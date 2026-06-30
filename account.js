/* =========================================================
   account.js — /account.html
   ========================================================= */
(() => {
  const simweb = window.simwebApi;
  const sb = simweb.client();

  const $ = (id) => document.getElementById(id);

  simweb.renderTopNav();

  // Listen for the (post-load) auth state to retry rendering if needed.
  simweb.client(); // ensure init
  window.addEventListener("simweb:auth", maybeBoot);

  async function maybeBoot() {
    if (!simweb.isAuthed()) {
      simweb.redirectToLogin("account.html");
      return;
    }
    if ($("usernameInput").dataset.loaded === "1") return;
    await boot();
  }

  async function boot() {
    const me = simweb.me();
    $("usernameInput").dataset.loaded = "1";
    $("who").innerHTML =
      `Signed in as <b style="color:var(--txt)">@${simweb.escapeHTML(me.user_metadata?.username || "")}</b>` +
      (me.email ? ` &middot; ${simweb.escapeHTML(me.email)}` : "");
    $("emailInput").value = me.email || "";

    try {
      const { data: profile, error } = await sb.from("users")
        .select("id, username, display_name, bio, deleted_at, deletion_reason")
        .eq("id", me.id).maybeSingle();
      if (error) throw error;

      paintProfile(profile);
      const projectCount = await countProjects(me.id);
      await paintPending(profile, projectCount);
      wire(profile);
    } catch (e) {
      $("who").textContent = "Couldn't load profile: " + (e?.message || e);
    }
  }

  function paintProfile(p) {
    $("usernameInput").value = p.username || "";
    const me = simweb.me();
    $("displayInput").value = p.display_name || p.username || "";
    $("bioInput").value = p.bio || "";
    $("bioCount").textContent = ($("bioInput").value || "").length;
  }

  async function countProjects(uid) {
    const { count } = await sb.from("projects").select("id", { count: "exact", head: true }).eq("owner_id", uid);
    return count || 0;
  }

  let timer = null;

  async function paintPending(profile, projectCount) {
    if (!profile || !profile.deleted_at) {
      $("pendingBanner").hidden = true;
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }
    $("pendingBanner").hidden = false;
    $("pendCountUsername").textContent = "@" + profile.username;
    $("pendProjectCount").textContent = projectCount;
    $("pendProjsPlural").textContent = projectCount === 1 ? "" : "s";
    const deadline = new Date(new Date(profile.deleted_at).getTime() + 14 * 86400_000);
    function tick() {
      const remaining = Math.max(0, Math.floor((deadline.getTime() - Date.now()) / 1000));
      const d = Math.floor(remaining / 86400);
      const h = Math.floor((remaining % 86400) / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      const s = remaining % 60;
      let label;
      if (remaining <= 0) label = "soon";
      else if (d > 0)   label = `${d}d ${h}h`;
      else if (h > 0)   label = `${h}h ${m}m`;
      else if (m > 0)   label = `${m}m ${s}s`;
      else              label = `${s}s`;
      $("pendCountdown").textContent = label;
    }
    tick();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000);
  }

  function wire(profile) {
    $("bioInput").addEventListener("input", () => {
      $("bioCount").textContent = $("bioInput").value.length;
    });

    $("saveBtn").addEventListener("click", async () => {
      $("saveMsg").textContent = "";
      try {
        const { data, error } = await sb.from("users").update({
          display_name: $("displayInput").value.trim().slice(0, 64),
          bio: $("bioInput").value.slice(0, 240),
        }).eq("id", simweb.me().id)
          .select("id, username, display_name, bio").single();
        if (error) throw error;
        paintProfile(data);
        $("saveMsg").textContent = "Saved.";
        $("saveMsg").className = "help";
      } catch (e) {
        $("saveMsg").textContent = e?.message || "Failed.";
        $("saveMsg").className = "help err";
      }
    });

    $("logoutBtn").addEventListener("click", async () => {
      await simweb.signOut();
      location.href = "index.html";
    });

    $("restoreBtn").addEventListener("click", async () => {
      $("dangerMsg").textContent = "Restoring…";
      try {
        const { error } = await sb.from("users").update({
          deleted_at: null,
          deletion_reason: null,
        }).eq("id", simweb.me().id);
        if (error) throw error;
        $("dangerMsg").textContent = "Account restored.";
        $("dangerMsg").className = "help";
        setTimeout(() => location.reload(), 800);
      } catch (e) {
        $("dangerMsg").textContent = e?.message || "Failed.";
        $("dangerMsg").className = "help err";
      }
    });

    const dlBtn = $("deleteBtn");
    const dlDlg = $("confirmDlg");
    const dlInput = $("confirmInput");
    const dlConfirm = $("confirmDeleteBtn");

    dlBtn.addEventListener("click", () => {
      if (profile && profile.deleted_at) return;
      $("confirmUsername").textContent = "@" + profile.username;
      dlInput.value = "";
      dlConfirm.disabled = true;
      dlDlg.showModal();
    });
    dlInput.addEventListener("input", () => {
      dlConfirm.disabled = dlInput.value.trim() !== profile.username;
    });
    dlConfirm.addEventListener("click", async () => {
      if (dlConfirm.disabled) return;
      try {
        const { error } = await sb.from("users").update({
          deleted_at: new Date().toISOString(),
          deletion_reason: "user-initiated",
        }).eq("id", simweb.me().id);
        if (error) throw error;
        const fresh = await sb.from("users")
          .select("id, username, display_name, bio, deleted_at, deletion_reason")
          .eq("id", simweb.me().id).single();
        const cnt = await countProjects(simweb.me().id);
        await paintPending(fresh.data || {}, cnt);
        dlDlg.close();
      } catch (e) {
        $("dangerMsg").textContent = e?.message || "Failed.";
        $("dangerMsg").className = "help err";
      }
    });
  }

  // Kick off once the auth state has settled. If the user is already
  // signed in (the page reload preserved their session), boot() runs
  // immediately on the next tick.
  maybeBoot();
})();
