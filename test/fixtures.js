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
  fs.writeFileSync(path.join(agyHome, "settings.json"), JSON.stringify({ model: "Gemini 3.1 Pro (High)", permissions: { allow: [] } }));
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

module.exports = { CID, makeRoots, writeConversation, writeHistoryLine, writeAgyStub, writeCodexSession, writeMcpStub, assert, finish, sleep };
