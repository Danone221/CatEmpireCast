const { query, queryOne } = require('../index');
const { v4: uuidv4 } = require('uuid');

const SYSTEM_ROLES = new Set(['@everyone', 'OWNER']);

class Role {
  static async list(serverId) {
    return query(
      `SELECT r.*, COUNT(rm.user_id)::int AS member_count
       FROM server_roles r
       LEFT JOIN server_role_members rm ON rm.role_id = r.id
       WHERE r.server_id = $1
       GROUP BY r.id
       ORDER BY r.position DESC, r.created_at ASC`,
      [serverId]
    );
  }

  static async findById(serverId, roleId) {
    return queryOne(
      `SELECT r.*, COUNT(rm.user_id)::int AS member_count
       FROM server_roles r
       LEFT JOIN server_role_members rm ON rm.role_id = r.id
       WHERE r.server_id = $1 AND r.id = $2
       GROUP BY r.id`,
      [serverId, roleId]
    );
  }

  static async create(serverId, data) {
    const name = String(data.name || 'Novo cargo').trim().slice(0, 80);
    if (!name) throw Object.assign(new Error('Nome do cargo inválido'), { status: 400 });

    const highest = await queryOne(
      `SELECT COALESCE(MAX(position), 0) AS position
       FROM server_roles WHERE server_id = $1 AND position < 100`,
      [serverId]
    );
    const position = Math.max(1, Number(highest?.position || 0) + 1);

    const role = await queryOne(
      `INSERT INTO server_roles
        (id, server_id, name, color, icon, position, permissions, mentionable)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       RETURNING *`,
      [
        uuidv4(),
        serverId,
        name,
        data.color || null,
        data.icon || null,
        Math.min(position, 99),
        JSON.stringify(data.permissions || {}),
        !!data.mentionable
      ]
    );
    return role;
  }

  static async update(serverId, roleId, data) {
    const role = await this.findById(serverId, roleId);
    if (!role) throw Object.assign(new Error('Cargo não encontrado'), { status: 404 });
    if (SYSTEM_ROLES.has(role.name)) {
      throw Object.assign(new Error('Este cargo é protegido pelo sistema'), { status: 400 });
    }

    const fields = [];
    const values = [];
    const add = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (typeof data.name === 'string') {
      const name = data.name.trim().slice(0, 80);
      if (!name) throw Object.assign(new Error('Nome do cargo inválido'), { status: 400 });
      add('name', name);
    }
    if (data.color !== undefined) add('color', data.color || null);
    if (data.icon !== undefined) add('icon', data.icon || null);
    if (data.mentionable !== undefined) add('mentionable', !!data.mentionable);
    if (data.permissions !== undefined) add('permissions', JSON.stringify(data.permissions || {}));

    if (data.position !== undefined) {
      const position = Math.max(1, Math.min(99, Number(data.position) || 1));
      add('position', position);
    }

    if (!fields.length) return role;
    values.push(serverId, roleId);
    return queryOne(
      `UPDATE server_roles SET ${fields.join(', ')}
       WHERE server_id = $${values.length - 1} AND id = $${values.length}
       RETURNING *`,
      values
    );
  }

  static async remove(serverId, roleId) {
    const role = await this.findById(serverId, roleId);
    if (!role) throw Object.assign(new Error('Cargo não encontrado'), { status: 404 });
    if (SYSTEM_ROLES.has(role.name)) {
      throw Object.assign(new Error('Este cargo é protegido pelo sistema'), { status: 400 });
    }
    await query('DELETE FROM server_roles WHERE server_id = $1 AND id = $2', [serverId, roleId]);
    return { success: true, id: roleId };
  }

  static async listMembers(serverId, roleId) {
    return query(
      `SELECT u.id, u.username, u.display_name, u.avatar, sm.nickname, sm.joined_at
       FROM server_role_members rm
       JOIN users u ON u.id = rm.user_id
       JOIN server_members sm ON sm.server_id = rm.server_id AND sm.user_id = rm.user_id
       WHERE rm.server_id = $1 AND rm.role_id = $2
       ORDER BY COALESCE(sm.nickname, u.display_name), u.username`,
      [serverId, roleId]
    );
  }

  static async addMember(serverId, roleId, userId) {
    const role = await this.findById(serverId, roleId);
    if (!role) throw Object.assign(new Error('Cargo não encontrado'), { status: 404 });
    const member = await queryOne(
      'SELECT user_id FROM server_members WHERE server_id = $1 AND user_id = $2',
      [serverId, userId]
    );
    if (!member) throw Object.assign(new Error('Usuário não é membro do servidor'), { status: 400 });

    await query(
      `INSERT INTO server_role_members(role_id, server_id, user_id)
       VALUES ($1,$2,$3) ON CONFLICT (role_id,user_id) DO NOTHING`,
      [roleId, serverId, userId]
    );
    return this.listMembers(serverId, roleId);
  }

  static async removeMember(serverId, roleId, userId) {
    await query(
      'DELETE FROM server_role_members WHERE server_id=$1 AND role_id=$2 AND user_id=$3',
      [serverId, roleId, userId]
    );
    return this.listMembers(serverId, roleId);
  }
}

module.exports = Role;
