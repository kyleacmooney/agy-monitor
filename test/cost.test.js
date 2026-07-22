"use strict";
/*
 * cost.test — conversationCost against REAL sqlite conversation DBs.
 *
 *   node test/cost.test.js
 *
 * The cost pipeline (sqliteQuery → gen_metadata → protobuf usage decode → prices)
 * had zero tests: nothing in the repo ever created a .db, so neither read path ran.
 * That is how the ?immutable=1 bug shipped — on a live conversation it returned
 * "malformed" or, worse, a stale-but-plausible row count.
 *
 * Three scenarios, each against a real sqlite3:
 *   1. a finished conversation: .db with no -wal        → the immutable path
 *   2. a LIVE conversation: a writer holds the db open,
 *      with rows sitting ONLY in the -wal               → the mode=ro path must see
 *      them; immutable provably reports one row short
 *   3. more rows land in the -wal only — the .db file's
 *      mtime/size never move                            → the wal-aware cache key
 *      must recompute; the old mtime-only key served the stale cost forever
 */
const assert = require("assert");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cost-test-"));
process.env.AGY_MONITOR_ROOT = path.join(BASE, "agy-monitor");
process.env.AGY_CLI_HOME = path.join(BASE, "antigravity-cli");
process.env.AGY_MONITOR_NO_PS = "1";
const CONV = path.join(process.env.AGY_CLI_HOME, "conversations");
fs.mkdirSync(CONV, { recursive: true });
fs.mkdirSync(path.join(process.env.AGY_CLI_HOME, "cache"), { recursive: true });

const { agyMonitor } = require("../agy-monitor.js");

const CID_DONE = "aaaaaaaa-0000-1111-2222-333333333333"; // finished: no -wal
const CID_LIVE = "bbbbbbbb-0000-1111-2222-333333333333"; // live: writer holds a -wal

// One gen_metadata row's blob: protobuf {1:{4:{2:100, 3:25, 5:50}}} — the shape
// usageOf() decodes (field 2 uncached input, 3+9 output, 5 cached), values kept
// single-byte so the encoding stays legible.
const ROW_HEX = "0a08" + "2206" + "1064" + "1819" + "2832";
// sanity: 0x0a len8 [ 0x22 len6 [ 0x10 100 | 0x18 25 | 0x28 50 ] ]

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + (e && e.message)); fail++; }
}

async function summary() {
  const r = await agyMonitor.run({ action: "cost-summary", days: 7 }, {});
  assert.ok(r && r.ok, "cost-summary ok");
  return r;
}
const itemOf = (r, cid) => (r.items || []).find((x) => x.conversationId === cid) || null;

// drive one long-lived sqlite3 process over stdin; `.print` markers gate each step
function holderExec(holder, sql, marker) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for " + marker)), 15000);
    const onData = (d) => {
      if (String(d).includes(marker)) { clearTimeout(t); holder.stdout.off("data", onData); resolve(); }
    };
    holder.stdout.on("data", onData);
    holder.stdin.write(sql + "\n.print " + marker + "\n");
  });
}

(async () => {
  // -- 1. finished conversation: no -wal, read via immutable --------------------
  const doneDb = path.join(CONV, CID_DONE + ".db");
  execFileSync("sqlite3", [doneDb,
    "CREATE TABLE gen_metadata(idx INTEGER, data BLOB); INSERT INTO gen_metadata VALUES(1, X'" + ROW_HEX + "');"]);
  let r = await summary();
  const one = itemOf(r, CID_DONE);
  let perRow = 0;
  check("a no-wal db is read and priced (the immutable path)", () => {
    assert.ok(one, "conversation listed");
    assert.ok(one.costUsd > 0, "nonzero cost from one decoded usage row");
    perRow = one.costUsd;
  });

  // -- 2. live conversation: rows in the -wal only ------------------------------
  const liveDb = path.join(CONV, CID_LIVE + ".db");
  const holder = spawn("sqlite3", [liveDb], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await holderExec(holder,
      "PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\n" +
      "CREATE TABLE gen_metadata(idx INTEGER, data BLOB);\n" +
      "INSERT INTO gen_metadata VALUES(1, X'" + ROW_HEX + "');\n" +
      "PRAGMA wal_checkpoint(TRUNCATE);", "SETUP1");
    // this row exists ONLY in the -wal; the main .db file still holds one row
    await holderExec(holder, "INSERT INTO gen_metadata VALUES(2, X'" + ROW_HEX + "');", "SETUP2");
    assert.ok(fs.statSync(liveDb + "-wal").size > 0, "precondition: the -wal holds the new row");

    r = await summary();
    const live2 = itemOf(r, CID_LIVE);
    check("a LIVE db is read through its -wal — both rows priced, not the stale main file", () => {
      assert.ok(live2, "live conversation listed");
      assert.ok(Math.abs(live2.costUsd - 2 * perRow) < 1e-9,
        `expected 2 rows' worth (${2 * perRow}), got ${live2.costUsd} — immutable would see 1`);
    });

    // -- 3. the cache key must cover the -wal -----------------------------------
    const before = fs.statSync(liveDb);
    await holderExec(holder, "INSERT INTO gen_metadata VALUES(3, X'" + ROW_HEX + "');", "SETUP3");
    const after = fs.statSync(liveDb);
    r = await summary();
    const live3 = itemOf(r, CID_LIVE);
    check("a wal-only write invalidates the cost cache even though the .db never moved", () => {
      assert.strictEqual(before.mtimeMs, after.mtimeMs, "precondition: .db mtime frozen — only the -wal grew");
      assert.strictEqual(before.size, after.size, "precondition: .db size frozen");
      assert.ok(Math.abs(live3.costUsd - 3 * perRow) < 1e-9,
        `expected 3 rows' worth (${3 * perRow}), got ${live3.costUsd} — an mtime-keyed cache serves the stale 2-row cost`);
    });
  } finally {
    try { holder.stdin.end(); } catch {}
    try { holder.kill("SIGKILL"); } catch {}
  }

  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
