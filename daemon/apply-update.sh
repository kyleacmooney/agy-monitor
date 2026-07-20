#!/usr/bin/env bash
# Detached supervisor for an agy-monitor self-update. Runs INDEPENDENTLY of the daemon (it
# restarts it): parse-check the edit, commit it (scoped to the app dir), kickstart the daemon
# onto it, health-check, and auto-rollback (git revert, app-dir-scoped) if it doesn't come
# back healthy. NEVER pushes — this repo's owner holds commits.
#
# Usage:
#   apply-update.sh <source_dir> <label> <port> <status_file> [server_pid]
#     source_dir  = the agy-monitor tool dir (its source; also the git-scope for commits)
#     label       = launchd label / systemd unit hint (may be the launchd-style default)
#     port        = server port, for the /api/health poll
#     status_file = JSON status file the UI polls across the restart
#     server_pid  = the live server's PID (derives the real systemd unit from its cgroup)
#
# Feedback: appends to self-update.log next to the status file; writes status JSON
#           {state, commit, ts}. States: no-changes | rejected | applying | applied | rolled-back | error.
set -uo pipefail

SRC="$1"; LABEL="$2"; PORT="$3"; STATUS="$4"; SERVER_PID="${5:-}"
LOG="$(dirname "$STATUS")/self-update.log"
NODE="${NODE_BIN:-node}"
TRIES="${HEALTH_TRIES:-24}"   # health-check attempts (1s apart); overridable for tests

# Files whose syntax we verify before touching the live daemon. Missing ones are skipped —
# agy-promoter.js is optional and public/app.js may not exist on every checkout.
PREFLIGHT_FILES=(
  server.js
  agy-monitor.js
  agy-runs.js
  agy-events.js
  agy-gate.js
  agy-policy.js
  agy-parse.js
  agy-promoter.js
  render-agy-monitor.js
  public/app.js
)

say(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }
set_status(){ printf '{"state":"%s","commit":"%s","ts":%s}\n' "$1" "${2:-}" "$(date +%s)000" > "$STATUS"; }
healthy(){ for _ in $(seq 1 "$TRIES"); do sleep 1; curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null && return 0; done; return 1; }

# Resolve the systemd unit ONCE, now — while the daemon we're about to restart is still alive,
# so its cgroup is readable (a later restart frees the old PID). Prefer the label if it's a real
# unit; else derive the daemon's OWN unit from its cgroup; else the conventional name.
resolve_unit(){
  command -v systemctl >/dev/null 2>&1 || return 0
  # sudoers NOPASSWD rules match argv exactly — emit the suffix-less form.
  if systemctl cat "$LABEL" >/dev/null 2>&1; then echo "${LABEL%.service}"; return 0; fi
  if [ -n "$SERVER_PID" ] && [ -r "/proc/$SERVER_PID/cgroup" ]; then
    local u; u="$(grep -oE '[^/]+\.service' "/proc/$SERVER_PID/cgroup" | head -1)"
    [ -n "$u" ] && { echo "${u%.service}"; return 0; }
  fi
  echo "agy-monitor"
}
UNIT="$(resolve_unit)"

# Restart the daemon onto the new code — macOS (launchd) AND a Linux box (systemd). A no-op
# for an unmanaged dev `node server.js` (neither service manager owns it), so it can never kill
# an unmanaged dev server.
restart_daemon(){
  if command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null
  elif command -v systemctl >/dev/null 2>&1; then
    sudo -n systemctl restart "$UNIT" 2>/dev/null \
      || systemctl --user restart "$UNIT" 2>/dev/null \
      || systemctl restart "$UNIT" 2>/dev/null
  fi
}

SRC="${SRC%/}"          # a trailing slash would make REL empty → an unscoped git pathspec
# Physical path: git prints a symlink-resolved toplevel (macOS /var → /private/var),
# so the prefix strip below only works if SRC is resolved the same way.
SRC="$(cd "$SRC" 2>/dev/null && pwd -P)" || { say "app dir missing: $1"; set_status "error" ""; exit 1; }
REPO="$(git -C "$SRC" rev-parse --show-toplevel 2>/dev/null)" || { say "not a git repo: $SRC"; set_status "error" ""; exit 1; }
cd "$REPO" || exit 1
REL="${SRC#"$REPO"/}"   # app dir relative to repo root — the git scope for every op below
[ "$REL" = "$SRC" ] && REL="."   # SRC IS the repo root (the standalone-repo case)

if [ -z "$(git status --porcelain -- "$REL")" ]; then
  say "no file changes were made — nothing to apply"; set_status "no-changes" ""; exit 0
fi

# Pre-flight: parse-check the edited JS BEFORE we touch the live daemon. Catches the usual
# "bricks the app" mistakes (a broken server.js, a core safety module, or public/app.js — the
# frontend, which the post-restart health check can't see) with no browser needed. If anything
# won't parse, discard the whole edit and leave the running app COMPLETELY untouched.
bad=""
for name in "${PREFLIGHT_FILES[@]}"; do
  f="$REL/$name"
  [ -f "$f" ] || continue
  "$NODE" --check "$f" >>"$LOG" 2>&1 || { bad="$f"; break; }
done
if [ -n "$bad" ]; then
  say "PREFLIGHT FAIL: $bad won't parse — discarding the edit; the live app was NOT touched"
  git checkout HEAD -- "$REL" >/dev/null 2>&1
  git clean -fd -- "$REL" >/dev/null 2>&1   # untracked files from the rejected edit too
  set_status "rejected" ""; exit 1
fi

git add -- "$REL"
git commit -q -m "self-update (live): agy-monitor" -m "Co-Authored-By: Claude <noreply@anthropic.com>" \
  || { say "git commit failed"; set_status "error" ""; exit 1; }
COMMIT="$(git rev-parse --short HEAD)"
say "committed $COMMIT — restarting daemon onto it"
set_status "applying" "$COMMIT"

restart_daemon

if healthy; then
  say "healthy after restart — applied $COMMIT"
  set_status "applied" "$COMMIT"; exit 0
fi

# Did not come back healthy → revert the change (scoped) and restart onto the known-good code.
say "NOT healthy after restart — rolling back $COMMIT"
git revert --no-edit "$COMMIT" >/dev/null 2>&1 \
  || { git checkout "$COMMIT~1" -- "$REL" && git commit -q -m "rollback self-update $COMMIT"; }
restart_daemon
healthy && say "rolled back — app restored" || say "rolled back — WARNING: still unhealthy, check logs"
set_status "rolled-back" "$COMMIT"
exit 1
