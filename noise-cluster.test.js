"use strict";
/* noise-cluster.test.js — folding conversations that open with the same prompt.

   A CLI that shells out to `agy -p` on every commit (or every judge call, or
   every health probe) produces hundreds of conversations whose opening turn is
   identical apart from its payload. They bury every hand-written chat in All
   chats. The fold is deliberately keyed on the FIRST USER PROMPT and nothing
   else: agy's own Title is empty in practice, and its Preview summarizes the
   REPLY — for a commit helper that is the generated message, different every run.

   Rows are tagged, never dropped, so the header count, full-text search and the
   SPEND rollup keep reporting every real, billed conversation. */

const assert = require("assert");
const { promptKey, tagClusters, noiseMinCluster, stripUserRequest } = require("./agy-monitor");

let pass = 0;
const T = (name, fn) => { fn(); pass++; console.log("  ✓ " + name); };

const COMMIT = "Write a concise Git commit message for the following changes. Follow Conventional Commits format if possible...";
const rows = (...prompts) => prompts.map((p, i) => ({ conversationId: "c" + i, firstPrompt: p }));

// --- promptKey: what counts as "the same opening" -----------------------------
T("the same prompt with different whitespace yields one key", () => {
  assert.strictEqual(promptKey(COMMIT), promptKey(COMMIT.replace(/ /g, "\n  ")));
});
T("case does not split a cluster", () => {
  assert.strictEqual(promptKey(COMMIT), promptKey(COMMIT.toUpperCase()));
});
T("the payload after the shared preamble is ignored", () => {
  // A preamble shorter than the 100-char cap lets the diff bleed into what a
  // caller sees — the key must still land entirely inside the shared part.
  const pre = COMMIT.slice(0, 70);
  const a = (pre + " diff --git a/server.js b/server.js").slice(0, 100);
  const b = (pre + " diff --git a/README.md b/README.md").slice(0, 100);
  assert.notStrictEqual(a, b, "the visible text really does differ");
  assert.strictEqual(promptKey(a), promptKey(b));
});
T("this particular prompt is longer than the cap, so no diff ever reaches the key", () => {
  // 111 chars — the producers cap at 100, so every commit run is byte-identical
  // by the time it is keyed. Recorded because it is why the fold is exact here.
  assert.ok(COMMIT.length > 100, "prompt exceeds the 100-char cap");
  assert.strictEqual(COMMIT.slice(0, 100), (COMMIT + " diff --git a/x b/x").slice(0, 100));
});
T("a genuinely different prompt gets a different key", () => {
  assert.notStrictEqual(promptKey(COMMIT), promptKey("Write a concise release note for the following changes."));
});
T("short prompts never cluster, however often they repeat", () => {
  assert.strictEqual(promptKey("hi"), null);
  assert.strictEqual(promptKey("go on"), null);
  assert.strictEqual(promptKey("   "), null);
});
T("non-strings are not keys", () => {
  assert.strictEqual(promptKey(null), null);
  assert.strictEqual(promptKey(undefined), null);
  assert.strictEqual(promptKey(42), null);
});

// --- tagClusters: the threshold, and what it leaves alone ----------------------
T("tags every member at exactly the threshold", () => {
  const r = rows(...Array(5).fill(COMMIT));
  tagClusters(r, 5);
  assert.ok(r.every((x) => x.groupKey === promptKey(COMMIT)), "all five carry the key");
  assert.ok(r.every((x) => x.groupLabel === COMMIT), "…and a human label");
});
T("tags nothing one below the threshold", () => {
  const r = rows(...Array(4).fill(COMMIT));
  tagClusters(r, 5);
  assert.ok(r.every((x) => x.groupKey === undefined), "no key");
  assert.ok(r.every((x) => x.groupLabel === undefined), "no label");
});
T("a repeated prompt never drops a row", () => {
  const r = rows(...Array(9).fill(COMMIT));
  assert.strictEqual(tagClusters(r, 5).length, 9);
});
T("hand-written chats beside a cluster stay untagged", () => {
  const r = rows(...Array(5).fill(COMMIT), "fix the daemon bootstrap race in install.sh");
  tagClusters(r, 5);
  assert.strictEqual(r[5].groupKey, undefined, "the real chat is untouched");
  assert.strictEqual(r[0].groupKey, promptKey(COMMIT));
});
T("two distinct clusters get distinct keys", () => {
  const JUDGE = "You are a safety judge. Classify the following shell command as safe or unsafe.";
  const r = rows(...Array(5).fill(COMMIT), ...Array(5).fill(JUDGE));
  tagClusters(r, 5);
  assert.notStrictEqual(r[0].groupKey, r[5].groupKey);
  assert.strictEqual(new Set(r.map((x) => x.groupKey)).size, 2);
});
T("a repeated SHORT prompt is never folded even past the threshold", () => {
  const r = rows(...Array(20).fill("hi"));
  tagClusters(r, 5);
  assert.ok(r.every((x) => x.groupKey === undefined), "\"hi\" x20 stays unfolded");
});
T("threshold 0 disables folding entirely", () => {
  const r = rows(...Array(20).fill(COMMIT));
  tagClusters(r, 0);
  assert.ok(r.every((x) => x.groupKey === undefined));
});
T("rows with no prompt at all are safe to tag", () => {
  const r = [{ firstPrompt: null }, { firstPrompt: undefined }, {}, null];
  assert.doesNotThrow(() => tagClusters(r, 5));
});
T("the label is the prompt, not any row's agy-generated title", () => {
  const r = rows(...Array(5).fill(COMMIT));
  r.forEach((x, i) => { x.title = "fix(server): thing number " + i; }); // agy's Preview of the REPLY
  tagClusters(r, 5);
  assert.strictEqual(r[0].groupLabel, COMMIT);
});

