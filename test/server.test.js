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
