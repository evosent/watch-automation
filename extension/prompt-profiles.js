import { buildInputPlan, renderReferenceAwareText } from './input-plan.js';

const MODEL_PLACEHOLDERS = Object.freeze([
  '[вставь нужную модель часов]',
  '{{MODEL_NAME}}'
]);

// Model codes vary considerably between brands. These two overlapping
// tokenisers cover contiguous codes (BY-S001-177-MD, L4.320.2.11.7) and the
// occasional spaced form (GA 2100 1A1). A look-ahead keeps candidates that
// begin after a collection/series prefix such as "G-SHOCK-" or "PRX ".
// The final extension is removed before matching so a filename can be passed
// directly.
const WATCH_REFERENCE_PATTERNS = Object.freeze([
  /(?=(\b[A-Z]{1,5}(?=[A-Z0-9.\-]*\d)[A-Z0-9]*(?:[-.][A-Z0-9]+){0,6}\b))/gi,
  /(?=(\b[A-Z]{1,5}(?=[A-Z0-9.\-\s]*\d)(?:[-.\s]+[A-Z0-9]+){1,6}\b))/gi
]);
const REFERENCE_NON_CODES = Object.freeze([
  /^SERIES[-\s]?\d+$/i,
  /^MODEL[-\s]?\d+$/i,
  /^TYPE[-\s]?\d+$/i,
  /^EDITION[-\s]?\d+$/i,
  /^VERSION[-\s]?\d+$/i
]);
const REFERENCE_BRAND_PREFIXES = new Set([
  'ARMANI', 'BENYAR', 'CASIO', 'CERTINA', 'CITIZEN', 'DESIGN', 'DIESEL',
  'EXCHANGE', 'LONGINES', 'ORIENT', 'PAGANI', 'Q', 'SEIKO', 'TISSOT'
]);
const REFERENCE_PREFIX_STOPWORDS = new Set([
  'BABY', 'CASIOTRON', 'CLASSIC', 'COLLECTION', 'DIGITAL', 'DS', 'DREAM',
  'EDIFICE', 'EVERYTIME', 'GENT', 'LADY', 'LOVELY', 'MASTER', 'PR', 'PRX',
  'PRO', 'SERIES', 'SHEEN', 'SPORT', 'STAR', 'TREK', 'VINTAGE'
]);

const LOOKALIKE_CHARACTERS = Object.freeze({
  а: 'a', с: 'c', е: 'e', о: 'o', р: 'p', х: 'x', у: 'y', і: 'i', ј: 'j',
  А: 'A', С: 'C', Е: 'E', О: 'O', Р: 'P', Х: 'X', У: 'Y', І: 'I', Ј: 'J'
});

function normalizeModelName(modelName) {
  return String(modelName || '').replace(/\s+/g, ' ').trim();
}

