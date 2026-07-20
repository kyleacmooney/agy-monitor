"use strict";
/*
 * agy-monitor server — standalone always-on local web app.
 *
 *   node server.js            → http://127.0.0.1:8719
 *   env: PORT, BIND_HOST, AGY_MONITOR_TOKEN (bearer; empty = open on loopback),
 *        AGY_MONITOR_ROOT (state dir, default ~/.agy-monitor),
 *        AGY_CLI_HOME (agy data dir, default ~/.gemini/antigravity-cli)
 *   Any of these can also live in ~/.agy-monitor/config.json (agy-config.js;
 *   the environment wins over the file).
 *
 * Routes:
 *   GET  /api/health        no auth   {ok, name, version, ts, approvals, liveRuns}
 *   POST /api/run           bearer    {action, ...} → agyMonitor.run() (RPC; the
 *                                     same contract an embedding host's runTool uses)
 *   GET  /api/stream        bearer    SSE: typed change events (sessions/approvals/
 *                                     runs/convo) driven by fs watchers — replaces
 *                                     blind 4s client polling
 *   GET  /*                 static    public/ + the shared renderer, all no-cache
 *
 * Exposure model: always bind loopback; remote access is a
 * fronting layer (Tailscale serve) + the bearer token.
 */

require("./agy-config").load(); // before any module that reads env at require time

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { agyMonitor } = require("./agy-monitor");
const { AgyEvents, MON_ROOT, AGY_DIR } = require("./agy-events");
const { RunManager } = require("./agy-runs");
const selfUpdate = require("./agy-selfupdate");
const PKG = require("./package.json");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const RATE_LIMIT = { windowMs: 60000, max: 600 }; // POSTs per IP per minute — the v3 console makes ~9 RPCs per refresh tick
const BODY_CAP = 12 << 20; // 12 MB — composer attachments arrive base64 in upload-attachment
const SSE_HEARTBEAT_MS = 25000;

function agyBin() {
  const cand = path.join(require("os").homedir(), ".local", "bin", "agy");
  try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch { return "agy"; }
}

function tokenOk(req, token) {
  if (!token) return true;
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

function start(opts = {}) {
  const port = opts.port != null ? opts.port : parseInt(process.env.PORT || "8719", 10);
  const bindHost = opts.bindHost || process.env.BIND_HOST || "127.0.0.1";
  const token = opts.token != null ? opts.token : (process.env.AGY_MONITOR_TOKEN || "");

  const events = new AgyEvents().start();
  const runManager = new RunManager({ agyBin: opts.agyBin || process.env.AGY_GATE_AGY_BIN || agyBin(), events });
  const config = { runManager, events, agyDir: AGY_DIR };
  const rate = new Map(); // ip → [timestamps]

  function rateLimited(ip) {
    const now = Date.now();
    const arr = (rate.get(ip) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
    arr.push(now);
    rate.set(ip, arr);
    return arr.length > RATE_LIMIT.max;
  }

  function approvalsCount() {
    try { return fs.readdirSync(path.join(MON_ROOT, "approvals")).filter((f) => f.endsWith(".json")).length; } catch { return 0; }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/api/health") {
      return sendJson(res, 200, { ok: true, name: "agy-monitor", version: PKG.version, ts: Date.now(), approvals: approvalsCount(), liveRuns: runManager.liveCount() });
    }

    if (p.startsWith("/api/")) {
      if (!tokenOk(req, token)) return sendJson(res, 401, { ok: false, message: "unauthorized" });

      if (p === "/api/stream" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write("retry: 3000\n\n");
        res.write(`event: hello\ndata: ${JSON.stringify({ version: PKG.version, ts: Date.now() })}\n\n`);
        const onChange = (ev) => { try { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); } catch {} };
        events.on("change", onChange);
        const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, SSE_HEARTBEAT_MS);
        req.on("close", () => { clearInterval(hb); events.removeListener("change", onChange); });
        return;
      }

      // "Improve this app" — inert unless AGY_MONITOR_SELF_UPDATE=1 (see agy-selfupdate.js)
      if (p === "/api/self-update/status" && req.method === "GET") {
        return sendJson(res, 200, Object.assign({ ok: true, enabled: selfUpdate.enabled() }, selfUpdate.readStatus(MON_ROOT)));
      }
      if (p === "/api/self-update" && req.method === "POST") {
        if (!selfUpdate.enabled()) return sendJson(res, 403, { ok: false, message: "Self-update is turned off (set AGY_MONITOR_SELF_UPDATE=1)." });
        const ip = req.socket.remoteAddress || "?";
        if (rateLimited(ip)) return sendJson(res, 429, { ok: false, message: "rate limited" });
        let body = "";
        req.on("data", (d) => { body += d; if (body.length > BODY_CAP) { sendJson(res, 413, { ok: false, message: "body too large" }); req.destroy(); } });
        req.on("end", () => {
          if (res.writableEnded) return;
          let input;
          try { input = JSON.parse(body || "{}"); } catch { return sendJson(res, 400, { ok: false, message: "bad JSON" }); }
          const out = selfUpdate.startSelfUpdate({ request: input.request, model: input.model, stateDir: MON_ROOT, port, label: selfUpdate.DAEMON_LABEL });
          return sendJson(res, out.ok ? 200 : 400, out);
        });
        return;
      }

      if (p === "/api/run" && req.method === "POST") {
        const ip = req.socket.remoteAddress || "?";
        if (rateLimited(ip)) return sendJson(res, 429, { ok: false, message: "rate limited" });
        let body = "";
        req.on("data", (d) => { body += d; if (body.length > BODY_CAP) { sendJson(res, 413, { ok: false, message: "body too large" }); req.destroy(); } });
        req.on("end", async () => {
          if (res.writableEnded) return;
          let input;
          try { input = JSON.parse(body || "{}"); } catch { return sendJson(res, 400, { ok: false, message: "bad JSON" }); }
          if (input && input.input && input.toolId) input = input.input; // legacy {toolId,input} body shape {toolId, input}
          try {
            const out = await agyMonitor.run(input, config);
            return sendJson(res, 200, out == null ? { ok: false, message: "no result" } : out);
          } catch (e) {
            return sendJson(res, 500, { ok: false, message: "action failed: " + (e && e.message ? e.message : e) });
          }
        });
        return;
      }

      return sendJson(res, 404, { ok: false, message: "not found" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { ok: false, message: "method not allowed" });

    // static: public/, plus the shared renderer which lives at the repo root so
    // it stays a drop-in for an embedding host
    let file = p === "/" ? path.join(PUBLIC_DIR, "index.html")
      : p === "/render-agy-monitor.js" ? path.join(__dirname, "render-agy-monitor.js")
      : path.join(PUBLIC_DIR, path.normalize(p).replace(/^([/\\])+/, ""));
    if (!file.startsWith(PUBLIC_DIR) && file !== path.join(__dirname, "render-agy-monitor.js")) {
      return sendJson(res, 404, { ok: false, message: "not found" });
    }
    fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { ok: false, message: "not found" });
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, bindHost, () => {
      resolve({
        server,
        port: server.address().port,
        events,
        runManager,
        close() { events.stop(); return new Promise((r) => server.close(r)); },
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(({ port }) => {
    console.log(`agy-monitor v${PKG.version} → http://127.0.0.1:${port}`);
  }).catch((e) => { console.error("failed to start:", e.message); process.exit(1); });
}
