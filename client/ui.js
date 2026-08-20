(function () {
  function ensureToastContainer() {
    let c = document.getElementById('toastContainer');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toastContainer';
      c.className = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  window.toast = function (message, type) {
    const c = ensureToastContainer();
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');
    el.textContent = message;
    c.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    }, 3600);
  };

  window.uiConfirm = function (message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML =
        '<div class="confirm-box">' +
          '<p class="confirm-msg"></p>' +
          '<div class="confirm-actions">' +
            '<button type="button" class="btn confirm-cancel">Cancelar</button>' +
            '<button type="button" class="btn btn-primary confirm-ok">Confirmar</button>' +
          '</div>' +
        '</div>';
      overlay.querySelector('.confirm-msg').textContent = message;
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('show'));

      function close(result) {
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 200);
        resolve(result);
      }

      overlay.querySelector('.confirm-cancel').addEventListener('click', () => close(false));
      overlay.querySelector('.confirm-ok').addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(false); }
      });
    });
  };
})();