function matchingModelName(modelName) {
  return [...normalizeModelName(modelName)]
    .map((character) => LOOKALIKE_CHARACTERS[character] || character)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function alias(name, pattern) {
  return Object.freeze({ name, pattern });
}

function titleLayoutFor(profile, brandLines, seriesPolicy = null) {
  const metadata = BRAND_PROFILE_META[profile] || BRAND_PROFILE_META.generic;
  const policy = seriesPolicy || (metadata.seriesRequired === true
    ? 'required'
    : (metadata.series || []).length ? 'optional' : 'forbidden');
  return Object.freeze({
    version: 1,
    brandLines: Object.freeze([...brandLines]),
    brandLineCount: brandLines.length,
    seriesPolicy: policy
  });
}

// This is a controlled vocabulary. The filename resolver below only handles
// literal hints already present in the source filename. During generation the
// model may discover a series online, but it must map that result to this
// closed vocabulary before it can use the name in the card.
const BRAND_PROFILE_META = Object.freeze({
  casio: Object.freeze({
    displayName: 'Casio',
    promptPath: 'prompts/brands/casio.txt',
    fallbackSeries: 'Classic',
    seriesRequired: true,
    series: Object.freeze([
      'Classic', 'G-SHOCK', 'BABY-G', 'EDIFICE', 'PRO TREK', 'OCEANUS', 'SHEEN',
      'VINTAGE', 'COLLECTION', 'CASIOTRON', 'MR-G', 'MT-G', 'G-STEEL',
      'MASTER OF G', 'G-SHOCK MOVE', 'G-MS', 'G-LIDE', 'LINEAGE', 'DATA BANK'
    ]),
    aliases: Object.freeze([
      alias('CASIOTRON', /\bcasiotron\b/i),
      // The brand occupies line 1. Keep only the printable series token on
      // line 2 so Casio Vintage/Collection cannot become “Casio Casio …”.
      alias('VINTAGE', /\bcasio\s+vintage\b|\bvintage\b/i),
      alias('COLLECTION', /\bcasio\s+collection\b|\bcollection\b/i),
      alias('BABY-G', /\bbaby[-\s]?g\b/i),
      alias('G-SHOCK', /\bg[-\s]?shock\b/i),
      alias('PRO TREK', /\bpro\s+trek\b/i),
      alias('EDIFICE', /\bedifice\b/i),
      alias('OCEANUS', /\boceanus\b/i),
      alias('SHEEN', /\bsheen\b/i),
      alias('MASTER OF G', /\bmaster\s+of\s+g\b/i),
      alias('G-SHOCK MOVE', /\bg[-\s]?shock\s+move\b/i),
      alias('G-STEEL', /\bg[-\s]?steel\b/i),
      alias('MR-G', /\bmr[-\s]?g\b/i),
      alias('MT-G', /\bmt[-\s]?g\b/i),
      alias('G-MS', /\bg[-\s]?ms\b/i),
      alias('G-LIDE', /\bg[-\s]?lide\b/i),
      alias('LINEAGE', /\blineage\b/i),
      alias('DATA BANK', /\bdata\s+bank\b/i)
    ])
  }),
  orient: Object.freeze({
    displayName: 'Orient',
    promptPath: 'prompts/brands/orient.txt',
    fallbackSeries: null,
    seriesRequired: false,
    series: Object.freeze([]),
    aliases: Object.freeze([])
  }),
  tissot: Object.freeze({
    displayName: 'Tissot',
    promptPath: 'prompts/brands/tissot.txt',
    fallbackSeries: null,
    seriesRequired: false,
    series: Object.freeze([]),
    aliases: Object.freeze([])
  }),
  pagani_design: Object.freeze({
    displayName: 'Pagani Design',
    promptPath: 'prompts/brands/pagani-design.txt',
    fallbackSeries: null,
    // Pagani Design uses two fixed brand lines followed by a smaller model
    // line. Product category words and homage references are excluded, and
    // this profile deliberately has no series vocabulary.
    series: Object.freeze([]),
    aliases: Object.freeze([])
  }),
  benyar: Object.freeze({
    displayName: 'Benyar',
    promptPath: 'prompts/brands/benyar.txt',
    fallbackSeries: null,
    seriesRequired: false,
    series: Object.freeze([]),
    aliases: Object.freeze([])
  }),
  q_and_q: Object.freeze({
    displayName: 'Q&Q',
    promptPath: 'prompts/brands/q-and-q.txt',
    fallbackSeries: null,
    seriesRequired: false,
    series: Object.freeze([]),
    aliases: Object.freeze([])
  }),
  seiko: Object.freeze({
    displayName: 'Seiko',
    promptPath: 'prompts/brands/seiko.txt',
    fallbackSeries: null,
    seriesRequired: false,
    series: Object.freeze([]),
    aliases: Object.freeze([])
  }),
  citizen: Object.freeze({
    displayName: 'Citizen',
    promptPath: 'prompts/brands/citizen.txt',
    fallbackSeries: null,
    seriesRequired: false,
    series: Object.freeze([]),
    aliases: Object.freeze([])
  }),
  longines: Object.freeze({
    displayName: 'Longines',
    promptPath: 'prompts/brands/longines.txt',
    fallbackSeries: null,
    seriesRequired: false,
    series: Object.freeze([]),
    aliases: Object.freeze([])
  }),
  diesel: Object.freeze({
    displayName: 'Diesel',
    promptPath: 'prompts/brands/diesel.txt',
    fallbackSeries: null,
    series: Object.freeze([
      'Mega Chief', 'Mr. Daddy', 'Griffed', 'Overflow', 'Double Down', 'Rasp',
      'Little Daddy', 'Mini Daddy', 'Scraper', 'Stinger', 'Spiked', 'Mercurial', 'Vert',
      'Closer', 'D-Era', 'D-Curve', 'Streamline', 'Framed', 'Armbar', 'Metamorph'
    ]),
    aliases: Object.freeze([
      alias('Mega Chief', /\bmega\s+chief\b/i),
      alias('Mr. Daddy', /\bmr\.?\s+daddy\b/i),
      alias('Little Daddy', /\blittle\s+daddy\b/i),
      alias('Mini Daddy', /\bmini\s+daddy\b/i),
      alias('Double Down', /\bdouble\s+down\b/i),
      alias('Griffed', /\bgriffed\b/i),
      alias('Overflow', /\boverflow\b/i),
      alias('Scraper', /\bscraper\b/i),
      alias('Rasp', /\brasp\b/i),
      alias('Stinger', /\bstinger\b/i),
      alias('Spiked', /\bspiked\b/i),
      alias('Mercurial', /\bmercurial\b/i),
      alias('Vert', /\bvert\b/i),
      alias('Closer', /\bcloser\b/i),
      alias('D-Era', /\bd[-\s]?era\b/i),
      alias('D-Curve', /\bd[-\s]?curve\b/i),
      alias('Streamline', /\bstreamline\b/i),
      alias('Framed', /\bframed\b/i),
      alias('Armbar', /\barmbar\b/i),
      alias('Metamorph', /\bmetamorph\b/i)
    ])
  }),
  armani_exchange: Object.freeze({
    displayName: 'Armani Exchange',
    promptPath: 'prompts/brands/armani-exchange.txt',
    fallbackSeries: null,
    series: Object.freeze(['A|X Sync', 'A|X Bass', 'A|X Audora', 'Digital', 'Hampton', 'Drexler', 'Hugo', 'Outerbanks', 'AX Chronograph']),
    aliases: Object.freeze([
      alias('AX Chronograph', /\bax\s+chronograph\b/i),
      alias('Outerbanks', /\bouterbanks\b/i),
      alias('Hampton', /\bhampton\b/i),
      alias('Drexler', /\bdrexler\b/i),
      alias('Hugo', /\bhugo\b/i),
      alias('A|X Sync', /\ba\s*[|/]?\s*x\s+sync\b|\bsync\b/i),
      alias('A|X Bass', /\ba\s*[|/]?\s*x\s+bass\b/i),
      alias('A|X Audora', /\ba\s*[|/]?\s*x\s+audora\b|\baudora\b/i),
      alias('Digital', /\bdigital\s+watch\b/i)
    ])
  }),
  certina: Object.freeze({
    displayName: 'Certina',
    promptPath: 'prompts/brands/certina.txt',
    fallbackSeries: null,
    seriesRequired: false,
    series: Object.freeze([]),
    aliases: Object.freeze([])
  }),
  generic: Object.freeze({
    displayName: 'Общий профиль',
    promptPath: 'prompts/brands/generic.txt',
    fallbackSeries: null,
    series: Object.freeze([]),
    aliases: Object.freeze([])
  })
});

// The bundled brand files contain the closed vocabulary and source hints. This
// small map keeps only genuinely brand-specific exceptions, so the runtime
// prompt does not repeat the same layout and evidence rules for every brand.
const BRAND_SPECIAL_RULES = Object.freeze({
  benyar: Object.freeze([
    'В названии бренда используй только точное слово BENYAR; новый логотип или монограмму не создавай.',
    'Серии и линейки для заглавной карточки Benyar полностью исключены; категории, механизмы, рекламные теги и названия вроде Automatic, Explorer, Professional Divers, Ladies, Sport или Chronograph в заголовок не добавляй.'
  ]),
  casio: Object.freeze([
    'Сохрани точное написание CASIO из главного шаблона; верхний логотип уже готов и не перерисовывается.',
    'В строке 1 выводи только Casio, во второй — только токен серии. Для VINTAGE и COLLECTION запрещено повторять Casio во второй строке.',
    'Fallback «Classic» разрешён только обычной неименованной модели Casio после завершения поиска и только по правилам профиля.',
    'Sports, Professional, Quartz, Digital и Automatic не назначай серией без прямого подтверждения из словаря.'
  ]),
  generic: Object.freeze([
    'У общего профиля нет разрешённых серий: при отсутствии совпадения оставь первую строку пустой, бренд перенеси на позицию второй строки.',
    'Логотип бренда шапки уже находится в главном шаблоне и не заменяется отдельным логотипом магазина.'
  ])
});

const SERIES_DISPLAY_OVERRIDES = Object.freeze({
  casio: Object.freeze({
    VINTAGE: 'Vintage',
    COLLECTION: 'Collection',
    CASIOTRON: 'Casiotron'
  })
});

function printableSeriesName(profile, series) {
  if (!series) return null;
  return SERIES_DISPLAY_OVERRIDES[profile]?.[series] || series;
}

function brandLabelForTitle(profile, modelName) {
  const metadata = getBrandProfile(profile);
  if (metadata.displayName !== 'Общий профиль') return metadata.displayName;
  const normalized = normalizeModelName(modelName)
    .replace(/\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i, '')
    .trim();
  const code = extractReferenceCode(normalized);
  if (!code) return normalized.split(/\s+/).slice(0, 2).join(' ') || 'Бренд';
  const index = matchingModelName(normalized).toUpperCase().indexOf(code.toUpperCase());
  const rawPrefix = index > 0 ? normalized.slice(0, index).trim() : normalized;
  return rawPrefix
    .replace(/[,;:–—-]+$/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ') || 'Бренд';
}

export function resolveTitleSpec(modelName) {
  const normalizedModelName = normalizeModelName(modelName);
  const profile = detectBrandProfile(normalizedModelName);
  const metadata = getBrandProfile(profile);
  const referenceCode = extractReferenceCode(normalizedModelName);
  if (profile === 'pagani_design') {
    return Object.freeze({
      profile,
      brand: 'Pagani Design',
      referenceCode,
      explicitSeries: null,
      explicitSeriesPrint: null,
      fallbackSeries: null,
      seriesRequired: false,
      fixedLines: Object.freeze(['Pagani', 'Design', referenceCode || 'полный код PD-модели']),
      titleLayout: titleLayoutFor(profile, ['Pagani', 'Design'], 'forbidden'),
      mode: 'fixed'
    });
  }
  if (profile === 'orient') {
    return Object.freeze({
      profile,
      brand: 'Orient',
      referenceCode,
      explicitSeries: null,
      explicitSeriesPrint: null,
      fallbackSeries: null,
      seriesRequired: false,
      fixedLines: Object.freeze(['Orient', referenceCode || 'полный код модели из исходного названия']),
      titleLayout: titleLayoutFor(profile, ['Orient'], 'forbidden'),
      mode: 'fixed'
    });
  }
  if (profile === 'seiko') {
    return Object.freeze({
      profile,
      brand: 'Seiko',
      referenceCode,
      explicitSeries: null,
      explicitSeriesPrint: null,
      fallbackSeries: null,
      seriesRequired: false,
      fixedLines: Object.freeze(['Seiko', referenceCode || 'полный код модели из исходного названия']),
      titleLayout: titleLayoutFor(profile, ['Seiko'], 'forbidden'),
      mode: 'fixed'
    });
  }
  if (profile === 'tissot') {
    return Object.freeze({
      profile,
      brand: 'Tissot',
      referenceCode,
      explicitSeries: null,
      explicitSeriesPrint: null,
      fallbackSeries: null,
      seriesRequired: false,
      fixedLines: Object.freeze(['Tissot', referenceCode || 'полный код модели из исходного названия']),
      titleLayout: titleLayoutFor(profile, ['Tissot'], 'forbidden'),
      mode: 'fixed'
    });
  }
  if (profile === 'longines') {
    return Object.freeze({
      profile,
      brand: 'Longines',
      referenceCode,
      explicitSeries: null,
      explicitSeriesPrint: null,
      fallbackSeries: null,
      seriesRequired: false,
      fixedLines: Object.freeze(['Longines', referenceCode || 'полный код модели из исходного названия']),
      titleLayout: titleLayoutFor(profile, ['Longines'], 'forbidden'),
      mode: 'fixed'
    });
  }
  if (profile === 'citizen') {
    return Object.freeze({
      profile,
      brand: 'Citizen',
      referenceCode,
      explicitSeries: null,
      explicitSeriesPrint: null,
      fallbackSeries: null,
      seriesRequired: false,
      fixedLines: Object.freeze(['Citizen', referenceCode || 'полный код модели из исходного названия']),
      titleLayout: titleLayoutFor(profile, ['Citizen'], 'forbidden'),
      mode: 'fixed'
    });
  }
  if (profile === 'certina') {
    return Object.freeze({
      profile,
      brand: 'Certina',
      referenceCode,
      explicitSeries: null,
      explicitSeriesPrint: null,
      fallbackSeries: null,
      seriesRequired: false,
      fixedLines: Object.freeze(['Certina', referenceCode || 'полный код модели из исходного названия']),
      titleLayout: titleLayoutFor(profile, ['Certina'], 'forbidden'),
      mode: 'fixed'
    });
  }
  if (profile === 'benyar') {
    return Object.freeze({
      profile,
      brand: 'Benyar',
      referenceCode,
      explicitSeries: null,
      explicitSeriesPrint: null,
      fallbackSeries: null,
      seriesRequired: false,
      fixedLines: Object.freeze(['Benyar', referenceCode || 'полный код модели из исходного названия']),
      titleLayout: titleLayoutFor(profile, ['Benyar'], 'forbidden'),
      mode: 'fixed'
    });
  }
  if (profile === 'q_and_q') {
    return Object.freeze({
      profile,
      brand: 'Q&Q',
      referenceCode,
      explicitSeries: null,
      explicitSeriesPrint: null,
      fallbackSeries: null,
      seriesRequired: false,
      fixedLines: Object.freeze(['Q&Q', referenceCode || 'полный код модели из исходного названия']),
      titleLayout: titleLayoutFor(profile, ['Q&Q'], 'forbidden'),
      mode: 'fixed'
    });
  }
  const explicitSeries = resolveExplicitBrandSeries(normalizedModelName);
  const explicitSeriesPrint = printableSeriesName(profile, explicitSeries);
  const fallbackSeries = metadata.fallbackSeries || null;
  const brand = brandLabelForTitle(profile, normalizedModelName);
  const seriesPolicy = metadata.seriesRequired === true
    ? 'required'
    : (metadata.series || []).length ? 'optional' : 'forbidden';
  return Object.freeze({
    profile,
    brand,
    referenceCode,
    explicitSeries,
    explicitSeriesPrint,
    fallbackSeries,
    seriesRequired: seriesPolicy === 'required',
    titleLayout: titleLayoutFor(profile, [brand], seriesPolicy),
    seriesVocabulary: metadata.series,
    fixedLines: null,
    mode: explicitSeries ? 'candidate' : 'search'
  });
}

export function buildTitleContract(modelName, options = {}) {
  const spec = resolveTitleSpec(modelName);
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const code = spec.referenceCode || 'полный технический код из исходного названия';
  if (spec.mode === 'fixed') {
    if (spec.profile === 'seiko') {
      return [
        'TITLE CONTRACT — ФИКСИРОВАННЫЙ ДВУХСТРОЧНЫЙ БЛОК SEIKO',
        'В заголовке Seiko запрещены любые линейки, серии и дополнительные строки между брендом и кодом модели.',
        'Строка 1: «Seiko».',
        `Строка 2: «${spec.fixedLines[1]}» — полный код модели; он расположен непосредственно под брендом и набран меньше бренда.`,
        'Не добавляй третью строку и не помещай в заголовок названия линеек, серий или подсерий.',
        `Сохрани геометрию блока из ${templateRef}. Допускаются ровно две строки: Seiko и код модели.`
      ].join('\n');
    }
    if (spec.profile === 'tissot') {
      return [
        'TITLE CONTRACT — ФИКСИРОВАННЫЙ ДВУХСТРОЧНЫЙ БЛОК TISSOT',
        'В заголовке Tissot запрещены любые коллекции, линейки, серии и дополнительные строки между брендом и кодом модели.',
        'Строка 1: «Tissot».',
        `Строка 2: «${spec.fixedLines[1]}» — полный код модели; он расположен непосредственно под брендом и набран меньше бренда.`,
        'Не добавляй третью строку и не помещай в заголовок названия коллекций или серий.',
        `Сохрани геометрию блока из ${templateRef}. Допускаются ровно две строки: Tissot и код модели.`
      ].join('\n');
    }
    if (spec.profile === 'longines') {
      return [
        'TITLE CONTRACT — ФИКСИРОВАННЫЙ ДВУХСТРОЧНЫЙ БЛОК LONGINES',
        'В заголовке Longines запрещены любые коллекции, линейки, серии и дополнительные строки между брендом и кодом модели.',
        'Строка 1: «Longines».',
        `Строка 2: «${spec.fixedLines[1]}» — полный код модели; он расположен непосредственно под брендом и набран меньше бренда.`,
        'Не добавляй третью строку и не помещай в заголовок названия коллекций или серий.',
        `Сохрани геометрию блока из ${templateRef}. Допускаются ровно две строки: Longines и код модели.`
      ].join('\n');
    }
    if (spec.profile === 'citizen') {
      return [
        'TITLE CONTRACT — ФИКСИРОВАННЫЙ ДВУХСТРОЧНЫЙ БЛОК CITIZEN',
        'В заголовке Citizen запрещены любые линейки, коллекции, серии и дополнительные строки между брендом и кодом модели.',
        'Строка 1: «Citizen».',
        `Строка 2: «${spec.fixedLines[1]}» — полный код модели; он расположен непосредственно под брендом и набран меньше бренда.`,
        'Не добавляй третью строку и не помещай в заголовок названия линеек, коллекций или серий.',
        `Сохрани геометрию блока из ${templateRef}. Допускаются ровно две строки: Citizen и код модели.`
      ].join('\n');
    }
    if (spec.profile === 'certina') {
      return [
        'TITLE CONTRACT — ФИКСИРОВАННЫЙ ДВУХСТРОЧНЫЙ БЛОК CERTINA',
        'В заголовке Certina запрещены любые коллекции, семейства, серии и дополнительные строки между брендом и кодом модели.',
        'Строка 1: «Certina».',
        `Строка 2: «${spec.fixedLines[1]}» — полный код модели; он расположен непосредственно под брендом и набран меньше бренда.`,
        'Не добавляй третью строку и не помещай в заголовок названия коллекций, семейств или серий.',
        `Сохрани геометрию блока из ${templateRef}. Допускаются ровно две строки: Certina и код модели.`
      ].join('\n');
    }
    if (spec.profile === 'benyar') {
      return [
        'TITLE CONTRACT — ФИКСИРОВАННЫЙ ДВУХСТРОЧНЫЙ БЛОК BENYAR',
        'В заголовке Benyar запрещены любые коллекции, линейки, серии и дополнительные строки между брендом и кодом модели.',
        'Строка 1: «Benyar».',
        `Строка 2: «${spec.fixedLines[1]}» — полный код модели; он расположен непосредственно под брендом и набран меньше бренда.`,
        'Не добавляй третью строку и не помещай в заголовок названия коллекций, линеек или серий.',
        `Сохрани геометрию блока из ${templateRef}. Допускаются ровно две строки: Benyar и код модели.`
      ].join('\n');
    }
    if (spec.profile === 'q_and_q') {
      return [
        'TITLE CONTRACT — ФИКСИРОВАННЫЙ ДВУХСТРОЧНЫЙ БЛОК Q&Q',
        'В заголовке Q&Q запрещены любые коллекции, линейки, серии и дополнительные строки между брендом и кодом модели.',
        'Строка 1: «Q&Q».',
        `Строка 2: «${spec.fixedLines[1]}» — полный код модели; он расположен непосредственно под брендом и набран меньше бренда.`,
        'Не добавляй третью строку и не помещай в заголовок названия SmileSolar, Superior, Sports, Fashion, Digital, Elegant или любые другие названия коллекций и серий.',
        `Сохрани геометрию блока из ${templateRef}. Допускаются ровно две строки: Q&Q и полный код модели.`
      ].join('\n');
    }
    if (spec.profile === 'orient') {
      return [
        'TITLE CONTRACT — ФИКСИРОВАННЫЙ ДВУХСТРОЧНЫЙ БЛОК ORIENT',
        'В заголовке Orient запрещены любые серии, коллекции и дополнительные строки между брендом и кодом модели.',
        'Строка 1: «Orient».',
        `Строка 2: «${spec.fixedLines[1]}» — полный код модели; он расположен непосредственно под брендом и набран меньше бренда.`,
        'Не добавляй третью строку и не помещай в заголовок слова Bambino, Mako, Kamasu, Orient Star, Classic, Sports или другие названия коллекций/серий.',
        `Сохрани геометрию блока из ${templateRef}. Допускаются ровно две строки: Orient и код модели.`
      ].join('\n');
    }
    return [
      'TITLE CONTRACT — ОБЯЗАТЕЛЬНЫЙ ФИНАЛЬНЫЙ БЛОК НАЗВАНИЯ',
      'Этот контракт имеет приоритет над общими формулировками о заголовке. Это не рекомендация, а фиксированная разметка.',
      `Строка 1: «${spec.fixedLines[0]}»`,
      `Строка 2: «${spec.fixedLines[1]}»`,
      `Строка 3: модель «${spec.fixedLines[2]}» меньшим кеглем, чем строки 1 и 2.`,
      'Не добавляй серии. Не объединяй брендовые строки и не удаляй строку 2. Если не хватает места, уменьши кегль модели, сохранив три отдельные строки.',
      `Сохрани позиции, межстрочный ритм и ширину блока из ${templateRef}. Отсутствующая или объединённая строка считается ошибкой результата.`
    ].join('\n');
  }

  const lines = [
    'TITLE CONTRACT — ОБЯЗАТЕЛЬНАЯ СПЕЦИФИКАЦИЯ БЛОКА НАЗВАНИЯ',
    'Этот контракт идёт последним и имеет приоритет над общими формулировками о заголовке. Перед вызовом генерации изображения выбери допустимый для этого бренда режим ниже и зафиксируй его.',
    `Бренд: «${spec.brand}».`,
    `Технический код: «${code}».`
  ];

  if (spec.explicitSeriesPrint) {
    lines.push(
      `В исходном названии есть разрешённый словарём кандидат серии: «${spec.explicitSeriesPrint}». Он является сильной подсказкой, но всё равно проверь точный артикул по правилам профиля бренда.`,
      `Если источник подтверждает этот кандидат и не даёт более точной разрешённой подсерии, SERIES MODE обязан быть ровно таким:
Строка 1: «${spec.brand}»
Строка 2: «${spec.explicitSeriesPrint}»
Строка 3: «${code}»`,
      'После подтверждения серии строка 2 ОБЯЗАТЕЛЬНА. Запрещено молча перейти к двухстрочному варианту, убрать серию или слить бренд с серией.',
      'Если официальный источник прямо связывает с этим же кодом другую, более точную серию из закрытого словаря, используй её каноническое печатное имя во второй строке вместо кандидата.'
    );
  } else {
    lines.push(
      'В исходном названии нет отдельного разрешённого кандидата серии. Выполни поиск по точному бренду и коду только внутри закрытого словаря профиля.',
      `Если подтверждена серия из словаря, SERIES MODE обязан быть ровно таким:
Строка 1: «${spec.brand}»
Строка 2: «<подтверждённая каноническая серия>»
Строка 3: «${code}»`
    );
  }

  if (spec.fallbackSeries) {
    lines.push(`Если прямое название серии не найдено, fallback «${printableSeriesName(spec.profile, spec.fallbackSeries)}» разрешён только при выполнении специальных условий профиля бренда. Он не включается автоматически.`);
  }

  if (spec.seriesRequired) {
    lines.push(
      'ДЛЯ ЭТОГО БРЕНДА СЕРИЯ ОБЯЗАТЕЛЬНА: NO-SERIES MODE запрещён. Не вызывай генерацию изображения, пока не выбрана подтверждённая серия из закрытого словаря или допустимый fallback по правилам профиля.',
      `Финальный title block всегда содержит три видимые строки:
Строка 1: «${spec.brand}»
Строка 2: «<подтверждённая каноническая серия>»
Строка 3: «${code}»`,
      'После выбора серии не меняй структуру во время рендера. Количество строк, их порядок и текст становятся фиксированными.'
    );
  } else {
    lines.push(
      `Если серия не подтверждена и fallback неприменим, NO-SERIES MODE обязан быть ровно таким:
Строка 1: <пустая фиксированная строка>
Строка 2: «${spec.brand}»
Строка 3: «${code}»`,
      'После выбора SERIES MODE или NO-SERIES MODE не меняй структуру во время рендера. Количество строк, их порядок и текст становятся фиксированными.'
    );
  }

  lines.push(
    'КРИТИЧЕСКОЕ ПРАВИЛО: в SERIES MODE вторая строка не может исчезнуть. Не объединяй строки 1 и 2. Не заменяй три строки двумя. При нехватке места сначала уменьши кегль/трекинг в пределах стиля шаблона, но сохрани все обязательные строки.',
    `Перед финальной выдачей сравни title block с выбранным режимом посимвольно. Если обязательная строка отсутствует, объединена или заменена — исправь карточку до выдачи. Сохрани геометрию блока из ${templateRef}.`
  );
  return lines.join('\n');
}

function buildPaganiBrandInstruction(modelName, options = {}) {
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const referenceCode = extractReferenceCode(modelName);
  const codeLabel = referenceCode ? `«${referenceCode}»` : 'из исходного названия модели';
  return [
    'ПРОФИЛЬ БРЕНДА PAGANI DESIGN — ФИКСИРОВАННАЯ РАЗМЕТКА',
    `— Бренд этой генерации: Pagani Design. Брендовый знак шапки уже зафиксирован в ${templateRef} и сохраняется без перерисовки.`,
    '— Блок названия состоит из двух брендовых строк и строки модели меньшим кеглем:',
    '  1) «Pagani»; 2) «Design»; 3) название модели с полным техническим кодом.',
    `— Для этой модели технический код: ${codeLabel}. Выведи его один раз в третьей строке, без сокращений и дублей; строку модели сделай заметно меньше двух брендовых строк.`,
    '— Серии для Pagani Design не используются. Между «Design» и моделью серию не вставляй. После строки модели ничего не добавляй: категории, механизмы, назначение и homage-модели исключены из блока названия.',
    `— Сохрани межстрочный ритм, позицию и композицию текстового блока из ${templateRef}; визуальную иерархию соблюдай: Pagani / Design крупно, модель меньшим кеглем.`
  ].join('\n');
}

function buildOrientBrandInstruction(modelName, options = {}) {
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const referenceCode = extractReferenceCode(modelName);
  return [
    'ПРОФИЛЬ БРЕНДА ORIENT — СЕРИИ ПОЛНОСТЬЮ ИСКЛЮЧЕНЫ',
    `— Используй новую композицию Orient из ${templateRef}: логотип Orient и «2 Года гарантии» в шапке, крупный блок Orient с кодом модели ниже, два УТП слева, водозащита и диаметр корпуса внизу.`,
    `— Код модели: ${referenceCode ? `«${referenceCode}»` : 'точный полный код из исходного названия'}. Выведи его один раз непосредственно под словом «Orient».`,
    '— Заголовок содержит ровно две строки: «Orient» и полный код модели. Не добавляй серию, коллекцию, подсерии или описательные слова ни в заголовок, ни вместо кода.',
    '— Не ищи и не определяй серии. Названия Bambino, Mako, Kamasu, Orient Star, Classic, Sports и любые другие коллекции не включай в карточку.',
    '— Сохрани фиксированные зоны, размер и расположение элементов референса. В референсе УТП — «Минеральное стекло» и «Автоматический механизм»; для другой модели используй только подтверждённые для её кода характеристики.',
    '— Водозащиту и диаметр корпуса переноси из подтверждённых источников для конкретного артикула. Не копируй значения 5 атм и 40,5 мм с референса, если они не соответствуют модели.'
  ].join('\n');
}

function buildSeikoBrandInstruction(modelName, options = {}) {
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const referenceCode = extractReferenceCode(modelName);
  return [
    'ПРОФИЛЬ БРЕНДА SEIKO — ЛИНЕЙКИ И СЕРИИ ПОЛНОСТЬЮ ИСКЛЮЧЕНЫ',
    `— Используй композицию Seiko из ${templateRef}: логотип Seiko и «2 Года гарантии» в шапке, крупный блок Seiko с кодом модели ниже, два УТП слева, водозащита и диаметр корпуса внизу.`,
    `— Код модели: ${referenceCode ? `«${referenceCode}»` : 'точный полный код из исходного названия'}. Выведи его один раз непосредственно под словом «Seiko».`,
    '— Заголовок содержит ровно две строки: «Seiko» и полный код модели. Не добавляй линейку, серию, подсерии или описательные слова ни в заголовок, ни вместо кода.',
    '— Не ищи и не определяй линейки или серии. Названия Prospex, Presage, Astron, 5 Sports, King Seiko и любые другие линейки не включай в карточку.',
    '— Сохрани фиксированные зоны, размер и расположение элементов референса. В референсе УТП — «Минеральное стекло» и «Автоматический механизм»; для другой модели используй только подтверждённые для её кода характеристики.',
    '— Водозащиту и диаметр корпуса переноси из подтверждённых источников для конкретного артикула. Не копируй значения 5 атм и 40,5 мм с референса, если они не соответствуют модели.'
  ].join('\n');
}

function buildTissotBrandInstruction(modelName, options = {}) {
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const referenceCode = extractReferenceCode(modelName);
  return [
    'ПРОФИЛЬ БРЕНДА TISSOT — КОЛЛЕКЦИИ И СЕРИИ ПОЛНОСТЬЮ ИСКЛЮЧЕНЫ',
    `— Используй композицию Tissot из ${templateRef}: знак Tissot и «2 Года гарантии» в шапке, крупный блок Tissot с кодом модели ниже, два УТП слева, водозащита и диаметр корпуса внизу.`,
    `— Код модели: ${referenceCode ? `«${referenceCode}»` : 'точный полный код из исходного названия'}. Выведи его один раз непосредственно под словом «Tissot».`,
    '— Заголовок содержит ровно две строки: «Tissot» и полный код модели. Не добавляй коллекцию, линейку, серию или описательные слова ни в заголовок, ни вместо кода.',
    '— Не ищи и не определяй коллекции или серии. Названия PRX, Seastar, Le Locle, Gentleman и любые другие названия коллекций не включай в карточку.',
    '— Сохрани фиксированные зоны, размер и расположение элементов референса. В примере показаны УТП «Минеральное стекло» и «Кварцевый механизм»; для другой модели используй только подтверждённые для её кода характеристики.',
    '— Водозащиту и диаметр корпуса переноси из подтверждённых источников для конкретного артикула. Не копируй значения 10 атм и 40 мм с референса, если они не соответствуют модели.'
  ].join('\n');
}

function buildLonginesBrandInstruction(modelName, options = {}) {
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const referenceCode = extractReferenceCode(modelName);
  return [
    'ПРОФИЛЬ БРЕНДА LONGINES — КОЛЛЕКЦИИ И СЕРИИ ПОЛНОСТЬЮ ИСКЛЮЧЕНЫ',
    `— Используй композицию Longines из ${templateRef}: крылатый логотип Longines и «2 Года гарантии» в шапке, крупный блок Longines с кодом модели ниже, два УТП слева, водозащита и диаметр корпуса внизу.`,
    `— Код модели: ${referenceCode ? `«${referenceCode}»` : 'точный полный код из исходного названия'}. Выведи его один раз непосредственно под словом «Longines».`,
    '— Заголовок содержит ровно две строки: «Longines» и полный код модели. Не добавляй коллекцию, линейку, серию или описательные слова ни в заголовок, ни вместо кода.',
    '— Не ищи и не определяй коллекции или серии. Названия HydroConquest, Conquest, Spirit, Master Collection и любые другие названия линеек не включай в карточку.',
    '— Сохрани фиксированные зоны, размер и расположение элементов референса. В примере показаны УТП «Сапфировое стекло» и «Автоматический механизм»; для другой модели используй только подтверждённые для её кода характеристики.',
    '— Водозащиту и диаметр корпуса переноси из подтверждённых источников для конкретного артикула. Не копируй значения 10 атм и 41 мм с референса, если они не соответствуют модели.'
  ].join('\n');
}

function buildCitizenBrandInstruction(modelName, options = {}) {
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const referenceCode = extractReferenceCode(modelName);
  return [
    'ПРОФИЛЬ БРЕНДА CITIZEN — ЛИНЕЙКИ И СЕРИИ ПОЛНОСТЬЮ ИСКЛЮЧЕНЫ',
    `— Используй композицию Citizen из ${templateRef}: орлиный логотип Citizen и «2 Года гарантии» в шапке, крупный блок Citizen с кодом модели ниже, два УТП слева, водозащита и диаметр корпуса внизу.`,
    `— Код модели: ${referenceCode ? `«${referenceCode}»` : 'точный полный код из исходного названия'}. Выведи его один раз непосредственно под словом «Citizen».`,
    '— Заголовок содержит ровно две строки: «Citizen» и полный код модели. Не добавляй линейку, семейство, коллекцию, серию или описательные слова ни в заголовок, ни вместо кода.',
    '— Не ищи и не определяй линейки или серии. Названия Eco-Drive, Promaster, Tsuyosa, Series8, Attesa и любые другие названия линеек не включай в карточку.',
    '— Сохрани фиксированные зоны, размер и расположение элементов референса. В примере показаны УТП «Минеральное стекло» и «Кварцевый механизм»; для другой модели используй только подтверждённые для её кода характеристики.',
    '— Водозащиту и диаметр корпуса переноси из подтверждённых источников для конкретного артикула. Не копируй значения 10 атм и 42 мм с референса, если они не соответствуют модели.'
  ].join('\n');
}

function buildCertinaBrandInstruction(modelName, options = {}) {
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const referenceCode = extractReferenceCode(modelName);
  return [
    'ПРОФИЛЬ БРЕНДА CERTINA — СЕМЕЙСТВА И СЕРИИ ПОЛНОСТЬЮ ИСКЛЮЧЕНЫ',
    `— Используй композицию Certina из ${templateRef}: логотип Certina и «2 Года гарантии» в шапке, крупный блок Certina с кодом модели ниже, два УТП слева, водозащита и диаметр корпуса внизу.`,
    `— Код модели: ${referenceCode ? `«${referenceCode}»` : 'точный полный код из исходного названия'}. Выведи его один раз непосредственно под словом «Certina».`,
    '— Заголовок содержит ровно две строки: «Certina» и полный код модели. Не добавляй семейство, коллекцию, серию или описательные слова ни в заголовок, ни вместо кода.',
    '— Не ищи и не определяй семейства или серии. Названия DS, DS Action, DS Podium, DS PH и любые другие названия линеек не включай в карточку.',
    '— Сохрани фиксированные зоны, размер и расположение элементов референса. В примере показаны УТП «Сапфировое стекло» и «Кварцевый механизм»; для другой модели используй только подтверждённые для её кода характеристики.',
    '— Водозащиту и диаметр корпуса переноси из подтверждённых источников для конкретного артикула. Не копируй значения 10 атм и 41 мм с референса, если они не соответствуют модели.'
  ].join('\n');
}

function buildBenyarBrandInstruction(modelName, options = {}) {
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const referenceCode = extractReferenceCode(modelName);
  return [
    'ПРОФИЛЬ БРЕНДА BENYAR — ЛИНЕЙКИ И СЕРИИ ПОЛНОСТЬЮ ИСКЛЮЧЕНЫ',
    `— Используй композицию Benyar из ${templateRef}: эмблема Benyar и «2 Года гарантии» в шапке, крупный блок Benyar с кодом модели ниже, два УТП слева, водозащита и диаметр корпуса внизу.`,
    `— Код модели: ${referenceCode ? `«${referenceCode}»` : 'точный полный код из исходного названия'}. Выведи его один раз непосредственно под словом «Benyar».`,
    '— Заголовок содержит ровно две строки: «Benyar» и полный код модели. Не добавляй линейку, коллекцию, серию или описательные слова ни в заголовок, ни вместо кода.',
    '— Не ищи и не определяй линейки или серии. Названия Casual Date, Moonphase, Grand Master, SportX и любые другие линейки не включай в карточку.',
    '— Сохрани фиксированные зоны, размер и расположение элементов референса. В примере показаны УТП «Ударопрочный корпус» и «Автоматический механизм»; для другой модели используй только подтверждённые для её кода характеристики.',
    '— Водозащиту и диаметр корпуса переноси из подтверждённых источников для конкретного артикула. Не копируй значения 5 атм и 41 мм с референса, если они не соответствуют модели.'
  ].join('\n');
}

function buildQAndQBrandInstruction(modelName, options = {}) {
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  const referenceCode = extractReferenceCode(modelName);
  return [
    'ПРОФИЛЬ БРЕНДА Q&Q — ЛИНЕЙКИ И СЕРИИ ПОЛНОСТЬЮ ИСКЛЮЧЕНЫ',
    `— Используй композицию Q&Q из ${templateRef}: логотип Q&Q и «2 Года гарантии» в верхней синей шапке, крупный блок Q&Q с кодом модели ниже, часы справа, два УТП слева и отдельные зоны водозащиты/диаметра внизу.`,
    `— Код модели: ${referenceCode ? `«${referenceCode}»` : 'точный полный код из исходного названия'}. Выведи его один раз непосредственно под надписью «Q&Q».`,
    '— Заголовок содержит ровно две строки: «Q&Q» и полный код модели. Не добавляй линейку, коллекцию, серию или описательные слова ни в заголовок, ни вместо кода.',
    '— Не ищи и не определяй коллекции или серии. Названия SmileSolar, Superior, Sports, Fashion, Digital, Elegant и любые другие линейки/коллекции не включай в карточку.',
    '— Сохрани фиксированные зоны, размер и расположение элементов референса. В примере показаны УТП «Минеральное стекло» и «Кварцевый механизм»; для другой модели используй только подтверждённые для её кода характеристики.',
    '— Водозащиту и диаметр корпуса переноси из подтверждённых источников для конкретного артикула. Не копируй значения 5 атм и 40 мм с референса, если они не соответствуют модели.'
  ].join('\n');
}

export function brandProfileIds() {
  return Object.keys(BRAND_PROFILE_META);
}

export function getBrandProfile(profileId) {
  return BRAND_PROFILE_META[String(profileId || '').trim()] || BRAND_PROFILE_META.generic;
}

export function detectBrandProfile(modelName) {
  const value = matchingModelName(modelName).toLowerCase();
  if (/\bpagani\s+design\b/.test(value)) return 'pagani_design';
  if (/\barmani\s+exchange\b/.test(value)) return 'armani_exchange';
  if (/\bbenyar\b/.test(value)) return 'benyar';
  if (/\bcasio\b/.test(value)) return 'casio';
  if (/\borient\b/.test(value)) return 'orient';
  if (/\btissot\b/.test(value)) return 'tissot';
  if (/\bq\s*&\s*q\b/.test(value)) return 'q_and_q';
  if (/\bseiko\b/.test(value)) return 'seiko';
  if (/\bcitizen\b/.test(value)) return 'citizen';
  if (/\blongines\b/.test(value)) return 'longines';
  if (/\bdiesel\b/.test(value)) return 'diesel';
  if (/\bcertina\b/.test(value)) return 'certina';
  return 'generic';
}

function resolveAllowedSeriesAlias(modelName) {
  const profile = detectBrandProfile(modelName);
  const metadata = getBrandProfile(profile);
  const value = matchingModelName(modelName);
  return (metadata.aliases || [])
    .filter((item) => metadata.series.includes(item.name) && item.pattern.test(value))
    .sort((left, right) => right.name.length - left.name.length)[0]?.name || null;
}

export function resolveBrandSeries(modelName) {
  const profile = detectBrandProfile(modelName);
  return resolveAllowedSeriesAlias(modelName) || getBrandProfile(profile).fallbackSeries || null;
}

function resolveExplicitBrandSeries(modelName) {
  return resolveAllowedSeriesAlias(modelName);
}

export function brandPromptPath(profileOrModelName) {
  const value = String(profileOrModelName || '').trim();
  const profile = Object.hasOwn(BRAND_PROFILE_META, value) ? value : detectBrandProfile(value);
  return getBrandProfile(profile).promptPath;
}

export function extractReferenceCode(modelName) {
  const value = normalizeModelName(modelName)
    .replace(/\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i, '')
    .trim();
  const matches = WATCH_REFERENCE_PATTERNS.flatMap((pattern) => (
    [...value.matchAll(pattern)].map((match) => ({ index: match.index ?? 0, raw: String(match[1] || '').trim() }))
  )).sort((left, right) => left.index - right.index || left.raw.length - right.raw.length);
  for (const { raw } of matches) {
    const rawParts = raw.split(/\s+/);
    const codeParts = [];
    for (const [index, part] of rawParts.entries()) {
      // Spaces inside a code are accepted while the following segment still
      // carries a digit (for example: GA 2100 1A1). Plain words such as
      // "Automatic" are title descriptors and terminate the code.
      if (index > 0 && !/\d/.test(part)) break;
      codeParts.push(part);
    }
    const candidate = codeParts.join('-').replace(/\s+/g, '-').toUpperCase();
    if (!candidate || REFERENCE_NON_CODES.some((pattern) => pattern.test(candidate))) continue;
    const segments = candidate.split('-').filter(Boolean);
    const firstSegment = segments[0] || '';
    const digitCount = (candidate.match(/\d/g) || []).length;
    if (digitCount < 2 || REFERENCE_BRAND_PREFIXES.has(firstSegment)) continue;
    // A technical code either carries a digit in its first segment (T126...,
    // AX1721) or starts with a short code prefix followed by a digit-bearing
    // segment (BY-S001..., GA-2100...). This filters lexical series names
    // while retaining legitimate one-letter prefixes such as G-5600.
    if (!/\d/.test(firstSegment)) {
      const secondSegment = segments[1] || '';
      if (firstSegment.length > 3 || !/\d/.test(secondSegment)) continue;
      if (REFERENCE_PREFIX_STOPWORDS.has(firstSegment)) continue;
    }
    return candidate;
  }
  return null;
}

export function buildBrandInstruction(modelName, options = {}) {
  const profile = detectBrandProfile(modelName);
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  const templateRef = inputPlan.refs.template || 'главный шаблон';
  if (profile === 'pagani_design') return buildPaganiBrandInstruction(modelName, { ...options, inputPlan });
  if (profile === 'orient') return buildOrientBrandInstruction(modelName, { ...options, inputPlan });
  if (profile === 'seiko') return buildSeikoBrandInstruction(modelName, { ...options, inputPlan });
  if (profile === 'tissot') return buildTissotBrandInstruction(modelName, { ...options, inputPlan });
  if (profile === 'longines') return buildLonginesBrandInstruction(modelName, { ...options, inputPlan });
  if (profile === 'citizen') return buildCitizenBrandInstruction(modelName, { ...options, inputPlan });
  if (profile === 'certina') return buildCertinaBrandInstruction(modelName, { ...options, inputPlan });
  if (profile === 'benyar') return buildBenyarBrandInstruction(modelName, { ...options, inputPlan });
  if (profile === 'q_and_q') return buildQAndQBrandInstruction(modelName, { ...options, inputPlan });
  const normalizedModelName = normalizeModelName(modelName);
  const referenceCode = extractReferenceCode(modelName);
  const metadata = getBrandProfile(profile);
  const explicitSeries = resolveExplicitBrandSeries(modelName);
  const fallbackSeries = metadata.fallbackSeries || null;
  const searchTarget = referenceCode
    ? `${metadata.displayName} ${referenceCode}`
    : normalizedModelName || `${metadata.displayName} полное название модели`;
  const lines = [
    `ПРОФИЛЬ БРЕНДА ${metadata.displayName.toUpperCase()} — RUNTIME-КОНТРОЛЬ`,
    `— Бренд этой генерации: ${metadata.displayName === 'Общий профиль' ? 'точное название бренда из исходного названия' : `«${metadata.displayName}»`}. Логотип шапки уже зафиксирован в ${templateRef}.`,
    `— Технический код: ${referenceCode ? `«${referenceCode}»` : 'из исходного названия'}. Код не является серией и печатается только один раз в технической строке.`,
    explicitSeries
      ? `— В исходном названии обнаружен разрешённый кандидат серии «${printableSeriesName(profile, explicitSeries)}». Проверь его по точному артикулу; не отбрасывай этот кандидат без причины и не считай имя файла единственным доказательством.`
      : '— В исходном названии отдельный разрешённый кандидат серии не обнаружен. Ищи серию по точному артикулу только внутри закрытого словаря из файла профиля.',
    `— Поисковый ключ: «${searchTarget}». Приоритет: официальная карточка модели, официальный каталог и инструкция; продавец — только дополнительное подтверждение.`,
    '— Интернет не расширяет локальный словарь. Используй только каноническое значение, разрешённое файлом профиля бренда.',
    '— Решение о строках заголовка не принимай свободно: после этого блока будет TITLE CONTRACT, который задаёт обязательные режимы и финальную разметку.'
  ];
  if (fallbackSeries) {
    lines.push(`— Fallback «${printableSeriesName(profile, fallbackSeries)}» применим только при выполнении условий файла профиля; отсутствие результата поиска само по себе не включает fallback.`);
  } else {
    lines.push('— Fallback отсутствует: без подтверждённой серии используй только NO-SERIES MODE из TITLE CONTRACT.');
  }
  lines.push(...(BRAND_SPECIAL_RULES[profile] || []));
  return lines.join('\n').trim();
}

function stripSeriesSection(promptText, profile) {
  const text = String(promptText || '');
  const start = text.search(/^ПОИСК МОДЕЛИ И СЕРИИ\s*$/im);
  const end = text.search(/^ПРОВЕРКА ФАКТОВ И УТП\s*$/im);
  if (start < 0 || end < 0 || end <= start) return text;
  const checklistLine = profile === 'orient'
    ? '4. Заголовок содержит ровно две строки: «Orient» и полный код модели; серия отсутствует.'
    : profile === 'seiko'
      ? '4. Заголовок содержит ровно две строки: «Seiko» и полный код модели; линейка и серия отсутствуют.'
      : profile === 'tissot'
        ? '4. Заголовок содержит ровно две строки: «Tissot» и полный код модели; коллекция и серия отсутствуют.'
        : profile === 'longines'
          ? '4. Заголовок содержит ровно две строки: «Longines» и полный код модели; коллекция и серия отсутствуют.'
          : profile === 'citizen'
            ? '4. Заголовок содержит ровно две строки: «Citizen» и полный код модели; линейка и серия отсутствуют.'
            : profile === 'certina'
              ? '4. Заголовок содержит ровно две строки: «Certina» и полный код модели; семейство и серия отсутствуют.'
              : profile === 'benyar'
                ? '4. Заголовок содержит ровно две строки: «Benyar» и полный код модели; коллекция и серия отсутствуют.'
                : profile === 'q_and_q'
                  ? '4. Заголовок содержит ровно две строки: «Q&Q» и полный код модели; коллекция и серия отсутствуют.'
                : '4. Заголовок содержит две строки «Pagani» и «Design», затем код модели; полный код написан один раз.';
  return `${text.slice(0, start).trim()}\n\n${text.slice(end).trim()}`
    .replace(/названию бренда или серии/gi, 'названию бренда')
    .replace('4. Заголовок дословно соответствует выбранному TITLE CONTRACT: обязательные строки не потеряны и не объединены, полный код написан один раз.', checklistLine);
}

export function buildGenerationPrompt(basePrompt, modelName, brandPrompt = '', options = {}) {
  const normalizedModelName = normalizeModelName(modelName);
  const profile = detectBrandProfile(normalizedModelName);
  const inputPlan = options?.inputPlan || buildInputPlan(options?.inputMode);
  let prompt = ['pagani_design', 'orient', 'seiko', 'tissot', 'longines', 'citizen', 'certina', 'benyar', 'q_and_q'].includes(profile)
    ? stripSeriesSection(basePrompt, profile)
    : String(basePrompt || '');
  for (const placeholder of MODEL_PLACEHOLDERS) {
    prompt = prompt.replaceAll(placeholder, normalizedModelName);
  }
  prompt = renderReferenceAwareText(prompt, inputPlan);
  const sections = [prompt.trim()];
  const profileText = renderReferenceAwareText(String(brandPrompt || '').trim(), inputPlan);
  if (profileText) {
    sections.push(`ФАЙЛ ПРОФИЛЯ БРЕНДА — ИСПОЛЬЗУЙ КАК ИСТОЧНИК ПРАВИЛ:
${profileText}`);
  }
  const brandInstruction = buildBrandInstruction(normalizedModelName, { inputPlan });
  sections.push(`КОНТРОЛЬ БРЕНДА И ПРОВЕРКИ:
${renderReferenceAwareText(brandInstruction, inputPlan)}`);
  sections.push(renderReferenceAwareText(buildTitleContract(normalizedModelName, { inputPlan }), inputPlan));
  return sections.filter(Boolean).join('\n\n').trim();
}
