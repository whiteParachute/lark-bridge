#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="$SCRIPT_DIR/../service"
BRIDGE_DIR="$HOME/.feishu-bridge"

echo "Installing feishu-bridge service..."

# Ensure config dir exists
mkdir -p "$BRIDGE_DIR"

# Install dependencies
cd "$SERVICE_DIR"
npm install

# Build
npm run build

echo "feishu-bridge installed successfully."
echo "Run '/feishu-bridge start' to start the daemon."
