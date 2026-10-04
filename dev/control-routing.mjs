const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

export function extensionIdFromOrigin(origin) {
  const match = /^chrome-extension:\/\/([a-p]{32})$/i.exec(String(origin || '').trim());
  return match ? match[1].toLowerCase() : null;
}

export function normalizeControlClient({ origin, extensionId: claimedExtensionId = '', clientId = '', version = '' } = {}) {
  const originId = extensionIdFromOrigin(origin);
  const claimedId = String(claimedExtensionId || '').trim().toLowerCase();
  if (claimedId && !EXTENSION_ID_PATTERN.test(claimedId)) return null;
  if (originId && claimedId && originId !== claimedId) return null;
  // Chromium service-worker fetches can omit the Origin header even when they
  // originate from an extension. In that case, use the extension ID supplied
  // by the installed client and validate its format. Client IDs remain an
  // installation-scoped capability on the loopback-only watcher.
  const extensionId = originId || (EXTENSION_ID_PATTERN.test(claimedId) ? claimedId : null);
  if (!extensionId) return null;
  const normalizedClientId = String(clientId || '').trim();
  if (normalizedClientId && !CLIENT_ID_PATTERN.test(normalizedClientId)) return null;
  return {
    extensionId,
    clientId: normalizedClientId || null,
    clientKey: normalizedClientId ? `client:${normalizedClientId}` : `legacy:${extensionId}`,
    version: String(version || '').trim().slice(0, 80) || null
  };
}

export function resolveControlTarget(payload = {}, activeClients = []) {
  const targetClientId = String(payload.targetClientId || '').trim();
  const targetExtensionId = String(payload.targetExtensionId || '').trim().toLowerCase();
  if (targetClientId && !CLIENT_ID_PATTERN.test(targetClientId)) {
    throw new Error('Некорректный targetClientId');
  }
  if (targetExtensionId && !EXTENSION_ID_PATTERN.test(targetExtensionId)) {
    throw new Error('Некорректный targetExtensionId');
  }

  let candidates = activeClients;
  if (targetClientId) candidates = candidates.filter((client) => client.clientId === targetClientId);
  if (targetExtensionId) candidates = candidates.filter((client) => client.extensionId === targetExtensionId);
  if (!targetClientId && !targetExtensionId && candidates.length !== 1) {
    throw new Error(candidates.length
      ? 'Активны несколько экземпляров расширения; укажи targetClientId или targetExtensionId'
      : 'Нет недавно опрашивавших локальный канал экземпляров расширения');
  }
  if (!candidates.length) throw new Error('Указанный экземпляр расширения сейчас не зарегистрирован');
  if (!targetClientId && candidates.length > 1) {
    throw new Error('Один extensionId используется несколькими профилями; укажи targetClientId');
  }
  if (candidates.length > 1) throw new Error('targetClientId не идентифицирует единственный экземпляр расширения');
  return {
    targetClientId: candidates[0].clientId,
    targetClientKey: candidates[0].clientKey,
    targetExtensionId: candidates[0].extensionId
  };
}

export function controlCommandMatchesClient(command, client) {
  if (!command || !client) return false;
  if (command.targetClientKey && command.targetClientKey !== client.clientKey) return false;
  if (command.targetExtensionId && command.targetExtensionId !== client.extensionId) return false;
  return Boolean(command.targetClientKey || command.targetExtensionId);
}
