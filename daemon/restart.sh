#!/usr/bin/env bash
# Restart the agy-monitor service on the owner's request (e.g. an About panel "Restart app"
# button). Detached from the server it restarts. Works on macOS (launchd) and, for future-
# proofing, a Linux box (systemd). If neither service manager owns this process (e.g. a bare
# `node server.js` dev run), it does NOTHING — so the button can never kill an unmanaged dev
# server; it just won't restart.
#
# Usage:
#   restart.sh [label] [server_pid]
#     label       = launchd label / systemd unit hint (default: the launchd-style label)
#     server_pid  = the server's PID (derives the real systemd unit from its cgroup, so this
#                   works even when the label doesn't match the unit name on the box)
set -uo pipefail
LABEL="${1:-${AGY_MONITOR_LABEL:-com.$(whoami).agy-monitor}}"
SERVER_PID="${2:-}"

sleep 0.4 # let the HTTP response flush before we bounce the service

# macOS — launchd user agent.
if command -v launchctl >/dev/null 2>&1 && launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null
  exit 0
fi

# Linux — systemd. Resolve the unit robustly: the passed label if it's a real unit, else the
# server's OWN unit derived from its cgroup (label-independent), else the conventional name.
if command -v systemctl >/dev/null 2>&1; then
  unit=""
  if systemctl cat "$LABEL" >/dev/null 2>&1; then
    unit="$LABEL"
  elif [ -n "$SERVER_PID" ] && [ -r "/proc/$SERVER_PID/cgroup" ]; then
    unit="$(grep -oE '[^/]+\.service' "/proc/$SERVER_PID/cgroup" | head -1)"
  fi
  [ -n "$unit" ] || unit="agy-monitor"
  unit="${unit%.service}" # sudoers NOPASSWD rules match argv exactly — use the suffix-less form
  sudo -n systemctl restart "$unit" 2>/dev/null \
    || systemctl --user restart "$unit" 2>/dev/null \
    || systemctl restart "$unit" 2>/dev/null
fi
