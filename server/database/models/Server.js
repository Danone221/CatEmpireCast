const { query, queryOne } = require('../index');
const { v4: uuidv4 } = require('uuid');
const Channel = require('./Channel');

class Server {
  static async create({ name, icon, creatorId }) {
    const id = uuidv4();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await query(
      `INSERT INTO servers (id, name, icon, code, creator_id) VALUES ($1, $2, $3, $4, $5)`,
      [id, name, icon || '🐱', code, creatorId]
    );

    await this.addMember(id, creatorId, 'admin');
    await Channel.create({ serverId: id, name: 'geral', type: 'text', category: 'CANAIS' });
    await Channel.create({ serverId: id, name: 'Geral', type: 'voice', category: 'CANAIS DE VOZ' });

    return this.findById(id);
  }

  static async findById(id) {
    return queryOne(
      `SELECT s.*,
        (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) as member_count
      FROM servers s
      WHERE s.id = $1`,
      [id]
    );
  }

  static async findByCode(code) {
    return queryOne('SELECT * FROM servers WHERE code = $1', [code]);
  }

  static async findByUser(userId) {
    return query(
      `SELECT s.*,
        (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) as member_count
      FROM servers s
      JOIN server_members sm ON s.id = sm.server_id
      WHERE sm.user_id = $1
      ORDER BY s.created_at`,
      [userId]
    );
  }

  static async addMember(serverId, userId, role = 'member') {
    await query(
      `INSERT INTO server_members (server_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (server_id, user_id) DO NOTHING`,
      [serverId, userId, role]
    );
  }

  static async removeMember(serverId, userId) {
    await query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
  }

  static async getMembers(serverId) {
    return query(
      `SELECT u.id, u.username, u.display_name, u.avatar, sm.role, sm.joined_at
      FROM server_members sm
      JOIN users u ON sm.user_id = u.id
      WHERE sm.server_id = $1
      ORDER BY sm.role DESC, u.display_name`,
      [serverId]
    );
  }

  static async getMemberRole(serverId, userId) {
    const row = await queryOne(
      'SELECT role FROM server_members WHERE server_id = $1 AND user_id = $2',
      [serverId, userId]
    );
    return row ? row.role : null;
  }

  static async update(id, data) {
    const allowed = ['name', 'icon', 'banner', 'banner_color', 'description'];
    const fields = [];
    const values = [];
    let i = 1;
    for (const key of allowed) {
      if (data[key] === undefined) continue;
      fields.push(`${key} = $${i}`);
      values.push(data[key]);
      i++;
    }
    if (!fields.length) return this.findById(id);
    values.push(id);
    await query(`UPDATE servers SET ${fields.join(', ')} WHERE id = $${i}`, values);
    return this.findById(id);
  }

  static async updateMemberRole(serverId, userId, role) {
    await query(
      'UPDATE server_members SET role = $3 WHERE server_id = $1 AND user_id = $2',
      [serverId, userId, role]
    );
  }

  static async delete(serverId) {
    await query('DELETE FROM servers WHERE id = $1', [serverId]);
  }

  static async getChannels(serverId) {
    return query(
      `SELECT * FROM channels
      WHERE server_id = $1
      ORDER BY category, position, name`,
      [serverId]
    );
  }
}

module.exports = Server;
