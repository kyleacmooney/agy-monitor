#!/usr/bin/env bash
set -euo pipefail
# Remove the agy-monitor background daemon (LaunchAgent). Leaves the log file in place.
#   daemon/uninstall.sh
LABEL="${AGY_MONITOR_LABEL:-com.$(whoami).agy-monitor}"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "✓ agy-monitor daemon removed (log kept at ~/Library/Logs/agy-monitor.log)"
