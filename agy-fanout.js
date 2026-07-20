"use strict";
/*
 * agy-fanout — N parallel agy workers on one task + a single Opus judge.
 *
 * Strategies:
 *   best      — every worker attacks the SAME task from a different angle;
 *               the judge ranks the candidate diffs (scores /10 + verdicts).
 *   decompose — one planning call splits the task into N subtasks (one per
 *               worker); the judge checks the diffs for conflicts and returns
 *               a merge order.
 *
 * Each worker runs `agy -p` inside its own detached git worktree (created at
 * HEAD), so workers can't collide with each other or the live tree. Worker
 * runs are gated (AGY_MONITOR_GATED=1) — their approvals surface in NEEDS YOU
 * like any UI-launched run. On completion each worktree's diff is staged
 * (`git add -A`) and snapshotted to a patch file; apply/merge uses
 * `git apply --3way` against the real workspace, then prunes the worktrees.
 *
 * State: MON_ROOT/fanout/<id>.json + MON_ROOT/fanout/<id>/w<L>/ worktrees.
 * Workers are detached children — after a server restart the exit handlers
 * are gone, so list() lazily finalizes any "running" worker whose pid died.
 */

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { callAnthropic, usageMeta, responseText } = require("./agy-anthropic");

const MON_ROOT = process.env.AGY_MONITOR_ROOT || path.join(os.homedir(), ".agy-monitor");
const FANOUT_DIR = path.join(MON_ROOT, "fanout");
const PRINT_TIMEOUT = "20m";
const GATE_TIMEOUT_MS = 8 * 60 * 1000;
const PATCH_CAP = 30 * 1024; // per-worker diff bytes sent to the judge
const GC_MS = 7 * 24 * 3600 * 1000;

const APPROACHES = [
  "direct fix, minimal diff",
  "defensive rewrite, tests first",
  "alternative structural design",
  "spec-first: invariants, then code",
];

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || "").toString().slice(0, 400)));
      else resolve(stdout.toString());
    });
  });
}

function agyBin() {
  if (process.env.AGY_GATE_AGY_BIN) return process.env.AGY_GATE_AGY_BIN; // explicit override (also how tests stub agy)
  const cand = path.join(os.homedir(), ".local", "bin", "agy");
  try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch { return "agy"; }
}

function groupFile(id) { return path.join(FANOUT_DIR, id + ".json"); }
function readGroup(id) {
  try { return JSON.parse(fs.readFileSync(groupFile(id), "utf8")); } catch { return null; }
}
function writeGroup(g) {
  fs.mkdirSync(FANOUT_DIR, { recursive: true });
  fs.writeFileSync(groupFile(g.id), JSON.stringify(g));
}
function safeId(id) { return typeof id === "string" && /^f[a-z0-9]{4,20}$/.test(id); }

let _events = null;
function emit() { if (_events) _events.emit("change", { type: "runs" }); }

// ---- worker lifecycle --------------------------------------------------------

function workerPrompt(g, w) {
  const scope = g.strategyMode === "best"
    ? "Solve this task. Your assigned angle of attack: " + w.approach + "."
    : "Complete ONLY this subtask of a larger effort: " + w.approach + ".";
  return g.task + "\n\n---\n" + scope + " Work entirely inside the current directory (an isolated git worktree). " +
    "Edit files in place; do NOT commit, push, create branches, or touch anything outside this directory. " +
    "When done, summarize what you changed.";
}

function spawnWorker(g, w) {
  let child;
  try {
    child = spawn(agyBin(), ["-p", workerPrompt(g, w), "--add-dir", w.worktree, "--print-timeout", PRINT_TIMEOUT, "--output-format", "json"], {
      cwd: w.worktree,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, AGY_MONITOR_GATED: "1", AGY_GATE_TIMEOUT_MS: String(GATE_TIMEOUT_MS), AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
    });
  } catch (e) {
    w.status = "error";
    w.error = "failed to start agy: " + (e && e.message ? e.message : e);
    return;
  }
  child.on("error", () => {});
  child.unref();
  w.pid = child.pid;
  w.startedAt = Date.now();
  child.on("exit", () => { onWorkerExit(g.id, w.label).catch(() => {}); });
}

