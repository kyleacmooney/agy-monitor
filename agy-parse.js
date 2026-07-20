#!/usr/bin/env node
"use strict";
/*
 * agy-parse — a fail-closed, dependency-free static analyzer for shell command lines.
 *
 * It does NOT interpret or execute. It only recognizes structure and REFUSES ON DOUBT.
 * The single public function:
 *
 *     analyze(cmd) -> { ok:true,  subcommands:[ Sub, ... ] }
 *                  |  { ok:false, reason:<string>, at:<index?> }
 *
 *   Sub = {
 *     binary,   // basename of the real command head, e.g. "rm" (from "/bin/rm", "command rm")
 *     atom,     // binary + leading plain subcommand verbs, e.g. "git diff", "npm run test"
 *     words,    // operand token VALUES after wrappers/env-assigns are removed
 *     flags: {
 *       envAssign:    [{name, value}],  // leading NAME=val assignments (recorded, never ignored)
 *       envRunner:    bool,   // head executes its args (npx, docker run/exec, sudo, command/exec/env, sh -c, ssh host cmd)
 *       interpreter:  bool,   // head is a shell/script interpreter (sh bash zsh dash python* node ruby perl php)
 *       codeExecutor: bool,   // carries inline code/program (-e/-c/-i, awk/sed program, python file, osascript)
 *       findAction:   bool,   // find with an action primary (-exec/-delete/-fprintf/...) or unknown -exec / -f primaries
 *       hasGlob:      bool,   // unquoted glob metacharacter present (informational)
 *       pipeStage:    number, // 0 = first stage; >0 = a downstream `|` pipe stage
 *       redirects:    [{fd, op, target}],  // ALL already validated against the safe whitelist
 *     },
 *   }
 *
 * Design rules (the safety contract):
 *  - Quote-aware tokenizer (NORMAL/SINGLE/DOUBLE). Operators are recognized ONLY in NORMAL,
 *    so `&&` inside quotes is literal data, never a separator.
 *  - ANY command/parameter/arithmetic/process substitution ($(, `, ${, $var, <(, >() → fail closed.
 *  - ALL redirection fails closed EXCEPT the explicit safe whitelist: 2>&1 / 1>&2 / N>&M fd-dups
 *    and >/dev/null, 2>/dev/null, >>/dev/null, &>/dev/null (target is exactly the null device).
 *  - Unbalanced quotes, dangling escapes, grouping ( ) { }, shell keywords, comments, here-docs,
 *    control/NUL chars, an obfuscated (quoted/escaped) command NAME, and resource-limit breaches
 *    all fail closed.
 *  - Any internal exception is caught → { ok:false, reason:"parser-exception" }: a parser bug
 *    degrades to "refuse to certify", never to a crash or a false certification.
 *
 * This module is the SHARED source of truth: agy-gate.js requires it for the gate's hard-deny +
 * compound-aware safelist, and the M4 safelist promoter requires the SAME analyze() so what gets
 * promoted and what gets auto-allowed can never drift apart. Policy tables (which atoms are
 * catastrophic vs defer-worthy) live with their consumers; this file reports only structure.
 */

const MAX_LEN = 4096;       // total command length
const MAX_TOKENS = 256;     // total word tokens across the whole command
const MAX_SUBCOMMANDS = 32; // sub-commands after splitting
const MAX_WORD_LEN = 1024;  // a single token

