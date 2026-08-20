const { query, queryOne } = require('../index');
const { v4: uuidv4 } = require('uuid');

class Channel {
  static async create({ serverId, name, type, category }) {
    const id = uuidv4();
    await query(
      `INSERT INTO channels (id, server_id, name, type, category) VALUES ($1, $2, $3, $4, $5)`,
      [id, serverId, name, type, category || 'CANAIS']
    );
    return this.findById(id);
  }

  static async findById(id) {
    return queryOne('SELECT * FROM channels WHERE id = $1', [id]);
  }

  static async findByServer(serverId) {
    return query('SELECT * FROM channels WHERE server_id = $1 ORDER BY category, position, name', [serverId]);
  }

  static async delete(id) {
    return query('DELETE FROM channels WHERE id = $1', [id]);
  }

  static async update(id, data) {
    const fields = [];
    const values = [];
    let i = 1;
    for (const [key, value] of Object.entries(data)) {
      fields.push(`${key} = $${i}`);
      values.push(value);
      i++;
    }
    values.push(id);
    return query(`UPDATE channels SET ${fields.join(', ')} WHERE id = $${i}`, values);
  }

  static async getMessages(channelId, limit = 100) {
    const rows = await query(
      `SELECT m.*, u.username, u.display_name, u.avatar
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.channel_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2`,
      [channelId, limit]
    );
    return rows.reverse();
  }

  static async saveMessage({ channelId, userId, content, file }) {
    const id = uuidv4();
    await query(
      `INSERT INTO messages (id, channel_id, user_id, content, file_name, file_type, file_size, file_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        channelId,
        userId,
        content || '',
        file?.name || null,
        file?.type || null,
        file?.size || null,
        file?.data || null
      ]
    );
    return this.getMessage(id);
  }

  static async getMessage(id) {
    return queryOne(
      `SELECT m.*, u.username, u.display_name, u.avatar
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.id = $1`,
      [id]
    );
  }

  static async getVoiceMembers(channelId) {
    return query(
      `SELECT vs.*, u.username, u.display_name, u.avatar
      FROM voice_states vs
      JOIN users u ON vs.user_id = u.id
      WHERE vs.channel_id = $1`,
      [channelId]
    );
  }

  static async joinVoice(userId, channelId) {
    await query(
      `INSERT INTO voice_states (user_id, channel_id, joined_at)
       VALUES ($1, $2, extract(epoch FROM now())::bigint)
       ON CONFLICT (user_id, channel_id)
       DO UPDATE SET joined_at = EXCLUDED.joined_at`,
      [userId, channelId]
    );
  }

  static async leaveVoice(userId, channelId) {
    await query('DELETE FROM voice_states WHERE user_id = $1 AND channel_id = $2', [userId, channelId]);
  }

  static async updateVoiceState(userId, channelId, muted, deafened) {
    await query(
      `UPDATE voice_states SET muted = $1, deafened = $2 WHERE user_id = $3 AND channel_id = $4`,
      [!!muted, !!deafened, userId, channelId]
    );
  }
}

module.exports = Channel;
