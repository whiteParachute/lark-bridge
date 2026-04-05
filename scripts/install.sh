#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="$SCRIPT_DIR/../service"
BRIDGE_DIR="$HOME/.lark-bridge"

echo "Installing lark-bridge service..."

# Ensure config dir exists
mkdir -p "$BRIDGE_DIR"

# Install dependencies
cd "$SERVICE_DIR"
if [ -f "package-lock.json" ]; then
  npm ci
else
  npm install
fi

# Build
npm run build

echo "lark-bridge installed successfully."
echo "Run '/lark-bridge start' to start the daemon."
