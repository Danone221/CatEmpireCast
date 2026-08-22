const { query, queryOne } = require('../index');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');

class User {
  static async create({ username, password, displayName }) {
    const id = uuidv4();
    const hashedPassword = bcrypt.hashSync(password, 10);
    await query(
      `INSERT INTO users (id, username, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
      [id, username, displayName || username, hashedPassword]
    );
    return this.findById(id);
  }

  static async findById(id) {
    return queryOne(
      'SELECT id, username, display_name, avatar, banner, bio, banner_color, created_at FROM users WHERE id = $1',
      [id]
    );
  }

  static async getPublicProfile(id) {
    return queryOne(
      'SELECT id, username, display_name, avatar, banner, bio, banner_color, created_at FROM users WHERE id = $1',
      [id]
    );
  }

  static async findByUsername(username) {
    return queryOne('SELECT * FROM users WHERE username = $1', [username]);
  }

  static async findByDiscordId(discordId) {
    return queryOne('SELECT * FROM users WHERE discord_id = $1', [discordId]);
  }

  static async findOrCreateByDiscord({ discordId, username, displayName, avatar }) {
    const existing = await this.findByDiscordId(discordId);
    if (existing) return this.update(existing.id, { display_name: displayName, avatar });
    const id = uuidv4();
    let localUsername = username;
    if (await this.findByUsername(localUsername)) localUsername = `${username}_${discordId.slice(-5)}`;
    await query(
      `INSERT INTO users (id, username, display_name, avatar, password_hash, discord_id)
       VALUES ($1, $2, $3, $4, NULL, $5)`,
      [id, localUsername, displayName || localUsername, avatar || null, discordId]
    );
    return this.findById(id);
  }

  static async authenticate(username, password) {
    const user = await this.findByUsername(username);
    if (!user || !user.password_hash) return null;
    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) return null;
    return this.findById(user.id);
  }

  static async updatePassword(id, currentPassword, newPassword) {
    const rawUser = await queryOne('SELECT password_hash FROM users WHERE id = $1', [id]);
    if (!rawUser) throw new Error('Usuário não encontrado');
    if (rawUser.password_hash) {
      if (!currentPassword || !bcrypt.compareSync(currentPassword, rawUser.password_hash)) {
        throw new Error('Senha atual incorreta');
      }
    }
    const hashed = bcrypt.hashSync(newPassword, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, id]);
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
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${i}`, values);
    return this.findById(id);
  }

  static async getServers(userId) {
    return query(
      `SELECT s.*,
        (SELECT COUNT(*) FROM server_members WHERE server_id = s.id) as member_count,
        sm.role
      FROM servers s
      JOIN server_members sm ON s.id = sm.server_id
      WHERE sm.user_id = $1
      ORDER BY s.created_at`,
      [userId]
    );
  }
}

module.exports = User;
