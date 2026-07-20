"use strict";
/* runs.test.js — RunManager lifecycle against a stub agy binary:
   managed send (running → done + parsed result), busy serialization, stop,
   error capture, and new-conversation early cid resolution. */

const fx = require("./fixtures");
const roots = fx.makeRoots("agy-runs-test-");
process.env.AGY_MONITOR_ROOT = roots.monRoot;
process.env.AGY_CLI_HOME = roots.agyHome;

const fs = require("fs");
const path = require("path");
const { RunManager } = require("../agy-runs");

const readRun = (cid) => JSON.parse(fs.readFileSync(path.join(roots.monRoot, "ui-runs", cid + ".json"), "utf8"));

(async () => {
  const failures = [];
  const stub = fx.writeAgyStub(roots.base, roots.agyHome);
  const ws = path.join(roots.base, "ws");
  fs.mkdirSync(ws, { recursive: true });

  const events = [];
  const bus = { emit: (_t, ev) => events.push(ev) };
  const rm = new RunManager({ agyBin: stub, events: bus });

  // send → running record → done record with the parsed json result
  const r1 = rm.send({ conversationId: fx.CID, workspace: ws, message: "hi" });
  fx.assert(r1.ok === true, "send starts a managed run", failures);
  fx.assert(rm.isBusy(fx.CID), "conversation is busy while running", failures);
  fx.assert(readRun(fx.CID).status === "running", "running record written", failures);

  const r2 = rm.send({ conversationId: fx.CID, workspace: ws, message: "again" });
  fx.assert(r2.ok === false && r2.busy === true, "second send while busy → {busy:true}", failures);

  for (let i = 0; i < 50 && rm.isBusy(fx.CID); i++) await fx.sleep(100);
  const done = readRun(fx.CID);
  fx.assert(done.status === "done", "run finalized as done", failures);
  fx.assert(done.result && done.result.status === "SUCCESS" && done.result.usage.total_tokens === 125, "exit json captured (status + usage)", failures);
  fx.assert(events.some((e) => e && e.type === "runs"), "runs change event emitted", failures);

  // error path: non-zero exit + stderr tail
  process.env.STUB_EXIT = "3";
  rm.send({ conversationId: fx.CID, workspace: ws, message: "fail please" });
  for (let i = 0; i < 50 && rm.isBusy(fx.CID); i++) await fx.sleep(100);
  const err = readRun(fx.CID);
  fx.assert(err.status === "error" && err.exitCode === 3, "failed run recorded as error with exit code", failures);
  fx.assert(/simulated failure/.test(err.errorTail || ""), "stderr tail captured", failures);
  delete process.env.STUB_EXIT;

  // stop: SIGTERM the group → recorded as stopped
  process.env.STUB_SLEEP = "10";
  rm.send({ conversationId: fx.CID, workspace: ws, message: "long one" });
  await fx.sleep(200);
  const st = rm.stop(fx.CID);
  fx.assert(st.ok === true, "stop accepted for a live run", failures);
  for (let i = 0; i < 50 && rm.isBusy(fx.CID); i++) await fx.sleep(100);
  fx.assert(readRun(fx.CID).status === "stopped", "stopped run recorded as stopped", failures);
  delete process.env.STUB_SLEEP;

  // new conversation: early cid via last_conversations.json
  const nc = await rm.startNew({ workspace: ws, message: "fresh", agyDir: roots.agyHome });
  fx.assert(nc.ok === true && nc.conversationId === fx.CID, "startNew resolves the new conversation id early", failures);
  for (let i = 0; i < 50 && rm.liveCount() > 0; i++) await fx.sleep(100);

  fx.finish(failures, "runs.test");
})().catch((e) => { console.error(e); process.exit(1); });
