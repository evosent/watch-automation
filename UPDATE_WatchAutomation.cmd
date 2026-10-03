@echo off
setlocal
cd /d "%~dp0"
node dev\update-watch-automation.mjs
if errorlevel 1 echo.
if errorlevel 1 echo Update failed. Read the message above and try again.
pause
