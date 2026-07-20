"use strict";
/* doctor.test.js — hermetic tests for the onboarding surface: the config-file
   loader (allow-list + env-wins), install-hooks as a module (install/status/
   stale-path detection/uninstall preserving other hooks), the doctor checks
   (agy binary, data dir, hook, claude transport) and their coreReady summary,
   and the setup-status / install-hook dispatcher actions. */

const fx = require("./fixtures");
const roots = fx.makeRoots("agy-doctor-test-");
process.env.AGY_MONITOR_ROOT = roots.monRoot;
process.env.AGY_CLI_HOME = roots.agyHome;
process.env.AGY_GEMINI_HOME = require("path").join(roots.base, "gemini-home");
process.env.AGY_ANTHROPIC_PROVIDER = "anthropic";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.AGY_GATE_AGY_BIN;
process.env.PORT = "59983"; // nothing listens here → the server check stays "info"

const fs = require("fs");
const path = require("path");

const cfg = require("../agy-config");
const hooks = require("../install-hooks");
const doctor = require("../agy-doctor");
const { agyMonitor } = require("../agy-monitor");

(async () => {
  const failures = [];
  const A = (c, m) => fx.assert(c, m, failures);
  const by = (checks, id) => checks.find((c) => c.id === id);

  // --- config file loader ---------------------------------------------------
  const cfgFile = path.join(roots.monRoot, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({
    AGY_DOCTOR_CANARY: "yes",     // allowed prefix, unset → applied
    PORT: "1234",                 // already set in env → env wins
    HOME: "/tmp/evil",            // not on the allow-list → ignored
    AGY_NESTED: { no: true },     // non-scalar → ignored
  }));
  const r1 = cfg.load();
  A(r1.exists && !r1.error, "config.json loads");
  A(process.env.AGY_DOCTOR_CANARY === "yes", "allowed unset key is applied to the env");
  A(process.env.PORT === "59983", "env wins over the file for an already-set key");
  A(process.env.HOME !== "/tmp/evil", "keys outside the allow-list are never applied");
  A(r1.ignored.includes("HOME") && r1.ignored.includes("PORT") && r1.ignored.includes("AGY_NESTED"), "ignored keys are reported");
  delete process.env.AGY_DOCTOR_CANARY;

  fs.writeFileSync(cfgFile, "{ nope");
  A(!!cfg.load().error, "broken JSON reports an error instead of throwing");
  fs.unlinkSync(cfgFile);
  A(cfg.load().exists === false, "an absent config file is not an error");

  // --- install-hooks as a module -------------------------------------------
  const hooksJson = hooks.hooksJsonPath();
  A(hooksJson.startsWith(path.join(roots.base, "gemini-home")), "AGY_GEMINI_HOME redirects hooks.json (never the real one)");

  // pre-seed a foreign hook that must survive our install/uninstall
  fs.mkdirSync(path.dirname(hooksJson), { recursive: true });
  fs.writeFileSync(hooksJson, JSON.stringify({ "other-hook": { Stop: [] } }));

  let st = hooks.status();
  A(st.installed === false, "status: not installed in a fresh world");
  A(by(await checks(), "hook").status === "warn", "doctor: missing hook is a warn");
  A(by(await checks(), "hook").canInstall === true, "doctor: missing hook offers one-click install");

  const inst = hooks.install();
  A(inst.ok === true && fs.existsSync(hooksJson), "install writes hooks.json");
  A(inst.otherHooks.includes("other-hook"), "install preserves other hooks");
  st = hooks.status();
  A(st.installed && st.current, "status: installed and pointing at this checkout");
  A(st.preToolUseTimeout === 720, "PreToolUse timeout is parsed back out (720)");
  A(st.events.length === 6, "all six lifecycle events registered");

  // simulate a repo move: rewrite the stored script path → stale
  const cfgNow = JSON.parse(fs.readFileSync(hooksJson, "utf8"));
  cfgNow["agy-monitor"].PreToolUse[0].hooks[0].command = "'/elsewhere/agy-monitor-hook.sh' PreToolUse";
  fs.writeFileSync(hooksJson, JSON.stringify(cfgNow));
  st = hooks.status();
  A(st.installed && !st.current && st.scriptPath === "/elsewhere/agy-monitor-hook.sh", "a moved checkout is detected as stale");
  const hc = by(await checks(), "hook");
  A(hc.status === "warn" && /missing file|different checkout/.test(hc.detail), "doctor: stale hook path is a warn with the old path shown");

  const un = hooks.uninstall();
  A(un.ok && un.removed, "uninstall removes our key");
  const after = JSON.parse(fs.readFileSync(hooksJson, "utf8"));
  A(!!after["other-hook"] && !after["agy-monitor"], "uninstall leaves other hooks intact");

  // --- agy binary + data dir + summary --------------------------------------
  process.env.AGY_GATE_AGY_BIN = "/nope/agy";
  A(by(await checks(), "agy").status === "fail", "a broken AGY_GATE_AGY_BIN is a hard fail, not a silent ok");
  const stub = fx.writeAgyStub(roots.base, roots.agyHome);
  process.env.AGY_GATE_AGY_BIN = stub;
  A(by(await checks(), "agy").status === "ok", "the stub agy binary passes");

  let dc = by(await checks(), "agy-data");
  A(dc.status === "warn", "an empty conversations dir is a warn (agy never ran)");
  fs.writeFileSync(path.join(roots.agyHome, "conversations", "x.db"), "");
  dc = by(await checks(), "agy-data");
  A(dc.status === "ok" && /1 conversation\b/.test(dc.detail), "a conversation db turns the data check green");

  // --- claude transport (anthropic provider; bedrock needs the aws CLI) -----
  A(by(await checks(), "claude").status === "warn", "anthropic provider without a key is a warn (features off)");
  process.env.ANTHROPIC_API_KEY = "test-key";
  A(by(await checks(), "claude").status === "ok", "anthropic provider with a key is ready");

  const { summary } = await doctor.runChecks();
  A(summary.coreReady === true, "summary: core ready with agy + data + node");
  A(summary.reviewReady === true, "summary: claude features ready");
  A(summary.hookLive === false, "summary: hook currently uninstalled → live state off");

  // --- dispatcher actions ---------------------------------------------------
  const ss = await agyMonitor.run({ action: "setup-status" }, {});
  A(ss.ok === true && Array.isArray(ss.checks) && ss.checks.length >= 8, "setup-status returns the checks over RPC");
  A(!!ss.summary && typeof ss.summary.coreReady === "boolean", "setup-status carries the summary");

  const ih = await agyMonitor.run({ action: "install-hook" }, {});
  A(ih.ok === true && ih.check && ih.check.status === "ok", "install-hook action installs and re-checks green");
  A(hooks.status().current === true, "one-click install points hooks.json at this checkout");

  fx.finish(failures, "doctor.test");

  async function checks() { return (await doctor.runChecks()).checks; }
})().catch((e) => { console.error(e); process.exit(1); });
