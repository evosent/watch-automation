import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';

test('isolated local service serves batch accounting evidence with a bounded shared path cache', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'accounting-service-'));
  const root = path.join(temp, 'WatchAutomation');
  await fs.mkdir(root);
  const png = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(768, 16); png.writeUInt32BE(1024, 20);
  const filePath = path.join(root, 'result.png');
  await fs.writeFile(filePath, png);
  const hash = createHash('sha256').update(png).digest('hex');
  const port = await new Promise(resolve => {
    const listener = createServer();
    listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
  });
  const child = spawn(process.execPath, ['dev/watch-extension.mjs'], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, WATCH_AUTOMATION_PORT: String(port), WATCH_AUTOMATION_OUTPUT_ROOT: root }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
      if (i >= 100) throw new Error('Isolated service failed to start');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const endpoint = `${base}/output-accounting-verify`;
    const headers = { Origin: 'chrome-extension://ofdhkengdhfpmmghdpnehkabjojiocek', 'Content-Type': 'application/json' };
    const artifacts = [{ generationId: 'gen1', path: filePath, outputHash: hash },
      { generationId: 'gen2', path: filePath, outputHash: 'b'.repeat(64) }];
    assert.equal((await fetch(endpoint, { method: 'POST', body: JSON.stringify({ artifacts }) })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'OPTIONS', headers })).status, 204);
    const clientQuery = new URLSearchParams({ extensionId: 'ofdhkengdhfpmmghdpnehkabjojiocek', clientId: 'accounting-test-client', version: '0.3.51' });
    const installedEndpoint = `${endpoint}?${clientQuery}`;
    const withoutOrigin = await fetch(installedEndpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artifacts }) });
    assert.equal(withoutOrigin.status, 200, 'MV3 requests without Origin retain the per-install capability');
    assert.equal((await withoutOrigin.json()).checks.gen1.valid, true);
    assert.equal((await fetch(`${endpoint}?extensionId=ofdhkengdhfpmmghdpnehkabjojiocek`, {
      method: 'POST', body: JSON.stringify({ artifacts }) })).status, 403, 'a claimed extension ID alone is insufficient');
    assert.equal((await fetch(installedEndpoint, { method: 'POST',
      headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ artifacts }) })).status, 403,
    'an explicit website Origin cannot use the installed-client fallback');
    assert.equal((await fetch(installedEndpoint, { method: 'POST',
      headers: { ...headers, Origin: `chrome-extension://${'a'.repeat(32)}` }, body: JSON.stringify({ artifacts }) })).status, 403,
    'a claimed extension identity must match an explicit extension Origin');
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ artifacts }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.checks.gen1.valid, true);
    assert.equal(result.checks.gen1.sha256, hash);
    assert.equal(result.checks.gen2.valid, false);
    assert.equal(result.checks.gen2.exists, true);
    await fs.unlink(filePath);
    const removed = await (await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ artifacts }) })).json();
    assert.equal(removed.checks.gen1.exists, false);
    assert.equal(removed.checks.gen1.valid, false);
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    // temp is created exclusively by this test and has a known absolute root.
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('worker batch checks transmit the installation identity instead of relying on Origin alone', async () => {
  const worker = await fs.readFile('extension/service-worker.js', 'utf8');
  const body = worker.slice(worker.indexOf('async function verifyCanonicalArtifacts('), worker.indexOf('function verifiedJournalProofForRevision('));
  assert.match(body, /await getDevControlClientIdentity\(\)/);
  assert.match(body, /OUTPUT_ACCOUNTING_VERIFY_ENDPOINT\}\?\$\{new URLSearchParams\(identity\)\}/);
  assert.match(body, /fetchWithTimeout\(endpoint,/);
});
