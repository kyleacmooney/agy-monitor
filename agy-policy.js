#!/usr/bin/env node
"use strict";
/*
 * agy-policy — the command-safety POLICY layer, on top of the agy-parse structural analyzer.
 *
 * Pure, dependency-free. Two public entry points:
 *
 *   screen(cmd) -> {
 *     disposition: "deny" | "defer" | "eligible",
 *     reason:      <string|null>,   // human-readable "why" for deny/defer
 *     analysis:    <analyze() result>,
 *     atoms:       [<string>],      // the command atoms (for logging / safelist matching)
 *   }
 *     deny     = a catastrophe-core match → AUTO-DENY (block outright; the human never sees it)
 *     defer    = dangerous-but-sometimes-legitimate, or unparseable, or not-statically-certifiable
 *                → MANUAL APPROVAL (overrides any model "allow"); never auto-allows
 *     eligible = structurally clean → MAY auto-allow IF safelisted (isCompoundSafelisted) or if the
 *                LLM classifier returns allow/none-low/high
 *
 *   isCompoundSafelisted(analysis, allowList) -> bool
 *     true iff EVERY sub-command's atom matches a permissions.allow `command(X)` entry (per-atom,
 *     word-boundary). Only meaningful on an `eligible` analysis (eligibility already vetoed
 *     env-runners, code-executors, dangerous flags, non-allowlisted env-assignments, etc.).
 *
 * DESIGN: the hard-deny is a fail-closed VETO that can only ever make a command MORE restrictive —
 * it never certifies anything as safe (that is the allowlist's job). Denylists are unsound as the
 * SOLE gate (infinite obfuscation variants), which is exactly why matching is done on the PARSER's
 * normalized atoms + flag-sets + operands, not on the raw string. The one raw-string check
 * (rawCatastrophe) is a deliberately tiny, anchored set of never-legitimate shapes.
 *
 * The tables are exported as versioned DATA so the M4 safelist-promoter reuses the SAME veto set —
 * what gets promoted and what gets auto-allowed can never drift.
 */
const { analyze, basename } = require("./agy-parse.js");

const POLICY_VERSION = 1;

// ---- catastrophe core (AUTO-DENY) -----------------------------------------
// Never-legitimate, irreversible. Matched on parser atoms/flags/operands (not raw strings),
// except rawCatastrophe() which scans the raw string for shapes the parser can't atomize.
const FS_DESTROYERS = new Set(["mkfs", "newfs", "wipefs", "fdisk", "gpart"]); // + mkfs.* prefix
const DISKUTIL_DESTROY = new Set(["erasedisk", "erasevolume", "zerodisk", "reformat", "partitiondisk", "secureerase"]);
// rm -rf targets that mean "the whole machine / the whole home" → DENY (vs a workspace path → DEFER).
const RM_DENY_TARGETS = new Set(["/", "/*", "~", "~/", "~/*", "..", "../", "../*"]);
function isSystemPath(t) {
  return t === "/" || /^\/(usr|etc|bin|sbin|var|opt|lib|lib64|System|Library|Users|Applications|private|cores|Volumes|dev|boot|root|home)(\/|$)/.test(t);
}

