"use strict";
/*
 * agy-external — read-only transcripts from OTHER local coding agents.
 *
 *   CODEX   — ~/.codex/sessions/**\/rollout-*.jsonl
 *             2026 format: {type:"session_meta"|"response_item"|"event_msg", payload:{...}}
 *             2025 format: flat {type:"message", role, content:[...]} lines
 *   COPILOT — VS Code chat: ~/Library/Application Support/Code/User/
 *             workspaceStorage/<hash>/chatSessions/*.json  ({requests:[...]})
 *
 * These are surfaced read-only: the monitor never writes to either tool's
 * files. IDs are "cdx."/"cop." + base64url(absolute path), and reads validate
 * the decoded path is still inside the expected root (no traversal).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const CODEX_ROOT = process.env.AGY_CODEX_ROOT || path.join(os.homedir(), ".codex", "sessions");
const COPILOT_ROOT = process.env.AGY_COPILOT_ROOT ||
  path.join(os.homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage");
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

// ---- public API -------------------------------------------------------------

function listExternal() {
  const items = listCodex().concat(listCopilot());
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, externals: items.slice(0, LIST_LIMIT) };
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
  return { ok: false, message: "unknown external id scheme" };
}

module.exports = { listExternal, getExternal };
