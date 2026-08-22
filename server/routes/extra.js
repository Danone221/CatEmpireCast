const express = require('express');
const router = express.Router();
const Category = require('../database/models/Category');
const Server = require('../database/models/Server');
const User = require('../database/models/User');
const { queryOne } = require('../database');
const { authenticate } = require('../middleware/auth');

// ========== CATEGORIAS DE CANAIS ==========
router.get('/servers/:serverId/categories', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (!role) return res.status(403).json({ error: 'Você não é membro deste servidor' });
    res.json(await Category.list(req.params.serverId));
  } catch (error) {
    console.error('Erro ao listar categorias:', error);
    res.status(500).json({ error: 'Erro ao listar categorias' });
  }
});

router.post('/servers/:serverId/categories', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem criar categorias' });
    const category = await Category.create(req.params.serverId, req.body?.name);
    const io = req.app.get('io');
    if (io) io.to(`server-${req.params.serverId}`).emit('category-updated', { serverId: req.params.serverId });
    res.json(category);
  } catch (error) {
    console.error('Erro ao criar categoria:', error);
    res.status(400).json({ error: error.message || 'Erro ao criar categoria' });
  }
});

router.put('/servers/:serverId/categories/:categoryId', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem editar categorias' });
    const category = await Category.rename(req.params.serverId, req.params.categoryId, req.body?.name);
    const io = req.app.get('io');
    if (io) io.to(`server-${req.params.serverId}`).emit('category-updated', { serverId: req.params.serverId });
    res.json(category);
  } catch (error) {
    console.error('Erro ao editar categoria:', error);
    res.status(400).json({ error: error.message || 'Erro ao editar categoria' });
  }
});

router.delete('/servers/:serverId/categories/:categoryId', authenticate, async (req, res) => {
  try {
    const role = await Server.getMemberRole(req.params.serverId, req.user.id);
    if (role !== 'admin') return res.status(403).json({ error: 'Apenas administradores podem excluir categorias' });
    const result = await Category.remove(req.params.serverId, req.params.categoryId);
    const io = req.app.get('io');
    if (io) io.to(`server-${req.params.serverId}`).emit('category-updated', { serverId: req.params.serverId });
    res.json(result);
  } catch (error) {
    console.error('Erro ao excluir categoria:', error);
    res.status(400).json({ error: error.message || 'Erro ao excluir categoria' });
  }
});

// ========== PERFIL DENTRO DO SERVIDOR ==========
// Inclui datas e uma hierarquia de cargos visual para o servidor atual.
// O sistema de permissões existente continua baseado em admin/member; os
// nomes abaixo são a representação visual solicitada no perfil.
router.get('/users/:userId/server-profile', authenticate, async (req, res) => {
  try {
    const serverId = req.query.serverId;
    if (!serverId) return res.status(400).json({ error: 'serverId é obrigatório' });

    const requesterRole = await Server.getMemberRole(serverId, req.user.id);
    if (!requesterRole) return res.status(403).json({ error: 'Você não é membro deste servidor' });

    const member = await queryOne(
      `SELECT sm.user_id, sm.role, sm.joined_at, s.creator_id
       FROM server_members sm
       JOIN servers s ON s.id = sm.server_id
       WHERE sm.server_id = $1 AND sm.user_id = $2`,
      [serverId, req.params.userId]
    );
    if (!member) return res.status(404).json({ error: 'Membro não encontrado neste servidor' });

    const profile = await User.getPublicProfile(req.params.userId);
    if (!profile) return res.status(404).json({ error: 'Usuário não encontrado' });

    const roles = [];
    if (member.user_id === member.creator_id) {
      roles.push({ name: 'FOUNDER', color: '#ffcd3c', position: 100 });
      roles.push({ name: 'OWNER', color: '#ff4fd8', position: 90 });
    } else if (member.role === 'admin') {
      roles.push({ name: 'ADMIN', color: '#8b2bff', position: 80 });
      roles.push({ name: 'STAFF', color: '#b56bff', position: 70 });
    }
    roles.push({ name: 'MEMBRO', color: '#9a86bd', position: 10 });

    res.json({
      ...profile,
      server_id: serverId,
      server_joined_at: member.joined_at,
      server_role: member.role,
      is_server_owner: member.user_id === member.creator_id,
      roles
    });
  } catch (error) {
    console.error('Erro ao buscar perfil no servidor:', error);
    res.status(500).json({ error: 'Erro ao buscar perfil no servidor' });
  }
});

module.exports = router;
