(async function() {
  const $ = id => document.getElementById(id);

  function getInviteCode() {
    const searchCode = new URLSearchParams(location.search).get('code');
    if (searchCode && searchCode.trim()) return searchCode.trim();

    const parts = location.pathname.split('/');
    const invIdx = parts.findIndex(p => p === 'invite' || p === 'invite.html');
    if (invIdx >= 0 && parts[invIdx + 1] && parts[invIdx + 1].trim()) {
      return parts[invIdx + 1].trim().split('?')[0];
    }
    const last = (parts[parts.length - 1] || '').trim().split('?')[0];
    if (last && last !== 'invite' && last !== 'invite.html') return last;
    return '';
  }

  const code = getInviteCode();

  if (!code) {
    showError('Nenhum código de convite informado na URL.');
    return;
  }

  let token = localStorage.getItem('cat_token');
  let userId = localStorage.getItem('cat_user_id');

  function headers() {
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  }

  function applyBannerStyle(el, banner) {
    if (!el) return;
    if (banner && /^(data:|https?:)/.test(banner)) {
      el.style.backgroundImage = 'url("' + banner + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    } else {
      el.style.backgroundImage = 'none';
      el.style.backgroundColor = banner || '#5865f2';
    }
  }

  function showError(msg) {
    $('inviteLoading').hidden = true;
    $('inviteContent').hidden = true;
    $('inviteError').hidden = false;
    $('inviteErrorText').textContent = msg;
  }

  try {
    const r = await fetch('/api/invites/' + encodeURIComponent(code), { headers: headers() });
    const d = await r.json();
    if (!r.ok) {
      showError(d.error || 'Convite inválido ou expirado.');
      return;
    }

    $('inviteLoading').hidden = true;
    $('inviteContent').hidden = false;

    if (d.creatorName) {
      $('inviteInviter').textContent = d.creatorName + ' convidou você para entrar em';
    } else {
      $('inviteInviter').textContent = 'VOCÊ FOI CONVIDADO PARA ENTRAR EM';
    }
    $('inviteServerName').textContent = d.serverName || 'Servidor';
    
    if (d.serverDescription && d.serverDescription.trim()) {
      $('inviteDescription').hidden = false;
      $('inviteDescription').textContent = d.serverDescription.trim();
    } else {
      $('inviteDescription').hidden = true;
    }

    $('inviteMembers').textContent = (d.memberCount || 1) + (d.memberCount === 1 ? ' Membro' : ' Membros');

    applyBannerStyle($('inviteBanner'), d.serverBannerColor || '#5865f2');

    const isImg = d.serverIcon && /^(https?:|data:)/.test(d.serverIcon);
    if (isImg) {
      $('inviteIconWrap').innerHTML = '<img src="' + d.serverIcon + '" alt="" style="width:100%;height:100%;object-fit:cover">';
    } else {
      $('inviteIconWrap').innerHTML = '<span id="inviteIcon">' + (d.serverIcon || '🐱') + '</span>';
    }

    if (d.isMember) {
      $('acceptInviteBtn').textContent = 'VOCÊ JÁ ESTÁ NO SERVIDOR — ABRIR';
      $('acceptInviteBtn').onclick = () => {
        localStorage.setItem('cat_last_server', d.serverId);
        location.href = '/server.html?serverId=' + encodeURIComponent(d.serverId);
      };
      return;
    }

    if (!token || !userId) {
      $('inviteActions').hidden = true;
      $('inviteAuth').hidden = false;
    } else {
      $('acceptInviteBtn').onclick = () => joinServer(code);
    }

    $('inviteDiscordBtn').onclick = () => {
      localStorage.setItem('cat_pending_invite', code);
      location.href = '/auth/discord';
    };

    $('guestJoinBtn').onclick = async () => {
      const clean = ($('guestName').value.trim() || 'Cat' + Math.random().toString(36).slice(2, 7)).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16) || 'Cat';
      const password = crypto.randomUUID() + 'Aa1!';
      const username = (clean.toLowerCase() + '_' + Math.random().toString(36).slice(2, 7)).slice(0, 30);
      try {
        const rReg = await fetch('/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, displayName: clean })
        });
        const dReg = await rReg.json();
        if (!rReg.ok) throw new Error(dReg.error || 'Erro ao criar conta');
        token = dReg.token;
        userId = dReg.user.id;
        localStorage.setItem('cat_user_id', userId);
        localStorage.setItem('cat_user_name', dReg.user.display_name || dReg.user.username);
        localStorage.setItem('cat_token', token);
        await joinServer(code);
      } catch (e) {
        if (window.toast) toast(e.message, 'error');
        else alert(e.message);
      }
    };

  } catch (e) {
    showError(e.message || 'Erro ao carregar convite.');
  }

  async function joinServer(invCode) {
    try {
      const r = await fetch('/api/invites/' + encodeURIComponent(invCode) + '/join', {
        method: 'POST',
        headers: headers()
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Não foi possível entrar no servidor');
      localStorage.setItem('cat_last_server', d.serverId);
      location.href = '/server.html?serverId=' + encodeURIComponent(d.serverId);
    } catch (e) {
      if (window.toast) toast(e.message, 'error');
      else alert(e.message);
    }
  }
})();