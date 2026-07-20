#!/usr/bin/env node
"use strict";
/*
 * agy-parse-test — golden structural tests for the fail-closed shell parser (M2a).
 *
 *   node agy-parse-test.js
 *
 * Asserts the STRUCTURE analyze() reports (splitting, fail-closed triggers, env-assign
 * extraction, wrapper unwrap, flag detection, atom derivation). Final disposition
 * (DENY/DEFER/ALLOW) is tested in M2b once the hard-deny tables + safe-compound policy
 * are wired. Every red-team bypass and every brief golden appears here.
 */
const assert = require("assert");
const { analyze } = require("./agy-parse.js");

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; /* console.log("  ok   " + name); */ }
  catch (e) { fail++; console.log("  FAIL " + name + "\n         " + (e && e.message ? e.message : e)); }
}

// Assert analyze(cmd) fails closed (optionally with a reason prefix).
function denyParse(cmd, reasonPrefix) {
  check("ok:false  " + JSON.stringify(cmd) + (reasonPrefix ? "  (" + reasonPrefix + ")" : ""), () => {
    const r = analyze(cmd);
    assert.strictEqual(r.ok, false, "expected ok:false, got " + JSON.stringify(r).slice(0, 200));
    if (reasonPrefix) assert.ok(String(r.reason).startsWith(reasonPrefix), "reason was " + r.reason);
  });
}

// Assert analyze(cmd).ok === true and each spec in `subs` matches the corresponding sub-command.
// A spec is a partial object; only the listed fields are checked.
function okParse(cmd, subs) {
  check("ok:true   " + JSON.stringify(cmd), () => {
    const r = analyze(cmd);
    assert.strictEqual(r.ok, true, "expected ok:true, got " + JSON.stringify(r).slice(0, 200));
    assert.strictEqual(r.subcommands.length, subs.length, "subcommand count");
    r.subcommands.forEach((sub, k) => {
      const spec = subs[k];
      for (const key of Object.keys(spec)) {
        if (key === "atom" || key === "binary") {
          assert.strictEqual(sub[key], spec[key], `sub[${k}].${key}`);
        } else if (key === "envAssign") {
          assert.deepStrictEqual(sub.flags.envAssign.map((a) => a.name), spec[key], `sub[${k}].envAssign names`);
        } else if (key === "redirects") {
          assert.strictEqual(sub.flags.redirects.length, spec[key], `sub[${k}].redirects count`);
        } else if (key === "words") {
          assert.deepStrictEqual(sub.words, spec[key], `sub[${k}].words`);
        } else { // a boolean/number flag
          assert.strictEqual(sub.flags[key], spec[key], `sub[${k}].flags.${key}`);
        }
      }
    });
  });
}

// ---- splitting & pipe stages ----------------------------------------------
okParse("ls && pwd", [{ atom: "ls" }, { atom: "pwd" }]);
okParse("git status && git diff", [{ atom: "git status" }, { atom: "git diff" }]);
okParse("a | b | c", [{ atom: "a", pipeStage: 0 }, { atom: "b", pipeStage: 1 }, { atom: "c", pipeStage: 2 }]);
okParse("a && b | c", [{ pipeStage: 0 }, { pipeStage: 0 }, { pipeStage: 1 }]);
okParse("git diff && curl x | sh", [{ atom: "git diff", pipeStage: 0 }, { binary: "curl", pipeStage: 0 }, { binary: "sh", pipeStage: 1, interpreter: true }]);
okParse("ls; pwd; whoami", [{ atom: "ls" }, { atom: "pwd" }, { atom: "whoami" }]);
okParse("ls;", [{ atom: "ls" }]); // trailing ; is fine
denyParse("ls &&", "empty-subcommand");
denyParse("&& ls", "empty-subcommand");
denyParse("| ls", "empty-subcommand");
denyParse("ls ;; pwd", "case-terminator");

// ---- substitution / expansion → fail closed -------------------------------
denyParse("ls $(whoami)", "substitution-dollar");
denyParse("echo `id`", "substitution-backtick");
denyParse("echo $HOME", "substitution-dollar");
denyParse("echo ${HOME}", "substitution-dollar");
denyParse("cat <(ls)", "input-redirect"); // process substitution: the leading < fails closed first
denyParse("ls $((1+1))", "substitution-dollar");
okParse("echo '$HOME'", [{ atom: "echo", words: ["$HOME"] }]); // single-quoted $ is literal
okParse('echo "plain text"', [{ atom: "echo", words: ["plain text"] }]);

