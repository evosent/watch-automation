[CmdletBinding()]
param(
    [string]$InstallRoot = $PSScriptRoot,
    [switch]$NoLaunch,
    [switch]$NoGuide,
    [switch]$NoShortcut,
    [switch]$SkipPhotos,
    [switch]$SkipRuntimeSetup
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repository = "evosent/watch-automation"
$photosReleaseTag = "watch-photos-v1"
$packageAssetName = "watch-automation-installer-package.zip"
$photosAssetName = "watch-photos-v1.tar"
$photosManifestAssetName = "watch-photos-manifest.json"
$targetRoot = $InstallRoot

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host ("==> " + $Message) -ForegroundColor Cyan
}

function Get-Release([string]$Uri) {
    $headers = @{
        "Accept" = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
        "User-Agent" = "WatchAutomationInstaller"
    }
    return Invoke-RestMethod -Uri $Uri -Headers $headers -UseBasicParsing
}

function Find-ReleaseAsset($Release, [string]$Name) {
    $matchingAssets = @($Release.assets | Where-Object { $_.name -ceq $Name -and $_.state -eq "uploaded" })
    if ($matchingAssets.Count -ne 1) {
        throw "В релизе $($Release.tag_name) должен находиться ровно один файл $Name."
    }
    if ($matchingAssets[0].digest -notmatch "^sha256:([0-9a-fA-F]{64})$") {
        throw "GitHub не вернул SHA-256 для $Name. Повтори попытку позже."
    }
    return $matchingAssets[0]
}

function Get-Sha256Hex([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $hash = $algorithm.ComputeHash($stream)
        return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
    } finally {
        $stream.Dispose()
        $algorithm.Dispose()
    }
}

function Remove-PartialDownload([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
}

function Download-VerifiedAsset($Asset, [string]$Destination) {
    Write-Host ("Скачивание {0} ({1:N0} МБ)..." -f $Asset.name, ([double]$Asset.size / 1MB))
    $downloaded = $false

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source --location --fail --show-error --silent --retry 5 --retry-delay 3 --connect-timeout 30 --continue-at "-" --output $Destination $Asset.browser_download_url
        if ($LASTEXITCODE -eq 0) { $downloaded = $true }
        else { Remove-PartialDownload $Destination }
    }

    if (-not $downloaded) {
        $bits = Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue
        if ($bits) {
            try {
                Start-BitsTransfer -Source $Asset.browser_download_url -Destination $Destination -RetryInterval 15 -RetryTimeout 1800 -ErrorAction Stop
                $downloaded = $true
            } catch {
                Remove-PartialDownload $Destination
            }
        }
    }

    if (-not $downloaded) {
        Remove-PartialDownload $Destination
        Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Destination -UseBasicParsing
    }

    if (-not (Test-Path -LiteralPath $Destination)) { throw "GitHub не создал локальный файл $Destination." }
    $actualLength = (Get-Item -LiteralPath $Destination).Length
    if ([long]$actualLength -ne [long]$Asset.size) {
        Remove-PartialDownload $Destination
        throw "Размер $($Asset.name) не совпал с данными GitHub: скачано $actualLength байт, ожидалось $($Asset.size)."
    }

    Write-Host "Проверка SHA-256..."
    $actualDigest = Get-Sha256Hex -Path $Destination
    $expectedDigest = ([regex]::Match([string]$Asset.digest, "^sha256:([0-9a-fA-F]{64})$")).Groups[1].Value.ToLowerInvariant()
    if ($actualDigest -ne $expectedDigest) {
        Remove-PartialDownload $Destination
        throw "Проверка целостности $($Asset.name) не пройдена. Файл удалён."
    }
}

function Get-ImageFiles([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction Stop |
        Where-Object { $_.Extension -match "(?i)^\.(png|jpe?g|webp)$" })
}

