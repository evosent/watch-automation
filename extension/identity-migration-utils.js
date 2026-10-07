import { canonicalBrandIdentityId, modelCodeFromName, normalizeBrandId, normalizeSkuCode, skuKeyForModelName } from './sku-utils.js';

export const IDENTITY_MIGRATION_VERSION = 1;

const IGNORED_SOURCE_PREFIXES = new Set(['generic', 'legacy', 'unknown', 'import']);
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)$/i;
const LOOKALIKE_TRANSLATION = Object.freeze({
  '\u0430': 'a', '\u0432': 'v', '\u0441': 'c', '\u0435': 'e', '\u043d': 'h',
  '\u043a': 'k', '\u043c': 'm', '\u043e': 'o', '\u0440': 'p', '\u0442': 't',
  '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0458': 'j'
});

function text(value) {
  return String(value ?? '').trim();
}

function normalizeEvidenceBrand(value) {
  const normalized = text(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^q\s*&\s*q$|^q\s+and\s+q$/.test(normalized)) return canonicalBrandIdentityId('q_and_q');
  return canonicalBrandIdentityId(normalized);
}

function legacyModelCodeFromName(value) {
  const name = String(value || '').replace(/\.[^.]+$/, '').normalize('NFKC');
  const normalized = name.replace(/[\u0430\u0432\u0441\u0435\u043d\u043a\u043c\u043e\u0440\u0442\u0445\u0443\u0456\u0458]/gi, (char) => {
    const lower = char.toLowerCase();
    const replacement = LOOKALIKE_TRANSLATION[lower];
    return replacement ? (char === lower ? replacement : replacement.toUpperCase()) : char;
  });
  const matches = normalized.match(/(?:^|[^A-Z0-9])(?=[A-Z0-9.-]*[A-Z])(?=[A-Z0-9.-]*\d)[A-Z0-9]+(?:[.-][A-Z0-9]+)*(?=$|[^A-Z0-9])/gi) || [];
  for (const match of matches) {
    const code = normalizeSkuCode(match);
    if (code.length >= 4 && /[A-Z]/.test(code) && /\d/.test(code)) return code;
  }
  return null;
}

// This reproduces the former SKU derivation only to validate version-1
// archives. It must never be used to choose a live catalog identity.
export function legacySkuKeyForArchiveModelName(modelName, brandId = 'generic') {
  const brand = normalizeBrandId(brandId);
  const code = legacyModelCodeFromName(modelName);
  if (code) return `${brand}:${code}`;
  return skuKeyForModelName(modelName, brand);
}

function brandFromSourceId(sourceId) {
  const value = text(sourceId);
  const separator = value.indexOf(':');
  if (separator <= 0) return '';
  const prefix = normalizeBrandId(value.slice(0, separator));
  return IGNORED_SOURCE_PREFIXES.has(prefix) ? '' : prefix;
}

function evidenceBrandValues(record, sourceId) {
  const values = [];
  for (const [field, raw] of [
    ['profileId', record?.profileId],
    ['brandId', record?.brandId],
    ['titleBrand', record?.titleBrand],
    ['expectedTitleBrand', record?.expectedTitleBrand]
  ]) {
    const value = text(raw);
    if (value) values.push({ field, value, brandId: normalizeEvidenceBrand(value) });
  }
  const idBrand = brandFromSourceId(sourceId);
  if (idBrand) values.push({ field: 'sourceId.prefix', value: idBrand, brandId: idBrand });
  return values;
}

function addCodeEvidence(target, field, rawValue, strict = false) {
  const value = text(rawValue);
  if (!value) return;
  const code = modelCodeFromName(value);
  if (!code) {
    if (strict) target.unparsed.push({ field, value });
    return;
  }
  target.codes.push({ field, value, code });
}

function filenameEvidenceValue(rawValue) {
  const value = text(rawValue);
  return value ? value.split(/[\\/]/).at(-1) || value : '';
}

function sourceVariantFilename(rawValue) {
  const value = text(rawValue);
  if (!value) return '';
  const asset = value.includes('|') ? value.slice(value.lastIndexOf('|') + 1) : value;
  // sourceVariantId is an opaque key in some fixtures and integrations. Only
  // treat it as product evidence when it visibly contains an asset path/name.
  if (!/[\\/]/.test(asset) && !IMAGE_EXTENSION.test(asset)) return '';
  return filenameEvidenceValue(asset);
}

