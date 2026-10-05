import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, promises as fs, watch as watchFiles } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createUpdateManager, installedUpdateStatus, scheduleApplicationRestart, UPDATE_STATE_FILE,
  AUTOMATION_LAUNCHER_TEMPLATE_MARKER, prepareAutomationBrowserStartup,
  repairAutomationLauncherFromTemplate } from './update-utils.mjs';
import { createResultsTransferManager } from '../extension/local-service/results-transfer.mjs';
import {
  controlCommandMatchesClient,
  extensionIdFromOrigin,
  normalizeControlClient,
  normalizeExtensionUpdateClient,
  resolveControlTarget
} from './control-routing.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_ROOT = path.join(PROJECT_ROOT, 'extension');
const HOST = process.env.WATCH_AUTOMATION_HOST || '127.0.0.1';
const PORT = Number(process.env.WATCH_AUTOMATION_PORT || 17321);
const WATCHER_API_VERSION = 11;
const WATCHER_BUILD_ID = '2026-10-05.2';
const DEBOUNCE_MS = Number(process.env.WATCH_AUTOMATION_DEBOUNCE_MS || 650);
const POLL_MS = Number(process.env.WATCH_AUTOMATION_POLL_MS || 5000);
const DOM_LIBRARY_ROOT = path.join(PROJECT_ROOT, 'diagnostics', 'dom-library');
const DOM_DIAGNOSTIC_ROOT = path.join(PROJECT_ROOT, 'diagnostics', 'dom-diagnostics');
const MAX_DOM_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_DOM_RECENT_KEYS = 10000;
const MAX_CONTROL_COMMANDS = 100;
const CONTROL_CLIENT_TTL_MS = 120000;
const CONTROL_COMMAND_CLAIM_TIMEOUT_MS = 300000;

const IGNORED_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini'
]);

const state = {
  startedAt: new Date().toISOString(),
  changedAt: null,
  revision: null,
  fileCount: 0,
  lastReason: 'startup',
  lastError: null,
  domEventsReceived: 0,
  domLastEventAt: null,
  domSessions: 0,
  diagnosticsReceived: 0,
  diagnosticLastAt: null,
  controlCommandsReceived: 0,
  controlCommandsCompleted: 0,
  controlLastCommandAt: null,
  controlLastPoll: null
};

let rescanTimer = null;
let pollingTimer = null;
let sourceWatcher = null;
let server = null;
let closing = false;
let domWriteChain = Promise.resolve();
let diagnosticWriteChain = Promise.resolve();
let updateApplying = false;
const recentDomKeys = new Set();
const recentDomKeyOrder = [];
const domSessionsSeen = new Set();
const controlCommands = [];
const controlClients = new Map();
// Use a restart-safe numeric ID. The extension persists the last consumed ID,
// while this development server may be restarted during code changes.
let nextControlId = Date.now() * 1000 + 1;

const updateManager = createUpdateManager(PROJECT_ROOT, {
  onApplyStart: async () => { updateApplying = true; },
  onApplyEnd: async ({ applied }) => {
    // Keep the installed revision hidden while the helper swaps the watcher
    // and managed browser. Failed installs still restore the current watcher.
    if (!applied) {
      updateApplying = false;
      await rescan('manual-update-failed');
    }
  },
  onRestart: async ({ installed }) => {
    updateApplying = true;
    try {
      await scheduleApplicationRestart(PROJECT_ROOT, installed, { hostName: HOST, port: PORT });
      setTimeout(close, 700);
    } catch (error) {
      updateApplying = false;
      await rescan('restart-failed');
      throw error;
    }
  }
});
const resultsTransfers = createResultsTransferManager({ outputRoot: defaultOutputRoot });

function relativePath(filePath) {
  return path.relative(EXTENSION_ROOT, filePath).split(path.sep).join('/');
}

function shouldIgnore(filePath) {
  const relative = relativePath(filePath);
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return true;
  const parts = relative.split('/');
  return parts.some((part) => (
    IGNORED_NAMES.has(part)
    || part.startsWith('.') && part !== '.well-known'
    || part.endsWith('~')
    || part.endsWith('.tmp')
    || part.endsWith('.swp')
  ));
}

async function listFiles(directory) {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (shouldIgnore(fullPath)) continue;
    if (entry.isDirectory()) {
      result.push(...await listFiles(fullPath));
    } else if (entry.isFile()) {
      result.push(fullPath);
    }
  }
  return result;
}

const LOCAL_INPUT_ROOTS = Object.freeze({
  references: path.join(PROJECT_ROOT, 'input-ref-images'),
  watches: path.join(PROJECT_ROOT, 'input-watches-images')
});

function projectRelativePath(filePath) {
  return path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/');
}

function localInputRoot(kind) {
  const root = LOCAL_INPUT_ROOTS[String(kind || '').trim()];
  if (!root) throw new Error('Поддерживаются локальные наборы references и watches');
  return root;
}

function localInputFilePath(relative) {
  const value = String(relative || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const candidate = path.resolve(PROJECT_ROOT, value);
  const relativeToProject = path.relative(PROJECT_ROOT, candidate);
  const firstPart = relativeToProject.split(path.sep)[0]?.toLowerCase();
  if (!relativeToProject || relativeToProject.startsWith('..') || path.isAbsolute(relativeToProject)) {
    throw new Error('Локальный путь выходит за пределы проекта');
  }
  if (!['input-ref-images', 'input-watches-images'].includes(firstPart)) {
    throw new Error('Разрешены только входные папки WatchesScript');
  }
  return candidate;
}

async function listLocalInputFiles(directory) {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name) || entry.name.startsWith('.') || entry.name.endsWith('~')) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listLocalInputFiles(fullPath));
    } else if (entry.isFile()) {
      const info = await fs.stat(fullPath);
      result.push({
        path: projectRelativePath(fullPath),
        name: entry.name,
        size: info.size,
        lastModified: info.mtimeMs
      });
    }
  }
  return result;
}

function mimeTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff'
  })[extension] || 'application/octet-stream';
}

function safeOutputPath(value) {
  const raw = String(value || '').replaceAll('\\', path.sep);
  const candidate = path.resolve(raw);
  const segments = candidate
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  if (!segments.includes('watchautomation')) {
    throw new Error('Разрешена проверка только файлов из папки WatchAutomation');
  }
  return candidate;
}

function defaultOutputRoot() {
  const explicit = String(process.env.WATCH_AUTOMATION_OUTPUT_ROOT || '').trim();
  if (explicit) return safeOutputRoot(explicit);
  let downloadsDirectory = path.join(homedir(), 'Downloads');
  if (process.platform === 'win32') {
    try {
      const registryValue = execFileSync('reg.exe', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        '/v',
        '{374DE290-123F-4565-9164-39C4925E467B}'
      ], { encoding: 'utf8', windowsHide: true });
      const value = String(registryValue).match(/REG_(?:EXPAND_SZ|SZ)\s+(.+)$/im)?.[1]?.trim();
      if (value) {
        downloadsDirectory = path.resolve(value.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`));
      }
    } catch (_) {}
  }
  return path.join(downloadsDirectory, 'WatchAutomation');
}

function safeOutputRoot(value) {
  const candidate = safeOutputPath(value);
  const segments = candidate.split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase());
  const index = segments.lastIndexOf('watchautomation');
  if (index < 0 || index !== segments.length - 1) {
    throw new Error('Корневая папка должна оканчиваться на WatchAutomation');
  }
  return candidate;
}

async function resolveOutputRoot(value = '') {
  const requested = String(value || '').trim();
  const candidate = requested ? safeOutputRoot(requested) : defaultOutputRoot();
  const info = await fs.stat(candidate);
  if (!info.isDirectory()) throw new Error('Папка WatchAutomation не найдена');
  return candidate;
}

async function listOutputPngFiles(root) {
  const files = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.png$/i.test(entry.name)) continue;
    const filePath = path.join(root, entry.name);
    const info = await fs.stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;
    files.push({
      path: filePath,
      relativePath: entry.name,
      groupId: '',
      outputFileName: entry.name,
      bytes: info.size,
      modifiedAt: info.mtimeMs
    });
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '_archive' || IGNORED_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
    const groupDir = path.join(root, entry.name);
    const children = await fs.readdir(groupDir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isFile() || !/\.png$/i.test(child.name)) continue;
      const filePath = path.join(groupDir, child.name);
      const info = await fs.stat(filePath).catch(() => null);
      if (!info?.isFile()) continue;
      files.push({
        path: filePath,
        relativePath: `${entry.name}/${child.name}`,
        groupId: entry.name,
        outputFileName: child.name,
        bytes: info.size,
        modifiedAt: info.mtimeMs
      });
    }
  }
  files.sort((a, b) => Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0));
  return files;
}

async function countArchivedOutputPngFiles(root) {
  const archiveRoot = path.join(root, '_archive');
  const groups = await fs.readdir(archiveRoot, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const group of groups) {
    if (!group.isDirectory() || group.name.startsWith('.')) continue;
    const files = await fs.readdir(path.join(archiveRoot, group.name), { withFileTypes: true }).catch(() => []);
    count += files.filter((entry) => entry.isFile() && /\.png$/i.test(entry.name)).length;
  }
  return count;
}

function archiveTimestamp(value = Date.now()) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '').replace('.', '-');
}

async function archiveOutputRevision(payload = {}) {
  const source = safeOutputPath(payload.path);
  if (!/\.png$/i.test(source)) throw new Error('В архив можно переместить только PNG');
  const expectedHash = String(payload.expectedHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Для архивации ревизии нужен SHA-256 PNG');
  const root = payload.root ? safeOutputRoot(payload.root) : defaultOutputRoot();
  const relative = path.relative(root, source);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('PNG должен находиться внутри папки результатов WatchAutomation');
  }
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length === 3 && parts[0] === '_archive') {
    return { archived: 1, alreadyArchived: true, files: [{ from: source, to: source }] };
  }
  if (parts.length < 1 || parts.length > 2) throw new Error('Ожидался PNG в корне или папке категории');
  const [physicalGroupId, fileName] = parts.length === 2 ? parts : ['', parts[0]];
  const info = await fs.stat(source).catch(() => null);
  if (!info?.isFile()) return { archived: 0, missing: true, files: [] };
  const expectedModifiedAt = Number(payload.expectedModifiedAt || 0);
  const expectedBytes = Number(payload.expectedBytes || 0);
  if ((expectedModifiedAt && Math.abs(Number(info.mtimeMs || 0) - expectedModifiedAt) > 1)
    || (expectedBytes && Number(info.size || 0) !== expectedBytes)) {
    throw new Error('PNG изменился после загрузки галереи; обнови список и повтори действие');
  }
  const actual = await readPngMetadata(source);
  if (expectedHash && actual.sha256.toLowerCase() !== expectedHash) {
    throw new Error('PNG на диске уже относится к другой генерации; архивирование отменено');
  }
  const afterRead = await fs.stat(source).catch(() => null);
  if (!afterRead?.isFile() || afterRead.size !== info.size || afterRead.mtimeMs !== info.mtimeMs) {
    throw new Error('PNG изменился во время проверки; архивирование отменено');
  }

  const requestedArchiveGroup = String(payload.archiveGroupId || '').trim();
  if (requestedArchiveGroup && !/^[a-z0-9_-]+$/i.test(requestedArchiveGroup)) {
    throw new Error('Некорректная категория архива');
  }
  const archiveGroupId = requestedArchiveGroup || physicalGroupId || 'legacy';
  const archiveDir = path.join(root, '_archive', archiveGroupId);
  await fs.mkdir(archiveDir, { recursive: true });
  let target;
  let serial = 0;
  do {
    const suffix = serial ? `-${serial}` : '';
    target = path.join(archiveDir, `${archiveTimestamp(info.mtimeMs || Date.now())}${suffix}__${fileName}`);
    serial += 1;
  } while (await fs.stat(target).then(() => true).catch(() => false));
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
  const archivedMetadata = await readPngMetadata(target);
  if (archivedMetadata.sha256.toLowerCase() !== actual.sha256.toLowerCase()) {
    const sourceExists = await fs.stat(source).then(() => true).catch(() => false);
    if (!sourceExists) await fs.rename(target, source).catch(() => {});
    throw new Error('PNG изменился во время переноса; изображение возвращено либо оставлено в архиве для сохранности');
  }
  return {
    archived: 1,
    outputHash: archivedMetadata.sha256,
    files: [{ from: source, to: target, modifiedAt: info.mtimeMs, bytes: info.size }],
    archiveDir
  };
}

async function deleteOutputPng(value) {
  const filePath = safeOutputPath(value);
  if (!/\.png$/i.test(filePath)) throw new Error('Удалять разрешено только PNG');
  const info = await fs.stat(filePath);
  if (!info.isFile()) throw new Error('PNG не найден');
  await fs.unlink(filePath);
  return { deleted: true, path: filePath };
}

async function readPngMetadata(filePath) {
  const info = await fs.stat(filePath);
  if (!info.isFile() || info.size < 24) throw new Error('PNG отсутствует или пуст');
  const header = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(32);
    await header.read(buffer, 0, buffer.length, 0);
    const signature = '89504e470d0a1a0a';
    if (buffer.subarray(0, 8).toString('hex') !== signature) throw new Error('Файл не является PNG');
    if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG не содержит IHDR');
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (!width || !height) throw new Error('PNG имеет нулевые размеры');
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    await new Promise((resolve, reject) => {
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return { valid: true, bytes: info.size, width, height, sha256: hash.digest('hex'), mime: 'image/png' };
  } finally {
    await header.close().catch(() => {});
  }
}

function binaryResponse(response, statusCode, body, contentType = 'application/octet-stream') {
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Length': body.length
  });
  response.end(body);
}

async function snapshotExtension() {
  // Avoid reloading Chrome while an editor has written only half of a new
  // manifest. The next filesystem event or polling pass will retry it.
  const manifest = JSON.parse(await fs.readFile(path.join(EXTENSION_ROOT, 'manifest.json'), 'utf8'));
  if (manifest?.manifest_version !== 3 || !manifest?.background?.service_worker) {
    throw new Error('manifest.json не похож на Manifest V3 расширения');
  }
  const files = (await listFiles(EXTENSION_ROOT))
    .sort((left, right) => relativePath(left).localeCompare(relativePath(right), 'en'));
  const hash = createHash('sha256');
  for (const filePath of files) {
    const content = await fs.readFile(filePath);
    hash.update(relativePath(filePath));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return {
    revision: hash.digest('hex'),
    fileCount: files.length
  };
}

async function rescan(reason) {
  if (closing || updateApplying) return;
  try {
    const next = await snapshotExtension();
    const initialized = state.revision !== null;
    const changed = initialized && state.revision !== next.revision;
    state.revision = next.revision;
    state.fileCount = next.fileCount;
    state.lastReason = reason;
    state.lastError = null;
    if (changed) {
      state.changedAt = new Date().toISOString();
      console.log(`[watch-extension] Изменение обнаружено (${reason}), revision ${state.revision.slice(0, 12)}`);
    } else if (!initialized) {
      console.log(`[watch-extension] Контрольная точка создана: ${state.revision.slice(0, 12)}, файлов ${state.fileCount}`);
    }
  } catch (error) {
    state.lastError = error?.message || String(error);
    state.lastReason = reason;
    console.error(`[watch-extension] Ошибка сканирования: ${state.lastError}`);
  }
}

function scheduleRescan(reason) {
  if (rescanTimer) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    rescan(reason).catch((error) => {
      state.lastError = error?.message || String(error);
    });
  }, Math.max(100, DEBOUNCE_MS));
}

function jsonResponse(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

function safeFileStem(value, fallback = 'unknown-session') {
  const stem = String(value || fallback)
    .replace(/[^a-zA-Z0-9а-яА-Я._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 140);
  return stem || fallback;
}

function eventKey(event) {
  return `${event?.sessionId || 'session'}:${Number(event?.sequence || 0)}`;
}

function rememberDomKey(key) {
  if (recentDomKeys.has(key)) return false;
  recentDomKeys.add(key);
  recentDomKeyOrder.push(key);
  while (recentDomKeyOrder.length > MAX_DOM_RECENT_KEYS) {
    recentDomKeys.delete(recentDomKeyOrder.shift());
  }
  return true;
}

function domDate(timestamp) {
  const parsed = new Date(timestamp || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

async function appendDomEvents(events = []) {
  const accepted = events
    .filter((event) => event && typeof event === 'object')
    .filter((event) => rememberDomKey(eventKey(event)));
  if (!accepted.length) return { accepted: 0, duplicate: events.length };

  const grouped = new Map();
  for (const event of accepted) {
    const date = domDate(event.timestamp);
    const session = safeFileStem(event.sessionId);
    const key = `${date}/${session}`;
    if (!grouped.has(key)) grouped.set(key, { date, session, events: [] });
    grouped.get(key).events.push(event);
  }

  domWriteChain = domWriteChain.catch(() => {}).then(async () => {
    await fs.mkdir(DOM_LIBRARY_ROOT, { recursive: true });
    for (const item of grouped.values()) {
      const directory = path.join(DOM_LIBRARY_ROOT, item.date);
      const filePath = path.join(directory, `${item.session}.jsonl`);
      await fs.mkdir(directory, { recursive: true });
      const body = `${item.events.map((event) => JSON.stringify(event)).join('\n')}\n`;
      await fs.appendFile(filePath, body, 'utf8');
    }
  });
  await domWriteChain;
  state.domEventsReceived += accepted.length;
  state.domLastEventAt = new Date().toISOString();
  for (const event of accepted) domSessionsSeen.add(event.sessionId);
  state.domSessions = domSessionsSeen.size;
  return { accepted: accepted.length, duplicate: events.length - accepted.length };
}

async function appendDiagnostic(diagnostic = {}) {
  if (!diagnostic || typeof diagnostic !== 'object') return { accepted: 0 };
  const capturedAt = diagnostic.capturedAt || new Date().toISOString();
  const date = domDate(capturedAt);
  const identity = safeFileStem(diagnostic.sessionId || diagnostic.operationId || diagnostic.entryName || 'diagnostic');
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fileName = `${identity}-${stamp}.json`;
  const directory = path.join(DOM_DIAGNOSTIC_ROOT, date);
  const body = JSON.stringify({
    schemaVersion: 1,
    capturedAt,
    ...diagnostic
  }, null, 2);
  if (Buffer.byteLength(body, 'utf8') > MAX_DOM_REQUEST_BYTES) {
    return { accepted: 0, error: 'Diagnostic is too large' };
  }
  diagnosticWriteChain = diagnosticWriteChain.catch(() => {}).then(async () => {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, fileName), body, 'utf8');
  });
  await diagnosticWriteChain;
  state.diagnosticsReceived += 1;
  state.diagnosticLastAt = capturedAt;
  return { accepted: 1, file: path.join(directory, fileName) };
}

async function clearDiagnostics() {
  // The deletion scope is limited to the two generated diagnostic folders.
  // Extension source, input images and generated output live elsewhere.
  await Promise.all([
    fs.rm(DOM_LIBRARY_ROOT, { recursive: true, force: true }),
    fs.rm(DOM_DIAGNOSTIC_ROOT, { recursive: true, force: true })
  ]);
  await Promise.all([
    fs.mkdir(DOM_LIBRARY_ROOT, { recursive: true }),
    fs.mkdir(DOM_DIAGNOSTIC_ROOT, { recursive: true })
  ]);
  domWriteChain = Promise.resolve();
  diagnosticWriteChain = Promise.resolve();
  recentDomKeys.clear();
  recentDomKeyOrder.splice(0, recentDomKeyOrder.length);
  domSessionsSeen.clear();
  state.domEventsReceived = 0;
  state.domLastEventAt = null;
  state.domSessions = 0;
  state.diagnosticsReceived = 0;
  state.diagnosticLastAt = null;
  return { cleared: true };
}

function normalizeControlCommand(value) {
  const command = String(value || '').trim().toLowerCase();
  const aliases = new Map([
    ['start', 'START'],
    ['run', 'START'],
    ['запуск', 'START'],
    ['старт', 'START'],
    ['resume', 'RESUME'],
    ['continue', 'RESUME'],
    ['продолжить', 'RESUME'],
    ['stop', 'STOP'],
    ['остановить', 'STOP'],
    ['стоп', 'STOP'],
    ['import_references', 'IMPORT_REFERENCES'],
    ['import-references', 'IMPORT_REFERENCES'],
    ['импорт_референсов', 'IMPORT_REFERENCES'],
    ['импорт референсов', 'IMPORT_REFERENCES'],
    ['status', 'STATUS'],
    ['состояние', 'STATUS']
  ]);
  return aliases.get(command) || null;
}

function publicControlCommand(command) {
  return {
    id: command.id,
    command: command.command,
    payload: command.payload || {},
    targetClientId: command.targetClientId || null,
    targetExtensionId: command.targetExtensionId || null,
    status: command.status,
    createdAt: command.createdAt,
    startedAt: command.startedAt || null,
    completedAt: command.completedAt || null,
    ok: command.ok ?? null,
    value: command.value ?? null,
    error: command.error || null
  };
}

function publicControlClient(client) {
  return {
    clientId: client.clientId,
    extensionId: client.extensionId,
    version: client.version,
    firstSeenAt: client.firstSeenAt,
    lastSeenAt: new Date(client.lastSeenAt).toISOString()
  };
}

function touchControlClient(request, url, bodyClientId = '', bodyExtensionId = '', bodyVersion = '') {
  const claimedExtensionId = url?.searchParams?.get('extensionId') || bodyExtensionId || '';
  const client = normalizeControlClient({
    origin: request?.headers?.origin,
    extensionId: claimedExtensionId,
    clientId: bodyClientId || url?.searchParams?.get('clientId') || '',
    version: url?.searchParams?.get('version') || bodyVersion || ''
  });
  if (!client) return null;
  const now = Date.now();
  const previous = controlClients.get(client.clientKey);
  const next = {
    ...previous,
    ...client,
    version: client.version || previous?.version || null,
    firstSeenAt: previous?.firstSeenAt || new Date(now).toISOString(),
    lastSeenAt: now
  };
  controlClients.set(client.clientKey, next);
  return next;
}

function activeControlClients() {
  const now = Date.now();
  for (const [key, client] of controlClients) {
    if (now - client.lastSeenAt > CONTROL_CLIENT_TTL_MS) controlClients.delete(key);
  }
  return [...controlClients.values()];
}

function failExpiredControlClaims() {
  const now = Date.now();
  for (const command of controlCommands) {
    if (command.status !== 'claimed' || now - Number(command.claimedAt || 0) < CONTROL_COMMAND_CLAIM_TIMEOUT_MS) continue;
    command.status = 'failed';
    command.ok = false;
    command.error = 'Экземпляр расширения не вернул результат команды за 5 минут';
    command.completedAt = new Date(now).toISOString();
    state.controlCommandsCompleted += 1;
    state.controlLastCommandAt = command.completedAt;
    console.warn(`[watch-extension] Команда ${command.command} истекла без результата, id ${command.id}`);
  }
}

function enqueueControlCommand(payload = {}, request = null) {
  const command = normalizeControlCommand(payload.command || payload.action);
  if (!command) throw new Error('Поддерживаются команды start, continue, stop и import_references');
  const caller = request ? touchControlClient(
    request,
    new URL(request.url || '/', `http://${HOST}:${PORT}`),
    payload.clientId,
    payload.extensionId,
    payload.version
  ) : null;
  const target = resolveControlTarget({
    targetClientId: payload.targetClientId || caller?.clientId || '',
    targetExtensionId: payload.targetExtensionId || ''
  }, activeControlClients());
  const item = {
    id: nextControlId++,
    command,
    payload: payload.payload && typeof payload.payload === 'object' ? payload.payload : {},
    ...target,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    ok: null,
    value: null,
    error: null
  };
  controlCommands.push(item);
  while (controlCommands.length > MAX_CONTROL_COMMANDS) controlCommands.shift();
  state.controlCommandsReceived += 1;
  state.controlLastCommandAt = item.createdAt;
  console.log(`[watch-extension] Команда ${item.command} поставлена в очередь, id ${item.id}`);
  return publicControlCommand(item);
}

function listControlCommands(url, request) {
  failExpiredControlClaims();
  const client = touchControlClient(request, url);
  if (!client) return { ok: true, nextId: nextControlId, commands: [] };
  const after = Math.max(0, Number(url.searchParams.get('after') || 0));
  const id = Number(url.searchParams.get('id') || 0);
  const commands = controlCommands.filter((item) => {
    if (!controlCommandMatchesClient(item, client)) return false;
    if (id) return item.id === id;
    if (item.id <= after || item.status !== 'queued') return false;
    item.status = 'claimed';
    item.claimedByKey = client.clientKey;
    item.claimedAt = Date.now();
    return true;
  });
  return {
    ok: true,
    nextId: nextControlId,
    commands: commands.map(publicControlCommand)
  };
}

function completeControlCommand(payload = {}, request = null) {
  const id = Number(payload.id || 0);
  const command = controlCommands.find((item) => item.id === id);
  if (!command) throw new Error(`Команда ${id} не найдена`);
  const caller = request ? touchControlClient(
    request,
    new URL(request.url || '/', `http://${HOST}:${PORT}`),
    payload.clientId,
    payload.extensionId,
    payload.version
  ) : null;
  if (!caller || !controlCommandMatchesClient(command, caller)
    || (command.claimedByKey && command.claimedByKey !== caller.clientKey)) {
    throw new Error('Команда принадлежит другому экземпляру расширения');
  }
  if (command.completedAt || ['completed', 'failed'].includes(command.status)) {
    return publicControlCommand(command);
  }
  command.status = payload.ok === true ? 'completed' : 'failed';
  command.ok = payload.ok === true;
  command.value = payload.value ?? null;
  command.error = payload.ok === true ? null : String(payload.error || 'Команда завершилась с ошибкой').slice(0, 4000);
  command.completedAt = new Date().toISOString();
  state.controlCommandsCompleted += 1;
  state.controlLastCommandAt = command.completedAt;
  console.log(`[watch-extension] Команда ${command.command} завершена (${command.ok ? 'ok' : 'error'}), id ${command.id}`);
  return publicControlCommand(command);
}

function readControlCommandResult(id) {
  const command = controlCommands.find((item) => item.id === Number(id));
  return command ? publicControlCommand(command) : null;
}

async function listDiagnosticFiles() {
  const result = [];
  let dates = [];
  try { dates = await fs.readdir(DOM_DIAGNOSTIC_ROOT, { withFileTypes: true }); } catch (_) { return result; }
  for (const dateEntry of dates.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const directory = path.join(DOM_DIAGNOSTIC_ROOT, dateEntry.name);
    let files = [];
    try { files = await fs.readdir(directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const file of files.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))) {
      const filePath = path.join(directory, file.name);
      const info = await fs.stat(filePath).catch(() => null);
      result.push({ date: dateEntry.name, name: file.name, path: filePath, size: info?.size || 0, modifiedAt: info?.mtime?.toISOString?.() || null });
    }
  }
  return result;
}

function readRequestBody(request, maximumBytes = MAX_DOM_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maximumBytes) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    request.on('error', reject);
  });
}

