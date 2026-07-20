#!/usr/bin/env node
"use strict";
/*
 * agy-promoter-test — hermetic tests for the safelist promoter.
 *
 *   node agy-promoter-test.js
 *
 * Covers §8-G (golden derivation/veto), aggregation & scoring (§6.2), the fail-closed veto (§6.3),
 * promotion writing settings.json + a timestamped backup (§6.5), and snooze/reject persistence.
 * Fully hermetic: a temp AGY_MONITOR_ROOT + AGY_GATE_SETTINGS per test; the promoter reads env at
 * call time. Thresholds are lowered via env so tests stay small (N=3 approvals, ≥2 conversations).
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const P = require("./agy-promoter.js");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agy-promoter-test-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// Small, fixed thresholds so a handful of rows is enough to cross candidacy.
process.env.AGY_PROMOTER_MIN_COUNT = "3";
process.env.AGY_PROMOTER_MIN_CONVERSATIONS = "2";
process.env.AGY_PROMOTER_WINDOW_DAYS = "30";
delete process.env.AGY_PROMOTER_SNOOZE_MS; // use the real 7-day default

let pass = 0, fail = 0, n = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n         " + (e && e.message ? e.message : e)); }
}

function freshRoot() {
  const r = fs.mkdtempSync(path.join(TMP, "root-"));
  process.env.AGY_MONITOR_ROOT = r;
  return r;
}
function settingsWith(allow) {
  const p = path.join(TMP, `settings-${n++}.json`);
  fs.writeFileSync(p, JSON.stringify({ permissions: { allow } }, null, 2));
  process.env.AGY_GATE_SETTINGS = p;
  return p;
}
function ago(ms) { return new Date(Date.now() - ms).toISOString(); }

// A decision-log row shaped exactly like agy-gate.js writes; override any field per test.
function row(over) {
  return Object.assign({
    ts: new Date().toISOString(),
    conversationId: "conv-a", session: null,
    command: "git diff HEAD~1", cwd: "/repo", intent: "(none provided)",
    atoms: ["git diff"], disposition: "eligible",
    stage: "classifier-auto-allow", outcome: "classifier-auto-allow",
    decision: "allow", reason: null,
    classifier: { decision: "allow", risk: "none", confidence: "high", categories: [], source: "llm" },
    durationMs: 100,
  }, over || {});
}
function writeDecisions(root, rows) {
  const dir = path.join(root, "decisions");
  fs.mkdirSync(dir, { recursive: true });
  const byMonth = {};
  for (const r of rows) { const m = new Date(r.ts).toISOString().slice(0, 7); (byMonth[m] = byMonth[m] || []).push(r); }
  for (const m of Object.keys(byMonth)) {
    fs.appendFileSync(path.join(dir, m + ".jsonl"), byMonth[m].map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
}
function candByAtom(res, atom) { return (res.candidates || []).find((c) => c.atom === atom); }

function main() {
  // ---- aggregation & scoring (§6.2) --------------------------------------
  console.log("\n# aggregation & scoring");
  test("N approvals across ≥2 conversations → surfaces as a candidate", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [
      row({ conversationId: "a", command: "git diff HEAD~1" }),
      row({ conversationId: "a", command: "git diff --stat" }),
      row({ conversationId: "b", command: "git diff src/x.js" }),
    ]);
    const c = candByAtom(P.listCandidates(), "git diff");
    assert.ok(c, "git diff should be a candidate");
    assert.strictEqual(c.count, 3);
    assert.ok(c.examples.length <= 3 && c.examples.length >= 1, "keeps ≤3 examples");
    assert.strictEqual(c.alreadyAllowed, false);
  });
  test("< N approvals does NOT surface", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [row({ conversationId: "a" }), row({ conversationId: "b" })]); // only 2 (<3)
    assert.ok(!candByAtom(P.listCandidates(), "git diff"), "should not surface with 2 approvals");
  });
  test("< 2 distinct conversations does NOT surface (one-off automation guard)", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [row({ conversationId: "a" }), row({ conversationId: "a" }), row({ conversationId: "a" })]);
    assert.ok(!candByAtom(P.listCandidates(), "git diff"), "single-conversation atom must not surface");
  });
  test("a single deny POISONS the atom (never a candidate)", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [
      row({ conversationId: "a" }), row({ conversationId: "b" }), row({ conversationId: "c" }),
      row({ conversationId: "d", outcome: "manual-deny", stage: "manual", decision: "deny", reason: "denied from dashboard", classifier: { decision: "defer", risk: "low", confidence: "med", categories: [], source: "llm" } }),
    ]);
    assert.ok(!candByAtom(P.listCandidates(), "git diff"), "one deny should poison the atom");
  });
  test("a manual timeout is NEUTRAL (does not count, does not poison)", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [
      row({ conversationId: "a" }), row({ conversationId: "b" }),
      row({ conversationId: "c", outcome: "manual-timeout", stage: "manual", decision: "deny", reason: "approval timed out" }),
    ]);
    // 2 positives + 1 timeout = still < N (3) and NOT poisoned; adding one more positive surfaces it.
    assert.ok(!candByAtom(P.listCandidates(), "git diff"), "timeout must not count toward N");
    writeDecisions(root, [row({ conversationId: "c" })]);
    assert.ok(candByAtom(P.listCandidates(), "git diff"), "timeout must not have poisoned the atom");
  });
  test("manual-approve counts only when classifier rated it low/none", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [
      // policy force-defer (classifier null) manual approvals must NOT inflate the count
      row({ atoms: ["docker ps"], command: "docker ps -a", conversationId: "a", outcome: "manual-approve", stage: "manual", classifier: null }),
      row({ atoms: ["docker ps"], command: "docker ps",    conversationId: "b", outcome: "manual-approve", stage: "manual", classifier: null }),
      row({ atoms: ["docker ps"], command: "docker ps -q", conversationId: "c", outcome: "manual-approve", stage: "manual", classifier: null }),
    ]);
    assert.ok(!candByAtom(P.listCandidates(), "docker ps"), "null-classifier approvals must not count");
    // the same atom, now with low-risk classifier approvals, DOES surface
    writeDecisions(root, [
      row({ atoms: ["docker ps"], command: "docker ps -a", conversationId: "a", outcome: "manual-approve", stage: "manual", classifier: { decision: "defer", risk: "low", confidence: "med", categories: [], source: "llm" } }),
      row({ atoms: ["docker ps"], command: "docker ps",    conversationId: "b", outcome: "manual-approve", stage: "manual", classifier: { decision: "defer", risk: "low", confidence: "med", categories: [], source: "llm" } }),
      row({ atoms: ["docker ps"], command: "docker ps -q", conversationId: "c", outcome: "manual-approve", stage: "manual", classifier: { decision: "defer", risk: "none", confidence: "med", categories: [], source: "llm" } }),
    ]);
    assert.ok(candByAtom(P.listCandidates(), "docker ps"), "low/none classifier approvals should count");
  });

  // ---- §6.3 fail-closed veto ---------------------------------------------
  console.log("\n# fail-closed veto (§6.3)");
  test("bare single-binary atoms are NEVER candidates (git/ls), even with many approvals", () => {
    const root = freshRoot(); settingsWith([]);
    for (const atom of ["git", "ls"]) {
      writeDecisions(root, [
        row({ atoms: [atom], command: atom + " x", conversationId: "a" }),
        row({ atoms: [atom], command: atom + " y", conversationId: "b" }),
        row({ atoms: [atom], command: atom + " z", conversationId: "c" }),
      ]);
    }
    const res = P.listCandidates();
    assert.ok(!candByAtom(res, "git"), "bare git must be vetoed (would auto-allow git push)");
    assert.ok(!candByAtom(res, "ls"), "bare single binary must be vetoed");
  });
  test("policy-danger atoms are vetoed even if the log has positive rows for them", () => {
    const root = freshRoot(); settingsWith([]);
    for (const atom of ["git push", "npm run test", "rm build"]) {
      writeDecisions(root, [
        row({ atoms: [atom], command: atom, conversationId: "a", classifier: { decision: "defer", risk: "low", confidence: "med", categories: [], source: "llm" }, outcome: "manual-approve", stage: "manual" }),
        row({ atoms: [atom], command: atom, conversationId: "b", classifier: { decision: "defer", risk: "low", confidence: "med", categories: [], source: "llm" }, outcome: "manual-approve", stage: "manual" }),
        row({ atoms: [atom], command: atom, conversationId: "c", classifier: { decision: "defer", risk: "low", confidence: "med", categories: [], source: "llm" }, outcome: "manual-approve", stage: "manual" }),
      ]);
    }
    const res = P.listCandidates();
    for (const atom of ["git push", "npm run test", "rm build"]) {
      assert.ok(!candByAtom(res, atom), atom + " must be vetoed by policy");
    }
  });
  test("word boundary: git diff is a candidate but gitleaks is a distinct atom", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [
      row({ atoms: ["git diff"], conversationId: "a" }), row({ atoms: ["git diff"], conversationId: "b" }), row({ atoms: ["git diff"], conversationId: "c" }),
      row({ atoms: ["gitleaks detect"], command: "gitleaks detect", conversationId: "a" }), row({ atoms: ["gitleaks detect"], command: "gitleaks detect", conversationId: "b" }), row({ atoms: ["gitleaks detect"], command: "gitleaks detect", conversationId: "c" }),
    ]);
    const res = P.listCandidates();
    assert.ok(candByAtom(res, "git diff"), "git diff surfaces");
    assert.ok(!candByAtom(res, "git"), "never a bare git");
    // gitleaks detect is its own atom, clearly distinct from git — proves prefix isn't greedy.
    assert.ok(candByAtom(res, "gitleaks detect"), "gitleaks detect is a separate candidate");
  });

  // ---- promotion writes settings + backup (§6.5) -------------------------
  console.log("\n# promoteRule");
  test("promote writes command(atom) into permissions.allow AND a timestamped backup", () => {
    freshRoot();
    const sfile = settingsWith(["command(ls)"]);
    const r = P.promoteRule("git diff");
    assert.ok(r.ok && r.rule === "command(git diff)", JSON.stringify(r));
    const after = JSON.parse(fs.readFileSync(sfile, "utf8"));
    assert.deepStrictEqual(after.permissions.allow, ["command(ls)", "command(git diff)"]);
    assert.ok(r.backup && fs.existsSync(r.backup), "a .backup copy must exist: " + r.backup);
    assert.ok(/\.backup$/.test(r.backup), "backup uses the .backup extension");
    const backupJson = JSON.parse(fs.readFileSync(r.backup, "utf8"));
    assert.deepStrictEqual(backupJson.permissions.allow, ["command(ls)"], "backup holds the PRE-promotion state");
  });
  test("promote records an audit entry in promoter-state.json", () => {
    const root = freshRoot(); settingsWith([]);
    P.promoteRule("kubectl get");
    const state = JSON.parse(fs.readFileSync(path.join(root, "promoter-state.json"), "utf8"));
    assert.ok(Array.isArray(state.promotions) && state.promotions.length === 1);
    assert.strictEqual(state.promotions[0].rule, "command(kubectl get)");
    assert.ok(state.promotions[0].ts, "promotion is timestamped");
  });
  test("promote refuses veto-class atoms and leaves settings untouched", () => {
    freshRoot();
    const sfile = settingsWith(["command(ls)"]);
    for (const bad of ["git push", "rm", "git", "curl example.com", "ls > x"]) {
      const r = P.promoteRule(bad);
      assert.ok(!r.ok, bad + " must be refused: " + JSON.stringify(r));
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(sfile, "utf8")).permissions.allow, ["command(ls)"], "settings must be unchanged");
  });
  test("promote is idempotent: already-covered atom is a no-op (no dup, no backup)", () => {
    freshRoot();
    const sfile = settingsWith(["command(git diff)"]);
    const r = P.promoteRule("git diff");
    assert.ok(r.ok && r.alreadyAllowed === true, JSON.stringify(r));
    assert.ok(!r.backup, "no backup when nothing changes");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(sfile, "utf8")).permissions.allow, ["command(git diff)"]);
  });
  test("promote creates settings.json when it does not exist yet", () => {
    freshRoot();
    const sfile = path.join(TMP, `settings-missing-${n++}.json`);
    process.env.AGY_GATE_SETTINGS = sfile; // does not exist
    const r = P.promoteRule("git diff");
    assert.ok(r.ok && r.backup === null, "no backup for a missing file: " + JSON.stringify(r));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(sfile, "utf8")).permissions.allow, ["command(git diff)"]);
  });

  // ---- snooze / reject persistence ---------------------------------------
  console.log("\n# snooze / reject");
  test("snooze hides a candidate and persists to promoter-state.json", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [row({ conversationId: "a" }), row({ conversationId: "b" }), row({ conversationId: "c" })]);
    assert.ok(candByAtom(P.listCandidates(), "git diff"), "precondition: candidate present");
    const r = P.snoozeRule("git diff");
    assert.ok(r.ok && r.snoozedUntil, JSON.stringify(r));
    assert.ok(!candByAtom(P.listCandidates(), "git diff"), "snoozed atom must be hidden");
    const state = JSON.parse(fs.readFileSync(path.join(root, "promoter-state.json"), "utf8"));
    assert.ok(state.snoozed && state.snoozed["git diff"], "snooze persisted");
  });
  test("reject permanently blocklists a candidate", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [row({ atoms: ["kubectl get"], command: "kubectl get pods", conversationId: "a" }), row({ atoms: ["kubectl get"], command: "kubectl get svc", conversationId: "b" }), row({ atoms: ["kubectl get"], command: "kubectl get ns", conversationId: "c" })]);
    assert.ok(candByAtom(P.listCandidates(), "kubectl get"), "precondition: candidate present");
    P.rejectRule("kubectl get");
    assert.ok(!candByAtom(P.listCandidates(), "kubectl get"), "rejected atom must be hidden");
    const state = JSON.parse(fs.readFileSync(path.join(root, "promoter-state.json"), "utf8"));
    assert.ok(state.rejected && state.rejected["kubectl get"], "reject persisted");
  });
  test("expired snooze re-surfaces the candidate (SNOOZE_MS small)", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [row({ conversationId: "a" }), row({ conversationId: "b" }), row({ conversationId: "c" })]);
    process.env.AGY_PROMOTER_SNOOZE_MS = "1"; // 1ms window
    P.snoozeRule("git diff");
    const t = Date.now(); while (Date.now() - t < 5) { /* let the 1ms snooze lapse */ }
    assert.ok(candByAtom(P.listCandidates(), "git diff"), "an expired snooze should re-surface the atom");
    delete process.env.AGY_PROMOTER_SNOOZE_MS;
  });

  // ---- listDecisions ------------------------------------------------------
  console.log("\n# listDecisions");
  test("listDecisions returns rows newest-first within the window and drops older rows", () => {
    const root = freshRoot(); settingsWith([]);
    writeDecisions(root, [
      row({ command: "newest", ts: ago(1 * 60 * 1000) }),
      row({ command: "middle", ts: ago(60 * 60 * 1000) }),
      row({ command: "old-10d", ts: ago(10 * 24 * 60 * 60 * 1000) }), // outside a 7-day window
    ]);
    const r = P.listDecisions(7);
    assert.ok(r.ok && r.days === 7);
    assert.strictEqual(r.decisions[0].command, "newest", "newest first");
    assert.ok(!r.decisions.some((d) => d.command === "old-10d"), "rows older than the window are dropped");
    // a wider window includes the old row
    assert.ok(P.listDecisions(30).decisions.some((d) => d.command === "old-10d"), "30-day window includes it");
  });
  test("listDecisions defaults to 7 days on bad input", () => {
    freshRoot(); settingsWith([]);
    assert.strictEqual(P.listDecisions(undefined).days, 7);
    assert.strictEqual(P.listDecisions(-5).days, 7);
    assert.strictEqual(P.listDecisions("abc").days, 7);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
