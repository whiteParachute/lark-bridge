#!/bin/bash
#
# Quick start lark-bridge daemon (nohup, no auto-restart).
# For persistent deployment, use: service.sh install && service.sh start
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="$SCRIPT_DIR/../service"
BRIDGE_DIR="$HOME/.lark-bridge"
PID_FILE="$BRIDGE_DIR/bridge.pid"
LOG_FILE="$BRIDGE_DIR/bridge.log"
CONFIG_FILE="$BRIDGE_DIR/config.json"

# Check config exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config file not found at $CONFIG_FILE"
  echo "Run /lark-setup to configure the bridge first."
  exit 1
fi

# Check if already running
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    if ps -p "$PID" -o args= 2>/dev/null | grep -q "lark-bridge\|dist/index.js"; then
      echo "lark-bridge is already running (PID: $PID)"
      exit 0
    fi
  fi
  rm -f "$PID_FILE"
fi

# Ensure built
if [ ! -f "$SERVICE_DIR/dist/index.js" ]; then
  echo "Building service..."
  cd "$SERVICE_DIR" && npm run build
fi

# Start daemon
mkdir -p "$BRIDGE_DIR"
LARK_BRIDGE_CONFIG="$CONFIG_FILE" \
  nohup node "$SERVICE_DIR/dist/index.js" >> "$LOG_FILE" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$PID_FILE"

# Wait briefly to check it started
sleep 1
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "lark-bridge started (PID: $DAEMON_PID)"
  echo "Log: $LOG_FILE"
  echo ""
  echo "NOTE: This is a one-off nohup start. For boot persistence + auto-restart:"
  echo "  bash scripts/service.sh install && bash scripts/service.sh start"
else
  echo "ERROR: lark-bridge failed to start. Check log: $LOG_FILE"
  tail -20 "$LOG_FILE" 2>/dev/null
  rm -f "$PID_FILE"
  exit 1
fi
