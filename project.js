/* =========================================================
   project.js — single project view, like/favorite, version switch.
   ========================================================= */

(() => {
  const simweb = window.simwebApi;
  const sb = simweb.client();
  simweb.renderTopNav();

  const $ = (s) => document.querySelector(s);
  const layout      = $("#projectLayout");
  const loading     = $("#loadingState");
  const errState    = $("#errorState");
  const projTitle   = $("#projTitle");
  const projDesc    = $("#projDesc");
  const projOwner   = $("#projOwner");
  const projStats   = $("#projStats");
  const frame       = $("#frame");
  const versionsEl  = $("#versions");
  const likeBtn     = $("#likeBtn");
  const favBtn      = $("#favBtn");
  const editBtn     = $("#editBtn");
  const viewSrcBtn  = $("#viewSrcBtn");
  const shareBtn    = $("#shareBtn");
  const likeLabel   = $("#likeLabel");
  const favLabel    = $("#favLabel");

  let state = { project: null, versions: [], viewer: { liked:false, favorited:false, isOwner:false }, activeVersionId: null };

  function injectRouter(html) {
    return String(html || "").replace(/<base\b[^>]*>/gi, "");
  }
  function renderIframe(html) {
    if (!html) {
      frame.srcdoc = `<!doctype html><body style="font-family:system-ui;padding:32px;color:#888">No code in this version.</body>`;
      return;
    }
    const safe = injectRouter(html);
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
    frame.srcdoc = safe;
  }

  function renderVersions() {
    versionsEl.innerHTML = "";
    if (!state.versions.length) {
      versionsEl.innerHTML = `<div style="padding:14px 16px;color:var(--txt-mute);font-size:13px">No versions yet.</div>`;
      return;
    }
    for (const v of state.versions) {
      const row = document.createElement("div");
      row.className = "version-row" + (v.id === state.activeVersionId ? " active" : "");
      row.dataset.id = v.id;
      row.innerHTML = `
        <span class="v-num">v${v.version_number}</span>
        <div class="v-info">
          <div class="v-prompt">${simweb.escapeHTML(v.prompt || "Untitled prompt")}</div>
          <div class="v-time">${simweb.fmtTime(v.created_at)} · <span style="font-family:ui-monospace,Consolas,monospace">${simweb.escapeHTML(v.model || "model")}</span></div>
        </div>
        <span class="v-origin">${simweb.escapeHTML(v.origin || "edit")}</span>
      `;
      row.addEventListener("click", () => {
        state.activeVersionId = v.id;
        renderIframe(v.code);
        renderVersions();
      });
      versionsEl.appendChild(row);
    }
  }

  function renderHeader() {
    const p = state.project;
    projTitle.textContent = p.title || "Untitled";
    projDesc.textContent = p.description || "";
    const initials = ((p.owner.display_name || p.owner.username || "?")[0] || "?").toUpperCase();
    projOwner.innerHTML = `
      <a href="/profile.html?u=${encodeURIComponent(p.owner.username)}">
        <span class="avatar">${simweb.escapeHTML(initials)}</span>
      </a>
      <a href="/profile.html?u=${encodeURIComponent(p.owner.username)}">@${simweb.escapeHTML(p.owner.username)}</a>
      <span style="color:var(--txt-mute)">·</span>
      <span style="color:var(--txt-mute)">${simweb.fmtTime(p.created_at)}</span>
    `;
    projStats.innerHTML = `
      <span>👁 ${simweb.fmtCompact(p.view_count)} views</span>
      <span>♥ ${simweb.fmtCompact(p.like_count)} likes</span>
      <span>★ ${simweb.fmtCompact(p.favorite_count)} favorites</span>
      <span>⑂ ${simweb.fmtCompact(p.fork_count)} forks</span>
    `;
  }

  function renderActions() {
    likeLabel.textContent = state.viewer.liked ? "Liked" : "Like";
    favLabel.textContent  = state.viewer.favorited ? "Favorited" : "Favorite";
    editBtn.hidden = !state.viewer.isOwner;
    likeBtn.classList.toggle("primary", state.viewer.liked);
    favBtn.classList.toggle("primary", state.viewer.favorited);
  }

  async function refreshCounts() {
    const { data } = await sb.from("projects")
      .select("like_count, favorite_count, view_count")
      .eq("id", state.project.id).maybeSingle();
    if (data) {
      state.project.like_count = data.like_count;
      state.project.favorite_count = data.favorite_count;
      state.project.view_count = data.view_count;
    }
  }

  async function toggleLike() {
    if (!simweb.isAuthed()) { simweb.redirectToLogin(`project.html?id=${state.project.id}`); return; }
    const uid = simweb.me().id;
    const { data: existing } = await sb.from("likes")
      .select("user_id").eq("user_id", uid).eq("project_id", state.project.id).maybeSingle();
    if (existing) {
      await sb.from("likes").delete().match({ user_id: uid, project_id: state.project.id });
      state.viewer.liked = false;
    } else {
      // ignoreDuplicates so a rapid double-click doesn't 409
      await sb.from("likes").upsert(
        { user_id: uid, project_id: state.project.id },
        { ignoreDuplicates: true }
      );
      state.viewer.liked = true;
    }
    await refreshCounts();
    renderActions(); renderHeader();
  }

  async function toggleFav() {
    if (!simweb.isAuthed()) { simweb.redirectToLogin(`project.html?id=${state.project.id}`); return; }
    const uid = simweb.me().id;
    const { data: existing } = await sb.from("favorites")
      .select("user_id").eq("user_id", uid).eq("project_id", state.project.id).maybeSingle();
    if (existing) {
      await sb.from("favorites").delete().match({ user_id: uid, project_id: state.project.id });
      state.viewer.favorited = false;
    } else {
      await sb.from("favorites").upsert(
        { user_id: uid, project_id: state.project.id },
        { ignoreDuplicates: true }
      );
      state.viewer.favorited = true;
    }
    await refreshCounts();
    renderActions(); renderHeader();
  }

  likeBtn.addEventListener("click", toggleLike);
  favBtn.addEventListener("click",  toggleFav);
  editBtn.addEventListener("click", () => {
    location.href = `/create.html?project=${encodeURIComponent(state.project.id)}`;
  });
  viewSrcBtn.addEventListener("click", () => {
    const v = state.versions.find(v => v.id === state.activeVersionId);
    if (!v) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.title = "Source — " + (state.project.title || "simweb");
    w.document.body.innerHTML = `<pre style="white-space:pre;font-family:ui-monospace,Consolas,monospace;font-size:12px;padding:16px;background:#0b0b14;color:#cfd0e6;min-height:100vh;margin:0;">${simweb.escapeHTML(v.code)}</pre>`;
  });
  shareBtn.addEventListener("click", async () => {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      shareBtn.querySelector("span").textContent = "Copied ✓";
      setTimeout(() => shareBtn.querySelector("span").textContent = "Share", 1100);
    } catch (_) {}
  });

  async function loadViewerState(uid, ownerId, projectId) {
    if (!uid) return { liked:false, favorited:false, isOwner: uid === ownerId };
    const [{ data: lk }, { data: fv }] = await Promise.all([
      sb.from("likes").select("user_id").eq("user_id", uid).eq("project_id", projectId).maybeSingle(),
      sb.from("favorites").select("user_id").eq("user_id", uid).eq("project_id", projectId).maybeSingle(),
    ]);
    return {
      liked: !!lk,
      favorited: !!fv,
      isOwner: uid === ownerId,
    };
  }

  async function fetchProject(idOrSlug, byId) {
    let projQ = sb.from("project_feed_v").select("*").limit(1);
    projQ = byId ? projQ.eq("id", idOrSlug) : projQ.eq("slug", idOrSlug);
    const { data: proj, error } = await projQ.maybeSingle();
    if (error) throw error;
    return proj;
  }

  async function bumpView(projectId) {
    // SECURITY DEFINER RPC. RLS would otherwise block this update for non-owners.
    try {
      await sb.rpc("increment_view_count", { p_project_id: projectId });
    } catch (_) { /* ignore */ }
  }

  (async function boot() {
    const params = new URLSearchParams(location.search);
    const byId = !!params.get("id");
    const idOrSlug = params.get("id") || params.get("slug");
    if (!idOrSlug) { loading.hidden = true; errState.textContent = "Missing project id."; errState.hidden = false; return; }

    try {
      const proj = await fetchProject(idOrSlug, byId);
      if (!proj) { loading.hidden = true; errState.textContent = "Project not found."; errState.hidden = false; return; }

      // Fetch versions (newest first)
      const { data: versions } = await sb.from("project_versions")
        .select("id, version_number, prompt, model, parent_version_id, origin, created_at, code")
        .eq("project_id", proj.id)
        .order("version_number", { ascending: false });

      const me = simweb.me();
      const viewerState = await loadViewerState(me?.id ?? null, proj.owner_id, proj.id);

      state.project = {
        id: proj.id,
        slug: proj.slug,
        title: proj.title,
        description: proj.description,
        visibility: proj.visibility,
        like_count: proj.like_count,
        favorite_count: proj.favorite_count,
        view_count: proj.view_count,
        fork_count: proj.fork_count,
        created_at: proj.created_at,
        updated_at: proj.updated_at,
        owner: {
          id: proj.owner_id,
          username: proj.owner_username,
          display_name: proj.owner_display_name,
          avatar_url: proj.owner_avatar_url,
        },
        current_version_id: proj.current_version_id,
      };
      state.versions = versions || [];
      state.viewer = viewerState;
      state.activeVersionId = state.project.current_version_id || (state.versions[0]?.id);

      const cur = state.versions.find(v => v.id === state.activeVersionId) || state.versions[0];
      renderIframe(cur?.code);

      renderHeader();
      renderActions();
      renderVersions();
      loading.hidden = true;
      layout.hidden = false;

      // Fire-and-forget view count
      bumpView(state.project.id);
    } catch (err) {
      loading.hidden = true;
      errState.textContent = err?.message || String(err);
      errState.hidden = false;
    }
  })();
})();
