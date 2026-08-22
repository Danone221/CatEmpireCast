const express = require('express');
const { query, queryOne } = require('../database');
const Server = require('../database/models/Server');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function requireMember(serverId, userId) {
  const role = await Server.getMemberRole(serverId, userId);
  if (!role) throw Object.assign(new Error('Você não é membro deste servidor'), { status: 403 });
}

async function requireManage(serverId, userId) {
  const role = await Server.getMemberRole(serverId, userId);
  if (!role || !['owner', 'admin', 'moderator'].includes(role)) {
    throw Object.assign(new Error('Sem permissão para gerenciar o Stage'), { status: 403 });
  }
}

function fail(res, error, fallback) {
  console.error(fallback, error);
  return res.status(error.status || 400).json({ error: error.message || fallback });
}

async function getStage(channelId) {
  return queryOne(`SELECT c.*, s.name AS server_name
    FROM channels c JOIN servers s ON s.id=c.server_id
    WHERE c.id=$1 AND c.type='stage'`, [channelId]);
}

// Stage state: moderators, speakers and audience.
router.get('/channels/:channelId/stage', async (req, res) => {
  try {
    const channel = await getStage(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Stage não encontrado' });
    await requireMember(channel.server_id, req.user.id);

    const members = await query(`SELECT sm.*, u.username, u.display_name, u.avatar
      FROM stage_members sm
      JOIN users u ON u.id=sm.user_id
      WHERE sm.channel_id=$1
      ORDER BY CASE sm.role WHEN 'moderator' THEN 0 WHEN 'speaker' THEN 1 ELSE 2 END, sm.joined_at`, [channel.id]);

    res.json({ channel, members });
  } catch (e) { fail(res, e, 'Erro ao carregar Stage'); }
});

router.post('/channels/:channelId/stage/join', async (req, res) => {
  try {
    const channel = await getStage(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Stage não encontrado' });
    await requireMember(channel.server_id, req.user.id);

    const requestedRole = ['moderator', 'speaker', 'audience'].includes(req.body.role) ? req.body.role : 'audience';
    const role = requestedRole === 'moderator' ? 'audience' : requestedRole;

    const member = await queryOne(`INSERT INTO stage_members(channel_id,user_id,role)
      VALUES($1,$2,$3)
      ON CONFLICT(channel_id,user_id) DO UPDATE SET role=$3,updated_at=extract(epoch FROM now())::bigint
      RETURNING *`, [channel.id, req.user.id, role]);

    res.json(member);
  } catch (e) { fail(res, e, 'Erro ao entrar no Stage'); }
});

router.delete('/channels/:channelId/stage/leave', async (req, res) => {
  try {
    const channel = await getStage(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Stage não encontrado' });
    await requireMember(channel.server_id, req.user.id);
    await query('DELETE FROM stage_members WHERE channel_id=$1 AND user_id=$2', [channel.id, req.user.id]);
    res.json({ success: true });
  } catch (e) { fail(res, e, 'Erro ao sair do Stage'); }
});

router.patch('/channels/:channelId/stage/members/:userId', async (req, res) => {
  try {
    const channel = await getStage(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Stage não encontrado' });
    await requireManage(channel.server_id, req.user.id);

    const fields = [];
    const values = [];
    const add = (field, value) => {
      values.push(value);
      fields.push(`${field}=$${values.length}`);
    };

    if (['moderator', 'speaker', 'audience'].includes(req.body.role)) add('role', req.body.role);
    if (typeof req.body.muted === 'boolean') add('muted', req.body.muted);
    if (typeof req.body.deafened === 'boolean') add('deafened', req.body.deafened);
    if (typeof req.body.speaking === 'boolean') add('speaking', req.body.speaking);
    if (!fields.length) return res.status(400).json({ error: 'Nenhuma alteração informada' });

    values.push(channel.id, req.params.userId);
    const member = await queryOne(`UPDATE stage_members SET ${fields.join(', ')}, updated_at=extract(epoch FROM now())::bigint
      WHERE channel_id=$${values.length - 1} AND user_id=$${values.length} RETURNING *`, values);
    if (!member) return res.status(404).json({ error: 'Membro não está no Stage' });
    res.json(member);
  } catch (e) { fail(res, e, 'Erro ao atualizar membro do Stage'); }
});

module.exports = router;