// ---- force-defer taxonomy (→ MANUAL; overrides a model "allow") ------------
const PRIVESC = new Set(["sudo", "su", "doas", "pkexec"]);
const NETWORK = new Set(["curl", "wget", "nc", "ncat", "netcat", "scp", "sftp", "ftp", "tftp", "telnet", "ssh", "sshpass", "rsync", "socat", "dig", "nslookup", "host", "whois", "ftp"]);
const PROC_SYS = new Set(["kill", "pkill", "killall", "shutdown", "reboot", "halt", "poweroff", "launchctl", "systemctl", "service", "crontab", "at", "batch", "pfctl", "iptables", "ip6tables", "nft", "mount", "umount", "sysctl", "nfsd", "renice"]);
const MAC_DANGER = new Set(["osascript", "open", "tmutil", "mdutil", "spctl", "csrutil", "nvram", "scutil", "dscl", "defaults", "networksetup", "systemsetup", "pmset", "kextload", "kextunload", "dseditgroup", "createhomedir"]);
const INSTALLER_BINS = new Set(["pip", "pip3", "pipx", "gem", "brew", "port", "apt", "apt-get", "yum", "dnf", "pacman", "apk", "conda", "mamba", "poetry", "uv"]);
// Package multiplexers (npm/yarn/pnpm/bun): install→installer, run/test/exec/build→never-safelistable.
const PKG_MULTIPLEX = new Set(["npm", "yarn", "pnpm", "bun"]);
const INSTALL_SUBCMDS = new Set(["install", "ci", "add", "i", "update", "upgrade", "remove", "uninstall", "rebuild", "link", "unlink", "dlx", "create", "init"]);
const BUILD_RUNNERS = new Set(["make", "gmake", "just", "rake", "gradle", "gradlew", "mvn", "mvnw", "ninja", "bazel", "buck", "task", "tox", "nox", "invoke", "cmake", "scons", "meson", "ant", "sbt", "lein", "mix", "dotnet", "msbuild", "xcodebuild", "swift", "deno"]);
// cargo/go: build/run/test/install subcommands execute repo-controlled code.
const CARGO_GO_EXEC = new Set(["run", "build", "test", "install", "bench", "doc", "generate", "rustc"]);
// Cloud/infra/orchestration CLIs: defer on a mutating or credential-touching subcommand; read
// subcommands (kubectl get, aws s3 ls, docker ps) stay eligible / safelistable.
const EXTERNAL_STATE = new Set(["kubectl", "oc", "helm", "terraform", "terragrunt", "aws", "gcloud", "az", "doctl", "vercel", "fly", "flyctl", "heroku", "pulumi", "eksctl", "kustomize", "nomad", "kubeadm", "gh", "glab", "docker", "podman", "kubectx", "kubens"]);
const MUTATING_VERBS = new Set(["delete", "destroy", "apply", "create", "remove", "rm", "rmi", "terminate", "put", "edit", "patch", "scale", "drain", "cordon", "uncordon", "taint", "replace", "rollout", "set", "annotate", "label", "expose", "stop", "start", "restart", "reboot", "kill", "upgrade", "uninstall", "deploy", "publish", "sync", "import", "migrate", "drop", "truncate", "exec", "cp", "prune", "purge", "revoke", "disable", "enable", "run"]);
const CRED_VERBS = new Set(["auth", "token", "secret", "secrets", "credential", "credentials", "login", "logout", "password", "passwd", "configure", "config", "kubeconfig", "print-access-token", "print-identity-token", "get-token", "keytab", "signin"]);
// Secret-store / credential CLIs: always defer (even reads expose secrets).
const CREDENTIAL_TOOLS = new Set(["vault", "consul", "op", "pass", "security", "gpg", "keyctl", "aws-vault", "gopass"]);

// ---- never-safelistable (block static AND classifier auto-allow) -----------
// Their behavior is controlled by repo files / stdin / inline code, so a high-confidence "looks
// safe" is meaningless (malicious-checkout RCE). They may reach the human, never the fast path.
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python2", "python3", "node", "deno", "bun", "ruby", "perl", "php"]);
const WRITE_SINKS = new Set(["tee", "dd", "sponge"]);
const SOURCE_BINS = new Set([".", "source"]);

// ---- safe environment-assignment allowlist --------------------------------
const SAFE_ENV = new Set(["LANG", "LANGUAGE", "NO_COLOR", "TERM", "TZ", "CLICOLOR", "CLICOLOR_FORCE", "COLUMNS", "LINES", "PAGER_OFF"]);
function isSafeEnvAssign(ea) {
  const okName = SAFE_ENV.has(ea.name) || /^LC_[A-Z]+$/.test(ea.name);
  const okValue = /^[A-Za-z0-9._:+-]*$/.test(ea.value); // literal, no slash/whitespace/quote
  return okName && okValue;
}