async function finalizeWorker(g, w) {
  if (w.status !== "running") return;
  w.status = "done";
  w.endedAt = Date.now();
  try {
    await execFileP("git", ["-C", w.worktree, "add", "-A"]);
    const numstat = await execFileP("git", ["-C", w.worktree, "diff", "--cached", "--numstat"]);
    let add = 0, del = 0;
    for (const line of numstat.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
      if (m) { add += m[1] === "-" ? 0 : +m[1]; del += m[2] === "-" ? 0 : +m[2]; }
    }
    w.add = add; w.del = del;
    const patch = await execFileP("git", ["-C", w.worktree, "diff", "--cached", "--binary"]);
    w.patchFile = path.join(FANOUT_DIR, g.id, "patch-" + w.label + ".patch");
    fs.writeFileSync(w.patchFile, patch);
    w.empty = !patch.trim();
  } catch (e) {
    w.error = "diff failed: " + (e && e.message ? e.message : e);
    w.add = w.add || 0; w.del = w.del || 0;
    w.empty = true;
  }
}

async function onWorkerExit(id, label) {
  const g = readGroup(id);
  if (!g) return;
  const w = g.workers.find((x) => x.label === label);
  if (!w || w.status !== "running") return;
  await finalizeWorker(g, w);
  writeGroup(g);
  emit();
  await maybeJudge(g);
}

// ---- judge -------------------------------------------------------------------

const JUDGE_BEST_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "candidates"],
  properties: {
    summary: { type: "string", description: "2-3 sentences: which candidate wins and why" },
    candidates: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["label", "rank", "score", "verdict"],
        properties: {
          label: { type: "string" },
          rank: { type: "integer", description: "1 = best" },
          score: { type: "number", description: "0-10 quality score" },
          verdict: { type: "string", description: "one-sentence assessment" },
        },
      },
    },
  },
};
const JUDGE_DECOMPOSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "order"],
  properties: {
    summary: { type: "string", description: "conflict check result + recommended merge strategy" },
    order: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["label", "order", "note"],
        properties: {
          label: { type: "string" },
          order: { type: "integer", description: "merge position, 1 first" },
          note: { type: "string", description: "integration note for this diff" },
        },
      },
    },
  },
};

function patchExcerpt(w) {
  if (!w.patchFile) return "(no diff)";
  try {
    let p = fs.readFileSync(w.patchFile, "utf8");
    if (p.length > PATCH_CAP) p = p.slice(0, PATCH_CAP) + "\n… (truncated)";
    return p.trim() || "(empty diff)";
  } catch { return "(diff unavailable)"; }
}

let _judging = new Set();
async function maybeJudge(g) {
  if (g.status !== "running" || g.workers.some((w) => w.status === "running")) return;
  if (_judging.has(g.id)) return;
  _judging.add(g.id);
  try {
    g.status = "judging";
    writeGroup(g); emit();
    const parts = g.workers.map((w) =>
      "### Candidate " + w.label + " — " + w.approach + " (+" + (w.add || 0) + " −" + (w.del || 0) + ")\n" + patchExcerpt(w));
    const isBest = g.strategyMode === "best";
    const system = isBest
      ? "You judge parallel candidate implementations of the same task. Rank them by correctness first, then simplicity and completeness. Penalize empty or broken diffs hard."
      : "You are an integration checker for subtask diffs of one larger task. Detect conflicts/overlaps between the diffs and produce a safe merge order with per-diff integration notes.";
    const out = await callAnthropic({
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system,
      output_config: { format: { type: "json_schema", schema: isBest ? JUDGE_BEST_SCHEMA : JUDGE_DECOMPOSE_SCHEMA } },
      messages: [{ role: "user", content: "Task:\n" + g.task + "\n\n" + parts.join("\n\n") }],
    });
    const g2 = readGroup(g.id) || g;
    if (!out.ok) {
      g2.status = "done";
      g2.judge = { summary: "Judge call failed: " + out.message + " — inspect the worktree diffs manually.", meta: null, error: true };
      writeGroup(g2); emit();
      return;
    }
    const text = responseText(out.response);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const meta = usageMeta(out.response, out.ms);
    if (isBest && parsed && Array.isArray(parsed.candidates)) {
      for (const c of parsed.candidates) {
        const w = g2.workers.find((x) => x.label === c.label);
        if (w) { w.rank = c.rank; w.score = c.score; w.verdict = c.verdict; }
      }
      g2.judge = { summary: parsed.summary || "", meta };
    } else if (!isBest && parsed && Array.isArray(parsed.order)) {
      for (const c of parsed.order) {
        const w = g2.workers.find((x) => x.label === c.label);
        if (w) { w.order = c.order; w.verdict = c.note; }
      }
      g2.judge = { summary: parsed.summary || "", meta };
    } else {
      g2.judge = { summary: "Judge returned unparseable output — inspect the diffs manually.", meta, error: true };
    }
    g2.status = "done";
    writeGroup(g2); emit();
  } finally {
    _judging.delete(g.id);
  }
}

