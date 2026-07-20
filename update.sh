#!/usr/bin/env bash
set -uo pipefail
#
# update.sh — pull the latest agy-monitor and restart the background daemon, in one step.
#
# Intended for a git checkout (git clone). It:
#   1. git pull --ff-only          (refresh the code)
#   2. installs runtime deps ONLY if any exist (agy-monitor ships with zero, so normally a no-op)
#   3. re-points the launchd plist to this folder and restarts the daemon (daemon/install.sh)
#   4. health-checks the server
#
# Usage:
#   ./update.sh
#
# Not a git checkout (e.g. you replaced the folder from a ZIP)? It skips the pull and just
# restarts with whatever is on disk — so it still works, you just refresh the folder yourself.

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_INSTALL="$APP_DIR/daemon/install.sh"
PORT="${PORT:-8719}"

cd "$APP_DIR"

# --- 1. refresh the code -----------------------------------------------------
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  echo "==> git pull --ff-only"
  if ! git pull --ff-only; then
    echo "Error: git pull failed (local changes or diverged history). Resolve it, then re-run." >&2
    exit 1
  fi
else
  echo "! not a git checkout — skipping pull; restarting with the on-disk code."
fi

# --- 2. runtime deps (normally none) -----------------------------------------
if node -e 'process.exit(Object.keys((require("./package.json").dependencies)||{}).length ? 0 : 1)' 2>/dev/null; then
  echo "==> installing runtime deps (npm install --omit=dev)"
  npm install --omit=dev --no-audit --no-fund || { echo "Error: npm install failed." >&2; exit 1; }
else
  echo "==> no runtime deps to install (zero-dependency app)"
fi

# --- 3. re-point plist + restart the daemon ----------------------------------
if [ ! -x "$DAEMON_INSTALL" ]; then
  echo "Error: $DAEMON_INSTALL missing — run this from the agy-monitor repo root." >&2
  exit 1
fi
echo "==> refreshing + restarting the daemon"
PORT="$PORT" "$DAEMON_INSTALL"

# --- 4. health check ---------------------------------------------------------
echo "==> health check (http://127.0.0.1:$PORT/api/health)"
HEALTH=""
for _ in $(seq 1 20); do
  HEALTH="$(curl -s "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"
  [ -n "$HEALTH" ] && break
  sleep 0.3
done

if [ -n "$HEALTH" ]; then
  echo "✓ agy-monitor is up on :$PORT — $HEALTH"
else
  echo "! no health response yet — check the log: ~/Library/Logs/agy-monitor.log" >&2
  exit 1
fi
