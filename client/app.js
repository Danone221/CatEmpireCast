const $ = id => document.getElementById(id);
let userId = localStorage.getItem('cat_user_id') || '';
let userName = localStorage.getItem('cat_user_name') || '';
let token = localStorage.getItem('cat_token') || '';

function setSession(user) {
  userId = user.id;
  userName = user.display_name || user.username;
  token = 'cookie';
  localStorage.setItem('cat_user_id', userId);
  localStorage.setItem('cat_user_name', userName);
  localStorage.setItem('cat_token', token);
}

function headers() {
  return { 'Content-Type': 'application/json', ...(token ? { 'Authorization': 'Bearer ' + token } : {}) };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function ensureGuest(name, forceNew = false) {
  if (!forceNew && token && userId) return true;
  const clean = (name || 'Cat' + Math.random().toString(36).slice(2, 7)).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16) || 'Cat';
  const password = crypto.randomUUID() + 'Aa1!';
  const username = (clean.toLowerCase() + '_' + Math.random().toString(36).slice(2, 7)).slice(0, 30);
  const r = await fetch('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, displayName: clean })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Não foi possível criar a conta.');
  setSession(d.user, d.token);
  return true;
}

window.enterServer = id => {
  localStorage.setItem('cat_last_server', id);
  location.href = '/server.html?serverId=' + encodeURIComponent(id);
};

async function loadServers() {
  if (!token) return;
  try {
    const r = await fetch('/api/servers', { headers: headers() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro');
    const el = $('serversList');
    if (el) {
      el.innerHTML = (d || []).map(s => {
        const isImg = s.icon && /^(https?:|data:)/.test(s.icon);
        const iconHtml = isImg
          ? `<img class="server-logo" src="${esc(s.icon)}" alt="">`
          : `<div class="server-logo" style="display:grid;place-items:center;font-size:24px">${esc(s.icon || '🐱')}</div>`;
        return `
          <div class="server-card" data-server-id="${s.id}">
            ${iconHtml}
            <div class="name">${esc(s.name)}</div>
          </div>
        `;
      }).join('');
    }
  } catch (e) {
    console.error(e);
  }
}


if ($('serversList')) {
  $('serversList').addEventListener('click', (e) => {
    const card = e.target.closest('.server-card');
    if (card) enterServer(card.dataset.serverId);
  });
}

async function active() {
  try {
    const r = await fetch('/api/servers/active');
    const d = await r.json();
    if (typeof d.count === 'number') {
      if ($('activeRooms')) $('activeRooms').textContent = d.count;
      if ($('activeRoomsTop')) $('activeRoomsTop').textContent = d.count;
    }
  } catch (e) {}
}

async function resumeUserDestination() {
  const pendingInvite = localStorage.getItem('cat_pending_invite');
  if (pendingInvite) {
    localStorage.removeItem('cat_pending_invite');
    location.href = '/invite/' + encodeURIComponent(pendingInvite);
    return;
  }

  const lastServer = localStorage.getItem('cat_last_server');
  if (lastServer) {
    location.href = '/server.html?serverId=' + encodeURIComponent(lastServer);
    return;
  }


  location.href = '/dms.html';
}

async function restoreSession() {

  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const discordToken = hash.get('discord_token');
  if (discordToken) {
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const r = await fetch('/auth/verify', { headers: { Authorization: 'Bearer ' + discordToken } });
      const d = await r.json();
      if (r.ok) {
        setSession(d.user, discordToken);
        await resumeUserDestination();
        return;
      }
    } catch (e) {}
  }

  const params = new URLSearchParams(location.search);
  const discordError = params.get('discordError');
  if (discordError) {
    history.replaceState(null, '', location.pathname);
    toast('Não foi possível entrar com Discord. Tente novamente.', 'error');
  }

  try {
    const r = await fetch('/auth/verify', { headers: headers() });
    if (!r.ok) throw new Error('sessão inválida');
    const d = await r.json();
    if (d?.user) setSession(d.user);
    await resumeUserDestination();
  } catch (e) {

    userId = ''; userName = ''; token = '';
    localStorage.removeItem('cat_user_id');
    localStorage.removeItem('cat_user_name');
    localStorage.removeItem('cat_token');
    localStorage.removeItem('cat_last_server');
  }
}

$('guestBtn').onclick = () => {
  $('guestForm').hidden = !$('guestForm').hidden;
  if (!$('guestForm').hidden) $('guestName').focus();
};

function setGuestButtonLoading(loading) {
  const btn = $('guestGo');
  if (!btn) return;
  btn.disabled = loading;
  btn.dataset.loading = loading ? 'true' : 'false';
  btn.setAttribute('aria-busy', loading ? 'true' : 'false');
}

$('guestName').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('guestGo').click();
  }
});

$('guestGo').onclick = async () => {
  if ($('guestGo').disabled) return;
  setGuestButtonLoading(true);
  try {
    await ensureGuest($('guestName').value.trim(), true);
    toast('🐱 Conta criada!', 'success');
    await resumeUserDestination();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    setGuestButtonLoading(false);
  }
};

$('discordBtn').onclick = () => { location.href = '/auth/discord'; };

active();
setInterval(active, 30000);
restoreSession();
