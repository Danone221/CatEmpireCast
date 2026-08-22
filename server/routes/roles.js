const express = require('express');
const router = express.Router();
const Role = require('../database/models/Role');
const Server = require('../database/models/Server');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

async function getManageLevel(serverId, userId) {
  const server = await Server.findById(serverId);
  if (!server) throw Object.assign(new Error('Servidor não encontrado'), { status: 404 });
  if (server.owner_id === userId || server.creator_id === userId) return 100;

  const member = await Server.getMemberRole(serverId, userId);
  if (member === 'owner') return 100;
  if (member === 'admin') return 90;
  if (member === 'moderator') return 70;
  if (member === 'staff') return 50;
  return 0;
}

async function requireManage(serverId, userId) {
  const level = await getManageLevel(serverId, userId);
  if (level < 90) throw Object.assign(new Error('Sem permissão para gerenciar cargos'), { status: 403 });
  return level;
}

function fail(res, error, fallback) {
  console.error(fallback, error);
  res.status(error.status || 400).json({ error: error.message || fallback });
}

router.get('/servers/:serverId/roles', async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const level = await getManageLevel(serverId, req.user.id);
    if (!level) {
      const member = await Server.getMemberRole(serverId, req.user.id);
      if (!member) return res.status(403).json({ error: 'Você não é membro deste servidor' });
    }
    res.json(await Role.list(serverId));
  } catch (e) { fail(res, e, 'Erro ao listar cargos'); }
});

router.post('/servers/:serverId/roles', async (req, res) => {
  try {
    await requireManage(req.params.serverId, req.user.id);
    res.status(201).json(await Role.create(req.params.serverId, req.body || {}));
  } catch (e) { fail(res, e, 'Erro ao criar cargo'); }
});

router.patch('/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    const level = await requireManage(req.params.serverId, req.user.id);
    const role = await Role.findById(req.params.serverId, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'Cargo não encontrado' });
    if (role.position >= level && role.name !== '@everyone') {
      return res.status(403).json({ error: 'Você não pode editar um cargo acima ou igual à sua hierarquia' });
    }
    const next = { ...(req.body || {}) };
    if (next.position !== undefined && Number(next.position) >= level) next.position = level - 1;
    res.json(await Role.update(req.params.serverId, req.params.roleId, next));
  } catch (e) { fail(res, e, 'Erro ao editar cargo'); }
});

router.delete('/servers/:serverId/roles/:roleId', async (req, res) => {
  try {
    const level = await requireManage(req.params.serverId, req.user.id);
    const role = await Role.findById(req.params.serverId, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'Cargo não encontrado' });
    if (role.position >= level) return res.status(403).json({ error: 'Você não pode excluir um cargo acima ou igual à sua hierarquia' });
    res.json(await Role.remove(req.params.serverId, req.params.roleId));
  } catch (e) { fail(res, e, 'Erro ao excluir cargo'); }
});

router.get('/servers/:serverId/roles/:roleId/members', async (req, res) => {
  try {
    const member = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (!member) return res.status(403).json({ error: 'Você não é membro deste servidor' });
    res.json(await Role.listMembers(req.params.serverId, req.params.roleId));
  } catch (e) { fail(res, e, 'Erro ao listar membros do cargo'); }
});

router.put('/servers/:serverId/roles/:roleId/members/:userId', async (req, res) => {
  try {
    const level = await requireManage(req.params.serverId, req.user.id);
    const role = await Role.findById(req.params.serverId, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'Cargo não encontrado' });
    if (role.position >= level) return res.status(403).json({ error: 'Você não pode atribuir este cargo' });
    res.json(await Role.addMember(req.params.serverId, req.params.roleId, req.params.userId));
  } catch (e) { fail(res, e, 'Erro ao adicionar membro ao cargo'); }
});

router.delete('/servers/:serverId/roles/:roleId/members/:userId', async (req, res) => {
  try {
    const level = await requireManage(req.params.serverId, req.user.id);
    const role = await Role.findById(req.params.serverId, req.params.roleId);
    if (!role) return res.status(404).json({ error: 'Cargo não encontrado' });
    if (role.position >= level) return res.status(403).json({ error: 'Você não pode remover este cargo' });
    res.json(await Role.removeMember(req.params.serverId, req.params.roleId, req.params.userId));
  } catch (e) { fail(res, e, 'Erro ao remover membro do cargo'); }
});

module.exports = router;
