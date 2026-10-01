const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { query, queryOne } = require('../database');
const Server = require('../database/models/Server');
const config = require('../config');
const { sanitizeAttachment, cleanMessageText } = require('../input-security');
const { validatePublicHttpsUrl } = require('../security');
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

function cleanFileName(value) {
  return String(value || 'arquivo')
    .replace(/[\\/\0\r\n]/g, '_')
    .replace(/[<>"]/g, '')
    .slice(0, 160) || 'arquivo';
}

function boundedJson(value, maxBytes, label) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw Object.assign(new Error(`${label} excede o limite permitido`), { status: 413 });
  }
  return value;
}

function normalizeStoredAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
    throw Object.assign(new Error('Anexo inválido'), { status: 400 });
  }
  const fileType = String(attachment.fileType || '').trim().toLowerCase();
  if (!config.upload.allowedTypes.includes(fileType)) {
    throw Object.assign(new Error('Tipo de arquivo não permitido'), { status: 400 });
  }
  const maxBytes = Math.min(Number(config.upload.maxSize) || 8 * 1024 * 1024, 8 * 1024 * 1024);
  const fileName = cleanFileName(attachment.fileName);
  let url;
  let fileSize = Math.max(0, Number(attachment.fileSize) || 0);

  if (attachment.fileData) {
    const safe = sanitizeAttachment(
      { name: fileName, type: fileType, data: attachment.fileData },
      { maxBytes, allowedTypes: config.upload.allowedTypes }
    );
    url = safe.data;
    fileSize = safe.size;
  } else {
    url = validatePublicHttpsUrl(attachment.url, 4096);
    if (!url) throw Object.assign(new Error('URL do anexo é obrigatória'), { status: 400 });
    if (fileSize > maxBytes) throw Object.assign(new Error('Arquivo excede o limite permitido'), { status: 413 });
  }

  const metadata = attachment.metadata && typeof attachment.metadata === 'object' && !Array.isArray(attachment.metadata)
    ? attachment.metadata
    : {};
  boundedJson(metadata, 8192, 'Metadados do anexo');
  return { fileName, fileType, fileSize: fileSize || null, url, metadata };
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
    const content = cleanMessageText(req.body.content, 2000);
    const replyTo = typeof req.body.replyTo === 'string' ? req.body.replyTo : null;
    const threadId = typeof req.body.threadId === 'string' ? req.body.threadId : null;
    const embeds = Array.isArray(req.body.embeds) ? req.body.embeds.slice(0, 10) : [];
    const mentions = Array.isArray(req.body.mentions) ? req.body.mentions.slice(0, 50) : [];
    const stickers = Array.isArray(req.body.stickers) ? req.body.stickers.slice(0, 20) : [];
    boundedJson(embeds, 32768, 'Embeds');
    boundedJson(stickers, 16384, 'Stickers');
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

    const attachments = Array.isArray(req.body.attachments) ? req.body.attachments.slice(0, 10) : [];
    for (const rawAttachment of attachments) {
      const attachment = normalizeStoredAttachment(rawAttachment);
      await query(`INSERT INTO message_attachments(id,message_id,file_name,file_type,file_size,url,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [
        uuidv4(),
        message.id,
        attachment.fileName,
        attachment.fileType,
        attachment.fileSize,
        attachment.url,
        JSON.stringify(attachment.metadata)
      ]);
    }

    const normalizedMentions = mentions
      .filter(mention => mention && typeof mention === 'object' && !Array.isArray(mention))
      .map(mention => ({
        type: ['user','role','everyone','here'].includes(mention.type) ? mention.type : 'user',
        userId: typeof mention.userId === 'string' ? mention.userId : null,
        roleId: typeof mention.roleId === 'string' ? mention.roleId : null
      }));
    const mentionedUserIds = [...new Set(normalizedMentions.filter(m => m.type === 'user' && m.userId).map(m => m.userId))];
    const mentionedRoleIds = [...new Set(normalizedMentions.filter(m => m.type === 'role' && m.roleId).map(m => m.roleId))];
    const [validUsers, validRoles] = await Promise.all([
      mentionedUserIds.length
        ? query('SELECT user_id AS id FROM server_members WHERE server_id=$1 AND user_id = ANY($2::text[])', [channel.server_id, mentionedUserIds])
        : Promise.resolve([]),
      mentionedRoleIds.length
        ? query('SELECT id FROM server_roles WHERE server_id=$1 AND id = ANY($2::text[])', [channel.server_id, mentionedRoleIds])
        : Promise.resolve([])
    ]);
    if (validUsers.length !== mentionedUserIds.length || validRoles.length !== mentionedRoleIds.length) {
      return res.status(400).json({ error: 'Menção inválida para este servidor' });
    }

    for (const mention of normalizedMentions) {
      if (mention.type === 'user' && mention.userId) {
        await query(`INSERT INTO message_mentions(message_id,user_id,mention_type) VALUES($1,$2,'user') ON CONFLICT DO NOTHING`, [message.id, mention.userId]);
      } else if (mention.type === 'role' && mention.roleId) {
        await query(`INSERT INTO message_mentions(message_id,role_id,mention_type) VALUES($1,$2,'role')`, [message.id, mention.roleId]);
      } else if (mention.type === 'everyone' || mention.type === 'here') {
        await query(`INSERT INTO message_mentions(message_id,mention_type) VALUES($1,$2)`, [message.id, mention.type]);
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
    await requireMemberByChannel(message.channel_id, req.user.id);
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
    await requireMemberByChannel(message.channel_id, req.user.id);
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
