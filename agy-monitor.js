"use strict";
/*
 * agyMonitor — monitor running agy (Antigravity CLI) sessions.
 *
 * Exported as a self-contained tool object so it can also be embedded in a
 * larger dashboard host. Tool interface:
 * { id, meta(config), async run(input, config) }.
 *
 * Model: ONE card per live agy PROCESS (each agy terminal). agy runs one OS
 * process per terminal but multiplexes conversations inside it, and exposes no
 * session-start/end hook — so a process is the reliable unit of "a running
 * session". Liveness comes from `ps`; the workspace from `lsof` (cwd).
 *
 * Live state (busy/idle/waiting) comes from the agy hook (agy-monitor-hook.sh),
 * which writes a per-conversation status file. We attach a conversation's state
 * to a process ONLY when the hook event fired AFTER that process started — so a
 * stale/prior conversation in the same folder (e.g. one you already /quit) can
 * never mislabel a freshly started session. The current prompt is read from that
 * conversation's own transcript, never from folder-global history.
 *
 * Read-only; nothing is mutated, so polling every few seconds is safe.
 * Standalone:  node agy-monitor.js
 */

const { execFile, execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// AGY_MONITOR_ROOT / AGY_CLI_HOME let the server tests point everything at
// fixture dirs (same convention agy-gate.js already uses).
const MON_ROOT = process.env.AGY_MONITOR_ROOT || path.join(os.homedir(), ".agy-monitor");
const STATUS_DIR = path.join(MON_ROOT, "sessions");
const APPROVALS_DIR = path.join(MON_ROOT, "approvals"); // gate → UI (pending)
const ANSWERS_DIR = path.join(MON_ROOT, "answers");     // UI → gate (decision)
const UI_RUNS_DIR = path.join(MON_ROOT, "ui-runs");     // conversations launched from the UI
const AGY_DIR = process.env.AGY_CLI_HOME || path.join(os.homedir(), ".gemini", "antigravity-cli");
const SETTINGS = path.join(AGY_DIR, "settings.json");
const BRAIN_DIR = path.join(AGY_DIR, "brain"); // per-conversation transcripts live here
const HISTORY = path.join(AGY_DIR, "history.jsonl"); // {display,timestamp,workspace,conversationId}
const CONVO_META = path.join(AGY_DIR, "cache", "conversation_metadata.json"); // agy's /resume index
const GEMINI_GLOBAL = path.join(os.homedir(), ".gemini", "GEMINI.md");

const STATUS_STALE_HOURS = 24; // GC status files older than this
// A hook event may be logged a few seconds before/after we compute the process
// start (1s ps resolution + write latency); allow this slack when gating.
const ATTACH_SLACK_MS = 6000;
// Active work streams hook events every few seconds; a "busy" whose last event is
// older than this has really ended its turn (its Stop was missed or overwritten by
// a trailing out-of-order event), so we show it as idle/your-turn instead.
const BUSY_STALE_MS = 45000;
// actionable-first: needs-you states sort above working ones
const STATE_ORDER = { waiting: 0, idle: 1, busy: 2, running: 3, unknown: 4 };

// ---- small helpers ---------------------------------------------------------

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout) => {
      resolve(typeof stdout === "string" ? stdout : "");
    });
  });
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function homeShort(p) {
  const home = os.homedir();
  return p && p.startsWith(home) ? "~" + p.slice(home.length) : p || "";
}

function etimeToSeconds(etime) {
  if (!etime) return null;
  let days = 0, rest = etime;
  if (rest.includes("-")) { const [d, r] = rest.split("-"); days = parseInt(d, 10) || 0; rest = r; }
  const parts = rest.split(":").map((n) => parseInt(n, 10) || 0);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return days * 86400 + s;
}

function humanDuration(sec) {
  if (sec == null) return "";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function classifyArgs(argv) {
  const joined = argv.join(" ");
  const has = (...flags) => argv.some((a) => flags.includes(a));
  let mode = "interactive";
  if (has("-p", "--print", "--prompt")) mode = "print";
  else if (has("-c", "--continue")) mode = "continue";
  else if (has("--conversation")) mode = "resume";
  else if (has("-i", "--prompt-interactive")) mode = "interactive";

  let prompt = null;
  const m = joined.match(/(?:^|\s)(?:-p|--print|--prompt|-i|--prompt-interactive)\s+(.+)$/);
  if (m) prompt = m[1].trim();
  return { mode, prompt, sandbox: has("--sandbox"), skipPerms: has("--dangerously-skip-permissions") };
}

function configuredModel() {
  const s = readJsonSafe(SETTINGS, {});
  return typeof s.model === "string" ? s.model : null;
}

// --- per-conversation cost (list-price estimate of token spend) --------------
// agy stores per-turn token usage as a protobuf blob in conversations/<id>.db
// gen_metadata. We decode it (no deps) and price it at retail Vertex rates. This
// is the retail value of your tokens, NOT the (pooled, per-project) amount billed.
//
// Field map (empirically decoded against agy's /tokens output): in the usage submsg
//   f2 = new/uncached prompt tokens, f5 = cached prompt tokens,
//   f3 = output tokens, f9 = thinking tokens (also output-rate).
// NOTE: not yet locked against `/tokens` — treat as an estimate.

// USD per 1M tokens. 3.0 and 3.1 Pro are priced identically.
const PRICES = {
  "gemini-3-pro":     { in: 2.00, cached: 0.20, out: 12.00, inHi: 4.00, cachedHi: 0.40, outHi: 18.00 },
  "gemini-3.5-flash": { in: 1.50, cached: 0.15, out: 9.00 },
  "gemini-2.5-pro":   { in: 1.25, cached: 0.125, out: 10.00, inHi: 2.50, cachedHi: 0.25, outHi: 15.00 },
};
const TIER_HI = 200000; // prompt-token boundary for the higher price tier

function priceBucket(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("flash")) return "gemini-3.5-flash";
  if (m.includes("2.5")) return "gemini-2.5-pro";
  return "gemini-3-pro"; // 3 / 3.1 Pro (and default)
}

function pbVarint(buf, st) {
  let shift = 0, res = 0;
  for (;;) { const b = buf[st.i++]; res += (b & 0x7f) * 2 ** shift; if (!(b & 0x80)) break; shift += 7; }
  return res;
}
function parsePb(buf) {
  const out = {}; const st = { i: 0 };
  while (st.i < buf.length) {
    const key = pbVarint(buf, st); const fn = Math.floor(key / 8), wt = key & 7; let v;
    if (wt === 0) v = pbVarint(buf, st);
    else if (wt === 1) { v = buf.subarray(st.i, st.i + 8); st.i += 8; }
    else if (wt === 2) { const len = pbVarint(buf, st); const raw = buf.subarray(st.i, st.i + len); st.i += len; let sub = null; try { sub = parsePb(raw); } catch {} v = sub != null ? sub : raw; }
    else if (wt === 5) { v = buf.subarray(st.i, st.i + 4); st.i += 4; }
    else break;
    (out[fn] || (out[fn] = [])).push(v);
  }
  return out;
}
function usageOf(rowBuf) {
  const top = parsePb(rowBuf);
  const f1 = top[1] && top[1][0];
  if (!f1 || typeof f1 !== "object") return null;
  let u = (f1[4] && f1[4][0]) || (f1[17] && f1[17][0]);
  if (u && u[2] && typeof u[2][0] === "object") u = u[2][0];
  if (!u || typeof u !== "object") return null;
  const scal = {};
  for (const k of Object.keys(u)) if (typeof u[k][0] === "number") scal[k] = u[k][0];
  return scal;
}

const _costCache = new Map(); // db path -> { mtimeMs, model, result }
function conversationCost(conversationId, model) {
  if (!isSafeConversationId(conversationId)) return null;
  const db = path.join(AGY_DIR, "conversations", conversationId + ".db");
  let mtimeMs;
  try { mtimeMs = fs.statSync(db).mtimeMs; } catch { return null; }
  const cached = _costCache.get(db);
  if (cached && cached.mtimeMs === mtimeMs && cached.model === model) return cached.result;

  let hex;
  try {
    hex = execFileSync("sqlite3", ["file:" + db + "?immutable=1", "SELECT idx||':'||hex(data) FROM gen_metadata ORDER BY idx;"],
      { timeout: 5000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).toString();
  } catch (e) {
    // A permanently malformed db (there is one on this machine) would otherwise
    // re-fork sqlite3 on every call forever — and leak its stderr into our log.
    // Pin ONLY when the db itself is the problem: a transient fork/timeout must
    // stay retryable, or one blip hides a real cost until the process restarts.
    const why = String((e && e.stderr) || (e && e.message) || "");
    if (/malformed|not a database|file is encrypted|no such table/i.test(why)) _costCache.set(db, { mtimeMs, model, result: null });
    return null;
  }

  const P = PRICES[priceBucket(model)] || PRICES["gemini-3-pro"];
  let uncachedInput = 0, cachedTok = 0, output = 0, costUsd = 0, turns = 0;
  for (const line of hex.split("\n")) {
    if (!line.trim()) continue;
    const c = line.indexOf(":");
    let u = null;
    try { u = usageOf(Buffer.from(line.slice(c + 1), "hex")); } catch {}
    if (!u) continue;
    const f2 = u[2] || 0, f5 = u[5] || 0, out = (u[3] || 0) + (u[9] || 0);
    if (!f2 && !f5 && !out) continue; // empty/aborted turn
    turns++;
    const hi = (f2 + f5) > TIER_HI && P.inHi;
    uncachedInput += f2; cachedTok += f5; output += out;
    costUsd += (f2 * (hi ? P.inHi : P.in) + f5 * (hi ? P.cachedHi : P.cached) + out * (hi ? P.outHi : P.out)) / 1e6;
  }
  const result = turns ? { costUsd, tokens: { uncachedInput, cached: cachedTok, output }, turns } : null;
  _costCache.set(db, { mtimeMs, model, result });
  return result;
}

// Global rollup: total list-price cost across conversations whose .db was written
// within `days` (null/0 = all time), newest-priciest first. Iterates the
// conversations DIRECTORY (not just the metadata index) so headless/untracked
// conversations are counted too; the .db mtime is the reliable activity time.
// Also returns `spark`: 14 half-day buckets over the last 7 days for the sidebar
// sparkline (a conversation's whole cost lands in its last-activity bucket —
// coarse, but per-turn timestamps aren't worth decoding for a 20px chart).
const SPARK_BUCKETS = 14, SPARK_BUCKET_MS = 12 * 3600 * 1000;
function getCostSummary(days) {
  const meta = loadConversationMeta() || {};
  const model = configuredModel();
  const now = Date.now();
  const sinceMs = (typeof days === "number" && days > 0) ? now - days * 86400 * 1000 : 0;
  const dir = path.join(AGY_DIR, "conversations");
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".db")); } catch { files = []; }

  let total = 0, count = 0;
  const items = [];
  const spark = new Array(SPARK_BUCKETS).fill(0);
  for (const f of files) {
    const cid = f.slice(0, -3);
    if (!isSafeConversationId(cid)) continue;
    const rec = meta[cid], sm = rec && rec.summary;
    if (rec && rec.is_internal) continue;
    let mtimeMs;
    try { mtimeMs = fs.statSync(path.join(dir, f)).mtimeMs; } catch { continue; }
    if (sinceMs && mtimeMs < sinceMs) continue;
    const c = conversationCost(cid, model);
    if (!c) continue;
    total += c.costUsd; count++;
    const bucket = SPARK_BUCKETS - 1 - Math.floor((now - mtimeMs) / SPARK_BUCKET_MS);
    if (bucket >= 0 && bucket < SPARK_BUCKETS) spark[bucket] += c.costUsd;
    items.push({
      conversationId: cid,
      title: (sm && (cleanTitle(sm.Title) || cleanTitle(sm.Preview))) || firstUserPrompt(cid) || null,
      costUsd: c.costUsd,
      updatedAt: new Date(mtimeMs).toISOString(),
      project: sm && sm.WorkspaceURIs && sm.WorkspaceURIs[0] ? path.basename(uriToPath(sm.WorkspaceURIs[0])) : null,
    });
  }
  items.sort((a, b) => b.costUsd - a.costUsd);
  return { ok: true, days: days || null, total, count, spark, items: items.slice(0, 60) };
}

