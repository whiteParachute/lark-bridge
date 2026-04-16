#!/bin/bash
# SessionStart hook: report lark-bridge daemon status

set -euo pipefail

BRIDGE_DIR="$HOME/.lark-bridge"
PID_FILE="$BRIDGE_DIR/bridge.pid"
STATUS_FILE="$BRIDGE_DIR/status.json"

# Check if daemon is running
RUNNING=false
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    RUNNING=true
  fi
fi

if [ "$RUNNING" = "false" ]; then
  exit 0
fi

# Read status if available
SESSIONS=0
if [ -f "$STATUS_FILE" ]; then
  SESSIONS=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('activeSessions',0))" "$STATUS_FILE" 2>/dev/null || echo 0)
fi

# Output context
cat << EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Lark Bridge\n\nlark-bridge daemon is running (PID: $(cat "$PID_FILE")). Active sessions: ${SESSIONS}.\nUse /lark-bridge status for details, /feishu-sessions to list active conversations."}}
EOF
