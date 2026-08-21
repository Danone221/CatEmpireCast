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

  // ========== MODAL UNIFICADO "+": CRIAR OU ENTRAR VIA CONVITE ==========
  window.openAddServerModal = function () {
    let overlay = document.getElementById('globalAddServerModal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'globalAddServerModal';
      overlay.className = 'modal';
      overlay.innerHTML =
        '<div class="modal-box">' +
          '<div class="type-toggle" style="margin-bottom:18px">' +
            '<button type="button" class="type-opt active" id="tabCreateServerBtn">＋ Criar Servidor</button>' +
            '<button type="button" class="type-opt" id="tabJoinInviteBtn">🔗 Entrar com Convite</button>' +
          '</div>' +
          '<div id="paneCreateServer">' +
            '<p class="modal-hint">Dê um nome ao seu novo servidor:</p>' +
            '<input type="text" id="addServerNameInput" placeholder="Nome do servidor (ex: Império dos Gatos)" maxlength="40">' +
            '<div class="modal-actions">' +
              '<button type="button" class="btn" id="closeAddServerBtn1">Cancelar</button>' +
              '<button type="button" class="btn btn-primary" id="confirmCreateServerBtn">Criar Servidor</button>' +
            '</div>' +
          '</div>' +
          '<div id="paneJoinInvite" hidden>' +
            '<p class="modal-hint">Cole o link completo ou o código do convite:</p>' +
            '<input type="text" id="addInviteInput" placeholder="https://catempire.cast/invite/... ou código">' +
            '<div class="modal-actions">' +
              '<button type="button" class="btn" id="closeAddServerBtn2">Cancelar</button>' +
              '<button type="button" class="btn btn-primary" id="confirmJoinInviteBtn">Entrar no Servidor</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);

      const tabCreate = overlay.querySelector('#tabCreateServerBtn');
      const tabJoin = overlay.querySelector('#tabJoinInviteBtn');
      const paneCreate = overlay.querySelector('#paneCreateServer');
      const paneJoin = overlay.querySelector('#paneJoinInvite');
      const inputName = overlay.querySelector('#addServerNameInput');
      const inputInvite = overlay.querySelector('#addInviteInput');

      function switchTab(mode) {
        if (mode === 'create') {
          tabCreate.classList.add('active');
          tabJoin.classList.remove('active');
          paneCreate.hidden = false;
          paneJoin.hidden = true;
          inputName.focus();
        } else {
          tabCreate.classList.remove('active');
          tabJoin.classList.add('active');
          paneCreate.hidden = true;
          paneJoin.hidden = false;
          inputInvite.focus();
        }
      }

      tabCreate.onclick = () => switchTab('create');
      tabJoin.onclick = () => switchTab('join');

      function close() {
        overlay.classList.remove('open');
      }

      overlay.querySelector('#closeAddServerBtn1').onclick = close;
      overlay.querySelector('#closeAddServerBtn2').onclick = close;
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

      overlay.querySelector('#confirmCreateServerBtn').onclick = async () => {
        const name = inputName.value.trim() || 'Cat Empire';
        const token = localStorage.getItem('cat_token');
        if (!token) return toast('Sessão expirada. Faça login novamente.', 'error');
        try {
          const r = await fetch('/api/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ name })
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Erro ao criar servidor');
          localStorage.setItem('cat_last_server', d.id);
          close();
          toast('🐱 Servidor criado com sucesso!', 'success');
          location.href = '/server.html?serverId=' + encodeURIComponent(d.id);
        } catch (e) {
          toast(e.message, 'error');
        }
      };

      overlay.querySelector('#confirmJoinInviteBtn').onclick = async () => {
        let raw = inputInvite.value.trim();
        if (!raw) return toast('Cole o link ou código de convite.', 'error');
        const match = raw.match(/invite\/([a-zA-Z0-9_-]+)/);
        const code = match ? match[1] : raw;

        const token = localStorage.getItem('cat_token');
        if (!token) return toast('Sessão expirada. Faça login novamente.', 'error');

        try {
          const r = await fetch('/api/invites/' + encodeURIComponent(code) + '/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Convite inválido ou expirado');
          localStorage.setItem('cat_last_server', d.serverId);
          close();
          toast('🐱 Você entrou no servidor!', 'success');
          location.href = '/server.html?serverId=' + encodeURIComponent(d.serverId);
        } catch (e) {
          toast(e.message, 'error');
        }
      };
    }

    overlay.querySelector('#addServerNameInput').value = '';
    overlay.querySelector('#addInviteInput').value = '';
    overlay.classList.add('open');
    setTimeout(() => overlay.querySelector('#addServerNameInput').focus(), 50);
  };

  // Escuta cliques globais em botões de adicionar servidor (#railAddBtn)
  document.addEventListener('click', (e) => {
    const addBtn = e.target.closest('#railAddBtn, .rail-add');
    if (addBtn) {
      e.preventDefault();
      e.stopPropagation();
      window.openAddServerModal();
    }
  });

  // ========== CORREÇÃO DAS PALETAS DE CORES ==========
  // A paleta é usada tanto no Perfil quanto nas Configurações do Servidor.
  // Forçamos uma grade estável para impedir que os swatches sejam empilhados
  // em uma única coluna quando o modal/flexbox calcula uma largura pequena.
  const paletteStyle = document.createElement('style');
  paletteStyle.id = 'catEmpirePaletteFix';
  paletteStyle.textContent = `
    .color-swatches {
      display: grid !important;
      grid-template-columns: repeat(8, 26px) !important;
      grid-auto-rows: 26px;
      gap: 9px;
      align-content: start;
      justify-content: start;
      width: 100%;
      min-width: 0;
      flex: 1 1 auto !important;
      margin-bottom: 0 !important;
    }

    .color-swatch {
      width: 26px !important;
      height: 26px !important;
      min-width: 26px;
      min-height: 26px;
      display: block !important;
      flex: none !important;
    }

    .color-swatch:hover {
      transform: translateY(-1px);
      border-color: #fff;
      box-shadow: 0 0 8px rgba(181, 107, 255, .45);
    }

    .color-swatch.selected {
      outline: 2px solid #fff;
      outline-offset: 2px;
      box-shadow: 0 0 10px rgba(255, 255, 255, .25);
    }

    @media (max-width: 600px) {
      .color-swatches {
        grid-template-columns: repeat(6, 26px) !important;
        gap: 8px;
      }
    }
  `;
  document.head.appendChild(paletteStyle);
})();
