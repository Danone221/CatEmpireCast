const { query } = require('./index');

async function initPlatformSchema() {
  await query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banner TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'online';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS activities JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS badges JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner TEXT;
    ALTER TABLE servers ADD COLUMN IF NOT EXISTS owner_id TEXT;
    ALTER TABLE servers ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE server_members ADD COLUMN IF NOT EXISTS nickname TEXT;
    ALTER TABLE server_members ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS topic TEXT;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS slowmode INTEGER DEFAULT 0;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE channels ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS server_roles (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT,
      icon TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      mentionable BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );
    CREATE INDEX IF NOT EXISTS idx_server_roles_server ON server_roles(server_id, position);

    CREATE TABLE IF NOT EXISTS server_role_members (
      role_id TEXT NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      PRIMARY KEY(role_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_role_members_server ON server_role_members(server_id, user_id);

    CREATE TABLE IF NOT EXISTS permission_overrides (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      category_id TEXT REFERENCES channel_categories(id) ON DELETE CASCADE,
      channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
      role_id TEXT REFERENCES server_roles(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','blocked')),
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      updated_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      PRIMARY KEY(user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS group_dms (
      id TEXT PRIMARY KEY,
      name TEXT,
      icon TEXT,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );
    CREATE TABLE IF NOT EXISTS group_dm_members (
      group_id TEXT NOT NULL REFERENCES group_dms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      PRIMARY KEY(group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      parent_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      locked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );
    CREATE TABLE IF NOT EXISTS thread_members (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      PRIMARY KEY(thread_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS forum_posts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'open',
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      updated_at BIGINT
    );

    CREATE TABLE IF NOT EXISTS server_emojis (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      image TEXT NOT NULL,
      animated BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );
    CREATE TABLE IF NOT EXISTS server_stickers (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      image TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS server_events (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      start_at BIGINT NOT NULL,
      end_at BIGINT,
      location TEXT,
      type TEXT DEFAULT 'other',
      status TEXT DEFAULT 'scheduled',
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );
    CREATE TABLE IF NOT EXISTS event_attendees (
      event_id TEXT NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      PRIMARY KEY(event_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS moderation_actions (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      moderator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN ('warning','kick','ban','timeout')),
      reason TEXT,
      started_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      expires_at BIGINT,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      reason TEXT,
      changes JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS onboarding_configs (
      server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      welcome_text TEXT,
      questions JSONB NOT NULL DEFAULT '[]'::jsonb,
      default_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
      default_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );
    CREATE TABLE IF NOT EXISTS automod_configs (
      server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      rules JSONB NOT NULL DEFAULT '{}'::jsonb,
      keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
      actions JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT,
      description TEXT,
      target JSONB NOT NULL DEFAULT '{}'::jsonb,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE INDEX IF NOT EXISTS idx_threads_channel ON threads(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_forum_posts_channel ON forum_posts(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_server_emojis_server ON server_emojis(server_id);
    CREATE INDEX IF NOT EXISTS idx_server_stickers_server ON server_stickers(server_id);
    CREATE INDEX IF NOT EXISTS idx_events_server ON server_events(server_id, start_at);
    CREATE INDEX IF NOT EXISTS idx_moderation_server_user ON moderation_actions(server_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_logs(server_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at);
  `);

  await query(`
    UPDATE servers SET owner_id = creator_id WHERE owner_id IS NULL;
    INSERT INTO server_roles (id, server_id, name, color, position, permissions)
    SELECT md5(s.id || ':everyone'), s.id, '@everyone', NULL, 0, '{"view_channel":true,"send_messages":true}'::jsonb
    FROM servers s
    WHERE NOT EXISTS (SELECT 1 FROM server_roles r WHERE r.server_id=s.id AND r.name='@everyone');
    INSERT INTO server_roles (id, server_id, name, position, permissions)
    SELECT md5(s.id || ':owner'), s.id, 'OWNER', 100, '{"administrator":true}'::jsonb
    FROM servers s
    WHERE NOT EXISTS (SELECT 1 FROM server_roles r WHERE r.server_id=s.id AND r.name='OWNER');
  `);
}

module.exports = { initPlatformSchema };
