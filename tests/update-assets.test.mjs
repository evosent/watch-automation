import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { DB_NAME, getAsset, replaceAssets, replaceAssetsFromLoader } from '../extension/idb.js';

function deleteDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`IndexedDB ${DB_NAME} deletion was blocked`));
  });
}

test('reference updater can force-refresh a same-metadata image in IndexedDB', async () => {
  await deleteDatabase();
  try {
    const previous = new File(['old'], 'Casio.png', { type: 'image/png', lastModified: 123 });
    const updated = new File(['new'], 'Casio.png', { type: 'image/png', lastModified: 123 });
    const entry = (file) => ({ key: 'ref:template:casio', file, relativePath: 'input-ref-images/brands/Casio/1. Casio.png' });

    await replaceAssets('ref:', [entry(previous)]);
    const normalRefresh = await replaceAssets('ref:', [entry(updated)]);
    assert.equal(normalRefresh.changed, 0);
    assert.equal(await (await getAsset('ref:template:casio')).blob.text(), 'old');

    const forcedRefresh = await replaceAssets('ref:', [entry(updated)], { force: true });
    assert.equal(forcedRefresh.changed, 1);
    assert.equal(await (await getAsset('ref:template:casio')).blob.text(), 'new');
  } finally {
    await deleteDatabase();
  }
});

test('local input asset loader imports in bounded batches and skips unchanged files', async () => {
  await deleteDatabase();
  try {
    const entries = Array.from({ length: 7 }, (_, index) => {
      const name = `watch-${index}.png`;
      const relativePath = `input-watches-images/in_sale/${name}`;
      const key = `watch:in_sale:${name}`;
      return {
        key,
        file: { name, type: 'image/png', size: Buffer.byteLength(key), lastModified: 123, relativePath },
        relativePath
      };
    });
    let active = 0;
    let maxActive = 0;
    let loads = 0;
    let progress = 0;
    const loadFile = async (entry) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return new File([entry.key], entry.file.name, {
        type: entry.file.type,
        lastModified: entry.file.lastModified
      });
    };

    const first = await replaceAssetsFromLoader('watch:', entries, loadFile, {
      batchSize: 4,
      concurrency: 2,
      onProgress: (completed) => { progress = completed; }
    });
    assert.deepEqual(first, { total: 7, changed: 7, removed: 0 });
    assert.equal(maxActive, 2);
    assert.equal(loads, 7);
    assert.equal(progress, 7);
    assert.equal((await getAsset(entries[0].key)).relativePath, entries[0].relativePath);

    const unchanged = await replaceAssetsFromLoader('watch:', entries, async () => {
      throw new Error('unchanged files should not be fetched');
    }, {
      batchSize: 4,
      concurrency: 2,
      shouldLoad: () => false
    });
    assert.deepEqual(unchanged, { total: 7, changed: 0, removed: 0 });
  } finally {
    await deleteDatabase();
  }
});