// Transparent wrappers: run their argument as a command. We unwrap to analyze the INNER command,
// failing closed if the argument shape doesn't match (so we never guess where the inner cmd starts).
const WRAPPERS = new Set(["time", "nohup", "timeout", "nice", "stdbuf"]);
// Prefixes that exec their argument and which we peel to reveal the real verb (and mark envRunner).
const EXEC_PREFIXES = new Set(["command", "builtin", "exec", "env"]);
// Heads that execute their arguments as a (sub)command — never transparent; never auto-allowable.
const ENV_RUNNER_HEADS = new Set(["npx", "watch", "setsid", "ionice", "flock", "sudo", "su", "doas", "pkexec", "ssh", "rsh"]);
// Shell / script interpreters: bare = reads stdin/file as code; with -c/-e = inline code.
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python2", "python3", "node", "deno", "bun", "ruby", "perl", "php"]);
// Text processors that can run code / write files when given a program or in-place flag.
const CODE_PROCESSORS = new Set(["awk", "gawk", "mawk", "nawk", "sed", "osascript"]);
// Multiplexer subcommand verbs: extend the atom but require a following concrete token.
const MULTIPLEX_VERBS = new Set(["run", "exec", "eval"]);
// find action primaries (write/exec/delete). Unknown -exec*/-f* also trip findAction (fail closed).
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprintf", "-fprint", "-fprint0", "-fls"]);
// Inline-code flags across the code processors / interpreters.
const CODE_FLAGS = new Set(["-e", "-c", "-i", "-f", "-r", "--eval", "--expression", "--in-place", "--file"]);

