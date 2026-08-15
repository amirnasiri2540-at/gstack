# OpenAI Codex CLI — Linux Installer

A one-command installer for the [OpenAI Codex CLI](https://www.npmjs.com/package/@openai/codex)
on Linux (tested on Debian/Ubuntu, works anywhere with `bash` and `npm`).
Installs the CLI via npm and adds an "OpenAI Codex" entry to your
applications menu (plus a Desktop shortcut, if you have a Desktop folder).

## What it does

1. Checks that Node.js and npm are installed (and tells you clearly if
   they're not — it never installs Node/npm for you).
2. Checks whether the `codex` command already exists. If it does, the
   `npm install -g @openai/codex` step is **skipped** — running the
   installer again on a machine that already has everything is safe and
   fast, it just refreshes the launcher and menu entry. Pass `--force` to
   `install-codex.sh` if you want to force a reinstall anyway.
3. Copies a launcher script to `~/.local/share/openai-codex`.
4. Creates an "OpenAI Codex" `.desktop` entry in
   `~/.local/share/applications` (and on your Desktop, if present) that
   opens your default terminal and starts `codex`.

No root privileges are required, unless your system's npm global folder
isn't writable by your user — the script detects that automatically and
only uses `sudo` in that case.

## Install

**Prerequisite:** Node.js and npm (e.g. `sudo apt install nodejs npm` on
Debian/Ubuntu, or from https://nodejs.org/).

### Option A — you already have this folder

```bash
bash install-codex.sh
```

### Option B — one-liner (no clone needed)

```bash
dir=$(mktemp -d) && for f in install-codex.sh launch-codex.sh create-desktop-entry.sh; do curl -fsSL -o "$dir/$f" "https://raw.githubusercontent.com/amirnasiri2540-at/gstack/claude/codex-cli-windows-installer-732wam/codex-cli-linux-installer/$f"; done && bash "$dir/install-codex.sh"
```

When it finishes, look for **OpenAI Codex** in your applications menu (or
on your Desktop) and click it to launch Codex.

## Logging in

Installing the CLI is not the same as authenticating it. The first time,
run either:

```bash
codex login                       # opens a browser-based login flow
# or
echo "sk-..." | codex login --with-api-key   # if you have an OpenAI API key
```

This installer cannot do this step for you — it needs your own OpenAI
account/credentials.

## Files

| File | Purpose |
|------|---------|
| `install-codex.sh` | Main entry point. Verifies Node/npm, installs the CLI, sets up the launcher and menu entry. Run this one. |
| `launch-codex.sh` | Copied into the install folder; the menu/Desktop entry points at this. Starts `codex` and keeps the terminal open if something goes wrong. |
| `create-desktop-entry.sh` | Called by `install-codex.sh`. Creates the `.desktop` application entry (and Desktop shortcut). |
| `codex.png` (optional) | Drop a `.png` icon with this name next to the installer scripts before running `install-codex.sh` for a custom icon. Without it, the standard `utilities-terminal` icon is used. |

## Troubleshooting

- **"Node.js was not found on PATH"** — install it via your package
  manager (`sudo apt install nodejs npm` on Debian/Ubuntu) or from
  https://nodejs.org/, then re-run the installer.
- **`sudo npm install -g @openai/codex` fails** — check the npm output
  above; usually a network issue.
- **Don't use `sudo snap install codex`** — that installs an unrelated
  snap package. This installer uses the real `@openai/codex` npm package.
- **Menu entry appears but says "Untrusted application launcher"** on
  GNOME/Nautilus — right-click the Desktop icon and choose "Allow
  Launching" once; menu entries under Activities/App menu don't need this.
- **Says "codex command was not found" when launched** — open a new
  terminal and run `npm install -g @openai/codex` manually (PATH changes
  need a fresh shell), then try again.
