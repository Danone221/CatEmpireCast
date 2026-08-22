(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const token = localStorage.getItem('cat_token') || q.get('token') || '';
  const userId = localStorage.getItem('cat_user_id') || q.get('userId') || '';
  const serverId = q.get('serverId') || '';
  const isServer = !!$('serverSettingsBtn');
  const isDm = !!$('dmSidebar');
  if (!token || !userId) return;

  const auth = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
  const api = async (url, options = {}) => {
    const r = await fetch(url, { ...options, headers: { ...auth(), ...(options.headers || {}) } });
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(data?.error || 'Erro na requisição');
    return data;
  };

  const css = document.createElement('style');
  css.id = 'cat-final-ui-fixes';
  css.textContent = `
    :root{--cat-settings-bg:#0d0618;--cat-settings-panel:#120820;--cat-settings-line:#4a1f92;--cat-settings-bright:#8a3fe8}
    .feature-settings-overlay{position:fixed!important;inset:0!important;z-index:500!important;background:rgba(3,0,7,.96)!important;display:none!important}
    .feature-settings-overlay.open{display:flex!important}
    .feature-settings-nav{width:250px!important;flex:0 0 250px!important;background:#0d0319!important;border-right:3px solid #29104b!important;padding:24px 12px!important;overflow:auto}
    .feature-settings-brand{font:12px 'Press Start 2P',monospace;color:#fff;padding:0 10px 20px;text-shadow:0 0 10px rgba(181,107,255,.45)}
    .feature-settings-brand small{display:block;color:#8c74a9;font:8px monospace;margin-top:8px}
    .feature-nav-group{margin:18px 8px 7px;color:#6f5a88;font:8px monospace;text-transform:uppercase}
    .feature-nav-btn{display:block;width:100%;border:2px solid transparent;background:transparent;color:#b9acd0;text-align:left;padding:10px;font:9px monospace;cursor:pointer}
    .feature-nav-btn:hover,.feature-nav-btn.active{background:#26123f;color:#fff;border-color:#8a3fe8}
    .feature-settings-main{flex:1;overflow:auto;padding:34px 42px 70px;background:#0d0618!important;position:relative}
    .feature-settings-close{position:absolute;right:24px;top:20px;width:38px;height:38px;border:2px solid #5a2a95;background:#120820;color:#fff;font-size:20px;cursor:pointer}
    .v3-title{font:14px 'Press Start 2P',monospace;color:#fff;margin-bottom:8px}
    .v3-sub{font:10px monospace;color:#8d7ba9;line-height:1.6;margin-bottom:22px}
    .v3-field{margin-bottom:16px}.v3-field label{display:block;color:#8c74a9;font:9px monospace;margin-bottom:6px}
    .v3-field input,.v3-field textarea,.v3-field select{width:100%;background:#09020f;border:2px solid #3b1b68;color:#f2ecff;padding:10px;font:10px monospace;outline:none}
    .v3-field input:focus,.v3-field textarea:focus,.v3-field select:focus{border-color:#a65cff;box-shadow:0 0 0 2px rgba(166,92,255,.16)}
    .v3-field textarea{min-height:90px;resize:vertical}.v3-card{border:2px solid #3b1b68;background:#0d0618;padding:14px;margin-bottom:12px}
    .v3-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px}.v3-btn{border:2px solid #6e36b2;background:#26123f;color:#fff;padding:11px;font:10px monospace;cursor:pointer}.v3-btn.primary{background:linear-gradient(135deg,#8b2bff,#ff4fd8)}
    .v3-row{display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid #29104b;font:9px monospace}.v3-row:last-child{border-bottom:0}.v3-row .grow{flex:1}.v3-mini{border:1px solid #4b2a73;background:#120820;color:#ddd;padding:6px 8px;font:8px monospace;cursor:pointer}.v3-mini:hover{border-color:#a65cff;color:#fff}
    .v3-toggle{display:flex;justify-content:space-between;align-items:center;border:2px solid #3b1b68;background:#0d0618;padding:12px;margin-bottom:9px;font:9px monospace;color:#fff}.v3-toggle button{border:2px solid #4a1f92;background:#150a29;color:#9a86bd;padding:5px 9px;font:8px monospace;cursor:pointer}.v3-toggle button.on{border-color:#3ddc7a;color:#3ddc7a}
    .v3-banner{height:180px;border:2px solid #3b1b68;border-radius:4px;background:#5865f2 center/cover no-repeat;position:relative;margin-bottom:14px;overflow:hidden}.v3-banner-tools{position:absolute;right:10px;top:10px;display:flex;gap:7px}.v3-banner-tools button{border:2px solid #6e36b2;background:#120820;color:#fff;padding:8px 10px;font:8px monospace;cursor:pointer}.v3-banner-tools button:hover{border-color:#b56bff}
    .v3-icon{width:76px;height:76px;border:3px solid #8a3fe8;background:#10051d;display:grid;place-items:center;overflow:hidden;margin-top:-38px;position:relative;z-index:2}.v3-icon img{width:100%;height:100%;object-fit:cover}.v3-icon span{font-size:28px}
    .v3-role{font-size:8px;padding:4px 6px;border:1px solid #4b2a73;color:#b56bff;background:#120820}.v3-profile-date{font:9px monospace;color:#8d7ba9;margin-top:7px;line-height:1.7}.v3-role-chip{display:inline-block;padding:5px 7px;border:1px solid #4b2a73;background:#120820;margin:3px 4px 0 0;font:8px monospace}
    .cat-reaction-picker{position:fixed;z-index:800;display:grid;grid-template-columns:repeat(6,1fr);gap:4px;width:min(330px,calc(100vw - 20px));padding:9px;background:#120820;border:2px solid #6e36b2;box-shadow:6px 6px #050007}.cat-reaction-picker button{min-height:38px;border:1px solid #3b1b68;background:#0d0618;color:#fff;font:20px 'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif;cursor:pointer}.cat-reaction-picker button:hover{border-color:#a65cff;background:#26123f}
    .cat-actions{position:absolute!important;right:8px;top:-12px;display:none;gap:2px;padding:3px;background:#10051d;border:2px solid #4a1f92;box-shadow:4px 4px #050007;z-index:8}.message:hover .cat-actions,.message.cat-hold .cat-actions{display:flex!important}.cat-actions button{border:1px solid transparent;background:#150a29;color:#fff;padding:4px 6px;min-width:28px;font:16px 'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif;cursor:pointer}.cat-actions button:hover{border-color:#a65cff;background:#26123f}
    .cat-reactions{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}.cat-reactions button{border:1px solid #3b1b68;background:#10051d;color:#fff;padding:3px 6px;font:12px 'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif;cursor:pointer}.cat-reactions button.active{border-color:#a65cff;background:#26123f}
    .cat-mention{color:#d8a6ff;background:rgba(139,43,255,.16);border-radius:3px;padding:1px 3px}
    .cat-mention-box{position:absolute;z-index:700;display:none;max-height:190px;overflow:auto;background:#120820;border:2px solid #6e36b2;box-shadow:5px 5px #050007}.cat-mention-box.open{display:block}.cat-mention-item{padding:8px 10px;color:#f2ecff;font:9px monospace;cursor:pointer}.cat-mention-item:hover{background:#26123f}.cat-mention-item small{color:#8d7ba9;margin-left:5px}
    .cat-call-time{margin-left:8px;color:#8d7ba9;font:8px monospace;white-space:nowrap}.channel-item.active .cat-call-time{color:#b56bff}
    .profile-modal-box.profile-horizontal{width:min(780px,94vw)!important;max-height:90vh!important}.profile-modal-box .profile-banner{height:190px!important;min-height:190px!important;background-position:center!important;background-size:cover!important}.profile-modal-box .profile-avatar-big{width:104px!important;height:104px!important}.cat-profile-meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}.cat-profile-meta .v3-card{margin:0}.cat-profile-roles{margin-top:12px}
    .profile-settings-actions .btn{min-height:52px!important}.profile-settings-actions{margin-top:18px!important}
    .dm-friends-panel{padding:12px 10px;border-bottom:3px solid #29104b;background:rgba(13,3,25,.4)}.dm-friends-title{font:9px monospace;color:#fff;margin:0 8px 8px}.dm-friend-add{display:flex;gap:6px}.dm-friend-add input{flex:1;min-width:0;background:#09020f;border:2px solid #3b1b68;color:#eee8ff;padding:9px;font:9px monospace}.dm-friend-add button{width:42px;border:2px solid #5a2a95;background:#150a29;color:#b56bff;font:14px monospace;cursor:pointer}.dm-friend-add button:hover{border-color:#b56bff}
    .typing-indicator{font-size:8px!important;padding:4px 10px!important;min-height:0!important;line-height:1.2!important}
    .gif-row,.gif-hint,.feature-gif-btn,.feature-emoji-btn,#featureGifUrl,#featureGifInsert,.feature-picker,#gifBtn,.gif-btn,[data-action="gif"]{display:none!important}
    @media(max-width:700px){.feature-settings-nav{width:205px!important;flex-basis:205px!important}.feature-settings-main{padding:24px 18px 60px}.v3-banner{height:150px}.profile-modal-box .profile-banner{height:155px!important;min-height:155px!important}.cat-profile-meta{grid-template-columns:1fr}.cat-actions{right:4px;top:-8px}}
    @media(max-width:560px){.feature-settings-overlay.open{display:block!important;overflow:auto}.feature-settings-nav{display:block!important;width:100%!important;border-right:0;border-bottom:3px solid #29104b;padding:14px!important}.feature-settings-main{min-height:70vh;padding:20px 14px 45px}.feature-nav-btn{display:inline-block;width:auto;margin:2px}.feature-nav-group{margin:10px 5px 5px}.v3-actions{grid-template-columns:1fr}.v3-banner{height:135px}.profile-modal-box.profile-horizontal{width:96vw!important}}
  `;
  document.head.appendChild(css);

  const EMOJIS = ['❤️','😂','😮','😢','🔥','👍','👏','🎉','💜','💖','👀','💯'];

  function closeViewProfile() { $('viewProfileModal')?.classList.remove('open'); }

  function formatDate(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts) * 1000);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric' });
  }

  function formatDuration(startedAt) {
    if (!startedAt) return '';
    const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(startedAt)));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  // ---------- Banner persistente ----------
  async function refreshServerBanner() {
    if (!isServer || !serverId) return;
    try {
      const s = await api('/api/servers/' + encodeURIComponent(serverId));
      if (s.banner_color && typeof window.applyBannerStyle === 'function') window.applyBannerStyle($('serverHead'), s.banner_color);
      if (s.banner_color && $('serverHead')) {
        const isImage = /^(data:|https?:)/.test(s.banner_color);
        if (isImage) {
          $('serverHead').style.backgroundImage = `url("${s.banner_color}")`;
          $('serverHead').style.backgroundSize = 'cover';
          $('serverHead').style.backgroundPosition = 'center';
        }
      }
    } catch (_) {}
  }

  // ---------- Tempo da call ao lado do canal ----------
  let voiceStats = {};
  async function refreshVoiceStats() {
    if (!isServer || !serverId) return;
    try { voiceStats = await api('/api/features/servers/' + encodeURIComponent(serverId) + '/voice-stats'); }
    catch (_) { voiceStats = {}; }
    paintVoiceTimers();
  }
  function paintVoiceTimers() {
    document.querySelectorAll('#channelList .channel-item[data-type="voice"]').forEach(item => {
      const id = item.dataset.id;
      const name = item.querySelector('.cname');
      if (!name) return;
      if (!name.dataset.baseName) name.dataset.baseName = name.textContent.replace(/\s+\d{2}:\d{2}(?::\d{2})?$/,'').trim();
      let timer = name.querySelector('.cat-call-time');
      const stat = voiceStats[id];
      if (stat?.startedAt) {
        if (!timer) { timer = document.createElement('span'); timer.className = 'cat-call-time'; name.appendChild(timer); }
        timer.textContent = formatDuration(stat.startedAt);
      } else if (timer) timer.remove();
    });
  }
  if (isServer) {
    refreshVoiceStats();
    setInterval(() => { paintVoiceTimers(); }, 1000);
    setInterval(refreshVoiceStats, 5000);
    const channelList = $('channelList');
    if (channelList) new MutationObserver(() => setTimeout(paintVoiceTimers, 0)).observe(channelList, { childList:true, subtree:true });
  }

  // ---------- Perfil grande com datas + cargos ----------
  async function openFullProfile(targetId) {
    if (!targetId) return;
    if (targetId === userId) {
      closeViewProfile();
      const original = window.__catOriginalOpenMyProfile;
      if (typeof original === 'function') original();
      else $('editProfileModal')?.classList.add('open');
      return;
    }
    try {
      let p;
      if (serverId) p = await api('/api/users/' + encodeURIComponent(targetId) + '/server-profile?serverId=' + encodeURIComponent(serverId));
      else p = await api('/api/users/' + encodeURIComponent(targetId) + '/profile');
      const modal = $('viewProfileModal');
      if (!modal) return;
      const box = modal.querySelector('.modal-box');
      box?.classList.add('profile-horizontal');
      if ($('viewProfileBanner')) {
        if (p.banner_color && /^(data:|https?:)/.test(p.banner_color)) {
          $('viewProfileBanner').style.backgroundImage = `url("${p.banner_color}")`;
          $('viewProfileBanner').style.backgroundColor = '';
        } else {
          $('viewProfileBanner').style.backgroundImage = 'none';
          $('viewProfileBanner').style.backgroundColor = p.banner_color || '#5865f2';
        }
      }
      $('viewProfileAvatar').src = p.avatar || '/logo.svg';
      $('viewProfileName').textContent = p.display_name || p.username || 'Membro';
      $('viewProfileUsername').textContent = '@' + (p.username || 'usuario');
      $('viewProfileBio').textContent = p.bio || 'Sem bio.';
      let meta = box.querySelector('.cat-profile-extra');
      if (!meta) { meta = document.createElement('div'); meta.className = 'cat-profile-extra'; $('viewProfileBio').insertAdjacentElement('afterend', meta); }
      const roles = Array.isArray(p.roles) ? p.roles : [];
      meta.innerHTML = `
        <div class="cat-profile-meta">
          <div class="v3-card"><div class="kv-label">CONTA CRIADA</div><div style="font:10px monospace;color:#fff;margin-top:7px">${formatDate(p.created_at)}</div></div>
          <div class="v3-card"><div class="kv-label">ENTROU NO SERVIDOR</div><div style="font:10px monospace;color:#fff;margin-top:7px">${formatDate(p.server_joined_at)}</div></div>
        </div>
        <div class="cat-profile-roles"><div class="kv-label">CARGOS</div><div style="margin-top:5px">${roles.length ? roles.sort((a,b)=>(b.position||0)-(a.position||0)).map(r=>`<span class="v3-role-chip" style="color:${esc(r.color||'#b56bff')};border-color:${esc(r.color||'#4b2a73')}">${esc(r.name)}</span>`).join('') : '<span style="font:9px monospace;color:#8d7ba9">MEMBRO</span>'}</div></div>`;
      $('viewProfileModal').classList.add('open');
    } catch (e) { if (typeof toast === 'function') toast(e.message, 'error'); }
  }
  window.openProfile = openFullProfile;

  // Rebind member/message profile clicks through event delegation, so the new large profile is always used.
  if ($('membersList')) $('membersList').onclick = e => { const el = e.target.closest('[data-user-id]'); if (el) openFullProfile(el.dataset.userId); };
  if ($('messagesList')) $('messagesList').addEventListener('dblclick', e => { const el = e.target.closest('[data-user-id]'); if (el) openFullProfile(el.dataset.userId); });

  // Own profile: keep only the large editor, never the small view profile.
  if (typeof window.openMyProfile === 'function' && !window.__catOriginalOpenMyProfile) window.__catOriginalOpenMyProfile = window.openMyProfile;
  if (typeof window.__catOriginalOpenMyProfile === 'function') {
    const originalOwn = window.__catOriginalOpenMyProfile;
    window.openMyProfile = function() { closeViewProfile(); return originalOwn(); };
    ['myAvatarBtn','myInfoBtn','userSettingsBtn'].forEach(id => {
      const el = $(id); if (!el || el.dataset.catOwnBound) return;
      el.dataset.catOwnBound = '1';
      const clone = el.cloneNode(true); el.replaceWith(clone); $(id).addEventListener('click', window.openMyProfile);
    });
  }

  // ---------- Reações: hover no desktop / segurar no mobile ----------
  function picker(x, y, messageId) {
    document.querySelector('.cat-reaction-picker')?.remove();
    const p = document.createElement('div');
    p.className = 'cat-reaction-picker';
    p.style.left = Math.max(8, Math.min(innerWidth - 340, x)) + 'px';
    p.style.top = Math.max(8, Math.min(innerHeight - 250, y)) + 'px';
    p.innerHTML = EMOJIS.map(e => `<button type="button" data-e="${esc(e)}">${esc(e)}</button>`).join('');
    document.body.appendChild(p);
    p.onclick = e => { const b = e.target.closest('[data-e]'); if (!b) return; toggleReaction(messageId, b.dataset.e); p.remove(); };
    setTimeout(() => document.addEventListener('pointerdown', function outside(ev){ if (!p.contains(ev.target)) { p.remove(); document.removeEventListener('pointerdown', outside); } }, { once:true }), 0);
  }
  async function toggleReaction(messageId, emoji) {
    try {
      const d = await api('/api/features/reactions/toggle', { method:'POST', body:JSON.stringify({ type:isDm?'dm':'server', messageId, emoji }) });
      renderReactions(messageId, d.reactions || []);
    } catch (e) { if (typeof toast === 'function') toast(e.message, 'error'); }
  }
  function renderReactions(messageId, reactions) {
    const m = document.querySelector(`.message[data-message-id="${CSS.escape(messageId)}"]`); if (!m) return;
    let box = m.querySelector('.cat-reactions');
    if (!reactions.length) { box?.remove(); return; }
    if (!box) { box = document.createElement('div'); box.className='cat-reactions'; m.querySelector('.message-body')?.appendChild(box); }
    box.innerHTML = reactions.map(r => `<button type="button" class="${r.reacted?'active':''}" data-reaction="${esc(r.emoji)}">${esc(r.emoji)} ${r.count}</button>`).join('');
    box.querySelectorAll('[data-reaction]').forEach(b => b.onclick = () => toggleReaction(messageId, b.dataset.reaction));
  }
  async function hydrateReactions() {
    const list = $('messagesList'); if (!list) return;
    const ids = [...list.querySelectorAll('.message[data-message-id]')].map(x => x.dataset.messageId).filter(Boolean);
    if (!ids.length) return;
    try {
      const d = await api('/api/features/reactions?type=' + (isDm?'dm':'server') + '&ids=' + encodeURIComponent(ids.join(',')));
      Object.entries(d || {}).forEach(([id, reactions]) => renderReactions(id, reactions));
    } catch (_) {}
  }
  function addReactionActions() {
    const list = $('messagesList'); if (!list) return;
    list.querySelectorAll('.message[data-message-id]').forEach(m => {
      if (m.querySelector('.cat-actions')) return;
      m.style.position = 'relative';
      const actions = document.createElement('div'); actions.className='cat-actions';
      actions.innerHTML = EMOJIS.slice(0,6).map(e => `<button type="button" data-e="${esc(e)}">${esc(e)}</button>`).join('') + '<button type="button" class="more">＋</button>';
      m.appendChild(actions);
      actions.onclick = e => { e.stopPropagation(); const b=e.target.closest('button'); if(!b)return; if(b.classList.contains('more')){const r=m.getBoundingClientRect();picker(r.right-330,r.bottom+6,m.dataset.messageId);}else toggleReaction(m.dataset.messageId,b.dataset.e); };
      let holdTimer;
      m.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse') return; holdTimer=setTimeout(()=>m.classList.add('cat-hold'),450); }, { passive:true });
      ['pointerup','pointercancel','pointerleave'].forEach(k=>m.addEventListener(k,()=>{clearTimeout(holdTimer);setTimeout(()=>m.classList.remove('cat-hold'),700)}));
    });
  }
  if ($('messagesList')) {
    const mo = new MutationObserver(() => { addReactionActions(); setTimeout(hydrateReactions, 30); });
    mo.observe($('messagesList'), { childList:true, subtree:true });
    addReactionActions(); hydrateReactions();
  }

  // ---------- Menções @username ----------
  function highlightMentions(root) {
    if (!root) return;
    root.querySelectorAll('.message-content').forEach(el => {
      if (el.dataset.mentionsReady === '1') return;
      el.dataset.mentionsReady = '1';
      const members = Array.isArray(window.members) ? window.members : [];
      const names = new Set(members.map(m => String(m.username || '').toLowerCase()).filter(Boolean));
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes=[]; while(walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(node => {
        const text=node.nodeValue; const re=/@([A-Za-z0-9_.-]{2,32})/g; if(!re.test(text)) return;
        re.lastIndex=0; const frag=document.createDocumentFragment(); let last=0,m;
        while((m=re.exec(text))){ frag.appendChild(document.createTextNode(text.slice(last,m.index))); const span=document.createElement('span'); span.className='cat-mention'; span.textContent=m[0]; if(names.size && !names.has(m[1].toLowerCase())) span.style.opacity='.75'; frag.appendChild(span); last=re.lastIndex; }
        frag.appendChild(document.createTextNode(text.slice(last))); node.parentNode?.replaceChild(frag,node);
      });
    });
  }
  function setupMentionAutocomplete() {
    const input=$('messageInput'); if(!input || input.dataset.catMentionReady) return; input.dataset.catMentionReady='1';
    const wrap=input.parentElement; if(!wrap) return; wrap.style.position='relative';
    const box=document.createElement('div'); box.className='cat-mention-box'; wrap.appendChild(box);
    function hide(){box.classList.remove('open');}
    input.addEventListener('input',()=>{
      if (!isServer || !Array.isArray(window.members)) return hide();
      const before=input.value.slice(0,input.selectionStart); const match=before.match(/@([A-Za-z0-9_.-]*)$/); if(!match) return hide();
      const term=match[1].toLowerCase(); const list=window.members.filter(m=>m.id!==userId && String(m.username||'').toLowerCase().includes(term)).slice(0,8); if(!list.length)return hide();
      box.innerHTML=list.map(m=>`<div class="cat-mention-item" data-username="${esc(m.username)}">@${esc(m.username)} <small>${esc(m.display_name||'')}</small></div>`).join('');
      const r=input.getBoundingClientRect(); const wr=wrap.getBoundingClientRect(); box.style.left=(r.left-wr.left)+'px'; box.style.bottom=(wr.bottom-r.top+6)+'px'; box.style.width=Math.min(320,r.width)+'px'; box.classList.add('open');
    });
    box.onclick=e=>{const item=e.target.closest('[data-username]');if(!item)return;const start=input.selectionStart;const before=input.value.slice(0,start);const match=before.match(/@([A-Za-z0-9_.-]*)$/);if(!match)return;const replacement='@'+item.dataset.username+' ';input.value=before.slice(0,before.length-match[0].length)+replacement+input.value.slice(start);input.focus();input.setSelectionRange(before.length-match[0].length+replacement.length,before.length-match[0].length+replacement.length);hide();};
    input.addEventListener('keydown',e=>{if(e.key==='Escape')hide()});
  }
  setupMentionAutocomplete();
  highlightMentions($('messagesList'));

  // ---------- DMs: somente Amigos + adicionar por @username ----------
  function setupDmFriends() {
    if (!isDm) return;
    const side=$('dmSidebar'), list=$('dmList'); if(!side||!list||side.querySelector('.dm-friends-panel')) return;
    const p=document.createElement('div'); p.className='dm-friends-panel'; p.innerHTML='<div class="dm-friends-title">AMIGOS</div><div class="dm-friend-add"><input id="dmFriendUsername" placeholder="@username"><button type="button" id="dmFriendAddBtn">+</button></div>';
    side.insertBefore(p,list);
    const add=async()=>{const name=$('dmFriendUsername').value.trim().replace(/^@/,'');if(!name)return;try{const u=await api('/api/users/by-username/'+encodeURIComponent(name));if(typeof window.openConversation==='function')window.openConversation(u.id);$('dmFriendUsername').value='';if(typeof toast==='function')toast('Conversa aberta com @'+u.username,'success')}catch(e){if(typeof toast==='function')toast(e.message,'error')}};
    $('dmFriendAddBtn').onclick=add;$('dmFriendUsername').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();add()}};
  }
  setupDmFriends();

  // ---------- Remover GIF de forma persistente ----------
  function removeGifUi(){document.querySelectorAll('.feature-gif-btn,.feature-emoji-btn,#featureGifUrl,#featureGifInsert,.gif-row,.gif-hint,.feature-picker,#gifBtn,.gif-btn,[data-action="gif"]').forEach(el=>el.remove());}
  removeGifUi();
  new MutationObserver(removeGifUi).observe(document.body,{childList:true,subtree:true});

  // ---------- Configurações do servidor, completas e sem abas quebradas ----------
  function settingsShell() {
    document.getElementById('catV3Fixed')?.remove();
    document.getElementById('catV3Settings')?.remove();
    const o=document.createElement('div'); o.id='catV3Fixed'; o.className='feature-settings-overlay open';
    o.innerHTML=`<aside class="feature-settings-nav">
      <div class="feature-settings-brand">CAT EMPIRE<small>CONFIGURAÇÕES DO SERVIDOR</small></div>
      <div class="feature-nav-group">SERVIDOR</div>
      <button class="feature-nav-btn active" data-page="overview">Perfil do servidor</button>
      <button class="feature-nav-btn" data-page="channels">Canais e categorias</button>
      <div class="feature-nav-group">PESSOAS</div>
      <button class="feature-nav-btn" data-page="members">Membros</button>
      <button class="feature-nav-btn" data-page="roles">Cargos</button>
      <div class="feature-nav-group">MODERAÇÃO</div>
      <button class="feature-nav-btn" data-page="security">Configurações de segurança</button>
    </aside><main class="feature-settings-main"><button class="feature-settings-close" id="fixedClose">×</button><div id="fixedContent"></div></main>`;
    document.body.appendChild(o);
    o.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>showSettingsPage(b.dataset.page));
    $('fixedClose').onclick=()=>o.remove();
    return o;
  }
  let settingsServer=null;
  async function showSettingsPage(page){
    const content=$('fixedContent'); if(!content)return;
    document.querySelectorAll('#catV3Fixed [data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
    try {
      if(page==='overview') await settingsOverview(content);
      else if(page==='channels') await settingsChannels(content);
      else if(page==='members') await settingsMembers(content);
      else if(page==='roles') await settingsRoles(content);
      else await settingsSecurity(content);
    } catch(e) { content.innerHTML=`<div class="v3-title">Erro</div><div class="v3-sub">${esc(e.message)}</div>`; }
  }
  async function settingsOverview(c){
    settingsServer=await api('/api/features/servers/'+encodeURIComponent(serverId)+'/settings');
    const banner=settingsServer.banner_color||'#5865f2'; const icon=settingsServer.icon||'🐱'; const iconHtml=/^(data:|https?:)/.test(icon)?`<img src="${esc(icon)}" alt="">`:`<span>${esc(icon)}</span>`;
    c.innerHTML=`<div class="v3-title">Perfil do servidor</div><div class="v3-sub">Personalize o servidor. As alterações ficam salvas no Postgres e permanecem após F5.</div>
      <div class="v3-field"><label>NOME</label><input id="fxName" maxlength="40" value="${esc(settingsServer.name||'')}"></div>
      <div class="v3-field"><label>ÍCONE</label><div class="v3-icon" id="fxIcon">${iconHtml}</div><input id="fxIconFile" type="file" accept="image/*" hidden></div>
      <div class="v3-field"><label>FAIXA / BANNER</label><div class="v3-banner" id="fxBanner"></div><div class="v3-banner-tools"><button id="fxBannerFileBtn" type="button">📷 Imagem</button><button id="fxBannerDefault" type="button">🎨 Cor padrão</button></div><input id="fxBannerFile" type="file" accept="image/*" hidden></div>
      <div class="v3-field"><label>COR PERSONALIZADA</label><input id="fxColor" type="color" value="${/^#[0-9a-f]{6}$/i.test(banner)?banner:'#5865f2'}" style="height:44px;padding:4px"></div>
      <div class="v3-field"><label>DESCRIÇÃO</label><textarea id="fxDesc" maxlength="300">${esc(settingsServer.description||'')}</textarea></div>
      <div class="v3-actions"><button class="v3-btn" id="fxCancel">Cancelar</button><button class="v3-btn primary" id="fxSave">Salvar alterações</button></div>`;
    let bannerValue=banner, iconValue=icon;
    const apply=()=>{const el=$('fxBanner');if(!el)return;if(/^(data:|https?:)/.test(bannerValue)){el.style.backgroundImage=`url("${bannerValue}")`;el.style.backgroundColor='';}else{el.style.backgroundImage='none';el.style.backgroundColor=bannerValue||'#5865f2';} };
    apply();
    $('fxBannerFileBtn').onclick=()=>$('fxBannerFile').click();
    $('fxBannerDefault').onclick=()=>{bannerValue='#5865f2';$('fxColor').value='#5865f2';apply();};
    $('fxColor').oninput=e=>{bannerValue=e.target.value;apply();};
    $('fxBanner').onclick=()=>$('fxBannerFile').click();
    $('fxBannerFile').onchange=async()=>{const f=$('fxBannerFile').files[0];if(!f)return;try{bannerValue=await fileData(f,500*1024);apply();}catch(e){toast?.(e.message,'error')}finally{$('fxBannerFile').value=''}};
    $('fxIcon').onclick=()=>$('fxIconFile').click(); $('fxIconFile').onchange=async()=>{const f=$('fxIconFile').files[0];if(!f)return;try{iconValue=await fileData(f,500*1024);$('fxIcon').innerHTML=`<img src="${esc(iconValue)}" alt="">`}catch(e){toast?.(e.message,'error')}finally{$('fxIconFile').value=''}};
    $('fxCancel').onclick=()=>document.getElementById('catV3Fixed')?.remove();
    $('fxSave').onclick=async()=>{try{const d=await api('/api/servers/'+encodeURIComponent(serverId),{method:'PUT',body:JSON.stringify({name:$('fxName').value.trim(),description:$('fxDesc').value,bannerColor:bannerValue,icon:iconValue})});if(typeof window.applyBannerStyle==='function')window.applyBannerStyle($('serverHead'),d.banner_color);settingsServer=d;document.getElementById('catV3Fixed')?.remove();if(typeof toast==='function')toast('Configurações salvas.','success');setTimeout(refreshServerBanner,50)}catch(e){toast?.(e.message,'error')}};
  }
  function fileData(file,max){return new Promise((resolve,reject)=>{if(file.size>max)return reject(new Error('Imagem muito grande (máx. 500KB).'));const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('Erro ao ler imagem.'));r.readAsDataURL(file);});}
  async function reloadServer(){const d=await api('/api/servers/'+encodeURIComponent(serverId));if(Array.isArray(window.channels))window.channels=d.channels||[];if(Array.isArray(window.members))window.members=d.members||[];if(typeof window.myRole!=='undefined')window.myRole=d.myRole||window.myRole;window.renderChannelList?.();window.renderMembers?.();refreshVoiceStats();}
  async function settingsChannels(c){
    const d=await api('/api/features/servers/'+encodeURIComponent(serverId)+'/categories'); const cats=d.categories||d||[]; const chs=d.channels||[];
    c.innerHTML=`<div class="v3-title">Canais e categorias</div><div class="v3-sub">Crie, renomeie, mova e exclua categorias e canais.</div><div class="v3-card"><div class="v3-field"><label>NOVA CATEGORIA</label><input id="fxCat" maxlength="40" placeholder="ex.: MODERADOR"></div><button class="v3-btn primary" id="fxCatBtn">Criar categoria</button></div><div id="fxCats"></div>`;
    $('fxCatBtn').onclick=async()=>{const n=$('fxCat').value.trim();if(!n)return;try{await api('/api/features/servers/'+serverId+'/categories',{method:'POST',body:JSON.stringify({name:n})});await reloadServer();settingsChannels(c);}catch(e){toast?.(e.message,'error')}};
    const fallbackCats=cats.length?cats:Array.from(new Set(chs.map(x=>x.category).filter(Boolean))).map((name,i)=>({id:'virtual-'+i,name}));
    $('fxCats').innerHTML=fallbackCats.map(cat=>{const catChannels=chs.filter(x=>(x.category||'CANAIS')===cat.name);return `<div class="v3-card"><div class="v3-row"><b class="grow">${esc(cat.name)}</b><button class="v3-mini" data-ren="${esc(cat.id)}">Editar</button><button class="v3-mini" data-del="${esc(cat.id)}">Excluir</button></div>${catChannels.length?catChannels.map(ch=>`<div class="v3-row"><span>${ch.type==='voice'?'🔊':'#'}</span><span class="grow">${esc(ch.name)}</span><button class="v3-mini" data-ch="${esc(ch.id)}">Editar</button><button class="v3-mini" data-cd="${esc(ch.id)}">Excluir</button></div>`).join(''):'<div style="font:8px monospace;color:#6f5a88;padding:8px 0">Nenhum canal nesta categoria.</div>'}<div style="margin-top:10px"><button class="v3-mini" data-add="${esc(cat.name)}">＋ Criar canal nesta categoria</button></div></div>`}).join('');
    document.querySelectorAll('#fxCats [data-ren]').forEach(b=>b.onclick=async()=>{const cat=fallbackCats.find(x=>x.id===b.dataset.ren);if(!cat||String(cat.id).startsWith('virtual-'))return toast?.('Essa categoria ainda não possui registro próprio.','info');const n=prompt('Nome da categoria:',cat.name);if(!n)return;try{await api('/api/features/servers/'+serverId+'/categories/'+cat.id,{method:'PUT',body:JSON.stringify({name:n})});await reloadServer();settingsChannels(c);}catch(e){toast?.(e.message,'error')}});
    document.querySelectorAll('#fxCats [data-del]').forEach(b=>b.onclick=async()=>{const cat=fallbackCats.find(x=>x.id===b.dataset.del);if(!cat||String(cat.id).startsWith('virtual-'))return toast?.('Categoria padrão não pode ser excluída desta tela.','info');if(!(await uiConfirm('Excluir categoria? Os canais serão movidos para CANAIS.')))return;try{await api('/api/features/servers/'+serverId+'/categories/'+cat.id,{method:'DELETE'});await reloadServer();settingsChannels(c);}catch(e){toast?.(e.message,'error')}});
    document.querySelectorAll('#fxCats [data-ch]').forEach(b=>b.onclick=async()=>{const ch=chs.find(x=>x.id===b.dataset.ch);if(!ch)return;const n=prompt('Nome do canal:',ch.name);if(!n)return;try{await api('/api/features/servers/'+serverId+'/channels/'+ch.id,{method:'PUT',body:JSON.stringify({name:n})});await reloadServer();settingsChannels(c);}catch(e){toast?.(e.message,'error')}});
    document.querySelectorAll('#fxCats [data-cd]').forEach(b=>b.onclick=async()=>{if(!(await uiConfirm('Excluir canal?')))return;try{await api('/api/servers/'+serverId+'/channels/'+b.dataset.cd,{method:'DELETE'});await reloadServer();settingsChannels(c);}catch(e){toast?.(e.message,'error')}});
    document.querySelectorAll('#fxCats [data-add]').forEach(b=>b.onclick=async()=>{const name=prompt('Nome do novo canal:');if(!name)return;const type=confirm('OK = canal de voz / Cancelar = canal de texto');try{await api('/api/servers/'+serverId+'/channels',{method:'POST',body:JSON.stringify({name,type:type?'voice':'text',category:b.dataset.add})});await reloadServer();settingsChannels(c);}catch(e){toast?.(e.message,'error')}});
  }
  async function settingsMembers(c){
    const d=await api('/api/servers/'+encodeURIComponent(serverId));
    c.innerHTML=`<div class="v3-title">Membros</div><div class="v3-sub">Gerencie membros e a hierarquia do servidor.</div><div class="v3-card" id="fxMembers"></div>`;
    $('fxMembers').innerHTML=(d.members||[]).map(m=>`<div class="v3-row"><div class="m-avatar" style="width:30px;height:30px;flex:none"><img src="${esc(m.avatar||'/logo.svg')}" alt="" style="width:100%;height:100%;object-fit:cover"></div><span class="grow">${esc(m.display_name||m.username)}<small style="display:block;color:#6f5a88">@${esc(m.username)}</small></span><span class="v3-role">${d.creator_id===m.id?'FOUNDER':m.role==='admin'?'ADMIN':'MEMBRO'}</span>${d.creator_id===m.id||m.id===userId?'':`<button class="v3-mini" data-m="${esc(m.id)}">${m.role==='admin'?'Rebaixar':'Promover'}</button>`}</div>`).join('');
    document.querySelectorAll('#fxMembers [data-m]').forEach(b=>b.onclick=async()=>{const m=d.members.find(x=>x.id===b.dataset.m);try{await api('/api/servers/'+serverId+'/members/'+b.dataset.m+'/role',{method:'PUT',body:JSON.stringify({role:m.role==='admin'?'member':'admin'})});await reloadServer();settingsMembers(c);}catch(e){toast?.(e.message,'error')}});
  }
  async function settingsRoles(c){
    const d=await api('/api/features/servers/'+encodeURIComponent(serverId)+'/roles');
    c.innerHTML=`<div class="v3-title">Cargos</div><div class="v3-sub">Hierarquia visual do servidor.</div>${(d.roles||[]).map(r=>`<div class="v3-card"><div class="v3-row"><b style="color:${esc(r.color)}">${esc(r.name)}</b><span class="grow"></span><span class="v3-role">${r.count}</span></div><div style="font:8px monospace;color:#8d7ba9;line-height:1.6">${esc(r.description)}</div></div>`).join('')}`;
  }
  async function settingsSecurity(c){
    const d=await api('/api/features/servers/'+encodeURIComponent(serverId)+'/settings'); const s={verification:false,mediaFilter:false,mentions:false,...(d.security||{})};
    c.innerHTML=`<div class="v3-title">Configurações de segurança</div><div class="v3-sub">Controles persistidos no Postgres.</div><div id="fxSecurity">${[['verification','Verificação de entrada'],['mediaFilter','Filtro de mídia'],['mentions','Controle de menções']].map(([k,n])=>`<div class="v3-toggle"><span>${n}</span><button type="button" data-s="${k}" class="${s[k]?'on':''}">${s[k]?'ATIVO':'DESATIVADO'}</button></div>`).join('')}<div class="v3-actions"><button class="v3-btn primary" id="fxSecSave">Salvar segurança</button></div></div>`;
    document.querySelectorAll('#fxSecurity [data-s]').forEach(b=>b.onclick=()=>{s[b.dataset.s]=!s[b.dataset.s];b.classList.toggle('on',s[b.dataset.s]);b.textContent=s[b.dataset.s]?'ATIVO':'DESATIVADO';});
    $('fxSecSave').onclick=async()=>{try{await api('/api/features/servers/'+serverId+'/settings',{method:'PUT',body:JSON.stringify({security:s})});toast?.('Segurança salva.','success');}catch(e){toast?.(e.message,'error')}};
  }
  async function openServerSettingsFinal(){
    if(!isServer||!serverId)return;
    const o=settingsShell();
    try{await showSettingsPage('overview');}catch(e){toast?.(e.message,'error');}
  }
  if (isServer) $('serverSettingsBtn').onclick = e => { e.preventDefault(); openServerSettingsFinal(); };

  // ---------- GIF removido + call timer/profile after dynamic renders ----------
  if (isServer) {
    document.addEventListener('click', e => { const el=e.target.closest('[data-user-id]'); if(el && el.closest('#membersList')) openFullProfile(el.dataset.userId); });
    refreshServerBanner();
  }
  if (typeof window.renderChannelList === 'function') {
    const originalRender = window.renderChannelList;
    window.renderChannelList = function(){ const r=originalRender.apply(this,arguments); setTimeout(paintVoiceTimers,0); setTimeout(highlightMentions,20); return r; };
  }
  if (typeof window.renderMessages === 'function') {
    const originalRenderMessages=window.renderMessages;
    window.renderMessages=function(msgs){const r=originalRenderMessages.apply(this,arguments);setTimeout(()=>{addReactionActions();hydrateReactions();highlightMentions($('messagesList'));},30);return r;};
  }

  // Browser mobile: robust camera flip using applyConstraints first, then a new stream as fallback.
  if (isServer && $('flipCamBtn')) {
    $('flipCamBtn').onclick = async () => {
      if (!window.camOn || !window.localStream) return;
      const track=window.localStream.getVideoTracks?.()[0]; if(!track)return;
      const old=window.videoSettings?.facingMode || 'user'; const next=old==='environment'?'user':'environment';
      try {
        try { await track.applyConstraints({ facingMode: { exact: next } }); }
        catch (_) {
          const s=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:next}},audio:false}); const nt=s.getVideoTracks()[0];
          if(!nt)throw new Error('Câmera não encontrada');
          await window.replaceCameraTrack(nt); if(window.videoSettings)window.videoSettings.facingMode=next;
        }
        if(window.videoSettings){window.videoSettings.facingMode=next;localStorage.setItem('cat_video_settings',JSON.stringify(window.videoSettings));}
        window.renderVoiceGrid?.();
      } catch(e) { if(typeof toast==='function')toast('Não foi possível virar a câmera neste dispositivo.','error'); }
    };
  }

  // Prevent the old DM/feature GIF button from reappearing after async scripts.
  setTimeout(removeGifUi,500); setTimeout(removeGifUi,1500);
})();
