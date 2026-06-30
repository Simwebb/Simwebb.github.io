/* =========================================================
   simweb.js — shared frontend module loaded by every page.

   In this version (no Netlify functions):
   - Supabase client is created from window.SUPABASE_URL + window.SUPABASE_ANON_KEY
     (set by config.js, loaded before this script).
   - `simwebApi.client()` returns the singleton supabase-js client.
   - `simwebApi.me()` is a sync mirror of the current user, kept in sync
     via onAuthStateChange.
   - DOM / escape / time helpers are unchanged.

   Every page still loads <script src="config.js"></script> before this.
   ========================================================= */

(() => {
  const SESSION_STORAGE_KEY = "simweb.auth.v2"; // supabase-js auth storage key

  // ---------- supabase client (lazy singleton) ----------
  let _client = null;
  let _user = null;

  function client() {
    if (_client) return _client;

    const url = window.SUPABASE_URL;
    const key = window.SUPABASE_ANON_KEY;
    if (!url || !key || url.includes("YOUR-PROJECT") || key.includes("YOUR-ANON")) {
      showConfigBanner();
    }

    const sb = window.supabase.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: window.localStorage,
        storageKey: SESSION_STORAGE_KEY,
      },
    });
    _client = sb;

    // Hydrate from any existing session, then keep `me` fresh.
    sb.auth.getSession().then(({ data }) => {
      _user = data?.session?.user ?? null;
      renderTopNav();
      window.dispatchEvent(new CustomEvent("simweb:auth", { detail: { user: _user } }));
    }).catch(() => { /* ignore */ });

    sb.auth.onAuthStateChange((_event, session) => {
      _user = session?.user ?? null;
      renderTopNav();
      window.dispatchEvent(new CustomEvent("simweb:auth", { detail: { user: _user } }));
    });

    return sb;
  }

  function showConfigBanner() {
    if (document.getElementById("simweb-config-banner")) return;
    const b = document.createElement("div");
    b.id = "simweb-config-banner";
    b.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;padding:10px 14px;background:#ffb45a;color:#0b0b14;font:13px/1.4 system-ui;border-bottom:1px solid rgba(0,0,0,.2);text-align:center;";
    b.innerHTML = "⚠ <b>simweb isn't configured yet.</b> Open <code>config.js</code> and set <code>SUPABASE_URL</code> + <code>SUPABASE_ANON_KEY</code>.";
    document.body.appendChild(b);
  }

  // ---------- sync session mirror ----------
  function me() { return _user; }
  function isAuthed() { return !!_user; }

  async function signOut() {
    const sb = client();
    await sb.auth.signOut();
    _user = null;
  }

  // ---------- top nav ----------
  function renderTopNav() {
    const host = document.getElementById("topnav");
    if (!host) return;
    const user = me();
    const here = location.pathname.split("/").pop() || "index.html";
    const link = (href, label) =>
      `<a href="${href}" class="navlink ${here === href ? "active" : ""}">${label}</a>`;

    host.innerHTML = `
      <a class="brand" href="index.html" aria-label="simweb home">
        <img src="logo.png" alt="" width="22" height="22" style="border-radius:6px;display:block" />
        <span class="brandword"><b>sim</b>web</span>
      </a>
      <nav class="toplinks">${link("index.html", "Feed")}${link("create.html", "Create")}</nav>
      <div class="topright">
        ${user
          ? `<a class="pill profile" href="profile.html?u=${encodeURIComponent(user.user_metadata?.username || "")}" title="@${escapeHTML(user.user_metadata?.username || "")}">
               <span class="pill-dot"></span>
               <span>@${escapeHTML(user.user_metadata?.username || "")}</span>
             </a>
             <button class="btn ghost small" id="logoutBtn">Log out</button>`
          : `<a class="btn ghost small" href="login.html">Log in</a>
             <a class="btn primary small" href="signup.html">Sign up</a>`
        }
      </div>`;

    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) logoutBtn.addEventListener("click", async () => {
      await signOut();
      location.href = "index.html";
    });
  }

  window.addEventListener("storage", () => {
    const sb = _client;
    if (sb && sb.auth) sb.auth.getSession().then(({ data }) => {
      _user = data?.session?.user ?? null;
      renderTopNav();
    });
  });

  // ---------- helpers (unchanged) ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const k in attrs) {
      if (k === "class") node.className = attrs[k];
      else if (k === "html") node.innerHTML = attrs[k];
      else if (k.startsWith("on") && typeof attrs[k] === "function") {
        node.addEventListener(k.slice(2), attrs[k]);
      } else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      if (typeof c === "string") node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }
  function escapeHTML(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
     .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtTime(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime(), now = Date.now();
    const s = Math.max(1, Math.floor((now - t) / 1000));
    if (s < 60)  return s + "s ago";
    if (s < 3600) return Math.floor(s/60) + "m ago";
    if (s < 86400) return Math.floor(s/3600) + "h ago";
    if (s < 86400*30) return Math.floor(s/86400) + "d ago";
    return new Date(iso).toLocaleDateString();
  }
  function fmtCompact(n) {
    if (n == null) return "0";
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
    return String(n | 0);
  }
  function redirectToLogin(next) {
    const u = new URL("login.html", location.href);
    if (next) u.searchParams.set("next", next);
    location.href = u.toString();
  }

  // ---------- iframe thumbnail renderer ----------
  const ROUTER_SCRIPT = `<script>(function(){
    document.addEventListener('click', function(e){
      var a = e.target && e.target.closest && e.target.closest('a');
      if (!a) return;
      var h = a.getAttribute('href');
      if (!h || /^javascript:/i.test(h) || /^mailto:/i.test(h) || /^tel:/i.test(h)) return;
      e.preventDefault(); e.stopPropagation();
      parent.postMessage({ type:'simweb:navigate', href: h }, '*');
    }, true);
  })();<\/script>`;

  function renderIframe(iframe, html /*, opts */) {
    if (!iframe) return;
    let safe = String(html || "");
    safe = safe.replace(/<base\b[^>]*>/gi, "");
    if (/<head[^>]*>/i.test(safe)) {
      safe = safe.replace(/(<head[^>]*>)/i, "$1" + ROUTER_SCRIPT);
    } else if (/<body[^>]*>/i.test(safe)) {
      safe = safe.replace(/(<body[^>]*>)/i, ROUTER_SCRIPT + "$1");
    } else {
      safe = ROUTER_SCRIPT + safe;
    }
    iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
    iframe.srcdoc = safe;
  }

  // ---------- supabase Edge Function call ----------
  // Streams the request body straight back as a fetch Response so
  // SSE pipelines work without going through supabase-js's JSON-only
  // `functions.invoke` parser.
  async function invokeFunction(name, body, opts = {}) {
    const sb = client();
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    const url = (window.SUPABASE_URL || "").replace(/\/+$/, "") + "/functions/v1/" + name;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token || window.SUPABASE_ANON_KEY}`,
        "apikey": window.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
    return resp;
  }

  // ---------- public api ----------
  window.simwebApi = {
    client, me, isAuthed, signOut,
    renderTopNav,
    el, escapeHTML, escapeAttr: escapeHTML, fmtTime, fmtCompact,
    redirectToLogin,
    renderIframe,
    invokeFunction,
  };

  // init eagerly so `me()` reflects the session ASAP
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", client);
  } else {
    client();
  }
})();

// cache-bust build: 2026-06-30T16:06:42Z
