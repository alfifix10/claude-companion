@echo off
REM ===================================================================
REM Claude Companion - launch the browser WITHOUT the debugger banner.
REM
REM The "... started debugging this browser" bar steals ~36px from the
REM top of every page (hiding part of the page and the top of the orange
REM automation border). Chrome's --silent-debugger-extension-api flag
REM removes it permanently -- but ONLY on a FRESH browser process. So this
REM script closes the browser first (your tabs restore on relaunch if
REM "Continue where you left off" is on), then relaunches it with the flag.
REM
REM Use this every time you start the browser for automation. You can pin
REM it to the taskbar or make a desktop shortcut to it.
REM ===================================================================
setlocal
title Claude Companion - Clean Browser Launch

set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
  "%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"
) do (
  if exist "%%~P" if not defined BROWSER set "BROWSER=%%~P"
)

if not defined BROWSER (
  echo.
  echo Could not find Chrome or Brave in the usual locations.
  echo Edit this file and set BROWSER to your browser's full exe path.
  echo.
  pause
  exit /b 1
)

for %%F in ("%BROWSER%") do set "EXE=%%~nxF"

echo.
echo Browser: %BROWSER%
echo Closing %EXE% so the no-banner flag can take effect...
echo (Your tabs reopen if "Continue where you left off" is enabled.)
taskkill /IM "%EXE%" >nul 2>&1
timeout /t 3 /nobreak >nul

echo Relaunching with the debugger banner suppressed...
start "" "%BROWSER%" --silent-debugger-extension-api

echo.
echo Done. The page and the orange border now show in FULL during automation.
timeout /t 2 /nobreak >nul
endlocal
