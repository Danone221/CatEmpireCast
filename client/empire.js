(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const paths = {
    screen:'<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
    camera:'<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/>',
    mic:'<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
    audio:'<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>',
    settings:'<path d="m10 2-.7 3-2 .9-2.8-.8-2 3.5 2.2 2.2v2.4L2.5 15l2 3.5 2.8-.8 2 .9.7 3h4l.7-3 2-.9 2.8.8 2-3.5-2.2-1.8v-2.4L21.5 8l-2-3.5-2.8.8-2-.9L14 2z"/><circle cx="12" cy="12" r="3"/>',
    chat:'<path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z"/>',
    users:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m3 11v-3a6 6 0 0 0-3-5"/>',
    link:'<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 2 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
    menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
    exit:'<path d="M9 3H3v18h6m5-15 6 6-6 6m-7-6h13"/>',
    phone:'<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',
    send:'<path d="m3 3 18 9-18 9 4-9-4-9zm4 9h14"/>',
    attach:'<path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2"/>',
    flip:'<path d="M4 9a8 8 0 0 1 14-4l2 3m-5 0h5V3M20 15a8 8 0 0 1-14 4l-2-3m5 0H4v5"/>'
  };
  const icon = name => `<svg class="empire-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.settings}</svg>`;
  const button = (id, glyph, label, extra='') => `<button type="button" class="btn ${extra}" id="${id}" title="${label}" aria-label="${label}">${icon(glyph)}<span class="action-label">${label}</span></button>`;
  if (!document.body.classList.contains('room-page')) return;
  const isServer = !!el('voiceView');
  const top = document.createElement('header');
  top.className = 'empire-topbar';
  top.innerHTML = `${button('workspaceNav','menu','Servidores','workspace-nav-toggle')}<a class="brand" href="/dms.html"><img class="brand-logo" src="/logo.svg" alt="">Cat Empire</a><span class="workspace-caption">${isServer ? 'Seu servidor. Sua comunidade.' : 'Conversas que aproximam.'}</span><nav class="workspace-actions" aria-label="Ações do espaço">${isServer ? button('workspaceInvite','link','Convidar') + button('watchChatToggle','chat','Chat') + button('workspaceMembers','users','Membros') : ''}${button('workspaceProfile','settings','Meu perfil')}</nav>`;
  document.body.prepend(top);
  if (!isServer) {
    const welcome = document.createElement('section');
    welcome.className = 'dm-welcome';
    welcome.innerHTML = `<div class="stage-symbol">${icon('chat')}</div><h1>Uma boa conversa começa aqui.</h1><p>Escolha uma mensagem na lateral ou convide alguém para conversar.</p>${button('welcomeFriend','users','Adicionar amigo')}`;
    el('messagesList').before(welcome);
    el('welcomeFriend').onclick = () => el('openAddFriendBtn')?.click();
  }
  el('workspaceNav').onclick = () => el('hamburgerBtn')?.click();
  el('workspaceProfile').onclick = () => el('userSettingsBtn')?.click();
  if (isServer) {
    el('workspaceInvite').onclick = () => el('serverInviteBtn')?.click();
    el('watchChatToggle').setAttribute('aria-pressed','true');
    el('watchChatToggle').onclick = () => {
      if (!document.body.classList.contains('watch-mode')) { el('messageInput')?.focus(); return; }
      document.body.classList.remove('show-workspace-members');
      el('membersSidebar')?.classList.remove('mobile-open');
      el('sidebarOverlay')?.classList.remove('open');
      const hidden = document.body.classList.toggle('watch-chat-hidden');
      el('watchChatToggle').setAttribute('aria-pressed',String(!hidden));
      el('workspaceMembers').setAttribute('aria-pressed','false');
    };
    el('workspaceMembers').setAttribute('aria-pressed','false');
    el('workspaceMembers').onclick = () => {
      if (matchMedia('(max-width:860px)').matches) { el('membersToggleBtn')?.click(); return; }
      const open = document.body.classList.toggle('show-workspace-members');
      document.body.classList.remove('watch-chat-hidden');
      el('workspaceMembers').setAttribute('aria-pressed',String(open));
      el('watchChatToggle').setAttribute('aria-pressed',String(!open));
    };
    const empty = document.createElement('section');
    empty.className = 'stage-empty';
    empty.innerHTML = `<div class="stage-symbol">${icon('screen')}</div><h2>A próxima transmissão pode ser sua.</h2><p>Compartilhe sua tela ou câmera com as pessoas deste canal.</p><div class="stage-actions">${button('stageShare','screen','Compartilhar tela')}${button('stageCamera','camera','Ligar câmera')}</div>`;
    el('voiceGrid').before(empty);
    el('stageShare').onclick = () => el('screenBtn').click();
    el('stageCamera').onclick = () => el('camBtn').click();
  }
  const controls = {micBtn:'mic',screenVolumeBtn:'audio',camBtn:'camera',flipCamBtn:'flip',videoSettingsBtn:'settings',screenBtn:'screen',mobileCastBtn:'phone',hangupBtn:'exit',userSettingsBtn:'settings',sendBtn:'send',attachBtn:'attach'};
  for (const [id,glyph] of Object.entries(controls)) {
    const control = el(id);
    if (!control) continue;
    // Some existing media handlers update button labels; observe only those
    // controls, leaving the media elements and their streams untouched.
    const decorate = () => {
      if (!control.querySelector('svg')) control.innerHTML = icon(glyph);
      control.setAttribute('aria-label',control.title || id);
      if (['micBtn','camBtn','screenBtn'].includes(id)) control.setAttribute('aria-pressed',String(control.classList.contains('active')));
    };
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(control,{childList:true,attributes:true,attributeFilter:['title','class']});
  }
  // The rails predate keyboard controls. Delegate so asynchronously loaded
  // server entries remain reachable after the server list refreshes.
  const rail = el('serverRail');
  if (rail) {
    const accessible = () => rail.querySelectorAll('.rail-icon').forEach(item => {
      item.tabIndex = 0; item.setAttribute('role','button');
      item.setAttribute('aria-label', item.title || 'Abrir servidor');
    });
    accessible();
    new MutationObserver(accessible).observe(rail,{childList:true,subtree:true});
    rail.addEventListener('keydown',event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.rail-icon')) { event.preventDefault(); event.target.click(); }
    });
  }
})();
