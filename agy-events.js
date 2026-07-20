"use strict";
/*
 * AgyEvents — filesystem watchers → typed change events for the SSE stream.
 *
 * agy has no push API, so liveness comes from watching the files everything
 * already writes: the hook's status dir (session state), the gate's approval
 * mailboxes, the ui-runs records, and agy's own brain/ transcript tree.
 * Emits debounced, typed events:
 *   "sessions"  — a hook status file changed (state flipped busy/idle/waiting)
 *   "approvals" — an approval appeared or was answered/removed
 *   "runs"      — a UI-launched run record changed
 *   "convo"     — { conversationId } a transcript got new rows
 *
 * macOS fs.watch is FSEvents-backed; recursive watch on brain/ is reliable
 * there. Every watcher is best-effort: a missing dir is retried lazily, and
 * consumers keep a slow fallback poll, so a lost event never wedges the UI.
 */

const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MON_ROOT = process.env.AGY_MONITOR_ROOT || path.join(os.homedir(), ".agy-monitor");
const AGY_DIR = process.env.AGY_CLI_HOME || path.join(os.homedir(), ".gemini", "antigravity-cli");
const BRAIN_DIR = path.join(AGY_DIR, "brain");

const DEBOUNCE_MS = 250;
const REWATCH_MS = 15000; // retry missing dirs / broken watchers this often

class AgyEvents extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // one listener per SSE client
    this._watchers = new Map(); // key → fs.FSWatcher
    this._timers = new Map();   // debounce timers per event key
    this._rewatch = null;
  }

  start() {
    this._ensureAll();
    this._rewatch = setInterval(() => this._ensureAll(), REWATCH_MS);
    if (this._rewatch.unref) this._rewatch.unref();
    return this;
  }

  stop() {
    if (this._rewatch) clearInterval(this._rewatch);
    for (const w of this._watchers.values()) { try { w.close(); } catch {} }
    this._watchers.clear();
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
  }

  // Debounced emit; convo events debounce per-conversation so parallel runs
  // don't swallow each other's signals.
  _bump(type, payload) {
    const key = type + (payload && payload.conversationId ? ":" + payload.conversationId : "");
    if (this._timers.has(key)) return;
    this._timers.set(key, setTimeout(() => {
      this._timers.delete(key);
      this.emit("change", { type, ...(payload || {}) });
    }, DEBOUNCE_MS));
  }

  _ensureAll() {
    this._ensureDir("sessions", path.join(MON_ROOT, "sessions"), () => this._bump("sessions"));
    this._ensureDir("approvals", path.join(MON_ROOT, "approvals"), () => this._bump("approvals"));
    this._ensureDir("ui-runs", path.join(MON_ROOT, "ui-runs"), () => this._bump("runs"));
    this._ensureBrain();
  }

  _ensureDir(key, dir, onChange) {
    if (this._watchers.has(key)) return;
    try {
      const w = fs.watch(dir, onChange);
      w.on("error", () => { try { w.close(); } catch {} this._watchers.delete(key); });
      this._watchers.set(key, w);
    } catch { /* dir doesn't exist yet — retried by the rewatch timer */ }
  }

  // brain/<cid>/.system_generated/logs/transcript_full.jsonl — recursive watch,
  // map any path back to its conversation id.
  _ensureBrain() {
    if (this._watchers.has("brain")) return;
    try {
      const w = fs.watch(BRAIN_DIR, { recursive: true }, (_ev, file) => {
        if (!file) return this._bump("sessions");
        const cid = String(file).split(path.sep)[0];
        if (/^[A-Za-z0-9-]{8,}$/.test(cid)) this._bump("convo", { conversationId: cid });
      });
      w.on("error", () => { try { w.close(); } catch {} this._watchers.delete("brain"); });
      this._watchers.set("brain", w);
    } catch { /* no brain dir yet */ }
  }
}

module.exports = { AgyEvents, MON_ROOT, AGY_DIR };
