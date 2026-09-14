# Install the opencode-never-stop plugin into the global opencode config.
# Works on Windows (PowerShell 5.1+). Run from a normal prompt:
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#
# The plugin has no runtime dependencies, so nothing needs to be built or
# installed — this script only copies files and creates a default config.
# Re-running it (e.g. after pulling updates) simply reinstalls.

$ErrorActionPreference = "Stop"

function Write-JsonFile {
    param([string]$Path, [string]$Json)
    [System.IO.File]::WriteAllText($Path, $Json, (New-Object System.Text.UTF8Encoding($false)))
}

$RepoDir = Split-Path -Parent $PSScriptRoot
$ConfigDir = Join-Path $env:USERPROFILE ".config\opencode"
$PluginsDir = Join-Path $ConfigDir "plugins"
$CommandsDir = Join-Path $ConfigDir "commands"
$ConfigFile = Join-Path $ConfigDir "opencode-never-stop.json"

Write-Host "=== opencode-never-stop installer (Windows) ==="

# --- 1. copy plugin ----------------------------------------------------------
$PluginSrc = Join-Path $RepoDir "plugin\opencode-never-stop.ts"
if (-not (Test-Path $PluginSrc)) {
    Write-Error "ERROR: $PluginSrc not found. Run this script from the repo."
    exit 1
}

Write-Host "1. copying plugin -> $PluginsDir\opencode-never-stop.ts"
New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null
Copy-Item -Force $PluginSrc (Join-Path $PluginsDir "opencode-never-stop.ts")

# --- 2. copy commands --------------------------------------------------------
Write-Host "2. copying commands -> $CommandsDir\"
New-Item -ItemType Directory -Force -Path $CommandsDir | Out-Null
Copy-Item -Force (Join-Path $RepoDir "commands\opencode-never-stop.md") (Join-Path $CommandsDir "opencode-never-stop.md")
Copy-Item -Force (Join-Path $RepoDir "commands\opencode-stop.md") (Join-Path $CommandsDir "opencode-stop.md")

# --- 3. create default config (never overwrite) -------------------------------
$emDash = [char]0x2014
$DefaultConfig = @{
    checkIntervalSeconds = 15
    message = "Have you done all your assignments? If anything is left, continue $emDash or spend some more time double-checking your work."
}
if (Test-Path $ConfigFile) {
    Write-Host "3. config already exists: $ConfigFile (not overwriting)"
} else {
    Write-Host "3. creating default config -> $ConfigFile"
    $json = $DefaultConfig | ConvertTo-Json
    Write-JsonFile -Path $ConfigFile -Json $json
}

Write-Host ""
Write-Host "=== done. Restart opencode for the changes to apply. ==="
Write-Host "    Plugin loaded from: $PluginsDir\opencode-never-stop.ts"
Write-Host "    Commands: /opencode-never-stop (start), /opencode-stop (stop)"
Write-Host "    Config:   $ConfigFile"
Write-Host "    Reinstall (e.g. after pulling updates): rerun .\scripts\install.ps1"