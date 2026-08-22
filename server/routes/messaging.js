const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { query, queryOne } = require('../database');
const Server = require('../database/models/Server');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

async function requireMemberByChannel(channelId, userId) {
  const channel = await queryOne('SELECT * FROM channels WHERE id=$1', [channelId]);
  if (!channel) throw Object.assign(new Error('Canal não encontrado'), { status: 404 });
  const role = await Server.getMemberRole(channel.server_id, userId);
  if (!role) throw Object.assign(new Error('Você não é membro deste servidor'), { status: 403 });
  return { channel, role };
}

async function canManage(channel, userId) {
  const role = await Server.getMemberRole(channel.server_id, userId);
  return ['owner', 'admin'].includes(role);
}

function fail(res, error, fallback) {
  console.error(fallback, error);
  return res.status(error.status || 400).json({ error: error.message || fallback });
}

async function loadMessage(messageId) {
  return queryOne(`
    SELECT m.*, u.username, u.display_name, u.avatar,
      COALESCE((SELECT json_agg(json_build_object('emoji', r.emoji, 'count', r.cnt, 'users', r.users))
        FROM (SELECT emoji, COUNT(*)::int AS cnt, json_agg(user_id) AS users
              FROM message_reactions WHERE message_id=m.id GROUP BY emoji) r), '[]'::json) AS reactions,
      COALESCE((SELECT json_agg(json_build_object('id',a.id,'fileName',a.file_name,'fileType',a.file_type,'fileSize',a.file_size,'url',a.url,'metadata',a.metadata))
        FROM message_attachments a WHERE a.message_id=m.id), '[]'::json) AS attachments,
      EXISTS(SELECT 1 FROM pinned_messages p WHERE p.message_id=m.id) AS pinned
    FROM messages m JOIN users u ON u.id=m.user_id
    WHERE m.id=$1
  `, [messageId]);
}

