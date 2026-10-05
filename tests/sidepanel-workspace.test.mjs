import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

function uniqueIds(source) {
  const ids = [...source.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
  return { ids, duplicates: ids.filter((id, index) => ids.indexOf(id) !== index) };
}

function functionBody(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.notEqual(end, -1, `missing boundary ${nextSignature}`);
  return source.slice(start, end);
}

test('compact workspaces preserve unique DOM contracts and remove header status cluster', () => {
  const { duplicates } = uniqueIds(html);
  assert.deepEqual(duplicates, [], 'all sidepanel IDs must remain unique');

  const tabs = [...html.matchAll(/data-workspace-tab="([^"]+)"/g)].map((match) => match[1]);
  const views = [...html.matchAll(/data-workspace-view="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(tabs)], ['queues', 'run', 'settings']);
  assert.deepEqual([...new Set(views)], ['run', 'queues', 'settings']);

  const header = html.match(/<header class="app-header">([\s\S]*?)<\/header>/)?.[1] || '';
  assert.ok(header, 'header exists');
  assert.doesNotMatch(header, /health-cluster|statusSignal|pauseSignal|pauseStatus/);
  for (const removedId of ['statusSignal', 'pauseSignal', 'status', 'pauseStatus']) {
    assert.ok(!uniqueIds(html).ids.includes(removedId), `${removedId} should not return as a visible header status`);
  }

  const renderHealth = functionBody(script, 'function renderHealth(', 'async function refreshRuntime(');
  assert.match(renderHealth, /if \(statusSignal\)/);
  assert.match(renderHealth, /if \(pauseSignal\)/);
  assert.match(renderHealth, /if \(status\)/);
  assert.match(renderHealth, /if \(pauseStatus\)/);
});

test('queue overview is the landing screen and older run selection migrates once', () => {
  assert.match(script, /const UI_VIEW_STORAGE_KEY = 'watchAutomation\.uiView\.v4'/);
  assert.match(script, /const UI_VIEW_STORAGE_KEY_LEGACY = 'watchAutomation\.uiView\.v3'/);
  assert.match(script, /const UI_VIEW_STORAGE_KEY_OLDEST = 'watchAutomation\.uiView\.v2'/);
  assert.match(script, /view === 'models' \? 'queues' : view === 'service' \? 'settings'/);
  assert.match(script, /let initialView = 'queues'/);
  assert.match(script, /canonicalWorkspaceView\(previousView\) === 'run'\) initialView = 'queues'/);
  assert.match(html, /data-workspace-tab="queues" aria-selected="true">Очереди/);
  assert.match(html, /data-workspace-view="queues">/);
  assert.match(html, /class="queue-selection-state"[^>]*hidden/,
    'exact launch selectors remain in the DOM without taking space away from the queue browser');
  const navHandler = functionBody(script, "button.addEventListener('click', () => setWorkspaceView(button.dataset.workspaceTab))", 'const saved = disclosureState()');
  assert.doesNotMatch(navHandler, /startOrResume|pauseRun|stopOrResetRun/,
    'navigation and the “Изменить” link only switch views');
  const viewRenderer = functionBody(script, 'function setWorkspaceView(', 'function disclosureState()');
  assert.match(viewRenderer, /querySelectorAll\('\.workspace-tab\[data-workspace-tab\]'\)/,
    'only navigation tabs receive aria-selected state; the “Изменить” action remains a normal button');
});

test('run feedback, timers and prompt status remain rendered in their new locations', () => {
  assert.match(html, /id="feedback"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="preflightSummary"[^>]*role="status"[^>]*aria-live="polite"/);
  for (const id of ['stateBadge', 'currentAction', 'runProgressCount', 'runElapsed', 'runAverage', 'slotGrid', 'promptStatus']) {
    assert.ok(uniqueIds(html).ids.includes(id), `${id} remains available to the renderer`);
  }
  for (const id of ['updateStatus', 'domDiagnosticsStatus', 'runDiagnosticsStatus']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*aria-live="polite"`), `${id} remains an announced status`);
  }
  assert.match(script, /if \(promptStatus\) promptStatus\.textContent/);
});

test('memory tree browsing is separate from the exact, lock-protected launch draft', () => {
  const treeHandler = functionBody(script, "$('memoryTree')?.addEventListener('click'", "$('memoryStatusFilter')?.addEventListener('change'");
  assert.match(treeHandler, /selectedMemoryPartId = part\.id/);
  assert.doesNotMatch(treeHandler, /\$\('(runQueueMode|runGroupFilter|runBrandFilter|runPart)'\)\.value\s*=/);
  assert.match(treeHandler, /if \(!launchSelectionLocked\(\)\) applySelectedMemoryPartForLaunch\(\)/,
    'selecting a part sets the launch draft while idle and keeps active runs locked');

  const apply = functionBody(script, 'async function applySelectedMemoryPartForLaunch()', 'function updateActionButtons()');
  assert.match(apply, /launchSelectionLocked\(\)/);
  assert.match(apply, /freshPart\.signature !== part\.signature/);
  assert.match(apply, /\$\('runQueueMode'\)\.value = freshPart\.mode/);
  assert.match(apply, /showFeedback\(`Для запуска выбрана часть \$\{freshPart\.partNumber\}/,
    'applying a progress-tree part gives the user a visible success confirmation');
  assert.match(script, /\$\('useSelectedPart'\)\?\.addEventListener\('click', \(\) => applySelectedMemoryPartForLaunch\(\)/);

  const parameterHandlers = functionBody(script, "$('workerCount').addEventListener('change'", "$('rateLimitPauseMinutes')?.addEventListener");
  assert.equal((parameterHandlers.match(/lastPreflight = null/g) || []).length, 3,
    'tab count, photo count, and input mode invalidate stale preflight feedback');
  const actionState = functionBody(script, 'function updateActionButtons()', 'let actionBusy = false;');
  assert.match(actionState, /\$\('workerCount'\)\.disabled = controlsLocked/);
  assert.match(actionState, /\['runQueueMode', 'runGroupFilter', 'runBrandFilter', 'runPart', 'runLimit', 'inputMode'/);
});

test('settings and results workflows remain reachable through their existing controls', () => {
  const requiredControls = [
    'openGallery', 'updateExtension', 'retryExtensionRestart', 'exportDiagnostics',
    'runDiagnosticsSelect', 'exportRunDiagnostics', 'memoryExport', 'memoryImport',
    'resetRunRescan', 'rateLimitPauseMinutes', 'domDiagnosticsMode', 'chooseOutputFolder',
    'workerCount', 'runLimit', 'inputMode',
    'grantOutputFolder', 'useDownloadsOutput'
  ];
  const ids = new Set(uniqueIds(html).ids);
  for (const id of requiredControls) assert.ok(ids.has(id), `${id} stays reachable`);

  const settingsViewStart = html.indexOf('data-workspace-view="settings"');
  assert.ok(settingsViewStart >= 0);
  for (const id of ['workerCount', 'runLimit', 'inputMode']) {
    assert.ok(html.indexOf(`id="${id}"`) > settingsViewStart, `${id} belongs to Settings, separate from exact queue selection`);
  }

  assert.match(html, /id="openGallery"[^>]*title="Галерея, импорт и экспорт архивов результатов"/);
  assert.match(script, /\$\('openGallery'\)\?\.addEventListener\('click'/);
  assert.match(script, /\{ type: 'RETRY_EXTENSION_RESTART' \}/);
  assert.match(script, /retryButton\.hidden = status\?\.canRetryRestart !== true/);
  const retry = functionBody(script, 'async function retryExtensionRestartFromUi()', '// Selecting the same directory twice');
  assert.match(retry, /showFeedback\('Повторный перезапуск расширения отправлен/);
  assert.match(script, /\$\('retryExtensionRestart'\)\?\.addEventListener\('click', \(\) => retryExtensionRestartFromUi\(\)\.catch\(showError\)\)/,
    'restart success and failure both produce user-visible feedback');
  assert.match(script, /\$\('start'\)\.addEventListener\('click', \(\) => \{\s*setWorkspaceView\('run'\);\s*startOrResume\(\)/);
});

test('queue overview uses a two-pane scrolling workspace with readable labels and a fixed action dock', () => {
  assert.match(css, /\.playlist-layout\s*\{[^}]*grid-template-columns:minmax\(0,\.72fr\) minmax\(0,1\.28fr\)/s);
  assert.match(css, /\.models-card \.memory-list\s*\{[^}]*flex:1 1 auto/s);
  assert.match(css, /\.command-dock\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) minmax\(270px,\.95fr\)/s);
  assert.match(css, /@media\(max-width:520px\)\s*\{[\s\S]*?\.playlist-layout \{ grid-template-columns:minmax\(0,1fr\)/);
});
