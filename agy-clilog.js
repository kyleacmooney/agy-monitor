#!/usr/bin/env node
"use strict";
/*
 * agy-clilog — recover turn-state that agy generates but never hands to our hooks.
 *
 * WHY THIS EXISTS
 * ---------------
 * agy fires exactly six lifecycle hooks and none of them means "the user interrupted
 * me". When you press Escape at agy's native tool-approval prompt, agy cancels the
 * TURN CONTEXT and then runs the Stop hook with that already-cancelled context — so
 * our hook process is killed before it can write, and ~/.agy-monitor/sessions/<cid>.json
 * stays frozen on the dangling PreToolUse forever. The monitor then shows "needs you /
 * awaiting approval…" for a session that is really sitting at the input box.
 *
 * agy does record what happened, just not where we were looking: its stdout/stderr IS
 * ~/.gemini/antigravity-cli/log/cli-<YYYYMMDD>_<HHMMSS>.log (one per process, held open
 * on fd 1/2 — so the lsof pass listAgySessions already runs hands us the path for free).
 * Four line shapes there are load-bearing:
 *
 *   tool_confirmation_manager.go:192] Surfacing tool confirmation: "Bash" at step 4
 *   tool_confirmation_manager.go:71]  Auto-approving tool confirmation: "ReadFile" at step 4
 *   tool_confirmation_manager.go:183] Print mode: soft-denying tool confirmation "Bash" at step 10
 *   server.go:1773] Tool confirmation for conversation <cid> step 10 (type=… approved=false)
 *   log_context.go:117] failed to call custom stop hook jsonhook__agy-monitor_Stop_0_0: … context canceled
 *
 * The `at step N` / `step N` numbers are the SAME numbering as the PreToolUse payload's
 * `stepIdx` (verified against two archived stuck sessions), which is what lets us pair a
 * frozen status file with agy's own account of that exact step.
 *
 * PUBLIC API
 *   parseCliLog(text, refMs) -> [{ kind, tsMs, tool, step, cid, approved }]   (pure)
 *   logStartMs(logPath)      -> epoch ms parsed from the cli-<date>_<time>.log name
 *   confirmationState(logPath, { cid, stepIdx, sinceMs })
 *        -> { surfaced, tool, approved, turnEnded } | null
 *
 * Every failure path returns null so callers degrade to their old behaviour — this
 * module may only ever ADD certainty, never remove it.
 */

const fs = require("fs");
const path = require("path");

// Only the tail matters: we always window events to "after the PreToolUse we're
// explaining", and a session that has been running for hours has a huge log.
const TAIL_BYTES = 512 * 1024;
// The hook stamps whole seconds (`date +%s`), and agy logs the "Surfacing" line a few
// ms AFTER PreToolUse fires, so a match can look very slightly older than the hook.
const SLACK_MS = 2000;
// A cancelled-Stop line only counts as "the turn ended" if it lands strictly after the
// second the PreToolUse was stamped in — same-second lines can't be ordered reliably.
const TURN_END_MIN_MS = 1000;
const MAX_EVENTS = 2000; // ring cap; a long-lived process must not grow this unbounded

// glog prefix: I0721 08:28:58.085137 50198 server.go:1773] …  (the trailing number is
// the writing process's pid — agy's own pid, verified: the first line of every log is
// `Starting language server process with pid <same>`, and lsof shows that pid holding
// the file). We capture it because ONE LOG CAN HAVE TWO WRITERS: the filename has
// 1-second resolution (cli-<YYYYMMDD>_<HHMMSS>.log), so two agy processes started in
// the same second open the same file — 20 of 154 logs on this machine have two pids —
// and with independent offsets their writes even splice together mid-line.
const GLOG_RE = /[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6}) (\d+) /g;

const SURFACED = /Surfacing tool confirmation: "([^"]*)" at step (\d+)/;
const AUTO_APPROVED = /Auto-approving tool confirmation: "([^"]*)" at step (\d+)/;
const SOFT_DENIED = /soft-denying tool confirmation "([^"]*)" at step (\d+)/;
const RESOLVED = /Tool confirmation for conversation ([0-9a-fA-F-]{36}) step (\d+) \(([^)]*)\)/;
const STOP_LOST = /failed to call custom stop hook\b[\s\S]{0,400}?context canceled/;