// ---- dangerous write-flags on an otherwise read-only atom ------------------
function dangerousFlag(words) {
  for (let k = 0; k < words.length; k++) {
    const t = words[k];
    if (/^--output(-file)?(=|$)/.test(t)) return "--output";
    if (/^--ext-diff(=|$)/.test(t)) return "--ext-diff";
    if (/^--in-place(=|$)/.test(t)) return "--in-place";
    if (/^--write(=|$)/.test(t)) return "--write";
    if (/^-o[\/~]/.test(t)) return "-o<path>";
    if (t === "-o" && words[k + 1] && /[\/~]/.test(words[k + 1])) return "-o <path>";
  }
  return null;
}

// Tiny anchored raw-string catastrophe scan (the only non-parser check). Fork bombs are never
// legitimate; we auto-deny so the human is never asked. (curl|bash is NOT here — installers can be
// legitimate, so it routes to manual via the network/interpreter force-defer instead.)
function rawCatastrophe(cmd) {
  const s = String(cmd);
  if (/(^|[\s;&|(])([A-Za-z_:][A-Za-z0-9_]*)\s*\(\)\s*\{[^}]*\|\s*\2\b[^}]*&[^}]*\}\s*;/.test(s)) return "fork-bomb";
  if (/:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;\s*:/.test(s)) return "fork-bomb";
  return null;
}

// Extract the recursive/force flag-set from rm-style words (so -rf, -r -f, -fr, -R, --recursive
// --force are all ONE rule).
function rmFlagSet(words) {
  const set = { recursive: false, force: false };
  for (const t of words) {
    if (t === "--recursive") set.recursive = true;
    else if (t === "--force") set.force = true;
    else if (/^-[A-Za-z]+$/.test(t)) {
      for (const c of t.slice(1)) {
        if (c === "r" || c === "R") set.recursive = true;
        if (c === "f") set.force = true;
      }
    }
  }
  return set;
}
const operandsOf = (words) => words.filter((t) => !t.startsWith("-"));

// git subcommand danger (history rewrite, force push, destructive checkout/clean/reset).
function gitDanger(words) {
  const sub = words.find((t) => !t.startsWith("-")); // first non-flag = subcommand
  if (!sub) return null;
  const has = (...xs) => words.some((w) => xs.includes(w));
  switch (sub) {
    case "push": return "git push"; // network egress + possible --force; always defer
    case "reset": return has("--hard") ? "git reset --hard" : null;
    case "clean": return words.some((w) => /^-[a-zA-Z]*f/.test(w)) ? "git clean -f" : null;
    case "checkout": return has(".", "--") ? "git checkout (discard)" : null;
    case "restore": return "git restore";
    case "branch": return has("-D", "--delete", "-d") ? "git branch -D" : null;
    case "stash": return has("drop", "clear", "pop") ? "git stash drop/clear" : null;
    case "filter-branch": case "filter-repo": return "git " + sub;
    case "update-ref": return has("-d") ? "git update-ref -d" : null;
    case "rm": return "git rm";
    case "gc": case "prune": return "git " + sub;
    default: return null;
  }
}

function deny(reason) { return { d: "deny", reason }; }
function defer(reason) { return { d: "defer", reason }; }
const ELIGIBLE = { d: "eligible", reason: null };

