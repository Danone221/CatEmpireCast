(() => {
  'use strict';

  const run = () => {
    const serverSettingsBtn = document.getElementById('serverSettingsBtn');

    // The runtime-v5 settings UI is the canonical settings surface.
    // Older enhancement layers assign onclick handlers later, which causes two
    // settings overlays to open from one click. Remove only the legacy property
    // handler; runtime-v5 uses addEventListener and remains intact.
    if (serverSettingsBtn) serverSettingsBtn.onclick = null;

    // Keep one message interaction toolbar and one mention surface.
    // runtime-v5 + mentions-v5 are the active layers; v4-final is legacy.
    document.querySelectorAll('.cat-actions,.cat-reactions,.cat-reaction-picker,.cat-mention-box').forEach(el => el.remove());
    document.querySelectorAll('.cat-v5-friends').forEach((el, i) => { if (i > 0) el.remove(); });
    document.querySelectorAll('.dm-friends-panel').forEach(el => el.remove());

    // Normalize the mention popup after legacy CSS has loaded.
    const mentionBoxes = document.querySelectorAll('.cat-v5-mention-box');
    mentionBoxes.forEach((box, index) => { if (index > 0) box.remove(); });
    const mention = document.querySelector('.cat-v5-mention-box');
    if (mention) {
      mention.style.left = '0';
      mention.style.right = '0';
      mention.style.bottom = 'calc(100% + 6px)';
      mention.style.top = 'auto';
    }

    // runtime-v5 expects PUT for role updates; keep the backend contract stable
    // if a legacy layer still emits PATCH for a role endpoint.
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

    // Prevent legacy delegated member-profile handlers from racing the
    // canonical profile implementation. Use the final profile once.
    const membersList = document.getElementById('membersList');
    if (membersList && !membersList.dataset.catProfileV6) {
      membersList.dataset.catProfileV6 = '1';
      membersList.addEventListener('click', event => {
        const target = event.target.closest('[data-user-id]');
        if (!target) return;
        event.stopImmediatePropagation();
        window.openProfile?.(target.dataset.userId);
      }, true);
    }

    // Always use the current window-level profile handler for the user's own
    // profile. This avoids the old onclick property bypassing profile-v4.
    ['myAvatarBtn', 'myInfoBtn', 'userSettingsBtn'].forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.dataset.catOwnProfileV6) return;
      el.dataset.catOwnProfileV6 = '1';
      el.addEventListener('click', event => {
        event.stopImmediatePropagation();
        window.openMyProfile?.();
      }, true);
    });

    // Re-apply the single settings handler after any late legacy layer.
    if (serverSettingsBtn) serverSettingsBtn.onclick = null;
  };

  const start = () => setTimeout(run, 1200);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
  window.addEventListener('load', () => setTimeout(run, 1200), { once: true });
})();