// The filename carries the only year the log itself never prints.
function logStartMs(logPath) {
  const m = /cli-(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.log$/.exec(String(logPath || ""));
  if (m) {
    const [, y, mo, d, h, mi, s] = m.map(Number);
    const t = new Date(y, mo - 1, d, h, mi, s).getTime();
    if (Number.isFinite(t)) return t;
  }
  // Unnamed/rotated log: fall back to its own birth time, then mtime.
  try {
    const st = fs.statSync(logPath);
    return st.birthtimeMs > 9.4e11 ? st.birthtimeMs : st.mtimeMs;
  } catch { return null; }
}

// glog omits the year, so we borrow it from the log's start and roll forward if the
// month/day sits before it (a process alive across New Year).
function stampMs(m, refMs) {
  const ref = new Date(refMs);
  const [, mo, d, h, mi, s, us] = m;
  let t = new Date(ref.getFullYear(), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Math.floor(Number(us) / 1000)).getTime();
  if (t < refMs - 12 * 3600 * 1000) t = new Date(ref.getFullYear() + 1, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Math.floor(Number(us) / 1000)).getTime();
  return t;
}

// Split one physical line into the glog RECORDS it contains. Normally that is exactly
// one, but two processes writing the same log at independent offsets splice records
// together mid-line, e.g.
//   I0720 10:09:19.226024 13825 experiment_manager.go:35] StartI0720 10:09:19.420608 14248 http_helpers.go:228] URL: …
// Attributing the second record's BODY to the first record's timestamp and pid is
// exactly how a stray "stop-lost" could steal a live session's clock, so each record
// must be paired with the prefix that actually owns it. Any leading fragment (the tail
// of a record whose prefix landed on an earlier line) is unattributable — drop it.
function splitRecords(line) {
  const recs = [];
  GLOG_RE.lastIndex = 0;
  let m, prev = null;
  while ((m = GLOG_RE.exec(line))) {
    if (prev) recs.push({ g: prev.g, body: line.slice(prev.end, m.index) });
    prev = { g: m, end: GLOG_RE.lastIndex };
  }
  if (prev) recs.push({ g: prev.g, body: line.slice(prev.end) });
  return recs;
}

// Pure: log text (any number of whole lines) -> the events we care about.
function parseCliLog(text, refMs) {
  const out = [];
  if (typeof text !== "string" || !text) return out;
  const ref = typeof refMs === "number" && Number.isFinite(refMs) ? refMs : Date.now();
  for (const line of text.split("\n")) {
    for (const { g, body } of splitRecords(line)) {
      const tsMs = stampMs(g, ref);
      const pid = g[7];
      let m;
      if ((m = SURFACED.exec(body))) out.push({ kind: "surfaced", tsMs, pid, tool: m[1], step: Number(m[2]) });
      else if ((m = AUTO_APPROVED.exec(body))) out.push({ kind: "auto-approved", tsMs, pid, tool: m[1], step: Number(m[2]) });
      else if ((m = SOFT_DENIED.exec(body))) out.push({ kind: "soft-denied", tsMs, pid, tool: m[1], step: Number(m[2]) });
      else if ((m = RESOLVED.exec(body))) out.push({ kind: "resolved", tsMs, pid, cid: m[1], step: Number(m[2]), approved: /\bapproved=true\b/.test(m[3]) });
      else if (STOP_LOST.test(body)) out.push({ kind: "stop-lost", tsMs, pid });
    }
  }
  return out;
}

// Incremental tail reader: parse only bytes we haven't seen, keyed by file size, so a
// poll loop over a live (constantly appending) log stays cheap.
const _cache = new Map(); // logPath -> { size, refMs, carry, events }

const MAX_CACHED_LOGS = 64; // agy makes one log per process and never reuses a path

function readEvents(logPath) {
  if (typeof logPath !== "string" || !logPath) return null;
  let size;
  // The daemon runs for weeks and every agy process mints a brand-new log path, so an
  // entry whose file is gone must be dropped or the Map grows without bound.
  try { size = fs.statSync(logPath).size; } catch { _cache.delete(logPath); return null; }
  if (!_cache.has(logPath) && _cache.size >= MAX_CACHED_LOGS) {
    _cache.delete(_cache.keys().next().value); // Map keeps insertion order → oldest first
  }

  let c = _cache.get(logPath);
  if (!c || size < c.size) {
    // First sight, or the file shrank (rotated/truncated) — start clean.
    const refMs = logStartMs(logPath);
    if (refMs == null) return null;
    c = { size: Math.max(0, size - TAIL_BYTES), refMs, carry: "", events: [] };
    _cache.set(logPath, c);
  }
  if (size > c.size) {
    let chunk;
    try {
      const fd = fs.openSync(logPath, "r");
      try {
        const len = size - c.size;
        const buf = Buffer.allocUnsafe(len);
        const read = fs.readSync(fd, buf, 0, len, c.size);
        chunk = buf.slice(0, read).toString("utf8");
      } finally { fs.closeSync(fd); }
    } catch { return c.events.length ? c.events : null; }
    const text = c.carry + chunk;
    // A trailing partial line must wait for the rest of itself.
    const cut = text.lastIndexOf("\n");
    c.carry = cut < 0 ? text : text.slice(cut + 1);
    if (cut >= 0) c.events.push(...parseCliLog(text.slice(0, cut), c.refMs));
    if (c.events.length > MAX_EVENTS) c.events.splice(0, c.events.length - MAX_EVENTS);
    c.size = size;
  }
  return c.events;
}

/*
 * What agy itself says about the tool call a frozen PreToolUse is parked on.
 *
 *   surfaced   true  = agy IS showing its approval prompt for this step (ground truth,
 *                      unlike agy-monitor's own policy heuristic)
 *              false = agy auto-approved it, so the tool is genuinely running
 *              null  = no evidence either way
 *   approved   true/false once the prompt is answered (false = denied OR escaped)
 *   turnEnded  agy tried to fire Stop with a cancelled context after our PreToolUse —
 *              i.e. the turn ended and our hook was killed before it could record it
 *
 * `pid` is REQUIRED for a trustworthy answer. Only the `resolved` line carries a
 * conversation id; `Surfacing`/`Auto-approving` are scoped by nothing but a small step
 * number, and `stop-lost` by nothing at all. Since a log can have two writers (see
 * GLOG_RE), a sibling session's step 4 would otherwise be read as ours — and would
 * outrank agy's own ground truth about our prompt. Passing the pid we got from lsof
 * scopes every event to the one process this session actually is. Without it, a
 * mismatch just yields all-null facts and the caller keeps its old inference.
 */
function confirmationState(logPath, opts) {
  const o = opts || {};
  const events = readEvents(logPath);
  if (!events) return null;
  const sinceMs = typeof o.sinceMs === "number" ? o.sinceMs : null;
  const from = sinceMs == null ? -Infinity : sinceMs - SLACK_MS;
  const stepIdx = typeof o.stepIdx === "number" ? o.stepIdx : null;
  const pid = o.pid == null ? null : String(o.pid);

  let surfaced = null, tool = null, approved = null, turnEnded = false;
  for (const e of events) {
    if (e.tsMs < from) continue;
    if (pid != null && e.pid !== pid) continue;
    if (e.kind === "stop-lost") {
      if (sinceMs == null || e.tsMs >= sinceMs + TURN_END_MIN_MS) turnEnded = true;
      continue;
    }
    if (stepIdx == null || e.step !== stepIdx) continue;
    if (e.kind === "surfaced") { surfaced = true; if (e.tool) tool = e.tool; }
    else if (e.kind === "auto-approved") { if (surfaced === null) surfaced = false; if (e.tool) tool = e.tool; }
    else if (e.kind === "soft-denied") { approved = false; if (e.tool) tool = e.tool; }
    else if (e.kind === "resolved") { if (!o.cid || !e.cid || e.cid === o.cid) approved = e.approved; }
  }
  return { surfaced, tool, approved, turnEnded };
}

// Testing seam: the incremental cache must not leak between fixture worlds.
function _resetCache() { _cache.clear(); }

module.exports = { parseCliLog, logStartMs, confirmationState, _resetCache, TAIL_BYTES, SLACK_MS, TURN_END_MIN_MS };
