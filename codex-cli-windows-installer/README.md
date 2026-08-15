# OpenAI Codex CLI — Windows Installer

A one-command installer for the [OpenAI Codex CLI](https://www.npmjs.com/package/@openai/codex)
on Windows. Installs the CLI via npm and creates an "OpenAI Codex" shortcut
on your Desktop and in the Start Menu, so you never have to open a terminal
by hand again.

## What it does

1. Checks that Node.js and npm are installed (and tells you clearly if
   they're not — it never installs Node/npm for you).
2. Checks whether the `codex` command already exists. If it does, the
   `npm install -g @openai/codex` step is **skipped** — running the
   installer again on a machine that already has everything is safe and
   fast, it just refreshes the launcher and shortcuts. Pass `-Force` to
   `install-codex.ps1` if you want to force a reinstall anyway.
3. Copies a launcher script to `%LOCALAPPDATA%\OpenAICodex`.
4. Creates "OpenAI Codex" shortcuts on your Desktop and in the Start Menu
   that open a PowerShell window and start `codex`.

No administrator rights are required — everything installs to your user
profile. Already have some of the prerequisites? Nothing extra to do —
the script detects what's present and only installs what's missing.

## Install

**Prerequisite:** [Node.js](https://nodejs.org/) (which includes npm).

### Option A — you already have this folder

Open PowerShell in this folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File install-codex.ps1
```

### Option B — one-liner (no clone needed)

Paste this into PowerShell to download the three installer files and run
the installer, all in one step:

```powershell
$dir = Join-Path $env:TEMP 'openai-codex-installer'; New-Item -ItemType Directory -Force -Path $dir | Out-Null; foreach ($f in 'install-codex.ps1','launch-codex.ps1','create-shortcut.ps1') { Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/amirnasiri2540-at/gstack/main/codex-cli-windows-installer/$f" -OutFile (Join-Path $dir $f) }; powershell -ExecutionPolicy Bypass -File (Join-Path $dir 'install-codex.ps1')
```

When it finishes, look for **OpenAI Codex** on your Desktop or in the Start
Menu and click it to launch Codex.

## Files

| File | Purpose |
|------|---------|
| `install-codex.ps1` | Main entry point. Verifies Node/npm, installs the CLI, sets up the launcher and shortcuts. Run this one. |
| `launch-codex.ps1` | Copied into the install folder; the shortcuts point at this. Starts `codex` in a PowerShell window and keeps the window open if something goes wrong. |
| `create-shortcut.ps1` | Called by `install-codex.ps1`. Creates the Desktop and Start Menu `.lnk` shortcuts. |
| `codex.ico` (optional) | Drop a `.ico` file with this name next to the installer scripts before running `install-codex.ps1` to give the shortcuts a custom icon. Without it, the shortcuts use the PowerShell icon. |

## Troubleshooting

- **"Node.js was not found on PATH"** — install Node.js from
  https://nodejs.org/, then re-run the installer.
- **"npm install exited with code ..."** — scroll up in the terminal for
  npm's own error output; it's usually a network or permissions issue.
- **Shortcut runs but says "codex command was not found"** — open a new
  PowerShell window and run `npm install -g @openai/codex` manually, then
  try the shortcut again (PATH changes need a fresh terminal).
- **Script won't run at all** — Windows may block scripts downloaded from
  the internet. Run installs via
  `powershell -ExecutionPolicy Bypass -File install-codex.ps1` as shown
  above; this only changes the policy for that one process.
