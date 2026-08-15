#!/usr/bin/env bash
#
# Launcher for the OpenAI Codex CLI, invoked by the "OpenAI Codex"
# application menu / Desktop entry.
#
# Starts the interactive Codex CLI session. On error, the window stays
# open with a readable message instead of closing immediately.

set -u

pause() {
    echo
    echo "Press Enter to close this window..."
    read -r _ || true
}

if ! command -v codex >/dev/null 2>&1; then
    echo "The 'codex' command was not found on PATH."
    echo "Re-run install-codex.sh, or run: npm install -g @openai/codex"
    pause
    exit 1
fi

echo "Starting OpenAI Codex CLI..."
echo
codex
status=$?

if [ "$status" -ne 0 ]; then
    echo
    echo "OpenAI Codex CLI exited with an error (code $status)."
    pause
fi

exit "$status"
