@echo off
setlocal
cd /d "%~dp0"
title Zero3 Pilot - Source Console
chcp 65001 >nul
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install Node.js 24 LTS, then try again.
  pause
  exit /b 1
)
node "%~dp0apps\zero3-desktop\scripts\dev-console.mjs"
if errorlevel 1 pause
endlocal