function Assert-SafePhotoArchive([string]$ArchivePath, [int]$ExpectedCount) {
    $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
    if (-not $tar) { throw "В Windows не найден tar.exe. Установи актуальные обновления Windows и повтори запуск." }
    $entries = @(& $tar.Source -tf $ArchivePath)
    if ($LASTEXITCODE -ne 0) { throw "Не удалось прочитать список файлов фототеки в TAR." }
    $images = @($entries | Where-Object { $_ -match "(?i)\.(png|jpe?g|webp)$" })
    if ($images.Count -ne $ExpectedCount) {
        throw "В архиве фототеки найдено $($images.Count) изображений, ожидалось $ExpectedCount."
    }
    foreach ($entry in $entries) {
        $normalized = ([string]$entry).Replace("\", "/")
        if (($normalized -ne "input-watches-images" -and
                -not $normalized.StartsWith("input-watches-images/", [StringComparison]::Ordinal)) -or
            @($normalized.Split("/") | Where-Object { $_ -eq ".." }).Count -gt 0) {
            throw "В архиве обнаружен небезопасный путь: $entry"
        }
    }
}

function Install-Photos($Release, [string]$WorkRoot, [string]$Target) {
    $photoFolder = Join-Path $Target "input-watches-images"
    $existing = Get-ImageFiles $photoFolder
    if ($existing.Count -gt 0) {
        Write-Host "Фототека уже есть ($($existing.Count) изображений). Оставляю локальную папку без изменений." -ForegroundColor Green
        return
    }

    if (Test-Path -LiteralPath $photoFolder -PathType Container) {
        $children = @(Get-ChildItem -LiteralPath $photoFolder -Force)
        if ($children.Count -gt 0) {
            throw "Папка input-watches-images существует, но в ней не найдено изображений. Она сохранена без изменений; переименуй её вручную для полной первичной загрузки."
        }
    }

    $manifestAsset = Find-ReleaseAsset $Release $photosManifestAssetName
    $manifestPath = Join-Path $WorkRoot $photosManifestAssetName
    Download-VerifiedAsset $manifestAsset $manifestPath
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$manifest.schemaVersion -ne 1 -or
        $manifest.releaseTag -cne $photosReleaseTag -or
        $manifest.archiveAsset -cne $photosAssetName -or
        [int]$manifest.imageCount -lt 1) {
        throw "Манифест фототеки имеет неожиданный формат или тег."
    }

    $archiveAsset = Find-ReleaseAsset $Release $photosAssetName
    if ([long]$archiveAsset.size -ne [long]$manifest.archiveBytes) {
        throw "Размер архива фототеки в GitHub Release не совпадает с манифестом."
    }

    $volumeRoot = [System.IO.Path]::GetPathRoot($InstallRoot)
    $drive = [System.IO.DriveInfo]::new($volumeRoot)
    $requiredFreeBytes = [long]$archiveAsset.size + [long]$manifest.totalBytes + 512MB
    if ($drive.AvailableFreeSpace -lt $requiredFreeBytes) {
        $requiredGb = [math]::Ceiling($requiredFreeBytes / 1GB)
        throw "Для первой загрузки фототеки нужно около $requiredGb ГБ свободного места на диске $volumeRoot."
    }

    $archivePath = Join-Path $WorkRoot $photosAssetName
    Download-VerifiedAsset $archiveAsset $archivePath
    Assert-SafePhotoArchive $archivePath ([int]$manifest.imageCount)

    $photoStage = Join-Path $WorkRoot "photo-stage"
    New-Item -ItemType Directory -Force -Path $photoStage | Out-Null
    Write-Step "Распаковка фототеки"
    $tar = Get-Command tar.exe -ErrorAction Stop
    & $tar.Source -xf $archivePath -C $photoStage
    if ($LASTEXITCODE -ne 0) { throw "Распаковка фототеки завершилась с кодом $LASTEXITCODE." }

    $stagedPhotoFolder = Join-Path $photoStage "input-watches-images"
    $stagedImages = Get-ImageFiles $stagedPhotoFolder
    $stagedBytes = ($stagedImages | Measure-Object -Property Length -Sum).Sum
    if ($stagedImages.Count -ne [int]$manifest.imageCount -or [long]$stagedBytes -ne [long]$manifest.totalBytes) {
        throw "Проверка фототеки после распаковки не пройдена: изображений $($stagedImages.Count)/$($manifest.imageCount), размер $stagedBytes/$($manifest.totalBytes) байт."
    }
    foreach ($requiredDirectory in @("in_sale", "not_in_sale")) {
        if (-not (Test-Path -LiteralPath (Join-Path $stagedPhotoFolder $requiredDirectory) -PathType Container)) {
            throw "После распаковки отсутствует папка фототеки $requiredDirectory."
        }
    }

    Remove-PartialDownload $archivePath
    if (Test-Path -LiteralPath $photoFolder -PathType Container) {
        Remove-Item -LiteralPath $photoFolder -Force
    }
    Move-Item -LiteralPath $stagedPhotoFolder -Destination $photoFolder
    Write-Host "Загружена фототека: $($stagedImages.Count) изображений." -ForegroundColor Green
}

function Copy-AppPackage([string]$PackageStage, [string]$Target) {
    $manifest = Join-Path $PackageStage "extension\manifest.json"
    if (-not (Test-Path -LiteralPath $manifest)) { throw "В установочном архиве отсутствует extension\manifest.json." }
    if (Test-Path -LiteralPath (Join-Path $PackageStage "input-watches-images")) {
        throw "Установочный ZIP содержит input-watches-images; пакет отклонён, чтобы защитить локальные фотографии."
    }

    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Write-Step "Установка приложения"
    & robocopy.exe $PackageStage $Target /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "Копирование файлов приложения завершилось с кодом robocopy $LASTEXITCODE." }
}

