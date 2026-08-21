const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const serverId = q.get('serverId');
const userId = q.get('userId');
const userName = q.get('userName') || 'Membro';
const token = q.get('token') || localStorage.getItem('cat_token');

const socket = io();

let channels = [];
let members = [];
let myRole = 'member';
let selectedTextChannelId = null;
let activeMainView = 'text'; // 'text' | 'voice'
let voiceChannelId = null;   // channel currently connected to voice
let pendingChannelType = 'text';

// ---- Voice/WebRTC state ----
let localStream = null;
let micOn = true;
let camOn = false;
let screenOn = false;
const peers = {}; // remoteUserId -> { pc, polite, makingOffer, ignoreOffer }
const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

$('myName').textContent = userName;

function headers() {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

let hadConnectedBefore = false;
socket.on('connect', () => {
  socket.emit('register', { userId, token, serverId });
  if (selectedTextChannelId) socket.emit('join-text-channel', { channelId: selectedTextChannelId });
  if (voiceChannelId) {
    // ===== CORREÇÃO DA RECONEXÃO =====
    // Se você já esteve conectado antes, você DEVE fechar TODOS os peers velhos
    // e limpar o grid de voz ANTES de tentar entrar no canal.
    if (hadConnectedBefore) {
      Object.keys(peers).forEach(closePeer);
      // Reseta o estado da câmera/tela local para evitar conflitos
      if (camOn) { camOn = false; updateCamButton(); removeCurrentVideoTrack(); }
      if (screenOn) { screenOn = false; updateScreenButton(); removeCurrentVideoTrack(); }
      renderVoiceGrid();
    }
    // ==================================
    socket.emit('join-voice-channel', { channelId: voiceChannelId });
  }
  hadConnectedBefore = true;
}); {
    // Se isso é uma RECONEXÃO (já tínhamos conectado antes) durante uma
    // chamada, o servidor já nos tirou e recolocou no canal de voz (ver
    // fix no disconnect handler do socket.js). As conexões WebRTC antigas
    // que tínhamos com os outros participantes, porém, ficaram órfãs desse
    // lado — o 'channel-members' que vamos receber a seguir só cria peers
    // pra quem AINDA NÃO existe no nosso `peers`, então essas conexões
    // velhas nunca seriam refeitas. Fechamos todas aqui pra garantir que
    // sejam recriadas do zero com a lista atualizada de participantes.
    if (hadConnectedBefore) {
      Object.keys(peers).forEach(closePeer);
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

// Alguém novo entrou no servidor enquanto esta página já estava aberta —
// atualiza a lista local de membros pra que o nome apareça correto em
// qualquer lugar que dependa desse array (sidebar de membros, nome nos
// tiles da chamada de voz — sem isso caíam no fallback genérico "Membro").
socket.on('member-joined', (member) => {
  if (!member || members.some(m => m.id === member.id)) return;
  members.push(member);
  renderMembers();
  if (voiceChannelId) renderVoiceGrid();
});

// ========== CARREGAR SERVIDOR ==========
async function load() {
  if (!serverId || !token) { location.href = '/'; return; }
  try {
    const r = await fetch('/api/servers/' + serverId, { headers: headers() });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro ao carregar servidor');
    $('serverName').textContent = d.name || 'Servidor';
    $('roomCode').textContent = d.code || '------';
    $('mobileTitle').textContent = d.name || 'CAT EMPIRE';
    channels = d.channels || [];
    members = d.members || [];
    myRole = d.myRole || 'member';
    $('myRole').textContent = myRole === 'admin' ? 'admin' : 'membro';
    renderChannelList();
    renderMembers();
    const firstText = channels.find(c => c.type === 'text');
    if (firstText) openTextChannel(firstText.id);
    const me = members.find(m => m.id === userId);
    if (me && me.avatar) $('myAvatarImg').src = me.avatar;
  } catch (e) {
    toast(e.message, 'error');
    location.href = '/';
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
        ${myRole === 'admin' ? `<button class="add-channel-btn" data-cat="${esc(cat)}" data-type="${byCategory[cat][0].type === 'voice' ? 'voice' : 'text'}" title="Criar canal">＋</button>` : ''}
      </div>
      ${byCategory[cat].map(c => channelItemHtml(c)).join('')}
    </div>
  `).join('') + (myRole === 'admin' ? `<button class="add-channel-btn add-channel-generic" id="addChannelGeneric">＋ Criar canal</button>` : '');

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
  return `<div class="channel-item ${active ? 'active' : ''}" data-id="${c.id}" data-type="${c.type}">
    <span class="icon">${icon}</span><span class="cname">${esc(c.name)}</span>
    ${c.type === 'voice' && c.id === voiceChannelId ? '<span class="live-dot" title="Conectado"></span>' : ''}
    ${myRole === 'admin' ? `<button class="del-btn" data-id="${c.id}" title="Excluir">✕</button>` : ''}
  </div>`;
}

// ========== SIDEBAR: MEMBROS ==========
function renderMembers() {
  $('memberCount').textContent = members.length;
  $('membersList').innerHTML = members.map(m => `
    <div class="member-row">
      <div class="m-avatar"><img src="${m.avatar || '/logo.svg'}" alt=""></div>
      <div class="m-name">${esc(m.display_name || m.username)}</div>
      ${m.role === 'admin' ? '<span class="m-badge">ADMIN</span>' : ''}
    </div>
  `).join('');
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

// ========== MOBILE SIDEBAR ==========
$('hamburgerBtn').onclick = () => { $('channelsSidebar').classList.add('open'); $('sidebarOverlay').classList.add('open'); };
$('sidebarOverlay').onclick = closeMobileSidebar;
function closeMobileSidebar() { $('channelsSidebar').classList.remove('open'); $('sidebarOverlay').classList.remove('open'); }

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
    // sem onclick inline — o listener delegado no #messagesList cuida do clique (ver abaixo)
    fileHtml = `<img class="message-image" src="${m.file_data}" alt="${esc(m.file_name || 'imagem')}" data-file-url="${m.file_data}">`;
  } else if (m.file_data) {
    fileHtml = `<a class="message-file" href="${m.file_data}" download="${esc(m.file_name || 'arquivo')}">📄 ${esc(m.file_name || 'arquivo')}</a>`;
  }
  return `<div class="message">
    <div class="message-avatar"><img src="${m.avatar || '/logo.svg'}" alt=""></div>
    <div class="message-body">
      <div class="message-head"><span class="message-author">${esc(m.display_name || m.username || 'Membro')}</span><span class="message-time">${time}</span></div>
      ${m.content ? `<div class="message-content">${esc(m.content)}</div>` : ''}
      ${fileHtml}
    </div>
  </div>`;
}

// clique nas imagens do chat pra abrir em nova aba — delegado (sem onclick inline)
$('messagesList').addEventListener('click', (e) => {
  const img = e.target.closest('.message-image[data-file-url]');
  if (img) window.open(img.dataset.fileUrl, '_blank');
});

socket.on('new-message', (msg) => {
  if (msg.channel_id !== selectedTextChannelId) return;
  const empty = $('messagesList').querySelector('.empty-hint');
  if (empty) empty.remove();
  $('messagesList').insertAdjacentHTML('beforeend', messageHtml(msg));
  $('messagesList').scrollTop = $('messagesList').scrollHeight;
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
    // Enquanto já existe uma imagem selecionada, desativa o botão de anexar:
    // só cabe uma imagem por mensagem mesmo, e assim nenhum toque acidental
    // (ou ativação sintética vinda do teclado virtual) consegue reabrir o
    // seletor de arquivo por engano.
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
}

// O envio não depende mais da submissão nativa do form (evita de vez a
// ambiguidade de "qual botão é o padrão" em teclados virtuais/IMEs
// mobile): o botão de enviar e a tecla Enter chamam sendMessage()
// diretamente. O onsubmit fica só como rede de segurança.
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
  voiceChannelId = null;
  camOn = false;
  screenOn = false;
  micOn = true;
  removeExternalCastTile();
  $('voiceGrid').innerHTML = '';
  if (switchView) showView('text');
  else { $('voiceBar').hidden = true; renderChannelList(); }
}

$('hangupBtn').onclick = () => leaveVoiceChannel(true);
$('voiceBarLeave').onclick = () => leaveVoiceChannel(false);

$('micBtn').onclick = () => {
  if (!localStream) return;
  micOn = !micOn;
  localStream.getAudioTracks().forEach(t => t.enabled = micOn);
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

ffunction addVideoTrackToPeers(track) {
  if (!localStream) localStream = new MediaStream();
  localStream.addTrack(track);
  
  // ===== NOVA CORREÇÃO: REMOVER TRACKS ANTIGAS =====
  // Antes de adicionar a nova track, garanta que não existe outra track de vídeo
  const oldVideos = localStream.getVideoTracks();
  oldVideos.forEach(t => {
    if (t !== track) {
      t.stop();
      localStream.removeTrack(t);
    }
  });
  // ================================================

  Object.values(peers).forEach(p => p.pc.addTrack(track, localStream));
}

$('camBtn').onclick = async () => {
  if (!camOn) {
    try {
      if (screenOn) { removeCurrentVideoTrack(); screenOn = false; updateScreenButton(); }
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = camStream.getVideoTracks()[0];
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
  socket.emit('voice-media-state', { muted: !micOn, camera: camOn, screen: screenOn });
};

$('screenBtn').onclick = async () => {
  if (!screenOn) {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      // Alguns navegadores de celular (principalmente Android mais antigo)
      // simplesmente não têm a API de captura de tela — sem essa checagem,
      // o clique não fazia nada e parecia um bug silencioso.
      toast('Este navegador não suporta compartilhar tela. Tente no Chrome/Brave atualizado.', 'error');
      return;
    }
    try {
      if (camOn) { removeCurrentVideoTrack(); camOn = false; updateCamButton(); }
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = screenStream.getVideoTracks()[0];
      addVideoTrackToPeers(track);
      screenOn = true;
      renderVoiceGrid();
      // dispara quando o usuário clica em "Parar compartilhamento" na barra nativa do navegador
      track.addEventListener('ended', () => { screenOn = false; updateScreenButton(); renderVoiceGrid(); });
    } catch (e) {
      // usuário cancelou o seletor de tela — não é erro de verdade
      if (e.name !== 'NotAllowedError') toast('Não foi possível compartilhar a tela.', 'error');
      return;
    }
  } else {
    removeCurrentVideoTrack();
    screenOn = false;
    renderVoiceGrid();
  }
  updateScreenButton();
  socket.emit('voice-media-state', { muted: !micOn, camera: camOn, screen: screenOn });
};

function updateMicButton() { $('micBtn').classList.toggle('active', micOn); $('micBtn').textContent = micOn ? '🎤' : '🔇'; }
function updateCamButton() { $('camBtn').classList.toggle('active', camOn); }
function updateScreenButton() { $('screenBtn').classList.toggle('active', screenOn); }

// ========== CAST EXTERNO (transmitir a tela do celular via app de RTMP) ==========
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
  fsBtn.addEventListener('click', (e) => { e.stopPropagation(); requestTileFullscreen(video); });
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
  document.getElementById('tile-external-cast')?.remove();
}

function tileId(uid) { return 'tile-' + uid; }
function audioElId(uid) { return 'audio-' + uid; }

// Áudio remoto é tocado por um <audio> dedicado, independente de vídeo.
// Antes, o som só saía através do <video> — e esse <video> só existia quando
// a pessoa tinha câmera/tela ligada (hasVideo). Alguém só de microfone
// (o caso mais comum) não tinha ONDE o áudio tocar: por isso "o microfone
// era só enfeite". Esse elemento fica fora do grid (não é apagado quando o
// tile é redesenhado) e persiste enquanto o peer estiver conectado.
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

  // remove stale
  existingIds.forEach(id => { if (![...wantIds].some(u => tileId(u) === id)) grid.querySelector('#' + id)?.remove(); });

  // self tile
  const meM = members.find(mm => mm.id === userId);
  upsertTile(userId, userName, meM && meM.avatar, localStream, true);
  // remote tiles — e áudio (ver ensureRemoteAudio acima)
  Object.keys(peers).forEach(uid => {
    const m = members.find(mm => mm.id === uid);
    const state = remoteMediaState[uid];
    // Sem aviso ainda recebido pra esse peer (acabou de entrar): confia na
    // stream em si até o primeiro 'user-media-state' chegar.
    const knownVideoOff = state && !state.camera && !state.screen;
    upsertTile(uid, m ? (m.display_name || m.username) : 'Membro', m && m.avatar, peers[uid].remoteStream, false, knownVideoOff);
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

  // Quando você compartilha a TELA (não a câmera), sua própria prévia mostra
  // literalmente o seu monitor — que inclui essa mesma prévia. Em janela
  // normal isso já fica estranho; em tela cheia vira um espelho infinito
  // (o "erro" com dezenas de cursores da imagem). Isso não é um bug de
  // renderização, é o efeito Droste inevitável de exibir a própria captura
  // de tela em tela cheia. Só quem está do outro lado deve ver esse vídeo
  // ao vivo — pra você, mostramos um card fixo "transmitindo".
  const isOwnScreenShare = isSelf && screenOn && hasVideo;
  const wantKind = isOwnScreenShare ? 'sharing' : hasVideo ? 'video' : 'avatar';

  // Só recria o HTML de dentro do tile quando o "tipo" dele muda de fato
  // (passou a ter vídeo, deixou de ter, ou entrou/saiu do modo "sua
  // transmissão"). Se já é vídeo e continua sendo, NUNCA mexe no <video>
  // existente — só troca o srcObject. Recriar o nó via innerHTML a cada
  // render tirava a pessoa da tela cheia sozinha, porque o elemento em
  // tela cheia some do DOM assim que o innerHTML é reatribuído por cima.
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
      // O vídeo é sempre "muted": o som de verdade sai pelo <audio> dedicado
      // (ensureRemoteAudio), então tocar áudio pelo <video> também duplicaria o som.
      tile.innerHTML = `<video autoplay playsinline muted></video>${fsBtn}<div class="tile-name"><span class="mic-icon">🎤</span></div>`;
    } else {
      tile.innerHTML = `<div class="tile-avatar"><img alt=""></div><div class="tile-name"><span class="mic-icon">🎤</span></div>`;
    }
    tile.dataset.kind = wantKind;
  }

  // atualiza só o conteúdo dinâmico (nome, srcObject, avatar), sem tocar na
  // estrutura/nó de vídeo já existente.
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
}

function requestTileFullscreen(video) {
  if (!video) return;
  if (video.requestFullscreen) video.requestFullscreen();
  else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
}

$('voiceGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('.fs-btn');
  if (!btn) return;
  e.stopPropagation();
  const tile = document.getElementById(btn.dataset.tile);
  requestTileFullscreen(tile && tile.querySelector('video'));
});

$('voiceGrid').addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.voice-tile');
  if (!tile) return;
  requestTileFullscreen(tile.querySelector('video'));
});

socket.on('channel-members', (list) => {
  if (!voiceChannelId) return;
  const others = (list || []).filter(m => m.user_id !== userId);
  others.forEach(m => { if (!peers[m.user_id]) createPeer(m.user_id); });
  Object.keys(peers).forEach(uid => { if (!others.some(m => m.user_id === uid)) closePeer(uid); });
  renderVoiceGrid();
});

socket.on('user-left', ({ userId: uid }) => {
  if (peers[uid]) closePeer(uid);
  renderVoiceGrid();

    // ===== NOVA CORREÇÃO: REMOVER TRACKS ANTIGAS =====
  // Antes de adicionar a nova track, garanta que não existe outra track de vídeo
  const oldVideos = localStream.getVideoTracks();
  oldVideos.forEach(t => {
    if (t !== track) {
      t.stop();
      localStream.removeTrack(t);
    }
  });
  // ================================================

  Object.values(peers).forEach(p => p.pc.addTrack(track, localStream));
}
});

// Estado de câmera/tela de quem está na chamada, conforme o último aviso
// que recebemos por sinalização (evento abaixo). É essa informação — não a
// stream em si — que decide se mostramos vídeo ou o avatar de alguém: a
// track WebRTC removida às vezes continua "pendurada" no MediaStream do
// outro lado com o último frame congelado, sem disparar nenhum evento
// confiável de remoção em todos os navegadores. Antes, o código recebia
// esse aviso mas ignorava os campos camera/screen e nunca re-renderizava —
// por isso quem assistia continuava vendo a câmera/tela "aberta" mesmo
// depois de fechada do outro lado.
const remoteMediaState = {}; // remoteUserId -> { camera, screen }

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

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onnegotiationneeded = async () => {
    try {
      // Só inicia uma negociação nova se a conexão estiver "parada" (stable).
      // Sem essa checagem, com 3+ pessoas é comum esse evento disparar bem
      // no meio de uma negociação que já está em andamento (ex: acabamos de
      // receber uma oferta e ainda não respondemos) — aí setLocalDescription()
      // sem argumento cria uma RESPOSTA em vez de oferta (o navegador infere
      // pelo estado atual), o outro lado recebe uma resposta duplicada pra
      // mesma oferta, e a conexão quebra de vez. Se não está estável, quem
      // vai resolver isso é o próprio ciclo de negociação em andamento — não
      // precisamos fazer nada aqui, o evento volta a disparar sozinho quando
      // estabilizar.
      if (pc.signalingState !== 'stable') return;
      peer.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit('voice-signal', { to: remoteId, data: { sdp: pc.localDescription } });
    } catch (e) { console.error(e); }
    finally { peer.makingOffer = false; }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('voice-signal', { to: remoteId, data: { candidate } });
  };

  pc.ontrack = (e) => {
    peer.remoteStream = e.streams[0] || peer.remoteStream;
    renderVoiceGrid();
  };

  pc.onconnectionstatechange = () => {
    // 'disconnected' costuma ser passageiro (rede oscilou, ICE está
    // renegociando sozinho) — principalmente sob a carga extra de 3+
    // pessoas transmitindo câmera/tela ao mesmo tempo. Fechar a conexão na
    // hora, como fazíamos antes, matava participantes que teriam se
    // reconectado sozinhos em 1-2 segundos. Só derruba de vez se ficar
    // "failed"/"closed", ou se "disconnected" persistir por um tempo.
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

  return peer;
}

function closePeer(remoteId) {
  const p = peers[remoteId];
  if (!p) return;
  clearTimeout(p.disconnectTimer);
  try { p.pc.close(); } catch (e) {}
  delete peers[remoteId];
  delete remoteMediaState[remoteId];
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
      // Candidatos de ICE que chegaram antes da remote description estar
      // pronta (comum quando o outro lado inicia uma nova negociação, ex:
      // ao ligar a câmera/tela no meio de uma chamada só de áudio) ficam
      // guardados em peer.pendingCandidates; agora que a description já
      // foi aplicada, aplica todos eles. Sem isso, esses candidatos eram
      // simplesmente descartados e a conexão de vídeo podia nunca fechar
      // — fica com o track chegando mas nenhum dado fluindo, daí o vídeo
      // parece "carregando" pra sempre.
      if (peer.pendingCandidates.length) {
        for (const c of peer.pendingCandidates) {
          try { await peer.pc.addIceCandidate(c); } catch (e) { console.error(e); }
        }
        peer.pendingCandidates.length = 0;
      }
      if (data.sdp.type === 'offer') {
        await peer.pc.setLocalDescription();
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
$('leaveBtn').onclick = () => {
  if (voiceChannelId) leaveVoiceChannel(false);
  location.href = '/';
};

load();
