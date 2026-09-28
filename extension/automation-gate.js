(() => {
  const SESSION_KEY = '__watch_automation_tab_v1';
  let enabled = false;
  try {
    const marker = new URL(location.href).searchParams.get('watch_automation');
    enabled = marker === '1' || sessionStorage.getItem(SESSION_KEY) === '1';
    if (marker === '1') sessionStorage.setItem(SESSION_KEY, '1');
  } catch (_) {}
  window.__WATCH_AUTOMATION_ENABLED__ = enabled;
})();