try {
    if (-not $InstallRoot) { throw "Не задана папка установки." }
    $InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
    $volumeRoot = [System.IO.Path]::GetPathRoot($InstallRoot)
    if ($InstallRoot.TrimEnd([char]'\') -eq $volumeRoot.TrimEnd([char]'\')) { throw "Запусти установщик из папки внутри диска, например C:\WatchAutomation." }
    $targetRoot = $InstallRoot

    if (Test-Path -LiteralPath (Join-Path $targetRoot "extension\manifest.json")) {
        Write-Host "Обнаружена существующая установка. Закрой окна Chrome for Testing, которые используют профиль автогенерации." -ForegroundColor Yellow
        $confirmation = Read-Host "Когда профиль закрыт, введи ГОТОВО"
        if ($confirmation.Trim().ToUpperInvariant() -cne "ГОТОВО") { throw "Установка отменена." }
    }

    Write-Host "Установщик WatchAutomation загружает последнюю стабильную версию из публичного GitHub-репозитория." -ForegroundColor White
    Write-Host "Фототека часов загружается только при первой установке. Существующая локальная папка сохраняется."
    $latestRelease = Get-Release ("https://api.github.com/repos/" + $repository + "/releases/latest")
    if ($latestRelease.draft -or $latestRelease.prerelease) { throw "GitHub вернул незавершённый релиз вместо стабильной версии." }
    $packageAsset = Find-ReleaseAsset $latestRelease $packageAssetName
    $stageParent = Split-Path -Parent $InstallRoot
    $workRoot = Join-Path $stageParent (".watch-automation-install-stage-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

    try {
        $packageArchive = Join-Path $workRoot $packageAssetName
        Download-VerifiedAsset $packageAsset $packageArchive
        $packageStage = Join-Path $workRoot "app-stage"
        Expand-Archive -LiteralPath $packageArchive -DestinationPath $packageStage -Force
        Copy-AppPackage $packageStage $targetRoot

        if (-not $SkipPhotos) {
            Write-Step "Проверка комплекта фотографий"
            $localPhotos = Get-ImageFiles (Join-Path $targetRoot "input-watches-images")
            if ($localPhotos.Count -gt 0) {
                Write-Host "Фототека уже есть ($($localPhotos.Count) изображений). Оставляю локальную папку без изменений." -ForegroundColor Green
            } else {
                $photoRelease = Get-Release ("https://api.github.com/repos/" + $repository + "/releases/tags/" + $photosReleaseTag)
                if (-not $photoRelease.prerelease) { throw "Релиз фототеки должен оставаться отдельным prerelease, чтобы не подменять последнюю стабильную версию приложения." }
                Install-Photos $photoRelease $workRoot $targetRoot
            }
        } else {
            Write-Host "Загрузка фототеки пропущена по параметру -SkipPhotos." -ForegroundColor Yellow
        }

        if ($SkipRuntimeSetup) {
            Write-Host "Настройка Node.js/Chrome пропущена по параметру -SkipRuntimeSetup." -ForegroundColor Yellow
        } else {
            $localInstaller = Join-Path $targetRoot "Install_WatchAutomation.ps1"
            if (-not (Test-Path -LiteralPath $localInstaller)) { throw "Основной установщик не найден в приложении: $localInstaller" }
            Write-Step "Настройка Node.js, Chrome for Testing и ярлыка"
            $arguments = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $localInstaller, "-SkipExtract", "-InstallRoot", $targetRoot, "-EnsureBrowser")
            if ($NoLaunch) { $arguments += "-NoLaunch" }
            if ($NoGuide -or $NoLaunch) { $arguments += "-NoGuide" }
            if ($NoShortcut) { $arguments += "-NoShortcut" }
            & powershell.exe @arguments
            if ($LASTEXITCODE -ne 0) { throw "Настройка приложения завершилась с кодом $LASTEXITCODE." }
        }

        Write-Host ""
        Write-Host ("Готово. WatchAutomation установлен в: " + $targetRoot) -ForegroundColor Green
        Write-Host "Для обновлений используй кнопку «Проверить обновления» во вкладке «Сервис». Папка с фото часов при этом не скачивается."
    } finally {
        if (Test-Path -LiteralPath $workRoot) {
            Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
} catch {
    Write-Host ""
    Write-Host ("Установка остановлена: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host "Повтори запуск через INSTALL_FROM_GITHUB.cmd. Уже существующая папка с фото часов сохраняется." -ForegroundColor Yellow
    exit 1
}
