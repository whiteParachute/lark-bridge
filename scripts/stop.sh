#!/bin/bash
#
# Stop lark-bridge daemon, respecting daemon.mode from config.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$HOME/.lark-bridge"
PID_FILE="$BRIDGE_DIR/bridge.pid"
CONFIG_FILE="${LARK_BRIDGE_CONFIG:-$BRIDGE_DIR/config.json}"
NODE_BIN="$(command -v node 2>/dev/null || echo "")"

# Read daemon.mode from config
DAEMON_MODE="nohup"
if [ -n "$NODE_BIN" ] && [ -f "$CONFIG_FILE" ]; then
  DAEMON_MODE="$(LARK_BRIDGE_CFG="$CONFIG_FILE" "$NODE_BIN" -e "
    const c = JSON.parse(require('fs').readFileSync(process.env.LARK_BRIDGE_CFG,'utf-8'));
    console.log((c.daemon && c.daemon.mode) || 'nohup');
  " 2>/dev/null || echo "nohup")"
fi

# If daemon.mode is "service", delegate to service.sh
if [ "$DAEMON_MODE" = "service" ]; then
  bash "$SCRIPT_DIR/service.sh" stop
  exit $?
fi

# ── nohup mode ──

if [ ! -f "$PID_FILE" ]; then
  echo "lark-bridge is not running (no PID file)"
  exit 0
fi

PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
if [ -z "$PID" ]; then
  rm -f "$PID_FILE"
  echo "lark-bridge is not running (empty PID file)"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping lark-bridge (PID: $PID)..."
  kill "$PID"
  # Wait up to 10s for graceful shutdown
  for i in $(seq 1 10); do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  # Force kill if still running
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
  fi
  echo "lark-bridge stopped."
else
  echo "lark-bridge was not running (stale PID: $PID)"
fi

rm -f "$PID_FILE"
