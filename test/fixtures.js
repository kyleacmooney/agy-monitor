"use strict";
/* Shared test fixtures: a fake ~/.agy-monitor state root and a fake agy CLI home
   (brain transcripts + metadata cache + settings), plus a stub `agy` binary that
   prints the --output-format json envelope. Set env BEFORE requiring app modules. */

const fs = require("fs");
const os = require("os");
const path = require("path");

const CID = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0001";

function makeRoots(prefix) {
  process.env.AGY_MONITOR_NO_PS = "1"; // a REAL agy session on this machine must not leak into fixture worlds
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const monRoot = path.join(base, "agy-monitor");
  const agyHome = path.join(base, "antigravity-cli");
  for (const d of ["sessions", "approvals", "answers", "ui-runs"]) fs.mkdirSync(path.join(monRoot, d), { recursive: true });
  fs.mkdirSync(path.join(agyHome, "cache"), { recursive: true });
  fs.mkdirSync(path.join(agyHome, "conversations"), { recursive: true });
  return { base, monRoot, agyHome };
}

// `prompt` sets the opening user turn (noise-clustering keys on it); `padBytes`
// pads that turn's payload so the record exceeds a chunked reader's window — the
// real shape of a commit-message helper that ships a whole diff in one JSON line.
function writeConversation(agyHome, { cid = CID, workspace = "/tmp/ws", title = "Test convo", askTail = false, indexed = true, prompt = "hello agy", padBytes = 0 } = {}) {
  const logs = path.join(agyHome, "brain", cid, ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const body = prompt + (padBytes ? "\n" + "d".repeat(padBytes) : "");
  const rows = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-07-01T12:00:00Z", content: "<USER_REQUEST> " + body + " </USER_REQUEST>" },
    { step_index: 1, source: "SYSTEM", type: "CONVERSATION_HISTORY", status: "DONE", created_at: "2026-07-01T12:00:00Z", content: "internal" },
    { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-07-01T12:00:05Z", content: "Hi there — **all good**.", thinking: "the user greets me" },
  ];
  if (askTail) {
    rows.push({
      step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-07-01T12:00:10Z",
      content: 'One decision before I continue.\n```ask\n{"questions":[{"header":"Backoff","question":"Cap for the retry backoff?","multiSelect":false,"options":[{"label":"15s","description":"snappy recovery"},{"label":"60s","description":"current default"}]}]}\n```',
    });
  }
  fs.writeFileSync(path.join(logs, "transcript_full.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // indexed:false leaves the transcript in brain/ but NOT in agy's /resume index —
  // the orphan shape the all-chats backfill has to recover. NumSteps mirrors
  // max(step_index)+1 so an indexed and a backfilled read of the SAME transcript agree.
  if (indexed) {
    // merge into any existing metadata so tests can register several conversations
    const metaFile = path.join(agyHome, "cache", "conversation_metadata.json");
    let meta = { conversations: {} };
    try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
    meta.conversations = meta.conversations || {};
    meta.conversations[cid] = {
      is_internal: false,
      last_modified_time: Date.now() / 1000,
      summary: { ID: cid, Title: title, Preview: "### hi", NumSteps: rows.length, UpdatedAt: "2026-07-01T12:00:05Z", WorkspaceURIs: ["file://" + workspace], AppDataDir: "antigravity-cli" },
    };
    fs.writeFileSync(metaFile, JSON.stringify(meta));
  }
  // Seed a valid settings file for worlds that lack one — but never CLOBBER one a
  // test has already shaped: the safelist suite edits this exact file (it doubles as
  // AGY_GATE_SETTINGS), and a later writeConversation silently resetting
  // permissions.allow to [] would erase that state mid-test.
  const settingsFile = path.join(agyHome, "settings.json");
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({ model: "Gemini 3.1 Pro (High)", permissions: { allow: [] } }));
  }
  return cid;
}

// Append an agy prompt-log line — the only on-disk source that ties an UNINDEXED
// conversation to a workspace.
function writeHistoryLine(agyHome, { cid = CID, workspace = "/tmp/ws", display = "hello agy" } = {}) {
  fs.appendFileSync(path.join(agyHome, "history.jsonl"),
    JSON.stringify({ display, timestamp: Date.parse("2026-07-01T12:00:00Z"), workspace, conversationId: cid }) + "\n");
}

// A stub agy: sleeps, updates last_conversations.json for new chats, prints the
// probe-verified json envelope. Behavior knobs via env: STUB_EXIT, STUB_SLEEP.
function writeAgyStub(dir, agyHome, { cid = CID } = {}) {
  const stub = path.join(dir, "agy");
  fs.writeFileSync(stub, `#!/bin/bash
# stub agy for tests
CID="${cid}"
NEW=0
for a in "$@"; do [ "$a" = "--conversation" ] && NEW=1; done
if [ "$NEW" = "0" ]; then
  mkdir -p "${agyHome}/cache"
  echo "{\\"$PWD\\": \\"$CID\\"}" > "${agyHome}/cache/last_conversations.json"
fi
sleep "\${STUB_SLEEP:-0.4}"
if [ "\${STUB_EXIT:-0}" != "0" ]; then echo "boom: simulated failure" >&2; exit "\${STUB_EXIT}"; fi
echo "{\\"conversation_id\\":\\"$CID\\",\\"status\\":\\"SUCCESS\\",\\"response\\":\\"pong\\",\\"duration_seconds\\":0.4,\\"num_turns\\":1,\\"usage\\":{\\"input_tokens\\":100,\\"output_tokens\\":20,\\"thinking_tokens\\":5,\\"total_tokens\\":125}}"
`);
  fs.chmodSync(stub, 0o755);
  return stub;
}

// A fake Codex CLI session (2026 rollout format) under <base>/codex-sessions —
// point AGY_CODEX_ROOT here for hermetic list-external/get-external tests.
function writeCodexSession(base, { workspace = "/tmp/codex-ws", title = "fix the flaky test in ci" } = {}) {
  const root = path.join(base, "codex-sessions");
  const dir = path.join(root, "2026", "07", "01");
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { type: "session_meta", timestamp: "2026-07-01T10:00:00Z", payload: { id: "cdx-1", cwd: workspace, base_instructions: "x".repeat(200) } },
    { type: "event_msg", timestamp: "2026-07-01T10:00:01Z", payload: { type: "user_message", message: title } },
    { type: "event_msg", timestamp: "2026-07-01T10:00:09Z", payload: { type: "agent_message", message: "Found it — the test races the server boot. Patching the wait." } },
  ];
  const file = path.join(dir, "rollout-2026-07-01T10-00-00-cdx1.jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { root, file };
}

// A fake Claude Code session under <base>/claude-projects — point AGY_CLAUDE_ROOT
// here for hermetic list-external/get-external tests. Deliberately includes the
// awkward parts of the real format: one content block per assistant record, a tool
// result arriving as a `user` record, a machine-generated `user` turn, a queued
// mid-turn human message, and a subagent transcript nested one level deeper.
function writeClaudeSession(base, {
  workspace = "/tmp/claude-ws",
  title = "wire up the export endpoint",
  aiTitle = "Export endpoint wiring",
  sid = "11111111-2222-3333-4444-555555555555",
} = {}) {
  const root = path.join(base, "claude-projects");
  const dir = path.join(root, "-tmp-claude-ws");
  fs.mkdirSync(dir, { recursive: true });
  const common = { cwd: workspace, sessionId: sid, gitBranch: "main", isSidechain: false, userType: "external" };
  const rows = [
    { type: "mode", mode: "normal", sessionId: sid },
    { type: "user", ...common, timestamp: "2026-07-01T10:00:00Z", origin: { kind: "human" }, promptSource: "typed",
      message: { role: "user", content: title } },
    { type: "ai-title", aiTitle, sessionId: sid },
    // one block per assistant record — these three must merge into ONE turn
    { type: "assistant", ...common, timestamp: "2026-07-01T10:00:02Z",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "look at the router first", signature: "sig" }] } },
    { type: "assistant", ...common, timestamp: "2026-07-01T10:00:03Z",
      message: { role: "assistant", content: [{ type: "text", text: "Let me look at the router." }] } },
    { type: "assistant", ...common, timestamp: "2026-07-01T10:00:04Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "rg -n export server.js", description: "Find the export route" } }] } },
    // a tool result comes back as a `user` record — never its own message
    { type: "user", ...common, timestamp: "2026-07-01T10:00:05Z", toolUseResult: { stdout: "42: app.get('/export')", stderr: "", interrupted: false },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42: app.get('/export')" }] } },
    // machine-generated `user` turn: must not appear as something the human said
    { type: "user", ...common, timestamp: "2026-07-01T10:00:06Z", origin: { kind: "task-notification" },
      message: { role: "user", content: "<task-notification>\n<task-id>abc</task-id>\n</task-notification>" } },
    // text after tool calls opens the next beat
    { type: "assistant", ...common, timestamp: "2026-07-01T10:00:07Z",
      message: { role: "assistant", content: [{ type: "text", text: "Found it on line 42." }] } },
    // typed while the agent was working: only ever recorded as an attachment
    { type: "attachment", ...common, timestamp: "2026-07-01T10:00:08Z",
      attachment: { type: "queued_command", prompt: "also add the csv variant", commandMode: "prompt" } },
    // background-task completion is queued the SAME way — must stay filtered
    { type: "attachment", ...common, timestamp: "2026-07-01T10:00:09Z",
      attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>zzz</task-id>\n</task-notification>" } },
    { type: "assistant", ...common, timestamp: "2026-07-01T10:00:10Z",
      message: { role: "assistant", content: [{ type: "text", text: "Adding the csv variant now." }] } },
  ];
  const file = path.join(dir, sid + ".jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  // a subagent transcript, which must NOT be listed as a session of its own
  const subDir = path.join(dir, sid, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "agent-deadbeef.jsonl"), JSON.stringify({
    type: "user", ...common, timestamp: "2026-07-01T10:00:11Z", origin: { kind: "human" },
    message: { role: "user", content: "subagent prompt that must never be listed" },
  }) + "\n");
  return { root, file, dir, sid };
}

// ---- a LIVE fake agy process --------------------------------------------------
// listAgySessions discovers sessions with ps (argv[0] basename === "agy") and lsof
// (cwd → workspace, an open brain/<cid>/ file → conversation, an open
// antigravity-cli/log/cli-*.log → agy's own stdout log). This spawns a process that
// satisfies all four checks for real: bash cd's into the workspace, holds the brain
// transcript open on fd 3, points stdout at a cli log, then execs into `sleep` with
// argv[0] forced to "agy". No monitor code is stubbed — the test exercises the same
// ps/lsof path production runs.
//
// NB: callers must UNSET AGY_MONITOR_NO_PS (makeRoots sets it), which also lets any
// REAL agy session on the machine into the results — assertions must select by cid.
function spawnFakeAgy({ agyHome, workspace, cid }) {
  const { spawn } = require("child_process");
  const logDir = path.join(agyHome, "log");
  fs.mkdirSync(logDir, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  // the filename carries the log's start time — logStartMs parses it for the year
  const logPath = path.join(logDir,
    `cli-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.log`);
  fs.writeFileSync(logPath, "");
  const transcript = path.join(agyHome, "brain", cid, ".system_generated", "logs", "transcript_full.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, "");
  const child = spawn("/bin/bash", ["-c",
    'cd "$1" && exec 3< "$2" && exec >> "$3" 2>&1 && exec -a agy sleep 120',
    "bash", workspace, transcript, logPath], { stdio: "ignore" });
  return { pid: child.pid, logPath, transcript, kill: () => { try { child.kill("SIGKILL"); } catch {} } };
}

// One glog-format line as agy's own process writes them (year omitted — it comes
// from the log filename; the pid column is the writing process's).
function agyGlogLine(pid, atMs, body) {
  const d = new Date(atMs);
  const p2 = (n) => String(n).padStart(2, "0");
  const us = String(d.getMilliseconds() * 1000).padStart(6, "0");
  return `I${p2(d.getMonth() + 1)}${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${us} ${pid} tool_confirmation_manager.go:192] ${body}`;
}

// A minimal stdio MCP server (newline JSON-RPC): answers initialize + tools/list.
function writeMcpStub(dir) {
  const stub = path.join(dir, "mcp-stub.js");
  fs.writeFileSync(stub, `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "stub", version: "1.0" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo_tool", description: "Echoes a message back to the caller and returns the round-trip latency, the negotiated protocol version, and any transport warnings raised while the stub server was handling the request." }] } }) + "\\n");
    }
  }
});
`);
  return stub;
}

function assert(cond, msg, failures) {
  if (cond) { console.log("  ✓ " + msg); } else { console.log("  ✗ " + msg); failures.push(msg); }
}

function finish(failures, name) {
  console.log("");
  if (failures.length) { console.log(`FAIL ${name}: ${failures.length} failure(s)`); process.exit(1); }
  console.log(`PASS ${name}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { CID, makeRoots, writeConversation, writeHistoryLine, writeAgyStub, writeCodexSession, writeClaudeSession, writeMcpStub, spawnFakeAgy, agyGlogLine, assert, finish, sleep };
