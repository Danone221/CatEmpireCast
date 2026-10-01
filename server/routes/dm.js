const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { query, queryOne } = require('../database');
const User = require('../database/models/User');
const Dm = require('../database/models/Dm');
const { authenticate } = require('../middleware/auth');
const config = require('../config');
const { sanitizeAttachment, cleanMessageText } = require('../input-security');
const { sanitizePlainText, validateImageValue } = require('../security');

router.use(authenticate);

function fail(res, error, fallback) {
  console.error(fallback, error);
  return res.status(error.status || 400).json({ error: error.message || fallback });
}

async function ensureUser(userId) {
  const user = await User.getPublicProfile(userId);
  if (!user) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
  return user;
}

// ===== DM INDIVIDUAL =====
router.post('/dms/:userId/messages', async (req, res) => {
  try {
    if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Não é possível enviar DM para você mesmo' });
    await ensureUser(req.params.userId);
    const block = await queryOne('SELECT blocker_id FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1', [req.user.id, req.params.userId]);
    if (block) return res.status(403).json({ error: block.blocker_id === req.user.id ? 'Desbloqueie este usuário antes de enviar mensagens' : 'Você não pode enviar mensagens para este usuário' });
    const content = cleanMessageText(req.body.content, 2000);
    const file = req.body.file
      ? sanitizeAttachment(req.body.file, {
          maxBytes: Math.min(Number(config.upload.maxSize) || 8 * 1024 * 1024, 8 * 1024 * 1024),
          allowedTypes: config.upload.allowedTypes
        })
      : null;
    if (!content && !file) return res.status(400).json({ error: 'A mensagem está vazia' });

    const message = await Dm.send({ senderId: req.user.id, recipientId: req.params.userId, content, file });
    const io = req.app.get('io');
    if (io) {
      io.to(`user-${req.user.id}`).emit('dm-message-created', message);
      io.to(`user-${req.params.userId}`).emit('dm-message-created', message);
    }
    res.status(201).json(message);
  } catch (e) { fail(res, e, 'Erro ao enviar DM'); }
});

router.patch('/dms/messages/:messageId', async (req, res) => {
  try {
    const message = await Dm.getById(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (message.sender_id !== req.user.id) return res.status(403).json({ error: 'Você não pode editar esta mensagem' });
    const block = await queryOne(
      'SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1',
      [message.sender_id, message.recipient_id]
    );
    if (block) return res.status(403).json({ error: 'Esta conversa está bloqueada' });
    const content = cleanMessageText(req.body.content, 2000);
    if (!content) return res.status(400).json({ error: 'A mensagem está vazia' });
    const updated = await Dm.edit(message.id, content);
    const io = req.app.get('io');
    if (io) {
      io.to(`user-${message.sender_id}`).emit('dm-message-updated', updated);
      io.to(`user-${message.recipient_id}`).emit('dm-message-updated', updated);
    }
    res.json(updated);
  } catch (e) { fail(res, e, 'Erro ao editar DM'); }
});

router.delete('/dms/messages/:messageId', async (req, res) => {
  try {
    const message = await Dm.getById(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (message.sender_id !== req.user.id) return res.status(403).json({ error: 'Você não pode excluir esta mensagem' });
    await Dm.delete(message.id);
    const io = req.app.get('io');
    if (io) {
      const payload = { id: message.id, senderId: message.sender_id, recipientId: message.recipient_id };
      io.to(`user-${message.sender_id}`).emit('dm-message-deleted', payload);
      io.to(`user-${message.recipient_id}`).emit('dm-message-deleted', payload);
    }
    res.json({ success: true, id: message.id });
  } catch (e) { fail(res, e, 'Erro ao excluir DM'); }
});

// ===== GROUP DM =====
router.get('/group-dms', async (req, res) => {
  try {
    const groups = await query(`
      SELECT g.*, COUNT(gm.user_id)::int AS member_count
      FROM group_dms g JOIN group_dm_members gm ON gm.group_id=g.id
      WHERE EXISTS (SELECT 1 FROM group_dm_members mine WHERE mine.group_id=g.id AND mine.user_id=$1)
      GROUP BY g.id ORDER BY g.created_at DESC`, [req.user.id]);
    res.json(groups);
  } catch (e) { fail(res, e, 'Erro ao listar grupos de DM'); }
});

router.post('/group-dms', async (req, res) => {
  try {
    const participants = [...new Set((Array.isArray(req.body.participants) ? req.body.participants : [])
      .filter(userId => typeof userId === 'string' && userId.length > 0 && userId.length <= 160))];
    if (!participants.includes(req.user.id)) participants.push(req.user.id);
    if (participants.length < 2 || participants.length > 25) return res.status(400).json({ error: 'Um grupo de DM precisa ter entre 2 e 25 participantes' });
    for (const userId of participants) await ensureUser(userId);
    const groupId = uuidv4();
    const name = sanitizePlainText(req.body.name || '', 80) || null;
    const icon = req.body.icon == null || req.body.icon === ''
      ? null
      : validateImageValue(req.body.icon, { allowShortText: true, maxLength: 200000 });
    const group = await queryOne(`INSERT INTO group_dms(id,name,icon,owner_id) VALUES($1,$2,$3,$4) RETURNING *`, [groupId, name, icon, req.user.id]);
    for (const userId of participants) await query('INSERT INTO group_dm_members(group_id,user_id) VALUES($1,$2)', [groupId, userId]);
    res.status(201).json({ ...group, participants });
  } catch (e) { fail(res, e, 'Erro ao criar grupo de DM'); }
});

router.get('/group-dms/:groupId', async (req, res) => {
  try {
    const group = await queryOne('SELECT * FROM group_dms WHERE id=$1 AND EXISTS (SELECT 1 FROM group_dm_members WHERE group_id=$1 AND user_id=$2)', [req.params.groupId, req.user.id]);
    if (!group) return res.status(404).json({ error: 'Grupo de DM não encontrado' });
    const members = await query(`SELECT u.id,u.username,u.display_name,u.avatar FROM group_dm_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=$1 ORDER BY u.username`, [group.id]);
    res.json({ ...group, members });
  } catch (e) { fail(res, e, 'Erro ao carregar grupo de DM'); }
});

router.post('/group-dms/:groupId/members/:userId', async (req, res) => {
  try {
    const group = await queryOne('SELECT * FROM group_dms WHERE id=$1', [req.params.groupId]);
    if (!group) return res.status(404).json({ error: 'Grupo de DM não encontrado' });
    const owner = group.owner_id === req.user.id;
    const member = await queryOne('SELECT 1 FROM group_dm_members WHERE group_id=$1 AND user_id=$2', [group.id, req.user.id]);
    if (!owner && !member) return res.status(403).json({ error: 'Você não participa deste grupo' });
    await ensureUser(req.params.userId);
    const count = await queryOne('SELECT COUNT(*)::int AS count FROM group_dm_members WHERE group_id=$1', [group.id]);
    if (Number(count.count) >= 25) return res.status(400).json({ error: 'Limite de participantes atingido' });
    await query('INSERT INTO group_dm_members(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [group.id, req.params.userId]);
    res.json({ success: true });
  } catch (e) { fail(res, e, 'Erro ao adicionar participante'); }
});

module.exports = router;
