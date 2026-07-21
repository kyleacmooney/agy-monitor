/*
 * renderAgyMonitor — frontend renderer for the agy-monitor ops console (v3).
 *
 * EMBEDDING: this renderer is host-agnostic — to mount it inside another
 * dashboard, provide the two globals it relies on, el(tag, attrs, children) and
 * runTool(toolId, input), and register `renderAgyMonitor` in that host's
 * renderer map (keyed by tool.ui). The `.agy-*` classes live in
 * public/styles.css — copy those too. IBM Plex Sans/Mono are expected (Google
 * Fonts link in index.html); system fonts are the fallback.
 *
 * No innerHTML anywhere. When the standalone shell is present
 * (window.AGY_SHELL) refreshes are pushed over SSE and the interval is a slow
 * safety net; in a plain embed there's no push, so poll at 4s.
 *
 * Layout: a 3-panel console — left sidebar (sessions, drag-resizable, collapses
 * to an icon rail), main column (52px header + view + composer strip), right
 * workspace panel (diff/turn tabs, collapses to a rail). One reconcilePanels()
 * enforces leftRendered + rightRendered + 380 ≤ innerWidth on every drag,
 * toggle, view open and window resize.
 *
 * Navigation uses the History API. Sub-view state lives in the QUERY STRING
 * (?convo=… / ?history=… / ?context=… / ?all / ?safelist / ?new / ?file=…); the
 * URL HASH is never touched, so a host hub that routes on the hash is unaffected.
 */

