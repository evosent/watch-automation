import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_FILES = [
  'dev/watch-extension.mjs',
  'dev/update-utils.mjs',
  'dev/update-watch-automation.mjs'
];
const BOOTSTRAP_FILES = [
  'UPDATE_WatchAutomation.cmd',
  'dev/update-utils.mjs',
  'dev/update-watch-automation.mjs'
];
const ROOT_IMAGE_EXTENSION = /\.(?:png|jpe?g|webp)$/i;
const IGNORED_FILE_NAMES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store']);

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function copyTree(source, destination, { imageOnly = false } = {}) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_FILE_NAMES.has(entry.name) || entry.name.endsWith('~') || entry.name.endsWith('.tmp')) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath, { imageOnly });
      continue;
    }
    if (!entry.isFile() || (imageOnly && !ROOT_IMAGE_EXTENSION.test(entry.name))) continue;
    await fs.copyFile(sourcePath, destinationPath);
  }
}

async function collectFiles(root, prefix = '') {
  const files = [];
  const entries = await fs.readdir(path.join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_FILE_NAMES.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filePath = path.join(root, ...relative.split('/'));
    if (entry.isDirectory()) files.push(...await collectFiles(root, relative));
    else if (entry.isFile()) {
      const contents = await fs.readFile(filePath);
      files.push({ path: relative, size: contents.length, sha256: sha256(contents) });
    }
  }
  return files;
}

function buildTag(version) {
  const provided = String(process.argv[2] || `v${version}`).trim();
  const expected = `v${version}`;
  if (provided !== expected) throw new Error(`Тег релиза должен совпадать с extension/manifest.json: ${expected}`);
  return provided;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Сборщик обновлений рассчитан на Windows и использует Compress-Archive');
  const extensionManifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'extension', 'manifest.json'), 'utf8'));
  const version = String(extensionManifest.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('В manifest.json требуется версия вида 0.3.32');
  const releaseTag = buildTag(version);
  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-automation-update-build-'));
  const bootstrapRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-automation-bootstrap-build-'));
  const outputPath = path.join(PROJECT_ROOT, 'dist', 'watch-automation-update.zip');
  const bootstrapOutputPath = path.join(PROJECT_ROOT, 'dist', 'watch-automation-bootstrap.zip');

  try {
    await fs.mkdir(path.join(stageRoot, 'dev'), { recursive: true });
    await fs.mkdir(path.join(bootstrapRoot, 'dev'), { recursive: true });
    await copyTree(path.join(PROJECT_ROOT, 'extension'), path.join(stageRoot, 'extension'));
    await copyTree(path.join(PROJECT_ROOT, 'input-ref-images'), path.join(stageRoot, 'input-ref-images'), { imageOnly: true });
    for (const relative of UPDATE_FILES) {
      await fs.copyFile(path.join(PROJECT_ROOT, relative), path.join(stageRoot, ...relative.split('/')));
    }
    for (const relative of BOOTSTRAP_FILES) {
      await fs.copyFile(path.join(PROJECT_ROOT, relative), path.join(bootstrapRoot, ...relative.split('/')));
    }

    const files = (await collectFiles(stageRoot)).sort((left, right) => left.path.localeCompare(right.path));
    if (!files.some((file) => file.path.startsWith('input-ref-images/'))) throw new Error('В input-ref-images не найдено ни одного изображения-референса');
    if (files.some((file) => file.path.startsWith('input-watches-images/'))) throw new Error('В обновляющий пакет попали входные фото часов');
    const packageId = `${releaseTag}-${sha256(Buffer.from(files.map((file) => `${file.path}:${file.sha256}`).join('\n'))).slice(0, 24)}`;
    const packageManifest = {
      schemaVersion: 1,
      releaseTag,
      extensionVersion: version,
      packageId,
      createdAt: new Date().toISOString(),
      files
    };
    await fs.writeFile(path.join(stageRoot, 'watch-automation-update-package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8');

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.rm(outputPath, { force: true });
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      `$source = ${quotePowerShell(path.join(stageRoot, 'extension'))}, ${quotePowerShell(path.join(stageRoot, 'input-ref-images'))}, ${quotePowerShell(path.join(stageRoot, 'dev'))}, ${quotePowerShell(path.join(stageRoot, 'watch-automation-update-package.json'))}`,
      `$destination = ${quotePowerShell(outputPath)}`,
      'Compress-Archive -Path $source -DestinationPath $destination -CompressionLevel Optimal -Force'
    ].join('\n');
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript
    ], { stdio: 'inherit' });

    const bootstrapPowerShell = [
      '$ErrorActionPreference = "Stop"',
      `$source = ${quotePowerShell(path.join(bootstrapRoot, '*'))}`,
      `$destination = ${quotePowerShell(bootstrapOutputPath)}`,
      'Compress-Archive -Path $source -DestinationPath $destination -CompressionLevel Optimal -Force'
    ].join('\n');
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', bootstrapPowerShell
    ], { stdio: 'inherit' });

    const archive = await fs.readFile(outputPath);
    const digest = sha256(archive);
    await fs.writeFile(`${outputPath}.sha256`, `${digest}  ${path.basename(outputPath)}\n`, 'utf8');
    const bootstrapArchive = await fs.readFile(bootstrapOutputPath);
    const bootstrapDigest = sha256(bootstrapArchive);
    await fs.writeFile(`${bootstrapOutputPath}.sha256`, `${bootstrapDigest}  ${path.basename(bootstrapOutputPath)}\n`, 'utf8');
    console.log(`Пакет: ${outputPath}`);
    console.log(`Тег GitHub Release: ${releaseTag}`);
    console.log(`Версия расширения: ${version}`);
    console.log(`Файлов в архиве: ${files.length}`);
    console.log(`Архив: ${(archive.length / 1024 / 1024).toFixed(1)} МБ`);
    console.log(`SHA-256: ${digest}`);
    console.log('input-watches-images в пакет не включается.');
    console.log(`Стартовый пакет: ${bootstrapOutputPath}`);
    console.log(`Стартовый пакет SHA-256: ${bootstrapDigest}`);
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
    await fs.rm(bootstrapRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Не удалось собрать пакет обновления: ${error?.message || error}`);
  process.exitCode = 1;
});
