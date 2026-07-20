"use strict";
/*
 * agy-doctor — environment checks shared by the CLI (bin/doctor.js) and the
 * dashboard's first-run setup screen (dispatcher actions `setup-status` and
 * `install-hook`).
 *
 * Every check returns { id, label, status, detail, fix? } with status one of:
 *   ok    — configured and working
 *   warn  — a feature is degraded/off, with a concrete fix
 *   fail  — the app can't do its core job (agy missing, node too old)
 *   info  — purely informational
 *
 * Design rules: never call a paid model, never write anything (installHook is
 * the one explicit mutation, and it's a separate entry point), keep every
 * probe under ~10s, and always fall back to a useful message rather than a
 * stack trace — this module IS the error message.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const hooks = require("./install-hooks");

const AGY_INSTALL_URL = "https://antigravity.google";

function agyCliHome() {
  return process.env.AGY_CLI_HOME || path.join(os.homedir(), ".gemini", "antigravity-cli");
}

// Find an executable by scanning PATH plus the usual user-local bin dirs.
function findBin(name, extraDirs = []) {
  const dirs = (process.env.PATH || "").split(path.delimiter).concat(extraDirs);
  for (const d of dirs) {
    if (!d) continue;
    const cand = path.join(d, name);
    try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch {}
  }
  return null;
}

// Run a probe command with stdin IGNORED (agy deadlocks reading a piped stdin)
// and a hard timeout. Resolves { ok, stdout, stderr } — never rejects.
function probe(cmd, args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, stdout: "", stderr: e.message });
    }
    let out = "", err = "", done = false;
    const finish = (ok) => { if (!done) { done = true; resolve({ ok, stdout: out.trim(), stderr: err.trim() }); } };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(false); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { err = err || e.message; clearTimeout(timer); finish(false); });
    child.on("close", (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

// ---- individual checks -------------------------------------------------------

function checkNode() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  return major >= 20
    ? { id: "node", label: "Node.js", status: "ok", detail: `v${process.versions.node}` }
    : { id: "node", label: "Node.js", status: "fail", detail: `v${process.versions.node} is too old`, fix: "Install Node 20 or newer (https://nodejs.org)" };
}

async function checkAgy() {
  const envBin = process.env.AGY_GATE_AGY_BIN;
  if (envBin) {
    try { fs.accessSync(envBin, fs.constants.X_OK); } catch {
      return { id: "agy", label: "agy CLI", status: "fail", detail: `AGY_GATE_AGY_BIN points at a missing/non-executable file: ${envBin}`,
        fix: "Fix or unset AGY_GATE_AGY_BIN (env or ~/.agy-monitor/config.json)" };
    }
  }
  const bin = envBin || findBin("agy", [path.join(os.homedir(), ".local", "bin")]);
  if (!bin) {
    return { id: "agy", label: "agy CLI", status: "fail", detail: "agy binary not found on PATH or in ~/.local/bin",
      fix: `Install the Antigravity CLI (${AGY_INSTALL_URL}), then re-run this check` };
  }
  const v = await probe(bin, ["--version"], { timeoutMs: 8000 });
  return { id: "agy", label: "agy CLI", status: "ok", detail: v.ok && v.stdout ? `${v.stdout.split("\n")[0]} (${bin})` : bin };
}

function checkAgyData() {
  const home = agyCliHome();
  if (!fs.existsSync(home)) {
    return { id: "agy-data", label: "agy data dir", status: "fail", detail: `${home} does not exist`,
      fix: "Run agy once in a terminal so it creates its data dir (or point AGY_CLI_HOME at it)" };
  }
  let convos = 0;
  try { convos = fs.readdirSync(path.join(home, "conversations")).filter((f) => f.endsWith(".db")).length; } catch {}
  if (convos === 0) {
    return { id: "agy-data", label: "agy data dir", status: "warn", detail: `${home} exists but has no conversations yet`,
      fix: "Run agy once — the dashboard lights up after the first conversation" };
  }
  return { id: "agy-data", label: "agy data dir", status: "ok", detail: `${home} (${convos} conversation${convos === 1 ? "" : "s"})` };
}

function checkHook() {
  let s;
  try { s = hooks.status(); } catch (e) {
    return { id: "hook", label: "live-state hook", status: "warn", detail: "could not read hooks.json: " + e.message, fix: "node install-hooks.js" };
  }
  if (!s.installed) {
    return { id: "hook", label: "live-state hook", status: "warn", detail: "not installed — sessions show without live state, and the approval gate is off",
      fix: "node install-hooks.js  (or one click on the dashboard's setup screen)", canInstall: true };
  }
  if (!s.current) {
    return { id: "hook", label: "live-state hook", status: "warn",
      detail: `installed but points at ${s.scriptExists ? "a different checkout" : "a missing file"}: ${s.scriptPath}`,
      fix: "node install-hooks.js  (re-registers this checkout's hook path)", canInstall: true };
  }
  if ((s.preToolUseTimeout || 0) < 720) {
    return { id: "hook", label: "live-state hook", status: "warn",
      detail: `installed, but PreToolUse timeout is ${s.preToolUseTimeout || "unset"} (< 720s) — approvals could time out mid-wait`,
      fix: "node install-hooks.js  (rewrites the hook with the current timeout)", canInstall: true };
  }
  return { id: "hook", label: "live-state hook", status: "ok", detail: `installed → ${s.hooksJson}` };
}

function checkGateSettings() {
  const file = process.env.AGY_GATE_SETTINGS || path.join(agyCliHome(), "settings.json");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch {
    return { id: "gate", label: "gate safelist", status: "info", detail: `${file} not found yet (agy writes it on first run); until then nothing auto-runs` };
  }
  try {
    const allow = (JSON.parse(raw).permissions || {}).allow;
    const n = Array.isArray(allow) ? allow.length : 0;
    return { id: "gate", label: "gate safelist", status: "ok", detail: `${n} auto-approved rule${n === 1 ? "" : "s"} in ${file}` };
  } catch (e) {
    return { id: "gate", label: "gate safelist", status: "warn", detail: `${file} is not valid JSON: ${e.message}`, fix: "Fix the file by hand — the gate fails closed (everything needs approval) while it can't be read" };
  }
}

async function checkClaude() {
  const provider = process.env.AGY_ANTHROPIC_PROVIDER || "bedrock";
  const affected = "Claude features (opus review, fan-out judge, /btw)";
  if (provider === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
      return { id: "claude", label: "Claude transport", status: "ok", detail: "provider anthropic — API key present" };
    }
    return { id: "claude", label: "Claude transport", status: "warn", detail: `provider anthropic, but no key — ${affected} are off`,
      fix: "Set ANTHROPIC_API_KEY (env, or ~/.agy-monitor/config.json)" };
  }
  // bedrock (default): AWS SSO profile → aws configure export-credentials
  const profile = process.env.AGY_AWS_PROFILE || "saml";
  const aws = findBin("aws");
  if (!aws) {
    return { id: "claude", label: "Claude transport", status: "warn", detail: `provider bedrock, but the aws CLI is not installed — ${affected} are off`,
      fix: "Install the AWS CLI, or set AGY_ANTHROPIC_PROVIDER=anthropic + ANTHROPIC_API_KEY" };
  }
  const creds = await probe(aws, ["configure", "export-credentials", "--profile", profile, "--format", "process"], { timeoutMs: 10000 });
  if (creds.ok) {
    const region = (await probe(aws, ["configure", "get", "region", "--profile", profile], { timeoutMs: 5000 })).stdout || process.env.AGY_AWS_REGION || process.env.AWS_REGION || "us-east-1";
    return { id: "claude", label: "Claude transport", status: "ok", detail: `provider bedrock — profile '${profile}' ready (${region})` };
  }
  const known = /could not be found|does not exist/i.test(creds.stderr);
  if (known) {
    return { id: "claude", label: "Claude transport", status: "warn", detail: `provider bedrock, but AWS profile '${profile}' does not exist — ${affected} are off`,
      fix: `Create the profile (aws configure sso --profile ${profile}), set AGY_AWS_PROFILE to an existing one, or switch: AGY_ANTHROPIC_PROVIDER=anthropic` };
  }
  const why = (creds.stderr || "").split("\n")[0].slice(0, 160);
  return { id: "claude", label: "Claude transport", status: "warn",
    detail: `provider bedrock — profile '${profile}' has no live credentials — ${affected} are off` + (why ? ` (aws: ${why})` : ""),
    fix: `aws sso login --profile ${profile}` };
}

async function checkServer() {
  const port = parseInt(process.env.PORT || "8719", 10);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await res.json();
    if (j && j.name === "agy-monitor") {
      return { id: "server", label: "server", status: "ok", detail: `running v${j.version} on http://127.0.0.1:${port}` };
    }
    return { id: "server", label: "server", status: "warn", detail: `something else is listening on port ${port}`, fix: "Set PORT to a free port (env or ~/.agy-monitor/config.json)" };
  } catch {
    return { id: "server", label: "server", status: "info", detail: `not running on port ${port}`, fix: "npm start  (foreground) or daemon/install.sh (background at login)" };
  }
}

function checkExternals() {
  const codex = process.env.AGY_CODEX_ROOT || path.join(os.homedir(), ".codex", "sessions");
  const copilot = process.env.AGY_COPILOT_ROOT ||
    path.join(os.homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
  const found = [fs.existsSync(codex) && "codex", fs.existsSync(copilot) && "copilot"].filter(Boolean);
  return { id: "externals", label: "other agents", status: "info",
    detail: found.length ? `read-only sessions found: ${found.join(", ")}` : "none detected (codex/copilot) — the OTHER AGENTS section stays hidden" };
}

function checkConfigFile() {
  const cfgMod = require("./agy-config");
  // Re-reading (not re-applying) — load() already ran at process start; env-wins
  // makes a second look-only load safe and gives us fresh applied/ignored info.
  const r = cfgMod.load();
  if (!r.exists) return { id: "config", label: "config file", status: "info", detail: `${r.path} not present (optional)` };
  if (r.error) return { id: "config", label: "config file", status: "warn", detail: r.error, fix: `Fix ${r.path} — it must be a flat {"ENV_NAME": "value"} JSON object` };
  let mode = null;
  try { mode = fs.statSync(r.path).mode & 0o077; } catch {}
  let raw = "";
  try { raw = fs.readFileSync(r.path, "utf8"); } catch {}
  if (mode && /ANTHROPIC_API_KEY|AGY_MONITOR_TOKEN/.test(raw)) {
    return { id: "config", label: "config file", status: "warn", detail: `${r.path} holds secrets but is group/world-readable`, fix: `chmod 600 ${r.path}` };
  }
  return { id: "config", label: "config file", status: "ok", detail: r.path };
}

// ---- entry points ------------------------------------------------------------

async function runChecks() {
  const checks = [
    checkNode(),
    await checkAgy(),
    checkAgyData(),
    checkHook(),
    checkGateSettings(),
    await checkClaude(),
    await checkServer(),
    checkExternals(),
    checkConfigFile(),
  ];
  const by = (id) => checks.find((c) => c.id === id);
  const summary = {
    coreReady: by("agy").status === "ok" && by("agy-data").status !== "fail" && by("node").status === "ok",
    hookLive: by("hook").status === "ok",
    reviewReady: by("claude").status === "ok",
    fails: checks.filter((c) => c.status === "fail").length,
    warns: checks.filter((c) => c.status === "warn").length,
  };
  return { ok: true, checks, summary };
}

// Dispatcher action `setup-status`
async function setupStatus() {
  return runChecks();
}

// Dispatcher action `install-hook` — the one-click install from the dashboard.
async function installHook() {
  const r = hooks.install();
  if (!r.ok) return r;
  return { ok: true, installed: r, check: checkHook() };
}

module.exports = { runChecks, setupStatus, installHook, checkClaude, checkHook, probe, findBin };
