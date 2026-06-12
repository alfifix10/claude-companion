# Claude Companion - Windows installer
#
# Registers the native messaging host for every Chromium browser on this
# machine, auto-detects the extension ID from installed browsers' profiles,
# and (optionally) wires up Claude Code's MCP config.
#
# Usage:
#   .\install.ps1                          # auto-detect everything
#   .\install.ps1 <ext-id-1> <ext-id-2>    # explicit IDs (one per browser)

[CmdletBinding()]
param(
    [Parameter(Position=0, ValueFromRemainingArguments=$true)]
    [string[]]$ExtensionIds = @()
)

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$HostDir = Join-Path $ScriptDir "host"
$WrapperPath = Join-Path $HostDir "native-host-wrapper.bat"
$ManifestPath = Join-Path $HostDir "com.anthropic.claude_companion.json"
$HostName = "com.anthropic.claude_companion"
$McpServer = Join-Path $HostDir "mcp-server.js"

# --------------------------------------------------------------------------
# 1. Verify Node.js
# --------------------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Error: Node.js not found on PATH. Install from https://nodejs.org (v18+)." -ForegroundColor Red
    exit 1
}
$nodePath = $node.Source
Write-Host "[1/5] Node.js found: $nodePath" -ForegroundColor Green

# --------------------------------------------------------------------------
# 2. Install host npm deps
# --------------------------------------------------------------------------
if (-not (Test-Path (Join-Path $HostDir "node_modules"))) {
    Write-Host "[2/5] Installing host dependencies..." -ForegroundColor Cyan
    Push-Location $HostDir
    try { & npm install --silent } finally { Pop-Location }
} else {
    Write-Host "[2/5] Host dependencies ready." -ForegroundColor Green
}

# --------------------------------------------------------------------------
# 3. Auto-detect extension IDs from browser profiles
# --------------------------------------------------------------------------
function Find-ExtensionIds {
    $targetPath = $ScriptDir + "\extension"
    $needle = "claude-companion"
    $browsers = @(
        @{ Name = "Brave";    Root = "$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\User Data" },
        @{ Name = "Chrome";   Root = "$env:LOCALAPPDATA\Google\Chrome\User Data" },
        @{ Name = "Edge";     Root = "$env:LOCALAPPDATA\Microsoft\Edge\User Data" },
        @{ Name = "Chromium"; Root = "$env:LOCALAPPDATA\Chromium\User Data" }
    )
    $found = @{}
    foreach ($b in $browsers) {
        if (-not (Test-Path $b.Root)) { continue }
        $profiles = Get-ChildItem -Path $b.Root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq "Default" -or $_.Name -match "^Profile \d+$" }
        foreach ($p in $profiles) {
            foreach ($prefs in @("Secure Preferences", "Preferences")) {
                $f = Join-Path $p.FullName $prefs
                if (-not (Test-Path $f)) { continue }
                try {
                    $j = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json
                    $settings = $j.extensions.settings
                    if (-not $settings) { continue }
                    foreach ($prop in $settings.PSObject.Properties) {
                        $id = $prop.Name
                        $path = $prop.Value.path
                        if ($path -and $path.ToLower().Contains($needle)) {
                            $found[$id] = "$($b.Name)/$($p.Name)"
                        }
                    }
                } catch {}
            }
        }
    }
    return $found
}

# The extension ships a fixed `key` in manifest.json, so its ID is CONSTANT
# on every machine: bciopdghgdndoedlgbbcffgaebjbkago. That lets us register
# the native host for it BEFORE the extension is ever loaded — which kills
# the old chicken-and-egg trap: install used to scan for an already-loaded
# extension and `exit 1` if absent, but the natural order is to run setup
# first, THEN load unpacked. Now order doesn't matter.
$CanonicalExtId = "bciopdghgdndoedlgbbcffgaebjbkago"

if ($ExtensionIds.Count -eq 0) {
    Write-Host "[3/5] Scanning browsers for the extension..." -ForegroundColor Cyan
    $detected = Find-ExtensionIds
    if ($detected.Keys.Count -gt 0) {
        $ExtensionIds = @($detected.Keys)
        foreach ($id in $detected.Keys) {
            Write-Host "  => $id  [$($detected[$id])]" -ForegroundColor Green
        }
    } else {
        Write-Host "  Extension not loaded yet - registering the built-in fixed ID." -ForegroundColor DarkGray
        Write-Host "  (You can load it before OR after this step; order no longer matters.)" -ForegroundColor DarkGray
    }
} else {
    Write-Host "[3/5] Using provided extension IDs: $($ExtensionIds -join ', ')" -ForegroundColor Green
}
# ALWAYS register the canonical fixed ID too, de-duped. Detection stays a
# nicety (covers a dev who repacked with a different key); the fixed ID is
# the guarantee that a normal install just works.
$ExtensionIds = @($ExtensionIds + $CanonicalExtId | Select-Object -Unique)

