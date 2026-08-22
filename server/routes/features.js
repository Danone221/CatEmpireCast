const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../database');
const Category = require('../database/models/Category');
const Channel = require('../database/models/Channel');
const Server = require('../database/models/Server');
const { authenticate } = require('../middleware/auth');

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      UNIQUE(message_id, user_id, emoji)
    );
    CREATE TABLE IF NOT EXISTS dm_reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      UNIQUE(message_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_dm_reactions_message ON dm_reactions(message_id);
  `);
  schemaReady = true;
}

async function requireAdmin(serverId, userId) {
  const role = await Server.getMemberRole(serverId, userId);
  if (role !== 'admin') throw new Error('Apenas administradores podem alterar esta configuração');
}

router.use(authenticate);
router.use(async (req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (e) { console.error('Feature schema:', e); res.status(500).json({ error: 'Falha ao preparar recursos' }); }
});

router.get('/servers/:serverId/categories', async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (!role) return res.status(403).json({ error: 'Você não é membro deste servidor' });
    const categories = await Category.list(req.params.serverId);
    const channels = await Server.getChannels(req.params.serverId);
    res.json({ categories, channels });
  } catch (e) { res.status(500).json({ error: e.message || 'Erro ao listar categorias' }); }
});

router.post('/servers/:serverId/categories', async (req, res) => {
  try { await requireAdmin(req.params.serverId, req.user.id); res.json(await Category.create(req.params.serverId, req.body.name)); }
  catch (e) { res.status(400).json({ error: e.message || 'Erro ao criar categoria' }); }
});

router.put('/servers/:serverId/categories/:categoryId', async (req, res) => {
  try { await requireAdmin(req.params.serverId, req.user.id); res.json(await Category.rename(req.params.serverId, req.params.categoryId, req.body.name)); }
  catch (e) { res.status(400).json({ error: e.message || 'Erro ao editar categoria' }); }
});

router.delete('/servers/:serverId/categories/:categoryId', async (req, res) => {
  try { await requireAdmin(req.params.serverId, req.user.id); res.json(await Category.remove(req.params.serverId, req.params.categoryId)); }
  catch (e) { res.status(400).json({ error: e.message || 'Erro ao excluir categoria' }); }
});

router.put('/servers/:serverId/channels/:channelId', async (req, res) => {
  try {
    await requireAdmin(req.params.serverId, req.user.id);
    const channel = await Channel.findById(req.params.channelId);
    if (!channel || channel.server_id !== req.params.serverId) return res.status(404).json({ error: 'Canal não encontrado' });
    const data = {};
    if (typeof req.body.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim().slice(0, 40);
    if (req.body.type === 'text' || req.body.type === 'voice') data.type = req.body.type;
    if (typeof req.body.category === 'string' && req.body.category.trim()) data.category = req.body.category.trim().slice(0, 40);
    if (req.body.position !== undefined) data.position = Math.max(0, parseInt(req.body.position, 10) || 0);
    await Channel.update(req.params.channelId, data);
    res.json(await Channel.findById(req.params.channelId));
  } catch (e) { res.status(400).json({ error: e.message || 'Erro ao editar canal' }); }
});

router.get('/servers/:serverId/voice-stats', async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (!role) return res.status(403).json({ error: 'Você não é membro deste servidor' });
    const rows = await query(`
      SELECT c.id, MIN(vs.joined_at) AS started_at, COUNT(vs.user_id)::int AS member_count
      FROM channels c LEFT JOIN voice_states vs ON vs.channel_id = c.id
      WHERE c.server_id = $1 AND c.type = 'voice' GROUP BY c.id
    `, [req.params.serverId]);
    const out = {};
    rows.forEach(r => { out[r.id] = { startedAt: r.started_at ? Number(r.started_at) : null, memberCount: Number(r.member_count || 0) }; });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'Erro ao carregar duração das calls' }); }
});

function reactionTable(type) { return type === 'dm' ? 'dm_reactions' : 'message_reactions'; }
async function getReactions(type, ids, currentUserId) {
  if (!ids.length) return {};
  const table = reactionTable(type);
  const rows = await query(`
    SELECT message_id, emoji, COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS reacted
    FROM ${table} WHERE message_id = ANY($1::text[])
    GROUP BY message_id, emoji ORDER BY emoji
  `, [ids, currentUserId]);
  const out = {};
  rows.forEach(r => { (out[r.message_id] ||= []).push({ emoji: r.emoji, count: Number(r.count), reacted: !!r.reacted }); });
  return out;
}

router.get('/reactions', async (req, res) => {
  try {
    const type = req.query.type === 'dm' ? 'dm' : 'server';
    const ids = String(req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 100);
    res.json(await getReactions(type, ids, req.user.id));
  } catch (_) { res.status(500).json({ error: 'Erro ao carregar reações' }); }
});

router.post('/reactions/toggle', async (req, res) => {
  try {
    const type = req.body.type === 'dm' ? 'dm' : 'server';
    const messageId = String(req.body.messageId || '');
    const emoji = String(req.body.emoji || '').slice(0, 16);
    if (!messageId || !emoji) return res.status(400).json({ error: 'Reação inválida' });
    const table = reactionTable(type);
    if (type === 'server') {
      const msg = await queryOne('SELECT m.id, c.server_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = $1', [messageId]);
      if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
      if (!await Server.getMemberRole(msg.server_id, req.user.id)) return res.status(403).json({ error: 'Você não é membro deste servidor' });
    } else {
      const msg = await queryOne('SELECT id, sender_id, recipient_id FROM dm_messages WHERE id = $1', [messageId]);
      if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
      if (msg.sender_id !== req.user.id && msg.recipient_id !== req.user.id) return res.status(403).json({ error: 'Sem acesso a esta mensagem' });
    }
    const existing = await queryOne(`SELECT id FROM ${table} WHERE message_id = $1 AND user_id = $2 AND emoji = $3`, [messageId, req.user.id, emoji]);
    if (existing) await query(`DELETE FROM ${table} WHERE id = $1`, [existing.id]);
    else {
      const { v4: uuidv4 } = require('uuid');
      await query(`INSERT INTO ${table} (id, message_id, user_id, emoji) VALUES ($1, $2, $3, $4)`, [uuidv4(), messageId, req.user.id, emoji]);
    }
    const reactions = await getReactions(type, [messageId], req.user.id);
    res.json({ reactions: reactions[messageId] || [] });
  } catch (_) { res.status(500).json({ error: 'Erro ao atualizar reação' }); }
});

// Busca opcional de GIFs. O chat também aceita GIFs enviados como arquivo e URLs .gif sem API externa.
router.get('/gifs/search', async (req, res) => {
  const key = process.env.TENOR_API_KEY;
  if (!key) return res.json({ configured: false, results: [] });
  const term = String(req.query.q || 'trending').slice(0, 80);
  try {
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(term)}&key=${encodeURIComponent(key)}&client_key=cat_empire&limit=12`;
    const r = await fetch(url);
    if (!r.ok) return res.json({ configured: true, results: [] });
    const d = await r.json();
    const results = (d.results || []).map(x => ({ id:x.id, preview:x.media_formats?.tinygif?.url || x.media_formats?.nanogif?.url, url:x.media_formats?.gif?.url || x.media_formats?.mediumgif?.url })).filter(x => x.url);
    res.json({ configured: true, results });
  } catch (_) { res.json({ configured: true, results: [] }); }
});

module.exports = router;
