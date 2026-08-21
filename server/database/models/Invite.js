const { query, queryOne } = require('../index');
const crypto = require('crypto');

class Invite {
  static generateCode() {
    // Código curto e amigável para URLs (ex: kx82hZ_1)
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
    const now = Math.floor(Date.now() / 1000);
    const invite = await queryOne(
      `SELECT i.*, 
              s.name AS server_name, 
              s.icon AS server_icon, 
              s.banner_color AS server_banner_color,
              s.description AS server_description,
              (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) AS member_count,
              u.display_name AS creator_name
       FROM invites i
       JOIN servers s ON i.server_id = s.id
       JOIN users u ON i.creator_id = u.id
       WHERE i.code = $1`,
      [code]
    );

    if (!invite) return null;

    // Verificar se expirou
    if (invite.expires_at && invite.expires_at < now) {
      return { ...invite, expired: true };
    }

    // Verificar se atingiu limite de usos
    if (invite.max_uses && invite.uses >= invite.max_uses) {
      return { ...invite, maxUsesReached: true };
    }

    return invite;
  }

  static async listByServer(serverId) {
    return query(
      `SELECT i.*, u.display_name AS creator_name
       FROM invites i
       JOIN users u ON i.creator_id = u.id
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

  static async use(code) {
    await query(
      `UPDATE invites SET uses = uses + 1 WHERE code = $1`,
      [code]
    );
  }
}

module.exports = Invite;