// ---- decompose planning ------------------------------------------------------

const PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["subtasks"],
  properties: {
    subtasks: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["title", "instructions"],
        properties: {
          title: { type: "string", description: "short subtask name" },
          instructions: { type: "string", description: "self-contained instructions for one worker" },
        },
      },
    },
  },
};

async function planSubtasks(task, n) {
  const out = await callAnthropic({
    max_tokens: 4000,
    system: "Split the task into exactly " + n + " INDEPENDENT subtasks that can be implemented in parallel by separate agents in separate copies of the repo, minimizing file overlap. Each subtask must be self-contained.",
    output_config: { format: { type: "json_schema", schema: PLAN_SCHEMA } },
    messages: [{ role: "user", content: task }],
  });
  if (!out.ok) return { ok: false, message: out.message };
  const text = responseText(out.response);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!parsed || !Array.isArray(parsed.subtasks) || !parsed.subtasks.length) return { ok: false, message: "planning call returned no subtasks" };
  return { ok: true, subtasks: parsed.subtasks.slice(0, n) };
}

// ---- public API --------------------------------------------------------------

async function start({ workspace, task, strategy, n }, config) {
  if (typeof workspace !== "string" || !workspace) return { ok: false, message: "workspace required" };
  if (typeof task !== "string" || !task.trim()) return { ok: false, message: "task required" };
  const count = Math.max(2, Math.min(4, parseInt(n, 10) || 3));
  const mode = strategy === "decompose" ? "decompose" : "best";
  let ws;
  try { ws = fs.realpathSync(workspace); } catch { return { ok: false, message: "workspace not found" }; }
  try { await execFileP("git", ["-C", ws, "rev-parse", "--verify", "HEAD"]); }
  catch { return { ok: false, message: "workspace is not a git repository with a commit" }; }
  if (config && config.events) _events = config.events;

  let approaches;
  if (mode === "decompose") {
    const plan = await planSubtasks(task.trim(), count);
    if (!plan.ok) return plan;
    approaches = plan.subtasks.map((s) => s.title + " — " + s.instructions);
  } else {
    approaches = APPROACHES.slice(0, count);
  }

  const id = "f" + Date.now().toString(36);
  const gdir = path.join(FANOUT_DIR, id);
  fs.mkdirSync(gdir, { recursive: true });
  const g = {
    id,
    workspace: ws,
    project: path.basename(ws),
    task: task.trim().slice(0, 4000),
    strategyMode: mode,
    strategy: (mode === "best" ? "best-of-" : "decompose-") + count,
    status: "running",
    startedAt: Date.now(),
    applied: false,
    winner: null,
    workers: [],
  };
  for (let i = 0; i < count; i++) {
    const label = String.fromCharCode(65 + i);
    const wt = path.join(gdir, "w" + label);
    try {
      await execFileP("git", ["-C", ws, "worktree", "add", "--detach", wt, "HEAD"], { timeout: 60000 });
    } catch (e) {
      // roll back what we made so far
      for (const w of g.workers) { try { await execFileP("git", ["-C", ws, "worktree", "remove", "--force", w.worktree]); } catch {} }
      return { ok: false, message: "worktree add failed: " + (e && e.message ? e.message : e) };
    }
    g.workers.push({ label, approach: approaches[i], worktree: wt, status: "running", add: 0, del: 0 });
  }
  for (const w of g.workers) spawnWorker(g, w);
  writeGroup(g);
  emit();
  return { ok: true, id, group: publicGroup(g) };
}

function publicGroup(g) {
  return {
    id: g.id, workspace: g.workspace, project: g.project, task: g.task,
    strategyMode: g.strategyMode, strategy: g.strategy, status: g.status,
    startedAt: g.startedAt, applied: g.applied, winner: g.winner,
    judge: g.judge || null,
    workers: g.workers.map((w) => ({
      label: w.label, approach: w.approach, status: w.status,
      add: w.add || 0, del: w.del || 0, empty: !!w.empty,
      startedAt: w.startedAt || null, endedAt: w.endedAt || null,
      rank: w.rank != null ? w.rank : null, score: w.score != null ? w.score : null,
      order: w.order != null ? w.order : null, verdict: w.verdict || null,
      error: w.error || null, applied: !!w.applied,
    })),
  };
}

