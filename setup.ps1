# Claude Companion - One-click setup bootstrap (Windows)
# Launches the wizard in your browser.

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$WizardJs = Join-Path $ScriptDir "setup\wizard.mjs"

function Write-Section($msg) {
    Write-Host ""
    Write-Host "   $msg" -ForegroundColor Cyan
    Write-Host "   ------------------------------------------------------------" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Claude Companion - Setup Wizard" -ForegroundColor Yellow
Write-Host ""

# 1. Check Node
Write-Section "Checking Node.js..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "   [X] Node.js not found." -ForegroundColor Red
    Write-Host ""
    $ans = Read-Host "   Install via winget? [Y/n]"
    if ([string]::IsNullOrEmpty($ans) -or $ans -eq "Y" -or $ans -eq "y") {
        Write-Host "   Installing... (may need UAC)" -ForegroundColor Yellow
        try {
            winget install -e --id OpenJS.NodeJS --accept-source-agreements --accept-package-agreements
            # Refresh PATH
            $machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
            $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
            $env:Path = "$machinePath;$userPath"
        } catch {
            Write-Host "   winget failed. Download Node manually from https://nodejs.org" -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }
    } else {
        Write-Host "   Download Node from https://nodejs.org then re-run this script." -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 1
    }
} else {
    Write-Host "   [OK] Node.js found: $($node.Source)" -ForegroundColor Green
}

# 2. Install host deps
Write-Section "Preparing host dependencies..."
$hostDir = Join-Path $ScriptDir "host"
if (-not (Test-Path (Join-Path $hostDir "node_modules"))) {
    Push-Location $hostDir
    try {
        npm install --silent 2>&1 | Out-Null
        Write-Host "   [OK] Installed" -ForegroundColor Green
    } finally { Pop-Location }
} else {
    Write-Host "   [OK] Already installed" -ForegroundColor Green
}

# 3. Launch wizard
Write-Section "Launching wizard in your browser..."
Write-Host "   URL: http://127.0.0.1:5557" -ForegroundColor DarkGray
Write-Host ""
Write-Host "   Keep this window open until done." -ForegroundColor Yellow
Write-Host ""

node "$WizardJs"
