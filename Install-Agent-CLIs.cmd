@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Zero3 Pilot - Install agent CLIs
chcp 65001 >nul

rem This file stays ASCII on purpose. cmd.exe re-reads a batch file line by line
rem while it runs, so multi-byte text after `chcp 65001` corrupts the parse and
rem sends control flow into the wrong branch.

echo.
echo   Zero3 Pilot - installing the Claude Code and Codex CLIs
echo.

rem ------------------------------------------------------------------------
rem Refuse to run inside a packaged (MSIX) container.
rem
rem A packaged app virtualises %%APPDATA%%: an npm global install started from
rem inside one lands in <package>\LocalCache\Roaming\npm, a private overlay that
rem looks perfectly normal from inside the package and does not exist for anyone
rem else. Zero3 then reports both CLIs as not installed and every check run from
rem inside that same container disagrees with it. Detect the overlay by writing
rem a marker and looking for it in the per-package cache.
rem ------------------------------------------------------------------------
set "PROBE_NAME=zero3-cli-install-probe.tmp"
set "PROBE=%APPDATA%\%PROBE_NAME%"
set "VIRTUALIZED="
break > "%PROBE%" 2>nul
if not exist "%PROBE%" goto :no_appdata
for /d %%P in ("%LOCALAPPDATA%\Packages\*") do (
  if exist "%%~fP\LocalCache\Roaming\%PROBE_NAME%" set "VIRTUALIZED=%%~nxP"
)
del "%PROBE%" >nul 2>&1
if defined VIRTUALIZED goto :virtualized
goto :check_npm

:no_appdata
echo   [X] Could not write to %%APPDATA%% (%APPDATA%).
echo.
pause
exit /b 1

:virtualized
echo   [X] This window is running inside a packaged app container:
echo       %VIRTUALIZED%
echo.
echo       Anything installed from here goes into that package's private
echo       AppData, where Zero3 - and every other program - cannot see it.
echo.
echo       Close this window. Open PowerShell or CMD from the Start menu,
echo       or double-click Install-Agent-CLIs.cmd in Explorer, and run it
echo       again. Do not let an AI assistant or its terminal run it for you.
echo.
pause
exit /b 1

:check_npm
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo   [X] npm was not found. Install Node.js 24 LTS, then run this again.
  echo.
  pause
  exit /b 1
)
echo   [ok] Not containerised; global installs will land in %APPDATA%\npm
echo.

rem `call` is required: npm.cmd is a batch file, and without it control never
rem returns to this script.
rem
rem --allow-scripts is scoped to this one package on purpose. claude-code ships
rem a postinstall that places the actual claude.exe; skip it and npm still exits
rem zero, leaving a shim that points at a binary which was never written. The
rem flag is not set globally - nothing else gets to run install scripts.
echo   Installing @anthropic-ai/claude-code ...
call npm.cmd install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code
if errorlevel 1 goto :install_failed
echo.
echo   Installing @openai/codex ...
call npm.cmd install -g @openai/codex
if errorlevel 1 goto :install_failed

echo.
echo   Verifying...
set "NPM_BIN=%APPDATA%\npm"
if not exist "%NPM_BIN%\claude.cmd" goto :verify_failed
if not exist "%NPM_BIN%\codex.cmd" goto :verify_failed

rem The shim existing proves nothing: it is a text file that names a target npm
rem may never have written. Run each CLI instead - that exercises the same chain
rem Zero3 does, shim through to binary.
set "BROKEN="
for /f "tokens=*" %%V in ('call "%NPM_BIN%\claude.cmd" --version 2^>nul') do set "CLAUDE_VERSION=%%V"
if not defined CLAUDE_VERSION set "BROKEN=claude"
for /f "tokens=*" %%V in ('call "%NPM_BIN%\codex.cmd" --version 2^>nul') do set "CODEX_VERSION=%%V"
if not defined CODEX_VERSION set "BROKEN=%BROKEN% codex"
if defined BROKEN goto :cli_broken

echo   [ok] claude  %CLAUDE_VERSION%
echo   [ok] codex   %CODEX_VERSION%
echo.
echo   Done. Next steps:
echo     1. In the Zero3 source console, press R to reload.
echo     2. Open a new session. Codex should read as ready.
echo     3. Claude Code will read as unauthorized until you sign in:
echo        run "claude auth login", or use the button in the dialog.
echo.
pause
exit /b 0

:install_failed
echo.
echo   [X] npm reported a failure above. Nothing was verified.
echo.
pause
exit /b 1

:verify_failed
echo.
echo   [X] npm finished but the shims are not in %NPM_BIN%.
echo       Check "npm config get prefix" - a redirected prefix puts global
echo       packages somewhere Zero3 does not search.
echo.
pause
exit /b 1

:cli_broken
echo.
echo   [X] Installed, but these did not run:%BROKEN%
echo.
echo       The shim is there and its target is not, which is what a skipped
echo       postinstall looks like. Allow that package's install script once:
echo.
echo         npm.cmd install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code
echo.
pause
exit /b 1
