const $ = id => document.getElementById(id);
let userId = localStorage.getItem('cat_user_id') || '';
let userName = localStorage.getItem('cat_user_name') || '';
localStorage.removeItem('cat_token');

function setSession(user) {
  userId = user.id;
  userName = user.display_name || user.username;
  localStorage.setItem('cat_user_id', userId);
  localStorage.setItem('cat_user_name', userName);
  localStorage.removeItem('cat_token');
}

function headers() {
  return { 'Content-Type': 'application/json' };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

async function ensureGuest(name, forceNew = false) {
  if (!forceNew && userId) {
    try {
      const vr = await fetch('/auth/verify', { headers: headers() });
      if (vr.ok) return true;
    } catch {}
  }
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
  setSession(d.user);
  return true;
}

window.enterServer = id => {
  localStorage.setItem('cat_last_server', id);
  location.href = '/server.html?serverId=' + encodeURIComponent(id);
};

async function loadServers() {
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

// clique nos cards de servidor
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

  // Se não há servidor salvo, vai direto para a tela de DMs (que tem a rail lateral de servidores)
  location.href = '/dms.html';
}

async function restoreSession() {
  if (location.hash || new URLSearchParams(location.search).has('token')) {
    const cleanUrl = new URL(location.href);
    cleanUrl.hash = '';
    cleanUrl.searchParams.delete('token');
    history.replaceState(null, '', cleanUrl.pathname + (cleanUrl.search ? cleanUrl.search : ''));
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
    setSession(d.user);
    await resumeUserDestination();
  } catch {
    userId = '';
    userName = '';
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
