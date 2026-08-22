const { query } = require('./index');

async function initMessagingSchema() {
  await query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS stickers JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at BIGINT;

    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      PRIMARY KEY(message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_type TEXT,
      file_size BIGINT,
      url TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS message_mentions (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT REFERENCES server_roles(id) ON DELETE CASCADE,
      mention_type TEXT NOT NULL CHECK (mention_type IN ('user','role','everyone','here')),
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS pinned_messages (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      pinned_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pinned_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_message_mentions_user ON message_mentions(user_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_pinned_messages_channel ON pinned_messages(channel_id, pinned_at DESC);
  `);
}

module.exports = { initMessagingSchema };