// ---- redirection: only the null/fd whitelist survives ---------------------
okParse("ls 2>/dev/null", [{ atom: "ls", redirects: 1 }]);
okParse("ls 2>&1", [{ atom: "ls", redirects: 1 }]);
okParse("ls >/dev/null 2>&1", [{ atom: "ls", redirects: 2 }]);
okParse("make &>/dev/null", [{ binary: "make", redirects: 1 }]);
okParse("echo hi >&2", [{ binary: "echo", redirects: 1 }]);
denyParse("cat a > b", "unsafe-redirect");
denyParse("echo x >> file.txt", "unsafe-redirect");
denyParse("cat foo > /dev/sda", "unsafe-redirect");
okParse("tee ~/.zshrc", [{ binary: "tee" }]); // parses fine; tee is a write-sink → neverSafelistable in M2b
denyParse("cmd < input.txt", "input-redirect");
denyParse("cat <<EOF", "input-redirect");
denyParse("grep x <<< 'data'", "input-redirect");
denyParse("echo x >| f", "clobber-redirect");

// ---- grouping / brace / keywords / comments -------------------------------
denyParse("(ls)", "grouping");
denyParse("{ ls; }", "grouping");
denyParse("echo {a,b}", "grouping"); // brace expansion stays strict
denyParse("ls # comment", "comment");
okParse("echo issue#3", [{ atom: "echo", words: ["issue#3"] }]); // mid-word # is literal

// ---- unbalanced / escapes / control ---------------------------------------
denyParse('echo "hi', "unbalanced-double");
denyParse("echo 'hi", "unbalanced-single");
denyParse("echo hi\\", "dangling-escape");
denyParse("echo \x00 hi", "nul-byte");

// ---- obfuscated command name → fail closed --------------------------------
denyParse('"e"cho hi', "obfuscated-binary");
denyParse("c\\url http://x", "obfuscated-binary");
denyParse("''ls", "obfuscated-binary");
okParse("echo 'quoted arg ok'", [{ atom: "echo" }]); // quoting an ARG is fine; only the NAME must be clean

// ---- env-assignment is recorded, never ignored ----------------------------
okParse("GIT_PAGER=x git log", [{ atom: "git log", envAssign: ["GIT_PAGER"] }]);
okParse("DYLD_INSERT_LIBRARIES=/tmp/e.dylib ls", [{ atom: "ls", binary: "ls", envAssign: ["DYLD_INSERT_LIBRARIES"] }]);
okParse("PATH=/tmp/evil ls", [{ atom: "ls", envAssign: ["PATH"] }]);
okParse("LANG=C FOO=bar ls -la", [{ atom: "ls", envAssign: ["LANG", "FOO"] }]);
okParse("GIT_EXTERNAL_DIFF=/tmp/p.sh git diff HEAD~1", [{ atom: "git diff", envAssign: ["GIT_EXTERNAL_DIFF"] }]);
denyParse("FOO=$BAR ls", "substitution-dollar"); // non-literal assignment value

// ---- transparent wrappers unwrap to the inner command ---------------------
okParse("timeout 5 ls", [{ atom: "ls", binary: "ls" }]);
okParse("timeout 5s rm -rf ~", [{ binary: "rm" }]);
okParse("timeout -k 2 5 ls", [{ binary: "ls" }]);
okParse("time make", [{ binary: "make" }]);
okParse("nohup ./run.sh", [{ binary: "run.sh" }]);
okParse("nice -n 10 cargo build", [{ atom: "cargo build" }]);
okParse("stdbuf -oL grep foo", [{ binary: "grep" }]);
denyParse("timeout ls", "timeout-bad-duration"); // no duration → fail closed, don't guess

// ---- exec-prefixes peel + mark envRunner ----------------------------------
okParse("command rm -rf ~", [{ binary: "rm", envRunner: true }]);
okParse("env ls", [{ binary: "ls", envRunner: true }]);
okParse("env FOO=bar rm -rf ~", [{ binary: "rm", envRunner: true }]);
okParse("exec ls", [{ binary: "ls", envRunner: true }]);

// ---- env-runner heads & multiplexers --------------------------------------
okParse("sudo rm -rf /", [{ binary: "sudo", envRunner: true }]); // sudo not peeled → forceDefer(privesc)→manual in M2b
okParse("npx cowsay hi", [{ binary: "npx", envRunner: true }]);
okParse("docker run ubuntu", [{ binary: "docker", envRunner: true }]);
okParse("docker ps -a", [{ atom: "docker ps", envRunner: false }]);
okParse("ssh host rm -rf /", [{ binary: "ssh", envRunner: true }]);
okParse("find . -print0 | xargs -0 rm", [{ binary: "find", findAction: false }, { binary: "xargs", envRunner: true }]);

