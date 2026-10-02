const { query, queryOne } = require('../index');
const crypto = require('crypto');

class Invite {
  static generateCode() {
                                                       
    return crypto.randomBytes(6).toString('base64url').slice(0, 8);
  }

  static async create({ serverId, creatorId, maxUses = null, expiresInHours = null }) {
    const code = this.generateCode();
    let expiresAt = null;
    if (expiresInHours && expiresInHours > 0) {
      expiresAt = Math.floor(Date.now() / 1000) + (expiresInHours * 3600);
    }

    await query(
      `INSERT INTO invites (code, server_id, creator_id, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [code, serverId, creatorId, maxUses || null, expiresAt]
    );

    return this.findByCode(code);
  }

  static async findByCode(code) {
    if (!code) return null;
    const cleanCode = String(code).trim();
    const now = Math.floor(Date.now() / 1000);
    const invite = await queryOne(
      `SELECT i.*, 
              s.name AS server_name, 
              s.icon AS server_icon, 
              s.banner_color AS server_banner_color,
              s.description AS server_description,
              (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) AS member_count,
              COALESCE(u.display_name, u.username, 'Um membro') AS creator_name
       FROM invites i
       LEFT JOIN servers s ON i.server_id = s.id
       LEFT JOIN users u ON i.creator_id = u.id
       WHERE i.code = $1`,
      [cleanCode]
    );

    if (!invite) return null;

                           
    if (invite.expires_at && invite.expires_at < now) {
      return { ...invite, expired: true };
    }

                                          
    if (invite.max_uses && invite.uses >= invite.max_uses) {
      return { ...invite, maxUsesReached: true };
    }

    return invite;
  }

  static async listByServer(serverId) {
    return query(
      `SELECT i.*, COALESCE(u.display_name, u.username, 'Um membro') AS creator_name
       FROM invites i
       LEFT JOIN users u ON i.creator_id = u.id
       WHERE i.server_id = $1
       ORDER BY i.created_at DESC`,
      [serverId]
    );
  }

  static async revoke(code, serverId) {
    await query(
      `DELETE FROM invites WHERE code = $1 AND server_id = $2`,
      [code, serverId]
    );
    return { success: true };
  }

  static async consumeForUser(code, userId) {
    if (!code || !userId) return null;
    const cleanCode = String(code).trim();
    const now = Math.floor(Date.now() / 1000);
    return queryOne(
      `WITH candidate AS (
         SELECT code, server_id
         FROM invites
         WHERE code = $1
           AND (expires_at IS NULL OR expires_at >= $3)
           AND (max_uses IS NULL OR COALESCE(uses, 0) < max_uses)
         FOR UPDATE
       ),
       inserted AS (
         INSERT INTO server_members (server_id, user_id, role)
         SELECT server_id, $2, 'member'
         FROM candidate
         ON CONFLICT (server_id, user_id) DO NOTHING
         RETURNING server_id
       )
       UPDATE invites i
       SET uses = COALESCE(i.uses, 0) + 1
       FROM inserted m
       WHERE i.code = $1 AND i.server_id = m.server_id
       RETURNING i.*`,
      [cleanCode, userId, now]
    );
  }
}

module.exports = Invite;
