import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

import {
  INPUT_MODES,
  buildInputPlan,
  renderReferenceAwareText,
  unresolvedReferenceTokens
} from '../extension/input-plan.js';
import {
  brandProfileIds,
  getBrandProfile,
  buildGenerationPrompt,
  detectBrandProfile
} from '../extension/prompt-profiles.js';
import {
  AUTOMATION_ERROR_CLASSES,
  classifyAutomationError,
  coalescedPauseDeadline,
  CONVERSATION_LOAD_RECOVERY_DELAY_MS,
  GENERATION_TRANSPORT_REFRESH_AFTER_MS,
  imageLimitResumeAt,
  normalizeGenerationJitterSeconds,
  normalizeGenerationPauseMinutes,
  normalizeRateLimitIgnoreMinutes,
  isRateLimitIgnored,
  isUserPauseCancellation,
  resolveGenerationPause,
  sampleGenerationPause,
  stableHash,
  generationId,
  isMeaningfulProgress,
  shouldRefreshUnresponsiveGeneration
} from '../extension/reliability-utils.js';
import {
  referenceDescriptorForPath,
  generatedFileName,
  generationOutputFileName,
  ensureGenerationOutputFileName,
  brandIdFromModelName
} from '../extension/queue-utils.js';
import {
  latestGenerationRevisions,
  factsBelongToRevision,
  immutableRevisionTuple,
  verifiedRevisionMatchesEvent,
  freshSlotRevisionFields,
  canAuditSlot
} from '../extension/generation-revision-utils.js';
import { savedFactsStageMatchesReleasedOwner } from '../extension/facts-progress-utils.js';
import { galleryRecordsFromCatalog } from '../extension/gallery-revision-utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const extensionDir = path.join(root, 'extension');
const basePrompt = await readFile(path.join(extensionDir, 'Base Prompt v5.txt'), 'utf8');

const representativeModels = Object.freeze({
  casio: 'Casio Collection MDV-107D-1A3',
  orient: 'Orient RA-AA0001B19B',
  tissot: 'Tissot PRX T137.410.11.041.00',
  pagani_design: 'Pagani Design PD-1661',
  benyar: 'Benyar BY-5101-1B',
  q_and_q: 'Q&Q M173J001Y',
  seiko: 'Seiko SRPD55K1',
  citizen: 'Citizen NJ0150-81Z',
  longines: 'Longines L3.781.4.56.6',
  diesel: 'Diesel DZ4343',
  armani_exchange: 'Armani Exchange AX1721',
  certina: 'Certina C032.807.11.051.00',
  generic: 'UnknownBrand ZX-1234'
});

test('late SAVED stage survives OCR tab cleanup only for its exact revision and tab', () => {
  const previous = {
    tabId: 42,
    entryId: 'casio:AMW880D9A',
    generationId: 'gen-current',
    factsJobId: 'facts-current',
    outputHash: 'aabb'
  };
  assert.equal(savedFactsStageMatchesReleasedOwner({
    entryId: previous.entryId,
    generationId: previous.generationId,
    factsJobId: previous.factsJobId,
    outputHash: 'AABB'
  }, previous, 42), true);
  assert.equal(savedFactsStageMatchesReleasedOwner({
    ...previous,
    generationId: 'gen-old'
  }, previous, 42), false);
  assert.equal(savedFactsStageMatchesReleasedOwner(previous, previous, 43), false);
});

test('gallery version badge counts only saved image revisions for the same SKU', () => {
  const skuKey = 'casio:watch-a';
  const facts = { status: 'ok', generationId: 'ready-2', factsJobId: 'facts-2', outputHash: 'b'.repeat(64) };
  const card = galleryRecordsFromCatalog([{
    skuKey,
    latestReadyGenerationId: 'ready-2',
    modelName: 'Casio Watch A',
    variants: [{ groupId: 'in_sale_good' }]
  }], [
    { generationId: 'ready-1', sourceId: skuKey, status: 'READY', outputPath: 'archive/old.png', outputHash: 'a'.repeat(64), reviewStatus: 'rejected' },
    { generationId: 'ready-2', sourceId: skuKey, status: 'READY', outputPath: 'current.png', outputHash: 'b'.repeat(64), factsJobId: 'facts-2', factsStatus: 'ok', facts, completedAt: '2026-09-28T08:30:00.000Z' },
    { generationId: 'unsent', sourceId: skuKey, status: 'CANCELLED', outputPath: null, outputHash: null },
    { generationId: 'unverified', sourceId: skuKey, status: 'FACTS_PENDING', outputPath: 'partial.png', outputHash: 'not-a-sha256' },
    { generationId: 'other-sku', sourceId: 'casio:watch-b', status: 'READY', outputPath: 'other.png', outputHash: 'c'.repeat(64) }
  ]);
  assert.equal(card.length, 1);
  assert.equal(card[0].versionCount, 2, 'saved rejected versions remain in history; unsent and unverified attempts do not count');
  assert.equal(card[0].generatedAt, '2026-09-28T08:30:00.000Z', 'gallery display timestamp comes from the completed revision');
});

test('input plans assign contiguous references for modes 2/3/4', () => {
  const expected = {
    '2': { roles: ['template', 'watchReference'], refs: { template: '@1', watchReference: '@2' } },
    '3': { roles: ['template', 'ozonMap', 'watchReference'], refs: { template: '@1', ozonMap: '@2', watchReference: '@3' } },
    '4': { roles: ['template', 'ozonMap', 'storeLogo', 'watchReference'], refs: { template: '@1', ozonMap: '@2', storeLogo: '@3', watchReference: '@4' } }
  };
  for (const mode of Object.keys(expected)) {
    const plan = buildInputPlan(mode);
    assert.deepEqual(plan.roles, expected[mode].roles);
    for (const [role, ref] of Object.entries(expected[mode].refs)) assert.equal(plan.refs[role], ref);
    assert.equal(plan.count, Number(mode));
  }
});

test('conditional reference blocks disappear cleanly', () => {
  const template = [
    '{{REF_TEMPLATE}}',
    '[[IF_OZON_MAP]]ozon={{REF_OZON_MAP}}[[/IF_OZON_MAP]]',
    '[[IF_NO_OZON_MAP]]no-ozon[[/IF_NO_OZON_MAP]]',
    '[[IF_STORE_LOGO]]logo={{REF_STORE_LOGO}}[[/IF_STORE_LOGO]]',
    '[[IF_NO_STORE_LOGO]]no-logo[[/IF_NO_STORE_LOGO]]',
    'watch={{REF_WATCH}} count={{INPUT_COUNT}}'
  ].join('\n');

  const two = renderReferenceAwareText(template, '2');
  assert.match(two, /^@1/m);
  assert.match(two, /no-ozon/);
  assert.match(two, /no-logo/);
  assert.match(two, /watch=@2 count=2/);
  assert.doesNotMatch(two, /ozon=@/);
  assert.doesNotMatch(two, /logo=@/);
  assert.deepEqual(unresolvedReferenceTokens(two), []);

  const four = renderReferenceAwareText(template, '4');
  assert.match(four, /ozon=@2/);
  assert.match(four, /logo=@3/);
  assert.match(four, /watch=@4 count=4/);
  assert.doesNotMatch(four, /no-ozon|no-logo/);
  assert.deepEqual(unresolvedReferenceTokens(four), []);
});

test('all runtime brand profiles build valid prompts in every input mode', async () => {
  for (const profileId of brandProfileIds()) {
    const meta = getBrandProfile(profileId);
    const modelName = representativeModels[profileId];
    assert.ok(modelName, `missing representative model for ${profileId}`);
    assert.equal(detectBrandProfile(modelName), profileId);
    const brandPrompt = await readFile(path.join(extensionDir, meta.promptPath), 'utf8');

    for (const mode of Object.keys(INPUT_MODES)) {
      const plan = buildInputPlan(mode);
      const prompt = buildGenerationPrompt(basePrompt, modelName, brandPrompt, { inputPlan: plan });
      assert.ok(prompt.length > 1000, `${profileId}/${mode} prompt unexpectedly short`);
      assert.deepEqual(unresolvedReferenceTokens(prompt), [], `${profileId}/${mode} left template tokens`);
      assert.match(prompt, new RegExp(`\\${plan.refs.template}\\b`), `${profileId}/${mode} lacks template ref`);
      assert.match(prompt, new RegExp(`\\${plan.refs.watchReference}\\b`), `${profileId}/${mode} lacks watch ref`);
      if (plan.hasOzonMap) assert.match(prompt, new RegExp(`\\${plan.refs.ozonMap}\\b`), `${profileId}/${mode} lacks Ozon ref`);
      if (plan.hasStoreLogo) assert.match(prompt, new RegExp(`\\${plan.refs.storeLogo}\\b`), `${profileId}/${mode} lacks logo ref`);

      const usedRefs = [...prompt.matchAll(/@(\d+)\b/g)].map((match) => Number(match[1]));
      assert.ok(usedRefs.length > 0, `${profileId}/${mode} contains no attachment references`);
      assert.ok(Math.max(...usedRefs) <= plan.count, `${profileId}/${mode} references missing attachment @${Math.max(...usedRefs)}`);
    }
  }
});

test('2-input prompt contains explicit no-map/no-extra-logo guidance', async () => {
  const meta = getBrandProfile('casio');
  const brandPrompt = await readFile(path.join(extensionDir, meta.promptPath), 'utf8');
  const prompt = buildGenerationPrompt(basePrompt, representativeModels.casio, brandPrompt, { inputMode: '2' });
  assert.match(prompt, /Отдельной карты слепых зон Ozon нет/);
  assert.match(prompt, /Отдельного референса Watches World нет/);
  assert.doesNotMatch(prompt, /@3\b|@4\b/);
});

test('reference path parser accepts current reference layout', () => {
  assert.deepEqual(referenceDescriptorForPath('input-ref-images/1. Base.png'), {
    key: 'template', brandId: null, storageKey: 'template'
  });
  assert.deepEqual(referenceDescriptorForPath('input-ref-images/2. Ozon blind zones 2.png'), {
    key: 'ozonMap', brandId: null, storageKey: 'ozonMap'
  });
  assert.deepEqual(referenceDescriptorForPath('input-ref-images/3. Logo Black.png'), {
    key: 'storeLogo', brandId: null, storageKey: 'storeLogo'
  });
  assert.deepEqual(referenceDescriptorForPath('input-ref-images/brands/Casio/1. Casio.png'), {
    key: 'template', brandId: 'casio', storageKey: 'template:casio'
  });
});

test('brand and generated filename helpers remain deterministic', () => {
  assert.equal(brandIdFromModelName('Q&Q M173J001Y'), 'q_and_q');
  assert.equal(brandIdFromModelName('Pagani Design PD-1661'), 'pagani_design');
  assert.equal(brandIdFromModelName('Casio MDV-107D-1A3'), 'casio');
  assert.equal(generatedFileName('Casio MDV-107D-1A3.png'), 'gen-Casio MDV-107D-1A3.png');
  const slot = {};
  const firstAttempt = ensureGenerationOutputFileName(slot, { outputFileName: 'Casio MDV-107D-1A3.png' }, 'revision-a');
  assert.equal(firstAttempt, generationOutputFileName('Casio MDV-107D-1A3.png', 'revision-a'));
  assert.equal(slot.outputFileName, firstAttempt, 'the slot persists its exact output filename');
  assert.notEqual(firstAttempt, generationOutputFileName('Casio MDV-107D-1A3.png', 'revision-b'));
  assert.equal(ensureGenerationOutputFileName(slot, { outputFileName: 'other-name.png' }, 'revision-b'), firstAttempt,
    'retrying the same slot keeps its already reserved filename');
});

test('error classifier separates terminal text states from rate limit and transport failures', () => {
  assert.equal(classifyAutomationError('Слишком много запросов'), AUTOMATION_ERROR_CLASSES.RATE_LIMIT);
  assert.equal(classifyAutomationError({ code: 'CLARIFICATION_REQUIRED', message: 'Уточните модель' }), AUTOMATION_ERROR_CLASSES.CLARIFICATION_REQUIRED);
  assert.equal(classifyAutomationError({ code: 'MODEL_REFUSAL', message: 'Не могу выполнить' }), AUTOMATION_ERROR_CLASSES.MODEL_REFUSAL);
  assert.equal(classifyAutomationError({ code: 'TOOL_UNAVAILABLE', message: 'Генерация изображения недоступна' }), AUTOMATION_ERROR_CLASSES.TOOL_UNAVAILABLE);
  assert.equal(classifyAutomationError('receiving end does not exist', { tabClosed: true }), AUTOMATION_ERROR_CLASSES.TAB_LOST);
  assert.equal(classifyAutomationError('download failed'), AUTOMATION_ERROR_CLASSES.DOWNLOAD);
});

test('rate-limit deadline is coalesced rather than extended by duplicate signals', () => {
  const now = 1_000_000;
  const first = coalescedPauseDeadline(0, now, 180_000);
  assert.equal(first, now + 180_000);
  assert.equal(coalescedPauseDeadline(first, now + 30_000, 180_000), first);
  assert.equal(coalescedPauseDeadline(first, first + 1, 180_000), first + 1 + 180_000);
});

test('image creation limit uses the announced local reset time plus one minute', () => {
  const before = new Date(2026, 8, 28, 19, 42).getTime();
  const banner = 'Достигнут лимит создания изображений. Лимит создания изображений исчерпан. Попробуйте снова в 21:20.';
  assert.equal(imageLimitResumeAt(banner, before), new Date(2026, 8, 28, 21, 21).getTime());
  assert.equal(imageLimitResumeAt(banner, new Date(2026, 8, 28, 21, 20, 30).getTime()),
    new Date(2026, 8, 28, 21, 21).getTime());
  assert.equal(imageLimitResumeAt('Слишком много запросов', before), null);
  assert.equal(imageLimitResumeAt('Лимит создания изображений. Попробуйте снова в 25:90.', before), null);
  assert.equal(classifyAutomationError(banner), AUTOMATION_ERROR_CLASSES.RATE_LIMIT);
});

