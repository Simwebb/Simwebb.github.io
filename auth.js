/* =========================================================
   auth.js — login + signup form behaviors (shared by both pages)

   Uses supabase.auth.signUp / signInWithPassword directly from the
   browser. Username uniqueness is enforced server-side by the
   `handle_new_auth_user` trigger (Postgres throws "username_taken"
   if there is a collision), which atomically rolls back the auth row.
   ========================================================= */

(() => {
  const simweb = window.simwebApi;
  const sb = simweb.client();
  simweb.renderTopNav();

  const form = document.getElementById("signupForm") || document.getElementById("loginForm");
  if (!form) return;
  const isSignup = !!document.getElementById("signupForm");
  const errMsg   = document.getElementById("errMsg");
  const submit   = document.getElementById("submitBtn");

  function showError(msg) {
    if (!errMsg) return;
    errMsg.textContent = msg;
    errMsg.hidden = false;
  }
  function clearError() {
    if (!errMsg) return;
    errMsg.hidden = true;
    errMsg.textContent = "";
  }

  if (isSignup) {
    const u = document.getElementById("su_username");
    const help = document.getElementById("su_username_help");
    if (u && help) {
      u.addEventListener("input", () => {
        const v = u.value.trim().toLowerCase();
        u.classList.remove("invalid");
        if (!v) { help.textContent = "Lowercase letters, digits, underscores."; help.classList.remove("err"); return; }
        if (!/^[a-z0-9_]{3,24}$/.test(v)) {
          u.classList.add("invalid");
          help.textContent = "3-24 chars of [a-z0-9_]. No spaces, no uppercase.";
          help.classList.add("err");
          return;
        }
        help.textContent = "Looks good — we'll check on submit.";
        help.classList.remove("err");
      });
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError();
    submit.disabled = true;
    submit.textContent = isSignup ? "Creating…" : "Logging in…";

    try {
      if (isSignup) {
        const email        = document.getElementById("su_email").value.trim();
        const username     = document.getElementById("su_username").value.trim().toLowerCase();
        const display_name = (document.getElementById("su_display")?.value || "").trim() || username;
        const password     = document.getElementById("su_password").value;

        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: {
            data: { username, display_name },
          },
        });
        if (error) throw friendlyAuthError(error);

        // If your Supabase project has "Confirm email" turned on, `data.session`
        // is null and the user has to confirm via email before they can sign in.
        if (!data?.session) {
          throw new Error("Account created — check your email to confirm, then log in.");
        }
      } else {
        const email    = document.getElementById("li_email").value.trim();
        const password = document.getElementById("li_password").value;
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw friendlyAuthError(error);
      }

      // The supabase client persists the session in localStorage already.
      const params = new URLSearchParams(location.search);
      const next = params.get("next");
      location.href = next || "create.html";
    } catch (err) {
      showError(err.message || "Something went wrong.");
      submit.disabled = false;
      submit.textContent = isSignup ? "Create account" : "Log in";
    }
  });

  function friendlyAuthError(err) {
    const msg = (err?.message || "").toLowerCase();
    if (/invalid_username|invalid username/i.test(err?.message || "")) {
      return new Error("Username must be 3-24 chars of [a-z0-9_].");
    }
    if (/username_taken/i.test(err?.message || "")) {
      return new Error("That username is already taken.");
    }
    if (/already registered|already been registered/i.test(msg)) {
      return new Error("An account with that email already exists — try logging in.");
    }
    if (/invalid login credentials|invalid credentials/i.test(msg)) {
      return new Error("Wrong email or password.");
    }
    if (/password/i.test(msg) && /short|6 char|at least/i.test(msg)) {
      return new Error("Password must be at least 6 characters.");
    }
    return err;
  }
})();
