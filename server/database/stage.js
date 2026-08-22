const { query } = require('./index');

/**
 * Stage channel persistence.
 * This is additive: it does not alter or delete existing voice data.
 */
async function initStageSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS stage_members (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'audience' CHECK (role IN ('moderator','speaker','audience')),
      muted BOOLEAN NOT NULL DEFAULT FALSE,
      deafened BOOLEAN NOT NULL DEFAULT FALSE,
      speaking BOOLEAN NOT NULL DEFAULT FALSE,
      joined_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      updated_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      PRIMARY KEY(channel_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_stage_members_channel_role
      ON stage_members(channel_id, role, joined_at);
  `);
}

module.exports = { initStageSchema };
