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
REM IMPORTANT: the command is `claude auth login`, NOT `claude login`.
REM `claude login` is not a subcommand — claude treats "login" as a PROMPT
REM and drops into the interactive TUI, hanging the installer. We also skip
REM the step entirely when already signed in (auth status reports loggedIn).
echo [3/4] Checking Claude sign-in ...
claude auth status 2>nul | findstr /r /i "loggedIn.*true" >nul
if errorlevel 1 (
  echo     Not signed in yet - opening sign-in ^(a browser window may open^) ...
  call claude auth login
) else (
  echo     Already signed in - skipping.
)

REM [4/4] Register the local native host -----------------------------------
REM Tee the host-registration output to a log file so a failure is never
REM lost if the window is closed too quickly. install.ps1 is non-interactive,
REM so capturing it is safe (unlike the login step above).
echo [4/4] Setting up the local host ...
set "LOG=%~dp0setup-log.txt"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& '%~dp0install.ps1' %EXT_ID% *>&1 | Tee-Object -FilePath '%LOG%'"

echo.
echo ==================================================
echo   Setup ran. A full log was saved to:
echo     %LOG%
echo   ^(If anything stays broken, open that file or send it for help.^)
echo.
echo   TWO STEPS LEFT in your browser:
echo.
echo   A^) RESTART YOUR BROWSER  ^<-- IMPORTANT
echo      Close EVERY browser window completely, then open it again.
echo      The browser only reads the new host on a fresh start, so the
echo      "Local server" check stays RED until you do this.
echo.
echo   B^) Load the extension:
echo      1^) Open   chrome://extensions
echo      2^) Turn on  "Developer mode"   (top-right)
echo      3^) Click  "Load unpacked"  and choose this folder:
echo            %~dp0extension
echo ==================================================
echo.
echo Press any key to close this window...
pause >nul
