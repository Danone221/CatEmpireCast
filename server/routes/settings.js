const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../database');
const Server = require('../database/models/Server');
const { authenticate } = require('../middleware/auth');

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS server_settings (
      server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      security JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    )
  `);
  schemaReady = true;
}

async function requireAdmin(serverId, userId) {
  const role = await Server.getMemberRole(serverId, userId);
  if (role !== 'admin') throw new Error('Apenas administradores podem alterar estas configurações');
}

router.use(authenticate);
router.use(async (_req, res, next) => {
  try { await ensureSchema(); next(); }
  catch (e) { console.error('Settings schema:', e); res.status(500).json({ error: 'Falha ao preparar configurações' }); }
});

router.get('/servers/:serverId/settings', async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (!role) return res.status(403).json({ error: 'Você não é membro deste servidor' });
    const server = await Server.findById(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    const row = await queryOne('SELECT security, updated_at FROM server_settings WHERE server_id = $1', [req.params.serverId]);
    res.json({ ...server, security: row?.security || {}, settingsUpdatedAt: row?.updated_at || null, myRole: role });
  } catch (e) { res.status(500).json({ error: e.message || 'Erro ao carregar configurações' }); }
});

router.put('/servers/:serverId/settings', async (req, res) => {
  try {
    await requireAdmin(req.params.serverId, req.user.id);
    const server = await Server.findById(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });

    if (req.body?.security && typeof req.body.security === 'object') {
      const security = {
        verification: !!req.body.security.verification,
        mediaFilter: !!req.body.security.mediaFilter,
        mentions: !!req.body.security.mentions
      };
      await query(
        `INSERT INTO server_settings (server_id, security, updated_at)
         VALUES ($1, $2::jsonb, extract(epoch FROM now())::bigint)
         ON CONFLICT (server_id) DO UPDATE SET security = EXCLUDED.security, updated_at = EXCLUDED.updated_at`,
        [req.params.serverId, JSON.stringify(security)]
      );
    }

    const data = {};
    if (typeof req.body?.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim().slice(0, 40);
    if (typeof req.body?.description === 'string') data.description = req.body.description.slice(0, 300);
    if (typeof req.body?.icon === 'string') data.icon = req.body.icon;
    if (typeof req.body?.bannerColor === 'string') data.banner_color = req.body.bannerColor;
    const updated = Object.keys(data).length ? await Server.update(req.params.serverId, data) : server;
    const row = await queryOne('SELECT security, updated_at FROM server_settings WHERE server_id = $1', [req.params.serverId]);
    const io = req.app.get('io');
    if (io) io.to(`server-${req.params.serverId}`).emit('server-updated', updated);
    res.json({ ...updated, security: row?.security || {}, settingsUpdatedAt: row?.updated_at || null });
  } catch (e) { res.status(400).json({ error: e.message || 'Erro ao salvar configurações' }); }
});

router.get('/servers/:serverId/roles', async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (!role) return res.status(403).json({ error: 'Você não é membro deste servidor' });
    const server = await Server.findById(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Servidor não encontrado' });
    const rows = await query('SELECT role, COUNT(*)::int AS count FROM server_members WHERE server_id = $1 GROUP BY role', [req.params.serverId]);
    const counts = Object.fromEntries(rows.map(r => [r.role, Number(r.count)]));
    res.json({ roles: [
      { key:'FOUNDER', name:'FOUNDER', color:'#ffcd3c', count:server.creator_id ? 1 : 0, description:'Criador do servidor. Possui controle total e não pode ser rebaixado.' },
      { key:'ADMIN', name:'ADMIN', color:'#8b2bff', count:counts.admin || 0, description:'Gerencia membros, canais, categorias e configurações do servidor.' },
      { key:'MEMBRO', name:'MEMBRO', color:'#9a86bd', count:counts.member || 0, description:'Cargo padrão para participantes do servidor.' }
    ]});
  } catch (e) { res.status(500).json({ error: e.message || 'Erro ao carregar cargos' }); }
});

module.exports = router;
