#!/usr/bin/env bash
set -euo pipefail
# Install agy-monitor as a launchd LaunchAgent so it runs in the background (starts at login,
# auto-restarts on crash). Re-run any time to refresh paths (e.g. after a node upgrade).
# macOS-only — this tool watches local agy state on your Mac.
#
# Usage:
#   daemon/install.sh
#   PORT=9000 daemon/install.sh            # override the port
#   AGY_MONITOR_SELF_UPDATE=1 daemon/install.sh   # enable live self-update
#   AGY_MONITOR_TOKEN=secret  daemon/install.sh   # require a bearer token

LABEL="${AGY_MONITOR_LABEL:-com.$(whoami).agy-monitor}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8719}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/agy-monitor.log"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Error: node not found on PATH"; exit 1; }

# Resolve the real claude binary so the self-update run can find it under launchd's minimal env.
CLAUDE=""
for c in "$HOME/.local/bin/claude" "/opt/homebrew/bin/claude" "/usr/local/bin/claude"; do
  if [ -x "$c" ]; then CLAUDE="$c"; break; fi
done

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Values interpolated into the plist must be XML-escaped — an & or < in a token
# or path would otherwise produce an invalid plist AFTER the old agent was booted out.
xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

# Optional env lines, only emitted when set — keeps the plist minimal otherwise.
EXTRA_ENV=""
[ -n "$CLAUDE" ] && EXTRA_ENV="$EXTRA_ENV
    <key>CLAUDE_BIN</key><string>$(xml_escape "$CLAUDE")</string>"
[ -n "${AGY_MONITOR_TOKEN:-}" ] && EXTRA_ENV="$EXTRA_ENV
    <key>AGY_MONITOR_TOKEN</key><string>$(xml_escape "$AGY_MONITOR_TOKEN")</string>"
[ -n "${AGY_MONITOR_SELF_UPDATE:-}" ] && EXTRA_ENV="$EXTRA_ENV
    <key>AGY_MONITOR_SELF_UPDATE</key><string>$(xml_escape "$AGY_MONITOR_SELF_UPDATE")</string>"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$APP_DIR/server.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$APP_DIR")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>BIND_HOST</key><string>127.0.0.1</string>
    <key>PATH</key><string>$(xml_escape "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")</string>$EXTRA_ENV
  </dict>
</dict>
</plist>
PLIST_EOF

echo "==> wrote $PLIST  (node=$NODE${CLAUDE:+, claude=$CLAUDE})"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL" 2>/dev/null || true
sleep 1

echo "==> status:"
launchctl print "gui/$UID/$LABEL" 2>/dev/null | grep -E "^\s+(state|pid) " | sed 's/^/    /' || echo "    (not printed)"
echo
echo "✓ agy-monitor is now a background daemon."
echo "   open:    http://127.0.0.1:$PORT"
echo "   logs:    $LOG"
echo "   remove:  daemon/uninstall.sh"
