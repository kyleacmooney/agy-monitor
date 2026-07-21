#!/usr/bin/env node
"use strict";
/*
 * external.test — read-only transcripts from other local coding agents.
 *
 *   node external.test.js
 *
 * Focused on the Claude Code adapter, whose format is the awkward one: one content
 * block per assistant record, tool results delivered as `user` records, machine-
 * generated turns that look like user turns, and mid-turn human messages that only
 * ever exist as attachments.
 *
 * Fully hermetic — AGY_CLAUDE_ROOT / AGY_CODEX_ROOT / AGY_COPILOT_ROOT are pointed at
 * a temp dir BEFORE agy-external is required (it reads them at module load).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agy-external-test-"));
const fx = require("./test/fixtures.js");

const session = fx.writeClaudeSession(TMP);
process.env.AGY_CLAUDE_ROOT = session.root;
process.env.AGY_CODEX_ROOT = path.join(TMP, "no-codex");
process.env.AGY_COPILOT_ROOT = path.join(TMP, "no-copilot");

const E = require("./agy-external.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + (e && e.message)); fail++; }
}

const B64 = (s) => Buffer.from(s).toString("base64url");
const full = () => E.getExternal("cc." + B64(session.file));

// ---- listing ---------------------------------------------------------------
console.log("\n# listClaude");

test("a claude session is listed, titled by its ai-title", () => {
  const r = E.listExternal();
  assert.ok(r.ok);
  const cc = r.externals.filter((x) => x.agent === "CLAUDE");
  assert.strictEqual(cc.length, 1, "exactly one session");
  assert.strictEqual(cc[0].title, "Export endpoint wiring");
  assert.strictEqual(cc[0].project, "claude-ws");
  assert.strictEqual(cc[0].workspace, "/tmp/claude-ws");
});

// The nested transcript is the reason listClaude walks exactly two levels instead of
// using the recursive walk() the other adapters share.
test("subagent transcripts are NOT listed as sessions", () => {
  const ids = E.listExternal().externals.map((x) => x.id);
  assert.ok(!ids.some((id) => /agent-deadbeef/.test(Buffer.from(id.slice(3), "base64url").toString("utf8"))),
    "a <session>/subagents/*.jsonl file must never appear as its own row");
  assert.strictEqual(ids.length, 1, "only the top-level session");
});

test("cwd comes from the records, not the lossy directory name", () => {
  // the dir is "-tmp-claude-ws"; "-" stands for both "/" and "-", so it can't be inverted
  assert.strictEqual(full().workspace, "/tmp/claude-ws");
});

// ---- transcript ------------------------------------------------------------
console.log("\n# getExternal (claude)");

test("consecutive assistant records merge into one turn", () => {
  const m = full().messages;
  // thinking + text + tool_use arrived as three records; they are one turn
  const first = m.find((x) => x.role === "assistant");
  assert.strictEqual(first.text, "Let me look at the router.");
  assert.strictEqual(first.thinking, "look at the router first");
  assert.strictEqual(first.toolCalls.length, 1);
});

// Merging *everything* between two human turns is faithful and unreadable — a real
// session reaches 128 tool calls in one turn.
test("prose after tool calls opens a new turn", () => {
  const a = full().messages.filter((x) => x.role === "assistant");
  assert.ok(a.length >= 2, "the post-tool text is its own turn, not appended to the first");
  assert.strictEqual(a[1].text, "Found it on line 42.");
  assert.strictEqual(a[1].toolCalls.length, 0);
});

test("tool calls carry name, summary, command and their result", () => {
  const tc = full().messages.find((x) => x.role === "assistant").toolCalls[0];
  assert.strictEqual(tc.name, "Bash");
  assert.strictEqual(tc.summary, "Find the export route");
  assert.strictEqual(tc.command, "rg -n export server.js");
  assert.strictEqual(tc._result.kind, "command");
  assert.match(tc._result.stdout, /app\.get\('\/export'\)/);
});

test("a tool result never becomes a message of its own", () => {
  const users = full().messages.filter((x) => x.role === "user");
  assert.ok(!users.some((u) => /app\.get/.test(u.text)), "tool output must not read as something the user said");
});

// ---- who actually spoke ----------------------------------------------------
console.log("\n# human vs machine turns");

test("machine-generated user records are dropped", () => {
  const users = full().messages.filter((x) => x.role === "user");
  assert.ok(!users.some((u) => /task-notification/.test(u.text)), "origin.kind != human must be filtered");
});

test("a message typed mid-turn is recovered from its attachment", () => {
  const users = full().messages.filter((x) => x.role === "user").map((x) => x.text);
  assert.ok(users.includes("also add the csv variant"),
    "queued mid-turn steering only exists as an attachment and must not be lost");
});

// The queue is shared: background-task completions are injected exactly like a typed
// interruption, and these records carry no origin/promptSource to tell them apart.
test("a queued TASK NOTIFICATION is not mistaken for a typed message", () => {
  const users = full().messages.filter((x) => x.role === "user").map((x) => x.text);
  assert.ok(!users.some((t) => /task-notification/.test(t)), "queued machine notices stay filtered");
  assert.strictEqual(users.length, 2, "exactly the two things the human typed");
});

test("turn order is preserved: prompt, work, interruption, work", () => {
  const roles = full().messages.map((x) => x.role).join(",");
  assert.strictEqual(roles, "user,assistant,assistant,user,assistant");
});

// ---- provenance fallbacks ---------------------------------------------------
console.log("\n# provenance fallbacks");

test("records with no origin/promptSource fall back to shape", () => {
  const older = [
    { type: "user", cwd: "/w", timestamp: "t", message: { role: "user", content: "a real question" } },
    { type: "user", cwd: "/w", timestamp: "t", message: { role: "user", content: "<task-notification>x</task-notification>" } },
    { type: "user", cwd: "/w", timestamp: "t", message: { role: "user", content: "Another Claude session sent a message: hi" } },
  ].map((r) => JSON.stringify(r)).join("\n");
  const msgs = E.parseClaudeLines(older).msgs;
  assert.deepStrictEqual(msgs.map((m) => m.text), ["a real question"]);
});

test("promptSource sdk/system are machine, typed/queued are human", () => {
  const rows = [
    { type: "user", promptSource: "sdk", message: { role: "user", content: "sdk driven" } },
    { type: "user", promptSource: "system", message: { role: "user", content: "system driven" } },
    { type: "user", promptSource: "queued", message: { role: "user", content: "queued human" } },
    { type: "user", promptSource: "typed", message: { role: "user", content: "typed human" } },
  ].map((r) => JSON.stringify(r)).join("\n");
  assert.deepStrictEqual(E.parseClaudeLines(rows).msgs.map((m) => m.text), ["queued human", "typed human"]);
});

test("system-reminder blocks are stripped from what the user said", () => {
  const row = JSON.stringify({
    type: "user", origin: { kind: "human" },
    message: { role: "user", content: "do the thing<system-reminder>secret harness text</system-reminder>" },
  });
  const m = E.parseClaudeLines(row).msgs;
  assert.strictEqual(m[0].text, "do the thing");
});

test("a typed slash command renders as the command, not its scaffolding", () => {
  const row = JSON.stringify({
    type: "user", origin: { kind: "human" },
    message: { role: "user", content: "<command-name>/loop</command-name>\n<command-message>loop</command-message>\n<command-args>5m</command-args>" },
  });
  assert.strictEqual(E.parseClaudeLines(row).msgs[0].text, "/loop 5m");
});

test("inline sidechain records are skipped", () => {
  const rows = [
    { type: "user", origin: { kind: "human" }, isSidechain: true, message: { role: "user", content: "subagent turn" } },
    { type: "user", origin: { kind: "human" }, message: { role: "user", content: "main turn" } },
  ].map((r) => JSON.stringify(r)).join("\n");
  assert.deepStrictEqual(E.parseClaudeLines(rows).msgs.map((m) => m.text), ["main turn"]);
});

test("malformed lines are skipped, not fatal", () => {
  const rows = [
    "{not json",
    "",
    JSON.stringify({ type: "user", origin: { kind: "human" }, message: { role: "user", content: "still parsed" } }),
  ].join("\n");
  assert.deepStrictEqual(E.parseClaudeLines(rows).msgs.map((m) => m.text), ["still parsed"]);
});

test("an assistant turn with only empty blocks is dropped", () => {
  // real sessions store thinking with the text redacted — an empty bubble helps nobody
  const rows = [
    { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }] } },
  ].map((r) => JSON.stringify(r)).join("\n");
  assert.strictEqual(E.parseClaudeLines(rows).msgs.length, 0);
});

// ---- ids and traversal ------------------------------------------------------
console.log("\n# ids");

test("a path outside the claude root is refused", () => {
  const r = E.getExternal("cc." + B64("/etc/passwd"));
  assert.ok(!r.ok);
  assert.match(r.message, /bad external id/);
});

test("an unknown id scheme is refused", () => {
  assert.ok(!E.getExternal("zz.abc").ok);
  assert.ok(!E.getExternal(null).ok);
});

// ---- list fairness ----------------------------------------------------------
console.log("\n# mergeExternals");

const row = (agent, id, at) => ({ agent, id: agent + id, updatedAt: at });

test("every agent keeps slots even when another is far more recent", () => {
  const claude = Array.from({ length: 20 }, (_, i) => row("CLAUDE", i, 10000 - i));
  const codex = [row("CODEX", 1, 5), row("CODEX", 2, 4)];
  const copilot = [row("COPILOT", 1, 3)];
  const merged = E.mergeExternals([codex, copilot, claude]);
  const agents = new Set(merged.map((x) => x.agent));
  assert.ok(agents.has("CODEX") && agents.has("COPILOT") && agents.has("CLAUDE"),
    "a recency-only sort would have shown 12 claude rows and nothing else");
  assert.strictEqual(merged.filter((x) => x.agent === "CODEX").length, 2);
  assert.strictEqual(merged.filter((x) => x.agent === "COPILOT").length, 1);
});

test("the merged list stays newest-first and capped", () => {
  const merged = E.mergeExternals([
    Array.from({ length: 30 }, (_, i) => row("CLAUDE", i, 1000 - i)),
    [row("CODEX", 1, 1)],
  ]);
  assert.ok(merged.length <= 12, "capped at LIST_LIMIT");
  const ts = merged.map((x) => x.updatedAt);
  assert.deepStrictEqual(ts, ts.slice().sort((a, b) => b - a), "sorted newest-first");
});

test("an agent with no sessions contributes nothing", () => {
  const merged = E.mergeExternals([[], [], [row("CLAUDE", 1, 9)]]);
  assert.strictEqual(merged.length, 1);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
