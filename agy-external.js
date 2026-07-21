"use strict";
/*
 * agy-external — read-only transcripts from OTHER local coding agents.
 *
 *   CODEX   — ~/.codex/sessions/**\/rollout-*.jsonl
 *             2026 format: {type:"session_meta"|"response_item"|"event_msg", payload:{...}}
 *             2025 format: flat {type:"message", role, content:[...]} lines
 *   COPILOT — VS Code chat: ~/Library/Application Support/Code/User/
 *             workspaceStorage/<hash>/chatSessions/*.json  ({requests:[...]})
 *   CLAUDE  — Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *             one JSON object per line; see parseClaudeLines for the shapes.
 *
 * These are surfaced read-only: the monitor never writes to any of the three
 * tools' files. IDs are "cdx."/"cop."/"cc." + base64url(absolute path), and reads
 * validate the decoded path is still inside the expected root (no traversal).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const CODEX_ROOT = process.env.AGY_CODEX_ROOT || path.join(os.homedir(), ".codex", "sessions");
const COPILOT_ROOT = process.env.AGY_COPILOT_ROOT ||
  path.join(os.homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
const CLAUDE_ROOT = process.env.AGY_CLAUDE_ROOT || path.join(os.homedir(), ".claude", "projects");
const LIST_LIMIT = 12;
// list(): only the head of each file is read — but a single codex session_meta
// line (embedded base_instructions) can exceed 100KB, so the head must be big
// enough to reach the first real user message. Parsed heads cache by mtime.
const HEAD_BYTES = 256 * 1024;
const FULL_CAP = 2 * 1024 * 1024;
const _headCache = new Map(); // file → { mtimeMs, rec }

const b64u = (s) => Buffer.from(s).toString("base64url");
const unb64u = (s) => { try { return Buffer.from(s, "base64url").toString("utf8"); } catch { return null; } };

function walk(dir, match, depth, out) {
  if (depth < 0 || out.length > 400) return;
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, match, depth - 1, out);
    else if (match(d.name, p)) out.push(p);
  }
}

function headText(file, bytes) {
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString("utf8");
  } catch { return ""; }
}

// Whole file if it fits, otherwise its LAST `bytes` bytes with the leading partial
// line dropped. For a line-per-event transcript the tail is the part worth showing —
// Claude Code sessions here reach 106MB, and reading the first 2MB of one would show
// the opening and hide everything you actually came to look at.
// -> { text, truncated }
function tailText(file, bytes) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { text: "", truncated: false }; }
  if (size <= bytes) {
    try { return { text: fs.readFileSync(file, "utf8"), truncated: false }; }
    catch { return { text: "", truncated: false }; }
  }
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, size - bytes);
    fs.closeSync(fd);
    const raw = buf.subarray(0, n).toString("utf8");
    const nl = raw.indexOf("\n"); // the first line is a fragment of a record we cut
    return { text: nl < 0 ? "" : raw.slice(nl + 1), truncated: true };
  } catch { return { text: "", truncated: false }; }
}

function homeShort(p) {
  const home = os.homedir();
  return p && p.startsWith(home) ? "~" + p.slice(home.length) : p || "";
}
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

// ---- codex ------------------------------------------------------------------

function codexTextOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
  }
  return "";
}

// One pass over rollout lines → { cwd, msgs:[{role,text,ts}] }. The 2026 format
// carries clean text in event_msg rows; when any exist we prefer them and skip
// the duplicate response_item message rows.
function parseCodexLines(text) {
  const events = [], items = [];
  let cwd = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const p = j.payload && typeof j.payload === "object" ? j.payload : j;
    if (j.type === "session_meta" && p.cwd) { cwd = p.cwd; continue; }
    if (j.type === "event_msg") {
      if (p.type === "user_message" && p.message) events.push({ role: "user", text: p.message, ts: j.timestamp || null });
      else if (p.type === "agent_message" && p.message) events.push({ role: "assistant", text: p.message, ts: j.timestamp || null });
      continue;
    }
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const t = codexTextOf(p.content);
      if (t && !/^<\w+/.test(t)) items.push({ role: p.role, text: t, ts: j.timestamp || null });
    }
  }
  return { cwd, msgs: events.length ? events : items };
}

function listCodex() {
  const files = [];
  walk(CODEX_ROOT, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"), 4, files);
  const stat = files.map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.m - a.m).slice(0, LIST_LIMIT);
  const out = [];
  for (const { f, m } of stat) {
    const hit = _headCache.get(f);
    if (hit && hit.mtimeMs === m) { if (hit.rec) out.push(hit.rec); continue; }
    const parsed = parseCodexLines(headText(f, HEAD_BYTES));
    const firstUser = parsed.msgs.find((x) => x.role === "user");
    const rec = firstUser ? {
      id: "cdx." + b64u(f),
      agent: "CODEX",
      title: clip(firstUser.text, 90),
      project: parsed.cwd ? path.basename(parsed.cwd) : null,
      workspace: parsed.cwd || null,
      updatedAt: m,
      src: homeShort(f),
    } : null;
    _headCache.set(f, { mtimeMs: m, rec });
    if (rec) out.push(rec);
  }
  return out;
}

// ---- copilot ----------------------------------------------------------------

function copilotResponseText(resp) {
  if (typeof resp === "string") return resp;
  if (Array.isArray(resp)) {
    return resp.map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p.value === "string") return p.value;
      if (p && p.value && typeof p.value.value === "string") return p.value.value;
      return "";
    }).filter(Boolean).join("\n");
  }
  if (resp && typeof resp.value === "string") return resp.value;
  return "";
}

function copilotWorkspace(sessionFile) {
  // workspaceStorage/<hash>/workspace.json → { folder: "file:///path" }
  try {
    const wsJson = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(sessionFile)), "workspace.json"), "utf8"));
    const folder = wsJson.folder || wsJson.workspace;
    if (typeof folder === "string" && folder.startsWith("file://")) return decodeURIComponent(folder.replace(/^file:\/\//, ""));
  } catch {}
  return null;
}

function parseCopilot(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, "utf8").slice(0, FULL_CAP)); } catch { return null; }
  const reqs = Array.isArray(j.requests) ? j.requests : [];
  if (!reqs.length) return null;
  const msgs = [];
  for (const r of reqs) {
    const q = r.message && (typeof r.message === "string" ? r.message : r.message.text);
    if (q) msgs.push({ role: "user", text: String(q), ts: r.timestamp || null });
    const a = copilotResponseText(r.response);
    if (a) msgs.push({ role: "assistant", text: a, ts: null });
  }
  if (!msgs.length) return null;
  return { msgs, lastDate: j.lastMessageDate || j.creationDate || null };
}

function listCopilot() {
  const files = [];
  walk(COPILOT_ROOT, (n, p) => n.endsWith(".json") && p.includes(path.sep + "chatSessions" + path.sep), 3, files);
  const stat = files.map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.m - a.m).slice(0, 40);
  const out = [];
  for (const { f, m } of stat) {
    if (out.length >= LIST_LIMIT) break;
    const parsed = parseCopilot(f);
    if (!parsed) continue;
    const firstUser = parsed.msgs.find((x) => x.role === "user");
    if (!firstUser) continue;
    const ws = copilotWorkspace(f);
    out.push({
      id: "cop." + b64u(f),
      agent: "COPILOT",
      title: clip(firstUser.text, 90),
      project: ws ? path.basename(ws) : null,
      workspace: ws,
      updatedAt: m,
      src: "VS Code · workspaceStorage/chatSessions",
    });
  }
  return out;
}

// ---- claude code -------------------------------------------------------------
/*
 * ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl — one JSON object per line.
 * The lines that carry a conversation:
 *
 *   {type:"user",      message:{role,content}, cwd, timestamp, isSidechain, origin, …}
 *   {type:"assistant", message:{role,content:[block]}, cwd, timestamp, …}
 *   {type:"ai-title",  aiTitle:"Enable Claude Code chat visibility"}
 *
 * and a dozen bookkeeping types we skip (mode, permission-mode, attachment,
 * last-prompt, file-history-snapshot, queue-operation, agent-name, system, …).
 *
 * Three things make this messier than the codex/copilot formats:
 *
 * 1. ONE BLOCK PER ASSISTANT LINE. A turn's thinking, its prose and each of its tool
 *    calls arrive as separate `assistant` records, so consecutive ones must be merged
 *    back into a single turn or the UI draws twenty near-empty agent bubbles.
 * 2. TOOL RESULTS COME BACK AS `user` LINES. A record with `toolUseResult` and
 *    tool_result blocks is the harness replying to a tool call, not a person typing.
 *    They are attached to the call they answer (by tool_use_id) and never become
 *    messages themselves.
 * 3. NOT EVERY `user` LINE IS A HUMAN. Background-task notifications, teammate
 *    messages and SDK-driven prompts all land as `user`. Recent records label
 *    themselves (`origin.kind`, `promptSource`); older ones don't, so those fall back
 *    to recognising the machine-generated wrappers by shape.
 *
 * `cwd` is read from the records rather than decoded from the directory name, which
 * is lossy — it replaces both "/" and "-" with "-", so it cannot be inverted.
 */