// Histórico de mensagens com paginação. A API não altera o visual existente.
router.get('/channels/:channelId/messages', async (req, res) => {
  try {
    const { channel } = await requireMemberByChannel(req.params.channelId, req.user.id);
    if (channel.type !== 'text') return res.status(400).json({ error: 'O canal não é de texto' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const before = req.query.before ? Number(req.query.before) : null;
    const rows = await query(`
      SELECT m.*, u.username, u.display_name, u.avatar,
        COALESCE((SELECT json_agg(json_build_object('emoji', r.emoji, 'count', r.cnt, 'users', r.users))
          FROM (SELECT emoji, COUNT(*)::int AS cnt, json_agg(user_id) AS users
                FROM message_reactions WHERE message_id=m.id GROUP BY emoji) r), '[]'::json) AS reactions,
        COALESCE((SELECT json_agg(json_build_object('id',a.id,'fileName',a.file_name,'fileType',a.file_type,'fileSize',a.file_size,'url',a.url,'metadata',a.metadata))
          FROM message_attachments a WHERE a.message_id=m.id), '[]'::json) AS attachments,
        EXISTS(SELECT 1 FROM pinned_messages p WHERE p.message_id=m.id) AS pinned
      FROM messages m JOIN users u ON u.id=m.user_id
      WHERE m.channel_id=$1 AND m.deleted_at IS NULL
        AND ($2::bigint IS NULL OR m.created_at < $2)
      ORDER BY m.created_at DESC LIMIT $3
    `, [req.params.channelId, before, limit]);
    res.json(rows.reverse());
  } catch (e) { fail(res, e, 'Erro ao carregar mensagens'); }
});

// Criar mensagem com resposta, embeds, menções e anexos já persistidos.
router.post('/channels/:channelId/messages', async (req, res) => {
  try {
    const { channel } = await requireMemberByChannel(req.params.channelId, req.user.id);
    if (channel.type !== 'text') return res.status(400).json({ error: 'O canal não é de texto' });
    const content = String(req.body.content || '').slice(0, 4000);
    const replyTo = req.body.replyTo || null;
    const threadId = req.body.threadId || null;
    const embeds = Array.isArray(req.body.embeds) ? req.body.embeds.slice(0, 10) : [];
    const mentions = Array.isArray(req.body.mentions) ? req.body.mentions.slice(0, 100) : [];
    const stickers = Array.isArray(req.body.stickers) ? req.body.stickers.slice(0, 20) : [];
    if (!content && !req.body.attachments?.length && !embeds.length && !stickers.length) {
      return res.status(400).json({ error: 'A mensagem está vazia' });
    }
    if (channel.slowmode && Number(channel.slowmode) > 0) {
      const recent = await queryOne('SELECT created_at FROM messages WHERE channel_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1', [channel.id, req.user.id]);
      if (recent && Date.now() - Number(recent.created_at) < Number(channel.slowmode) * 1000) {
        return res.status(429).json({ error: 'Slowmode ativo neste canal', retryAfter: Number(channel.slowmode) * 1000 - (Date.now() - Number(recent.created_at)) });
      }
    }
    if (replyTo) {
      const parent = await queryOne('SELECT id FROM messages WHERE id=$1 AND channel_id=$2 AND deleted_at IS NULL', [replyTo, channel.id]);
      if (!parent) return res.status(400).json({ error: 'Mensagem de resposta inválida' });
    }
    if (threadId) {
      const thread = await queryOne('SELECT id FROM threads WHERE id=$1 AND channel_id=$2 AND archived=false AND locked=false', [threadId, channel.id]);
      if (!thread) return res.status(400).json({ error: 'Thread inválida ou bloqueada' });
    }
    const message = await queryOne(`INSERT INTO messages(id,channel_id,user_id,content,created_at,reply_to,thread_id,embeds,mentions,stickers)
      VALUES($1,$2,$3,$4,extract(epoch FROM now())::bigint,$5,$6,$7,$8,$9) RETURNING id`, [uuidv4(), channel.id, req.user.id, content, replyTo, threadId, JSON.stringify(embeds), JSON.stringify(mentions), JSON.stringify(stickers)]);

    for (const attachment of Array.isArray(req.body.attachments) ? req.body.attachments.slice(0, 10) : []) {
      await query(`INSERT INTO message_attachments(id,message_id,file_name,file_type,file_size,url,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [uuidv4(), message.id, String(attachment.fileName || 'arquivo').slice(0,255), attachment.fileType || null, Number(attachment.fileSize) || null, attachment.url || attachment.fileData || null, JSON.stringify(attachment.metadata || {})]);
    }

    for (const mention of mentions) {
      const type = ['user','role','everyone','here'].includes(mention.type) ? mention.type : 'user';
      if (type === 'user' && mention.userId) {
        await query(`INSERT INTO message_mentions(message_id,user_id,mention_type) VALUES($1,$2,'user') ON CONFLICT DO NOTHING`, [message.id, mention.userId]);
      } else if (type === 'role' && mention.roleId) {
        await query(`INSERT INTO message_mentions(message_id,role_id,mention_type) VALUES($1,$2,'role')`, [message.id, mention.roleId]);
      } else if (type === 'everyone' || type === 'here') {
        await query(`INSERT INTO message_mentions(message_id,mention_type) VALUES($1,$2)`, [message.id, type]);
      }
    }

    const full = await loadMessage(message.id);
    const io = req.app.get('io');
    if (io) io.to(`channel-${channel.id}`).emit('message-created', full);
    res.status(201).json(full);
  } catch (e) { fail(res, e, 'Erro ao enviar mensagem'); }
});

router.patch('/messages/:messageId', async (req, res) => {
  try {
    const message = await queryOne('SELECT m.*, c.server_id,c.id AS channel_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=$1', [req.params.messageId]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    const manage = await canManage(message, req.user.id);
    if (message.user_id !== req.user.id && !manage) return res.status(403).json({ error: 'Você não pode editar esta mensagem' });
    const content = String(req.body.content ?? message.content ?? '').slice(0, 4000);
    const updated = await queryOne('UPDATE messages SET content=$1, edited_at=extract(epoch FROM now())::bigint WHERE id=$2 AND deleted_at IS NULL RETURNING id', [content, message.id]);
    if (!updated) return res.status(404).json({ error: 'Mensagem não encontrada' });
    const full = await loadMessage(message.id);
    const io = req.app.get('io');
    if (io) io.to(`channel-${message.channel_id}`).emit('message-updated', full);
    res.json(full);
  } catch (e) { fail(res, e, 'Erro ao editar mensagem'); }
});

router.delete('/messages/:messageId', async (req, res) => {
  try {
    const message = await queryOne('SELECT m.*,c.server_id,c.id AS channel_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=$1', [req.params.messageId]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    const manage = await canManage(message, req.user.id);
    if (message.user_id !== req.user.id && !manage) return res.status(403).json({ error: 'Você não pode excluir esta mensagem' });
    await query('UPDATE messages SET deleted_at=extract(epoch FROM now())::bigint, content=NULL, file_data=NULL WHERE id=$1', [message.id]);
    const io = req.app.get('io');
    if (io) io.to(`channel-${message.channel_id}`).emit('message-deleted', { id: message.id, channelId: message.channel_id });
    res.json({ success: true, id: message.id });
  } catch (e) { fail(res, e, 'Erro ao excluir mensagem'); }
});

router.post('/messages/:messageId/reactions', async (req, res) => {
  try {
    const message = await queryOne('SELECT m.*,c.server_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=$1 AND m.deleted_at IS NULL', [req.params.messageId]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    await requireMemberByChannel(message.channel_id, req.user.id);
    const emoji = String(req.body.emoji || '').trim().slice(0, 64);
    if (!emoji) return res.status(400).json({ error: 'Emoji inválido' });
    await query('INSERT INTO message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [message.id, req.user.id, emoji]);
    const reactions = await query(`SELECT emoji,COUNT(*)::int AS count,BOOL_OR(user_id=$2) AS reacted FROM message_reactions WHERE message_id=$1 GROUP BY emoji ORDER BY emoji`, [message.id, req.user.id]);
    const io = req.app.get('io');
    if (io) io.to(`channel-${message.channel_id}`).emit('message-reactions-updated', { messageId: message.id, reactions });
    res.json(reactions);
  } catch (e) { fail(res, e, 'Erro ao adicionar reação'); }
});

router.delete('/messages/:messageId/reactions/:emoji', async (req, res) => {
  try {
    const message = await queryOne('SELECT m.*,c.server_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=$1', [req.params.messageId]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    await requireMemberByChannel(message.channel_id, req.user.id);
    await query('DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', [message.id, req.user.id, req.params.emoji]);
    const reactions = await query(`SELECT emoji,COUNT(*)::int AS count,BOOL_OR(user_id=$2) AS reacted FROM message_reactions WHERE message_id=$1 GROUP BY emoji ORDER BY emoji`, [message.id, req.user.id]);
    const io = req.app.get('io');
    if (io) io.to(`channel-${message.channel_id}`).emit('message-reactions-updated', { messageId: message.id, reactions });
    res.json(reactions);
  } catch (e) { fail(res, e, 'Erro ao remover reação'); }
});

router.get('/channels/:channelId/pins', async (req, res) => {
  try {
    await requireMemberByChannel(req.params.channelId, req.user.id);
    res.json(await query(`SELECT p.*,m.content,m.user_id,u.username,u.display_name,u.avatar
      FROM pinned_messages p JOIN messages m ON m.id=p.message_id JOIN users u ON u.id=m.user_id
      WHERE p.channel_id=$1 ORDER BY p.pinned_at DESC`, [req.params.channelId]));
  } catch (e) { fail(res, e, 'Erro ao listar mensagens fixadas'); }
});

router.post('/messages/:messageId/pin', async (req, res) => {
  try {
    const message = await queryOne('SELECT m.*,c.server_id,c.id AS channel_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=$1 AND m.deleted_at IS NULL', [req.params.messageId]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (!(await canManage(message, req.user.id))) return res.status(403).json({ error: 'Sem permissão para fixar mensagens' });
    await query('INSERT INTO pinned_messages(message_id,channel_id,pinned_by) VALUES($1,$2,$3) ON CONFLICT(message_id) DO NOTHING', [message.id, message.channel_id, req.user.id]);
    res.json({ success: true, messageId: message.id });
  } catch (e) { fail(res, e, 'Erro ao fixar mensagem'); }
});

router.delete('/messages/:messageId/pin', async (req, res) => {
  try {
    const message = await queryOne('SELECT m.*,c.server_id,c.id AS channel_id FROM messages m JOIN channels c ON c.id=m.channel_id WHERE m.id=$1', [req.params.messageId]);
    if (!message) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (!(await canManage(message, req.user.id))) return res.status(403).json({ error: 'Sem permissão para desafixar mensagens' });
    await query('DELETE FROM pinned_messages WHERE message_id=$1', [message.id]);
    res.json({ success: true, messageId: message.id });
  } catch (e) { fail(res, e, 'Erro ao desafixar mensagem'); }
});

router.get('/servers/:serverId/messages/search', async (req, res) => {
  try {
    await Server.getMemberRole(req.params.serverId, req.user.id).then(role => { if (!role) throw Object.assign(new Error('Você não é membro deste servidor'), { status: 403 }); });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ error: 'A busca precisa de pelo menos 2 caracteres' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const rows = await query(`SELECT m.id,m.channel_id,m.user_id,m.content,m.created_at,m.edited_at,u.username,u.display_name,u.avatar
      FROM messages m JOIN channels c ON c.id=m.channel_id JOIN users u ON u.id=m.user_id
      WHERE c.server_id=$1 AND m.deleted_at IS NULL AND m.content ILIKE $2
      ORDER BY m.created_at DESC LIMIT $3`, [req.params.serverId, `%${q}%`, limit]);
    res.json(rows);
  } catch (e) { fail(res, e, 'Erro ao pesquisar mensagens'); }
});

module.exports = router;
