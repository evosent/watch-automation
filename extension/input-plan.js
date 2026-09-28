export const INPUT_MODES = Object.freeze({
  '2': Object.freeze({
    id: '2',
    label: '2 файла · шаблон + часы',
    description: 'Эксперимент: геометрию Ozon берём только из готового шаблона.',
    roles: Object.freeze(['template', 'watchReference'])
  }),
  '3': Object.freeze({
    id: '3',
    label: '3 файла · шаблон + Ozon + часы',
    description: 'Основной оптимизированный режим без отдельного логотипа Watches World.',
    roles: Object.freeze(['template', 'ozonMap', 'watchReference'])
  }),
  '4': Object.freeze({
    id: '4',
    label: '4 файла · старый режим',
    description: 'Контрольный режим: шаблон + Ozon + Watches World + часы.',
    roles: Object.freeze(['template', 'ozonMap', 'storeLogo', 'watchReference'])
  })
});

export const DEFAULT_INPUT_MODE = '2';

export const INPUT_ROLE_LABELS = Object.freeze({
  template: 'главный шаблон карточки',
  ozonMap: 'карта слепых зон Ozon',
  storeLogo: 'логотип Watches World',
  watchReference: 'фотография конкретных часов'
});

const TOKEN_BY_ROLE = Object.freeze({
  template: '{{REF_TEMPLATE}}',
  ozonMap: '{{REF_OZON_MAP}}',
  storeLogo: '{{REF_STORE_LOGO}}',
  watchReference: '{{REF_WATCH}}'
});

export function normalizeInputMode(value, fallback = DEFAULT_INPUT_MODE) {
  const normalized = String(value ?? '').trim();
  if (Object.hasOwn(INPUT_MODES, normalized)) return normalized;
  const fallbackKey = String(fallback ?? DEFAULT_INPUT_MODE).trim();
  return Object.hasOwn(INPUT_MODES, fallbackKey) ? fallbackKey : DEFAULT_INPUT_MODE;
}

export function buildInputPlan(value = DEFAULT_INPUT_MODE) {
  const mode = normalizeInputMode(value);
  const definition = INPUT_MODES[mode];
  const attachments = definition.roles.map((role, index) => Object.freeze({
    role,
    index: index + 1,
    ref: `@${index + 1}`,
    label: INPUT_ROLE_LABELS[role] || role
  }));
  const refs = Object.fromEntries(attachments.map((item) => [item.role, item.ref]));
  return Object.freeze({
    mode,
    label: definition.label,
    description: definition.description,
    count: attachments.length,
    roles: Object.freeze([...definition.roles]),
    attachments: Object.freeze(attachments),
    refs: Object.freeze(refs),
    hasOzonMap: definition.roles.includes('ozonMap'),
    hasStoreLogo: definition.roles.includes('storeLogo')
  });
}

export function requiredReferenceRoles(value = DEFAULT_INPUT_MODE) {
  return buildInputPlan(value).roles.filter((role) => role !== 'watchReference');
}

export function referenceForRole(planOrMode, role, fallback = '') {
  const plan = typeof planOrMode === 'object' && planOrMode?.refs
    ? planOrMode
    : buildInputPlan(planOrMode);
  return plan.refs?.[role] || fallback;
}

function applyConditionalBlock(text, name, enabled) {
  const expression = new RegExp(`\\[\\[IF_${name}\\]\\]([\\s\\S]*?)\\[\\[/IF_${name}\\]\\]`, 'g');
  return String(text || '').replace(expression, enabled ? '$1' : '');
}

export function renderReferenceAwareText(text, planOrMode = DEFAULT_INPUT_MODE) {
  const plan = typeof planOrMode === 'object' && planOrMode?.refs
    ? planOrMode
    : buildInputPlan(planOrMode);
  let output = String(text || '');
  output = applyConditionalBlock(output, 'OZON_MAP', plan.hasOzonMap);
  output = applyConditionalBlock(output, 'NO_OZON_MAP', !plan.hasOzonMap);
  output = applyConditionalBlock(output, 'STORE_LOGO', plan.hasStoreLogo);
  output = applyConditionalBlock(output, 'NO_STORE_LOGO', !plan.hasStoreLogo);
  for (const [role, token] of Object.entries(TOKEN_BY_ROLE)) {
    output = output.replaceAll(token, referenceForRole(plan, role, ''));
  }
  output = output.replaceAll('{{INPUT_COUNT}}', String(plan.count));
  return output
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function unresolvedReferenceTokens(text) {
  return String(text || '').match(/\{\{REF_[A-Z_]+\}\}|\[\[\/?IF_[A-Z_]+\]\]/g) || [];
}