// --- unread cursors: how far the UI has read each conversation ---------------
// seen.json maps conversationId → the turn count the user last had on screen.
// unread = turns now − turns seen. A conversation never opened in the UI shows
// 0 (the first open sets the cursor) so old transcripts don't flood the badges.
const SEEN_FILE = path.join(MON_ROOT, "seen.json");
function readSeen() { return readJsonSafe(SEEN_FILE, {}); }
function markSeen(conversationId, count) {
  if (!isSafeConversationId(conversationId)) return { ok: false, message: "invalid conversationId" };
  const n = typeof count === "number" && count >= 0 ? Math.floor(count) : null;
  if (n == null) return { ok: false, message: "count required" };
  const seen = readSeen();
  seen[conversationId] = Math.max(n, seen[conversationId] || 0);
  try {
    fs.mkdirSync(MON_ROOT, { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(seen));
  } catch (e) {
    return { ok: false, message: "failed to write seen file: " + (e && e.message ? e.message : e) };
  }
  return { ok: true };
}

// User input content is wrapped in <USER_REQUEST>…</USER_REQUEST> with trailing
// metadata tags; pull just the request text. UI-launched runs append the ```ask
// convention block after ASK_MARK — that's instruction plumbing, not the user's
// words, so it's stripped everywhere user text is shown or titled.
const { ASK_MARK, ASK_RULES } = require("./agy-runs");
function stripUserRequest(content) {
  if (typeof content !== "string") return "";
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  let s = (m ? m[1] : content);
  // Unwrapped inputs (none on disk today, but titles are derived from this) still
  // carry agy's trailing context blocks — they are not part of what the user typed.
  if (!m) s = s.replace(/<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/g, "");
  const i = s.indexOf(ASK_MARK);
  if (i >= 0) s = s.slice(0, i).replace(/\s+$/, "");
  return s.trim();
}

// Extract a ```ask fenced block (the headless question convention) from an
// assistant turn: → { ask: parsedSpec|null, text: prose without the fence }.
function extractAsk(text) {
  const m = /```ask\s*\n([\s\S]*?)```/.exec(text || "");
  if (!m) return { ask: null, text };
  let spec = null;
  try { spec = JSON.parse(m[1].trim()); } catch {}
  if (!spec || !Array.isArray(spec.questions) || !spec.questions.length) return { ask: null, text };
  return { ask: { questions: spec.questions.slice(0, 4) }, text: (text.replace(m[0], "").trim()) };
}

// Drop trailing spaces and collapse runs of blank lines so the rendered text
// (pre-wrap) doesn't show big vertical gaps between paragraphs.
function tidyText(s) {
  if (typeof s !== "string") return "";
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The current prompt = the last USER_INPUT in this conversation's own transcript.
// Per-conversation, so it can't bleed in a different session's prompt the way
// folder-global history did.
function promptFromTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try { text = fs.readFileSync(transcriptPath, "utf8"); } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (!ln) continue;
    let e;
    try { e = JSON.parse(ln); } catch { continue; }
    if (e.type !== "USER_INPUT" || typeof e.content !== "string") continue;
    const raw = stripUserRequest(e.content);
    return raw || null;
  }
  return null;
}

// Tool step content carries a "Created At/Completed At" header, agy's tab indent,
// and a trailing "If relevant, proactively run…" boilerplate line. Strip all of
// that and cap length so the conversation payload stays readable + reasonable.
function cleanToolOutput(content) {
  if (typeof content !== "string") return null;
  const s = content
    .replace(/^(?:Created At:.*\n)?(?:Completed At:.*\n)?/, "")
    .replace(/\n?If relevant, proactively run terminal commands[\s\S]*$/, "")
    .split("\n")
    .map((l) => l.replace(/^[ \t]+/, "")) // drop agy's leading tab/space indent
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s ? s.slice(0, 4000) : null;
}

// A run_command result reads "<status>\nOutput:\n<stdout>". Split it so the UI can
// preview/show the actual command output distinctly from the status line.
function parseCommandResult(cleaned) {
  if (!cleaned) return { status: null, stdout: null };
  const i = cleaned.indexOf("\nOutput:");
  if (i === -1) return { status: cleaned.split("\n")[0] || null, stdout: null };
  const status = cleaned.slice(0, i).trim() || null;
  const stdout = cleaned.slice(i + "\nOutput:".length).replace(/^\n/, "").replace(/\s+$/, "");
  return { status, stdout: stdout || null };
}

// Normalize one tool call. write_to_file carries the new file content, which we
// surface so the UI can show it as a diff; every write-class tool names its file
// so the UI's TURN panel can scope the workspace diff to the current turn.
function parseToolCall(tc) {
  const a = (tc && tc.args) || {};
  const base = { name: (tc && tc.name) || "tool", summary: a.toolSummary || a.toolAction || null };
  if (tc && tc.name === "write_to_file") {
    return {
      ...base,
      file: a.TargetFile || null,
      content: typeof a.CodeContent === "string" ? a.CodeContent.slice(0, 12000) : null,
      overwrite: !!a.Overwrite,
    };
  }
  if (tc && tc.name === "run_command") {
    return { ...base, command: typeof a.CommandLine === "string" ? a.CommandLine.slice(0, 2000) : null };
  }
  if (tc && WRITE_TOOLS.has(tc.name)) {
    return { ...base, file: fileFromToolArgs(a) };
  }
  return base;
}

// Parse a conversation's transcript_full.jsonl into a normalized message list the
// UI renders: user turns, assistant text + thinking + tool calls, and tool results.
function parseTranscript(transcriptPath) {
  const text = fs.readFileSync(transcriptPath, "utf8"); // throws → caller handles
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "CONVERSATION_HISTORY") continue; // internal
    if (e.type === "USER_INPUT") {
      const t = tidyText(stripUserRequest(e.content));
      if (t) out.push({ role: "user", text: t.slice(0, 6000), ts: e.created_at || null });
    } else if (e.type === "PLANNER_RESPONSE") {
      const ax = extractAsk(tidyText(e.content || ""));
      out.push({
        role: "assistant",
        text: ax.text.slice(0, 8000) || null,
        ask: ax.ask,
        thinking: e.thinking ? tidyText(String(e.thinking)).slice(0, 6000) : null,
        toolCalls: Array.isArray(e.tool_calls) ? e.tool_calls.map(parseToolCall) : [],
        ts: e.created_at || null,
      });
    } else if (e.source === "MODEL") {
      // a tool step keyed by its type (GREP_SEARCH, VIEW_FILE, RUN_COMMAND, …)
      const cleaned = cleanToolOutput(e.content);
      const msg = {
        role: "tool",
        toolName: String(e.type || "tool").toLowerCase().replace(/_/g, " "),
        output: cleaned,
        ts: e.created_at || null,
      };
      if (e.type === "RUN_COMMAND") {
        const c = parseCommandResult(cleaned);
        msg.kind = "command";
        msg.status = c.status;
        msg.stdout = c.stdout;
      }
      out.push(msg);
    }
  }
  // keep the most recent slice for very long conversations
  return out.length > 400 ? out.slice(-400) : out;
}

