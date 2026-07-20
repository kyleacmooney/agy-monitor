"use strict";
/*
 * RunManager — managed lifecycle for UI-launched headless agy runs.
 *
 * Upgrades the old fire-and-forget spawn (stdio ignored, pid-liveness + a
 * 15-minute "probably done" heuristic) to a tracked child:
 *   - stdout captured: agy's hidden `--output-format json` prints a final
 *     {conversation_id, status, response, duration_seconds, num_turns, usage}
 *     object, so runs get a real outcome + token usage (probe-verified 1.0.15).
 *   - stderr tail kept for error surfacing.
 *   - exit updates ui-runs/<cid>.json with {status, exitCode, result, endedAt}.
 *   - per-conversation serialization: agy tolerates concurrent resumes but
 *     serializes them internally (~10x slower, out-of-order transcript rows),
 *     so a second send while a managed run is live returns {busy:true} and the
 *     client queues it.
 *   - AGY_CLI_DISABLE_AUTO_UPDATE pins the binary for the run (agy otherwise
 *     self-updates mid-invocation).
 *
 * Children are spawned detached (own process group): they survive a server
 * restart; on boot, records whose pid is still alive show as running again via
 * the legacy pid-liveness path in listUiRuns.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MON_ROOT = process.env.AGY_MONITOR_ROOT || path.join(os.homedir(), ".agy-monitor");
const UI_RUNS_DIR = path.join(MON_ROOT, "ui-runs");

// Headless agy can't pop an interactive question dialog, so UI-launched runs
// teach it a fenced ```ask convention: emit a fenced ask block and the
// web UI renders it as a tappable card whose answer arrives as the next turn.
// The marker delimits the injected block so transcript rendering can strip it.
const ASK_MARK = "[[UI-ASK-RULES]]";
const ASK_RULES =
  "\n\n" + ASK_MARK + " You are running headlessly inside a web UI. When you need the user to " +
  "choose between options, do NOT ask in prose. Instead emit a fenced code block whose info-string " +
  'is the single word ask, containing JSON of exactly this shape: {"questions":[{"header":"<=12 char ' +
  'label","question":"the question text","multiSelect":false,"options":[{"label":"short label",' +
  '"description":"what it means"}]}]}. Rules: 1-4 questions; each with 2-4 options; set ' +
  '"multiSelect":true to allow several answers to one question. An "Other" free-text choice is added ' +
  "automatically — never include your own. The user's selection arrives as their next message in the " +
  "form 'My answers: • <header>: <pick>'. Use this only for genuine multiple-choice decisions, not " +
  "open-ended questions.";

const PRINT_TIMEOUT = "12m";
const GATE_TIMEOUT_MS = 8 * 60 * 1000; // must stay under --print-timeout
const NEW_CID_POLL = { tries: 75, intervalMs: 200 }; // early cid pickup for kind:"new"
const STDERR_TAIL = 2000;

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeRun(cid, record) {
  try {
    fs.mkdirSync(UI_RUNS_DIR, { recursive: true });
    const fp = path.join(UI_RUNS_DIR, cid + ".json");
    const prev = readJsonSafe(fp, {});
    fs.writeFileSync(fp, JSON.stringify({ ...prev, ...record, conversationId: cid }));
  } catch {}
}

// The last {...} JSON object in agy's stdout (banner lines may precede it).
function parseFinalJson(stdout) {
  const start = stdout.lastIndexOf("\n{") + 1 || stdout.indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(stdout.slice(start)); } catch { return null; }
}

class RunManager {
  constructor({ agyBin, events } = {}) {
    this._agyBin = agyBin || "agy";
    this._events = events || null;
    this._live = new Map(); // conversationId (or "pending:<n>") → {child, info}
    this._pendingSeq = 0;
  }

  _emit(type, payload) {
    if (this._events) this._events.emit("change", { type, ...(payload || {}) });
  }

  isBusy(conversationId) {
    return this._live.has(conversationId);
  }

  liveCount() {
    return this._live.size;
  }

  // Send into an existing conversation. Returns {ok:false, busy:true} while a
  // managed run is already active there (client queues + flushes on run end).
  send({ conversationId, workspace, message }) {
    if (this.isBusy(conversationId)) {
      return { ok: false, busy: true, message: "A run is already active on this conversation — message queued client-side." };
    }
    const args = ["--conversation", conversationId, "-p", message + ASK_RULES, "--print-timeout", PRINT_TIMEOUT, "--output-format", "json"];
    // existsSync-guarded: the workspace may come from history.jsonl, which records
    // it at prompt time and never reconciles it against the filesystem.
    if (workspace && fs.existsSync(workspace)) args.push("--add-dir", workspace);
    return this._spawn({ key: conversationId, cid: conversationId, workspace, message, kind: "send", args });
  }

  // Brand-new conversation. Resolves the new cid early (agy registers it in
  // last_conversations.json within a couple seconds) so the UI can navigate
  // into the chat while the run is still going; the exit JSON confirms it.
  // Options: model → --model, mode "auto-edit" → --mode accept-edits,
  // gated:false → no safety gate env, reviewOnFinish → Opus review on done.
  async startNew({ workspace, message, agyDir, model, mode, gated, reviewOnFinish }) {
    const key = "pending:" + ++this._pendingSeq;
    const args = ["-p", message + ASK_RULES, "--add-dir", workspace, "--print-timeout", PRINT_TIMEOUT, "--output-format", "json"];
    if (typeof model === "string" && model) args.push("--model", model);
    if (mode === "auto-edit") args.push("--mode", "accept-edits");
    const res = this._spawn({ key, cid: null, workspace, message, kind: "new", args, gated, reviewOnFinish });
    if (!res.ok) return res;

    const cacheFile = path.join(agyDir, "cache", "last_conversations.json");
    const before = readJsonSafe(cacheFile, {})[workspace] || null;
    for (let i = 0; i < NEW_CID_POLL.tries; i++) {
      const entry = this._live.get(key);
      if (entry && entry.info.cid) return { ok: true, conversationId: entry.info.cid, workspace };
      if (!entry) { // already exited — trust the exit JSON if it named the cid
        const cid = res.state.cid;
        if (!cid && res.state.status === "error") { // spawn/instant failure must not read as success
          const why = res.state.spawnError || res.state.stderrTail || "unknown error";
          const hint = /ENOENT/.test(why) ? " — is the agy CLI installed? The Setup page has the checks." : "";
          return { ok: false, message: "agy failed to start: " + String(why).slice(0, 300) + hint };
        }
        return { ok: true, conversationId: cid || null, workspace };
      }
      const cur = readJsonSafe(cacheFile, {})[workspace] || null;
      if (cur && cur !== before) { this._adoptCid(key, cur); return { ok: true, conversationId: cur, workspace }; }
      await new Promise((r) => setTimeout(r, NEW_CID_POLL.intervalMs));
    }
    return { ok: true, conversationId: null, workspace, message: "started — it'll appear in history shortly" };
  }

  // Re-key a pending run once its conversation id is known and persist the record.
  _adoptCid(key, cid) {
    const entry = this._live.get(key);
    if (!entry || entry.info.cid) return;
    entry.info.cid = cid;
    this._live.delete(key);
    this._live.set(cid, entry);
    entry.key = cid;
    writeRun(cid, {
      workspace: entry.info.workspace, project: entry.info.workspace ? path.basename(entry.info.workspace) : null,
      shortWorkspace: entry.info.shortWorkspace, kind: entry.info.kind, message: entry.info.message.slice(0, 200),
      pid: entry.child.pid, startedAt: entry.info.startedAt, status: "running",
    });
    this._emit("runs");
  }

  _spawn({ key, cid, workspace, message, kind, args, gated, reviewOnFinish }) {
    let child;
    const home = os.homedir();
    const shortWorkspace = workspace && workspace.startsWith(home) ? "~" + workspace.slice(home.length) : workspace;
    const env = {
      ...process.env,
      AGY_MONITOR_GATED: "1",
      AGY_GATE_TIMEOUT_MS: String(GATE_TIMEOUT_MS),
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    };
    if (gated === false) delete env.AGY_MONITOR_GATED; // explicit opt-out from the new-chat form
    try {
      child = spawn(this._agyBin, args, {
        cwd: workspace && fs.existsSync(workspace) ? workspace : undefined,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group: group-killable, survives server restarts
        env,
      });
    } catch (e) {
      return { ok: false, message: "failed to start agy: " + (e && e.message ? e.message : e) };
    }
    const state = { stdout: "", stderrTail: "", cid };
    const info = { cid, workspace, shortWorkspace, message, kind, startedAt: Date.now(), reviewOnFinish: reviewOnFinish === true };
    const entry = { child, info, key };
    this._live.set(key, entry);
    child.unref();
    child.on("error", (e) => { state.spawnError = (e && e.message) || "spawn failed"; this._finish(entry, state, null, "error"); });
    child.stdout.on("data", (d) => { state.stdout += d; if (state.stdout.length > 1 << 20) state.stdout = state.stdout.slice(-(1 << 19)); });
    child.stderr.on("data", (d) => { state.stderrTail = (state.stderrTail + d).slice(-STDERR_TAIL); });
    child.on("exit", (code) => { this._finish(entry, state, code); });

    if (cid) {
      writeRun(cid, {
        workspace, project: workspace ? path.basename(workspace) : null, shortWorkspace,
        kind, message: message.slice(0, 200), pid: child.pid, startedAt: info.startedAt, status: "running",
      });
      this._emit("runs");
    }
    return { ok: true, started: true, state };
  }

  _finish(entry, state, exitCode, forcedStatus) {
    const live = this._live.get(entry.key) === entry ? entry : null;
    if (!live) return;
    this._live.delete(entry.key);
    const result = parseFinalJson(state.stdout);
    const cid = live.info.cid || (result && result.conversation_id) || null;
    state.cid = cid;
    const stopped = live.info.stopped === true;
    const okResult = result && result.status === "SUCCESS";
    const status = forcedStatus || (stopped ? "stopped" : okResult ? "done" : "error");
    state.status = status; // callers polling a cid-less run (startNew) read the outcome here
    if (cid) {
      writeRun(cid, {
        workspace: live.info.workspace, project: live.info.workspace ? path.basename(live.info.workspace) : null,
        shortWorkspace: live.info.shortWorkspace, kind: live.info.kind, message: live.info.message.slice(0, 200),
        pid: live.child.pid, startedAt: live.info.startedAt,
        status, exitCode: exitCode == null ? null : exitCode, endedAt: Date.now(),
        result: result ? {
          status: result.status || null,
          durationSeconds: result.duration_seconds || null,
          numTurns: result.num_turns || null,
          usage: result.usage || null,
          responsePreview: typeof result.response === "string" ? result.response.slice(0, 240) : null,
        } : null,
        errorTail: status === "error" && state.stderrTail ? state.stderrTail : undefined,
      });
    }
    this._emit("runs");
    if (cid) this._emit("convo", { conversationId: cid });

    // "Opus review on finish" from the new-chat form: fire the one-shot review
    // over whatever the run left in the worktree. Best-effort — failures land in
    // the review store, not the run record.
    if (status === "done" && live.info.reviewOnFinish && live.info.workspace) {
      try {
        const review = require("./agy-review");
        Promise.resolve(review.runReview({ workspace: live.info.workspace, task: live.info.message.slice(0, 500) }))
          .then(() => { this._emit("review", { workspace: live.info.workspace }); })
          .catch(() => {});
      } catch {}
    }
  }

  // SIGTERM the run's process group (agy exits cleanly on TERM); record "stopped".
  stop(conversationId) {
    const entry = this._live.get(conversationId);
    if (entry) {
      entry.info.stopped = true;
      try { process.kill(-entry.child.pid, "SIGTERM"); } catch { try { entry.child.kill("SIGTERM"); } catch {} }
      return { ok: true, stopping: true };
    }
    // not ours (pre-restart child or legacy record) — fall back to the recorded pid
    const r = readJsonSafe(path.join(UI_RUNS_DIR, conversationId + ".json"), null);
    if (r && r.pid) {
      try { process.kill(-r.pid, "SIGTERM"); } catch { try { process.kill(r.pid, "SIGTERM"); } catch {} }
      writeRun(conversationId, { status: "stopped", endedAt: Date.now() });
      this._emit("runs");
      return { ok: true, stopping: true };
    }
    return { ok: false, message: "no live run for that conversation" };
  }
}

module.exports = { RunManager, UI_RUNS_DIR, ASK_MARK, ASK_RULES };