async function listDomLogFiles() {
  const result = [];
  let dates = [];
  try { dates = await fs.readdir(DOM_LIBRARY_ROOT, { withFileTypes: true }); } catch (_) { return result; }
  for (const dateEntry of dates.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const directory = path.join(DOM_LIBRARY_ROOT, dateEntry.name);
    let files = [];
    try { files = await fs.readdir(directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const file of files.filter((entry) => entry.isFile() && fileNameIsDomLog(entry.name))) {
      const filePath = path.join(directory, file.name);
      const info = await fs.stat(filePath).catch(() => null);
      result.push({
        date: dateEntry.name,
        session: file.name.slice(0, -'.jsonl'.length),
        path: filePath,
        size: info?.size || 0,
        modifiedAt: info?.mtime?.toISOString?.() || null
      });
    }
  }
  return result;
}

function fileNameIsDomLog(name) {
  return /^[^/\\]+\.jsonl$/i.test(String(name || ''));
}

async function readDomObservations(url) {
  const files = await listDomLogFiles();
  const session = url.searchParams.get('session');
  const operationId = url.searchParams.get('operationId');
  const entryId = url.searchParams.get('entryId');
  const eventType = url.searchParams.get('eventType');
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
  if (!session) return { ok: true, libraryRoot: DOM_LIBRARY_ROOT, files: files.slice(0, 200) };
  const wanted = safeFileStem(session);
  const file = files.find((item) => item.session === wanted);
  if (!file) return { ok: true, session: wanted, events: [], files: [] };
  const content = await fs.readFile(file.path, 'utf8').catch(() => '');
  const events = content.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch (_) { return { parseError: true, raw: line.slice(0, 1000) }; }
  }).filter((event) => (
    (!operationId || event.operationId === operationId)
    && (!entryId || event.entryId === entryId)
    && (!eventType || event.type === eventType)
  )).slice(-limit);
  return { ok: true, session: wanted, events, file: file.path };
}

