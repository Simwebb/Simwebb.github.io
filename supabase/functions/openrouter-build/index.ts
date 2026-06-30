// supabase/functions/openrouter-build/index.ts
//
// Server-side proxy for OpenRouter. The API key stays as a Supabase
// secret and never touches the browser. The caller MUST be authenticated
// (their Supabase JWT in `Authorization: Bearer …`) — we use the
// validated user.id for per-user rate limiting so one runaway client
// can't burn through everyone's quota.
//
// Deploy with:
//   supabase functions deploy openrouter-build --no-verify-jwt=false
// Secrets:
//   OPENROUTER_API_KEY   sk-or-v1-...
//   PUBLIC_SITE_URL      https://your-site.example.com (for HTTP-Referer)
//
// Request body shape (POST):
//   {
//     prompt                string  -- current user message
//     model                 string  -- OpenRouter model id
//     mode                  "create"|"edit"|"iterate"|"navigate" (default create)
//     existingCode?         string  -- most recent rendered HTML
//     previousMessages?     [{role:"user"|"assistant", content:string}, …]
//   }
//
// Returns upstream SSE (text/event-stream) on success, or JSON error.
//

// @ts-expect-error -- Deno serves this; type-only import for edit-time hints.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OR_URL = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT_BASE = `You are the backend of an AI-simulated internet called "simweb".

When the user gives you a request, generate ONE COMPLETE, SELF-CONTAINED HTML document that fulfills it. Always return ONLY raw HTML inside a single fenced code block:

\`\`\`html
<!doctype html>
<html>... full document including <style> and <script> ...</html>
\`\`\`

Rules for the page you generate:
- Self-contained (no <script src="..."> or external CSS).
- Polished, modern, credible. Use real-looking fake data.
- Never use "lorem ipsum" — invent believable content.
- Use system fonts and inline SVG. Styling tip: dark or light, generous spacing, decent typography, hover states. Be consistent.
- For links/forms, use href="#" with a data-href="/some/path" attribute so the host can intercept them; or use real-looking URLs that the host will turn into new prompts.
- NEVER include <meta http-equiv="refresh">, <base href=...>, or any redirect logic.
- Return ONLY the code block, no preamble or explanation.`;

const SYSTEM_PROMPT_EDIT = `You are the backend of "simweb". The user is EDITING an existing page that we are providing below. Your job is to MODIFY the page according to the user's edit prompt and return the COMPLETELY UPDATED page (not a diff, not just the changes — the ENTIRE final page must be in the output).

Rules:
- You may add, remove, or rewrite anything in the existing page.
- Keep the overall design language, but improve where it helps fulfill the edit.
- The output MUST be a single fenced \`\`\`html ... \`\`\` block containing the ENTIRE updated <!doctype html>...</html> document.
- Self-contained — no external scripts or stylesheets.
- NEVER include <meta http-equiv="refresh">, <base href=...>, or any redirect logic.
- Return ONLY the code block, nothing else.`;

// Per-user token bucket. Warm Lambda/Edge instances preserve this for a
// while; once it rolls, the bucket flushes, which is acceptable for v1.
const buckets = new Map<string, { resetAt: number; count: number }>();
function rateAllow(userId: string, perMinute: number): boolean {
  const now = Date.now();
  const win = 60_000;
  const b = buckets.get(userId) ?? { resetAt: now + win, count: 0 };
  if (now >= b.resetAt) { b.resetAt = now + win; b.count = 0; }
  b.count++;
  buckets.set(userId, b);
  return b.count <= perMinute;
}

function corsHeaders(origin: string | null) {
  const allowPublic = Deno.env.get("PUBLIC_SITE_URL");
  let allowOrigin: string;
  if (!allowPublic || allowPublic === "*") {
    allowOrigin = "*";
  } else if (origin && origin === allowPublic) {
    allowOrigin = origin;
  } else {
    allowOrigin = allowPublic;
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonError(message: string, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") {
    return jsonError("POST only", 405, cors);
  }

  // ----- Auth: require a valid Supabase JWT -----
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return jsonError("missing bearer token", 401, cors);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return jsonError("server misconfigured: missing Supabase env", 500, cors);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userErr } = await admin.auth.getUser(m[1].trim());
  if (userErr || !userData?.user) {
    return jsonError("invalid token", 401, cors);
  }
  // Reject the anon role — the anon key is itself a valid JWT but it
  // represents the public/anonymous identity, and we want builds to be
  // reserved for signed-in users only. Anyone with the anon key can
  // otherwise saturate the per-user rate limit bucket.
  const role = (userData.user.app_metadata as Record<string, unknown> | undefined)?.provider
    ? "authenticated"
    : (userData.user.role ?? "");
  if (role !== "authenticated" || !userData.user.email) {
    return jsonError("must be signed in to build", 401, cors);
  }
  const userId = userData.user.id;

  // ----- Per-user rate limit -----
  if (!rateAllow(userId, 30)) {
    return jsonError("slow down — max 30 builds per minute", 429, {
      ...cors,
      "Retry-After": "60",
    });
  }

  // ----- Body -----
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError("bad json", 400, cors);
  }
  const prompt = String(body.prompt ?? "").trim();
  const model = String(body.model ?? "").trim();
  const mode = String(body.mode ?? "create");
  if (!prompt) return jsonError("prompt required", 400, cors);
  if (!model) return jsonError("model required", 400, cors);
  if (mode !== "create" && mode !== "edit" && mode !== "iterate" && mode !== "navigate") {
    return jsonError("invalid mode", 400, cors);
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    return jsonError(
      "server is missing OPENROUTER_API_KEY — set it via `supabase secrets set`",
      500,
      cors,
    );
  }

  // ----- Build the messages array -----
  const sysPrompt =
    mode === "edit" || mode === "iterate" ? SYSTEM_PROMPT_EDIT : SYSTEM_PROMPT_BASE;
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: sysPrompt },
  ];

  const safeHistory = Array.isArray(body.previousMessages)
    ? (body.previousMessages as unknown[])
    : [];
  const PER_ENTRY_CAP = 28_000;
  for (const entry of safeHistory.slice(-12)) {
    if (!entry || typeof entry !== "object") continue;
    const role = (entry as Record<string, unknown>).role;
    if (role !== "user" && role !== "assistant") continue;
    let content = String((entry as Record<string, unknown>).content ?? "");
    if (content.length > PER_ENTRY_CAP) {
      content = content.slice(0, PER_ENTRY_CAP) + "\n…(truncated)";
    }
    messages.push({ role, content });
  }

  let userContent = prompt;
  const existingCode = typeof body.existingCode === "string" ? body.existingCode : "";
  if ((mode === "edit" || mode === "iterate") && existingCode) {
    userContent =
      `USER EDIT: """${prompt}"""\n\nCURRENT PAGE CODE (modify it):\n` +
      `\`\`\`html\n${existingCode}\n\`\`\`\n\n` +
      "Return the FULLY UPDATED page inside a single ```html ... ``` block.";
  }
  messages.push({ role: "user", content: userContent });

  // ----- Call upstream and stream back the SSE -----
  const referer = Deno.env.get("PUBLIC_SITE_URL") || origin || "https://simweb.local";
  const upstream = await fetch(OR_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
      "HTTP-Referer": referer,
      "X-Title": "simweb",
    },
    body: JSON.stringify({ model, stream: true, messages }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    return jsonError(
      `upstream ${upstream.status} — ${errText.slice(0, 240)}`,
      upstream.status,
      cors,
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      // Disable buffering on proxies that might otherwise chunk this oddly.
      "X-Accel-Buffering": "no",
    },
  });
});