// Tools that change files on disk; their args name the file written/edited.
const WRITE_TOOLS = new Set([
  "write_to_file", "replace_file_content", "multi_replace_file_content",
  "edit_file", "create_file", "apply_patch",
]);
function fileFromToolArgs(a) {
  const f = a && (a.TargetFile || a.FilePath || a.AbsolutePath || a.File || a.Path || a.Uri);
  if (!f) return null;
  try { return decodeURIComponent(String(f).replace(/^file:\/\//, "")); } catch { return String(f); }
}

// A lightweight card summary for a conversation: the agent's latest reply and the
// files it has changed. Cached by transcript mtime so 4s polling re-reads only on change.
const _summaryCache = new Map(); // transcriptPath -> { mtimeMs, summary }
function sessionSummary(conversationId) {
  const tp = path.join(BRAIN_DIR, conversationId, ".system_generated", "logs", "transcript_full.jsonl");
  let mtimeMs;
  try { mtimeMs = fs.statSync(tp).mtimeMs; } catch { return null; }
  const cached = _summaryCache.get(tp);
  if (cached && cached.mtimeMs === mtimeMs) return cached.summary;
  let text;
  try { text = fs.readFileSync(tp, "utf8"); } catch { return null; }
  let lastReply = null;
  let userTurns = 0, plannerTurns = 0;
  let lastTurnKind = null; // "user" | "planner" | "ask" — tool rows don't reset it
  const files = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "USER_INPUT") { userTurns++; lastTurnKind = "user"; continue; }
    if (e.type !== "PLANNER_RESPONSE") continue;
    plannerTurns++;
    lastTurnKind = typeof e.content === "string" && /```ask\s*\n/.test(e.content) ? "ask" : "planner";
    if (typeof e.content === "string" && e.content.trim()) lastReply = e.content;
    if (Array.isArray(e.tool_calls)) {
      for (const tc of e.tool_calls) {
        if (!tc || !WRITE_TOOLS.has(tc.name)) continue;
        const f = fileFromToolArgs(tc.args);
        if (f && !seen.has(f)) { seen.add(f); files.push(f); }
      }
    }
  }
  const summary = {
    lastReply: lastReply ? tidyText(lastReply).slice(0, 240) : null,
    files: files.slice(-8).map((f) => ({ path: f, name: f.split("/").pop() })),
    hasEarlier: userTurns > 1, // the shown exchange is the tail of a longer conversation
    msgCount: userTurns + plannerTurns, // turn-level cursor for unread badges (tool rows would inflate it)
    endsWithAsk: lastTurnKind === "ask", // conversation is waiting on an unanswered ```ask
  };
  _summaryCache.set(tp, { mtimeMs, summary });
  return summary;
}

// conversationId is interpolated into a filesystem path, so restrict it to the
// uuid charset — no separators, no traversal.
function isSafeConversationId(cid) {
  return typeof cid === "string" && /^[0-9a-fA-F-]{16,40}$/.test(cid);
}

function getConversation(conversationId) {
  if (!isSafeConversationId(conversationId)) {
    return { ok: false, message: "invalid conversationId" };
  }
  const tp = path.join(BRAIN_DIR, conversationId, ".system_generated", "logs", "transcript_full.jsonl");
  try {
    const messages = parseTranscript(tp);
    const convos = loadConversationMeta() || {};
    // index first, history.jsonl second — a backfilled conversation has no summary
    const ws = conversationWorkspace(conversationId, convos);
    const cost = conversationCost(conversationId, configuredModel());
    const summary = sessionSummary(conversationId);
    return {
      ok: true, conversationId, messages,
      // unindexed conversations have no index title — recover it from the same
      // mtime-cached transcript pass the all-chats list uses (this reloads on
      // every poll, so a second uncached 16KB read would be per-tick waste).
      title: titleFromMeta(convos, conversationId) || (transcriptStats(conversationId) || {}).title || null,
      workspace: ws, project: ws ? path.basename(ws) : null, shortWorkspace: ws ? homeShort(ws) : null,
      costUsd: cost ? cost.costUsd : null, tokens: cost ? cost.tokens : null,
      msgCount: summary ? summary.msgCount : null, // the UI reports this back via mark-seen
    };
  } catch {
    return { ok: false, message: "no transcript for that conversation yet" };
  }
}

const MAX_FILE_BYTES = 256 * 1024;

// Read a file referenced in a conversation (e.g. a [name](file:///…) link) for the
// in-app file viewer. Restricted to the user's home tree — referenced project files
// live there, and it keeps this localhost endpoint from serving arbitrary system files.
function getFile(rawPath) {
  if (typeof rawPath !== "string" || !rawPath) return { ok: false, message: "path required" };
  let fp = rawPath.startsWith("file://") ? decodeURIComponent(rawPath.replace(/^file:\/\//, "")) : rawPath;
  fp = path.resolve(fp);
  if (!path.isAbsolute(fp)) return { ok: false, message: "absolute path required" };
  if (fp !== os.homedir() && !fp.startsWith(os.homedir() + path.sep)) {
    return { ok: false, message: "outside home directory" };
  }
  let st;
  try { st = fs.statSync(fp); } catch { return { ok: false, message: "file not found" }; }
  if (!st.isFile()) return { ok: false, message: "not a file" };
  let buf;
  try {
    const fd = fs.openSync(fp, "r");
    buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
  } catch { return { ok: false, message: "cannot read file" }; }
  if (buf.includes(0)) return { ok: true, path: fp, binary: true, content: null, size: st.size };
  return { ok: true, path: fp, content: buf.toString("utf8"), truncated: st.size > MAX_FILE_BYTES, size: st.size };
}

// --- "memory" view: agy's context files + a workspace's conversation history ----

function readContextFile(p, scope) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { path: p, scope, exists: false };
    return { path: p, scope, exists: true, empty: st.size === 0, content: fs.readFileSync(p, "utf8").slice(0, 40000) };
  } catch {
    return { path: p, scope, exists: false };
  }
}

// The opening user prompt of a conversation, read from the head of its transcript
// (more reliable as a title than history.jsonl, which can miss the first turn).
function firstUserPrompt(conversationId) {
  const tp = path.join(BRAIN_DIR, conversationId, ".system_generated", "logs", "transcript_full.jsonl");
  let text;
  try {
    const fd = fs.openSync(tp, "r");
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.subarray(0, n).toString("utf8");
  } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // last line may be truncated — skip
    if (e.type === "USER_INPUT" && typeof e.content === "string") {
      const t = stripUserRequest(e.content);
      if (t) return t.replace(/\s+/g, " ").slice(0, 100);
    }
  }
  return null;
}

function uriToPath(u) {
  try { return decodeURIComponent(String(u).replace(/^file:\/\//, "")).replace(/\/+$/, ""); }
  catch { return String(u).replace(/^file:\/\//, "").replace(/\/+$/, ""); }
}

// agy's generated/renamed titles carry the odd leading "### " markdown header and
// stray whitespace — normalize for display.
function cleanTitle(t) {
  if (typeof t !== "string") return null;
  const s = t.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 140) : null;
}

// agy's /resume index (conversationId → summary), or null if absent.
function loadConversationMeta() {
  try { const j = JSON.parse(fs.readFileSync(CONVO_META, "utf8")); return (j && j.conversations) || {}; }
  catch { return null; }
}

// A conversation's display title: renamed Title, else generated Preview.
function titleFromMeta(convos, cid) {
  const sm = convos && convos[cid] && convos[cid].summary;
  if (!sm) return null;
  return cleanTitle(sm.Title) || cleanTitle(sm.Preview) || null;
}

// All conversations agy has had in a workspace, newest first. Primary source is
// agy's own /resume index (cache/conversation_metadata.json) which has the real
// titles (Title = renamed, Preview = generated), step counts, timestamps and the
// CLI-vs-IDE origin; falls back to history.jsonl if that index is missing.
function conversationsForWorkspace(workspace) {
  const convos = loadConversationMeta();
  if (!convos) return conversationsFromHistory(workspace);
  const wsNorm = String(workspace).replace(/\/+$/, ""); // already a plain path — decoding it here would double-decode
  const model = configuredModel();
  const out = [];
  // Unindexed brain conversations history.jsonl can place in THIS workspace —
  // without this a backfilled chat shows in All chats but not its own project.
  const hist = historyWorkspaces();
  for (const { cid, stats } of orphanCids(convos)) {
    if (hist[cid] !== wsNorm) continue;
    const o = hydrateOrphan(cid, stats, hist, model);
    out.push({
      conversationId: o.conversationId, title: o.title, numSteps: o.numSteps,
      updatedAt: o.updatedAt, source: o.source, costUsd: o.costUsd, backfilled: true,
    });
  }
  for (const [cid, rec] of Object.entries(convos)) {
    const sm = rec && rec.summary;
    if (!sm || rec.is_internal) continue;
    const uris = Array.isArray(sm.WorkspaceURIs) ? sm.WorkspaceURIs.map(uriToPath) : [];
    if (!uris.includes(wsNorm)) continue;
    const cost = conversationCost(cid, model);
    out.push({
      conversationId: cid,
      title: cleanTitle(sm.Title) || cleanTitle(sm.Preview) || firstUserPrompt(cid) || null,
      numSteps: sm.NumSteps || 0,
      updatedAt: sm.UpdatedAt || null,
      source: sm.AppDataDir === "antigravity" ? "ide" : "cli",
      costUsd: cost ? cost.costUsd : null,
    });
  }
  out.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return out;
}

// Fallback when the metadata index is absent: derive from history.jsonl, titled by
// each transcript's first user prompt.
function conversationsFromHistory(workspace) {
  let lines;
  try { lines = fs.readFileSync(HISTORY, "utf8").split("\n"); } catch { return []; }
  const byCid = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.workspace !== workspace || !e.conversationId) continue;
    const ts = e.timestamp || 0;
    const c = byCid[e.conversationId] || { conversationId: e.conversationId, lastTs: 0, count: 0 };
    c.count++;
    if (ts >= c.lastTs) c.lastTs = ts;
    byCid[e.conversationId] = c;
  }
  return Object.values(byCid)
    .sort((a, b) => b.lastTs - a.lastTs)
    .map((c) => ({ conversationId: c.conversationId, title: firstUserPrompt(c.conversationId), numSteps: null, updatedAt: c.lastTs ? new Date(c.lastTs).toISOString() : null, source: "cli" }));
}

// Resolve the agy binary (the hub may run without ~/.local/bin on PATH).
function agyBin() {
  const cand = path.join(os.homedir(), ".local", "bin", "agy");
  try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch { return "agy"; }
}

// Send a message to a conversation by resuming it headlessly (agy --conversation
// <id> -p "<message>"). Refuses if that conversation is currently open in a live
// agy terminal (a second process on the same conversation would diverge). The run
// is fire-and-forget — the detail view's polling shows the new turn as it streams
// into the transcript.
async function sendMessage(conversationId, message, config) {
  if (!isSafeConversationId(conversationId)) return { ok: false, message: "invalid conversationId" };
  if (typeof message !== "string" || !message.trim()) return { ok: false, message: "message required" };
  if (message.length > 8000) return { ok: false, message: "message too long" };

  const sessions = await listAgySessions();
  if (sessions.some((s) => s.conversationId === conversationId)) {
    return { ok: false, message: "That conversation is open in a live agy terminal — close it there to send from here." };
  }

  const convos = loadConversationMeta() || {};
  // index first, history.jsonl second — a backfilled conversation has no summary,
  // and resuming it without --add-dir/cwd would run the agent workspace-less.
  const ws = conversationWorkspace(conversationId, convos);

  // Server-managed path: tracked child, captured output, real exit status,
  // per-conversation serialization (a busy conversation returns {busy:true}).
  if (config && config.runManager) {
    return config.runManager.send({ conversationId, workspace: ws, message });
  }

  try {
    // AGY_MONITOR_GATED routes this run's tool calls through the approval gate (see
    // agy-gate.js). The gate decides/denies within AGY_GATE_TIMEOUT_MS, which must be
    // under --print-timeout (so the run doesn't abort before the user can approve).
    const args = ["--conversation", conversationId, "-p", message + ASK_RULES, "--print-timeout", "12m"];
    // make the agent's workspace active (cwd alone isn't enough). existsSync-guarded:
    // history.jsonl records a workspace at prompt time and never reconciles it, so a
    // moved/deleted repo would otherwise hand agy a dead --add-dir.
    if (ws && fs.existsSync(ws)) args.push("--add-dir", ws);
    const child = spawn(agyBin(), args, {
      cwd: ws && fs.existsSync(ws) ? ws : undefined,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, AGY_MONITOR_GATED: "1", AGY_GATE_TIMEOUT_MS: String(8 * 60 * 1000) },
    });
    child.on("error", () => {}); // e.g. agy not found — don't crash the hub
    child.unref();
    recordUiRun(conversationId, { workspace: ws, project: ws ? path.basename(ws) : null, shortWorkspace: ws ? homeShort(ws) : null, kind: "send", message: message.slice(0, 200), pid: child.pid });
  } catch (e) {
    return { ok: false, message: "failed to start agy: " + (e && e.message ? e.message : e) };
  }
  return { ok: true, started: true };
}

// Pending tool approvals the gate is blocked on (one per conversation at a time).
function listApprovals() {
  let names;
  try { names = fs.readdirSync(APPROVALS_DIR); } catch { return { ok: true, approvals: [] }; }
  const approvals = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const a = readJsonSafe(path.join(APPROVALS_DIR, n), null);
    if (a && a.id) approvals.push(a);
  }
  approvals.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { ok: true, approvals };
}

