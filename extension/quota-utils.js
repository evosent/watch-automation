// Shared by classic content scripts and the module service worker.
(() => {
  const QUOTA_SAFETY_MS = 60000;
  const QUOTA_RECHECK_MS = 3 * 60 * 60 * 1000 + QUOTA_SAFETY_MS;
  const normalizedText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  function isUploadLimitText(value) {
    return /(?:file\s+uploads?\s+limit|upload(?:s|ing)?\s+(?:rate\s+)?limit|limit\s+(?:for|on)\s+(?:file\s+)?uploads?|(?:reached|exceeded|exhausted)[^.]{0,80}(?:upload|file)[^.]{0,30}limit|too\s+many\s+(?:files|uploads)|лимит[^.]{0,70}загруз|загруз[^.]{0,70}(?:лимит|ограничен)|слишком\s+много\s+файлов)/i
      .test(normalizedText(value));
  }

  function isStorageLimitText(value) {
    return /(?:storage\s+(?:limit|quota|capacity)|(?:out\s+of|insufficient|not\s+enough)\s+storage|(?:storage|disk)[^.]{0,40}(?:full|exceeded)|хранилищ[^.]{0,40}(?:переполн|заполн)|лимит[^.]{0,40}(?:хранен|хранилищ)|недостаточно\s+места)/i
      .test(normalizedText(value));
  }

  function isImageLimitText(value) {
    return /(?:лимит\s+(?:создания|генерации)\s+изображений|лимит\s+запросов\s+на\s+генерацию\s+изображений|image\s+(?:generation|creation)\s+limit|limit\s+(?:for|on)\s+(?:creating|generating)\s+images)/i
      .test(normalizedText(value));
  }

  function quotaResetAt(value, now = Date.now()) {
    const text = normalizedText(value);
    const current = Number(now);
    const relative = text.match(/(?:\bin\b|\bafter\b|через)\s+((?:\d+(?:[.,]\d+)?\s*(?:hours?|hrs?|h\b|час(?:а|ов)?|ч\.?(?=\s|[.,;]|$)|minutes?|mins?|m\b|минут(?:у|ы)?|мин\.?(?=\s|[.,;]|$)|seconds?|secs?|секунд(?:у|ы)?|сек\.?(?=\s|[.,;]|$))(?:\s*(?:and|и)?\s*)?){1,3})/i);
    if (relative) {
      let delayMs = 0;
      for (const match of relative[1].matchAll(/(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|h\b|час(?:а|ов)?|ч\.?(?=\s|[.,;]|$)|minutes?|mins?|m\b|минут(?:у|ы)?|мин\.?(?=\s|[.,;]|$)|seconds?|secs?|секунд(?:у|ы)?|сек\.?(?=\s|[.,;]|$))/gi)) {
        const unit = match[2].toLowerCase();
        const factor = /^(?:h|час|ч)/.test(unit) ? 3600000 : /^(?:m|мин)/.test(unit) ? 60000 : 1000;
        delayMs += Number(match[1].replace(',', '.')) * factor;
      }
      if (Number.isFinite(delayMs) && delayMs >= 0) return current + delayMs + QUOTA_SAFETY_MS;
    }
    const clock = text.match(/(?:попробуйте\s+(?:снова|ещ[её]\s+раз)\s+в|повторите\s+попытку\s+в|try\s+again\s+(?:at|after))\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!clock) return null;
    let hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (minute > 59 || hour > 23 || (clock[3] && (hour < 1 || hour > 12))) return null;
    if (clock[3]) hour = hour % 12 + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
    const deadline = new Date(current);
    deadline.setHours(hour, minute + 1, 0, 0);
    if (deadline.getTime() <= current && current - deadline.getTime() < 5 * 60000) return current + QUOTA_SAFETY_MS;
    if (deadline.getTime() <= current) deadline.setDate(deadline.getDate() + 1);
    return deadline.getTime();
  }

  function uploadLimitResumeAt(value, now = Date.now()) {
    if (!isUploadLimitText(value) || isStorageLimitText(value)) return null;
    return quotaResetAt(value, now) ?? Number(now) + QUOTA_RECHECK_MS;
  }

  function imageLimitResumeAt(value, now = Date.now()) {
    return isImageLimitText(value) ? quotaResetAt(value, now) : null;
  }

  function imageLimitFallbackResumeAt(value, now = Date.now()) {
    return isImageLimitText(value) ? Number(now) + QUOTA_RECHECK_MS : null;
  }

  globalThis.WatchQuotaUtils = Object.freeze({
    isUploadLimitText, isStorageLimitText, isImageLimitText,
    quotaResetAt, uploadLimitResumeAt, imageLimitResumeAt, imageLimitFallbackResumeAt
  });
})();

