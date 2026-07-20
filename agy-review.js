"use strict";
/*
 * agy-review — one-shot Opus review of a workspace's working-tree diff.
 *
 * ONE static Messages-API call (no agentic loop, no tool use): the
 * working-tree diff + optional task context go in, structured findings come
 * back via output_config.format (json_schema — guaranteed parseable). The
 * transport lives in agy-anthropic.js — Bedrock via the AWS SSO "saml"
 * profile by default, first-party API via AGY_ANTHROPIC_PROVIDER=anthropic.
 * Results persist per-workspace under MON_ROOT/reviews/ with token usage,
 * list-price cost, and latency; findings are dismissable.
 */

const { execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { callAnthropic, usageMeta, responseText } = require("./agy-anthropic");

const MON_ROOT = process.env.AGY_MONITOR_ROOT || path.join(os.homedir(), ".agy-monitor");
const REVIEWS_DIR = path.join(MON_ROOT, "reviews");
const DIFF_CAP = 200 * 1024;      // bytes of diff sent for review
const UNTRACKED_CAP = 32 * 1024;  // per untracked file
const MAX_TOKENS = 16000;

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout) => {
      resolve(typeof stdout === "string" ? stdout : "");
    });
  });
}

function wsKey(workspace) {
  return crypto.createHash("sha1").update(workspace).digest("hex").slice(0, 16);
}
function reviewFile(workspace) {
  return path.join(REVIEWS_DIR, wsKey(workspace) + ".json");
}
function readReview(workspace) {
  try { return JSON.parse(fs.readFileSync(reviewFile(workspace), "utf8")); } catch { return null; }
}
function writeReview(workspace, rec) {
  fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  fs.writeFileSync(reviewFile(workspace), JSON.stringify(Object.assign({ workspace }, rec)));
}

// Working-tree diff as one review payload: git diff HEAD + untracked files
// appended as pseudo-diffs, size-capped.
async function collectDiff(ws) {
  const git = (args, extra) => execFileP("git", ["-C", ws].concat(args), extra);
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!branch) return { ok: false, message: "not a git repository" };
  let diff = await git(["diff", "HEAD", "--no-color", "-U10"]);
  const status = await git(["status", "--porcelain"]);
  const untracked = [];
  for (const line of status.split("\n")) {
    if (!line.startsWith("??")) continue;
    const rel = line.slice(3).replace(/^"|"$/g, "");
    try {
      const fp = path.join(ws, rel);
      const st = fs.statSync(fp);
      if (!st.isFile() || st.size > UNTRACKED_CAP) continue;
      const content = fs.readFileSync(fp, "utf8");
      if (content.includes("\0")) continue;
      untracked.push("--- /dev/null\n+++ b/" + rel + " (new file)\n" + content.split("\n").map((l) => "+" + l).join("\n"));
    } catch {}
  }
  diff += (diff && untracked.length ? "\n" : "") + untracked.join("\n");
  if (!diff.trim()) return { ok: false, message: "working tree clean — nothing to review" };
  let truncated = false;
  if (Buffer.byteLength(diff) > DIFF_CAP) { diff = diff.slice(0, DIFF_CAP); truncated = true; }
  const numstat = await git(["diff", "HEAD", "--numstat"]);
  let add = 0, del = 0, files = new Set();
  for (const line of numstat.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (m) { add += m[1] === "-" ? 0 : +m[1]; del += m[2] === "-" ? 0 : +m[2]; files.add(m[3]); }
  }
  for (const line of status.split("\n")) if (line.trim()) files.add(line.slice(3));
  return { ok: true, branch, diff, truncated, stats: { files: files.size, add, del } };
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["request_changes", "changes_suggested", "lgtm"] },
    summary: { type: "string", description: "2-3 sentence overall assessment of the diff" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "title", "explanation", "patch", "fix"],
        properties: {
          severity: { type: "string", enum: ["blocker", "warn", "nit"] },
          file: { type: "string" },
          line: { type: "integer" },
          title: { type: "string", description: "short finding title" },
          explanation: { type: "string", description: "why this matters, concretely" },
          patch: { type: "string", description: "small unified-diff-style suggested change, or empty string" },
          fix: { type: "string", description: "one-sentence fix instruction, ready to hand to a coding agent" },
        },
      },
    },
  },
};

const SYSTEM = "You are a rigorous senior code reviewer doing a ONE-SHOT static review of a working-tree diff. " +
  "You cannot run code or ask questions. Report real defects: correctness bugs, data loss, races, security holes, " +
  "silent failure modes, and robustness gaps a reviewer would block on. severity=blocker for must-fix defects, " +
  "warn for should-fix robustness/correctness risks, nit for minor polish. Do not pad the list — an empty findings " +
  "array with verdict lgtm is a valid answer. For each finding give the file:line it anchors to, a concrete " +
  "explanation, optionally a small suggested patch, and a one-sentence fix instruction a coding agent could execute.";

async function runReview({ workspace, task }) {
  if (typeof workspace !== "string" || !workspace) return { ok: false, message: "workspace required" };
  let ws;
  try { ws = fs.realpathSync(workspace); } catch { return { ok: false, message: "workspace not found" }; }

  const d = await collectDiff(ws);
  if (!d.ok) return d;

  writeReview(ws, { status: "running", at: Date.now() });

  const user = [
    task ? "The task being worked on:\n" + String(task).slice(0, 2000) : null,
    "Branch: " + d.branch + " · " + d.stats.files + " files · +" + d.stats.add + " −" + d.stats.del + (d.truncated ? " · (diff truncated for review)" : ""),
    "Review this working-tree diff:\n\n" + d.diff,
  ].filter(Boolean).join("\n\n");

  const out = await callAnthropic({
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [{ role: "user", content: user }],
  });
  if (!out.ok) {
    writeReview(ws, { status: "error", error: out.message, at: Date.now() });
    return out;
  }
  const text = responseText(out.response);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!parsed || !Array.isArray(parsed.findings)) {
    writeReview(ws, { status: "error", error: "unparseable review output", at: Date.now() });
    return { ok: false, message: "review output was not valid JSON" };
  }
  const rec = {
    status: "done",
    verdict: parsed.verdict || "changes_suggested",
    summary: parsed.summary || "",
    findings: parsed.findings.slice(0, 20),
    dismissed: [],
    scope: d.stats,
    meta: usageMeta(out.response, out.ms),
    at: Date.now(),
  };
  writeReview(ws, rec);
  return Object.assign({ ok: true, workspace: ws }, rec);
}

function getReview(workspace) {
  if (typeof workspace !== "string" || !workspace) return { ok: false, message: "workspace required" };
  let ws = workspace;
  try { ws = fs.realpathSync(workspace); } catch {}
  const rec = readReview(ws);
  if (!rec) return { ok: true, status: "idle" };
  return Object.assign({ ok: true }, rec);
}

function dismissFinding(workspace, index) {
  if (typeof workspace !== "string" || !workspace) return { ok: false, message: "workspace required" };
  let ws = workspace;
  try { ws = fs.realpathSync(workspace); } catch {}
  const rec = readReview(ws);
  if (!rec || rec.status !== "done") return { ok: false, message: "no completed review for that workspace" };
  if (typeof index !== "number" || index < 0 || index >= (rec.findings || []).length) return { ok: false, message: "bad finding index" };
  rec.dismissed = Array.from(new Set((rec.dismissed || []).concat([index])));
  writeReview(ws, rec);
  return Object.assign({ ok: true }, rec);
}

module.exports = { runReview, getReview, dismissFinding };
