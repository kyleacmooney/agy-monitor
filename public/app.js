"use strict";
/*
 * agy-monitor app shell — provides the globals the shared renderer expects
 * (el, runTool) plus the standalone-only layer: bearer-token auth, the SSE
 * change stream (window.AGY_SHELL.notify → instant refresh), connection-state
 * reporting (LIVE / RECONNECTING / OFFLINE → AGY_SHELL.conn + onConn), toasts,
 * and the self-update ("Improve") hooks the palette exposes. The renderer
 * itself stays host-portable (see render-agy-monitor.js).
 */
(() => {
  const TOKEN_KEY = "agy-monitor-token";

  // --- DOM helper (the same signature an embedding host would provide) -------
  window.el = function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") node.textContent = v;
      else if (k === "class") node.className = v;
      else if (k === "style") Object.assign(node.style, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v != null) node.setAttribute(k, v);
    }
    if (children) for (const c of [].concat(children)) if (c) node.appendChild(c);
    return node;
  };

  // --- auth -------------------------------------------------------------------
  let token = "";
  try { token = localStorage.getItem(TOKEN_KEY) || ""; } catch {}
  const authHeaders = () => (token ? { authorization: "Bearer " + token } : {});

  const signin = document.getElementById("signin");
  const signinToken = document.getElementById("signin-token");
  const signinErr = document.getElementById("signin-err");
  function showSignin() { signin.style.display = ""; signinToken.focus(); }
  async function trySignin() {
    const t = signinToken.value.trim();
    if (!t) return;
    const r = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + t }, body: JSON.stringify({ action: "list-workspaces" }) });
    if (r.status === 401) { signinErr.textContent = "That token didn't work."; return; }
    token = t;
    try { localStorage.setItem(TOKEN_KEY, t); } catch {}
    signin.style.display = "none";
    location.reload(); // clean re-boot with auth in place
  }
  document.getElementById("signin-go").addEventListener("click", trySignin);
  signinToken.addEventListener("keydown", (e) => { if (e.key === "Enter") trySignin(); });

  // --- backend RPC (the renderer's network primitive) --------------------------
  window.runTool = async function runTool(_toolId, input) {
    const r = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(input),
    });
    if (r.status === 401) { showSignin(); throw new Error("unauthorized"); }
    return r.json();
  };

  // --- toasts -------------------------------------------------------------------
  const toasts = document.getElementById("toasts");
  function toast(msg) {
    const t = window.el("div", { class: "agy-toast", text: msg });
    toasts.appendChild(t);
    setTimeout(() => { t.classList.add("gone"); setTimeout(() => t.remove(), 400); }, 3200);
  }

  // --- SSE change stream ----------------------------------------------------------
  // fetch-based reader (not EventSource) so the Authorization header works.
  // Any change event pokes the renderer's registered loader → instant refresh.
  // Connection state is published on AGY_SHELL.conn and pushed via .onConn so
  // the renderer can draw the sidebar LIVE dot + the reconnect/offline banner.
  function setConn(state, extra) {
    const shell = window.AGY_SHELL;
    shell.conn = Object.assign({ state }, extra || {});
    if (shell.onConn) { try { shell.onConn(shell.conn); } catch {} }
  }
  let backoff = 1000;
  async function streamLoop() {
    for (;;) {
      try {
        const r = await fetch("/api/stream", { headers: authHeaders() });
        if (r.status === 401) { setConn("offline", { lastAt: Date.now() }); showSignin(); return; }
        if (!r.ok || !r.body) throw new Error("stream " + r.status);
        setConn("live"); backoff = 1000;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            if (!/^event: (sessions|approvals|runs|convo)$/m.test(frame)) continue;
            if (window.AGY_SHELL.notify) { try { window.AGY_SHELL.notify(); } catch {} }
          }
        }
        throw new Error("stream ended");
      } catch {
        // first drop → "reconnecting" (short retries); repeated failure → "offline"
        const st = backoff >= 8000 ? "offline" : "reconnecting";
        setConn(st, { retryMs: backoff, lastAt: Date.now() });
        await new Promise((res) => setTimeout(res, backoff));
        backoff = Math.min(backoff * 2, 15000);
      }
    }
  }

  // --- "Improve this app" (self-update) ------------------------------------------
  // Standalone-only (the routes don't exist on a hub host). No dedicated button in
  // the v3 design — the renderer's command palette calls AGY_SHELL.improve() when
  // AGY_SHELL.improveEnabled is true.
  let watching = false;
  async function refreshImproveVisibility() {
    try {
      const r = await fetch("/api/self-update/status", { headers: authHeaders() });
      if (!r.ok) return;
      const st = await r.json();
      window.AGY_SHELL.improveEnabled = !!st.enabled;
    } catch {}
  }
  async function watchSelfUpdate() {
    if (watching) return;
    watching = true;
    for (let i = 0; i < 150; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      let st;
      try { st = await (await fetch("/api/self-update/status", { headers: authHeaders() })).json(); } catch { continue; }
      if (st.state === "applied") { toast("✓ Improvement applied — reloading"); setTimeout(() => location.reload(), 1200); break; }
      if (st.state === "rolled-back") { toast("Reverted — the change broke the health check"); break; }
      if (st.state === "rejected") { toast("Rejected — the edit didn't parse; nothing changed"); break; }
      if (st.state === "no-changes") { toast("No changes were made"); break; }
      if (st.state === "error") { toast("Self-update error — see the log"); break; }
    }
    watching = false;
  }
  async function improve(request) {
    if (!request || !request.trim()) return;
    try {
      const r = await fetch("/api/self-update", { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify({ request: request.trim() }) });
      const out = await r.json();
      if (out.ok) { toast("Working on it — I'll reload when it's applied"); watchSelfUpdate(); }
      else toast(out.message || "Couldn't start the improvement");
    } catch (e) { toast("Error: " + (e && e.message ? e.message : e)); }
  }

  // the contract render-agy-monitor.js looks for (must exist before it loads)
  window.AGY_SHELL = {
    notify: null,                 // renderer sets this; SSE events call it
    toast,
    conn: { state: "reconnecting" }, // live | reconnecting | offline
    onConn: null,                 // renderer sets this to redraw conn UI
    improveEnabled: false,
    improve,
  };

  refreshImproveVisibility();
  streamLoop();
})();
