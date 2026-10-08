import {
  QUEUE_GROUP_IDS, brandIdFromModelName, sourceIdFor,
  generationMemoryRecordFromEntry, historyRecordFromEntry,
  applyGenerationHistory, applyGenerationMemory
} from './queue-utils.js';
import { canonicalBrandIdentityId, modelCodeFromName } from './sku-utils.js';
import { legacySkuKeyForArchiveModelName } from './identity-migration-utils.js';

export const RESULTS_PACKAGE_FORMAT = 'watch-automation-results';
export const RESULTS_PACKAGE_VERSION = 1;
export const MAX_RESULT_RECORDS = 5000;
const HASH = /^[a-f0-9]{64}$/i;
const REVISION_FIELDS = [
  'generationId', 'sourceId', 'modelName', 'fileName', 'groupId', 'sourceVariantId',
  'relativePath', 'sourceHash', 'recipeHash', 'profileId', 'profileVersion', 'attempt',
  'generatedAt', 'completedAt', 'downloadedAt', 'outputHash', 'outputWidth', 'outputHeight', 'factsJobId', 'operationId',
  'originSourceId'
];
const FACTS_FIELDS = [
  'titleBrand', 'titleSeries', 'titleModel', 'utp1', 'utp2', 'waterResistance',
  'waterResistanceValue', 'waterResistanceUnit', 'caseSize', 'caseSizeValueMm',
  'warnings', 'extractedAt', 'extractorVersion', 'completion', 'profileId',
  'titleLayoutVersion', 'seriesPolicy', 'brandLineCount', 'seriesRequired',
  'expectedTitleBrand', 'expectedTitleSeries', 'expectedTitleModel'
];
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => object?.[key] != null)
  .map((key) => [key, object[key]]));

function canonicalPortableSourceId(record) {
  const canonicalId = sourceIdFor(record.groupId, record.relativePath, record.modelName);
  const currentCode = modelCodeFromName(record.modelName);
  const brandId = brandIdFromModelName(record.modelName);
  const facts = record.facts && typeof record.facts === 'object' ? record.facts : null;
  const explicitModelValues = [facts?.titleModel, facts?.expectedTitleModel].filter((value) => String(value || '').trim());
  if (explicitModelValues.some((value) => modelCodeFromName(value) !== currentCode)) {
    throw new Error('Код модели в названии и спецификации не совпадает');
  }
  const factsBrand = String(facts?.titleBrand || facts?.expectedTitleBrand || '').trim();
  if (factsBrand && canonicalBrandIdentityId(factsBrand) !== canonicalBrandIdentityId(brandId)) {
    throw new Error('Бренд в названии и спецификации не совпадает');
  }
  if (facts?.sourceId && facts.sourceId !== record.sourceId && facts.sourceId !== canonicalId) {
    throw new Error('ID модели в спецификации не совпадает с результатом');
  }
  const suppliedOrigin = String(record.originSourceId || '').trim();
  const legacyId = legacySkuKeyForArchiveModelName(record.modelName, brandId);
  if (record.sourceId === canonicalId) {
    if (suppliedOrigin && suppliedOrigin !== canonicalId && suppliedOrigin !== legacyId) {
      throw new Error('Исторический ID модели не соответствует результату');
    }
    return { sourceId: canonicalId, originSourceId: suppliedOrigin || null };
  }

  if (!currentCode) throw new Error('Невозможно подтвердить код модели для исторического ID');

  // Version-1 archives may contain an ID produced by the former first-match
  // parser. Accept it only when that parser derives the supplied alias from
  // this exact name and the current parser independently identifies a model.
  if (legacyId !== record.sourceId || legacyId === canonicalId) {
    throw new Error('ID модели или контрольная сумма результата некорректны');
  }
  if (suppliedOrigin && suppliedOrigin !== canonicalId && suppliedOrigin !== record.sourceId) {
    throw new Error('Исторический ID модели не соответствует результату');
  }
  return { sourceId: canonicalId, originSourceId: suppliedOrigin || record.sourceId };
}

export function transferableRevision(record) {
  return Boolean(record?.generationId && record.sourceId && record.outputPath
    && HASH.test(String(record.outputHash || '')) && record.reviewStatus !== 'rejected'
    && !['GENERATING', 'PENDING', 'CANCELLED', 'FAILED', 'REJECTED'].includes(String(record.status || '').toUpperCase()));
}