function basename(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

// Throw a structured fail-closed signal (caught by analyze()).
function fail(reason, at) {
  const e = new Error(reason);
  e.__failClosed = true;
  e.reason = reason;
  if (at != null) e.at = at;
  throw e;
}

function analyze(cmd) {
  try {
    return doAnalyze(cmd);
  } catch (e) {
    if (e && e.__failClosed) return e.at != null ? { ok: false, reason: e.reason, at: e.at } : { ok: false, reason: e.reason };
    return { ok: false, reason: "parser-exception" };
  }
}

function doAnalyze(cmd) {
  if (typeof cmd !== "string") fail("not-a-string");
  if (cmd.length === 0 || !cmd.trim()) fail("empty");
  if (cmd.length > MAX_LEN) fail("too-long");
  if (cmd.includes("�")) fail("non-utf8");
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd.charCodeAt(i);
    if (c === 0) fail("nul-byte", i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) fail("control-char", i);
  }

  // --- tokenize + split into sub-commands in a single pass ------------------
  const subcommands = [];      // [{ words:[WordObj], redirects:[], pipeStage }]
  let cur = { words: [], redirects: [], pipeStage: 0 };
  let nextPipeStage = 0;
  let totalTokens = 0;
  let lastConnector = false; // was the most recent separator a binary connector (&& || | |&)?

  // current word accumulator
  let w = "";            // resolved literal value
  let wStarted = false;  // any char (incl. an empty quote) seen for this word
  let wQuoted = false;   // any quote/escape used anywhere in this word (→ obfuscation check on binary)
  let wGlob = false;     // unquoted glob metachar present

  let state = 0; // 0 NORMAL, 1 SINGLE, 2 DOUBLE
  let i = 0;
  const n = cmd.length;

  function pushWord() {
    if (!wStarted) return;
    if (w.length > MAX_WORD_LEN) fail("word-too-long");
    cur.words.push({ v: w, quoted: wQuoted, glob: wGlob });
    if (++totalTokens > MAX_TOKENS) fail("too-many-tokens");
    w = ""; wStarted = false; wQuoted = false; wGlob = false;
  }
  function flushSub(isPipe, isConnector) {
    pushWord();
    if (cur.words.length === 0) fail("empty-subcommand", i);
    subcommands.push(cur);
    if (subcommands.length > MAX_SUBCOMMANDS) fail("too-many-subcommands");
    lastConnector = !!isConnector;
    nextPipeStage = isPipe ? cur.pipeStage + 1 : 0;
    cur = { words: [], redirects: [], pipeStage: nextPipeStage };
  }

  while (i < n) {
    const ch = cmd[i];

    if (state === 1) { // SINGLE quote: everything literal until the closing '
      if (ch === "'") { state = 0; i++; continue; }
      w += ch; wStarted = true; i++; continue;
    }
    if (state === 2) { // DOUBLE quote
      if (ch === '"') { state = 0; i++; continue; }
      if (ch === "$") fail("substitution-dollar", i);   // expansion inside "" still expands
      if (ch === "`") fail("substitution-backtick", i);
      if (ch === "\\") {
        if (i + 1 >= n) fail("dangling-escape", i);
        w += cmd[i + 1]; wStarted = true; wQuoted = true; i += 2; continue;
      }
      w += ch; wStarted = true; i++; continue;
    }

    // state === NORMAL
    if (ch === "\\") {
      if (i + 1 >= n) fail("dangling-escape", i);
      w += cmd[i + 1]; wStarted = true; wQuoted = true; i += 2; continue;
    }
    if (ch === "'") { state = 1; wStarted = true; wQuoted = true; i++; continue; }
    if (ch === '"') { state = 2; wStarted = true; wQuoted = true; i++; continue; }
    if (ch === "$") fail("substitution-dollar", i);
    if (ch === "`") fail("substitution-backtick", i);

    if (ch === " " || ch === "\t") { pushWord(); i++; continue; }
    if (ch === "\n" || ch === "\r") { pushWord(); flushSub(false, false); i++; continue; }

    if (ch === "#") {
      if (!wStarted) fail("comment", i); // # at a token boundary starts a comment
      w += ch; wStarted = true; i++; continue; // mid-word # is literal (e.g. issue#3)
    }

    if (ch === "(" || ch === ")" || ch === "{" || ch === "}") fail("grouping", i); // subshell/group/brace-expansion

    if (ch === "&") {
      if (cmd[i + 1] === "&") { pushWord(); flushSub(false, true); i += 2; continue; } // &&
      if (cmd[i + 1] === ">") { i = readRedirect(i, "&"); continue; }                 // &> / &>>
      pushWord(); flushSub(false, false); i++; continue;                              // & background (terminator)
    }
    if (ch === "|") {
      if (cmd[i + 1] === "|") { pushWord(); flushSub(false, true); i += 2; continue; } // ||
      if (cmd[i + 1] === "&") { pushWord(); flushSub(true, true); i += 2; continue; }  // |&
      pushWord(); flushSub(true, true); i++; continue;                                 // |
    }
    if (ch === ";") {
      if (cmd[i + 1] === ";" || cmd[i + 1] === "&") fail("case-terminator", i);  // ;; ;& ;;&
      pushWord(); flushSub(false, false); i++; continue;
    }
    if (ch === ">" || ch === "<") { i = readRedirect(i, null); continue; }

    if (ch === "*" || ch === "?") { wGlob = true; }
    // '[' ']' are glob/test characters, not grouping — allowed (informational glob)
    if (ch === "[" || ch === "]") { wGlob = true; }
    w += ch; wStarted = true; i++;
  }

  if (state !== 0) fail(state === 1 ? "unbalanced-single" : "unbalanced-double");
  pushWord();
  if (cur.words.length > 0) {
    subcommands.push(cur);
    if (subcommands.length > MAX_SUBCOMMANDS) fail("too-many-subcommands");
  } else if (subcommands.length === 0) {
    fail("empty-subcommand"); // nothing at all
  } else if (lastConnector) {
    fail("empty-subcommand"); // dangling binary connector (ls && , a | )
  } // else: trailing terminator (; & newline) — drop the empty tail

  // --- redirect reader (returns the new index) -----------------------------
  // Handles an output redirect starting at index `start`. `fdAmp` is "&" for the &> form.
  // Only the safe whitelist survives; anything else fails closed.
  function readRedirect(start, fdAmp) {
    let j = start;
    let fd = "";
    if (fdAmp === "&") { fd = "&"; j++; } // consume the '&', now at '>'
    else if (wStarted && /^[0-9]+$/.test(w)) { fd = w; w = ""; wStarted = false; } // digits before > = fd
    else { pushWord(); } // a preceding non-fd word ends here

    const opCh = cmd[j];
    if (opCh === "<") fail("input-redirect", j); // `< file`, `<<`, `<<<`, `<>` — never whitelisted
    // opCh === '>'
    let op = ">";
    if (cmd[j + 1] === ">") { op = ">>"; j += 2; }
    else if (cmd[j + 1] === "|") fail("clobber-redirect", j); // >|
    else j += 1;

    // skip spaces before the target
    while (cmd[j] === " " || cmd[j] === "\t") j++;

    // target: either &N (fd duplication) or a path token in a restricted charset
    let target = "";
    if (cmd[j] === "&") {
      target = "&";
      j++;
      while (j < n && /[0-9-]/.test(cmd[j])) { target += cmd[j]; j++; }
    } else {
      while (j < n && /[A-Za-z0-9._/+-]/.test(cmd[j])) { target += cmd[j]; j++; }
    }
    if (!target) fail("redirect-no-target", j);

    const safe =
      (/^&[0-9]+$/.test(target)) ||                          // 2>&1, 1>&2, N>&M
      ((op === ">" || op === ">>") && target === "/dev/null"); // >/dev/null, 2>/dev/null, &>/dev/null, >>/dev/null
    if (!safe) fail("unsafe-redirect:" + (fd || "") + op + target, start);

    cur.redirects.push({ fd: fd || "1", op, target });
    return j;
  }

  // --- per-sub-command structural analysis ---------------------------------
  const out = subcommands.map((s) => analyzeSub(s));
  return { ok: true, subcommands: out };
}

