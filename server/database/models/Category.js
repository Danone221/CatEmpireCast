const { query, queryOne } = require('../index');
const { v4: uuidv4 } = require('uuid');

class Category {
  static async ensureFromChannels(serverId) {
    const rows = await query(
      `SELECT DISTINCT category FROM channels
       WHERE server_id = $1 AND category IS NOT NULL AND trim(category) <> ''`,
      [serverId]
    );
    for (const row of rows) {
      const name = String(row.category).trim();
      await query(
        `INSERT INTO channel_categories (id, server_id, name, position)
         VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM channel_categories WHERE server_id = $2), 0))
         ON CONFLICT (server_id, name) DO NOTHING`,
        [uuidv4(), serverId, name]
      );
    }
  }

  static async list(serverId) {
    await this.ensureFromChannels(serverId);
    return query(
      `SELECT c.id, c.server_id, c.name, c.position,
              (SELECT COUNT(*) FROM channels ch WHERE ch.server_id = c.server_id AND ch.category = c.name) AS channel_count
       FROM channel_categories c
       WHERE c.server_id = $1
       ORDER BY c.position, c.name`,
      [serverId]
    );
  }

  static async create(serverId, name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new Error('Nome da categoria é obrigatório');
    await this.ensureFromChannels(serverId);
    const exists = await queryOne(
      'SELECT id FROM channel_categories WHERE server_id = $1 AND lower(name) = lower($2)',
      [serverId, clean]
    );
    if (exists) throw new Error('Já existe uma categoria com esse nome');
    const id = uuidv4();
    await query(
      `INSERT INTO channel_categories (id, server_id, name, position)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) + 1 FROM channel_categories WHERE server_id = $2), 0))`,
      [id, serverId, clean]
    );
    return queryOne('SELECT id, server_id, name, position FROM channel_categories WHERE id = $1', [id]);
  }

  static async rename(serverId, categoryId, name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new Error('Nome da categoria é obrigatório');
    const current = await queryOne(
      'SELECT * FROM channel_categories WHERE id = $1 AND server_id = $2',
      [categoryId, serverId]
    );
    if (!current) throw new Error('Categoria não encontrada');
    if (current.name === clean) return current;
    const duplicate = await queryOne(
      'SELECT id FROM channel_categories WHERE server_id = $1 AND lower(name) = lower($2) AND id <> $3',
      [serverId, clean, categoryId]
    );
    if (duplicate) throw new Error('Já existe uma categoria com esse nome');

    await query('UPDATE channels SET category = $1 WHERE server_id = $2 AND category = $3', [clean, serverId, current.name]);
    await query('UPDATE channel_categories SET name = $1 WHERE id = $2 AND server_id = $3', [clean, categoryId, serverId]);
    return queryOne('SELECT id, server_id, name, position FROM channel_categories WHERE id = $1', [categoryId]);
  }

  static async remove(serverId, categoryId) {
    const current = await queryOne(
      'SELECT * FROM channel_categories WHERE id = $1 AND server_id = $2',
      [categoryId, serverId]
    );
    if (!current) throw new Error('Categoria não encontrada');
    await query('UPDATE channels SET category = $1 WHERE server_id = $2 AND category = $3', ['CANAIS', serverId, current.name]);
    await query('DELETE FROM channel_categories WHERE id = $1 AND server_id = $2', [categoryId, serverId]);
    return { success: true };
  }
}

module.exports = Category;
