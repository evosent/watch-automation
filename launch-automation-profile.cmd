@echo off
setlocal
set "ROOT=%~dp0"
rem Keep Chrome's writable profile outside the package. This lets the ZIP live
rem on a read-only folder, USB drive, or a shared directory.
set "PROFILE=%LocalAppData%\WatchAutomation\ChromeProfile"
if not exist "%PROFILE%" mkdir "%PROFILE%"

rem The watcher enables auto-reload, DOM history, local PNG verification, and
rem Codex control. The extension itself still starts when Node.js is absent.
where node >nul 2>nul
if errorlevel 1 goto node_missing

rem A watcher is an independent Node process and can survive Chrome/reloads.
rem Before every Automation Profile launch, stop ONLY our stale watcher that
rem owns port 17321. This guarantees that the watcher code from the current
rem project folder is the process serving the extension. Keep these PowerShell
rem commands outside a parenthesized CMD block: CMD parses their parentheses
rem even inside quotes and otherwise aborts with "{ was unexpected at this time".
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $ids=@(Get-NetTCPConnection -State Listen -LocalPort 17321 | Select-Object -ExpandProperty OwningProcess -Unique); foreach($id in $ids){ $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id); if($p -and $p.Name -match '^node(.exe)?$' -and $p.CommandLine -match 'watch-extension\.mjs'){ Stop-Process -Id $id -Force } }" >nul 2>nul
powershell.exe -NoProfile -Command "Start-Sleep -Seconds 1" >nul 2>nul
start "Watch Automation watcher" /min "%ComSpec%" /d /c call "%ROOT%watch-extension.cmd"
rem Give the local service a short head start. Chrome may open before this
rem completes; the extension will retry, but this avoids the common first
rem gallery scan racing watcher startup.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 20;$i++){ try { $h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:17321/health'; if($h.ok -and [int]$h.apiVersion -ge 7){$ok=$true; break} } catch {}; Start-Sleep -Milliseconds 250 }; if(-not $ok){exit 2}" >nul 2>nul
if errorlevel 2 echo Watcher не подтвердил API v7. Галерея покажет диагностический статус.
goto watcher_ready

:node_missing
echo Node.js не найден. Chrome будет запущен, но watcher и автообновление недоступны.
echo Для полного режима установи Node.js 18+ и запусти этот файл повторно.

:watcher_ready

rem Official Chrome 137+ ignores --load-extension. Use the portable Chrome for
rem Testing binary provisioned by the installer. If this is the first launch,
rem bootstrap it automatically so the user never has to load the extension by hand.
set "CHROME=%LocalAppData%\WatchAutomation\ChromeForTesting\chrome-win64\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\WatchAutomation\ChromeForTesting\chrome.exe"
if not exist "%CHROME%" (
  if not exist "%ROOT%Install_WatchAutomation.ps1" (
    echo Chrome for Testing не найден, а установщик отсутствует в комплекте.
    exit /b 1
  )
  echo Первый запуск: устанавливаю Chrome for Testing автоматически...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%Install_WatchAutomation.ps1" -SkipExtract -InstallRoot "%ROOT%" -NoLaunch -NoGuide -EnsureBrowser
  if errorlevel 1 (
    echo Не удалось установить Chrome for Testing. Запусти INSTALL_WatchAutomation.cmd повторно.
    exit /b 1
  )
  set "CHROME=%LocalAppData%\WatchAutomation\ChromeForTesting\chrome-win64\chrome.exe"
  if not exist "%CHROME%" set "CHROME=%LocalAppData%\WatchAutomation\ChromeForTesting\chrome.exe"
)

if not exist "%CHROME%" (
  echo Chrome for Testing не найден после установки. Проверь папку %LocalAppData%\WatchAutomation\ChromeForTesting.
  exit /b 1
)

:launch


rem Chrome reuses an existing process for the same profile and silently ignores
rem command-line flags from the second launch. Stop only Chrome for Testing
rem processes whose command line points at this exact automation profile, then
rem start one fresh browser process with the required background guarantees.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$profile=[IO.Path]::GetFullPath('%PROFILE%'); $chrome=[IO.Path]::GetFullPath('%CHROME%'); $targets=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $chrome -and $_.CommandLine -and $_.CommandLine.IndexOf($profile,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -ExpandProperty ProcessId -Unique); foreach($pidValue in $targets){ Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }; if($targets.Count){ Start-Sleep -Milliseconds 800 }"

start "Watch Automation Chrome" "%CHROME%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-sync --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=IntensiveWakeUpThrottling,FreezingOnBatterySaver,InfiniteTabsFreezing,InfiniteTabsFreezingOnMemoryPressure,CalculateNativeWinOcclusion --load-extension="%ROOT%extension" "https://chatgpt.com/?watch_automation=1"
endlocal
