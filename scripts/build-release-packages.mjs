import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ROOT = path.join(PROJECT_ROOT, 'dist');
const PHOTO_ROOT = path.join(PROJECT_ROOT, 'input-watches-images');
const PHOTO_DATA_TAG = 'watch-photos-v1';
const PHOTO_ARCHIVE_NAME = 'watch-photos-v1.tar';
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp)$/i;
const SYSTEM_ENTRIES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store']);
const MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function quotePowerShell(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

async function copyTree(source, destination, { imageOnly = false } = {}) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SYSTEM_ENTRIES.has(entry.name) || entry.name.endsWith('~') || entry.name.endsWith('.tmp')) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath, { imageOnly });
      continue;
    }
    if (!entry.isFile() || (imageOnly && !IMAGE_EXTENSION.test(entry.name))) continue;
    await fs.copyFile(sourcePath, destinationPath);
  }
}

async function walkFiles(root, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SYSTEM_ENTRIES.has(entry.name)) continue;
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    const absolutePath = path.join(root, ...relative.split('/'));
    if (entry.isDirectory()) files.push(...await walkFiles(root, relative));
    else if (entry.isFile()) files.push({ path: relative, absolutePath, size: (await fs.stat(absolutePath)).size });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walkDirectories(root, prefix = '') {
  const directories = [];
  for (const entry of await fs.readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SYSTEM_ENTRIES.has(entry.name)) continue;
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    directories.push(relative);
    directories.push(...await walkDirectories(root, relative));
  }
  return directories.sort((left, right) => left.localeCompare(right));
}

function runPowerShell(lines) {
  execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', lines.join('\n')
  ], { stdio: 'inherit' });
}

async function buildInstallerPackage(stageRoot, outputPath, version) {
  await fs.mkdir(stageRoot, { recursive: true });
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: PROJECT_ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((relative) => !relative.startsWith('input-watches-images/'));
  if (!tracked.includes('Install_From_GitHub.ps1') || !tracked.includes('INSTALL_FROM_GITHUB.cmd')) {
    throw new Error('Сначала добавь GitHub-установщик в Git, затем собери релизный пакет.');
  }
  for (const relative of tracked) {
    const sourcePath = path.join(PROJECT_ROOT, ...relative.split('/'));
    const destinationPath = path.join(stageRoot, ...relative.split('/'));
    const stat = await fs.stat(sourcePath).catch(() => null);
    if (!stat?.isFile()) continue;
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
  }
  await copyTree(path.join(PROJECT_ROOT, 'input-ref-images'), path.join(stageRoot, 'input-ref-images'), { imageOnly: true });

  const files = await walkFiles(stageRoot);
  if (!files.some((file) => file.path.startsWith('input-ref-images/'))) throw new Error('Релизный пакет не содержит входные визуальные референсы.');
  if (files.some((file) => file.path.startsWith('input-watches-images/'))) throw new Error('Защитная проверка: в установочный пакет попали фото часов.');
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const fileManifest = {
    schemaVersion: 1,
    releasePackage: 'watch-automation-installer-package.zip',
    extensionVersion: version,
    fileCount: files.length,
    totalBytes,
    files: files.map(({ path: relative, size }) => ({ path: relative, size }))
  };
  await fs.writeFile(path.join(stageRoot, 'watch-automation-installer-manifest.json'), JSON.stringify(fileManifest, null, 2) + '\n', 'utf8');

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.rm(outputPath, { force: true });
  runPowerShell([
    '$ErrorActionPreference = "Stop"',
    '$source = ' + quotePowerShell(path.join(stageRoot, '*')),
    '$destination = ' + quotePowerShell(outputPath),
    'Compress-Archive -Path $source -DestinationPath $destination -CompressionLevel Optimal -Force'
  ]);
  const archiveStat = await fs.stat(outputPath);
  const digest = await sha256File(outputPath);
  await fs.writeFile(outputPath + '.sha256', digest + '  ' + path.basename(outputPath) + '\n', 'utf8');
  console.log('Полный установочный пакет: ' + outputPath);
  console.log('Файлов приложения: ' + files.length + '; фото часов исключены; референсы включены.');
  console.log('Размер ZIP: ' + (archiveStat.size / 1024 / 1024).toFixed(1) + ' МБ; SHA-256: ' + digest);
}

