import { createHash } from 'node:crypto';
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

async function validateExtractedPackage(root, releaseTag, archiveEntries) {
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

export function createUpdateManager(projectRoot, { onApplyStart = null, onApplyEnd = null } = {}) {
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
  let stageRoot = null;
  let releaseIdentity = null;

  const setStatus = (phase, message, extra = {}) => {
    status = { ...status, ...extra, phase, message, updatedAt: new Date().toISOString() };
  };

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
    if (preparePromise || applyPromise || status.phase === 'ready') return false;
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
    if (!stageRoot || status.phase !== 'ready' || applyPromise) return false;
    applyPromise = (async () => {
      const stagedRoot = stageRoot;
      const packageManifest = await readJson(path.join(stagedRoot, UPDATE_PACKAGE_MANIFEST));
      setStatus('applying', `Устанавливаю ${packageManifest.extensionVersion} и синхронизирую референсы…`);
      await onApplyStart?.();
      try {
        await replaceTargets(root, stagedRoot, packageManifest, releaseIdentity);
        stageRoot = null;
        setStatus('complete', `Обновление ${packageManifest.extensionVersion} установлено. Входные фотографии сохранены.`, {
          currentVersion: packageManifest.extensionVersion,
          latestVersion: packageManifest.extensionVersion,
          packageId: packageManifest.packageId,
          error: null
        });
        await fs.rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
      } catch (error) {
        setStatus('error', `Обновление отменено, исходные файлы восстановлены: ${error?.message || error}`, {
          error: error?.message || String(error)
        });
        throw error;
      } finally {
        await onApplyEnd?.();
        applyPromise = null;
      }
    })();
    void applyPromise.catch(() => {});
    return true;
  }

  async function waitForApply() {
    if (applyPromise) await applyPromise.catch(() => {});
    return { ...status };
  }

  async function cancelPreparedUpdate() {
    if (status.phase === 'applying') return false;
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
    cancelPreparedUpdate
  };
}
