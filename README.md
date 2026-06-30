# simweb — AI-simulated internet

A clone of [websim.com](https://websim.com) you can deploy as a **static
website** and back with Supabase. Users describe any website in plain
English and an AI simulates it in real time. Click any link inside
the result and the AI keeps simulating the next page.

## Stack

- **Frontend** — vanilla HTML/CSS/JS. **No build step.** Drop the
  folder on any static host (GitHub Pages, Cloudflare Pages, Vercel,
  Netlify static, etc.).
- **Auth + Database** — Supabase (Postgres + Auth via the JS SDK
  loaded from a CDN).
- **LLM proxy** — Supabase Edge Function (Deno). Keeps the OpenRouter
  API key server-side. Rate-limited per authenticated user.
- **Scheduled cleanup** — `pg_cron`. Hard-deletes accounts whose
  14-day soft-delete grace window has expired.

## Files

```
.
├── config.js             # edit before deploying: SUPABASE_URL + ANON_KEY
├── index.html            # Home feed (project grid)
├── signup.html           # Account creation
├── login.html            # Log in
├── create.html           # Build/edit AI UI
├── project.html          # Single project view
├── profile.html          # User profile
├── account.html          # Account settings (incl. soft-delete / restore)
├── styles.css            # All UI styles
├── simweb.js             # Shared client module (Supabase client, helpers)
├── auth.js               # signup/login (signUp / signInWithPassword)
├── feed.js               # home feed (project_feed_v)
├── create.js             # LLM stream via Edge Function + project create
├── project.js            # single project view + like/favorite/view
├── profile.js            # profile + favorites
├── account.js            # profile update + soft-delete + restore
├── supabase/
│   ├── migrations/
│   │   ├── 001_init.sql            # users, projects, versions, likes, favs, RLS
│   │   ├── 002_soft_delete.sql     # deleted_at + 14-day view filter
│   │   └── 003_frontend_support.sql # signUp trigger + 2 RPCs + pg_cron
│   └── functions/
│       └── openrouter-build/
│           └── index.ts            # Edge Function (Deno)
└── logo.png
```

## Deployment step by step

### 1. Create a Supabase project

1. [app.supabase.com](https://app.supabase.com) → **New project**.
2. Open **SQL Editor → New query** and run each of the three
   migrations in order:
   - `supabase/migrations/001_init.sql`
   - `supabase/migrations/002_soft_delete.sql`
   - `supabase/migrations/003_frontend_support.sql`
3. Open **Database → Extensions** and make sure **pg_cron** is
   enabled (it is by default on free tier).
4. **Authentication → Providers → Email** → disable *Confirm email*
   *only* for development; production should leave it on so spammers
   can't burn your auth quota.
5. Copy your **Project URL** (`https://abcdefghijk.supabase.co`) and
   your **anon public** key (`sb_publishable_…`) from
   **Project Settings → API keys**. Both are safe to embed in the
   browser; the anon key is gated by Row Level Security.

### 2. Deploy the OpenRouter Edge Function

You need the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
# Link the local repo to your remote project (only once)
supabase link --project-ref YOUR-PROJECT-REF

# Set the secrets the function needs
supabase secrets set OPENROUTER_API_KEY=sk-or-v1-...
supabase secrets set PUBLIC_SITE_URL=https://your-site.example.com

# Deploy the function
supabase functions deploy openrouter-build --no-verify-jwt=false
```

After deploy, smoke-test it:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR-ANON-KEY" \
  -H "Content-Type: application/json" \
  -H "apikey: YOUR-ANON-KEY" \
  -d '{"prompt":"a tiny blank page","model":"meta-llama/llama-3.3-70b-instruct:free","mode":"create"}' \
  https://YOUR-PROJECT-REF.supabase.co/functions/v1/openrouter-build
```

This should return an SSE stream (use `--no-buffer` to see it).

### 3. Edit `config.js`

Open `config.js` and replace the placeholders:

```js
window.SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_…";
```

That's the only file you need to touch before deploying.

### 4. Host the static site

Pick any static host:

**GitHub Pages**
```bash
git init && git add -A && git commit -m "init"
# create a GitHub repo, then:
git remote add origin https://github.com/you/simweb.git
git push -u origin main
# on GitHub: Settings → Pages → branch: main, / (root)
```

**Cloudflare Pages / Vercel / Netlify** — point them at the repo,
build command: *(leave empty)*, publish directory: `.`.

**Important:** most free static hosts won't let you set custom HTTP
headers. We've added a Content-Security-Policy `<meta>` tag inside
every page so you still get a meaningful CSP. If your host supports
headers (Vercel, Netlify, Cloudflare), drop a `_headers` (Netlify)
or `vercel.json` with the same CSP and add `X-Frame-Options: DENY`
plus `X-Content-Type-Options: nosniff`. The `<meta>` tag is then
redundant but harmless.

### 5. Local development (optional)

You don't need a build step. Any HTTP server works — the SDK is loaded
from a CDN so even `file://` mostly works (some browsers block
`localStorage` on `file://`, so prefer a server).

```bash
# Python:
python3 -m http.server 8080
# or Node:
npx serve .
```

Then visit `http://localhost:8080`. The site will read `config.js`
at load time. To iterate on the Edge Function locally, run
`supabase functions serve openrouter-build` and tweak
`config.js` to point at `http://localhost:54321`.

## How iteration works

When you click **Publish** on `create.html` *without* a project
loaded, the model receives your prompt as a fresh request and returns
a new page.

When you arrive at `create.html?project=<id>` (the **Edit** button on
the project page), the current version's HTML is included in the user
message and the system prompt switches to "MODIFY the page, return
the FULLY updated page". So if your prompt is "make the background
purple", the model reads the current HTML and rewrites it with
`background: purple`. The result is then saved as a new version.

The Edge Function `openrouter-build` runs in Supabase's Deno runtime
and forwards to OpenRouter with SSE streaming. **The OpenRouter key
never touches the browser** — only the Edge Function has it.

## Soft delete

`account.html`'s *Delete* button sets `public.users.deleted_at = now()`
via a direct Postgres update (the `users_update_self` RLS policy
allows it). The home feed view filters out soft-deleted accounts
immediately, so their projects vanish from the public feed within
seconds. The user can sign back in for 14 days and call **Restore** at
any point during that window.

`pg_cron` runs once a day at 03:15 UTC and hard-deletes from
`auth.users` any account whose `deleted_at` is older than 14 days.
The `ON DELETE CASCADE` chain — `public.users → projects →
project_versions → likes → favorites` — purges everything in one
statement.

## Where do my projects live?

All projects, versions, likes, favorites live in your Supabase
Postgres. The frontend talks to Postgres exclusively through the
supabase-js SDK via the REST API. **RLS is your perimeter** — the
browser only ever holds the anon key, and anon can only do what RLS
allows.

For per-user record rules, see the policies in
`001_init.sql`:

```
users           select: anyone,    update: self only
projects        select: public OR owner,  write: owner only
project_versions select: tied to project's visibility,  write: owner only
likes / favs    select: anyone,    write: self only
```

These are enforced server-side; there is no "admin" code path that
can override them from the browser.
