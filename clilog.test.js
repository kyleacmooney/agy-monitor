"use strict";
/* clilog.test.js — agy-clilog: reading agy's own process log for the turn-state agy
   generates but never delivers. Regression cover for the bug where pressing Escape at
   agy's tool-approval prompt left the monitor showing "needs you / awaiting approval…"
   forever, because agy runs the Stop hook with the turn context it just cancelled and
   our hook is killed before it can write.

   Every glog line below is copied verbatim from a real ~/.gemini/antigravity-cli/log
   file on this machine — the formats are agy's, not invented. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cl = require("./agy-clilog");

let pass = 0;
const T = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

// ---- logStartMs: the year glog never prints comes from the filename ---------
T("logStartMs reads the date out of the cli-<date>_<time>.log name", () => {
  const t = cl.logStartMs("/x/log/cli-20260721_082849.log");
  const d = new Date(t);
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 6);   // July
  assert.strictEqual(d.getDate(), 21);
  assert.strictEqual(d.getHours(), 8);
  assert.strictEqual(d.getMinutes(), 28);
});
T("logStartMs on a name it can't parse and a file that isn't there → null", () => {
  assert.strictEqual(cl.logStartMs("/nope/not-a-cli-log.txt"), null);
  assert.strictEqual(cl.logStartMs(""), null);
});

// ---- parseCliLog: the five line shapes we depend on -------------------------
const REF = cl.logStartMs("/x/log/cli-20260721_082849.log");

T("Surfacing → the approval prompt is on screen, with tool + step", () => {
  const ev = cl.parseCliLog(
    'I0721 08:28:58.085137 50198 tool_confirmation_manager.go:192] Surfacing tool confirmation: "Bash" at step 4', REF);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].kind, "surfaced");
  assert.strictEqual(ev[0].tool, "Bash");
  assert.strictEqual(ev[0].step, 4);
  assert.strictEqual(new Date(ev[0].tsMs).getFullYear(), 2026); // year borrowed from REF
});
T("Auto-approving → agy never prompted; the tool is really running", () => {
  const ev = cl.parseCliLog(
    'I0715 12:45:11.598272 11820 tool_confirmation_manager.go:71] Auto-approving tool confirmation: "ReadFile" at step 4', REF);
  assert.strictEqual(ev[0].kind, "auto-approved");
  assert.strictEqual(ev[0].step, 4);
});
T("Tool confirmation … approved=false → the prompt was answered no", () => {
  const ev = cl.parseCliLog(
    "I0720 12:40:34.066251 29051 server.go:1773] Tool confirmation for conversation 9b94b2bc-cb0e-4871-9b4d-3ce5f598751c step 10 (type=*gemini_coder_go_proto.Step_RunCommand approved=false)", REF);
  assert.strictEqual(ev[0].kind, "resolved");
  assert.strictEqual(ev[0].cid, "9b94b2bc-cb0e-4871-9b4d-3ce5f598751c");
  assert.strictEqual(ev[0].step, 10);
  assert.strictEqual(ev[0].approved, false);
});
T("… approved=true is not mistaken for a denial", () => {
  const ev = cl.parseCliLog(
    "I0718 13:08:37.691693 24043 server.go:1773] Tool confirmation for conversation f87bcf43-d776-4607-962d-e33426721619 step 20 (type=*gemini_coder_go_proto.Step_Generic approved=true)", REF);
  assert.strictEqual(ev[0].approved, true);
});
T("cancelled Stop hook → the turn ended and our hook was killed", () => {
  const ev = cl.parseCliLog(
    'E0721 08:29:01.489683 50198 log_context.go:117] failed to call custom stop hook jsonhook__agy-monitor_Stop_0_0: JSON hook "jsonhook__agy-monitor_Stop_0_0" command failed: command failed: context canceled, stderr: ', REF);
  assert.strictEqual(ev[0].kind, "stop-lost");
});
T("a Stop hook that failed for some OTHER reason is not an interrupt", () => {
  const ev = cl.parseCliLog(
    'E0721 08:29:01.489683 50198 log_context.go:117] failed to call custom stop hook jsonhook__agy-monitor_Stop_0_0: command failed: signal: killed, stderr: ', REF);
  assert.strictEqual(ev.length, 0);
});
// ONE LOG, TWO WRITERS. agy names its log with 1-second resolution, so two agy processes
// started in the same second open the same file (20 of 154 logs on this machine have two
// pids) and their writes splice together mid-line. Both hazards are covered here.
T("every event carries the pid that wrote it", () => {
  const ev = cl.parseCliLog(
    'I0721 08:28:58.085137 50198 tool_confirmation_manager.go:192] Surfacing tool confirmation: "Bash" at step 4', REF);
  assert.strictEqual(ev[0].pid, "50198");
});
T("a TORN line is split at the prefix that owns each record — no borrowed timestamps", () => {
  // real shape, from cli-20260720_100918.log: one record's body cut off by another's prefix
  const ev = cl.parseCliLog(
    'I0721 08:35:00.000000 111 experiment_manager.go:35] StartI0721 08:20:00.000000 222 log_context.go:117] failed to call custom stop hook h: command failed: context canceled, stderr: ', REF);
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].kind, "stop-lost");
  assert.strictEqual(ev[0].pid, "222", "the stop-lost belongs to pid 222, not the line's leading pid");
  // …and it must be stamped 08:20, NOT the 08:35 of the record it was spliced onto.
  assert.strictEqual(new Date(ev[0].tsMs).getHours(), 8);
  assert.strictEqual(new Date(ev[0].tsMs).getMinutes(), 20);
});
T("an unattributable leading fragment is dropped, not stamped with the wrong clock", () => {
  const ev = cl.parseCliLog(
    'hook: command failed: context canceled, stderr: I0721 08:35:00.000000 111 hooks_manager.go:53] loaded 1 named hooks', REF);
  assert.deepStrictEqual(ev, [], "the tail of a record whose prefix landed earlier has no known time or pid");
});
T("noise lines and non-glog junk are ignored", () => {
  const ev = cl.parseCliLog([
    "I0721 08:28:49.538892 50198 hooks_manager.go:53] loaded 1 named hooks from 1 hooks.json file(s)",
    "not a log line at all",
    "",
    "Surfacing tool confirmation: \"Bash\" at step 4",  // no glog prefix → not a real event
  ].join("\n"), REF);
  assert.strictEqual(ev.length, 0);
});
T("parseCliLog is total: junk input returns [] rather than throwing", () => {
  assert.deepStrictEqual(cl.parseCliLog(null, REF), []);
  assert.deepStrictEqual(cl.parseCliLog("", REF), []);
  assert.deepStrictEqual(cl.parseCliLog(undefined, undefined), []);
});

// ---- confirmationState: file-backed, incremental ----------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agymon-clilog-test-"));
const LOG = path.join(TMP, "cli-20260721_082849.log");
const CID = "afd12068-111c-4a37-95d0-92e190817f23";
// The PreToolUse hook stamps whole seconds; this is the real one from the fossil.
const PRE_TS_MS = new Date(2026, 6, 21, 8, 28, 58).getTime();

const SURFACE = 'I0721 08:28:58.085137 50198 tool_confirmation_manager.go:192] Surfacing tool confirmation: "Bash" at step 4';
const STOP_LOST = 'E0721 08:29:01.489683 50198 log_context.go:117] failed to call custom stop hook jsonhook__agy-monitor_Stop_0_0: JSON hook "x" command failed: command failed: context canceled, stderr: ';
const DENIED = "I0721 08:29:01.400000 50198 server.go:1773] Tool confirmation for conversation " + CID + " step 4 (type=*gemini_coder_go_proto.Step_RunCommand approved=false)";
const PID = "50198";
const write = (...lines) => fs.writeFileSync(LOG, lines.join("\n") + "\n");
const facts = (over) => { cl._resetCache(); return cl.confirmationState(LOG, Object.assign({ cid: CID, stepIdx: 4, sinceMs: PRE_TS_MS, pid: PID }, over)); };

T("parked at the prompt: surfaced, turn NOT ended", () => {
  write(SURFACE);
  const f = facts();
  assert.strictEqual(f.surfaced, true);
  assert.strictEqual(f.tool, "Bash");
  assert.strictEqual(f.approved, null);
  assert.strictEqual(f.turnEnded, false);
});
T("after Escape: the cancelled Stop hook marks the turn ended", () => {
  write(SURFACE, STOP_LOST);
  assert.strictEqual(facts().turnEnded, true);
});
T("after an explicit deny: approved=false", () => {
  write(SURFACE, DENIED, STOP_LOST);
  assert.strictEqual(facts().approved, false);
});
T("a resolved line for ANOTHER conversation is ignored", () => {
  write(SURFACE, DENIED.replace(CID, "11111111-2222-3333-4444-555555555555"));
  assert.strictEqual(facts().approved, null);
});
T("a resolved line for another STEP is ignored", () => {
  write(SURFACE, DENIED.replace("step 4", "step 9"));
  assert.strictEqual(facts().approved, null);
});
T("events from BEFORE this PreToolUse don't leak in", () => {
  write(
    'I0721 08:20:00.000000 50198 tool_confirmation_manager.go:192] Surfacing tool confirmation: "Bash" at step 4',
    'E0721 08:20:05.000000 50198 log_context.go:117] failed to call custom stop hook jsonhook__agy-monitor_Stop_0_0: command failed: context canceled, stderr: ');
  const f = facts();
  assert.strictEqual(f.surfaced, null, "an 8-minute-old surfacing is not this step");
  assert.strictEqual(f.turnEnded, false, "a prior turn's lost Stop must not end this one");
});
T("a same-second cancelled Stop is NOT trusted (can't be ordered against a whole-second stamp)", () => {
  write(SURFACE, 'E0721 08:28:58.900000 50198 log_context.go:117] failed to call custom stop hook x: command failed: context canceled, stderr: ');
  assert.strictEqual(facts().turnEnded, false);
});
T("auto-approved → surfaced:false, so the caller reports 'running', never 'needs you'", () => {
  write('I0721 08:28:58.085137 50198 tool_confirmation_manager.go:71] Auto-approving tool confirmation: "ReadFile" at step 4');
  const f = facts();
  assert.strictEqual(f.surfaced, false);
  assert.strictEqual(f.turnEnded, false);
});
// The pid guard is what makes a shared log safe: only `resolved` carries a conversation
// id, so a sibling process's step-4 lines would otherwise be read as ours — and would
// outrank agy's own ground truth about OUR prompt.
T("a SIBLING process's events in the same log are not attributed to us", () => {
  const sib = (l) => l.replace(" " + PID + " ", " 99999 ");
  write(SURFACE, sib(STOP_LOST), sib(DENIED));
  const f = facts();
  assert.strictEqual(f.surfaced, true, "our own surfacing still counts");
  assert.strictEqual(f.turnEnded, false, "a sibling's lost Stop must not end our turn");
  assert.strictEqual(f.approved, null, "a sibling's denial must not cancel our tool");
});
T("a sibling's auto-approve can't pin us at 'running' either", () => {
  write(SURFACE.replace(" " + PID + " ", " 99999 ").replace("Surfacing tool confirmation:", "tool_confirmation_manager.go:71] Auto-approving tool confirmation:"));
  assert.strictEqual(facts().surfaced, null);
});
T("no pid supplied → no filtering (back-compat), so callers must pass one", () => {
  write(SURFACE.replace(" " + PID + " ", " 99999 "));
  assert.strictEqual(facts({ pid: undefined }).surfaced, true);
  assert.strictEqual(facts().surfaced, null);
});
T("a pid that matches nothing degrades to all-null, never to a wrong answer", () => {
  write(SURFACE, STOP_LOST);
  const f = facts({ pid: "12345" });
  assert.deepStrictEqual(f, { surfaced: null, tool: null, approved: null, turnEnded: false });
});
T("silent log → all-null facts (caller keeps its old inference)", () => {
  write("I0721 08:28:59.000000 50198 hooks_manager.go:53] loaded 1 named hooks");
  const f = facts();
  assert.deepStrictEqual(f, { surfaced: null, tool: null, approved: null, turnEnded: false });
});
T("missing log file → null, so the caller degrades instead of guessing", () => {
  cl._resetCache();
  assert.strictEqual(cl.confirmationState(path.join(TMP, "cli-20260721_000000.log"), { cid: CID, stepIdx: 4, sinceMs: PRE_TS_MS }), null);
  assert.strictEqual(cl.confirmationState(null, {}), null);
});
T("a log that has been deleted drops its cache entry (the daemon runs for weeks)", () => {
  const gone = path.join(TMP, "cli-20260721_090000.log");
  fs.writeFileSync(gone, SURFACE + "\n");
  cl._resetCache();
  assert.strictEqual(cl.confirmationState(gone, { pid: PID, stepIdx: 4, sinceMs: PRE_TS_MS }).surfaced, true);
  fs.rmSync(gone);
  assert.strictEqual(cl.confirmationState(gone, { pid: PID, stepIdx: 4, sinceMs: PRE_TS_MS }), null);
});
T("incremental read: appending is seen without re-parsing from scratch", () => {
  write(SURFACE);
  cl._resetCache();
  const opts = { cid: CID, stepIdx: 4, sinceMs: PRE_TS_MS, pid: PID };
  assert.strictEqual(cl.confirmationState(LOG, opts).turnEnded, false);
  fs.appendFileSync(LOG, STOP_LOST + "\n");           // same cache entry, only new bytes
  assert.strictEqual(cl.confirmationState(LOG, opts).turnEnded, true);
});
T("a truncated/rotated log resets the cache instead of desyncing", () => {
  write(SURFACE, STOP_LOST);
  cl._resetCache();
  const opts = { cid: CID, stepIdx: 4, sinceMs: PRE_TS_MS, pid: PID };
  assert.strictEqual(cl.confirmationState(LOG, opts).turnEnded, true);
  write(SURFACE);                                      // shrank → start clean
  assert.strictEqual(cl.confirmationState(LOG, opts).turnEnded, false);
});
T("a partial trailing line is held back until its newline arrives", () => {
  write(SURFACE);
  cl._resetCache();
  const opts = { cid: CID, stepIdx: 4, sinceMs: PRE_TS_MS, pid: PID };
  cl.confirmationState(LOG, opts);
  fs.appendFileSync(LOG, STOP_LOST.slice(0, 40));      // half a line
  assert.strictEqual(cl.confirmationState(LOG, opts).turnEnded, false);
  fs.appendFileSync(LOG, STOP_LOST.slice(40) + "\n");  // …completed
  assert.strictEqual(cl.confirmationState(LOG, opts).turnEnded, true);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nPASS clilog.test (${pass} assertions)`);
