const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const serverId = q.get('serverId') || localStorage.getItem('cat_last_server');
const userId = localStorage.getItem('cat_user_id') || q.get('userId');
const userName = localStorage.getItem('cat_user_name') || q.get('userName') || 'Membro';
const token = localStorage.getItem('cat_token') || q.get('token');

if (!userId || !token) { location.href = '/'; }

const socket = io();

let channels = [];
let members = [];
let myRole = 'member';
let selectedTextChannelId = null;
let currentServer = null;
let unreadChannels = new Set();
let onlineUserIds = new Set();
let activeMainView = 'text'; // 'text' | 'voice'
let voiceChannelId = null;   // channel currently connected to voice
let pendingChannelType = 'text';

// ---- Voice/WebRTC state ----
let localStream = null;
let micOn = true;
let camOn = false;
let screenOn = false;
let screenAudioTrack = null; // faixa de áudio da tela (som do jogo/vídeo compartilhado), separada do mic
const VIDEO_SETTINGS_KEY = 'cat_video_settings';
const VIDEO_PROFILES = {
  480: { width: 854, height: 480, bitrate: 1_500_000 },
  720: { width: 1280, height: 720, bitrate: 3_000_000 },
  1080: { width: 1920, height: 1080, bitrate: 5_000_000 }
};
let videoSettings = loadVideoSettings();
const peers = {}; // remoteUserId -> { pc, polite, makingOffer, ignoreOffer }
const nativeScreenOwners = {}; // screen:<userId> -> perfil do autor
const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

$('myName').textContent = userName;
const cachedAvatar = localStorage.getItem('cat_avatar');
if (cachedAvatar && $('myAvatarImg')) $('myAvatarImg').src = cachedAvatar;

(async function loadMyProfileOnStartup() {
  try {
    const r = await fetch('/api/me', { headers: headers() });
    if (!r.ok) return;
    const me = await r.json();
    if (me) {
      if (me.display_name && $('myName')) $('myName').textContent = me.display_name;
      if (me.avatar && $('myAvatarImg')) $('myAvatarImg').src = me.avatar;
      if (me.avatar) localStorage.setItem('cat_avatar', me.avatar);
      if (me.display_name) localStorage.setItem('cat_user_name', me.display_name);
    }
  } catch (e) {}
})();