// --- AGY_NOISE_MIN_CLUSTER parsing --------------------------------------------
// config.json values arrive as strings (agy-config sets process.env[k] = String(v)),
// so a blank entry must read as "unset" and not as the documented 0 = "off".
T("the threshold defaults to 5 when unset, blank or unparseable", () => {
  const saved = process.env.AGY_NOISE_MIN_CLUSTER;
  try {
    for (const v of [undefined, "", "   ", "abc", "-1", "NaN"]) {
      if (v === undefined) delete process.env.AGY_NOISE_MIN_CLUSTER;
      else process.env.AGY_NOISE_MIN_CLUSTER = v;
      assert.strictEqual(noiseMinCluster(), 5, `value ${JSON.stringify(v)} → default`);
    }
    process.env.AGY_NOISE_MIN_CLUSTER = "0";
    assert.strictEqual(noiseMinCluster(), 0, "an explicit 0 disables folding");
    process.env.AGY_NOISE_MIN_CLUSTER = "12";
    assert.strictEqual(noiseMinCluster(), 12);
    process.env.AGY_NOISE_MIN_CLUSTER = "2.7";
    assert.strictEqual(noiseMinCluster(), 2, "fractional values floor");
  } finally {
    if (saved === undefined) delete process.env.AGY_NOISE_MIN_CLUSTER;
    else process.env.AGY_NOISE_MIN_CLUSTER = saved;
  }
});
T("the default threshold is what tagClusters uses when none is passed", () => {
  const saved = process.env.AGY_NOISE_MIN_CLUSTER;
  delete process.env.AGY_NOISE_MIN_CLUSTER;
  try {
    const four = rows(...Array(4).fill(COMMIT));
    tagClusters(four);
    assert.ok(four.every((x) => x.groupKey === undefined), "4 is below the default");
    const five = rows(...Array(5).fill(COMMIT));
    tagClusters(five);
    assert.ok(five.every((x) => x.groupKey), "5 reaches it");
  } finally {
    if (saved !== undefined) process.env.AGY_NOISE_MIN_CLUSTER = saved;
  }
});

// --- stripUserRequest: the truncated-head path the fold depends on -------------
// A commit helper sends "prompt + whole diff" as ONE JSON line, so a bounded read
// can hand us an opening <USER_REQUEST> with no closing tag. That must not leak
// the literal tag into the title — it would key its own one-row "cluster".
T("an unterminated <USER_REQUEST> yields the prompt, not the tag", () => {
  const t = stripUserRequest("<USER_REQUEST> " + COMMIT + " diff --git a/x b/x\n+lorem");
  assert.ok(!/USER_REQUEST/.test(t), "no tag in the text");
  assert.ok(t.startsWith("Write a concise Git commit message"), "starts with the prompt");
});
T("a normal wrapped request is unaffected", () => {
  assert.strictEqual(stripUserRequest("<USER_REQUEST> hello agy </USER_REQUEST>"), "hello agy");
});
// The salvage branch is anchored to the START of the content. An unwrapped prompt
// reaches this function too (classifyArgs scrapes a live `agy -p` command line for
// the sidebar title), and a prompt that merely MENTIONS the tag must keep the
// words before it — and must still have its trailing metadata blocks stripped.
T("a prompt that merely mentions the tag keeps everything before it", () => {
  assert.strictEqual(
    stripUserRequest("explain how the <USER_REQUEST> wrapper is stripped"),
    "explain how the <USER_REQUEST> wrapper is stripped");
});
T("an unwrapped prompt still loses its trailing metadata blocks", () => {
  assert.strictEqual(
    stripUserRequest("do a thing <ADDITIONAL_METADATA>cwd=/secret</ADDITIONAL_METADATA>"),
    "do a thing");
  assert.strictEqual(
    stripUserRequest("do a thing <USER_REQUEST> now <ADDITIONAL_METADATA>cwd=/secret</ADDITIONAL_METADATA>")
      .includes("/secret"), false, "…even when the tag appears mid-prompt");
});
T("a truncated head and a complete record cluster together", () => {
  const whole = stripUserRequest("<USER_REQUEST> " + COMMIT + " diff </USER_REQUEST>").replace(/\s+/g, " ").slice(0, 100);
  const cut = stripUserRequest("<USER_REQUEST> " + COMMIT + " diff --git").replace(/\s+/g, " ").slice(0, 100);
  assert.strictEqual(promptKey(whole), promptKey(cut));
});

console.log(`\nPASS noise-cluster.test (${pass} assertions)`);