// list() also does the lazy repair pass: finalize workers whose pid died while
// we weren't watching (server restart), then trigger the judge if that
// completed the set.
async function list() {
  let names = [];
  try { names = fs.readdirSync(FANOUT_DIR).filter((f) => f.endsWith(".json")); } catch {}
  const groups = [];
  const now = Date.now();
  for (const nfile of names) {
    const g = readGroup(nfile.replace(/\.json$/, ""));
    if (!g) continue;
    if ((g.status === "applied" || g.status === "discarded") && now - (g.startedAt || 0) > GC_MS) {
      try { fs.unlinkSync(groupFile(g.id)); } catch {}
      continue;
    }
    let changed = false;
    for (const w of g.workers) {
      if (w.status !== "running" || !w.pid) continue;
      let alive = false;
      try { process.kill(w.pid, 0); alive = true; } catch {}
      if (!alive) { await finalizeWorker(g, w); changed = true; }
    }
    if (changed) { writeGroup(g); maybeJudge(g).catch(() => {}); }
    groups.push(publicGroup(g));
  }
  groups.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return { ok: true, groups };
}

function get(id) {
  if (!safeId(id)) return { ok: false, message: "bad id" };
  const g = readGroup(id);
  if (!g) return { ok: false, message: "no such fan-out" };
  return { ok: true, group: publicGroup(g) };
}

async function removeWorktrees(g) {
  for (const w of g.workers) {
    try { await execFileP("git", ["-C", g.workspace, "worktree", "remove", "--force", w.worktree], { timeout: 60000 }); } catch {}
  }
  try { await execFileP("git", ["-C", g.workspace, "worktree", "prune"]); } catch {}
}

async function applyPatch(g, w) {
  if (!w.patchFile || w.empty) return { ok: false, message: "candidate " + w.label + " has no diff to apply" };
  try {
    await execFileP("git", ["-C", g.workspace, "apply", "--3way", w.patchFile], { timeout: 60000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: "git apply failed for " + w.label + ": " + (e && e.message ? e.message : e) };
  }
}

async function apply(id, label) {
  if (!safeId(id)) return { ok: false, message: "bad id" };
  const g = readGroup(id);
  if (!g) return { ok: false, message: "no such fan-out" };
  if (g.status !== "done") return { ok: false, message: "fan-out is not ready to apply (" + g.status + ")" };
  const w = g.workers.find((x) => x.label === label);
  if (!w) return { ok: false, message: "no such candidate" };
  const res = await applyPatch(g, w);
  if (!res.ok) return res;
  w.applied = true;
  g.applied = true; g.status = "applied"; g.winner = label;
  writeGroup(g);
  await removeWorktrees(g);
  emit();
  return { ok: true, group: publicGroup(g) };
}

async function mergeAll(id) {
  if (!safeId(id)) return { ok: false, message: "bad id" };
  const g = readGroup(id);
  if (!g) return { ok: false, message: "no such fan-out" };
  if (g.status !== "done") return { ok: false, message: "fan-out is not ready to merge (" + g.status + ")" };
  const ordered = g.workers.slice().sort((a, b) => (a.order || 99) - (b.order || 99));
  for (const w of ordered) {
    if (w.empty) { w.applied = true; continue; }
    const res = await applyPatch(g, w);
    if (!res.ok) { writeGroup(g); return res; } // earlier applied diffs stay applied — report where it stopped
    w.applied = true;
  }
  g.applied = true; g.status = "applied"; g.winner = null;
  writeGroup(g);
  await removeWorktrees(g);
  emit();
  return { ok: true, group: publicGroup(g) };
}

async function discard(id) {
  if (!safeId(id)) return { ok: false, message: "bad id" };
  const g = readGroup(id);
  if (!g) return { ok: false, message: "no such fan-out" };
  for (const w of g.workers) {
    if (w.status === "running" && w.pid) {
      try { process.kill(-w.pid, "SIGTERM"); } catch { try { process.kill(w.pid, "SIGTERM"); } catch {} }
    }
  }
  g.status = "discarded";
  writeGroup(g);
  await removeWorktrees(g);
  emit();
  return { ok: true };
}

module.exports = { start, list, get, apply, mergeAll, discard };
