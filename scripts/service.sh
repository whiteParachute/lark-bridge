#!/bin/bash
#
# lark-bridge daemon service manager.
# Reads daemon.mode and daemon.autoStart from config.json.
#
# Usage: service.sh <install|uninstall|start|stop|restart|status>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="$SCRIPT_DIR/../service"
BRIDGE_DIR="$HOME/.lark-bridge"
CONFIG_FILE="${LARK_BRIDGE_CONFIG:-$BRIDGE_DIR/config.json}"
LOG_FILE="$BRIDGE_DIR/bridge.log"
PID_FILE="$BRIDGE_DIR/bridge.pid"
NODE_BIN="$(command -v node 2>/dev/null || echo "")"

SYSTEMD_SERVICE="lark-bridge"
LAUNCHD_LABEL="com.lark-bridge.daemon"

# ─── Read config ─────────��────────────────────────────────────

read_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: Config not found at $CONFIG_FILE"
    exit 1
  fi
  # Extract daemon.mode and daemon.autoStart via node one-liner
  if [ -n "$NODE_BIN" ]; then
    DAEMON_MODE="$("$NODE_BIN" -e "
      const c = JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8'));
      console.log((c.daemon && c.daemon.mode) || 'nohup');
    ")"
    AUTO_START="$("$NODE_BIN" -e "
      const c = JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8'));
      console.log((c.daemon && c.daemon.autoStart) === true ? 'true' : 'false');
    ")"
  else
    # Fallback: grep-based extraction (best effort)
    DAEMON_MODE="$(grep -oP '"mode"\s*:\s*"\K[^"]+' "$CONFIG_FILE" 2>/dev/null || echo "nohup")"
    AUTO_START="$(grep -oP '"autoStart"\s*:\s*\K(true|false)' "$CONFIG_FILE" 2>/dev/null || echo "false")"
  fi
}

detect_platform() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    *)       echo "unknown" ;;
  esac
}

PLATFORM="$(detect_platform)"

# ─── Preflight ──────────��───────────────────────────────��─────

preflight() {
  if [ -z "$NODE_BIN" ]; then
    echo "ERROR: node not found in PATH"
    exit 1
  fi
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: Config not found at $CONFIG_FILE"
    exit 1
  fi
  if [ ! -f "$SERVICE_DIR/dist/index.js" ]; then
    echo "Building service..."
    cd "$SERVICE_DIR" && npm run build
  fi
  mkdir -p "$BRIDGE_DIR"
}

# ─── nohup mode ──────────────────────────────────────────────

is_bridge_process() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && \
    ps -p "$pid" -o args= 2>/dev/null | grep -q "lark-bridge\|dist/index.js"
}

nohup_start() {
  preflight
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || echo "")"
    if is_bridge_process "$pid"; then
      echo "lark-bridge already running (PID: $pid)"
      return
    fi
    rm -f "$PID_FILE"
  fi

  LARK_BRIDGE_CONFIG="$CONFIG_FILE" \
    nohup "$NODE_BIN" "$SERVICE_DIR/dist/index.js" >> "$LOG_FILE" 2>&1 &
  local daemon_pid=$!
  echo "$daemon_pid" > "$PID_FILE"

  sleep 1
  if kill -0 "$daemon_pid" 2>/dev/null; then
    echo "lark-bridge started (PID: $daemon_pid) [nohup]"
    echo "Log: $LOG_FILE"
  else
    echo "ERROR: failed to start. Check: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
}

nohup_stop() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || echo "")"
    if is_bridge_process "$pid"; then
      kill "$pid"
      echo "lark-bridge stopped (PID: $pid)"
    else
      echo "lark-bridge not running (stale PID file)."
    fi
    rm -f "$PID_FILE"
  else
    echo "lark-bridge not running."
  fi
}

nohup_status() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || echo "")"
    if is_bridge_process "$pid"; then
      echo "lark-bridge is running (PID: $pid) [nohup]"
      return
    fi
  fi
  echo "lark-bridge not running."
}

# ─── systemd (Linux) ─────────────────────────────────────────

systemd_unit_path() {
  echo "$HOME/.config/systemd/user/${SYSTEMD_SERVICE}.service"
}

systemd_install() {
  preflight
  local unit_path auto_start_value
  unit_path="$(systemd_unit_path)"
  mkdir -p "$(dirname "$unit_path")"

  cat > "$unit_path" <<EOF
[Unit]
Description=lark-bridge daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${SERVICE_DIR}/dist/index.js
Restart=on-failure
RestartSec=5
Environment=HOME=${HOME}
Environment=PATH=${PATH}
Environment=LARK_BRIDGE_CONFIG=${CONFIG_FILE}
WorkingDirectory=${SERVICE_DIR}
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload

  if [ "$AUTO_START" = "true" ]; then
    systemctl --user enable "$SYSTEMD_SERVICE"
    echo "systemd user service installed + enabled (auto-start on boot)"
  else
    systemctl --user disable "$SYSTEMD_SERVICE" 2>/dev/null || true
    echo "systemd user service installed (manual start only)"
  fi
  echo "  Unit: $unit_path"
  echo "  Run: service.sh start"
}