function analyzeSub(s) {
  const words = s.words.slice();

  // 1. leading env-assignments (recorded, NEVER ignored — they are RCE vectors)
  const envAssign = [];
  while (words.length) {
    const t = words[0];
    if (t.quoted) break; // a quoted leading token is not a clean assignment
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t.v);
    if (!m) break;
    envAssign.push({ name: m[1], value: m[2] });
    words.shift();
  }
  if (words.length === 0) {
    // pure assignment, no command → no atom → not auto-allowable (policy defers it)
    return { binary: "", atom: "", words: [], flags: blankFlags({ envAssign, pipeStage: s.pipeStage, redirects: s.redirects }) };
  }

  // 2. unwrap transparent wrappers and peel exec-prefixes (mark envRunner for the latter)
  let envRunner = false;
  let guard = 0;
  for (;;) {
    if (++guard > 8) fail("wrapper-too-deep");
    const head0 = words[0];
    if (head0.quoted) fail("obfuscated-binary"); // the command NAME must be a plain unquoted token
    const head = head0.v;
    const baseHead = basename(head);

    if (WRAPPERS.has(baseHead)) {
      const consumed = wrapperConsume(baseHead, words);
      words.splice(0, consumed); // drop wrapper + its own args; inner command remains
      if (words.length === 0) fail("wrapper-without-command");
      continue;
    }
    if (EXEC_PREFIXES.has(baseHead)) {
      envRunner = true;
      words.shift();
      // env / command / exec may carry their own leading flags and (for env) NAME=val
      while (words.length && (/^-/.test(words[0].v) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].v))) words.shift();
      if (words.length === 0) fail("exec-prefix-without-command");
      continue;
    }
    break;
  }

  // 3. the real binary
  const headWord = words[0];
  if (headWord.quoted) fail("obfuscated-binary");
  const head = headWord.v;
  if (!/^(~?\/)?[A-Za-z0-9._+/-]+$/.test(head)) fail("obfuscated-binary"); // outside the clean binary charset
  const binary = basename(head);
  const rest = words.slice(1);
  const restVals = rest.map((x) => x.v);

  // 4. structural flags
  const flags = blankFlags({ envAssign, pipeStage: s.pipeStage, redirects: s.redirects });
  flags.hasGlob = words.some((x) => x.glob);

  if (ENV_RUNNER_HEADS.has(binary)) envRunner = true;
  // bare-binary multiplexers that exec their args
  if ((binary === "docker" || binary === "podman") && (restVals[0] === "run" || restVals[0] === "exec")) envRunner = true;
  if ((binary === "devbox" || binary === "mise" || binary === "direnv") && (restVals[0] === "run" || restVals[0] === "exec")) envRunner = true;
  flags.envRunner = envRunner;

  if (INTERPRETERS.has(binary)) {
    flags.interpreter = true;
    if (restVals.some((v) => v === "-c" || v === "-e")) { flags.envRunner = true; flags.codeExecutor = true; }
    // `python file.py`, `node app.js`, `ruby x.rb` (any non-flag operand) = running code
    if (restVals.some((v) => !v.startsWith("-"))) flags.codeExecutor = true;
  }
  if (CODE_PROCESSORS.has(binary)) {
    if (binary === "osascript") flags.codeExecutor = true; // always runs AppleScript
    else if (rest.some((x) => CODE_FLAGS.has(x.v))) flags.codeExecutor = true;
    else if (rest.some((x) => !x.v.startsWith("-"))) flags.codeExecutor = true; // awk/sed program operand
  }
  if (binary === "find") {
    for (const x of rest) {
      if (FIND_ACTIONS.has(x.v) || /^-exec/.test(x.v) || /^-f(print|ls)/.test(x.v)) { flags.findAction = true; break; }
    }
  }
  if (binary === "xargs") flags.envRunner = true; // xargs executes its argument with stdin appended

  // 5. atom = binary + leading plain (unquoted, verb-shaped) subcommand tokens
  let atom = binary;
  let depth = 0;
  for (const x of rest) {
    if (depth >= 3) break;
    if (x.quoted) break;
    const t = x.v;
    if (t.startsWith("-")) break;
    if (/[/=~$:]/.test(t)) break;          // path / assignment / ref / expansion-ish → operand, stop
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(t)) break; // not a plain verb token
    atom += " " + t;
    depth++;
    if (!MULTIPLEX_VERBS.has(t)) {
      // keep extending only one level past a non-multiplexer verb is unusual; stop after first
      // concrete verb for non-multiplexers (e.g. `git diff` stops; `npm run test` continues via run)
      break;
    }
  }

  return { binary, atom, words: restVals, flags };
}