// Track conversations launched/continued from the UI (headless agy -p), so the
// dashboard can show + manage them as "sessions" even after the print process exits.
function recordUiRun(conversationId, info) {
  if (!conversationId) return;
  try {
    fs.mkdirSync(UI_RUNS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UI_RUNS_DIR, conversationId + ".json"), JSON.stringify({ conversationId, ...info, startedAt: Date.now() }));
  } catch {}
}
function listUiRuns() {
  let files;
  try { files = fs.readdirSync(UI_RUNS_DIR).filter((f) => f.endsWith(".json")); }
  catch { return { ok: true, runs: [] }; }
  const convos = loadConversationMeta() || {};
  const model = configuredModel();
  const pending = new Set();
  try { for (const n of fs.readdirSync(APPROVALS_DIR)) if (n.endsWith(".json")) pending.add(n.replace(/\.json$/, "")); } catch {}
  const now = Date.now();
  const runs = [];
  for (const f of files) {
    const r = readJsonSafe(path.join(UI_RUNS_DIR, f), null);
    if (!r || !r.conversationId) continue;
    if (r.startedAt && now - r.startedAt > 7 * 864e5) { try { fs.unlinkSync(path.join(UI_RUNS_DIR, f)); } catch {} continue; } // GC > 7d
    // Managed runs (spawned by server.js) carry a real recorded outcome; legacy
    // fire-and-forget records fall back to pid-liveness + the 15-min heuristic.
    let status;
    if (r.status && r.status !== "running") {
      status = r.status; // done | error | stopped
    } else {
      let alive = false;
      if (r.pid) { try { process.kill(r.pid, 0); alive = true; } catch {} }
      if (alive && r.startedAt && now - r.startedAt > 15 * 60000) alive = false; // past print-timeout → treat as done
      status = alive ? "running" : "done"; // dead pid + no recorded outcome (legacy or orphaned by a server restart) → assume done
    }
    if (pending.has(r.conversationId)) status = "waiting";
    const sm = convos[r.conversationId] && convos[r.conversationId].summary;
    const cost = conversationCost(r.conversationId, model);
    runs.push({
      conversationId: r.conversationId, workspace: r.workspace || null, project: r.project || null, shortWorkspace: r.shortWorkspace || null,
      title: (sm && (cleanTitle(sm.Title) || cleanTitle(sm.Preview))) || null,
      message: r.message || null, kind: r.kind || "send", status, startedAt: r.startedAt || null,
      endedAt: r.endedAt || null, exitCode: r.exitCode != null ? r.exitCode : null,
      result: r.result || null, errorTail: status === "error" ? (r.errorTail || null) : null,
      numSteps: sm ? (sm.NumSteps || 0) : null, costUsd: cost ? cost.costUsd : null,
    });
  }
  runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return { ok: true, runs };
}
function dismissUiRun(conversationId) {
  if (!isSafeConversationId(conversationId)) return { ok: false, message: "invalid conversationId" };
  const fp = path.join(UI_RUNS_DIR, conversationId + ".json");
  const r = readJsonSafe(fp, null);
  if (r && r.pid) { // stop it if still running (kill the detached process group, fall back to the pid)
    try { process.kill(r.pid, 0); try { process.kill(-r.pid); } catch { process.kill(r.pid); } } catch {}
  }
  try { fs.unlinkSync(fp); } catch {}
  return { ok: true };
}

// Answer a pending approval — the gate polls for this and unblocks the command.
function answerApproval(conversationId, approvalId, decision) {
  if (!isSafeConversationId(conversationId)) return { ok: false, message: "invalid conversationId" };
  if (decision !== "allow" && decision !== "deny") return { ok: false, message: "decision must be allow or deny" };
  if (typeof approvalId !== "string" || !approvalId) return { ok: false, message: "approvalId required" };
  try {
    fs.mkdirSync(ANSWERS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ANSWERS_DIR, conversationId + ".json"),
      JSON.stringify({ id: approvalId, decision, ts: Math.floor(Date.now() / 1000) }));
  } catch (e) {
    return { ok: false, message: "failed to write answer: " + (e && e.message ? e.message : e) };
  }
  return { ok: true };
}

// Start a BRAND-NEW conversation in a workspace (agy -p "<message>" with no
// --conversation) and return the new conversationId once agy registers it. Gated
// like send-message, so its commands go through the approval flow.
// opts (all optional): model (an `agy models` name), mode ("auto-edit" →
// --mode accept-edits), gated (false disables the safety gate), reviewOnFinish
// (run the Opus review when the run completes — RunManager only).
async function newConversation(workspace, message, config, opts) {
  if (typeof workspace !== "string" || !workspace) return { ok: false, message: "workspace required" };
  if (typeof message !== "string" || !message.trim()) return { ok: false, message: "message required" };
  if (message.length > 24000) return { ok: false, message: "message too long" };
  let ws = workspace;
  try { ws = fs.realpathSync(workspace); } catch { return { ok: false, message: "workspace not found" }; }
  const o = opts || {};

  if (config && config.runManager) {
    return config.runManager.startNew({
      workspace: ws, message, agyDir: AGY_DIR,
      model: o.model, mode: o.mode, gated: o.gated, reviewOnFinish: o.reviewOnFinish,
    });
  }

  const cacheFile = path.join(AGY_DIR, "cache", "last_conversations.json");
  const before = (readJsonSafe(cacheFile, {})[ws]) || null;
  let pid = null;
  try {
    const args = ["-p", message + ASK_RULES, "--add-dir", ws, "--print-timeout", "12m"];
    if (typeof o.model === "string" && o.model) args.push("--model", o.model);
    if (o.mode === "auto-edit") args.push("--mode", "accept-edits");
    const env = { ...process.env, AGY_MONITOR_GATED: "1", AGY_GATE_TIMEOUT_MS: String(8 * 60 * 1000) };
    if (o.gated === false) delete env.AGY_MONITOR_GATED;
    const child = spawn(agyBin(), args, {
      cwd: ws, stdio: "ignore", detached: true,
      env,
    });
    child.on("error", () => {});
    child.unref();
    pid = child.pid;
  } catch (e) {
    return { ok: false, message: "failed to start agy: " + (e && e.message ? e.message : e) };
  }
  // agy writes the new conversation into the cache early in the run — poll for it.
  for (let i = 0; i < 75; i++) {
    const cur = readJsonSafe(cacheFile, {})[ws] || null;
    if (cur && cur !== before) {
      recordUiRun(cur, { workspace: ws, project: path.basename(ws), shortWorkspace: homeShort(ws), kind: "new", message: message.slice(0, 200), pid });
      return { ok: true, conversationId: cur, workspace: ws };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: true, conversationId: null, workspace: ws, message: "started — it'll appear in history shortly" };
}

// --- fork: agy has no native fork, so a fork = a NEW conversation seeded with
// a digest of the source transcript. (Copying the sqlite conversation was
// considered but its schema embeds ids we can't safely rewrite; the seeded
// fork is transcript-faithful and risk-free.) uptoTs forks "from this point".
const FORK_DIGEST_CAP = 9000;
function transcriptDigest(messages, uptoTs) {
  let msgs = messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.text);
  if (uptoTs != null) {
    const cut = typeof uptoTs === "number" ? uptoTs : Date.parse(uptoTs);
    if (!isNaN(cut)) {
      msgs = msgs.filter((m) => {
        const t = m.ts ? (typeof m.ts === "number" ? (m.ts > 1e12 ? m.ts : m.ts * 1000) : Date.parse(m.ts)) : NaN;
        return isNaN(t) || t <= cut;
      });
    }
  }
  const lines = msgs.map((m) => (m.role === "user" ? "USER: " : "AGENT: ") + m.text.replace(/\s+\n/g, "\n").slice(0, 2000));
  let digest = lines.join("\n\n");
  if (digest.length > FORK_DIGEST_CAP) {
    // keep the opening ask + the most recent turns
    const head = lines[0] || "";
    let tail = "";
    for (let i = lines.length - 1; i > 0 && tail.length < FORK_DIGEST_CAP - head.length - 60; i--) {
      tail = lines[i] + "\n\n" + tail;
    }
    digest = head + "\n\n[… earlier turns elided …]\n\n" + tail;
  }
  return digest;
}
async function forkConversation(conversationId, uptoTs, config) {
  const conv = getConversation(conversationId);
  if (!conv.ok) return conv;
  if (!conv.workspace) return { ok: false, message: "conversation has no workspace to fork into" };
  const digest = transcriptDigest(conv.messages, uptoTs);
  const message = "This conversation is a FORK of an earlier one — the copied context follows. " +
    "Read it, then continue from where it leaves off; nothing you do here affects the original.\n\n" +
    "=== COPIED CONTEXT ===\n" + digest + "\n=== END COPIED CONTEXT ===\n\n" +
    "Acknowledge the fork briefly and continue.";
  return newConversation(conv.workspace, message, config);
}
async function forkExternal(id, config) {
  let external;
  try { external = require("./agy-external"); } catch { return { ok: false, message: "external module not available" }; }
  const src = external.getExternal(id);
  if (!src.ok) return src;
  if (!src.workspace) return { ok: false, message: "that session has no recorded workspace — start a new chat and paste the context instead" };
  const digest = transcriptDigest(src.messages, null);
  const message = "This conversation TAKES OVER a session from another coding agent (" + src.agent + "). " +
    "The imported transcript follows; continue the work locally from here.\n\n" +
    "=== IMPORTED " + src.agent + " TRANSCRIPT ===\n" + digest + "\n=== END TRANSCRIPT ===\n\n" +
    "Acknowledge the takeover briefly and continue.";
  return newConversation(src.workspace, message, config);
}