systemd_uninstall() {
  systemctl --user stop "$SYSTEMD_SERVICE" 2>/dev/null || true
  systemctl --user disable "$SYSTEMD_SERVICE" 2>/dev/null || true
  rm -f "$(systemd_unit_path)"
  systemctl --user daemon-reload
  echo "systemd user service removed."
}

systemd_start() {
  preflight
  systemctl --user start "$SYSTEMD_SERVICE"
  echo "lark-bridge started (systemd)"
  systemctl --user status "$SYSTEMD_SERVICE" --no-pager || true
}

systemd_stop() {
  systemctl --user stop "$SYSTEMD_SERVICE"
  echo "lark-bridge stopped."
}

systemd_restart() {
  preflight
  systemctl --user restart "$SYSTEMD_SERVICE"
  echo "lark-bridge restarted."
}

systemd_status() {
  systemctl --user status "$SYSTEMD_SERVICE" --no-pager 2>/dev/null || echo "Service not running or not installed."
}

# ─── launchd (macOS) ──────────────────────────────────────────

launchd_plist_path() {
  echo "$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
}

launchd_install() {
  preflight
  local plist_path run_at_load
  plist_path="$(launchd_plist_path)"
  mkdir -p "$(dirname "$plist_path")"

  if [ "$AUTO_START" = "true" ]; then
    run_at_load="true"
  else
    run_at_load="false"
  fi

  cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SERVICE_DIR}/dist/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${SERVICE_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>LARK_BRIDGE_CONFIG</key>
    <string>${CONFIG_FILE}</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>${PATH}</string>
  </dict>

  <key>RunAtLoad</key>
  <${run_at_load}/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>

  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
EOF

  if [ "$AUTO_START" = "true" ]; then
    echo "launchd agent installed + enabled (auto-start on login)"
  else
    echo "launchd agent installed (manual start only)"
  fi
  echo "  Plist: $plist_path"
  echo "  Run: service.sh start"
}

launchd_uninstall() {
  local plist_path
  plist_path="$(launchd_plist_path)"
  launchctl bootout "gui/$(id -u)" "$plist_path" 2>/dev/null || true
  rm -f "$plist_path"
  echo "launchd agent removed."
}

launchd_start() {
  preflight
  local plist_path
  plist_path="$(launchd_plist_path)"
  if [ ! -f "$plist_path" ]; then
    echo "ERROR: Service not installed. Run: service.sh install"
    exit 1
  fi
  launchctl bootstrap "gui/$(id -u)" "$plist_path" 2>/dev/null || \
    launchctl kickstart -k "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
  echo "lark-bridge started (launchd)"
  sleep 1
  launchd_status
}

launchd_stop() {
  launchctl kill SIGTERM "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
  echo "lark-bridge stopped."
}

launchd_restart() {
  launchd_stop
  sleep 1
  launchd_start
}

launchd_status() {
  local info
  info="$(launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null)" || {
    echo "Service not running or not installed."
    return
  }
  local pid
  pid="$(echo "$info" | grep -oE 'pid = [0-9]+' | head -1 | grep -oE '[0-9]+')" || pid=""
  if [ -n "$pid" ]; then
    echo "lark-bridge is running (PID: $pid)"
  else
    echo "lark-bridge is registered but not running."
  fi
}

# ─── Dispatch ──────────────────────────────���──────────────────

ACTION="${1:-help}"

read_config

# Determine effective backend
if [ "$DAEMON_MODE" = "service" ]; then
  case "$PLATFORM" in
    linux)  BACKEND="systemd" ;;
    macos)  BACKEND="launchd" ;;
    *)
      echo "WARNING: daemon.mode=service but platform unsupported. Falling back to nohup."
      BACKEND="nohup"
      ;;
  esac
else
  BACKEND="nohup"
fi

case "$BACKEND" in
  systemd)
    case "$ACTION" in
      install)   systemd_install ;;
      uninstall) systemd_uninstall ;;
      start)     systemd_start ;;
      stop)      systemd_stop ;;
      restart)   systemd_restart ;;
      status)    systemd_status ;;
      *)         echo "Usage: service.sh <install|uninstall|start|stop|restart|status>" ;;
    esac
    ;;
  launchd)
    case "$ACTION" in
      install)   launchd_install ;;
      uninstall) launchd_uninstall ;;
      start)     launchd_start ;;
      stop)      launchd_stop ;;
      restart)   launchd_restart ;;
      status)    launchd_status ;;
      *)         echo "Usage: service.sh <install|uninstall|start|stop|restart|status>" ;;
    esac
    ;;
  nohup)
    case "$ACTION" in
      install)   echo "daemon.mode=nohup: no service to install. Use start directly." ;;
      uninstall) echo "daemon.mode=nohup: no service to uninstall." ;;
      start)     nohup_start ;;
      stop)      nohup_stop ;;
      restart)   nohup_stop; sleep 1; nohup_start ;;
      status)    nohup_status ;;
      *)         echo "Usage: service.sh <install|uninstall|start|stop|restart|status>" ;;
    esac
    ;;
esac
