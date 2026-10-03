import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { DB_NAME, getAsset, replaceAssets } from '../extension/idb.js';

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
