import { randomUUID } from 'node:crypto';
import { createWriteStream, constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RESULTS_PACKAGE_FORMAT, RESULTS_PACKAGE_VERSION, MAX_RESULT_RECORDS,
  portableResult, validateResultsManifest } from '../results-transfer-utils.js';
import { MAX_RESULTS_ARCHIVE_BYTES, pngMetadata, writeResultsZip, extractResultsZip } from './results-archive.mjs';

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
async function safeDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Папка результатов содержит ссылку');
  return fs.realpath(directory);
}
async function readPng(filePath, root) {
  const real = await fs.realpath(filePath);
  const relative = path.relative(root, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PNG находится за пределами папки результатов');
  const info = await fs.stat(real);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('Неверный размер PNG');
  const bytes = await fs.readFile(real);
  return { bytes, metadata: pngMetadata(bytes) };
}

export function createResultsTransferManager({ outputRoot }) {
  const active = new Set();
  const cache = new Map();
  const idPattern = /^[a-f0-9-]{36}$/;
  // Resolve the Windows Downloads location once; registry lookup on every
  // progress update would block the service's event loop during large exports.
  let resolvedRoot;
  const rootPath = () => resolvedRoot ||= (typeof outputRoot === 'function' ? outputRoot() : outputRoot);
  const pathsFor = async (id) => {
    if (!idPattern.test(String(id || ''))) throw new Error('Некорректный ID передачи');
    const root = await safeDirectory(rootPath());
    const staging = await safeDirectory(path.join(root, '.result-transfers'));
    const directory = path.join(staging, id);
    const directoryInfo = await fs.lstat(directory).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (directoryInfo && (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())) throw new Error('Временная папка передачи содержит ссылку');
    return { root, directory, statePath: path.join(directory, 'state.json') };
  };
  const save = async (job) => {
    const snapshot = structuredClone(job);
    const { directory, statePath } = await pathsFor(job.id);
    await safeDirectory(directory);
    const temp = `${statePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(snapshot));
    // Windows readers/antivirus can briefly hold the previous state file.
    // Keep replacement atomic and retry the transient sharing violation.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, statePath); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    cache.set(job.id, snapshot);
    if (cache.size > 64) for (const key of cache.keys()) {
      if (key !== job.id && !active.has(key)) { cache.delete(key); break; }
    }
  };
  const load = async (id, owner) => {
    if (!idPattern.test(String(id || ''))) throw new Error('Некорректный ID передачи');
    const { statePath } = await pathsFor(id);
    const job = cache.get(id) || JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (job.owner !== owner) throw new Error('Эта передача принадлежит другому экземпляру расширения');
    return structuredClone(job);
  };
  const launch = (job, task) => {
    active.add(job.id);
    void (async () => {
      try { await task(); }
      catch (error) {
        job.phase = 'error'; job.error = error.message;
        if (job.kind === 'export' || !job.items) {
          const { directory } = await pathsFor(job.id);
          await fs.rm(path.join(directory, 'extracted'), { recursive: true, force: true });
          await fs.rm(path.join(directory, 'images'), { recursive: true, force: true });
          await fs.rm(path.join(directory, 'results.zip'), { force: true });
        }
        try { await save(job); } catch (_) { cache.set(job.id, job); }
      }
      finally { active.delete(job.id); }
    })().catch((error) => { job.phase = 'error'; job.error = error.message; cache.set(job.id, structuredClone(job)); });
  };
  return {
    async startExport(records, owner) {
      if (!Array.isArray(records) || !records.length || records.length > MAX_RESULT_RECORDS) throw new Error('Выбери от 1 до 5000 результатов');
      const job = { id: randomUUID(), owner, kind: 'export', phase: 'exporting', processed: 0, total: records.length, skipped: [] };
      await save(job);
      launch(job, async () => {
        const { root, directory } = await pathsFor(job.id);
        const images = new Map(), items = [], seen = new Set();
        for (const record of records) {
          try {
            const portable = portableResult(record);
            const key = `${portable.sourceId}|${portable.outputHash}`;
            if (seen.has(key)) { job.processed++; continue; }
            seen.add(key);
            const file = await readPng(record.outputPath, root);
            if (file.metadata.sha256 !== portable.outputHash) throw new Error('PNG на диске изменился');
            const image = `images/${portable.outputHash}.png`;
            if (!images.has(image)) {
              const target = path.join(directory, ...image.split('/'));
              await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.bytes, { flag: 'wx' });
              images.set(image, { name: image, path: target });
            }
            items.push({ ...portable, outputWidth: file.metadata.width, outputHeight: file.metadata.height, image });
          } catch (error) { job.skipped.push({ modelName: record.modelName || record.fileName || record.sourceId, reason: error.message }); }
          job.processed++; await save(job);
        }
        if (!items.length) throw new Error('В папке результатов не найдено ни одного подходящего PNG');
        const manifest = { format: RESULTS_PACKAGE_FORMAT, schemaVersion: RESULTS_PACKAGE_VERSION,
          exportedAt: new Date().toISOString(), items };
        await writeResultsZip(path.join(directory, 'results.zip'), [
          { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest)) }, ...images.values()
        ]);
        await fs.rm(path.join(directory, 'images'), { recursive: true, force: true });
        job.phase = 'ready'; job.count = items.length; job.models = new Set(items.map((item) => item.sourceId)).size;
        await save(job);
      });
      return job;
    },
    async uploadImport(request, owner) {
      const job = { id: randomUUID(), owner, kind: 'import', phase: 'checking', processed: 0 };
      await save(job);
      const { directory } = await pathsFor(job.id);
      const archivePath = path.join(directory, 'results.zip');
      let bytes = 0;
      try {
        await pipeline(request, new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > MAX_RESULTS_ARCHIVE_BYTES ? new Error('Архив превышает 1 ГБ') : null, chunk);
        } }), createWriteStream(archivePath, { flags: 'wx' }));
      } catch (error) {
        job.phase = 'error'; job.error = error.message;
        await fs.rm(archivePath, { force: true }); await save(job); throw error;
      }
      launch(job, async () => {
        const extracted = path.join(directory, 'extracted');
        const entries = await extractResultsZip(archivePath, extracted);
        const manifest = validateResultsManifest(JSON.parse(await fs.readFile(path.join(extracted, 'manifest.json'), 'utf8')));
        const expected = new Set(['manifest.json', ...manifest.items.map((item) => item.image)]);
        if (expected.size !== entries.length || entries.some((entry) => !expected.has(entry.name))) throw new Error('Состав архива не совпадает с манифестом');
        for (const item of manifest.items) {
          const file = await readPng(path.join(extracted, ...item.image.split('/')), await fs.realpath(extracted));
          if (file.metadata.sha256 !== item.outputHash) throw new Error(`Контрольная сумма PNG не совпала: ${item.modelName}`);
          item.outputWidth = file.metadata.width; item.outputHeight = file.metadata.height;
          job.processed++;
        }
        job.items = manifest.items; job.total = manifest.items.length; job.phase = 'ready'; await save(job);
      });
      return job;
    },
    async status(id, owner) { return load(id, owner); },
    async verifyInstalled(id, owner) {
      const job = await load(id, owner);
      if (job.kind !== 'import' || job.phase !== 'installed') throw new Error('PNG ещё не установлены');
      const { root } = await pathsFor(id);
      for (const item of job.items) {
        const file = await readPng(item.outputPath, root);
        if (file.metadata.sha256 !== item.outputHash) throw new Error('Установленный PNG изменился');
      }
      return job;
    },
    async finishImport(id, owner) {
      const job = await load(id, owner);
      if (job.kind !== 'import' || job.phase !== 'installed') throw new Error('Импорт ещё не установлен');
      const { directory } = await pathsFor(id);
      await fs.rm(path.join(directory, 'extracted'), { recursive: true, force: true });
      await fs.rm(path.join(directory, 'results.zip'), { force: true });
      job.cleaned = true; await save(job); return { cleaned: true };
    },
    async archivePath(id, owner) {
      const job = await load(id, owner);
      if (job.kind !== 'export' || job.phase !== 'ready') throw new Error('Архив ещё не готов');
      return path.join((await pathsFor(id)).directory, 'results.zip');
    },
    async finishExport(id, owner) {
      const job = await load(id, owner);
      if (job.kind !== 'export' || job.phase !== 'ready') return;
      const { directory } = await pathsFor(id);
      await fs.rm(path.join(directory, 'results.zip'), { force: true });
      job.phase = 'downloaded'; await save(job);
    },
    async install(id, owner) {
      const job = await load(id, owner);
      if (job.kind !== 'import' || !job.items || !['ready', 'installing', 'installed', 'error'].includes(job.phase)) throw new Error('Архив ещё не проверен');
      if (job.phase === 'installed' || active.has(id)) return job;
      active.add(id);
      job.phase = 'installing'; delete job.error;
      try { await save(job); } catch (error) { active.delete(id); throw error; }
      launch(job, async () => {
        const { root, directory } = await pathsFor(id);
        const installed = [];
        for (const item of job.items) {
          const source = path.join(directory, 'extracted', ...item.image.split('/'));
          const sourceFile = await readPng(source, await fs.realpath(path.join(directory, 'extracted')));
          if (sourceFile.metadata.sha256 !== item.outputHash) throw new Error('PNG изменился после проверки архива');
          const targetDirectory = await safeDirectory(path.join(root, item.groupId));
          const stem = String(item.modelName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80).replace(/[. ]+$/, '') || 'watch';
          const target = path.join(targetDirectory, `${stem}__import_${item.outputHash}.png`);
          try { await fs.copyFile(source, target, constants.COPYFILE_EXCL); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
          const targetFile = await readPng(target, root);
          if (targetFile.metadata.sha256 !== item.outputHash) throw new Error('Файл назначения занят другим PNG');
          installed.push({ ...item, outputPath: target, verificationMode: 'results-import-sha256' });
        }
        job.items = installed; job.phase = 'installed'; job.root = root; await save(job);
      });
      return job;
    }
  };
}
