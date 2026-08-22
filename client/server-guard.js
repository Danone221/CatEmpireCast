(() => {
  'use strict';

  // Never let a missing Socket.IO client library prevent the entire server UI
  // from booting. Realtime/voice can degrade gracefully; HTTP server data must
  // still render.
  if (typeof window.io !== 'function') {
    const listeners = new Map();
    window.io = function () {
      return {
        connected: false,
        on(event, handler) {
          if (!listeners.has(event)) listeners.set(event, []);
          listeners.get(event).push(handler);
          return this;
        },
        emit() { return this; },
        off() { return this; },
        once(event, handler) {
          const wrapped = (...args) => handler(...args);
          return this.on(event, wrapped);
        },
        disconnect() { return this; }
      };
    };
    window.__catEmpireSocketFallback = true;
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>\"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function authHeaders() {
    const q = new URLSearchParams(location.search);
    const token = localStorage.getItem('cat_token') || q.get('token') || '';
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  }

  async function recoverServerView() {
    const q = new URLSearchParams(location.search);
    const serverId = q.get('serverId') || localStorage.getItem('cat_last_server');
    if (!serverId) return;

    // If the normal room.js boot succeeded, do not touch its DOM/state.
    const channelList = document.getElementById('channelList');
    const membersList = document.getElementById('membersList');
    const hasChannels = !!channelList?.querySelector('.channel-item');
    const hasMembers = !!membersList?.querySelector('.member-row');
    if (hasChannels || hasMembers) return;

    try {
      const r = await fetch('/api/servers/' + encodeURIComponent(serverId), { headers: authHeaders() });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || 'Erro ao carregar servidor');

      const channels = Array.isArray(data.channels) ? data.channels : [];
      const members = Array.isArray(data.members) ? data.members : [];
      const role = data.myRole || 'member';

      const serverName = document.getElementById('serverName');
      const mobileTitle = document.getElementById('mobileTitle');
      if (serverName) serverName.textContent = data.name || 'Servidor';
      if (mobileTitle) mobileTitle.textContent = data.name || 'CAT EMPIRE';

      if (channelList) {
        const groups = {};
        channels.forEach(c => {
          const cat = c.category || (c.type === 'voice' ? 'CANAIS DE VOZ' : 'CANAIS');
          (groups[cat] ||= []).push(c);
        });
        channelList.innerHTML = Object.entries(groups).map(([cat, items]) => `
          <div class="channel-category">
            <div class="channel-cat-header"><span>${esc(cat)}</span></div>
            ${items.map(c => `<div class="channel-item" data-id="${esc(c.id)}" data-type="${esc(c.type)}">
              <span class="icon">${c.type === 'voice' ? '🔊' : '#'}</span>
              <span class="cname">${esc(c.name)}</span>
            </div>`).join('')}
          </div>
        `).join('');
      }

      if (membersList) {
        membersList.innerHTML = members.map(m => `
          <div class="member-row" data-user-id="${esc(m.id)}">
            <div class="m-avatar"><img src="${esc(m.avatar || '/logo.svg')}" alt=""></div>
            <div class="m-name">${esc(m.display_name || m.username || 'Membro')}</div>
            ${m.role === 'admin' ? '<span class="m-badge">ADMIN</span>' : ''}
          </div>
        `).join('');
      }
      const count = document.getElementById('memberCount');
      if (count) count.textContent = String(members.length);
      const roleEl = document.getElementById('myRole');
      if (roleEl) roleEl.textContent = role === 'admin' ? 'admin' : 'membro';

      // Keep the page usable even if room.js aborted before wiring events.
      channelList?.querySelectorAll('.channel-item').forEach(el => {
        el.addEventListener('click', () => {
          const id = el.dataset.id;
          const type = el.dataset.type;
          if (type === 'text') {
            const ch = channels.find(c => c.id === id);
            const title = document.getElementById('chatChannelName');
            if (title) title.textContent = '# ' + (ch?.name || 'canal');
            loadMessagesFallback(id);
          }
        });
      });

      // The normal room.js loader will usually have opened the first text
      // channel already. If it did not, open it here without changing styles.
      if (!hasChannels) {
        const firstText = channels.find(c => c.type === 'text');
        if (firstText) {
          const title = document.getElementById('chatChannelName');
          if (title) title.textContent = '# ' + firstText.name;
          await loadMessagesFallback(firstText.id);
        }
      }
    } catch (error) {
      console.error('[CAT EMPIRE] fallback server load failed:', error);
    }
  }

  async function loadMessagesFallback(channelId) {
    const list = document.getElementById('messagesList');
    if (!list) return;
    try {
      const r = await fetch('/api/channels/' + encodeURIComponent(channelId) + '/messages', { headers: authHeaders() });
      const messages = await r.json();
      if (!r.ok) throw new Error(messages?.error || 'Erro ao carregar mensagens');
      if (!Array.isArray(messages) || !messages.length) {
        list.innerHTML = '<p class="empty-hint">Nenhuma mensagem ainda. Seja o primeiro a escrever!</p>';
        return;
      }
      list.innerHTML = messages.map(m => `
        <div class="message">
          <div class="message-avatar"><img src="${esc(m.avatar || '/logo.svg')}" alt=""></div>
          <div class="message-body">
            <div class="message-head"><span class="message-author">${esc(m.display_name || m.username || 'Membro')}</span><span class="message-time">${m.created_at ? new Date(Number(m.created_at) * 1000).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}) : ''}</span></div>
            <div class="message-content">${esc(m.content || '')}</div>
          </div>
        </div>
      `).join('');
      list.scrollTop = list.scrollHeight;
    } catch (error) {
      list.innerHTML = '<p class="empty-hint">Erro ao carregar mensagens.</p>';
    }
  }

  const run = () => setTimeout(recoverServerView, 900);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
})();
