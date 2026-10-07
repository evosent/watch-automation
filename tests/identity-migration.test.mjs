import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCodeFromName, skuKeyForModelName } from '../extension/sku-utils.js';
import { buildIdentityMigrationPlan } from '../extension/identity-migration-utils.js';
import { portableResult, planResultsMerge } from '../extension/results-transfer-utils.js';
import { mergeScannedGroups, modelCatalogRecordsFromGroups, queueGroupsFromCatalog, queuePartPlan,
  sourceVariantIdFor } from '../extension/queue-utils.js';

const ssModel = 'Casio CASIOTRON 50th TRN-50SS-2A Мужские Японские наручные часы, Гарантия';
const zeModel = 'Casio CASIOTRON 50th TRN-50ZE-1A Мужские Японские наручные часы, Гарантия';
const ssId = 'casio:TRN50SS2A';
const zeId = 'casio:TRN50ZE1A';
const oldId = 'casio:50TH';
const hash = (digit) => digit.repeat(64);

function legacyRevision({ generationId, modelName, sourceVariantId, outputHash, titleModel, sourceId = oldId }) {
  return {
    generationId, sourceId, skuKey: sourceId, modelName,
    fileName: `${modelName}.png`, outputFileName: `gen-${modelName}__${generationId}.png`,
    groupId: 'in_sale_good',
    inputPath: `input-watches-images/in_sale/${modelName}.png`, sourceVariantId,
    outputHash, status: 'READY', factsStatus: 'ok',
    factsJobId: `facts-${generationId}`,
    facts: { sourceId, generationId, factsJobId: `facts-${generationId}`, outputHash,
      status: 'ok', titleBrand: 'Casio', titleModel }
  };
}

test('model code extraction skips ordinal labels and keeps dotted model suffixes', () => {
  assert.equal(modelCodeFromName(ssModel), 'TRN50SS2A');
  assert.equal(modelCodeFromName(zeModel), 'TRN50ZE1A');
  assert.equal(modelCodeFromName('Tissot T006.207.11.058.00'), 'T0062071105800');
  assert.equal(modelCodeFromName('Tissot T006.207.11.058.00.png'), 'T0062071105800');
  assert.equal(modelCodeFromName('Longines Master Collection L2.673.4.78.6'), 'L26734786');
  assert.equal(modelCodeFromName('Longines L2.673.4.78.6.png'), 'L26734786');
  assert.equal(modelCodeFromName('Certina DS Action C032.607.11.051.00'), 'C0326071105100');
  assert.equal(modelCodeFromName('Certina C032.607.11.051.00.jpg'), 'C0326071105100');
  assert.equal(skuKeyForModelName('Tissot T006.207.11.058.00', 'tissot'), 'tissot:T0062071105800');
  assert.equal(modelCodeFromName('Casiotron 50th Anniversary'), null);
});

test('identity migration splits revisions by exact model evidence and keeps provenance', () => {
  const revisions = [
    legacyRevision({ generationId: 'ss-1', modelName: ssModel, sourceVariantId: 'in_sale_good|ss.png', outputHash: hash('a'), titleModel: 'TRN-50SS-2A' }),
    legacyRevision({ generationId: 'ze-1', modelName: zeModel, sourceVariantId: 'in_sale_bad|ze.png', outputHash: hash('b'), titleModel: 'TRN-50ZE-1A' })
  ];
  const catalogRows = [{ sourceId: oldId, skuKey: oldId, brandId: 'casio', sourcePresent: true, modelName: ssModel,
    variants: [
      { groupId: 'in_sale_good', modelName: ssModel, fileName: `${ssModel}.png`, sourceVariantId: 'in_sale_good|ss.png' },
      { groupId: 'in_sale_bad', modelName: zeModel, fileName: `${zeModel}.png`, sourceVariantId: 'in_sale_bad|ze.png' }
    ] }];
  const plan = buildIdentityMigrationPlan({ catalogRows, revisions });
  assert.deepEqual(plan.revisionMoves.map(({ generationId, toSourceId }) => [generationId, toSourceId]), [
    ['ss-1', ssId], ['ze-1', zeId]
  ]);
  assert.ok(plan.revisionMoves.every((move) => move.fromSourceId === oldId && move.originSourceId === oldId));
  assert.deepEqual(plan.catalogAssignments.map(({ toSourceId }) => toSourceId), [ssId, zeId]);
  const primary = plan.catalogAssignments.find((assignment) => assignment.toSourceId === ssId);
  const additional = plan.catalogAssignments.find((assignment) => assignment.toSourceId === zeId);
  assert.equal(primary.partitionOrderKey, oldId);
  assert.equal(additional.partitionOrderKey, `~identity-split:${oldId}:${zeId}`);
  assert.equal(additional.membership.groupId, 'in_sale_bad');
  assert.equal(plan.quarantined.length, 0);
});

