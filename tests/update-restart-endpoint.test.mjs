import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const extensionId = 'ofdhkengdhfpmmghdpnehkabjojiocek';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('watcher exposes authenticated restart retry while retaining update and results-transfer routes', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'watch-update-restart-http-'));
  const outputRoot = path.join(temp, 'Downloads', 'WatchAutomation');
  await mkdir(outputRoot, { recursive: true });
  const port = await unusedPort();
  const child = spawn(process.execPath, [path.join(project, 'dev/watch-extension.mjs')], {
    env: { ...process.env, WATCH_AUTOMATION_PORT: String(port), WATCH_AUTOMATION_OUTPUT_ROOT: outputRoot },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const identity = new URLSearchParams({ extensionId, clientId: 'restart-http-test', version: '0.3.40' });
  const headers = { Origin: `chrome-extension://${extensionId}` };
  t.after(async () => {
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timeout = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.kill();
    });
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/health`)).ok) break; }
    catch (_) { /* wait for the child listener */ }
    if (attempt === 99) throw new Error(log || 'watcher failed to start');
    await pause(20);
  }

  const forbidden = await fetch(`${base}/update/restart`, { method: 'POST' });
  assert.equal(forbidden.status, 403);

  const statusResponse = await fetch(`${base}/update/status?${identity}`, { headers });
  assert.equal(statusResponse.status, 200);
  const statusPayload = await statusResponse.json();
  assert.equal(statusPayload.ok, true);
  assert.equal(typeof statusPayload.status.restartRetryAvailable, 'boolean');

  const noPending = await fetch(`${base}/update/restart?${identity}`, { method: 'POST', headers });
  assert.equal(noPending.status, 409);
  const noPendingPayload = await noPending.json();
  assert.equal(noPendingPayload.ok, false);
  assert.equal(noPendingPayload.reason, 'not_pending');

  // The restart route must not shadow the legacy results-transfer router.
  const transfer = await fetch(`${base}/results-transfer/status?${identity}&id=00000000-0000-4000-8000-000000000000`, { headers });
  assert.equal(transfer.status, 400);
  assert.match((await transfer.json()).error, /\.result-transfers/i);
});