// --- /btw: a one-shot side question ABOUT a conversation. The side model reads
// the transcript but never writes into it — the answer exists only in the UI.
async function btwAsk(conversationId, question, history) {
  if (typeof question !== "string" || !question.trim()) return { ok: false, message: "question required" };
  const conv = getConversation(conversationId);
  if (!conv.ok) return conv;
  let anthropic;
  try { anthropic = require("./agy-anthropic"); } catch { return { ok: false, message: "anthropic module not available" }; }
  const digest = transcriptDigest(conv.messages, null).slice(-24000);
  const messages = [
    { role: "user", content: "Read this transcript of a coding-agent conversation (context only — you are a SIDE channel; nothing you say enters it):\n\n" + digest },
    { role: "assistant", content: "Got it — I have the transcript and I'll answer side questions without touching that conversation." },
  ];
  for (const h of (Array.isArray(history) ? history : []).slice(-8)) {
    if (h && h.text) messages.push({ role: h.who === "side" ? "assistant" : "user", content: String(h.text).slice(0, 2000) });
  }
  messages.push({ role: "user", content: question.trim().slice(0, 4000) });
  const out = await anthropic.callAnthropic({
    max_tokens: 2000,
    system: "You are a concise side-channel assistant. The user is supervising a coding agent's conversation (transcript provided). Answer their side questions about it — the code, the approach, the agent's behavior — directly and briefly. You cannot run tools.",
    messages,
  });
  if (!out.ok) return out;
  return { ok: true, answer: anthropic.responseText(out.response), meta: anthropic.usageMeta(out.response, out.ms) };
}

// --- the models agy can run (`agy models`), cached — for the new-chat picker.
// NB: agy hangs if spawned with a piped stdin (it blocks reading it), so this
// must use spawn with stdin ignored — execFile's default stdio deadlocks.
let _modelsCache = null;
function listModels() {
  if (_modelsCache && Date.now() - _modelsCache.at < 600000) return _modelsCache.res;
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(agyBin(), ["models"], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "1" } });
    } catch { return resolve({ ok: true, models: [], current: configuredModel() }); }
    const done = () => {
      const models = out.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("Usage"));
      const res = { ok: true, models, current: configuredModel() };
      if (models.length) _modelsCache = { at: Date.now(), res };
      resolve(res);
    };
    const to = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done(); }, 10000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(to); done(); });
    child.on("exit", () => { clearTimeout(to); done(); });
  });
}

// All known workspaces for the new-chat picker, newest-first, excluding temp dirs.
const TEMP_WS_RE = /^\/(private\/)?(tmp|var\/folders)\//;
function listWorkspaces() {
  const byWs = {};
  const bump = (ws, ts) => {
    if (!ws || TEMP_WS_RE.test(ws)) return;
    const e = byWs[ws] || { workspace: ws, project: path.basename(ws), shortWorkspace: homeShort(ws), lastTs: 0 };
    if (ts > e.lastTs) e.lastTs = ts;
    byWs[ws] = e;
  };
  const convos = loadConversationMeta() || {};
  for (const r of Object.values(convos)) {
    const sm = r && r.summary;
    if (!sm) continue;
    const u = Array.isArray(sm.WorkspaceURIs) && sm.WorkspaceURIs[0] ? uriToPath(sm.WorkspaceURIs[0]) : null;
    bump(u, Date.parse(sm.UpdatedAt) || 0);
  }
  for (const ws of Object.keys(readJsonSafe(path.join(AGY_DIR, "cache", "last_conversations.json"), {}))) bump(ws, 0);
  const workspaces = Object.values(byWs).sort((a, b) => b.lastTs - a.lastTs).map(({ lastTs, ...w }) => w);
  return { ok: true, workspaces };
}

// --- backfill: conversations agy never wrote to its /resume index -------------
// agy only records some conversations in cache/conversation_metadata.json — a
// crashed run or an `agy -p` probe can leave a brain/<cid>/ transcript the index
// never learns about, and those chats were invisible to "all chats", to search,
// and to a project's own History tab. These helpers synthesize the same row
// shape from the transcript itself.
//
// Enumeration is split from hydration on purpose: enumerating is a cached
// transcript read, hydrating forks sqlite3 for the cost. Search greps first and
// hydrates only survivors, so a debounced keystroke doesn't fork N processes.

const ORPHAN_HYDRATE_MAX = 60; // same bound getCostSummary uses for its item list

// Steps, last activity and title for a conversation with no summary. agy's
// NumSteps is max(step_index)+1 (26 of 27 conversations that are both indexed
// and on disk agree; feabd972 is a known outlier where agy counted a step it
// never flushed). UpdatedAt is the newest row's created_at — the file mtime runs
// seconds to a minute late. The title comes from this same pass rather than a
// second firstUserPrompt() read. Cached by transcript mtime, like _summaryCache.
const _statsCache = new Map(); // transcriptPath -> { mtimeMs, val }
function transcriptStats(conversationId) {
  const tp = path.join(BRAIN_DIR, conversationId, ".system_generated", "logs", "transcript_full.jsonl");
  let st;
  try { st = fs.statSync(tp); } catch { return null; } // no transcript at all
  const hit = _statsCache.get(tp);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.val;
  let text;
  try { text = fs.readFileSync(tp, "utf8"); } catch { return null; }
  let maxStep = -1, lastTs = 0, userTurns = 0, title = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // truncated tail — skip
    if (typeof e.step_index === "number" && e.step_index > maxStep) maxStep = e.step_index;
    const ts = e.created_at ? Date.parse(e.created_at) : NaN;
    if (ts > lastTs) lastTs = ts;
    if (e.type !== "USER_INPUT") continue;
    userTurns++;
    if (!title && typeof e.content === "string") {
      const t = stripUserRequest(e.content);
      if (t) title = t.replace(/\s+/g, " ").slice(0, 100); // same shape firstUserPrompt returns
    }
  }
  const best = lastTs > 9.4e11 ? lastTs : (st.mtimeMs > 9.4e11 ? st.mtimeMs : 0); // same pre-2000 guard as allHistory
  const val = { numSteps: maxStep + 1, userTurns, title, mtimeMs: st.mtimeMs, updatedAt: best ? new Date(best).toISOString() : null };
  _statsCache.set(tp, { mtimeMs: st.mtimeMs, val });
  return val;
}

// cid → workspace from agy's prompt log. The only on-disk source that ties an
// unindexed conversation to a directory — and it only covers interactive runs
// (`agy -p` print runs never write a history line), so plenty of backfilled
// conversations legitimately resolve to null. history.jsonl stores a raw path,
// never a file:// URI, so it is NOT run through uriToPath — decoding it would
// corrupt a directory whose name legitimately contains a '%'. Cached by mtime.
let _histWs = { mtimeMs: -1, map: {} };
function historyWorkspaces() {
  let st;
  try { st = fs.statSync(HISTORY); } catch { return {}; }
  if (st.mtimeMs === _histWs.mtimeMs) return _histWs.map;
  let lines;
  try { lines = fs.readFileSync(HISTORY, "utf8").split("\n"); } catch { return {}; }
  const map = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.conversationId && e.workspace) map[e.conversationId] = String(e.workspace).replace(/\/+$/, ""); // last line wins
  }
  _histWs = { mtimeMs: st.mtimeMs, map };
  return map;
}

// Cheap enumeration: every brain/ conversation the /resume index is missing, as
// { cid, stats }. No sqlite3, no second file read — safe to call per keystroke.
function orphanCids(convos) {
  let dirs;
  try { dirs = fs.readdirSync(BRAIN_DIR); } catch { return []; }
  const out = [];
  for (const cid of dirs) {
    if (!isSafeConversationId(cid)) continue;     // keeps junk out of every path.join below
    if (convos && convos[cid]) continue;          // the indexed loop already emitted it
    const stats = transcriptStats(cid);
    if (!stats) continue;                         // no transcript → getConversation can't open it either
    if (!stats.userTurns) continue;               // nothing the user said = nothing worth listing.
                                                  // NOT an is_internal proxy: the one is_internal record
                                                  // on disk HAS a user turn, and no brain conversation has zero.
    if (!stats.title && !stats.numSteps) continue; // same empty-placeholder skip as allHistory
    out.push({ cid, stats });
  }
  return out;
}

// The expensive half: price the conversation and place it in a workspace.
function hydrateOrphan(cid, stats, hist, model) {
  // NOTE: temp workspaces are deliberately NOT filtered here — TEMP_WS_RE exists
  // to keep dead dirs out of the new-chat picker; a history list is a record.
  const ws = hist[cid] || null;
  const cost = conversationCost(cid, model);
  return {
    conversationId: cid,
    title: stats.title,
    project: ws ? path.basename(ws) : null, workspace: ws, shortWorkspace: ws ? homeShort(ws) : null,
    numSteps: stats.numSteps, updatedAt: stats.updatedAt,
    source: "cli", // a dir under antigravity-cli/brain is by definition a CLI run
    costUsd: cost ? cost.costUsd : null,
    backfilled: true, // → UI chip: this conversation is not in agy's /resume index
  };
}