function blankFlags(seed) {
  return {
    envAssign: seed.envAssign || [],
    envRunner: false,
    interpreter: false,
    codeExecutor: false,
    findAction: false,
    hasGlob: false,
    pipeStage: seed.pipeStage || 0,
    redirects: seed.redirects || [],
  };
}

// How many leading tokens a transparent wrapper consumes (wrapper + its OWN args), before the
// inner command begins. Fail closed if the argument shape is unexpected (never guess).
function wrapperConsume(name, words) {
  if (name === "time" || name === "nohup") return 1;
  if (name === "stdbuf") {
    let k = 1;
    while (k < words.length && words[k].v.startsWith("-")) k++; // -oL -eL -i...
    if (k >= words.length) fail("wrapper-without-command");
    return k;
  }
  if (name === "nice") {
    let k = 1;
    if (words[1] && (words[1].v === "-n")) k = 3;             // nice -n N cmd
    else if (words[1] && /^-(\d+|n\d+)$/.test(words[1].v)) k = 2; // nice -10 / -n10
    else if (words[1] && words[1].v.startsWith("-")) k = 2;   // other nice flag
    if (k >= words.length) fail("wrapper-without-command");
    return k;
  }
  if (name === "timeout") {
    let k = 1;
    while (k < words.length && words[k].v.startsWith("-")) {
      const f = words[k].v;
      if (f === "-s" || f === "--signal" || f === "-k" || f === "--kill-after") k += 2; // flag + arg
      else k += 1;
    }
    // exactly one duration token, then the command
    if (k >= words.length || !/^[0-9]+(\.[0-9]+)?[smhd]?$/.test(words[k].v)) fail("timeout-bad-duration");
    return k + 1;
  }
  fail("unknown-wrapper");
}

module.exports = { analyze, basename };

if (require.main === module) {
  // quick manual probe: node agy-parse.js 'git status && ls 2>/dev/null'
  const arg = process.argv.slice(2).join(" ");
  process.stdout.write(JSON.stringify(analyze(arg), null, 2) + "\n");
}
