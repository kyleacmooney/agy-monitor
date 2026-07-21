#!/bin/bash
# agy-monitor hook — observe-only. Installed globally in ~/.gemini/config/hooks.json
# on every lifecycle event; records the latest event for a conversation into a
# status file the monitor reads, then replies in a way that never alters agy:
# `allow` on PreToolUse (the only event carrying a decision) and an empty
# no-opinion `{}` on every other event.
#
#   usage (from hooks.json):  agy-monitor-hook.sh <EventName>
#
# Design notes:
# - conversationId comes from $ANTIGRAVITY_CONVERSATION_ID (no JSON parsing needed
#   for the filename); the raw stdin payload is embedded verbatim so the Node
#   backend can parse toolCall / fullyIdle / terminationReason at read time.
# - Atomic write (temp + mv) so concurrent async events can't tear the file.
# - Best-effort: any write failure is swallowed; we still print allow + exit 0.

EVENT="$1"
CID="${ANTIGRAVITY_CONVERSATION_ID:-unknown}"
DIR="$HOME/.agy-monitor/sessions"
PAYLOAD="$(cat)"
[ -z "$PAYLOAD" ] && PAYLOAD='null'
TS="$(date +%s)"

{
  mkdir -p "$DIR" 2>/dev/null
  TMP="$DIR/.$CID.$$.tmp"
  printf '{"event":"%s","ts":%s,"conversationId":"%s","payload":%s}\n' \
    "$EVENT" "$TS" "$CID" "$PAYLOAD" > "$TMP" 2>/dev/null \
    && mv -f "$TMP" "$DIR/$CID.json" 2>/dev/null
} || true

# When a UI-triggered send is gated (AGY_MONITOR_GATED), route PreToolUse through
# the approval gate: it auto-allows safelisted commands and otherwise blocks for a
# dashboard approval. Non-gated sessions (your real terminals) skip this entirely.
if [ -n "$AGY_MONITOR_GATED" ] && [ "$EVENT" = "PreToolUse" ]; then
  DECISION="$(printf '%s' "$PAYLOAD" | node "$(cd "$(dirname "$0")" && pwd)/agy-gate.js" 2>/dev/null)"
  if [ -n "$DECISION" ]; then printf '%s\n' "$DECISION"; exit 0; fi
  # GATED but the gate produced no output (node missing, agy-gate.js absent, or it crashed):
  # FAIL CLOSED. A gated run must never silently degrade to an ungated send — that would make the
  # whole safety gate vanish exactly when it can't run. Deny so the human has to re-trigger.
  echo '{"decision":"deny","reason":"agy-monitor gate unavailable"}'
  exit 0
fi

# Ungated sessions (your real terminals) are pure observe-only: never gate.
#
# agy parses each hook's stdout as THAT EVENT'S proto, and PreToolUse is the event
# whose proto we actually need a field from. Replying {"decision":"allow"} to the
# others made agy log, 112 times in the logs on this machine:
#
#   failed to unmarshal result from hook jsonhook__agy-monitor_PostToolUse_0_0
#   via protojson: {"decision":"allow"}: proto: (line 1:2): unknown field "decision"
#
# observed for PreInvocation, PostToolUse and PostInvocation. An empty object is the
# no-opinion reply every event accepts, so it is used for all of them — including
# Stop and Notification, which were never seen to complain but have no decision to
# express either.
if [ "$EVENT" = "PreToolUse" ]; then
  echo '{"decision":"allow"}'
else
  echo '{}'
fi
exit 0
