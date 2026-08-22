/* CAT EMPIRE — Discord-style enhancements requested 2026-08-21 */
(function () {
  'use strict';

  const tokenValue = () => localStorage.getItem('cat_token') || '';
  const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenValue() });
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  let categories = [];
  let categoryLoaded = false;
  let callTimer = null;
  let callStartedAt = 0;

  function formatDate(epoch) {
    if (!epoch) return '—';
    const d = new Date(Number(epoch) * 1000);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? [h, m, s].map((v, i) => i === 0 ? String(v) : String(v).padStart(2, '0')).join(':')
      : String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function injectStyle() {
    if (document.getElementById('catEmpireEnhancementStyle')) return;
    const style = document.createElement('style');
    style.id = 'catEmpireEnhancementStyle';
    style.textContent = `
      /* ===== Perfis ===== */
      .profile-modal-box.profile-horizontal{width:min(680px,94vw);padding:0 24px 24px}
      .profile-meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
      .profile-meta-card{border:2px solid #3b1b68;background:#09020f;padding:10px 12px}
      .profile-meta-card .label{font-family:'Press Start 2P',monospace;font-size:7px;color:#7f6a98;margin-bottom:7px}
      .profile-meta-card .value{font-family:monospace;font-size:11px;color:#eee8ff;line-height:1.4}
      .profile-roles{margin-top:14px;border:2px solid #3b1b68;background:#09020f;padding:12px}
      .profile-roles-title{font-family:'Press Start 2P',monospace;font-size:8px;color:#8c74a9;margin-bottom:9px}
      .profile-role-list{display:flex;flex-wrap:wrap;gap:7px}
      .profile-role-badge{font-family:monospace;font-size:9px;font-weight:700;padding:5px 8px;border:1px solid currentColor;background:rgba(255,255,255,.03);text-shadow:0 0 7px currentColor}
      .profile-own-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
      .profile-own-actions .btn{margin:0!important;height:48px;min-height:48px;display:flex;align-items:center;justify-content:center}
      @media(max-width:560px){.profile-meta-grid{grid-template-columns:1fr}.profile-modal-box.profile-horizontal{width:94vw}.profile-own-actions{grid-template-columns:1fr}}

      /* ===== Hierarquia de membros ===== */
      .member-role-group{margin-bottom:13px}
      .member-role-heading{display:flex;align-items:center;gap:7px;padding:6px 6px 5px;color:#76658f;font-size:8px;letter-spacing:.8px}
      .member-role-heading .count{font-family:monospace;color:#4f4263}
      .member-row.role-highlight{padding-left:8px}
      .member-row.role-highlight .m-name{color:#eee8ff}
      .member-role-badge{font-family:monospace;font-size:7px;border:1px solid #5c4712;padding:2px 4px;white-space:nowrap}
      .member-row.owner-row .m-name{color:var(--gold)}

      /* ===== Categorias ===== */
      .channel-cat-actions{display:flex;align-items:center;gap:2px}
      .channel-cat-action{background:none;border:0;color:#6f5a88;font-size:11px;padding:2px 4px;cursor:pointer}
      .channel-cat-action:hover{color:#fff}
      .create-category-bar{width:100%;margin:2px 0 12px;padding:8px 10px;background:#10051d;border:2px dashed #3b1b68;color:#8d7ba9;font-family:monospace;font-size:9px;text-align:left;cursor:pointer}
      .create-category-bar:hover{border-color:var(--purple2);color:#fff}
      .category-empty{padding:5px 10px 8px;color:#4e4161;font-family:monospace;font-size:8px;font-style:italic}
      .channel-category[data-category-empty="true"]{min-height:38px}

      /* ===== Duração da call ===== */
      .call-duration{margin-left:auto;font-family:monospace;font-size:10px;color:#7fe0a0;border:1px solid #1c3f2c;padding:5px 8px;background:#0a1710;white-space:nowrap}

      /* ===== Digitando menor ===== */
      .typing-indicator{padding:2px 18px!important;min-height:11px!important;font-size:8px!important;line-height:1.2!important}

      /* ===== Categorias modal ===== */
      .category-modal-box{width:min(440px,92vw)}
      .category-modal-box input{margin-bottom:8px}

      /* ===== Campo de GIF ===== */
      .gif-ready-badge{font-family:monospace;font-size:8px;color:#b56bff;margin-left:4px}

      /* ===== Convite ===== */
      .btn-server-invite{cursor:pointer!important;pointer-events:auto!important}
    `;
    document.head.appendChild(style);
  }

  async function loadCategories() {
    try {
      const r = await fetch('/api/servers/' + encodeURIComponent(serverId) + '/categories', { headers: authHeaders() });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Erro ao carregar categorias');
      categories = Array.isArray(data) ? data : [];
      categoryLoaded = true;
      window.renderChannelList?.();
    } catch (e) {
      categoryLoaded = false;
      console.warn('[Cat Empire] categorias:', e.message);
    }
  }

  function categoryForChannel(channel) {
    return channel?.category || (channel?.type === 'voice' ? 'CANAIS DE VOZ' : 'CANAIS');
  }

  function roleInfo(member) {
    if (!member) return { key: 'MEMBRO', color: '#9a86bd', position: 10 };
    if (currentServer && member.id === currentServer.creator_id) return { key: 'FOUNDER', color: '#ffcd3c', position: 100 };
    if (member.role === 'admin') return { key: 'ADMIN', color: '#8b2bff', position: 80 };
    return { key: 'MEMBRO', color: '#9a86bd', position: 10 };
  }

  function enhancedRenderMembers() {
    const root = document.getElementById('membersList');
    if (!root) return;
    const groups = new Map();
    (members || []).forEach(m => {
      const info = roleInfo(m);
      if (!groups.has(info.key)) groups.set(info.key, { info, list: [] });
      groups.get(info.key).list.push(m);
    });
    const ordered = [...groups.values()].sort((a, b) => b.info.position - a.info.position);
    root.innerHTML = ordered.map(group => `
      <div class="member-role-group">
        <div class="member-role-heading"><span>${escapeHtml(group.info.key)}</span><span class="count">— ${group.list.length}</span></div>
        ${group.list.map(m => {
          const info = roleInfo(m);
          const online = onlineUserIds.has(m.id);
          const owner = currentServer && m.id === currentServer.creator_id;
          return `<div class="member-row role-highlight ${owner ? 'owner-row' : ''}" data-user-id="${escapeHtml(m.id)}">
            <div class="m-avatar"><img src="${escapeHtml(m.avatar || '/logo.svg')}" alt=""><span class="presence-dot ${online ? 'online' : 'offline'}"></span></div>
            <div class="m-name">${escapeHtml(m.display_name || m.username)}</div>
            <span class="member-role-badge" style="color:${info.color};border-color:${info.color}">${escapeHtml(info.key)}</span>
          </div>`;
        }).join('')}
      </div>
    `).join('');
    root.querySelectorAll('[data-user-id]').forEach(el => {
      el.addEventListener('click', () => window.openProfile?.(el.dataset.userId));
    });
  }

  function ensureCategoryModal() {
    if (document.getElementById('categoryEditModal')) return;
    const modal = document.createElement('div');
    modal.id = 'categoryEditModal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-box category-modal-box">
        <h2 id="categoryModalTitle">Nova categoria</h2>
        <p class="modal-hint" id="categoryModalHint">Crie uma categoria para organizar canais de texto e voz.</p>
        <input id="categoryNameInput" maxlength="40" placeholder="Nome da categoria">
        <div class="modal-actions">
          <button type="button" class="btn" id="categoryCancelBtn">Cancelar</button>
          <button type="button" class="btn btn-primary" id="categorySaveBtn">Salvar</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('categoryCancelBtn').onclick = () => modal.classList.remove('open');
  }

  function openCategoryEditor(category, isNew) {
    ensureCategoryModal();
    const modal = document.getElementById('categoryEditModal');
    const input = document.getElementById('categoryNameInput');
    const save = document.getElementById('categorySaveBtn');
    document.getElementById('categoryModalTitle').textContent = isNew ? 'Nova categoria' : 'Editar categoria';
    document.getElementById('categoryModalHint').textContent = isNew
      ? 'Crie uma categoria para organizar canais de texto e voz.'
      : 'Altere o nome. Os canais desta categoria serão atualizados automaticamente.';
    input.value = isNew ? '' : (category?.name || '');
    modal.classList.add('open');
    setTimeout(() => { input.focus(); input.select(); }, 30);
    save.onclick = async () => {
      const name = input.value.trim();
      if (!name) return toast('Digite um nome para a categoria.', 'error');
      try {
        const url = isNew
          ? '/api/servers/' + serverId + '/categories'
          : '/api/servers/' + serverId + '/categories/' + encodeURIComponent(category.id);
        const r = await fetch(url, {
          method: isNew ? 'POST' : 'PUT',
          headers: authHeaders(),
          body: JSON.stringify({ name })
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Erro ao salvar categoria');
        modal.classList.remove('open');
        await loadCategories();
        const serverRes = await fetch('/api/servers/' + serverId, { headers: authHeaders() });
        if (serverRes.ok) {
          const serverData = await serverRes.json();
          channels = serverData.channels || channels;
          currentServer = { ...currentServer, ...serverData };
        }
        window.renderChannelList?.();
        toast(isNew ? 'Categoria criada.' : 'Categoria atualizada.', 'success');
      } catch (e) { toast(e.message, 'error'); }
    };
  }

  async function deleteCategory(category) {
    if (!category) return;
    if (!(await uiConfirm('Excluir a categoria "' + category.name + '"? Os canais serão movidos para CANAIS.'))) return;
    try {
      const r = await fetch('/api/servers/' + serverId + '/categories/' + encodeURIComponent(category.id), { method: 'DELETE', headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Erro ao excluir categoria');
      await loadCategories();
      const serverRes = await fetch('/api/servers/' + serverId, { headers: authHeaders() });
      if (serverRes.ok) {
        const serverData = await serverRes.json();
        channels = serverData.channels || channels;
        currentServer = { ...currentServer, ...serverData };
      }
      window.renderChannelList?.();
      toast('Categoria excluída.', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  function enhancedRenderChannelList() {
    const root = document.getElementById('channelList');
    if (!root) return;
    const grouped = new Map();
    (categories || []).forEach(c => grouped.set(c.name, { category: c, channels: [] }));
    (channels || []).forEach(c => {
      const name = categoryForChannel(c);
      if (!grouped.has(name)) grouped.set(name, { category: { id: null, name, position: 999 }, channels: [] });
      grouped.get(name).channels.push(c);
    });
    const list = [...grouped.values()].sort((a, b) => Number(a.category.position || 0) - Number(b.category.position || 0) || String(a.category.name).localeCompare(String(b.category.name)));

    root.innerHTML = list.map(group => {
      const cat = group.category;
      const items = group.channels.map(c => {
        const icon = c.type === 'voice' ? '🔊' : '#';
        const activeText = activeMainView === 'text' && c.id === selectedTextChannelId;
        const activeVoice = activeMainView === 'voice' && c.id === voiceChannelId;
        const unread = c.type === 'text' && unreadChannels.has(c.id) ? ' has-unread' : '';
        return `<div class="channel-item ${activeText || activeVoice ? 'active' : ''}${unread}" data-id="${escapeHtml(c.id)}" data-type="${escapeHtml(c.type)}">
          <span class="icon">${icon}</span><span class="cname">${escapeHtml(c.name)}</span>
          ${unread ? '<span class="unread-dot"></span>' : ''}
          ${c.type === 'voice' && c.id === voiceChannelId ? '<span class="live-dot"></span>' : ''}
          ${myRole === 'admin' ? `<button class="del-btn" data-id="${escapeHtml(c.id)}" title="Excluir">✕</button>` : ''}
        </div>`;
      }).join('') || '<div class="category-empty">Nenhum canal ainda</div>';
      return `<div class="channel-category" data-category-empty="${group.channels.length ? 'false' : 'true'}">
        <div class="channel-cat-header">
          <span>${escapeHtml(cat.name)}</span>
          <div class="channel-cat-actions">
            ${myRole === 'admin' ? `<button class="channel-cat-action add-cat-channel" data-category="${escapeHtml(cat.name)}" title="Criar canal">＋</button>` : ''}
            ${myRole === 'admin' && cat.id ? `<button class="channel-cat-action edit-cat-btn" data-category-id="${escapeHtml(cat.id)}" title="Editar categoria">✎</button><button class="channel-cat-action delete-cat-btn" data-category-id="${escapeHtml(cat.id)}" title="Excluir categoria">🗑</button>` : ''}
          </div>
        </div>${items}
      </div>`;
    }).join('') + (myRole === 'admin' ? '<button type="button" class="create-category-bar" id="createCategoryBtn">＋ Criar categoria</button>' : '');

    root.querySelectorAll('.channel-item').forEach(el => {
      el.onclick = (e) => {
        if (e.target.closest('.del-btn')) return;
        if (el.dataset.type === 'voice') window.joinVoiceChannel?.(el.dataset.id);
        else window.openTextChannel?.(el.dataset.id);
        window.closeMobileSidebar?.();
      };
    });
    root.querySelectorAll('.del-btn').forEach(el => {
      el.onclick = async (e) => {
        e.stopPropagation();
        if (!(await uiConfirm('Excluir este canal?'))) return;
        try {
          const r = await fetch('/api/servers/' + serverId + '/channels/' + encodeURIComponent(el.dataset.id), { method: 'DELETE', headers: authHeaders() });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Erro ao excluir canal');
          channels = channels.filter(c => c.id !== el.dataset.id);
          window.renderChannelList?.();
        } catch (err) { toast(err.message, 'error'); }
      };
    });
    root.querySelectorAll('.add-cat-channel').forEach(el => {
      el.onclick = (e) => { e.stopPropagation(); window.openCreateChannelModal?.('text', el.dataset.category); };
    });
    root.querySelectorAll('.edit-cat-btn').forEach(el => {
      el.onclick = () => openCategoryEditor(categories.find(c => c.id === el.dataset.categoryId), false);
    });
    root.querySelectorAll('.delete-cat-btn').forEach(el => {
      el.onclick = () => deleteCategory(categories.find(c => c.id === el.dataset.categoryId));
    });
    root.querySelector('#createCategoryBtn')?.addEventListener('click', () => openCategoryEditor(null, true));
  }

  function installChannelCreateOverride() {
    const originalOpen = window.openCreateChannelModal;
    if (typeof originalOpen !== 'function' || originalOpen.__catEnhanced) return;
    const wrappedOpen = function (type, categoryName) {
      originalOpen(type || 'text');
      const modal = document.getElementById('createChannelModal');
      if (!modal) return;
      let wrap = document.getElementById('channelCategoryPickerWrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'channelCategoryPickerWrap';
        wrap.innerHTML = '<label class="kv-label" style="display:block;margin:12px 0 6px">CATEGORIA</label><select id="channelCategoryPicker"></select>';
        const typeToggle = modal.querySelector('.type-toggle');
        typeToggle?.parentNode.insertBefore(wrap, typeToggle);
      }
      const select = document.getElementById('channelCategoryPicker');
      select.innerHTML = categories.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
      if (categoryName) select.value = categoryName;
      if (!select.value && categories[0]) select.value = categories[0].name;
    };
    wrappedOpen.__catEnhanced = true;
    window.openCreateChannelModal = wrappedOpen;

    const confirm = document.getElementById('confirmChannelBtn');
    if (confirm && !confirm.dataset.catEnhanced) {
      confirm.dataset.catEnhanced = '1';
      confirm.onclick = async () => {
        const name = document.getElementById('newChannelName')?.value.trim();
        const type = document.getElementById('typeVoiceBtn')?.classList.contains('active') ? 'voice' : 'text';
        const category = document.getElementById('channelCategoryPicker')?.value || (type === 'voice' ? 'CANAIS DE VOZ' : 'CANAIS');
        if (!name) return toast('Digite um nome para o canal.', 'error');
        try {
          const r = await fetch('/api/servers/' + serverId + '/channels', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ name, type, category })
          });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Erro ao criar canal');
          channels.push(d);
          document.getElementById('createChannelModal').classList.remove('open');
          window.renderChannelList?.();
        } catch (e) { toast(e.message, 'error'); }
      };
    }
  }

  function roleMarkup(roles) {
    if (!roles?.length) return '<div class="profile-roles"><div class="profile-roles-title">CARGOS</div><div class="profile-role-list"><span class="profile-role-badge" style="color:#9a86bd">MEMBRO</span></div></div>';
    return `<div class="profile-roles"><div class="profile-roles-title">CARGOS</div><div class="profile-role-list">${roles.map(r => `<span class="profile-role-badge" style="color:${escapeHtml(r.color)};border-color:${escapeHtml(r.color)}">${escapeHtml(r.name)}</span>`).join('')}</div></div>`;
  }

  function ensureProfileExtraUI() {
    const modal = document.getElementById('viewProfileModal');
    if (!modal) return;
    const box = modal.querySelector('.modal-box');
    if (!box || box.querySelector('#viewProfileMeta')) return;
    const meta = document.createElement('div');
    meta.id = 'viewProfileMeta';
    meta.innerHTML = `
      <div class="profile-meta-grid">
        <div class="profile-meta-card"><div class="label">CONTA CRIADA</div><div class="value" id="viewProfileCreatedAt">—</div></div>
        <div class="profile-meta-card"><div class="label">ENTROU NO SERVIDOR</div><div class="value" id="viewProfileJoinedAt">—</div></div>
      </div>
      <div id="viewProfileRoles"></div>
      <div class="profile-own-actions" id="viewProfileOwnActions" hidden>
        <button type="button" class="btn btn-primary" id="editOwnProfileBtn">✎ Editar perfil</button>
        <button type="button" class="btn" id="closeOwnProfileBtn">Fechar</button>
      </div>`;
    const actions = box.querySelector('.modal-actions');
    actions?.parentNode.insertBefore(meta, actions);
    document.getElementById('editOwnProfileBtn')?.addEventListener('click', () => {
      modal.classList.remove('open');
      window.openMyProfileEditor?.();
    });
    document.getElementById('closeOwnProfileBtn')?.addEventListener('click', () => modal.classList.remove('open'));
  }

  async function showServerProfile(targetUserId, own) {
    try {
      ensureProfileExtraUI();
      const r = await fetch('/api/users/' + encodeURIComponent(targetUserId) + '/server-profile?serverId=' + encodeURIComponent(serverId), { headers: authHeaders() });
      const p = await r.json();
      if (!r.ok) throw new Error(p.error || 'Erro ao carregar perfil');
      viewingProfileId = targetUserId;
      applyBannerStyle(document.getElementById('viewProfileBanner'), p.banner_color || '#5865f2');
      document.getElementById('viewProfileAvatar').src = p.avatar || '/logo.svg';
      document.getElementById('viewProfileName').textContent = p.display_name || p.username;
      document.getElementById('viewProfileUsername').textContent = '@' + (p.username || 'usuario');
      document.getElementById('viewProfileBio').textContent = p.bio || 'Sem bio.';
      document.getElementById('viewProfileCreatedAt').textContent = formatDate(p.created_at);
      document.getElementById('viewProfileJoinedAt').textContent = formatDate(p.server_joined_at);
      document.getElementById('viewProfileRoles').innerHTML = roleMarkup(p.roles);
      const ownActions = document.getElementById('viewProfileOwnActions');
      const normalActions = document.getElementById('viewProfileModal').querySelector('.modal-box > .modal-actions');
      if (ownActions) ownActions.hidden = !own;
      if (normalActions) normalActions.hidden = !!own;
      document.getElementById('viewProfileModal').classList.add('open');
    } catch (e) { toast(e.message, 'error'); }
  }

  function openMyProfileEditor() {
    // Preserva o editor já existente em room.js. Só muda o ponto de entrada
    // do próprio perfil para a visualização pequena + "Editar perfil".
    const original = window.__catOriginalOpenMyProfile;
    if (typeof original === 'function') return original();
  }

  function installProfileOverrides() {
    ensureProfileExtraUI();
    if (!window.__catOriginalOpenMyProfile && typeof window.openMyProfile === 'function') {
      window.__catOriginalOpenMyProfile = window.openMyProfile;
      window.openMyProfile = () => showServerProfile(userId, true);
    }
    if (!window.__catOriginalOpenProfile && typeof window.openProfile === 'function') {
      window.__catOriginalOpenProfile = window.openProfile;
      window.openProfile = (targetId) => {
        if (targetId === userId) return showServerProfile(userId, true);
        return showServerProfile(targetId, false);
      };
    }
    document.getElementById('myAvatarBtn')?.addEventListener('click', () => showServerProfile(userId, true));
    document.getElementById('myInfoBtn')?.addEventListener('click', () => showServerProfile(userId, true));
    document.getElementById('userSettingsBtn')?.addEventListener('click', () => showServerProfile(userId, true));
  }

  function installCallTimer() {
    const header = document.getElementById('voiceChannelName');
    if (!header || header.parentElement.querySelector('#callDuration')) return;
    const duration = document.createElement('span');
    duration.id = 'callDuration';
    duration.className = 'call-duration';
    duration.textContent = '00:00';
    header.parentElement.appendChild(duration);

    const originalJoin = window.joinVoiceChannel;
    if (typeof originalJoin === 'function' && !originalJoin.__catTimerWrapped) {
      const wrappedJoin = async function (channelId) {
        const wasSame = typeof voiceChannelId !== 'undefined' && voiceChannelId === channelId;
        const result = await originalJoin(channelId);
        if (!wasSame) startCallTimer();
        return result;
      };
      wrappedJoin.__catTimerWrapped = true;
      window.joinVoiceChannel = wrappedJoin;
    }
    const originalLeave = window.leaveVoiceChannel;
    if (typeof originalLeave === 'function' && !originalLeave.__catTimerWrapped) {
      const wrappedLeave = function () {
        stopCallTimer();
        return originalLeave.apply(this, arguments);
      };
      wrappedLeave.__catTimerWrapped = true;
      window.leaveVoiceChannel = wrappedLeave;
    }
  }

  function startCallTimer() {
    if (callTimer) return;
    callStartedAt = Date.now();
    const el = document.getElementById('callDuration');
    const tick = () => {
      const target = document.getElementById('callDuration');
      if (target) target.textContent = formatDuration(Date.now() - callStartedAt);
    };
    tick();
    callTimer = setInterval(tick, 1000);
  }

  function stopCallTimer() {
    if (callTimer) clearInterval(callTimer);
    callTimer = null;
    const el = document.getElementById('callDuration');
    if (el) el.textContent = '00:00';
  }

  function installGifSupport() {
    const input = document.getElementById('fileInput');
    if (input) {
      input.accept = 'image/jpeg,image/png,image/gif,image/webp';
      input.setAttribute('data-gif-supported', 'true');
    }
    const attach = document.getElementById('attachBtn');
    if (attach) attach.title = 'Enviar imagem ou GIF';
  }

  function installNativeCastGuard() {
    const btn = document.getElementById('mobileCastBtn');
    if (!btn || btn.dataset.castGuardInstalled) return;
    btn.dataset.castGuardInstalled = '1';
    const original = btn.onclick;
    btn.onclick = async function () {
      if (window.CatEmpireNative && typeof window.CatEmpireNative.startBroadcast === 'function' && !window.__catNativeBroadcasting) {
        try {
          const r = await fetch('/api/channels/' + encodeURIComponent(voiceChannelId) + '/cast-credentials', { headers: authHeaders() });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Erro ao gerar credenciais.');
          if (!d.configured || !d.rtmpUrl || d.rtmpUrl.includes('SEU_HOST_DE_MIDIA')) {
            toast('Transmissão de tela do APK indisponível: o servidor RTMP ainda não está configurado.', 'error');
            return;
          }
          window.CatEmpireNative.startBroadcast(d.rtmpUrl, d.streamKey, videoSettings?.quality || 720, videoSettings?.fps || 30);
          return;
        } catch (e) {
          toast(e.message, 'error');
          return;
        }
      }
      if (typeof original === 'function') return original.call(this);
    };
  }

  function installInviteFix() {
    const btn = document.getElementById('serverInviteBtn');
    if (!btn || btn.dataset.inviteGuardInstalled) return;
    btn.dataset.inviteGuardInstalled = '1';
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof window.openInviteModal === 'function') window.openInviteModal();
      else document.getElementById('inviteModal')?.classList.add('open');
    };
  }

  function installCategorySocket() {
    if (typeof socket === 'undefined' || socket.__catCategoryEnhanced) return;
    socket.__catCategoryEnhanced = true;
    socket.on('category-updated', ({ serverId: changed }) => {
      if (changed === serverId) loadCategories();
    });
  }

  function bootstrap() {
    injectStyle();
    installGifSupport();
    installProfileOverrides();
    installCallTimer();
    installNativeCastGuard();
    installInviteFix();
    installCategorySocket();
    installChannelCreateOverride();
    loadCategories();

    // room.js já carregou o servidor. Re-renderiza os membros com a hierarquia
    // visual sem mexer na API de permissões existente.
    if (typeof window.renderMembers === 'function') window.renderMembers = enhancedRenderMembers;
    enhancedRenderMembers();
    enhancedRenderChannelList();

    // Se room.js atualizar membros/canais por socket, reaplica a apresentação.
    const observer = new MutationObserver(() => {
      if (document.getElementById('membersList') && !document.getElementById('membersList').dataset.catEnhanced) {
        document.getElementById('membersList').dataset.catEnhanced = '1';
        enhancedRenderMembers();
      }
    });
    const memberRoot = document.getElementById('membersList');
    if (memberRoot) observer.observe(memberRoot, { childList: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();
})();
