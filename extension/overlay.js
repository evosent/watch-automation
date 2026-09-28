(() => {
  if (window.__WATCH_AUTOMATION_ENABLED__ !== true) return;
  async function highlightTarget(element, { label = 'Action', color = '#ff2b2b', duration = 750 } = {}) {
    if (!(element instanceof Element)) return;
    const rect = element.getBoundingClientRect();
    const box = document.createElement('div');
    box.setAttribute('data-watch-automation-overlay', 'true');
    Object.assign(box.style, {
      position: 'fixed', left: `${Math.max(0, rect.left - 5)}px`, top: `${Math.max(0, rect.top - 5)}px`,
      width: `${rect.width + 10}px`, height: `${rect.height + 10}px`, border: `3px solid ${color}`,
      borderRadius: '12px', boxShadow: `0 0 0 4px rgba(255,43,43,.18)`, zIndex: '2147483647',
      pointerEvents: 'none', transition: 'opacity .2s ease'
    });
    const tag = document.createElement('div');
    tag.textContent = label;
    Object.assign(tag.style, {
      position: 'fixed', left: `${Math.max(8, rect.left)}px`, top: `${Math.max(8, rect.top - 34)}px`,
      background: color, color: '#fff', font: '600 12px system-ui, sans-serif', padding: '5px 8px',
      borderRadius: '7px', zIndex: '2147483647', pointerEvents: 'none', maxWidth: '260px'
    });
    document.documentElement.append(box, tag);
    await new Promise((r) => setTimeout(r, duration));
    box.style.opacity = '0'; tag.style.opacity = '0';
    setTimeout(() => { box.remove(); tag.remove(); }, 220);
  }
  window.WatchAutomationOverlay = { highlightTarget };
})();
