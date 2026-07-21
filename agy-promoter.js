#!/usr/bin/env node
"use strict";
/*
 * agy-promoter — the safelist LEARNING / REVIEW loop.
 *
 * Turns the decision log written by agy-gate.js into safe, MINIMAL Claude-Code-style
 * prefixes a human can one-click add to agy's `permissions.allow`. It only ever SUGGESTS —
 * promotion is always human-gated (never auto). The dispatch in agy-monitor.js is wired to:
 *
 *   listDecisions(days)  -> { ok, days, decisions:[row, ...] }   newest-first, from decisions/*.jsonl
 *   listCandidates()     -> { ok, candidates:[{atom,count,lastTs,examples,alreadyAllowed}, ...] }
 *   promoteRule(atom)    -> { ok, atom, rule, backup, alreadyAllowed } | { ok:false, message }
 *   snoozeRule(atom)     -> { ok, atom, snoozedUntil }            temporary hide
 *   rejectRule(atom)     -> { ok, atom, rejected }                permanent blocklist
 *
 * SAFETY (single source of truth, no drift): every veto reuses agy-policy.screen() and its exported
 * tables — what gets AUTO-ALLOWED (agy-gate.js) and what gets PROMOTED can never diverge. We NEVER
 * promote a deny-class or defer-forced atom, and NEVER a bare single-binary token (promoting bare
 * `git` would auto-allow `git push --force`; that is the exact §6.1 trap). The command text and any
 * example commands come from the log; we screen the ATOM, and re-screen defensively on promotion.
 *
 * All state (snooze/reject/promotions) lives in <AGY_MONITOR_ROOT>/promoter-state.json. Paths and
 * tunables read process.env at CALL time (never module-load) so the host and tests stay hermetic.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const policy = require("./agy-policy.js");

// ---- env-aware paths (mirror agy-gate.js's override convention) -------------
function root() { return process.env.AGY_MONITOR_ROOT || path.join(os.homedir(), ".agy-monitor"); }
function decisionsDir() { return path.join(root(), "decisions"); }
function stateFile() { return path.join(root(), "promoter-state.json"); }
function settingsPath() {
  return process.env.AGY_GATE_SETTINGS ||
    path.join(process.env.AGY_CLI_HOME || path.join(os.homedir(), ".gemini", "antigravity-cli"), "settings.json");
}

// ---- tunables (§6.2; env-overridable, read at call time) --------------------
function minCount() { return Number(process.env.AGY_PROMOTER_MIN_COUNT) || 5; }          // approvals ≥ N
function minConversations() { return Number(process.env.AGY_PROMOTER_MIN_CONVERSATIONS) || 2; } // ≥2 distinct runs
function windowDays() { return Number(process.env.AGY_PROMOTER_WINDOW_DAYS) || 30; }     // candidacy review window
function snoozeMs() { return Number(process.env.AGY_PROMOTER_SNOOZE_MS) || 7 * 24 * 60 * 60 * 1000; }
const MAX_EXAMPLES = 3;
const MAX_DECISIONS = 2000; // cap listDecisions payload

const DAY_MS = 24 * 60 * 60 * 1000;

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// ---- decision-log reading ---------------------------------------------------

// The set of "YYYY-MM" month files that could hold rows in the last `days` (UTC, matching the
// gate's toISOString()-based file naming). Hard-capped so a bogus `days` can't loop forever.
function monthsForWindow(days) {
  const out = [];
  const end = new Date();
  const endMonth = end.toISOString().slice(0, 7);
  let d = new Date(end.getTime() - days * DAY_MS);
  d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  for (let i = 0; i < 120; i++) {
    const m = d.toISOString().slice(0, 7);
    out.push(m);
    if (m >= endMonth) break;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return out;
}

// Parse the JSONL month files intersecting the window; drop rows older than the cutoff. Newest-first.
function readDecisions(days) {
  const dir = decisionsDir();
  const cutoff = Date.now() - days * DAY_MS;
  const rows = [];
  for (const m of monthsForWindow(days)) {
    let text;
    try { text = fs.readFileSync(path.join(dir, m + ".jsonl"), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let r;
      try { r = JSON.parse(s); } catch { continue; } // skip a torn/partial line, never throw
      const t = Date.parse(r.ts);
      if (!Number.isNaN(t) && t < cutoff) continue;
      rows.push(r);
    }
  }
  rows.sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
  return rows;
}

// ---- state (snooze / reject / promotion audit trail) ------------------------
function readState() {
  const s = readJsonSafe(stateFile());
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}
function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2) + "\n");
  } catch {}
}
function isRejected(state, atom) {
  return !!(state.rejected && state.rejected[atom]);
}
function isSnoozed(state, atom) {
  const ts = state.snoozed && state.snoozed[atom];
  const t = ts ? Date.parse(ts) : NaN;
  if (Number.isNaN(t)) return false;
  return Date.now() - t < snoozeMs(); // a snooze expires; a reject is forever
}

// ---- §6.3 hard veto (fail-closed; NEVER even suggest a dangerous prefix) -----
// Returns a reason string if the atom must not be promoted, else null. Reuses agy-policy so the
// veto set is identical to the gate's force-defer/deny set (versioned data, no drift).
function vetoReason(atom) {
  const a = String(atom == null ? "" : atom).trim();
  if (!a) return "empty";
  if (/[$`|&;<>(){}\[\]*?\n]/.test(a)) return "shell-metacharacter"; // atoms are clean by construction; defensive
  if (!a.includes(" ")) return "bare-single-binary";                 // never a bare multiplexer (git/npm/docker/…)
  const scr = policy.screen(a);
  if (scr.disposition !== "eligible") return "policy:" + (scr.reason || scr.disposition); // deny/defer class → veto
  return null;
}

// A row that counts toward candidacy: a human approval the classifier ALSO rated low/none, or an
// auto-allow (classifier/cache — always low/none by construction). Policy force-defers (classifier
// null) and classifier errors (null) are deliberately EXCLUDED so they can never inflate a count.
function isPositive(r) {
  if (r.outcome === "classifier-auto-allow") return true;
  if (r.outcome === "manual-approve") return !!(r.classifier && (r.classifier.risk === "none" || r.classifier.risk === "low"));
  return false;
}
// Any explicit human deny or catastrophe auto-deny POISONS the atom (one deny → never a candidate).
// A manual timeout is neutral (the human was simply absent — not a judgment on the command).
function isDeny(r) {
  return r.outcome === "manual-deny" || r.outcome === "auto-deny";
}

// Aggregate the decision rows per atom (§6.2). A compound row credits EACH of its sub-command atoms.
function aggregate(rows) {
  const map = new Map();
  for (const r of rows) {
    const atoms = Array.isArray(r.atoms) ? r.atoms : [];
    const positive = isPositive(r);
    const deny = isDeny(r);
    if (!positive && !deny) continue;
    for (const atom of atoms) {
      if (typeof atom !== "string" || !atom) continue;
      let e = map.get(atom);
      if (!e) { e = { atom, count: 0, lastTs: null, examples: [], conversations: new Set(), poisoned: false }; map.set(atom, e); }
      if (deny) { e.poisoned = true; continue; }
      e.count++;
      if (r.conversationId) e.conversations.add(r.conversationId);
      if (!e.lastTs || (Date.parse(r.ts) || 0) > (Date.parse(e.lastTs) || 0)) e.lastTs = r.ts;
      if (r.command && e.examples.length < MAX_EXAMPLES && !e.examples.includes(r.command)) e.examples.push(r.command);
    }
  }
  return map;
}

function loadAllow() {
  const s = readJsonSafe(settingsPath());
  return (s && s.permissions && Array.isArray(s.permissions.allow)) ? s.permissions.allow : [];
}

// ===========================================================================
// Public API (wired in agy-monitor.js)
// ===========================================================================

// Raw decision history for the dashboard. Default 7 days; capped to bound the payload.
function listDecisions(days) {
  let d = Number(days);
  if (!Number.isFinite(d) || d <= 0) d = 7;
  if (d > 366) d = 366;
  const rows = readDecisions(d);
  return { ok: true, days: d, decisions: rows.slice(0, MAX_DECISIONS) };
}

// Surface promotable atoms (§6.2–6.3). Excludes snoozed, rejected, and anything the policy vetoes;
// `alreadyAllowed` is a flag (not a filter) so the UI can gray out rules already covered.
function listCandidates() {
  const state = readState();
  const rows = readDecisions(windowDays());
  const map = aggregate(rows);
  const allow = loadAllow();
  const N = minCount();
  const C = minConversations();
  const candidates = [];
  for (const e of map.values()) {
    if (e.poisoned) continue;                       // a single deny poisons the atom
    if (isRejected(state, e.atom)) continue;        // permanent blocklist
    if (isSnoozed(state, e.atom)) continue;         // temporary hide
    if (e.count < N) continue;                      // not approved often enough
    if (e.conversations.size < C) continue;         // one-off automation guard (§6.2)
    if (vetoReason(e.atom)) continue;               // §6.3 hard veto (policy + bare-token)
    candidates.push({
      atom: e.atom,
      count: e.count,
      lastTs: e.lastTs,
      examples: e.examples.slice(0, MAX_EXAMPLES),
      alreadyAllowed: policy.atomMatchesAllow(e.atom, allow),
    });
  }
  candidates.sort((a, b) => b.count - a.count || ((Date.parse(b.lastTs) || 0) - (Date.parse(a.lastTs) || 0)));
  return { ok: true, candidates };
}

// Timestamped .backup of settings.json before the destructive edit (repo convention). null if absent.
function backupSettings(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${file}.${stamp}.backup`;
    fs.copyFileSync(file, backup);
    return backup;
  } catch { return null; }
}

// Add `command(<atom>)` to permissions.allow. Re-screens the atom (belt-and-suspenders: the same
// veto the UI applied), backs up settings.json, then appends. Refuses any veto-class atom outright.
function promoteRule(atom) {
  const a = String(atom == null ? "" : atom).trim();
  if (!a) return { ok: false, message: "empty atom" };
  const veto = vetoReason(a);
  if (veto) return { ok: false, message: "refused to promote: " + veto, atom: a };

  const file = settingsPath();
  let settings = readJsonSafe(file);
  // readJsonSafe returns null for BOTH "missing" and "unparseable", and rebuilding a
  // fresh object is right for the first and catastrophic for the second: a settings.json
  // with one hand-edit typo would be silently replaced by `{permissions:{allow:[…]}}`,
  // dropping model, trustedWorkspaces and — the dangerous one — permissions.DENY, while
  // still reporting ok. Only a genuinely absent file may be created from scratch.
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    if (fs.existsSync(file)) {
      return { ok: false, message: "settings.json is not readable JSON — not overwriting it", atom: a };
    }
    settings = {};
  }
  if (!settings.permissions || typeof settings.permissions !== "object") settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

  const rule = `command(${a})`;
  if (settings.permissions.allow.includes(rule) || policy.atomMatchesAllow(a, settings.permissions.allow)) {
    return { ok: true, atom: a, rule, alreadyAllowed: true, message: "already covered by the safelist" };
  }

  const backup = backupSettings(file);
  settings.permissions.allow.push(rule);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  } catch (e) {
    return { ok: false, message: "failed to write settings: " + (e && e.message ? e.message : String(e)), atom: a };
  }

  // Audit trail for rollback (§6.5): who/when is this process at this time; record rule + backup.
  const state = readState();
  if (!Array.isArray(state.promotions)) state.promotions = [];
  state.promotions.push({ atom: a, rule, backup: backup || null, ts: new Date().toISOString() });
  // Promoting clears any prior snooze/reject on the atom (the human decided to add it).
  if (state.snoozed && state.snoozed[a]) delete state.snoozed[a];
  if (state.rejected && state.rejected[a]) delete state.rejected[a];
  writeState(state);

  return { ok: true, atom: a, rule, backup: backup || null, alreadyAllowed: false };
}

// The CURRENT safelist — permissions.allow as agy will actually apply it.
// Rules promoted from here carry `promoted:true` (matched via the audit trail).
//
// Each rule also carries `uses`: how many of the window's safelist auto-approvals that
// rule COVERS. Note "covers", not "fired" — the log records that the safelist allowed a
// command, never which entry satisfied it, so when two rules overlap (command(git) and
// command(git log)) both are credited. Over-crediting is the honest direction: it can
// make a redundant rule look earned, but it can never make a load-bearing rule look dead.
// Matching uses policy.atomMatchesAllow — the gate's own matcher, not a copy of it.
//
// Two flags bound what the UI may claim from this:
//   usesKnown      — the log holds at least one safelist-allow row. Otherwise every count
//                    is 0 for want of data (no gate hook, fresh install), not for want of use.
//   logSpansWindow — the log actually reaches back the full window. A log that started
//                    yesterday cannot support "no auto-approvals in 30 days"; without this
//                    a single row would brand every other rule dead.
function listRules() {
  const allow = loadAllow();
  const state = readState();
  const promos = new Map();
  for (const p of (Array.isArray(state.promotions) ? state.promotions : [])) {
    if (p && p.rule) promos.set(p.rule, p.ts || null);   // last promotion of a rule wins
  }
  const days = windowDays();
  const rows = readDecisions(days);
  // same bound listDecisions applies — the decision log is append-only and unpruned,
  // so an uncapped scan here is rows x rules work on the server's event loop
  const fired = rows.filter((r) => r && r.outcome === "safelist-allow").slice(0, MAX_DECISIONS);
  // readDecisions is newest-first, so the last row is the oldest we hold
  const oldest = rows.length ? Date.parse(rows[rows.length - 1].ts) : NaN;
  const spans = !Number.isNaN(oldest) && (Date.now() - oldest) >= (days - 1) * DAY_MS;
  return {
    ok: true,
    path: settingsPath(),
    windowDays: days,
    usesKnown: fired.length > 0,
    logSpansWindow: spans,
    rules: allow.map((r) => {
      const rule = String(r);
      const one = [rule];
      let uses = 0;
      for (const d of fired) {
        const atoms = Array.isArray(d.atoms) ? d.atoms : [];
        if (atoms.some((a) => typeof a === "string" && a && policy.atomMatchesAllow(a, one))) uses++;
      }
      return { rule, promoted: promos.has(rule), promotedTs: promos.get(rule) || null, uses };
    }),
  };
}

// Remove a rule from permissions.allow (the inverse of promoteRule; same backup
// convention). Takes the FULL rule string, e.g. "command(git log)".
function demoteRule(rule) {
  const r = String(rule == null ? "" : rule).trim();
  if (!r) return { ok: false, message: "empty rule" };
  const file = settingsPath();
  const settings = readJsonSafe(file);
  const allow = settings && settings.permissions && Array.isArray(settings.permissions.allow) ? settings.permissions.allow : null;
  if (!allow || !allow.includes(r)) return { ok: false, message: "rule not in the safelist", rule: r };
  const backup = backupSettings(file);
  settings.permissions.allow = allow.filter((x) => x !== r);
  try {
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  } catch (e) {
    return { ok: false, message: "failed to write settings: " + (e && e.message ? e.message : String(e)), rule: r };
  }
  const state = readState();
  if (!Array.isArray(state.demotions)) state.demotions = [];
  state.demotions.push({ rule: r, backup: backup || null, ts: new Date().toISOString() });
  writeState(state);
  return { ok: true, rule: r, backup: backup || null };
}

// Undo a demote: put a rule the user just removed back, VERBATIM.
//
// Deliberately does NOT run vetoReason(). That veto exists to stop promoteRule from
// CREATING a dangerous new rule out of an observed atom — but this rule was already
// in the user's own file a moment ago, and re-screening would refuse to restore the
// single-token rules (command(wc), command(ls)) that make up most real safelists.
// Restoring is returning the file to a state the user already had, not granting
// anything new; the only writer of the string is the file itself.
function restoreRule(rule) {
  const r = String(rule == null ? "" : rule).trim();
  if (!r) return { ok: false, message: "empty rule" };
  // Only undo what we recorded removing. Skipping the veto is only defensible for a
  // string this tool took OUT of the file; without this check the action would be an
  // unvetted "append anything to permissions.allow" primitive, and restoring would be
  // the way around a veto that refuses command(*) and bare single binaries outright.
  const state = readState();
  if (!(Array.isArray(state.demotions) && state.demotions.some((d) => d && d.rule === r))) {
    return { ok: false, message: "nothing to restore — that rule was not removed from this dashboard", rule: r };
  }
  // Belt-and-braces: command(*) disables the gate for every command. Helping a user put
  // that back is not an undo worth offering, whatever the ledger says.
  const pat = /^command\((.+)\)$/.exec(r);
  if (pat && pat[1].trim() === "*") {
    return { ok: false, message: "refusing to restore command(*) — it would auto-approve every command", rule: r };
  }
  const file = settingsPath();
  let settings = readJsonSafe(file);
  // readJsonSafe returns null for BOTH "missing" and "unparseable". Rebuilding a fresh
  // object is right for the first and catastrophic for the second: it would drop every
  // other key in the user's agy settings — model, trustedWorkspaces, permissions.DENY —
  // and report ok. Only a genuinely absent file may be created from scratch.
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    if (fs.existsSync(file)) {
      return { ok: false, message: "settings.json is not readable JSON — not overwriting it", rule: r };
    }
    settings = {};
  }
  if (!settings.permissions || typeof settings.permissions !== "object") settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
  if (settings.permissions.allow.includes(r)) {
    return { ok: true, rule: r, alreadyAllowed: true, message: "already in the safelist" };
  }
  const backup = backupSettings(file);
  settings.permissions.allow.push(r);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  } catch (e) {
    return { ok: false, message: "failed to write settings: " + (e && e.message ? e.message : String(e)), rule: r };
  }
  // Consume the ledger entry: one removal buys exactly one undo, so a single old
  // demotion can't be replayed into repeated grants later.
  state.demotions = state.demotions.filter((d) => !(d && d.rule === r));
  if (!Array.isArray(state.restorations)) state.restorations = [];
  state.restorations.push({ rule: r, backup: backup || null, ts: new Date().toISOString() });
  writeState(state);
  return { ok: true, rule: r, backup: backup || null };
}

// Temporary hide (expires after the snooze window). The atom can resurface later on new approvals.
function snoozeRule(atom) {
  const a = String(atom == null ? "" : atom).trim();
  if (!a) return { ok: false, message: "empty atom" };
  const state = readState();
  if (!state.snoozed || typeof state.snoozed !== "object") state.snoozed = {};
  state.snoozed[a] = new Date().toISOString();
  writeState(state);
  return { ok: true, atom: a, snoozedUntil: new Date(Date.now() + snoozeMs()).toISOString() };
}

// Permanent blocklist ("never suggest this prefix again"). Supersedes any snooze.
function rejectRule(atom) {
  const a = String(atom == null ? "" : atom).trim();
  if (!a) return { ok: false, message: "empty atom" };
  const state = readState();
  if (!state.rejected || typeof state.rejected !== "object") state.rejected = {};
  state.rejected[a] = new Date().toISOString();
  if (state.snoozed && state.snoozed[a]) delete state.snoozed[a];
  writeState(state);
  return { ok: true, atom: a, rejected: true };
}

module.exports = {
  listDecisions,
  listCandidates,
  listRules,
  promoteRule,
  demoteRule,
  restoreRule,
  snoozeRule,
  rejectRule,
  // exported for tests / reuse
  vetoReason,
  aggregate,
  readDecisions,
};

if (require.main === module) {
  const arg = process.argv[2] || "candidates";
  const out =
    arg === "decisions" ? listDecisions(Number(process.argv[3]) || 7) :
    arg === "candidates" ? listCandidates() :
    { ok: false, message: "usage: agy-promoter.js [candidates|decisions [days]]" };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}