function collectRecordEvidence(record, sourceId, linkedFacts = []) {
  const result = { codes: [], brands: [], unparsed: [] };
  const ownFacts = record?.facts && typeof record.facts === 'object' ? record.facts : null;
  const sources = [record, ownFacts, ...linkedFacts].filter(Boolean);
  for (const item of sources) {
    for (const field of ['titleModel', 'expectedTitleModel']) addCodeEvidence(result, field, item[field], true);
    for (const field of ['modelName', 'fileName']) addCodeEvidence(result, field, item[field]);
    for (const field of ['outputFileName', 'inputPath', 'relativePath']) {
      addCodeEvidence(result, field, filenameEvidenceValue(item[field]));
    }
    addCodeEvidence(result, 'sourceVariantId', sourceVariantFilename(item.sourceVariantId));
    result.brands.push(...evidenceBrandValues(item, sourceId));
  }
  const codes = [...new Set(result.codes.map((item) => item.code))];
  const brands = [...new Set(result.brands.map((item) => item.brandId))];
  let reason = null;
  if (result.unparsed.length) reason = 'unparseable-explicit-model-code';
  else if (codes.length > 1) reason = 'conflicting-model-code-evidence';
  else if (brands.length > 1) reason = 'conflicting-brand-evidence';
  else if (!codes.length) reason = 'missing-model-code-evidence';
  else if (!brands.length) reason = 'missing-brand-evidence';
  const brandId = brands[0] || '';
  const modelCode = codes[0] || '';
  return {
    sourceId,
    targetSourceId: reason ? null : `${brandId}:${modelCode}`,
    modelCode: modelCode || null,
    brandId: brandId || null,
    reason,
    evidence: result.codes,
    brandEvidence: result.brands,
    unparsed: result.unparsed
  };
}

function quarantine(recordType, record, sourceId, identity, extra = {}) {
  return {
    recordType,
    generationId: record?.generationId || null,
    fromSourceId: sourceId || null,
    outputHash: record?.outputHash || null,
    reason: identity.reason || 'ambiguous-identity',
    evidence: identity.evidence || [],
    brandEvidence: identity.brandEvidence || [],
    unparsed: identity.unparsed || [],
    ...extra
  };
}

function revisionSourceId(revision) {
  const sourceId = text(revision?.sourceId);
  const skuKey = text(revision?.skuKey);
  if (sourceId && skuKey && sourceId !== skuKey) return null;
  return sourceId || skuKey;
}

export function identityVariantKey(variant) {
  return text(variant?.sourceVariantId)
    || text(variant?.variantId)
    || text(variant?.assetKey)
    || text(variant?.sourceId)
    || [text(variant?.groupId), text(variant?.relativePath || variant?.fileName)].filter(Boolean).join('|');
}

function factsForRevision(revision, factsByGenerationId) {
  return factsByGenerationId.get(text(revision?.generationId)) || [];
}

function stableMembership(row, variant, key, membershipBySourceId, membershipByVariantKey) {
  const explicit = variant?.identityMembership || variant?.partMembership || variant?.queueMembership
    || row?.identityMembership || row?.partMembership || row?.queueMembership
    || membershipByVariantKey?.[key] || membershipBySourceId?.[text(row?.sourceId || row?.skuKey)];
  return {
    groupId: text(variant?.groupId || row?.groupId) || null,
    partitionOrderKey: text(variant?.partitionOrderKey || row?.partitionOrderKey
      || explicit?.partitionOrderKey || row?.sourceId || row?.skuKey) || null,
    partId: text(variant?.partId || row?.partId || explicit?.partId) || null,
    partIndex: Number.isInteger(variant?.partIndex) ? variant.partIndex
      : (Number.isInteger(row?.partIndex) ? row.partIndex : (Number.isInteger(explicit?.partIndex) ? explicit.partIndex : null)),
    membershipKey: text(variant?.membershipKey || row?.membershipKey || explicit?.membershipKey) || null,
    explicit: explicit ? structuredClone(explicit) : null
  };
}

/**
 * Build a conservative, read-only identity migration plan.
 *
 * Identity decisions are made for each generation revision and source variant
 * from that record's own model code and brand evidence. A historical
 * sourceId is treated as a locator only; it never forces unrelated revisions
 * into one destination SKU.
 */
