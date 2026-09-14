#!/usr/bin/env bash
#
# Install the opencode-never-stop plugin into the global opencode config.
# Works on macOS, Linux and WSL.
#
# Usage:
#   ./scripts/install.sh
#
# The plugin has no runtime dependencies, so nothing needs to be built or
# installed — this script only copies files and creates a default config.
# Re-running it (e.g. after pulling updates) simply reinstalls.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd .. && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGINS_DIR="$CONFIG_DIR/plugins"
COMMANDS_DIR="$CONFIG_DIR/commands"
CONFIG_FILE="$CONFIG_DIR/opencode-never-stop.json"

echo "=== opencode-never-stop installer ==="

# --- 1. copy plugin ----------------------------------------------------------
PLUGIN_SRC="$REPO_DIR/plugin/opencode-never-stop.ts"
if [ ! -f "$PLUGIN_SRC" ]; then
  echo "ERROR: $PLUGIN_SRC not found. Run this script from the repo." >&2
  exit 1
fi

echo "1. copying plugin -> $PLUGINS_DIR/opencode-never-stop.ts"
mkdir -p "$PLUGINS_DIR"
cp "$PLUGIN_SRC" "$PLUGINS_DIR/"

# --- 2. copy commands --------------------------------------------------------
echo "2. copying commands -> $COMMANDS_DIR/"
mkdir -p "$COMMANDS_DIR"
cp "$REPO_DIR"/commands/*.md "$COMMANDS_DIR/"

# --- 3. create default config (never overwrite) -------------------------------
if [ -f "$CONFIG_FILE" ]; then
  echo "3. config already exists: $CONFIG_FILE (not overwriting)"
else
  echo "3. creating default config -> $CONFIG_FILE"
  cat > "$CONFIG_FILE" <<JSON
{
  "checkIntervalSeconds": 15,
  "message": "Have you done all your assignments? If anything is left, continue \u2014 or spend some more time double-checking your work."
}
JSON
fi

echo
echo "=== done. Restart opencode for the changes to apply. ==="
echo "    Plugin loaded from: $PLUGINS_DIR/opencode-never-stop.ts"
echo "    Commands: /opencode-never-stop (start), /opencode-stop (stop)"
echo "    Config:   $CONFIG_FILE"
echo "    Reinstall (e.g. after pulling updates): rerun ./scripts/install.sh"