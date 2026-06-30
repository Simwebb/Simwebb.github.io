/* =========================================================
   feed.js — home page: load project feed, render cards, sort, paginate.
   ========================================================= */

(() => {
  const simweb = window.simwebApi;
  const sb = simweb.client();
  simweb.renderTopNav();

  const feedEl = document.getElementById("feed");
  const moreEl = document.getElementById("feedMore");

  let state = { sort: "new", page: 0, loading: false, done: false, pageSize: 24 };

  const sortBtns = document.querySelectorAll(".sortbar button");
  sortBtns.forEach(b => b.addEventListener("click", () => {
    if (state.sort === b.dataset.sort) return;
    sortBtns.forEach(x => x.classList.toggle("active", x === b));
    state.sort = b.dataset.sort;
    state.page = 0; state.done = false;
    feedEl.innerHTML = "";
    load(true);
  }));

  function card(p) {
    const initials = ((p.owner?.display_name || p.owner?.username || "?")[0] || "?").toUpperCase();
    const a = document.createElement("a");
    a.className = "card";
    a.href = `/project.html?id=${encodeURIComponent(p.id)}`;

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const fb = document.createElement("div");
    fb.className = "thumb-fallback";
    fb.textContent = "loading…";
    thumb.appendChild(fb);
    a.appendChild(thumb);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `
      <h3 class="title">${simweb.escapeHTML(p.title || "Untitled")}</h3>
      <p class="desc">${simweb.escapeHTML(p.description || "")}</p>
      <div class="row">
        <a class="owner" href="/profile.html?u=${encodeURIComponent(p.owner?.username || "")}"
           onclick="event.stopPropagation()">
          <span class="avatar">${simweb.escapeHTML(initials)}</span>
          <span>@${simweb.escapeHTML(p.owner?.username || "")}</span>
        </a>
        <span class="stats">
          <span class="stat" title="views"><span class="eye">👁</span>${simweb.fmtCompact(p.view_count)}</span>
          <span class="stat" title="likes"><span class="heart">♥</span>${simweb.fmtCompact(p.like_count)}</span>
          <span class="stat" title="updated">${simweb.fmtTime(p.updated_at)}</span>
        </span>
      </div>
    `;
    a.appendChild(meta);

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.disconnect();
        if (p.current_version?.code) {
          const f = document.createElement("iframe");
          f.setAttribute("loading", "lazy");
          f.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");
          f.addEventListener("load", () => {
            try {
              f.contentWindow.addEventListener("click", (ev) => {
                const link = ev.target?.closest && ev.target.closest("a");
                if (!link) return;
                ev.preventDefault();
                location.href = `/project.html?id=${encodeURIComponent(p.id)}`;
              }, true);
            } catch (_) {}
          });
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

  async function fetchVersionsById(ids) {
    if (!ids.length) return {};
    const { data } = await sb.from("project_versions").select("id, version_number, code").in("id", ids);
    const map = {};
    for (const v of data || []) map[v.id] = v;
    return map;
  }

  function shapeRow(r, byVid) {
    const v = r.current_version_id ? byVid[r.current_version_id] : null;
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      description: r.description,
      like_count: r.like_count,
      favorite_count: r.favorite_count,
      view_count: r.view_count,
      fork_count: r.fork_count,
      created_at: r.created_at,
      updated_at: r.updated_at,
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

  async function load(reset = false) {
    if (state.loading || state.done) return;
    state.loading = true;
    if (reset) moreEl.innerHTML = "";

    try {
      let q = sb.from("project_feed_v").select("*");
      if (state.sort === "top") {
        q = q.order("like_count", { ascending: false, nullsFirst: false });
      } else if (state.sort === "hot") {
        q = q.order("like_count", { ascending: false, nullsFirst: false })
             .order("updated_at", { ascending: false });
      } else {
        q = q.order("updated_at", { ascending: false });
      }
      const from = state.page * state.pageSize;
      const to = from + state.pageSize - 1;
      q = q.range(from, to);

      const { data: rows, error } = await q;
      if (error) throw error;
      const ids = (rows ?? []).map(r => r.current_version_id).filter(Boolean);
      const byVid = await fetchVersionsById(ids);
      const items = (rows ?? []).map(r => shapeRow(r, byVid));

      if (reset) feedEl.innerHTML = "";
      if (items.length === 0 && reset) {
        feedEl.innerHTML = `<div class="feed-empty">
          <p>Nobody has built anything yet.</p>
          <p><a class="btn primary" href="create.html">Be the first →</a></p>
        </div>`;
      }
      for (const p of items) feedEl.appendChild(card(p));

      if (!items.length) {
        state.done = true;
        moreEl.innerHTML = "<span class='help'>— end of feed —</span>";
      } else if (items.length === state.pageSize) {
        state.page += 1;
        const btn = document.createElement("button");
        btn.className = "btn ghost";
        btn.textContent = "Load more";
        btn.addEventListener("click", () => load());
        moreEl.innerHTML = "";
        moreEl.appendChild(btn);
      } else {
        state.done = true;
        moreEl.innerHTML = "<span class='help'>— end of feed —</span>";
      }
    } catch (err) {
      moreEl.innerHTML = `<span class="help err">${simweb.escapeHTML(err.message || String(err))}</span>`;
    } finally {
      state.loading = false;
    }
  }

  window.addEventListener("scroll", () => {
    if (state.done) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 600;
    if (nearBottom) load();
  });

  load(true);
})();
