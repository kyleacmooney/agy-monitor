"use strict";
/*
 * agy-mcp — enumerate + probe the MCP servers agy (Antigravity CLI) can use.
 *
 * Config sources (merged, later wins on name collisions). These are the files
 * Antigravity CLI itself reads — verified against agy 1.1.4's bundled docs
 * (builtin/skills/agy-customizations/docs/mcp_servers.md) and its binary:
 *   ~/.gemini/config/mcp_config.json          .mcpServers   (global — all sessions)
 *   ~/.gemini/antigravity-cli/plugins/<n>/mcp_config.json   (per plugin, when enabled)
 *   ~/.gemini/plugins/<n>/mcp_config.json                   (per plugin, alt location)
 *
 * NOTE: agy does NOT read ~/.gemini/settings.json for MCP — that's gemini-cli's
 * config. Reading it made this panel show servers agy never actually loads.
 *
 * agy supports exactly two transports (per its own docs + binary):
 *   - stdio (command/args/env):  a local process, JSON-RPC over its stdio
 *   - sse   (serverUrl):         a remote endpoint, HTTP+SSE transport
 * A plain streamable-HTTP `httpUrl`/`url` is IGNORED by agy — we surface such a
 * server as an error explaining the fix, rather than probing it as if it worked.
 *
 * Each server gets a REAL MCP handshake (initialize → tools/list). Probes are
 * slow-ish and servers rarely change, so results cache in memory + on disk
 * (MON_ROOT/mcp-cache.json) — 10 min for successes, 30 s for errors.
 *
 * Skills: agy has no first-class skill registry today; we surface any
 * <AGY_CLI_HOME>/skills/<name>/SKILL.md or <workspace>/.agy/skills/* found so
 * the panel + slash menu light up if that ever materializes.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MON_ROOT = process.env.AGY_MONITOR_ROOT || path.join(os.homedir(), ".agy-monitor");
const AGY_DIR = process.env.AGY_CLI_HOME || path.join(os.homedir(), ".gemini", "antigravity-cli");
const GEMINI_HOME = process.env.AGY_GEMINI_HOME || path.join(os.homedir(), ".gemini"); // overridable for tests
const CACHE_FILE = path.join(MON_ROOT, "mcp-cache.json");
const PROBE_TIMEOUT_MS = 5000;
const OK_TTL_MS = 10 * 60 * 1000;
const ERR_TTL_MS = 30 * 1000;
const PROTOCOL = "2025-03-26";

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// ---- config -----------------------------------------------------------------

// Every plugins/<name>/mcp_config.json under the given roots (best-effort).
function pluginConfigFiles() {
  const roots = [path.join(AGY_DIR, "plugins"), path.join(GEMINI_HOME, "plugins")];
  const files = [];
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) files.push(path.join(root, n, "mcp_config.json"));
  }
  return files;
}

function configuredServers() {
  // agy reads MCP from mcp_config.json only — global first, then plugins.
  const sources = [path.join(GEMINI_HOME, "config", "mcp_config.json"), ...pluginConfigFiles()];
  const merged = {};
  for (const f of sources) {
    const s = readJsonSafe(f, {});
    const m = s && typeof s.mcpServers === "object" ? s.mcpServers : null;
    if (!m) continue;
    for (const [name, cfg] of Object.entries(m)) {
      if (cfg && typeof cfg === "object") merged[name] = cfg;
    }
  }
  return merged;
}

// Which transport agy would use for this entry (agy honours command + serverUrl).
function transportKind(cfg) {
  if (cfg.command) return "stdio";
  if (cfg.serverUrl) return "sse";
  if (cfg.httpUrl || cfg.url) return "http-unsupported";
  return "unknown";
}

function transportOf(cfg) {
  const kind = transportKind(cfg);
  if (kind === "stdio") return "stdio";
  if (kind === "sse") {
    try { return "sse · " + new URL(cfg.serverUrl).host; } catch { return "sse"; }
  }
  if (kind === "http-unsupported") {
    try { return "http · " + new URL(cfg.httpUrl || cfg.url).host + " (ignored)"; } catch { return "http (ignored)"; }
  }
  return "misconfigured";
}

function serverHash(name, cfg) {
  return name + "|" + JSON.stringify(cfg);
}

// ---- cache ------------------------------------------------------------------

let _mem = null;
function loadCache() {
  if (!_mem) _mem = readJsonSafe(CACHE_FILE, {});
  return _mem;
}
function saveCache() {
  try {
    fs.mkdirSync(MON_ROOT, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_mem || {}));
  } catch {}
}
function cached(hash) {
  const c = loadCache()[hash];
  if (!c) return null;
  const ttl = c.status === "connected" ? OK_TTL_MS : ERR_TTL_MS;
  return Date.now() - (c.at || 0) < ttl ? c : null;
}
function remember(hash, entry) {
  loadCache()[hash] = Object.assign({ at: Date.now() }, entry);
  saveCache();
}

// ---- probes -----------------------------------------------------------------

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
const note = (method, params) => JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
const INIT_PARAMS = {
  protocolVersion: PROTOCOL,
  capabilities: {},
  clientInfo: { name: "agy-monitor", version: "0.2.0" },
};

// The panel can expand a description now, so send the whole thing rather than the
// old one-line/140-char display cut. Still bounded: a chatty server advertising 40
// tools shouldn't be able to push an unbounded blob into every poll.
const DESC_MAX = 1200;

function normTools(result) {
  const tools = (result && Array.isArray(result.tools)) ? result.tools : [];
  return tools.slice(0, 40).map((t) => ({
    name: String(t.name || "?"),
    description: String(t.description || "").trim().slice(0, DESC_MAX),
  }));
}

function probeStdio(cfg) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cfg.command, cfg.args || [], {
        stdio: ["pipe", "pipe", "ignore"],
        env: Object.assign({}, process.env, cfg.env || {}),
      });
    } catch (e) {
      return resolve({ status: "error", error: String((e && e.message) || e), tools: [] });
    }
    let buf = "";
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(out);
    };
    const timer = setTimeout(() => finish({ status: "error", error: "timed out after " + PROBE_TIMEOUT_MS / 1000 + "s", tools: [] }), PROBE_TIMEOUT_MS);
    child.on("error", (e) => finish({ status: "error", error: String((e && e.message) || e), tools: [] }));
    child.on("exit", (code) => finish({ status: "error", error: "exited (" + code + ") during handshake", tools: [] }));
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { // initialize reply → ack, then list tools
          try {
            child.stdin.write(note("notifications/initialized", {}));
            child.stdin.write(rpc(2, "tools/list", {}));
          } catch {}
        } else if (msg.id === 2) {
          finish({ status: "connected", error: null, tools: normTools(msg.result) });
        }
      }
    });
    try { child.stdin.write(rpc(1, "initialize", INIT_PARAMS)); } catch {}
  });
}

// SSE transport (agy's `serverUrl`): open a GET event-stream, wait for the
// `endpoint` event that names the POST URL, then POST the JSON-RPC handshake and
// read the replies back off the stream. Correlate by request id.
async function probeSse(cfg) {
  const url = cfg.serverUrl;
  if (!url) return { status: "error", error: "no serverUrl configured", tools: [] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const hdrs = cfg.headers || {};
  let origin;
  try { origin = new URL(url); } catch { clearTimeout(timer); return { status: "error", error: "invalid serverUrl", tools: [] }; }
  const postTo = async (endpoint, body) => {
    const target = new URL(endpoint, origin).toString();
    await fetch(target, {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, hdrs),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).catch(() => {});
  };
  try {
    const res = await fetch(url, { method: "GET", headers: Object.assign({ accept: "text/event-stream" }, hdrs), signal: ctrl.signal });
    if (!res.ok || !res.body) return { status: "error", error: "HTTP " + res.status + " opening SSE stream", tools: [] };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sbuf = "";
    let endpoint = null;
    let initialized = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      sbuf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = sbuf.indexOf("\n\n")) >= 0) {
        const raw = sbuf.slice(0, sep); sbuf = sbuf.slice(sep + 2);
        let ev = "message", data = "";
        for (const l of raw.split("\n")) {
          if (l.startsWith("event:")) ev = l.slice(6).trim();
          else if (l.startsWith("data:")) data += l.slice(5).trim();
        }
        if (ev === "endpoint") {
          endpoint = data;
          await postTo(endpoint, { jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS });
        } else if (ev === "message" && endpoint) {
          let msg; try { msg = JSON.parse(data); } catch { continue; }
          if (msg.id === 1 && !initialized) {
            initialized = true;
            await postTo(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" });
            await postTo(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          } else if (msg.id === 2) {
            return { status: "connected", error: null, tools: normTools(msg.result) };
          }
        }
      }
    }
    return { status: "error", error: "SSE stream ended before handshake completed", tools: [] };
  } catch (e) {
    const code = e && e.cause && e.cause.code;
    const msg = code ? code : (e && e.name === "AbortError" ? "timed out after " + PROBE_TIMEOUT_MS / 1000 + "s" : String((e && e.message) || e));
    return { status: "error", error: msg + " — is the SSE server reachable?", tools: [] };
  } finally {
    clearTimeout(timer);
    try { ctrl.abort(); } catch {}
  }
}

// Dispatch to the right probe for what agy would actually do with this entry.
function probeServer(cfg) {
  const kind = transportKind(cfg);
  if (kind === "stdio") return probeStdio(cfg);
  if (kind === "sse") return probeSse(cfg);
  if (kind === "http-unsupported") {
    return Promise.resolve({ status: "error", error: "agy ignores httpUrl/url — use serverUrl (SSE) or command (stdio)", tools: [] });
  }
  return Promise.resolve({ status: "error", error: "no command or serverUrl configured", tools: [] });
}

// ---- skills -----------------------------------------------------------------

function skillDirs(workspace) {
  const dirs = [path.join(AGY_DIR, "skills")];
  if (workspace) dirs.push(path.join(workspace, ".agy", "skills"));
  return dirs;
}
function listSkills(workspace) {
  const skills = [];
  for (const dir of skillDirs(workspace)) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const md = path.join(dir, n, "SKILL.md");
      let desc = "";
      try {
        const head = fs.readFileSync(md, "utf8").slice(0, 2000);
        const dm = head.match(/^description:\s*(.+)$/m);
        desc = dm ? dm[1].trim().slice(0, DESC_MAX) : "";
      } catch { continue; }
      skills.push({ name: n, description: desc });
    }
  }
  return skills;
}

// ---- public API -------------------------------------------------------------

async function listMcp(workspace) {
  const cfgs = configuredServers();
  const servers = await Promise.all(Object.entries(cfgs).map(async ([name, cfg]) => {
    const hash = serverHash(name, cfg);
    let probe = cached(hash);
    if (!probe) {
      probe = await probeServer(cfg);
      remember(hash, probe);
    }
    return {
      name,
      transport: transportOf(cfg),
      status: probe.status,
      error: probe.error || null,
      tools: probe.tools || [],
    };
  }));
  return { ok: true, servers, skills: listSkills(workspace) };
}

// Cache-only view for the slash-command list (never blocks on probes).
function cachedMcp(workspace) {
  const cfgs = configuredServers();
  const servers = [];
  for (const [name, cfg] of Object.entries(cfgs)) {
    const c = loadCache()[serverHash(name, cfg)]; // stale is fine here
    servers.push({ name, transport: transportOf(cfg), status: c ? c.status : "unknown", error: c ? c.error : null, tools: (c && c.tools) || [] });
  }
  return { servers, skills: listSkills(workspace) };
}

module.exports = { listMcp, cachedMcp };
