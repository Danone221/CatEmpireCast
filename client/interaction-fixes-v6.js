(() => {
  'use strict';

  const run = () => {
    // Do not overwrite or null native room.js handlers. The previous version
    // accidentally removed serverSettingsBtn.onclick, which made the button
    // appear dead.

    // Clean only duplicate legacy UI that may still exist in an already-open
    // page. The canonical runtime creates its own v5 controls.
    document.querySelectorAll('.cat-actions,.cat-reactions,.cat-reaction-picker,.cat-mention-box').forEach(el => el.remove());
    document.querySelectorAll('.cat-v5-friends').forEach((el, i) => { if (i > 0) el.remove(); });
    document.querySelectorAll('.dm-friends-panel').forEach((el, i) => { if (i > 0) el.remove(); });

    const mentionBoxes = document.querySelectorAll('.cat-v5-mention-box');
    mentionBoxes.forEach((box, index) => { if (index > 0) box.remove(); });
    const mention = document.querySelector('.cat-v5-mention-box');
    if (mention) {
      mention.style.left = '0';
      mention.style.right = '0';
      mention.style.bottom = 'calc(100% + 6px)';
      mention.style.top = 'auto';
    }

    // Keep legacy PATCH role calls compatible with the current PUT endpoint.
    if (!window.__catEmpireFetchV6) {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : input?.url || '';
        const method = String(init?.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();
        if (method === 'PATCH' && /\/api\/platform\/servers\/[^/]+\/roles\/[^/?]+(?:\?|$)/.test(url)) {
          init = { ...init, method: 'PUT' };
        }
        return nativeFetch(input, init);
      };
      window.__catEmpireFetchV6 = true;
    }
  };

  const start = () => setTimeout(run, 900);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
