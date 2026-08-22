const { query } = require('./index');

/**
 * Additive schema for the Cat Empire platform expansion.
 * This file never drops or resets existing data.
 */
async function initExpansionSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS server_invites (
      code TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
      creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uses INTEGER NOT NULL DEFAULT 0,
      max_uses INTEGER,
      expires_at BIGINT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','revoked')),
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );
    CREATE INDEX IF NOT EXISTS idx_server_invites_server ON server_invites(server_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS server_guides (
      server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      rules TEXT,
      guide TEXT,
      announcement_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
      updated_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS server_search_documents (
      id TEXT PRIMARY KEY,
      server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
      channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT,
      content TEXT,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );
    CREATE INDEX IF NOT EXISTS idx_search_documents_kind ON server_search_documents(kind);
    CREATE INDEX IF NOT EXISTS idx_search_documents_server ON server_search_documents(server_id, kind);

    CREATE TABLE IF NOT EXISTS server_security (
      server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      verification_level TEXT NOT NULL DEFAULT 'low',
      explicit_media_filter BOOLEAN NOT NULL DEFAULT FALSE,
      raid_protection BOOLEAN NOT NULL DEFAULT FALSE,
      two_factor_moderation BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS server_community (
      server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      rules_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
      updates_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
      default_notifications TEXT NOT NULL DEFAULT 'all',
      updated_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS server_member_notes (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      note TEXT NOT NULL DEFAULT '',
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      PRIMARY KEY(server_id, user_id)
    );
  `);
}

module.exports = { initExpansionSchema };