// Bookkeeping between the tool call and its result. A pathological file could name
// thousands of unanswered calls, so the map is capped rather than left unbounded.
const MAX_PENDING_TOOLS = 500;
const CLAUDE_TOOL_OUT_CAP = 4000;

// Machine-generated `user` records, recognised by shape — the fallback for records
// written before origin/promptSource existed.
const MACHINE_TURN = /^\s*(?:<(?:task-notification|teammate-message|local-command-caveat|local-command-stdout|system-reminder)\b|Another Claude session sent a message:)/;

function claudeTextOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text).join("\n");
  }
  return "";
}

// System reminders are injected by the harness, not typed; showing them as the user's
// words would misattribute them.
function stripClaudeNoise(s) {
  return String(s || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    .trim();
}

// "<command-name>/loop</command-name>…<command-args>5m</command-args>" is how a typed
// slash command is recorded. That IS a human turn — render it as what they typed.
function claudeSlashCommand(txt) {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(txt);
  if (!name) return txt;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(txt);
  return (name[1].trim() + " " + (args ? args[1].trim() : "")).trim();
}

function isClaudeHumanTurn(rec, txt) {
  const kind = rec.origin && rec.origin.kind;
  if (typeof kind === "string") return kind === "human";        // authoritative when present
  if (typeof rec.promptSource === "string") return rec.promptSource !== "system" && rec.promptSource !== "sdk";
  return !MACHINE_TURN.test(txt);                                // older records: judge by shape
}

// A one-line label for a tool card. `description` is Claude Code's own summary of the
// call when it has one; otherwise fall back to whichever argument identifies the target.
function claudeToolSummary(input) {
  const a = input && typeof input === "object" ? input : {};
  if (typeof a.description === "string" && a.description.trim()) return clip(a.description, 120);
  for (const k of ["file_path", "notebook_path", "path", "pattern", "query", "url", "prompt", "command"]) {
    if (typeof a[k] === "string" && a[k].trim()) return clip(k.endsWith("path") ? homeShort(a[k]) : a[k], 120);
  }
  return "";
}

// The renderer reads {kind:"command", stdout} or {output}, same as agy's own tools.
function claudeToolResult(block, toolUseResult) {
  const r = toolUseResult && typeof toolUseResult === "object" ? toolUseResult : null;
  if (r && (typeof r.stdout === "string" || typeof r.stderr === "string")) {
    return {
      kind: "command",
      stdout: [r.stdout, r.stderr].filter(Boolean).join("\n").slice(0, CLAUDE_TOOL_OUT_CAP),
      status: r.interrupted ? "interrupted" : "",
    };
  }
  const c = block && block.content;
  const text = typeof c === "string" ? c
    : Array.isArray(c) ? c.map((x) => (x && typeof x.text === "string" ? x.text : "")).filter(Boolean).join("\n")
    : "";
  return { kind: "output", output: text.slice(0, CLAUDE_TOOL_OUT_CAP) };
}

// -> { cwd, title, sessionId, gitBranch, msgs:[{role,text,thinking,toolCalls,ts}] }
function parseClaudeLines(text) {
  let cwd = null, title = null, sessionId = null, gitBranch = null;
  const msgs = [];
  const pending = new Map(); // tool_use_id -> the toolCall awaiting its result
  let turn = null;           // the assistant turn currently being accumulated

  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== "object") continue;

    if (!cwd && typeof j.cwd === "string" && j.cwd) cwd = j.cwd;
    if (!sessionId && typeof j.sessionId === "string") sessionId = j.sessionId;
    if (typeof j.gitBranch === "string" && j.gitBranch) gitBranch = j.gitBranch;
    // regenerated as the session goes on — the last one describes it best
    if (j.type === "ai-title" && typeof j.aiTitle === "string" && j.aiTitle.trim()) {
      title = j.aiTitle.trim();
      continue;
    }
    if (j.isSidechain === true) continue; // a subagent's turn, not this conversation's

    // A message typed WHILE the agent is working never becomes a `user` record — it is
    // queued, and only survives as an attachment (plus a queue-operation enqueue/remove
    // pair, which would double-count). Mid-turn steering is some of the most important
    // text in a transcript, so it is recovered here rather than silently dropped.
    // `queued_command` is the one attachment type that carries something a human typed;
    // the other seventeen are harness bookkeeping.
    if (j.type === "attachment") {
      const at = j.attachment;
      if (at && at.type === "queued_command" && typeof at.prompt === "string") {
        const q = stripClaudeNoise(at.prompt);
        // The queue is not human-only: background-task completions are injected the
        // same way and arrive here as <task-notification> blobs. These records carry
        // no origin/promptSource, so the shape test is the only thing separating a
        // person interrupting from the harness reporting a finished job.
        if (q && !MACHINE_TURN.test(q)) {
          msgs.push({ role: "user", text: claudeSlashCommand(q), ts: j.timestamp || null });
          turn = null;
        }
      }
      continue;
    }

    const m = j.message;
    if (!m || typeof m !== "object") continue;

    if (j.type === "user") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const results = blocks.filter((b) => b && b.type === "tool_result");
      for (const b of results) {
        const tc = pending.get(b.tool_use_id);
        if (tc) { tc._result = claudeToolResult(b, j.toolUseResult); pending.delete(b.tool_use_id); }
      }
      // a record that is ONLY tool results is the harness answering, not a person
      if (results.length && results.length === blocks.length) continue;

      const txt = stripClaudeNoise(claudeTextOf(m.content));
      if (!txt || !isClaudeHumanTurn(j, txt)) continue;
      const shown = claudeSlashCommand(txt);
      if (!shown) continue;
      msgs.push({ role: "user", text: shown, ts: j.timestamp || null });
      turn = null; // a human turn closes whatever the agent was saying
      continue;
    }

    if (j.type === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [];
      if (!blocks.length) continue;
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        // Merging every assistant record between two human turns into one bubble is
        // technically faithful and completely unreadable — a long turn here runs to
        // 128 tool calls. Claude Code's own rhythm is prose, tools, prose, tools, so
        // prose (or fresh thinking) arriving after tool calls opens the next beat.
        if (turn && turn.toolCalls.length &&
            ((b.type === "text" && typeof b.text === "string" && b.text.trim()) ||
             (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()))) {
          turn = null;
        }
        if (!turn) {
          turn = { role: "assistant", text: "", thinking: "", toolCalls: [], ts: j.timestamp || null };
          msgs.push(turn);
        }
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          turn.text += (turn.text ? "\n\n" : "") + b.text;
        } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          turn.thinking += (turn.thinking ? "\n\n" : "") + b.thinking;
        } else if (b.type === "tool_use") {
          const tc = { name: b.name || "tool", summary: claudeToolSummary(b.input) };
          // Bash is the one tool whose argument IS a command line, which the UI
          // renders on its own `$ ` row rather than as a summary.
          if (b.name === "Bash" && b.input && typeof b.input.command === "string") {
            tc.command = b.input.command.slice(0, 2000);
          }
          turn.toolCalls.push(tc);
          if (b.id && pending.size < MAX_PENDING_TOOLS) pending.set(b.id, tc);
        }
      }
    }
  }

  // A turn whose only blocks were empty strings would render as a blank agent bubble.
  return {
    cwd, title, sessionId, gitBranch,
    msgs: msgs.filter((x) => x.role !== "assistant" || x.text || x.thinking || x.toolCalls.length),
  };
}

