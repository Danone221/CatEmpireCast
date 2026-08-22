(function () {
  'use strict';

  const api = {
    async request(path, options = {}) {
      const token = localStorage.getItem('token') || localStorage.getItem('catEmpireToken');
      const headers = new Headers(options.headers || {});
      if (!headers.has('Content-Type') && options.body && typeof options.body !== 'string') headers.set('Content-Type', 'application/json');
      if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
      const body = options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body;
      const response = await fetch(path, { ...options, headers, body });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
      if (!response.ok) throw new Error(data && data.error ? data.error : `HTTP ${response.status}`);
      return data;
    },

    structure(serverId) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/structure`); },
    roles(serverId) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/roles`); },
    createRole(serverId, data) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/roles`, { method:'POST', body:data }); },
    updateRole(serverId, roleId, data) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`, { method:'PUT', body:data }); },
    deleteRole(serverId, roleId) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`, { method:'DELETE' }); },
    setMemberRoles(serverId, userId, roleIds) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/roles`, { method:'PUT', body:{roleIds} }); },
    savePermissions(serverId, data) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/permissions`, { method:'PUT', body:data }); },
    threads(channelId) { return this.request(`/api/platform/channels/${encodeURIComponent(channelId)}/threads`); },
    createThread(channelId, data) { return this.request(`/api/platform/channels/${encodeURIComponent(channelId)}/threads`, { method:'POST', body:data }); },
    forumPosts(channelId) { return this.request(`/api/platform/channels/${encodeURIComponent(channelId)}/forum/posts`); },
    createForumPost(channelId, data) { return this.request(`/api/platform/channels/${encodeURIComponent(channelId)}/forum/posts`, { method:'POST', body:data }); },
    friends() { return this.request('/api/platform/friends'); },
    addFriend(username) { return this.request(`/api/platform/friends/${encodeURIComponent(username)}`, { method:'POST' }); },
    acceptFriend(userId) { return this.request(`/api/platform/friends/${encodeURIComponent(userId)}/accept`, { method:'POST' }); },
    notifications() { return this.request('/api/platform/notifications'); },
    markNotificationRead(id) { return this.request(`/api/platform/notifications/${encodeURIComponent(id)}/read`, { method:'POST' }); },
    events(serverId) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/events`); },
    createEvent(serverId, data) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/events`, { method:'POST', body:data }); },
    rsvp(eventId) { return this.request(`/api/platform/events/${encodeURIComponent(eventId)}/rsvp`, { method:'POST' }); },
    moderation(serverId) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/moderation`); },
    moderate(serverId, data) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/moderation`, { method:'POST', body:data }); },
    auditLog(serverId) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/audit-log`); },
    onboarding(serverId) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/onboarding`); },
    saveOnboarding(serverId, data) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/onboarding`, { method:'PUT', body:data }); },
    automod(serverId) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/automod`); },
    saveAutomod(serverId, data) { return this.request(`/api/platform/servers/${encodeURIComponent(serverId)}/automod`, { method:'PUT', body:data }); }
  };

  window.CatEmpirePlatform = Object.freeze(api);
  window.dispatchEvent(new CustomEvent('cat-empire-platform-ready', { detail: api }));
})();
