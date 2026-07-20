#!/usr/bin/env node
"use strict";
/*
 * agy-monitor self-update tests.
 *
 *   node test/self-update.test.js
 *
 * Part A — the module (no daemon, no claude spawned): buildPrompt guard-rails, readStatus
 * default, the AGY_MONITOR_SELF_UPDATE inert gate.
 * Part B — the supervisor (daemon/apply-update.sh) run FOR REAL in an isolated temp git repo
 * with a fake /api/health server: the applied, rolled-back, and rejected (pre-flight) paths.
 * This is the safety net that makes auto-apply OK, so it's the most important thing to verify.
 * launchctl kickstart is a harmless no-op here (the fake label/unit doesn't exist).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawn } = require("child_process");

const SU = require("../agy-selfupdate.js");
const SCRIPT = path.join(__dirname, "..", "daemon", "apply-update.sh");

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log("  ok   " + msg); }
  else { fail++; console.log("  FAIL " + msg); }
}

function git(repo, args) { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim(); }
function runSupervisor(appDir, port, statusFile) {
  return new Promise((resolve) => {
    const p = spawn("bash", [SCRIPT, appDir, "test.agy-monitor.fake", String(port), statusFile],
      { env: Object.assign({}, process.env, { HEALTH_TRIES: "4", NODE_BIN: process.execPath }), stdio: "ignore" });
    p.on("close", (code) => resolve(code));
  });
}
const fakeHealth = (code) => http.createServer((req, res) => { res.writeHead(req.url.includes("/api/health") ? code : 404); res.end(); });
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

(async () => {
  // ── Part A: module ──
  console.log("\n# module (buildPrompt / readStatus / enabled gate)");
  const prompt = SU.buildPrompt("make the header green");
  check(prompt.includes("make the header green"), "buildPrompt embeds the request verbatim");
  check(/agy-monitor/i.test(prompt), "buildPrompt names the app it is editing");
  check(/agy-gate\.js|safety gate/i.test(prompt) && /token/i.test(prompt), "buildPrompt keeps the security guard-rails (gate + token)");
  check(/Confine every edit to this agy-monitor tool directory/i.test(prompt), "buildPrompt confines edits to the tool dir");

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-su-status-"));
  const st = SU.readStatus(emptyDir);
  check(st.state === "idle" && st.commit === "" && st.ts === 0, "readStatus → idle when no status file exists");

  const savedFlag = process.env.AGY_MONITOR_SELF_UPDATE;
  delete process.env.AGY_MONITOR_SELF_UPDATE;
  check(SU.enabled() === false, "enabled() false when AGY_MONITOR_SELF_UPDATE unset");
  const disabled = SU.startSelfUpdate({ request: "x", stateDir: emptyDir });
  check(disabled.ok === false && /turned off/i.test(disabled.error), "startSelfUpdate refuses (no claude run) while disabled");
  process.env.AGY_MONITOR_SELF_UPDATE = "1";
  check(SU.enabled() === true, "enabled() true when AGY_MONITOR_SELF_UPDATE=1");
  const noReq = SU.startSelfUpdate({ request: "   ", stateDir: emptyDir });
  check(noReq.ok === false && /describe/i.test(noReq.error), "startSelfUpdate rejects an empty request (no claude run)");
  if (savedFlag === undefined) delete process.env.AGY_MONITOR_SELF_UPDATE; else process.env.AGY_MONITOR_SELF_UPDATE = savedFlag;
  fs.rmSync(emptyDir, { recursive: true, force: true });

  // ── Part B: supervisor apply / rollback / reject ──
  console.log("\n# supervisor (daemon/apply-update.sh — real git + fake health)");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-repo-"));
  const appDir = path.join(repo, "tools", "agy-monitor");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  const file = path.join(appDir, "thing.txt");
  fs.writeFileSync(file, "original\n");
  // Valid JS the pre-flight parse-checks (a subset of PREFLIGHT_FILES; the rest are skipped).
  fs.writeFileSync(path.join(appDir, "server.js"), 'console.log("ok");\n');
  fs.writeFileSync(path.join(appDir, "agy-monitor.js"), '"use strict";\n');
  fs.writeFileSync(path.join(appDir, "agy-gate.js"), '"use strict";\nmodule.exports = {};\n');
  fs.writeFileSync(path.join(appDir, "render-agy-monitor.js"), '"use strict";\n');
  fs.writeFileSync(path.join(appDir, "public", "app.js"), '(function(){ "use strict"; })();\n');
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t"]); git(repo, ["config", "user.name", "T"]);
  git(repo, ["add", "-A"]); git(repo, ["commit", "-q", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);

  try {
    // Scenario A — healthy change → applied (committed, kept on disk).
    fs.writeFileSync(file, "CHANGED by self-update\n");
    let srv = fakeHealth(200); const portOk = await listen(srv);
    const statusA = path.join(repo, "statusA.json");
    await runSupervisor(appDir, portOk, statusA);
    srv.close();
    const a = JSON.parse(fs.readFileSync(statusA, "utf8"));
    check(a.state === "applied", 'healthy change → status "applied"');
    check(git(repo, ["rev-parse", "HEAD"]) !== base, "healthy change → committed");
    check(fs.readFileSync(file, "utf8").includes("CHANGED"), "healthy change → kept on disk");

    // Scenario B — never comes back healthy → rolled back (reverted, restored).
    const afterA = git(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(file, "BROKEN change\n");
    let srvBad = fakeHealth(503); const portBad = await listen(srvBad);
    const statusB = path.join(repo, "statusB.json");
    await runSupervisor(appDir, portBad, statusB);
    srvBad.close();
    const b = JSON.parse(fs.readFileSync(statusB, "utf8"));
    check(b.state === "rolled-back", 'unhealthy change → status "rolled-back"');
    check(git(repo, ["rev-parse", "HEAD"]) !== afterA, "rollback created a revert commit");
    check(!fs.readFileSync(file, "utf8").includes("BROKEN"), "rollback restored the file (no broken content)");

    // Scenario C — a self-edit with a JS SYNTAX ERROR is rejected by pre-flight, before the live
    // daemon is ever touched (no commit, no restart). Closes the "server up but code broken" gap.
    const headBeforeC = git(repo, ["rev-parse", "HEAD"]);
    const gateJs = path.join(appDir, "agy-gate.js");
    fs.writeFileSync(gateJs, "function broken( {  // not valid JS\n");
    let srvC = fakeHealth(200); const portC = await listen(srvC); // would pass health IF it got there
    const statusC = path.join(repo, "statusC.json");
    await runSupervisor(appDir, portC, statusC);
    srvC.close();
    const c = JSON.parse(fs.readFileSync(statusC, "utf8"));
    check(c.state === "rejected", 'syntax-error edit → status "rejected" (pre-flight)');
    check(git(repo, ["rev-parse", "HEAD"]) === headBeforeC, "rejected edit → NOT committed (live app untouched)");
    check(fs.readFileSync(gateJs, "utf8").includes("module.exports"), "rejected edit → discarded (agy-gate.js restored)");
  } catch (e) { fail++; console.log("  FAIL supervisor: " + (e && e.stack || e)); }

  fs.rmSync(repo, { recursive: true, force: true });

  console.log(`\n${fail ? "SELF-UPDATE FAIL" : "SELF-UPDATE PASS"} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
