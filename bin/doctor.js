#!/usr/bin/env node
"use strict";
/*
 * doctor — environment checks for agy-monitor.
 *
 *   npm run doctor          (or: node bin/doctor.js)
 *
 * Prints one line per check (✓ ok, ! warn/info, ✗ fail) with a concrete fix
 * for anything not green. Exit 0 unless a hard failure (agy missing, node too
 * old) means the app can't do its core job.
 */

require("../agy-config").load();
const { runChecks } = require("../agy-doctor");

const ICON = { ok: "✓", warn: "!", info: "·", fail: "✗" };

(async () => {
  const { checks, summary } = await runChecks();
  console.log("agy-monitor doctor\n");
  for (const c of checks) {
    console.log(`  ${ICON[c.status] || "?"} ${c.label.padEnd(16)} ${c.detail}`);
    if (c.fix && c.status !== "ok") console.log(`      → ${c.fix}`);
  }
  console.log("");
  if (!summary.coreReady) {
    console.log("Error: core not ready — fix the ✗ items above, then re-run.");
    process.exit(1);
  }
  const bits = [
    "core ready",
    summary.hookLive ? "live state on" : "live state OFF (install the hook)",
    summary.reviewReady ? "Claude features ready" : "Claude features off (optional)",
  ];
  console.log(`✓ ${bits.join(" · ")}`);
})().catch((e) => {
  console.error("Error: doctor crashed: " + (e && e.message ? e.message : e));
  process.exit(1);
});