// Every unindexed brain conversation, fully hydrated, in allHistory()'s row shape.
// Bounded: a missing/corrupt index makes EVERY brain dir an orphan, so hydrate
// only the most recently active ORPHAN_HYDRATE_MAX of them.
function orphanConversations(convos, model) {
  const found = orphanCids(convos);
  if (found.length > ORPHAN_HYDRATE_MAX) {
    found.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
    found.length = ORPHAN_HYDRATE_MAX;
  }
  const hist = historyWorkspaces();
  return found.map(({ cid, stats }) => hydrateOrphan(cid, stats, hist, model));
}

// A conversation's workspace: the /resume index first, else history.jsonl. Shared
// by getConversation and sendMessage so a backfilled chat opens with its DIFF
// panel and a reply to it gets the right --add-dir/cwd instead of running
// workspace-less.
function conversationWorkspace(conversationId, convos) {
  const sm = convos && convos[conversationId] && convos[conversationId].summary;
  if (sm && Array.isArray(sm.WorkspaceURIs) && sm.WorkspaceURIs[0]) return uriToPath(sm.WorkspaceURIs[0]);
  return historyWorkspaces()[conversationId] || null;
}

// Every conversation across ALL workspaces (the dashboard's "all chats" browser),
// newest first — so you can reach history for projects with no running session.
function allHistory() {
  const convos = loadConversationMeta(); // null ⇒ index missing/corrupt — the backfill still finds everything
  const model = configuredModel();
  const out = [];
  for (const [cid, rec] of Object.entries(convos || {})) {
    const sm = rec && rec.summary;
    if (!sm || rec.is_internal) continue;
    const title = cleanTitle(sm.Title) || cleanTitle(sm.Preview) || firstUserPrompt(cid) || null;
    if (!title && (sm.NumSteps || 0) === 0) continue; // skip empty placeholder conversations
    const u = Array.isArray(sm.WorkspaceURIs) && sm.WorkspaceURIs[0] ? uriToPath(sm.WorkspaceURIs[0]) : null;
    const ts = Date.parse(sm.UpdatedAt);
    const cost = conversationCost(cid, model);
    out.push({
      conversationId: cid,
      title,
      project: u ? path.basename(u) : null, workspace: u, shortWorkspace: u ? homeShort(u) : null,
      numSteps: sm.NumSteps || 0, updatedAt: ts > 9.4e11 ? sm.UpdatedAt : null, // ignore bogus pre-2000 stamps
      source: sm.AppDataDir === "antigravity" ? "ide" : "cli",
      costUsd: cost ? cost.costUsd : null,
    });
  }
  for (const c of orphanConversations(convos, model)) out.push(c); // brain/ dirs the index never learned about
  out.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return { ok: true, conversations: out };
}

// Full-text search INSIDE conversations: scan each transcript for the query and
// return matches with a snippet. Heavier than the title filter, so the UI calls it
// debounced and shows the results as a secondary "found inside conversations" section.
function snippetAround(text, idx, qlen) {
  const start = Math.max(0, idx - 48), end = Math.min(text.length, idx + qlen + 72);
  const s = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + s + (end < text.length ? "…" : "");
}
// First place the query appears in a parsed transcript, as a display snippet.
function snippetFor(transcriptPath, q) {
  try {
    for (const m of parseTranscript(transcriptPath)) {
      const hay = [m.text, m.thinking, m.output, m.stdout].filter(Boolean).join("  ");
      const idx = hay.toLowerCase().indexOf(q);
      if (idx >= 0) return snippetAround(hay, idx, q.length);
    }
  } catch {}
  return null;
}
function searchConversations(query) {
  const q = (query || "").trim().toLowerCase();
  if (q.length < 2) return { ok: true, matches: [] };
  const convos = loadConversationMeta() || {};
  const model = configuredModel();
  const matches = [];
  for (const [cid, rec] of Object.entries(convos)) {
    const sm = rec && rec.summary;
    if (!sm || rec.is_internal) continue;
    const tp = path.join(BRAIN_DIR, cid, ".system_generated", "logs", "transcript_full.jsonl");
    let raw;
    try { raw = fs.readFileSync(tp, "utf8"); } catch { continue; }
    if (!raw.toLowerCase().includes(q)) continue; // fast reject before parsing
    const snippet = snippetFor(tp, q);
    const u = Array.isArray(sm.WorkspaceURIs) && sm.WorkspaceURIs[0] ? uriToPath(sm.WorkspaceURIs[0]) : null;
    const ts = Date.parse(sm.UpdatedAt);
    const cost = conversationCost(cid, model);
    matches.push({
      conversationId: cid,
      title: cleanTitle(sm.Title) || cleanTitle(sm.Preview) || firstUserPrompt(cid) || null,
      project: u ? path.basename(u) : null, workspace: u, shortWorkspace: u ? homeShort(u) : null,
      numSteps: sm.NumSteps || 0, updatedAt: ts > 9.4e11 ? sm.UpdatedAt : null,
      source: sm.AppDataDir === "antigravity" ? "ide" : "cli",
      costUsd: cost ? cost.costUsd : null, snippet,
    });
  }
  // Same backfill as allHistory — an unindexed conversation's transcript is right
  // there in brain/, only the enumeration was index-gated. Grep BEFORE hydrating:
  // hydration forks sqlite3, and this runs on every debounced keystroke.
  const hist = historyWorkspaces();
  for (const { cid, stats } of orphanCids(convos)) {
    const tp = path.join(BRAIN_DIR, cid, ".system_generated", "logs", "transcript_full.jsonl");
    let raw;
    try { raw = fs.readFileSync(tp, "utf8"); } catch { continue; }
    if (!raw.toLowerCase().includes(q)) continue;
    matches.push({ ...hydrateOrphan(cid, stats, hist, model), snippet: snippetFor(tp, q) });
  }
  matches.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return { ok: true, matches };
}

// --- workspace diff (the right-hand DIFF/TURN panel) --------------------------
// One `git diff HEAD` + `git status --porcelain` parse. Untracked files render
// as all-adds. Workspace must live under home (same rule as getFile).

const DIFF_MAX_BYTES = 400 * 1024;   // git diff output cap
const DIFF_MAX_FILE_LINES = 800;     // per-file rendered-line cap
const UNTRACKED_MAX_BYTES = 64 * 1024;

// Workspaces must live under home; AGY_MONITOR_EXTRA_ROOTS (colon-separated
// prefixes) widens that for tests, which build fixture workspaces in tmpdir.
function insideHome(p) {
  if (typeof p !== "string") return false;
  const roots = [os.homedir()].concat((process.env.AGY_MONITOR_EXTRA_ROOTS || "").split(":").filter(Boolean));
  return roots.some((r) => p === r || p.startsWith(r + path.sep));
}

function parseUnifiedDiff(text) {
  // → { "path": { hunks: [{header, lines: [[mark, text]]}] } }
  const files = {};
  let cur = null, hunk = null, lineBudget = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) { cur = null; hunk = null; continue; }
    const plus = line.match(/^\+\+\+ b\/(.*)$/);
    if (plus) { cur = files[plus[1]] = { hunks: [] }; hunk = null; lineBudget = DIFF_MAX_FILE_LINES; continue; }
    if (line.startsWith("--- ")) continue;
    if (!cur) continue;
    const hh = line.match(/^@@[^@]*@@.*$/);
    if (hh) { hunk = { header: line, lines: [] }; cur.hunks.push(hunk); continue; }
    if (!hunk || lineBudget <= 0) continue;
    if (line.startsWith("+")) hunk.lines.push(["+", line.slice(1)]);
    else if (line.startsWith("-")) hunk.lines.push(["-", line.slice(1)]);
    else if (line.startsWith(" ") || line === "") hunk.lines.push([" ", line.slice(1)]);
    else continue; // "\ No newline at end of file" etc.
    if (--lineBudget === 0) hunk.lines.push([" ", "… (diff truncated)"]);
  }
  return files;
}

async function workspaceDiff(workspace) {
  if (typeof workspace !== "string" || !workspace) return { ok: false, message: "workspace required" };
  let ws = workspace;
  try { ws = fs.realpathSync(workspace); } catch { return { ok: false, message: "workspace not found" }; }
  if (!insideHome(ws)) return { ok: false, message: "outside home directory" };

  const git = (args) => execFileP("git", ["-C", ws].concat(args), { maxBuffer: 16 * 1024 * 1024 });
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!branch) return { ok: true, workspace: ws, git: false, branch: null, files: [] }; // not a git repo

  const status = await git(["status", "--porcelain"]);
  const numstat = await git(["diff", "HEAD", "--numstat"]);
  let diffText = await git(["diff", "HEAD", "--no-color", "-U3"]);
  if (diffText.length > DIFF_MAX_BYTES) diffText = diffText.slice(0, DIFF_MAX_BYTES);
  const parsed = parseUnifiedDiff(diffText);

  const stats = {}; // path → {add, del}
  for (const line of numstat.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (m) stats[m[3]] = { add: m[1] === "-" ? 0 : parseInt(m[1], 10), del: m[2] === "-" ? 0 : parseInt(m[2], 10) };
  }

  const files = [];
  const seen = new Set();
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const st = line.slice(0, 2), rel = line.slice(3).replace(/^"|"$/g, "");
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (st === "??") {
      // untracked → all-adds hunk from the file head
      let content = null, lines = [];
      try {
        const fp = path.join(ws, rel);
        const s2 = fs.statSync(fp);
        if (s2.isFile() && s2.size <= UNTRACKED_MAX_BYTES) content = fs.readFileSync(fp, "utf8");
        else if (s2.isDirectory()) continue;
      } catch {}
      if (content != null && !content.includes("\0")) {
        lines = content.replace(/\n$/, "").split("\n").slice(0, DIFF_MAX_FILE_LINES).map((l) => ["+", l]);
      } else lines = [["+", "(binary or large file)"]];
      files.push({ path: rel, st: "A", add: lines.length, del: 0, hunks: [{ header: "@@ new file @@", lines }] });
      continue;
    }
    const letter = /D/.test(st) ? "D" : /A/.test(st) ? "A" : "M";
    const p = parsed[rel] || null;
    const ns = stats[rel] || { add: 0, del: 0 };
    files.push({ path: rel, st: letter, add: ns.add, del: ns.del, hunks: p ? p.hunks : [] });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ok: true, workspace: ws, git: true, branch, files };
}

