"use strict";
/* sse.test.js — the change stream: hello frame on connect, then a pushed
   `approvals` event when an approval file lands (fs.watch → debounce → SSE). */

const fx = require("./fixtures");
const roots = fx.makeRoots("agy-sse-test-");
process.env.AGY_MONITOR_ROOT = roots.monRoot;
process.env.AGY_CLI_HOME = roots.agyHome;

const fs = require("fs");
const path = require("path");
const { start } = require("../server");

(async () => {
  const failures = [];
  const s = await start({ port: 0, token: "" });
  const base = `http://127.0.0.1:${s.port}`;

  const res = await fetch(base + "/api/stream");
  fx.assert(res.status === 200 && /event-stream/.test(res.headers.get("content-type") || ""), "stream connects", failures);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = frame.match(/^event: (\S+)$/m);
        if (m) seen.push(m[1]);
      }
    }
  })();

  for (let i = 0; i < 30 && !seen.includes("hello"); i++) await fx.sleep(100);
  fx.assert(seen.includes("hello"), "hello frame received on connect", failures);

  // drop an approval file → expect a pushed `approvals` event (no polling)
  fs.writeFileSync(path.join(roots.monRoot, "approvals", fx.CID + ".json"),
    JSON.stringify({ id: fx.CID + "-1", conversationId: fx.CID, command: "rm -rf /", cwd: "/tmp", reason: "test", ts: Math.floor(Date.now() / 1000) }));
  for (let i = 0; i < 40 && !seen.includes("approvals"); i++) await fx.sleep(100);
  fx.assert(seen.includes("approvals"), "approval file change pushed over SSE", failures);

  const h = await (await fetch(base + "/api/health")).json();
  fx.assert(h.approvals === 1, "health approval count reflects the pending file", failures);

  reader.cancel().catch(() => {});
  await s.close();
  fx.finish(failures, "sse.test");
})().catch((e) => { console.error(e); process.exit(1); });
