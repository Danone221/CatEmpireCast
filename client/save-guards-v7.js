(() => {
  'use strict';

  function wrapSave(id, busyText) {
    const button = document.getElementById(id);
    if (!button || button.dataset.saveGuardV7) return;
    const original = button.onclick;
    if (typeof original !== 'function') return;

    button.dataset.saveGuardV7 = '1';
    button.onclick = async function (...args) {
      if (button.dataset.saving === '1') return;
      button.dataset.saving = '1';
      const oldText = button.textContent;
      const oldDisabled = button.disabled;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = busyText;
      try {
        return await original.apply(this, args);
      } finally {
        button.dataset.saving = '0';
        button.disabled = oldDisabled;
        button.removeAttribute('aria-busy');
        button.textContent = oldText;
      }
    };
  }

  const bind = () => {
    wrapSave('saveEditProfileBtn', 'Salvando…');
    wrapSave('saveServerSettingsBtn', 'Salvando…');
    wrapSave('saveVideoSettingsBtn', 'Salvando…');
    wrapSave('categorySaveBtn', 'Salvando…');
    wrapSave('v3Save', 'Salvando…');
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(bind, 500), { once: true });
  else setTimeout(bind, 500);
  window.addEventListener('load', () => setTimeout(bind, 500), { once: true });
})();
