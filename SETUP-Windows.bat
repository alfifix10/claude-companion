@echo off
chcp 65001 >nul
title Claude Companion - Setup
cd /d "%~dp0"
set "EXT_ID=bciopdghgdndoedlgbbcffgaebjbkago"

echo ==================================================
echo    Claude Companion  -  One-time Setup
echo ==================================================
echo.
echo This sets up everything except loading the extension
echo (the last manual step, shown at the end).
echo.

REM [1/4] Node.js -----------------------------------------------------------
where node >nul 2>nul
if not errorlevel 1 goto node_ok
echo [X] Node.js is not installed.
where winget >nul 2>nul
if errorlevel 1 (
  echo     Install the LTS version from https://nodejs.org  then run this again.
  start "" https://nodejs.org
  echo.
  pause
  exit /b 1
)
echo     Installing Node.js LTS via winget ^(approve any prompt^) ...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
echo.
echo     Node.js installed. Please CLOSE this window and run setup again
echo     so the new PATH takes effect.
echo.
pause
exit /b 0
:node_ok
for /f "delims=" %%v in ('node -v') do echo [1/4] Node.js %%v found.

REM [2/4] Claude CLI --------------------------------------------------------
where claude >nul 2>nul
if errorlevel 1 (
  echo [2/4] Installing Claude CLI ...
  call npm install -g @anthropic-ai/claude-code
) else (
  echo [2/4] Claude CLI already installed.
)

REM [3/4] Login (needs a Claude Max subscription) ---------------------------
echo [3/4] Logging in to Claude  ^(a browser window may open^) ...
call claude login

REM [4/4] Register the local native host -----------------------------------
echo [4/4] Setting up the local host ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %EXT_ID%

echo.
echo ==================================================
echo   Almost done! Final step, in your browser:
echo     1^) Open   chrome://extensions
echo     2^) Turn on  "Developer mode"   (top-right)
echo     3^) Click  "Load unpacked"  and choose this folder:
echo          %~dp0extension
echo ==================================================
echo.
pause