// --- composer metadata: slash commands + workspace files ----------------------
// Built-in agy slash commands pass straight through `agy -p "/cmd"`; monitor
// commands are handled by the UI itself and grow as features land. MCP tools +
// skills come from the mcp module's cache (never blocks on probes here).
const AGY_BUILTINS = [
  { name: "clear", desc: "Clear the conversation context", src: "agy" },
  { name: "compact", desc: "Compact context — keep decisions, drop noise", src: "agy" },
  { name: "hooks", desc: "Show configured lifecycle hooks", src: "agy" },
  { name: "tokens", desc: "Show token usage for this conversation", src: "agy" },
  { name: "memory", desc: "Show injected user memories", src: "agy" },
];
function listCommands(workspace) {
  const commands = AGY_BUILTINS.slice();
  try {
    const mcp = require("./agy-mcp").cachedMcp(workspace);
    for (const sk of mcp.skills) {
      commands.push({ name: "skill " + sk.name, desc: sk.description || "Run the " + sk.name + " skill", src: "skill" });
    }
    for (const sv of mcp.servers) {
      for (const t of sv.tools.slice(0, 12)) {
        commands.push({ name: "mcp " + sv.name + " " + t.name, desc: t.description || sv.name + " tool", src: "mcp" });
      }
    }
  } catch {}
  return { ok: true, commands };
}

async function listFiles(workspace, q) {
  if (typeof workspace !== "string" || !workspace) return { ok: false, message: "workspace required" };
  let ws = workspace;
  try { ws = fs.realpathSync(workspace); } catch { return { ok: false, message: "workspace not found" }; }
  if (!insideHome(ws)) return { ok: false, message: "outside home directory" };
  const git = (args) => execFileP("git", ["-C", ws].concat(args), { maxBuffer: 8 * 1024 * 1024 });
  const changedRaw = await git(["status", "--porcelain"]);
  const changed = [];
  for (const line of changedRaw.split("\n")) {
    if (line.trim()) changed.push(line.slice(3).replace(/^"|"$/g, ""));
  }
  const tracked = (await git(["ls-files"])).split("\n").filter(Boolean);
  const seen = new Set();
  const all = changed.concat(tracked).filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  const needle = (q || "").toLowerCase();
  const files = (needle ? all.filter((p) => p.toLowerCase().includes(needle)) : all).slice(0, 400);
  return { ok: true, workspace: ws, files };
}

// --- composer attachments -----------------------------------------------------
// Pasted/picked files are saved under MON_ROOT/attachments/<cid or "new">/ and
// referenced by absolute path in the sent message, so agy reads them with its
// own file tools. Names are sanitized; content arrives base64 (body cap is
// raised in server.js accordingly).
const ATTACH_DIR = path.join(MON_ROOT, "attachments");
const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
function saveAttachment(conversationId, name, dataBase64) {
  const cid = isSafeConversationId(conversationId) ? conversationId : "new";
  if (typeof name !== "string" || !name) return { ok: false, message: "name required" };
  if (typeof dataBase64 !== "string" || !dataBase64) return { ok: false, message: "data required" };
  let buf;
  try { buf = Buffer.from(dataBase64, "base64"); } catch { return { ok: false, message: "bad base64" }; }
  if (!buf.length) return { ok: false, message: "empty file" };
  if (buf.length > ATTACH_MAX_BYTES) return { ok: false, message: "attachment too large (8 MB cap)" };
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
  const dir = path.join(ATTACH_DIR, cid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let fp = path.join(dir, safe);
    if (fs.existsSync(fp)) fp = path.join(dir, Date.now() + "-" + safe);
    fs.writeFileSync(fp, buf);
    return { ok: true, path: fp, name: safe, size: buf.length };
  } catch (e) {
    return { ok: false, message: "failed to save: " + (e && e.message ? e.message : e) };
  }
}

// Context files agy loads into its prompt (global + project GEMINI.md / AGENTS.md).
function getContext(workspace) {
  if (typeof workspace !== "string" || !workspace) return { ok: false, message: "workspace required" };
  const contextFiles = [readContextFile(GEMINI_GLOBAL, "global")];
  if (workspace === os.homedir() || workspace.startsWith(os.homedir() + path.sep)) {
    contextFiles.push(readContextFile(path.join(workspace, "GEMINI.md"), "project"));
    contextFiles.push(readContextFile(path.join(workspace, "AGENTS.md"), "project"));
  }
  return { ok: true, workspace, project: path.basename(workspace), shortWorkspace: homeShort(workspace), contextFiles };
}

// Every conversation agy has had in this workspace.
function getHistory(workspace) {
  if (typeof workspace !== "string" || !workspace) return { ok: false, message: "workspace required" };
  return { ok: true, workspace, project: path.basename(workspace), shortWorkspace: homeShort(workspace), conversations: conversationsForWorkspace(workspace) };
}

// ---- Tier 3: live state from hook-written status files ----------------------

function deriveState(event, payload) {
  const p = payload || {};
  switch (event) {
    case "PreToolUse": {
      const tool = p.toolCall && p.toolCall.name;
      return { state: "busy", detail: tool ? `running ${tool}` : "running a tool", tool: tool || null };
    }
    case "PostToolUse":
      return { state: "busy", detail: "working", tool: (p.toolCall && p.toolCall.name) || null };
    case "PreInvocation":
      return { state: "busy", detail: "thinking", tool: null };
    case "PostInvocation":
      return { state: "busy", detail: "working", tool: null };
    case "Stop":
      return p.fullyIdle === false
        ? { state: "busy", detail: "working", tool: null }
        : { state: "idle", detail: "your turn", tool: null, terminationReason: p.terminationReason || null };
    case "Notification":
      return { state: "waiting", detail: "needs attention", tool: null };
    default:
      return { state: "running", detail: null, tool: null };
  }
}

// Apply the staleness rule to a live hook entry → display {state, stateDetail, tool}.
// A "busy" whose last event is older than BUSY_STALE_MS usually means its Stop was
// missed/overwritten, so we downgrade to idle ("your turn"). The EXCEPTION is a
// dangling PreToolUse (a tool that never got its PostToolUse): that isn't a missed
// Stop — agy is parked AT the tool. Without --dangerously-skip-permissions that means
// it's blocked on the terminal's approval prompt (needs you); with skip-perms the tool
// is just running long. Either way the turn has NOT ended, so never call it "your turn".
// `now` is injectable for tests.
function displayLiveState(live, skipPerms, now) {
  if (!live) return { state: "running", stateDetail: null, tool: null };
  let state = live.state, stateDetail = live.detail, tool = live.tool || null;
  const nowMs = now == null ? Date.now() : now;
  if (state === "busy" && nowMs - live.ts * 1000 > BUSY_STALE_MS) {
    if (live.event === "PreToolUse" && live.tool) {
      if (skipPerms) stateDetail = `still running ${live.tool}`;
      else { state = "waiting"; stateDetail = `awaiting approval: ${live.tool}`; }
    } else {
      state = "idle"; stateDetail = "your turn"; tool = null;
    }
  }
  return { state, stateDetail, tool };
}

// Hook status files (GC'ing stale ones), indexed by conversationId (primary) and
// by workspace (fallback). The timestamp gate (below) decides whether a status
// actually belongs to a given process.
function readStatuses() {
  let names;
  try { names = fs.readdirSync(STATUS_DIR); } catch { return { byConv: {}, byWorkspace: {} }; }
  const now = Date.now();
  const byConv = {}, byWorkspace = {};
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(STATUS_DIR, name);
    const rec = readJsonSafe(file, null);
    if (!rec) continue;
    if (now - (rec.ts ? rec.ts * 1000 : 0) > STATUS_STALE_HOURS * 3600 * 1000) {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    const ws = rec.payload && Array.isArray(rec.payload.workspacePaths) ? rec.payload.workspacePaths[0] : null;
    const entry = {
      conversationId: rec.conversationId,
      workspace: ws,
      ts: rec.ts,
      transcriptPath: rec.payload && rec.payload.transcriptPath,
      ...deriveState(rec.event, rec.payload),
      event: rec.event,
    };
    if (rec.conversationId && rec.conversationId !== "unknown") byConv[rec.conversationId] = entry;
    if (ws && (!byWorkspace[ws] || (entry.ts || 0) >= (byWorkspace[ws].ts || 0))) byWorkspace[ws] = entry;
  }
  return { byConv, byWorkspace };
}

// ---- core: enumerate running agy sessions ----------------------------------

