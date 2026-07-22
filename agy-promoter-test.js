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

  // ---- listRules: per-rule usage attribution ------------------------------
  console.log("\n# listRules uses");
  const fired = (over) => row(Object.assign({ stage: "safelist-allow", outcome: "safelist-allow", classifier: null }, over));

  test("uses counts only the rows the safelist itself let through, per rule", () => {
    const root = freshRoot(); settingsWith(["command(git diff)", "command(wc)"]);
    writeDecisions(root, [
      fired({ atoms: ["git diff"] }),
      fired({ atoms: ["git diff"] }),
      fired({ atoms: ["wc"] }),
      // a manual approval is NOT the safelist firing — the human did the work
      row({ atoms: ["git diff"], stage: "manual", outcome: "manual-approve" }),
    ]);
    const r = P.listRules();
    assert.ok(r.ok && r.usesKnown, "usesKnown once safelist-allow rows exist");
    const by = (rule) => r.rules.find((x) => x.rule === rule);
    assert.strictEqual(by("command(git diff)").uses, 2, "two safelist-allow rows, not three");
    assert.strictEqual(by("command(wc)").uses, 1);
  });

  test("a compound row credits every rule that covered one of its atoms", () => {
    const root = freshRoot(); settingsWith(["command(git log)", "command(wc)", "command(sort)"]);
    writeDecisions(root, [fired({ command: "git log | wc -l", atoms: ["git log", "wc"] })]);
    const r = P.listRules();
    const by = (rule) => r.rules.find((x) => x.rule === rule).uses;
    assert.strictEqual(by("command(git log)"), 1);
    assert.strictEqual(by("command(wc)"), 1, "both atoms' rules are credited");
    assert.strictEqual(by("command(sort)"), 0, "an uninvolved rule is not");
  });

  test("prefix and wildcard rules use the gate's own matcher", () => {
    const root = freshRoot(); settingsWith(["command(git)", "command(*)"]);
    writeDecisions(root, [fired({ atoms: ["git push --force"] })]);
    const r = P.listRules();
    const by = (rule) => r.rules.find((x) => x.rule === rule).uses;
    assert.strictEqual(by("command(git)"), 1, "space-prefix match counts");
    assert.strictEqual(by("command(*)"), 1, "the wildcard matches everything");
  });

  test("logSpansWindow is false for a log younger than the window", () => {
    const root = freshRoot(); settingsWith(["command(git diff)", "command(wc)"]);
    writeDecisions(root, [fired({ atoms: ["git diff"], ts: ago(2 * 60 * 60 * 1000) })]);
    const r = P.listRules();
    assert.ok(r.usesKnown, "we do have data");
    assert.strictEqual(r.logSpansWindow, false, "…but not 30 days of it, so nothing may be called dead");
  });

  test("logSpansWindow is true once the log reaches back the full window", () => {
    const root = freshRoot(); settingsWith(["command(git diff)"]);
    writeDecisions(root, [
      fired({ atoms: ["git diff"] }),
      row({ atoms: ["x"], ts: ago(31 * 24 * 60 * 60 * 1000) }),   // outside the window, but proves reach
      row({ atoms: ["y"], ts: ago(29.5 * 24 * 60 * 60 * 1000) }), // oldest row still inside it
    ]);
    assert.strictEqual(P.listRules().logSpansWindow, true);
  });

  test("one row with a mangled ts does not pin logSpansWindow false", () => {
    const root = freshRoot(); settingsWith(["command(git diff)"]);
    writeDecisions(root, [
      fired({ atoms: ["git diff"] }),
      row({ atoms: ["y"], ts: ago(29.5 * 24 * 60 * 60 * 1000) }), // genuinely old — proves reach
    ]);
    // readDecisions KEEPS a row whose ts doesn't parse (NaN skips the window filter)
    // and sorts it to the very end — the exact slot the old code read on faith, so a
    // single torn row froze `spans` at false for as long as it stayed in the month file
    const monthFile = path.join(root, "decisions", new Date().toISOString().slice(0, 7) + ".jsonl");
    fs.appendFileSync(monthFile, JSON.stringify(row({ atoms: ["bad"], ts: "not-a-date" })) + "\n");
    assert.strictEqual(P.listRules().logSpansWindow, true,
      "the oldest PARSEABLE row decides; a mangled ts is skipped, not fatal");
  });

  test("a 1-day window still demands real reach before branding rules dead", () => {
    process.env.AGY_PROMOTER_WINDOW_DAYS = "1";
    try {
      const root = freshRoot(); settingsWith(["command(git diff)"]);
      // (days-1)*DAY_MS degenerates to 0 at days=1 — a 2-hour-old log must NOT span
      writeDecisions(root, [fired({ atoms: ["git diff"], ts: ago(2 * 60 * 60 * 1000) })]);
      assert.strictEqual(P.listRules().logSpansWindow, false, "a 2h-old log does not span a 1-day window");
      writeDecisions(root, [row({ atoms: ["old"], ts: ago(14 * 60 * 60 * 1000) })]);
      assert.strictEqual(P.listRules().logSpansWindow, true, "14h (> half the window) does");
    } finally {
      process.env.AGY_PROMOTER_WINDOW_DAYS = "30";
    }
  });

  test("usesKnown is false when the log holds no safelist-allow rows at all", () => {
    const root = freshRoot(); settingsWith(["command(git diff)"]);
    writeDecisions(root, [row({ atoms: ["git diff"] })]); // classifier-auto-allow only
    const r = P.listRules();
    assert.strictEqual(r.usesKnown, false, "0 must not be presented as 'this rule is dead'");
    assert.strictEqual(r.rules[0].uses, 0);
  });

  test("listRules exposes the promotion timestamp so a new rule isn't called unused", () => {
    freshRoot(); settingsWith([]);
    P.promoteRule("git diff");
    const r = P.listRules();
    assert.ok(r.rules[0].promoted, "promoted flag survives");
    assert.ok(r.rules[0].promotedTs && !Number.isNaN(Date.parse(r.rules[0].promotedTs)), "with a parseable ts");
  });

  // ---- restoreRule (undo a demote) ----------------------------------------
  console.log("\n# restoreRule");
  test("restores a single-token rule that promoteRule would refuse to create", () => {
    freshRoot();
    const file = settingsWith(["command(wc)"]);
    assert.ok(P.demoteRule("command(wc)").ok);
    assert.ok(!P.promoteRule("wc").ok, "promote still refuses a bare single binary (the veto is intact)");
    const res = P.restoreRule("command(wc)");
    assert.ok(res.ok, "restore does not re-veto: " + (res.message || ""));
    const allow = JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow;
    assert.ok(allow.includes("command(wc)"), "the rule is back in permissions.allow");
  });

  test("restore writes a backup and records the restoration", () => {
    const root = freshRoot();
    const file = settingsWith(["command(git log)"]);
    P.demoteRule("command(git log)");
    const res = P.restoreRule("command(git log)");
    assert.ok(res.backup && fs.existsSync(res.backup), "settings.json backed up before the write");
    const state = JSON.parse(fs.readFileSync(path.join(root, "promoter-state.json"), "utf8"));
    assert.ok(Array.isArray(state.restorations) && state.restorations.length === 1, "audit trail written");
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow.filter((x) => x === "command(git log)").length, 1);
  });

  test("restoring twice never duplicates the rule", () => {
    freshRoot(); const file = settingsWith(["command(head)"]);
    P.demoteRule("command(head)");
    assert.ok(P.restoreRule("command(head)").ok);
    assert.ok(!P.restoreRule("command(head)").ok, "the ledger entry was consumed by the first undo");
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow.filter((x) => x === "command(head)").length, 1);
  });

  test("restore is a no-op when the rule is already back by other means", () => {
    freshRoot(); const file = settingsWith(["command(head)"]);
    P.demoteRule("command(head)");
    // the user re-added it by hand before clicking Undo
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ["command(head)"] } }, null, 2));
    const res = P.restoreRule("command(head)");
    assert.ok(res.ok && res.alreadyAllowed, "reports already-present rather than duplicating");
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow.length, 1);
  });

  test("restore preserves a non-command() rule verbatim", () => {
    freshRoot(); const file = settingsWith(["mcp__playwright__browser_click"]);
    P.demoteRule("mcp__playwright__browser_click");
    assert.ok(P.restoreRule("mcp__playwright__browser_click").ok);
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow.includes("mcp__playwright__browser_click"));
  });

  test("restore rejects an empty rule", () => {
    freshRoot(); settingsWith([]);
    assert.ok(!P.restoreRule("").ok);
    assert.ok(!P.restoreRule(null).ok);
  });

  // Undo must not become a way around the veto that promoteRule enforces.
  test("restore refuses a rule this dashboard never removed", () => {
    freshRoot(); const file = settingsWith([]);
    const res = P.restoreRule("command(*)");
    assert.ok(!res.ok, "an arbitrary rule cannot be injected via restore");
    assert.ok(/not removed/.test(res.message || ""), "and it says why: " + res.message);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow, [], "settings untouched");
  });

  test("restore refuses command(*) even if it really was demoted", () => {
    freshRoot(); const file = settingsWith(["command(*)"]);
    assert.ok(P.demoteRule("command(*)").ok);
    const res = P.restoreRule("command(*)");
    assert.ok(!res.ok, "undo must not help put the gate-disabling rule back");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow, []);
  });

  test("one removal buys exactly one undo", () => {
    freshRoot(); const file = settingsWith(["command(git log)"]);
    P.demoteRule("command(git log)");
    assert.ok(P.restoreRule("command(git log)").ok);
    P.demoteRule("command(git log)");                 // removed again, by hand this time
    assert.ok(P.restoreRule("command(git log)").ok, "a fresh demote grants a fresh undo");
    // but a stale ledger entry cannot be replayed once consumed
    const allow = JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow;
    assert.deepStrictEqual(allow, ["command(git log)"]);
  });

  test("restore refuses to overwrite a settings.json it cannot parse", () => {
    freshRoot();
    const file = settingsWith(["command(wc)"]);
    P.demoteRule("command(wc)");
    fs.writeFileSync(file, '{"model":"x","permissions":{"deny":["command(rm)"]},,,BROKEN');
    const res = P.restoreRule("command(wc)");
    assert.ok(!res.ok, "a corrupt settings.json must not be silently replaced");
    assert.ok(/not readable JSON/.test(res.message || ""), res.message);
    assert.ok(/BROKEN/.test(fs.readFileSync(file, "utf8")), "the user's file is left exactly as it was");
  });

  test("restore only re-adds the exact string that was demoted", () => {
    freshRoot(); const file = settingsWith(["command(git log)"]);
    P.demoteRule("command(git log)");
    assert.ok(!P.restoreRule("command(git)").ok, "a WIDER neighbour of the demoted rule is refused");
    assert.ok(P.restoreRule("command(git log)").ok);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow, ["command(git log)"]);
  });

  // Same hazard as the restore case above, on the path that is FAR more travelled —
  // Promote is one click from the candidates list. readJsonSafe returns null for both
  // "missing" and "unparseable", and promote used to rebuild `{}` from either, which
  // silently discarded permissions.DENY along with every other key in the file.
  test("promote refuses to overwrite a settings.json it cannot parse", () => {
    freshRoot();
    const file = settingsWith(["command(wc)"]);
    fs.writeFileSync(file, '{"model":"x","permissions":{"deny":["command(rm)"],"allow":["command(wc)"]},,,BROKEN');
    const res = P.promoteRule("git diff");
    assert.ok(!res.ok, "a corrupt settings.json must not be silently replaced");
    assert.ok(/not readable JSON/.test(res.message || ""), res.message);
    const after = fs.readFileSync(file, "utf8");
    assert.ok(/BROKEN/.test(after), "the user's file is left exactly as it was");
    assert.ok(/command\(rm\)/.test(after), "permissions.deny survives");
  });

  // The ledger is what lets restore skip the promotion veto, so an entry must be
  // scoped to the file the rule actually came out of — otherwise demoting from a
  // scratch settings file licenses an unvetted append into the real one once
  // AGY_GATE_SETTINGS is repointed.
  test("a demotion recorded against one settings file cannot restore into another", () => {
    freshRoot();
    settingsWith(["command(sudo systemctl)"]);            // file A
    P.demoteRule("command(sudo systemctl)");              // ledger entry names file A
    const fileB = settingsWith(["command(git log)"]);     // repoint at file B
    const res = P.restoreRule("command(sudo systemctl)");
    assert.ok(!res.ok, "the ledger entry is for a different file");
    assert.ok(/not removed from this dashboard/.test(res.message || ""), res.message);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(fileB, "utf8")).permissions.allow,
      ["command(git log)"], "file B untouched");
  });

  test("…and the undo still works once pointed back at the original file", () => {
    freshRoot();
    const fileA = settingsWith(["command(wc)"]);
    P.demoteRule("command(wc)");
    settingsWith(["command(git log)"]);                   // away…
    process.env.AGY_GATE_SETTINGS = fileA;                // …and back
    assert.ok(P.restoreRule("command(wc)").ok);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(fileA, "utf8")).permissions.allow, ["command(wc)"]);
  });

  test("consuming an undo only spends THIS file's ledger entry", () => {
    freshRoot();
    const fileA = settingsWith(["command(head)"]);
    P.demoteRule("command(head)");
    const fileB = settingsWith(["command(head)"]);        // same rule, different file
    P.demoteRule("command(head)");
    assert.ok(P.restoreRule("command(head)").ok, "restores into file B");
    process.env.AGY_GATE_SETTINGS = fileA;
    assert.ok(P.restoreRule("command(head)").ok, "file A's own entry is still unspent");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(fileA, "utf8")).permissions.allow, ["command(head)"]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(fileB, "utf8")).permissions.allow, ["command(head)"]);
  });

  test("promote still creates settings.json when it is genuinely absent", () => {
    const root = freshRoot();
    // the guard keys on existsSync, so the never-created case must stay working
    const file = path.join(root, "nested", "settings.json");
    process.env.AGY_GATE_SETTINGS = file;
    assert.ok(!fs.existsSync(file), "precondition: no settings file");
    const res = P.promoteRule("git diff");
    assert.ok(res.ok, res.message);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow, ["command(git diff)"]);
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
