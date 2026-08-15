#!/usr/bin/env bash
#
# Creates an "OpenAI Codex" application menu entry (and Desktop shortcut,
# if a Desktop folder exists) using the freedesktop.org .desktop format.
# Works across GNOME, KDE, XFCE, and other standard Linux desktops -
# Terminal=true tells the desktop environment to open the user's default
# terminal emulator itself, so this does not hardcode gnome-terminal,
# konsole, xterm, etc.
#
# Usage: create-desktop-entry.sh <launcher-path> <install-dir>

set -euo pipefail

LAUNCHER_PATH="${1:?Usage: create-desktop-entry.sh <launcher-path> <install-dir>}"
INSTALL_DIR="${2:?Usage: create-desktop-entry.sh <launcher-path> <install-dir>}"

APPS_DIR="$HOME/.local/share/applications"
DESKTOP_FILE_NAME="openai-codex.desktop"

mkdir -p "$APPS_DIR"

icon="utilities-terminal"
icon_candidate="$INSTALL_DIR/codex.png"
if [ -f "$icon_candidate" ]; then
    icon="$icon_candidate"
fi

write_desktop_file() {
    local dest="$1"
    cat > "$dest" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=OpenAI Codex
Comment=Launch OpenAI Codex CLI
Exec=$LAUNCHER_PATH
Icon=$icon
Terminal=true
Categories=Development;Utility;
EOF
    chmod +x "$dest"
}

write_desktop_file "$APPS_DIR/$DESKTOP_FILE_NAME"
echo "    Created application menu entry: $APPS_DIR/$DESKTOP_FILE_NAME"

if [ -d "$HOME/Desktop" ]; then
    desktop_shortcut="$HOME/Desktop/$DESKTOP_FILE_NAME"
    write_desktop_file "$desktop_shortcut"
    if command -v gio >/dev/null 2>&1; then
        gio set "$desktop_shortcut" metadata::trusted true 2>/dev/null || true
    fi
    echo "    Created Desktop shortcut: $desktop_shortcut"
fi
