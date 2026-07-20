"use strict";
/*
 * agy-config — optional file-based configuration, so a daemon install never
 * needs its plist edited: ~/.agy-monitor/config.json (under AGY_MONITOR_ROOT)
 * is a flat { "ENV_NAME": "value" } object applied to process.env at startup.
 *
 * The environment always wins — a key already set in the env is never
 * overridden, which also keeps test fixtures (which configure via env)
 * hermetic. Only PORT, BIND_HOST, and AGY_- or ANTHROPIC_-prefixed keys are honored.
 *
 * load() must run before any module that reads process.env at require time
 * (agy-anthropic.js resolves its provider on require), so entry points call it
 * first thing: server.js, bin/doctor.js, install-hooks.js.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ALLOWED = (k) => k === "PORT" || k === "BIND_HOST" || k.startsWith("AGY_") || k.startsWith("ANTHROPIC_");

function configPath() {
  const root = process.env.AGY_MONITOR_ROOT || path.join(os.homedir(), ".agy-monitor");
  return path.join(root, "config.json");
}

// Applies config.json to process.env (env wins). Returns { path, applied, ignored }
// for doctor/status reporting; never throws — a broken file is reported, not fatal.
function load() {
  const file = configPath();
  const out = { path: file, exists: false, applied: [], ignored: [], error: null };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out; // absent is the common case, not an error
  }
  out.exists = true;
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    out.error = "config.json is not valid JSON: " + e.message;
    return out;
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    out.error = "config.json must be a flat JSON object of env keys";
    return out;
  }
  for (const [k, v] of Object.entries(cfg)) {
    if (!ALLOWED(k)) { out.ignored.push(k); continue; }
    if (process.env[k] !== undefined) { out.ignored.push(k); continue; } // env wins
    if (v === null || typeof v === "object") { out.ignored.push(k); continue; }
    process.env[k] = String(v);
    out.applied.push(k);
  }
  return out;
}

module.exports = { load, configPath };
