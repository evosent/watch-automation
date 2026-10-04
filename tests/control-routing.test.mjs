import test from 'node:test';
import assert from 'node:assert/strict';

import {
  controlCommandMatchesClient,
  extensionIdFromOrigin,
  normalizeControlClient,
  resolveControlTarget
} from '../dev/control-routing.mjs';

const extensionA = 'ofdhkengdhfpmmghdpnehkabjojiocek';
const extensionB = 'agdcdommeajcmpojedjponmocjhngdgj';

test('control commands are tied to one active extension client', () => {
  const active = [
    normalizeControlClient({ origin: `chrome-extension://${extensionA}`, clientId: 'client-current-001', version: '0.3.35' }),
    normalizeControlClient({ origin: `chrome-extension://${extensionB}`, version: '0.3.32' })
  ];
  const target = resolveControlTarget({ targetClientId: 'client-current-001' }, active);
  const command = { ...target };

  assert.equal(controlCommandMatchesClient(command, active[0]), true);
  assert.equal(controlCommandMatchesClient(command, active[1]), false);
});

test('unscoped control refuses to guess when multiple extension copies poll', () => {
  const active = [
    normalizeControlClient({ origin: `chrome-extension://${extensionA}` }),
    normalizeControlClient({ origin: `chrome-extension://${extensionB}` })
  ];
  assert.throws(() => resolveControlTarget({}, active), /несколько экземпляров/i);
});

test('extension id targeting fails closed when one id is used by multiple profiles', () => {
  const active = [
    normalizeControlClient({ origin: `chrome-extension://${extensionA}`, clientId: 'profile-client-01' }),
    normalizeControlClient({ origin: `chrome-extension://${extensionA}`, clientId: 'profile-client-02' })
  ];
  assert.throws(() => resolveControlTarget({ targetExtensionId: extensionA }, active), /несколькими профилями/i);
  assert.equal(resolveControlTarget({ targetClientId: 'profile-client-02' }, active).targetClientId, 'profile-client-02');
});

test('browser origin is the authoritative extension identity', () => {
  assert.equal(extensionIdFromOrigin(`chrome-extension://${extensionA}`), extensionA);
  assert.equal(extensionIdFromOrigin('http://127.0.0.1:17321'), null);
  assert.equal(normalizeControlClient({ origin: `chrome-extension://${extensionA}`, clientId: 'bad id' }), null);
});