test('image limit pauses the whole run, salvages ready images, and requeues unfinished slots', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const resolver = await readFile(path.join(extensionDir, 'selector-resolver.js'), 'utf8');
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  const cleanup = worker.slice(worker.indexOf('function pauseForImageLimit('), worker.indexOf('function armRateLimitIgnoreWindow('));
  assert.match(resolver, /лимит\\s\+\(\?:создания\|генерации\)/);
  assert.match(cleanup, /run\.state = 'PAUSED'/);
  assert.match(cleanup, /quickProbeReadyResultsBeforeReset\(snapshot\.run\)/);
  assert.match(cleanup, /await reconcileActiveDownloads\(\)/);
  assert.match(cleanup, /entry\.status = 'pending'/);
  assert.match(cleanup, /setGenerationMemoryStatus\(memory, entry, GENERATION_MEMORY_STATUSES\.NOT_READY/);
  assert.match(cleanup, /run\.pendingIds = entries\.filter/);
  assert.match(cleanup, /chrome\.tabs\.remove\(tabId\)/);
  assert.match(worker, /if \(imageLimitTasks\.has\(initialRun\.operationId\)\)/);
  assert.match(panel, /ОЖИДАНИЕ ЛИМИТА/);
});

test('stable hashes and physical generation ids change with revision inputs', () => {
  const a = stableHash({ mode: '3', prompt: 'A' });
  const b = stableHash({ mode: '2', prompt: 'A' });
  assert.notEqual(a, b);
  assert.equal(stableHash({ mode: '3', prompt: 'A' }), a);
  assert.notEqual(generationId('watch-1', a), generationId('watch-1', b));
  assert.notEqual(generationId('watch-1', 'operation-1-lease-1'), generationId('watch-1', 'operation-2-lease-1'));
});

test('one SKU keeps three immutable revisions and gallery selects the complete latest tuple', () => {
  const revisions = [1, 2, 3].map((number) => ({
    generationId: `watch-a-generation-${number}`,
    sourceId: 'watch-a',
    outputPath: `C:/Downloads/WatchAutomation/in_sale_good/name${number === 1 ? '' : ` (${number - 1})`}.png`,
    outputHash: `hash-${number}`,
    chatUrl: `https://chatgpt.com/c/chat-${number}`,
    factsJobId: `facts-${number}`,
    facts: { generationId: `watch-a-generation-${number}`, factsJobId: `facts-${number}`, utp1: `UTP ${number}` },
    completedAt: `2026-09-22T10:0${number}:00.000Z`
  }));
  const selected = latestGenerationRevisions(revisions).get('watch-a');
  assert.equal(selected.versionCount, 3);
  assert.deepEqual(immutableRevisionTuple(selected.record), {
    generationId: 'watch-a-generation-3',
    sourceId: 'watch-a',
    outputPath: 'C:/Downloads/WatchAutomation/in_sale_good/name (2).png',
    outputHash: 'hash-3',
    chatUrl: 'https://chatgpt.com/c/chat-3',
    facts: { generationId: 'watch-a-generation-3', factsJobId: 'facts-3', utp1: 'UTP 3' },
    completedAt: '2026-09-22T10:03:00.000Z'
  });
});

test('late OCR from generation A1 cannot be attached to generation A2', () => {
  const a2 = {
    generationId: 'generation-a2',
    sourceId: 'watch-a',
    outputHash: 'hash-a2',
    factsJobId: 'facts-a2'
  };
  assert.equal(factsBelongToRevision(a2, {
    generationId: 'generation-a1',
    outputHash: 'hash-a1',
    factsJobId: 'facts-a1'
  }), false);
  assert.equal(factsBelongToRevision(a2, {
    generationId: 'generation-a2',
    outputHash: 'hash-a2',
    factsJobId: 'facts-a2'
  }), true);
});

test('duplicate physical filenames are selected by persisted revision path', () => {
  const revisions = [
    { generationId: 'a1', sourceId: 'watch-a', outputPath: 'C:/x/name.png', completedAt: '2026-09-22T10:01:00Z' },
    { generationId: 'a2', sourceId: 'watch-a', outputPath: 'C:/x/name (1).png', completedAt: '2026-09-22T10:02:00Z' },
    { generationId: 'a3', sourceId: 'watch-a', outputPath: 'C:/x/name (2).png', completedAt: '2026-09-22T10:03:00Z' }
  ];
  assert.equal(latestGenerationRevisions(revisions).get('watch-a').record.outputPath, 'C:/x/name (2).png');
});

test('rejected current revision remains in history while latest accepted revision drives gallery', () => {
  const revisions = [
    { generationId: 'a1', sourceId: 'watch-a', outputPath: 'C:/x/_archive/name.png', completedAt: '2026-09-22T10:01:00Z' },
    { generationId: 'a2', sourceId: 'watch-a', outputPath: 'C:/x/_archive/name (1).png', completedAt: '2026-09-22T10:02:00Z', reviewStatus: 'rejected' },
    { generationId: 'a3', sourceId: 'watch-a', outputPath: 'C:/x/name.png', completedAt: '2026-09-22T10:03:00Z' }
  ];
  const selected = latestGenerationRevisions(revisions).get('watch-a');
  assert.equal(revisions.length, 3);
  assert.equal(selected.record.generationId, 'a3');
  assert.equal(selected.versionCount, 3);
});

test('latest revision selection is deterministic when completion timestamps are equal', () => {
  const selected = latestGenerationRevisions([
    { generationId: 'generation-a', sourceId: 'watch-a', outputPath: 'C:/x/a.png', completedAt: '2026-09-22T10:00:00Z' },
    { generationId: 'generation-b', sourceId: 'watch-a', outputPath: 'C:/x/b.png', completedAt: '2026-09-22T10:00:00Z' }
  ]).get('watch-a');
  assert.equal(selected.record.generationId, 'generation-b');
});

test('meaningful progress recognizes image and assistant advances but ignores unchanged state', () => {
  assert.equal(isMeaningfulProgress({ state: 'GENERATING', assistantCount: 1 }, { state: 'GENERATING', assistantCount: 1 }), false);
  assert.equal(isMeaningfulProgress({ state: 'GENERATING', assistantCount: 1 }, { state: 'GENERATING', assistantCount: 2 }), true);
  assert.equal(isMeaningfulProgress({ imageCandidate: false }, { imageCandidate: true, imageSource: 'x' }), true);
  assert.equal(isMeaningfulProgress({ state: 'GENERATING' }, { state: 'READY' }), true);
});

test('generation pause samples an independent sign and 50–150% factor for each Send', () => {
  const plus = sampleGenerationPause(3, 30, (() => { const draws = [0.32, 0.82]; return () => draws.shift(); })());
  const minus = sampleGenerationPause(3, 30, (() => { const draws = [0.62, 0.12]; return () => draws.shift(); })());
  assert.equal(plus.delayMs, 204600);
  assert.equal(plus.direction, 1);
  assert.ok(Math.abs(plus.factor - 0.82) < 1e-12);
  assert.equal(minus.delayMs, 146400);
  assert.equal(minus.direction, -1);
  assert.ok(Math.abs(minus.factor - 1.12) < 1e-12);
  assert.equal(sampleGenerationPause(0, 30, () => 0).delayMs, 0, 'negative pause clamps to zero');
  assert.equal(sampleGenerationPause(3, 0, () => 1).delayMs, 180000, 'zero spread is exact');
});

test('configured pause is normalized and a sampled gap survives a worker wake', () => {
  assert.equal(normalizeGenerationPauseMinutes('3'), 3);
  assert.equal(normalizeGenerationJitterSeconds('30'), 30);
  assert.equal(normalizeGenerationPauseMinutes(''), 0.17);
  assert.equal(normalizeGenerationJitterSeconds(''), 2);
  assert.equal(normalizeGenerationPauseMinutes('-4'), 0);
  assert.equal(normalizeGenerationJitterSeconds('99999'), 3600);
  const first = resolveGenerationPause(null, 3, 30, (() => { const draws = [0.32, 0.82]; return () => draws.shift(); })());
  const restored = resolveGenerationPause(first.delayMs, 3, 30, () => { throw new Error('random must not be drawn again'); });
  assert.equal(first.reused, false);
  assert.equal(restored.reused, true);
  assert.equal(restored.delayMs, first.delayMs);
});

