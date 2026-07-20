#!/usr/bin/env node
"use strict";
/*
 * install-hooks.js — register (or remove) the agy-monitor status hook in agy's
 * global hooks config, ~/.gemini/config/hooks.json (override the ~/.gemini root
 * with AGY_GEMINI_HOME).
 *
 *   node install-hooks.js            # install
 *   node install-hooks.js --uninstall
 *   node install-hooks.js --status   # show what's installed
 *
 * All of our entries live under ONE top-level hook name ("agy-monitor"), so we
 * add/remove exactly that key and never touch any other hooks you've configured.
 * The original file is backed up (hooks.json.bak-<ts>) before any write.
 *
 * Also required as a module (the dashboard's one-click hook install and the
 * doctor use it): exports install/uninstall/status.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOK_NAME = "agy-monitor";
const HOOK_SCRIPT = path.join(__dirname, "agy-monitor-hook.sh");

// Resolved per call, not at require time, so tests can point AGY_GEMINI_HOME
// at a fixture world after requiring this module.
function hooksJsonPath() {
  const root = process.env.AGY_GEMINI_HOME || path.join(os.homedir(), ".gemini");
  return path.join(root, "config", "hooks.json");
}

// Lifecycle events use a direct handler list; tool events wrap in {matcher,hooks}.
function buildEntries() {
  const cmd = (event, timeout = 10) => ({ type: "command", command: `${shq(HOOK_SCRIPT)} ${event}`, timeout });
  const toolEvent = (event, timeout) => [{ matcher: ".*", hooks: [cmd(event, timeout)] }];
  const lifecycle = (event) => [cmd(event)];
  return {
    // PreToolUse must be able to outlast the approval gate's block (agy-gate.js,
    // ~8 min) so a UI-triggered send can wait for the user to approve. Observe-only
    // for normal sessions, so the large timeout never matters there.
    PreToolUse: toolEvent("PreToolUse", 720),
    PostToolUse: toolEvent("PostToolUse"),
    PreInvocation: lifecycle("PreInvocation"),
    PostInvocation: lifecycle("PostInvocation"),
    Stop: lifecycle("Stop"),
    Notification: lifecycle("Notification"),
  };
}

// shell-quote a path so spaces/metacharacters in the install path stay intact
function shq(p) {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function readHooks() {
  try {
    return JSON.parse(fs.readFileSync(hooksJsonPath(), "utf8"));
  } catch {
    return {};
  }
}

function backup() {
  const file = hooksJsonPath();
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function write(config) {
  const file = hooksJsonPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

// What's installed, and whether it points at THIS checkout. `scriptPath` is
// parsed back out of the stored command so a repo move is detectable (stale).
function status() {
  const cfg = readHooks();
  const entry = cfg[HOOK_NAME];
  const out = {
    ok: true,
    hooksJson: hooksJsonPath(),
    installed: !!entry,
    otherHooks: Object.keys(cfg).filter((k) => k !== HOOK_NAME),
    events: entry ? Object.keys(entry) : [],
    scriptPath: null,
    scriptExists: false,
    current: false, // installed AND pointing at this checkout's hook script
    preToolUseTimeout: null,
  };
  if (!entry) return out;
  try {
    const pre = entry.PreToolUse && entry.PreToolUse[0];
    const hook = pre && pre.hooks && pre.hooks[0];
    if (hook && typeof hook.command === "string") {
      const m = /^'((?:[^']|'\\'')*)' /.exec(hook.command + " ");
      out.scriptPath = m ? m[1].replace(/'\\''/g, "'") : null;
      out.preToolUseTimeout = hook.timeout || null;
    }
  } catch {}
  if (out.scriptPath) {
    try { out.scriptExists = fs.existsSync(out.scriptPath); } catch {}
    out.current = out.scriptExists && path.resolve(out.scriptPath) === path.resolve(HOOK_SCRIPT);
  }
  return out;
}

function install() {
  if (!fs.existsSync(HOOK_SCRIPT)) {
    return { ok: false, message: `hook script not found: ${HOOK_SCRIPT}` };
  }
  try { fs.chmodSync(HOOK_SCRIPT, 0o755); } catch {}
  const cfg = readHooks();
  const bak = backup();
  cfg[HOOK_NAME] = buildEntries();
  write(cfg);
  return {
    ok: true,
    hooksJson: hooksJsonPath(),
    scriptPath: HOOK_SCRIPT,
    otherHooks: Object.keys(cfg).filter((k) => k !== HOOK_NAME),
    backup: bak,
  };
}

function uninstall() {
  const cfg = readHooks();
  if (!cfg[HOOK_NAME]) return { ok: true, removed: false, message: "agy-monitor hook not present; nothing to remove." };
  const bak = backup();
  delete cfg[HOOK_NAME];
  write(cfg);
  return { ok: true, removed: true, hooksJson: hooksJsonPath(), backup: bak };
}

function main() {
  const arg = process.argv[2];

  if (arg === "--status") {
    const s = status();
    console.log(`hooks.json: ${s.hooksJson}`);
    console.log(`agy-monitor hook installed: ${s.installed}${s.installed && !s.current ? "  (! points at a different checkout: " + s.scriptPath + ")" : ""}`);
    console.log(`other hooks present: ${s.otherHooks.join(", ") || "(none)"}`);
    if (s.installed) console.log(`events: ${s.events.join(", ")}`);
    return;
  }

  if (arg === "--uninstall") {
    const r = uninstall();
    console.log(r.removed ? `Removed "${HOOK_NAME}" from ${r.hooksJson}` : r.message);
    if (r.backup) console.log(`Backup: ${r.backup}`);
    return;
  }

  const r = install();
  if (!r.ok) {
    console.error(`Error: ${r.message}`);
    process.exit(1);
  }
  console.log(`Installed "${HOOK_NAME}" hook → ${r.hooksJson}`);
  console.log(`Hook script: ${r.scriptPath}`);
  console.log(`Other hooks preserved: ${r.otherHooks.join(", ") || "(none)"}`);
  if (r.backup) console.log(`Backup of previous config: ${r.backup}`);
  console.log(`\nVerify in agy with:  /hooks`);
}

module.exports = { install, uninstall, status, hooksJsonPath, HOOK_NAME, HOOK_SCRIPT };

if (require.main === module) {
  require("./agy-config").load();
  main();
}
