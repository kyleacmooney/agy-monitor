"use strict";
/* fanout-review.test.js — end-to-end review + fan-out against a STUB Claude
   API (local HTTP server standing in for api.anthropic.com; provider forced to
   "anthropic") and a stub agy that writes a real file into its worktree.

   Covers: run-review (diff collection → structured findings → persist →
   dismiss), fanout best-of-N (worktrees created → workers run → diffs staged →
   judge ranks → apply lands the winner's patch in the real workspace →
   worktrees pruned), and fanout-discard. */

const fx = require("./fixtures");
const roots = fx.makeRoots("agy-fanout-test-");
process.env.AGY_MONITOR_ROOT = roots.monRoot;
process.env.AGY_CLI_HOME = roots.agyHome;
process.env.AGY_ANTHROPIC_PROVIDER = "anthropic";
process.env.ANTHROPIC_API_KEY = "test-key";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");

// ---- stub Claude API --------------------------------------------------------
// Answers by sniffing the system prompt: reviewer → findings; judge → ranking.
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const j = JSON.parse(body);
    const system = j.system || "";
    let text;
    if (/code reviewer/i.test(system)) {
      text = JSON.stringify({
        verdict: "changes_suggested",
        summary: "One robustness gap worth fixing.",
        findings: [
          { severity: "warn", file: "hello.js", line: 2, title: "Magic number", explanation: "22 is unexplained.", patch: "- const two = 22;\n+ const two = 2; // restore", fix: "Replace the magic 22 with 2 in hello.js." },
        ],
      });
    } else if (/judge parallel candidate/i.test(system)) {
      text = JSON.stringify({
        summary: "A is correct and smallest.",
        candidates: [
          { label: "A", rank: 1, score: 8.7, verdict: "Correct + simplest." },
          { label: "B", rank: 2, score: 6.1, verdict: "Works, heavier." },
        ],
      });
    } else {
      text = JSON.stringify({ subtasks: [] });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: "claude-opus-4-8",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1000, output_tokens: 200 },
    }));
  });
});

(async () => {
  const failures = [];
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:" + stub.address().port;

  // real git workspace
  const ws = path.join(roots.base, "ws");
  fs.mkdirSync(ws, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", ws, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  fs.writeFileSync(path.join(ws, "hello.js"), "const one = 1;\nconst two = 2;\n");
  git("add", "-A"); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(ws, "hello.js"), "const one = 1;\nconst two = 22;\n");

  // ---- review ---------------------------------------------------------------
  const review = require("../agy-review");
  const r1 = await review.runReview({ workspace: ws, task: "tweak numbers" });
  fx.assert(r1.ok && r1.status === "done", "run-review completes against the stub API", failures);
  fx.assert(r1.verdict === "changes_suggested" && r1.findings.length === 1, "structured findings parsed", failures);
  fx.assert(r1.meta && r1.meta.costUsd > 0 && r1.meta.inTokens === 1000, "usage meta computed", failures);
  const r2 = review.getReview(ws);
  fx.assert(r2.ok && r2.status === "done" && r2.findings.length === 1, "review persists per-workspace", failures);
  const r3 = review.dismissFinding(ws, 0);
  fx.assert(r3.ok && r3.dismissed.includes(0), "finding dismissable", failures);

  // ---- fan-out (best-of-2) --------------------------------------------------
  // Stub agy: each worker writes a label-specific file into its worktree cwd.
  const agyStub = path.join(roots.base, "agy");
  fs.writeFileSync(agyStub, "#!/bin/bash\nsleep 0.3\necho \"worker output $(basename $PWD)\" > from-worker-$(basename $PWD).txt\necho '{\"status\":\"SUCCESS\"}'\n");
  fs.chmodSync(agyStub, 0o755);
  process.env.AGY_GATE_AGY_BIN = agyStub;

  const fanout = require("../agy-fanout");
  const startRes = await fanout.start({ workspace: ws, task: "make the numbers right", strategy: "best", n: 2 }, {});
  fx.assert(startRes.ok, "fanout-start launches (" + (startRes.message || "ok") + ")", failures);
  const id = startRes.id;
  fx.assert(fs.existsSync(path.join(roots.monRoot, "fanout", id, "wA")), "worktree A created", failures);

  // wait for workers → judge → done
  let g = null;
  for (let i = 0; i < 60; i++) {
    await fx.sleep(250);
    const res = await fanout.list(); // list() also lazily finalizes + triggers the judge
    g = (res.groups || []).find((x) => x.id === id);
    if (g && g.status === "done") break;
  }
  fx.assert(g && g.status === "done", "fan-out reaches done (status=" + (g && g.status) + ")", failures);
  fx.assert(g && g.workers.every((w) => w.status === "done" && w.add > 0), "workers finalized with staged diffs", failures);
  fx.assert(g && g.workers.find((w) => w.label === "A").rank === 1, "judge ranking applied to workers", failures);
  fx.assert(g && /A is correct/.test(g.judge.summary), "judge summary recorded", failures);

  const applyRes = await fanout.apply(id, "A");
  fx.assert(applyRes.ok, "apply winner succeeds (" + (applyRes.message || "ok") + ")", failures);
  fx.assert(fs.existsSync(path.join(ws, "from-worker-wA.txt")), "winner's diff landed in the real workspace", failures);
  fx.assert(!fs.existsSync(path.join(ws, "from-worker-wB.txt")), "loser's diff NOT applied", failures);
  fx.assert(!fs.existsSync(path.join(roots.monRoot, "fanout", id, "wA", ".git")), "worktrees pruned after apply", failures);

  // ---- discard path ---------------------------------------------------------
  const s2 = await fanout.start({ workspace: ws, task: "another go", strategy: "best", n: 2 }, {});
  fx.assert(s2.ok, "second fan-out starts", failures);
  const d = await fanout.discard(s2.id);
  fx.assert(d.ok, "discard succeeds", failures);
  const g2 = await fanout.get(s2.id);
  fx.assert(g2.ok && g2.group.status === "discarded", "discarded status recorded", failures);

  stub.close();
  fx.finish(failures, "fanout-review.test");
})().catch((e) => { console.error(e); process.exit(1); });
