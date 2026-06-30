/* =========================================================
   profile.js — /profile.html?u=username
   ========================================================= */
(() => {
  const simweb = window.simwebApi;
  const sb = simweb.client();
  simweb.renderTopNav();

  const head     = document.getElementById("head");
  const feed     = document.getElementById("feed");
  const more     = document.getElementById("feedMore");
  const tabs     = document.querySelectorAll(".tab");
  const favTab   = document.getElementById("favTab");

  const params = new URLSearchParams(location.search);
  const username = params.get("u") || simweb.me()?.user_metadata?.username || null;
  if (!username) {
    head.innerHTML = `<div class="who"><h2>Pick a profile</h2><p class="handle">Use the address bar like <code>?u=cooluser</code>.</p></div>`;
    feed.innerHTML = "";
    return;
  }

  let tab = "projects";
  tabs.forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));

  function switchTab(name) {
    tab = name;
    tabs.forEach(x => x.classList.toggle("active", x.dataset.tab === name));
    feed.innerHTML = "";
    more.innerHTML = "";
    load();
  }

  function card(p) {
    const initials = ((p.owner?.display_name || p.owner?.username || "?")[0] || "?").toUpperCase();
    const a = document.createElement("a");
    a.className = "card";
    a.href = `/project.html?id=${encodeURIComponent(p.id)}`;
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const fb = document.createElement("div");
    fb.className = "thumb-fallback"; fb.textContent = "loading…";
    thumb.appendChild(fb);
    a.appendChild(thumb);
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `
      <h3 class="title">${simweb.escapeHTML(p.title || "Untitled")}</h3>
      <p class="desc">${simweb.escapeHTML(p.description || "")}</p>
      <div class="row">
        <span class="owner"><span class="avatar">${simweb.escapeHTML(initials)}</span>
          <span>@${simweb.escapeHTML(p.owner?.username || "")}</span></span>
        <span class="stats">
          <span><span class="heart" style="color:var(--bad)">♥</span> ${simweb.fmtCompact(p.like_count)}</span>
          <span><span class="eye">👁</span> ${simweb.fmtCompact(p.view_count)}</span>
        </span>
      </div>`;
    a.appendChild(meta);
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue; io.disconnect();
        if (p.current_version?.code) {
          const f = document.createElement("iframe");
          f.setAttribute("sandbox","allow-scripts allow-forms allow-same-origin");
          thumb.appendChild(f);
          simweb.renderIframe(f, p.current_version.code);
          fb.remove();
        } else {
          fb.textContent = "no preview";
        }
      }
    }, { rootMargin: "200px" });
    io.observe(a);
    return a;
  }

  function shapeRow(r, byVid) {
    const v = r.current_version_id ? byVid[r.current_version_id] : null;
    return {
      id: r.id, slug: r.slug, title: r.title, description: r.description,
      like_count: r.like_count, favorite_count: r.favorite_count,
      view_count: r.view_count, fork_count: r.fork_count,
      created_at: r.created_at, updated_at: r.updated_at,
      owner: {
        username: r.owner_username,
        display_name: r.owner_display_name,
        avatar_url: r.owner_avatar_url,
      },
      current_version: v
        ? { id: r.current_version_id, version_number: v.version_number ?? 1, code: v.code ?? "" }
        : null,
    };
  }

  async function load() {
    more.innerHTML = "<span class='help'>loading…</span>";
    const me = simweb.me();
    const myUid = me?.id ?? null;
    try {
      let items = [];
      let header = "";
      if (tab === "favorites") {
        if (!simweb.isAuthed()) {
          feed.innerHTML = `<div class="feed-empty"><p>Log in to see your favorites.</p></div>`;
          more.innerHTML = "";
          header = ``;
          head.innerHTML = "";
          return;
        }
        header = `
          <div class="avatar-lg" style="background: linear-gradient(135deg,#ffb45a,#ff5e7e);">★</div>
          <div class="who"><h2>Your favorites</h2>
            <div class="handle">@${simweb.escapeHTML(me.user_metadata?.username || "")}</div></div>`;
        const { data: faves, error: favErr } = await sb
          .from("favorites").select("project_id, created_at")
          .eq("user_id", myUid)
          .order("created_at", { ascending: false })
          .limit(48);
        if (favErr) throw favErr;
        const vIds = (faves || []).map(f => f.project_id);
        if (!vIds.length) { items = []; }
        else {
          const { data: rows } = await sb
            .from("project_feed_v").select("*").in("id", vIds);
          const idMap = Object.fromEntries((rows || []).map(r => [r.id, r]));
          // restore favorite-at order
          const order = Object.fromEntries((faves || []).map((f, i) => [f.project_id, i]));
          (rows || []).sort((a, b) => (order[a.id] ?? 0) - (order[b.id] ?? 0));
          const vidIds = (rows || []).map(r => r.current_version_id).filter(Boolean);
          const byVid = {};
          if (vidIds.length) {
            const { data: vs } = await sb.from("project_versions")
              .select("id, version_number, code").in("id", vidIds);
            for (const v of vs || []) byVid[v.id] = v;
          }
          items = (rows || []).map(r => shapeRow(r, byVid));
        }
      } else {
        const { data: owner, error: ownErr } = await sb
          .from("users").select("id, username, display_name, bio, avatar_url, created_at")
          .eq("username", username).maybeSingle();
        if (ownErr) throw ownErr;
        if (!owner) { head.innerHTML = `<div class="who"><h2>User not found</h2></div>`; return; }
        const { data: rows } = await sb.from("project_feed_v").select("*")
          .eq("owner_id", owner.id)
          .order("updated_at", { ascending: false })
          .limit(48);
        const vidIds = (rows || []).map(r => r.current_version_id).filter(Boolean);
        const byVid = {};
        if (vidIds.length) {
          const { data: vs } = await sb.from("project_versions")
            .select("id, version_number, code").in("id", vidIds);
          for (const v of vs || []) byVid[v.id] = v;
        }
        items = (rows || []).map(r => shapeRow(r, byVid));
        const initials = ((owner.display_name || owner.username || "?")[0] || "?").toUpperCase();
        header = `
          <div class="avatar-lg">${simweb.escapeHTML(initials)}</div>
          <div class="who">
            <h2>${simweb.escapeHTML(owner.display_name || owner.username)}</h2>
            <div class="handle">@${simweb.escapeHTML(owner.username)} · ${items.length} project${items.length === 1 ? "" : "s"}</div>
            ${owner.bio ? `<p class="bio">${simweb.escapeHTML(owner.bio)}</p>` : ""}
          </div>`;
        if (myUid && myUid === owner.id) favTab.hidden = false;
      }
      head.innerHTML = header;
      if (!items.length) feed.innerHTML = `<div class="feed-empty"><p>Nothing here yet.</p></div>`;
      for (const p of items) feed.appendChild(card(p));
      more.innerHTML = "";
    } catch (err) {
      more.innerHTML = `<span class="help err">${simweb.escapeHTML(err.message || String(err))}</span>`;
    }
  }

  load();
})();