// ONLY <project>/<session-id>.jsonl. Subagent transcripts live one level deeper, in
// <session-id>/subagents/**, and are fragments of a parent session rather than
// conversations of their own — listing them would bury the real sessions.
function listClaudeFiles() {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(CLAUDE_ROOT, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names;
    try { names = fs.readdirSync(path.join(CLAUDE_ROOT, d.name), { withFileTypes: true }); } catch { continue; }
    for (const n of names) {
      if (n.isFile() && n.name.endsWith(".jsonl")) out.push(path.join(CLAUDE_ROOT, d.name, n.name));
    }
  }
  return out;
}

function listClaude() {
  const files = listClaudeFiles();
  const stat = files.map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.m - a.m).slice(0, LIST_LIMIT);
  const out = [];
  for (const { f, m } of stat) {
    const hit = _headCache.get(f);
    if (hit && hit.mtimeMs === m) { if (hit.rec) out.push(hit.rec); continue; }
    const parsed = parseClaudeLines(headText(f, HEAD_BYTES));
    const firstUser = parsed.msgs.find((x) => x.role === "user");
    // A session with no human turn in its head is a harness artefact, not a chat.
    const rec = (parsed.title || firstUser) ? {
      id: "cc." + b64u(f),
      agent: "CLAUDE",
      title: parsed.title || clip(firstUser.text, 90),
      project: parsed.cwd ? path.basename(parsed.cwd) : null,
      workspace: parsed.cwd || null,
      updatedAt: m,
      src: homeShort(f),
    } : null;
    _headCache.set(f, { mtimeMs: m, rec });
    if (rec) out.push(rec);
  }
  return out;
}

