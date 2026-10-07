const LOOKALIKE_TRANSLATION = Object.freeze({
  '\u0430': 'a', '\u0432': 'b', '\u0441': 'c', '\u0435': 'e', '\u043d': 'h',
  '\u043a': 'k', '\u043c': 'm', '\u043e': 'o', '\u0440': 'p', '\u0442': 't',
  '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0458': 'j'
});

const IMAGE_FILE_EXTENSION = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif)$/i;

function stripImageFileExtension(value) {
  return String(value || '').replace(IMAGE_FILE_EXTENSION, '');
}

export function normalizeSkuCode(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0430\u0432\u0441\u0435\u043d\u043a\u043c\u043e\u0440\u0442\u0445\u0443\u0456\u0458]/g, (char) => LOOKALIKE_TRANSLATION[char] || char)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function modelCodeFromName(value) {
  // Model references may contain dots as meaningful suffix separators
  // (for example Tissot T006.207.11.058.00). Strip image extensions only.
  const name = stripImageFileExtension(value).normalize('NFKC');
  const normalized = name.replace(/[\u0430\u0432\u0441\u0435\u043d\u043a\u043c\u043e\u0440\u0442\u0445\u0443\u0456\u0458]/gi, (char) => {
    const lower = char.toLowerCase();
    const replacement = LOOKALIKE_TRANSLATION[lower];
    return replacement ? (char === lower ? replacement : replacement.toUpperCase()) : char;
  });
  const matches = normalized.match(/(?:^|[^A-Z0-9])(?=[A-Z0-9.-]*[A-Z])(?=[A-Z0-9.-]*\d)[A-Z0-9]+(?:[.-][A-Z0-9]+)*(?=$|[^A-Z0-9])/gi) || [];
  for (const match of matches) {
    const code = normalizeSkuCode(match);
    // Ordinal labels such as "50th anniversary" often appear before the
    // actual watch reference (for example, "CASIOTRON 50th TRN-50SS-2A").
    // They are descriptive text, not product codes.
    if (/^\d+(?:ST|ND|RD|TH)$/i.test(String(match).replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, ''))) continue;
    if (code.length >= 4 && /[A-Z]/.test(code) && /\d/.test(code)) return code;
  }
  return null;
}

export function normalizeBrandId(brandId = 'generic') {
  return String(brandId || 'generic')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'generic';
}

// Exact, reviewed aliases for brand labels found in model names and OCR facts.
// Keep normalizeBrandId() stable because its output is also used in persisted
// SKU/source IDs; use this helper only when comparing brand identity evidence.
const BRAND_IDENTITY_ALIASES = Object.freeze({
  pagani: 'pagani_design',
  q_q: 'q_and_q'
});

export function canonicalBrandIdentityId(brandId = 'generic') {
  const normalized = normalizeBrandId(brandId);
  return BRAND_IDENTITY_ALIASES[normalized] || normalized;
}

export function skuKeyForModelName(modelName, brandId = 'generic') {
  const brand = normalizeBrandId(brandId);
  const code = modelCodeFromName(modelName);
  if (code) return `${brand}:${code}`;
  const normalizedName = stripImageFileExtension(modelName)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0430\u0432\u0441\u0435\u043d\u043a\u043c\u043e\u0440\u0442\u0445\u0443\u0456\u0458]/g, (char) => LOOKALIKE_TRANSLATION[char] || char)
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_');
  return `${brand}:name:${normalizedName || 'unknown'}`;
}
