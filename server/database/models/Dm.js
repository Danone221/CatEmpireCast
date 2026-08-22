const { query, queryOne } = require('../index');
const { v4: uuidv4 } = require('uuid');

class Dm {
  // Lista de conversas do usuário — a pessoa do outro lado, a última
  // mensagem trocada e quantas estão sem ler. Sem tabela de "conversa"
  // separada: a lista é derivada direto de dm_messages.
  static async getConversations(userId) {
    const rows = await query(
      `SELECT dm.*,
        su.username AS sender_username, su.display_name AS sender_display_name, su.avatar AS sender_avatar,
        ru.username AS recipient_username, ru.display_name AS recipient_display_name, ru.avatar AS recipient_avatar,
        EXISTS(SELECT 1 FROM user_blocks b WHERE b.blocker_id=$1 AND b.blocked_id=CASE WHEN dm.sender_id=$1 THEN dm.recipient_id ELSE dm.sender_id END) AS blocked_by_me,
        EXISTS(SELECT 1 FROM user_blocks b WHERE b.blocked_id=$1 AND b.blocker_id=CASE WHEN dm.sender_id=$1 THEN dm.recipient_id ELSE dm.sender_id END) AS blocked_me
      FROM dm_messages dm
      JOIN users su ON su.id = dm.sender_id
      JOIN users ru ON ru.id = dm.recipient_id
      WHERE dm.sender_id = $1 OR dm.recipient_id = $1
      ORDER BY dm.created_at DESC
      LIMIT 500`,
      [userId]
    );

    const byOther = new Map();
    for (const row of rows) {
      const isSender = row.sender_id === userId;
      const otherId = isSender ? row.recipient_id : row.sender_id;
      if (!byOther.has(otherId)) {
        byOther.set(otherId, {
          id: otherId,
          username: isSender ? row.recipient_username : row.sender_username,
          display_name: isSender ? row.recipient_display_name : row.sender_display_name,
          avatar: isSender ? row.recipient_avatar : row.sender_avatar,
          last_message: row.content,
          last_has_file: !!row.file_name,
          last_created_at: row.created_at,
          last_from_me: isSender,
          unread_count: 0,
          blocked_by_me: !!row.blocked_by_me,
          blocked_me: !!row.blocked_me
        });
      }
      if (!isSender && !row.read_at && !row.blocked_by_me && !row.blocked_me) {
        byOther.get(otherId).unread_count++;
      }
    }
    return Array.from(byOther.values()).sort((a, b) => b.last_created_at - a.last_created_at);
  }

  static async getMessages(userId, otherId, limit = 100) {
    const rows = await query(
      `SELECT dm.*,
        su.username AS sender_username, su.display_name AS sender_display_name, su.avatar AS sender_avatar
      FROM dm_messages dm
      JOIN users su ON su.id = dm.sender_id
      WHERE (dm.sender_id = $1 AND dm.recipient_id = $2) OR (dm.sender_id = $2 AND dm.recipient_id = $1)
      ORDER BY dm.created_at DESC
      LIMIT $3`,
      [userId, otherId, limit]
    );
    return rows.reverse();
  }

  static async send({ senderId, recipientId, content, file }) {
    const id = uuidv4();
    await query(
      `INSERT INTO dm_messages (id, sender_id, recipient_id, content, file_name, file_type, file_size, file_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id, senderId, recipientId, content || '',
        file?.name || null, file?.type || null, file?.size || null, file?.data || null
      ]
    );
    return this.getById(id);
  }

  static async getById(id) {
    return queryOne(
      `SELECT dm.*, su.username AS sender_username, su.display_name AS sender_display_name, su.avatar AS sender_avatar
      FROM dm_messages dm
      JOIN users su ON su.id = dm.sender_id
      WHERE dm.id = $1`,
      [id]
    );
  }

  static async edit(id, content) {
    await query(
      `UPDATE dm_messages SET content = $1, edited_at = extract(epoch FROM now())::bigint WHERE id = $2`,
      [content, id]
    );
    return this.getById(id);
  }

  static async delete(id) {
    await query('DELETE FROM dm_messages WHERE id = $1', [id]);
  }

  // Marca como lidas todas as mensagens que `otherId` mandou pra `userId`.
  static async markRead(userId, otherId) {
    await query(
      `UPDATE dm_messages SET read_at = extract(epoch FROM now())::bigint
       WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`,
      [userId, otherId]
    );
  }

  static async getUnreadTotal(userId) {
    const row = await queryOne(
      `SELECT COUNT(*) AS count FROM dm_messages dm WHERE recipient_id = $1 AND read_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id=$1 AND b.blocked_id=dm.sender_id) OR (b.blocked_id=$1 AND b.blocker_id=dm.sender_id))`,
      [userId]
    );
    return row ? parseInt(row.count, 10) : 0;
  }
}

module.exports = Dm;