// ---- interpreters / code-executors ----------------------------------------
okParse("sh -c 'rm -rf ~'", [{ binary: "sh", interpreter: true, envRunner: true, codeExecutor: true }]);
okParse("bash script.sh", [{ binary: "bash", interpreter: true, codeExecutor: true }]);
okParse("python app.py", [{ binary: "python", interpreter: true, codeExecutor: true }]);
okParse("python3 --version", [{ binary: "python3", interpreter: true, codeExecutor: false }]);
okParse("node -e 'process.exit(0)'", [{ binary: "node", codeExecutor: true }]);
okParse("awk 'BEGIN{system(1)}'", [{ binary: "awk", codeExecutor: true }]);
okParse("sed -i s/a/b/ file", [{ binary: "sed", codeExecutor: true }]);
okParse("sed s/a/b/ file", [{ binary: "sed", codeExecutor: true }]); // program operand → codeExecutor
okParse("osascript -e 'tell app'", [{ binary: "osascript", codeExecutor: true }]);
okParse("grep -i foo file", [{ atom: "grep", codeExecutor: false }]); // grep -i is NOT in-place

// ---- find action detection ------------------------------------------------
okParse("find . -delete", [{ binary: "find", findAction: true }]);
denyParse("find . -exec rm {} +", "grouping"); // the {} placeholder trips grouping first → fail closed (safe)
okParse("find . -exec rm ';'", [{ binary: "find", findAction: true }]); // -exec without {} → findAction
okParse("find . -fprintf ~/.x out", [{ binary: "find", findAction: true }]);
okParse("find . -name '*.js'", [{ atom: "find", findAction: false }]);

// ---- atom derivation goldens (mirror brief §6.2) --------------------------
okParse("git diff HEAD~1", [{ atom: "git diff" }]);
okParse("git log --oneline", [{ atom: "git log" }]);
okParse("npm run test", [{ atom: "npm run test" }]);
okParse("kubectl get pods -n x", [{ atom: "kubectl get" }]);
okParse("docker ps -a", [{ atom: "docker ps" }]);
okParse("cargo build --release", [{ atom: "cargo build" }]);
okParse("ls -la", [{ atom: "ls" }]);
okParse("/usr/bin/git status", [{ atom: "git status", binary: "git" }]);

// ---- structure exposed for M2b policy (these parse ok:true; policy blocks them) ---
okParse("git diff --output=~/.zshrc", [{ atom: "git diff", words: ["diff", "--output=~/.zshrc"] }]); // dangerousFlag → M2b
okParse("sort -o ~/.zshrc file", [{ atom: "sort", words: ["-o", "~/.zshrc", "file"] }]);     // writer flag → M2b
okParse(". /tmp/x.sh", [{ binary: ".", atom: "." }]);   // source builtin → neverSafelistable in M2b
okParse("diskutil eraseDisk JHFS+ X disk2", [{ atom: "diskutil eraseDisk" }]); // denyCore in M2b
okParse("rm -r -f ~", [{ binary: "rm", words: ["-r", "-f", "~"] }]);            // flag-set {r,f} → denyCore in M2b
okParse("rm -fr ~", [{ binary: "rm", words: ["-fr", "~"] }]);

// ---- robustness: analyze() must NEVER throw — always returns {ok:boolean} ---
check("never throws on adversarial / garbage input", () => {
  const seeds = [
    "", " ", "\t\n", "\\", "\\\\", "'", '"', "''", '""', "`", "$", "${", "$(", "<(", ">(", "|", "||", "&&",
    ";", ";;", "&", "()", "{}", "#", "rm -rf /", "a".repeat(5000), " ", "�", "ls \xff", "ls ".repeat(300),
    "a | ".repeat(40), "echo " + "x ".repeat(300), "💀 rm -rf ~", "ls", "cmd 2>&1 | tee -a f && x; y || z",
  ];
  for (const s of seeds) {
    let r;
    try { r = analyze(s); } catch (e) { throw new Error("analyze threw on " + JSON.stringify(s).slice(0, 60) + ": " + e.message); }
    assert.ok(r && typeof r.ok === "boolean", "no {ok} for " + JSON.stringify(s).slice(0, 60));
    if (r.ok) assert.ok(Array.isArray(r.subcommands));
  }
  // pseudo-random bytes (deterministic seed, no Math.random)
  const alpha = "abc ;|&()$`\"'\\<>{}#=~/*?\n\t-12";
  let x = 1234567;
  for (let t = 0; t < 4000; t++) {
    let s = "";
    const len = (x % 40);
    for (let k = 0; k < len; k++) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += alpha[x % alpha.length]; }
    let r;
    try { r = analyze(s); } catch (e) { throw new Error("analyze threw on fuzz " + JSON.stringify(s) + ": " + e.message); }
    assert.ok(r && typeof r.ok === "boolean", "no {ok} for fuzz " + JSON.stringify(s));
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
