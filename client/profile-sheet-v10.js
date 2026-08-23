(() => {
  'use strict';
  if (window.__catProfileSheetV10) return;
  window.__catProfileSheetV10 = true;

  const toastMessage = (message, type = 'success') => {
    if (typeof window.toast === 'function') window.toast(message, type);
  };

  async function copyText(value, label) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toastMessage(label + ' copiado.');
    } catch (_) {
      toastMessage('Não foi possível copiar.', 'error');
    }
  }

  function closeMenus(except) {
    document.querySelectorAll('.profile-sheet-menu').forEach(menu => {
      if (menu !== except) menu.hidden = true;
    });
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-profile-menu-trigger]');
    if (trigger) {
      event.preventDefault();
      event.stopPropagation();
      const sheet = trigger.closest('.profile-sheet');
      const menu = sheet?.querySelector('.profile-sheet-menu');
      if (!menu) return;
      const willOpen = menu.hidden;
      closeMenus(menu);
      menu.hidden = !willOpen;
      trigger.setAttribute('aria-expanded', String(willOpen));
      return;
    }

    const action = event.target.closest('[data-profile-sheet-action]');
    if (action) {
      const modal = action.closest('.profile-sheet-modal');
      const menu = action.closest('.profile-sheet-menu');
      const kind = action.dataset.profileSheetAction;
      if (kind === 'copy-username') {
        const username = modal?.querySelector('.profile-username')?.textContent?.trim();
        copyText(username, 'Username');
      } else if (kind === 'copy-id') {
        copyText(modal?.dataset.profileId || '', 'ID');
      } else if (kind === 'close') {
        modal?.classList.remove('open');
      }
      if (menu) menu.hidden = true;
      return;
    }
    if (!event.target.closest('.profile-sheet-menu')) closeMenus();
  });
})();