export function portableResult(record) {
  if (!record || typeof record !== 'object') throw new Error('Некорректная запись результата');
  const result = pick(record, REVISION_FIELDS);
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string' && (value.length > 2048 || value.includes('\0'))) throw new Error(`Некорректное поле ${key}`);
    if (!['string', 'number'].includes(typeof value)) throw new Error(`Некорректное поле ${key}`);
  }
  if (!result.generationId || !result.modelName || !HASH.test(String(result.outputHash || ''))) {
    throw new Error('ID модели или контрольная сумма результата некорректны');
  }
  const identity = canonicalPortableSourceId({ ...record, ...result, facts: record.facts });
  result.originSourceId = identity.originSourceId || undefined;
  result.sourceId = identity.sourceId;
  result.outputHash = result.outputHash.toLowerCase();
  if (!QUEUE_GROUP_IDS.includes(result.groupId)) throw new Error('Неизвестная категория результата');
  const facts = record.facts;
  const ready = Boolean(record.factsStatus === 'ok' && facts?.status === 'ok' && result.factsJobId
    && facts.generationId === record.generationId && facts.factsJobId === result.factsJobId
    && String(facts.outputHash || '').toLowerCase() === result.outputHash);
  const selectedFacts = ready ? pick(facts, FACTS_FIELDS) : null;
  if (selectedFacts && Object.hasOwn(facts, 'titleSeries')) selectedFacts.titleSeries = facts.titleSeries;
  if (selectedFacts && JSON.stringify(selectedFacts).length > 64000) throw new Error('Спецификация слишком большая');
  if (selectedFacts) {
    for (const [key, value] of Object.entries(selectedFacts)) {
      if (key === 'warnings') {
        if (!Array.isArray(value) || value.length > 100 || value.some((warning) => typeof warning !== 'string' || warning.length > 2000)) throw new Error('Некорректные замечания спецификации');
      } else if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Некорректное поле спецификации');
    }
  }
  result.factsStatus = ready ? 'ok' : 'missing';
  result.status = ready ? 'READY' : 'IMAGE_SAVED';
  result.facts = ready ? { ...selectedFacts, status: 'ok', sourceId: result.sourceId,
    generationId: result.generationId, factsJobId: result.factsJobId, outputHash: result.outputHash } : null;
  return result;
}

export function validateResultsManifest(manifest) {
  if (manifest?.format !== RESULTS_PACKAGE_FORMAT || manifest.schemaVersion !== RESULTS_PACKAGE_VERSION) {
    throw new Error('Неподдерживаемый формат архива результатов');
  }
  if (!Array.isArray(manifest.items) || !manifest.items.length || manifest.items.length > MAX_RESULT_RECORDS) {
    throw new Error('Архив должен содержать от 1 до 5000 результатов');
  }
  const seen = new Set();
  return { format: RESULTS_PACKAGE_FORMAT, schemaVersion: RESULTS_PACKAGE_VERSION,
    exportedAt: String(manifest.exportedAt || ''), items: manifest.items.map((item) => {
      const record = portableResult(item);
      if (item.image !== `images/${record.outputHash}.png`) throw new Error('Некорректный путь PNG в архиве');
      const key = `${record.sourceId}|${record.outputHash}`;
      if (seen.has(key)) throw new Error('Архив содержит повторяющийся результат');
      seen.add(key);
      return { ...record, image: item.image };
    }) };
}

export function resultsImportPreview(items, existingRevisions = []) {
  const normalizedItems = items.map((item) => portableResult(item));
  const saved = existingRevisions.filter((record) => record.outputHash && record.outputPath);
  let duplicates = 0;
  let conflicts = 0;
  let rejected = 0;
  for (const item of normalizedItems) {
    const sameModel = saved.filter((record) => record.sourceId === item.sourceId);
    const sameImage = sameModel.find((record) => String(record.outputHash).toLowerCase() === item.outputHash);
    if (sameImage) { duplicates += 1; if (sameImage.reviewStatus === 'rejected') rejected += 1; }
    else if (sameModel.length) conflicts += 1;
  }
  return { total: normalizedItems.length, models: new Set(normalizedItems.map((item) => item.sourceId)).size,
    newResults: normalizedItems.length - duplicates, duplicates, conflicts, rejected,
    withoutFacts: normalizedItems.filter((item) => item.factsStatus !== 'ok').length };
}

