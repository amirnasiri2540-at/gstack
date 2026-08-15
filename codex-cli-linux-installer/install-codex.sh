#!/usr/bin/env bash
#
# One-command installer for the OpenAI Codex CLI on Linux (Debian/Ubuntu and
# other distros with npm available).
#
#   - Verifies Node.js and npm are installed (never installs them for you).
#   - Skips the npm install step if the Codex CLI is already on PATH, so
#     re-running this script on a machine that already has everything set
#     up does nothing but refresh the launcher and application menu entry.
#   - Copies the launcher script into a per-user install folder.
#   - Creates an "OpenAI Codex" entry in your applications menu (and on
#     your Desktop, if you have one).
#
# Usage:
#   Download this file together with launch-codex.sh and
#   create-desktop-entry.sh into the same folder, then run:
#
#       bash install-codex.sh
#
#   No root privileges are required unless your npm global folder needs
#   them (the script detects this and uses sudo only in that case).
#   Pass --force to reinstall the Codex CLI even if it's already present.

set -euo pipefail

APP_NAME="OpenAI Codex"
INSTALL_DIR="$HOME/.local/share/openai-codex"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE=0

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
    esac
done

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf '    OK: %s\n' "$1"; }
err()  { printf '    ERROR: %s\n' "$1" >&2; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

echo "OpenAI Codex CLI - Linux Installer"
echo "===================================="

step "Checking for Node.js"
if ! command_exists node; then
    err "Node.js was not found on PATH."
    echo "    Install it, e.g. 'sudo apt install nodejs npm' on Debian/Ubuntu, or from https://nodejs.org/, then re-run this script."
    exit 1
fi
ok "Node.js $(node -v) found"

step "Checking for npm"
if ! command_exists npm; then
    err "npm was not found on PATH."
    echo "    npm normally ships with Node.js. Install it and re-run this script."
    exit 1
fi
ok "npm $(npm -v) found"

step "Checking whether the Codex CLI is already installed"
if command_exists codex && [ "$FORCE" -ne 1 ]; then
    version="$(codex --version 2>/dev/null || true)"
    if [ -n "$version" ]; then
        ok "Codex CLI already installed ($version) - skipping npm install"
    else
        ok "Codex CLI already installed - skipping npm install"
    fi
else
    step "Installing OpenAI Codex CLI (npm install -g @openai/codex)"
    npm_global_dir="$(npm config get prefix)/lib/node_modules"
    if [ -w "$npm_global_dir" ] || { [ ! -e "$npm_global_dir" ] && [ -w "$(dirname "$npm_global_dir")" ]; }; then
        npm install -g @openai/codex
    else
        echo "    npm's global folder needs elevated permissions, using sudo..."
        sudo npm install -g @openai/codex
    fi
    ok "OpenAI Codex CLI installed"
fi

step "Verifying the codex command is available"
if ! command_exists codex; then
    err "The 'codex' command was not found. Open a new terminal and try 'npm install -g @openai/codex' manually, then re-run this script."
    exit 1
fi
ok "codex command is available"

step "Setting up the launcher"
mkdir -p "$INSTALL_DIR"

launcher_source="$SCRIPT_DIR/launch-codex.sh"
if [ ! -f "$launcher_source" ]; then
    err "launch-codex.sh was not found next to install-codex.sh. Download all installer files into the same folder and try again."
    exit 1
fi
launcher_dest="$INSTALL_DIR/launch-codex.sh"
cp "$launcher_source" "$launcher_dest"
chmod +x "$launcher_dest"

icon_source="$SCRIPT_DIR/codex.png"
if [ -f "$icon_source" ]; then
    cp "$icon_source" "$INSTALL_DIR/codex.png"
fi
ok "Launcher installed to $INSTALL_DIR"

step "Creating application menu entry"
desktop_script="$SCRIPT_DIR/create-desktop-entry.sh"
if [ ! -f "$desktop_script" ]; then
    err "create-desktop-entry.sh was not found next to install-codex.sh. Download all installer files into the same folder and try again."
    exit 1
fi
bash "$desktop_script" "$launcher_dest" "$INSTALL_DIR"

echo
echo "Install complete."
echo "Look for '$APP_NAME' in your applications menu (or on your Desktop), and click it to launch Codex."
echo "You can also run it directly: $launcher_dest"
