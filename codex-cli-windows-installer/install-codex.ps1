<#
.SYNOPSIS
    One-command installer for the OpenAI Codex CLI on Windows.

.DESCRIPTION
    - Verifies Node.js and npm are installed.
    - Installs the OpenAI Codex CLI globally via npm.
    - Copies the launcher script into a per-user install folder.
    - Creates "OpenAI Codex" shortcuts on the Desktop and in the Start Menu.

.USAGE
    Download this file together with launch-codex.ps1 and create-shortcut.ps1
    into the same folder, then run:

        powershell -ExecutionPolicy Bypass -File install-codex.ps1

    No administrator rights are required.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$AppName    = 'OpenAI Codex'
$InstallDir = Join-Path $env:LOCALAPPDATA 'OpenAICodex'
$ScriptDir  = $PSScriptRoot

function Write-Step { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "    OK: $Message" -ForegroundColor Green }
function Write-Err  { param([string]$Message) Write-Host "    ERROR: $Message" -ForegroundColor Red }

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

try {
    Write-Host "OpenAI Codex CLI - Windows Installer" -ForegroundColor Magenta
    Write-Host "======================================" -ForegroundColor Magenta

    Write-Step "Checking for Node.js"
    if (-not (Test-CommandExists 'node')) {
        Write-Err "Node.js was not found on PATH."
        Write-Host "    Install Node.js (it includes npm) from https://nodejs.org/ and re-run this script." -ForegroundColor Yellow
        exit 1
    }
    Write-Ok "Node.js $(node -v) found"

    Write-Step "Checking for npm"
    if (-not (Test-CommandExists 'npm')) {
        Write-Err "npm was not found on PATH."
        Write-Host "    npm ships with Node.js. Reinstall Node.js from https://nodejs.org/ and re-run this script." -ForegroundColor Yellow
        exit 1
    }
    Write-Ok "npm $(npm -v) found"

    Write-Step "Installing OpenAI Codex CLI (npm install -g @openai/codex)"
    npm install -g @openai/codex
    if ($LASTEXITCODE -ne 0) {
        throw "npm install exited with code $LASTEXITCODE. Check the npm output above for details."
    }
    Write-Ok "OpenAI Codex CLI installed"

    Write-Step "Verifying the codex command is available"
    if (-not (Test-CommandExists 'codex')) {
        throw "The 'codex' command was not found after installation. Open a new terminal and try 'npm install -g @openai/codex' manually, then re-run this script."
    }
    Write-Ok "codex command is available"

    Write-Step "Setting up the launcher"
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

    $launcherSource = Join-Path $ScriptDir 'launch-codex.ps1'
    if (-not (Test-Path $launcherSource)) {
        throw "launch-codex.ps1 was not found next to install-codex.ps1. Download all installer files into the same folder and try again."
    }
    $launcherDest = Join-Path $InstallDir 'launch-codex.ps1'
    Copy-Item -Path $launcherSource -Destination $launcherDest -Force

    $iconSource = Join-Path $ScriptDir 'codex.ico'
    if (Test-Path $iconSource) {
        Copy-Item -Path $iconSource -Destination (Join-Path $InstallDir 'codex.ico') -Force
    }
    Write-Ok "Launcher installed to $InstallDir"

    Write-Step "Creating Desktop and Start Menu shortcuts"
    $shortcutScript = Join-Path $ScriptDir 'create-shortcut.ps1'
    if (-not (Test-Path $shortcutScript)) {
        throw "create-shortcut.ps1 was not found next to install-codex.ps1. Download all installer files into the same folder and try again."
    }
    & $shortcutScript -LauncherPath $launcherDest -InstallDir $InstallDir
    if ($LASTEXITCODE -ne 0) {
        throw "Shortcut creation failed. See the error above."
    }

    Write-Host "`nInstall complete." -ForegroundColor Green
    Write-Host "Look for '$AppName' on your Desktop or in the Start Menu, and click it to launch Codex." -ForegroundColor Green
}
catch {
    Write-Err $_.Exception.Message
    Write-Host "`nInstallation did not finish. Fix the issue above and re-run this script." -ForegroundColor Red
    exit 1
}
