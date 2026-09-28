const LOOKALIKE_TRANSLATION = Object.freeze({
  '\u0430': 'a', '\u0432': 'b', '\u0441': 'c', '\u0435': 'e', '\u043d': 'h',
  '\u043a': 'k', '\u043c': 'm', '\u043e': 'o', '\u0440': 'p', '\u0442': 't',
  '\u0445': 'x', '\u0443': 'y', '\u0456': 'i', '\u0458': 'j'
});

export function normalizeSkuCode(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0430\u0432\u0441\u0435\u043d\u043a\u043c\u043e\u0440\u0442\u0445\u0443\u0456\u0458]/g, (char) => LOOKALIKE_TRANSLATION[char] || char)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function modelCodeFromName(value) {
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

export function skuKeyForModelName(modelName, brandId = 'generic') {
  const brand = String(brandId || 'generic').normalize('NFKC').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'generic';
  const code = modelCodeFromName(modelName);
  if (code) return `${brand}:${code}`;
  const normalizedName = String(modelName || '')
    .replace(/\.[^.]+$/, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0430\u0432\u0441\u0435\u043d\u043a\u043c\u043e\u0440\u0442\u0445\u0443\u0456\u0458]/g, (char) => LOOKALIKE_TRANSLATION[char] || char)
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_');
  return `${brand}:name:${normalizedName || 'unknown'}`;
}
