const $ = id => document.getElementById(id);
let userId = localStorage.getItem('cat_user_id') || '';
let userName = localStorage.getItem('cat_user_name') || '';
let token = localStorage.getItem('cat_token') || '';

function setSession(user, t) {
  userId = user.id;
  userName = user.display_name || user.username;
  token = t;
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

// forceNew=true ignora qualquer sessão salva e cria uma conta convidada do
// zero. Sem isso, quem já tinha testado como convidado uma vez ficava PRESO
// nessa mesma conta pra sempre nesse navegador: clicar em "criar conta
// convidada" com um nome novo não fazia nada, porque a função via que já
// existia token e devolvia a conta antiga sem nem olhar pro nome digitado.
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
  location.href = '/server.html?serverId=' + encodeURIComponent(id) +
    '&userId=' + encodeURIComponent(userId) +
    '&userName=' + encodeURIComponent(userName) +
    '&token=' + encodeURIComponent(token);
};

async function loadServers() {
  if (!token) return;
  try {
    const r = await fetch('/api/servers', { headers: headers() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro');
    $('serversList').innerHTML = (d || []).map(s => `
      <div class="server-card" data-server-id="${s.id}">
        <img class="server-logo" src="/logo.svg" alt="">
        <div class="name">${esc(s.name)}</div>
        <div class="code">Código: ${s.code}</div>
      </div>
    `).join('') || '<p class="hint">Nenhum servidor ainda.</p>';
  } catch (e) {
    console.error(e);
  }
}

// clique nos cards de servidor (delegado — evita onclick inline, que o CSP bloqueia)
$('serversList').addEventListener('click', (e) => {
  const card = e.target.closest('.server-card');
  if (card) enterServer(card.dataset.serverId);
});

async function active() {
  try {
    const r = await fetch('/api/servers/active');
    const d = await r.json();
    if (typeof d.count === 'number') {
      $('activeRooms').textContent = d.count;
      if ($('activeRoomsTop')) $('activeRoomsTop').textContent = d.count;
    }
  } catch (e) {}
}

// Corrige sessão "fantasma": se havia token salvo de um banco antigo
// (ex: recriado no servidor), valida no backend antes de usar; se inválido, limpa.
async function restoreSession() {
  // Retorno do fluxo OAuth do Discord chega como #discord_token=... na URL
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const discordToken = hash.get('discord_token');
  if (discordToken) {
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const r = await fetch('/auth/verify', { headers: { Authorization: 'Bearer ' + discordToken } });
      const d = await r.json();
      if (r.ok) { setSession(d.user, discordToken); await loadServers(); return; }
    } catch (e) {}
  }
  const params = new URLSearchParams(location.search);
  const discordError = params.get('discordError');
  if (discordError) {
    history.replaceState(null, '', location.pathname);
    toast('Não foi possível entrar com Discord. Tente novamente.', 'error');
  }
  if (!token) return;
  try {
    const r = await fetch('/auth/verify', { headers: headers() });
    if (!r.ok) throw new Error('sessão inválida');
    await loadServers();
  } catch (e) {
    // Token salvo não existe mais no banco (ex: banco recriado) — limpa a sessão travada.
    userId = ''; userName = ''; token = '';
    localStorage.removeItem('cat_user_id');
    localStorage.removeItem('cat_user_name');
    localStorage.removeItem('cat_token');
  }
}

$('guestBtn').onclick = () => {
  $('guestForm').hidden = !$('guestForm').hidden;
  if (!$('guestForm').hidden) $('guestName').focus();
};

$('guestGo').onclick = async () => {
  try {
    // forceNew: true — clicar aqui é uma intenção explícita de criar uma
    // conta convidada (nova), então sempre gera uma nova, mesmo se já
    // havia uma salva neste navegador.
    await ensureGuest($('guestName').value.trim(), true);
    $('guestForm').hidden = true;
    await loadServers();
    toast('🐱 Conta criada!', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

$('discordBtn').onclick = () => { location.href = '/auth/discord'; };

$('createServerBtn').onclick = async () => {
  try {
    await ensureGuest();
    const name = $('serverName').value.trim() || 'Cat Empire';
    const r = await fetch('/api/servers', { method: 'POST', headers: headers(), body: JSON.stringify({ name }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro ao criar servidor');
    await loadServers();
    toast('🐱 Servidor criado! Código: ' + d.code, 'success');
    enterServer(d.id);
  } catch (e) { toast(e.message, 'error'); }
};

$('joinServerBtn').onclick = async () => {
  const code = $('joinCode').value.trim();
  if (!/^\d{6}$/.test(code)) return toast('Digite um código de 6 dígitos.', 'error');
  try {
    await ensureGuest();
    const r = await fetch('/api/servers/code/' + encodeURIComponent(code), { headers: headers() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Servidor não encontrado');
    const j = await fetch('/api/servers/' + d.id + '/join', { method: 'POST', headers: headers() });
    const jd = await j.json();
    if (!j.ok) throw new Error(jd.error || 'Não foi possível entrar');
    enterServer(d.id);
  } catch (e) { toast(e.message, 'error'); }
};

active();
setInterval(active, 30000);
restoreSession();
