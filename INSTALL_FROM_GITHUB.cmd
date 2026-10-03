@echo off
setlocal
set "INSTALLER=%TEMP%\WatchAutomation-GitHub-Installer-%RANDOM%-%RANDOM%.ps1"
set "WATCH_AUTOMATION_INSTALLER=%INSTALLER%"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/evosent/watch-automation/releases/latest/download/Install_From_GitHub.ps1' -OutFile $env:WATCH_AUTOMATION_INSTALLER"
if errorlevel 1 (
  echo Не удалось скачать установщик GitHub.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER%" %*
set "EXITCODE=%ERRORLEVEL%"
del "%INSTALLER%" >nul 2>nul
if not "%EXITCODE%"=="0" pause
endlocal & exit /b %EXITCODE%