test('send throttling is isolated to the real Send gate and long waits have an MV3 alarm', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const submitStart = worker.indexOf('async function submitPreparedSlot');
  const submitEnd = worker.indexOf('chrome.runtime.onInstalled.addListener', submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  const gate = worker.slice(submitStart, submitEnd);
  assert.match(gate, /resolveGenerationPause\(slot\.generationGapMs/);
  assert.match(gate, /previousLaunchAt\s*\?\s*resolveGenerationPause/);
  assert.match(gate, /currentSlot\.generationGapMs = gap\.delayMs/);
  assert.match(worker, /function resetLaunchScheduler\(operationId\)\s*\{[\s\S]*?lastLaunchAt = 0;/);
  assert.match(worker, /if \(assignments\.active\) \{\s*resetLaunchScheduler\(assignments\.runId\)/);
  assert.match(worker, /chrome\.alarms\.create\(`\$\{GENERATION_SEND_ALARM_PREFIX\}/);
  assert.match(worker, /alarm\.name\.startsWith\(GENERATION_SEND_ALARM_PREFIX\)/);
  assert.match(worker, /rehydrateWorkerWake\(\)/);
  assert.match(worker, /type: 'PREPARE_PAGE_CONTENT'/);
  assert.match(worker, /type: 'SUBMIT_PAGE_RUN'/);
  assert.match(content, /state: 'READY_TO_SEND'/);
  assert.match(content, /async function prepareRunForSubmit/);
  assert.match(content, /async function submitPreparedRun/);
});

test('generation pause settings persist in the job and each run snapshots them', async () => {
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  const html = await readFile(path.join(extensionDir, 'sidepanel.html'), 'utf8');
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(html, /id="generationPauseMinutes"/);
  assert.match(html, /id="generationJitterSeconds"/);
  assert.match(panel, /savedJob\.generationPauseMinutes/);
  assert.match(panel, /savedJob\.generationJitterSeconds/);
  assert.match(panel, /job: \{[\s\S]*generationPauseMinutes,[\s\S]*generationJitterSeconds,/);
  assert.match(worker, /generationPauseMinutes: normalizeGenerationPauseMinutes\(run\?\.generationPauseMinutes\)/);
  assert.match(worker, /const generationPauseMinutes = normalizeGenerationPauseMinutes\(job\.generationPauseMinutes\)/);
  assert.match(worker, /const generationJitterSeconds = normalizeGenerationJitterSeconds\(job\.generationJitterSeconds\)/);
});

test('normal Start keeps workers in the side-panel host window', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  assert.match(panel, /preferredWindowId: await currentHostWindowId\(\)/);
  assert.match(worker, /automationWindowOwned: false/);
  const host = worker.slice(worker.indexOf('function ensureAutomationWindow('), worker.indexOf('async function markTabAsAutomation'));
  assert.match(host, /stored\.run\.automationWindowId = host\.id/);
  assert.match(host, /stored\.run\.automationWindowOwned = false/);
  assert.doesNotMatch(host, /chrome\.windows\.create/);
  assert.match(worker, /chrome\.tabs\.create\(\{ windowId, url: AUTOMATION_URL, active: false \}\)/);
});

test('host-window resolver uses the supplied window without creating a Chrome window', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const source = worker.slice(worker.indexOf('function ensureAutomationWindow('), worker.indexOf('async function markTabAsAutomation'));
  const stored = { run: { operationId: 'run-1', preferredWindowId: 77,
    automationWindowId: null, automationWindowOwned: false }, queue: {} };
  let saved = 0;
  const context = {
    chrome: { windows: {
      get: async (id) => id === 77 ? { id, type: 'normal' } : null,
      getLastFocused: async () => { throw new Error('preferred host should win'); },
      create: async () => { throw new Error('must not open a window'); }
    } },
    getStored: async () => stored,
    withStateLock: async (fn) => fn(),
    saveRunAndQueue: async () => { saved += 1; },
    publishRun: async () => {},
    automationWindowPromise: null,
    automationWindowPromiseRunId: null
  };
  runInNewContext(`${source}\nglobalThis.resolveHost = ensureAutomationWindow;`, context);
  const result = await context.resolveHost('run-1');
  assert.equal(result.windowId, 77);
  assert.equal(result.owned, false);
  assert.equal(stored.run.automationWindowOwned, false);
  assert.equal(saved, 1);
});

test('new slot lease clears every previous revision and page binding before reassignment', async () => {
  const cleared = { ...{
    generationId: 'old', factsJobId: 'old-facts', pageRunAcceptedAt: 'old-page',
    rendererBootstrappedAt: 'old-renderer', outputFileName: 'old.png',
    lastSendClickedAt: '2026-09-27T20:00:00Z', noResponseSince: '2026-09-27T20:00:00Z',
    autoRefreshGenerationId: 'old', autoRefreshAt: '2026-09-27T20:00:00Z'
  }, ...freshSlotRevisionFields() };
  assert.equal(cleared.generationId, null);
  assert.equal(cleared.factsJobId, null);
  assert.equal(cleared.outputFileName, null);
  assert.equal(cleared.pageRunAcceptedAt, null);
  assert.equal(cleared.rendererBootstrappedAt, null);
  assert.equal(cleared.lastSendClickedAt, null);
  assert.equal(cleared.noResponseSince, null);
  assert.equal(cleared.autoRefreshGenerationId, null);
  assert.equal(cleared.autoRefreshAt, null);
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.equal((worker.match(/\.\.\.freshSlotRevisionFields\(\)/g) || []).length, 2, 'ordinary claim and resume both reset identity');
  assert.match(worker, /Slot generation identity does not match its current SKU and lease/);
});

test('prepared drafts stay unsent and facts draining waits for every worker slot', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const sendStart = worker.indexOf('function slotGenerationSubmitted');
  const sendEnd = worker.indexOf('async function pauseStalledPreparedSlots', sendStart);
  const drainStart = worker.indexOf('function shouldEnterFactsDraining');
  const drainEnd = worker.indexOf('function hasUnresolvedSlotErrors', drainStart);
  const context = { SLOT_PHASES: { SENDING: 'SENDING', PROMPT_SENT: 'PROMPT_SENT', GENERATING: 'GENERATING', OBSERVING: 'OBSERVING', IMAGE_FOUND: 'IMAGE_FOUND', DOWNLOADING: 'DOWNLOADING', VERIFYING_FILE: 'VERIFYING_FILE' } };
  runInNewContext(`${worker.slice(sendStart, sendEnd)}\n${worker.slice(drainStart, drainEnd)}\nglobalThis.isSubmitted = slotGenerationSubmitted; globalThis.mayDrain = shouldEnterFactsDraining;`, context);
  const draft = { entryId: 'watch-b', preparedForSubmit: true, status: 'OBSERVING', phase: 'OBSERVING', finalCheckPending: true,
    preparedAt: '2026-09-28T07:00:00Z', lastSendClickedAt: '2026-09-27T20:00:00Z' };
  assert.equal(context.isSubmitted(draft), false, 'the previous model click cannot turn a prepared draft into a sent generation');
  assert.equal(context.isSubmitted({ ...draft, lastSendClickedAt: '2026-09-28T07:01:00Z' }), true);
  const run = { pendingIds: [], slots: { 0: { entryId: null }, 1: draft }, postprocessTabs: { 9: { entryId: 'watch-a' } } };
  assert.equal(context.mayDrain(run, null), false, 'another claimed worker still needs its Send click');
  run.slots[1].entryId = null;
  assert.equal(context.mayDrain(run, null), true);
});

test('interrupted prepared slots return to the saved plan without a Send click', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const start = worker.indexOf('function slotGenerationSubmitted');
  const end = worker.indexOf('function hasObservationWork', start);
  const entries = ['done', 'draft-a', 'draft-b'].map((sourceId) => ({ sourceId,
    status: sourceId === 'done' ? 'done' : 'running' }));
  const draft = (slotId, entryId) => ({ slotId, entryId, generationId: `gen-${entryId}`,
    preparedForSubmit: true, preparedAt: '2026-09-28T07:00:00Z',
    lastSendClickedAt: '2026-09-27T20:00:00Z', status: 'OBSERVING',
    finalCheckPending: true, tabId: slotId + 100 });
  const run = { operationId: 'run-a', groupId: 'in_sale_good', state: 'DRAINING',
    plannedIds: entries.map((entry) => entry.sourceId), pendingIds: [],
    slots: { 0: { slotId: 0, entryId: null, status: 'DONE' }, 1: draft(1, 'draft-a'), 2: draft(2, 'draft-b') } };
  const stored = { run, queue: { groups: { in_sale_good: entries } }, history: { items: {} }, generationMemory: { items: {} } };
  const cancelled = [];
  const context = {
    SLOT_PHASES: { WAITING_LAUNCH: 'WAITING_LAUNCH', SENDING: 'SENDING', PROMPT_SENT: 'PROMPT_SENT', GENERATING: 'GENERATING', OBSERVING: 'OBSERVING', IMAGE_FOUND: 'IMAGE_FOUND', DOWNLOADING: 'DOWNLOADING', VERIFYING_FILE: 'VERIFYING_FILE' },
    GENERATION_MEMORY_STATUSES: { NOT_READY: 'not_ready' },
    withStateLock: async (fn) => fn(), getStored: async () => stored,
    normalizeHistory: (value) => value, normalizeGenerationMemory: (value) => value,
    groupEntries: () => entries,
    setGenerationMemoryStatus: () => {}, recordRunEvent: () => {},
    saveRunAndQueue: async () => {}, publishRun: async () => {},
    cancelUnsubmittedGenerationRevision: async (generationId) => { cancelled.push(generationId); }
  };
  runInNewContext(`${worker.slice(start, end)}\nglobalThis.recoverDrafts = pauseStalledPreparedSlots;`, context);
  await context.recoverDrafts('run-a');
  assert.equal(run.state, 'PAUSED');
  assert.deepEqual([...run.pendingIds], ['draft-a', 'draft-b']);
  assert.equal(entries[0].status, 'done');
  assert.deepEqual(entries.slice(1).map((entry) => entry.status), ['pending', 'pending']);
  assert.equal(run.slots[1].finalCheckPending, false);
  assert.equal(run.slots[2].finalCheckPending, false);
  assert.deepEqual(cancelled, ['gen-draft-a', 'gen-draft-b']);
});

test('audit ignores a newly allocated tab until PREPARE_PAGE_RUN is acknowledged', () => {
  const slot = { entryId: 'sku-A', tabId: 12, status: 'PREPARING', phase: 'PREPARING' };
  assert.equal(canAuditSlot(slot), false);
  assert.equal(canAuditSlot({ ...slot, pageRunAcceptedAt: '2026-09-27T00:00:00Z' }), true);
  assert.equal(canAuditSlot({ ...slot, generationSubmittedAt: '2026-09-27T00:00:00Z' }), true, 'legacy submitted run is still recoverable');
  assert.equal(canAuditSlot({ ...slot, finalCheckPending: true }), true);
});

test('worker tabs are preallocated in parallel and tab creation is not globally serialized', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.doesNotMatch(worker, /tabCreationChain/);
  assert.match(worker, /async function preallocateWorkerTabs/);
  assert.match(worker, /await Promise\.all\(pending\.map/);
  assert.match(worker, /await preallocateWorkerTabs\(runId, active\)/);
});

test('every never-visited worker tab gets one deterministic renderer bootstrap without focusing the user window', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  assert.match(worker, /async function bootstrapAutomationTab/);
  assert.match(worker, /chrome\.tabs\.update\(Number\(tabId\), \{ active: true \}\)/);
  assert.match(worker, /type: 'BOOTSTRAP_AUTOMATION_TAB'/);
  assert.match(worker, /for \(const assignment of pending\)/);
  assert.match(worker, /slot\.rendererBootstrappedAt/);
  assert.doesNotMatch(worker.slice(worker.indexOf('async function bootstrapAutomationTab'), worker.indexOf('async function createOrReuseTabUnlocked')), /focused: true/);
  assert.match(content, /message\.type === 'BOOTSTRAP_AUTOMATION_TAB'/);
  assert.match(content, /waitForComposerReadyForInput/);
});

test('facts completion has a lightweight 1.5-second service-worker pulse path', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(worker, /FACTS_FAST_PULSE_INTERVAL_MS = 1500/);
  assert.match(worker, /function startFactsPulseMonitor/);
  assert.match(worker, /await pulsePostprocessTabs\(run\)/);
  assert.match(worker, /startFactsPulseMonitor\(100\)/);
  assert.match(worker, /startFactsPulseMonitor\(250\)/);
});

test('prepare path does not wait on telemetry and overlaps upload with prompt fill', async () => {
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  assert.match(content, /postRuntimeMessage\(\{ type: 'STATE_EVENT'/);
  assert.match(content, /postRuntimeMessage\(\{ type: 'LOG_EVENT'/);
  assert.match(content, /const uploadPromise = A\(\)\.uploadFiles/);
  assert.match(content, /const promptPromise = A\(\)\.setComposerText/);
  assert.match(content, /Promise\.all\(\[uploadPromise, promptPromise\]\)/);
  assert.match(content, /message\.type === 'CACHE_FILES'/);
});

test('current ChatGPT image previews count as uploaded attachments outside the form', async () => {
  const source = await readFile(path.join(extensionDir, 'selector-resolver.js'), 'utf8');
  class Element {
    constructor(tag = 'div') {
      this.tag = tag;
      this.isConnected = true;
      this.parentElement = null;
      this.images = [];
      this.groups = [];
      this.src = '';
      this.naturalWidth = 0;
      this.naturalHeight = 0;
    }
    getBoundingClientRect() { return { width: 120, height: 120 }; }
    querySelectorAll(selector) {
      if (selector === 'img') return this.images;
      if (selector === '[role="group"][aria-label]') return this.groups;
      return [];
    }
    closest(selector) {
      if (this === composer && selector === 'form') return form;
      if (this.tag === 'img' && selector.includes('[data-turn]')) return this.navigation ? {} : null;
      return null;
    }
    matches(selector) { return this.tag === 'main' && selector.includes('main'); }
    getAttribute() { return null; }
  }
  const composer = new Element('div');
  const form = new Element('form');
  const wrapper = new Element('section');
  const main = new Element('main');
  form.parentElement = wrapper;
  wrapper.parentElement = main;
  const preview = () => Object.assign(new Element('img'), {
    src: 'blob:https://chatgpt.com/preview', naturalWidth: 512, naturalHeight: 512
  });
  wrapper.images = [preview(), preview()];
  main.images = [...wrapper.images, Object.assign(preview(), { navigation: true })];
  const document = {
    querySelectorAll(selector) { return selector.includes('[role="textbox"]') ? [composer] : []; },
    querySelector() { return null; }
  };
  const window = { __WATCH_AUTOMATION_ENABLED__: true };
  runInNewContext(source, {
    window, document, Element,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  });
  assert.equal(window.WatchSelectorResolver.attachmentTiles().length, 2);
});

test('generated image is found through current accessible label even when legacy turn markers are absent', async () => {
  const source = await readFile(path.join(extensionDir, 'selector-resolver.js'), 'utf8');
  const image = {
    src: 'https://chatgpt.com/backend-api/estuary/content/ready.png',
    currentSrc: '', alt: 'Сгенерированное изображение 1', complete: true,
    naturalWidth: 1024, naturalHeight: 1365,
    getBoundingClientRect: () => ({ width: 400, height: 530 }),
    getAttribute: (name) => name === 'width' ? '1024' : (name === 'height' ? '1365' : null)
  };
  const assistant = {
    querySelectorAll: (selector) => selector.includes('img[alt^=') ? [image] : []
  };
  const user = { querySelectorAll: () => [] };
  const headings = [
    { textContent: 'Вы сказали:', closest: () => user },
    { textContent: 'ChatGPT сказал:', closest: () => assistant }
  ];
  const document = {
    querySelectorAll(selector) {
      if (selector === 'h3, h4, h5, [role="heading"]') return headings;
      if (selector.includes('img[alt^=')) return [image];
      return [];
    }
  };
  const window = { __WATCH_AUTOMATION_ENABLED__: true };
  runInNewContext(source, { window, document });
  const resolver = window.WatchSelectorResolver;
  assert.equal(resolver.assistantTurns().length, 1);
  assert.equal(resolver.userTurns().length, 1);
  assert.equal(resolver.generatedImage(), image);
});

test('ChatGPT conversation load error requires the visible error text and a visible Retry button', async () => {
  const source = await readFile(path.join(extensionDir, 'selector-resolver.js'), 'utf8');
  class Element {
    constructor({ tag = 'div', text = '', ariaLabel = '' } = {}) {
      this.tagName = tag.toUpperCase();
      this.innerText = text;
      this.textContent = text;
      this.isConnected = true;
      this.parentElement = null;
      this.children = [];
      this.attributes = { 'aria-label': ariaLabel };
    }
    append(child) { child.parentElement = this; this.children.push(child); }
    getAttribute(name) { return this.attributes[name] || null; }
    getBoundingClientRect() { return { width: 160, height: 30 }; }
    querySelectorAll(selector) {
      const found = [];
      const visit = (element) => {
        for (const child of element.children) {
          if (selector === 'button, [role="button"]' && child.tagName === 'BUTTON') found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    }
  }
  const retry = new Element({ tag: 'button', text: 'Повторить' });
  const alert = new Element({ text: 'Не удалось загрузить этот разговор ChatGPT Повторить' });
  alert.append(retry);
  const document = { querySelectorAll: (selector) => selector === 'button, [role="button"]' ? [retry] : [] };
  const window = { __WATCH_AUTOMATION_ENABLED__: true };
  runInNewContext(source, {
    window, document, Element,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  });
  assert.equal(window.WatchSelectorResolver.visibleConversationLoadError(), alert);
  alert.innerText = alert.textContent = 'Попробуйте обновить страницу';
  assert.equal(window.WatchSelectorResolver.visibleConversationLoadError(), null);
});

test('conversation load error is reported only when no generated image is already available', async () => {
  const source = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  const errorCard = { innerText: 'Не удалось загрузить этот разговор ChatGPT Повторить' };
  const image = {
    src: 'https://chatgpt.com/backend-api/estuary/content/ready.png',
    currentSrc: '', alt: 'Сгенерированное изображение 1', complete: true,
    naturalWidth: 1024, naturalHeight: 1365,
    getAttribute: () => null
  };
  let hasImage = false;
  const resolver = {
    assistantTurns: () => [], userTurns: () => [], latestAssistantTurn: () => null,
    generatedImage: () => hasImage ? image : null,
    visibleConversationLoadError: () => errorCard,
    dismissRateLimitDialog: () => ({ detected: false }), rateLimitDialog: () => null,
    visibleErrors: () => [], stopGeneratingButton: () => null,
    hasResponseActions: () => false
  };
  const window = { __WATCH_AUTOMATION_ENABLED__: true, WatchSelectorResolver: resolver };
  runInNewContext(source, { window, document: {}, setTimeout, clearTimeout, AbortController, DOMException });
  const adapter = window.WatchChatGPTAdapter;
  assert.equal(adapter.inspectGeneratedImage().state, 'CONVERSATION_LOAD_ERROR');
  hasImage = true;
  assert.equal(adapter.inspectGeneratedImage().state, 'READY');
});

test('long image generation remains observable with zero legacy assistant turns', async () => {
  const source = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  const image = {
    src: 'https://chatgpt.com/backend-api/estuary/content/ready.png',
    currentSrc: '', alt: 'Сгенерированное изображение 1', complete: true,
    naturalWidth: 1024, naturalHeight: 1365,
    getAttribute: () => null
  };
  let available = false;
  const resolver = {
    assistantTurns: () => [], userTurns: () => [], latestAssistantTurn: () => null,
    generatedImage: () => available ? image : null,
    dismissRateLimitDialog: () => ({ detected: false }), rateLimitDialog: () => null,
    visibleErrors: () => [], stopGeneratingButton: () => null,
    hasResponseActions: () => false
  };
  const window = { __WATCH_AUTOMATION_ENABLED__: true, WatchSelectorResolver: resolver };
  runInNewContext(source, { window, document: {}, setTimeout, clearTimeout, AbortController, DOMException });
  const adapter = window.WatchChatGPTAdapter;
  assert.equal(adapter.inspectGeneratedImage().state, 'WAITING_ASSISTANT');
  const abort = new AbortController();
  const abortTimer = setTimeout(() => abort.abort(), 1200);
  const imageTimer = setTimeout(() => { available = true; }, 250);
  try {
    const generated = await adapter.waitForGeneratedImage({ timeout: 1000, debugOverlay: false, signal: abort.signal });
    assert.equal(generated.src, image.src);
    assert.equal(adapter.inspectGeneratedImage().state, 'READY');
  } finally {
    clearTimeout(imageTimer);
    clearTimeout(abortTimer);
  }
});

test('generation observation continues after its warning deadline and accepts a late image', async () => {
  const source = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  const image = {
    src: 'https://chatgpt.com/backend-api/estuary/content/late.png',
    currentSrc: '', alt: 'Сгенерированное изображение 1', complete: true,
    naturalWidth: 1024, naturalHeight: 1365,
    getAttribute: () => null
  };
  let available = false;
  let warnings = 0;
  const resolver = {
    assistantTurns: () => [], userTurns: () => [], latestAssistantTurn: () => null,
    generatedImage: () => available ? image : null,
    dismissRateLimitDialog: () => ({ detected: false }), rateLimitDialog: () => null,
    visibleErrors: () => [], stopGeneratingButton: () => null,
    hasResponseActions: () => false
  };
  const window = { __WATCH_AUTOMATION_ENABLED__: true, WatchSelectorResolver: resolver };
  runInNewContext(source, { window, document: {}, setTimeout, clearTimeout, AbortController, DOMException });
  const adapter = window.WatchChatGPTAdapter;
  const abort = new AbortController();
  const abortTimer = setTimeout(() => abort.abort(), 2500);
  const imageTimer = setTimeout(() => { available = true; }, 250);
  try {
    const generated = await adapter.waitForGeneratedImage({
      timeout: 50,
      debugOverlay: false,
      signal: abort.signal,
      onTimeout: ({ timeoutMs }) => {
        assert.equal(timeoutMs, 50);
        warnings += 1;
      }
    });
    assert.equal(generated.src, image.src);
    assert.equal(warnings, 1);
  } finally {
    clearTimeout(imageTimer);
    clearTimeout(abortTimer);
  }
});

test('unsent upload failure cannot turn into a false generation observation', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const start = worker.indexOf('const generationWasStarted = Boolean(');
  const end = worker.indexOf('const duplicateFailure =', start);
  const decision = worker.slice(start, end);
  assert.match(decision, /currentSlotSendClicked\(failedSlot\)/);
  assert.doesNotMatch(decision, /OBSERVING|WAITING_GENERATION/);
});

test('send spacing clock uses physical Send click while acceptance is asynchronous', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  assert.match(adapter, /async function clickSendPrompt/);
  assert.match(adapter, /async function waitForPromptAcceptance/);
  assert.match(content, /void confirmSendAndMonitor\(click, signal\)/);
  assert.match(content, /sendClickedAtMs: click\.sendClickedAtMs/);
  assert.match(worker, /const sendClickedAt = Number\(submitted\?\.sendClickedAtMs/);
  assert.match(worker, /lastGenerationLaunchAt = Math\.max\([^\n]*sendClickedAt\)/);
});

test('custom output directory uses persisted File System Access handle with Downloads fallback', async () => {
  const idb = await readFile(path.join(extensionDir, 'idb.js'), 'utf8');
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  const html = await readFile(path.join(extensionDir, 'sidepanel.html'), 'utf8');

  assert.match(idb, /DB_VERSION = 6/);
  assert.match(idb, /HANDLE_STORE = 'handles'/);
  assert.match(idb, /REVISION_STORE = 'generationRevisions'/);
  assert.match(idb, /keyPath: 'generationId'/);
  assert.match(idb, /putOutputDirectoryHandle/);
  assert.match(idb, /getOutputDirectoryHandle/);
  assert.match(panel, /showDirectoryPicker\(\{ mode: 'readwrite'/);
  assert.match(panel, /putOutputDirectoryHandle\(handle\)/);
  assert.match(html, /id="chooseOutputFolder"/);
  assert.match(html, /id="grantOutputFolder"/);
  assert.match(worker, /async function writeGeneratedToCustomDirectory/);
  assert.match(worker, /createWritable\(\)/);
  assert.match(worker, /queueGroupsFromCatalog\(persistedCatalog/);
  assert.match(worker, /reconcilePersistedCurrentRevisions/);
  assert.match(worker, /Папка результатов доступна для записи/);
  assert.match(worker, /CUSTOM_OUTPUT_REQUIRES_PAGE_FETCH/);
  assert.match(content, /prepareGeneratedImage\(generated\)/);
});

test('custom output completion is finalized without a chrome download id', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  assert.match(worker, /finalizeCompletedArtifact\(operationId, slotId, entryId, saved\.outputPath/);
  assert.match(worker, /return \{ mode: 'custom', completed: true/);
  assert.match(worker, /mode: 'downloads',[\s\S]{0,160}downloadId,[\s\S]{0,160}sourceMode/);
  assert.match(content, /response\.completed === true && response\.mode === 'custom'/);
  assert.match(content, /Saved to custom output folder/);
});

test('facts postprocess accepts only a complete extraction envelope', async () => {
  await import('../extension/facts-json-utils.js');
  const facts = globalThis.WatchFactsUtils;
  assert.ok(facts, 'WatchFactsUtils must be available');

  const complete = '{"titleBrand":"Casio","titleSeries":"Collection","titleModel":"AE-1500WH-1A","utp1":"10 лет работы батареи","utp2":"LED-подсветка","waterResistance":"100 м","caseSize":"54,4 мм","uncertain":[]}';
  assert.equal(facts.isCompleteFactsResponse(complete), true);
  assert.deepEqual(facts.parseExtractionJson(complete).parsed, {
    titleBrand: 'Casio',
    titleSeries: 'Collection',
    titleModel: 'AE-1500WH-1A',
    utp1: '10 лет работы батареи',
    utp2: 'LED-подсветка',
    waterResistance: '100 м',
    caseSize: '54,4 мм',
    uncertain: []
  });

  const streamedPrefix = '{"titleBrand":"Casio",';
  assert.equal(facts.isCompleteFactsResponse(streamedPrefix), false);
  assert.throws(
    () => facts.parseExtractionJson(streamedPrefix),
    (error) => error?.code === 'FACTS_JSON_INCOMPLETE' && error?.missingKeys?.includes('titleModel')
  );
});

test('facts parser tolerates harmless formatting only when every required field is present', async () => {
  await import('../extension/facts-json-utils.js');
  const facts = globalThis.WatchFactsUtils;

  const fenced = '```json\n{"titleBrand":"Casio","titleSeries":"Collection","titleModel":"AE-1200WHD-1A","utp1":"10-летняя батарея","utp2":"Мировое время","waterResistance":"10 бар","caseSize":"45 мм","uncertain":[],}\n```';
  assert.equal(facts.isCompleteFactsResponse(fenced), true);
  assert.equal(facts.parseExtractionJson(fenced).parsed.titleModel, 'AE-1200WHD-1A');

  const partialButParsable = '{"titleBrand":"Casio","titleSeries":null}';
  assert.equal(facts.isCompleteFactsResponse(partialButParsable), false);
  assert.throws(
    () => facts.parseExtractionJson(partialButParsable),
    (error) => error?.code === 'FACTS_JSON_INCOMPLETE'
  );
});

test('facts discovery scans every assistant fragment and finds a complete JSON outside the last node', async () => {
  await import('../extension/facts-json-utils.js');
  const facts = globalThis.WatchFactsUtils;
  const complete = '{"titleBrand":"Casio","titleSeries":"Collection","titleModel":"AE-1200WHD-1A","utp1":"Батарея 10 лет","utp2":"Мировое время","waterResistance":"10 бар","caseSize":"45 мм","uncertain":[]}';
  assert.equal(facts.findCompleteFactsResponse([
    'Thinking finished',
    complete,
    'Служебный assistant-блок без JSON'
  ]), complete);

  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  assert.match(adapter, /function completeFactsTurn\(turns = \[\]\)/);
  assert.match(adapter, /for \(let index = turns\.length - 1; index >= 0; index -= 1\)/);
  assert.match(adapter, /completeFactsTurn\(candidates\)/);
  assert.doesNotMatch(adapter, /turnText\(candidates\[candidates\.length - 1\], 16000\)/);
});

test('0.3.17 postprocess requires a complete facts envelope and never finalizes a quiet partial stream', async () => {
  const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts?.[0]?.js || [];
  assert.ok(scripts.includes('facts-json-utils.js'));
  assert.ok(scripts.indexOf('facts-json-utils.js') < scripts.indexOf('chatgpt-adapter.js'));

  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');

  assert.match(worker, /FACTS_EXTRACTOR_VERSION = 4/);
  assert.match(worker, /facts-json-utils\.js/);
  assert.match(content, /requireCompleteFactsJson: true/);
  assert.match(adapter, /isCompleteFactsResponse/);
  assert.doesNotMatch(adapter, /FINAL_INCOMPLETE_STABLE_MS/);
  assert.doesNotMatch(adapter, /long-stable-incomplete/);
  assert.match(adapter, /completion: 'facts-json-complete'/);
  assert.match(adapter, /afterUserTurnId/);
  assert.match(adapter, /assistantTurnsAfterUserTurn/);
});


test('all five observed successful postcheck responses stay incomplete until the full streamed JSON arrives', async () => {
  await import('../extension/facts-json-utils.js');
  const facts = globalThis.WatchFactsUtils;
  const samples = [
    '{"titleBrand":"Casio","titleSeries":"Collection","titleModel":"AE-1500WH-1A","utp1":"10 лет работы батареи","utp2":"LED-подсветка","waterResistance":"100 м","caseSize":"54,4 мм","uncertain":[]}',
    '{"titleBrand":"Casio","titleSeries":"Collection","titleModel":"AE-1200WHD-1A","utp1":"10-летняя батарея","utp2":"Мировое время","waterResistance":"10 бар","caseSize":"45 мм","uncertain":[]}',
    '{"titleBrand":"Casio","titleSeries":"Collection","titleModel":"AE-1500WH-2A","utp1":"10-летняя батарея","utp2":"LED-подсветка","waterResistance":"100 м","caseSize":"54,4 мм","uncertain":[]}',
    '{"titleBrand":"Casio","titleSeries":"Collection","titleModel":"AE-1000W-2A","utp1":"Мировое время","utp2":"Батарея 10 лет","waterResistance":"100 м","caseSize":"48,2 мм","uncertain":[]}',
    '{"titleBrand":"Casio","titleSeries":"Collection","titleModel":"AE-1000W-8A","utp1":"10-летняя батарея","utp2":"Мировое время","waterResistance":"100 м","caseSize":"48,2 мм","uncertain":[]}'
  ];

  for (const sample of samples) {
    for (let length = 1; length < sample.length; length += 1) {
      assert.equal(
        facts.isCompleteFactsResponse(sample.slice(0, length)),
        false,
        `stream prefix ${length}/${sample.length} must not be accepted`
      );
    }
    assert.equal(facts.isCompleteFactsResponse(sample), true);
  }
});


test('0.3.8 low-latency path starts HTTPS downloads before page-side PNG copying', async () => {
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');

  assert.match(content, /IMAGE_CANDIDATE_GRACE_MS = 350/);
  assert.match(content, /generatedSourceNeedsPageFetch/);
  assert.match(content, /chrome\.runtime\.sendMessage\(downloadMessage\(null, 'direct-url'\)\)/);
  assert.match(content, /startFactsExtractionFastPath\(\)/);
  assert.match(content, /prompt: runCache\.job\.factsPrompt/);
  assert.doesNotMatch(adapter, /await sleep\(1800\)/);
  assert.match(adapter, /mountedSourceGraceMs = 350/);
  assert.match(adapter, /await sleep\(1000\)/);
  assert.match(adapter, /while \(true\)/);
  assert.match(adapter, /onTimeout\?\.\(\{ timeoutMs: Number\(timeout\), elapsedMs \}\)/);
  assert.match(worker, /factsPrompt: buildFactsExtractionPrompt\(entry\)/);
  assert.match(worker, /const activeDownloadClaims = new Map\(\)/);
  assert.match(worker, /persistDownloadStartedFast/);
  assert.match(worker, /await chrome\.storage\.local\.get\('run'\)/);
  assert.match(worker, /OUTPUT_VERIFY_TIMEOUT_MS = 2000/);
});

test('transient page telemetry no longer rewrites queue/history/generationMemory', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const start = worker.indexOf('async function handleStateEvent(message, sender)');
  const end = worker.indexOf('async function reconcileDownloadChange', start);
  assert.ok(start >= 0 && end > start);
  const block = worker.slice(start, end);
  assert.match(block, /chrome\.storage\.local\.get\('run'\)/);
  assert.match(block, /chrome\.storage\.local\.set\(\{ run \}\)/);
  assert.doesNotMatch(block, /getStored\(\)/);
  assert.doesNotMatch(block, /saveRunAndQueue/);
  assert.doesNotMatch(block, /normalizeGenerationMemory|saveRunAndQueue/);
});

test('fast facts extraction never closes an active download tab before finalization', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  assert.match(content, /fastPath: true/);
  assert.match(content, /fastPath: message\.fastPath === true/);
  assert.match(worker, /const canCleanupFactsTab = Boolean\(tabId\)/);
  assert.match(worker, /message\?\.fastPath !== true/);
  assert.match(worker, /if \(duplicateState === 'done'\) \{/);
  assert.match(worker, /finally\(\(\) => cleanupPostprocessTab\(runId, tabId\)\)/);
});

test('verified finalization preserves only the complete facts record owned by this revision and job', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(worker, /getGenerationFacts, getModelCatalog/);
  assert.match(worker, /persistGenerationImageRevision\(/);
  assert.match(worker, /const expectedFactsJobId = String\(slot\.factsJobId/);
  assert.match(worker, /const factsCandidate = \[revisionFacts, existingFacts\]\.find/);
  assert.match(worker, /String\(facts\.generationId \|\| ''\) === String\(revisionId\)/);
  assert.match(worker, /String\(facts\.factsJobId \|\| ''\) === expectedFactsJobId/);
  assert.match(worker, /factsAlreadyComplete = Boolean/);
  assert.match(worker, /entry\.factsStatus = factsAlreadyComplete \? 'ok'/);
  assert.match(worker, /if \(completedTabId && !factsAlreadyComplete\)/);
  assert.match(worker, /factsAlreadyComplete \? factsCandidate : null/);
});


test('0.3.15 postprocess waits for idle input, fills text, confirms Send readiness, then reserves and clicks', async () => {
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  assert.match(adapter, /function isActualSendButton/);
  assert.match(adapter, /stop\|cancel\|abort\|остан\|прерват\|отмен/);
  assert.match(adapter, /async function waitForComposerReadyForInput/);
  assert.match(adapter, /async function waitForComposerReadyForSend/);

  const inputStart = adapter.indexOf('async function waitForComposerReadyForInput');
  const inputEnd = adapter.indexOf('async function waitForComposerReadyForSend', inputStart);
  const inputBlock = adapter.slice(inputStart, inputEnd);
  assert.match(inputBlock, /stopGeneratingButton/);
  assert.match(inputBlock, /resolve\('composer'\)/);
  assert.doesNotMatch(inputBlock, /resolve\('send'\)/, 'empty composer must not wait for a Send button that does not exist yet');

  const waitInput = content.indexOf('await A().waitForComposerReadyForInput');
  const fill = content.indexOf('const filled = await A().setComposerText', waitInput);
  const waitSend = content.indexOf('await A().waitForComposerReadyForSend', fill);
  const permit = content.indexOf('let permit = await requestFactsSendPermit', waitSend);
  const click = content.indexOf('let click = await A().clickSendPrompt', permit);
  const accepted = content.indexOf('submitted = await A().waitForPromptAcceptance', click);
  assert.ok(waitInput >= 0 && fill > waitInput && waitSend > fill && permit > waitSend && click > permit && accepted > click,
    'postprocess order must be idle -> fill -> Send ready -> permit -> click -> acceptance');
});

test('0.3.9 run stays draining until owned facts tabs finish', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(worker, /const postprocessWork = Object\.keys\(run\?\.postprocessTabs \|\| \{\}\)\.length > 0/);
  assert.match(worker, /Изображения скачаны\. Дожидаюсь постпроверки характеристик\./);
  const cleanupStart = worker.indexOf('async function cleanupPostprocessTab');
  const cleanupEnd = worker.indexOf('function startFactsExtractionDetached', cleanupStart);
  const cleanup = worker.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /finalizeDrainingRun\(stored\.run, stored\.queue\)/);
});

test('0.3.9 fast postprocess failure has a single verified fallback and rejects stale results', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(worker, /message\?\.fastPath === true && postprocessOwnsTab && !rateLimited/);
  assert.match(worker, /Fast-path постпроверка не отправилась; повторяю после подтверждённого скачивания/);
  assert.match(worker, /stored\.run\?\.operationId && stored\.run\.operationId !== runId/);
  assert.match(worker, /!activeSlotOwnsTab && !postprocessOwnsTab/);
});


test('0.3.9 closed postprocess tabs cannot strand DRAINING and diagnostics use the returned composer length', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  assert.match(worker, /const postprocess = run\.postprocessTabs\?\.\[String\(tabId\)\] \|\| null/);
  assert.match(worker, /return cleanupPostprocessTab\(run\.operationId, tabId\)/);
  assert.match(content, /composerCharacters: filled\?\.length \|\| null/);
});


test('0.3.10 rate-limit cooldown is recoverable after MV3 suspension and does not duplicate a live Send task', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(worker, /const activeLaunchTasks = new Map\(\)/);
  assert.match(worker, /const existingTask = activeLaunchTasks\.get\(launchKey\)/);
  assert.match(worker, /if \(existingTask\) return existingTask/);

  const pauseStart = worker.indexOf('async function pauseNewLaunchesForRateLimit');
  const pauseEnd = worker.indexOf('async function waitForRateLimitClear', pauseStart);
  const pauseBlock = worker.slice(pauseStart, pauseEnd);
  assert.match(pauseBlock, /slot\.rateLimitRetryNeeded = true/);

  const resumeStart = worker.indexOf('async function resumeAfterRateLimitPause');
  const resumeEnd = worker.indexOf('async function submitPreparedSlot', resumeStart);
  const resumeBlock = worker.slice(resumeStart, resumeEnd);
  assert.match(resumeBlock, /persistedDeferredLaunch/);
  assert.match(resumeBlock, /slot\.preparedForSubmit === true/);
  assert.match(resumeBlock, /retryAssignments\.push/);
  assert.doesNotMatch(resumeBlock, /slot\.rateLimitRetryNeeded = false/, 'retry marker must survive until a real accepted Send');

  const submitStart = worker.indexOf('async function submitPreparedSlot');
  const submitEnd = worker.indexOf('chrome.runtime.onInstalled.addListener', submitStart);
  const submitBlock = worker.slice(submitStart, submitEnd);
  assert.match(submitBlock, /latestSlot\.rateLimitRetryNeeded = false/);
  assert.match(submitBlock, /const rateLimitRecovered = latestSlot\.rateLimitRetryNeeded === true/);
  assert.match(submitBlock, /if \(!rateLimitRecovered\)/);
});

test('0.3.11 rate-limit detection is latched to the physical Send and audits do not steal the modal', async () => {
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');

  assert.match(adapter, /let lastRateLimitSignal = null/);
  assert.match(adapter, /function noteRateLimit/);
  assert.match(adapter, /function recentRateLimitForSend/);
  assert.match(adapter, /sendClickedAtMs = 0/);
  assert.match(adapter, /const latchedRateLimit = recentRateLimitForSend\(sendClickedAtMs, rateLimitScope\)/);
  assert.match(adapter, /throw rateLimitError\(latchedRateLimit, \{ beforeAssistant: true \}\)/);
  assert.match(content, /sendConfirmationPending = true/);
  assert.match(content, /sendConfirmationPending = false/);
  assert.match(content, /checkAndDismissRateLimit\(\{ notify: true, dismiss: message\.forceDismiss === true \|\| !runCache\?\.sendConfirmationPending \}\)/);
  assert.match(content, /A\(\)\?\.noteRateLimit\?\.\(detected, 'generation'\)/);
});

test('0.3.11 ordinary MV3 worker wake rehydrates live tasks instead of forcing manual pause', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(worker, /async function rehydrateWorkerWake\(\)/);
  assert.match(worker, /scheduleRateLimitResume\(run\.operationId, pauseUntil\)/);
  assert.match(worker, /void submitPreparedSlot\(run\.operationId, slot\.slotId, slot\.entryId, slot\.tabId\)/);
  assert.match(worker, /rehydrateWorkerWake\(\)\.catch/);
  assert.doesNotMatch(worker, /scheduleInterruptedRunRecovery\('Фоновый процесс расширения был перезапущен'\)/);
  assert.match(worker, /if \(rateLimitActive\) slot\.rateLimitRetryNeeded = true/);
  assert.match(worker, /if \(Number\(run\.rateLimitPauseUntil \|\| 0\) > Date\.now\(\)\)/);
});

import {
  meaningfulFactValue,
  effectiveFactsWarnings,
  factsDisplayState,
  sortGalleryRecords,
  physicalPngCount
} from '../extension/gallery-utils.js';

test('rate-limit ignore window accepts a persisted 10-minute setting and expires deterministically', () => {
  assert.equal(normalizeRateLimitIgnoreMinutes(10), 10);
  assert.equal(normalizeRateLimitIgnoreMinutes(0), 0);
  assert.equal(normalizeRateLimitIgnoreMinutes(999), 60);
  assert.equal(isRateLimitIgnored(10_000, 9_999), true);
  assert.equal(isRateLimitIgnored(10_000, 10_000), false);
});

test('intentional user-pause cancellation is distinguishable from a generation failure', () => {
  assert.equal(isUserPauseCancellation('Запуск генерации отменён: очередь больше не активна'), true);
  assert.equal(isUserPauseCancellation('Отправка генерации отменена у физического Send-gate'), true);
  assert.equal(isUserPauseCancellation('PNG verification failed'), false);
});

test('submitted generation refresh is bounded to one reload after four minutes without a tab response', () => {
  const now = 2_000_000_000_000;
  const base = {
    tabId: 14,
    generationId: 'gen-1',
    leaseId: 'lease-1',
    generationSubmittedAt: new Date(now - 10 * 60_000).toISOString(),
    noResponseSince: new Date(now - GENERATION_TRANSPORT_REFRESH_AFTER_MS).toISOString()
  };
  assert.equal(GENERATION_TRANSPORT_REFRESH_AFTER_MS, 4 * 60_000);
  assert.equal(shouldRefreshUnresponsiveGeneration(base, now), true);
  assert.equal(shouldRefreshUnresponsiveGeneration({ ...base, noResponseSince: new Date(now - GENERATION_TRANSPORT_REFRESH_AFTER_MS + 1).toISOString() }, now), false);
  assert.equal(shouldRefreshUnresponsiveGeneration({ ...base, autoRefreshGenerationId: 'gen-1' }, now), false);
  assert.equal(shouldRefreshUnresponsiveGeneration({ ...base, downloadId: 7 }, now), false);
  assert.equal(shouldRefreshUnresponsiveGeneration({ ...base, generationSubmittedAt: null }, now), false);
});

test('load-error classification and recovery delay are stable and explicit', () => {
  assert.equal(CONVERSATION_LOAD_RECOVERY_DELAY_MS, 2 * 60_000);
  assert.equal(classifyAutomationError('Не удалось загрузить этот разговор ChatGPT'), AUTOMATION_ERROR_CLASSES.CONVERSATION_LOAD_ERROR);
  assert.equal(classifyAutomationError('Повторить'), AUTOMATION_ERROR_CLASSES.UNKNOWN);
});

test('gallery physical PNG counter includes archived files while keeping gallery cards separate', () => {
  assert.equal(physicalPngCount(84, 25), 109);
  assert.equal(physicalPngCount(84, 0), 84);
  assert.equal(physicalPngCount(-4, -3), 0);
});

test('verified-output reconciliation requires the exact operation, generation, path and hash', () => {
  const event = {
    type: 'output_verified',
    entryId: 'sku-1',
    generationId: 'gen-2',
    outputPath: 'C:/WatchAutomation/sku.png',
    sha256: 'a'.repeat(64)
  };
  const revision = {
    operationId: 'run-1',
    sourceId: 'sku-1',
    generationId: 'gen-2',
    outputPath: 'C:/WatchAutomation/sku.png',
    outputHash: 'a'.repeat(64)
  };
  assert.equal(verifiedRevisionMatchesEvent(event, revision, 'run-1'), true);
  assert.equal(verifiedRevisionMatchesEvent(event, { ...revision, operationId: 'run-0' }, 'run-1'), false);
  assert.equal(verifiedRevisionMatchesEvent(event, { ...revision, generationId: 'gen-1' }, 'run-1'), false);
  assert.equal(verifiedRevisionMatchesEvent(event, { ...revision, outputPath: 'C:/old.png' }, 'run-1'), false);
  assert.equal(verifiedRevisionMatchesEvent(event, { ...revision, outputHash: 'b'.repeat(64) }, 'run-1'), false);
});

test('gallery does not mark an empty facts record as successful text', () => {
  const record = {
    factsStatus: 'ok',
    facts: {
      status: 'ok',
      titleBrand: null,
      titleSeries: '—',
      titleModel: '',
      utp1: null,
      utp2: null,
      waterResistance: null,
      caseSize: null,
      warnings: []
    }
  };
  assert.equal(meaningfulFactValue('—'), false);
  assert.equal(factsDisplayState(record).kind, 'missing');
  assert.ok(effectiveFactsWarnings(record.facts).includes('EMPTY_FACTS'));
  assert.ok(effectiveFactsWarnings(record.facts).includes('MISSING_UTP_1'));
});

test('gallery reconstructs missing-field warnings for legacy partial facts', () => {
  const record = {
    facts: {
      status: 'ok',
      titleBrand: 'Casio',
      titleSeries: 'Collection',
      titleModel: 'AE-1500WH-1A',
      utp1: '10-летняя батарея',
      utp2: null,
      waterResistance: '100 м',
      caseSize: null,
      warnings: []
    }
  };
  const state = factsDisplayState(record);
  assert.equal(state.kind, 'warning');
  assert.ok(state.warnings.includes('MISSING_UTP_2'));
  assert.ok(state.warnings.includes('MISSING_CASE_SIZE'));
});

test('gallery sorting supports date, natural name and text-issue order', () => {
  const rows = [
    { modelName: 'Casio 10', generatedAt: '2026-09-20T10:00:00Z', facts: { titleBrand:'Casio', titleModel:'10', utp1:'A', utp2:'B', waterResistance:'100 м', caseSize:'45 мм', warnings:[] } },
    { modelName: 'Casio 2', generatedAt: '2026-09-21T10:00:00Z', facts: null },
    { modelName: 'Casio 1', generatedAt: '2026-09-19T10:00:00Z', factsStatus:'error', facts:{ status:'error', warnings:[] } }
  ];
  assert.deepEqual(sortGalleryRecords(rows, 'name_asc').map((item) => item.modelName), ['Casio 1', 'Casio 2', 'Casio 10']);
  assert.deepEqual(sortGalleryRecords(rows, 'date_desc').map((item) => item.modelName), ['Casio 2', 'Casio 10', 'Casio 1']);
  assert.deepEqual(sortGalleryRecords(rows, 'facts_issues').map((item) => item.modelName), ['Casio 1', 'Casio 2', 'Casio 10']);
});

test('0.3.13 facts prompt is literal OCR and does not leak expected model values', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const start = worker.indexOf('function buildFactsExtractionPrompt');
  const end = worker.indexOf('function normalizeExtractedFacts', start);
  const block = worker.slice(start, end);
  assert.match(block, /Источник значений — ТОЛЬКО пиксели/);
  assert.match(block, /Мировое время 48 городов/);
  assert.match(block, /48,2 мм/);
  assert.doesNotMatch(block, /Контрольная модель:/);
  assert.doesNotMatch(block, /Ожидаемый бренд/);
  assert.doesNotMatch(block, /Ожидаемый код/);
});

test('postprocess exposes deterministic stages and shares the physical Send gate', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  assert.match(worker, /POSTPROCESS_SEND_GAP_MS = 3000/);
  assert.match(worker, /REQUEST_FACTS_SEND_PERMIT/);
  assert.match(worker, /FACTS_STAGE_EVENT/);
  assert.match(worker, /factsJobs: factsProgressSummaries\(run\)/);
  assert.match(worker, /startedAt: run\?\.startedAt \|\| null/);
  assert.match(worker, /finishedAt: run\?\.finishedAt \|\| null/);
  assert.match(content, /stage\('WAITING_COMPOSER'/);
  assert.match(content, /stage\('FILLING_PROMPT'/);
  assert.match(content, /stage\('WAITING_SEND'/);
  assert.match(content, /stage\('WAITING_SEND_GATE'/);
  assert.match(content, /stage\('SENDING'/);
  assert.match(content, /stage\('PROMPT_ACCEPTED'/);
  assert.match(content, /stage\('WAITING_RESPONSE_START'/);
  assert.match(content, /stage\('RECEIVING_RESPONSE'/);
  assert.match(content, /stage\('PARSING'/);
  assert.match(panel, /FACTS_STAGE_LABELS/);
  assert.match(panel, /Спецификация ·/);
});

test('0.3.13 stale facts cannot overwrite a newer attempt and transient extracting writes are removed', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  assert.match(worker, /factsJobId = stableHash\(\{[\s\S]*leaseId/);
  assert.match(worker, /reason: 'facts_job_mismatch'/);
  assert.match(worker, /message\?\.error\?\.promptAccepted !== true/);
  assert.match(content, /promptSubmitted: error\.promptSubmitted === true/);
  assert.match(content, /state=error is intentionally restartable/);
  const detachedStart = worker.indexOf('function startFactsExtractionDetached');
  const resultStart = worker.indexOf('async function handleFactsExtractionResult', detachedStart);
  const detached = worker.slice(detachedStart, resultStart);
  assert.doesNotMatch(detached, /putGenerationFacts\(\{[\s\S]*status: 'extracting'/);
});

test('0.3.13 stores exact ChatGPT conversation URL and gallery can reopen it', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const gallery = await readFile(path.join(extensionDir, 'gallery.js'), 'utf8');
  const galleryHtml = await readFile(path.join(extensionDir, 'gallery.html'), 'utf8');
  assert.match(content, /function currentConversationUrl/);
  assert.match(content, /chatUrl: currentConversationUrl\(\)/);
  assert.match(worker, /normalizeChatConversationUrl/);
  assert.match(worker, /entry\.chatUrl = normalizeChatConversationUrl/);
  assert.match(galleryHtml, /id="viewerOpenChat"/);
  assert.match(gallery, /function openCurrentChat/);
  assert.match(gallery, /record\.chatUrl/);
});

test('facts watchdog distinguishes model wait from streaming and preserves late Thinking responses', async () => {
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(content, /FACTS_COMPOSER_TIMEOUT_MS = 30000/);
  assert.match(content, /FACTS_SEND_BUTTON_TIMEOUT_MS = 30000/);
  assert.match(content, /FACTS_ACCEPTANCE_TIMEOUT_MS = 12000/);
  assert.match(content, /FACTS_ACCEPTANCE_RETRY_TIMEOUT_MS = 15000/);
  assert.match(content, /FACTS_RESPONSE_TIMEOUT_MS = 900000/);
  assert.match(content, /stage\('WAITING_SEND'/);
  assert.match(content, /stage\('SEND_CLICKED'/);
  assert.match(content, /stage\('WAITING_ACCEPTANCE'/);
  assert.match(content, /stage\('WAITING_MODEL_RESPONSE'/);
  assert.match(content, /stage\('RECEIVING_RESPONSE'/);
  assert.match(content, /afterUserTurnId: submitted\.userTurnId/);
  assert.match(content, /error\.promptSubmitted = promptSubmitted \|\| error\.promptSubmitted === true/);
  assert.match(content, /error\.promptAccepted = promptAccepted \|\| error\.promptAccepted === true/);
  assert.match(adapter, /error\.promptSubmitted = true/);
  assert.match(worker, /message\?\.error\?\.promptAccepted !== true/);
});

test('verified completion requires the current generation and facts job, then checks the exact image tuple', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const start = worker.indexOf('async function finalizeCompletedArtifact');
  const end = worker.indexOf('async function finishDownload', start);
  const block = worker.slice(start, end);
  assert.match(block, /String\(facts\.generationId \|\| ''\) === String\(revisionId\)/);
  assert.match(block, /String\(facts\.factsJobId \|\| ''\) === expectedFactsJobId/);
  assert.match(block, /normalizedDownloadPath\(facts\.outputPath\) === normalizedDownloadPath\(outputPath\)/);
  assert.match(block, /String\(facts\.outputHash\)\.toLowerCase\(\) === String\(verification\.sha256 \|\| ''\)\.toLowerCase\(\)/);
  assert.match(worker, /String\(message\?\.factsJobId \|\| ''\) !== expectedFactsJobId/);
});



test('0.3.15 postprocess Send permits are not queued behind generation launchChain', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const start = worker.indexOf('async function requestFactsSendPermit');
  const end = worker.indexOf('async function markLaunchWaiting', start);
  const block = worker.slice(start, end);
  assert.match(block, /physicalSendChain\.then/);
  assert.doesNotMatch(block, /launchChain\.then/, 'facts Send permit must not wait behind generation launch scheduler');
  assert.match(worker, /const physicalGateTask = physicalSendChain\.then/);
});

test('0.3.15 rapid status polling bypasses heavy queue synchronization', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  const start = worker.indexOf('async function fastRuntimeState');
  const end = worker.indexOf('async function ensureGenerationMemoryState', start);
  const block = worker.slice(start, end);
  assert.match(block, /chrome\.storage\.local\.get\(\['runtime', 'logs'\]\)/);
  assert.doesNotMatch(block, /withStateLock\(|syncQueueWithHistory\(|getStored\(/);
  assert.match(worker, /message\?\.type === 'GET_RUNTIME_FAST'/);
  assert.match(panel, /setInterval\(\(\) => \{\s*refreshRuntimeFast\(\)/);
  assert.match(panel, /\}, 1000\);/);
  assert.match(panel, /message\?\.type === 'FACTS_STAGE_LIVE'/);
});

test('0.3.15 stop detection is scoped to the composer instead of the whole document', async () => {
  const resolver = await readFile(path.join(extensionDir, 'selector-resolver.js'), 'utf8');
  const start = resolver.indexOf('function stopGeneratingButton');
  const end = resolver.indexOf('const RATE_LIMIT_PATTERN', start);
  const block = resolver.slice(start, end);
  assert.match(resolver, /function composerSurface/);
  assert.match(resolver, /composer\.closest\('form'\)/);
  assert.match(block, /firstVisible\(selector, surface\)/);
  assert.doesNotMatch(block, /firstVisible\(selector\);/);
  assert.doesNotMatch(block, /'\[data-testid\*=\"stop\"\]'/);
});


test('0.3.16 facts composer survives ChatGPT post-image re-mounts', async () => {
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  assert.match(adapter, /Composer text did not persist on the current ChatGPT editor/);
  assert.match(adapter, /fresh !== stableNode/);
  assert.match(adapter, /composerContainsExpected\(fresh, value\)/);
  assert.match(adapter, /attempts < 4/);
  assert.match(adapter, /Date\.now\(\) - stableSince >= 180/);
});

test('0.3.16 Send and Stop detection are scoped and strict inside the composer', async () => {
  const resolver = await readFile(path.join(extensionDir, 'selector-resolver.js'), 'utf8');
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  assert.match(resolver, /function composerSendButton/);
  assert.match(resolver, /resolve\('send', \{ visibleOnly: true, root: surface \}\)/);
  const stopStart = resolver.indexOf('function stopGeneratingButton');
  const stopEnd = resolver.indexOf('const RATE_LIMIT_PATTERN', stopStart);
  const stop = resolver.slice(stopStart, stopEnd);
  assert.doesNotMatch(stop, /data-testid\*=.*stop/i);
  assert.match(adapter, /R\(\)\.composerSendButton\?\.\(\)\.element/);
});

test('0.3.16 facts acceptance can use consumed composer and safely retries only a no-op click', async () => {
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(adapter, /acceptanceMode: accepted\.mode/);
  assert.match(adapter, /mode: 'composer-consumed'/);
  assert.match(content, /stage\('RETRYING_SEND'/);
  assert.match(content, /promptStillPresent && idle/);
  assert.match(content, /expectedPrompt: text/);
  assert.match(worker, /message\?\.error\?\.promptAccepted !== true/);
});

test('0.3.16 facts errors expose exact failed stage in the live panel', async () => {
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  assert.match(content, /error\.factsStage = error\.factsStage \|\| currentStage/);
  assert.match(worker, /errorStage = String\(message\?\.error\?\.factsStage/);
  assert.match(worker, /errorCode: message\?\.error\?\.code \|\| null/);
  assert.match(panel, /const errorText = stage === 'ERROR'/);
  assert.match(panel, /RETRYING_SEND: 'повторяет Send после холостого клика'/);
});

test('run preflight checks a pending entry without generation-slot variables or mutation', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const start = worker.indexOf('async function runPreflight(');
  const end = worker.indexOf('\nasync function importLocalReferences()', start);
  assert.ok(start >= 0 && end > start, 'runPreflight function boundary is present');
  const entry = {
    sourceId: 'casio:AE1200WHD1A',
    sourceVariantId: 'variant-1',
    inputSourceId: 'variant-1',
    modelName: 'Casio AE-1200WHD-1A',
    fileName: 'AE-1200WHD-1A.png',
    outputFileName: 'existing-output-name.png',
    status: 'pending'
  };
  const queue = { groups: { in_sale_good: [entry], in_sale_bad: [], not_in_sale_good: [], not_in_sale_bad: [] } };
  let savedPreflight = null;
  const context = {
    getStored: async () => ({
      job: { prompt: '{{REF_TEMPLATE}} {{REF_WATCH}}', inputMode: 2, filters: { quality: 'good', sale: 'in_sale' } },
      queue
    }),
    buildInputPlan: (mode) => ({ mode: String(mode), count: 2, roles: ['template', 'watchReference'] }),
    normalizeWatchFilter: (filter) => filter,
    parseFilterSelectionId: () => null,
    filterFromQueueGroup: () => ({}),
    groupIdForWatchFilter: () => 'in_sale_good',
    REGENERATION_QUEUE_ID: 'repair',
    QUEUE_GROUP_IDS: ['in_sale_good', 'in_sale_bad', 'not_in_sale_good', 'not_in_sale_bad'],
    groupEntries: (value, groupId) => value?.groups?.[groupId] || [],
    normalizedRepairQueue: () => [],
    computeEntryRecipeHash: async () => 'recipe-hash',
    getAssetKeys: async (prefix) => prefix === 'ref:' ? ['ref:casio-template'] : ['watch:variant-1'],
    detectBrandProfile: () => 'casio',
    referenceCandidatesForRole: (role, profile) => [`${profile}-${role}`],
    fetchWithTimeout: async () => ({ ok: true }),
    outputDirectoryAccess: async () => ({ config: { mode: 'downloads' }, handle: null, permission: 'unknown' }),
    PROMPT_PIPELINE_VERSION: 'test-pipeline',
    stableHash: () => 'preflight-hash',
    chrome: {
      storage: { local: { set: async (value) => { savedPreflight = value.lastPreflight; } } },
      runtime: { sendMessage: async () => ({ ok: true }) }
    }
  };
  const result = await runInNewContext(`${worker.slice(start, end)}\nrunPreflight()`, context);
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.candidates, 1);
  assert.equal(result.checks.find((check) => check.id === 'watch:casio:AE1200WHD1A').ok, true);
  assert.equal(entry.outputFileName, 'existing-output-name.png', 'preflight leaves generation output identity untouched');
  assert.equal(savedPreflight, result, 'preflight result is persisted before Start continues');
});

test('package integrity: every local module/html dependency referenced by the extension exists', async () => {
  const files = (await readdir(extensionDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:js|html)$/i.test(entry.name))
    .map((entry) => entry.name);
  const missing = [];
  for (const relative of files) {
    const file = path.join(extensionDir, relative);
    const text = await readFile(file, 'utf8');
    if (/\.html$/i.test(relative)) {
      for (const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (/^(?:https?:|data:|#)/i.test(specifier)) continue;
        const target = path.resolve(path.dirname(file), specifier);
        try { await access(target); } catch { missing.push(`${relative} -> ${specifier}`); }
      }
      continue;
    }
    for (const match of text.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["']/g)) {
      const specifier = match[1];
      const target = path.resolve(path.dirname(file), specifier);
      try { await access(target); } catch { missing.push(`${relative} -> ${specifier}`); }
    }
  }
  assert.deepEqual(missing, []);
});

test('package integrity: SHA256SUMS entries exist and match the shipped source tree', async () => {
  const manifest = await readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8');
  const failures = [];
  for (const line of manifest.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (!match) {
      failures.push(`malformed checksum line: ${line}`);
      continue;
    }
    const [, expected, relative] = match;
    const file = path.join(root, relative.trim());
    try {
      const bytes = await readFile(file);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected.toLowerCase()) failures.push(`${relative.trim()}: checksum mismatch`);
    } catch {
      failures.push(`${relative.trim()}: missing`);
    }
  }
  assert.deepEqual(failures, []);
});

test('0.3.14 gallery thumbnail cache survives re-render races and invalidates regenerated images', async () => {
  const gallery = await readFile(path.join(extensionDir, 'gallery.js'), 'utf8');
  assert.match(gallery, /function thumbnailCacheKey\(record\)/);
  assert.match(gallery, /record\?\.outputHash/);
  assert.match(gallery, /record\?\.modifiedAt/);
  assert.match(gallery, /const pending = loadingThumbs\.get\(cacheKey\)/);
  assert.match(gallery, /await pending\.catch/);
  assert.match(gallery, /thumbUrls\.set\(cacheKey, source\.url\)/);
});

test('package integrity: static DOM id references exist in gallery and side panel HTML', async () => {
  for (const base of ['gallery', 'sidepanel']) {
    const [js, html] = await Promise.all([
      readFile(path.join(extensionDir, `${base}.js`), 'utf8'),
      readFile(path.join(extensionDir, `${base}.html`), 'utf8')
    ]);
    const htmlIds = new Set([...html.matchAll(/id=["']([^"']+)["']/g)].map((match) => match[1]));
    const referencedIds = new Set([...js.matchAll(/\$\(["']([^"']+)["']\)/g)].map((match) => match[1]));
    const missing = [...referencedIds].filter((id) => !htmlIds.has(id)).sort();
    assert.deepEqual(missing, [], `${base}.js references missing DOM ids`);
  }
});

test('0.3.18 completed generations persist recipe identity and missing legacy hashes do not requeue forever', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const queueUtils = await readFile(path.join(extensionDir, 'queue-utils.js'), 'utf8');
  assert.match(worker, /entry\.recipeHash = slot\.recipeHash \|\| entry\.recipeHash \|\| null/);
  assert.match(worker, /if \(!entry\.recipeHash\) \{[\s\S]*entry\.recipeHash = expectedRecipeHash/);
  assert.match(worker, /return Boolean\(expected && entry\.recipeHash && entry\.recipeHash !== expected\)/);
  assert.match(queueUtils, /recipeHash: overrides\.recipeHash \?\? entry\?\.recipeHash \?\? null/);
  assert.match(queueUtils, /entry\.recipeHash = record\.recipeHash \|\| entry\.recipeHash \|\| null/);
});

test('background facts recovery reloads frozen tabs and resumes DOM inspection without foreground activation', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  assert.match(worker, /async function pulsePostprocessTabs/);
  assert.match(worker, /type: 'PULSE_FACTS_EXTRACTION'/);
  assert.match(worker, /tabState\?\.frozen === true \|\| tabState\?\.discarded === true/);
  assert.match(worker, /chrome\.tabs\.reload\(Number\(owner\.tabId\)\)/);
  assert.match(worker, /recover: true/);
  assert.match(worker, /userTurnId: owner\.userTurnId \|\| null/);
  assert.match(worker, /baselineAssistantCount: Number\(owner\.baselineAssistantCount \|\| 0\)/);
  assert.doesNotMatch(worker.slice(worker.indexOf('async function pulsePostprocessTabs'), worker.indexOf('function startFactsExtractionDetached')), /chrome\.tabs\.update\([^\n]*active:\s*true/);
  assert.match(worker, /completion: 'service-worker-pulse-complete'/);
  assert.match(worker, /await pulsePostprocessTabs\(run\)/);
  assert.match(content, /message\.type === 'PULSE_FACTS_EXTRACTION'/);
  assert.match(content, /userTurnId: submitted\.userTurnId \|\| null/);
  assert.match(content, /baselineAssistantCount: Number\(message\.baselineAssistantCount \|\| 0\)/);
  assert.match(adapter, /function inspectFactsResponse/);
  assert.match(adapter, /isCompleteFactsResponse/);
});

test('five background postprocess owners are inspected independently in one audit pass', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const start = worker.indexOf('async function pulsePostprocessTabs');
  const end = worker.indexOf('function startFactsExtractionDetached', start);
  const block = worker.slice(start, end);
  assert.match(block, /Promise\.all\(liveOwners\.map\(async \(owner\)/);
  assert.match(block, /owner\.recoveryDeadlineAt/);
  assert.match(block, /cleanupPostprocessTab\(runSnapshot\.operationId, owner\.tabId\)/);
  assert.match(block, /if \(!value\?\.complete \|\| !String\(value\?\.text/);
  assert.match(block, /await handleFactsExtractionResult\(/);
  assert.match(block, /generationId: owner\.generationId \|\| null/);
  assert.match(block, /factsJobId: owner\.factsJobId/);
  assert.match(block, /outputHash: owner\.outputHash \|\| null/);
});

test('background recovery window covers a response arriving after fifteen inactive minutes', async () => {
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(content, /FACTS_RESPONSE_TIMEOUT_MS = 900000/);
  assert.match(worker, /periodInMinutes: 0\.5/);
  assert.match(worker, /tabState\?\.frozen === true \|\| tabState\?\.discarded === true/);
  assert.match(worker, /waitTabReady\(Number\(owner\.tabId\), 60000\)/);
});

test('automation launcher guarantees a fresh profile process with background protection flags', async () => {
  const launcher = await readFile(path.join(root, 'launch-automation-profile.cmd'), 'utf8');
  const installer = await readFile(path.join(root, 'Install_WatchAutomation.ps1'), 'utf8');
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(launcher, /--disable-background-timer-throttling/);
  assert.match(launcher, /--disable-renderer-backgrounding/);
  assert.match(launcher, /--disable-backgrounding-occluded-windows/);
  assert.match(launcher, /--disable-features=IntensiveWakeUpThrottling[^\r\n]*FreezingOnBatterySaver[^\r\n]*InfiniteTabsFreezing/);
  assert.match(installer, /\$shortcut\.TargetPath = \$env:ComSpec/);
  assert.match(installer, /launch-automation-profile\.cmd/);
  assert.match(launcher, /Get-CimInstance Win32_Process/);
  assert.match(launcher, /Stop-Process -Id \$pidValue/);
  assert.match(launcher, /CommandLine\.IndexOf\(\$profile,\[StringComparison\]::OrdinalIgnoreCase\) -ge 0/);
  assert.match(worker, /autoDiscardable: false/);
  assert.equal((launcher.match(/(?<!\r)\n/g) || []).length, 0, 'Windows launcher must use CRLF line endings');
  assert.doesNotMatch(launcher, /\^\|/);
  assert.match(launcher, /if errorlevel 1 goto node_missing/);
});

test('generation revisions atomically bind exact PNG, facts and chat while preserving archives', async () => {
  const idb = await readFile(path.join(extensionDir, 'idb.js'), 'utf8');
  const watcher = await readFile(path.join(root, 'dev/watch-extension.mjs'), 'utf8');
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const gallery = await readFile(path.join(extensionDir, 'gallery.js'), 'utf8');
  assert.match(watcher, /async function archiveOutputRevision/);
  assert.match(watcher, /'\/output-archive-revision'/);
  assert.match(watcher, /'_archive'/);
  assert.doesNotMatch(worker, /archivePreviousOutputVariants/);
  assert.match(worker, /OUTPUT_ARCHIVE_REVISION_ENDPOINT/);
  assert.match(idb, /persistGenerationImageRevision/);
  assert.match(idb, /persistGenerationFactsRevision/);
  assert.match(worker, /ensureSlotGenerationIdentity/);
  assert.match(worker, /await persistGenerationImageRevision\(/);
  assert.match(gallery, /galleryRecordsFromCatalog\(catalog, currentRevisionRecords\)/);
  assert.match(gallery, /generationId: record\.generationId \|\| null/);
  const revisionUtils = await readFile(path.join(extensionDir, 'gallery-revision-utils.js'), 'utf8');
  assert.match(revisionUtils, /facts,/);
  assert.match(revisionUtils, /chatUrl: revision\.chatUrl/);
  assert.match(gallery, /versionCount/);
});

test('manual reject targets the exact generation and queues regeneration when archiving fails', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const idb = await readFile(path.join(extensionDir, 'idb.js'), 'utf8');
  const gallery = await readFile(path.join(extensionDir, 'gallery.js'), 'utf8');
  const archiveRequest = worker.slice(worker.indexOf('async function archiveOutputRevisionViaWatcher'), worker.indexOf('async function archiveCustomOutputRevision'));
  const rejectFlow = worker.slice(worker.indexOf('async function reviewGeneration'), worker.indexOf('async function reconcileActiveDownloads'));
  assert.match(gallery, /generationId: record\.generationId \|\| null/);
  assert.match(worker, /const rejectedGenerationId = knownGenerationId \|\| \(normalizedDecision === 'reject'/);
  assert.match(idb, /reviewStatus: 'rejected'/);
  assert.match(worker, /await rejectGenerationRevision\(rejectedGenerationId/);
  assert.match(worker, /GENERATION_MEMORY_STATUSES\.NOT_READY/);
  assert.match(worker, /archiveOutputRevisionViaWatcher\(record\)/);
  assert.doesNotMatch(archiveRequest, /expectedModifiedAt|expectedBytes/);
  assert.match(rejectFlow, /archiveWarning = deletion\?\.error/);
  assert.match(rejectFlow, /upsertRepairQueueItem\(queue, sourceKey, rejectedGenerationId\)/);
  assert.match(gallery, /PNG не перемещён в архив:/);
  assert.doesNotMatch(worker, /archivePreviousOutputVariants/);
  assert.doesNotMatch(worker, /wantedFile = sanitizeFilename\(artifact\.outputFileName\)/);
});

test('SAVED is emitted only after the persistent revision write completes', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const start = worker.indexOf('async function handleFactsExtractionResult');
  const end = worker.indexOf('async function finalizeCompletedArtifact', start);
  const block = worker.slice(start, end);
  const persist = block.indexOf('await persistGenerationFactsRevision(');
  const saved = block.indexOf("stage: 'SAVED'");
  assert.ok(persist >= 0 && saved > persist, 'persistent revision must be committed before SAVED');
  assert.match(block, /generationId не совпадает/);
});

test('gallery recovery reads the existing conversation and writes only the exact immutable revision', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const gallery = await readFile(path.join(extensionDir, 'gallery.js'), 'utf8');
  const start = worker.indexOf('async function recoverRevisionFactsUnlocked');
  const end = worker.indexOf('function recoverRevisionFacts(', start);
  const recovery = worker.slice(start, end);
  assert.match(recovery, /chrome\.tabs\.create\(\{ windowId: host\.id, url: recoveryUrl, active: false \}\)/);
  assert.match(recovery, /await bootstrapAutomationTab\(tabId, host\.id/);
  assert.doesNotMatch(recovery, /chrome\.windows\.create|chrome\.windows\.remove/);
  assert.match(recovery, /type: 'PULSE_FACTS_EXTRACTION'/);
  assert.doesNotMatch(recovery, /START_FACTS_EXTRACTION|EXTRACT_GENERATION_FACTS|buildFactsExtractionPrompt|clickSendPrompt/);
  assert.match(worker, /persistRecoveredRevisionFacts/);
  assert.match(worker, /await getGenerationRevision\(generationIdValue\)/);
  assert.match(worker, /generationId: current\.generationId/);
  assert.match(worker, /outputPath: current\.outputPath/);
  assert.match(worker, /outputHash: current\.outputHash/);
  assert.match(worker, /chatUrl: current\.chatUrl/);
  assert.match(gallery, /type: 'RECOVER_GALLERY_FACTS'/);
  assert.match(gallery, /record\?\.generationId/);
});

test('OCR recovery is scoped to an active run and never opens windows on idle startup', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(worker, /REVISION_FACTS_RECOVERY_ALARM_NAME/);
  assert.match(worker, /scheduleRevisionFactsRecoveryAfterUpgrade\(\)\.catch/);
  assert.match(worker, /async function recoverTimedOutRevisionFacts\(\)/);
  assert.match(worker, /if \(!currentRunId\) return \{ skipped: true, reason: 'no_active_run' \}/);
  assert.match(worker, /revision\.operationId === currentRunId/);
  assert.match(worker, /await getAllGenerationRevisions\(\)/);
  assert.match(worker, /Timeout waiting for settled assistant text/);
  assert.match(worker, /await recoverGalleryFacts\(generationIds\)/);
  assert.match(worker, /chrome\.alarms\.get\(REVISION_FACTS_RECOVERY_ALARM_NAME\)/);
  assert.match(worker, /marker\.buildId === EXTENSION_BUILD_ID && marker\.completedAt/);
});

test('generation Send can confirm a consumed composer when ChatGPT user-turn DOM is late', async () => {
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const block = content.slice(content.indexOf('async function confirmSendAndMonitor'), content.indexOf('async function submitPreparedRun'));
  assert.match(block, /expectedPrompt: runCache\?\.job\?\.prompt \|\| null/);
  const adapter = await readFile(path.join(extensionDir, 'chatgpt-adapter.js'), 'utf8');
  assert.match(adapter, /mode: 'composer-consumed'/);
});

test('terminal LIVE statuses have no growing elapsed timer and idle slots discard stale errors', async () => {
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  assert.match(panel, /if \(slot\.status === 'IDLE' \|\| !slot\.entryId\) return 'idle'/);
  assert.match(panel, /\['SAVED', 'ERROR'\]\.includes\(stage\) \? '' : elapsedShort\(facts\.stageAtMs\)/);
  assert.match(panel, /const facts = hasCurrentRun && slot\?\.entryId/);
});

test('accepted OCR timeout retains its own tab for late full JSON and closes on bounded expiry', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const result = worker.slice(worker.indexOf('async function handleFactsExtractionResult'), worker.indexOf('async function finalizeCompletedArtifact'));
  assert.match(result, /const waitForLateJson = !rateLimited && errorRecord\.promptAccepted/);
  assert.match(result, /&& postprocessOwnsTab/);
  assert.match(result, /owner\.recoveryDeadlineAt = Date\.now\(\) \+ FINAL_CHECK_TIMEOUT_MS/);
  assert.match(result, /stage: 'RECEIVING_RESPONSE'/);
  assert.match(result, /startFactsPulseMonitor\(0\)/);
  const pulse = worker.slice(worker.indexOf('async function pulsePostprocessTabs'), worker.indexOf('async function persistRecoveredRevisionFacts'));
  assert.match(pulse, /Number\(owner\.recoveryDeadlineAt \|\| 0\)/);
  assert.match(pulse, /await cleanupPostprocessTab\(runSnapshot\.operationId, owner\.tabId\)/);
  assert.match(worker, /if \(patch\.factsStatus !== 'ok' && revisionFactsAreComplete\(revision\)\) return/);
});

test('pause keeps OCR observation alive and Stop closes only tracked worker/OCR tabs', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const html = await readFile(path.join(extensionDir, 'sidepanel.html'), 'utf8');
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  assert.match(html, /id="pauseRun"/);
  assert.match(html, /id="stop"/);
  assert.match(panel, /type: 'PAUSE_RUN'/);
  assert.match(panel, /type: 'STOP_RUN'/);
  const observation = worker.slice(worker.indexOf('function hasObservationWork'), worker.indexOf('function scheduledRetriesForRun'));
  assert.match(observation, /run\?\.postprocessTabs/);
  const reset = worker.slice(worker.indexOf('async function resetRunAndRescan'), worker.indexOf('async function clearGenerationHistory'));
  assert.match(reset, /const postprocessTabIds = Object\.keys\(initialRun\?\.postprocessTabs/);
  assert.match(reset, /const recoveryTabIds = Object\.keys\(initialRun\?\.recoveryTabs/);
  assert.match(reset, /\.\.\.postprocessTabIds/);
  assert.match(reset, /\.\.\.recoveryTabIds/);
  assert.match(worker, /cancelUnsubmittedGenerationRevision\(generationId, sourceId, 'user_pause_before_send'\)/);
});

test('reload and restart keep successful SKUs completed through persisted generation memory', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const queueUtils = await readFile(path.join(extensionDir, 'queue-utils.js'), 'utf8');
  assert.match(worker, /chrome\.runtime\.onStartup\.addListener/);
  assert.match(worker, /chrome\.runtime\.onInstalled\.addListener/);
  assert.match(worker, /ensureGenerationMemoryState/);
  assert.match(queueUtils, /generationId: overrides\.generationId \?\? entry\?\.generationId \?\? null/);
  assert.match(queueUtils, /entry\.status = queueStatusForGenerationMemoryStatus\(status\)/);
  assert.match(queueUtils, /entry\.generationId = record\.generationId \|\| null/);
});

test('development auto-reload defers while paused generation tabs still own work', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const guard = worker.slice(worker.indexOf('function runHasActiveAutomationWork'), worker.indexOf('async function postControlResult'));
  const poll = worker.slice(worker.indexOf('async function pollDevReload'), worker.indexOf('function runHasActiveAutomationWork'));
  const refresh = worker.slice(worker.indexOf('async function refreshChatGPTTabsAfterReload'), worker.indexOf('async function initializeDevReloadState'));
  assert.match(guard, /hasLiveSlotWork\(run\)/);
  assert.match(guard, /slot\.entryId && slot\.tabId/);
  assert.match(poll, /runHasActiveAutomationWork\(run\)/);
  assert.match(poll, /Автообновление отложено до завершения текущего прогона/);
  assert.match(refresh, /runHasActiveAutomationWork\(run\)/);
});

test('manual Stop consumes a deferred development reload at the first idle checkpoint', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const poll = worker.slice(worker.indexOf('async function pollDevReload'), worker.indexOf('function runHasActiveAutomationWork'));
  const stopStart = worker.indexOf('async function stopRun()');
  const stopEnd = worker.indexOf('async function setUserStopReloadBoundary', stopStart);
  const stop = worker.slice(stopStart, stopEnd);
  assert.match(stop, /setUserStopReloadBoundary\(true\)/);
  assert.match(stop, /setUserStopReloadBoundary\(false\)/);
  assert.match(poll, /if \(marker\.userStopPending\)/);
  assert.match(poll, /suppressedAfterUserStop: true/);
  assert.match(poll, /pendingRevision: null,[\s\S]*?userStopPending: false/);
});

test('post-cooldown limit warnings are dismissed and coalesced for the configured ignore window', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  const html = await readFile(path.join(extensionDir, 'sidepanel.html'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  assert.match(html, /id="rateLimitIgnoreMinutes"/);
  assert.match(panel, /rateLimitIgnoreMinutes,/);
  assert.match(worker, /armRateLimitIgnoreWindow\(run/);
  assert.match(worker, /ignoreRateLimitDuringWindow\(operationId/);
  assert.match(worker, /recordRunEvent\(run, 'rate_limit_ignore_window'/);
  assert.match(worker, /recordRunEvent\(run, 'rate_limit_ignored'/);
  assert.match(worker, /forceDismiss: isRateLimitIgnored\(run\.rateLimitIgnoreUntil\)/);
  assert.match(content, /message\.forceDismiss === true \|\| !runCache\?\.sendConfirmationPending/);
  assert.match(worker, /latest\.run\.lastGenerationLaunchAt = Math\.max\(Number\(latest\.run\.lastGenerationLaunchAt \|\| 0\), Number\(physicalGate\.reservedAtMs/);
  assert.match(worker, /retryAfterIgnoredRateLimit: true/);
});

test('user pause preserves submitted work and does not convert expected cancellation into slot error', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const pauseStart = worker.indexOf('async function pauseRun(');
  const pauseEnd = worker.indexOf('async function startOrResumeRun(', pauseStart);
  const pauseBlock = worker.slice(pauseStart, pauseEnd);
  assert.match(worker, /isUserPauseCancellation\(error\?\.message\)/);
  assert.match(pauseBlock, /if \(submitted\) \{/);
  assert.doesNotMatch(pauseBlock, /delete history\.items\[entry\.sourceId\]/);
  assert.doesNotMatch(pauseBlock, /history\.ignored\[entry\.sourceId\] = true/);
  assert.match(pauseBlock, /run\.status = observing \? 'PAUSED_RECOVERING' : 'PAUSED'/);
  assert.match(worker, /async function stopRun\(\) \{[\s\S]*?preserveLogs: true/);
  assert.match(worker, /message\?\.type === 'PAUSE_RUN'/);
  assert.match(worker, /message\?\.type === 'STOP_RUN'/);
});

test('verified immutable revisions repair run queue state after interrupted or user-paused runs', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  assert.match(worker, /async function reconcileRunVerifiedRevisions\(/);
  assert.match(worker, /verifiedRevisionMatchesEvent\(event, revision, run\.operationId\)/);
  const revisions = await readFile(path.join(extensionDir, 'generation-revision-utils.js'), 'utf8');
  assert.match(revisions, /String\(revision\.operationId \|\| ''\) === String\(operationId \|\| ''\)/);
  assert.match(revisions, /String\(revision\.outputHash \|\| ''\)\.toLowerCase\(\)/);
  assert.match(worker, /reconcileRunVerifiedRevisions\(run, queue, history, generationMemory\)/);
  assert.match(worker, /reason: 'user-pause'/);
  assert.match(worker, /reason: 'interrupted-run-recovery'/);
});

test('gallery physical file counter includes archived PNGs while SKU cards remain deduplicated', async () => {
  const gallery = await readFile(path.join(extensionDir, 'gallery.js'), 'utf8');
  const html = await readFile(path.join(extensionDir, 'gallery.html'), 'utf8');
  const watcher = await readFile(path.join(root, 'dev', 'watch-extension.mjs'), 'utf8');
  assert.match(gallery, /Карточек из памяти:/);
  assert.match(gallery, /galleryRecordsFromCatalog\(catalog, currentRevisionRecords\)/);
  assert.match(gallery, /в архиве:/);
  assert.match(html, /PNG на диске, включая архив/);
  assert.match(watcher, /countArchivedOutputPngFiles/);
  assert.match(watcher, /archivedCount: await countArchivedOutputPngFiles\(root\)/);
});

test('postprocess timeout recovery, retry wakeups, and facts UI stay bound to persisted generation identity', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const sidepanel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  const retryUtils = await readFile(path.join(extensionDir, 'reliability-utils.js'), 'utf8');
  const factsProgress = await readFile(path.join(extensionDir, 'facts-progress-utils.js'), 'utf8');
  const watcher = await readFile(path.join(root, 'dev/watch-extension.mjs'), 'utf8');

  assert.match(worker, /autoRetryPending = !generationWasStarted/);
  assert.match(worker, /async function processDueScheduledRetries/);
  assert.match(worker, /run\.pendingIds \|\|= \[\]/);
  assert.match(worker, /await processDueScheduledRetries\(\)/);
  assert.match(worker, /hasScheduledRunRetries\(run, queue\)/);
  assert.match(retryUtils, /export function scheduledRunRetries/);
  assert.match(retryUtils, /slot\.generationSubmittedAt/);
  assert.match(worker, /factsStageMatchesOwner\(/);
  assert.match(factsProgress, /factsJobId/);
  assert.match(sidepanel, /selectFactsProgressForSlot\(/);
  assert.match(content, /inspectFactsResponse\?\./);
  assert.match(content, /facts-json-final-timeout-probe/);
  assert.match(content, /responseDiagnostics/);
  assert.match(worker, /const waitForLateJson = !rateLimited && errorRecord\.promptAccepted/);
  assert.match(worker, /owner\.recoveryDeadlineAt = Date\.now\(\) \+ FINAL_CHECK_TIMEOUT_MS/);
  assert.match(worker, /responseDiagnostics: message\.error\.responseDiagnostics/);
  assert.match(watcher, /item\.id > after && item\.status === 'queued'/);
  assert.match(watcher, /if \(command\.completedAt \|\| \['completed', 'failed'\]\.includes\(command\.status\)\)/);
});

test('submitted generation observation can recover an evicted page cache without preparing or resending', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const content = await readFile(path.join(extensionDir, 'content-script.js'), 'utf8');
  const checkStart = content.indexOf("if (message.type === 'CHECK_GENERATION')");
  const checkEnd = content.indexOf("if (message.type === 'DRY_RUN')", checkStart);
  const checkBlock = content.slice(checkStart, checkEnd);

  assert.match(worker, /recover: Boolean\(slot\.generationSubmittedAt && slot\.generationId && slot\.leaseId\)/);
  assert.match(worker, /baselineAssistantCount: Number\(slot\.baselineAssistantCount \|\| 0\)/);
  assert.match(content, /message\.recover !== true \|\| !requestedGenerationId \|\| !message\.leaseId/);
  assert.match(content, /generation-context-recovered/);
  assert.match(checkBlock, /promptSent: true/);
  assert.match(checkBlock, /preparedForSubmit: false/);
  assert.doesNotMatch(checkBlock, /prepareRunForSubmit\(|submitPreparedRun\(|clickSendPrompt\(/);
});

test('conversation load recovery pauses sends, closes only recorded worker tabs, waits, and checks saved chats without resending', async () => {
  const worker = await readFile(path.join(extensionDir, 'service-worker.js'), 'utf8');
  const panel = await readFile(path.join(extensionDir, 'sidepanel.js'), 'utf8');
  const recoveryStart = worker.indexOf('async function beginConversationLoadRecoveryInternal');
  const recoveryEnd = worker.indexOf('function automationConversationUrl', recoveryStart);
  const recovery = worker.slice(recoveryStart, recoveryEnd);
  const failureRecovery = worker.slice(worker.indexOf('async function failConversationLoadRecovery'), recoveryStart);
  const probeStart = recovery.indexOf('const probes = await Promise.all');
  const probeBlock = recovery.slice(probeStart, recovery.indexOf('if (failedProbe)', probeStart));
  const resetStart = worker.indexOf('async function resetRunAndRescan(options = {})');
  const resetEnd = worker.indexOf('async function clearGenerationHistory', resetStart);
  const reset = worker.slice(resetStart, resetEnd);
  const interruptedStart = worker.indexOf('async function recoverInterruptedRun(reason)');
  const interruptedEnd = worker.indexOf('function hasObservationWork', interruptedStart);
  const interrupted = worker.slice(interruptedStart, interruptedEnd);

  assert.match(recovery, /stage: 'INSPECTING'/);
  assert.match(recovery, /stage: 'WAITING'/);
  assert.match(recovery, /CONVERSATION_LOAD_RECOVERY_DELAY_MS/);
  assert.match(recovery, /closeTabs: closeTabRecords/);
  assert.match(recovery, /slot\.leaseId !== submitted\.leaseId/);
  assert.match(recovery, /chatTabFingerprint\(actualChatUrl\) !== chatTabFingerprint\(savedChatUrl\)/);
  assert.doesNotMatch(recovery, /if \(!tab \|\| !urlFingerprint/);
  assert.match(failureRecovery, /stage: 'FAILED'/);
  assert.match(probeBlock, /type: 'CHECK_GENERATION'/);
  assert.match(probeBlock, /recover: true/);
  assert.doesNotMatch(probeBlock, /type: 'PREPARE_PAGE_CONTENT'|submitPreparedSlot\(|clickSendPrompt\(/);
  assert.match(worker, /async function closeConversationRecoveryTabs\(/);
  assert.match(worker, /initialRun && recoveryStage === 'INSPECTING'[\s\S]*?beginConversationLoadRecovery\(/);
  assert.match(worker, /initialRun && \['WAITING', 'REOPENING'\]\.includes\(recoveryStage\)[\s\S]*?closeConversationRecoveryTabs\(/);
  assert.match(reset, /\.\.\.conversationTabIds/);
  assert.match(reset, /conversationRecovery\?\.closeTabs/);
  assert.match(panel, /runtime\.stopBlocked/);
  assert.match(panel, /function stopOrResetRun\(\)/);
  assert.match(panel, /conversationRecoveryBusy = \['INSPECTING', 'WAITING', 'REOPENING'\]/);
  assert.match(interrupted, /Восстанавливаю сессию после обновления расширения без сброса очереди/);
  assert.doesNotMatch(interrupted, /buildChanged[\s\S]{0,180}resetRunAndRescan\(/);
});