test('good and bad source variants for the same watch remain one catalog identity', () => {
  const catalogRows = [{ sourceId: oldId, skuKey: oldId, brandId: 'casio', sourcePresent: true, modelName: ssModel,
    variants: [
      { groupId: 'in_sale_good', modelName: ssModel, fileName: `${ssModel}.png`, sourceVariantId: 'in_sale_good|ss-good.png' },
      { groupId: 'in_sale_bad', modelName: ssModel, fileName: `${ssModel}.png`, sourceVariantId: 'in_sale_bad|ss-bad.png' }
    ] }];
  const plan = buildIdentityMigrationPlan({ catalogRows });
  assert.equal(plan.catalogAssignments.length, 1);
  assert.equal(plan.catalogAssignments[0].toSourceId, ssId);
  assert.deepEqual(plan.catalogAssignments[0].variantKeys, ['in_sale_good|ss-good.png', 'in_sale_bad|ss-bad.png']);
});

test('conflicting spec and filename evidence is quarantined without moving the revision', () => {
  const revision = legacyRevision({ generationId: 'conflict', modelName: ssModel,
    sourceVariantId: 'in_sale_good|ss.png', outputHash: hash('c'), titleModel: 'TRN-50ZE-1A' });
  const plan = buildIdentityMigrationPlan({ revisions: [revision] });
  assert.equal(plan.revisionMoves.length, 0);
  assert.equal(plan.quarantined.length, 1);
  assert.equal(plan.quarantined[0].reason, 'conflicting-model-code-evidence');
  assert.equal(plan.quarantined[0].generationId, 'conflict');
});

test('opaque source variant IDs are not interpreted as model-code evidence', () => {
  const revision = legacyRevision({ generationId: 'opaque-variant', modelName: ssModel,
    sourceVariantId: 'input-TRN-50ZE-1A-good', outputHash: hash('8'), titleModel: 'TRN-50SS-2A' });
  const plan = buildIdentityMigrationPlan({ revisions: [revision] });
  assert.equal(plan.revisionMoves.length, 1);
  assert.equal(plan.revisionMoves[0].toSourceId, ssId);
  assert.equal(plan.quarantined.length, 0);
});

test('canonical revision identities remain unchanged', () => {
  const revision = { ...legacyRevision({ generationId: 'canonical', modelName: ssModel,
    sourceVariantId: 'in_sale_good|ss.png', outputHash: hash('d'), titleModel: 'TRN-50SS-2A', sourceId: ssId }),
  skuKey: ssId };
  const plan = buildIdentityMigrationPlan({ revisions: [revision] });
  assert.equal(plan.revisionMoves.length, 0);
  assert.deepEqual(plan.unchangedRevisions, [{ generationId: 'canonical', sourceId: ssId, outputHash: hash('d') }]);
  assert.equal(plan.quarantined.length, 0);
});

test('rekey preserves the existing first 100 part memberships and places a split SKU at the tail', () => {
  const oldItems = Array.from({ length: 99 }, (_, index) => {
    const sku = `casio:A${String(index + 1).padStart(3, '0')}`;
    return { sourceId: sku, skuKey: sku, partitionOrderKey: sku };
  });
  oldItems.push({ sourceId: oldId, skuKey: oldId, partitionOrderKey: oldId });
  const before = queuePartPlan(oldItems, 100, 'regular|in_sale|good|casio');
  const afterItems = oldItems.map((entry) => entry.sourceId === oldId
    ? { ...entry, sourceId: ssId, skuKey: ssId, partitionOrderKey: oldId }
    : entry);
  afterItems.push({ sourceId: zeId, skuKey: zeId, partitionOrderKey: `~identity-split:${oldId}:${zeId}` });
  const after = queuePartPlan(afterItems, 100, 'regular|in_sale|good|casio');
  assert.equal(before.parts[0].count, 100);
  assert.equal(after.parts[0].count, 100);
  assert.deepEqual(after.parts[0].entries.map((entry) => entry.partitionOrderKey),
    before.parts[0].entries.map((entry) => entry.partitionOrderKey));
  assert.equal(after.parts[0].sourceIds.includes(ssId), true);
  assert.equal(after.parts[0].sourceIds.includes(zeId), false);
  assert.equal(after.parts[1].sourceIds.includes(zeId), true);
});

