import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const html = await readFile(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');
const gallery = await readFile(new URL('../extension/gallery.html', import.meta.url), 'utf8');
function ids(source) { return [...source.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]); }

test('original playlist workspace retains unique controls and presentation routes', () => {
  assert.equal(new Set(ids(html)).size, ids(html).length);
  assert.deepEqual([...new Set([...html.matchAll(/data-workspace-tab="([^"]+)"/g)].map(m => m[1]))], ['models', 'run', 'service']);
  for (const view of ['models', 'run', 'service']) assert.ok(html.includes('data-workspace-view="' + view + '"'));
  assert.match(html, /id="legacyLaunchSelection"/);
  assert.match(script, /view === 'queues' \? 'models' : view === 'settings' \? 'service'/);
  assert.match(script, /let initialView = 'models'/);
  assert.match(script, /buildPlaylistProgressTree\(queue.groups, queue.repairQueue, generationMemory, accountingSnapshot\)/);
  assert.match(script, /flatMap\(\(sale\) => sale.children.flatMap\(\(quality\) => quality.children\)\)/);
});

test('all existing run, maintenance and transfer actions are reachable', () => {
  for (const id of ['start', 'stop', 'pauseRun', 'workerCount', 'runLimit', 'inputMode',
    'runQueueMode', 'runGroupFilter', 'runBrandFilter', 'runPart', 'useSelectedPart',
    'stateBadge', 'currentAction', 'runProgressCount', 'runElapsed', 'runAverage', 'slotGrid',
    'updateExtension', 'retryExtensionRestart', 'exportDiagnostics', 'runDiagnosticsSelect',
    'exportRunDiagnostics', 'memoryExport', 'memoryImport', 'memoryImportFile', 'openResultsTransfer',
    'resetRunRescan', 'chooseOutputFolder', 'grantOutputFolder', 'useDownloadsOutput']) {
    assert.ok(ids(html).includes(id), id);
  }
  assert.match(script, /gallery.html#transfer/);
  for (const id of ['resultsTransferOpen', 'resultsExport', 'resultsImportCheck', 'resultsImportApply', 'resultsImportResume']) {
    assert.ok(ids(gallery).includes(id), id);
  }
  assert.match(script, /retryButton.disabled = retryButton.hidden \|\| extensionRestartRetryBusy/);
  assert.match(script, /launchCandidateCount > 0/);
  assert.match(script, /const plannedTasks = Math\.min\(runLimit, pendingTasks\)/);
  assert.match(script, /К запуску \$\{plannedTasks\} задач/);
  assert.match(script, /elapsedRunClock\(clockRun, Date.now\(\)\)/);
});

test('original layout owns all sizing, scrolling and responsive behavior without legacy adapters', () => {
  assert.match(css, /grid-template-columns:minmax\(295px,\s*.92fr\) minmax\(0,1.4fr\)/);
  assert.match(css, /\.memory-tree \{[^}]*overflow:auto/);
  assert.match(css, /\.memory-list \{[^}]*overflow:auto/);
  assert.match(css, /@media\(max-width:740px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(css, /compact workspace|adapter|\.queue-selection-state|\.models-card \.memory-list/);
});

test('all runtime render targets are supplied by the new markup', () => {
  for (const id of [...script.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1])) {
    assert.ok(ids(html).includes(id), 'missing target ' + id);
  }
});

test('changing generation parameters continues to invalidate stale preflight checks', () => {
  const section = script.slice(script.indexOf("$('workerCount').addEventListener('change'"),
    script.indexOf("$('rateLimitPauseMinutes')?.addEventListener"));
  assert.equal((section.match(/lastPreflight = null/g) || []).length, 3);
});

test('design stylesheet remains an exact copy of the supplied patch', () => {
  const digest = createHash('sha256').update(css.replace(/\r\n/g, '\n').trimEnd()).digest('hex');
  assert.equal(digest, 'd2fcc59396694e37dff71cca17bd2d16c6ed416cd5dfaf0da297cb26e0b5da58');
});
