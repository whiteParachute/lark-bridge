#!/bin/bash
set -euo pipefail

BRIDGE_DIR="$HOME/.feishu-bridge"
PID_FILE="$BRIDGE_DIR/bridge.pid"
STATUS_FILE="$BRIDGE_DIR/status.json"
LOG_FILE="$BRIDGE_DIR/bridge.log"

echo "=== feishu-bridge status ==="

# Check daemon
RUNNING=false
PID=""
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    RUNNING=true
  fi
fi

if [ "$RUNNING" = "true" ]; then
  echo "Daemon: RUNNING (PID: $PID)"
else
  echo "Daemon: STOPPED"
fi

# Show status file
if [ -f "$STATUS_FILE" ]; then
  echo ""
  echo "Sessions:"
  cat "$STATUS_FILE"
else
  echo ""
  echo "No status file (daemon may not have started yet)"
fi

# Show last few log lines
if [ -f "$LOG_FILE" ]; then
  echo ""
  echo "Recent logs:"
  tail -10 "$LOG_FILE"
fi
