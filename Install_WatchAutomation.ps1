[CmdletBinding()]
param(
    [string]$ArchivePath,
    [string]$InstallRoot,
    [switch]$SkipExtract,
    [switch]$NoLaunch,
    [switch]$NoGuide,
    [switch]$EnsureBrowser,
    [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-NodeExecutable {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
        (Join-Path $env:LocalAppData "Programs\nodejs\node.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

function Add-NodeToPath {
    $paths = @(
        (Join-Path $env:ProgramFiles "nodejs"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs"),
        (Join-Path $env:LocalAppData "Programs\nodejs")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    if ($paths.Count -gt 0) {
        $env:Path = (($paths -join ";") + ";" + $env:Path)
    }
}

function Test-NodeSupported([string]$NodePath) {
    if (-not $NodePath) { return $false }
    try {
        $versionText = (& $NodePath --version 2>$null).Trim().TrimStart("v")
        return ([version]$versionText).Major -ge 18
    } catch {
        return $false
    }
}

function Install-Node {
    $node = Get-NodeExecutable
    if (Test-NodeSupported $node) {
        $versionText = (& $node --version 2>$null).Trim()
        Write-Host "Node.js $versionText уже установлен." -ForegroundColor Green
        Add-NodeToPath
        return $node
    }

    Write-Step "Установка Node.js LTS"
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Host "Использую winget. Windows может запросить подтверждение UAC."
        & $winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
        Add-NodeToPath
        $node = Get-NodeExecutable
        if (Test-NodeSupported $node) { return $node }
    }

    Write-Host "winget недоступен или установка не завершилась. Скачиваю официальный MSI с nodejs.org." -ForegroundColor Yellow
    # Windows PowerShell 5.1 may default to TLS 1.0 on older systems.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM64") { "arm64" } else { "x64" }
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
    $release = $index | Where-Object {
        $_.lts -and ($_.files -contains "win-$arch-msi")
    } | Select-Object -First 1
    if (-not $release) { throw "Не удалось найти актуальный Node.js LTS для архитектуры $arch." }
    $versionName = $release.version
    $msiUrl = "https://nodejs.org/dist/$versionName/$versionName-win-$arch.msi"
    $msiPath = Join-Path ([IO.Path]::GetTempPath()) "WatchAutomation-Node-$versionName.msi"
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
    try {
        $arguments = "/i `"$msiPath`" /qn /norestart"
        Start-Process -FilePath "msiexec.exe" -ArgumentList $arguments -Verb RunAs -Wait
    } finally {
        if (Test-Path -LiteralPath $msiPath) {
            Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue
        }
    }
    Add-NodeToPath
    $node = Get-NodeExecutable
    if (-not (Test-NodeSupported $node)) { throw "Node.js 18+ не найден после установки. Перезапустите установщик с правами администратора." }
    return $node
}

function Get-ChromeForTestingExecutable {
    $browserRoot = Join-Path $env:LocalAppData "WatchAutomation\ChromeForTesting"
    if (-not (Test-Path -LiteralPath $browserRoot)) { return $null }

    $knownPaths = @(
        (Join-Path $browserRoot "chrome-win64\chrome.exe"),
        (Join-Path $browserRoot "chrome.exe")
    )
    foreach ($candidate in $knownPaths) {
        if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
    }

    $discovered = Get-ChildItem -LiteralPath $browserRoot -Filter "chrome.exe" -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($discovered) { return $discovered.FullName }
    return $null
}

function Install-ChromeForTesting {
    $existing = Get-ChromeForTestingExecutable
    if ($existing) {
        Write-Host "Chrome for Testing уже установлен: $existing" -ForegroundColor Green
        return $existing
    }

    Write-Step "Установка Chrome for Testing"
    # Windows PowerShell 5.1 may default to TLS 1.0 on older systems.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $metadataUri = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
    $metadata = Invoke-RestMethod -Uri $metadataUri -UseBasicParsing
    $download = @($metadata.channels.Stable.downloads.chrome |
        Where-Object { $_.platform -eq "win64" } |
        Select-Object -First 1)
    if ($download.Count -eq 0 -or -not $download[0].url) {
        throw "Не удалось найти официальный Chrome for Testing для Windows x64."
    }

    $versionName = [string]$metadata.channels.Stable.version
    if (-not $versionName) { $versionName = "stable" }
    $browserRoot = Join-Path $env:LocalAppData "WatchAutomation\ChromeForTesting"
    $zipPath = Join-Path ([IO.Path]::GetTempPath()) ("WatchAutomation-ChromeForTesting-$versionName.zip")
    New-Item -ItemType Directory -Force -Path $browserRoot | Out-Null
    Write-Host "Версия: $versionName"
    Write-Host "Скачивание официального бинарника..."
    try {
        Invoke-WebRequest -Uri $download[0].url -OutFile $zipPath -UseBasicParsing
        Expand-Archive -LiteralPath $zipPath -DestinationPath $browserRoot -Force
    } finally {
        if (Test-Path -LiteralPath $zipPath) {
            Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        }
    }

    $chrome = Get-ChromeForTestingExecutable
    if (-not $chrome) {
        throw "Chrome for Testing скачан, но chrome.exe не найден в $browserRoot."
    }

    # Recent Windows Chrome builds include a sandbox setup helper. It may need
    # elevation on some machines; a non-zero code does not invalidate the
    # browser, so continue after recording the result.
    $setup = Join-Path (Split-Path -Parent $chrome) "setup.exe"
    if (Test-Path -LiteralPath $setup) {
        try {
            & $setup "--configure-browser-in-directory=$(Split-Path -Parent $chrome)" 2>$null | Out-Null
        } catch {
            Write-Host "Настройка sandbox пропущена: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    Write-Host "Chrome for Testing установлен: $chrome" -ForegroundColor Green
    return $chrome
}

function New-AutomationShortcut([string]$PackageRoot, [string]$ChromePath) {
    if ($NoShortcut) { return }
    if (-not $ChromePath -or -not (Test-Path -LiteralPath $ChromePath)) {
        Write-Host "Ярлык не создан: Chrome for Testing ещё не найден." -ForegroundColor Yellow
        return
    }

    $desktop = [Environment]::GetFolderPath("Desktop")
    if (-not $desktop) {
        Write-Host "Ярлык не создан: системная папка рабочего стола не найдена." -ForegroundColor Yellow
        return
    }

    $launcherPath = Join-Path $PackageRoot "launch-automation-profile.cmd"
    $shortcutPath = Join-Path $desktop "Автогенерация — профиль.lnk"
    if (-not (Test-Path -LiteralPath $launcherPath)) {
        throw "Launcher не найден: $launcherPath"
    }
    # The launcher owns process replacement and the complete background flag
    # set. Pointing the shortcut at chrome.exe directly can silently reuse an
    # old profile process and lose every newly added flag.
    $arguments = '/d /c call "{0}"' -f $launcherPath

    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $env:ComSpec
        $shortcut.Arguments = $arguments
        $shortcut.WorkingDirectory = $PackageRoot
        $shortcut.IconLocation = "$ChromePath,0"
        $shortcut.Description = "Открыть отдельный профиль Автогенерации"
        $shortcut.Save()
        Write-Host "Ярлык создан: $shortcutPath" -ForegroundColor Green
    } catch {
        Write-Host "Ярлык не создан: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Resolve-PackageRoot {
    if ($SkipExtract) {
        $root = if ($InstallRoot) { $InstallRoot } else { $scriptRoot }
        $manifest = Join-Path $root "extension\manifest.json"
        if (-not (Test-Path -LiteralPath $manifest)) {
            throw "В папке не найдено расширение: $manifest"
        }
        return (Resolve-Path -LiteralPath $root).Path
    }

    $archive = $ArchivePath
    if (-not $archive) {
        $archive = Get-ChildItem -LiteralPath $scriptRoot -Filter "WatchAutomation_*.zip" -File -ErrorAction SilentlyContinue |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $archive -or -not (Test-Path -LiteralPath $archive)) {
        throw "Рядом с установщиком не найден архив WatchAutomation_*.zip."
    }

    $base = if ($InstallRoot) { $InstallRoot } else { Join-Path $env:LocalAppData "WatchAutomation" }
    New-Item -ItemType Directory -Force -Path $base | Out-Null
    $target = Join-Path $base "WatchAutomation"
    Write-Step "Распаковка комплекта"
    Write-Host "Источник: $archive"
    Write-Host "Назначение: $target"

    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($tar) {
        & $tar.Source -xf (Resolve-Path -LiteralPath $archive).Path -C (Resolve-Path -LiteralPath $base).Path
        if ($LASTEXITCODE -ne 0) { throw "tar.exe завершился с кодом $LASTEXITCODE." }
    } else {
        Expand-Archive -LiteralPath $archive -DestinationPath $base -Force
    }
    $manifest = Join-Path $target "extension\manifest.json"
    if (-not (Test-Path -LiteralPath $manifest)) {
        throw "Распаковка завершилась, но manifest.json не найден в $target."
    }
    return (Resolve-Path -LiteralPath $target).Path
}

function Install-Dependencies([string]$PackageRoot, [string]$NodePath) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) {
        $npmCandidates = @(
            (Join-Path $env:ProgramFiles "nodejs\npm.cmd"),
            (Join-Path ${env:ProgramFiles(x86)} "nodejs\npm.cmd"),
            (Join-Path $env:LocalAppData "Programs\nodejs\npm.cmd")
        )
        foreach ($candidate in $npmCandidates) {
            if ($candidate -and (Test-Path -LiteralPath $candidate)) { $npm = Get-Item -LiteralPath $candidate; break }
        }
    }
    if (-not $npm) { throw "npm.cmd не найден рядом с Node.js." }

    Write-Step "Проверка Node.js-зависимостей"
    Push-Location $PackageRoot
    try {
        $npmPath = if ($npm.Source) { $npm.Source } else { $npm.FullName }
        & $npmPath install --no-audit --no-fund --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw "npm install завершился с кодом $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}

function Start-Package([string]$PackageRoot) {
    $launcher = Join-Path $PackageRoot "START_AUTOGENERATION.cmd"
    if (-not (Test-Path -LiteralPath $launcher)) { throw "Не найден launcher: $launcher" }
    Write-Step "Запуск отдельного окна Chrome"
    $commandLine = "/c `"$launcher`""
    Start-Process -FilePath $env:ComSpec -ArgumentList $commandLine -WorkingDirectory $PackageRoot
}

function Open-Guide([string]$PackageRoot) {
    $guide = Join-Path $PackageRoot "docs\WatchAutomation_Инструкция.pdf"
    if (-not (Test-Path -LiteralPath $guide)) {
        Write-Host "PDF-инструкция не найдена: $guide" -ForegroundColor Yellow
        return
    }
    Write-Step "Открытие PDF-инструкции"
    $browserCandidates = @(
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LocalAppData "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:LocalAppData "Microsoft\Edge\Application\msedge.exe")
    )
    $browser = $browserCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
    if ($browser) {
        # A dedicated profile keeps the guide independent from personal browser tabs.
        $guideProfile = Join-Path $env:LocalAppData "WatchAutomation\GuideProfile"
        New-Item -ItemType Directory -Force -Path $guideProfile | Out-Null
        $guideUri = ([System.Uri]$guide).AbsoluteUri
        Start-Process -FilePath $browser -ArgumentList @(
            "--user-data-dir=`"$guideProfile`"",
            "--new-window",
            "--start-fullscreen",
            $guideUri
        )
    } else {
        Start-Process -FilePath $guide
    }
}

try {
    $packageRoot = Resolve-PackageRoot
    $nodePath = Install-Node
    Add-NodeToPath
    Install-Dependencies -PackageRoot $packageRoot -NodePath $nodePath
    $chromePath = $null
    if ($EnsureBrowser -or -not $NoLaunch) {
        $chromePath = Install-ChromeForTesting
    }
    if ($chromePath) { New-AutomationShortcut -PackageRoot $packageRoot -ChromePath $chromePath }
    if (-not $NoLaunch) { Start-Package -PackageRoot $packageRoot }
    if (-not $NoGuide) {
        Start-Sleep -Milliseconds 800
        Open-Guide -PackageRoot $packageRoot
    }
    Write-Host "`nГотово. Комплект установлен в: $packageRoot" -ForegroundColor Green
} catch {
    Write-Host "`nУстановка остановлена: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Запустите INSTALL_WatchAutomation.cmd ещё раз после исправления причины." -ForegroundColor Yellow
    exit 1
}
