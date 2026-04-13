#!/bin/bash
#
# Reset lark-bridge session(s) via SIGUSR1.
#
# Usage:
#   reset.sh                   # Close all sessions
#   reset.sh <chatId>          # Close specific session
#   reset.sh --all             # Close all sessions (explicit)
#
set -euo pipefail

BRIDGE_DIR="$HOME/.lark-bridge"
CONTROL_FILE="$BRIDGE_DIR/control.json"
CONFIG_FILE="${LARK_BRIDGE_CONFIG:-$BRIDGE_DIR/config.json}"
NODE_BIN="$(command -v node 2>/dev/null || echo "")"

CHAT_ID="${1:-}"
REASON="会话已重置，下条消息将使用最新配置。"

# Build control command
if [ -z "$CHAT_ID" ] || [ "$CHAT_ID" = "--all" ]; then
  echo '{"action":"close-all","reason":"'"$REASON"'"}' > "$CONTROL_FILE"
  echo "Resetting ALL sessions..."
else
  echo '{"action":"close","chatId":"'"$CHAT_ID"'","reason":"'"$REASON"'"}' > "$CONTROL_FILE"
  echo "Resetting session: $CHAT_ID"
fi

# Send SIGUSR1 to daemon
DAEMON_MODE="nohup"
if [ -n "$NODE_BIN" ] && [ -f "$CONFIG_FILE" ]; then
  DAEMON_MODE="$(LARK_BRIDGE_CFG="$CONFIG_FILE" "$NODE_BIN" -e "
    const c = JSON.parse(require('fs').readFileSync(process.env.LARK_BRIDGE_CFG,'utf-8'));
    console.log((c.daemon && c.daemon.mode) || 'nohup');
  " 2>/dev/null || echo "nohup")"
fi

SENT=false
if [ "$DAEMON_MODE" = "service" ]; then
  if systemctl --user is-active lark-bridge >/dev/null 2>&1; then
    systemctl --user kill -s USR1 lark-bridge
    SENT=true
  fi
else
  PID_FILE="$BRIDGE_DIR/bridge.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      kill -USR1 "$PID"
      SENT=true
    fi
  fi
fi

if [ "$SENT" = "true" ]; then
  echo "Done. Session(s) will close and restart on next message."
else
  echo "Error: daemon not running. Use /lark-bridge start first."
  rm -f "$CONTROL_FILE"
  exit 1
fi
