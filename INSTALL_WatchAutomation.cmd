@echo off
setlocal
set "ROOT=%~dp0"
set "PS1=%ROOT%Install_WatchAutomation.ps1"
if not exist "%PS1%" (
  echo Install_WatchAutomation.ps1 not found.
  exit /b 1
)

set "ARCHIVE="
for /f "delims=" %%Z in ('dir /b /a:-d "%ROOT%WatchAutomation_*.zip" 2^>nul') do if not defined ARCHIVE set "ARCHIVE=%ROOT%%%Z"

if defined ARCHIVE (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -ArchivePath "%ARCHIVE%"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -SkipExtract -InstallRoot "%ROOT%"
)
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" pause
endlocal & exit /b %EXITCODE%
