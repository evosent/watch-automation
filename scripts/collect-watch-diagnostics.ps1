param(
  [string]$ClientId = '',
  [string]$OutputRoot = '',
  [int]$TimeoutSeconds = 120,
  [int]$MaxDomFiles = 50
)

$ErrorActionPreference = 'Stop'
$baseUrl = 'http://127.0.0.1:17321'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $repoRoot 'diagnostics\exports'
}

$health = Invoke-RestMethod -Method Get -Uri "$baseUrl/health" -TimeoutSec 5
if ($health.ok -ne $true) { throw 'Локальный сервис WatchAutomation не подтвердил готовность.' }
$clientsResponse = Invoke-RestMethod -Method Get -Uri "$baseUrl/control/clients" -TimeoutSec 5
$clients = @($clientsResponse.clients)
if ($ClientId) { $clients = @($clients | Where-Object { $_.clientId -eq $ClientId }) }
if ($clients.Count -ne 1) {
  if ($clients.Count -eq 0) { throw 'Активный экземпляр расширения не найден. Открой Chrome с расширением и повтори сбор.' }
  throw 'Найдено несколько профилей расширения. Укажи точный -ClientId из /control/clients.'
}
$client = $clients[0]

$commandBody = @{
  command = 'diagnostics'
  clientId = $client.clientId
  extensionId = $client.extensionId
  version = $client.version
  targetClientId = $client.clientId
  targetExtensionId = $client.extensionId
} | ConvertTo-Json -Compress
$queued = Invoke-RestMethod -Method Post -Uri "$baseUrl/control" -ContentType 'application/json' -Body $commandBody -TimeoutSec 10
$commandId = [string]$queued.command.id
if (-not $commandId) { throw 'Локальный сервис не поставил запрос диагностики в очередь.' }

$deadline = [DateTimeOffset]::UtcNow.AddSeconds([Math]::Max(10, $TimeoutSeconds))
$commandResult = $null
do {
  Start-Sleep -Milliseconds 800
  $response = Invoke-RestMethod -Method Get -Uri "$baseUrl/control/result?id=$commandId" -TimeoutSec 5
  $commandResult = $response.command
  if ($commandResult.status -in @('completed', 'failed')) { break }
} while ([DateTimeOffset]::UtcNow -lt $deadline)

if ($commandResult.status -ne 'completed') {
  $state = if ($commandResult.status) { $commandResult.status } else { 'unknown' }
  throw "Расширение не завершило сбор диагностики за $TimeoutSeconds секунд (состояние команды: $state)."
}
if ($commandResult.ok -ne $true -or -not $commandResult.value) {
  throw "Расширение вернуло ошибку диагностики: $($commandResult.error)"
}

$stamp = [DateTimeOffset]::Now.ToString('yyyyMMdd-HHmmss-fff')
$collectionPath = Join-Path $OutputRoot "watch-automation-support-$stamp"
$domPath = Join-Path $collectionPath 'dom'
$pageDiagnosticsPath = Join-Path $collectionPath 'page-diagnostics'
New-Item -ItemType Directory -Path $domPath -Force | Out-Null
New-Item -ItemType Directory -Path $pageDiagnosticsPath -Force | Out-Null

$diagnostic = $commandResult.value
$diagnostic | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $collectionPath 'diagnostics.json') -Encoding utf8
$domSnapshots = @($diagnostic.domSnapshots)
if ($domSnapshots.Count -gt 0) {
  $domSnapshots | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $domPath 'current-pages.json') -Encoding utf8
}
$operationId = [string]($diagnostic.run.operationId)
if (-not $operationId) { $operationId = [string]($diagnostic.runtime.operationId) }
if (-not $operationId) { $operationId = [string]($diagnostic.runtime.progressRunId) }
if (-not $operationId) { $operationId = [string]($diagnostic.runArchive.run.operationId) }

$latestDom = Invoke-RestMethod -Method Get -Uri "$baseUrl/observations?latest=1&limit=20" -TimeoutSec 15
$latestDom | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $domPath 'latest-sessions.json') -Encoding utf8
$domIndex = Invoke-RestMethod -Method Get -Uri "$baseUrl/observations" -TimeoutSec 15
$sessionFiles = @($domIndex.files | Select-Object -First 200)
$domSessions = [System.Collections.Generic.List[object]]::new()
foreach ($sessionFile in $sessionFiles) {
  $encodedSession = [Uri]::EscapeDataString([string]$sessionFile.session)
  $sessionUri = "$baseUrl/observations?session=$encodedSession&all=1&limit=50000"
  if ($operationId) { $sessionUri += "&operationId=$([Uri]::EscapeDataString($operationId))" }
  $sessionData = Invoke-RestMethod -Method Get -Uri $sessionUri -TimeoutSec 30
  if (@($sessionData.events).Count -gt 0) {
    $safeName = [regex]::Replace([string]$sessionFile.session, '[^a-zA-Z0-9._-]', '_')
    $sessionData | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $domPath "$safeName.json") -Encoding utf8
    $domSessions.Add([pscustomobject]@{ session = $sessionFile.session; events = @($sessionData.events).Count; totalEvents = $sessionData.totalEvents; truncated = $sessionData.truncated })
  }
}

$pageFilesResponse = Invoke-RestMethod -Method Get -Uri "$baseUrl/diagnostics" -TimeoutSec 15
$pageFiles = @($pageFilesResponse.files | Sort-Object modifiedAt -Descending | Select-Object -First ([Math]::Max(0, $MaxDomFiles)))
$copiedPageFiles = [System.Collections.Generic.List[object]]::new()
foreach ($pageFile in $pageFiles) {
  if (-not (Test-Path -LiteralPath $pageFile.path -PathType Leaf)) { continue }
  $name = [regex]::Replace([string]$pageFile.name, '[^a-zA-Z0-9._-]', '_')
  $destination = Join-Path $pageDiagnosticsPath $name
  Copy-Item -LiteralPath $pageFile.path -Destination $destination -Force
  $copiedPageFiles.Add([pscustomobject]@{ name = $name; modifiedAt = $pageFile.modifiedAt; size = $pageFile.size })
}

$manifest = [pscustomobject]@{
  collectedAt = [DateTimeOffset]::Now.ToString('o')
  extensionVersion = $client.version
  extensionId = $client.extensionId
  clientId = $client.clientId
  operationId = $operationId
  runState = if ($diagnostic.run.state) { $diagnostic.run.state } else { $diagnostic.runtime.state }
  domSnapshotCount = $domSnapshots.Count
  domSessionCount = $domSessions.Count
  domSessions = @($domSessions)
  copiedPageDiagnosticCount = $copiedPageFiles.Count
  copiedPageDiagnostics = @($copiedPageFiles)
}
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $collectionPath 'manifest.json') -Encoding utf8

$archivePath = "$collectionPath.zip"
Compress-Archive -Path (Join-Path $collectionPath '*') -DestinationPath $archivePath -CompressionLevel Optimal
Write-Output "ARCHIVE=$archivePath"
Write-Output "DIAGNOSTICS=$(Join-Path $collectionPath 'diagnostics.json')"
Write-Output "OPERATION_ID=$operationId"
Write-Output "DOM_SNAPSHOTS=$($domSnapshots.Count)"
Write-Output "DOM_SESSIONS=$($domSessions.Count)"
Write-Output "PAGE_DIAGNOSTICS=$($copiedPageFiles.Count)"
