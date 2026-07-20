"use strict";
/* classify-args.test.js — the ps-command-line → {mode, prompt} scraper.

   Regression cover for the bug where a live session's sidebar title leaked the
   injected headless-question preamble as "…\012\012[[UI-ASK-RULES]] You are…":
   the -p argument is `userMessage + ASK_RULES`, and BSD `ps` escapes the embedded
   newlines as octal (\012). classifyArgs must decode ps's escaping and strip the
   ASK block so the title shows the user's words. */

const assert = require("assert");
const { classifyArgs, unescapePsArg } = require("./agy-monitor");
const { ASK_RULES } = require("./agy-runs");

let pass = 0;
const T = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

// Simulate how BSD ps renders a string in the args column.
const psEscape = (s) => s
  .replace(/\\/g, "\\\\")
  .replace(/\n/g, "\\012")
  .replace(/\r/g, "\\015")
  .replace(/\t/g, "\\011");

// --- unescapePsArg: single left-to-right pass, \\ before \NNN is honored -------
T("decodes \\012 to a newline", () => {
  assert.strictEqual(unescapePsArg("a\\012b"), "a\nb");
});
T("a literal backslash (\\\\) is not misread as an octal escape", () => {
  // ps emits "\\012" for a real backslash followed by the text 012
  assert.strictEqual(unescapePsArg("x\\\\012y"), "x\\012y");
});
T("no backslashes → returned unchanged (fast path)", () => {
  assert.strictEqual(unescapePsArg("plain text"), "plain text");
});

// --- classifyArgs: mode + a clean prompt --------------------------------------
const argv = (s) => s.split(/\s+/);

T("UI-launched -p strips the [[UI-ASK-RULES]] preamble and octal newlines", () => {
  const realArg = "pls remove it" + ASK_RULES;           // what agy actually receives
  const line = "agy -p " + psEscape(realArg);            // what ps prints
  const { mode, prompt } = classifyArgs(argv(line).slice(1));
  assert.strictEqual(mode, "print");
  assert.strictEqual(prompt, "pls remove it");
});
T("a plain -p prompt (no ASK block) passes through", () => {
  const { mode, prompt } = classifyArgs(argv("agy -p fix the flaky test").slice(1));
  assert.strictEqual(mode, "print");
  assert.strictEqual(prompt, "fix the flaky test");
});
T("interactive session with no -p → null prompt", () => {
  const { mode, prompt } = classifyArgs(argv("agy --conversation abc123").slice(1));
  assert.strictEqual(mode, "resume");
  assert.strictEqual(prompt, null);
});
T("flags are still detected alongside the cleaned prompt", () => {
  const line = "agy -p " + psEscape("do it" + ASK_RULES) + " --dangerously-skip-permissions";
  const { skipPerms, prompt } = classifyArgs(argv(line).slice(1));
  assert.strictEqual(skipPerms, true);
  // the regex is greedy to end-of-line, so trailing flags fold into the prompt text,
  // but the ASK block (and everything after it) is stripped — no preamble leaks.
  assert.ok(!/UI-ASK-RULES/.test(prompt), "no ASK preamble in the title");
  assert.ok(/^do it/.test(prompt), "starts with the user's words");
});

console.log(`\nPASS classify-args.test (${pass} assertions)`);
