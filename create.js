/* =========================================================
   create.js — websim-style create/edit page.

   - Streams completions from the `openrouter-build` Supabase Edge
     Function via simwebApi.invokeFunction (POST + Supabase JWT).
   - Sends previous chat turns + last rendered code as context so
     the LLM can do conversational edits (not just inject a diff).
   - Inline panel UI (title, description, prompt, model, visibility).
   - Versioning: every successful Build becomes a new project_version.
     First publish writes the project + version 1 directly; subsequent
     publishes call the insert_project_version SECURITY DEFINER RPC
     so version numbering is race-safe.
   ========================================================= */

(() => {
  const simweb = window.simwebApi;
  const sb = simweb.client();

  // ---------- DOM ----------
  const frame        = document.getElementById("frame");
  const wsEmpty      = document.getElementById("wsEmpty");
  const wsThinking   = document.getElementById("wsThinking");
  const wsTText      = document.getElementById("wsThinkingText");
  const projTitle    = document.getElementById("projTitle");
  const projDesc     = document.getElementById("projDesc");
  const wsOwnerAv    = document.getElementById("wsOwnerAvatar");
  const wsOwnerNm    = document.getElementById("wsOwnerName");
  const wsOwnerTm    = document.getElementById("wsOwnerTime");
  const statusText   = document.getElementById("statusText");
  const promptForm   = document.getElementById("promptForm");
  const promptInput  = document.getElementById("promptInput");
  const buildBtn     = document.getElementById("buildBtn");
  const logSection   = document.getElementById("logSection");
  const streamOut    = document.getElementById("streamOut");
  const logClose     = document.getElementById("logClose");
  const assetsSection= document.getElementById("assetsSection");
  const assetsBtn    = document.getElementById("assetsBtn");
  const modelSelect  = document.getElementById("modelSelect");
  const visBtn       = document.getElementById("visBtn");
  const visLabel     = document.getElementById("visLabel");
  const favBtn       = document.getElementById("favBtn");
  const topright     = document.getElementById("topright");
  const railReset    = document.getElementById("railReset");
  const railLog      = document.getElementById("railLog");
  const railMobile   = document.getElementById("railMobile");
  const railChat     = document.getElementById("railChat");
  const railHeart    = document.getElementById("railHeart");
  const railFolder   = document.getElementById("railFolder");
  const railNew      = document.getElementById("railNew");
  const railEdit     = document.getElementById("railEdit");
  const railSource   = document.getElementById("railSource");
  const railMore     = document.getElementById("railMore");
  const railBook     = document.getElementById("railBook");
  const railPaint    = document.getElementById("railPaint");
  const sourceDlg    = document.getElementById("sourceDlg");
  const sourceCode2  = document.getElementById("sourceCode2");
  const copySrcBtn2  = document.getElementById("copySrcBtn2");
  const versionsDlg  = document.getElementById("versionsDlg");
  const versionsList = document.getElementById("versionsList");

  // ---------- runtime state ----------
  const editing = {
    projectId: null,
    slug: null,
    versionNumber: 0,
    currentVersionId: null,
    visibility: "public",
  };
  let building = false;
  let currentSource = "";
  let currentQuery = "";
  let startedAt = 0;
  let sseBuffer = "";
  let mobileMode = false;
  let aborter = null;

  // Per-session chat history { role, content }. The AI receives ALL
  // prior turns + the current rendered code so each subsequent build
  // has full context.
  const chatHistory = [];

  const sessionVersions = [];

  // ---------- helpers ----------
  function setStatus(text, mode = "idle") {
    statusText.textContent = text;
    statusText.dataset.mode = mode;
  }
  function showEmpty(show) {
    wsEmpty.style.display = show ? "" : "none";
  }
  function showThinking(show, label) {
    wsThinking.hidden = !show;
    if (show && label) wsTText.textContent = label;
  }
  function setOwnerChip() {
    const me = simweb.me();
    const uname = me?.user_metadata?.username || "";
    if (me && uname) {
      wsOwnerNm.textContent = "@" + uname;
      wsOwnerAv.textContent = (uname[0] || "?").toUpperCase();
    } else {
      wsOwnerNm.textContent = "guest";
      wsOwnerAv.textContent = "G";
    }
    wsOwnerTm.textContent = "0m";
  }
  function refreshOwnerTime() {
    if (!startedAt) return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    let label = "0m";
    if (s < 60) label = s + "s";
    else if (s < 3600) label = Math.floor(s / 60) + "m";
    else label = Math.floor(s / 3600) + "h";
    wsOwnerTm.textContent = label;
  }
  function escapeHTML(s) {
    return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }
  function extractHTML(raw) {
    if (!raw) return "";
    let m = raw.match(/```(?:html)?\s*\n([\s\S]*?)```/i); if (m) return m[1].trim();
    m = raw.match(/(<!doctype html[\s\S]*?<\/html>)/i); if (m) return m[1].trim();
    const t = raw.trim();
    if (/^<!doctype html/i.test(t) || /^<html/i.test(t)) {
      const end = t.search(/<\/html>/i); return end !== -1 ? t.slice(0, end + 7) : t;
    }
    return `<!doctype html><html><body><pre style="white-space:pre-wrap;font-family:system-ui;padding:20px;">${escapeHTML(raw)}</pre></body></html>`;
  }
  function cap(s, n) { const x = String(s||"").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; }

  // ---------- slug + suffix ----------
  function slugify(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60) || "project";
  }
  function randomSuffix() {
    const a = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l
    let s = "";
    for (let i = 0; i < 8; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }

  // ---------- iframe hardening (shared router) ----------
  function injectRouter(html) {
    html = html.replace(/<base\b[^>]*>/gi, "");
    const router = `<script>(function(){
      function nav(href){ try{ parent.postMessage({type:'simweb:navigate', href:String(href||'/')}, '*'); }catch(_){} }
      function stop(e){ e.preventDefault(); e.stopPropagation(); }
      document.addEventListener('click', function(e){
        var a = e.target && e.target.closest && e.target.closest('a'); if (!a) return;
        var h = a.getAttribute('href'); if (h == null) return;
        if (/^javascript:/i.test(h) || /^mailto:/i.test(h) || /^tel:/i.test(h)) return;
        stop(e);
        if (h === '#' || h === '') { var dh = a.getAttribute('data-href'); if (dh) return nav(dh); return; }
        nav(h);
      }, true);
      document.addEventListener('submit', function(e){
        var f = e.target; if (!(f instanceof HTMLFormElement)) return;
        stop(e);
        var action = f.getAttribute('action') || '';
        if (action === '' || action === '#') { var dh = f.getAttribute('data-href'); if (dh) return nav(dh); }
        nav(action || (location.pathname + '?submitted'));
      }, true);
      try {
        var op = history.pushState, or = history.replaceState;
        history.pushState    = function(s,t,u){ if(u) nav(u); return op.apply(this,arguments); };
        history.replaceState = function(s,t,u){ if(u) nav(u); return or.apply(this,arguments); };
      } catch(_){}
      try { new MutationObserver(function(muts){
        muts.forEach(function(m){ m.addedNodes.forEach(function(n){
          if (n && n.tagName==='META' && (n.getAttribute('http-equiv')||'').toLowerCase()==='refresh') {
            var c = n.getAttribute('content')||''; var mm = c.match(/url=['"]?([^;'"\s]*)/i);
            n.remove(); if (mm && mm[1]) nav(mm[1]);
          }
        }); });
      }).observe(document.documentElement, { childList:true, subtree:true }); } catch(_){}
      try {
        Object.defineProperty(Location.prototype,'assign',  { value:function(u){ nav(u); }, configurable:true });
        Object.defineProperty(Location.prototype,'replace', { value:function(u){ nav(u); }, configurable:true });
      } catch(_){}
      window.addEventListener('beforeunload', function(){ parent.postMessage({type:'simweb:navigate', href:'about:srcdoc#rogue-redirect'}, '*'); });
    })();<\/script>`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/(<head[^>]*>)/i, "$1\n" + router);
    if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, router + "\n$1");
    return router + "\n" + html;
  }
  function renderInIframe(html) {
    const safe = injectRouter(html || "");
    frame.srcdoc = safe;
  }

  // ---------- streaming build via Supabase Edge Function ----------
  async function build(promptRaw, opts = {}) {
    const mode = opts.mode || (editing.projectId ? "edit" : "create");
    const explicitCode = opts.code;
    const explicitMessages = opts.previousMessages;
    const prompt = String(promptRaw || "").trim();
    if (!prompt) return;
    if (building) { setStatus("Already building — please wait.", "err"); return; }
    if (!simweb.isAuthed()) { setStatus("Log in to build.", "err"); return; }
    building = true;

    const model = modelSelect.value;
    currentQuery = prompt;

    showEmpty(false);
    showThinking(true, opts.thinkingLabel || "Building…");
    setStatus("Calling " + model + "…", "busy");
    logSection.hidden = false;
    streamOut.textContent = "";
    startedAt = Date.now();
    refreshOwnerTime();
    const tick = setInterval(refreshOwnerTime, 30_000);

    sseBuffer = "";
    let firstTokAt = null, fullText = "";

    aborter = new AbortController();
    try {
      const body = {
        prompt,
        model,
        mode,
      };
      if (mode === "edit" || mode === "iterate") {
        body.existingCode = explicitCode != null ? explicitCode : currentSource;
      }
      body.previousMessages = explicitMessages || chatHistory.slice();

      if (body.existingCode && body.existingCode.length > 60_000) {
        setStatus("Existing code too large to send as context.", "err");
        return;
      }

      const resp = await simweb.invokeFunction("openrouter-build", body, { signal: aborter.signal });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} — ${errText.slice(0, 220)}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstTokAt) firstTokAt = Date.now();
        sseBuffer += decoder.decode(value, { stream: true });
        const parts = sseBuffer.split(/\r?\n/);
        sseBuffer = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]" || data === "") continue;
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? "";
            if (delta) { fullText += delta; streamOut.textContent = fullText; }
          } catch (_) {}
        }
      }

      const html = extractHTML(fullText);
      currentSource = html;
      renderInIframe(html);

      chatHistory.push({ role: "user", content: prompt });
      chatHistory.push({ role: "assistant", content: html });

      const total = ((Date.now() - startedAt) / 1000).toFixed(1);
      const ttft  = firstTokAt ? ((firstTokAt - startedAt) / 1000).toFixed(2) : total;
      setStatus(`Rendered ${Math.round(html.length / 1024)} KB · ${total}s · first ${ttft}s`, "ok");
      showThinking(false);
      assetsSection.hidden = false;
      setUnsaved(true);
      return html;
    } catch (err) {
      const isAbort = err && (err.name === "AbortError" || /abort/i.test(String(err.message)));
      if (isAbort) {
        setStatus("Cancelled.", "idle");
        if (promptInput) promptInput.value = currentQuery;
      } else {
        streamOut.textContent += "\n\n[error] " + (err.message || err);
        setStatus("Error: " + (err.message || err).slice(0, 200), "err");
      }
    } finally {
      building = false;
      aborter = null;
      clearInterval(tick);
      showThinking(false);
    }
  }

  function setUnsaved(un) {
    if (!un) projTitle.classList.remove("dirty");
    else if (currentQuery && !editing.projectId) projTitle.classList.add("dirty");
  }

  // ---------- save / publish ----------
  async function publish() {
    if (!currentSource) { setStatus("Build something first.", "err"); return; }
    if (!simweb.isAuthed()) { simweb.redirectToLogin("create.html"); return; }
    try {
      const payload = {
        title: projTitle.value.trim() || "Untitled",
        description: projDesc.value.trim(),
        prompt: currentQuery,
        model: modelSelect.value,
        visibility: editing.visibility,
      };
      let r;
      if (editing.projectId) {
        // Subsequent edits — atomic version-number assignment
        const { data, error } = await sb.rpc("insert_project_version", {
          p_project_id: editing.projectId,
          p_prompt: payload.prompt,
          p_model: payload.model,
          p_code: currentSource,
          p_origin: "edit",
        }).single();
        if (error) throw error;

        // Apply title/description update alongside (RLS: owner can update)
        const { error: metaErr } = await sb.from("projects").update({
          title: payload.title,
          description: payload.description,
          current_version_id: data.id,
        }).eq("id", editing.projectId);
        if (metaErr) throw metaErr;

        r = { version_id: data.id, version_number: data.version_number, slug: editing.slug, project_id: editing.projectId };
        editing.currentVersionId = r.version_id;
        editing.versionNumber = r.version_number;
        sessionVersions.unshift({ version_number: r.version_number, prompt: currentQuery, model: modelSelect.value, created_at: new Date().toISOString() });
      } else {
        // First publish: insert project + v1 + re-point
        const me = simweb.me();
        const base = slugify(payload.title);
        let proj = null;
        for (let attempt = 0; attempt < 6; attempt++) {
          const slug = `${base}-${randomSuffix()}`;
          const { data, error } = await sb.from("projects").insert({
            owner_id: me.id,
            slug,
            title: payload.title,
            description: payload.description,
            visibility: payload.visibility,
          }).select().maybeSingle();
          if (!error) { proj = data; break; }
          // duplicate-key on slug column → try again with a new suffix
          if (!/duplicate key|unique/i.test(error.message || "")) throw error;
        }
        if (!proj) throw new Error("could not allocate slug, retry");

        const { data: ver, error: vErr } = await sb.from("project_versions").insert({
          project_id: proj.id,
          version_number: 1,
          prompt: payload.prompt,
          model: payload.model,
          code: currentSource,
          origin: "create",
        }).select().maybeSingle();
        if (vErr || !ver) throw (vErr || new Error("version insert failed"));

        const { error: ptrErr } = await sb.from("projects")
          .update({ current_version_id: ver.id }).eq("id", proj.id);
        if (ptrErr) throw ptrErr;

        r = { project_id: proj.id, slug: proj.slug, version_id: ver.id, version_number: 1 };
        editing.projectId = r.project_id;
        editing.slug = r.slug;
        editing.currentVersionId = r.version_id;
        editing.versionNumber = r.version_number;
        sessionVersions.unshift({ version_number: 1, prompt: currentQuery, model: modelSelect.value, created_at: new Date().toISOString() });
      }
      railEdit.hidden = false;
      setUnsaved(false);
      setStatus(`Published v${r.version_number} as /${r.slug}`, "ok");
      history.replaceState({}, "", `?project=${encodeURIComponent(r.project_id)}`);
    } catch (err) {
      setStatus("Publish failed: " + (err.message || err), "err");
    }
  }

  // ---------- load an existing project (edit mode) ----------
  async function loadProject(projectId) {
    try {
      const { data: proj, error: projErr } = await sb.from("project_feed_v")
        .select("*").eq("id", projectId).maybeSingle();
      if (projErr) throw projErr;
      if (!proj) throw new Error("not found");

      const { data: versions } = await sb.from("project_versions")
        .select("id, version_number, prompt, model, parent_version_id, origin, created_at, code")
        .eq("project_id", projectId)
        .order("version_number", { ascending: false });

      const cur = (versions || []).find(v => v.id === proj.current_version_id) || versions?.[0];
      currentSource = cur?.code || "";
      projTitle.value = proj.title || "";
      projDesc.value = proj.description || "";
      editing.projectId = proj.id;
      editing.slug = proj.slug;
      editing.currentVersionId = cur?.id || null;
      editing.versionNumber = cur?.version_number || 1;
      editing.visibility = proj.visibility || "public";

      chatHistory.length = 0;
      if (cur?.prompt) chatHistory.push({ role: "user", content: cur.prompt });
      chatHistory.push({ role: "assistant", content: currentSource });

      sessionVersions.length = 0;
      (versions || []).slice().reverse().slice(0, 10).forEach(vv => {
        sessionVersions.push({ version_number: vv.version_number, prompt: vv.prompt, model: vv.model, created_at: vv.created_at });
      });

      visBtn.dataset.vis = editing.visibility;
      visLabel.textContent = editing.visibility === "private" ? "Private" : editing.visibility === "unlisted" ? "Unlisted" : "Public";
      railEdit.hidden = false;
      showEmpty(false);
      renderInIframe(currentSource);
      setStatus(`Loaded v${editing.versionNumber}.`, "ok");
      setUnsaved(false);
    } catch (err) {
      setStatus("Couldn't load project: " + (err.message || err), "err");
    }
  }

  // ---------- navigation intercepted from inside the iframe ----------
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || d.type !== "simweb:navigate") return;
    let href = String(d.href || "/").trim();
    if (!href || href.startsWith("about:") || href === "#") return;
    promptInput.value = href;
    build("simulate the page at URL: " + href, { mode: "create" });
  });

  // ---------- visibility pill ----------
  const VIS_CYCLE = ["public", "unlisted", "private"];
  visBtn.addEventListener("click", () => {
    const idx = VIS_CYCLE.indexOf(visBtn.dataset.vis);
    const next = VIS_CYCLE[(idx + 1) % VIS_CYCLE.length];
    visBtn.dataset.vis = next;
    visLabel.textContent = next === "private" ? "Private" : next === "unlisted" ? "Unlisted" : "Public";
    editing.visibility = next;
  });

  // ---------- favorites ----------
  favBtn.addEventListener("click", async () => {
    if (!editing.projectId) { setStatus("Publish first to favorite this project.", "err"); return; }
    try {
      const me = simweb.me();
      const { data: existing } = await sb.from("favorites")
        .select("user_id").eq("user_id", me.id).eq("project_id", editing.projectId).maybeSingle();
      if (existing) {
        await sb.from("favorites").delete().match({ user_id: me.id, project_id: editing.projectId });
      } else {
        await sb.from("favorites").upsert(
          { user_id: me.id, project_id: editing.projectId },
          { ignoreDuplicates: true }
        );
      }
      favBtn.classList.toggle("active");
      setStatus(favBtn.classList.contains("active") ? "Saved to favorites." : "Removed from favorites.", "ok");
    } catch (err) {
      setStatus("Favorite failed: " + (err.message || err), "err");
    }
  });

  // ---------- prompt form ----------
  promptForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = promptInput.value.trim();
    if (!raw) { promptInput.focus(); return; }
    if (editing.projectId) {
      build(raw, { mode: "iterate" });
    } else {
      build(raw, { mode: "create" });
    }
    promptInput.value = "";
  });

  promptInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); promptForm.requestSubmit(); }
  });

  // ---------- left rail: reset, log, mobile ----------
  railReset.addEventListener("click", () => {
    if (aborter) aborter.abort();
    currentSource = "";
    currentQuery = "";
    chatHistory.length = 0;
    sessionVersions.length = 0;
    editing.projectId = null; editing.slug = null; editing.currentVersionId = null; editing.versionNumber = 0;
    railEdit.hidden = true;
    showEmpty(true);
    frame.srcdoc = "about:blank";
    projTitle.value = "";
    projDesc.value = "";
    setStatus("Cleared.", "idle");
    history.replaceState({}, "", location.pathname);
  });

  railLog.addEventListener("click", () => {
    logSection.hidden = !logSection.hidden;
    railLog.classList.toggle("active", !logSection.hidden);
  });
  logClose.addEventListener("click", () => { logSection.hidden = true; railLog.classList.remove("active"); });

  railMobile.addEventListener("click", () => {
    mobileMode = !mobileMode;
    railMobile.setAttribute("aria-pressed", String(mobileMode));
    const stage = document.querySelector(".ws-stage");
    stage.classList.toggle("mobile", mobileMode);
    if (frame && frame.srcdoc) {
      const src = frame.srcdoc; frame.srcdoc = "about:blank";
      requestAnimationFrame(() => { frame.srcdoc = src; });
    }
  });

  // ---------- right rail: chat / heart / folder / new / edit / source / more / book / paint ----------
  railChat.addEventListener("click", () => setStatus("Comments are coming next.", "idle"));
  railHeart.addEventListener("click", () => favBtn.click());
  railFolder.addEventListener("click", () => openVersions());
  railNew.addEventListener("click", () => railReset.click());
  railEdit.addEventListener("click", () => { if (editing.projectId) location.href = "/project.html?id=" + encodeURIComponent(editing.projectId); });
  railSource.addEventListener("click", () => openSource());
  railMore.addEventListener("click", () => {
    if (currentSource) publish();
    else setStatus("Build something first.", "err");
  });
  railBook.addEventListener("click", () => setStatus("Help docs coming soon — for now, just type what you want.", "idle"));
  railPaint.addEventListener("click", () => setStatus("Theme picker coming soon.", "idle"));

  // ---------- hint chips ----------
  document.addEventListener("click", (e) => {
    const t = e.target.closest(".empty-hint");
    if (t) { promptInput.value = t.dataset.q; promptInput.focus(); promptForm.requestSubmit(); }
  });

  // ---------- versions dialog ----------
  function openVersions() {
    if (sessionVersions.length === 0) { setStatus("No versions yet — publish first.", "err"); return; }
    versionsList.innerHTML = sessionVersions.map(v => `
      <div class="ws-vrow" data-v="${v.version_number}">
        <span class="ws-vnum">v${v.version_number}</span>
        <span class="ws-vprompt" title="${escapeHTML(v.prompt || '')}">${escapeHTML(cap(v.prompt || '', 80))}</span>
        <span class="ws-vmeta">${escapeHTML(v.model || '')} · ${escapeHTML(simweb.fmtTime(v.created_at) || '')}</span>
      </div>
    `).join("");
    versionsDlg.showModal();
  }
  versionsList.addEventListener("click", (e) => {
    const r = e.target.closest(".ws-vrow");
    if (!r) return;
    const v = sessionVersions.find(x => x.version_number === +r.dataset.v);
    if (v && editing.projectId) {
      sb.from("project_versions").select("id, version_number, code").eq("project_id", editing.projectId).eq("version_number", v.version_number).maybeSingle()
        .then(({ data: vv, error }) => {
          if (error) throw error;
          if (vv) {
            currentSource = vv.code;
            renderInIframe(vv.code);
            setStatus(`Showing v${v.version_number} (view-only). Build to continue editing.`, "ok");
          }
        })
        .catch(err => setStatus("Couldn't load version: " + (err.message || err), "err"));
    }
  });

  // ---------- source dialog ----------
  function openSource() {
    sourceCode2.textContent = currentSource || "<!-- nothing yet -->";
    sourceDlg.showModal();
  }
  copySrcBtn2.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(currentSource || "");
      copySrcBtn2.textContent = "Copied!";
      setTimeout(() => copySrcBtn2.textContent = "Copy", 1100);
    } catch (_) {}
  });

  // ---------- top-right: profile chip or login CTA ----------
  function renderTopRight() {
    const me = simweb.me();
    const uname = me?.user_metadata?.username || "";
    topright.innerHTML = me
      ? `<a class="pill profile" href="profile.html?u=${encodeURIComponent(uname)}" title="@${simweb.escapeHTML(uname)}">
           <span class="pill-dot"></span>
           <span>@${simweb.escapeHTML(uname)}</span>
         </a>
         <a class="btn ghost small" href="account.html" title="Account settings">Account</a>
         <button class="btn ghost small" id="logoutBtn">Log out</button>`
      : `<a class="btn ghost small" href="login.html?next=create.html">Log in</a>
         <a class="btn primary small" href="signup.html?next=create.html">Sign up</a>`;
    const lo = document.getElementById("logoutBtn");
    if (lo) lo.addEventListener("click", async () => { await simweb.signOut(); location.reload(); });
  }

  window.__publish = publish;

  // ---------- boot ----------
  renderTopRight();
  setOwnerChip();
  window.addEventListener("simweb:auth", () => { renderTopRight(); setOwnerChip(); });

  const params = new URLSearchParams(location.search);
  const projectParam = params.get("project");
  if (projectParam) loadProject(projectParam);

  window.simwebCreate = { build, publish };
})();