# --------------------------------------------------------------------------
# 4. Write wrapper + manifest, register in each browser's registry
# --------------------------------------------------------------------------
$nativeHostScript = Join-Path $HostDir "native-host.js"
# The .bat wrapper MUST be UTF-8 without BOM:
#   - Out-File -Encoding ASCII mangles non-ASCII paths (Arabic/CJK user folders)
#   - Out-File -Encoding UTF8 writes a BOM which breaks cmd.exe
# `chcp 65001 >nul` switches cmd to UTF-8 so it can read the quoted paths.
$wrapperContent = "@echo off`r`nchcp 65001 >nul`r`n`"$nodePath`" `"$nativeHostScript`" %*`r`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($WrapperPath, $wrapperContent, $utf8NoBom)

$allowedOrigins = @($ExtensionIds | ForEach-Object { "chrome-extension://$_/" })
$manifest = [ordered]@{
    name             = $HostName
    description      = "Claude Companion Native Messaging Host"
    path             = $WrapperPath
    type             = "stdio"
    allowed_origins  = $allowedOrigins
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
# Chromium's native messaging spec requires UTF-8. No BOM — some Chromium
# forks reject a BOM at the start of the manifest.
[System.IO.File]::WriteAllText($ManifestPath, $manifestJson, $utf8NoBom)

Write-Host "[4/5] Registering with browsers:" -ForegroundColor Cyan
$browsers = @(
    @{ Name = "Google Chrome";    Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName" },
    @{ Name = "Microsoft Edge";   Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName" },
    @{ Name = "Brave Browser";    Key = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName" },
    @{ Name = "Chromium";         Key = "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName" },
    @{ Name = "Opera";            Key = "HKCU:\Software\Opera Software\Opera Stable\NativeMessagingHosts\$HostName" },
    @{ Name = "Vivaldi";          Key = "HKCU:\Software\Vivaldi\NativeMessagingHosts\$HostName" },
    @{ Name = "Arc";              Key = "HKCU:\Software\The Browser Company\Arc\NativeMessagingHosts\$HostName" }
)
foreach ($b in $browsers) {
    try {
        New-Item -Path $b.Key -Force | Out-Null
        Set-ItemProperty -Path $b.Key -Name "(Default)" -Value $ManifestPath
        Write-Host "      $($b.Name)  OK" -ForegroundColor Green
    } catch {
        Write-Host "      $($b.Name)  skipped ($($_.Exception.Message))" -ForegroundColor DarkGray
    }
}

# --------------------------------------------------------------------------
# 5. Auto-install Claude Code CLI if missing, then add MCP
# --------------------------------------------------------------------------
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    Write-Host "[5/5] Installing Claude Code CLI (global npm)..." -ForegroundColor Cyan
    try {
        & npm install -g "@anthropic-ai/claude-code" 2>&1 | Out-Null
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        $claude = Get-Command claude -ErrorAction SilentlyContinue
        if ($claude) { Write-Host "      Claude Code installed" -ForegroundColor Green }
    } catch {
        Write-Host "      npm install failed: $_" -ForegroundColor Yellow
    }
}
if ($claude) {
    Write-Host "[5/5] Registering MCP server with Claude Code..." -ForegroundColor Cyan
    try { & claude mcp remove claude-companion 2>$null | Out-Null } catch {}
    try {
        & claude mcp add --scope user claude-companion -- node "$McpServer" 2>&1 | Out-Null
        Write-Host "      MCP registered as 'claude-companion'" -ForegroundColor Green
    } catch {
        Write-Host "      Could not auto-register MCP: $_" -ForegroundColor Yellow
        Write-Host "      Run manually: claude mcp add --scope user claude-companion -- node `"$McpServer`"" -ForegroundColor DarkGray
    }
} else {
    Write-Host "[5/5] Claude Code CLI not found. After installing it, run:" -ForegroundColor Yellow
    Write-Host "      npm install -g @anthropic-ai/claude-code" -ForegroundColor DarkGray
    Write-Host "      claude login" -ForegroundColor DarkGray
    Write-Host "      claude mcp add --scope user claude-companion -- node `"$McpServer`"" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Done!" -ForegroundColor Green
Write-Host "Next: close all browser windows then reopen - the registry is re-read on startup." -ForegroundColor Cyan
