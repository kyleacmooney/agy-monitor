"use strict";
/*
 * live-session.test — the WIRE between agy-clilog and listAgySessions.
 *
 *   node test/live-session.test.js
 *
 * Both ends are unit-tested (clilog.test.js, state.test.js), but the plumbing in
 * listAgySessions — find the process, find its cli log via lsof, join the status
 * file's stepIdx against the log, let the evidence override the heuristics — was
 * covered by nothing: deleting the whole cli block left the suite green. This test
 * runs the REAL discovery (ps + lsof) against a fake agy process that satisfies it
 * genuinely (argv[0] "agy", cwd in the workspace, brain transcript + cli log held
 * open), so removing any link in the chain fails here.
 *
 * ps discovery is machine-global, so a developer's real agy sessions may appear in
 * the results — every assertion selects by this test's own conversation id.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// env BEFORE the module load — agy-monitor reads these at require time
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agy-live-test-"));
const AGY_HOME = path.join(BASE, "gemini", "antigravity-cli");
process.env.AGY_MONITOR_ROOT = path.join(BASE, "agy-monitor");
process.env.AGY_CLI_HOME = AGY_HOME;
delete process.env.AGY_MONITOR_NO_PS; // this test IS about ps discovery
fs.mkdirSync(path.join(process.env.AGY_MONITOR_ROOT, "sessions"), { recursive: true });
fs.mkdirSync(path.join(AGY_HOME, "cache"), { recursive: true });

const fx = require("./fixtures.js");
const { agyMonitor } = require("../agy-monitor.js");

const CID = "deadbeef-1111-2222-3333-444455556666";
// realpath: lsof reports the resolved path, and /var is a symlink to /private/var
// on macOS — comparing against the mkdtemp spelling would fail for the wrong reason
fs.mkdirSync(path.join(BASE, "ws"), { recursive: true });
const WS = fs.realpathSync(path.join(BASE, "ws"));

let pass = 0, fail = 0;
const results = [];
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + (e && e.message)); fail++; }
}

function writeStatus({ event = "PreToolUse", tsMs = Date.now(), stepIdx = 4, tool = "run_command", cmd = "touch escape-test.txt" } = {}) {
  fs.writeFileSync(path.join(process.env.AGY_MONITOR_ROOT, "sessions", CID + ".json"), JSON.stringify({
    event, ts: Math.floor(tsMs / 1000), conversationId: CID,
    payload: {
      stepIdx,
      toolCall: { name: tool, args: tool === "run_command" ? { CommandLine: cmd } : {} },
      workspacePaths: [WS],
    },
  }));
}

async function ourSession() {
  const r = await agyMonitor.run({ action: "fetch-sessions" }, {});
  assert.ok(r && r.ok, "fetch-sessions ok");
  return (r.data || []).find((s) => s.conversationId === CID) || null;
}

// listAgySessions attaches hook state only when it fired after the process started —
// give ps a beat to observe the spawn before stamping the status file.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One ps/lsof pass can transiently come up empty on a loaded machine (execFileP maps
// an lsof stall to empty output by design), so no assertion here rides a single
// fetch: poll until the predicate holds, then assert on that stable snapshot.
async function untilSession(pred, ms = 10000) {
  let s = null;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    s = await ourSession();
    if (s && pred(s)) return s;
    await sleep(150);
  }
  return s; // let the assertion report what we actually last saw
}

(async () => {
  const agy = fx.spawnFakeAgy({ agyHome: AGY_HOME, workspace: WS, cid: CID });
  try {
    // wait for the exec chain to settle and the process to be discoverable
    let s = null;
    for (let i = 0; i < 50 && !s; i++) { await sleep(100); s = await ourSession(); }
    check("a fake agy process is discovered via ps + lsof, with its workspace and cid", () => {
      assert.ok(s, "session found");
      assert.strictEqual(s.workspace, WS);
    });

    // -- 1. the prompt is up: agy's own log beats the policy heuristic ------------
    const t0 = Date.now();
    writeStatus({ tsMs: t0 });
    fs.appendFileSync(agy.logPath,
      fx.agyGlogLine(agy.pid, t0 + 85, 'Surfacing tool confirmation: "Bash" at step 4') + "\n");
    s = await untilSession((x) => x.state === "waiting");
    check("surfaced in the cli log → waiting, labelled with the TRANSCRIPT's tool name", () => {
      assert.ok(s, "session visible");
      assert.strictEqual(s.state, "waiting");
      assert.strictEqual(s.stateDetail, "awaiting approval: run_command");
      assert.strictEqual(s.tool, "run_command", "never agy's internal 'Bash'");
    });

    // -- 2. Escape, inside the SAME second as the hook stamp ----------------------
    // The turn-context-cancelled Stop line lands < 1s after the whole-second hook
    // stamp — the exact window the old time-only rule could never see.
    fs.appendFileSync(agy.logPath,
      fx.agyGlogLine(agy.pid, t0 + 400,
        "server.go:1773] Tool confirmation for conversation " + CID + " step 4 (type=*gemini_coder_go_proto.Step_RunCommand approved=false)") + "\n" +
      fx.agyGlogLine(agy.pid, t0 + 600,
        "log_context.go:117] failed to call custom stop hook jsonhook__agy-monitor_Stop_0_0: command failed: context canceled, stderr: ") + "\n");
    s = await untilSession((x) => x.state === "idle");
    check("an escaped prompt flips the frozen PreToolUse to idle, not 'needs you' forever", () => {
      assert.ok(s, "session visible");
      assert.strictEqual(s.state, "idle");
      assert.strictEqual(s.stateDetail, "your turn — tool cancelled");
      assert.strictEqual(s.tool, null);
    });
    check("cancelledTool carries the transcript name so the UI can mark the right card", () => {
      assert.strictEqual(s.cancelledTool, "run_command");
    });

    // -- 3. no log evidence → the old inference stands unchanged ------------------
    // A new turn's PreToolUse lands seconds after the previous turn's lines in real
    // life; without this gap the old stop-lost's nominal timestamp can land inside
    // the new stamp's TURN_END_MIN_MS window and the test fails for a fake reason.
    await sleep(1600);
    const t1 = Date.now();
    writeStatus({ tsMs: t1, stepIdx: 9, cmd: "rm -rf build" }); // a command agy prompts on
    s = await untilSession((x) => x.state === "waiting");
    check("a step the log is silent about falls back to the policy heuristic", () => {
      assert.ok(s, "session visible");
      assert.strictEqual(s.state, "waiting", "forcesApproval fast path still applies");
      assert.strictEqual(s.cancelledTool, null);
    });
  } finally {
    agy.kill();
  }

  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
