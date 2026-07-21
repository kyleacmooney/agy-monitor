"use strict";
/* server.test.js — boot the real server in-process on port 0 with fixture roots:
   health, token gate, RPC dispatch, static serving + traversal guard, rate limit. */

const fx = require("./fixtures");
const roots = fx.makeRoots("agy-server-test-");
process.env.AGY_MONITOR_ROOT = roots.monRoot;
process.env.AGY_CLI_HOME = roots.agyHome;

const fs = require("fs");
const path = require("path");
const { start } = require("../server");

(async () => {
  const failures = [];
  fx.writeConversation(roots.agyHome);

  // --- token-gated instance -------------------------------------------------
  let s = await start({ port: 0, token: "sekret" });
  let base = `http://127.0.0.1:${s.port}`;

  const h = await (await fetch(base + "/api/health")).json();
  fx.assert(h.ok === true && h.name === "agy-monitor", "health is open + names the app", failures);
  fx.assert(typeof h.version === "string" && typeof h.approvals === "number" && typeof h.liveRuns === "number", "health carries version + counts", failures);

  fx.assert((await fetch(base + "/api/run", { method: "POST", body: "{}" })).status === 401, "POST without token → 401", failures);
  fx.assert((await fetch(base + "/api/stream")).status === 401, "stream without token → 401", failures);

  const auth = { "content-type": "application/json", authorization: "Bearer sekret" };
  const ws = await (await fetch(base + "/api/run", { method: "POST", headers: auth, body: JSON.stringify({ action: "list-workspaces" }) })).json();
  fx.assert(ws.ok === true, "authed RPC works", failures);

  const conv = await (await fetch(base + "/api/run", { method: "POST", headers: auth, body: JSON.stringify({ action: "get-conversation", conversationId: fx.CID }) })).json();
  fx.assert(conv.ok === true && conv.messages.length === 2, "get-conversation parses the fixture transcript", failures);
  fx.assert(conv.messages[0].ts === "2026-07-01T12:00:00Z", "messages carry timestamps", failures);

  const legacy = await (await fetch(base + "/api/run", { method: "POST", headers: auth, body: JSON.stringify({ toolId: "agy-monitor", input: { action: "list-workspaces" } }) })).json();
  fx.assert(legacy.ok === true, "legacy {toolId, input} body shape still accepted", failures);

  const unk = await (await fetch(base + "/api/run", { method: "POST", headers: auth, body: JSON.stringify({ action: "nope" }) })).json();
  fx.assert(unk.ok === false && /Unknown/.test(unk.message), "unknown action rejected cleanly", failures);

  fx.assert((await fetch(base + "/api/run", { method: "POST", headers: auth, body: "{{{" })).status === 400, "bad JSON → 400", failures);

  const idx = await fetch(base + "/");
  fx.assert(idx.status === 200 && /agy_monitor/.test(await idx.text()), "index.html served", failures);
  fx.assert((await fetch(base + "/render-agy-monitor.js")).status === 200, "shared renderer served from tool root", failures);
  fx.assert((await fetch(base + "/..%2Fagy-monitor.js")).status === 404, "path traversal blocked", failures);

  // --- backfill: brain/ conversations agy never wrote to its /resume index ---
  const post = (body) => fetch(base + "/api/run", { method: "POST", headers: auth, body: JSON.stringify(body) }).then((r) => r.json());
  const ORPHAN = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0009";
  const orphanWs = path.join(roots.base, "orphan-ws");
  fs.mkdirSync(orphanWs, { recursive: true });
  fx.writeConversation(roots.agyHome, { cid: ORPHAN, indexed: false });
  fx.writeHistoryLine(roots.agyHome, { cid: ORPHAN, workspace: orphanWs });

  const allc = await post({ action: "list-all-conversations" });
  const row = (allc.conversations || []).find((c) => c.conversationId === ORPHAN);
  fx.assert(!!row, "unindexed brain conversation is listed in all-chats", failures);
  fx.assert(row && row.backfilled === true, "backfilled row is flagged for the UI chip", failures);
  fx.assert(row && row.title === "hello agy", "backfilled title comes from the first user prompt, unwrapped", failures);
  fx.assert(row && row.numSteps === 3, "backfilled numSteps = max(step_index)+1", failures);
  fx.assert(row && Date.parse(row.updatedAt) === Date.parse("2026-07-01T12:00:05Z"), "backfilled updatedAt = last created_at, not the file mtime", failures);
  fx.assert(row && row.workspace === orphanWs && row.project === "orphan-ws", "backfilled workspace resolved from history.jsonl", failures);
  const indexedRow = (allc.conversations || []).find((c) => c.conversationId === fx.CID);
  fx.assert(indexedRow && indexedRow.backfilled === undefined, "indexed rows carry no backfilled key", failures);

  // a brain dir with no transcript must not produce an unopenable row
  const NOTX = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff000a";
  fs.mkdirSync(path.join(roots.agyHome, "brain", NOTX, ".user_uploaded"), { recursive: true });
  // ...nor one whose transcript has no user turn at all
  const NOUSER = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff000b";
  const nouserLogs = path.join(roots.agyHome, "brain", NOUSER, ".system_generated", "logs");
  fs.mkdirSync(nouserLogs, { recursive: true });
  fs.writeFileSync(path.join(nouserLogs, "transcript_full.jsonl"),
    JSON.stringify({ step_index: 0, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-07-01T12:00:00Z", content: "stillborn" }) + "\n");
  // ...nor a dir name that isn't a conversation id
  fs.mkdirSync(path.join(roots.agyHome, "brain", "not-a-uuid"), { recursive: true });
  const allc2 = await post({ action: "list-all-conversations" });
  const has = (cid) => (allc2.conversations || []).some((c) => c.conversationId === cid);
  fx.assert(!has(NOTX), "a transcript-less brain dir is skipped", failures);
  fx.assert(!has(NOUSER), "a transcript with zero user turns is skipped", failures);
  fx.assert(!has("not-a-uuid"), "a non-uuid brain dir never reaches a path.join", failures);

  // cache correctness: identical twice, then advances when the transcript grows
  const allc3 = await post({ action: "list-all-conversations" });
  fx.assert(JSON.stringify(allc2.conversations) === JSON.stringify(allc3.conversations), "repeat list is identical (mtime cache hit)", failures);
  const orphanTx = path.join(roots.agyHome, "brain", ORPHAN, ".system_generated", "logs", "transcript_full.jsonl");
  fs.appendFileSync(orphanTx, JSON.stringify({ step_index: 3, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-07-01T13:00:00Z", content: "<USER_REQUEST> more </USER_REQUEST>" }) + "\n");
  fs.utimesSync(orphanTx, new Date(), new Date(Date.now() + 1000)); // beat same-ms mtime granularity
  const grown = ((await post({ action: "list-all-conversations" })).conversations || []).find((c) => c.conversationId === ORPHAN);
  fx.assert(grown && grown.numSteps === 4, "appending a row advances numSteps (cache invalidates on mtime)", failures);
  fx.assert(grown && Date.parse(grown.updatedAt) === Date.parse("2026-07-01T13:00:00Z"), "appending a row advances updatedAt", failures);

  // search parity: a string that exists only inside the unindexed transcript
  const hit = await post({ action: "search-conversations", query: "all good" });
  const m = (hit.matches || []).find((x) => x.conversationId === ORPHAN);
  fx.assert(!!m, "unindexed conversation is full-text searchable", failures);
  fx.assert(m && m.backfilled === true && /all good/.test(m.snippet || ""), "search hit carries the chip flag and a snippet", failures);
  fx.assert((hit.matches || []).some((x) => x.conversationId === fx.CID && x.backfilled === undefined), "indexed search results keep their shape", failures);

  // open path: title + workspace no longer come back null
  const oconv = await post({ action: "get-conversation", conversationId: ORPHAN });
  fx.assert(oconv.ok === true && oconv.messages.length >= 2, "get-conversation opens an unindexed conversation", failures);
  fx.assert(oconv.title === "hello agy", "unindexed conversation gets a title from its transcript", failures);
  fx.assert(oconv.workspace === orphanWs, "unindexed conversation resolves its workspace for the DIFF panel", failures);

  // the project's own History tab must not be missing its backfilled chat
  const gh = await post({ action: "get-history", workspace: orphanWs });
  fx.assert(gh.ok === true && (gh.conversations || []).some((c) => c.conversationId === ORPHAN && c.backfilled === true),
    "backfilled conversation appears in its own project's History tab", failures);

  // --- noise folding: a helper that drives `agy -p` on every commit ----------
  // The decisive detail: one such prompt lands BOTH as an indexed record and as
  // an unindexed brain/ orphan, so a fix that only reaches one path leaves most
  // of the flood on screen. Seed both shapes and assert they share a group.
  const COMMIT_PROMPT = "Write a concise Git commit message for the following changes. Follow Conventional Commits format if possible...";
  const commitWs = path.join(roots.base, "commit-ws");
  fs.mkdirSync(commitWs, { recursive: true });
  const commitCids = [];
  for (let i = 0; i < 6; i++) {
    const cid = `bbbbbbbb-cccc-dddd-eeee-ffff0000000${i}`;
    commitCids.push(cid);
    // i<3 indexed, i>=3 orphan. #2 (indexed) and #5 (orphan) carry a diff far past
    // any bounded head read — the case that used to come back title-less and
    // unclusterable, and it has to be covered on BOTH code paths.
    fx.writeConversation(roots.agyHome, { cid, workspace: commitWs, indexed: i < 3, prompt: COMMIT_PROMPT, padBytes: (i === 2 || i === 5) ? 300000 : 0 });
    if (i >= 3) fx.writeHistoryLine(roots.agyHome, { cid, workspace: commitWs });
  }

  const folded = await post({ action: "list-all-conversations" });
  const frows = (folded.conversations || []).filter((c) => commitCids.includes(c.conversationId));
  fx.assert(frows.length === 6, "every commit-helper conversation is still listed — folded, not dropped", failures);
  const gk = frows[0] && frows[0].groupKey;
  fx.assert(!!gk && frows.every((c) => c.groupKey === gk), "all 6 share one groupKey across the indexed/orphan split", failures);
  fx.assert(frows.some((c) => c.backfilled === true) && frows.some((c) => c.backfilled === undefined),
    "…and that really was a mix of indexed and backfilled rows", failures);
  fx.assert(frows.every((c) => (c.groupLabel || "").startsWith("Write a concise Git commit message")),
    "the group label is the shared prompt", failures);
  // #2 is the load-bearing one: the INDEXED path reads a bounded head, so a
  // 300KB single-line record forces the by-hand salvage. (#5 is the same bytes on
  // the orphan path, which reads the whole file and never exercises that code —
  // it is here to prove the two paths agree, not as read-window coverage.)
  for (const [i, via] of [[2, "indexed — bounded read + salvage"], [5, "backfilled — whole-file read"]]) {
    const bigRow = frows.find((c) => c.conversationId === commitCids[i]);
    fx.assert(bigRow && (bigRow.firstPrompt || "").startsWith("Write a concise Git commit message"),
      `a first turn of 300KB still yields its prompt, not null (${via})`, failures);
    fx.assert(bigRow && !/USER_REQUEST/.test(bigRow.firstPrompt || ""),
      `…with no leaked wrapper tag (${via})`, failures);
  }
  fx.assert(frows.find((c) => c.conversationId === commitCids[2]).groupKey === gk,
    "…and the salvaged prompt clusters with the small ones", failures);

  // a run killed mid-flush leaves ONE half-written record and no trailing newline.
  // It never parses, but its head carries the prompt — and the mtime never changes
  // again, so giving up here would cache "untitled" forever.
  const TRUNC = "cccccccc-dddd-eeee-ffff-000000000003";
  fx.writeConversation(roots.agyHome, { cid: TRUNC, workspace: commitWs, title: "", prompt: COMMIT_PROMPT });
  const half = JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-07-01T12:00:00Z", content: "<USER_REQUEST> " + COMMIT_PROMPT + " diff --git a/server.js b/server.js" });
  fs.writeFileSync(path.join(roots.agyHome, "brain", TRUNC, ".system_generated", "logs", "transcript_full.jsonl"), half.slice(0, -40));
  const truncRow = ((await post({ action: "list-all-conversations" })).conversations || []).find((c) => c.conversationId === TRUNC);
  fx.assert(truncRow && (truncRow.firstPrompt || "").startsWith("Write a concise Git commit message"),
    "a transcript cut off mid-record still yields its prompt", failures);
  fx.assert(truncRow && truncRow.groupKey === gk, "…and joins the cluster rather than sitting alone", failures);
  const idxCommit = frows.find((c) => c.conversationId === commitCids[0]);
  fx.assert(idxCommit && (idxCommit.firstPrompt || "").startsWith("Write a concise Git commit message"),
    "indexed rows carry firstPrompt — agy's Preview alone could never identify them", failures);
  fx.assert(idxCommit && idxCommit.title === "Test convo" && idxCommit.firstPrompt !== idxCommit.title,
    "…and firstPrompt is independent of the displayed title", failures);
  fx.assert((folded.conversations || []).some((c) => c.conversationId === fx.CID && c.groupKey === undefined),
    "a chat with a one-off prompt is never folded", failures);
  fx.assert((folded.conversations || []).some((c) => c.conversationId === ORPHAN && c.groupKey === undefined),
    "…nor is the pre-existing backfilled chat", failures);

  // the fold must reach search too, or the group reappears row-by-row under
  // "FOUND INSIDE N MORE CONVERSATIONS" on the next keystroke
  const csearch = await post({ action: "search-conversations", query: "conventional commits" });
  const smatch = (csearch.matches || []).filter((m) => commitCids.includes(m.conversationId));
  fx.assert(smatch.length >= 5 && smatch.every((m) => m.groupKey === gk), "search results carry the same groupKey", failures);

  // and the project's own History tab, where the same helper also piles up
  const ghc = await post({ action: "get-history", workspace: commitWs });
  const hrows = (ghc.conversations || []).filter((c) => commitCids.includes(c.conversationId));
  fx.assert(hrows.length === 6 && hrows.every((c) => c.groupKey === gk), "project History tab folds the same cluster", failures);

  // Hydration budget: unindexed one-shot runs are ALWAYS newer than your real
  // work, so a plain newest-first cut at ORPHAN_HYDRATE_MAX spends every slot on
  // them and a genuinely recovered chat silently vanishes from All chats — the
  // fold cannot give back a row that was dropped before it ran.
  const REAL_OLD = "cccccccc-dddd-eeee-ffff-000000000001";
  fx.writeConversation(roots.agyHome, { cid: REAL_OLD, indexed: false, prompt: "why does the daemon bootstrap race when launchd relaunches it" });
  fx.writeHistoryLine(roots.agyHome, { cid: REAL_OLD, workspace: orphanWs });
  const oldTx = path.join(roots.agyHome, "brain", REAL_OLD, ".system_generated", "logs", "transcript_full.jsonl");
  const aMonthAgo = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(oldTx, aMonthAgo, aMonthAgo); // older than every commit run below
  for (let i = 0; i < 70; i++) {
    fx.writeConversation(roots.agyHome, { cid: `dddddddd-eeee-ffff-0000-0000000000${String(i).padStart(2, "0")}`, indexed: false, prompt: COMMIT_PROMPT });
  }
  const flooded = (await post({ action: "list-all-conversations" })).conversations || [];
  fx.assert(flooded.some((c) => c.conversationId === REAL_OLD),
    "a month-old recovered chat survives 70 newer folded one-shot runs", failures);
  fx.assert(flooded.some((c) => c.conversationId === ORPHAN),
    "…as does the earlier backfilled chat", failures);
  fx.assert(flooded.filter((c) => c.groupKey === gk).length > 5,
    "…and the cluster still fills the rest of the budget", failures);

  // no history line ⇒ workspace is legitimately null, and the row still lists
  const LOOSE = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff000c";
  fx.writeConversation(roots.agyHome, { cid: LOOSE, indexed: false });
  const loose = ((await post({ action: "list-all-conversations" })).conversations || []).find((c) => c.conversationId === LOOSE);
  fx.assert(loose && loose.workspace === null && loose.project === null, "an orphan with no history line has a null workspace", failures);
  fx.assert(loose && loose.title === "hello agy", "…and still lists with its transcript title", failures);

  await s.close();

  // --- open (no-token) instance + rate limit --------------------------------
  s = await start({ port: 0, token: "" });
  base = `http://127.0.0.1:${s.port}`;
  const open = await (await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list-workspaces" }) })).json();
  fx.assert(open.ok === true, "empty token = open on loopback", failures);

  let limited = false;
  for (let i = 0; i < 650; i++) {
    const r = await fetch(base + "/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "list-approvals" }) });
    if (r.status === 429) { limited = true; break; }
  }
  fx.assert(limited, "POST rate limit kicks in", failures);
  await s.close();

  fx.finish(failures, "server.test");
})().catch((e) => { console.error(e); process.exit(1); });
