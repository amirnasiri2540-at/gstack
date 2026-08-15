<#
.SYNOPSIS
    Launcher for the OpenAI Codex CLI, invoked by the "OpenAI Codex" shortcuts.

.DESCRIPTION
    Opens a PowerShell window, checks that the codex command is available,
    and starts the interactive Codex CLI session. On error, the window stays
    open with a readable message instead of flashing closed.
#>

$Host.UI.RawUI.WindowTitle = 'OpenAI Codex'
$ErrorActionPreference = 'Stop'

function Wait-ForKeyThenExit {
    param([int]$Code)
    Write-Host ""
    Write-Host "Press any key to close this window..." -ForegroundColor DarkGray
    [void][System.Console]::ReadKey($true)
    exit $Code
}

try {
    if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
        Write-Host "The 'codex' command was not found on PATH." -ForegroundColor Red
        Write-Host "Re-run install-codex.ps1, or run 'npm install -g @openai/codex' manually." -ForegroundColor Yellow
        Wait-ForKeyThenExit 1
    }

    Write-Host "Starting OpenAI Codex CLI..." -ForegroundColor Cyan
    Write-Host ""
    codex
    exit 0
}
catch {
    Write-Host ""
    Write-Host "OpenAI Codex CLI exited with an error:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Wait-ForKeyThenExit 1
}
