(() => {
  'use strict';
  if (window.__catMessageInteractionV9) return;
  window.__catMessageInteractionV9 = true;

  const style = document.createElement('style');
  style.textContent = `
    .cat-v5-actions button:not([data-more]){display:none!important}
    .cat-v5-actions button[data-more]{display:grid!important;place-items:center;width:38px;height:34px;padding:0!important;font-size:0!important}
    .cat-v5-actions button[data-more]::before{content:'☺';font:20px/1 "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif}
    .cat-v5-actions{padding:3px!important}
  `;
  document.head.appendChild(style);

  function normalizeActions(root = document) {
    root.querySelectorAll?.('.cat-v5-actions').forEach(actions => {
      const trigger = actions.querySelector('button[data-more]');
      if (!trigger) return;
      trigger.setAttribute('aria-label', 'Adicionar reação');
      trigger.setAttribute('title', 'Adicionar reação');
      trigger.dataset.interactionTrigger = '1';
    });
  }

  const list = document.getElementById('messagesList');
  if (list) {
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node.nodeType === 1) normalizeActions(node);
      }
      normalizeActions(list);
    }).observe(list, { childList: true, subtree: true });
  }
  normalizeActions();

  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-interaction-trigger]');
    document.querySelectorAll('.message.cat-v5-hold').forEach(message => {
      if (!trigger || !message.contains(trigger)) message.classList.remove('cat-v5-hold');
    });
    if (trigger) setTimeout(() => trigger.closest('.message')?.classList.remove('cat-v5-hold'), 0);
  });
})();
