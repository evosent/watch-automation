import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const UPDATE_REPOSITORY = 'evosent/watch-automation';
export const UPDATE_ASSET_NAME = 'watch-automation-update.zip';
export const UPDATE_PACKAGE_MANIFEST = 'watch-automation-update-package.json';
export const UPDATE_STATE_FILE = '.watch-automation-update-state.json';

const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 220 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1000;
const ALLOWED_DEV_FILES = new Set([
  'dev/control-routing.mjs',
  'dev/watch-extension.mjs',
  'dev/update-utils.mjs',
  'dev/update-watch-automation.mjs'
]);
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp)$/i;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function allowedPackagePath(name, isDirectory = false) {
  const normalized = String(name || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.includes('\0')) return false;
  const trimmed = isDirectory ? normalized.replace(/\/+$/, '') : normalized;
  const segments = trimmed.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))) return false;

  if (trimmed === UPDATE_PACKAGE_MANIFEST) return !isDirectory;
  if (trimmed === 'extension' || trimmed.startsWith('extension/')) return true;
  if (trimmed === 'input-ref-images' || trimmed.startsWith('input-ref-images/')) {
    return isDirectory || IMAGE_EXTENSION.test(trimmed);
  }
  if (trimmed === 'dev') return isDirectory;
  return ALLOWED_DEV_FILES.has(trimmed) && !isDirectory;
}

function findZipDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== buffer.length) continue;
    const diskNumber = buffer.readUInt16LE(offset + 4);
    const centralDisk = buffer.readUInt16LE(offset + 6);
    const diskEntries = buffer.readUInt16LE(offset + 8);
    const totalEntries = buffer.readUInt16LE(offset + 10);
    const centralSize = buffer.readUInt32LE(offset + 12);
    const centralOffset = buffer.readUInt32LE(offset + 16);
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error('Пакет обновления использует неподдерживаемый многотомный ZIP');
    if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) throw new Error('ZIP64-пакеты обновления не поддерживаются');
    if (totalEntries > MAX_ARCHIVE_ENTRIES || centralOffset + centralSize > offset) throw new Error('Некорректное оглавление ZIP-пакета');
    return { offset: centralOffset, size: centralSize, count: totalEntries };
  }
  throw new Error('В архиве обновления не найдено оглавление ZIP');
}

function listZipEntries(buffer) {
  const directory = findZipDirectory(buffer);
  const entries = [];
  const seenNames = new Set();
  let offset = directory.offset;

  for (let index = 0; index < directory.count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Повреждено оглавление ZIP-пакета');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const checksum = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttributes = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const entryEnd = nameStart + nameLength + extraLength + commentLength;
    if (entryEnd > buffer.length) throw new Error('ZIP-пакет обрывается внутри имени файла');
    if ((flags & 0x0001) !== 0) throw new Error('Зашифрованный ZIP-пакет обновления запрещён');
    if (![0, 8].includes(method)) throw new Error(`ZIP-метод ${method} не поддерживается`);

    const rawName = buffer.subarray(nameStart, nameStart + nameLength);
    let name;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    } catch (_) {
      throw new Error('В ZIP-пакете обнаружено имя файла с неподдерживаемой кодировкой');
    }
    const isDirectory = name.endsWith('/');
    if (!allowedPackagePath(name, isDirectory)) throw new Error(`Пакет содержит недопустимый путь: ${name}`);
    if (seenNames.has(name)) throw new Error(`Пакет содержит повторяющийся путь: ${name}`);
    seenNames.add(name);

    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) throw new Error(`Символическая ссылка в ZIP-пакете запрещена: ${name}`);
    if (!isDirectory && uncompressedSize > 64 * 1024 * 1024) throw new Error(`Файл в ZIP-пакете превышает безопасный размер: ${name}`);
    entries.push({ name, isDirectory, method, checksum, compressedSize, uncompressedSize, localOffset });
    offset = entryEnd;
  }
  if (offset !== directory.offset + directory.size) throw new Error('Размер оглавления ZIP-пакета не совпадает');
  return entries;
}

