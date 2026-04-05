#!/bin/bash
set -euo pipefail

BRIDGE_DIR="$HOME/.lark-bridge"
PID_FILE="$BRIDGE_DIR/bridge.pid"

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