// Import adapts portable records to this installation's input fingerprints.
// Source folders/catalog are never taken from the sender's machine.
export function planResultsMerge(items, { revisions = [], catalog = [], queue = { groups: {} },
  history = {}, generationMemory = {} } = {}) {
  const nextQueue = structuredClone(queue);
  const nextHistory = structuredClone({ version: 1, items: {}, ignored: {}, ...history });
  const memory = structuredClone({ version: 1, items: {}, ...generationMemory });
  const models = new Map(catalog.map((record) => [record.skuKey, structuredClone(record)]));
  const saved = new Map(revisions.map((record) => [record.generationId, record]));
  const changes = new Map();
  const modelChanges = new Map();
  const now = new Date().toISOString();
  const preview = resultsImportPreview(items, revisions);
  const adopted = new Set();
  let incompatibleInputs = 0;
  for (const incoming of [...items].sort((a, b) => String(a.completedAt || a.generatedAt || '').localeCompare(String(b.completedAt || b.generatedAt || '')))) {
    const portable = portableResult(incoming);
    if (!incoming.outputPath) throw new Error('PNG ещё не установлен в папку результатов');
    const same = [...saved.values()].find((record) => record.sourceId === portable.sourceId
      && String(record.outputHash || '').toLowerCase() === portable.outputHash);
    if (same?.reviewStatus === 'rejected') continue;
    const id = same?.generationId || `import:${portable.sourceId}:${portable.outputHash}`;
    const localFactsValid = same?.factsStatus === 'ok' && same.facts?.status === 'ok'
      && same.facts.generationId === same.generationId && same.facts.factsJobId === same.factsJobId
      && String(same.facts.outputHash || '').toLowerCase() === portable.outputHash;
    const factsCandidate = localFactsValid ? same.facts : portable.facts;
    const factsJobId = factsCandidate?.factsJobId || portable.factsJobId || null;
    const facts = factsCandidate ? { ...factsCandidate, sourceId: portable.sourceId, generationId: id,
      factsJobId, outputHash: portable.outputHash, outputPath: incoming.outputPath, chatUrl: null } : null;
    const revision = { ...portable, ...(same || {}), generationId: id, outputPath: incoming.outputPath,
      outputFileName: String(incoming.outputPath).replaceAll('\\', '/').split('/').at(-1),
      outputHash: portable.outputHash, factsJobId, facts,
      factsStatus: facts ? 'ok' : 'missing', status: facts ? 'READY' : 'IMAGE_SAVED',
      verificationMode: 'results-import-sha256', importedAt: same ? (same.importedAt || null) : now,
      importedGenerationId: same?.importedGenerationId || portable.generationId, updatedAt: now };
    saved.set(id, revision);
    changes.set(id, revision);
    const model = models.get(portable.sourceId) || { skuKey: portable.sourceId, sourceId: portable.sourceId,
      modelName: portable.modelName, brandId: brandIdFromModelName(portable.modelName), sourcePresent: false, variants: [] };
    const pointed = saved.get(model.currentGenerationId);
    const current = pointed?.outputPath ? pointed : saved.get(model.latestReadyGenerationId);
    const localResult = current?.outputHash && current.reviewStatus !== 'rejected';
    const oldMemory = memory.items[portable.sourceId];
    const preserveLocal = Boolean((localResult && current.generationId !== id && !current.importedAt)
      || (oldMemory?.outputHash && oldMemory.outputHash !== portable.outputHash && oldMemory.statusSource !== 'results-import'));
    const preserveReady = Boolean(current?.status === 'READY' && !facts && current.generationId !== id);
    const ignored = Boolean(nextHistory.ignored[portable.sourceId] || memory.items[portable.sourceId]?.reviewStatus === 'rejected');
    if (!preserveLocal && !preserveReady && !ignored) {
      const entries = QUEUE_GROUP_IDS.flatMap((groupId) => nextQueue.groups?.[groupId] || []);
      const local = entries.find((entry) => entry.sourceId === portable.sourceId);
      const localVariant = model.variants?.find((variant) => variant.sourceVariantId === portable.sourceVariantId);
      const input = localVariant || local;
      const incompatible = Boolean(input?.sourceHash && portable.sourceHash
        && String(input.sourceHash).toLowerCase() !== String(portable.sourceHash).toLowerCase());
      if (incompatible) incompatibleInputs += 1;
      model.currentGenerationId = id;
      model.latestReadyGenerationId = facts ? id : null;
      model.currentOutputPath = revision.outputPath;
      model.currentOutputHash = revision.outputHash;
      model.generationStatus = revision.status;
      if (!incompatible) {
        const base = { ...portable, ...pick(input, ['sourceVariantId', 'groupId', 'relativePath', 'fileName', 'fingerprint', 'sourceHash']), sourceId: portable.sourceId,
          generationId: id, outputPath: revision.outputPath, outputHash: revision.outputHash,
          outputFileName: revision.outputFileName, generatedAt: portable.generatedAt || portable.completedAt || now };
        memory.items[portable.sourceId] = generationMemoryRecordFromEntry(base, { status: facts ? 'ready' : 'image_saved',
          statusSource: 'results-import', sourcePresent: Boolean(local), generatedAt: base.generatedAt,
          verificationMode: revision.verificationMode, createdAt: memory.items[portable.sourceId]?.createdAt || now });
        nextHistory.items[portable.sourceId] = historyRecordFromEntry(base);
        delete nextHistory.ignored[portable.sourceId];
        model.queueState = { ...(model.queueState || {}), status: 'done', generationId: id, lastError: null };
        model.variants = (model.variants || []).map((variant) => variant.sourceVariantId === base.sourceVariantId
          ? { ...variant, status: 'done', generationId: id, outputPath: revision.outputPath,
            outputHash: revision.outputHash, factsStatus: revision.factsStatus, lastError: null } : variant);
        adopted.add(portable.sourceId);
      }
      model.updatedAt = now;
      models.set(portable.sourceId, model);
      modelChanges.set(portable.sourceId, model);
    } else if (current?.generationId === id) {
      model.currentOutputPath = revision.outputPath;
      modelChanges.set(portable.sourceId, model);
    }
  }
  applyGenerationHistory(nextQueue.groups || {}, nextHistory);
  applyGenerationMemory(nextQueue.groups || {}, memory);
  return { revisions: [...changes.values()], models: [...modelChanges.values()], queue: nextQueue,
    history: nextHistory, generationMemory: memory,
    summary: { ...preview, adoptedModels: adopted.size, incompatibleInputs } };
}