function renderAgyMonitor(tool) {
  const shell = (typeof window !== "undefined" && window.AGY_SHELL) || null;

  // ---------- tiny helpers ----------
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function agoShort(iso) {
    if (!iso) return "";
    const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  const tsAgoShort = (ms) => (ms ? agoShort(new Date(ms).toISOString()) : "");

  function fmtCost(usd) {
    if (usd == null) return "";
    if (usd === 0) return "$0.00";
    if (usd < 0.01) return "<$0.01";
    if (usd < 100) return "$" + usd.toFixed(2);
    return "$" + Math.round(usd);
  }
  // Label for a folded "repeated prompt" group. The server caps first prompts at
  // 100 chars, which lands mid-word on a long preamble — quote it and mark the cut.
  function noiseLabel(s) {
    if (!s) return "";
    const t = s.trim();
    return "“" + (t.length >= 100 ? t.slice(0, 96).replace(/\s+\S*$/, "") + "…" : t) + "”";
  }

  // Split conversation rows into the ordinary ones and the clusters the server
  // tagged as a repeated one-shot prompt. Used by every list that shows chats.
  function splitNoise(rows) {
    const plain = [], byKey = new Map();
    for (const c of rows || []) {
      if (!c || !c.groupKey) { if (c) plain.push(c); continue; }
      if (!byKey.has(c.groupKey)) byKey.set(c.groupKey, { key: c.groupKey, label: c.groupLabel, items: [] });
      byKey.get(c.groupKey).items.push(c);
    }
    return { plain, noise: [...byKey.values()] };
  }

  // One collapsible "REPEATED PROMPT" section. Collapsed by default and its rows
  // are built lazily on first expand — a cluster can be hundreds of chats, and
  // building DOM for all of them just to hide it defeats the point of folding.
  // Collapse state lives in S.collapsed so it survives the 4s/15s repaint.
  function noiseSection(g, rowFn, matching, scope) {
    const key = "noise:" + scope + ":" + g.key;
    if (S.collapsed[key] === undefined) S.collapsed[key] = true;
    let open = !S.collapsed[key], built = false;
    const list = el("div", { class: "agy-cardlist" });
    const fill = () => { if (built) return; built = true; for (const c of g.items) list.appendChild(rowFn(c)); };
    if (open) fill();
    list.style.display = open ? "" : "none";
    const chev = el("span", { class: "chev", text: open ? "▾" : "▸" });
    const n = g.items.length;
    // while a query is live the count is of MATCHES, so the header never implies
    // the fold is hiding more than the search actually found
    const noun = matching ? (n === 1 ? " MATCH" : " MATCHES") : (n === 1 ? " CHAT" : " CHATS");
    const head = el("div", {
      class: "agy-chatgroup-head clickable",
      onclick: () => {
        open = !open;
        S.collapsed[key] = !open;
        if (open) fill();
        list.style.display = open ? "" : "none";
        chev.textContent = open ? "▾" : "▸";
      },
    }, [
      chev,
      el("span", { class: "n", text: "REPEATED PROMPT · " + n + noun }),
      el("span", { class: "p", text: noiseLabel(g.label) }),
    ]);
    return el("div", { class: "agy-chatgroup" }, [head, list]);
  }
  function tokTip(t) {
    if (!t) return "list-price estimate, not a bill";
    const n = (x) => (x || 0).toLocaleString();
    return `${n(t.uncachedInput)} input · ${n(t.cached)} cached · ${n(t.output)} output — list-price estimate, not a bill`;
  }

  // state → {cls (dot/text class), label (chip), detail fallback}
  function stateMeta(s) {
    switch (s && s.state) {
      case "waiting": return { cls: "waiting", chip: "needs you", short: "WAITING", detail: (s && s.stateDetail) || "needs attention" };
      case "idle":    return { cls: "idle",    chip: "your turn", short: "IDLE",    detail: (s && s.stateDetail) || "your turn" };
      case "busy":    return { cls: "busy",    chip: "busy",      short: "BUSY",    detail: (s && s.stateDetail) || "working" };
      default:        return { cls: "running", chip: "running",   short: "RUNNING", detail: (s && s.stateDetail) || "running" };
    }
  }
  const RUN_META = {
    running: { cls: "busy", label: "running" }, waiting: { cls: "waiting", label: "needs approval" },
    done: { cls: "done", label: "done" }, error: { cls: "error", label: "error" }, stopped: { cls: "done", label: "stopped" },
  };

  const sessKey = (s) => s.conversationId || ("pid:" + s.pid);
  const memCtx = (s) => ({ project: s.project, shortWorkspace: s.shortWorkspace, workspace: s.workspace });

  // ---------- rich text / markdown (no innerHTML) ----------
  function richText(text, openFile) {
    const out = [];
    const re = /\[([^\]]+)\]\(([^)\s]+)\)|((?:file|https?):\/\/[^\s)<>"']+)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
      let label, url;
      if (m[1] != null) { label = m[1]; url = m[2]; }
      else { url = m[3]; label = url.startsWith("file://") ? decodeURIComponent(url).split("/").pop() : url; }
      out.push(linkNode(label, url, openFile));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(document.createTextNode(text.slice(last)));
    return out;
  }
  function linkNode(label, url, openFile) {
    const isFile = url.startsWith("file://") || url.startsWith("/");
    if (isFile && openFile) {
      return el("a", { class: "agy-filelink", href: "#", text: label,
        onclick: (e) => { e.preventDefault(); openFile(url, label); } });
    }
    if (/^https?:\/\//.test(url)) {
      return el("a", { class: "agy-link", href: url, target: "_blank", rel: "noreferrer", text: label });
    }
    return document.createTextNode(label);
  }

  function renderMarkdown(text, openFile) {
    if (!text) return [];
    const nodes = [];
    for (const part of String(text).split(/(```[\s\S]*?```)/g)) {
      if (!part) continue;
      const fence = part.match(/^```([^\n]*)\n?([\s\S]*?)```$/);
      if (fence) {
        const lang = fence[1].trim();
        const code = fence[2].replace(/\n$/, "");
        nodes.push(el("pre", { class: "agy-md-code" },
          [lang ? el("div", { class: "agy-md-code-lang", text: lang }) : null, document.createTextNode(code)].filter(Boolean)));
      } else {
        for (const n of renderMdBlocks(part, openFile)) nodes.push(n);
      }
    }
    return nodes;
  }
  function renderMdBlocks(text, openFile) {
    const nodes = [];
    const lines = text.split("\n");
    let para = [];
    const flush = () => {
      const s = para.join("\n").replace(/\s+$/, "");
      if (s.trim()) nodes.push(el("div", { class: "agy-md-p" }, renderInline(s, openFile)));
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flush(); nodes.push(el("div", { class: "agy-md-h", style: { fontSize: (17 - h[1].length) + "px" } }, renderInline(h[2], openFile))); continue; }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        flush();
        const items = [];
        while (i < lines.length) {
          const lm = lines[i].match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
          if (!lm) break;
          items.push(el("li", {}, renderInline(lm[1], openFile)));
          i++;
        }
        i--;
        nodes.push(el("ul", { class: "agy-md-list" }, items));
        continue;
      }
      if (line.trim() === "") { flush(); continue; }
      para.push(line);
    }
    flush();
    return nodes;
  }
  function renderInline(text, openFile) {
    const out = [];
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\[[^\]]+\]\([^)\s]+\))|((?:file|https?):\/\/[^\s)<>"']+)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
      const t = m[0];
      if (m[1]) out.push(el("code", { class: "agy-md-ic", text: t.slice(1, -1) }));
      else if (m[2] || m[3]) out.push(el("strong", { text: t.slice(2, -2) }));
      else if (m[4]) { const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t); out.push(linkNode(mm[1], mm[2], openFile)); }
      else if (m[5]) out.push(linkNode(t.startsWith("file://") ? decodeURIComponent(t).split("/").pop() : t, t, openFile));
      else out.push(el("em", { text: t.slice(1, -1) }));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(document.createTextNode(text.slice(last)));
    return out;
  }

  // ---------- persisted UI prefs ----------
  const PREF_KEY = "agy-ui-v3";
  function loadPrefs() {
    try { return Object.assign({ leftW: 288, rightW: 336, leftOpen: true, rightOpen: true, diffFs: 11 }, JSON.parse(localStorage.getItem(PREF_KEY) || "{}")); }
    catch { return { leftW: 288, rightW: 336, leftOpen: true, rightOpen: true, diffFs: 11 }; }
  }
  const P = loadPrefs();
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ leftW: P.leftW, rightW: P.rightW, leftOpen: P.leftOpen, rightOpen: P.rightOpen, diffFs: P.diffFs })); } catch {}
  }

  // ---------- volatile state ----------
  const S = {
    view: { kind: "overview" },
    navDepth: 0,
    curPos: 0, maxPos: 0,  // absolute position in this session's nav stack → back/forward enablement
    focusIdx: -1,          // j/k focus over the flattened session list
    palOpen: false, palQuery: "", palIdx: 0, palPick: false,
    rightTab: "diff",      // diff | turn  (mcp/review arrive with their features)
    collapsed: {},         // ws-panel collapse map (file paths…) — truthy = collapsed
    expanded: {},          // opt-in row expansion (mcp tool/skill descriptions) — truthy = expanded
    ctxOn: false,
    panes: [], paneFocus: 0, // split view (conversation ids)
    splitCtx: null,          // focused pane's ctx (header + workspace panel follow it)
    asks: {},                // ask-card drafts/answers, keyed per card (survives re-renders)
  };

  // ---------- data ----------
  const D = {
    sessions: [], approvals: [], runs: [], spend: null, fanouts: [],
    commands: [], // slash-command metadata (fetched once; static per server)
    externals: [], externalsAt: 0, // other agents' sessions (read-only; refetched lazily)
    setup: null, // doctor checks (setup-status; fetched once at boot, then on demand)
    lastFetch: 0,
  };

  // ---------- skeleton ----------
  const root = el("div", { class: "agy-app" });
  const sideHost = el("div", { style: { display: "contents" } });
  const mainEl = el("div", { class: "agy-main" });
  const headerEl = el("header", { class: "agy-header" });
  const bannerHost = el("div", { style: { display: "contents" } });
  const viewEl = el("div", { class: "agy-view" });
  const compHost = el("div", { style: { display: "contents" } });
  mainEl.appendChild(headerEl); mainEl.appendChild(bannerHost); mainEl.appendChild(viewEl); mainEl.appendChild(compHost);
  const wsHost = el("div", { style: { display: "contents" } });
  root.appendChild(sideHost); root.appendChild(mainEl); root.appendChild(wsHost);

  // ---------- panel geometry ----------
  const MAIN_MIN = 380;
  const hasWorkspace = () => ["convo", "split", "context", "history"].includes(S.view.kind) && !S.view.external;
  function reconcilePanels() {
    const vw = window.innerWidth || 1440;
    const ws = hasWorkspace();
    const rendered = () => (P.leftOpen ? P.leftW : 54) + (ws ? (P.rightOpen ? P.rightW : 46) : 0);
    let over = rendered() + MAIN_MIN - vw;
    if (over > 0 && ws && P.rightOpen) { const cut = Math.min(over, P.rightW - 264); P.rightW -= cut; over -= cut; }
    if (over > 0 && P.leftOpen) { const cut = Math.min(over, P.leftW - 216); P.leftW -= cut; over -= cut; }
    if (over > 0 && P.leftOpen) { P.leftOpen = false; over = rendered() + MAIN_MIN - vw; }
    if (over > 0 && ws && P.rightOpen) { P.rightOpen = false; }
    savePrefs();
  }
  function startDrag(side, e) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? P.leftW : P.rightW;
    const handle = e.currentTarget;
    handle.classList.add("dragging");
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const vw = window.innerWidth || 1440;
      if (side === "left") {
        const other = hasWorkspace() ? (P.rightOpen ? P.rightW : 46) : 0;
        const max = Math.max(216, Math.min(440, vw - other - MAIN_MIN));
        P.leftW = Math.max(216, Math.min(max, startW + dx));
        applyPanelWidths();
      } else {
        const other = P.leftOpen ? P.leftW : 54;
        const max = Math.max(264, Math.min(620, vw - other - MAIN_MIN));
        P.rightW = Math.max(264, Math.min(max, startW - dx));
        applyPanelWidths();
      }
      renderHeader(); // compaction follows the measured main width
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      handle.classList.remove("dragging");
      reconcilePanels(); applyPanels();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }
  let sideEl = null, wsEl = null;
  function applyPanelWidths() {
    if (sideEl && P.leftOpen) sideEl.style.width = P.leftW + "px";
    if (wsEl && P.rightOpen) wsEl.style.width = P.rightW + "px";
  }
  function toggleLeft() { P.leftOpen = !P.leftOpen; reconcilePanels(); applyPanels(); }
  function toggleRight() { P.rightOpen = !P.rightOpen; reconcilePanels(); applyPanels(); }
  function applyPanels() { renderSide(); renderPanel(); renderHeader(); }

  // ---------- connection UI ----------
  const CONN_LABEL = { live: "LIVE", reconnecting: "RECONNECTING", offline: "OFFLINE" };
  let connDotEl = null; // set by renderSide
  function renderBanner() {
    clear(bannerHost);
    const c = shell ? shell.conn : { state: "live" };
    if (c && c.state !== "live") {
      const msg = c.state === "offline"
        ? "stream offline — showing last snapshot" + (D.lastFetch ? " from " + new Date(D.lastFetch).toLocaleTimeString() : "")
        : "event stream dropped — retrying" + (c.retryMs ? " in " + Math.round(c.retryMs / 1000) + "s" : "") + " · data may be stale";
      bannerHost.appendChild(el("div", { class: "agy-conn-banner " + c.state }, [
        el("span", { class: "d" }), el("span", { class: "t", text: msg }),
      ]));
    }
    // onboarding: surface a broken/half-configured environment everywhere except
    // the setup page itself (which shows the full detail)
    if (D.setup && S.view.kind !== "setup" && !S.setupDismissed) {
      const sum = D.setup.summary || {};
      let text = null, cls = "warn";
      if (!sum.coreReady) { text = "agy-monitor isn't fully set up — the checks page has the fixes"; cls = "fail"; }
      else if (!sum.hookLive) text = "live state is off — the agy hook isn't installed (one click to fix)";
      if (text) {
        bannerHost.appendChild(el("div", { class: "agy-setup-banner " + cls }, [
          el("span", { class: "d" }),
          el("span", { class: "t", text }),
          el("button", { class: "agy-btn sm", text: "Open setup", onclick: () => navTop({ kind: "setup" }) }),
          el("button", { class: "agy-ghost", text: "✕", title: "hide until next reload", onclick: () => { S.setupDismissed = true; renderBanner(); } }),
        ]));
      }
    }
  }
  function renderConn() {
    const c = shell ? shell.conn : { state: "live" };
    const state = (c && c.state) || "live";
    if (connDotEl) {
      connDotEl.className = "agy-conn " + state;
      const lab = connDotEl.querySelector(".agy-conn-label");
      if (lab) lab.textContent = CONN_LABEL[state] || "";
    }
    renderBanner();
  }
  if (shell) shell.onConn = renderConn;

  // ---------- attention (NEEDS YOU) ----------
  function attentionItems() {
    const items = [];
    for (const a of D.approvals) {
      items.push({
        title: "$ " + (a.command || ""), sub: ((a.cwd ? a.cwd.split("/").pop() : a.project) || "?") + " · approval",
        go: () => { if (a.conversationId) openConvo({ conversationId: a.conversationId }); else navTop({ kind: "overview" }); },
      });
    }
    for (const s of D.sessions) {
      if (s.state === "waiting" && s.conversationId) {
        items.push({ title: s.title || s.prompt || "(untitled)", sub: (s.project || "?") + " · " + stateMeta(s).detail, go: () => openConvo(sessCtx(s)) });
      }
    }
    for (const g of D.fanouts) {
      if (g.status === "done" && !g.applied) {
        items.push({ title: "⑃ pick a winner — " + g.task, sub: g.project + " · " + g.strategy, go: () => go({ kind: "fanout", id: g.id }) });
      }
    }
    return items;
  }
  const sessCtx = (s) => ({
    conversationId: s.conversationId, title: s.title, project: s.project,
    shortWorkspace: s.shortWorkspace, workspace: s.workspace, state: s.state, stateDetail: s.stateDetail, mode: s.mode,
  });

  // ---------- sidebar ----------
  function renderSide() {
    clear(sideHost);
    if (!P.leftOpen) { renderSideRail(); return; }
    const aside = el("aside", { class: "agy-side", style: { width: P.leftW + "px" } });
    sideEl = aside;

    // brand row
    const connState = (shell && shell.conn && shell.conn.state) || "live";
    const conn = el("span", { class: "agy-conn " + connState }, [
      el("span", { class: "agy-conn-dot" }),
      el("span", { class: "agy-conn-label", text: CONN_LABEL[connState] || "" }),
    ]);
    connDotEl = conn;
    aside.appendChild(el("div", { class: "agy-brand-row" }, [
      el("div", { class: "agy-brand" }, [
        el("span", { class: "b1", text: "agy" }), el("span", { class: "b2", text: "_" }), el("span", { class: "b3", text: "monitor" }),
      ]),
      el("div", { class: "agy-brand-right" }, [
        conn,
        el("span", { class: "agy-collapse", title: "collapse sidebar ( [ )", text: "⟨", onclick: toggleLeft }),
      ]),
    ]));

    // palette trigger
    aside.appendChild(el("div", { class: "agy-pal-trigger-wrap" }, [
      el("div", { class: "agy-pal-trigger", onclick: () => openPalette(false) }, [
        el("span", { class: "ph", text: "Jump to session or action…" }),
        el("span", { class: "agy-kbd", text: "⌘K" }),
      ]),
    ]));

    // nav
    const NAV = [
      { kind: "overview", label: "Overview", icon: "▤", kbd: "1" },
      { kind: "allchats", label: "All chats", icon: "≡", kbd: "2" },
      { kind: "safelist", label: "Safelist", icon: "⛨", kbd: "3" },
      { kind: "newchat", label: "New chat", icon: "+", kbd: "N" },
    ];
    aside.appendChild(el("nav", { class: "agy-nav" }, NAV.map((n) => el("div", {
      class: "agy-nav-item" + (S.view.kind === n.kind ? " active" : ""),
      onclick: () => navTop({ kind: n.kind, ctx: {} }),
    }, [
      el("span", { class: "lft" }, [el("span", { class: "ico", text: n.icon }), el("span", { class: "lab", text: n.label })]),
      el("span", { class: "kbd", text: n.kbd }),
    ]))));

    // NEEDS YOU
    const att = attentionItems();
    if (att.length) {
      aside.appendChild(el("div", { class: "agy-needs" }, [
        el("div", { class: "agy-needs-head" }, [
          el("span", { class: "t", text: "NEEDS YOU" }),
          el("span", { class: "agy-needs-badge", text: String(att.length) }),
        ]),
      ].concat(att.map((a) => el("div", { class: "agy-att-row", onclick: a.go }, [
        el("span", { class: "t", text: a.title }),
        el("span", { class: "s", text: a.sub }),
      ])))));
    }

    // session groups
    const scroll = el("div", { class: "agy-side-scroll" });
    if (!D.sessions.length) {
      scroll.appendChild(el("div", { class: "agy-side-empty" }, [
        document.createTextNode("No live sessions."), el("br"), document.createTextNode("Start agy in any terminal."),
      ]));
    } else {
      const groups = new Map();
      for (const s of D.sessions) {
        const key = s.workspace || "(unknown)";
        if (!groups.has(key)) groups.set(key, { project: s.project || "(unknown)", sessions: [] });
        groups.get(key).sessions.push(s);
      }
      for (const g of groups.values()) {
        const grp = el("div", { class: "agy-group" }, [
          el("div", { class: "agy-group-head" }, [
            el("span", { class: "n", text: g.project }),
            el("span", { class: "c", text: String(g.sessions.length) }),
          ]),
        ]);
        for (const s of g.sessions) grp.appendChild(sessRow(s));
        scroll.appendChild(grp);
      }
    }
    // OTHER AGENTS — read-only transcripts from Codex / Copilot on this machine
    if (D.externals.length) {
      const ext = el("div", { class: "agy-ext-sec" }, [
        el("div", { class: "agy-ext-head" }, [
          el("span", { class: "t", text: "OTHER AGENTS" }),
          el("span", { class: "r", text: "READ-ONLY" }),
        ]),
      ]);
      for (const x of D.externals) {
        const selected = S.view.kind === "external" && S.view.id === x.id;
        ext.appendChild(el("div", {
          class: "agy-ext-row" + (selected ? " selected" : ""),
          onclick: () => go({ kind: "external", id: x.id }),
        }, [
          el("span", { class: "agy-ext-tag", text: x.agent }),
          el("span", { class: "t", text: x.title || "(untitled)" }),
          el("span", { class: "ago", text: x.updatedAt ? tsAgoShort(x.updatedAt) : "" }),
        ]));
      }
      scroll.appendChild(ext);
    }
    aside.appendChild(scroll);

    // footer — spend + hints
    const foot = el("div", { class: "agy-side-foot" });
    const sp = D.spend;
    foot.appendChild(el("div", { class: "agy-spend-row" }, [
      el("span", { class: "agy-lbl", text: "SPEND · 7D" }),
      el("span", { class: "agy-spend-total" }, [
        document.createTextNode(sp ? fmtCost(sp.total) : "…"),
        el("span", { class: "sub", text: sp ? " · " + sp.count + " convo" + (sp.count === 1 ? "" : "s") : "" }),
      ]),
    ]));
    const bars = (sp && sp.spark && sp.spark.length ? sp.spark : new Array(14).fill(0)).map((v) => (typeof v === "number" ? v : v.usd || 0));
    const mx = Math.max(0.0001, ...bars);
    foot.appendChild(el("div", { class: "agy-spark" }, bars.map((v, i) => el("span", {
      class: i === bars.length - 1 ? "last" : "",
      title: "$" + v.toFixed(2),
      style: { height: Math.max(8, Math.round((v / mx) * 100)) + "%" },
    }))));
    foot.appendChild(el("div", { class: "agy-hint", text: "⌘K PALETTE · J/K MOVE · N NEW CHAT · [ ] PANELS · ⌘[ ⌘] BACK/FWD" }));
    aside.appendChild(foot);

    sideHost.appendChild(aside);
    const drag = el("div", { class: "agy-drag left", title: "drag to resize", onmousedown: (e) => startDrag("left", e) });
    sideHost.appendChild(drag);
  }

  function sessRow(s) {
    const meta = stateMeta(s);
    const idx = D.sessions.indexOf(s);
    const selected = (S.view.kind === "convo" && s.conversationId && S.view.ctx && S.view.ctx.conversationId === s.conversationId)
      || (S.view.kind === "split" && s.conversationId && S.panes.includes(s.conversationId));
    const un = s.unread || 0;
    const row = el("div", {
      class: "agy-sess-row" + (selected ? " selected" : "") + (idx === S.focusIdx && !selected ? " kfocus" : "") + (un ? " unread" : ""),
      onclick: s.conversationId ? (e) => clickSession(e, s) : undefined,
      title: s.conversationId ? undefined : "no conversation attached yet",
    }, [
      el("span", { class: "agy-dot " + meta.cls }),
      el("span", { class: "mid" }, [
        el("span", { class: "t", text: s.title || s.prompt || "(untitled)" }),
        el("span", { class: "s" }, [
          el("span", { class: "agy-tc-" + meta.cls, text: meta.detail }),
          document.createTextNode(" · " + (agoShort(s.lastActivity || s.startedAt) || s.elapsed || "")),
        ]),
      ]),
      un ? el("span", { class: "agy-unread", text: String(un) })
         : (s.costUsd != null ? el("span", { class: "cost", title: tokTip(s.tokens), text: fmtCost(s.costUsd) }) : null),
    ]);
    return row;
  }

  function renderSideRail() {
    const aside = el("aside", { class: "agy-side-rail" });
    aside.appendChild(el("span", { class: "brand" }, [document.createTextNode("a"), el("span", { class: "u", text: "_" })]));
    aside.appendChild(el("span", { class: "agy-rail-btn", title: "expand sidebar ( [ )", text: "⟩", onclick: toggleLeft }));
    aside.appendChild(el("span", { class: "agy-rail-btn pal", title: "command palette (⌘K)", text: "›", onclick: () => openPalette(false) }));
    const NAV = [
      { kind: "overview", icon: "▤", label: "Overview" },
      { kind: "allchats", icon: "≡", label: "All chats" },
      { kind: "safelist", icon: "⛨", label: "Safelist" },
      { kind: "newchat", icon: "+", label: "New chat" },
    ];
    for (const n of NAV) aside.appendChild(el("span", {
      class: "agy-rail-btn" + (S.view.kind === n.kind ? " active" : ""), title: n.label, text: n.icon,
      onclick: () => navTop({ kind: n.kind, ctx: {} }),
    }));
    const att = attentionItems();
    if (att.length) aside.appendChild(el("span", { class: "agy-rail-att", title: "needs you", text: String(att.length), onclick: () => navTop({ kind: "overview" }) }));
    aside.appendChild(el("div", { class: "agy-rail-sep" }));
    const dots = el("div", { class: "agy-rail-dots" });
    for (const s of D.sessions) {
      const meta = stateMeta(s);
      const selected = (S.view.kind === "convo" && s.conversationId && S.view.ctx && S.view.ctx.conversationId === s.conversationId)
        || (S.view.kind === "split" && s.conversationId && S.panes.includes(s.conversationId));
      dots.appendChild(el("span", {
        class: "agy-dot " + meta.cls + (selected ? " selected" : ""),
        title: (s.title || s.prompt || "(untitled)") + " — " + meta.detail,
        onclick: s.conversationId ? (e) => clickSession(e, s) : undefined,
      }));
    }
    aside.appendChild(dots);
    sideHost.appendChild(aside);
    sideEl = null;
  }

  // ---------- header ----------
  let headStatusText = "";
  function renderHeader() {
    clear(headerEl);
    const mainW = Math.max(0, (window.innerWidth || 1440) - (P.leftOpen ? P.leftW + 5 : 54) - (hasWorkspace() ? (P.rightOpen ? P.rightW + 5 : 46) : 0));
    const compact = mainW < 820;
    const tight = mainW < 640;
    const v = S.view;

    const left = el("div", { class: "hleft" });
    // back/forward through this session's nav stack — the only way to move in a PWA
    // window (no browser chrome). Shown once you've navigated; greyed at the ends.
    if (S.maxPos > 0) {
      const canBack = S.curPos > 0, canFwd = S.curPos < S.maxPos;
      left.appendChild(el("span", { class: "agy-back" + (canBack ? "" : " disabled"), title: "back (⌘[ or esc)", text: "←", onclick: canBack ? () => history.back() : undefined }));
      left.appendChild(el("span", { class: "agy-back" + (canFwd ? "" : " disabled"), title: "forward (⌘])", text: "→", onclick: canFwd ? () => history.forward() : undefined }));
    }

    let crumb = "AGY MONITOR", title = "Overview", chip = null;
    if (v.kind === "convo") {
      const s = v.ctx && v.ctx.conversationId ? D.sessions.find((x) => x.conversationId === v.ctx.conversationId) : null;
      crumb = (v.ctx && v.ctx.project) || (s && s.project) || "chat";
      title = (v.ctx && v.ctx.title) || (s && (s.title || s.prompt)) || "conversation";
      if (s) {
        const meta = stateMeta(s);
        chip = { cls: meta.cls, label: meta.chip, pulse: s.state === "busy" || s.state === "waiting" };
      } else {
        const run = v.ctx && v.ctx.conversationId ? D.runs.find((r) => r.conversationId === v.ctx.conversationId) : null;
        if (run && (run.status === "running" || run.status === "waiting")) {
          const rm = RUN_META[run.status];
          chip = { cls: rm.cls, label: rm.label, pulse: true };
        } else chip = { cls: "done", label: "history", pulse: false };
      }
    } else if (v.kind === "split") { crumb = "SPLIT VIEW"; title = S.panes.length + " conversations side-by-side"; }
    else if (v.kind === "fanout") {
      const g = v.fanout || D.fanouts.find((x) => x.id === v.id);
      crumb = (g && g.project) || "fan-out";
      title = (g && g.task) || "fan-out";
      const fc = g ? (FAN_CHIP[g.status] || FAN_CHIP.done) : FAN_CHIP.done;
      chip = { cls: fc.cls, label: fc.label, pulse: g && (g.status === "running" || g.status === "judging" || g.status === "done") };
    }
    else if (v.kind === "external") {
      const x = D.externals.find((e2) => e2.id === v.id);
      crumb = (v.extProject || (x && x.project)) || "external";
      title = (v.extTitle || (x && x.title)) || "imported session";
      chip = { cls: "done", label: (x && x.agent ? x.agent.toLowerCase() + " · " : "") + "read-only", pulse: false };
    }
    else if (v.kind === "allchats") title = "All chats";
    else if (v.kind === "safelist") title = "Safelist review";
    else if (v.kind === "setup") title = "Setup";
    else if (v.kind === "newchat") title = "New chat";
    else if (v.kind === "context") { crumb = (v.ctx && v.ctx.project) || "project"; title = "Context"; }
    else if (v.kind === "history") { crumb = (v.ctx && v.ctx.project) || "project"; title = "History"; }
    else if (v.kind === "file") { crumb = "file"; title = v.label || "file"; }

    if (!(tight && v.kind === "convo")) {
      left.appendChild(el("span", { class: "agy-crumb", text: crumb }));
      left.appendChild(el("span", { class: "agy-crumb-sep", text: "/" }));
    }
    left.appendChild(el("span", { class: "agy-htitle", text: title }));
    if (chip) {
      const chipEl = el("span", {
        class: "agy-chip agy-tc-" + chip.cls, title: chip.label,
        style: { background: "color-mix(in srgb, currentColor 10%, transparent)" },
      }, [
        el("span", { class: "agy-dot " + chip.cls + (chip.pulse ? "" : " nopulse") }),
        tight ? null : el("span", { text: chip.label }),
      ]);
      left.appendChild(chipEl);
    }
    headerEl.appendChild(left);

    const right = el("div", { class: "hright" });
    if (v.kind === "convo" || v.kind === "split") {
      const actionCtx = v.kind === "split" ? (S.splitCtx || (S.panes[S.paneFocus] ? ctxForCid(S.panes[S.paneFocus]) : {})) : (v.ctx || {});
      if (v.kind === "convo") {
        const cost = v.costUsd != null ? fmtCost(v.costUsd) : null;
        if (cost && !compact) right.appendChild(el("span", { class: "agy-hcost", title: tokTip(v.tokens), text: "≈ " + cost }));
      }
      right.appendChild(el("span", {
        class: "agy-hbtn", title: "fork — new conversation seeded with this one's context",
        text: compact ? "⑂" : "⑂ fork",
        onclick: () => forkNow(null),
      }));
      right.appendChild(el("span", {
        class: "agy-hbtn accent",
        title: v.kind === "split" ? "add another conversation (or ⌘click a session)" : "open another conversation side-by-side (or ⌘click a session)",
        text: v.kind === "split" ? (compact ? "＋" : "＋ add") : (compact ? "⫿" : "⫿ split"),
        onclick: () => openPalette(true),
      }));
      right.appendChild(el("span", {
        class: "agy-hbtn", title: "project context (GEMINI.md / AGENTS.md)", text: compact ? "≣" : "context",
        onclick: () => go({ kind: "context", ctx: memCtx(actionCtx) }),
      }));
      right.appendChild(el("span", {
        class: "agy-hbtn", title: "project history — past conversations", text: compact ? "↺" : "history",
        onclick: () => go({ kind: "history", ctx: memCtx(actionCtx) }),
      }));
      // ⚖ review verdict chip (once a review exists for this workspace)
      const rv = PANEL.review;
      if (!tight && rv && rv.status === "done") {
        const live = (rv.findings || []).filter((_, i) => !(rv.dismissed || []).includes(i));
        const nb = live.filter((f) => f.severity === "blocker").length;
        const nw = live.filter((f) => f.severity === "warn").length;
        const color = nb ? "var(--red)" : nw ? "var(--amber)" : "var(--green)";
        const label = compact
          ? (nb || nw ? "⚖ " + nb + "·" + nw : "⚖ ✓")
          : (nb ? "⚖ " + nb + " BLOCKER" + (nb > 1 ? "S" : "") + (nw ? " · " + nw + " WARN" : "") : nw ? "⚖ " + nw + " WARN" : "⚖ LGTM");
        right.appendChild(el("span", {
          class: "agy-rv-chip", title: "Opus review verdict — click to open",
          style: { color, borderColor: "color-mix(in srgb, " + color + " 40%, transparent)" },
          text: label,
          onclick: () => { S.rightTab = "review"; if (!P.rightOpen) toggleRight(); else renderPanel(); },
        }));
      }
    }
    if (headStatusText && !tight && (v.kind === "overview" || v.kind === "allchats")) {
      right.appendChild(el("span", { class: "agy-hstatus", text: headStatusText }));
    }
    if (hasWorkspace()) {
      right.appendChild(el("span", {
        class: "agy-wstoggle" + (P.rightOpen ? " on" : ""), title: "workspace panel ( ] )", text: "◨", onclick: toggleRight,
      }));
    }
    headerEl.appendChild(right);
  }

  // ---------- workspace panel (DIFF / TURN) ----------
  // PANEL holds the current workspace's parsed git diff plus the last turn's
  // file set (computed from the open conversation). refreshPanel() re-fetches
  // and only re-renders when the diff signature actually changed.
  const PANEL = { workspace: null, data: null, sig: "", turnFiles: null, turnLabel: null, mcp: null, mcpAt: 0, review: null, reviewRunning: false };
  async function refreshPanel(workspace) {
    if (!hasWorkspace() || !workspace) return;
    PANEL.workspace = workspace;
    refreshMcp(workspace);
    refreshReview(workspace);
    let res;
    try { res = await runTool(tool.id, { action: "workspace-diff", workspace }); } catch { return; }
    if (PANEL.workspace !== workspace || !hasWorkspace()) return; // superseded
    if (!res) return;
    if (!res.ok) res = { ok: true, git: false, branch: null, files: [], error: res.message || "no workspace" };
    const sig = (res.branch || "") + "|" + (res.files || []).map((f) => f.path + ":" + f.add + ":" + f.del).join("|") + "#" + JSON.stringify(res.files || []).length;
    if (sig === PANEL.sig) return;
    PANEL.sig = sig;
    PANEL.data = res;
    renderPanel();
  }
  async function refreshReview(workspace) {
    if (PANEL.reviewRunning) return; // the in-flight run-review call owns the state
    let res;
    try { res = await runTool(tool.id, { action: "get-review", workspace }); } catch { return; }
    if (!res || !res.ok || PANEL.workspace !== workspace) return;
    const sig = JSON.stringify([res.status, res.verdict, (res.findings || []).length, (res.dismissed || []).length]);
    const changed = !PANEL.review || PANEL.review._sig !== sig || PANEL.review.workspace !== workspace;
    PANEL.review = Object.assign({ workspace, _sig: sig }, res);
    if (changed) { renderPanel(); renderHeader(); }
  }
  async function runReviewNow() {
    const workspace = PANEL.workspace;
    if (!workspace || PANEL.reviewRunning) return;
    PANEL.reviewRunning = true;
    PANEL.review = Object.assign({}, PANEL.review, { workspace, status: "running" });
    S.rightTab = "review";
    if (!P.rightOpen) { P.rightOpen = true; reconcilePanels(); }
    renderPanel();
    let task = null;
    if (S.view.kind === "convo" && S.view.ctx && S.view.ctx.title) task = S.view.ctx.title;
    try {
      const res = await runTool(tool.id, { action: "run-review", workspace, task });
      PANEL.review = Object.assign({ workspace, _sig: "fresh" + Date.now() }, res.ok ? res : { status: "error", error: res.message });
      if (shell) shell.toast(res.ok ? "⚖ Opus review ready — " + (res.findings || []).length + " findings" : "Review failed: " + (res.message || "unknown"));
    } catch (e) {
      PANEL.review = { workspace, status: "error", error: String((e && e.message) || e) };
    }
    PANEL.reviewRunning = false;
    renderPanel(); renderHeader();
  }

  async function refreshMcp(workspace) {
    if (Date.now() - PANEL.mcpAt < 30000 && PANEL.mcp && PANEL.mcp.workspace === workspace) return;
    PANEL.mcpAt = Date.now();
    let res;
    try { res = await runTool(tool.id, { action: "list-mcp", workspace }); } catch { return; }
    if (!res || !res.ok) return;
    const sig = JSON.stringify([res.servers, res.skills]);
    const changed = !PANEL.mcp || PANEL.mcp.sig !== sig;
    PANEL.mcp = { workspace, servers: res.servers || [], skills: res.skills || [], sig };
    if (changed) renderPanel();
  }
  function setTurnInfo(files, label) {
    const sig = JSON.stringify([files, label]);
    if (PANEL._turnSig === sig) return;
    PANEL._turnSig = sig;
    PANEL.turnFiles = files;
    PANEL.turnLabel = label;
    if (S.rightTab === "turn") renderPanel();
  }
  function inTurnSet(relPath) {
    if (!PANEL.turnFiles || !PANEL.turnFiles.length) return false;
    return PANEL.turnFiles.some((f) => f === relPath || f.endsWith("/" + relPath));
  }

  function renderPanel() {
    clear(wsHost);
    if (!hasWorkspace()) { wsEl = null; return; }
    const data = PANEL.data;
    const files = (data && data.files) || [];
    if (!P.rightOpen) {
      const rail = el("aside", { class: "agy-ws-rail" }, [
        el("span", { class: "agy-rail-btn", title: "workspace panel ( ] )", text: "⟨", onclick: toggleRight }),
        el("span", { class: "g", title: "workspace panel ( ] )", text: "⎇", onclick: toggleRight }),
        files.length ? el("span", { class: "n", title: files.length + " changed file" + (files.length === 1 ? "" : "s") + " — workspace panel ( ] )", text: String(files.length), onclick: toggleRight }) : null,
      ]);
      wsHost.appendChild(rail);
      wsEl = null;
      return;
    }
    wsHost.appendChild(el("div", { class: "agy-drag", title: "drag to resize", onmousedown: (e) => startDrag("right", e) }));
    const aside = el("aside", { class: "agy-ws", style: { width: P.rightW + "px" } });
    wsEl = aside;
    const mcp = PANEL.mcp;
    const mcpUp = mcp ? mcp.servers.filter((s) => s.status === "connected").length : 0;
    aside.appendChild(el("div", { class: "agy-ws-head" }, [
      el("span", { class: "lft" }, [
        el("span", { class: "agy-lbl", text: "WORKSPACE" }),
        data && data.branch ? el("span", { class: "agy-ws-branch" }, [
          document.createTextNode("⎇ " + data.branch + " "),
          files.length ? el("span", { class: "dirty", text: "+" + files.length }) : null,
        ]) : null,
        mcp && mcp.servers.length ? el("span", {
          class: "agy-mcp-chip" + (mcpUp < mcp.servers.length ? " err" : ""),
          title: "MCP servers — connected / total", text: "⌁ " + mcpUp + "/" + mcp.servers.length + " MCP",
          onclick: () => { S.rightTab = "mcp"; renderPanel(); },
        }) : null,
      ]),
      el("span", { class: "agy-collapse", title: "collapse panel ( ] )", text: "⟩", onclick: toggleRight }),
    ]));
    const rv = PANEL.review;
    const liveFindings = rv && rv.status === "done"
      ? (rv.findings || []).filter((_, i) => !(rv.dismissed || []).includes(i)) : [];
    aside.appendChild(el("div", { class: "agy-ws-tabs" }, [
      el("span", { class: "agy-wtab" + (S.rightTab === "diff" ? " active" : ""), text: "DIFF" + (files.length ? " · " + files.length : ""), onclick: () => { S.rightTab = "diff"; renderPanel(); } }),
      el("span", { class: "agy-wtab" + (S.rightTab === "turn" ? " active" : ""), title: "only the files touched since your last message", text: "TURN", onclick: () => { S.rightTab = "turn"; renderPanel(); } }),
      el("span", { class: "agy-wtab" + (S.rightTab === "mcp" ? " active" : ""), text: "MCP", onclick: () => { S.rightTab = "mcp"; renderPanel(); } }),
      el("span", { class: "agy-wtab" + (S.rightTab === "review" ? " active" : ""), onclick: () => { S.rightTab = "review"; renderPanel(); } }, [
        el("span", { text: "⚖ REVIEW" }),
        liveFindings.length ? el("span", { class: "badge", text: String(liveFindings.length) }) : null,
      ]),
    ]));
    const bodyWrap = el("div", { class: "agy-ws-body-wrap" });
    const body = el("div", { class: "agy-ws-body" });

    if (S.rightTab === "review") {
      renderReviewTab(body, liveFindings);
    } else if (S.rightTab === "mcp") {
      renderMcpTab(body);
    } else {
      const turnMode = S.rightTab === "turn";
      const shown = turnMode ? files.filter((f) => inTurnSet(f.path)) : files;
      if (turnMode && PANEL.turnLabel) body.appendChild(el("div", { class: "agy-turnlabel", text: PANEL.turnLabel }));
      if (!data) body.appendChild(el("div", { class: "agy-ws-empty", text: "loading…" }));
      else if (data.git === false) body.appendChild(el("div", { class: "agy-ws-empty", text: data.error ? "No diff — " + data.error : "Not a git repository." }));
      else if (!shown.length) body.appendChild(el("div", { class: "agy-ws-empty", text: turnMode ? "No files changed this turn." : "Working tree clean — no changes yet." }));
      for (const f of shown) body.appendChild(fileBlock(f));
    }
    bodyWrap.appendChild(body);
    const showDiffTools = S.rightTab !== "mcp" && S.rightTab !== "review";
    bodyWrap.appendChild(el("div", { class: "agy-ws-foot" }, [
      showDiffTools ? el("span", { class: "grp" }, [
        el("span", { class: "agy-ws-tool" + (S.ctxOn ? " on" : ""), title: "show surrounding context lines", text: "±CTX", onclick: () => { S.ctxOn = !S.ctxOn; renderPanel(); } }),
        el("span", { class: "agy-ws-tool", title: "smaller diff text", text: "A−", onclick: () => { P.diffFs = Math.max(9, P.diffFs - 1); savePrefs(); renderPanel(); } }),
        el("span", { class: "agy-ws-tool", title: "larger diff text", text: "A＋", onclick: () => { P.diffFs = Math.min(15, P.diffFs + 1); savePrefs(); renderPanel(); } }),
      ]) : null,
      el("span", { class: "proj", text: (S.view.ctx && S.view.ctx.project) || (data && data.workspace ? data.workspace.split("/").pop() : "") }),
    ]));
    aside.appendChild(bodyWrap);
    wsHost.appendChild(aside);
  }

  const VERDICT_LABEL = { request_changes: "REQUEST CHANGES", changes_suggested: "CHANGES SUGGESTED", lgtm: "LGTM" };
  function renderReviewTab(body, liveFindings) {
    const rv = PANEL.review;
    const wrap = el("div", { class: "agy-rv-wrap" });
    body.appendChild(wrap);
    const data = PANEL.data;
    const files = (data && data.files) || [];
    const add = files.reduce((a, f) => a + f.add, 0), del = files.reduce((a, f) => a + f.del, 0);
    const estUsd = Math.max(0.05, ((add + del) * 60 / 4 * 5 + 2500 * 25) / 1e6); // rough: ~60 chars/line in + ~2.5k out
    const estLine = files.length + " files · +" + add + " −" + del + " · est ~$" + estUsd.toFixed(2) + " · single API call, no loop";

    if (!rv || rv.status === "idle" || rv.status === "error") {
      wrap.appendChild(el("div", { class: "agy-rv-idle" }, [
        el("span", { class: "g", text: "⚖" }),
        el("span", { class: "t", text: "One-shot Opus review" }),
        el("span", { class: "d", text: "Sends the working-tree diff + your task to a Claude Opus model for a static review. No agentic loop, no tool use — one call, fixed cost. Findings come back as ready-to-send fix instructions for agy." }),
        el("span", { class: "est", text: estLine }),
        rv && rv.status === "error" ? el("span", { class: "d", style: { color: "var(--red)" }, text: rv.error || "last review failed" }) : null,
        el("button", { class: "agy-btn sm", text: "Run review", style: { marginTop: "4px" }, onclick: runReviewNow }),
        el("span", { class: "also", text: "also: /review in any composer" }),
      ]));
      return;
    }
    if (rv.status === "running") {
      wrap.appendChild(el("div", { class: "agy-rv-running" }, [
        el("span", { class: "g", text: "⚖" }),
        el("span", { class: "t", text: "opus is reviewing the diff…" }),
        el("span", { class: "s", text: "single API call · no loop" }),
      ]));
      return;
    }
    // done
    const meta = rv.meta || {};
    wrap.appendChild(el("div", { class: "agy-rv-verdict " + (rv.verdict || "changes_suggested") }, [
      el("div", { class: "top" }, [
        el("span", { class: "v", text: "⚖ " + (VERDICT_LABEL[rv.verdict] || rv.verdict) }),
        el("span", { class: "rerun", title: "re-run the opus review on the current diff — one paid api call, replaces these findings and clears dismissals", text: "↻ re-run", onclick: runReviewNow }),
      ]),
      el("span", { class: "sum", text: rv.summary || "" }),
      el("span", { class: "meta", text: [meta.model, meta.inTokens != null ? (meta.inTokens / 1000).toFixed(1) + "k in / " + (meta.outTokens / 1000).toFixed(1) + "k out" : null, meta.costUsd != null ? "$" + meta.costUsd.toFixed(2) : null, meta.ms != null ? Math.round(meta.ms / 1000) + "s" : null].filter(Boolean).join(" · ") }),
    ]));
    if (!liveFindings.length) {
      wrap.appendChild(el("div", { class: "agy-ws-empty", text: (rv.findings || []).length ? "All findings dismissed." : "No findings." }));
      return;
    }
    for (const f of liveFindings) {
      const realIdx = (rv.findings || []).indexOf(f);
      wrap.appendChild(el("div", { class: "agy-rv-finding" }, [
        el("div", { class: "head" }, [
          el("span", { class: "agy-sev " + f.severity, text: f.severity }),
          el("span", { class: "loc", text: f.file + (f.line ? ":" + f.line : "") }),
          el("span", { class: "agy-x", text: "✕", title: "dismiss finding", onclick: async () => {
            try { const res = await runTool(tool.id, { action: "dismiss-finding", workspace: PANEL.workspace, index: realIdx }); if (res && res.ok) { PANEL.review = Object.assign({ workspace: PANEL.workspace, _sig: "d" + Date.now() }, res); renderPanel(); renderHeader(); } } catch {}
          } }),
        ]),
        el("div", { class: "bd" }, [
          el("span", { class: "t", text: f.title }),
          el("span", { class: "m", text: f.explanation }),
          f.patch ? el("div", { class: "agy-rv-patch" }, f.patch.split("\n").map((l) => el("div", {
            class: l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : "c", text: l,
          }))) : null,
          el("div", { class: "agy-rv-actions" }, [
            el("button", { class: "agy-btn xs", text: "→ send to agy", onclick: () => {
              const instruction = "Fix from Opus review (" + f.file + (f.line ? ":" + f.line : "") + "): " + (f.fix || f.title);
              if (S.activeComposer && S.activeComposer.insert) { S.activeComposer.insert(instruction); if (shell) shell.toast("→ Fix instruction drafted — review and send to agy"); }
              else if (shell) shell.toast("Open a conversation composer first");
            } }),
            el("span", { class: "note", text: "drafts a fix instruction in the composer" }),
          ]),
        ]),
      ]));
    }
  }

  function renderMcpTab(body) {
    const mcp = PANEL.mcp;
    // A name + a one-line description that ellipsizes in this narrow panel. The full
    // text is otherwise unreachable, so hover shows it and clicking wraps the row open.
    function descRow(cls, key, head, desc) {
      const text = desc || "";
      const exp = !!S.expanded[key];
      return el("div", {
        class: cls + (exp ? " open" : "") + (text ? " has-desc" : ""),
        title: text || undefined,
        onclick: text ? () => { S.expanded[key] = !exp; renderPanel(); } : undefined,
      }, head.concat([el("span", { class: "d", text })]));
    }

    if (!mcp) { body.appendChild(el("div", { class: "agy-ws-empty", text: "probing MCP servers…" })); return; }
    body.appendChild(el("div", { class: "agy-mcp-sec", text: "MCP SERVERS" }));
    if (!mcp.servers.length) body.appendChild(el("div", { class: "agy-ws-empty", text: "No MCP servers configured." }));
    for (const sv of mcp.servers) {
      const key = "mcp:" + sv.name;
      const open = !S.collapsed[key];
      const ok = sv.status === "connected";
      body.appendChild(el("div", {
        class: "agy-mcp-server",
        onclick: () => { S.collapsed[key] = open; renderPanel(); },
      }, [
        el("span", { class: "chev", text: open ? "▾" : "▸" }),
        el("span", { class: "agy-dot " + (ok ? "idle" : "waiting") }),
        el("span", { class: "n", text: sv.name }),
        el("span", { class: "tr", text: sv.transport }),
        el("span", { class: "st agy-tc-" + (ok ? "idle" : "error"), text: ok ? "connected" : "error" }),
        el("span", { class: "ct", text: sv.tools.length + " tools" }),
      ]));
      if (sv.error) body.appendChild(el("div", { class: "agy-mcp-err", text: sv.error }));
      if (open) for (const t of sv.tools) body.appendChild(descRow("agy-mcp-tool", "mcptool:" + sv.name + ":" + t.name, [
        el("span", { class: "n", text: t.name }),
      ], t.description));
    }
    body.appendChild(el("div", { class: "agy-mcp-sec", text: "SKILLS · " + mcp.skills.length }));
    if (!mcp.skills.length) body.appendChild(el("div", { class: "agy-ws-empty", text: "No skills found." }));
    for (const sk of mcp.skills) body.appendChild(descRow("agy-skill-row", "skill:" + sk.name, [
      el("span", { class: "dia", text: "◆" }),
      el("span", { class: "n", text: sk.name }),
    ], sk.description));
    body.appendChild(el("div", { class: "agy-mcp-note" }, [
      document.createTextNode("Type "),
      el("span", { class: "s", text: "/" }),
      document.createTextNode(" in any composer to run these — commands, MCP tools, and skills autocomplete."),
    ]));
  }

  function fileBlock(f) {
    const open = !S.collapsed[f.path];
    const blockKids = [
      el("div", {
        class: "agy-fhead",
        onclick: () => { S.collapsed[f.path] = open; renderPanel(); },
      }, [
        el("span", { class: "chev", text: open ? "▾" : "▸" }),
        el("span", { class: "stletter " + f.st, text: f.st }),
        el("span", { class: "fpath", text: "‎" + f.path }), // LRM keeps rtl-ellipsis from mangling the tail
        el("span", { class: "stats" }, [
          el("span", { class: "a", text: "+" + f.add }), document.createTextNode(" "),
          el("span", { class: "d", text: "−" + f.del }),
        ]),
      ]),
    ];
    if (open) {
      const bodyEl = el("div", { class: "agy-fbody" });
      for (const hk of f.hunks || []) {
        bodyEl.appendChild(el("div", { class: "agy-hunkhead", style: { fontSize: Math.max(9, P.diffFs - 1) + "px" }, text: hk.header }));
        for (const [mark, text] of hk.lines || []) {
          if (mark === " " && !S.ctxOn) continue;
          const cls = mark === "+" ? "add" : mark === "-" ? "del" : "ctx";
          bodyEl.appendChild(el("div", { class: "agy-dline " + cls }, [
            el("span", { class: "mk", style: { fontSize: P.diffFs + "px" }, text: mark === "-" ? "−" : mark }),
            el("span", { class: "tx", style: { fontSize: P.diffFs + "px" }, text: text }),
          ]));
        }
      }
      if (!(f.hunks || []).length) bodyEl.appendChild(el("div", { class: "agy-ws-empty", text: f.st === "D" ? "(deleted)" : "(no textual diff)" }));
      blockKids.push(bodyEl);
    }
    return el("div", { class: "agy-file" }, blockKids);
  }

  // ---------- data refresh ----------
  let timer = null;
  function clearTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    if (shell) shell.notify = null;
  }
  let viewTick = null; // per-view refresh (conversation polling etc.)
  async function tick() {
    await refreshCore();
    if (viewTick) { try { await viewTick(); } catch {} }
  }
  function startLoop() {
    clearTimer();
    timer = setInterval(tick, shell ? 15000 : 4000);
    if (typeof registerPoller === "function") registerPoller(timer);
    if (shell) shell.notify = tick;
  }

  let refreshing = false;
  async function refreshCore() {
    if (refreshing) return;
    refreshing = true;
    try {
      const [sess, aps, runs, spend, fans] = await Promise.all([
        runTool(tool.id, { action: "fetch-sessions" }).catch(() => null),
        runTool(tool.id, { action: "list-approvals" }).catch(() => null),
        runTool(tool.id, { action: "list-ui-runs" }).catch(() => null),
        runTool(tool.id, { action: "cost-summary", days: 7 }).catch(() => null),
        runTool(tool.id, { action: "list-fanouts" }).catch(() => null),
      ]);
      if (sess && sess.ok) D.sessions = sess.data || [];
      if (aps && aps.ok) D.approvals = aps.approvals || [];
      if (runs && runs.ok) D.runs = runs.runs || [];
      if (spend && spend.ok) D.spend = spend;
      if (fans && fans.ok) D.fanouts = fans.groups || [];
      if (Date.now() - D.externalsAt > 60000) { // other agents change slowly — 1/min is plenty
        D.externalsAt = Date.now();
        runTool(tool.id, { action: "list-external" })
          .then((r) => { if (r && r.ok) { D.externals = r.externals || []; renderSide(); } }).catch(() => {});
      }
      if (D.setup === null) { D.setup = false; fetchSetup(true); } // once per boot (false = in flight)
      D.lastFetch = Date.now();
      headStatusText = D.sessions.length + " RUNNING · " + new Date().toLocaleTimeString([], { hour12: false });
      renderSide();
      renderHeader();
      if (S.view.kind === "overview" && S.overviewRefresh) S.overviewRefresh();
    } finally { refreshing = false; }
  }

  // ---------- views ----------

  // -- setup / doctor --
  async function fetchSetup(firstBoot) {
    let r = null;
    try { r = await runTool(tool.id, { action: "setup-status" }); } catch {}
    D.setup = (r && r.ok) ? r : null;
    renderBanner();
    if (S.view.kind === "setup" && S.setupRefresh) S.setupRefresh();
    // first-run experience: a broken core environment lands you ON the fixes,
    // not on an empty overview (only from the default view — never yank a deep link)
    if (firstBoot && D.setup && !D.setup.summary.coreReady && S.view.kind === "overview") {
      history.replaceState({ kind: "setup", navDepth: 0, pos: S.curPos }, "", urlFor({ kind: "setup" }));
      render({ kind: "setup" });
    }
    return D.setup;
  }

  const SETUP_ICON = { ok: "✓", warn: "!", fail: "✗", info: "·" };
  function mountSetup() {
    viewTick = null;
    clear(compHost);
    clear(viewEl);
    const wrap = el("div", { class: "agy-setup" });
    viewEl.appendChild(wrap);
    let busy = false;

    function draw() {
      clear(wrap);
      const s = D.setup;
      const sum = (s && s.summary) || {};
      if (s && !sum.coreReady) {
        wrap.appendChild(el("div", { class: "agy-setup-hero" }, [
          el("span", { class: "h", text: "▸ let's get agy-monitor wired up" }),
          el("span", { class: "s", text: "The dashboard watches the agy CLI's own data on this machine. Fix the ✗ items below (each has its command), then re-check — everything else here is optional." }),
        ]));
      }
      const head = el("div", { class: "agy-setup-head" }, [
        el("span", { class: "agy-lbl", text: "ENVIRONMENT CHECKS" }),
        el("button", {
          class: "agy-btn sm", text: busy ? "checking…" : "↻ Re-check",
          onclick: async () => { if (busy) return; busy = true; draw(); await fetchSetup(false); busy = false; draw(); },
        }),
      ]);
      wrap.appendChild(head);
      if (!s) {
        wrap.appendChild(el("div", { class: "agy-empty-dash", text: busy || D.setup === false ? "Running checks…" : "Checks unavailable — is the server running this repo's latest code?" }));
        return;
      }
      const list = el("div", { class: "agy-setup-list" });
      for (const c of s.checks || []) {
        const row = el("div", { class: "agy-setup-row " + c.status }, [
          el("span", { class: "ico", text: SETUP_ICON[c.status] || "?" }),
          el("span", { class: "mid" }, [
            el("span", { class: "t", text: c.label }),
            el("span", { class: "s", text: c.detail || "" }),
          ]),
        ]);
        if (c.status !== "ok" && (c.fix || c.canInstall)) {
          const fixKids = [];
          if (c.canInstall) {
            fixKids.push(el("button", {
              class: "agy-btn sm", text: "Install hook",
              onclick: async (ev) => {
                ev.currentTarget.disabled = true;
                let r = null;
                try { r = await runTool(tool.id, { action: "install-hook" }); } catch {}
                if (shell) shell.toast(r && r.ok ? "✓ hook installed — agy sessions report live state from their next event" : "install failed: " + ((r && r.message) || "unknown"));
                await fetchSetup(false);
                draw();
              },
            }));
          }
          if (c.fix) {
            fixKids.push(el("span", { class: "cmd" }, [
              el("span", { class: "agy-prompt-ch", text: "→ " }), document.createTextNode(c.fix),
            ]));
            fixKids.push(el("button", {
              class: "agy-ghost", text: "copy", title: "copy the fix command",
              onclick: (ev) => {
                try { navigator.clipboard.writeText(c.fix); if (shell) shell.toast("copied"); } catch {}
                ev.stopPropagation();
              },
            }));
          }
          row.appendChild(el("span", { class: "fix" }, fixKids));
        }
        list.appendChild(row);
      }
      wrap.appendChild(list);
      const bits = [
        sum.coreReady ? "✓ core ready" : "✗ core not ready",
        sum.hookLive ? "✓ live state on" : "! live state off",
        sum.reviewReady ? "✓ Claude features ready" : "· Claude features off (optional)",
      ];
      wrap.appendChild(el("div", { class: "agy-setup-sum", text: bits.join("   ") }));
      wrap.appendChild(el("div", { class: "agy-setup-note", text: "CLI equivalent: npm run doctor · config file: ~/.agy-monitor/config.json (flat {\"ENV\": \"value\"}; the environment wins)" }));
    }
    S.setupRefresh = draw;
    draw();
    if (D.setup === null) fetchSetup(false);
  }

  // -- overview --
  function mountOverview() {
    viewTick = null;
    clear(compHost);
    clear(viewEl);
    const ov = el("div", { class: "agy-ov" });
    viewEl.appendChild(ov);

    function draw() {
      const scrollTop = viewEl.scrollTop;
      clear(ov);

      // NEEDS APPROVAL
      if (D.approvals.length) {
        const sec = el("div", { class: "agy-ov-sec" }, [
          el("div", { class: "agy-lbl red", text: "● NEEDS APPROVAL — " + D.approvals.length }),
        ]);
        D.approvals.forEach((a, i) => sec.appendChild(approvalCard(a, i === 0)));
        ov.appendChild(sec);
      }

      // FAN-OUTS
      if (D.fanouts.length) {
        const sec = el("div", { class: "agy-ov-sec" }, [
          el("span", { class: "agy-lbl", text: "⑃ FAN-OUTS — PARALLEL WORKERS + OPUS JUDGE" }),
        ]);
        const list = el("div", { class: "agy-cardlist" });
        for (const g of D.fanouts) {
          const doneN = g.workers.filter((w) => w.status !== "running").length;
          const fc = FAN_CHIP[g.status] || FAN_CHIP.done;
          const statusLabel = g.status === "running" ? doneN + "/" + g.workers.length + " done"
            : g.status === "judging" ? "opus judging…"
            : g.status === "done" ? "pick a winner"
            : g.status === "applied" ? "applied" + (g.winner ? " " + g.winner : "") : g.status;
          list.appendChild(el("div", { class: "agy-fanrow", onclick: () => go({ kind: "fanout", id: g.id }) }, [
            el("span", { class: "agy-dot " + fc.cls }),
            el("span", { class: "mid" }, [
              el("span", { class: "t", text: g.task }),
              el("span", { class: "s", text: g.project + " · " + g.strategy + " · isolated worktrees" }),
            ]),
            el("span", { class: "st agy-tc-" + fc.cls, text: statusLabel }),
            el("span", { class: "ago", text: g.startedAt ? tsAgoShort(g.startedAt) : "" }),
          ]));
        }
        sec.appendChild(list);
        ov.appendChild(sec);
      }

      // empty state
      if (!D.sessions.length && !D.runs.length && !D.approvals.length) {
        ov.appendChild(el("div", { class: "agy-ov-empty" }, [
          el("span", { class: "h", text: "▸ no agy sessions running" }),
          el("span", { class: "s", text: "Start agy in any terminal and it appears here live within a second — or launch one from the monitor:" }),
          el("span", { class: "cmd" }, [el("span", { class: "agy-prompt-ch", text: "$ " }), document.createTextNode('agy -p "fix the failing test"')]),
          el("button", { class: "agy-btn", text: "＋ New chat", style: { marginTop: "6px" }, onclick: () => navTop({ kind: "newchat", ctx: {} }) }),
        ]));
      }

      // ACTIVE SESSIONS table
      if (D.sessions.length) {
        const sec = el("div", { class: "agy-ov-sec" }, [
          el("div", { class: "agy-ov-sechead" }, [
            el("span", { class: "agy-lbl", text: "ACTIVE SESSIONS" }),
            el("span", { class: "agy-ov-count", text: D.sessions.length + " RUNNING" }),
          ]),
        ]);
        const tbl = el("div", { class: "agy-cardlist" });
        tbl.appendChild(el("div", { class: "agy-table-head" }, [
          el("span", { text: "STATE" }), el("span", { text: "SESSION" }), el("span", { text: "PROJECT" }),
          el("span", { text: "MODEL" }), el("span", { class: "r", text: "COST" }), el("span", { class: "r", text: "ACTIVE" }), el("span"),
        ]));
        for (const s of D.sessions) tbl.appendChild(tableRow(s));
        sec.appendChild(tbl);
        ov.appendChild(sec);
      }

      // LAUNCHED FROM HERE
      if (D.runs.length) {
        const sec = el("div", { class: "agy-ov-sec" }, [
          el("span", { class: "agy-lbl", text: "LAUNCHED FROM HERE · AGY -P" }),
        ]);
        const list = el("div", { class: "agy-cardlist" });
        for (const r of D.runs) list.appendChild(runRow(r));
        sec.appendChild(list);
        ov.appendChild(sec);
      }
      viewEl.scrollTop = scrollTop;
    }
    S.overviewRefresh = draw;
    draw();
  }

  function approvalCard(a, showKbd) {
    const where = (a.cwd ? a.cwd.split("/").pop() : null) || a.project || (a.conversationId || "").slice(0, 8);
    return el("div", { class: "agy-approval" }, [
      el("div", { class: "agy-approval-top" }, [
        el("span", { class: "agy-approval-who" }, [
          el("b", { text: where }),
          document.createTextNode(" · agy wants to run a command"),
          a.reason ? el("span", { class: "why", text: " — " + a.reason }) : null,
        ]),
        el("span", { class: "agy-approval-btns" }, [
          el("button", { class: "agy-btn sm", onclick: () => answerApproval(a, "allow") }, [
            document.createTextNode("Approve"), showKbd ? el("span", { class: "k", text: "A" }) : null,
          ]),
          el("button", { class: "agy-ghost", onclick: () => answerApproval(a, "deny") }, [
            document.createTextNode("Deny"), showKbd ? el("span", { class: "k", text: "D" }) : null,
          ]),
        ]),
      ]),
      el("div", { class: "agy-cmdblock" }, [el("span", { class: "p", text: "$ " }), document.createTextNode(a.command || "")]),
      a.risk ? el("div", { class: "agy-risk", text: "⚠ " + a.risk }) : null,
    ]);
  }
  async function answerApproval(a, decision) {
    D.approvals = D.approvals.filter((x) => x.id !== a.id); // instant
    renderSide();
    if (S.overviewRefresh && S.view.kind === "overview") S.overviewRefresh();
    if (S.approvalRefresh) { try { S.approvalRefresh(); } catch {} } // clear the card in the open convo/split view
    try { await runTool(tool.id, { action: "answer-approval", conversationId: a.conversationId, approvalId: a.id, decision }); } catch {}
    tick();
  }

  function tableRow(s) {
    const meta = stateMeta(s);
    const un = s.unread || 0;
    return el("div", { class: "agy-table-row", onclick: s.conversationId ? (e) => clickSession(e, s) : undefined }, [
      el("span", { class: "agy-tstate" }, [
        el("span", { class: "agy-dot " + meta.cls }),
        el("span", { class: "st agy-tc-" + meta.cls, text: meta.short }),
      ]),
      el("span", { class: "agy-tsess" }, [
        el("span", { class: "t", text: s.title || s.prompt || "(untitled)" }),
        el("span", { class: "s", text: [meta.detail, s.pid ? "pid " + s.pid : null, s.elapsed ? "up " + s.elapsed : null].filter(Boolean).join(" · ") }),
      ]),
      el("span", { class: "agy-tcell", text: s.project || "—" }),
      el("span", { class: "agy-tcell", text: s.model || "—" }),
      el("span", { class: "agy-tcell r", title: tokTip(s.tokens), text: s.costUsd != null ? fmtCost(s.costUsd) : "—" }),
      el("span", { class: "agy-tcell dim r", text: agoShort(s.lastActivity || s.startedAt) || s.elapsed || "" }),
      el("span", { class: "r" }, [un ? el("span", { class: "agy-unread", text: String(un) }) : null]),
    ]);
  }

  function runRow(r) {
    const rm = RUN_META[r.status] || RUN_META.done;
    const live = r.status === "running" || r.status === "waiting";
    const bits = [];
    if (r.project) bits.push(r.project);
    if (r.status === "done" && r.result) {
      const rb = ["✓ done"];
      if (r.result.durationSeconds != null) rb.push(Math.round(r.result.durationSeconds) + "s");
      if (r.result.usage && r.result.usage.total_tokens) rb.push((r.result.usage.total_tokens / 1000).toFixed(1) + "k tokens");
      bits.push(rb.join(" · "));
    } else if (r.status === "error") {
      bits.push("✗ failed" + (r.exitCode != null && r.exitCode !== 0 ? " (exit " + r.exitCode + ")" : ""));
    } else if (r.message) bits.push(r.message);
    return el("div", {
      class: "agy-runrow",
      onclick: () => openConvo({ conversationId: r.conversationId, title: r.title, project: r.project, shortWorkspace: r.shortWorkspace, workspace: r.workspace, historical: !live }),
    }, [
      el("div", { class: "top" }, [
        el("span", { class: "agy-dot " + rm.cls }),
        el("span", { class: "mid" }, [
          el("span", { class: "t", text: r.title || r.message || "(new conversation)" }),
          el("span", { class: "s", text: bits.join(" · ") }),
        ]),
        el("span", { class: "st agy-tc-" + rm.cls, text: rm.label }),
        r.costUsd != null ? el("span", { class: "cost", text: fmtCost(r.costUsd) }) : null,
        r.startedAt ? el("span", { class: "ago", text: tsAgoShort(r.startedAt) }) : null,
        el("span", {
          class: "act", text: live ? "stop" : "dismiss",
          title: live
            ? "stop this run — kills the agy process; the conversation is kept"
            : "dismiss — remove this finished run from the list; the conversation is kept",
          onclick: async (e) => {
            e.stopPropagation();
            try { await runTool(tool.id, { action: live ? "stop-ui-run" : "dismiss-ui-run", conversationId: r.conversationId }); } catch {}
            tick();
          },
        }),
      ]),
      r.errorTail ? el("div", { class: "agy-errtail", text: r.errorTail }) : null,
    ]);
  }

  // -- conversation --
  function msgTime(ts) {
    if (!ts) return null;
    const d = new Date(typeof ts === "number" ? (ts > 1e12 ? ts : ts * 1000) : ts);
    if (isNaN(d)) return null;
    const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    const label = d.toDateString() === new Date().toDateString() ? t
      : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t;
    return el("span", { class: "agy-msg-ts", text: label, title: d.toLocaleString() });
  }

  // Merge tool-result rows into the toolCalls of the assistant turn that issued
  // them, so a run_command renders as ONE card: $ command + OUTPUT + status.
  function mergeTranscript(msgs) {
    const out = [];
    let lastAssistant = null;
    const norm = (n) => String(n || "").toLowerCase().replace(/[\s_]+/g, "");
    for (const m of msgs) {
      if (m.role === "assistant") {
        const mm = Object.assign({}, m, { toolCalls: (m.toolCalls || []).map((tc) => Object.assign({}, tc)) });
        out.push(mm); lastAssistant = mm;
        continue;
      }
      if (m.role === "tool" && lastAssistant) {
        const tc = lastAssistant.toolCalls.find((t) => !t._result && norm(t.name) === norm(m.toolName));
        if (tc) { tc._result = m; continue; }
      }
      out.push(m);
      if (m.role === "user") lastAssistant = null;
    }
    return out;
  }

  // Ask plumbing over a merged transcript: a card is "answered" once ANY user
  // turn follows it, and raw "My answers:" turns fold into their card instead of
  // rendering as chat bubbles.
  function annotateAsks(merged) {
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      if (m.role !== "assistant" || !m.ask) continue;
      for (let j = i + 1; j < merged.length; j++) {
        if (merged[j].role === "user") { m._askAnswered = true; m._askAnswerText = merged[j].text || ""; break; }
      }
    }
    return merged.filter((m) => !(m.role === "user" && /^My answers:/.test((m.text || "").trim())));
  }
  function askSig(m) {
    return m.ask ? ":ask" + (m._askAnswered ? 1 : 0) + ":" + ((m._askAnswerText || "").length) : "";
  }

  function msgSig(m) {
    return [m.role, (m.text || "").length, (m.thinking || "").length, (m.output || "").length,
      (m.stdout || "").length, (m.status || "").length, JSON.stringify(m.toolCalls || "").length, m.ts || ""].join(":");
  }
  function preserveOpen(oldEl, newEl) {
    const open = new Set(), closed = new Set();
    oldEl.querySelectorAll("details[open]").forEach((d) => open.add(d.getAttribute("data-k")));
    oldEl.querySelectorAll("details:not([open])").forEach((d) => closed.add(d.getAttribute("data-k")));
    newEl.querySelectorAll("details").forEach((d) => {
      const k = d.getAttribute("data-k");
      if (open.has(k)) d.open = true; else if (closed.has(k)) d.open = false;
    });
  }

  function toolCard(tc, opts) {
    const res = tc._result || null;
    const running = !res && opts && opts.maybeRunning && !opts.compact;
    // A result-less tool on a session that's "waiting" (not busy) is parked on the
    // terminal's approval prompt, not executing — say so instead of "running…".
    const awaiting = running && opts && opts.awaiting;
    // …and one whose approval prompt the user escaped/denied never ran at all. It has
    // no result and the session is idle, so without this it would draw the plain green
    // ✓ and silently claim the cancelled command succeeded. `opts.cancelled` is the
    // TOOL NAME the server proved was cancelled, not a flag: a turn can end on several
    // result-less cards and only that one was refused.
    const cancelled = !res && !running && opts && opts.cancelled && !opts.compact
      && (!tc.name || tc.name === opts.cancelled);
    const kids = [];
    const glyph = el("span", { class: "glyph" + (awaiting ? " await" : running ? " live" : cancelled ? " cancelled" : ""), text: awaiting ? "◌" : running ? "●" : cancelled ? "⊘" : "✓" });
    const statText = res && res.kind === "command" && res.status ? firstLine(res.status)
      : awaiting ? "awaiting approval…" : running ? "running…" : cancelled ? "cancelled" : "";
    kids.push(el("summary", {}, [
      glyph,
      el("span", { class: "tname", text: tc.name || "tool" }),
      el("span", { class: "tsum", text: tc.summary || (tc.command ? firstLine(tc.command) : "") }),
      el("span", { class: "tstat", text: statText }),
    ]));
    if (tc.command) kids.push(el("div", { class: "agy-tool-cmd" }, [el("span", { class: "agy-prompt-ch", text: "$ " }), document.createTextNode(tc.command)]));
    const outText = res ? (res.kind === "command" ? res.stdout : res.output) : null;
    if (outText) {
      kids.push(el("div", { class: "agy-tool-outwrap" }, [
        el("div", { class: "agy-tool-outlabel", text: "OUTPUT" }),
        el("div", { class: "agy-tool-out" }, richText(outText, opts && opts.openFile)),
      ]));
    }
    return el("details", { class: "agy-tool", "data-k": opts && opts.key, open: running ? "" : null }, kids);
  }
  function diffCard(tc, opts) {
    const lines = (tc.content || "").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return el("details", { class: "agy-diffcard", "data-k": opts && opts.key, open: opts && opts.compact ? null : "" }, [
      el("summary", {}, [
        el("span", { class: "glyph", text: "✎" }),
        el("span", { class: "tname", text: tc.overwrite ? "edit file" : "write file" }),
        el("span", { class: "tsum", text: tc.summary || (tc.file ? tc.file.split("/").pop() : "") }),
        el("span", {
          class: "agy-panelbtn", text: "◨ panel", title: "open in workspace panel",
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); if (!P.rightOpen) toggleRight(); S.rightTab = "turn"; renderPanel(); },
        }),
      ]),
      el("div", { class: "agy-diffcard-body" }, lines.map((l) => el("div", { text: "+ " + l }))),
    ]);
  }
  function firstLine(s) {
    const ln = (s || "").split("\n").find((x) => x.trim());
    return ln ? (ln.length > 90 ? ln.slice(0, 90) + "…" : ln) : "";
  }

  // ---------- ask-user-question cards (```ask convention) ----------
  const askIntro = (n) => (n >= 3 ? "A few quick questions." : n === 2 ? "A couple of quick questions." : "One quick question.");
  function parseAskAnswerText(text) {
    const rows = [];
    for (const ln of String(text || "").split("\n")) {
      const mm = /^[•\-*]\s*(.+?):\s*(.*)$/.exec(ln.trim());
      if (mm) rows.push({ label: mm[1].trim(), picks: mm[2].trim() });
    }
    return rows;
  }
  function askCard(m, opts) {
    const qs = (m.ask.questions || []).slice(0, 4).map((q) => ({
      header: String(q.header || ""), question: String(q.question || ""),
      multi: !!q.multiSelect, options: (Array.isArray(q.options) ? q.options : []).slice(0, 4),
    }));
    if (!qs.length) return null;
    const key = (opts.cid || "") + "|" + (m.ts || "") + "|" + JSON.stringify(m.ask).length;
    const st = S.asks[key] || (S.asks[key] = { page: 0, sel: qs.map(() => []), other: qs.map(() => ""), answered: null });
    const host = el("div");

    // answered — fold into the green summary
    const externalRows = m._askAnswered ? parseAskAnswerText(m._askAnswerText) : null;
    if (st.answered || m._askAnswered) {
      const rows = st.answered || qs.map((q, i) => {
        const ext = (externalRows || []).find((r) => r.label === (q.header || q.question));
        return { eyebrow: (q.header || "").toUpperCase(), question: q.question, picks: ext ? ext.picks : "answered" };
      });
      host.appendChild(el("div", { class: "agy-ask answered" }, [
        el("div", { class: "agy-ask-done-head" }, [
          el("span", { class: "c", text: "✓" }),
          el("span", { class: "t", text: "Answered — sent as your turn" }),
        ]),
        el("div", { class: "agy-ask-done-body" }, rows.map((r) => el("div", { class: "agy-ask-done-row" }, [
          r.eyebrow ? el("span", { class: "agy-ask-eyebrow", text: r.eyebrow }) : null,
          el("span", { class: "qq", text: r.question }),
          el("span", { class: "agy-ask-pill", text: r.picks }),
        ]))),
      ]));
      return host;
    }

    const REVIEW = qs.length;
    const hasReview = qs.length >= 2;
    const picksFor = (i) => (st.sel[i] || []).map((v) => (v === "__other" ? (st.other[i] || "").trim() : v)).filter(Boolean);
    const complete = (i) => picksFor(i).length > 0;

    function draw() {
      clear(host);
      const onReview = hasReview && st.page === REVIEW;
      const qi = Math.min(st.page, qs.length - 1);
      const q = qs[qi];
      const kids = [];
      kids.push(el("div", { class: "agy-ask-head" }, [
        el("span", { class: "q", text: "?" }),
        el("span", { class: "t", text: askIntro(qs.length) }),
        el("span", { class: "n", text: onReview ? "review" : (qi + 1) + " of " + qs.length }),
      ]));
      const body = el("div", { class: "agy-ask-body" });
      if (onReview) {
        body.appendChild(el("span", { class: "agy-ask-eyebrow", text: "REVIEW — LAST CHECK BEFORE SENDING" }));
        qs.forEach((qq, i) => {
          body.appendChild(el("div", { class: "agy-ask-review-row" }, [
            el("span", { class: "mid" }, [
              qq.header ? el("span", { class: "agy-ask-eyebrow", text: qq.header.toUpperCase() }) : null,
              el("span", { class: "qq", text: qq.question }),
              el("span", { class: "picks", text: picksFor(i).join(" · ") || "—" }),
            ]),
            el("span", { class: "edit", title: "jump back to this question to change your picks", text: "edit", onclick: () => { st.page = i; draw(); } }),
          ]));
        });
      } else {
        if (q.header) body.appendChild(el("span", { class: "agy-ask-eyebrow", text: q.header.toUpperCase() + (q.multi ? " · SELECT ANY" : "") }));
        body.appendChild(el("span", { class: "agy-ask-q", text: q.question }));
        const optBox = el("div", { class: "agy-ask-opts" });
        const toggle = (label) => {
          let sel = (st.sel[qi] || []).slice();
          const has = sel.includes(label);
          if (q.multi) sel = has ? sel.filter((x) => x !== label) : sel.concat([label]);
          else sel = has ? [] : [label];
          st.sel[qi] = sel;
          draw();
        };
        for (const o of q.options) {
          const label = String(o.label || "");
          const on = (st.sel[qi] || []).includes(label);
          optBox.appendChild(el("div", { class: "agy-ask-opt" + (on ? " sel" : ""), onclick: () => toggle(label) }, [
            el("span", { class: "dot" }),
            el("span", { class: "lab", text: label }),
            o.description ? el("span", { class: "desc", text: String(o.description) }) : null,
          ]));
        }
        const otherOn = (st.sel[qi] || []).includes("__other");
        const otherRow = el("div", { class: "agy-ask-opt" + (otherOn ? " sel" : ""), onclick: () => toggle("__other") }, [
          el("span", { class: "dot" }),
          el("span", { class: "lab", text: "Other" }),
        ]);
        if (otherOn) {
          const inp = el("input", {
            type: "text", placeholder: "type your answer…", value: st.other[qi] || "",
            onclick: (e) => e.stopPropagation(),
            oninput: (e) => { st.other[qi] = e.target.value; footRefresh(); },
          });
          otherRow.appendChild(inp);
          setTimeout(() => inp.focus(), 0);
        }
        optBox.appendChild(otherRow);
        body.appendChild(optBox);
      }
      kids.push(body);

      const nextReady = onReview ? qs.every((_, i) => complete(i)) : complete(Math.min(st.page, qs.length - 1));
      const nextLabel = onReview ? "Submit answers" : (st.page === qs.length - 1 ? (hasReview ? "Review" : "Submit") : "Next");
      const nextBtn = el("span", {
        class: "agy-ask-next" + (nextReady ? " ready" : ""), text: nextLabel,
        onclick: () => {
          if (onReview) { if (nextReady) submit(); return; }
          if (!complete(qi)) { if (shell) shell.toast("Pick an option (or fill in Other)"); return; }
          if (qi === qs.length - 1) { hasReview ? (st.page = REVIEW, draw()) : submit(); }
          else { st.page = qi + 1; draw(); }
        },
      });
      function footRefresh() {
        const ready = onReview ? qs.every((_, i) => complete(i)) : complete(qi);
        nextBtn.classList.toggle("ready", ready);
      }
      const dots = qs.map((_, i) => el("span", { class: "agy-ask-dot" + (!onReview && i === qi ? " on" : "") }));
      if (hasReview) dots.push(el("span", { class: "agy-ask-dot review" + (onReview ? " on" : "") }));
      kids.push(el("div", { class: "agy-ask-foot" }, [
        (onReview ? REVIEW : qi) > 0 ? el("span", { class: "agy-ask-back", title: "back to the previous question — your picks are kept", text: "← back", onclick: () => { st.page = Math.max(0, (onReview ? REVIEW : qi) - 1); draw(); } }) : null,
        el("span", { class: "agy-ask-dots" }, dots),
        nextBtn,
      ]));
      host.appendChild(el("div", { class: "agy-ask" }, kids));
    }
    function submit() {
      for (let i = 0; i < qs.length; i++) {
        if (!complete(i)) { st.page = i; draw(); if (shell) shell.toast("Answer every question first"); return; }
      }
      const rows = qs.map((q, i) => ({ eyebrow: (q.header || "").toUpperCase(), question: q.question, picks: picksFor(i).join(" · ") }));
      st.answered = rows;
      const msg = "My answers:\n" + qs.map((q, i) => "• " + (q.header || q.question) + ": " + picksFor(i).join(", ")).join("\n");
      clear(host);
      draw2Answered(rows);
      if (opts.sendAnswer) opts.sendAnswer(msg);
    }
    function draw2Answered(rows) {
      host.appendChild(el("div", { class: "agy-ask answered" }, [
        el("div", { class: "agy-ask-done-head" }, [
          el("span", { class: "c", text: "✓" }),
          el("span", { class: "t", text: "Answered — sent as your turn" }),
        ]),
        el("div", { class: "agy-ask-done-body" }, rows.map((r) => el("div", { class: "agy-ask-done-row" }, [
          r.eyebrow ? el("span", { class: "agy-ask-eyebrow", text: r.eyebrow }) : null,
          el("span", { class: "qq", text: r.question }),
          el("span", { class: "agy-ask-pill", text: r.picks }),
        ]))),
      ]));
    }
    draw();
    return host;
  }

  function messageEl(m, i, opts) {
    const openFile = opts.openFile;
    if (m.role === "user") {
      return el("div", { class: "agy-turn" }, [
        el("div", { class: "agy-msg-user" }, [
          el("div", { class: "agy-rolebar" }, [
            el("span", { class: "agy-role you", text: "YOU" }),
            el("span", { class: "rgt" }, [
              opts.forkFrom && m.ts ? el("span", {
                class: "agy-forkfrom", title: "⑂ fork the conversation from this point",
                text: "⑂", onclick: () => opts.forkFrom(m.ts),
              }) : null,
              msgTime(m.ts),
            ]),
          ]),
          el("div", { class: "agy-msg-text" }, richText(m.text || "", openFile)),
        ]),
      ]);
    }
    if (m.role === "assistant") {
      const kids = [
        el("div", { class: "agy-rolebar" }, [
          opts.roleLabel
            ? el("span", { class: "agy-role ext", text: opts.roleLabel })
            : el("span", { class: "agy-role agy", text: "AGY" }),
          el("span", { class: "rgt" }, [msgTime(m.ts)]),
        ]),
      ];
      if (m.thinking) kids.push(el("details", { class: "agy-think", "data-k": "think:" + i }, [
        el("summary", { text: "thinking" }),
        el("div", { class: "agy-think-body", text: m.thinking }),
      ]));
      if (m.text) kids.push(el("div", { class: "agy-msg-text agy-md" }, renderMarkdown(m.text, openFile)));
      if (m.ask) {
        const answered = m._askAnswered || (S.asks[(opts.cid || "") + "|" + (m.ts || "") + "|" + JSON.stringify(m.ask).length] || {}).answered;
        if (opts.compact) {
          kids.push(answered
            ? el("div", { class: "agy-ask-chip done" }, [el("span", { class: "q", text: "✓" }), el("span", { class: "t", text: "question answered" })])
            : el("div", { class: "agy-ask-chip", title: "open the full view to answer", onclick: opts.askJump }, [
                el("span", { class: "q", text: "?" }), el("span", { class: "t", text: "question waiting — answer in the full view" }),
              ]));
        } else {
          const card = askCard(m, opts);
          if (card) kids.push(card);
        }
      }
      (m.toolCalls || []).forEach((tc, j) => {
        const key = "tool:" + i + ":" + j;
        if (tc.name === "write_to_file" && tc.content != null) kids.push(diffCard(tc, { key, compact: opts.compact }));
        else kids.push(toolCard(tc, { key, openFile, maybeRunning: opts.isLast && opts.live, awaiting: opts.isLast && opts.awaiting, cancelled: opts.isLast && opts.cancelled, compact: opts.compact }));
      });
      return el("div", { class: "agy-turn" }, [el("div", { class: "agy-msg-agy" }, kids)]);
    }
    // standalone tool result that didn't merge into an assistant turn
    const kids = [
      el("summary", {}, [
        el("span", { class: "glyph", text: "✓" }),
        el("span", { class: "tname", text: m.toolName || "tool" }),
        el("span", { class: "tsum", text: m.kind === "command" ? firstLine(m.stdout || m.status || "") : firstLine(m.output || "") }),
        el("span", { class: "tstat", text: "" }),
      ]),
    ];
    const outText = m.kind === "command" ? m.stdout : m.output;
    if (outText) kids.push(el("div", { class: "agy-tool-outwrap" }, [
      el("div", { class: "agy-tool-outlabel", text: "OUTPUT" }),
      el("div", { class: "agy-tool-out" }, richText(outText, opts.openFile)),
    ]));
    return el("div", { class: "agy-turn" }, [el("details", { class: "agy-tool", "data-k": "tool:" + i }, kids)]);
  }

  // ---------- lightbox ----------
  let lightboxEl = null;
  function closeLightbox() { if (lightboxEl) { try { root.removeChild(lightboxEl); } catch {} lightboxEl = null; } }
  function showLightbox(url, name) {
    closeLightbox();
    lightboxEl = el("div", { class: "agy-lightbox", onclick: closeLightbox }, [
      el("div", { class: "box" }, [
        el("span", { class: "img", style: { backgroundImage: "url(" + url + ")" } }),
        el("div", { class: "cap" }, [
          el("span", { class: "nm", text: name || "" }),
          el("span", { class: "hint", text: "CLICK OR ESC TO CLOSE" }),
        ]),
      ]),
    ]);
    root.appendChild(lightboxEl);
  }

  // ---------- composer (shared by the conversation view and, later, split panes) ----------
  // Slash-command menu + @-file menu + paste/pick attachments (⟦img1⟧ tokens
  // bidirectionally linked to chips, custom undo/redo), the queued-send bar,
  // and the active-command pill. Attachments upload to the server and ride the
  // message as absolute paths agy can read with its own tools.
  const SLASH_TAG = { agy: ["BUILT-IN", "var(--sec)"], custom: ["CUSTOM", "var(--green)"], mcp: ["MCP", "var(--amber)"], skill: ["SKILL", "#D6D3C9"] };
  // Commands the MONITOR handles itself (never sent to agy).
  const MONITOR_COMMANDS = [
    { name: "review", desc: "One-shot Opus review of the working-tree diff", src: "custom" },
    { name: "fanout", desc: "Launch N parallel workers on this task, Opus ranks results", src: "custom" },
    { name: "fork", desc: "Fork this conversation — copied context, fresh session", src: "custom" },
    { name: "btw", desc: "Ask a side question — answer stays OUT of context", src: "custom" },
  ];
  function allCommands() { return (D.commands || []).concat(MONITOR_COMMANDS); }

  const _fileCache = new Map(); // workspace → {files, at}
  async function workspaceFiles(workspace) {
    if (!workspace) return [];
    const hit = _fileCache.get(workspace);
    if (hit && Date.now() - hit.at < 30000) return hit.files;
    try {
      const res = await runTool(tool.id, { action: "list-files", workspace });
      const files = (res && res.ok && res.files) || [];
      _fileCache.set(workspace, { files, at: Date.now() });
      return files;
    } catch { return (hit && hit.files) || []; }
  }

  function makeComposer(opts) {
    // opts: { cid, getWorkspace(), onPending(msg), placeholder }
    const cid = opts.cid;
    const comp = el("div", { class: "agy-comp" });
    const queueBox = el("div");
    const pillBox = el("div");
    const chipsBox = el("div");
    const menuBox = el("div");
    const ta = el("textarea", { class: "agy-ta", rows: "2", placeholder: opts.placeholder || "Send a message to this conversation…" });
    const cstatus = el("span", { class: "agy-comp-status", text: "" });
    const fileInput = el("input", { type: "file", multiple: "", style: { display: "none" } });

    // draft (text only; attachment tokens are stripped on restore)
    const draftKey = "agy-draft:" + (cid || "");
    try {
      const d = localStorage.getItem(draftKey);
      if (d) ta.value = d.replace(/⟦(?:img|file)\d+⟧ ?/g, "");
    } catch {}
    const saveDraft = () => {
      try { ta.value.trim() ? localStorage.setItem(draftKey, ta.value) : localStorage.removeItem(draftKey); } catch {}
    };

    // ---- attachments ----
    let atts = [];       // {name, ph, url (objectURL for images), serverPath}
    let attSeq = 0;
    const undoStack = [], redoStack = [];
    const snap = () => ({ value: ta.value, atts: atts.slice() });
    function pushUndo() {
      undoStack.push(snap());
      if (undoStack.length > 20) undoStack.shift();
      redoStack.length = 0;
    }
    function restore(sn) {
      ta.value = sn.value;
      atts = sn.atts.slice();
      renderChips();
      ta.focus();
    }
    function renderChips() {
      clear(chipsBox);
      if (!atts.length) return;
      chipsBox.appendChild(el("div", { class: "agy-attchips" }, atts.map((a) => el("span", { class: "agy-attchip" }, [
        a.url ? el("span", { class: "thumb", title: "click to preview", style: { backgroundImage: "url(" + a.url + ")" }, onclick: () => showLightbox(a.url, a.name) })
              : el("span", { class: "fi", text: "▤" }),
        el("span", { class: "n", text: a.name }),
        el("span", { class: "agy-x", text: "✕", title: "remove attachment (also deletes its token)", onclick: () => removeAtt(a) }),
      ]))));
    }
    function removeAtt(a) {
      pushUndo();
      ta.value = ta.value.split(a.ph + " ").join("").split(a.ph).join("");
      atts = atts.filter((x) => x !== a);
      renderChips(); saveDraft();
    }
    function syncAttachments() {
      const keep = atts.filter((a) => ta.value.indexOf(a.ph) >= 0);
      if (keep.length !== atts.length) { atts = keep; renderChips(); }
    }
    async function addFiles(files) {
      if (!files || !files.length) return;
      for (const f of Array.from(files)) {
        const isImg = /^image\//.test(f.type || "");
        attSeq += 1;
        const name = f.name && f.name !== "image.png" ? f.name : (isImg ? "pasted-image-" + attSeq + ".png" : "pasted-file-" + attSeq);
        cstatus.textContent = "uploading " + name + "…";
        let dataB64;
        try {
          dataB64 = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ""));
            r.onerror = rej;
            r.readAsDataURL(f);
          });
        } catch { cstatus.textContent = "couldn't read " + name; continue; }
        let up;
        try { up = await runTool(tool.id, { action: "upload-attachment", conversationId: cid, name, data: dataB64 }); }
        catch (e) { cstatus.textContent = "upload failed: " + (e && e.message ? e.message : e); continue; }
        if (!up || !up.ok) { cstatus.textContent = (up && up.message) || "upload failed"; continue; }
        pushUndo();
        const ph = "⟦" + (isImg ? "img" : "file") + attSeq + "⟧";
        atts.push({ name: up.name || name, ph, url: isImg ? URL.createObjectURL(f) : null, serverPath: up.path });
        const i = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
        ta.value = ta.value.slice(0, i) + ph + " " + ta.value.slice(i);
        const ni = i + ph.length + 1;
        ta.setSelectionRange(ni, ni);
        ta.focus();
        cstatus.textContent = "";
        renderChips(); saveDraft();
      }
      if (atts.length && shell) shell.toast("⌲ Attached — one backspace removes a token, ⌘Z restores");
    }

    // ---- slash / @ menus ----
    let menu = null; // {type:'slash'|'at', q, idx}
    function slashMatches(q) {
      const needle = q.toLowerCase();
      return allCommands().filter((c) => !needle || (c.name + " " + c.desc).toLowerCase().includes(needle)).slice(0, 8);
    }
    let atFiles = [];
    function atMatches(q) {
      const needle = (q || "").toLowerCase();
      return atFiles.filter((p) => !needle || p.toLowerCase().includes(needle)).slice(0, 8);
    }
    function activeCommand() {
      const v = ta.value;
      return allCommands().find((c) => v.trim() === "/" + c.name || v.indexOf("/" + c.name + " ") === 0) || null;
    }
    function renderPill() {
      clear(pillBox);
      const c = activeCommand();
      if (!c) return;
      const tag = SLASH_TAG[c.src] || SLASH_TAG.agy;
      pillBox.appendChild(el("div", { class: "agy-cmdpill-row" }, [
        el("span", { class: "agy-cmdpill" }, [
          el("span", { class: "n", text: "/" + c.name }),
          el("span", { class: "tag", style: { color: tag[1] }, text: tag[0] }),
          el("span", { class: "d", text: c.desc }),
        ]),
      ]));
    }
    function renderMenu() {
      clear(menuBox);
      if (!menu) return;
      const items = menu.type === "slash" ? slashMatches(menu.q) : atMatches(menu.q);
      if (!items.length) { menu = null; return; }
      if (menu.idx >= items.length) menu.idx = items.length - 1;
      const list = el("div", { class: "agy-menu-list" }, items.map((it, i) => {
        if (menu.type === "slash") {
          const tag = SLASH_TAG[it.src] || SLASH_TAG.agy;
          return el("div", {
            class: "agy-menu-row" + (i === menu.idx ? " sel" : ""),
            // .d ellipsizes in a narrow composer, so hovering is the only way to read a long description
            title: "/" + it.name + (it.desc ? " — " + it.desc : ""),
            onmousedown: (e) => { e.preventDefault(); pickSlash(it); },
          }, [
            el("span", { class: "n", text: "/" + it.name }),
            el("span", { class: "d", text: it.desc }),
            el("span", { class: "tag", style: { color: tag[1] }, text: tag[0] }),
          ]);
        }
        return el("div", {
          class: "agy-menu-row" + (i === menu.idx ? " sel" : ""),
          onmousedown: (e) => { e.preventDefault(); pickAt(it); },
        }, [
          el("span", { class: "n", text: "@" + it }),
          el("span", { class: "d", text: "workspace file" }),
          el("span", { class: "tag", style: { color: "var(--sec)" }, text: "FILE" }),
        ]);
      }));
      menuBox.appendChild(el("div", { class: "agy-menu" }, [
        list,
        el("div", { class: "agy-menu-foot" }, [
          el("span", { text: "↑↓ NAVIGATE" }), el("span", { text: "↵/TAB INSERT" }), el("span", { text: "ESC DISMISS" }),
        ]),
      ]));
      const sel = list.children[menu.idx];
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    }
    function pickSlash(c) {
      ta.value = "/" + c.name + " ";
      menu = null; renderMenu(); renderPill(); saveDraft();
      ta.focus();
    }
    function pickAt(p) {
      ta.value = ta.value.replace(/@[A-Za-z0-9_\-./]*$/, "@" + p + " ");
      menu = null; renderMenu(); saveDraft();
      ta.focus();
    }
    async function onInput() {
      saveDraft();
      syncAttachments();
      renderPill();
      const v = ta.value;
      // slash menu: open while the value is a bare /prefix (no arguments yet) with matches
      const sm = /^\/(\S*)$/.exec(v);
      if (sm && slashMatches(sm[1]).length) {
        menu = { type: "slash", q: sm[1], idx: menu && menu.type === "slash" ? menu.idx : 0 };
        renderMenu();
        return;
      }
      const am = /@([A-Za-z0-9_\-./]*)$/.exec(v);
      if (am) {
        if (!atFiles.length) atFiles = await workspaceFiles(opts.getWorkspace());
        if (atMatches(am[1]).length) {
          menu = { type: "at", q: am[1], idx: menu && menu.type === "at" ? menu.idx : 0 };
          renderMenu();
          return;
        }
      }
      if (menu) { menu = null; renderMenu(); }
    }
    function onKeydown(e) {
      // one Backspace right after a token deletes the whole token (+ its chip)
      if (e.key === "Backspace") {
        const i = ta.selectionStart;
        if (i === ta.selectionEnd && i > 0) {
          const m = /⟦(?:img|file)\d+⟧ ?$/.exec(ta.value.slice(0, i));
          if (m) {
            e.preventDefault();
            pushUndo();
            ta.value = ta.value.slice(0, i - m[0].length) + ta.value.slice(i);
            const ni = i - m[0].length;
            ta.setSelectionRange(ni, ni);
            syncAttachments(); saveDraft(); renderPill();
            return;
          }
        }
      }
      // ⌘Z / ⌘⇧Z — token+attachment undo/redo
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (!e.shiftKey && undoStack.length) {
          e.preventDefault(); e.stopPropagation();
          redoStack.push(snap());
          restore(undoStack.pop());
          return;
        }
        if (e.shiftKey && redoStack.length) {
          e.preventDefault(); e.stopPropagation();
          undoStack.push(snap());
          restore(redoStack.pop());
          return;
        }
      }
      if (menu) {
        const items = menu.type === "slash" ? slashMatches(menu.q) : atMatches(menu.q);
        if (e.key === "ArrowDown") { e.preventDefault(); menu.idx = Math.min(menu.idx + 1, items.length - 1); renderMenu(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); menu.idx = Math.max(menu.idx - 1, 0); renderMenu(); return; }
        if (e.key === "Escape") { e.stopPropagation(); menu = null; renderMenu(); return; }
        const it = items[menu.idx];
        if (e.key === "Tab") { e.preventDefault(); if (it) (menu.type === "slash" ? pickSlash(it) : pickAt(it)); return; }
        if (e.key === "Enter" && it) {
          // Enter inserts while still completing; once the value IS the command it falls through to send
          if (menu.type === "at") { e.preventDefault(); pickAt(it); return; }
          if (ta.value.trim() !== "/" + it.name) { e.preventDefault(); pickSlash(it); return; }
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        menu = null; renderMenu();
        doSend();
      }
    }
    ta.addEventListener("input", onInput);
    ta.addEventListener("keydown", onKeydown);
    ta.addEventListener("paste", (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) { e.preventDefault(); addFiles(files); }
    });
    fileInput.addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });

    // ---- queue + send ----
    let queue = [], flushing = false;
    function renderQueue() {
      clear(queueBox);
      if (!queue.length) return;
      queueBox.appendChild(el("div", { class: "agy-queuebar" }, [
        el("span", { class: "q", text: "QUEUED" }),
        el("span", { class: "txt", text: queue.join("  ·  ") }),
        el("span", { class: "note", text: "sends when the run finishes" }),
        el("span", { class: "send", text: "send now", title: "stop the run and send now", onclick: () => stopAndFlush() }),
        el("span", { class: "agy-x", text: "✕", title: "discard queued message", onclick: () => { queue = []; renderQueue(); } }),
      ]));
    }
    function buildMessage() {
      let msg = ta.value;
      for (const a of atts) msg = msg.split(a.ph).join("");
      msg = msg.replace(/[ \t]{2,}/g, " ").trim();
      if (atts.length) {
        msg += (msg ? "\n\n" : "") + "Attached files (read them from disk):\n" + atts.map((a) => "- " + a.serverPath).join("\n");
      }
      return msg;
    }
    function clearComposer() {
      ta.value = "";
      atts = []; renderChips(); renderPill();
      try { localStorage.removeItem(draftKey); } catch {}
    }
    const tryFlush = async () => {
      if (!queue.length || flushing) return;
      flushing = true;
      const combined = queue.join("\n\n");
      try {
        const res = await runTool(tool.id, { action: "send-message", conversationId: cid, message: combined });
        if (res && res.ok) {
          queue = []; renderQueue();
          opts.onPending(combined);
          cstatus.textContent = "sent — agy is responding…";
        } else if (!(res && res.busy)) { cstatus.textContent = (res && res.message) || "failed to send"; }
      } catch {}
      flushing = false;
    };
    async function stopAndFlush() {
      cstatus.textContent = "stopping the current run…";
      try { await runTool(tool.id, { action: "stop-ui-run", conversationId: cid }); } catch {}
      setTimeout(tryFlush, 1200);
    }
    async function doSend() {
      const msg = buildMessage();
      if (!msg) return;
      // monitor-handled slash commands never go to agy
      const mc = MONITOR_COMMANDS.find((c) => msg === "/" + c.name || msg.indexOf("/" + c.name + " ") === 0);
      if (mc && opts.onCommand) {
        clearComposer();
        opts.onCommand(mc.name, msg.slice(mc.name.length + 1).trim());
        return;
      }
      clearComposer();
      sendBtn.setAttribute("disabled", "true"); cstatus.textContent = "sending…";
      try {
        const res = await runTool(tool.id, { action: "send-message", conversationId: cid, message: msg });
        if (res && res.ok) {
          opts.onPending(msg);
          cstatus.textContent = "sent — agy is responding…";
        } else if (res && res.busy) {
          queue.push(msg); renderQueue();
          cstatus.textContent = "agy is busy — queued";
        } else { cstatus.textContent = (res && res.message) || "failed to send"; }
      } catch (e) { cstatus.textContent = "error: " + (e && e.message ? e.message : e); }
      sendBtn.removeAttribute("disabled");
    }
    const sendBtn = el("button", { class: "agy-btn", text: "Send", onclick: () => doSend() });

    comp.appendChild(queueBox);
    comp.appendChild(pillBox);
    comp.appendChild(chipsBox);
    if (opts.compact) {
      ta.setAttribute("rows", "1");
      comp.appendChild(el("div", { class: "agy-pane-comp-row" }, [
        el("div", { class: "agy-ta-wrap" }, [menuBox, ta]),
        el("button", { class: "agy-pane-send", text: "↵", title: "send (↵)", onclick: () => doSend() }),
        fileInput,
      ]));
      comp.appendChild(cstatus);
    } else {
      comp.appendChild(el("div", { class: "agy-ta-wrap" }, [menuBox, ta]));
      comp.appendChild(el("div", { class: "agy-comp-bar" }, [
        el("span", { class: "lft" }, [
          opts.onBtw ? el("span", { class: "agy-btwbtn", text: "◗ btw", title: "side question — the answer stays OUT of this conversation's context", onclick: opts.onBtw }) : null,
          el("span", { class: "agy-filesbtn", text: "⌲ files", title: "attach files — or just paste into the composer", onclick: () => fileInput.click() }),
          fileInput,
          cstatus,
        ]),
        el("span", { class: "rgt" }, [
          el("span", { class: "agy-hint", text: "/ COMMANDS · ↵ SEND · ⇧↵ NEWLINE" }),
          sendBtn,
        ]),
      ]));
    }
    renderPill();
    return {
      root: comp, tryFlush,
      setStatus: (t) => { cstatus.textContent = t; },
      focus: () => ta.focus(),
      insert: (t) => { ta.value = t; ta.focus(); renderPill(); saveDraft(); },
      lastDraft: () => ta.value,
    };
  }

  function openConvo(ctx) { go({ kind: "convo", ctx }); }

  // ---------- split view entry points ----------
  function ctxForCid(cid) {
    const s = D.sessions.find((x) => x.conversationId === cid);
    if (s) return sessCtx(s);
    const r = D.runs.find((x) => x.conversationId === cid);
    if (r) return { conversationId: cid, title: r.title, project: r.project, workspace: r.workspace, shortWorkspace: r.shortWorkspace };
    return { conversationId: cid };
  }
  function clickSession(e, s) {
    if (!s.conversationId) return;
    if (e && (e.metaKey || e.ctrlKey || e.altKey)) { addPane(s.conversationId); return; }
    openConvo(sessCtx(s));
  }
  function addPane(cid) {
    if (!cid) return;
    closePalette();
    if (S.view.kind === "split") {
      const i = S.panes.indexOf(cid);
      if (i >= 0) { S.paneFocus = i; render(S.view); return; }
      if (S.panes.length >= 3) { if (shell) shell.toast("Split view maxes out at 3 panes"); return; }
      S.panes = S.panes.concat([cid]);
      S.paneFocus = S.panes.length - 1;
      P.leftOpen = false;
      history.replaceState(Object.assign({ navDepth: S.navDepth, pos: S.curPos }, { kind: "split", panes: S.panes }), "", urlFor({ kind: "split" }));
      render({ kind: "split", panes: S.panes });
      return;
    }
    if (S.view.kind === "convo" && S.view.ctx && S.view.ctx.conversationId && S.view.ctx.conversationId !== cid) {
      S.panes = [S.view.ctx.conversationId, cid];
      S.paneFocus = 1;
      P.leftOpen = false;
      go({ kind: "split", panes: S.panes });
      return;
    }
    openConvo(ctxForCid(cid));
  }
  function closePane(cid) {
    const panes = S.panes.filter((p) => p !== cid);
    if (panes.length <= 1) {
      const last = panes[0] || cid;
      S.panes = [];
      history.replaceState(Object.assign({ navDepth: S.navDepth, pos: S.curPos }, { kind: "convo", ctx: ctxForCid(last) }), "", urlFor({ kind: "convo", ctx: { conversationId: last } }));
      render({ kind: "convo", ctx: ctxForCid(last) });
      return;
    }
    S.panes = panes;
    S.paneFocus = Math.min(S.paneFocus, panes.length - 1);
    history.replaceState(Object.assign({ navDepth: S.navDepth, pos: S.curPos }, { kind: "split", panes: S.panes }), "", urlFor({ kind: "split" }));
    render({ kind: "split", panes: S.panes });
  }

  function mountConvo(ctx) {
    const full = Object.assign({}, ctx);
    S.view.ctx = full;
    const openFile = (p, label) => go({ kind: "file", path: p, label });
    clear(viewEl); clear(compHost);

    // Optimistic "starting agy…" placeholder: New chat navigates here the instant
    // Start is clicked, before the conversation id exists. start() resolves the id
    // in the background and re-renders this view with the real cid (or bounces back
    // to the form on failure). No polling here — the upgrade is push-driven.
    if (full.pendingStart && !full.conversationId) {
      const feed = el("div", { class: "agy-feed" });
      feed.appendChild(el("div", { class: "agy-turn" }, [
        el("div", { class: "agy-msg-user" }, [
          el("div", { class: "agy-rolebar" }, [el("span", { class: "agy-role you", text: "YOU" })]),
          el("div", { class: "agy-msg-text" }, richText(full.pendingMessage || "", openFile)),
        ]),
      ]));
      feed.appendChild(el("div", { class: "agy-pendrow" }, [
        el("span", { class: "agy-dot" }),
        el("span", { class: "t", text: "starting agy in " + (full.project || full.shortWorkspace || "this workspace") + "…" }),
      ]));
      viewEl.appendChild(feed);
      compHost.appendChild(el("div", { class: "agy-comp-strip" }, [
        el("div", { class: "agy-comp" }, [
          el("div", { class: "agy-comp-disabled", text: "Starting agy — the composer opens once the conversation is ready." }),
        ]),
      ]));
      viewTick = null;
      return;
    }

    const feed = el("div", { class: "agy-feed" });
    viewEl.appendChild(feed);
    const approvalBox = el("div", { class: "agy-convo-approval" });
    viewEl.appendChild(approvalBox);

    // ---- pending (optimistic send echo) ----
    let pendingMsg = null, pendingBaseCount = 0, pendingEl = null;
    function setPending(msg) {
      if (pendingEl) { try { viewEl.removeChild(pendingEl); } catch {} pendingEl = null; }
      if (!msg) return;
      pendingEl = el("div", { class: "agy-feed" }, [
        el("div", { class: "agy-turn" }, [
          el("div", { class: "agy-msg-user" }, [
            el("div", { class: "agy-rolebar" }, [el("span", { class: "agy-role you", text: "YOU" })]),
            el("div", { class: "agy-msg-text" }, richText(msg, openFile)),
          ]),
        ]),
        el("div", { class: "agy-pendrow" }, [el("span", { class: "agy-dot" }), el("span", { class: "t", text: "agy is responding…" })]),
      ]);
      viewEl.insertBefore(pendingEl, approvalBox);
      viewEl.scrollTop = viewEl.scrollHeight;
    }

    // ---- composer ----
    // Enabled unless this conversation is open in a live INTERACTIVE agy
    // terminal (backend refuses those); print-mode/UI runs + history are fine.
    const liveSess = () => full.conversationId ? D.sessions.find((x) => x.conversationId === full.conversationId) : null;
    const s0 = liveSess();
    const terminalHeld = !!(s0 && s0.mode && s0.mode !== "print");
    let composer = null;
    if (terminalHeld) {
      compHost.appendChild(el("div", { class: "agy-comp-strip" }, [
        el("div", { class: "agy-comp" }, [
          el("div", { class: "agy-comp-disabled", text: "This session is open in an agy terminal — type there to continue it." }),
        ]),
      ]));
    } else {
      composer = makeComposer({
        cid: full.conversationId,
        getWorkspace: () => full.workspace,
        onPending: (msg) => {
          pendingMsg = msg; pendingBaseCount = rows.length;
          setPending(msg);
          load();
        },
        onCommand: (name, rest) => handleMonitorCommand(name, rest),
        onBtw: () => openBtw(null),
        placeholder: s0 && s0.state === "busy" ? "agy is working — messages queue and send when the run finishes…" : "Send a message to this conversation…",
      });
      compHost.appendChild(el("div", { class: "agy-comp-strip" }, [composer.root]));
      S.activeComposer = composer;
    }
    const tryFlush = composer ? composer.tryFlush : null;

    // ask-card answers are their own send path (no chat bubble — the card folds)
    async function sendAnswer(text) {
      try {
        const res = await runTool(tool.id, { action: "send-message", conversationId: full.conversationId, message: text });
        if (res && res.ok) { if (shell) shell.toast("✓ Answers sent — agy continues"); load(); }
        else if (res && res.busy) { if (shell) shell.toast("agy is busy — answer again when the run finishes"); }
        else if (shell) shell.toast((res && res.message) || "failed to send answers");
      } catch {}
    }

    // ---- inline approval for THIS conversation ----
    function drawApprovals() {
      const aps = D.approvals.filter((a) => a.conversationId === full.conversationId);
      clear(approvalBox);
      if (!aps.length) return;
      const wrap = el("div", { class: "agy-feed" });
      for (const a of aps) wrap.appendChild(approvalCard(a, false));
      approvalBox.appendChild(wrap);
    }
    S.approvalRefresh = drawApprovals; // answerApproval calls this to clear the card instantly

    // ---- transcript polling with row reconciliation ----
    const rows = [];
    let seenSent = 0;
    async function load() {
      let res;
      try { res = await runTool(tool.id, { action: "get-conversation", conversationId: full.conversationId }); }
      catch { return; }
      if (S.view.kind !== "convo" || !S.view.ctx || S.view.ctx.conversationId !== full.conversationId) return; // superseded
      if (!res || !res.ok) return;
      if (res.title) { full.title = res.title; }
      full.workspace = full.workspace || res.workspace;
      full.project = full.project || res.project;
      full.shortWorkspace = full.shortWorkspace || res.shortWorkspace;
      S.view.costUsd = res.costUsd; S.view.tokens = res.tokens;
      renderHeader();

      const s = liveSess();
      const awaiting = !!(s && s.state === "waiting");
      // agy's own log proved this tool call was escaped/denied — it never ran. Keep the
      // NAME: only the matching card should be marked, not every result-less one.
      const cancelled = (s && s.cancelledTool) || null;
      const live = !!(s && (s.state === "busy" || s.state === "waiting")) || D.runs.some((r) => r.conversationId === full.conversationId && r.status === "running");
      const msgs = annotateAsks(mergeTranscript(res.messages || []));
      const nearBottom = viewEl.scrollHeight - viewEl.scrollTop - viewEl.clientHeight < 80;
      if (pendingEl) { try { viewEl.removeChild(pendingEl); } catch {} pendingEl = null; }
      let changed = false;
      for (let i = 0; i < msgs.length; i++) {
        const sig = msgSig(msgs[i]) + askSig(msgs[i]) + (i === msgs.length - 1 ? (live ? (awaiting ? ":await" : ":live") : cancelled ? ":cancel" : "") : "");
        const opts = { openFile, isLast: i === msgs.length - 1, live, awaiting, cancelled, cid: full.conversationId, sendAnswer, forkFrom: (ts) => forkNow(ts) };
        if (i >= rows.length) {
          const fresh = messageEl(msgs[i], i, opts);
          feed.appendChild(fresh); rows.push({ sig, el: fresh }); changed = true;
        } else if (rows[i].sig !== sig) {
          const fresh = messageEl(msgs[i], i, opts);
          preserveOpen(rows[i].el, fresh);
          feed.replaceChild(fresh, rows[i].el); rows[i] = { sig, el: fresh }; changed = true;
        }
      }
      while (rows.length > msgs.length) { feed.removeChild(rows.pop().el); changed = true; }
      if (!rows.length) feed.appendChild(el("div", { class: "agy-ws-empty", text: "No messages yet." }));
      if (pendingMsg && msgs.length > pendingBaseCount) pendingMsg = null;
      if (pendingMsg) setPending(pendingMsg);
      if ((changed || pendingMsg) && nearBottom) viewEl.scrollTop = viewEl.scrollHeight;
      drawApprovals();
      if (tryFlush) tryFlush();

      // workspace panel: refresh the diff + the last turn's file set
      if (full.workspace) refreshPanel(full.workspace);
      let lastUser = -1;
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { lastUser = i; break; }
      const turnFiles = [];
      for (let i = lastUser + 1; i < msgs.length; i++) {
        for (const tc of msgs[i].toolCalls || []) if (tc.file && !turnFiles.includes(tc.file)) turnFiles.push(tc.file);
      }
      const userCount = msgs.filter((m) => m.role === "user").length;
      const lu = lastUser >= 0 ? msgs[lastUser] : null;
      let turnTime = "";
      if (lu && lu.ts) {
        const d = new Date(typeof lu.ts === "number" ? (lu.ts > 1e12 ? lu.ts : lu.ts * 1000) : lu.ts);
        if (!isNaN(d)) turnTime = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      }
      setTurnInfo(turnFiles, "TURN " + userCount + (turnTime ? " · " + turnTime : "") +
        (lu && lu.text ? " — " + lu.text.replace(/\s+/g, " ").slice(0, 60) : ""));

      // clear the unread badge for this conversation (server-side last-seen cursor)
      if (res.msgCount != null && res.msgCount !== seenSent) {
        seenSent = res.msgCount;
        runTool(tool.id, { action: "mark-seen", conversationId: full.conversationId, count: res.msgCount }).catch(() => {});
        const mine = D.sessions.find((x) => x.conversationId === full.conversationId);
        if (mine && mine.unread) { mine.unread = 0; renderSide(); }
      }
    }
    viewTick = load;
    load();
  }

  // -- split view (2-3 conversations side-by-side) --
  function mountSplit() {
    clear(viewEl); clear(compHost);
    const wrap = el("div", { class: "agy-split" });
    viewEl.appendChild(wrap);
    const openFile = (p, label) => go({ kind: "file", path: p, label });

    const panes = S.panes.map((cid, idx) => makePane(cid, idx));
    function focusPane(idx) {
      if (S.paneFocus === idx) return;
      S.paneFocus = idx;
      panes.forEach((p, i) => p.el.classList.toggle("focused", i === idx));
      const p = panes[idx];
      S.splitCtx = p.ctx;
      S.activeComposer = p.composer || null;
      if (p.ctx.workspace) refreshPanel(p.ctx.workspace);
      setTurnInfo(p.turnFiles || [], p.turnLabel || null);
      renderHeader();
    }

    function makePane(cid, idx) {
      const ctx = ctxForCid(cid);
      const head = {
        dot: el("span", { class: "agy-dot done" }),
        title: el("span", { class: "t", text: ctx.title || "conversation" }),
        sub: el("span", { class: "s", text: ctx.project || "" }),
      };
      const feed = el("div", { class: "agy-pane-feed" });
      const approvalHost = el("div");
      const pane = { cid, ctx, rows: [], pendingMsg: null, pendingBaseCount: 0, pendingEl: null, seenSent: 0, turnFiles: [], turnLabel: null };

      const composer = makeComposer({
        cid, compact: true,
        getWorkspace: () => pane.ctx.workspace,
        onPending: (msg) => { pane.pendingMsg = msg; pane.pendingBaseCount = pane.rows.length; setPending(msg); pane.load(); },
        onCommand: (name, rest) => handleMonitorCommand(name, rest),
        placeholder: "Message…",
      });
      pane.composer = composer;

      function setPending(msg) {
        if (pane.pendingEl) { try { feed.removeChild(pane.pendingEl); } catch {} pane.pendingEl = null; }
        if (!msg) return;
        pane.pendingEl = el("div", {}, [
          el("div", { class: "agy-turn" }, [
            el("div", { class: "agy-msg-user" }, [
              el("div", { class: "agy-rolebar" }, [el("span", { class: "agy-role you", text: "YOU" })]),
              el("div", { class: "agy-msg-text" }, richText(msg, openFile)),
            ]),
          ]),
          el("div", { class: "agy-pendrow" }, [el("span", { class: "agy-dot" }), el("span", { class: "t", text: "agy is responding…" })]),
        ]);
        feed.appendChild(pane.pendingEl);
        feed.scrollTop = feed.scrollHeight;
      }

      function drawApproval() {
        const a = D.approvals.find((x) => x.conversationId === cid);
        clear(approvalHost);
        if (!a) return;
        approvalHost.appendChild(el("div", { class: "agy-pane-approval" }, [
          el("span", { class: "lbl", text: "● APPROVAL" }),
          el("span", { class: "cmd", text: "$ " + (a.command || "") }),
          el("button", { class: "ok", text: "✓", title: "approve", onclick: () => answerApproval(a, "allow") }),
          el("button", { class: "no", text: "✕", title: "deny", onclick: () => answerApproval(a, "deny") }),
        ]));
      }
      pane.drawApproval = drawApproval;

      pane.load = async function () {
        let res;
        try { res = await runTool(tool.id, { action: "get-conversation", conversationId: cid }); }
        catch { return; }
        if (S.view.kind !== "split" || !S.panes.includes(cid)) return; // superseded
        if (!res || !res.ok) return;
        if (res.title) { pane.ctx.title = res.title; head.title.textContent = res.title; }
        pane.ctx.workspace = pane.ctx.workspace || res.workspace;
        pane.ctx.project = pane.ctx.project || res.project;
        pane.ctx.shortWorkspace = pane.ctx.shortWorkspace || res.shortWorkspace;

        const s = D.sessions.find((x) => x.conversationId === cid);
        const meta = s ? stateMeta(s) : { cls: "done", detail: "history" };
        head.dot.className = "agy-dot " + meta.cls;
        clear(head.sub);
        head.sub.appendChild(document.createTextNode((pane.ctx.project || "") + " · "));
        head.sub.appendChild(el("span", { class: "agy-tc-" + meta.cls, text: meta.detail }));

        const live = !!(s && (s.state === "busy" || s.state === "waiting")) || D.runs.some((r) => r.conversationId === cid && r.status === "running");
        const msgs = annotateAsks(mergeTranscript(res.messages || []));
        const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
        if (pane.pendingEl) { try { feed.removeChild(pane.pendingEl); } catch {} pane.pendingEl = null; }
        let changed = false;
        for (let i = 0; i < msgs.length; i++) {
          const sig = msgSig(msgs[i]) + askSig(msgs[i]) + (i === msgs.length - 1 && live ? ":live" : "");
          const mOpts = { openFile, isLast: i === msgs.length - 1, live, compact: true, cid, askJump: () => openConvo(pane.ctx) };
          if (i >= pane.rows.length) {
            const fresh = messageEl(msgs[i], i, mOpts);
            feed.appendChild(fresh); pane.rows.push({ sig, el: fresh }); changed = true;
          } else if (pane.rows[i].sig !== sig) {
            const fresh = messageEl(msgs[i], i, mOpts);
            preserveOpen(pane.rows[i].el, fresh);
            feed.replaceChild(fresh, pane.rows[i].el); pane.rows[i] = { sig, el: fresh }; changed = true;
          }
        }
        while (pane.rows.length > msgs.length) { feed.removeChild(pane.rows.pop().el); changed = true; }
        if (pane.pendingMsg && msgs.length > pane.pendingBaseCount) pane.pendingMsg = null;
        if (pane.pendingMsg) setPending(pane.pendingMsg);
        if ((changed || pane.pendingMsg) && nearBottom) feed.scrollTop = feed.scrollHeight;
        drawApproval();
        composer.tryFlush();

        // turn file set (workspace panel follows the FOCUSED pane)
        let lastUser = -1;
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { lastUser = i; break; }
        const turnFiles = [];
        for (let i = lastUser + 1; i < msgs.length; i++) {
          for (const tc of msgs[i].toolCalls || []) if (tc.file && !turnFiles.includes(tc.file)) turnFiles.push(tc.file);
        }
        pane.turnFiles = turnFiles;
        pane.turnLabel = "TURN " + msgs.filter((m) => m.role === "user").length;
        if (S.paneFocus === idx) {
          S.splitCtx = pane.ctx;
          if (pane.ctx.workspace) refreshPanel(pane.ctx.workspace);
          setTurnInfo(turnFiles, pane.turnLabel);
        }
        if (res.msgCount != null && res.msgCount !== pane.seenSent) {
          pane.seenSent = res.msgCount;
          runTool(tool.id, { action: "mark-seen", conversationId: cid, count: res.msgCount }).catch(() => {});
          const mine = D.sessions.find((x) => x.conversationId === cid);
          if (mine && mine.unread) { mine.unread = 0; renderSide(); }
        }
      };

      pane.el = el("div", {
        class: "agy-pane" + (idx === S.paneFocus ? " focused" : ""),
        onclick: () => focusPane(idx),
      }, [
        el("div", { class: "agy-pane-head" }, [
          head.dot,
          el("span", { class: "mid" }, [head.title, head.sub]),
          el("span", { class: "agy-x", text: "✕", title: "close pane", onclick: (e) => { e.stopPropagation(); closePane(cid); } }),
        ]),
        feed,
        approvalHost,
        el("div", { class: "agy-pane-comp" }, [composer.root]),
      ]);
      return pane;
    }

    for (const p of panes) wrap.appendChild(p.el);
    const first = panes[S.paneFocus] || panes[0];
    if (first) { S.splitCtx = first.ctx; S.activeComposer = first.composer || null; }
    S.approvalRefresh = () => panes.forEach((p) => { try { p.drawApproval(); } catch {} });
    viewTick = () => Promise.all(panes.map((p) => p.load()));
    viewTick();
  }

  // ---------- monitor slash commands (/review, /fanout, /fork, /btw) ----------
  function handleMonitorCommand(name, rest) {
    if (name === "review") { runReviewNow(); return; }
    if (name === "fanout") { goFanout(rest || lastUserText()); return; }
    if (name === "fork") { forkNow(null); return; }
    if (name === "btw") { openBtw(rest || null); return; }
  }
  function activeCid() {
    if (S.view.kind === "convo" && S.view.ctx) return S.view.ctx.conversationId || null;
    if (S.view.kind === "split") return S.panes[S.paneFocus] || null;
    return null;
  }

  // ---------- ⑂ fork ----------
  // agy has no native fork — the backend starts a NEW conversation seeded with
  // a digest of this one's transcript (optionally cut at uptoTs = "fork from here").
  let forking = false;
  async function forkNow(uptoTs) {
    const cid = activeCid();
    if (!cid) { if (shell) shell.toast("Open a conversation to fork it"); return; }
    if (forking) return;
    forking = true;
    if (shell) shell.toast("⑂ forking — copying context into a fresh session…");
    let res;
    try { res = await runTool(tool.id, { action: "fork-conversation", conversationId: cid, uptoTs: uptoTs || undefined }); }
    catch (e) { res = { ok: false, message: String((e && e.message) || e) }; }
    forking = false;
    if (!res || !res.ok) { if (shell) shell.toast((res && res.message) || "fork failed"); return; }
    if (res.conversationId) {
      if (shell) shell.toast("⑂ forked — you're in the copy now");
      openConvo({ conversationId: res.conversationId, workspace: res.workspace, project: (res.workspace || "").split("/").pop(), shortWorkspace: res.workspace });
    } else if (shell) shell.toast(res.message || "⑂ fork started — it'll appear in history shortly");
    tick();
  }

  // ---------- ◗ btw side chat ----------
  // A docked side channel per conversation: the side model reads the transcript
  // but its answers never enter the conversation. Threads live in memory only.
  const BTW = { open: false, cid: null, threads: {}, pending: false };
  let btwEl = null;
  function closeBtw() { BTW.open = false; renderBtw(); }
  function openBtw(question) {
    const cid = activeCid();
    if (!cid) { if (shell) shell.toast("Open a conversation first — btw reads its transcript"); return; }
    BTW.open = true; BTW.cid = cid;
    renderBtw();
    if (question) btwSend(question);
  }
  async function btwSend(q) {
    const cid = BTW.cid;
    const question = (q || "").trim();
    if (!question || BTW.pending) return;
    const th = BTW.threads[cid] || (BTW.threads[cid] = []);
    const history = th.slice();
    th.push({ who: "you", text: question });
    BTW.pending = true;
    renderBtw();
    let res;
    try { res = await runTool(tool.id, { action: "btw", conversationId: cid, question, history }); }
    catch (e) { res = { ok: false, message: String((e && e.message) || e) }; }
    BTW.pending = false;
    th.push(res && res.ok
      ? { who: "side", text: res.answer || "(no answer)", meta: res.meta }
      : { who: "side", text: "✕ " + ((res && res.message) || "side call failed"), err: true });
    renderBtw();
  }
  function renderBtw() {
    if (btwEl) { try { root.removeChild(btwEl); } catch {} btwEl = null; }
    if (!BTW.open) return;
    const th = BTW.threads[BTW.cid] || [];
    const feed = el("div", { class: "agy-btw-feed" });
    if (!th.length && !BTW.pending) {
      feed.appendChild(el("div", { class: "agy-btw-empty" }, [
        document.createTextNode("Ask about this conversation, the codebase, agy itself — the side model reads the transcript but "),
        el("span", { class: "g", text: "writes nothing back into it" }),
        document.createTextNode(". The main context stays untouched."),
      ]));
    }
    for (const b of th) {
      feed.appendChild(el("div", { class: "agy-btw-turn" }, [
        el("span", { class: "who " + (b.who === "side" ? "side" : "you"), text: b.who === "side" ? "SIDE" : "YOU" }),
        el("span", { class: "t" + (b.err ? " err" : ""), text: b.text }),
        b.meta ? el("span", { class: "meta", text: [b.meta.model, b.meta.costUsd != null ? fmtCost(b.meta.costUsd) : null, b.meta.ms != null ? Math.round(b.meta.ms / 1000) + "s" : null].filter(Boolean).join(" · ") }) : null,
      ]));
    }
    if (BTW.pending) feed.appendChild(el("div", { class: "agy-btw-pend" }, [
      el("span", { class: "d" }), el("span", { class: "t", text: "side model thinking…" }),
    ]));
    const ta = el("textarea", { class: "agy-btw-ta", rows: "1", placeholder: "Ask on the side…" });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = ta.value; ta.value = ""; btwSend(v); }
      else if (e.key === "Escape") { e.stopPropagation(); closeBtw(); }
    });
    const rightOff = (hasWorkspace() ? (P.rightOpen ? P.rightW + 5 : 46) : 0) + 18;
    btwEl = el("div", { class: "agy-btw", style: { right: rightOff + "px" } }, [
      el("div", { class: "agy-btw-head" }, [
        el("span", { class: "t", text: "◗ BTW · SIDE CHAT" }),
        el("span", { class: "chip", text: "NOT IN CONTEXT" }),
        el("span", { style: { flex: "1" } }),
        el("span", { class: "x", title: "close (esc)", text: "✕", onclick: closeBtw }),
      ]),
      feed,
      el("div", { class: "agy-btw-bar" }, [
        ta,
        el("span", { class: "send", title: "ask (↵)", text: "↵", onclick: () => { const v = ta.value; ta.value = ""; btwSend(v); } }),
      ]),
    ]);
    root.appendChild(btwEl);
    feed.scrollTop = feed.scrollHeight;
    ta.focus();
  }

  function lastUserText() {
    // best-effort prefill: the current view's title (agy titles ≈ the task)
    const ctx = S.view.kind === "split" ? S.splitCtx : (S.view.kind === "convo" ? S.view.ctx : null);
    return (ctx && ctx.title) || "";
  }
  function activeWorkspace() {
    const ctx = S.view.kind === "split" ? S.splitCtx : (S.view.kind === "convo" ? S.view.ctx : null);
    return (ctx && ctx.workspace) || PANEL.workspace || null;
  }

  // ---------- fan-out launcher ----------
  // Fan-out lives on the new-chat page now (its ⑃ best-of-N / ⑃ decompose modes).
  // Every entry point routes there, carrying the workspace + prefilling the task.
  function goFanout(prefill) {
    navTop({ kind: "newchat", ctx: { workspace: activeWorkspace() || "", message: prefill || "", fanout: true } });
  }

  // ---------- fan-out detail view ----------
  const FAN_CHIP = {
    running: { cls: "busy", label: "workers running" },
    judging: { cls: "busy", label: "opus judging" },
    done: { cls: "waiting", label: "pick a winner" },
    applied: { cls: "idle", label: "applied" },
    discarded: { cls: "done", label: "discarded" },
  };
  function ordinal(n) { return n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : n + "TH"; }

  function mountFanout(id) {
    clear(viewEl); clear(compHost);
    const page = el("div", { class: "agy-fan-page" });
    viewEl.appendChild(page);
    let lastSig = "";

    async function load() {
      let res;
      try { res = await runTool(tool.id, { action: "get-fanout", id }); } catch { return; }
      if (S.view.kind !== "fanout" || S.view.id !== id) return;
      if (!res || !res.ok) { clear(page); page.appendChild(el("div", { class: "agy-empty-dash", text: (res && res.message) || "fan-out not found" })); return; }
      const g = res.group;
      S.view.fanout = g;
      const sig = JSON.stringify(g);
      if (sig === lastSig) return;
      lastSig = sig;
      renderHeader();
      clear(page);

      page.appendChild(el("div", { class: "agy-fan-task" }, [
        el("div", { class: "top" }, [
          el("span", { class: "t", text: g.task }),
          g.status !== "applied" && g.status !== "discarded" ? el("span", {
            class: "discard", text: "discard", title: "discard this fan-out (removes worktrees)",
            onclick: async () => { try { await runTool(tool.id, { action: "fanout-discard", id }); } catch {} tick(); load(); },
          }) : null,
        ]),
        el("span", { class: "s", text: g.strategy + " · isolated git worktrees · " + g.project }),
      ]));

      const decompose = g.strategyMode === "decompose";
      if (g.status === "running" || g.status === "judging") {
        const sec = el("div", { class: "agy-ov-sec" }, [el("span", { class: "agy-lbl", text: "WORKERS" })]);
        const list = el("div", { class: "agy-cardlist" });
        for (const w of g.workers) {
          const done = w.status !== "running";
          list.appendChild(el("div", { class: "agy-fan-worker" }, [
            el("span", { class: "lb", text: w.label }),
            el("span", { class: "agy-dot " + (done ? "idle" : "busy") }),
            el("span", { class: "ap", text: w.approach }),
            el("span", { class: "st agy-tc-" + (done ? "idle" : "busy"), text: done ? "done" : "running" }),
            el("span", { class: "meta", text: "+" + w.add + " −" + w.del + (w.startedAt ? " · " + agoShort(new Date(w.startedAt).toISOString()) : "") }),
          ]));
        }
        sec.appendChild(list);
        page.appendChild(sec);
      }
      if (g.status === "judging") {
        page.appendChild(el("div", { class: "agy-fan-judging" }, [
          el("span", { class: "g", text: "⚖" }),
          el("span", { class: "t", text: "all workers done — opus is " + (decompose ? "checking the subtask diffs for conflicts…" : "ranking the candidate diffs…") }),
        ]));
      }
      if (g.status === "done" || g.status === "applied") {
        if (g.judge) {
          page.appendChild(el("div", { class: "agy-fan-verdict" }, [
            el("span", { class: "h", text: "⚖ JUDGE VERDICT" }),
            el("span", { class: "sum", text: g.judge.summary }),
            g.judge.meta ? el("span", { class: "meta", text: [g.judge.meta.model, "$" + g.judge.meta.costUsd.toFixed(2), Math.round(g.judge.meta.ms / 1000) + "s"].join(" · ") }) : null,
            decompose && g.status === "done" ? el("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "2px" } }, [
              el("button", { class: "agy-btn sm", text: "✓ Merge all in order", title: "apply each subtask diff into the project checkout in order — stops at the first conflict, earlier ones stay applied (removes the worktrees)", onclick: async () => {
                const res2 = await runTool(tool.id, { action: "fanout-merge-all", id }).catch(() => null);
                if (res2 && !res2.ok && shell) shell.toast(res2.message);
                if (res2 && res2.ok && shell) shell.toast("✓ Merged " + g.workers.length + " subtask diffs in order");
                tick(); lastSig = ""; load();
              } }),
              el("span", { class: "agy-hint", text: "applies each subtask worktree sequentially" }),
            ]) : null,
          ]));
        }
        const sorted = g.workers.slice().sort((a, b) => ((a.rank || a.order || 9) - (b.rank || b.order || 9)));
        for (const w of sorted) {
          const first = (w.rank || w.order) === 1;
          page.appendChild(el("div", { class: "agy-fan-cand" }, [
            el("div", { class: "head" }, [
              el("span", { class: "agy-rank " + (first ? "first" : "rest"), text: decompose ? "STEP " + (w.order || "?") : ordinal(w.rank || 9) }),
              el("span", { class: "lb", text: w.label }),
              el("span", { class: "ap", text: w.approach }),
              !decompose && w.score != null ? el("span", { style: { display: "flex", alignItems: "center", gap: "6px", flexShrink: "0" } }, [
                el("span", { class: "agy-scorebar" }, [el("span", { style: { width: Math.min(100, w.score * 10) + "%", background: first ? "var(--amber)" : "var(--sec)" } })]),
                el("span", { class: "agy-score", style: { color: first ? "var(--amber)" : "var(--sec)" }, text: String(w.score) }),
              ]) : null,
            ]),
            el("div", { class: "bd" }, [
              w.verdict ? el("span", { class: "verdict", text: w.verdict }) : null,
              w.error ? el("span", { class: "verdict", style: { color: "var(--red)" }, text: w.error }) : null,
              el("div", { class: "actions" }, [
                g.status === "done" && !decompose && !w.empty ? el("button", { class: "agy-btn xs", text: "✓ apply this diff", title: "apply this candidate's diff to the workspace — discards every other candidate's worktree", onclick: async () => {
                  const res2 = await runTool(tool.id, { action: "fanout-apply", id, label: w.label }).catch(() => null);
                  if (res2 && !res2.ok && shell) shell.toast(res2.message);
                  if (res2 && res2.ok && shell) shell.toast("✓ Applied " + w.label + " — other worktrees discarded");
                  tick(); lastSig = ""; load();
                } }) : null,
                g.status === "applied" && w.applied ? el("span", { class: "applied", text: decompose ? "✓ MERGED" : "✓ APPLIED — OTHERS DISCARDED" }) : null,
                el("span", { class: "stat", text: "+" + w.add + " −" + w.del + (w.empty ? " · empty diff" : "") }),
              ]),
            ]),
          ]));
        }
      }
    }
    viewTick = load;
    load();
  }

  // -- all chats --
  function mountAllChats() {
    viewTick = null;
    clear(viewEl); clear(compHost);
    const page = el("div", { class: "agy-page" });
    viewEl.appendChild(page);
    const search = el("input", { class: "agy-search", type: "text", placeholder: "Search conversations by title, project, or content…" });
    page.appendChild(search);
    const body = el("div", { style: { display: "flex", flexDirection: "column", gap: "16px" } });
    const contentBox = el("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } });
    page.appendChild(body); page.appendChild(contentBox);

    let all = [];
    let topCids = new Set();
    const chatRow = (c, q, liveCids) => el("div", {
      class: "agy-chatrow",
      onclick: () => openConvo({ conversationId: c.conversationId, title: c.title, project: c.project, shortWorkspace: c.shortWorkspace, workspace: c.workspace, historical: true }),
    }, [
      el("span", { class: "mid" }, [
        el("span", { class: "t", text: c.title || "(untitled)" }),
        c.snippet ? snippetNode(c.snippet, q) : null,
      ]),
      liveCids.has(c.conversationId)
        ? el("span", { class: "agy-srctag live", title: "an agy process is running this conversation right now" }, [
            el("span", { class: "agy-dot busy" }), el("span", { text: "LIVE" }),
          ])
        : null,
      c.backfilled ? el("span", { class: "agy-srctag", text: "RECOVERED", title: "recovered from brain/ — agy never wrote this conversation to its /resume index" }) : null,
      c.source === "ide" ? el("span", { class: "agy-srctag", text: "IDE" }) : null,
      el("span", { class: "cost", text: c.costUsd != null ? fmtCost(c.costUsd) : "" }),
      el("span", { class: "steps", text: c.numSteps != null ? c.numSteps + " st" : "" }),
      el("span", { class: "ago", text: c.updatedAt ? tsAgoShort(Date.parse(c.updatedAt)) : "" }),
    ]);
    function snippetNode(snippet, q) {
      const div = el("span", { class: "snip" });
      const lc = snippet.toLowerCase(), lq = (q || "").toLowerCase();
      let i = 0, idx;
      while (lq && (idx = lc.indexOf(lq, i)) >= 0) {
        if (idx > i) div.appendChild(document.createTextNode(snippet.slice(i, idx)));
        div.appendChild(el("mark", { text: snippet.slice(idx, idx + lq.length) }));
        i = idx + lq.length;
      }
      if (i < snippet.length) div.appendChild(document.createTextNode(snippet.slice(i)));
      return div;
    }
    // Liveness comes from what the dashboard already polls (refreshCore, every
    // 4s/15s + SSE) — same test as renderHeader/runRow. No ps/lsof per load.
    let liveSig = "";
    function liveSet() {
      const s = new Set(D.sessions.map((x) => x.conversationId).filter(Boolean));
      for (const r of D.runs) if (r.conversationId && (r.status === "running" || r.status === "waiting")) s.add(r.conversationId);
      return s;
    }
    // The poll hook. Rebuilding 40+ rows every tick would churn the DOM for nothing
    // and race Playwright mid-click, so repaint only when liveness actually moved.
    function tickRender() {
      const sig = [...liveSet()].sort().join(",");
      if (sig === liveSig) return;
      render();
      paintContentRows(); // render() clears only `body` — restamp the content-search rows too
    }
    function render() {
      const scrollTop = viewEl.scrollTop; // render() also repaints on the poll — don't jump the list
      const q = (search.value || "").trim().toLowerCase();
      const convos = q ? all.filter((c) => (c.title || "").toLowerCase().includes(q) || (c.project || "").toLowerCase().includes(q)) : all;
      const liveCids = liveSet();
      liveSig = [...liveCids].sort().join(",");
      topCids = new Set(convos.map((c) => c.conversationId));
      headStatusText = (q ? convos.length + " OF " + all.length : String(all.length)) + " CONVERSATIONS";
      renderHeader();
      clear(body);
      if (!convos.length) { body.appendChild(el("div", { class: "agy-empty-dash", text: q ? "No chats match." : "No conversations yet." })); viewEl.scrollTop = scrollTop; return; }
      // Rows the server tagged as a repeated one-shot prompt (a commit-message
      // helper, a judge, a probe) fold into one group below the real projects —
      // otherwise hundreds of them bury every hand-written chat.
      const { plain, noise } = splitNoise(convos);
      const groups = new Map();
      for (const c of plain) {
        const key = c.workspace || "(no workspace)";
        if (!groups.has(key)) groups.set(key, { project: c.project, shortWorkspace: c.shortWorkspace, items: [] });
        groups.get(key).items.push(c);
      }
      for (const g of groups.values()) {
        const sec = el("div", { class: "agy-chatgroup" }, [
          el("div", { class: "agy-chatgroup-head" }, [
            el("span", { class: "n", text: g.project || "(no workspace)" }),
            el("span", { class: "p", text: g.shortWorkspace || "" }),
          ]),
        ]);
        const list = el("div", { class: "agy-cardlist" });
        for (const c of g.items) list.appendChild(chatRow(c, q, liveCids));
        sec.appendChild(list);
        body.appendChild(sec);
      }
      for (const g of noise) body.appendChild(noiseSection(g, (c) => chatRow(c, q, liveCids), !!q, "all"));
      viewEl.scrollTop = scrollTop;
    }
    let searchTimer = null;
    // the last content-search result, kept so the poll can restamp its LIVE chips
    let lastMatches = [], lastQ = "";
    function paintContentRows() {
      clear(contentBox);
      if (!lastMatches.length) return;
      contentBox.appendChild(el("div", { class: "agy-sub-note", text: "FOUND INSIDE " + lastMatches.length + " MORE CONVERSATION" + (lastMatches.length === 1 ? "" : "S") }));
      const liveCids = liveSet();
      // A content query matches the transcript BODY, so a repeated one-shot
      // prompt hits on every single run — this section floods harder than the
      // list above it. Same fold, and the count above stays the true total.
      const { plain, noise } = splitNoise(lastMatches);
      if (plain.length) {
        const list = el("div", { class: "agy-cardlist" });
        for (const c of plain) list.appendChild(chatRow(c, lastQ, liveCids));
        contentBox.appendChild(list);
      }
      for (const g of noise) contentBox.appendChild(noiseSection(g, (c) => chatRow(c, lastQ, liveCids), true, "found"));
    }
    function scheduleContentSearch() {
      const q = (search.value || "").trim();
      lastMatches = [];
      clear(contentBox);
      if (searchTimer) clearTimeout(searchTimer);
      if (q.length < 2) return;
      contentBox.appendChild(el("div", { class: "agy-sub-note", text: "searching inside conversations…" }));
      searchTimer = setTimeout(() => runContentSearch(q), 350);
    }
    async function runContentSearch(q) {
      let res;
      try { res = await runTool(tool.id, { action: "search-conversations", query: q }); }
      catch { clear(contentBox); return; }
      if ((search.value || "").trim() !== q) return;
      clear(contentBox);
      if (!res || !res.ok) return;
      lastMatches = (res.matches || []).filter((m) => !topCids.has(m.conversationId));
      lastQ = q;
      paintContentRows();
    }
    search.addEventListener("input", () => { render(); scheduleContentSearch(); });
    (async () => {
      let res;
      try { res = await runTool(tool.id, { action: "list-all-conversations" }); } catch { return; }
      if (S.view.kind !== "allchats") return; // navigated away mid-fetch — don't steal viewTick
      if (!res || !res.ok) return;
      all = res.conversations || [];
      render();
      viewTick = tickRender; // repaint on the poll so LIVE chips track D.sessions/D.runs (no refetch)
    })();
  }

  // -- safelist --
  // Byte-identical to agy-policy.js's atomMatchesAllow so the chip shows exactly what
  // the gate will read. Greedy + $-anchored, so command(sh -c (x)) keeps its inner parens.
  const RULE_CMD = /^command\((.+)\)$/;
  function parseRule(raw) {
    const s = String(raw == null ? "" : raw);
    const m = RULE_CMD.exec(s);
    if (!m) return { kind: "k-inert", label: s };            // the gate skips it — auto-approves nothing
    const pat = m[1].trim();
    if (!pat) return { kind: "k-inert", label: s };           // "command()" / "command(   )"
    if (pat === "*") return { kind: "k-wide", label: "*" };   // matches EVERY command
    return { kind: "", label: pat };
  }
  function shortHome(p) { return String(p).replace(/^\/(?:Users|home)\/[^/]+\//, "~/"); }

  function mountSafelist() {
    viewTick = null;
    clear(viewEl); clear(compHost);
    const page = el("div", { class: "agy-page agy-sl" });
    viewEl.appendChild(page);
    const search = el("input", {
      class: "agy-search", type: "text", spellcheck: "false",
      "aria-label": "Filter safelist rules, candidates, and gate decisions",
      placeholder: "Filter rules, candidates, and gate decisions — 'npm', 'deny', 'rm'…",
    });
    page.appendChild(search);
    // rendered only while filtering, so an idle page reserves no dead line
    const sumLine = el("div", { class: "agy-sl-sum" });
    sumLine.style.display = "none";
    page.appendChild(sumLine);
    const ruleSec = el("div", { class: "agy-ov-sec", "data-sec": "rules" });
    const candSec = el("div", { class: "agy-ov-sec", "data-sec": "candidates" });
    const decSec = el("div", { class: "agy-ov-sec", "data-sec": "decisions" });
    page.appendChild(ruleSec); page.appendChild(candSec); page.appendChild(decSec);

    let rules = [], rulesPath = "", cands = [], decs = [];
    let phase = "loading";   // "loading" | "ready"
    let rulesOk = false;     // false ⇒ never claim the safelist is empty
    let errMsg = "";
    let usesKnown = false;   // false ⇒ no safelist-allow rows at all; 0 means "no data", not "dead"
    let logSpans = false;    // false ⇒ the log is younger than the window; never claim "unused"
    let usesDays = 30;
    let undo = null;         // the last removed rule, offered back until it's used or dismissed

    // was `try { await runTool(...) } catch {}` — the response was discarded, so a
    // refused promote ("refused to promote: …") and "already covered" were both silent
    async function act(action, atom) {
      let res;
      try { res = await runTool(tool.id, { action, atom }); } catch {}
      if (shell) {
        if (!res) shell.toast("couldn't reach the monitor backend");
        else if (!res.ok) shell.toast(res.message || "that didn't work");
        else if (res.alreadyAllowed) shell.toast(res.message || "already covered by the safelist");
      }
      // a successful mutation elsewhere makes the old offer stale; a FAILED one changed
      // nothing, so the way back must survive it
      if (res && res.ok) undo = null;
      load();
    }
    async function demote(rule) {
      let res;
      try { res = await runTool(tool.id, { action: "demote-safelist-rule", rule }); } catch {}
      const p = parseRule(rule);
      const okd = !!(res && res.ok);
      if (shell) shell.toast(okd
        ? "removed — " + p.label + " asks for approval again" + (res.backup ? " · settings.json backed up" : "")
        : ((res && res.message) || "failed to remove"));
      // restore-safelist-rule puts the string back verbatim; promote would re-veto it.
      // a failed demote removed nothing, so it must not discard a live offer either.
      if (okd) undo = { rule, label: p.label };
      load();
    }
    async function restore(rule) {
      let res;
      try { res = await runTool(tool.id, { action: "restore-safelist-rule", rule }); } catch {}
      const p = parseRule(rule);
      const okd = !!(res && res.ok);
      if (shell) shell.toast(okd
        ? (res.alreadyAllowed ? "already in the safelist" : "restored — " + p.label + " is auto-approved again")
        : ((res && res.message) || "failed to restore"));
      // keep the offer on failure — clearing it would strand the user with no route back
      if (okd) undo = null;
      load();
    }

    function head(labelText, right) {
      return el("div", { class: "agy-sl-head" }, [
        el("span", { class: "agy-lbl", text: labelText }),
        right || null,
      ]);
    }
    const quiet = (text) => el("div", { class: "agy-empty-dash quiet", text });

    function draw() {
      const q = (search.value || "").trim().toLowerCase();
      const rf = rules.filter((r) => !q || r.rule.toLowerCase().includes(q));
      const cf = cands.filter((c) => !q || (c.atom + " " + (c.examples || []).join(" ")).toLowerCase().includes(q));
      // + outcome, so the new meta text stays findable by the same box
      const df = decs.filter((d) => !q || ((d.command || "") + " " + (d.reason || "") + " " +
        (d.decision || d.disposition || "") + " " + (d.outcome || d.stage || "")).toLowerCase().includes(q));

      // a filtered count in the section label would read as "you have 0 rules"
      sumLine.style.display = q ? "" : "none";
      sumLine.textContent = q
        ? rf.length + "/" + rules.length + " rules · " + cf.length + "/" + cands.length +
          " candidates · " + df.length + "/" + decs.length + " decisions"
        : "";

      clear(ruleSec); clear(candSec); clear(decSec);
      const loading = phase === "loading";

      // ---- 1. current safelist ----
      ruleSec.appendChild(head(
        "CURRENT SAFELIST — AUTO-APPROVED" + (loading ? "" : " · " + rf.length),
        rulesPath ? el("span", { class: "agy-sl-path", text: shortHome(rulesPath), title: rulesPath }) : null,
      ));
      if (errMsg) ruleSec.appendChild(el("div", { class: "agy-sl-err", text: errMsg }));
      // the undo offer outlives draw(), so a keystroke in the filter box can't eat it
      if (undo) {
        // bind the rule this row was DRAWN with — `undo` is mutable and a click can land
        // after another action reassigned it, which would restore the wrong rule
        const u = undo;
        ruleSec.appendChild(el("div", { class: "agy-sl-undo", role: "status", "aria-live": "polite" }, [
          el("span", { class: "t", text: "removed " + u.label + " — it asks for approval again" }),
          el("button", { class: "agy-ghost xs", type: "button", text: "Undo",
            title: "put " + u.rule + " back in permissions.allow, exactly as it was",
            onclick: () => restore(u.rule) }),
          el("button", { class: "d", type: "button", text: "✕", "aria-label": "dismiss", title: "dismiss",
            onclick: () => { undo = null; draw(); } }),
        ]));
      }
      if (loading) {
        ruleSec.appendChild(quiet("reading settings.json…"));
      } else if (rulesOk) {
        ruleSec.appendChild(el("div", { class: "agy-sl-note", text:
          "Each entry is a command prefix — agy runs anything starting with it, at a word boundary, without asking. Hover a rule to remove it." +
          (rules.some((r) => r.promoted) ? " A green edge marks rules promoted from this dashboard." : "") +
          (usesKnown ? " The number is how many of the last " + usesDays + " days' auto-approvals each rule covers." : "") }));
        if (!rf.length) {
          ruleSec.appendChild(quiet(q ? "No safelist rules match." : "Empty — agy asks before every command."));
        } else {
          const wrap = el("div", { class: "agy-rulewrap", role: "list",
            "aria-label": "safelist rules — each entry is a command prefix agy auto-approves" });
          for (const r of rf) {
            const p = parseRule(r.rule);
            // an inert rule auto-approves nothing by definition, so a "0" beside it would
            // read as "unused" when the truth is "never consulted" — the tag already says that
            const showUses = usesKnown && p.kind !== "k-inert";
            const uses = typeof r.uses === "number" ? r.uses : 0;
            const fresh = r.promotedTs && (Date.now() - Date.parse(r.promotedTs)) < usesDays * 864e5;
            // "this rule looks dead" is only sayable when the log actually reaches back
            // the whole window; otherwise a young log would brand every rule unused
            const idle = showUses && !uses && !fresh && logSpans;
            wrap.appendChild(el("span", {
              class: "agy-rule" + (p.kind ? " " + p.kind : "") + (r.promoted ? " promoted" : "")
                + (idle ? " unused" : ""),
              role: "listitem",
              "data-rule": r.rule,
              title: r.rule
                + (p.kind === "k-wide" ? "\nmatches EVERY command — nothing is gated while this rule exists" : "")
                + (p.kind === "k-inert" ? "\nnot a command(…) entry — agy's shell gate ignores it" : "")
                + (r.promoted ? "\npromoted from this dashboard" + (r.promotedTs ? " " + tsAgoShort(Date.parse(r.promotedTs)) + " ago" : "") : "")
                + (showUses
                    ? "\n" + (uses
                        // "covers", not "fired": the log records that the safelist allowed a
                        // command, not which entry did, so overlapping rules both count it
                        ? "covers " + uses + " of the commands the safelist auto-approved in the last " + usesDays + " days"
                        : fresh
                          ? "no auto-approvals recorded yet — this rule is newer than the " + usesDays + "-day window"
                          : idle
                            ? "no auto-approvals recorded in the last " + usesDays + " days — it may no longer be needed"
                            : "no auto-approvals recorded — the decision log doesn't go back a full " + usesDays + " days yet")
                    : ""),
            }, [
              el("span", { class: "pat", text: p.label }),
              p.kind === "k-wide" ? el("span", { class: "tag", text: "every command" }) : null,
              p.kind === "k-inert" ? el("span", { class: "tag", text: "not applied" }) : null,
              showUses ? el("span", { class: "use" + (uses ? "" : " zero"), text: fresh && !uses ? "new" : String(uses) }) : null,
              el("button", {
                class: "x", type: "button", text: "✕",
                title: "remove — this rule will ask for approval again",
                "aria-label": "Remove " + r.rule + " from the safelist — this command will ask for approval again"
                  + (r.promoted ? ". Promoted from this dashboard." : ""),
                onclick: () => demote(r.rule),
              }),
            ]));
          }
          ruleSec.appendChild(wrap);
        }
      }

      // ---- 2. candidates ----
      candSec.appendChild(head("CANDIDATES — REPEATEDLY APPROVED, NOT YET SAFELISTED" + (loading ? "" : " · " + cf.length)));
      if (!loading) {
        if (!cf.length) candSec.appendChild(quiet(q ? "No candidates match." : "Nothing to review — approve some gated commands first."));
        for (const c of cf) {
          candSec.appendChild(el("div", { class: "agy-cand" }, [
            el("div", { class: "agy-cand-top" }, [
              el("span", { class: "lft" }, [
                el("span", { class: "agy-atom", text: c.atom, title: c.atom }),
                el("span", { class: "agy-cand-sub", text: c.count + "× approved" + (c.lastTs ? " · last " + tsAgoShort(c.lastTs) + " ago" : "") }),
              ]),
              c.alreadyAllowed
                ? el("span", { class: "agy-cand-done", text: "already covered" })
                : el("span", { class: "agy-approval-btns" }, [
                    el("button", { class: "agy-ghost accent", text: "Promote", title: "adds command(" + c.atom + ") to permissions.allow — agy will then run anything starting with \"" + c.atom + "\" without asking", onclick: () => act("promote-safelist-rule", c.atom) }),
                    el("button", { class: "agy-ghost", text: "Snooze", title: "hide this suggestion for a week — the command still asks for approval", onclick: () => act("snooze-safelist-rule", c.atom) }),
                    el("button", { class: "agy-ghost", text: "Never", title: "never suggest this again — permanent; the command still asks for approval", onclick: () => act("reject-safelist-rule", c.atom) }),
                  ]),
            ]),
            (c.examples || []).length ? el("div", { class: "agy-cand-ex", text: (c.examples || []).map((x) => "$ " + x).join("\n") }) : null,
          ]));
        }
      }

      // ---- 3. decisions ----
      decSec.appendChild(head(
        "RECENT GATE DECISIONS · 7D" + (loading ? "" : " · " + df.length),
        df.length > 50 ? el("span", { class: "agy-sl-sum", text: "SHOWING 50" }) : null,
      ));
      if (!loading) {
        if (!df.length) {
          decSec.appendChild(quiet(q ? "No decisions match." : "No gated commands yet."));
        } else {
          // built only when there are rows — the old code nested a dashed
          // .agy-empty-dash inside this solid bordered container
          const list = el("div", { class: "agy-cardlist" });
          for (const d of df.slice(0, 50)) {
            const verdict = d.decision || d.disposition || "";
            const vc = verdict === "deny" ? "deny" : verdict === "allow" ? "allow" : "other";
            list.appendChild(el("div", {
              class: "agy-decrow",
              title: (d.intent && d.intent !== "(none provided)" ? "intent: " + d.intent + "\n\n" : "") + (d.command || ""),
            }, [
              el("span", { class: "v " + vc, text: verdict || "?" }),
              el("span", { class: "cmd", text: "$ " + (d.command || "") }),
              d.reason ? el("span", { class: "why", text: d.reason }) : null,
              // outcome, not stage: stage is "manual" for both manual-approve and manual-deny
              el("span", { class: "meta", text: [d.outcome || d.stage, d.ts ? tsAgoShort(d.ts) : null].filter(Boolean).join(" · ") }),
            ]));
          }
          decSec.appendChild(list);
        }
      }
    }

    async function load() {
      let rres, cres, dres;
      try {
        [rres, cres, dres] = await Promise.all([
          runTool(tool.id, { action: "list-safelist-rules" }).catch(() => null),
          runTool(tool.id, { action: "list-safelist-candidates" }),
          runTool(tool.id, { action: "list-decisions", days: 7 }),
        ]);
      } catch {
        // was a bare `return`, which left the page permanently blank
        phase = "ready"; rulesOk = false;
        errMsg = "couldn't reach the monitor backend — this is not a claim that the safelist is empty.";
        draw(); return;
      }
      rulesOk = !!(rres && rres.ok);
      rules = (rulesOk && rres.rules) || [];
      rulesPath = (rulesOk && rres.path) || "";
      usesKnown = !!(rulesOk && rres.usesKnown);
      logSpans = !!(rulesOk && rres.logSpansWindow);
      usesDays = (rulesOk && rres.windowDays) || 30;
      cands = (cres && cres.ok && cres.candidates) || [];
      decs = (dres && dres.ok && dres.decisions) || [];
      // a dead promoter module returns {ok:false}; that used to render as
      // "The safelist is empty — every command asks", a false safety claim
      const fail = !rulesOk
        ? ((rres && rres.message) || "couldn't read permissions.allow")
        : ((cres && cres.ok === false && cres.message) || (dres && dres.ok === false && dres.message) || "");
      errMsg = fail ? "couldn't read the safelist — " + fail : "";
      phase = "ready";
      draw();
    }
    search.addEventListener("input", draw);
    draw();   // paint the header + "reading settings.json…" before the first fetch
    load();
  }

  // -- context --
  function mountContext(ctx) {
    viewTick = null;
    clear(viewEl); clear(compHost);
    if (ctx.workspace) refreshPanel(ctx.workspace);
    const page = el("div", { class: "agy-page narrow" });
    viewEl.appendChild(page);
    page.appendChild(el("div", { class: "agy-ctx-note", text: "GEMINI.md / AGENTS.md that agy loads into its prompt. (agy's auto-extracted memories are stored encrypted and can't be shown.)" }));
    (async () => {
      let res;
      try { res = await runTool(tool.id, { action: "get-context", workspace: ctx.workspace }); } catch { return; }
      if (!res || !res.ok) { page.appendChild(el("div", { class: "agy-empty-dash", text: (res && res.message) || "error" })); return; }
      if (res.project && S.view.ctx) { S.view.ctx.project = res.project; renderHeader(); }
      for (const f of res.contextFiles) {
        const name = (f.path || "").split("/").pop();
        const tag = !f.exists ? "not present" : f.empty ? "empty" : "";
        page.appendChild(el("div", { class: "agy-ctxfile" }, [
          el("div", { class: "agy-ctxfile-head" }, [
            el("span", { class: "lft" }, [
              el("span", { class: "scope", text: f.scope }),
              el("span", { class: "name", text: name }),
            ]),
            el("span", { class: "tag", text: tag }),
          ]),
          f.exists && !f.empty ? el("div", { class: "agy-ctxfile-body", text: f.content }) : null,
        ]));
      }
    })();
  }

  // -- history --
  function mountHistory(ctx) {
    viewTick = null;
    clear(viewEl); clear(compHost);
    if (ctx.workspace) refreshPanel(ctx.workspace);
    const page = el("div", { class: "agy-page narrow" });
    viewEl.appendChild(page);
    (async () => {
      let res;
      try { res = await runTool(tool.id, { action: "get-history", workspace: ctx.workspace }); } catch { return; }
      if (!res || !res.ok) { page.appendChild(el("div", { class: "agy-empty-dash", text: (res && res.message) || "error" })); return; }
      const proj = res.project || ctx.project;
      if (proj && S.view.ctx) { S.view.ctx.project = proj; renderHeader(); }
      const convos = res.conversations || [];
      page.appendChild(el("span", { class: "agy-lbl", text: (proj || "PROJECT").toUpperCase() + " — PAST CONVERSATIONS · " + convos.length }));
      if (!convos.length) { page.appendChild(el("div", { class: "agy-empty-dash", text: "No recorded conversations for this project." })); return; }
      const histRow = (c) => el("div", {
        class: "agy-chatrow",
        onclick: () => openConvo({ conversationId: c.conversationId, title: c.title, project: proj, shortWorkspace: res.shortWorkspace, workspace: ctx.workspace, historical: true }),
      }, [
        el("span", { class: "mid" }, [el("span", { class: "t", text: c.title || "(untitled)" })]),
        c.backfilled ? el("span", { class: "agy-srctag", text: "RECOVERED", title: "recovered from brain/ — agy never wrote this conversation to its /resume index" }) : null,
        c.source === "ide" ? el("span", { class: "agy-srctag", text: "IDE" }) : null,
        el("span", { class: "cost", text: c.costUsd != null ? fmtCost(c.costUsd) : "" }),
        el("span", { class: "steps", text: c.numSteps != null ? c.numSteps + " st" : "" }),
        el("span", { class: "ago", text: c.updatedAt ? tsAgoShort(Date.parse(c.updatedAt)) : "" }),
      ]);
      // A helper that runs inside this repo floods its History tab too — same fold
      // as All chats, and the count in the label above stays the true total.
      const { plain, noise } = splitNoise(convos);
      if (plain.length) {
        const list = el("div", { class: "agy-cardlist" });
        for (const c of plain) list.appendChild(histRow(c));
        page.appendChild(list);
      }
      for (const g of noise) page.appendChild(noiseSection(g, histRow, false, "hist"));
    })();
  }

  // -- new chat --
  function mountNewChat(ctx) {
    viewTick = null;
    clear(viewEl); clear(compHost);
    const page = el("div", { class: "agy-newchat" });
    viewEl.appendChild(page);
    page.appendChild(el("h2", { text: "New chat" }));

    // An unsent draft (workspace + first message) survives navigating away and
    // reloads, like the conversation composer. An explicit ctx (a bounce-back
    // from a failed start, or a ?new= URL) wins over the stored draft.
    const NC_DRAFT_KEY = "agy-newchat-draft";
    let draft = {};
    try { draft = JSON.parse(localStorage.getItem(NC_DRAFT_KEY) || "{}") || {}; } catch {}
    const saveDraft = () => {
      try {
        const d = { workspace: wsInput.value, message: ta.value };
        if ((d.workspace || "").trim() || (d.message || "").trim()) localStorage.setItem(NC_DRAFT_KEY, JSON.stringify(d));
        else localStorage.removeItem(NC_DRAFT_KEY);
      } catch {}
    };
    const clearDraft = () => { try { localStorage.removeItem(NC_DRAFT_KEY); } catch {} };

    let allWorkspaces = [];
    const wsInput = el("input", { class: "agy-ws-input", type: "text", placeholder: "type a folder path, or pick a recent workspace…", value: ctx.workspace || draft.workspace || "" });
    const wsMenu = el("div", { class: "agy-ws-menu", style: { display: "none" } });
    // Keyboard-navigable combobox: ↑/↓ move the selection, Enter takes it, Esc closes.
    // `wsSel` is an index into `wsShown` (what's actually on screen right now), and -1
    // means "nothing selected — Enter should accept whatever I typed".
    let wsShown = [], wsSel = -1;
    function paintSel() {
      const opts = wsMenu.children;
      for (let i = 0; i < opts.length; i++) opts[i].classList.toggle("sel", i === wsSel);
      if (wsSel >= 0 && opts[wsSel] && opts[wsSel].scrollIntoView) opts[wsSel].scrollIntoView({ block: "nearest" });
    }
    function pickWs(w) {
      wsInput.value = w.workspace;
      wsMenu.style.display = "none"; wsSel = -1;
      saveDraft(); ta.focus();
    }
    function renderMenu() {
      const q = (wsInput.value || "").trim().toLowerCase();
      wsShown = allWorkspaces.filter((w) => !q || w.workspace.toLowerCase().includes(q) || (w.project || "").toLowerCase().includes(q)).slice(0, 14);
      clear(wsMenu);
      if (!wsShown.length) { wsMenu.style.display = "none"; wsSel = -1; return; }
      // Typing re-filters, so an index into the old list is meaningless — start over.
      if (wsSel >= wsShown.length) wsSel = wsShown.length - 1;
      for (const w of wsShown) {
        wsMenu.appendChild(el("div", { class: "agy-ws-opt", onmousedown: (e) => { e.preventDefault(); pickWs(w); } }, [
          el("span", { class: "n", text: w.project || w.shortWorkspace }),
          el("span", { class: "p", text: w.shortWorkspace }),
        ]));
      }
      wsMenu.style.display = "";
      paintSel();
    }
    wsInput.addEventListener("focus", renderMenu);
    wsInput.addEventListener("input", () => { wsSel = -1; renderMenu(); });
    wsInput.addEventListener("input", saveDraft);
    wsInput.addEventListener("blur", () => setTimeout(() => { wsMenu.style.display = "none"; wsSel = -1; }, 150));
    wsInput.addEventListener("keydown", (e) => {
      const open = wsMenu.style.display !== "none" && wsShown.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Only swallow the key once we know there is a list to move through — otherwise
        // ↑/↓ must keep their native caret-to-start / caret-to-end behaviour, which is
        // how you edit a long absolute path.
        if (!open) { renderMenu(); if (!wsShown.length) return; }
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        // Wrap, counting -1 (the typed text) as a stop so you can always get back to it.
        wsSel = wsSel + step;
        if (wsSel >= wsShown.length) wsSel = -1;
        else if (wsSel < -1) wsSel = wsShown.length - 1;
        paintSel();
        return;
      }
      if (e.key === "Enter") {
        if (open && wsSel >= 0) { e.preventDefault(); pickWs(wsShown[wsSel]); return; }
        // Nothing highlighted: keep the typed path and move on to the message box.
        e.preventDefault(); wsMenu.style.display = "none"; ta.focus();
        return;
      }
      if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); wsMenu.style.display = "none"; wsSel = -1; }
    });
    page.appendChild(el("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, [
      el("span", { class: "agy-field-label", text: "WORKSPACE" }),
      el("div", { class: "agy-ws-wrap" }, [wsInput, wsMenu]),
    ]));

    const ta = el("textarea", { class: "agy-nc-ta", rows: "5", placeholder: "Your first message — agy starts a fresh conversation in this folder…" });
    ta.addEventListener("input", saveDraft);
    page.appendChild(ta);

    // ---- options card: LAUNCH / MODEL / PERMISSIONS / SAFETY ----
    // NC persists across mounts so the form remembers your last choices.
    const nc = S.newChat || (S.newChat = { mode: "single", n: 3, model: null, perm: "default", gated: true, review: false });
    // arriving from a fan-out launcher (header ⑃ removed; slash /fanout + ⌘K route here):
    // prefill the task and, unless a fan strategy is already remembered, preset best-of-N.
    ta.value = ctx.message || draft.message || "";
    if (ctx.fanout && nc.mode === "single") nc.mode = "best";
    if (ta.value || ctx.fanout) setTimeout(() => ta.focus(), 0);
    let models = []; // from `agy models` (null model = agy's configured default)
    const optsCard = el("div", { class: "agy-nc-card" });
    function chip(label, on, pick, title, cls) {
      return el("span", { class: "agy-ncchip" + (on ? " on" : "") + (cls ? " " + cls : ""), text: label, title, onclick: pick });
    }
    function drawOpts() {
      clear(optsCard);
      const launchRow = el("div", { class: "row" }, [
        el("span", { class: "lbl", text: "LAUNCH" }),
        chip("single session", nc.mode === "single", () => { nc.mode = "single"; drawOpts(); }, "one agy session in the workspace folder itself — no worktree, no judge"),
        chip("⑃ best-of-N", nc.mode === "best", () => { nc.mode = "best"; drawOpts(); }, "N workers attack the task, Opus ranks the diffs"),
        chip("⑃ decompose", nc.mode === "decompose", () => { nc.mode = "decompose"; drawOpts(); }, "split into subtasks, one worker each, merge in order"),
      ]);
      if (nc.mode !== "single") {
        launchRow.appendChild(el("span", { class: "lbl in", text: "WORKERS" }));
        for (const n of [2, 3, 4]) launchRow.appendChild(chip(String(n), nc.n === n, () => { nc.n = n; drawOpts(); }));
      }
      optsCard.appendChild(launchRow);
      const modelRow = el("div", { class: "row" }, [el("span", { class: "lbl", text: "MODEL" })]);
      modelRow.appendChild(chip("default", nc.model == null, () => { nc.model = null; drawOpts(); }, "agy's configured model"));
      for (const m of models) modelRow.appendChild(chip(m, nc.model === m, () => { nc.model = m; drawOpts(); }));
      if (nc.mode === "single") {
        modelRow.appendChild(el("span", { class: "lbl in", text: "PERMISSIONS" }));
        modelRow.appendChild(chip("default", nc.perm === "default", () => { nc.perm = "default"; drawOpts(); }, "agy asks before edits"));
        modelRow.appendChild(chip("auto-edit", nc.perm === "auto-edit", () => { nc.perm = "auto-edit"; drawOpts(); }, "--mode accept-edits: file edits don't ask"));
      }
      optsCard.appendChild(modelRow);
      if (nc.mode === "single") {
        optsCard.appendChild(el("div", { class: "row" }, [
          el("span", { class: "lbl", text: "SAFETY" }),
          chip("⛨ gate commands · " + (nc.gated ? "ON" : "off"), nc.gated, () => { nc.gated = !nc.gated; drawOpts(); },
            "route run_command through the approval gate (AGY_MONITOR_GATED=1)", "green"),
          chip("⚖ opus review on finish · " + (nc.review ? "ON" : "off"), nc.review, () => { nc.review = !nc.review; drawOpts(); },
            "run a one-shot Opus review automatically when the session finishes", "amber"),
        ]));
      }
      status.textContent = nc.mode === "single"
        ? "typical session ≈ $0.10–0.60 list-price" + (nc.review ? " + opus review ~$0.30" : "")
        : nc.n + " agy workers in isolated worktrees + one opus judge call";
      startBtn.textContent = nc.mode === "single" ? "Start chat" : "⑃ Launch " + nc.n + " workers";
    }
    page.appendChild(optsCard);

    const status = el("span", { class: "agy-nc-est", text: "" });
    async function start() {
      const workspace = (wsInput.value || "").trim(), message = ta.value.trim();
      if (!workspace) { status.textContent = "enter a workspace"; return; }
      if (!message) { status.textContent = "enter a message"; return; }
      if (nc.mode !== "single") {
        status.textContent = "launching workers…";
        try {
          const res = await runTool(tool.id, { action: "fanout-start", workspace, task: message, strategy: nc.mode, n: nc.n });
          if (res && res.ok) {
            if (shell) shell.toast("⑃ " + nc.n + " workers launched in isolated worktrees");
            clearDraft();
            tick();
            go({ kind: "fanout", id: res.id });
            return;
          }
          status.textContent = (res && res.message) || "failed to launch";
        } catch (e) { status.textContent = "error: " + (e && e.message ? e.message : e); }
        return;
      }
      // Jump straight into the conversation with a "starting agy…" placeholder,
      // then resolve the real id in the background. The pendingId lets us tell
      // whether the user is still on THIS placeholder when the request returns.
      const project = workspace.split("/").pop();
      const pendingId = "p" + Date.now() + Math.random().toString(36).slice(2);
      go({ kind: "convo", ctx: { workspace, project, shortWorkspace: workspace, title: "Starting…", pendingStart: true, pendingMessage: message, pendingId } });
      const stillPending = () => S.view.kind === "convo" && S.view.ctx && S.view.ctx.pendingId === pendingId;
      const bounceToForm = (why) => {
        if (shell && why) shell.toast(why);
        if (!stillPending()) return;
        render({ kind: "newchat", ctx: { workspace, message } }); // re-mount the form, message + options preserved
        const st = { kind: "newchat", ctx: { workspace } };
        history.replaceState(Object.assign({ navDepth: S.navDepth, pos: S.curPos }, st), "", urlFor(st));
      };
      try {
        const res = await runTool(tool.id, {
          action: "new-conversation", workspace, message,
          model: nc.model || undefined,
          mode: nc.perm === "auto-edit" ? "auto-edit" : undefined,
          gated: nc.gated,
          reviewOnFinish: nc.review || undefined,
        });
        if (res && res.ok && res.conversationId) {
          if (shell) shell.toast(nc.gated ? "▸ Started gated — commands route through the approval gate" : "▸ Started ungated");
          clearDraft(); // it started — the draft is no longer "unsent"
          const ctx = { conversationId: res.conversationId, workspace: res.workspace, project: (res.workspace || workspace).split("/").pop(), shortWorkspace: res.workspace };
          if (stillPending()) {
            history.replaceState(Object.assign({ navDepth: S.navDepth, pos: S.curPos }, { kind: "convo", ctx }), "", urlFor({ kind: "convo", ctx }));
            render({ kind: "convo", ctx }); // upgrade the placeholder to the live conversation in place
          }
          return;
        }
        if (res && res.ok) { // started but no id within the window — it's registering; don't offer a re-submit
          clearDraft();
          bounceToForm("▸ Started — it's taking a moment to register; find it in History shortly");
          return;
        }
        // an outright failure — bounce back with the draft intact so nothing is lost
        bounceToForm("Couldn't start — " + ((res && res.message) || "failed to start"));
      } catch (e) { bounceToForm("Error: " + (e && e.message ? e.message : e)); }
    }
    const startBtn = el("button", { class: "agy-btn", text: "Start chat", onclick: () => start() });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); } });
    page.appendChild(el("div", { class: "agy-nc-bar" }, [
      status,
      el("span", { class: "agy-nc-right" }, [
        el("span", { class: "agy-hint", text: "⌘↵ TO START" }),
        startBtn,
      ]),
    ]));
    drawOpts();
    (async () => {
      try {
        const res = await runTool(tool.id, { action: "list-workspaces" });
        allWorkspaces = (res && res.ok && res.workspaces) || [];
        if (!wsInput.value && allWorkspaces[0]) wsInput.value = allWorkspaces[0].workspace;
      } catch {}
      try {
        const mr = await runTool(tool.id, { action: "list-models" });
        if (mr && mr.ok && (mr.models || []).length) { models = mr.models; drawOpts(); }
      } catch {}
    })();
  }

  // -- external agent transcript (read-only Codex / Copilot) --
  function mountExternal(id) {
    viewTick = null;
    clear(viewEl); clear(compHost);
    const openFile = (p, label) => go({ kind: "file", path: p, label });
    const feed = el("div", { class: "agy-feed" });
    viewEl.appendChild(feed);
    (async () => {
      let res;
      try { res = await runTool(tool.id, { action: "get-external", id }); } catch { return; }
      if (S.view.kind !== "external" || S.view.id !== id) return; // superseded
      if (!res || !res.ok) { feed.appendChild(el("div", { class: "agy-empty-dash", text: (res && res.message) || "couldn't read that session" })); return; }
      const msgs = res.messages || [];
      // header: real project, and the agent's own title for the session when it has
      // one (Claude Code records an ai-title) — otherwise the opening message
      const firstUser = msgs.find((m) => m.role === "user");
      S.view.extProject = res.project || null;
      S.view.extTitle = res.title
        ? String(res.title).replace(/\s+/g, " ").slice(0, 80)
        : firstUser ? firstUser.text.replace(/\s+/g, " ").slice(0, 80) : null;
      renderHeader();
      // Long transcripts are read from the END (see tailText), so say so rather than
      // let a session that opens mid-sentence look like the whole conversation.
      if (res.truncated) {
        feed.appendChild(el("div", { class: "agy-ext-trunc" }, [
          el("span", { class: "g", text: "⋯" }),
          el("span", { text: "This session is too large to show in full — earlier messages are omitted. You're seeing the most recent part." }),
        ]));
      }
      if (!msgs.length) feed.appendChild(el("div", { class: "agy-ws-empty", text: "No messages in this session." }));
      msgs.forEach((m, i) => feed.appendChild(messageEl(m, i, { openFile, roleLabel: res.agent })));

      // read-only bar in place of the composer: fork-to-agy takes the work over locally
      const forkBtn = el("span", { class: "agy-extbar-fork", text: "⑂ fork to agy", title: "copy this transcript into a new agy conversation", onclick: async () => {
        forkBtn.classList.add("busy");
        if (shell) shell.toast("⑂ importing " + res.agent + " transcript into agy…");
        let out;
        try { out = await runTool(tool.id, { action: "fork-external", id }); }
        catch (e) { out = { ok: false, message: String((e && e.message) || e) }; }
        forkBtn.classList.remove("busy");
        if (!out || !out.ok) { if (shell) shell.toast((out && out.message) || "takeover failed"); return; }
        if (out.conversationId) {
          if (shell) shell.toast("⑂ it's an agy conversation now");
          openConvo({ conversationId: out.conversationId, workspace: out.workspace, project: (out.workspace || "").split("/").pop(), shortWorkspace: out.workspace });
        } else if (shell) shell.toast(out.message || "⑂ takeover started — check history shortly");
        tick();
      } });
      compHost.appendChild(el("div", { class: "agy-extbar" }, [
        el("span", { class: "tag", text: res.agent + " · READ-ONLY" }),
        el("span", { class: "t", text: "imported from " + (res.src || "?") + " — continue it in its own tool, or take it over locally" }),
        forkBtn,
      ]));
    })();
  }

  // -- file view --
  function mountFile(rawPath, label) {
    viewTick = null;
    clear(viewEl); clear(compHost);
    const view = el("pre", { class: "agy-fileview", text: "loading…" });
    viewEl.appendChild(view);
    (async () => {
      let res;
      try { res = await runTool(tool.id, { action: "get-file", path: rawPath }); }
      catch (e) { view.textContent = "error: " + (e && e.message ? e.message : e); return; }
      if (!res || !res.ok) { view.textContent = (res && res.message) || "cannot open"; return; }
      if (res.binary) { view.textContent = "(binary file — " + (res.size || 0) + " bytes)"; return; }
      view.textContent = (res.content || "") + (res.truncated ? "\n\n… (truncated)" : "");
    })();
  }

  // ---------- command palette ----------
  let palEl = null;
  let palDrawList = null; // set while the palette is mounted — refreshes results only
  const _palChats = { list: [], at: 0 };
  function ensurePalChats() {
    if (Date.now() - _palChats.at < 30000) return;
    runTool(tool.id, { action: "list-all-conversations" }).then((r) => {
      // refresh only the RESULT LIST — replacing the input mid-typing scrambles the caret
      if (r && r.ok) {
        // one representative per folded cluster: 200 commit-helper runs would
        // otherwise BE the palette, before the slice ever reaches a real chat
        const seenGroup = new Set();
        _palChats.list = (r.conversations || []).filter((c) => {
          if (!c.groupKey) return true;
          if (seenGroup.has(c.groupKey)) return false;
          seenGroup.add(c.groupKey);
          return true;
        }).slice(0, 20);
        _palChats.at = Date.now();
        if (S.palOpen && palDrawList) palDrawList();
      }
    }).catch(() => {});
  }
  function openPalette(pick) {
    S.palOpen = true; S.palPick = !!pick; S.palQuery = ""; S.palIdx = 0;
    ensurePalChats();
    renderPalette();
  }
  function closePalette() {
    S.palOpen = false;
    palDrawList = null;
    if (palEl) { try { root.removeChild(palEl); } catch {} palEl = null; }
  }
  function palItems() {
    const q = S.palQuery.toLowerCase();
    const items = [];
    const pick = S.palPick;
    for (const s of D.sessions) {
      if (!s.conversationId) continue;
      const meta = stateMeta(s);
      items.push({
        label: s.title || s.prompt || "(untitled)", sub: s.project || "", kind: pick ? "add pane" : "session", dotCls: meta.cls,
        go: () => { closePalette(); pick ? addPane(s.conversationId) : openConvo(sessCtx(s)); },
      });
    }
    if (pick) return q ? items.filter((i) => (i.label + " " + i.sub).toLowerCase().includes(q)) : items;
    if (S.view.kind === "convo" || S.view.kind === "split") {
      items.push({ label: "Add a conversation to split view", sub: "side-by-side panes · or ⌘click any session", kind: "action", accent: true, go: () => { closePalette(); openPalette(true); } });
    }
    const liveCids = new Set(D.sessions.map((s) => s.conversationId).filter(Boolean));
    for (const c of _palChats.list) {
      if (liveCids.has(c.conversationId)) continue;
      items.push({
        label: c.title || "(untitled)", sub: (c.project || "") + (c.updatedAt ? " · " + tsAgoShort(Date.parse(c.updatedAt)) + " ago" : ""), kind: "chat",
        go: () => { closePalette(); openConvo({ conversationId: c.conversationId, title: c.title, project: c.project, shortWorkspace: c.shortWorkspace, workspace: c.workspace, historical: true }); },
      });
    }
    for (const x of D.externals) {
      items.push({
        label: x.title || "(untitled)", sub: (x.project || "") + " · read-only", kind: x.agent.toLowerCase(),
        go: () => { closePalette(); go({ kind: "external", id: x.id }); },
      });
    }
    items.push({ label: "Overview", sub: "sessions dashboard", kind: "view", go: () => { closePalette(); navTop({ kind: "overview" }); } });
    items.push({ label: "All chats", sub: "search every conversation", kind: "view", go: () => { closePalette(); navTop({ kind: "allchats" }); } });
    items.push({ label: "Safelist review", sub: "gate learning loop", kind: "view", go: () => { closePalette(); navTop({ kind: "safelist" }); } });
    items.push({ label: "Setup", sub: "environment checks · doctor", kind: "view", go: () => { closePalette(); navTop({ kind: "setup" }); } });
    items.push({ label: "New chat", sub: "start a fresh conversation", kind: "action", accent: true, go: () => { closePalette(); navTop({ kind: "newchat", ctx: {} }) } });
    items.push({ label: "⑃ Fan out a task", sub: "N parallel workers + Opus judge · opens New chat", kind: "action", accent: true, go: () => { closePalette(); goFanout(lastUserText()); } });
    if (hasWorkspace()) items.push({ label: "Review changes with Opus", sub: "one-shot static review · no agentic loop", kind: "action", accent: true, go: () => { closePalette(); runReviewNow(); } });
    items.push({ label: "Toggle workspace panel", sub: "diffs · ]", kind: "action", accent: true, go: () => { closePalette(); toggleRight(); } });
    items.push({ label: "Toggle sidebar", sub: "collapse the session list · [", kind: "action", accent: true, go: () => { closePalette(); toggleLeft(); } });
    if (D.approvals.length) {
      const a = D.approvals[0];
      items.push({ label: "Approve pending command", sub: "$ " + (a.command || "").slice(0, 60), kind: "action", dotCls: "waiting", go: () => { closePalette(); answerApproval(a, "allow"); } });
    }
    if (shell && shell.improveEnabled) {
      items.push({ label: "✦ Improve this app", sub: "ask agy-monitor to change itself", kind: "action", accent: true, go: () => {
        closePalette();
        const req = prompt("What should agy-monitor improve about itself?");
        if (req && shell.improve) shell.improve(req);
      } });
    }
    return q ? items.filter((i) => (i.label + " " + i.sub).toLowerCase().includes(q)) : items;
  }
  // The scrim + input mount ONCE per open; only the result list re-renders on
  // input. (Recreating the input each keystroke reset the caret to position 0,
  // which typed text backwards.)
  function renderPalette() {
    if (palEl) { try { root.removeChild(palEl); } catch {} palEl = null; }
    if (!S.palOpen) return;
    let items = [];
    const list = el("div", { class: "agy-pal-list" });
    function drawList() {
      items = palItems();
      if (S.palIdx >= items.length) S.palIdx = Math.max(0, items.length - 1);
      clear(list);
      if (!items.length) { list.appendChild(el("div", { class: "agy-pal-empty", text: "No matches." })); return; }
      items.forEach((it, i) => list.appendChild(el("div", {
        class: "agy-pal-row" + (i === S.palIdx ? " sel" : ""),
        onclick: () => it.go(),
      }, [
        el("span", { class: "agy-dot " + (it.dotCls || (it.accent ? "busy" : "done")) + " nopulse", style: it.dotCls ? undefined : { animation: "none" } }),
        el("span", { class: "mid" }, [
          el("span", { class: "t", text: it.label }),
          el("span", { class: "s", text: it.sub }),
        ]),
        el("span", { class: "k", text: it.kind }),
      ])));
      const sel = list.children[S.palIdx];
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    }
    const input = el("input", {
      class: "agy-pal-input", type: "text", value: S.palQuery,
      placeholder: S.palPick ? "Add a session to the split…" : "Jump to session, project, or action…",
      oninput: (e) => { S.palQuery = e.target.value; S.palIdx = 0; drawList(); },
      onkeydown: (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); S.palIdx = Math.min(S.palIdx + 1, items.length - 1); drawList(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); S.palIdx = Math.max(S.palIdx - 1, 0); drawList(); }
        else if (e.key === "Enter") { e.preventDefault(); const r = items[S.palIdx]; if (r) r.go(); }
        else if (e.key === "Escape") { e.stopPropagation(); closePalette(); }
      },
    });
    palEl = el("div", { class: "agy-pal-scrim", onclick: closePalette }, [
      el("div", { class: "agy-pal", onclick: (e) => e.stopPropagation() }, [
        el("div", { class: "agy-pal-top" }, [
          el("span", { class: "gt", text: "›" }),
          input,
          el("span", { class: "agy-kbd", text: "ESC" }),
        ]),
        list,
        el("div", { class: "agy-pal-foot" }, [
          el("span", { text: "↑↓ NAVIGATE" }), el("span", { text: "↵ OPEN" }), el("span", { text: "ESC CLOSE" }),
        ]),
      ]),
    ]);
    palDrawList = drawList;
    drawList();
    root.appendChild(palEl);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  // ---------- keyboard ----------
  function onKeydown(e) {
    const tag = (e.target && e.target.tagName) || "";
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (S.palOpen) closePalette(); else openPalette(false); return; }
    // ⌘[ / ⌘] — back/forward through the nav stack (preventDefault so it never
    // double-fires with a PWA/browser window's own ⌘[ handling). Works while typing.
    if ((e.metaKey || e.ctrlKey) && e.key === "[") { e.preventDefault(); history.back(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === "]") { e.preventDefault(); history.forward(); return; }
    if (e.key === "Escape") {
      if (S.palOpen) { closePalette(); return; }
      if (lightboxEl) { closeLightbox(); return; }
      if (BTW.open) { closeBtw(); return; }
      if (typing) { e.target.blur(); return; }
      if (S.navDepth > 0) { history.back(); return; }
      if (S.view.kind !== "overview") { navTop({ kind: "overview" }); }
      return;
    }
    if (S.palOpen || typing) return;
    if (e.key === "[") { toggleLeft(); return; }
    if (e.key === "]") { if (hasWorkspace()) toggleRight(); return; }
    if (e.key === "j" || e.key === "k") {
      const n = D.sessions.length;
      if (!n) return;
      let i = S.focusIdx;
      i = e.key === "j" ? Math.min(i + 1, n - 1) : Math.max(i - 1, 0);
      if (i < 0) i = 0;
      S.focusIdx = i;
      renderSide();
      return;
    }
    if (e.key === "Enter" && S.focusIdx >= 0) { const s = D.sessions[S.focusIdx]; if (s && s.conversationId) openConvo(sessCtx(s)); return; }
    if (e.key === "s" && S.focusIdx >= 0) { const s = D.sessions[S.focusIdx]; if (s && s.conversationId) addPane(s.conversationId); return; }
    if (e.key === "a" && D.approvals.length) { answerApproval(D.approvals[0], "allow"); return; }
    if (e.key === "d" && D.approvals.length) { answerApproval(D.approvals[0], "deny"); return; }
    if (e.key === "n" || e.key === "4") { navTop({ kind: "newchat", ctx: {} }); return; }
    if (e.key === "1") navTop({ kind: "overview" });
    if (e.key === "2") navTop({ kind: "allchats" });
    if (e.key === "3") navTop({ kind: "safelist" });
  }
  document.addEventListener("keydown", onKeydown);
  const onResize = () => { reconcilePanels(); applyPanels(); };
  window.addEventListener("resize", onResize);

  // ---------- navigation (History API, query-string state) ----------
  function urlFor(view) {
    const p = new URLSearchParams();
    switch (view.kind) {
      case "convo":   p.set("convo", (view.ctx && view.ctx.conversationId) || ""); break;
      case "split":   p.set("split", S.panes.join(",")); break;
      case "fanout":  p.set("fanout", view.id || ""); break;
      case "history": p.set("history", (view.ctx && view.ctx.workspace) || ""); break;
      case "context": p.set("context", (view.ctx && view.ctx.workspace) || ""); break;
      case "newchat": p.set("new", (view.ctx && view.ctx.workspace) || ""); break;
      case "external": p.set("ext", view.id || ""); break;
      case "allchats": p.set("all", "1"); break;
      case "safelist": p.set("safelist", "1"); break;
      case "setup":   p.set("setup", "1"); break;
      case "file":    p.set("file", view.path || ""); break;
      default: break; // overview: no params
    }
    const qs = p.toString();
    return location.pathname + (qs ? "?" + qs : "") + location.hash; // preserve the host's hash
  }
  function viewFromUrl() {
    const p = new URLSearchParams(location.search);
    if (p.has("convo")) return { kind: "convo", ctx: { conversationId: p.get("convo") } };
    if (p.has("split")) { const panes = (p.get("split") || "").split(",").filter(Boolean); if (panes.length) return { kind: "split", panes }; }
    if (p.has("fanout")) return { kind: "fanout", id: p.get("fanout") };
    if (p.has("history")) return { kind: "history", ctx: { workspace: p.get("history") } };
    if (p.has("context")) return { kind: "context", ctx: { workspace: p.get("context") } };
    if (p.has("new")) return { kind: "newchat", ctx: { workspace: p.get("new") } };
    if (p.has("ext")) return { kind: "external", id: p.get("ext") };
    if (p.has("all")) return { kind: "allchats" };
    if (p.has("safelist")) return { kind: "safelist" };
    if (p.has("setup")) return { kind: "setup" };
    if (p.has("file")) { const v = p.get("file") || ""; return { kind: "file", path: v, label: v.split("/").pop() }; }
    return null;
  }

  function render(view) {
    S.view = view || { kind: "overview" };
    S.overviewRefresh = null;
    S.setupRefresh = null;
    S.approvalRefresh = null; // convo/split views set this so answerApproval can redraw them instantly
    viewTick = null;
    if (S.view.kind === "split") {
      if (Array.isArray(S.view.panes) && S.view.panes.length) S.panes = S.view.panes.slice();
      if (!S.panes.length) S.view = { kind: "overview" };
    }
    viewEl.classList.toggle("split", S.view.kind === "split");
    reconcilePanels();
    renderSide(); renderHeader(); renderPanel(); renderBanner();
    switch (S.view.kind) {
      case "convo":   return mountConvo(S.view.ctx || {});
      case "split":   return mountSplit();
      case "fanout":  return mountFanout(S.view.id);
      case "history": return mountHistory(S.view.ctx || {});
      case "context": return mountContext(S.view.ctx || {});
      case "newchat": return mountNewChat(S.view.ctx || {});
      case "external": return mountExternal(S.view.id);
      case "allchats": return mountAllChats();
      case "safelist": return mountSafelist();
      case "setup":   return mountSetup();
      case "file":    return mountFile(S.view.path, S.view.label);
      default:        return mountOverview();
    }
  }

  // A push (go/navTop) starts a fresh forward branch: the current position advances
  // and becomes the furthest-forward entry (any forward history the browser had is gone).
  function go(view) {
    S.navDepth++;
    S.curPos = S.maxPos = S.curPos + 1;
    history.pushState(Object.assign({ navDepth: S.navDepth, pos: S.curPos }, view), "", urlFor(view));
    render(view);
  }
  function navTop(view) {
    S.navDepth = 0;
    S.curPos = S.maxPos = S.curPos + 1;
    history.pushState(Object.assign({ navDepth: 0, pos: S.curPos }, view), "", urlFor(view));
    render(view);
  }
  window.addEventListener("popstate", (ev) => {
    const st = ev.state && ev.state.kind ? ev.state : (viewFromUrl() || { kind: "overview" });
    S.navDepth = (ev.state && typeof ev.state.navDepth === "number") ? ev.state.navDepth : 0;
    S.curPos = (ev.state && typeof ev.state.pos === "number") ? ev.state.pos : 0; // maxPos stays: forward is still reachable
    render(st);
  });

  // ---------- boot ----------
  const initial = (history.state && history.state.kind) ? history.state : (viewFromUrl() || { kind: "overview" });
  S.navDepth = (history.state && typeof history.state.navDepth === "number") ? history.state.navDepth : (initial.kind === "overview" ? 0 : 1);
  S.curPos = S.maxPos = (history.state && typeof history.state.pos === "number") ? history.state.pos : 0;
  render(initial);
  refreshCore();
  runTool(tool.id, { action: "list-commands" }).then((r) => { if (r && r.ok) D.commands = r.commands || []; }).catch(() => {});
  startLoop();
  return [root];
}

/* Standalone wiring — on a hub host just add 'agy-monitor': renderAgyMonitor
   to the existing RENDERERS object. */
if (typeof window !== "undefined") {
  window.RENDERERS = window.RENDERERS || {};
  window.RENDERERS["agy-monitor"] = renderAgyMonitor;
}
