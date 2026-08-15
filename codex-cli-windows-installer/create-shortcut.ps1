<#
.SYNOPSIS
    Creates "OpenAI Codex" Desktop and Start Menu shortcuts.

.DESCRIPTION
    Builds a .lnk shortcut that opens PowerShell and runs launch-codex.ps1.
    Uses a custom icon (codex.ico) next to the launcher if one exists,
    otherwise falls back to the standard PowerShell icon. Only writes to the
    current user's Desktop and Start Menu folders, so no administrator
    rights are required.

.PARAMETER LauncherPath
    Full path to launch-codex.ps1 (already copied into the install folder).

.PARAMETER InstallDir
    Full path to the install folder, used as the shortcut's working
    directory and to look for an optional codex.ico.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$LauncherPath,

    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

$ErrorActionPreference = 'Stop'

$ShortcutName = 'OpenAI Codex.lnk'
$Desktop      = [Environment]::GetFolderPath('Desktop')
$StartMenu    = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'

$powershellExe = (Get-Command powershell.exe).Source

$iconCandidate = Join-Path $InstallDir 'codex.ico'
$iconLocation = if (Test-Path $iconCandidate) {
    "$iconCandidate,0"
} else {
    "$powershellExe,0"
}

function New-CodexShortcut {
    param([string]$Directory)

    if (-not (Test-Path $Directory)) {
        New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    }

    $shortcutPath = Join-Path $Directory $ShortcutName
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershellExe
    $shortcut.Arguments = "-NoLogo -ExecutionPolicy Bypass -File `"$LauncherPath`""
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.IconLocation = $iconLocation
    $shortcut.Description = 'Launch OpenAI Codex CLI'
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    return $shortcutPath
}

try {
    $desktopShortcut = New-CodexShortcut -Directory $Desktop
    Write-Host "    Created Desktop shortcut: $desktopShortcut" -ForegroundColor Green

    $startMenuShortcut = New-CodexShortcut -Directory $StartMenu
    Write-Host "    Created Start Menu shortcut: $startMenuShortcut" -ForegroundColor Green
}
catch {
    Write-Host "    Failed to create shortcuts: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