async function buildPhotoArchive(outputPath, manifestPath) {
  const photoFiles = await walkFiles(PHOTO_ROOT);
  const photoDirectories = await walkDirectories(PHOTO_ROOT);
  const invalidFiles = photoFiles.filter((file) => !IMAGE_EXTENSION.test(file.path));
  if (invalidFiles.length) throw new Error('В фототеке найдены файлы неподдерживаемого типа: ' + invalidFiles.slice(0, 5).map((file) => file.path).join(', '));
  if (!photoFiles.length) throw new Error('input-watches-images пустая.');
  for (const requiredFolder of ['in_sale', 'not_in_sale']) {
    if (!(await fs.stat(path.join(PHOTO_ROOT, requiredFolder)).catch(() => null))?.isDirectory()) {
      throw new Error('В фототеке отсутствует обязательная папка: ' + requiredFolder);
    }
  }
  for (const file of photoFiles) {
    if (/[\r\n]/.test(file.path)) throw new Error('Имя фото содержит перевод строки, его нельзя безопасно упаковать: ' + file.path);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.rm(outputPath, { force: true });
  execFileSync('tar.exe', [
    '-cf', outputPath, '-C', PROJECT_ROOT,
    'input-watches-images/in_sale',
    'input-watches-images/not_in_sale'
  ], { stdio: 'inherit' });
  const archiveStat = await fs.stat(outputPath);
  if (archiveStat.size >= MAX_RELEASE_ASSET_BYTES) {
    throw new Error('Архив фототеки должен быть меньше 2 ГиБ на один GitHub Release asset; сейчас ' + archiveStat.size + ' байт.');
  }
  const archiveNames = execFileSync('tar.exe', ['-tf', outputPath], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean);
  const archiveImages = archiveNames.filter((name) => IMAGE_EXTENSION.test(name));
  if (archiveImages.length !== photoFiles.length) {
    throw new Error('В TAR попало ' + archiveImages.length + ' изображений, ожидалось ' + photoFiles.length + '.');
  }
  const allowedDirectories = new Set(['input-watches-images', 'input-watches-images/']);
  for (const directory of photoDirectories) {
    const archivePath = 'input-watches-images/' + directory.replaceAll('\\', '/');
    allowedDirectories.add(archivePath);
    allowedDirectories.add(archivePath + '/');
  }
  for (const name of archiveNames) {
    const normalized = name.replaceAll('\\', '/');
    if ((normalized !== 'input-watches-images' && !normalized.startsWith('input-watches-images/')) ||
        normalized.split('/').some((part) => part === '..')) {
      throw new Error('Небезопасный путь в TAR фототеки: ' + name);
    }
    if (!IMAGE_EXTENSION.test(normalized) && !allowedDirectories.has(normalized)) {
      throw new Error('В TAR фототеки попал файл вне списка изображений: ' + name);
    }
  }

  const manifest = {
    schemaVersion: 1,
    releaseTag: PHOTO_DATA_TAG,
    archiveAsset: path.basename(outputPath),
    imageCount: photoFiles.length,
    totalBytes: photoFiles.reduce((sum, file) => sum + file.size, 0),
    archiveBytes: archiveStat.size,
    directories: photoDirectories,
    files: photoFiles.map((file) => ({ path: file.path, size: file.size }))
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const digest = await sha256File(outputPath);
  await fs.writeFile(outputPath + '.sha256', digest + '  ' + path.basename(outputPath) + '\n', 'utf8');
  console.log('Фототека: ' + photoFiles.length + ' PNG, ' + manifest.totalBytes + ' байт.');
  console.log('TAR: ' + outputPath + ' (' + archiveStat.size + ' байт); SHA-256: ' + digest);
  console.log('Манифест фототеки: ' + manifestPath);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Сборщик релиза использует встроенные Windows PowerShell и tar.exe.');
  const extensionManifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'));
  const version = String(extensionManifest.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('В extension/manifest.json требуется версия вида 0.3.33.');

  execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'build-update-package.mjs'), 'v' + version], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit'
  });

  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-automation-installer-build-'));
  const packageOutput = path.join(DIST_ROOT, 'watch-automation-installer-package.zip');
  const photoOutput = path.join(DIST_ROOT, PHOTO_ARCHIVE_NAME);
  const photoManifest = path.join(DIST_ROOT, 'watch-photos-manifest.json');
  try {
    await buildInstallerPackage(stageRoot, packageOutput, version);
    await buildPhotoArchive(photoOutput, photoManifest);
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Не удалось собрать пакеты релиза: ' + (error?.message || error));
  process.exitCode = 1;
});