export function buildIdentityMigrationPlan({ catalogRows = [], revisions = [], factsRows = [],
  membershipBySourceId = {}, membershipByVariantKey = {} } = {}) {
  const factsByGenerationId = new Map();
  const factsWithoutGenerationId = [];
  for (const facts of factsRows || []) {
    const generationId = text(facts?.generationId);
    if (!generationId) {
      factsWithoutGenerationId.push(facts);
      continue;
    }
    const list = factsByGenerationId.get(generationId) || [];
    list.push(facts);
    factsByGenerationId.set(generationId, list);
  }

  const quarantined = [];
  const revisionMoves = [];
  const unchangedRevisions = [];
  const revisionsByGenerationId = new Map();
  for (const revision of revisions || []) {
    const generationId = text(revision?.generationId);
    if (!generationId) {
      quarantined.push(quarantine('revision', revision, revisionSourceId(revision), {
        reason: 'missing-generation-id', evidence: [], brandEvidence: [], unparsed: []
      }));
      continue;
    }
    const matches = revisionsByGenerationId.get(generationId) || [];
    matches.push(revision);
    revisionsByGenerationId.set(generationId, matches);
  }

  for (const [generationId, matches] of revisionsByGenerationId) {
    if (matches.length !== 1) {
      for (const revision of matches) {
        quarantined.push(quarantine('revision', revision, revisionSourceId(revision), {
          reason: 'duplicate-generation-id', evidence: [], brandEvidence: [], unparsed: []
        }));
      }
      continue;
    }
    const revision = matches[0];
    const sourceId = revisionSourceId(revision);
    if (!sourceId) {
      quarantined.push(quarantine('revision', revision, null, {
        reason: 'conflicting-source-id-and-sku-key', evidence: [], brandEvidence: [], unparsed: []
      }));
      continue;
    }
    const linkedFacts = factsForRevision(revision, factsByGenerationId);
    const mismatchedFacts = linkedFacts.filter((facts) => text(facts.sourceId) && text(facts.sourceId) !== sourceId);
    const identity = collectRecordEvidence(revision, sourceId, linkedFacts);
    if (mismatchedFacts.length) identity.reason = 'facts-source-id-mismatch';
    if (identity.reason) {
      quarantined.push(quarantine('revision', revision, sourceId, identity, {
        mismatchedFacts: mismatchedFacts.map((facts) => ({ sourceId: facts.sourceId, generationId: facts.generationId }))
      }));
      continue;
    }
    if (identity.targetSourceId === sourceId) {
      unchangedRevisions.push({ generationId, sourceId, outputHash: revision.outputHash || null });
      continue;
    }
    revisionMoves.push({
      generationId,
      fromSourceId: sourceId,
      toSourceId: identity.targetSourceId,
      skuKey: identity.targetSourceId,
      originSourceId: sourceId,
      outputHash: revision.outputHash || null,
      sourceVariantId: revision.sourceVariantId || null,
      modelName: revision.modelName || revision.fileName || null,
      brandId: identity.brandId,
      modelCode: identity.modelCode,
      evidence: identity.evidence
    });
  }

  const catalogAssignments = [];
  for (const row of catalogRows || []) {
    const sourceId = text(row?.sourceId || row?.skuKey);
    if (!sourceId || (text(row?.sourceId) && text(row?.skuKey) && text(row.sourceId) !== text(row.skuKey))) {
      quarantined.push(quarantine('catalog', row, sourceId || null, {
        reason: 'conflicting-catalog-source-id-and-sku-key', evidence: [], brandEvidence: [], unparsed: []
      }));
      continue;
    }
    const variants = Array.isArray(row?.variants) ? row.variants : [];
    if (!variants.length) {
      const identity = collectRecordEvidence(row, sourceId);
      if (identity.reason) {
        quarantined.push(quarantine('catalog', row, sourceId, identity));
      } else if (identity.targetSourceId !== sourceId) {
        catalogAssignments.push({
          fromSourceId: sourceId,
          toSourceId: identity.targetSourceId,
          originSourceId: sourceId,
          partitionOrderKey: row.partitionOrderKey || sourceId,
          brandId: identity.brandId,
          modelName: row.modelName || null,
          variantKeys: [],
          membership: stableMembership(row, null, '', membershipBySourceId, membershipByVariantKey),
          sourcePresent: Boolean(row.sourcePresent)
        });
      }
      continue;
    }

    const groups = new Map();
    let rowAmbiguous = false;
    for (const variant of variants) {
      const identity = collectRecordEvidence(variant, sourceId);
      const key = identityVariantKey(variant);
      if (identity.reason || !key) {
        rowAmbiguous = true;
        quarantined.push(quarantine('catalog-variant', variant, sourceId, {
          ...identity,
          reason: identity.reason || 'missing-stable-variant-key'
        }, { variantKey: key || null }));
        continue;
      }
      const group = groups.get(identity.targetSourceId) || {
        fromSourceId: sourceId,
        toSourceId: identity.targetSourceId,
        originSourceId: sourceId,
        partitionOrderKey: variant.partitionOrderKey || row.partitionOrderKey || sourceId,
        brandId: identity.brandId,
        modelName: variant.modelName || variant.fileName || row.modelName || null,
        variantKeys: [],
        membership: stableMembership(row, variant, key, membershipBySourceId, membershipByVariantKey),
        sourcePresent: Boolean(row.sourcePresent)
      };
      group.variantKeys.push(key);
      groups.set(identity.targetSourceId, group);
    }
    if (rowAmbiguous) {
      quarantined.push(quarantine('catalog', row, sourceId, {
        reason: 'contains-ambiguous-variant-identity', evidence: [], brandEvidence: [], unparsed: []
      }, { variantsQuarantined: true }));
      continue;
    }
    if (groups.size > 1 || (groups.size === 1 && !groups.has(sourceId))) {
      const rowIdentity = collectRecordEvidence(row, sourceId);
      const primaryTarget = groups.has(rowIdentity.targetSourceId)
        ? rowIdentity.targetSourceId
        : [...groups.keys()].sort()[0];
      for (const [targetSourceId, group] of groups) {
        const orderKey = targetSourceId === primaryTarget
          ? (row.partitionOrderKey || sourceId)
          : `~identity-split:${sourceId}:${targetSourceId}`;
        group.partitionOrderKey = orderKey;
        group.membership = { ...group.membership, partitionOrderKey: orderKey };
      }
      catalogAssignments.push(...groups.values());
    }
  }

  const movedRevisionKeys = new Set(revisionMoves.map((move) => `${move.generationId}\u0000${move.fromSourceId}`));
  const duplicateFactsGenerationIds = new Set();
  for (const [generationId, list] of factsByGenerationId) {
    if (list.length > 1) duplicateFactsGenerationIds.add(generationId);
  }
  const movedOrQuarantinedSources = new Set([
    ...revisionMoves.map((move) => move.fromSourceId),
    ...catalogAssignments.map((assignment) => assignment.fromSourceId),
    ...quarantined.map((entry) => entry.fromSourceId).filter(Boolean)
  ]);
  for (const facts of factsWithoutGenerationId) {
    if (!movedOrQuarantinedSources.has(text(facts?.sourceId))) continue;
    quarantined.push(quarantine('facts', facts, facts.sourceId, {
      reason: 'facts-without-generation-id', evidence: [], brandEvidence: [], unparsed: []
    }));
  }
  for (const [generationId, list] of factsByGenerationId) {
    if (duplicateFactsGenerationIds.has(generationId)) {
      for (const facts of list) {
        quarantined.push(quarantine('facts', facts, facts.sourceId, {
          reason: 'duplicate-facts-generation-id', evidence: [], brandEvidence: [], unparsed: []
        }));
      }
      continue;
    }
    const facts = list[0];
    const key = `${generationId}\u0000${text(facts.sourceId)}`;
    if (!movedOrQuarantinedSources.has(text(facts.sourceId)) || movedRevisionKeys.has(key)) continue;
    if (!revisionsByGenerationId.has(generationId)) {
      quarantined.push(quarantine('facts', facts, facts.sourceId, {
        reason: 'facts-without-matching-revision', evidence: [], brandEvidence: [], unparsed: []
      }));
    }
  }

  revisionMoves.sort((a, b) => a.generationId.localeCompare(b.generationId));
  catalogAssignments.sort((a, b) => `${a.fromSourceId}\u0000${a.toSourceId}`.localeCompare(`${b.fromSourceId}\u0000${b.toSourceId}`));
  quarantined.sort((a, b) => `${a.recordType}\u0000${a.generationId || ''}\u0000${a.fromSourceId || ''}`.localeCompare(`${b.recordType}\u0000${b.generationId || ''}\u0000${b.fromSourceId || ''}`));

  return {
    version: IDENTITY_MIGRATION_VERSION,
    revisionMoves,
    catalogAssignments,
    unchangedRevisions,
    quarantined,
    counts: {
      revisionMoves: revisionMoves.length,
      catalogAssignments: catalogAssignments.length,
      unchangedRevisions: unchangedRevisions.length,
      quarantined: quarantined.length
    }
  };
}
