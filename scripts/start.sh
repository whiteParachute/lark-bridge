#!/bin/bash
#
# Start lark-bridge daemon, respecting daemon.mode from config.
# - daemon.mode = "service" → delegates to service.sh (systemd/launchd)
# - daemon.mode = "nohup"  → direct nohup start
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/../service" && pwd)"
BRIDGE_DIR="$HOME/.lark-bridge"
PID_FILE="$BRIDGE_DIR/bridge.pid"
LOG_FILE="$BRIDGE_DIR/bridge.log"
CONFIG_FILE="${LARK_BRIDGE_CONFIG:-$BRIDGE_DIR/config.json}"
NODE_BIN="$(command -v node 2>/dev/null || echo "")"

# Check config exists
if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: Config file not found at $CONFIG_FILE"
  echo "Run /lark-setup to configure the bridge first."
  exit 1
fi

# Read daemon.mode from config
DAEMON_MODE="nohup"
if [ -n "$NODE_BIN" ]; then
  DAEMON_MODE="$(LARK_BRIDGE_CFG="$CONFIG_FILE" "$NODE_BIN" -e "
    const c = JSON.parse(require('fs').readFileSync(process.env.LARK_BRIDGE_CFG,'utf-8'));
    console.log((c.daemon && c.daemon.mode) || 'nohup');
  " 2>/dev/null || echo "nohup")"
fi

# If daemon.mode is "service", delegate to service.sh
if [ "$DAEMON_MODE" = "service" ]; then
  echo "daemon.mode=service, delegating to service.sh..."
  # Install if not already installed, then start
  bash "$SCRIPT_DIR/service.sh" install 2>/dev/null || true
  bash "$SCRIPT_DIR/service.sh" start
  exit $?
fi

# ── nohup mode ──

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found in PATH"
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

# Ensure built — rebuild if dist is missing or src is newer than dist
NEEDS_BUILD=false
if [ ! -f "$SERVICE_DIR/dist/index.js" ]; then
  NEEDS_BUILD=true
else
  # Check if any src file is newer than dist/index.js
  NEWER_SRC="$(find "$SERVICE_DIR/src" -name '*.ts' -newer "$SERVICE_DIR/dist/index.js" 2>/dev/null | head -1)"
  if [ -n "$NEWER_SRC" ]; then
    NEEDS_BUILD=true
  fi
fi
if [ "$NEEDS_BUILD" = "true" ]; then
  echo "Building service..."
  cd "$SERVICE_DIR" && npm run build
fi

# Start daemon
mkdir -p "$BRIDGE_DIR"
LARK_BRIDGE_CONFIG="$CONFIG_FILE" \
  nohup "$NODE_BIN" "$SERVICE_DIR/dist/index.js" >> "$LOG_FILE" 2>&1 &
DAEMON_PID=$!
echo "$DAEMON_PID" > "$PID_FILE"

# Wait briefly to check it started
sleep 1
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "lark-bridge started (PID: $DAEMON_PID) [nohup]"
  echo "Log: $LOG_FILE"
  echo ""
  echo "TIP: For boot persistence + auto-restart, set daemon.mode to \"service\" in config."
else
  echo "ERROR: lark-bridge failed to start. Check log: $LOG_FILE"
  tail -20 "$LOG_FILE" 2>/dev/null
  rm -f "$PID_FILE"
  exit 1
fi