test('partition order key survives rescan, catalog persistence and queue reconstruction after a rekey', () => {
  const filename = `${ssModel}.png`;
  const relativePath = `input-watches-images/in_sale/${filename}`;
  const variantId = sourceVariantIdFor('in_sale_good', relativePath);
  const fingerprint = `123:456:${filename}`;
  const previous = { sourceId: oldId, skuKey: oldId, partitionOrderKey: oldId,
    sourceVariantId: variantId, inputSourceId: variantId, relativePath, fileName: filename,
    modelName: ssModel, fingerprint, sourceHash: hash('7'), status: 'done',
    variants: [{ sourceId: oldId, skuKey: oldId, sourceVariantId: variantId, variantId,
      groupId: 'in_sale_good', relativePath, fileName: filename, modelName: ssModel,
      fingerprint, sourceHash: hash('7'), status: 'done' }] };
  const scanned = { in_sale_good: [{ file: { name: filename, size: 123, lastModified: 456 }, relativePath, sourceHash: hash('7') }],
    in_sale_bad: [], not_in_sale_good: [], not_in_sale_bad: [] };
  const merged = mergeScannedGroups(scanned, { in_sale_good: [previous], in_sale_bad: [], not_in_sale_good: [], not_in_sale_bad: [] });
  assert.equal(merged.in_sale_good[0].sourceId, ssId);
  assert.equal(merged.in_sale_good[0].partitionOrderKey, oldId);

  const catalog = modelCatalogRecordsFromGroups(merged);
  assert.equal(catalog[0].sourceId, ssId);
  assert.equal(catalog[0].partitionOrderKey, oldId);
  const rebuilt = queueGroupsFromCatalog(catalog);
  assert.equal(rebuilt.in_sale_good[0].sourceId, ssId);
  assert.equal(rebuilt.in_sale_good[0].partitionOrderKey, oldId);
});

test('version-1 transfer archive corrects a verified legacy alias before merge', () => {
  const record = legacyRevision({ generationId: 'friend-ss', modelName: ssModel,
    sourceVariantId: 'in_sale_good|friend-ss.png', outputHash: hash('e'), titleModel: 'TRN-50SS-2A' });
  record.outputPath = 'D:/friend/Downloads/WatchAutomation/in_sale_good/result.png';
  const portable = portableResult(record);
  assert.equal(portable.sourceId, ssId);
  assert.equal(portable.originSourceId, oldId);
  assert.equal(portable.facts.sourceId, ssId);

  const local = { ...portable, generationId: 'local-ss', outputPath: 'D:/mine/result.png', outputHash: hash('f'),
    factsJobId: 'facts-local', factsStatus: 'ok', status: 'READY', latestReadyGenerationId: 'local-ss' };
  const catalog = [{ sourceId: ssId, skuKey: ssId, modelName: ssModel, brandId: 'casio', sourcePresent: true,
    currentGenerationId: 'local-ss', latestReadyGenerationId: 'local-ss', variants: [] }];
  const merge = planResultsMerge([record], { revisions: [local], catalog });
  assert.equal(merge.models.length, 0, 'existing local accepted result remains selected');
  assert.equal(merge.revisions.length, 1);
  assert.equal(merge.revisions[0].sourceId, ssId);
  assert.equal(merge.revisions[0].originSourceId, oldId);

  const spoofed = { ...record, sourceId: 'casio:WRONG' };
  assert.throws(() => portableResult(spoofed), /ID модели/);
});

test('color/model suffixes remain distinct in imported result identity', () => {
  const first = portableResult(legacyRevision({ generationId: 'friend-ss-color', modelName: ssModel,
    sourceVariantId: 'in_sale_good|friend-ss.png', outputHash: hash('1'), titleModel: 'TRN-50SS-2A' }));
  const second = portableResult(legacyRevision({ generationId: 'friend-ze-color', modelName: zeModel,
    sourceVariantId: 'in_sale_good|friend-ze.png', outputHash: hash('2'), titleModel: 'TRN-50ZE-1A' }));
  assert.equal(first.sourceId, ssId);
  assert.equal(second.sourceId, zeId);
  assert.notEqual(first.sourceId, second.sourceId);
});

test('version-1 dotted-code alias is repaired only when the complete model code matches its specification', () => {
  const modelName = 'Tissot T006.207.11.058.00 Женские швейцарские часы';
  const record = { ...legacyRevision({ generationId: 'tissot-dot', modelName,
    sourceVariantId: 'in_sale_good|tissot-dot.png', outputHash: hash('3'), titleModel: 'T006.207.11.058.00',
    sourceId: 'tissot:T00620711058' }),
  facts: { sourceId: 'tissot:T00620711058', generationId: 'tissot-dot', factsJobId: 'facts-tissot-dot',
    outputHash: hash('3'), status: 'ok', titleBrand: 'Tissot', titleModel: 'T006.207.11.058.00' } };
  const portable = portableResult(record);
  assert.equal(portable.sourceId, 'tissot:T0062071105800');
  assert.equal(portable.originSourceId, 'tissot:T00620711058');
  assert.throws(() => portableResult({ ...record, facts: { ...record.facts, titleModel: 'T006.207.11.058.01' } }), /Код модели/);
});

test('portable results with a canonical name-based identity remain transferable', () => {
  const modelName = 'Casio Collection Model without a reference';
  const canonicalId = 'casio:name:casio_collection_model_without_a_reference';
  const portable = portableResult({ generationId: 'name-only', sourceId: canonicalId,
    modelName, groupId: 'in_sale_good', outputHash: hash('4'), factsStatus: 'missing' });
  assert.equal(portable.sourceId, canonicalId);
});
