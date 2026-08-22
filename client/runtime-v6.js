(() => {
  'use strict';
  if (window.__catEmpireRuntimeV6) return;
  window.__catEmpireRuntimeV6 = true;

  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const token = localStorage.getItem('cat_token') || params.get('token') || '';
  const userId = localStorage.getItem('cat_user_id') || params.get('userId') || '';
  const serverId = params.get('serverId') || localStorage.getItem('cat_last_server') || '';
  const isServer = !!$('serverName') && !!serverId;
  const isDm = !!$('dmSidebar');
  if (!token || (!isServer && !isDm)) return;

  const auth = () => ({'Content-Type':'application/json', Authorization:'Bearer '+token});
  async function api(url, options = {}) {
    const res = await fetch(url, {...options, headers:{...auth(), ...(options.headers || {})}});
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function cacheServers(list) {
    try { localStorage.setItem('cat_servers_cache', JSON.stringify(list || [])); } catch (_) {}
  }
  function readCachedServers() {
    try { const v = JSON.parse(localStorage.getItem('cat_servers_cache') || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  function renderRail(list) {
    const rail = $('railServers');
    if (!rail) return;
    const safe = Array.isArray(list) ? list : [];
    rail.innerHTML = safe.map(s => {
      const active = isServer && String(s.id) === String(serverId) ? ' active' : '';
      const icon = s.icon && /^(data:|https?:)/.test(s.icon)
        ? `<img src="${esc(s.icon)}" alt="" style="width:100%;height:100%;object-fit:cover">`
        : esc(s.icon || (s.name || 'CE').slice(0,2).toUpperCase());
      return `<div class="rail-icon${active}" data-cat-server="${esc(s.id)}" title="${esc(s.name || 'Servidor')}">${icon}</div>`;
    }).join('');
    rail.querySelectorAll('[data-cat-server]').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.catServer;
        localStorage.setItem('cat_last_server', id);
        location.href = '/server.html?serverId=' + encodeURIComponent(id);
      };
    });
  }
  async function loadRail() {
    const cached = readCachedServers();
    if (cached.length) renderRail(cached);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const list = await api('/api/servers');
        if (Array.isArray(list)) {
          cacheServers(list);
          renderRail(list);
          return list;
        }
      } catch (error) {
        console.warn('CAT EMPIRE: falha ao carregar servidores, tentativa', attempt + 1, error);
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    return cached;
  }

  function installVisualGuardrails() {
    const style = document.createElement('style');
    style.textContent = `
      .cat-v6-banner-large,.profile-modal-box .profile-banner,#viewProfileBanner,.banner-edit-wrap{min-height:240px!important;height:240px!important;background-size:cover!important;background-position:center!important}
      .profile-modal-box.profile-horizontal{width:min(860px,94vw)!important;max-width:860px!important}
      .gif-row,.gif-hint,.feature-gif-btn,.feature-emoji-btn,#featureGifUrl,#featureGifInsert,.feature-picker,#gifBtn,.gif-btn,[data-action="gif"]{display:none!important}
      .cat-v6-settings-section{border:2px solid #3b1b68;background:#0d0618;padding:14px;margin:12px 0}
      .cat-v6-settings-section h3{font:11px monospace;color:#fff;margin:0 0 10px}
      .cat-v6-settings-row{display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:1px solid #29104b;font:9px monospace;color:#fff}
      .cat-v6-settings-row:last-child{border-bottom:0}
      .cat-v6-settings-row .grow{flex:1}
      .cat-v6-settings-muted{color:#8d7ba9;font-size:8px}
      .cat-v6-mini-btn{border:2px solid #6e36b2;background:#26123f;color:#fff;padding:7px 10px;font:9px monospace;cursor:pointer}
    `;
    document.head.appendChild(style);
  }

  function applyServerBanner(server) {
    const banner = server?.banner || server?.banner_color;
    if (!banner) return;
    const targets = [$('serverHead')].filter(Boolean);
    targets.forEach(el => {
      if (/^(data:|https?:)/.test(String(banner))) {
        el.style.backgroundImage = `url("${String(banner).replace(/"/g,'\\"')}")`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        el.style.backgroundColor = '';
      } else {
        el.style.backgroundImage = 'none';
        el.style.backgroundColor = banner;
      }
      el.classList.add('cat-v6-banner-large');
    });
  }

  async function syncServerBanner() {
    if (!isServer) return;
    try { applyServerBanner(await api('/api/servers/' + encodeURIComponent(serverId))); } catch (_) {}
  }

  function removeGifControls() {
    document.querySelectorAll('.gif-row,.gif-hint,.feature-gif-btn,.feature-emoji-btn,#featureGifUrl,#featureGifInsert,.feature-picker,#gifBtn,.gif-btn,[data-action="gif"]').forEach(el => el.remove());
  }

  async function addServerSettingsEnhancements() {
    if (!isServer) return;
    const btn = $('serverSettingsBtn');
    if (!btn || btn.dataset.catV6Settings) return;
    btn.dataset.catV6Settings = '1';
    const observer = new MutationObserver(() => {
      const overlay = document.querySelector('.cat-v5-settings:not([hidden])');
      if (!overlay || overlay.querySelector('.cat-v6-settings-section')) return;
      const content = overlay.querySelector('.cat-v5-settings-content');
      if (!content) return;
      const section = document.createElement('section');
      section.className = 'cat-v6-settings-section';
      section.innerHTML = `<h3>ESTRUTURA DO SERVIDOR</h3>
        <div class="cat-v6-settings-row"><span class="grow">Categorias e canais</span><button class="cat-v6-mini-btn" data-v6-open="channels">Gerenciar</button></div>
        <div class="cat-v6-settings-row"><span class="grow">Membros</span><button class="cat-v6-mini-btn" data-v6-open="members">Gerenciar</button></div>
        <div class="cat-v6-settings-row"><span class="grow">Cargos</span><button class="cat-v6-mini-btn" data-v6-open="roles">Gerenciar</button></div>`;
      content.appendChild(section);
      section.querySelectorAll('[data-v6-open]').forEach(b => b.onclick = () => loadStructurePanel(overlay, b.dataset.v6Open));
    });
    observer.observe(document.body, {childList:true, subtree:true, attributes:true, attributeFilter:['hidden','class']});
  }

  async function loadStructurePanel(overlay, type) {
    const content = overlay.querySelector('.cat-v5-settings-content');
    if (!content) return;
    const existing = content.querySelector('.cat-v6-structure-panel');
    existing?.remove();
    const panel = document.createElement('section');
    panel.className = 'cat-v6-settings-section cat-v6-structure-panel';
    panel.innerHTML = `<h3>${type === 'channels' ? 'CANAIS & CATEGORIAS' : type === 'members' ? 'MEMBROS' : 'CARGOS'}</h3><div class="cat-v6-settings-muted">Carregando…</div>`;
    content.appendChild(panel);
    try {
      if (type === 'channels') {
        const data = await api('/api/features/servers/' + encodeURIComponent(serverId) + '/categories');
        const cats = data.categories || [];
        const chans = data.channels || [];
        panel.innerHTML = `<h3>CANAIS & CATEGORIAS</h3>` +
          cats.map(c => `<div class="cat-v6-settings-row"><span class="grow">▾ ${esc(c.name)}</span><span class="cat-v6-settings-muted">${chans.filter(x=>x.category===c.name).length} canais</span></div>`).join('') +
          chans.map(c => `<div class="cat-v6-settings-row"><span class="grow">${c.type==='voice'?'🔊':'#'} ${esc(c.name)}</span><span class="cat-v6-settings-muted">${esc(c.category || 'sem categoria')}</span></div>`).join('');
      } else if (type === 'members') {
        const server = await api('/api/servers/' + encodeURIComponent(serverId));
        const members = server.members || [];
        panel.innerHTML = `<h3>MEMBROS — ${members.length}</h3>` + members.map(m => `<div class="cat-v6-settings-row"><span class="grow">${esc(m.display_name || m.username)}</span><span class="cat-v6-settings-muted">${esc(m.role || 'member')}</span></div>`).join('');
      } else {
        const data = await api('/api/platform/servers/' + encodeURIComponent(serverId) + '/roles');
        const roles = Array.isArray(data) ? data : (data.roles || []);
        panel.innerHTML = `<h3>CARGOS</h3>` + roles.map(r => `<div class="cat-v6-settings-row"><span class="grow">${esc(r.name)}</span><span class="cat-v6-settings-muted">posição ${Number(r.position || 0)}</span></div>`).join('');
      }
    } catch (e) {
      panel.innerHTML = `<h3>ERRO</h3><div class="cat-v6-settings-muted">${esc(e.message)}</div>`;
    }
  }

  installVisualGuardrails();
  removeGifControls();
  new MutationObserver(removeGifControls).observe(document.body, {childList:true, subtree:true});
  loadRail();
  setTimeout(loadRail, 1500);
  if (isServer) {
    syncServerBanner();
    addServerSettingsEnhancements();
    setTimeout(syncServerBanner, 1200);
  }
})();
