const { query, queryOne } = require('../index');
const { v4: uuidv4 } = require('uuid');
const { sanitizePlainText } = require('../../security');

const SYSTEM_ROLES = new Set(['@everyone', 'owner']);

function isSystemRoleName(value) {
  return SYSTEM_ROLES.has(String(value || '').trim().toLowerCase());
}

function cleanRoleColor(value) {
  if (value == null || value === '') return null;
  const color = String(value).trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw Object.assign(new Error('Cor de cargo inválida'), { status: 400 });
  }
  return color;
}

function cleanRoleIcon(value) {
  if (value == null || value === '') return null;
  const icon = sanitizePlainText(value, 16);
  if (!icon || /^[a-z][a-z0-9+.-]*:/i.test(icon)) {
    throw Object.assign(new Error('Ícone de cargo inválido'), { status: 400 });
  }
  return icon;
}

function cleanPermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, enabled] of Object.entries(value).slice(0, 64)) {
    if (!/^[a-z0-9_.:-]{1,64}$/i.test(key)) continue;
    out[key] = !!enabled;
  }
  return out;
}

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
    const name = sanitizePlainText(data.name || 'Novo cargo', 80);
    if (!name || isSystemRoleName(name)) {
      throw Object.assign(new Error('Nome do cargo inválido ou reservado'), { status: 400 });
    }

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
        cleanRoleColor(data.color),
        cleanRoleIcon(data.icon),
        Math.min(position, 99),
        JSON.stringify(cleanPermissions(data.permissions)),
        !!data.mentionable
      ]
    );
    return role;
  }

  static async update(serverId, roleId, data) {
    const role = await this.findById(serverId, roleId);
    if (!role) throw Object.assign(new Error('Cargo não encontrado'), { status: 404 });
    if (isSystemRoleName(role.name)) {
      throw Object.assign(new Error('Este cargo é protegido pelo sistema'), { status: 400 });
    }

    const fields = [];
    const values = [];
    const add = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (typeof data.name === 'string') {
      const name = sanitizePlainText(data.name, 80);
      if (!name || isSystemRoleName(name)) {
        throw Object.assign(new Error('Nome do cargo inválido ou reservado'), { status: 400 });
      }
      add('name', name);
    }
    if (data.color !== undefined) add('color', cleanRoleColor(data.color));
    if (data.icon !== undefined) add('icon', cleanRoleIcon(data.icon));
    if (data.mentionable !== undefined) add('mentionable', !!data.mentionable);
    if (data.permissions !== undefined) add('permissions', JSON.stringify(cleanPermissions(data.permissions)));

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
    if (isSystemRoleName(role.name)) {
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
    if (isSystemRoleName(role.name)) {
      throw Object.assign(new Error('Este cargo é gerenciado pelo sistema'), { status: 400 });
    }
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
    const role = await this.findById(serverId, roleId);
    if (!role) throw Object.assign(new Error('Cargo não encontrado'), { status: 404 });
    if (isSystemRoleName(role.name)) {
      throw Object.assign(new Error('Este cargo é gerenciado pelo sistema'), { status: 400 });
    }
    await query(
      'DELETE FROM server_role_members WHERE server_id=$1 AND role_id=$2 AND user_id=$3',
      [serverId, roleId, userId]
    );
    return this.listMembers(serverId, roleId);
  }
}

module.exports = Role;
