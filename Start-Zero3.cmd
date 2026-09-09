@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Zero3 Pilot - Source Console
chcp 65001 >nul

rem This file stays ASCII on purpose. cmd.exe re-reads a batch file line by line
rem while it runs, so multi-byte text after `chcp 65001` corrupts the parse and
rem sends control flow into the wrong branch. Localised messages belong in the
rem Node console, which handles UTF-8 properly.

set "ZERO3_RELAUNCH_FLAG=%TEMP%\zero3-relaunch.flag"

rem A console handed down from an agent, an MCP server or a sandboxed shell
rem keeps that parent's limits: files outside the workspace stay invisible and
rem the network can be off. Zero3 then probes the machine through that keyhole
rem and reports installed CLIs as missing. Environment variables cannot undo an
rem OS-level restriction, so the only fix is to leave that process tree: ask
rem Explorer to open this script, which starts it under the desktop shell.
if defined CODEX_SANDBOX_NETWORK_DISABLED goto :restricted
if defined CODEX_PERMISSION_PROFILE goto :restricted
if defined CODEX_SESSION_ID goto :restricted
goto :clean

:restricted
rem The relaunched console clears this flag on its way through, so a flag that
rem is still here means the escape did not work and asking again would loop.
if exist "%ZERO3_RELAUNCH_FLAG%" goto :escape_failed
break > "%ZERO3_RELAUNCH_FLAG%"
echo [Zero3] This console is sandboxed; local CLI detection would fail here.
echo [Zero3] Relaunching through Explorer with a normal environment...
explorer.exe "%~f0"
exit /b 0

:escape_failed
del "%ZERO3_RELAUNCH_FLAG%" >nul 2>&1
echo [Zero3] Still sandboxed after relaunching. Stopped.
echo.
echo   Start it yourself: double-click Start-Zero3.cmd in Explorer,
echo   or run it from an ordinary CMD / PowerShell window.
echo   Do not let an AI assistant or MCP tool launch it - Zero3 inherits
echo   their sandbox and then reports every installed CLI as missing.
echo.
pause
exit /b 1

:clean
del "%ZERO3_RELAUNCH_FLAG%" >nul 2>&1
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install Node.js 24 LTS, then try again.
  pause
  exit /b 1
)
node "%~dp0apps\zero3-desktop\scripts\dev-console.mjs"
if errorlevel 1 pause
endlocal
