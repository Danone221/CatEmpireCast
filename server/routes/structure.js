const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { query, queryOne } = require('../database');
const Server = require('../database/models/Server');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

async function requireManage(serverId, userId) {
  const role = await Server.getMemberRole(serverId, userId);
  if (!role || !['admin', 'owner'].includes(role)) {
    throw Object.assign(new Error('Sem permissão para gerenciar a estrutura do servidor'), { status: 403 });
  }
}

async function requireMember(serverId, userId) {
  const role = await Server.getMemberRole(serverId, userId);
  if (!role) throw Object.assign(new Error('Você não é membro deste servidor'), { status: 403 });
}

function fail(res, error, fallback) {
  console.error(fallback, error);
  return res.status(error.status || 400).json({ error: error.message || fallback });
}

// ===== CATEGORIAS =====
router.get('/servers/:serverId/categories', async (req, res) => {
  try {
    await requireMember(req.params.serverId, req.user.id);
    res.json(await query('SELECT * FROM channel_categories WHERE server_id=$1 ORDER BY position,id', [req.params.serverId]));
  } catch (e) { fail(res, e, 'Erro ao listar categorias'); }
});

router.post('/servers/:serverId/categories', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const name = String(req.body.name || 'Nova categoria').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'Nome da categoria inválido' });
    const pos = await queryOne('SELECT COALESCE(MAX(position),-1)+1 AS position FROM channel_categories WHERE server_id=$1', [req.params.serverId]);
    const category = await queryOne(`INSERT INTO channel_categories(id,server_id,name,position) VALUES($1,$2,$3,$4) RETURNING *`, [uuidv4(), req.params.serverId, name, Number(pos.position)]);
    res.status(201).json(category);
  } catch (e) { fail(res, e, 'Erro ao criar categoria'); }
});

router.patch('/servers/:serverId/categories/:categoryId', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const fields = [];
    const values = [];
    const add = (sql, value) => { values.push(value); fields.push(sql.replace('?', `$${values.length}`)); };
    if (typeof req.body.name === 'string') add('name=?', req.body.name.trim().slice(0, 80));
    if (req.body.position !== undefined) add('position=?', Math.max(0, Number(req.body.position) || 0));
    if (!fields.length) return res.status(400).json({ error: 'Nenhuma alteração informada' });
    values.push(req.params.serverId, req.params.categoryId);
    const category = await queryOne(`UPDATE channel_categories SET ${fields.join(', ')} WHERE server_id=$${values.length-1} AND id=$${values.length} RETURNING *`, values);
    if (!category) return res.status(404).json({ error: 'Categoria não encontrada' });
    res.json(category);
  } catch (e) { fail(res, e, 'Erro ao editar categoria'); }
});

router.delete('/servers/:serverId/categories/:categoryId', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const category = await queryOne('DELETE FROM channel_categories WHERE server_id=$1 AND id=$2 RETURNING id', [req.params.serverId, req.params.categoryId]);
    if (!category) return res.status(404).json({ error: 'Categoria não encontrada' });
    // Canais não são apagados ao remover a categoria: tornam-se canais sem categoria.
    await query('UPDATE channels SET category_id=NULL, category=NULL WHERE server_id=$1 AND category_id=$2', [req.params.serverId, req.params.categoryId]);
    res.json({ success: true, id: category.id });
  } catch (e) { fail(res, e, 'Erro ao excluir categoria'); }
});

// ===== CANAIS =====
router.post('/servers/:serverId/channels', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const name = String(req.body.name || 'novo-canal').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'novo-canal';
    const type = ['text', 'voice', 'forum', 'stage'].includes(req.body.type) ? req.body.type : 'text';
    const categoryId = req.body.categoryId || null;
    if (categoryId) {
      const category = await queryOne('SELECT id FROM channel_categories WHERE id=$1 AND server_id=$2', [categoryId, req.params.serverId]);
      if (!category) return res.status(400).json({ error: 'Categoria inválida' });
    }
    const pos = await queryOne('SELECT COALESCE(MAX(position),-1)+1 AS position FROM channels WHERE server_id=$1', [req.params.serverId]);
    const channel = await queryOne(`INSERT INTO channels(id,server_id,name,type,category,category_id,position,topic,slowmode,user_limit,bitrate,permissions)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [uuidv4(), req.params.serverId, name, type, categoryId, categoryId, Number(pos.position), req.body.topic || null, Math.max(0, Number(req.body.slowmode) || 0), Math.max(0, Number(req.body.userLimit) || 0), Math.max(0, Number(req.body.bitrate) || 64000), JSON.stringify(req.body.permissions || {})]);
    res.status(201).json(channel);
  } catch (e) { fail(res, e, 'Erro ao criar canal'); }
});

router.patch('/servers/:serverId/channels/:channelId', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const channel = await queryOne('SELECT * FROM channels WHERE id=$1 AND server_id=$2', [req.params.channelId, req.params.serverId]);
    if (!channel) return res.status(404).json({ error: 'Canal não encontrado' });
    const fields = [];
    const values = [];
    const add = (sql, value) => { values.push(value); fields.push(sql.replace('?', `$${values.length}`)); };
    if (typeof req.body.name === 'string') add('name=?', req.body.name.trim().slice(0, 64));
    if (['text', 'voice', 'forum', 'stage'].includes(req.body.type)) add('type=?', req.body.type);
    if (req.body.categoryId !== undefined) {
      const categoryId = req.body.categoryId || null;
      if (categoryId) {
        const category = await queryOne('SELECT id FROM channel_categories WHERE id=$1 AND server_id=$2', [categoryId, req.params.serverId]);
        if (!category) return res.status(400).json({ error: 'Categoria inválida' });
      }
      add('category_id=?', categoryId);
      add('category=?', categoryId);
    }
    if (typeof req.body.topic === 'string' || req.body.topic === null) add('topic=?', req.body.topic || null);
    if (req.body.slowmode !== undefined) add('slowmode=?', Math.max(0, Number(req.body.slowmode) || 0));
    if (req.body.userLimit !== undefined) add('user_limit=?', Math.max(0, Number(req.body.userLimit) || 0));
    if (req.body.bitrate !== undefined) add('bitrate=?', Math.max(8000, Number(req.body.bitrate) || 64000));
    if (req.body.position !== undefined) add('position=?', Math.max(0, Number(req.body.position) || 0));
    if (req.body.permissions && typeof req.body.permissions === 'object') add('permissions=?', JSON.stringify(req.body.permissions));
    if (!fields.length) return res.status(400).json({ error: 'Nenhuma alteração informada' });
    values.push(req.params.serverId, req.params.channelId);
    const updated = await queryOne(`UPDATE channels SET ${fields.join(', ')} WHERE server_id=$${values.length-1} AND id=$${values.length} RETURNING *`, values);
    res.json(updated);
  } catch (e) { fail(res, e, 'Erro ao editar canal'); }
});

router.delete('/servers/:serverId/channels/:channelId', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    const deleted = await queryOne('DELETE FROM channels WHERE id=$1 AND server_id=$2 RETURNING id', [req.params.channelId, req.params.serverId]);
    if (!deleted) return res.status(404).json({ error: 'Canal não encontrado' });
    res.json({ success: true, id: deleted.id });
  } catch (e) { fail(res, e, 'Erro ao excluir canal'); }
});

module.exports = router;
