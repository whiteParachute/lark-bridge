#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="$SCRIPT_DIR/../service"
BRIDGE_DIR="$HOME/.feishu-bridge"
PID_FILE="$BRIDGE_DIR/bridge.pid"
LOG_FILE="$BRIDGE_DIR/bridge.log"
CONFIG_FILE="$BRIDGE_DIR/config.json"

# Check config exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config file not found at $CONFIG_FILE"
  echo "Run /feishu-setup to configure the bridge first."
  exit 1
fi

# Check if already running
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "feishu-bridge is already running (PID: $PID)"
    exit 0
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
nohup node "$SERVICE_DIR/dist/index.js" > "$LOG_FILE" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$PID_FILE"

# Wait briefly to check it started
sleep 1
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "feishu-bridge started (PID: $DAEMON_PID)"
  echo "Log: $LOG_FILE"
else
  echo "ERROR: feishu-bridge failed to start. Check log: $LOG_FILE"
  tail -20 "$LOG_FILE" 2>/dev/null
  rm -f "$PID_FILE"
  exit 1
fi