// Disposition of a single parsed sub-command.
function subDisposition(sub) {
  const b = sub.binary;
  const f = sub.flags;
  const words = sub.words;

  if (!b) return defer("bare-assignment"); // env-assign with no command

  // --- AUTO-DENY: catastrophe core (matched on normalized atoms/flags/operands) ---
  if (b === "rm" || b === "rmdir") {
    const { recursive, force } = rmFlagSet(words);
    const targets = operandsOf(words);
    if ((recursive || b === "rmdir") && targets.some((t) => RM_DENY_TARGETS.has(t) || isSystemPath(t) || t === "")) {
      return deny("data_destruction: recursive rm on a protected path");
    }
    if (recursive && force && targets.length === 0) return deny("data_destruction: rm -rf with no/empty target");
    return defer("data_destruction: rm");
  }
  if (b === "dd") {
    if (words.some((t) => /^of=\/dev\//.test(t))) return deny("data_destruction: dd to a raw device");
    return defer("data_destruction: dd");
  }
  if (FS_DESTROYERS.has(b) || /^mkfs/.test(b)) return deny("data_destruction: filesystem destroyer " + b);
  if (b === "diskutil") {
    const sc = (words.find((t) => !t.startsWith("-")) || "").toLowerCase();
    if (DISKUTIL_DESTROY.has(sc)) return deny("data_destruction: diskutil " + sc);
    return defer("diskutil");
  }
  if (b === "shred" || b === "srm") {
    if (operandsOf(words).some((t) => /^\/dev\//.test(t))) return deny("data_destruction: " + b + " on a device");
    return defer("data_destruction: " + b);
  }
  if (b === "asr") return defer("asr");

  // --- FORCE-DEFER: dangerous-but-sometimes-legitimate, never auto-allow ---
  if (f.envRunner) return defer("env-runner: " + b);          // sudo, npx, docker run, sh -c, ssh, command/env-peeled, xargs
  if (f.codeExecutor) return defer("code-executor: " + b);   // awk/sed program, python file, node -e, osascript
  if (f.findAction) return defer("find action (exec/delete/write)");
  if (f.interpreter) return defer("interpreter: " + b);      // bare/sink sh/bash/python/node/...
  if (PRIVESC.has(b)) return defer("privilege-escalation: " + b);
  if (NETWORK.has(b)) return defer("network: " + b);
  if (PROC_SYS.has(b)) return defer("process/system-control: " + b);
  if (MAC_DANGER.has(b)) return defer("macos-control: " + b);
  if (CREDENTIAL_TOOLS.has(b)) return defer("credential-tool: " + b);
  if (EXTERNAL_STATE.has(b)) {
    const hit = words.find((t) => MUTATING_VERBS.has(t) || CRED_VERBS.has(t));
    if (hit) return defer("external-state: " + b + " " + hit);
    // read-only subcommand → fall through (may be eligible / safelistable)
  }
  if (INSTALLER_BINS.has(b)) {
    if (b.startsWith("pip") && !words.includes("install")) { /* pip list etc — still defer, pip is risky */ }
    return defer("installer: " + b);
  }
  if (PKG_MULTIPLEX.has(b)) {
    const sc = words.find((t) => !t.startsWith("-"));
    if (sc && INSTALL_SUBCMDS.has(sc)) return defer("installer: " + b + " " + sc);
    return defer("script-runner (repo-controlled): " + b + (sc ? " " + sc : ""));
  }
  if ((b === "cargo" || b === "go" || b === "dotnet") && words.some((t) => CARGO_GO_EXEC.has(t))) {
    return defer("build/run (repo-controlled): " + b);
  }
  if (BUILD_RUNNERS.has(b)) return defer("build-runner (repo-controlled): " + b);
  if (b === "git") { const g = gitDanger(words); if (g) return defer("vcs-danger: " + g); }
  if (b === "chmod") {
    if (words.some((t) => /^(0?[0-7]?7{2}7|.*7{3})$/.test(t) || /^[ugoa]*\+s/.test(t) || /^-[A-Za-z]*R/.test(t) || t === "--recursive")) {
      return defer("permission-change: chmod");
    }
  }
  if (b === "chown" || b === "chgrp") {
    if (words.some((t) => /^-[A-Za-z]*R/.test(t) || t === "--recursive") || operandsOf(words).some((t) => /(^|:)root\b/.test(t))) {
      return defer("ownership-change: " + b);
    }
  }

  // --- NEVER-SAFELISTABLE: structurally cannot be statically certified ---
  if (WRITE_SINKS.has(b)) return defer("write-sink: " + b);
  if (SOURCE_BINS.has(b)) return defer("source-builtin: " + b);
  if (f.pipeStage > 0 && (INTERPRETERS.has(b) || WRITE_SINKS.has(b))) return defer("pipe-sink interpreter: " + b);

  // --- env-assignment guard (DYLD_INSERT_LIBRARIES / PATH / GIT_PAGER …) ---
  for (const ea of f.envAssign) {
    if (!isSafeEnvAssign(ea)) return defer("env-assignment: " + ea.name);
  }

  // --- dangerous write-flag on an otherwise read-only atom ---
  const df = dangerousFlag(words);
  if (df) return defer("write-flag: " + df);

  return ELIGIBLE;
}

// Screen a raw command string. Never throws.
function screen(cmd) {
  try {
    const cat = rawCatastrophe(cmd);
    if (cat) return { disposition: "deny", reason: "catastrophe: " + cat, analysis: null, atoms: [] };
    const a = analyze(cmd);
    if (!a.ok) return { disposition: "defer", reason: "unparseable: " + a.reason, analysis: a, atoms: [] };
    const atoms = a.subcommands.map((s) => s.atom).filter(Boolean);
    let worst = ELIGIBLE;
    let reason = null;
    for (const sub of a.subcommands) {
      const v = subDisposition(sub);
      if (v.d === "deny") return { disposition: "deny", reason: v.reason, analysis: a, atoms };
      if (v.d === "defer" && worst.d !== "defer") { worst = v; reason = v.reason; }
    }
    return { disposition: worst.d, reason, analysis: a, atoms };
  } catch (e) {
    // Any unexpected error in the policy layer fails closed to manual approval.
    return { disposition: "defer", reason: "policy-exception", analysis: null, atoms: [] };
  }
}

// Per-atom safelist matcher, mirroring agy's own `command(X)` semantics (exact or space-prefix),
// applied to the ATOM — never the whole command string (which is the compound-bypass bug).
function atomMatchesAllow(atom, allowList) {
  const a = atom.trim();
  for (const entry of allowList) {
    const m = /^command\((.+)\)$/.exec(String(entry));
    if (!m) continue;
    const pat = m[1].trim();
    if (pat === "*" || a === pat || a.startsWith(pat + " ")) return true;
  }
  return false;
}

// True iff every sub-command's atom is safelisted. Caller must pass an `eligible` analysis.
function isCompoundSafelisted(analysis, allowList) {
  if (!analysis || !analysis.ok || !Array.isArray(allowList) || allowList.length === 0) return false;
  if (analysis.subcommands.length === 0) return false;
  return analysis.subcommands.every((s) => s.atom && atomMatchesAllow(s.atom, allowList));
}

module.exports = {
  screen,
  isCompoundSafelisted,
  atomMatchesAllow,
  rawCatastrophe,
  subDisposition,
  POLICY_VERSION,
  // veto tables exported as data for the M4 promoter (single source of truth, no drift)
  tables: {
    FS_DESTROYERS, DISKUTIL_DESTROY, RM_DENY_TARGETS, PRIVESC, NETWORK, PROC_SYS, MAC_DANGER,
    INSTALLER_BINS, PKG_MULTIPLEX, BUILD_RUNNERS, INTERPRETERS, WRITE_SINKS, SOURCE_BINS, SAFE_ENV,
  },
};

if (require.main === module) {
  const arg = process.argv.slice(2).join(" ");
  const r = screen(arg);
  process.stdout.write(JSON.stringify({ disposition: r.disposition, reason: r.reason, atoms: r.atoms }, null, 2) + "\n");
}
