"use strict";
/* state.test.js — the live-session turn-state machine (deriveState + the staleness
   downgrade in displayLiveState). Regression cover for the bug where an agy session
   parked on an interactive tool-approval prompt (a PreToolUse that never gets its
   PostToolUse) aged past BUSY_STALE_MS and was mislabeled "your turn / idle". */

const assert = require("assert");
const { deriveState, displayLiveState, BUSY_STALE_MS } = require("./agy-monitor");

let pass = 0;
const T = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

// deriveState: raw hook event → state
T("PreToolUse with a tool → busy, tool named", () => {
  const s = deriveState("PreToolUse", { toolCall: { name: "call_mcp_tool" } });
  assert.strictEqual(s.state, "busy");
  assert.strictEqual(s.tool, "call_mcp_tool");
});
T("Stop fullyIdle → idle", () => {
  assert.strictEqual(deriveState("Stop", { fullyIdle: true }).state, "idle");
});
T("Stop fullyIdle=false → busy", () => {
  assert.strictEqual(deriveState("Stop", { fullyIdle: false }).state, "busy");
});

// displayLiveState: the staleness rule. now is injectable.
const NOW = 1_000_000_000_000;
const preToolLive = (ageMs) => ({ state: "busy", detail: "running call_mcp_tool", tool: "call_mcp_tool", event: "PreToolUse", ts: (NOW - ageMs) / 1000 });
const postToolLive = (ageMs) => ({ state: "busy", detail: "working", tool: "run_command", event: "PostToolUse", ts: (NOW - ageMs) / 1000 });

T("fresh PreToolUse stays busy (not yet stale)", () => {
  const d = displayLiveState(preToolLive(5000), false, NOW);
  assert.strictEqual(d.state, "busy");
});
T("STALE PreToolUse without skip-perms → waiting (needs approval), NOT idle", () => {
  const d = displayLiveState(preToolLive(BUSY_STALE_MS + 60000), false, NOW);
  assert.strictEqual(d.state, "waiting");
  assert.match(d.stateDetail, /awaiting approval/);
  assert.strictEqual(d.tool, "call_mcp_tool"); // tool retained
});
T("STALE PreToolUse WITH skip-perms → stays busy (tool running long), NOT idle", () => {
  const d = displayLiveState(preToolLive(BUSY_STALE_MS + 60000), true, NOW);
  assert.strictEqual(d.state, "busy");
  assert.match(d.stateDetail, /still running/);
});
T("STALE PostToolUse (missed Stop) → idle / your turn", () => {
  const d = displayLiveState(postToolLive(BUSY_STALE_MS + 60000), false, NOW);
  assert.strictEqual(d.state, "idle");
  assert.strictEqual(d.stateDetail, "your turn");
  assert.strictEqual(d.tool, null);
});
T("no live entry → running", () => {
  assert.strictEqual(displayLiveState(null, false, NOW).state, "running");
});

console.log(`\nPASS state.test (${pass} assertions)`);