// ---- public API -------------------------------------------------------------

// Each agent that has any sessions is guaranteed this many slots before the rest of
// the list is filled by recency. Without it the agent you used most recently takes
// every slot — and since Claude Code sessions are usually the freshest thing on the
// machine, "other agents" would quietly stop showing the other agents.
const RESERVE_PER_AGENT = 2;

function mergeExternals(groups) {
  const byRecency = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  const picked = [], seen = new Set();
  for (const g of groups) {
    for (const x of g.slice().sort(byRecency).slice(0, RESERVE_PER_AGENT)) {
      if (!seen.has(x.id)) { seen.add(x.id); picked.push(x); }
    }
  }
  for (const x of groups.flat().filter((x) => !seen.has(x.id)).sort(byRecency)) {
    if (picked.length >= LIST_LIMIT) break;
    seen.add(x.id); picked.push(x);
  }
  return picked.sort(byRecency).slice(0, LIST_LIMIT);
}

function listExternal() {
  return { ok: true, externals: mergeExternals([listCodex(), listCopilot(), listClaude()]) };
}

function insideRoot(p, root) {
  return typeof p === "string" && (p === root || p.startsWith(root + path.sep));
}

function getExternal(id) {
  if (typeof id !== "string") return { ok: false, message: "id required" };
  if (id.startsWith("cdx.")) {
    const f = unb64u(id.slice(4));
    if (!f || !insideRoot(path.resolve(f), CODEX_ROOT)) return { ok: false, message: "bad external id" };
    let text;
    try { text = fs.readFileSync(f, "utf8").slice(0, FULL_CAP); } catch { return { ok: false, message: "session file unreadable" }; }
    const parsed = parseCodexLines(text);
    return {
      ok: true, id, agent: "CODEX", src: homeShort(f),
      workspace: parsed.cwd || null, project: parsed.cwd ? path.basename(parsed.cwd) : null,
      messages: parsed.msgs.map((x) => ({ role: x.role, text: x.text.slice(0, 8000), ts: x.ts })),
    };
  }
  if (id.startsWith("cop.")) {
    const f = unb64u(id.slice(4));
    if (!f || !insideRoot(path.resolve(f), COPILOT_ROOT)) return { ok: false, message: "bad external id" };
    const parsed = parseCopilot(f);
    if (!parsed) return { ok: false, message: "session file unreadable" };
    const ws = copilotWorkspace(f);
    return {
      ok: true, id, agent: "COPILOT", src: "VS Code · workspaceStorage/chatSessions",
      workspace: ws, project: ws ? path.basename(ws) : null,
      messages: parsed.msgs.map((x) => ({ role: x.role, text: x.text.slice(0, 8000), ts: x.ts })),
    };
  }
  if (id.startsWith("cc.")) {
    const f = unb64u(id.slice(3));
    if (!f || !insideRoot(path.resolve(f), CLAUDE_ROOT)) return { ok: false, message: "bad external id" };
    const { text, truncated } = tailText(f, FULL_CAP);
    if (!text) return { ok: false, message: "session file unreadable" };
    const parsed = parseClaudeLines(text);
    return {
      ok: true, id, agent: "CLAUDE", src: homeShort(f), truncated,
      workspace: parsed.cwd || null, project: parsed.cwd ? path.basename(parsed.cwd) : null,
      title: parsed.title || null, gitBranch: parsed.gitBranch || null,
      messages: parsed.msgs.map((x) => (x.role === "user"
        ? { role: x.role, text: x.text.slice(0, 8000), ts: x.ts }
        : {
            role: x.role, text: x.text.slice(0, 8000), ts: x.ts,
            thinking: x.thinking ? x.thinking.slice(0, 8000) : "",
            toolCalls: x.toolCalls,
          })),
    };
  }
  return { ok: false, message: "unknown external id scheme" };
}

module.exports = { listExternal, getExternal, parseClaudeLines, mergeExternals };
