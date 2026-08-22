(function () {
  'use strict';

  const token = () => localStorage.getItem('token') || localStorage.getItem('catEmpireToken');

  const request = async (path, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (!headers.has('Content-Type') && options.body && typeof options.body !== 'string') headers.set('Content-Type', 'application/json');
    const auth = token();
    if (auth && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${auth}`);
    const body = options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body;
    const response = await fetch(path, { ...options, headers, body });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!response.ok) throw Object.assign(new Error(data && data.error ? data.error : `HTTP ${response.status}`), { status: response.status, payload: data });
    return data;
  };

  const id = value => encodeURIComponent(value);

  const api = {
    request,
    structure: serverId => request(`/api/platform/servers/${id(serverId)}/structure`),
    roles: serverId => request(`/api/platform/servers/${id(serverId)}/roles`),
    createRole: (serverId, data) => request(`/api/platform/servers/${id(serverId)}/roles`, { method:'POST', body:data }),
    updateRole: (serverId, roleId, data) => request(`/api/platform/servers/${id(serverId)}/roles/${id(roleId)}`, { method:'PUT', body:data }),
    deleteRole: (serverId, roleId) => request(`/api/platform/servers/${id(serverId)}/roles/${id(roleId)}`, { method:'DELETE' }),
    setMemberRoles: (serverId, userId, roleIds) => request(`/api/platform/servers/${id(serverId)}/members/${id(userId)}/roles`, { method:'PUT', body:{roleIds} }),
    savePermissions: (serverId, data) => request(`/api/platform/servers/${id(serverId)}/permissions`, { method:'PUT', body:data }),
    threads: channelId => request(`/api/platform/channels/${id(channelId)}/threads`),
    createThread: (channelId, data) => request(`/api/platform/channels/${id(channelId)}/threads`, { method:'POST', body:data }),
    forumPosts: channelId => request(`/api/platform/channels/${id(channelId)}/forum/posts`),
    createForumPost: (channelId, data) => request(`/api/platform/channels/${id(channelId)}/forum/posts`, { method:'POST', body:data }),
    friends: () => request('/api/platform/friends'),
    addFriend: username => request(`/api/platform/friends/${id(username)}`, { method:'POST' }),
    acceptFriend: userId => request(`/api/platform/friends/${id(userId)}/accept`, { method:'POST' }),
    notifications: () => request('/api/platform/notifications'),
    markNotificationRead: notificationId => request(`/api/platform/notifications/${id(notificationId)}/read`, { method:'POST' }),
    events: serverId => request(`/api/platform/servers/${id(serverId)}/events`),
    createEvent: (serverId, data) => request(`/api/platform/servers/${id(serverId)}/events`, { method:'POST', body:data }),
    rsvp: eventId => request(`/api/platform/events/${id(eventId)}/rsvp`, { method:'POST' }),
    moderation: serverId => request(`/api/platform/servers/${id(serverId)}/moderation`),
    moderate: (serverId, data) => request(`/api/platform/servers/${id(serverId)}/moderation`, { method:'POST', body:data }),
    auditLog: serverId => request(`/api/platform/servers/${id(serverId)}/audit-log`),
    onboarding: serverId => request(`/api/platform/servers/${id(serverId)}/onboarding`),
    saveOnboarding: (serverId, data) => request(`/api/platform/servers/${id(serverId)}/onboarding`, { method:'PUT', body:data }),
    automod: serverId => request(`/api/platform/servers/${id(serverId)}/automod`),
    saveAutomod: (serverId, data) => request(`/api/platform/servers/${id(serverId)}/automod`, { method:'PUT', body:data }),

    // ===== V4 expansion =====
    fullServer: serverId => request(`/api/v4/servers/${id(serverId)}/full`),
    updateServerProfile: (serverId, data) => request(`/api/v4/servers/${id(serverId)}/profile`, { method:'PATCH', body:data }),
    security: serverId => request(`/api/v4/servers/${id(serverId)}/security`),
    saveSecurity: (serverId, data) => request(`/api/v4/servers/${id(serverId)}/security`, { method:'PUT', body:data }),
    community: serverId => request(`/api/v4/servers/${id(serverId)}/community`),
    saveCommunity: (serverId, data) => request(`/api/v4/servers/${id(serverId)}/community`, { method:'PUT', body:data }),
    invites: serverId => request(`/api/v4/servers/${id(serverId)}/invites`),
    createInvite: (serverId, data) => request(`/api/v4/servers/${id(serverId)}/invites`, { method:'POST', body:data }),
    useInvite: code => request(`/api/v4/invites/${id(code)}/use`, { method:'POST' }),
    revokeInvite: code => request(`/api/v4/invites/${id(code)}`, { method:'DELETE' }),
    emojis: serverId => request(`/api/v4/servers/${id(serverId)}/emojis`),
    createEmoji: (serverId, data) => request(`/api/v4/servers/${id(serverId)}/emojis`, { method:'POST', body:data }),
    deleteEmoji: (serverId, emojiId) => request(`/api/v4/servers/${id(serverId)}/emojis/${id(emojiId)}`, { method:'DELETE' }),
    stickers: serverId => request(`/api/v4/servers/${id(serverId)}/stickers`),
    createSticker: (serverId, data) => request(`/api/v4/servers/${id(serverId)}/stickers`, { method:'POST', body:data }),
    moderationV4: serverId => request(`/api/v4/servers/${id(serverId)}/moderation`),
    moderateV4: (serverId, data) => request(`/api/v4/servers/${id(serverId)}/moderation`, { method:'POST', body:data }),
    auditLogV4: serverId => request(`/api/v4/servers/${id(serverId)}/audit-log`),
    onboardingV4: serverId => request(`/api/v4/servers/${id(serverId)}/onboarding`),
    saveOnboardingV4: (serverId, data) => request(`/api/v4/servers/${id(serverId)}/onboarding`, { method:'PUT', body:data }),
    automodV4: serverId => request(`/api/v4/servers/${id(serverId)}/automod`),
    saveAutomodV4: (serverId, data) => request(`/api/v4/servers/${id(serverId)}/automod`, { method:'PUT', body:data }),
    search: query => request(`/api/v4/search?q=${encodeURIComponent(query)}`),
    member: (serverId, userId) => request(`/api/v4/servers/${id(serverId)}/members/${id(userId)}`)
  };

  window.CatEmpirePlatform = Object.freeze(api);
  window.dispatchEvent(new CustomEvent('cat-empire-platform-ready', { detail: api }));
})();
