"use strict";
/* state.test.js — the live-session turn-state machine (deriveState + the staleness
   downgrade in displayLiveState). Regression cover for BOTH halves of the dangling
   PreToolUse problem:

     1. a session parked on an interactive tool-approval prompt (a PreToolUse that
        never gets its PostToolUse) aged past BUSY_STALE_MS and was mislabeled
        "your turn / idle"; and
     2. the converse — a session whose prompt the user ESCAPED stayed pinned at
        "needs you / awaiting approval…" forever, because agy fires no interrupt
        hook and its Stop hook is killed by the very context Escape cancels.

   (1) is inference (staleness + policy). (2) can only be settled by evidence, which
   `live.cli` carries in from agy's own log (agy-clilog.js) — and that evidence must
   OVERRIDE the inference in both directions without disturbing the no-evidence case. */

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
// policy-aware fast path: a run_command agy prompts on (forcesApproval) is "awaiting
// approval" the instant PreToolUse fires — no need to wait out BUSY_STALE_MS.
const runCmdLive = (ageMs, forces) => ({ state: "busy", detail: "running run_command", tool: "run_command", event: "PreToolUse", ts: (NOW - ageMs) / 1000, forcesApproval: forces });

T("FRESH run_command that forces approval → waiting immediately (no stale wait)", () => {
  const d = displayLiveState(runCmdLive(500, true), false, NOW);
  assert.strictEqual(d.state, "waiting");
  assert.match(d.stateDetail, /awaiting approval: run_command/);
  assert.strictEqual(d.tool, "run_command");
});
T("FRESH run_command forcing approval WITH skip-perms → stays busy (no prompt)", () => {
  const d = displayLiveState(runCmdLive(500, true), true, NOW);
  assert.strictEqual(d.state, "busy");
});
T("FRESH run_command that does NOT force approval → stays busy (running)", () => {
  const d = displayLiveState(runCmdLive(500, false), false, NOW);
  assert.strictEqual(d.state, "busy");
});
T("stale PreToolUse with NO tool name (and no cli) → idle: nothing to be parked on", () => {
  // A dangling PreToolUse normally means "parked at the tool" — but with no tool name
  // there is nothing to wait for or approve, so it degrades to the missed-Stop rule.
  const noName = { state: "busy", detail: "running a tool", tool: null, event: "PreToolUse", ts: (NOW - BUSY_STALE_MS - 60000) / 1000 };
  assert.deepStrictEqual(displayLiveState(noName, false, NOW), { state: "idle", stateDetail: "your turn", tool: null });
  assert.deepStrictEqual(displayLiveState(noName, true, NOW), { state: "idle", stateDetail: "your turn", tool: null });
  // …while a FRESH nameless PreToolUse is still just busy
  const fresh = { ...noName, ts: (NOW - 5000) / 1000 };
  assert.strictEqual(displayLiveState(fresh, false, NOW).state, "busy");
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

// ---- evidence from agy's own log (live.cli) --------------------------------
// Every case above carries no `cli`, so they pin the degrade-gracefully contract:
// when the log is unreadable, behaviour is exactly what it was before.
const withCli = (base, cli) => ({ ...base, cli });
const STALE = BUSY_STALE_MS + 60000;

// TWO NAMESPACES, and mixing them is silent. agy's log names tools in its own display
// namespace ("Bash", "ReadFile", "McpTool"); the hook payload and every transcript tool
// card use the API name ("run_command", "read_file", "call_mcp_tool"). The UI marks the
// cancelled card by comparing cancelledTool === tc.name, so emitting agy's name would
// match nothing and quietly leave an escaped command wearing a green ✓. Hence every
// `cli` fixture below deliberately carries agy's name while the live entry carries the
// transcript's — and the assertions demand the transcript's back out.
T("ESCAPED prompt (turn ended, Stop hook killed) → idle, NOT 'needs you'", () => {
  const d = displayLiveState(withCli(preToolLive(STALE), { surfaced: true, tool: "Bash", approved: null, turnEnded: true }), false, NOW);
  assert.strictEqual(d.state, "idle");
  assert.strictEqual(d.stateDetail, "your turn");
  assert.strictEqual(d.tool, null);
  // so the UI can draw ⊘, not a green ✓ — and in the namespace tc.name is written in
  assert.strictEqual(d.cancelledTool, "call_mcp_tool");
});
T("DENIED prompt (approved=false) → idle / tool cancelled", () => {
  const d = displayLiveState(withCli(preToolLive(STALE), { surfaced: true, tool: "Bash", approved: false, turnEnded: false }), false, NOW);
  assert.strictEqual(d.state, "idle");
  assert.match(d.stateDetail, /cancelled/);
  assert.strictEqual(d.cancelledTool, "call_mcp_tool");
});
T("cancelledTool is NEVER agy's log name — the UI matches it against tc.name", () => {
  // the real shape: agy logs `Surfacing tool confirmation: "Bash"` for a step whose
  // PreToolUse payload said toolCall.name === "run_command".
  const escaped = withCli(runCmdLive(STALE, true), { surfaced: true, tool: "Bash", approved: false, turnEnded: true });
  const d = displayLiveState(escaped, false, NOW);
  assert.strictEqual(d.cancelledTool, "run_command");
  assert.notStrictEqual(d.cancelledTool, "Bash");
});
T("no tool name in the payload → cancelledTool is null, so the UI marks nothing", () => {
  // Better to leave the card unmarked than to mark an arbitrary one: `cancelled` is
  // truthy-gated in toolCard, so null degrades to the old green ✓ rather than guessing.
  const noName = { state: "busy", detail: "running a tool", tool: null, event: "PreToolUse", ts: (NOW - STALE) / 1000 };
  const d = displayLiveState(withCli(noName, { surfaced: true, tool: "Bash", approved: false, turnEnded: true }), false, NOW);
  assert.strictEqual(d.state, "idle");
  assert.strictEqual(d.cancelledTool, null);
});
// The reported bug's exact shape: forcesApproval short-circuits to "waiting" the
// instant PreToolUse lands, with no time term — so evidence must beat it while FRESH,
// or the common case stays broken no matter what the staleness branch does.
T("FRESH forcesApproval run_command that was escaped → idle, evidence beats the fast path", () => {
  const d = displayLiveState(withCli(runCmdLive(500, true), { surfaced: true, tool: "Bash", approved: null, turnEnded: true }), false, NOW);
  assert.strictEqual(d.state, "idle");
});
T("skip-perms + escaped → idle (not 'still running')", () => {
  const d = displayLiveState(withCli(preToolLive(STALE), { surfaced: true, tool: "Bash", approved: null, turnEnded: true }), true, NOW);
  assert.strictEqual(d.state, "idle");
});
T("agy says the prompt IS up → waiting, labelled with the TRANSCRIPT's tool name", () => {
  const d = displayLiveState(withCli(preToolLive(5000), { surfaced: true, tool: "Bash", approved: null, turnEnded: false }), false, NOW);
  assert.strictEqual(d.state, "waiting");
  // agy's log said "Bash"; the session card must still read the name the rest of the
  // UI uses for that same call, or the two views disagree about what is waiting.
  assert.strictEqual(d.stateDetail, "awaiting approval: call_mcp_tool");
  assert.strictEqual(d.tool, "call_mcp_tool");
});
T("agy's log name is used only when the payload had no tool name at all", () => {
  const noName = { state: "busy", detail: "running a tool", tool: null, event: "PreToolUse", ts: (NOW - 5000) / 1000 };
  const d = displayLiveState(withCli(noName, { surfaced: true, tool: "Bash", approved: null, turnEnded: false }), false, NOW);
  assert.strictEqual(d.stateDetail, "awaiting approval: Bash"); // better than "tool"
  assert.strictEqual(d.tool, null); // but never leaks into a field the UI matches on
});
// forcesApproval is only agy-monitor's GUESS at agy's prompting policy, and it is
// verifiably wrong in both directions — agy prompted on a command the policy rates
// "eligible". Where agy's own log speaks, the guess must not win.
T("agy AUTO-approved it → busy/running even though forcesApproval says otherwise", () => {
  const d = displayLiveState(withCli(runCmdLive(500, true), { surfaced: false, tool: "ReadFile", approved: null, turnEnded: false }), false, NOW);
  assert.strictEqual(d.state, "busy");
});
T("auto-approved AND stale → 'still running', never 'awaiting approval'", () => {
  const d = displayLiveState(withCli(preToolLive(STALE), { surfaced: false, tool: "Bash", approved: null, turnEnded: false }), false, NOW);
  assert.strictEqual(d.state, "busy");
  assert.match(d.stateDetail, /still running/);
});
T("prompt APPROVED and the tool is now executing → busy, not waiting", () => {
  const d = displayLiveState(withCli(preToolLive(STALE), { surfaced: true, tool: "Bash", approved: true, turnEnded: false }), false, NOW);
  assert.strictEqual(d.state, "busy");
});
T("cli present but silent about this step → falls back to the old inference", () => {
  const silent = { surfaced: null, tool: null, approved: null, turnEnded: false };
  assert.strictEqual(displayLiveState(withCli(preToolLive(STALE), silent), false, NOW).state, "waiting");
  assert.strictEqual(displayLiveState(withCli(preToolLive(STALE), silent), true, NOW).state, "busy");
  assert.strictEqual(displayLiveState(withCli(preToolLive(5000), silent), false, NOW).state, "busy");
});
T("evidence never resurrects a non-PreToolUse stale busy into 'needs you'", () => {
  const d = displayLiveState(withCli(postToolLive(STALE), { surfaced: true, tool: "Bash", approved: null, turnEnded: false }), false, NOW);
  assert.strictEqual(d.state, "idle");
  assert.strictEqual(d.stateDetail, "your turn");
});

console.log(`\nPASS state.test (${pass} assertions)`);
