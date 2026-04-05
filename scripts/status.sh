#!/bin/bash
#
# Show lark-bridge daemon status, respecting daemon.mode from config.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$HOME/.lark-bridge"
PID_FILE="$BRIDGE_DIR/bridge.pid"
STATUS_FILE="$BRIDGE_DIR/status.json"
LOG_FILE="$BRIDGE_DIR/bridge.log"
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

echo "=== lark-bridge status ==="

# If daemon.mode is "service", delegate to service.sh for daemon status
if [ "$DAEMON_MODE" = "service" ]; then
  bash "$SCRIPT_DIR/service.sh" status
else
  # nohup mode
  RUNNING=false
  PID=""
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      RUNNING=true
    fi
  fi

  if [ "$RUNNING" = "true" ]; then
    echo "Daemon: RUNNING (PID: $PID) [nohup]"
  else
    echo "Daemon: STOPPED"
  fi
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