export function inspectUpdateArchive(buffer) {
  return listZipEntries(Buffer.from(buffer)).map(({ name, isDirectory, method, uncompressedSize }) => ({
    name,
    isDirectory,
    method,
    uncompressedSize
  }));
}

async function extractZipSafely(buffer, entries, destination) {
  let totalBytes = 0;
  for (const entry of entries) {
    const target = path.resolve(destination, ...entry.name.replace(/\/$/, '').split('/'));
    const relative = path.relative(destination, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Путь из ZIP выходит за пределы временной папки: ${entry.name}`);
    if (entry.isDirectory) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error(`Повреждён локальный заголовок ZIP: ${entry.name}`);
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) throw new Error(`Данные файла выходят за пределы ZIP: ${entry.name}`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    let contents;
    try {
      contents = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
    } catch (_) {
      throw new Error(`Не удалось распаковать файл из обновления: ${entry.name}`);
    }
    if (contents.length !== entry.uncompressedSize || crc32(contents) !== entry.checksum) {
      throw new Error(`Контрольная сумма не совпала: ${entry.name}`);
    }
    totalBytes += contents.length;
    if (totalBytes > MAX_UNPACKED_BYTES) throw new Error('Распакованный пакет превышает безопасный размер');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, { flag: 'wx' });
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function validateExtractedPackage(root, releaseTag, archiveEntries) {
  const packageManifest = await readJson(path.join(root, UPDATE_PACKAGE_MANIFEST));
  if (!packageManifest || packageManifest.schemaVersion !== 1 || packageManifest.releaseTag !== releaseTag) {
    throw new Error('Манифест пакета не совпадает с версией опубликованного релиза');
  }
  if (!Array.isArray(packageManifest.files) || packageManifest.files.length < 4 || packageManifest.files.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('В пакете отсутствует корректный список файлов');
  }

  const declared = new Map();
  for (const file of packageManifest.files) {
    const name = String(file?.path || '');
    if (!allowedPackagePath(name) || name === UPDATE_PACKAGE_MANIFEST || declared.has(name)) {
      throw new Error(`В манифесте указан недопустимый путь: ${name}`);
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/i.test(String(file.sha256 || ''))) {
      throw new Error(`В манифесте указана некорректная контрольная сумма: ${name}`);
    }
    declared.set(name, file);
  }

  const archivedFiles = new Set(archiveEntries.filter((entry) => !entry.isDirectory && entry.name !== UPDATE_PACKAGE_MANIFEST).map((entry) => entry.name));
  if (archivedFiles.size !== declared.size || [...archivedFiles].some((name) => !declared.has(name))) {
    throw new Error('Состав файлов архива не совпадает с манифестом');
  }
  for (const [name, description] of declared) {
    const contents = await fs.readFile(path.join(root, ...name.split('/')));
    if (contents.length !== description.size || sha256(contents) !== String(description.sha256).toLowerCase()) {
      throw new Error(`Файл не прошёл проверку SHA-256: ${name}`);
    }
  }

  const extensionManifest = await readJson(path.join(root, 'extension', 'manifest.json'));
  if (!extensionManifest?.version || extensionManifest.version !== packageManifest.extensionVersion) {
    throw new Error('Версия расширения в пакете не совпадает с манифестом обновления');
  }
  if (packageManifest.extensionVersion !== versionFromTag(releaseTag)) {
    throw new Error('Версия расширения в архиве не совпадает с тегом GitHub Release');
  }
  for (const required of [
    'extension/manifest.json',
    'extension/sidepanel.html',
    'extension/sidepanel.js',
    'extension/service-worker.js',
    ...ALLOWED_DEV_FILES
  ]) {
    if (!declared.has(required)) throw new Error(`В пакете отсутствует обязательный файл: ${required}`);
  }
  if (![...declared.keys()].some((name) => name.startsWith('extension/prompts/'))) {
    throw new Error('Пакет не содержит обновлённые промпты расширения');
  }
  if (![...declared.keys()].some((name) => name.startsWith('input-ref-images/') && IMAGE_EXTENSION.test(name))) {
    throw new Error('Пакет не содержит изображения-референсы');
  }
  if ([...declared.keys()].some((name) => name.startsWith('input-watches-images/'))) {
    throw new Error('В пакет попали входные фотографии часов; обновление отменено');
  }
  return packageManifest;
}

function versionFromTag(value) {
  return String(value || '').replace(/^v/i, '');
}

function compareReleaseVersions(left, right) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(String(value || '').trim());
    return match ? match.slice(1, 4).map((part) => BigInt(part)) : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

async function fetchLatestRelease(fetchImpl) {
  const url = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'WatchAutomation-Updater'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 404) throw new Error('В GitHub пока нет опубликованного стабильного обновления');
  if (!response.ok) throw new Error(`GitHub не ответил успешно: HTTP ${response.status}`);
  const release = await response.json();
  const releaseUrl = String(release?.html_url || '');
  if (release.draft || release.prerelease || !release.tag_name
    || !releaseUrl.startsWith(`https://github.com/${UPDATE_REPOSITORY}/releases/tag/`)) {
    throw new Error('GitHub вернул неподходящий релиз обновления');
  }
  const asset = (Array.isArray(release.assets) ? release.assets : []).find((item) => item?.name === UPDATE_ASSET_NAME);
  if (!asset || !asset.browser_download_url || !Number.isFinite(Number(asset.size)) || Number(asset.size) <= 0 || Number(asset.size) > MAX_ARCHIVE_BYTES) {
    throw new Error(`В последнем релизе нет ZIP-пакета ${UPDATE_ASSET_NAME}`);
  }
  const downloadUrl = new URL(asset.browser_download_url);
  if (downloadUrl.protocol !== 'https:' || downloadUrl.hostname !== 'github.com'
    || !downloadUrl.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/download/`)) {
    throw new Error('Ссылка на ZIP-пакет ведёт за пределы репозитория');
  }
  return { release, asset };
}

async function readInstalledVersion(projectRoot) {
  const manifest = await readJson(path.join(projectRoot, 'extension', 'manifest.json'));
  return String(manifest?.version || 'неизвестна');
}

export async function writeUpdateRestartState(projectRoot, packageId, restart) {
  const markerPath = path.join(path.resolve(projectRoot), UPDATE_STATE_FILE);
  const installed = await readJson(markerPath);
  if (!installed || installed.packageId !== packageId) throw new Error('Установленный пакет изменился до перезапуска');
  const next = { ...installed, restart };
  const temporary = `${markerPath}.restart-${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, markerPath);
  return next;
}

export function installedUpdateStatus(status, installed) {
  const restartAge = Date.now() - Date.parse(installed?.restart?.requestedAt);
  const pending = installed?.restart?.phase === 'pending';
  const retryable = installed?.restart?.phase === 'error' || (pending && Number.isFinite(restartAge) && restartAge >= 120000);
  status = { ...status,
    restartRetryAvailable: Boolean(installed?.packageId && retryable && !['checking', 'downloading', 'validating', 'ready', 'applying'].includes(status.phase)),
    restartRetryAvailableAt: pending && Number.isFinite(restartAge) ? new Date(Date.parse(installed.restart.requestedAt) + 120000).toISOString() : null
  };
  if (!['idle', 'restarting'].includes(status.phase) || !installed?.restart) return status;
  const restart = installed.restart;
  const phase = restart.phase === 'complete' ? 'complete' : restart.phase === 'error' ? 'error' : 'restarting';
  return { ...status, phase, currentVersion: installed.extensionVersion, latestVersion: installed.extensionVersion,
    packageId: installed.packageId, restartRequired: phase === 'restarting',
    error: phase === 'error' ? restart.error : null,
    message: phase === 'complete' ? `Обновление ${installed.extensionVersion} установлено. Приложение перезапущено.`
      : phase === 'error' ? `Файлы обновлены, но перезапуск не завершён: ${restart.error}`
        : 'Обновление установлено. Перезапускаю приложение и локальный сервис…' };
}

// A detached helper outlives the watcher that currently serves the update
// request. It starts the updated watcher, closes only the managed browser
// profile, and then relaunches that profile with the newly installed files.
export function applicationRestartScript(config) {
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  return String.raw`
$ErrorActionPreference = 'Stop'
$config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
function Save-RestartState([string]$phase, [string]$failure = '') {
  $markerPath = Join-Path $config.projectRoot '.watch-automation-update-state.json'
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($marker.packageId -ne $config.packageId) { throw 'Installed package changed during restart' }
  $restart = @{ phase=$phase; requestedAt=$config.requestedAt; previousPid=$config.previousPid; completedAt=[DateTime]::UtcNow.ToString('o'); error=$failure }
  $marker | Add-Member -NotePropertyName restart -NotePropertyValue $restart -Force
  $temporary = $markerPath + '.restart-helper.tmp'
  [IO.File]::WriteAllText($temporary, ($marker | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $markerPath -Force
}
function Get-ManagedBrowsers {
  $profileArg = '(?:^|\s)--user-data-dir=(?:"' + [regex]::Escape($config.profilePath) + '"|' + [regex]::Escape($config.profilePath) + ')(?:\s|$)'
  @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $config.chromePath -and $_.CommandLine -match $profileArg
  })
}
try {
  if ($config.acknowledgementPath) { [IO.File]::WriteAllText($config.acknowledgementPath, [string]$PID) }
  Wait-Process -Id $config.previousPid -Timeout 30 -ErrorAction SilentlyContinue
  if (Get-Process -Id $config.previousPid -ErrorAction SilentlyContinue) { throw 'Previous local service did not stop' }
  $env:WATCH_AUTOMATION_HOST = $config.hostName
  $env:WATCH_AUTOMATION_PORT = [string]$config.port
  $nextWatcher = Start-Process -FilePath $config.nodeExecutable -ArgumentList ('"' + $config.watcherPath + '"') -WorkingDirectory $config.projectRoot -WindowStyle Hidden -PassThru
  $healthy = $false
  for ($attempt=0; $attempt -lt 60; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri $config.healthUrl -TimeoutSec 1 -UseBasicParsing
      if ($health.ok -and $health.pid -eq $nextWatcher.Id -and $health.projectRoot -eq $config.projectRoot) { $healthy=$true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (-not $healthy) { throw 'Updated local service did not become ready' }
  $browsers = @(Get-ManagedBrowsers)
  foreach ($browser in $browsers) { $process = Get-Process -Id $browser.ProcessId -ErrorAction SilentlyContinue; if ($process) { $process.CloseMainWindow() | Out-Null } }
  if ($browsers.Count) {
    Wait-Process -Id @($browsers | Select-Object -ExpandProperty ProcessId) -Timeout 8 -ErrorAction SilentlyContinue
    $remaining = @(Get-ManagedBrowsers)
    foreach ($browser in $remaining) { Stop-Process -Id $browser.ProcessId -Force -ErrorAction Stop }
    if ($remaining.Count) { Wait-Process -Id @($remaining | Select-Object -ExpandProperty ProcessId) -Timeout 10 -ErrorAction SilentlyContinue }
    if (@(Get-ManagedBrowsers).Count) { throw 'Previous automation browser did not stop' }
  }
  $arguments = @(('--user-data-dir="' + $config.profilePath + '"'), '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=IntensiveWakeUpThrottling,FreezingOnBatterySaver,InfiniteTabsFreezing,InfiniteTabsFreezingOnMemoryPressure,CalculateNativeWinOcclusion',
    ('--load-extension="' + $config.extensionPath + '"'), 'https://chatgpt.com/?watch_automation=1')
  Start-Process -FilePath $config.chromePath -ArgumentList $arguments -WorkingDirectory $config.projectRoot | Out-Null
  $browserReady = $false
  for ($attempt=0; $attempt -lt 30; $attempt++) { if (@(Get-ManagedBrowsers).Count) { $browserReady=$true; break }; Start-Sleep -Milliseconds 500 }
  if (-not $browserReady) { throw 'Chrome for Testing did not start with the automation profile' }
  Save-RestartState 'complete'
} catch {
  try { Save-RestartState 'error' $_.Exception.Message } catch {}
  exit 1
}
`;
}

export async function scheduleApplicationRestart(projectRoot, installed, {
  hostName = '127.0.0.1', port = 17321, nodeExecutable = process.execPath,
  localAppData = process.env.LOCALAPPDATA, spawnImpl = spawn, platform = process.platform
} = {}) {
  if (platform !== 'win32' || !localAppData) throw new Error('Автоматический перезапуск приложения поддерживается в Windows');
  const root = path.resolve(projectRoot);
  const browserRoot = path.join(localAppData, 'WatchAutomation', 'ChromeForTesting');
  let chromePath = null;
  for (const candidate of [path.join(browserRoot, 'chrome-win64', 'chrome.exe'), path.join(browserRoot, 'chrome.exe')]) {
    if (await fs.stat(candidate).then((info) => info.isFile()).catch(() => false)) { chromePath = candidate; break; }
  }
  if (!chromePath) throw new Error('Chrome for Testing не найден. Запусти INSTALL_WatchAutomation.cmd');
  const helperRoot = await fs.mkdtemp(path.join(root, '.watch-automation-restart-'));
  const acknowledgementPath = path.join(helperRoot, 'started.txt');
  const scriptPath = path.join(helperRoot, 'restart.ps1');
  const logPath = path.join(helperRoot, 'restart.log');
  const config = { projectRoot: root, nodeExecutable, chromePath,
    watcherPath: path.join(root, 'dev', 'watch-extension.mjs'), extensionPath: path.join(root, 'extension'),
    profilePath: path.join(localAppData, 'WatchAutomation', 'ChromeProfile'),
    hostName, port, healthUrl: `http://${hostName}:${port}/health`,
    packageId: installed.packageId, previousPid: process.pid, requestedAt: installed.restart.requestedAt,
    acknowledgementPath };
  await fs.writeFile(scriptPath, applicationRestartScript(config), 'utf8');
  const bootstrapConfig = Buffer.from(JSON.stringify({ scriptPath, logPath, outputPath: path.join(helperRoot, 'stdout.log') }), 'utf8').toString('base64');
  const bootstrap = `$ErrorActionPreference='Stop'; $launch=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bootstrapConfig}')) | ConvertFrom-Json; Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$launch.scriptPath+'"')) -WindowStyle Hidden -RedirectStandardOutput $launch.outputPath -RedirectStandardError $launch.logPath | Out-Null`;
  const encodedBootstrap = Buffer.from(bootstrap, 'utf16le').toString('base64');
  const log = await fs.open(path.join(helperRoot, 'bootstrap.log'), 'a');
  let child; let exited = false; let exitCode = null;
  try {
    child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedBootstrap], {
      cwd: root, detached: false, windowsHide: true, stdio: ['ignore', log.fd, log.fd]
    });
    child.once('exit', (code) => { exited = true; exitCode = code; });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (exited && exitCode !== 0) throw new Error(`Помощник перезапуска завершился до подтверждения (код ${exitCode}). Журналы: ${helperRoot}`);
      const acknowledgement = await fs.readFile(acknowledgementPath, 'utf8').catch(() => '');
      if (Number.isSafeInteger(Number(acknowledgement)) && Number(acknowledgement) > 0) {
        child.unref();
        return { pid: Number(acknowledgement), logPath };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Помощник перезапуска не подтвердил запуск. Журналы: ${helperRoot}`);
  } catch (error) {
    if (child && !exited) child.kill?.();
    throw error;
  } finally {
    await log.close();
  }
}

async function replaceTargets(projectRoot, stageRoot, packageManifest, releaseIdentity) {
  const backupRoot = await fs.mkdtemp(path.join(projectRoot, '.watch-automation-update-backup-'));
  const targets = [
    { relative: 'extension', directory: true },
    { relative: 'input-ref-images', directory: true },
    ...[...ALLOWED_DEV_FILES].map((relative) => ({ relative, directory: false }))
  ];
  const journal = [];
  const markerPath = path.join(projectRoot, UPDATE_STATE_FILE);
  const markerBackup = path.join(backupRoot, 'installed-state.json');
  let markerBackedUp = false;

  try {
    for (const item of targets) {
      const destination = path.join(projectRoot, ...item.relative.split('/'));
      const source = path.join(stageRoot, ...item.relative.split('/'));
      const backup = path.join(backupRoot, ...item.relative.split('/'));
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.mkdir(path.dirname(backup), { recursive: true });
      const entry = { destination, backup, hadOriginal: false, installed: false };
      journal.push(entry);
      try {
        await fs.rename(destination, backup);
        entry.hadOriginal = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await fs.rename(source, destination);
      entry.installed = true;
    }

    try {
      await fs.rename(markerPath, markerBackup);
      markerBackedUp = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const marker = {
      schemaVersion: 1,
      releaseTag: packageManifest.releaseTag,
      extensionVersion: packageManifest.extensionVersion,
      releaseIdentity,
      packageId: packageManifest.packageId,
      installedAt: new Date().toISOString()
    };
    const markerTemp = `${markerPath}.tmp`;
    await fs.writeFile(markerTemp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    await fs.rename(markerTemp, markerPath);
  } catch (error) {
    for (const entry of [...journal].reverse()) {
      if (entry.installed) await fs.rm(entry.destination, { recursive: true, force: true }).catch(() => {});
      if (entry.hadOriginal) await fs.rename(entry.backup, entry.destination).catch(() => {});
    }
    if (markerBackedUp) {
      await fs.rm(markerPath, { force: true }).catch(() => {});
      await fs.rename(markerBackup, markerPath).catch(() => {});
    }
    throw error;
  } finally {
    await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function createUpdateManager(projectRoot, { onApplyStart = null, onApplyEnd = null, onRestart = null } = {}) {
  const root = path.resolve(projectRoot);
  let status = {
    phase: 'idle',
    message: 'Нажми «Проверить и обновить», чтобы сверить версию с GitHub.',
    currentVersion: null,
    latestVersion: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    error: null
  };
  let preparePromise = null;
  let applyPromise = null;
  let restartPromise = null;
  let stageRoot = null;
  let releaseIdentity = null;

  const setStatus = (phase, message, extra = {}) => {
    status = { ...status, ...extra, phase, message, updatedAt: new Date().toISOString() };
  };

  async function restartInstalledUpdate(packageManifest, installed) {
    const restart = { phase: 'pending', requestedAt: new Date().toISOString(), previousPid: process.pid };
    installed = await writeUpdateRestartState(root, installed.packageId, restart);
    setStatus('restarting', 'Обновление установлено. Перезапускаю приложение и локальный сервис…', {
      currentVersion: installed.extensionVersion, latestVersion: installed.extensionVersion,
      packageId: installed.packageId, restartRequired: true, error: null
    });
    try {
      await onRestart({ packageManifest, installed });
      return installed;
    } catch (error) {
      await writeUpdateRestartState(root, installed.packageId, { ...restart, phase: 'error', error: error?.message || String(error) }).catch(() => {});
      throw error;
    }
  }

  async function prepareLatestUpdate(fetchImpl = globalThis.fetch) {
    const currentVersion = await readInstalledVersion(root);
    setStatus('checking', 'Проверяю опубликованную версию и подготовленные файлы…', {
      startedAt: new Date().toISOString(), currentVersion, latestVersion: null, error: null
    });
    const { release, asset } = await fetchLatestRelease(fetchImpl);
    const latestVersion = versionFromTag(release.tag_name);
    releaseIdentity = `${release.tag_name}|${asset.id || ''}|${asset.updated_at || ''}|${asset.size}`;
    const versionOrder = compareReleaseVersions(latestVersion, currentVersion);
    if (versionOrder == null) {
      throw new Error(`Не удалось безопасно сравнить установленную версию ${currentVersion} с релизом ${latestVersion}; установка отменена.`);
    }
    if (versionOrder < 0) {
      setStatus('current', `На GitHub опубликована более старая версия ${latestVersion}; установлена ${currentVersion}. Откат версии отменён.`, {
        currentVersion,
        latestVersion: null,
        error: null
      });
      return { available: false, version: latestVersion, newerInstalled: true };
    }
    const installedState = await readJson(path.join(root, UPDATE_STATE_FILE));
    if (installedState?.releaseIdentity === releaseIdentity) {
      if (onRestart && ['pending', 'error'].includes(installedState.restart?.phase)) {
        // Checking for updates is observational. Only the explicit retry
        // endpoint may launch a second restart helper.
        status = installedUpdateStatus({ ...status, phase: 'idle' }, installedState);
        return { available: false, restarting: installedState.restart.phase === 'pending' };
      }
      setStatus('current', `Установлена актуальная версия ${latestVersion}.`, { latestVersion });
      return { available: false, version: latestVersion };
    }

    setStatus('downloading', `Скачиваю обновление ${latestVersion}; входные фото часов останутся на месте.`, { latestVersion });
    const response = await fetchImpl(asset.browser_download_url, {
      headers: { 'User-Agent': 'WatchAutomation-Updater' },
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    if (!response.ok) throw new Error(`Не удалось скачать пакет обновления: HTTP ${response.status}`);
    const archiveBytes = Buffer.from(await response.arrayBuffer());
    if (!archiveBytes.length || archiveBytes.length > MAX_ARCHIVE_BYTES) throw new Error('Размер ZIP-пакета превышает безопасный предел');
    if (Number(asset.size) !== archiveBytes.length) throw new Error('Размер скачанного ZIP-пакета не совпадает с GitHub');
    const archiveDigest = sha256(archiveBytes);
    const expectedDigest = String(asset.digest || '').match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase();
    if (expectedDigest && archiveDigest !== expectedDigest) throw new Error('SHA-256 скачанного пакета не совпал с данными GitHub');

    setStatus('validating', 'Проверяю состав архива и контрольные суммы файлов…', { latestVersion });
    const entries = listZipEntries(archiveBytes);
    const nextStageRoot = await fs.mkdtemp(path.join(root, '.watch-automation-update-stage-'));
    try {
      await extractZipSafely(archiveBytes, entries, nextStageRoot);
      const packageManifest = await validateExtractedPackage(nextStageRoot, release.tag_name, entries);
      const actualDigest = expectedDigest || archiveDigest;
      if (stageRoot) await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      stageRoot = nextStageRoot;
      setStatus('ready', `Обновление ${latestVersion} проверено. Применяю его, когда рабочие вкладки свободны.`, {
        latestVersion,
        packageId: packageManifest.packageId,
        archiveDigest: actualDigest
      });
      return { available: true, version: latestVersion, packageId: packageManifest.packageId };
    } catch (error) {
      await fs.rm(nextStageRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  function startPrepare(fetchImpl = globalThis.fetch) {
    if (preparePromise || applyPromise || restartPromise || status.phase === 'ready') return false;
    preparePromise = prepareLatestUpdate(fetchImpl)
      .catch((error) => {
        setStatus('error', error?.message || String(error), { error: error?.message || String(error) });
      })
      .finally(() => { preparePromise = null; });
    return true;
  }

  async function waitForPrepare() {
    if (preparePromise) await preparePromise;
    return { ...status };
  }

  function startApply() {
    if (!stageRoot || status.phase !== 'ready' || applyPromise || restartPromise) return false;
    applyPromise = (async () => {
      const stagedRoot = stageRoot;
      let installed = null;
      let packageManifest = null;
      try {
        packageManifest = await readJson(path.join(stagedRoot, UPDATE_PACKAGE_MANIFEST));
        if (!packageManifest) throw new Error('Подготовленный пакет обновления не найден. Повтори проверку.');
        setStatus('applying', `Устанавливаю ${packageManifest.extensionVersion} и синхронизирую референсы…`);
        await onApplyStart?.();
        try {
          installed = await replaceTargets(root, stagedRoot, packageManifest, releaseIdentity);
          stageRoot = null;
        } finally {
          await onApplyEnd?.({ applied: Boolean(installed) });
        }
        await fs.rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
        if (onRestart) {
          await restartInstalledUpdate(packageManifest, installed);
          return;
        }
        setStatus('complete', `Обновление ${packageManifest.extensionVersion} установлено. Входные фотографии сохранены.`, {
          currentVersion: packageManifest.extensionVersion, latestVersion: packageManifest.extensionVersion,
          packageId: packageManifest.packageId, error: null
        });
      } catch (error) {
        if (installed && onRestart) {
          await writeUpdateRestartState(root, installed.packageId, {
            phase: 'error', requestedAt: new Date().toISOString(), previousPid: process.pid, error: error?.message || String(error)
          }).catch(() => {});
        }
        setStatus('error', installed
          ? `Файлы обновлены, но перезапуск приложения не завершён: ${error?.message || error}`
          : `Обновление отменено, исходные файлы восстановлены: ${error?.message || error}`, {
          error: error?.message || String(error)
        });
      } finally {
        if (stageRoot === stagedRoot) {
          await fs.rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
          stageRoot = null;
        }
      }
    })().finally(() => { applyPromise = null; });
    void applyPromise.catch(() => {});
    return true;
  }

  async function waitForApply() {
    if (applyPromise) await applyPromise.catch(() => {});
    return { ...status };
  }

  function startRestart() {
    const rejected = (reason, message, installed = null, retryAvailable = false) => ({
      started: false, reason, message, installed,
      status: { ...installedUpdateStatus({ ...status }, installed), restartRetryAvailable: retryAvailable }
    });
    if (restartPromise) return restartPromise;
    if (preparePromise || applyPromise || stageRoot) {
      return Promise.resolve(rejected('busy', 'Другая операция обновления ещё выполняется.'));
    }
    if (!onRestart) return Promise.resolve(rejected('unsupported', 'Перезапуск приложения недоступен в этом сервисе.'));
    restartPromise = (async () => {
      const installed = await readJson(path.join(root, UPDATE_STATE_FILE));
      if (!installed?.packageId || !['pending', 'error'].includes(installed.restart?.phase)) {
        return rejected('not_pending', 'Нет незавершённого перезапуска установленного обновления.', installed);
      }
      if (installed.restart.phase === 'pending') {
        const requestedAt = Date.parse(installed.restart.requestedAt);
        if (!Number.isFinite(requestedAt) || Date.now() - requestedAt < 120000) {
          return rejected('busy', 'Перезапуск ещё выполняется. Повтор доступен через две минуты после его начала.', installed);
        }
      }
      const restarted = await restartInstalledUpdate(installed, installed);
      return { started: true, installed: restarted, status: installedUpdateStatus({ ...status }, restarted) };
    })().catch(async (error) => {
      const message = `Файлы обновлены, но перезапуск приложения не завершён: ${error?.message || error}`;
      setStatus('error', message, { error: error?.message || String(error) });
      const installed = await readJson(path.join(root, UPDATE_STATE_FILE));
      return rejected('restart_failed', message, installed, true);
    }).finally(() => { restartPromise = null; });
    return restartPromise;
  }

  async function cancelPreparedUpdate() {
    if (applyPromise || restartPromise || ['applying', 'restarting'].includes(status.phase)) return false;
    if (stageRoot) await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    stageRoot = null;
    setStatus('idle', 'Подготовленное обновление отменено.');
    return true;
  }

  return {
    getStatus: () => ({ ...status }),
    startPrepare,
    waitForPrepare,
    startApply,
    waitForApply,
    startRestart,
    cancelPreparedUpdate
  };
}
