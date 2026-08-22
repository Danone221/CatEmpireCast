const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const userId = q.get('userId') || localStorage.getItem('cat_user_id');
const userName = q.get('userName') || localStorage.getItem('cat_user_name') || 'Membro';
const token = q.get('token') || localStorage.getItem('cat_token');
const openWith = q.get('with'); // pra abrir direto numa conversa (ex: veio do botão "Enviar mensagem" no perfil)

if (!userId || !token) { location.href = '/'; }

const socket = io();

let conversations = [];
let currentOtherId = null;
let currentOtherUser = null;
let currentBlockState = { blocked_by_me:false, blocked_me:false };
let revealBlockedMessages = false;
let pendingBlockedProfileUser = null;

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
function renderMarkdown(escapedText) {
  let t = escapedText;
  const blocks = [];
  t = t.replace(/```([\s\S]+?)```/g, (_, code) => { blocks.push(code); return `\u0000CODEBLOCK${blocks.length - 1}\u0000`; });
  t = t.replace(/`([^`\n]+?)`/g, '<code class="inline-code">$1</code>');
  t = t.replace(/\*\*([^\*\n]+?)\*\*/g, '<b>$1</b>');
  t = t.replace(/(?:\*([^\*\n]+?)\*|_([^_\n]+?)_)/g, (_, a, b) => `<i>${a || b}</i>`);
  t = t.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  t = t.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
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

socket.on('connect', () => {
  socket.emit('register', { userId, token });
  loadServersRail();
});
socket.on('error', d => { if (d?.message) toast(d.message, 'error'); });
socket.on('dm-send-error', d => { if(d?.message) toast(d.message,'error'); });
socket.on('block-changed', d => { if(d?.userId===currentOtherId) openConversation(currentOtherId); loadBlockedAccounts(); });
socket.on('profile-updated', profile => {
  if (!profile?.id) return;
  const conv=conversations.find(item=>item.id===profile.id);
  if(conv) Object.assign(conv,{username:profile.username,display_name:profile.display_name,avatar:profile.avatar});
  if(currentOtherId===profile.id){currentOtherUser={...currentOtherUser,...profile};lastDmMessages=lastDmMessages.map(message=>message.sender_id===profile.id?{...message,sender_username:profile.username,sender_display_name:profile.display_name,sender_avatar:profile.avatar}:message);renderMessages(lastDmMessages);$('mobileTitle').textContent=profile.display_name||profile.username;}
  renderConversationList();
});
socket.on('server-data-changed', () => { loadServersRail(); });
let dmLiveRefreshTimer=null,lastDmLiveRefreshAt=0;
function scheduleDmLiveRefresh(){clearTimeout(dmLiveRefreshTimer);dmLiveRefreshTimer=setTimeout(async()=>{if(document.hidden||Date.now()-lastDmLiveRefreshAt<800)return;lastDmLiveRefreshAt=Date.now();await Promise.all([loadConversations(),loadServersRail()]);if(currentOtherId)openConversation(currentOtherId);},100);}
window.addEventListener('focus',scheduleDmLiveRefresh);
window.addEventListener('online',scheduleDmLiveRefresh);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleDmLiveRefresh();});
socket.on('servers-list', (list) => renderServerRail(list || []));

function renderServerRail(list) {
  if (!$('railServers')) return;
  $('railServers').innerHTML = (list || []).map(s => {
    const isImg = s.icon && /^(https?:|data:)/.test(s.icon);
    const inner = isImg
      ? `<img src="${esc(s.icon)}" alt="" style="width:100%;height:100%;object-fit:cover">`
      : esc(s.icon || (s.name || '?').trim().slice(0, 2).toUpperCase());
    return `<div class="rail-icon" data-server-id="${esc(s.id)}" title="${esc(s.name || 'Servidor')}">${inner}</div>`;
  }).join('');
  $('railServers').querySelectorAll('[data-server-id]').forEach(el => {
    el.onclick = () => {
      localStorage.setItem('cat_last_server', el.dataset.serverId);
      location.href = '/server.html?serverId=' + encodeURIComponent(el.dataset.serverId);
    };
  });
}
$('railAddBtn')?.addEventListener('click', () => { window.openAddServerModal(); });
$('backBtn')?.addEventListener('click', () => {
  const last = localStorage.getItem('cat_last_server');
  if (last) {
    location.href = '/server.html?serverId=' + encodeURIComponent(last);
  }
});

// ========== LISTA DE CONVERSAS ==========
async function loadConversations() {
  try {
    const r = await fetch('/api/dms', { headers: headers() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro ao carregar conversas');
    conversations = d;
    renderConversationList();
  } catch (e) { toast(e.message, 'error'); }
}

function renderConversationList() {
  if (!conversations.length) {
    $('dmList').innerHTML = '<p class="empty-hint">Nenhuma conversa ainda. Abra o perfil de alguém num servidor e clique em "Enviar mensagem".</p>';
    return;
  }
  $('dmList').innerHTML = conversations.map(c => {
    const blocked = c.blocked_by_me || c.blocked_me;
    const preview = blocked ? '' : (c.last_from_me ? 'Você: ' : '');
    const text = blocked ? 'Conversa bloqueada' : (c.last_message ? (c.last_message.length > 34 ? c.last_message.slice(0, 34) + '…' : c.last_message) : (c.last_has_file ? '📄 Arquivo' : ''));
    const active = c.id === currentOtherId ? ' active' : '';
    return `<div class="channel-item dm-item${active}${blocked ? ' dm-item-blocked' : ''}" data-id="${esc(c.id)}">
      <div class="dm-avatar"><img src="${c.avatar || '/logo.svg'}" alt=""></div>
      <div class="dm-info">
        <div class="cname">${esc(c.display_name || c.username)}</div>
        <div class="dm-preview">${esc(preview + text)}</div>
      </div>
      ${c.unread_count > 0 ? `<span class="unread-badge">${c.unread_count > 9 ? '9+' : c.unread_count}</span>` : ''}
    </div>`;
  }).join('');
  $('dmList').querySelectorAll('.dm-item').forEach(el => {
    el.addEventListener('click', () => openConversation(el.dataset.id));
  });
}

// ========== CONVERSA ABERTA ==========
async function openConversation(otherId) {
  currentOtherId = otherId;
  typingUsers.clear();
  renderTypingIndicator();
  try {
    const r = await fetch('/api/dms/' + otherId, { headers: headers() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro ao carregar conversa');
    currentOtherUser = d.user;
    currentBlockState = d.blockState || { blocked_by_me:false, blocked_me:false };
    revealBlockedMessages = false;
    $('dmHeader').innerHTML = `<button type="button" class="dm-header-user" data-open-dm-profile><img src="${d.user.avatar || '/logo.svg'}" alt=""><span><strong>${esc(d.user.display_name || d.user.username)}</strong><small>@${esc(d.user.username)}</small></span><span class="dm-header-chevron">›</span></button><div class="dm-header-actions"><button type="button" class="dm-head-icon" title="Buscar">⌕</button></div>`;
    $('mobileTitle').textContent = d.user.display_name || d.user.username;
    updateDmComposerState();
    renderMessages(d.messages);
    let conv = conversations.find(c => c.id === otherId);
    if (conv) {
      conv.unread_count = 0;
      if (!conv.username) { conv.username = d.user.username; conv.display_name = d.user.display_name; conv.avatar = d.user.avatar; }
      renderConversationList();
    } else {
      await loadConversations();
    }
    closeMobileSidebar();
  } catch (e) { toast(e.message, 'error'); }
}

function dmIntroHtml() {
  const u=currentOtherUser;
  if(!u) return '';
  const blocked=currentBlockState.blocked_by_me;
  return `<section class="dm-profile-intro"><img class="dm-intro-avatar" src="${u.avatar || '/logo.svg'}" alt=""><h1>${esc(u.display_name || u.username)}</h1><div class="dm-intro-username">@${esc(u.username)}</div><p>Este é o começo da sua conversa com ${esc(u.display_name || u.username)}.</p><div class="dm-intro-actions"><button type="button" class="btn btn-primary" data-dm-friend>Enviar pedido de amizade</button><button type="button" class="btn ${blocked ? 'btn-primary' : ''}" data-dm-block>${blocked ? 'Desbloquear' : 'Bloquear'}</button></div></section>`;
}
function renderMessages(msgs) {
  const intro=dmIntroHtml();
  const body=(!msgs || !msgs.length) ? '<p class="empty-hint">Nenhuma mensagem ainda.</p>' : msgs.map(messageHtml).join('');
  if(currentBlockState.blocked_by_me && !revealBlockedMessages){
    $('messagesList').innerHTML=intro+`<button type="button" class="blocked-messages-gate" data-reveal-blocked><strong>Mensagens ocultas</strong><span>Você bloqueou este usuário. Toque para visualizar esta conversa.</span></button>`;
  }else{
    $('messagesList').innerHTML=intro+body;
  }
  $('messagesList').scrollTop = $('messagesList').scrollHeight;
}
function updateDmComposerState(){
  const blocked=currentBlockState.blocked_by_me||currentBlockState.blocked_me;
  $('messageInput').disabled=blocked||!currentOtherId;
  $('attachBtn').disabled=blocked;
  $('sendBtn').disabled=blocked;
  $('messageInput').placeholder=currentBlockState.blocked_by_me?'Desbloqueie para enviar mensagem':currentBlockState.blocked_me?'Você não pode enviar mensagens para este usuário':'Enviar mensagem…';
}

function messageHtml(m) {
  const time = new Date((m.created_at || 0) * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  let fileHtml = '';
  if (m.file_data && m.file_type && m.file_type.startsWith('image/')) {
    fileHtml = `<img class="message-image" src="${m.file_data}" alt="${esc(m.file_name || 'imagem')}" data-file-url="${m.file_data}">`;
  } else if (m.file_data) {
    fileHtml = `<a class="message-file" href="${m.file_data}" download="${esc(m.file_name || 'arquivo')}">📄 ${esc(m.file_name || 'arquivo')}</a>`;
  }
  const isMine = m.sender_id === userId;
  const editedTag = m.edited_at ? '<span class="message-edited-tag">(editado)</span>' : '';
  const toolbar = isMine ? `<div class="message-toolbar">
      <button class="msg-tool-btn" data-action="edit" title="Editar">✏️</button>
      <button class="msg-tool-btn" data-action="delete" title="Excluir">🗑️</button>
    </div>` : '';
  return `<div class="message" data-message-id="${esc(m.id)}" data-user-id="${esc(m.sender_id)}">
    <div class="message-avatar" data-user-id="${esc(m.sender_id)}"><img src="${m.sender_avatar || '/logo.svg'}" alt=""></div>
    <div class="message-body">
      <div class="message-head">
        <span class="message-author" data-user-id="${esc(m.sender_id)}">${esc(m.sender_display_name || m.sender_username || 'Membro')}</span>
        <span class="message-time">${time}</span>${editedTag}
      </div>
      <div class="message-content" data-raw="${esc(m.content || '')}">${m.content ? renderMarkdown(esc(m.content)) : ''}</div>
      ${fileHtml}
      ${toolbar}
    </div>
  </div>`;
}

socket.on('new-dm', (msg) => {
  const otherId = msg.sender_id === userId ? msg.recipient_id : msg.sender_id;
  if (otherId === currentOtherId) {
    if (currentBlockState.blocked_by_me || currentBlockState.blocked_me) { openConversation(currentOtherId); loadConversations(); return; }
    const empty = $('messagesList').querySelector('.empty-hint');
    if (empty) empty.remove();
    $('messagesList').insertAdjacentHTML('beforeend', messageHtml(msg));
    $('messagesList').scrollTop = $('messagesList').scrollHeight;
    removeTypingUser(msg.sender_id);
    if (msg.sender_id !== userId) fetch('/api/dms/' + otherId, { headers: headers() }).catch(() => {});
  }
  loadConversations();
});

socket.on('dm-edited', (msg) => {
  const otherId = msg.sender_id === userId ? msg.recipient_id : msg.sender_id;
  if (otherId !== currentOtherId) return;
  const el = $('messagesList').querySelector(`.message[data-message-id="${CSS.escape(msg.id)}"]`);
  if (el) el.outerHTML = messageHtml(msg);
});
socket.on('dm-deleted', ({ id, sender_id, recipient_id }) => {
  const otherId = sender_id === userId ? recipient_id : sender_id;
  if (otherId !== currentOtherId) return;
  $('messagesList').querySelector(`.message[data-message-id="${CSS.escape(id)}"]`)?.remove();
});

$('messagesList').addEventListener('click', (e) => {
  if(e.target.closest('[data-reveal-blocked]')){revealBlockedMessages=true;openConversationMessagesOnly();return;}
  if(e.target.closest('[data-dm-block]')){toggleCurrentBlock();return;}
  if(e.target.closest('[data-dm-friend]')){sendFriendRequestForCurrent();return;}
  const author=e.target.closest('.message-author[data-user-id],.message-avatar[data-user-id]');
  if(author&&author.dataset.userId){openDmUserProfileById(author.dataset.userId);return;}
  const img = e.target.closest('.message-image[data-file-url]');
  if (img) { window.open(img.dataset.fileUrl, '_blank'); return; }
  const toolBtn = e.target.closest('.msg-tool-btn');
  if (toolBtn) {
    const msgEl = toolBtn.closest('.message[data-message-id]');
    const messageId = msgEl?.dataset.messageId;
    if (!messageId) return;
    if (toolBtn.dataset.action === 'delete') {
      uiConfirm('Excluir esta mensagem?').then(ok => { if (ok) socket.emit('delete-dm', { messageId }); });
    } else if (toolBtn.dataset.action === 'edit') {
      startEditMessage(msgEl, messageId);
    }
  }
});

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
    if (save && newContent && newContent !== raw) socket.emit('edit-dm', { messageId, content: newContent });
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// ========== ENVIAR MENSAGEM / ANEXO ==========
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
  if (!currentOtherId) return;
  socket.emit('send-dm', { toUserId: currentOtherId, message: text, file: pendingFile });
  $('messageInput').value = '';
  pendingFile = null;
  $('fileInput').value = '';
  $('attachPreview').hidden = true;
  $('attachBtn').disabled = false;
  stopTyping();
}
$('sendBtn').onclick = sendMessage;
$('messageInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMessage(); } });
$('messageForm').onsubmit = (e) => { e.preventDefault(); if(currentBlockState.blocked_by_me||currentBlockState.blocked_me)return toast('Esta conversa está bloqueada.','error'); sendMessage(); };

// ---- "Está digitando…" ----
let typingTimeout = null;
let iAmTyping = false;
function stopTyping() {
  if (iAmTyping && currentOtherId) socket.emit('dm-typing-stop', { toUserId: currentOtherId });
  iAmTyping = false;
  clearTimeout(typingTimeout);
}
$('messageInput').addEventListener('input', () => {
  if (!currentOtherId) return;
  if (!iAmTyping) { iAmTyping = true; socket.emit('dm-typing-start', { toUserId: currentOtherId }); }
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(stopTyping, 3000);
});
const typingUsers = new Map();
function renderTypingIndicator() {
  const el = $('dmTypingIndicator');
  const names = Array.from(typingUsers.values());
  if (!names.length) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = `${names[0]} está digitando…`;
}
function removeTypingUser(uid) { if (typingUsers.delete(uid)) renderTypingIndicator(); }
socket.on('dm-user-typing', ({ userId: uid, userName: uname }) => {
  if (uid !== currentOtherId) return;
  typingUsers.set(uid, uname || 'Alguém');
  renderTypingIndicator();
});
socket.on('dm-user-stop-typing', ({ userId: uid }) => removeTypingUser(uid));

// ========== BLOQUEIOS E PERFIL DA DM ==========
let lastDmMessages=[];
function openConversationMessagesOnly(){renderMessages(lastDmMessages);}
const originalRenderMessages=renderMessages;
renderMessages=function(msgs){lastDmMessages=Array.isArray(msgs)?msgs:[];return originalRenderMessages(msgs);};
async function toggleCurrentBlock(){
  if(!currentOtherId)return;
  const blocking=currentBlockState.blocked_by_me;
  const ok=await uiConfirm(blocking?'Desbloquear este usuário?':'Bloquear este usuário? A amizade será removida e a conversa ficará oculta.');
  if(!ok)return;
  try{
    const r=await fetch('/api/social/blocks/'+encodeURIComponent(currentOtherId),{method:blocking?'DELETE':'POST',headers:headers()});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'Não foi possível alterar o bloqueio');
    await openConversation(currentOtherId);loadBlockedAccounts();
  }catch(e){toast(e.message,'error');}
}
async function sendFriendRequestForCurrent(){
  if(!currentOtherUser)return;
  try{const r=await fetch('/api/social/friends/request',{method:'POST',headers:headers(),body:JSON.stringify({username:currentOtherUser.username})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Erro ao enviar solicitação');toast(d.message||'Solicitação enviada.','success');}catch(e){toast(e.message,'error');}
}
async function openDmUserProfileById(targetUserId){
  targetUserId=String(targetUserId||'').trim();if(!targetUserId)return;
  try{
    const r=await fetch('/api/users/'+encodeURIComponent(targetUserId)+'/profile',{headers:headers(),cache:'no-store'});
    const profile=await r.json();if(!r.ok)throw new Error(profile.error||'Erro ao carregar perfil');
    if(targetUserId===currentOtherId&&currentBlockState.blocked_by_me){pendingBlockedProfileUser=profile;$('blockedProfileWarningModal').classList.add('open');return;}
    showDmUserProfile(profile);
  }catch(e){toast(e.message,'error');}
}
document.addEventListener('click',event=>{
  const target=event.target.closest?.('.message-author[data-user-id],.message-avatar[data-user-id]');
  if(!target||!target.dataset.userId)return;
  event.preventDefault();event.stopPropagation();openDmUserProfileById(target.dataset.userId);
},true);
function requestOpenCurrentProfile(){
  if(!currentOtherUser)return;
  if(currentBlockState.blocked_by_me){pendingBlockedProfileUser=currentOtherUser;$('blockedProfileWarningModal').classList.add('open');return;}
  openDmUserProfileById(currentOtherId);
}
function showDmUserProfile(u){
  applyBannerStyle($('dmProfileBanner'),u.banner||u.banner_color||'#8b2bff');
  $('dmProfileAvatar').src=u.avatar||'/logo.svg';$('dmProfileName').textContent=u.display_name||u.username;$('dmProfileUsername').textContent='@'+u.username;$('dmProfileBio').textContent=u.bio||'Sem bio.';$('dmUserProfileModal').classList.add('open');
}
$('dmHeader')?.addEventListener('click',e=>{if(e.target.closest('[data-open-dm-profile]'))requestOpenCurrentProfile();});
$('cancelBlockedProfileBtn')?.addEventListener('click',()=>$('blockedProfileWarningModal').classList.remove('open'));
$('openBlockedProfileBtn')?.addEventListener('click',()=>{$('blockedProfileWarningModal').classList.remove('open');if(pendingBlockedProfileUser)showDmUserProfile(pendingBlockedProfileUser);});
$('closeDmProfileBtn')?.addEventListener('click',()=>$('dmUserProfileModal').classList.remove('open'));
async function loadBlockedAccounts(){
 const list=$('blockedAccountsList');if(!list)return;
 try{const r=await fetch('/api/social/blocks',{headers:headers()});const rows=await r.json();if(!r.ok)throw new Error(rows.error||'Erro ao carregar bloqueios');list.innerHTML=rows.length?rows.map(u=>`<div class="blocked-account-row"><img src="${u.avatar||'/logo.svg'}" alt=""><div><strong>${esc(u.display_name||u.username)}</strong><small>@${esc(u.username)}</small></div><button type="button" class="btn" data-unblock-id="${esc(u.id)}">Desbloquear</button></div>`).join(''):'<p class="empty-hint">Nenhuma conta bloqueada.</p>';}catch(e){list.innerHTML='<p class="empty-hint">'+esc(e.message)+'</p>';}
}
$('refreshBlockedBtn')?.addEventListener('click',loadBlockedAccounts);
$('blockedAccountsList')?.addEventListener('click',async e=>{const b=e.target.closest('[data-unblock-id]');if(!b)return;await fetch('/api/social/blocks/'+encodeURIComponent(b.dataset.unblockId),{method:'DELETE',headers:headers()});loadBlockedAccounts();if(currentOtherId===b.dataset.unblockId)openConversation(currentOtherId);});

// ========== ADICIONAR AMIGO ==========
function closeAddFriendModal() {
  $('addFriendModal')?.classList.remove('open');
  if ($('addFriendStatus')) $('addFriendStatus').textContent = '';
}
$('openAddFriendBtn')?.addEventListener('click', () => {
  $('addFriendModal')?.classList.add('open');
  if ($('addFriendUsername')) {
    $('addFriendUsername').value = '';
    requestAnimationFrame(() => $('addFriendUsername').focus());
  }
});
$('closeAddFriendBtn')?.addEventListener('click', closeAddFriendModal);
$('cancelAddFriendBtn')?.addEventListener('click', closeAddFriendModal);
$('addFriendModal')?.addEventListener('click', event => {
  if (event.target === $('addFriendModal')) closeAddFriendModal();
});
async function submitFriendRequest() {
  const input = $('addFriendUsername');
  const button = $('confirmAddFriendBtn');
  const status = $('addFriendStatus');
  const username = input?.value.trim().replace(/^@/, '');
  if (!username) {
    if (status) status.textContent = 'Digite um username.';
    input?.focus();
    return;
  }
  button.disabled = true;
  if (status) status.textContent = 'Enviando…';
  try {
    const r = await fetch('/api/social/friends/request', {
      method: 'POST', headers: headers(), body: JSON.stringify({ username })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Não foi possível enviar a solicitação.');
    toast(data.message || 'Solicitação de amizade enviada.', 'success');
    closeAddFriendModal();
    document.dispatchEvent(new CustomEvent('cat:friends-changed'));
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}
$('confirmAddFriendBtn')?.addEventListener('click', submitFriendRequest);
$('addFriendUsername')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitFriendRequest();
  }
});

// ========== MOBILE SIDEBAR ==========
$('hamburgerBtn').onclick = () => { $('mobileDrawer').classList.add('open'); $('sidebarOverlay').classList.add('open'); };
$('sidebarOverlay').onclick = closeMobileSidebar;
function closeMobileSidebar() { $('mobileDrawer').classList.remove('open'); $('sidebarOverlay').classList.remove('open'); }

// ========== MEU PERFIL (mesmo modal usado em server.html) ==========
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
let pendingAvatarData = null;
let pendingProfileBannerData = null;

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
  el.innerHTML = PROFILE_COLORS.map(c => `<div class="color-swatch${c === selected ? ' selected' : ''}" data-color="${c}" style="background:${c}" title="${c}"></div>`).join('');
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

    switchUserTab('profile');
    $('editProfileModal').classList.add('open');
  } catch (e) { toast(e.message, 'error'); }
}

$('myAvatarBtn').onclick = openMyProfile;
$('myInfoBtn').onclick = openMyProfile;
$('userSettingsBtn')?.addEventListener('click', openMyProfile);
$('userTabProfileBtn')?.addEventListener('click', () => switchUserTab('profile'));
$('userTabAccountBtn')?.addEventListener('click', () => { switchUserTab('account'); loadBlockedAccounts(); });
$('closeAccountTabBtn')?.addEventListener('click', () => $('editProfileModal').classList.remove('open'));
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

$('copyUserIdBtn')?.addEventListener('click', () => {
  const uid = $('accountUserId')?.textContent;
  if (!uid || uid === '—') return;
  navigator.clipboard.writeText(uid).then(() => toast('ID da conta copiado!', 'success')).catch(() => toast('Erro ao copiar', 'error'));
});


$('accountLogoutBtn')?.addEventListener('click', async () => {
  if (!(await uiConfirm('Deseja realmente sair da sua conta?'))) return;
  logout();
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
    $('editProfileModal').classList.remove('open');
    toast('Perfil atualizado com sucesso!', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

// ========== INÍCIO ==========
(async function init() {
  loadServersRail();
  await loadConversations();
  if (openWith) {
    if (!conversations.some(c => c.id === openWith)) {
      conversations.unshift({ id: openWith, username: '', display_name: '', avatar: '', last_message: '', last_created_at: 0, unread_count: 0 });
    }
    openConversation(openWith);
  }
})();