async function listAgySessions() {
  // ps discovery sees REAL agy processes on the whole machine — tests set this
  // so a developer's live session can't leak into their fixture world.
  if (process.env.AGY_MONITOR_NO_PS === "1") return [];
  const out = await execFileP("ps", ["-Ao", "pid=,ppid=,state=,etime=,args="]);
  const candidates = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, state, etime, args] = m;
    if (state.startsWith("Z")) continue; // skip zombies
    if (path.basename(args.split(/\s+/)[0]) !== "agy") continue;
    candidates.push({ pid: Number(pid), ppid: Number(ppid), etime, args });
  }

  const model = configuredModel();
  const { byConv, byWorkspace } = readStatuses();
  const convoMeta = loadConversationMeta() || {};
  const seenMap = readSeen();

  const sessions = await Promise.all(
    candidates.map(async (c) => {
      // One lsof: the cwd (workspace) plus any open brain/<conversationId> dirs.
      // The active conversation is the one the process actually has open — reliable
      // even when the hook isn't firing and regardless of the (lagging) cache.
      const fn = await execFileP("lsof", ["-nP", "-p", String(c.pid), "-Ffn"]);
      let workspace = "", curFd = "";
      const brainCids = new Set();
      for (const l of fn.split("\n")) {
        if (l[0] === "f") curFd = l.slice(1);
        else if (l[0] === "n") {
          const name = l.slice(1);
          if (curFd === "cwd" && !workspace) workspace = name;
          const m = name.match(/\/brain\/([0-9a-fA-F][0-9a-fA-F-]{34,})(?:\/|$)/);
          if (m) brainCids.add(m[1]);
        }
      }
      // pick the open brain dir with the most-recently-written transcript.
      let conversationId = null, bestMt = -1;
      for (const cid of brainCids) {
        let mt = -1;
        try { mt = fs.statSync(path.join(BRAIN_DIR, cid, ".system_generated", "logs", "transcript_full.jsonl")).mtimeMs; } catch {}
        if (mt > bestMt) { bestMt = mt; conversationId = cid; }
      }

      const { mode, prompt: argPrompt, sandbox, skipPerms } = classifyArgs(c.args.split(/\s+/).slice(1));
      const elapsedSeconds = etimeToSeconds(c.etime);
      const startMs = elapsedSeconds != null ? Date.now() - elapsedSeconds * 1000 : null;

      // Live hook state for this conversation (gated to this process's lifetime).
      let cand = conversationId ? byConv[conversationId] : null;
      if (!cand && workspace) cand = byWorkspace[workspace];
      const live = cand && startMs != null && cand.ts * 1000 >= startMs - ATTACH_SLACK_MS ? cand : null;
      if (!conversationId && live) conversationId = live.conversationId; // hook fallback

      // prompt: explicit argv prompt (print/-i) wins; else the conversation's own transcript.
      let prompt = argPrompt, promptSource = argPrompt ? "args" : null;
      if (!prompt && conversationId) {
        const t = promptFromTranscript(path.join(BRAIN_DIR, conversationId, ".system_generated", "logs", "transcript_full.jsonl"));
        if (t) { prompt = t; promptSource = "transcript"; }
      }

      // Display state, applying the staleness rule (see displayLiveState).
      let { state, stateDetail, tool } = displayLiveState(live, skipPerms);

      const summary = conversationId ? sessionSummary(conversationId) : null;
      // a turn that ended on an unanswered ```ask is waiting on the human
      if (summary && summary.endsWithAsk && state !== "busy") {
        state = "waiting"; stateDetail = "question waiting"; tool = null;
      }
      const cost = conversationId ? conversationCost(conversationId, model) : null;
      // unread = turns since the UI last had this conversation open; a cid the
      // UI has never opened shows 0 (first open sets the cursor).
      const msgCount = summary ? summary.msgCount : null;
      const seenCount = conversationId != null ? seenMap[conversationId] : null;
      const unread = msgCount != null && seenCount != null ? Math.max(0, msgCount - seenCount) : 0;

      return {
        pid: c.pid,
        ppid: c.ppid,
        workspace,
        shortWorkspace: homeShort(workspace),
        project: workspace ? path.basename(workspace) : null,
        mode,
        sandbox,
        skipPerms,
        model,
        conversationId: conversationId || null,
        title: conversationId ? titleFromMeta(convoMeta, conversationId) : null,
        prompt: prompt ? String(prompt).slice(0, 280) : null,
        lastReply: summary ? summary.lastReply : null,
        files: summary ? summary.files : [],
        hasEarlier: summary ? summary.hasEarlier : false,
        costUsd: cost ? cost.costUsd : null,
        tokens: cost ? cost.tokens : null,
        msgCount,
        unread,
        promptSource,
        state,
        stateDetail,
        tool,
        terminationReason: live ? live.terminationReason || null : null,
        stateSince: live && live.ts ? new Date(live.ts * 1000).toISOString() : null,
        hooked: !!live,
        elapsedSeconds,
        elapsed: humanDuration(elapsedSeconds),
        startedAt: startMs != null ? new Date(startMs).toISOString() : null,
        lastActivity: live && live.ts ? new Date(live.ts * 1000).toISOString() : null,
      };
    })
  );

  sessions.sort((a, b) => {
    const so = (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9);
    if (so !== 0) return so;
    return (a.elapsedSeconds || 0) - (b.elapsedSeconds || 0);
  });
  return sessions;
}

// ---- the hub tool object ---------------------------------------------------

const agyMonitor = {
  id: "agy-monitor",
  meta(/* config */) {
    return {
      id: "agy-monitor",
      title: "Agy Sessions",
      description: "Monitor running Antigravity CLI sessions.",
      category: "Monitoring",
      ui: "agy-monitor",
      card: "summary",
    };
  },
  async run(input, config) {
    const action = input && input.action;
    if (action === "fetch-sessions") {
      return { ok: true, data: await listAgySessions() };
    }
    if (action === "get-conversation") {
      return getConversation(input && input.conversationId);
    }
    if (action === "get-file") {
      return getFile(input && input.path);
    }
    if (action === "get-context") {
      return getContext(input && input.workspace);
    }
    if (action === "get-history") {
      return getHistory(input && input.workspace);
    }
    if (action === "send-message") {
      return sendMessage(input && input.conversationId, input && input.message, config);
    }
    if (action === "cost-summary") {
      return getCostSummary(input && typeof input.days === "number" ? input.days : null);
    }
    if (action === "mark-seen") {
      return markSeen(input && input.conversationId, input && input.count);
    }
    if (action === "workspace-diff") {
      return workspaceDiff(input && input.workspace);
    }
    if (action === "list-commands") {
      return listCommands(input && input.workspace);
    }
    if (action === "list-mcp") {
      let mcp;
      try { mcp = require("./agy-mcp"); } catch { return { ok: false, message: "mcp module not available" }; }
      return mcp.listMcp(input && input.workspace);
    }
    // ---- one-shot Opus review (agy-review.js)
    if (action === "run-review" || action === "get-review" || action === "dismiss-finding") {
      let review;
      try { review = require("./agy-review"); } catch { return { ok: false, message: "review module not available" }; }
      if (action === "run-review") return review.runReview({ workspace: input && input.workspace, task: input && input.task });
      if (action === "get-review") return review.getReview(input && input.workspace);
      return review.dismissFinding(input && input.workspace, input && input.index);
    }
    // ---- fan-out: N workers in isolated worktrees + Opus judge (agy-fanout.js)
    if (action === "fanout-start" || action === "list-fanouts" || action === "get-fanout" ||
        action === "fanout-apply" || action === "fanout-merge-all" || action === "fanout-discard") {
      let fanout;
      try { fanout = require("./agy-fanout"); } catch { return { ok: false, message: "fanout module not available" }; }
      if (action === "fanout-start") return fanout.start({ workspace: input && input.workspace, task: input && input.task, strategy: input && input.strategy, n: input && input.n }, config);
      if (action === "list-fanouts") return fanout.list();
      if (action === "get-fanout") return fanout.get(input && input.id);
      if (action === "fanout-apply") return fanout.apply(input && input.id, input && input.label);
      if (action === "fanout-merge-all") return fanout.mergeAll(input && input.id);
      return fanout.discard(input && input.id);
    }
    if (action === "list-files") {
      return listFiles(input && input.workspace, input && input.q);
    }
    if (action === "upload-attachment") {
      return saveAttachment(input && input.conversationId, input && input.name, input && input.data);
    }
    if (action === "list-approvals") {
      return listApprovals();
    }
    if (action === "answer-approval") {
      return answerApproval(input && input.conversationId, input && input.approvalId, input && input.decision);
    }
    if (action === "new-conversation") {
      return newConversation(input && input.workspace, input && input.message, config, {
        model: input && input.model,
        mode: input && input.mode,
        gated: input && input.gated,
        reviewOnFinish: input && input.reviewOnFinish,
      });
    }
    if (action === "fork-conversation") {
      return forkConversation(input && input.conversationId, input && input.uptoTs, config);
    }
    if (action === "fork-external") {
      return forkExternal(input && input.id, config);
    }
    if (action === "btw") {
      return btwAsk(input && input.conversationId, input && input.question, input && input.history);
    }
    if (action === "list-models") {
      return listModels();
    }
    // ---- other local coding agents, read-only (agy-external.js)
    if (action === "list-external" || action === "get-external") {
      let external;
      try { external = require("./agy-external"); } catch { return { ok: false, message: "external module not available" }; }
      if (action === "list-external") return external.listExternal();
      return external.getExternal(input && input.id);
    }
    if (action === "list-workspaces") {
      return listWorkspaces();
    }
    if (action === "list-all-conversations") {
      return allHistory();
    }
    if (action === "search-conversations") {
      return searchConversations(input && input.query);
    }
    if (action === "list-ui-runs") {
      return listUiRuns();
    }
    if (action === "dismiss-ui-run") {
      return dismissUiRun(input && input.conversationId);
    }
    if (action === "stop-ui-run") {
      if (!isSafeConversationId(input && input.conversationId)) return { ok: false, message: "invalid conversationId" };
      if (config && config.runManager) return config.runManager.stop(input.conversationId);
      return dismissUiRun(input.conversationId); // legacy host: best-effort group kill
    }
    // ---- safety-gate learning loop (agy-promoter.js; decisions logged by agy-gate.js)
    if (action === "list-decisions" || action === "list-safelist-candidates" ||
        action === "list-safelist-rules" || action === "demote-safelist-rule" ||
        action === "promote-safelist-rule" || action === "snooze-safelist-rule" ||
        action === "reject-safelist-rule") {
      let promoter;
      try { promoter = require("./agy-promoter"); } catch { return { ok: false, message: "promoter module not available" }; }
      if (action === "list-decisions") return promoter.listDecisions(input && input.days);
      if (action === "list-safelist-candidates") return promoter.listCandidates();
      if (action === "list-safelist-rules") return promoter.listRules();
      if (action === "demote-safelist-rule") return promoter.demoteRule(input && input.rule);
      if (action === "promote-safelist-rule") return promoter.promoteRule(input && input.atom);
      if (action === "snooze-safelist-rule") return promoter.snoozeRule(input && input.atom);
      if (action === "reject-safelist-rule") return promoter.rejectRule(input && input.atom);
    }
    // ---- environment doctor / onboarding (agy-doctor.js)
    if (action === "setup-status" || action === "install-hook") {
      let doctor;
      try { doctor = require("./agy-doctor"); } catch { return { ok: false, message: "doctor module not available" }; }
      if (action === "setup-status") return doctor.setupStatus();
      return doctor.installHook();
    }
    return { ok: false, message: "Unknown action" };
  },
};

module.exports = { agyMonitor, listAgySessions, deriveState, displayLiveState, BUSY_STALE_MS };

if (require.main === module) {
  agyMonitor.run({ action: "fetch-sessions" }).then((res) => {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n"); // clean JSON on stdout
    process.stderr.write(`[${res.data ? res.data.length : 0} running agy session(s)]\n`);
  });
}