function headers() {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// Formatação estilo Discord: aplica DEPOIS de esc() escapar o HTML, então
// é seguro — nunca opera em texto não-escapado.
function renderMarkdown(escapedText) {
  let t = escapedText;
  // Blocos de código ```...``` (antes de tudo, pra não formatar por dentro)
  const blocks = [];
  t = t.replace(/```([\s\S]+?)```/g, (_, code) => {
    blocks.push(code);
    return `\u0000CODEBLOCK${blocks.length - 1}\u0000`;
  });
  // Código inline `texto`
  t = t.replace(/`([^`\n]+?)`/g, '<code class="inline-code">$1</code>');
  // Negrito **texto**
  t = t.replace(/\*\*([^\*\n]+?)\*\*/g, '<b>$1</b>');
  // Itálico *texto* ou _texto_
  t = t.replace(/(?:\*([^\*\n]+?)\*|_([^_\n]+?)_)/g, (_, a, b) => `<i>${a || b}</i>`);
  // Riscado ~~texto~~
  t = t.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  // Links http(s)://
  t = t.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  // Devolve os blocos de código guardados
  t = t.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => `<pre class="code-block">${blocks[Number(i)]}</pre>`);
  return t;
}

async function loadServersRail() {
  try {
    const r = await fetch('/api/servers', { headers: headers() });
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list)) renderServerRail(list);
    }
  } catch (e) {}
}

let hadConnectedBefore = false;
socket.on('connect', () => {
  socket.emit('register', { userId, token, serverId });
  loadServersRail();
  if (selectedTextChannelId) socket.emit('join-text-channel', { channelId: selectedTextChannelId });
  
  if (voiceChannelId) {
    // Corrigindo a reconexão do canal de voz
    if (hadConnectedBefore) {
      Object.keys(peers).forEach(closePeer);
      if (camOn) { camOn = false; updateCamButton(); removeCurrentVideoTrack(); }
      if (screenOn) { screenOn = false; updateScreenButton(); removeCurrentVideoTrack(); }
      renderVoiceGrid();
    }
    socket.emit('join-voice-channel', { channelId: voiceChannelId });
  }
  hadConnectedBefore = true;
});

socket.on('disconnect', () => {
  if (voiceChannelId) toast('Conexão perdida, reconectando…', 'error');
});
socket.on('error', d => console.error(d));

// Alguém novo entrou no servidor
socket.on('member-joined', (member) => {
  if (!member || members.some(m => m.id === member.id)) return;
  members.push(member);
  renderMembers();
  if (voiceChannelId) renderVoiceGrid();
});

// ===== Presença online/offline (bolinha verde/cinza estilo Discord) =====
socket.on('presence-list', (ids) => {
  onlineUserIds = new Set(ids || []);
  renderMembers();
  updateServerProfileCounts();
});
socket.on('presence-update', ({ userId: uid, online }) => {
  if (online) onlineUserIds.add(uid); else onlineUserIds.delete(uid);
  renderMembers();
  updateServerProfileCounts();
});

// ========== BARRA DE SERVIDORES (estilo Discord) ==========
socket.on('servers-list', (list) => {
  renderServerRail(list || []);
});

function switchServer(id) {
  if (id === serverId) return;
  localStorage.setItem('cat_last_server', id);
  location.href = '/server.html?serverId=' + encodeURIComponent(id);
}

function renderServerRail(list) {
  if (!$('railServers')) return;
  $('railServers').innerHTML = (list || []).map(s => {
    const active = s.id === serverId ? ' active' : '';
    const isImg = s.icon && /^(https?:|data:)/.test(s.icon);
    const inner = isImg
      ? `<img src="${esc(s.icon)}" alt="" style="width:100%;height:100%;object-fit:cover">`
      : esc(s.icon || (s.name || '?').trim().slice(0, 2).toUpperCase());
    return `<div class="rail-icon${active}" data-server-id="${esc(s.id)}" title="${esc(s.name || 'Servidor')}">${inner}</div>`;
  }).join('');
  $('railServers').querySelectorAll('[data-server-id]').forEach(el => {
    el.onclick = () => switchServer(el.dataset.serverId);
  });
}

$('railHomeBtn').onclick = () => {
  location.href = '/dms.html';
};
$('railAddBtn').onclick = () => { window.openAddServerModal(); };

// Badge de DMs não lidas no ícone que agora leva pras mensagens privadas.
async function refreshDmBadge() {
  try {
    const r = await fetch('/api/dms/unread-count', { headers: headers() });
    const d = await r.json();
    if (r.ok) {
      $('dmUnreadBadge').hidden = !d.count;
      $('dmUnreadBadge').textContent = d.count > 9 ? '9+' : d.count;
    }
  } catch (e) {}
}
refreshDmBadge();
socket.on('new-dm', (msg) => { if (msg.recipient_id === userId) refreshDmBadge(); });

// ========== CARREGAR SERVIDOR ==========
async function load() {
  if (!serverId || !token) { location.href = '/'; return; }
  try {
    const r = await fetch('/api/servers/' + serverId, { headers: headers() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro ao carregar servidor');
    currentServer = d;
    localStorage.setItem('cat_last_server', serverId);
    $('serverName').textContent = d.name || 'Servidor';
    $('serverName').title = d.name || 'Servidor';
    $('serverProfileName').textContent = d.name || 'Servidor';
    $('serverProfileIconImg').src = d.icon && /^(data:|https?:)/.test(d.icon) ? d.icon : '/logo.svg';
    $('mobileTitle').textContent = d.name || 'CAT EMPIRE';
    if (d.banner_color) $('serverHead').style.background = d.banner_color;
    channels = d.channels || [];
    members = d.members || [];
    myRole = d.myRole || 'member';
    const canManageServer = ['admin', 'owner'].includes(myRole);
    $('myRole').textContent = myRole === 'owner' ? 'dono' : ['admin', 'owner'].includes(myRole) ? 'admin' : 'membro';
    $('serverSettingsBtn').hidden = !canManageServer;
    $('serverAdminProfileActions').hidden = !canManageServer;
    renderChannelList();
    renderMembers();
    updateServerProfileCounts();
    const firstText = channels.find(c => c.type === 'text');
    if (firstText) openTextChannel(firstText.id);
    const me = members.find(m => m.id === userId);
    if (me && me.avatar) $('myAvatarImg').src = me.avatar;
  } catch (e) {
    toast(e.message, 'error');
    localStorage.removeItem('cat_last_server');
    location.href = '/dms.html';
  }
}

// ========== SIDEBAR: CANAIS ==========
function renderChannelList() {
  const byCategory = {};
  for (const c of channels) {
    const cat = c.category || (c.type === 'voice' ? 'CANAIS DE VOZ' : 'CANAIS');
    (byCategory[cat] = byCategory[cat] || []).push(c);
  }
  const cats = Object.keys(byCategory);
  $('channelList').innerHTML = cats.map(cat => `
    <div class="channel-category">
      <div class="channel-cat-header">
        <span>${esc(cat)}</span>
        ${['admin', 'owner'].includes(myRole) ? `<button class="add-channel-btn" data-cat="${esc(cat)}" data-type="${byCategory[cat][0].type === 'voice' ? 'voice' : 'text'}" title="Criar canal">＋</button>` : ''}
      </div>
      ${byCategory[cat].map(c => channelItemHtml(c)).join('')}
    </div>
  `).join('') + (['admin', 'owner'].includes(myRole) ? `<button class="add-channel-btn add-channel-generic" id="addChannelGeneric">＋ Criar canal</button>` : '');

  document.querySelectorAll('.channel-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('del-btn')) return;
      const id = el.dataset.id, type = el.dataset.type;
      if (type === 'voice') joinVoiceChannel(id); else openTextChannel(id);
      closeMobileSidebar();
    });
  });
  document.querySelectorAll('.del-btn').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(await uiConfirm('Excluir este canal?'))) return;
      try {
        const r = await fetch('/api/servers/' + serverId + '/channels/' + el.dataset.id, { method: 'DELETE', headers: headers() });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Erro ao excluir canal');
        channels = channels.filter(c => c.id !== el.dataset.id);
        renderChannelList();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  document.querySelectorAll('.add-channel-btn[data-cat]').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); openCreateChannelModal(el.dataset.type); });
  });
  $('addChannelGeneric')?.addEventListener('click', () => openCreateChannelModal('text'));
}

function channelItemHtml(c) {
  const icon = c.type === 'voice' ? '🔊' : '#';
  const isActiveText = activeMainView === 'text' && c.id === selectedTextChannelId;
  const isActiveVoice = c.id === voiceChannelId;
  const active = isActiveText || (activeMainView === 'voice' && isActiveVoice);
  const unread = c.type === 'text' && unreadChannels.has(c.id) ? ' has-unread' : '';
  return `<div class="channel-item ${active ? 'active' : ''}${unread}" data-id="${c.id}" data-type="${c.type}">
    <span class="icon">${icon}</span><span class="cname">${esc(c.name)}</span>
    ${unread ? '<span class="unread-dot" title="Mensagens não lidas"></span>' : ''}
    ${c.type === 'voice' && c.id === voiceChannelId ? '<span class="live-dot" title="Conectado"></span>' : ''}
    ${['admin', 'owner'].includes(myRole) ? `<button class="del-btn" data-id="${c.id}" title="Excluir">✕</button>` : ''}
  </div>`;
}

// ========== SIDEBAR: MEMBROS ==========
function renderMembers() {
  $('memberCount').textContent = members.length;
  $('membersList').innerHTML = members.map(m => `
    <div class="member-row" data-user-id="${esc(m.id)}">
      <div class="m-avatar">
        <img src="${m.avatar || '/logo.svg'}" alt="">
        <span class="presence-dot ${onlineUserIds.has(m.id) ? 'online' : 'offline'}"></span>
      </div>
      <div class="m-name">${esc(m.display_name || m.username)}</div>
      ${m.role === 'admin' ? '<span class="m-badge">ADMIN</span>' : ''}
    </div>
  `).join('');
  $('membersList').querySelectorAll('[data-user-id]').forEach(el => {
    el.addEventListener('click', () => openProfile(el.dataset.userId));
  });
}

// ========== CRIAR CANAL ==========
function openCreateChannelModal(type) {
  pendingChannelType = type || 'text';
  $('newChannelName').value = '';
  setTypeOpt(pendingChannelType);
  $('createChannelModal').classList.add('open');
  $('newChannelName').focus();
}
function setTypeOpt(type) {
  pendingChannelType = type;
  $('typeTextBtn').classList.toggle('active', type === 'text');
  $('typeVoiceBtn').classList.toggle('active', type === 'voice');
}
$('typeTextBtn').onclick = () => setTypeOpt('text');
$('typeVoiceBtn').onclick = () => setTypeOpt('voice');
$('cancelChannelBtn').onclick = () => $('createChannelModal').classList.remove('open');
$('confirmChannelBtn').onclick = async () => {
  const name = $('newChannelName').value.trim();
  if (!name) return toast('Digite um nome para o canal.', 'error');
  try {
    const r = await fetch('/api/servers/' + serverId + '/channels', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ name, type: pendingChannelType })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro ao criar canal');
    channels.push(d);
    renderChannelList();
    $('createChannelModal').classList.remove('open');
  } catch (e) { toast(e.message, 'error'); }
};

// ========== PERFIL DO SERVIDOR ==========
function updateServerProfileCounts(){
  if($('serverOnlineCount')) $('serverOnlineCount').textContent=members.filter(m=>onlineUserIds.has(m.id)).length;
  if($('serverTotalCount')) $('serverTotalCount').textContent=members.length;
}
function closeServerProfile(){
  $('serverProfileModal')?.classList.remove('open');
  $('serverProfileBtn')?.setAttribute('aria-expanded','false');
}
$('serverProfileBtn')?.addEventListener('click',()=>{
  updateServerProfileCounts();
  $('serverProfileModal')?.classList.add('open');
  $('serverProfileBtn').setAttribute('aria-expanded','true');
});
$('closeServerProfileBtn')?.addEventListener('click',closeServerProfile);
$('serverProfileModal')?.addEventListener('click',e=>{if(e.target===$('serverProfileModal'))closeServerProfile();});
$('serverNotificationsBtn')?.addEventListener('click',()=>toast('Notificações do servidor seguem as configurações da sua conta.','success'));
$('markServerReadBtn')?.addEventListener('click',()=>{unreadChannels.clear();renderChannelList();toast('Servidor marcado como lido.','success');closeServerProfile();});
$('serverChannelsRolesBtn')?.addEventListener('click',()=>{closeServerProfile();$('serverSettingsBtn')?.click();});
$('profileCreateChannelBtn')?.addEventListener('click',()=>{closeServerProfile();openCreateChannelModal('text');});
$('profileCreateCategoryBtn')?.addEventListener('click',()=>{closeServerProfile();$('serverSettingsBtn')?.click();toast('Abra Canais e Categorias para criar uma categoria.','success');});
$('profileEditServerBtn')?.addEventListener('click',()=>{closeServerProfile();$('serverSettingsBtn')?.click();});
$('leaveServerFromProfileBtn')?.addEventListener('click',async()=>{
 const ok=await uiConfirm('Sair deste servidor?');if(!ok)return;
 try{const r=await fetch('/api/servers/'+serverId+'/members/me',{method:'DELETE',headers:headers()});const d=await r.json();if(!r.ok)throw new Error(d.error||'Erro ao sair');localStorage.removeItem('cat_last_server');location.href='/dms.html';}catch(e){toast(e.message,'error');}
});

// ========== MOBILE SIDEBAR ==========
$('hamburgerBtn').onclick = () => {
  $('membersSidebar')?.classList.remove('mobile-open');
  $('membersToggleBtn')?.setAttribute('aria-expanded', 'false');
  $('mobileDrawer').classList.add('open');
  $('sidebarOverlay').classList.add('open');
};
$('membersToggleBtn')?.addEventListener('click', () => {
  $('mobileDrawer').classList.remove('open');
  const open = !$('membersSidebar').classList.contains('mobile-open');
  $('membersSidebar').classList.toggle('mobile-open', open);
  $('membersToggleBtn').setAttribute('aria-expanded', String(open));
  $('sidebarOverlay').classList.toggle('open', open);
});
$('sidebarOverlay').onclick = closeMobileSidebar;
function closeMobileSidebar() {
  $('mobileDrawer').classList.remove('open');
  $('membersSidebar')?.classList.remove('mobile-open');
  $('membersToggleBtn')?.setAttribute('aria-expanded', 'false');
  $('sidebarOverlay').classList.remove('open');
}

// ========== VIEW SWITCHING ==========
function showView(view) {
  activeMainView = view;
  $('textView').hidden = view !== 'text';
  $('voiceView').hidden = view !== 'voice';
  $('voiceBar').hidden = !(voiceChannelId && view === 'text');
  renderChannelList();
}

// ========== CANAL DE TEXTO ==========
async function openTextChannel(channelId) {
  selectedTextChannelId = channelId;
  unreadChannels.delete(channelId);
  typingUsers.clear();
  renderTypingIndicator();
  const ch = channels.find(c => c.id === channelId);
  $('chatChannelName').textContent = '# ' + (ch ? ch.name : 'canal');
  $('mobileTitle').textContent = ch ? ch.name : 'CAT EMPIRE';
  showView('text');
  socket.emit('join-text-channel', { channelId });
  $('messagesList').innerHTML = '<p class="empty-hint">Carregando mensagens…</p>';
  try {
    const r = await fetch('/api/channels/' + channelId + '/messages', { headers: headers() });
    const msgs = await r.json();
    renderMessages(msgs);
  } catch (e) {
    $('messagesList').innerHTML = '<p class="empty-hint">Erro ao carregar mensagens.</p>';
  }
}

function renderMessages(msgs) {
  if (!msgs || !msgs.length) {
    $('messagesList').innerHTML = '<p class="empty-hint">Nenhuma mensagem ainda. Seja o primeiro a escrever!</p>';
    return;
  }
  $('messagesList').innerHTML = msgs.map(messageHtml).join('');
  $('messagesList').scrollTop = $('messagesList').scrollHeight;
}

function messageHtml(m) {
  const time = new Date((m.created_at || 0) * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  let fileHtml = '';
  if (m.file_data && m.file_type && m.file_type.startsWith('image/')) {
    fileHtml = `<img class="message-image" src="${m.file_data}" alt="${esc(m.file_name || 'imagem')}" data-file-url="${m.file_data}">`;
  } else if (m.file_data) {
    fileHtml = `<a class="message-file" href="${m.file_data}" download="${esc(m.file_name || 'arquivo')}">📄 ${esc(m.file_name || 'arquivo')}</a>`;
  }
  const memberInfo = members.find(mem => mem.id === m.user_id);
  const isAdminAuthor = memberInfo && memberInfo.role === 'admin';
  const canManage = m.user_id === userId || myRole === 'admin';
  const editedTag = m.edited_at ? '<span class="message-edited-tag">(editado)</span>' : '';
  const toolbar = canManage ? `<div class="message-toolbar">
      ${m.user_id === userId ? `<button class="msg-tool-btn" data-action="edit" title="Editar">✏️</button>` : ''}
      <button class="msg-tool-btn" data-action="delete" title="Excluir">🗑️</button>
    </div>` : '';
  const messageUserId = m.user_id || m.sender_id || m.author_id || '';
  return `<div class="message" data-message-id="${esc(m.id)}" data-author-id="${esc(messageUserId)}">
    <div class="message-avatar" data-user-id="${esc(messageUserId)}"><img src="${m.avatar || '/logo.svg'}" alt=""></div>
    <div class="message-body">
      <div class="message-head">
        <span class="message-author${isAdminAuthor ? ' author-admin' : ''}" data-user-id="${esc(messageUserId)}">${esc(m.display_name || m.username || 'Membro')}</span>
        <span class="message-time">${time}</span>${editedTag}
      </div>
      <div class="message-content" data-raw="${esc(m.content || '')}">${m.content ? renderMarkdown(esc(m.content)) : ''}</div>
      ${fileHtml}
      ${toolbar}
    </div>
  </div>`;
}

$('messagesList').addEventListener('click', (e) => {
  const img = e.target.closest('.message-image[data-file-url]');
  if (img) { window.open(img.dataset.fileUrl, '_blank'); return; }

  const toolBtn = e.target.closest('.msg-tool-btn');
  if (toolBtn) {
    const msgEl = toolBtn.closest('.message[data-message-id]');
    const messageId = msgEl?.dataset.messageId;
    if (!messageId) return;
    if (toolBtn.dataset.action === 'delete') {
      uiConfirm('Excluir esta mensagem?').then(ok => { if (ok) socket.emit('delete-message', { messageId }); });
    } else if (toolBtn.dataset.action === 'edit') {
      startEditMessage(msgEl, messageId);
    }
    return;
  }

  const who = e.target.closest('[data-user-id]');
  if (who && who.dataset.userId) openProfile(who.dataset.userId);
});

// ---- Edição inline de mensagem ----
function startEditMessage(msgEl, messageId) {
  const contentEl = msgEl.querySelector('.message-content');
  if (!contentEl || msgEl.querySelector('.edit-message-input')) return;
  const raw = contentEl.dataset.raw || '';
  const wrap = document.createElement('div');
  wrap.className = 'edit-message-wrap';
  wrap.innerHTML = `<input type="text" class="edit-message-input" maxlength="2000" value="">
    <div class="edit-message-hint">enter pra salvar · esc pra cancelar</div>`;
  contentEl.replaceWith(wrap);
  const input = wrap.querySelector('.edit-message-input');
  input.value = raw;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  function finish(save) {
    const newContent = input.value.trim();
    wrap.replaceWith(contentEl);
    if (save && newContent && newContent !== raw) {
      socket.emit('edit-message', { messageId, content: newContent });
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

socket.on('message-edited', (msg) => {
  if (msg.channel_id !== selectedTextChannelId) return;
  const el = $('messagesList').querySelector(`.message[data-message-id="${CSS.escape(msg.id)}"]`);
  if (el) el.outerHTML = messageHtml(msg);
});
socket.on('message-deleted', ({ id, channel_id }) => {
  if (channel_id !== selectedTextChannelId) return;
  $('messagesList').querySelector(`.message[data-message-id="${CSS.escape(id)}"]`)?.remove();
});

socket.on('new-message', (msg) => {
  if (msg.channel_id !== selectedTextChannelId) {
    if (channels.some(c => c.id === msg.channel_id && c.type === 'text')) {
      unreadChannels.add(msg.channel_id);
      renderChannelList();
    }
    return;
  }
  const empty = $('messagesList').querySelector('.empty-hint');
  if (empty) empty.remove();
  $('messagesList').insertAdjacentHTML('beforeend', messageHtml(msg));
  $('messagesList').scrollTop = $('messagesList').scrollHeight;
  removeTypingUser(msg.user_id);
});

let pendingFile = null;
$('attachBtn').onclick = () => { $('fileInput').click(); $('attachBtn').blur(); };
$('fileInput').onchange = () => {
  const f = $('fileInput').files[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) { toast('Imagem muito grande (máx. 8MB).', 'error'); $('fileInput').value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    pendingFile = { name: f.name, type: f.type, size: f.size, data: reader.result };
    $('attachPreviewImg').src = reader.result;
    $('attachPreviewName').textContent = f.name;
    $('attachPreview').hidden = false;
    $('attachBtn').disabled = true;
    $('fileInput').blur();
    $('messageInput').focus();
  };
  reader.readAsDataURL(f);
};
$('attachRemoveBtn').onclick = () => {
  pendingFile = null;
  $('fileInput').value = '';
  $('attachPreview').hidden = true;
  $('attachBtn').disabled = false;
};

function sendMessage() {
  const text = $('messageInput').value.trim();
  if (!text && !pendingFile) return;
  if (!selectedTextChannelId) return;
  socket.emit('send-message', { channelId: selectedTextChannelId, message: text, file: pendingFile });
  $('messageInput').value = '';
  pendingFile = null;
  $('fileInput').value = '';
  $('attachPreview').hidden = true;
  $('attachBtn').disabled = false;
  $('messageInput').focus();
  stopTyping();
}

// ---- Indicador "está digitando…" ----
let typingTimeout = null;
let iAmTyping = false;
function stopTyping() {
  if (iAmTyping && selectedTextChannelId) socket.emit('typing-stop', { channelId: selectedTextChannelId });
  iAmTyping = false;
  clearTimeout(typingTimeout);
}
$('messageInput').addEventListener('input', () => {
  if (!selectedTextChannelId) return;
  if (!iAmTyping) {
    iAmTyping = true;
    socket.emit('typing-start', { channelId: selectedTextChannelId });
  }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(stopTyping, 3000);
});

const typingUsers = new Map(); // userId -> userName, só do canal aberto no momento
function renderTypingIndicator() {
  let el = $('typingIndicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'typingIndicator';
    el.className = 'typing-indicator';
    $('textView').insertBefore(el, $('voiceBar').nextSibling);
  }
  const names = Array.from(typingUsers.values());
  if (!names.length) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  const text = names.length === 1
    ? `${names[0]} está digitando…`
    : names.length === 2
      ? `${names[0]} e ${names[1]} estão digitando…`
      : `Várias pessoas estão digitando…`;
  el.textContent = text;
}
function removeTypingUser(userId) {
  if (typingUsers.delete(userId)) renderTypingIndicator();
}
socket.on('user-typing', ({ channelId, userId: uid, userName }) => {
  if (channelId !== selectedTextChannelId || uid === userId) return;
  typingUsers.set(uid, userName || 'Alguém');
  renderTypingIndicator();
});
socket.on('user-stop-typing', ({ channelId, userId: uid }) => {
  if (channelId !== selectedTextChannelId) return;
  removeTypingUser(uid);
});

$('messageInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$('sendBtn').onclick = (e) => { e.preventDefault(); sendMessage(); };
$('messageForm').onsubmit = (e) => {
  e.preventDefault();
  sendMessage();
};

// ========== CANAL DE VOZ / WEBRTC ==========
async function joinVoiceChannel(channelId) {
  if (voiceChannelId === channelId) { showView('voice'); return; }
  if (voiceChannelId) leaveVoiceChannel(false);

  const ch = channels.find(c => c.id === channelId);
  voiceChannelId = channelId;
  $('voiceChannelName').textContent = '🔊 ' + (ch ? ch.name : 'Voz');
  $('voiceBarText').textContent = 'Conectado a 🔊 ' + (ch ? ch.name : 'Voz');
  showView('voice');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    localStream = null;
    toast('Não foi possível acessar o microfone. Você entrará apenas ouvindo.', 'error');
  }
  micOn = !!localStream;
  updateMicButton();

  socket.emit('join-voice-channel', { channelId });
  renderVoiceGrid();
}

function leaveVoiceChannel(switchView = true) {
  if (!voiceChannelId) return;
  socket.emit('leave-voice-channel');
  Object.keys(peers).forEach(closePeer);
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  screenAudioTrack = null;
  stopAllNativeScreenAudio();
  voiceChannelId = null;
  camOn = false;
  screenOn = false;
  micOn = true;
  removeExternalCastTile();
  teardownAllSpeakingDetection();
  $('voiceGrid').innerHTML = '';
  if (switchView) showView('text');
  else { $('voiceBar').hidden = true; renderChannelList(); }
}

$('hangupBtn').onclick = () => leaveVoiceChannel(true);
$('voiceBarLeave').onclick = () => leaveVoiceChannel(false);

$('micBtn').onclick = () => {
  if (!localStream) return;
  micOn = !micOn;
  // Silenciar o microfone não pode silenciar junto o áudio da tela.
  localStream.getAudioTracks().forEach(t => {
    if (t !== screenAudioTrack) t.enabled = micOn;
  });
  updateMicButton();
  socket.emit('voice-media-state', { muted: !micOn, camera: camOn });
};

function removeCurrentVideoTrack() {
  const track = localStream && localStream.getVideoTracks()[0];
  if (!track) return;
  Object.values(peers).forEach(p => {
    const sender = p.pc.getSenders().find(s => s.track === track);
    if (sender) p.pc.removeTrack(sender);
  });
  track.stop();
  localStream.removeTrack(track);
}

function removeScreenAudioTrack() {
  if (!screenAudioTrack) return;
  const track = screenAudioTrack;
  screenAudioTrack = null;
  Object.values(peers).forEach(p => {
    const sender = p.pc.getSenders().find(s => s.track === track);
    if (sender) p.pc.removeTrack(sender);
  });
  track.stop();
  if (localStream) localStream.removeTrack(track);
}

function addVideoTrackToPeers(track) {
  if (!localStream) localStream = new MediaStream();
  localStream.addTrack(track);
  
  // CORREÇÃO: Remove tracks antigas para não duplicar
  const oldVideos = localStream.getVideoTracks();
  oldVideos.forEach(t => {
    if (t !== track) {
      t.stop();
      localStream.removeTrack(t);
    }
  });

  Object.values(peers).forEach(p => p.pc.addTrack(track, localStream));
}

function loadVideoSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIDEO_SETTINGS_KEY));
    const quality = [480, 720, 1080].includes(Number(saved?.quality)) ? Number(saved.quality) : 720;
    const fps = [24, 30, 60].includes(Number(saved?.fps)) ? Number(saved.fps) : 30;
    return { quality, fps, facingMode: saved?.facingMode === 'environment' ? 'environment' : 'user' };
  } catch (_) {
    return { quality: 720, fps: 30, facingMode: 'user' };
  }
}

function cameraConstraints() {
  const profile = VIDEO_PROFILES[videoSettings.quality];
  return {
    audio: false,
    video: {
      facingMode: { ideal: videoSettings.facingMode },
      width: { ideal: profile.width },
      height: { ideal: profile.height },
      frameRate: { ideal: videoSettings.fps, max: videoSettings.fps }
    }
  };
}

async function replaceCameraTrack(newTrack) {
  if (!localStream) localStream = new MediaStream();
  const oldTrack = localStream.getVideoTracks()[0];
  if (!oldTrack) {
    addVideoTrackToPeers(newTrack);
    return;
  }
  await Promise.all(Object.values(peers).map(async (peer) => {
    const sender = peer.pc.getSenders().find(s => s.track === oldTrack);
    if (sender) await sender.replaceTrack(newTrack);
    else peer.pc.addTrack(newTrack, localStream);
  }));
  localStream.removeTrack(oldTrack);
  oldTrack.stop();
  localStream.addTrack(newTrack);
}

function syncCameraControls() {
  $('flipCamBtn').hidden = !camOn;
  $('videoSettingsBtn').classList.toggle('active', camOn);
}

$('camBtn').onclick = async () => {
  if (!camOn) {
    try {
      if (screenOn) { removeCurrentVideoTrack(); screenOn = false; updateScreenButton(); }
      const camStream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
      const track = camStream.getVideoTracks()[0];
      if (!track) throw new Error('Câmera não encontrada.');
      addVideoTrackToPeers(track);
      camOn = true;
      renderVoiceGrid();
      track.addEventListener('ended', () => { camOn = false; updateCamButton(); renderVoiceGrid(); });
    } catch (e) { toast('Não foi possível acessar a câmera.', 'error'); return; }
  } else {
    removeCurrentVideoTrack();
    camOn = false;
    renderVoiceGrid();
  }
  updateCamButton();
  syncCameraControls();
  socket.emit('voice-media-state', { muted: !micOn, camera: camOn, screen: screenOn });
};

$('flipCamBtn').onclick = async () => {
  if (!camOn) return;
  const previousFacing = videoSettings.facingMode;
  videoSettings.facingMode = previousFacing === 'environment' ? 'user' : 'environment';
  try {
    const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('Câmera não encontrada.');
    await replaceCameraTrack(track);
    localStorage.setItem(VIDEO_SETTINGS_KEY, JSON.stringify(videoSettings));
    renderVoiceGrid();
  } catch (e) {
    videoSettings.facingMode = previousFacing;
    toast('Não foi possível virar a câmera neste dispositivo.', 'error');
  }
};

$('screenBtn').onclick = async () => {
  if (!screenOn) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast('Este navegador não suporta compartilhar tela. Tente no Chrome/Brave atualizado.', 'error');
      return;
    }
    try {
      if (camOn) { removeCurrentVideoTrack(); camOn = false; updateCamButton(); }
      // audio:true pede o som da aba/tela também (jogo, vídeo, música etc).
      // Depende do navegador/SO aceitar — se não vier áudio nenhum, a
      // pessoa que está assistindo simplesmente não ouve o som da tela
      // (não quebra nada, só não tem áudio extra).
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        systemAudio: 'include',
        surfaceSwitching: 'include'
      });
      const track = screenStream.getVideoTracks()[0];
      addVideoTrackToPeers(track);

      const screenAudio = screenStream.getAudioTracks()[0];
      if (screenAudio) {
        screenAudioTrack = screenAudio;
        screenAudio.enabled = true;
        if ('contentHint' in screenAudio) screenAudio.contentHint = 'music';
        if (!localStream) localStream = new MediaStream();
        localStream.addTrack(screenAudio);
        Object.values(peers).forEach(p => p.pc.addTrack(screenAudio, localStream));
        screenAudio.addEventListener('ended', () => removeScreenAudioTrack());
      } else {
        toast('O navegador não liberou o áudio desta tela. Ao escolher uma aba, ative “Compartilhar áudio”.', 'error');
      }

      screenOn = true;
      renderVoiceGrid();
      track.addEventListener('ended', () => {
        screenOn = false;
        removeScreenAudioTrack();
        updateScreenButton();
        renderVoiceGrid();
      });
    } catch (e) {
      if (e.name !== 'NotAllowedError') toast('Não foi possível compartilhar a tela.', 'error');
      return;
    }
  } else {
    removeCurrentVideoTrack();
    removeScreenAudioTrack();
    screenOn = false;
    renderVoiceGrid();
  }
  updateScreenButton();
  socket.emit('voice-media-state', { muted: !micOn, camera: camOn, screen: screenOn });
};

function updateMicButton() { $('micBtn').classList.toggle('active', micOn); $('micBtn').textContent = micOn ? '🎤' : '🔇'; }
function updateCamButton() { $('camBtn').classList.toggle('active', camOn); syncCameraControls(); }
function updateScreenButton() { $('screenBtn').classList.toggle('active', screenOn); }

$('videoSettingsBtn').onclick = () => {
  $('videoQualitySelect').value = String(videoSettings.quality);
  $('videoFpsSelect').value = String(videoSettings.fps);
  $('videoSettingsModal').classList.add('open');
};
$('cancelVideoSettingsBtn').onclick = () => $('videoSettingsModal').classList.remove('open');
$('saveVideoSettingsBtn').onclick = async () => {
  const previous = { ...videoSettings };
  const quality = Number($('videoQualitySelect').value);
  const fps = Number($('videoFpsSelect').value);
  videoSettings.quality = [480, 720, 1080].includes(quality) ? quality : 720;
  videoSettings.fps = [24, 30, 60].includes(fps) ? fps : 30;
  try {
    if (camOn) {
      const stream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('Câmera não encontrada.');
      await replaceCameraTrack(track);
      renderVoiceGrid();
    }
    localStorage.setItem(VIDEO_SETTINGS_KEY, JSON.stringify(videoSettings));
    $('videoSettingsModal').classList.remove('open');
    const suffix = nativeBroadcasting ? ' Reinicie a transmissão de tela para aplicar.' : '';
    toast(`${videoSettings.quality}p · ${videoSettings.fps} FPS aplicados.${suffix}`, 'success');
  } catch (error) {
    videoSettings = previous;
    toast('O dispositivo não aceitou essa combinação de qualidade e FPS.', 'error');
  }
};

// ========== CAST EXTERNO ==========
$('mobileCastBtn').onclick = async () => {
  if (!voiceChannelId) return;
  try {
    const r = await fetch('/api/channels/' + voiceChannelId + '/cast-credentials', { headers: headers() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro ao gerar credenciais.');
    $('castRtmpUrl').textContent = d.rtmpUrl;
    $('castStreamKey').textContent = d.streamKey;
    $('castWarning').hidden = !!d.configured;
    $('mobileCastModal').classList.add('open');
  } catch (e) { toast(e.message, 'error'); }
};
$('closeCastModalBtn').onclick = () => $('mobileCastModal').classList.remove('open');
document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const text = $(btn.dataset.copy).textContent;
    navigator.clipboard?.writeText(text).then(() => {
      const original = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => (btn.textContent = original), 1200);
    }).catch(() => toast('Não foi possível copiar.', 'error'));
  });
});

let externalCastPlayer = null;
socket.on('external-cast-live', ({ channelId, playbackUrl }) => {
  if (channelId !== voiceChannelId) return;
  upsertExternalCastTile(playbackUrl);
});
socket.on('external-cast-ended', ({ channelId }) => {
  if (channelId !== voiceChannelId) return;
  removeExternalCastTile();
});

function upsertExternalCastTile(playbackUrl) {
  removeExternalCastTile();
  const tile = document.createElement('div');
  tile.className = 'voice-tile';
  tile.id = 'tile-external-cast';
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  const fsBtn = document.createElement('button');
  fsBtn.type = 'button';
  fsBtn.className = 'fs-btn';
  fsBtn.title = 'Tela cheia';
  fsBtn.textContent = '⛶';
  fsBtn.addEventListener('click', (e) => { e.stopPropagation(); requestTileFullscreen(tile); });
  const label = document.createElement('div');
  label.className = 'tile-name';
  label.innerHTML = '<span class="mic-icon">📱</span>Celular (ao vivo)';
  tile.appendChild(video);
  tile.appendChild(fsBtn);
  tile.appendChild(label);
  $('voiceGrid').prepend(tile);

  if (window.flvjs && flvjs.isSupported()) {
    externalCastPlayer = flvjs.createPlayer({ type: 'flv', url: playbackUrl, isLive: true });
    externalCastPlayer.attachMediaElement(video);
    externalCastPlayer.load();
    externalCastPlayer.play().catch(() => {});
  } else {
    toast('Seu navegador não conseguiu tocar a transmissão do celular.', 'error');
  }
}

function removeExternalCastTile() {
  if (externalCastPlayer) {
    try { externalCastPlayer.destroy(); } catch (e) {}
    externalCastPlayer = null;
  }
  const tile = document.getElementById('tile-external-cast');
  if (tile && expandedVoiceTile === tile) closeTileFullscreen();
  tile?.remove();
}

function tileId(uid) { return 'tile-' + uid; }
function audioElId(uid) { return 'audio-' + uid; }

// ---- Detecção de "está falando" (contorno verde, igual ao Discord) ----
// Analisa o volume do áudio de cada participante em tempo real via Web
// Audio API e liga/desliga a classe .speaking no tile correspondente.
let sharedAudioCtx = null;
function getAudioCtx() {
  if (!sharedAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume().catch(() => {});
  return sharedAudioCtx;
}

// Áudio interno enviado pelo APK. É reproduzido automaticamente para os
// outros participantes e nunca devolvido ao próprio transmissor.
const nativeScreenAudioPlayers = {};

function stopNativeScreenAudio(peerId) {
  const player = nativeScreenAudioPlayers[peerId];
  if (!player) return;
  player.generation += 1;
  delete nativeScreenAudioPlayers[peerId];
}

function stopAllNativeScreenAudio() {
  Object.keys(nativeScreenAudioPlayers).forEach(stopNativeScreenAudio);
}

socket.on('native-screen-audio', ({ peerId, data, sampleRate, channels }) => {
  if (!voiceChannelId || !peerId || typeof data !== 'string') return;
  if (Number(sampleRate) !== 48000 || Number(channels) !== 1) return;
  try {
    const binary = atob(data);
    if (!binary.length || binary.length % 2) return;
    const samples = binary.length / 2;
    const ctx = getAudioCtx();
    const audioBuffer = ctx.createBuffer(1, samples, 48000);
    const output = audioBuffer.getChannelData(0);
    for (let index = 0; index < samples; index++) {
      const low = binary.charCodeAt(index * 2);
      const high = binary.charCodeAt(index * 2 + 1);
      const value = (high << 8) | low;
      output[index] = (value & 0x8000 ? value - 0x10000 : value) / 32768;
    }

    const player = nativeScreenAudioPlayers[peerId] ||
      (nativeScreenAudioPlayers[peerId] = { nextAt: 0, generation: 0 });
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    const minimumStart = ctx.currentTime + 0.06;
    if (player.nextAt < ctx.currentTime || player.nextAt > ctx.currentTime + 0.5) {
      player.nextAt = minimumStart;
    }
    source.start(Math.max(minimumStart, player.nextAt));
    player.nextAt = Math.max(minimumStart, player.nextAt) + audioBuffer.duration;
  } catch (error) {
    console.error('Falha ao reproduzir áudio da tela nativa:', error);
  }
});

const speakingAnalysers = {}; // uid -> { source, analyser, data, stream, raf }

function ensureSpeakingDetection(uid, stream) {
  const audioTrack = stream && stream.getAudioTracks().find(t => t.readyState === 'live');
  const existing = speakingAnalysers[uid];
  if (!audioTrack) {
    if (existing) teardownSpeakingDetection(uid);
    return;
  }
  if (existing && existing.stream === stream) return; // já monitorando esse stream
  if (existing) teardownSpeakingDetection(uid);

  try {
    const ctx = getAudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    speakingAnalysers[uid] = { source, analyser, data, stream, raf: null };
    tickSpeaking(uid);
  } catch (e) {
    // AudioContext pode falhar em navegadores restritos — sem animação,
    // mas a chamada continua funcionando normalmente.
  }
}

// Histerese: limiar mais alto pra "começar a falar" e mais baixo pra
// "parar de falar", pra não ficar piscando com ruído de fundo.
const SPEAKING_ON = 0.045;
const SPEAKING_OFF = 0.02;

function tickSpeaking(uid) {
  const entry = speakingAnalysers[uid];
  if (!entry) return;
  entry.analyser.getByteTimeDomainData(entry.data);
  let sumSquares = 0;
  for (let i = 0; i < entry.data.length; i++) {
    const v = (entry.data[i] - 128) / 128;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / entry.data.length);
  const tile = document.getElementById(tileId(uid));
  if (tile) {
    const isMutedTile = tile.classList.contains('muted');
    const currentlySpeaking = tile.classList.contains('speaking');
    const threshold = currentlySpeaking ? SPEAKING_OFF : SPEAKING_ON;
    const speaking = !isMutedTile && rms > threshold;
    tile.classList.toggle('speaking', speaking);
  }
  entry.raf = requestAnimationFrame(() => tickSpeaking(uid));
}

function teardownSpeakingDetection(uid) {
  const entry = speakingAnalysers[uid];
  if (!entry) return;
  if (entry.raf) cancelAnimationFrame(entry.raf);
  try { entry.source.disconnect(); } catch (e) {}
  delete speakingAnalysers[uid];
  document.getElementById(tileId(uid))?.classList.remove('speaking');
}
function teardownAllSpeakingDetection() {
  Object.keys(speakingAnalysers).forEach(teardownSpeakingDetection);
}

function ensureRemoteAudio(uid, stream) {
  let el = document.getElementById(audioElId(uid));
  if (!el) {
    el = document.createElement('audio');
    el.id = audioElId(uid);
    el.autoplay = true;
    el.hidden = true;
    document.body.appendChild(el);
  }
  if (el.srcObject !== stream) el.srcObject = stream || null;
}
function removeRemoteAudio(uid) {
  document.getElementById(audioElId(uid))?.remove();
}

function renderVoiceGrid() {
  const grid = $('voiceGrid');
  const existingIds = new Set([...grid.children].map(c => c.id));
  const wantIds = new Set([userId, ...Object.keys(peers)]);

  existingIds.forEach(id => {
    if (id === 'tile-external-cast') return;
    if (![...wantIds].some(u => tileId(u) === id)) {
      const staleTile = grid.querySelector('#' + id);
      if (staleTile && expandedVoiceTile === staleTile) closeTileFullscreen();
      staleTile?.remove();
      const uid = id.replace(/^tile-/, '');
      teardownSpeakingDetection(uid);
    }
  });

  const meM = members.find(mm => mm.id === userId);
  upsertTile(userId, userName, meM && meM.avatar, localStream, true);
  Object.keys(peers).forEach(uid => {
    const owner = nativeScreenOwners[uid];
    const m = owner ? members.find(mm => mm.id === owner.userId) : members.find(mm => mm.id === uid);
    const state = remoteMediaState[uid];
    const knownVideoOff = state && !state.camera && !state.screen;
    const displayName = owner?.userName || (m ? (m.display_name || m.username) : 'Membro');
    upsertTile(uid, owner ? `${displayName} — tela` : displayName, m && m.avatar, peers[uid].remoteStream, false, knownVideoOff);
    ensureRemoteAudio(uid, peers[uid].remoteStream);
  });
}

function upsertTile(uid, name, avatar, stream, isSelf, knownVideoOff) {
  const id = tileId(uid);
  let tile = $('voiceGrid').querySelector('#' + id);
  const hasVideo = !knownVideoOff && stream && stream.getVideoTracks().some(t => t.readyState === 'live');
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'voice-tile';
    tile.id = id;
    tile.dataset.kind = '';
    $('voiceGrid').appendChild(tile);
  }

  const isOwnScreenShare = isSelf && screenOn && hasVideo;
  const wantKind = isOwnScreenShare ? 'sharing' : hasVideo ? 'video' : 'avatar';

  if (tile.dataset.kind !== wantKind) {
    if (wantKind === 'sharing') {
      tile.innerHTML = `
        <div class="tile-avatar tile-sharing">
          <span class="share-icon">🖥️</span>
          <span class="share-label">transmitindo sua tela</span>
        </div>
        <div class="tile-name"><span class="mic-icon">🎤</span></div>`;
    } else if (wantKind === 'video') {
      const fsBtn = `<button type="button" class="fs-btn" data-tile="${id}" title="Tela cheia">⛶</button>`;
      tile.innerHTML = `<video autoplay playsinline muted></video>${fsBtn}<div class="tile-name"><span class="mic-icon">🎤</span></div>`;
    } else {
      tile.innerHTML = `<div class="tile-avatar"><img alt=""></div><div class="tile-name"><span class="mic-icon">🎤</span></div>`;
    }
    tile.dataset.kind = wantKind;
  }

  const nameEl = tile.querySelector('.tile-name');
  if (nameEl) nameEl.innerHTML = `<span class="mic-icon">🎤</span>${esc(name)}${isSelf ? ' (você)' : ''}`;

  if (wantKind === 'video') {
    const v = tile.querySelector('video');
    if (v && v.srcObject !== stream) v.srcObject = stream;
  } else if (wantKind === 'avatar') {
    const img = tile.querySelector('.tile-avatar img');
    const wanted = avatar || '/logo.svg';
    if (img && img.getAttribute('src') !== wanted) img.src = wanted;
  }

  ensureSpeakingDetection(uid, stream);
}

let expandedVoiceTile = null;

function closeTileFullscreen() {
  if (!expandedVoiceTile) return;
  expandedVoiceTile.classList.remove('voice-tile-expanded');
  const btn = expandedVoiceTile.querySelector('.fs-btn');
  if (btn) {
    btn.textContent = '⛶';
    btn.title = 'Ampliar';
    btn.setAttribute('aria-label', 'Ampliar transmissão');
    btn.setAttribute('aria-expanded', 'false');
  }
  expandedVoiceTile = null;
  document.body.classList.remove('voice-expanded-active');
}

function requestTileFullscreen(tile) {
  if (!tile || !tile.classList.contains('voice-tile')) return;
  if (expandedVoiceTile === tile) {
    closeTileFullscreen();
    return;
  }
  closeTileFullscreen();
  expandedVoiceTile = tile;
  tile.classList.add('voice-tile-expanded');
  document.body.classList.add('voice-expanded-active');
  const btn = tile.querySelector('.fs-btn');
  if (btn) {
    btn.textContent = '×';
    btn.title = 'Fechar tela ampliada';
    btn.setAttribute('aria-label', 'Fechar tela ampliada');
    btn.setAttribute('aria-expanded', 'true');
  }
  tile.querySelector('video')?.play().catch(() => {});
}

$('voiceGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('.fs-btn');
  if (!btn) return;
  e.stopPropagation();
  requestTileFullscreen(btn.closest('.voice-tile'));
});

$('voiceGrid').addEventListener('dblclick', (e) => {
  if (e.target.closest('.fs-btn')) return;
  const tile = e.target.closest('.voice-tile');
  if (!tile || (!tile.querySelector('video') && tile.dataset.kind !== 'sharing')) return;
  requestTileFullscreen(tile);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTileFullscreen();
});

socket.on('channel-members', (list) => {
  if (!voiceChannelId) return;
  const others = (list || []).filter(m => m.user_id !== userId);
  others.forEach(m => { if (!peers[m.user_id]) createPeer(m.user_id); });
  Object.keys(peers).forEach(uid => {
    if (!uid.startsWith('screen:') && !others.some(m => m.user_id === uid)) closePeer(uid);
  });
  renderVoiceGrid();
});

socket.on('native-screen-started', ({ peerId, userId: ownerId, userName: ownerName }) => {
  if (!voiceChannelId || !peerId) return;
  nativeScreenOwners[peerId] = { userId: ownerId, userName: ownerName || 'Membro' };
  remoteMediaState[peerId] = { camera: false, screen: true };
  if (!peers[peerId]) createPeer(peerId);
  // Confirma esta conexão específica como visualizadora. Um usuário pode
  // ter WebView, navegador e reconexões simultâneas; usar só o userId fazia
  // a oferta WebRTC cair numa conexão antiga e a tela nunca aparecia.
  socket.emit('native-screen-viewer-ready', { peerId });
  renderVoiceGrid();
});

socket.on('native-screen-ended', ({ peerId }) => {
  if (!peerId) return;
  stopNativeScreenAudio(peerId);
  if (peers[peerId]) closePeer(peerId);
  delete nativeScreenOwners[peerId];
  delete remoteMediaState[peerId];
  renderVoiceGrid();
});

socket.on('user-left', ({ userId: uid }) => {
  if (peers[uid]) closePeer(uid);
  renderVoiceGrid();

  // CORREÇÃO: Limpeza do tile de quem saiu
  const tile = document.getElementById(tileId(uid));
  if (tile) {
    const video = tile.querySelector('video');
    if (video && video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    }
  }
});

const remoteMediaState = {};

socket.on('user-media-state', ({ userId: uid, muted, camera, screen }) => {
  remoteMediaState[uid] = { camera: !!camera, screen: !!screen };
  const tile = $('voiceGrid').querySelector('#' + tileId(uid));
  if (tile) tile.classList.toggle('muted', !!muted);
  renderVoiceGrid();
});

function createPeer(remoteId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  const polite = userId > remoteId;
  const peer = { pc, polite, makingOffer: false, ignoreOffer: false, remoteStream: new MediaStream(), pendingCandidates: [] };
  peers[remoteId] = peer;
  const isNativeScreen = remoteId.startsWith('screen:');

  const reportScreenStage = (stage, detail = '') => {
    if (!isNativeScreen) return;
    socket.emit('native-screen-viewer-debug', { peerId: remoteId, stage, detail: String(detail || '').slice(0, 160) });
  };

  const createAndSendOffer = async () => {
    if (peer.makingOffer || pc.signalingState !== 'stable') return;
    try {
      peer.makingOffer = true;
      // createOffer/setLocalDescription explícitos funcionam também em
      // WebViews que ainda não implementam o setLocalDescription() implícito.
      const offer = await pc.createOffer(isNativeScreen
        ? { offerToReceiveVideo: true, offerToReceiveAudio: false }
        : undefined);
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      socket.emit('voice-signal', { to: remoteId, data: { sdp: pc.localDescription } });
      reportScreenStage('offer-sent');
    } catch (error) {
      console.error(error);
      reportScreenStage('offer-error', error && error.message);
    } finally {
      peer.makingOffer = false;
    }
  };

  // A conexão da tela nativa é somente recepção. Não devolvemos microfone e
  // câmera do WebView ao serviço Android e evitamos colisão de offers.
  if (!isNativeScreen && localStream) {
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  }

  pc.onnegotiationneeded = createAndSendOffer;

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('voice-signal', { to: remoteId, data: { candidate } });
  };

  pc.ontrack = (e) => {
    if (e.streams && e.streams[0]) {
      peer.remoteStream = e.streams[0];
    } else if (e.track && !peer.remoteStream.getTracks().some(track => track.id === e.track.id)) {
      // Alguns WebViews entregam o track nativo sem preencher event.streams.
      // Sem este fallback o vídeo estava conectado, mas o tile permanecia vazio.
      peer.remoteStream.addTrack(e.track);
    }
    reportScreenStage('track-received', e.track && e.track.kind);
    renderVoiceGrid();
  };

  pc.oniceconnectionstatechange = () => {
    reportScreenStage('ice-' + pc.iceConnectionState);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closePeer(remoteId);
      renderVoiceGrid();
      return;
    }
    if (pc.connectionState === 'disconnected') {
      clearTimeout(peer.disconnectTimer);
      peer.disconnectTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          closePeer(remoteId);
          renderVoiceGrid();
        }
      }, 6000);
    } else {
      clearTimeout(peer.disconnectTimer);
    }
  };

  // A tela nativa responde à oferta criada pelo visualizador. Essa direção
  // é mais confiável no WebView do que aguardar o Android iniciar a oferta.
  if (isNativeScreen && typeof pc.addTransceiver === 'function') {
    pc.addTransceiver('video', { direction: 'recvonly' });
  }

  if (isNativeScreen) {
    reportScreenStage('peer-created', typeof pc.addTransceiver === 'function' ? 'transceiver' : 'legacy-offer');
    // Não depende apenas de negotiationneeded: há WebViews em que esse
    // evento não dispara para um transceiver recvonly.
    setTimeout(createAndSendOffer, 0);
  }

  return peer;
}

function closePeer(remoteId) {
  const p = peers[remoteId];
  if (!p) return;
  clearTimeout(p.disconnectTimer);
  try { p.pc.close(); } catch (e) {}
  delete peers[remoteId];
  delete remoteMediaState[remoteId];
  teardownSpeakingDetection(remoteId);
  $('voiceGrid').querySelector('#' + tileId(remoteId))?.remove();
  removeRemoteAudio(remoteId);
}

socket.on('voice-signal', async ({ from, data }) => {
  let peer = peers[from] || createPeer(from);
  try {
    if (data.sdp) {
      const offerCollision = data.sdp.type === 'offer' && (peer.makingOffer || peer.pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) return;
      await peer.pc.setRemoteDescription(data.sdp);
      if (from.startsWith('screen:')) {
        socket.emit('native-screen-viewer-debug', { peerId: from, stage: 'answer-applied', detail: data.sdp.type });
      }
      if (peer.pendingCandidates.length) {
        for (const c of peer.pendingCandidates) {
          try { await peer.pc.addIceCandidate(c); } catch (e) { console.error(e); }
        }
        peer.pendingCandidates.length = 0;
      }
      if (data.sdp.type === 'offer') {
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        socket.emit('voice-signal', { to: from, data: { sdp: peer.pc.localDescription } });
      }
    } else if (data.candidate) {
      if (!peer.pc.remoteDescription || !peer.pc.remoteDescription.type) {
        peer.pendingCandidates.push(data.candidate);
        return;
      }
      try { await peer.pc.addIceCandidate(data.candidate); } catch (e) { if (!peer.ignoreOffer) console.error(e); }
    }
  } catch (e) { console.error(e); }
});

// ========== SAIR DO SERVIDOR ==========
$('leaveBtn')?.addEventListener('click', () => {
  if (voiceChannelId) leaveVoiceChannel(false);
  localStorage.removeItem('cat_last_server');
  location.href = '/dms.html';
});

// ========== PERFIL DE USUÁRIO E CONFIGURAÇÕES DE SERVIDOR ==========
const PROFILE_COLORS = [
  '#5865f2', // Discord Blurple
  '#57f287', // Discord Green
  '#fee75c', // Discord Yellow
  '#eb459e', // Discord Fuchsia
  '#ed4245', // Discord Red
  '#00a8fc', // Discord Sky Blue
  '#f47b67', // Discord Coral
  '#e91e63', // Discord Pink
  '#9b59b6', // Discord Purple
  '#71368a', // Discord Dark Purple
  '#3498db', // Discord Blue
  '#206694', // Discord Deep Blue
  '#1abc9c', // Discord Teal
  '#11806a', // Discord Dark Teal
  '#2ecc71', // Discord Light Green
  '#1f8b4c', // Discord Dark Green
  '#f1c40f', // Discord Gold
  '#e67e22', // Discord Orange
  '#a84300', // Discord Rust
  '#e74c3c', // Discord Crimson
  '#8b2bff', // Cat Empire Neon Purple
  '#ff4fd8', // Cat Empire Neon Pink
  '#4e5058', // Discord Grey
  '#2b2d31', // Discord Dark
  '#111214'  // Discord Black
];
let editSelectedColor = null;
let serverSelectedColor = null;
let pendingAvatarData = null;
let pendingProfileBannerData = null;
let pendingServerIconData = null;
let pendingServerBannerData = null;

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

function renderSwatches(containerId, selected, onPick) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = PROFILE_COLORS.map(c =>
    `<div class="color-swatch${c === selected ? ' selected' : ''}" data-color="${c}" style="background:${c}" title="${c}"></div>`
  ).join('');
  el.querySelectorAll('.color-swatch').forEach(sw => {
    sw.onclick = () => { onPick(sw.dataset.color); renderSwatches(containerId, sw.dataset.color, onPick); };
  });
}

function fileToDataUrl(file, maxBytes) {
  return new Promise((resolve, reject) => {
    if (file.size > maxBytes) { reject(new Error('Imagem muito grande (máx. ' + Math.round(maxBytes / 1024) + 'KB).')); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Erro ao ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

function logout() {
  localStorage.removeItem('cat_user_id');
  localStorage.removeItem('cat_user_name');
  localStorage.removeItem('cat_token');
  localStorage.removeItem('cat_last_server');
  localStorage.removeItem('cat_avatar');
  location.href = '/';
}

// ---- Configurações de Usuário / Perfil ----
async function openMyProfile() {
  try {
    const r = await fetch('/api/me', { headers: headers() });
    const me = await r.json();
    if (!r.ok) throw new Error(me.error || 'Erro ao carregar perfil');
    pendingAvatarData = null;
    pendingProfileBannerData = null;
    editSelectedColor = me.banner_color || '#5865f2';
    $('editAvatarPreview').src = me.avatar || '/logo.svg';
    $('editDisplayName').value = me.display_name || me.username || '';
    $('editBio').value = me.bio || '';
    $('editBioCount').textContent = (me.bio || '').length;
    applyBannerStyle($('editProfileBanner'), editSelectedColor);
    
    renderSwatches('editColorSwatches', editSelectedColor, (c) => {
      editSelectedColor = c;
      pendingProfileBannerData = null;
      applyBannerStyle($('editProfileBanner'), c);
    });

    if ($('accountUsername')) $('accountUsername').textContent = '@' + (me.username || 'usuario');
    if ($('accountUserId')) $('accountUserId').textContent = me.id || userId;

    // Reseta abas para perfil
    switchUserTab('profile');
    $('editProfileModal').classList.add('open');
  } catch (e) { toast(e.message, 'error'); }
}

function switchUserTab(tab) {
  if (tab === 'profile') {
    $('userTabProfileBtn')?.classList.add('active');
    $('userTabAccountBtn')?.classList.remove('active');
    if ($('userPaneProfile')) $('userPaneProfile').hidden = false;
    if ($('userPaneAccount')) $('userPaneAccount').hidden = true;
  } else {
    $('userTabProfileBtn')?.classList.remove('active');
    $('userTabAccountBtn')?.classList.add('active');
    if ($('userPaneProfile')) $('userPaneProfile').hidden = true;
    if ($('userPaneAccount')) $('userPaneAccount').hidden = false;
  }
}

$('userTabProfileBtn')?.addEventListener('click', () => switchUserTab('profile'));
$('userTabAccountBtn')?.addEventListener('click', () => switchUserTab('account'));
$('accountLogoutBtn')?.addEventListener('click', async () => {
  if (!(await uiConfirm('Deseja realmente sair da sua conta?'))) return;
  logout();
});
$('closeAccountTabBtn')?.addEventListener('click', () => $('editProfileModal').classList.remove('open'));

$('copyUserIdBtn')?.addEventListener('click', () => {
  const uid = $('accountUserId')?.textContent;
  if (!uid || uid === '—') return;
  navigator.clipboard.writeText(uid).then(() => toast('ID da conta copiado!', 'success')).catch(() => toast('Erro ao copiar', 'error'));
});


$('myAvatarBtn').onclick = openMyProfile;
$('myInfoBtn').onclick = openMyProfile;
$('userSettingsBtn')?.addEventListener('click', openMyProfile);
$('cancelEditProfileBtn').onclick = () => $('editProfileModal').classList.remove('open');
$('editBio').addEventListener('input', () => { $('editBioCount').textContent = $('editBio').value.length; });
$('editAvatarWrap').onclick = () => $('avatarFileInput').click();

$('avatarFileInput').onchange = async () => {
  const f = $('avatarFileInput').files[0];
  if (!f) return;
  try {
    pendingAvatarData = await fileToDataUrl(f, 500 * 1024);
    $('editAvatarPreview').src = pendingAvatarData;
  } catch (e) { toast(e.message, 'error'); }
  $('avatarFileInput').value = '';
};

$('editProfileBannerBtn')?.addEventListener('click', () => $('profileBannerFileInput').click());
$('profileBannerFileInput')?.addEventListener('change', async () => {
  const f = $('profileBannerFileInput').files[0];
  if (!f) return;
  try {
    pendingProfileBannerData = await fileToDataUrl(f, 500 * 1024);
    editSelectedColor = pendingProfileBannerData;
    applyBannerStyle($('editProfileBanner'), pendingProfileBannerData);
  } catch (e) { toast(e.message, 'error'); }
  $('profileBannerFileInput').value = '';
});

$('removeProfileBannerBtn')?.addEventListener('click', () => {
  pendingProfileBannerData = null;
  editSelectedColor = '#5865f2';
  applyBannerStyle($('editProfileBanner'), editSelectedColor);
  renderSwatches('editColorSwatches', editSelectedColor, (c) => {
    editSelectedColor = c;
    pendingProfileBannerData = null;
    applyBannerStyle($('editProfileBanner'), c);
  });
  toast('Banner redefinido para a cor padrão.', 'info');
});

$('editCustomColorInput')?.addEventListener('input', (e) => {
  editSelectedColor = e.target.value;
  pendingProfileBannerData = null;
  applyBannerStyle($('editProfileBanner'), editSelectedColor);
  renderSwatches('editColorSwatches', null, (c) => { editSelectedColor = c; applyBannerStyle($('editProfileBanner'), c); });
});

$('saveEditProfileBtn').onclick = async () => {
  try {
    const body = {
      displayName: $('editDisplayName').value,
      bio: $('editBio').value,
      bannerColor: pendingProfileBannerData || editSelectedColor
    };
    if (pendingAvatarData) body.avatar = pendingAvatarData;
    const r = await fetch('/api/me/profile', { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro ao salvar perfil');
    $('myName').textContent = d.display_name || d.username;
    if (d.avatar) {
      $('myAvatarImg').src = d.avatar;
      localStorage.setItem('cat_avatar', d.avatar);
    }
    const meIdx = members.findIndex(m => m.id === userId);
    if (meIdx >= 0) { members[meIdx] = { ...members[meIdx], display_name: d.display_name, avatar: d.avatar }; renderMembers(); }
    $('editProfileModal').classList.remove('open');
    toast('Perfil atualizado com sucesso!', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

// ---- Ver perfil de outra pessoa ----
let viewingProfileId = null;
function formatProfileDate(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return '—';
  return new Date(timestamp * 1000).toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}
async function openProfile(targetUserId) {
  targetUserId = String(targetUserId || '').trim();
  if (!targetUserId) return;
  closeMobileSidebar();
  if (targetUserId === userId) { openMyProfile(); return; }
  try {
    const r = await fetch('/api/users/' + encodeURIComponent(targetUserId) + '/server-profile?serverId=' + encodeURIComponent(serverId), { headers: headers(), cache: 'no-store' });
    const p = await r.json();
    if (!r.ok) throw new Error(p.error || 'Erro ao carregar perfil');
    viewingProfileId = targetUserId;
    const modal = $('viewProfileModal');
    modal.dataset.profileId = targetUserId;
    applyBannerStyle($('viewProfileBanner'), p.banner || p.banner_color || '#5865f2');
    $('viewProfileAvatar').src = p.avatar || '/logo.svg';
    $('viewProfileName').textContent = p.display_name || p.username;
    $('viewProfileUsername').textContent = '@' + p.username;
    $('viewProfileBio').textContent = p.bio || 'Sem bio.';
    if ($('viewProfileMemberContext')) $('viewProfileMemberContext').textContent = p.is_server_owner ? 'Criador deste servidor' : 'Membro deste servidor';
    if ($('viewProfileDates')) $('viewProfileDates').textContent = formatProfileDate(p.created_at) + '  •  ' + formatProfileDate(p.server_joined_at);
    if ($('viewProfileRoles')) {
      $('viewProfileRoles').innerHTML = (p.roles || []).map(role =>
        '<span class="profile-sheet-role" style="--role-color:' + esc(role.color || '#9a86bd') + '">' + esc(role.name || 'MEMBRO') + '</span>'
      ).join('');
    }
    modal.querySelector('.profile-sheet-menu')?.setAttribute('hidden', '');
    modal.classList.add('open');
  } catch (e) { toast(e.message, 'error'); }
}
window.catOpenUserProfile = openProfile;
document.addEventListener('click', event => {
  const target = event.target.closest?.('.message-author[data-user-id],.message-avatar[data-user-id],.member-row[data-user-id]');
  if (!target || !target.dataset.userId || target.closest('.message-toolbar')) return;
  event.preventDefault();
  event.stopPropagation();
  openProfile(target.dataset.userId);
}, true);
$('closeViewProfileBtn').onclick = () => $('viewProfileModal').classList.remove('open');
$('dmFromProfileBtn').onclick = () => {
  if (!viewingProfileId) return;
  location.href = '/dms.html?with=' + encodeURIComponent(viewingProfileId);
};

// Configurações avançadas são gerenciadas exclusivamente por runtime-v5.js.
// ---- Gerenciamento de convites do servidor ----
let currentActiveInviteCode = null;

async function openInviteModal() {
  $('inviteLinkText').textContent = 'Gerando link de convite…';
  $('adminInvitesListWrap').hidden = true;
  $('inviteModal').classList.add('open');

  try {
    // Tenta carregar os convites ativos se for admin ou gerar um padrão
    if (['admin', 'owner'].includes(myRole)) {
      const rList = await fetch('/api/servers/' + serverId + '/invites', { headers: headers() });
      const list = await rList.json();
      if (rList.ok && list.length > 0) {
        currentActiveInviteCode = list[0].code;
        $('inviteLinkText').textContent = location.origin + '/invite/' + list[0].code;
        renderAdminInvites(list);
        return;
      }
    }
    // Gera um novo convite inicial (padrão 24h, sem limite)
    await generateInvite();
  } catch (e) {
    $('inviteLinkText').textContent = 'Erro ao gerar convite.';
  }
}

async function generateInvite() {
  const expiresInHours = parseInt($('inviteExpireSelect').value, 10);
  const maxUses = parseInt($('inviteMaxUsesSelect').value, 10);
  try {
    const r = await fetch('/api/servers/' + serverId + '/invites', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ expiresInHours, maxUses })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro ao criar convite');
    currentActiveInviteCode = d.code;
    const url = location.origin + '/invite/' + d.code;
    $('inviteLinkText').textContent = url;
    toast('🔗 Novo link de convite gerado!', 'success');
    if (['admin', 'owner'].includes(myRole)) {
      const rList = await fetch('/api/servers/' + serverId + '/invites', { headers: headers() });
      const list = await rList.json();
      if (rList.ok) renderAdminInvites(list);
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderAdminInvites(list) {
  if (!list || !list.length) {
    $('adminInvitesListWrap').hidden = true;
    return;
  }
  $('adminInvitesListWrap').hidden = false;
  $('adminInvitesList').innerHTML = list.map(inv => {
    const exp = inv.expires_at ? new Date(inv.expires_at * 1000).toLocaleDateString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : 'Nunca';
    const uses = inv.max_uses ? `${inv.uses || 0}/${inv.max_uses}` : `${inv.uses || 0} usos`;
    return `
      <div class="active-invite-row" data-code="${esc(inv.code)}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid #29104b;font-family:monospace;font-size:10px">
        <div>
          <strong style="color:var(--gold)">${esc(inv.code)}</strong> · ${uses} · Expira: ${exp}
        </div>
        <button type="button" class="del-btn revoke-invite-btn" data-code="${esc(inv.code)}" title="Revogar convite" style="display:block;color:#ff5369;background:none;border:none;cursor:pointer">✕</button>
      </div>
    `;
  }).join('');

  $('adminInvitesList').querySelectorAll('.revoke-invite-btn').forEach(btn => {
    btn.onclick = async () => {
      const code = btn.dataset.code;
      if (!(await uiConfirm('Deseja revogar este convite?'))) return;
      try {
        const r = await fetch('/api/servers/' + serverId + '/invites/' + encodeURIComponent(code), {
          method: 'DELETE',
          headers: headers()
        });
        if (!r.ok) throw new Error('Erro ao revogar');
        toast('Convite revogado.', 'success');
        const rList = await fetch('/api/servers/' + serverId + '/invites', { headers: headers() });
        const list2 = await rList.json();
        if (rList.ok) renderAdminInvites(list2);
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  });
}

$('serverInviteBtn')?.addEventListener('click', openInviteModal);
$('closeInviteModalBtn')?.addEventListener('click', () => $('inviteModal').classList.remove('open'));
$('generateInviteBtn')?.addEventListener('click', generateInvite);
$('copyInviteBtn')?.addEventListener('click', () => {
  const text = $('inviteLinkText').textContent;
  if (!text || text.includes('…') || text.includes('Erro')) return;
  navigator.clipboard?.writeText(text).then(() => {
    const original = $('copyInviteBtn').textContent;
    $('copyInviteBtn').textContent = 'Copiado!';
    setTimeout(() => ($('copyInviteBtn').textContent = original), 1200);
  }).catch(() => toast('Não foi possível copiar.', 'error'));
});

// ---- Atualizações em tempo real de perfil/servidor/moderação ----
socket.on('member-profile-updated', (u) => {
  const idx = members.findIndex(m => m.id === u.id);
  if (idx >= 0) { members[idx] = { ...members[idx], display_name: u.display_name, avatar: u.avatar }; renderMembers(); }
  if (u.id === userId) { $('myName').textContent = u.display_name; if (u.avatar) $('myAvatarImg').src = u.avatar; }
  renderVoiceGrid();
});

let liveServerRefreshTimer = null;
let lastLiveServerRefreshAt = 0;
let serverStateRevision = 0;
let liveServerRequestId = 0;
function scheduleLiveServerRefresh(delay = 120) {
  clearTimeout(liveServerRefreshTimer);
  liveServerRefreshTimer = setTimeout(refreshServerDataLive, delay);
}
async function refreshServerDataLive() {
  if (document.hidden || Date.now() - lastLiveServerRefreshAt < 500) return;
  lastLiveServerRefreshAt = Date.now();
  const requestId = ++liveServerRequestId;
  const revisionAtStart = serverStateRevision;
  try {
    const response = await fetch('/api/servers/' + serverId, { headers: headers(), cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Erro ao sincronizar servidor');
    if (requestId !== liveServerRequestId || revisionAtStart !== serverStateRevision) return;
    currentServer = data;
    channels = Array.isArray(data.channels) ? data.channels : [];
    members = Array.isArray(data.members) ? data.members : [];
    myRole = data.myRole || 'member';
    $('serverName').textContent = data.name || 'Servidor';
    $('serverName').title = data.name || 'Servidor';
    $('mobileTitle').textContent = data.name || 'CAT EMPIRE';
    if ($('serverProfileName')) $('serverProfileName').textContent = data.name || 'Servidor';
    if ($('serverProfileIconImg')) $('serverProfileIconImg').src = data.icon && /^(data:|https?:)/.test(data.icon) ? data.icon : '/logo.svg';
    applyBannerStyle($('serverHead'), data.banner || data.banner_color);
    const canManage = ['admin','owner'].includes(myRole);
    $('serverSettingsBtn').hidden = !canManage;
    if ($('serverAdminProfileActions')) $('serverAdminProfileActions').hidden = !canManage;
    renderChannelList();
    renderMembers();
    updateServerProfileCounts();
    if (selectedTextChannelId && !channels.some(channel => channel.id === selectedTextChannelId)) {
      const firstText = channels.find(channel => channel.type === 'text');
      if (firstText) openTextChannel(firstText.id);
    }
    await loadServersRail();
    document.dispatchEvent(new CustomEvent('cat:server-live-data', { detail: data }));
    // Preserve the open editor exactly like the user profile editor does.
    // Closing the native file picker fires a window focus event; rebuilding the
    // settings panel here discarded the selected image before it could be saved.
    // The page behind the editor is already synchronized above, and the settings
    // runtime updates its own state after a successful save.

  } catch (error) { console.error('Sincronização do servidor:', error); }
}
socket.on('server-data-changed', payload => {
  if (!payload || payload.serverId === serverId) {
    serverStateRevision++;
    scheduleLiveServerRefresh(180);
  }
});
socket.on('profile-updated', profile => {
  const index = members.findIndex(member => member.id === profile?.id);
  if (index >= 0) { members[index] = { ...members[index], ...profile }; renderMembers(); }
});
window.addEventListener('focus', () => scheduleLiveServerRefresh(50));
window.addEventListener('online', () => scheduleLiveServerRefresh(50));
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleLiveServerRefresh(50); });

socket.on('server-updated', (s) => {
  if (s.id !== serverId) return;
  serverStateRevision++;
  liveServerRequestId++;
  currentServer = { ...currentServer, ...s };
  $('serverName').textContent = s.name || 'Servidor';
  $('serverName').title = s.name || 'Servidor';
  $('mobileTitle').textContent = s.name || 'CAT EMPIRE';
  if ($('serverProfileName')) $('serverProfileName').textContent = s.name || 'Servidor';
  if ($('serverProfileIconImg')) $('serverProfileIconImg').src = s.icon && /^(data:|https?:)/.test(s.icon) ? s.icon : '/logo.svg';
  applyBannerStyle($('serverHead'), s.banner || s.banner_color);
  loadServersRail();
});

socket.on('member-role-updated', ({ userId: uid, role }) => {
  const idx = members.findIndex(m => m.id === uid);
  if (idx >= 0) {
    members[idx].role = role;
    renderMembers();
    renderServerMembersManageList();
  }
  if (uid === userId) {
    myRole = role;
    const canManageServer = ['admin', 'owner'].includes(myRole);
    $('myRole').textContent = myRole === 'owner' ? 'dono' : ['admin', 'owner'].includes(myRole) ? 'admin' : 'membro';
    $('serverSettingsBtn').hidden = !canManageServer;
    toast('Seu cargo foi atualizado para: ' + (role === 'admin' ? 'Administrador' : 'Membro'), 'success');
  }
});

socket.on('member-kicked', ({ userId: uid }) => {
  if (uid === userId) {
    toast('Você foi removido deste servidor.', 'error');
    localStorage.removeItem('cat_last_server');
    setTimeout(() => { location.href = '/dms.html'; }, 1000);
    return;
  }
  members = members.filter(m => m.id !== uid);
  renderMembers();
  renderServerMembersManageList();
});

socket.on('server-deleted', ({ serverId: sid }) => {
  if (sid === serverId) {
    toast('Este servidor foi excluído pelo proprietário.', 'error');
    localStorage.removeItem('cat_last_server');
    setTimeout(() => { location.href = '/dms.html'; }, 1000);
  }
});

// ========== APP ANDROID NATIVO (captura + WebRTC do próprio canal) ==========
// Quando o site roda dentro do app Android (ver CatEmpireCast/…/MainActivity.kt),
// a ponte "CatEmpireNative" fica disponível no window. Nesse caso trocamos o
// botão de instruções (app externo tipo Larix) por transmissão nativa de
// verdade, sem precisar de outro app.
function hasNativeBroadcast() {
  return !!window.CatEmpireNative &&
    typeof window.CatEmpireNative.prepareBroadcast === 'function' &&
    typeof window.CatEmpireNative.startPreparedWebRtc === 'function';
}

let nativeBroadcasting = false;
let nativePreparing = false;
if (hasNativeBroadcast()) {
  document.documentElement.classList.add('cat-native-app');
  document.body.classList.add('cat-native-app');
  $('mobileCastBtn').title = 'Transmitir a tela (nativo)';
  $('mobileCastBtn').classList.add('native-broadcast-btn');
}

function nativeVideoOptions() {
  return {
    quality: [480, 720, 1080].includes(Number(videoSettings.quality)) ? Number(videoSettings.quality) : 720,
    fps: [24, 30, 60].includes(Number(videoSettings.fps)) ? Number(videoSettings.fps) : 30
  };
}

function connectPreparedNativeBroadcast() {
  try {
    if (!voiceChannelId) throw new Error('Entre novamente no canal de voz.');
    const { quality, fps } = nativeVideoOptions();
    window.CatEmpireNative.startPreparedWebRtc(
      token,
      userId,
      voiceChannelId,
      location.origin,
      quality,
      fps
    );
  } catch (e) {
    nativePreparing = false;
    toast(e.message, 'error');
  }
}

// Chamado pelo app Android quando a permissão, transmissão, erro ou término muda.
window.onNativeBroadcastState = function (state, message) {
  if (state === 'ready') {
    nativePreparing = false;
    connectPreparedNativeBroadcast();
  } else if (state === 'started') {
    nativePreparing = false;
    nativeBroadcasting = true;
    window.__catNativeBroadcasting = true;
    $('mobileCastBtn').classList.add('active');
    toast(message ? 'Transmitindo em ' + message + '.' : 'Transmitindo a tela ao vivo!', 'success');
  } else if (state === 'stopped') {
    nativePreparing = false;
    nativeBroadcasting = false;
    window.__catNativeBroadcasting = false;
    $('mobileCastBtn').classList.remove('active');
  } else if (state === 'error') {
    nativePreparing = false;
    nativeBroadcasting = false;
    window.__catNativeBroadcasting = false;
    $('mobileCastBtn').classList.remove('active');
    toast(message || 'Erro ao transmitir a tela.', 'error');
  }
};

const originalMobileCastHandler = $('mobileCastBtn').onclick;
$('mobileCastBtn').onclick = async () => {
  if (!voiceChannelId) return;
  if (hasNativeBroadcast()) {
    if (nativeBroadcasting) {
      window.CatEmpireNative.stopBroadcast();
      return;
    }
    if (nativePreparing) return;
    const { quality, fps } = nativeVideoOptions();
    nativePreparing = true;
    window.CatEmpireNative.prepareBroadcast(quality, fps);
    return;
  }
  return originalMobileCastHandler();
};

load();