async function readLatestDomObservations(url) {
  const files = await listDomLogFiles();
  const limit = Math.min(80, Math.max(1, Number(url.searchParams.get('limit') || 12)));
  const sessions = await Promise.all(files.slice(0, 100).map(async (file) => {
    const content = await fs.readFile(file.path, 'utf8').catch(() => '');
    const events = content.split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch (_) { return { parseError: true, raw: line.slice(0, 1000) }; }
    });
    return { ...file, events };
  }));
  return { ok: true, mode: 'latest', libraryRoot: DOM_LIBRARY_ROOT, sessions };
}

function stopStaleWindowsWatcherOnPort() {
  if (process.platform !== 'win32') return false;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$current=${process.pid}`,
    `$ids=@(Get-NetTCPConnection -State Listen -LocalPort ${PORT} | Select-Object -ExpandProperty OwningProcess -Unique)`,
    "$killed=$false",
    "foreach($id in $ids){ if($id -eq $current){continue}; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id); if($p -and $p.Name -match '^node(.exe)?$' -and $p.CommandLine -match 'watch-extension\\.mjs'){ Stop-Process -Id $id -Force; $killed=$true } }",
    "if($killed){exit 0}else{exit 3}"
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function startHttpServer() {
  server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${HOST}:${PORT}`);
    if (requestUrl.pathname.startsWith('/results-transfer/')) {
      const origin = String(request.headers.origin || '');
      const client = normalizeExtensionUpdateClient({ origin,
        extensionId: requestUrl.searchParams.get('extensionId'), clientId: requestUrl.searchParams.get('clientId') });
      if (!client) { jsonResponse(response, 403, { ok: false, error: 'Передача результатов доступна из расширения' }); return; }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        response.end(); return;
      }
      const id = requestUrl.searchParams.get('id');
      const owner = client.clientKey;
      let task;
      if (request.method === 'POST' && requestUrl.pathname === '/results-transfer/export') {
        task = readRequestBody(request, 16 * 1024 * 1024).then((payload) => resultsTransfers.startExport(payload.records, owner));
      } else if (request.method === 'POST' && requestUrl.pathname === '/results-transfer/import') {
        task = resultsTransfers.uploadImport(request, owner);
      } else if (request.method === 'POST' && requestUrl.pathname === '/results-transfer/install') {
        task = resultsTransfers.install(id, owner);
      } else if (request.method === 'GET' && requestUrl.pathname === '/results-transfer/status') {
        task = resultsTransfers.status(id, owner);
      } else if (request.method === 'GET' && requestUrl.pathname === '/results-transfer/verify') {
        task = resultsTransfers.verifyInstalled(id, owner);
      } else if (request.method === 'POST' && requestUrl.pathname === '/results-transfer/finish') {
        task = resultsTransfers.finishImport(id, owner);
      } else if (request.method === 'GET' && requestUrl.pathname === '/results-transfer/archive') {
        resultsTransfers.archivePath(id, owner).then(async (filePath) => {
          response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/zip',
            'Content-Length': (await fs.stat(filePath)).size, 'Cache-Control': 'no-store' });
          const stream = createReadStream(filePath);
          stream.once('close', () => {
            if (response.writableFinished) void resultsTransfers.finishExport(id, owner).catch(() => {});
          });
          stream.on('error', () => response.destroy()); stream.pipe(response);
        }).catch((error) => jsonResponse(response, 400, { ok: false, error: error.message }));
        return;
      } else { jsonResponse(response, 404, { ok: false, error: 'Неизвестный маршрут передачи' }); return; }
      task.then((value) => jsonResponse(response, 200, { ok: true, value }))
        .catch((error) => jsonResponse(response, 400, { ok: false, error: error.message }));
      return;
    }
    if (requestUrl.pathname.startsWith('/update')) {
      const origin = String(request.headers.origin || '');
      const updateClient = normalizeExtensionUpdateClient({
        origin,
        extensionId: requestUrl.searchParams.get('extensionId') || '',
        clientId: requestUrl.searchParams.get('clientId') || '',
        version: requestUrl.searchParams.get('version') || ''
      });
      if (!updateClient) {
        jsonResponse(response, 403, { ok: false, error: 'Обновление разрешено только из интерфейса расширения' });
        return;
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          'Access-Control-Allow-Origin': origin || '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Vary': 'Origin'
        });
        response.end();
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/update/status') {
        fs.readFile(path.join(PROJECT_ROOT, UPDATE_STATE_FILE), 'utf8')
          .then((contents) => JSON.parse(contents))
          .catch(() => null)
          .then((installed) => jsonResponse(response, 200, {
            ok: true,
            status: installedUpdateStatus(updateManager.getStatus(), installed),
            installed
          }));
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/update') {
        const started = updateManager.startPrepare();
        // Treat repeated requests as idempotent. Another panel/context may
        // already be checking or applying the same single staged update.
        jsonResponse(response, 202, { ok: true, started, status: updateManager.getStatus() });
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/update/apply') {
        const started = updateManager.startApply();
        const status = updateManager.getStatus();
        if (!started && !['applying', 'restarting', 'complete', 'current'].includes(String(status.phase || ''))) {
          jsonResponse(response, 409, { ok: false, error: 'Нет подготовленного обновления для установки', status });
          return;
        }
        jsonResponse(response, 202, { ok: true, started, status });
        return;
      }
      if (request.method === 'POST' && requestUrl.pathname === '/update/restart') {
        updateManager.startRestart().then((result) => {
          jsonResponse(response, result.started ? 202 : result.reason === 'restart_failed' ? 500 : 409, {
            ok: result.started, started: result.started, reason: result.reason,
            error: result.started ? undefined : result.message, status: result.status, installed: result.installed
          });
        }).catch((error) => jsonResponse(response, 500, { ok: false, error: error?.message || String(error) }));
        return;
      }
      jsonResponse(response, 404, { ok: false, error: 'Неизвестный маршрут обновления' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      response.end();
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/dom-events') {
      readRequestBody(request)
        .then((payload) => appendDomEvents(Array.isArray(payload?.events) ? payload.events : [payload?.event]))
        .then((value) => jsonResponse(response, 200, { ok: true, ...value }))
        .catch((error) => jsonResponse(response, 400, { ok: false, error: error.message }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/diagnostics') {
      readRequestBody(request)
        .then((payload) => appendDiagnostic(payload?.diagnostic || payload))
        .then((value) => jsonResponse(response, 200, { ok: true, ...value }))
        .catch((error) => jsonResponse(response, 400, { ok: false, error: error.message }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/clear-diagnostics') {
      clearDiagnostics()
        .then((value) => jsonResponse(response, 200, { ok: true, ...value }))
        .catch((error) => jsonResponse(response, 500, { ok: false, error: error.message }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/output-archive-revision') {
      readRequestBody(request)
        .then((payload) => archiveOutputRevision(payload))
        .then((value) => jsonResponse(response, 200, { ok: true, ...value }))
        .catch((error) => jsonResponse(response, 409, { ok: false, error: error.message }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/output-delete') {
      readRequestBody(request)
        .then((payload) => deleteOutputPng(payload?.path))
        .then((value) => jsonResponse(response, 200, { ok: true, ...value }))
        .catch((error) => jsonResponse(response, 400, { ok: false, error: error.message }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/control') {
      readRequestBody(request)
        .then((payload) => enqueueControlCommand(payload, request))
        .then((value) => jsonResponse(response, 202, { ok: true, command: value }))
        .catch((error) => jsonResponse(response, 400, { ok: false, error: error.message }));
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/control/result') {
      readRequestBody(request)
        .then((payload) => completeControlCommand(payload, request))
        .then((value) => jsonResponse(response, 200, { ok: true, command: value }))
        .catch((error) => jsonResponse(response, 400, { ok: false, error: error.message }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/local-input-files') {
      try {
        const kind = String(requestUrl.searchParams.get('kind') || 'references');
        const root = localInputRoot(kind);
        listLocalInputFiles(root)
          .then((files) => jsonResponse(response, 200, { ok: true, kind, root, files }))
          .catch((error) => jsonResponse(response, 404, { ok: false, error: error.message }));
      } catch (error) {
        jsonResponse(response, 400, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/local-input-file') {
      try {
        const filePath = localInputFilePath(requestUrl.searchParams.get('path'));
        fs.readFile(filePath)
          .then((body) => binaryResponse(response, 200, body, mimeTypeForPath(filePath)))
          .catch((error) => jsonResponse(response, 404, { ok: false, error: error.message }));
      } catch (error) {
        jsonResponse(response, 400, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/output-files') {
      resolveOutputRoot(requestUrl.searchParams.get('root'))
        .then(async (root) => ({
          root,
          files: await listOutputPngFiles(root),
          archivedCount: await countArchivedOutputPngFiles(root)
        }))
        .then((value) => jsonResponse(response, 200, { ok: true, ...value }))
        .catch((error) => jsonResponse(response, 404, { ok: false, error: error.message }));
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/output-file') {
      try {
        const filePath = safeOutputPath(requestUrl.searchParams.get('path'));
        if (!/\.png$/i.test(filePath)) throw new Error('Разрешено читать только PNG');
        const expectedHash = String(requestUrl.searchParams.get('expectedHash') || '').trim().toLowerCase();
        fs.readFile(filePath)
          .then(async (body) => {
            if (expectedHash) {
              if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Некорректный ожидаемый SHA-256');
              const actualHash = createHash('sha256').update(body).digest('hex');
              if (actualHash !== expectedHash) {
                jsonResponse(response, 409, { ok: false, error: 'output_hash_mismatch' });
                return;
              }
            }
            binaryResponse(response, 200, body, 'image/png');
          })
          .catch((error) => jsonResponse(response, 404, { ok: false, error: error.message }));
      } catch (error) {
        jsonResponse(response, 400, { ok: false, error: error.message });
      }
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/output-verify') {
      try {
        const filePath = safeOutputPath(requestUrl.searchParams.get('path'));
        const expectedName = String(requestUrl.searchParams.get('expected') || '').trim();
        if (expectedName && path.basename(filePath).toLowerCase() !== path.basename(expectedName).toLowerCase()) {
          jsonResponse(response, 422, {
            valid: false,
            error: 'Имя скачанного файла не совпадает с ожидаемым'
          });
          return;
        }
        readPngMetadata(filePath)
          .then((value) => jsonResponse(response, 200, value))
          .catch((error) => jsonResponse(response, 422, { valid: false, error: error.message }));
      } catch (error) {
        jsonResponse(response, 400, { valid: false, error: error.message });
      }
      return;
    }
    if (request.method !== 'GET') {
      jsonResponse(response, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    if (requestUrl.pathname === '/health') {
      jsonResponse(response, 200, { ok: true, service: 'watch-extension', apiVersion: WATCHER_API_VERSION, buildId: WATCHER_BUILD_ID, pid: process.pid, projectRoot: PROJECT_ROOT });
      return;
    }
    if (requestUrl.pathname === '/status') {
      const originExtensionId = extensionIdFromOrigin(request.headers.origin);
      const statusClient = touchControlClient(request, requestUrl);
      state.controlLastPoll = {
        at: new Date().toISOString(),
        origin: String(request.headers.origin || '').slice(0, 120) || null,
        clientId: String(requestUrl.searchParams.get('clientId') || '').slice(0, 128) || null,
        extensionId: String(requestUrl.searchParams.get('extensionId') || '').slice(0, 80) || null,
        registered: Boolean(statusClient)
      };
      // Older copies poll this shared watcher without an installation token.
      // Returning a revision to them would make an unrelated extension copy
      // reload itself and every ChatGPT tab it owns.
      const hideRevisionFromLegacyClient = Boolean(originExtensionId && !statusClient?.clientId);
      jsonResponse(response, 200, {
        ok: true,
        service: 'watch-extension',
        apiVersion: WATCHER_API_VERSION,
        buildId: WATCHER_BUILD_ID,
        pid: process.pid,
        projectRoot: PROJECT_ROOT,
        root: EXTENSION_ROOT,
        domLibraryRoot: DOM_LIBRARY_ROOT,
        domDiagnosticRoot: DOM_DIAGNOSTIC_ROOT,
        ...state,
        revision: hideRevisionFromLegacyClient ? null : state.revision,
        revisionHiddenForLegacyClient: hideRevisionFromLegacyClient
      });
      return;
    }
    if (requestUrl.pathname === '/control/clients') {
      jsonResponse(response, 200, {
        ok: true,
        clients: activeControlClients().map(publicControlClient)
      });
      return;
    }
    if (requestUrl.pathname === '/control/result') {
      const command = readControlCommandResult(requestUrl.searchParams.get('id'));
      jsonResponse(response, command ? 200 : 404, command
        ? { ok: true, command }
        : { ok: false, error: 'Команда не найдена' });
      return;
    }
    if (requestUrl.pathname === '/control') {
      jsonResponse(response, 200, listControlCommands(requestUrl, request));
      return;
    }
    if (requestUrl.pathname === '/observations') {
      const reader = requestUrl.searchParams.get('latest') === '1'
        ? readLatestDomObservations(requestUrl)
        : readDomObservations(requestUrl);
      reader
        .then((value) => jsonResponse(response, 200, value))
        .catch((error) => jsonResponse(response, 500, { ok: false, error: error.message }));
      return;
    }
    if (requestUrl.pathname === '/diagnostics') {
      listDiagnosticFiles()
        .then((files) => jsonResponse(response, 200, { ok: true, files: files.slice(0, 200) }))
        .catch((error) => jsonResponse(response, 500, { ok: false, error: error.message }));
      return;
    }
    jsonResponse(response, 404, { ok: false, error: 'Not found' });
  });

  let bindRetryCount = 0;
  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE' && bindRetryCount < 2 && stopStaleWindowsWatcherOnPort()) {
      bindRetryCount += 1;
      console.error(`[watch-extension] Порт ${PORT} занят старым WatchAutomation watcher. Перезапускаю локальный сервис…`);
      setTimeout(() => server.listen(PORT, HOST), 700);
      return;
    }
    if (error?.code === 'EADDRINUSE') {
      console.error(`[watch-extension] Порт ${PORT} занят другим процессом. Не завершаю посторонний процесс.`);
    } else {
      console.error(`[watch-extension] Ошибка HTTP-сервера: ${error?.message || error}`);
    }
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log(`[watch-extension] Слежение: ${EXTENSION_ROOT}`);
    console.log(`[watch-extension] Endpoint: http://${HOST}:${PORT}/status`);
    console.log('[watch-extension] Оставьте это окно запущенным во время разработки.');
  });
}

function startFileWatcher() {
  try {
    sourceWatcher = watchFiles(EXTENSION_ROOT, { recursive: true }, (_eventType, filename) => {
      scheduleRescan(filename ? `fs.watch:${filename}` : 'fs.watch');
    });
    sourceWatcher.on('error', (error) => {
      console.error(`[watch-extension] fs.watch недоступен: ${error?.message || error}`);
      scheduleRescan('watcher-error');
    });
  } catch (error) {
    console.error(`[watch-extension] Рекурсивное наблюдение недоступно: ${error?.message || error}`);
  }
  pollingTimer = setInterval(() => scheduleRescan('poll'), Math.max(1000, POLL_MS));
}

function close() {
  if (closing) return;
  closing = true;
  if (rescanTimer) clearTimeout(rescanTimer);
  if (pollingTimer) clearInterval(pollingTimer);
  sourceWatcher?.close();
  server?.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.once('SIGINT', close);
process.once('SIGTERM', close);

async function startAutomationStartupMaintenance() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return;
  const profilePath = path.join(process.env.LOCALAPPDATA, 'WatchAutomation', 'ChromeProfile');
  const rootLauncher = await fs.readFile(path.join(PROJECT_ROOT, 'launch-automation-profile.cmd'), 'utf8').catch(() => '');
  if (!rootLauncher.includes(AUTOMATION_LAUNCHER_TEMPLATE_MARKER)) {
    void prepareAutomationBrowserStartup(profilePath, { timeoutMs: 20000, pollMs: 100 })
      .then(({ changed }) => {
        if (changed) console.info('[watch-extension] Browser startup profile prepared.');
      })
      .catch(() => console.warn('[watch-extension] Browser startup profile was left unchanged.'));
  }
  void repairAutomationLauncherFromTemplate(PROJECT_ROOT, { timeoutMs: 30000, pollMs: 100 })
    .then(({ changed }) => {
      if (changed) console.info('[watch-extension] Root launcher repaired from the packaged template.');
    })
    .catch(() => console.warn('[watch-extension] Root launcher repair was skipped.'));
}

if (process.argv[2] === '--prepare-browser-startup') {
  try {
    const result = await prepareAutomationBrowserStartup(process.argv[3]);
    console.log(`Browser startup prepared; startup URL count: ${result.startupUrlCount}.`);
  } catch {
    console.error('Browser startup preparation failed; Preferences were left unchanged.');
    process.exitCode = 1;
  }
} else {
  await rescan('startup');
  startHttpServer();
  startFileWatcher();
  void startAutomationStartupMaintenance();
}
