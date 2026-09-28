(() => {
  const FACTS_SCALAR_KEYS = Object.freeze([
    'titleBrand',
    'titleSeries',
    'titleModel',
    'utp1',
    'utp2',
    'waterResistance',
    'caseSize'
  ]);
  const FACTS_REQUIRED_KEYS = Object.freeze([...FACTS_SCALAR_KEYS, 'uncertain']);

  function stripOuterFence(rawText) {
    return String(rawText || '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  function objectCandidate(rawText) {
    const raw = String(rawText || '').trim();
    const unfenced = stripOuterFence(raw);
    const first = unfenced.indexOf('{');
    const last = unfenced.lastIndexOf('}');
    return {
      raw,
      unfenced,
      first,
      last,
      hasClosingBrace: first >= 0 && last > first,
      candidate: first >= 0 && last > first ? unfenced.slice(first, last + 1) : unfenced
    };
  }

  function normalizeJsonTypography(text) {
    return String(text || '')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');
  }

  function recoverKnownFields(candidate) {
    const parsed = {};
    for (const key of FACTS_SCALAR_KEYS) {
      const expression = new RegExp(String.raw`["“]?${key}["”]?\s*:\s*(null|["“]([\s\S]*?)["”])(?=\s*[,}\n]|$)`, 'i');
      const match = String(candidate || '').match(expression);
      if (!match) continue;
      parsed[key] = /^null$/i.test(match[1]) ? null : String(match[2] || '').trim();
    }

    const uncertainKeyPresent = /["“]?uncertain["”]?\s*:/i.test(String(candidate || ''));
    const uncertainMatch = String(candidate || '').match(/["“]?uncertain["”]?\s*:\s*\[([\s\S]*?)\]/i);
    if (uncertainMatch) {
      parsed.uncertain = [...uncertainMatch[1].matchAll(/["“]([\s\S]*?)["”]/g)]
        .map((item) => item[1].trim())
        .filter(Boolean);
    } else if (uncertainKeyPresent) {
      // Keep the key present so callers can distinguish a malformed final
      // uncertain value from a response that has not streamed this field yet.
      parsed.uncertain = [];
    }
    return parsed;
  }

  function missingRequiredKeys(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [...FACTS_REQUIRED_KEYS];
    return FACTS_REQUIRED_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  }

  function makeFactsError(code, message, raw, extra = {}) {
    const error = new Error(message);
    error.code = code;
    error.responseText = String(raw || '').slice(0, 12000);
    Object.assign(error, extra);
    return error;
  }

  function parseExtractionJson(rawText) {
    const parts = objectCandidate(rawText);
    const attempts = [parts.candidate, normalizeJsonTypography(parts.candidate)];

    for (const attempt of attempts) {
      try {
        const parsed = JSON.parse(attempt);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const missing = missingRequiredKeys(parsed);
        if (!missing.length) return { parsed, raw: parts.raw, recovered: false };
        throw makeFactsError(
          'FACTS_JSON_INCOMPLETE',
          `FACTS_JSON_INCOMPLETE: отсутствуют обязательные поля: ${missing.join(', ')}`,
          parts.raw,
          { missingKeys: missing }
        );
      } catch (error) {
        if (error?.code === 'FACTS_JSON_INCOMPLETE') throw error;
      }
    }

    const recovered = recoverKnownFields(parts.candidate);
    const recoveredKeys = FACTS_REQUIRED_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(recovered, key));
    const missing = missingRequiredKeys(recovered);
    if (!missing.length) return { parsed: recovered, raw: parts.raw, recovered: true };

    if (recoveredKeys.length) {
      throw makeFactsError(
        'FACTS_JSON_INCOMPLETE',
        `FACTS_JSON_INCOMPLETE: получен только фрагмент ответа; отсутствуют поля: ${missing.join(', ')}`,
        parts.raw,
        { missingKeys: missing, recoveredKeys }
      );
    }

    throw makeFactsError(
      'FACTS_JSON_PARSE',
      'FACTS_JSON_PARSE: ответ не удалось разобрать как полный JSON постпроверки',
      parts.raw
    );
  }

  function isCompleteFactsResponse(rawText) {
    const parts = objectCandidate(rawText);
    if (!parts.hasClosingBrace) return false;
    try {
      parseExtractionJson(parts.raw);
      return true;
    } catch (_) {
      return false;
    }
  }

  function findCompleteFactsResponse(candidates = []) {
    for (const candidate of candidates || []) {
      const text = String(candidate || '').trim();
      if (text && isCompleteFactsResponse(text)) return text;
    }
    return null;
  }

  globalThis.WatchFactsUtils = Object.freeze({
    FACTS_SCALAR_KEYS,
    FACTS_REQUIRED_KEYS,
    objectCandidate,
    normalizeJsonTypography,
    recoverKnownFields,
    missingRequiredKeys,
    parseExtractionJson,
    isCompleteFactsResponse,
    findCompleteFactsResponse
  });
})();
