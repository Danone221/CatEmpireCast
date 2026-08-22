const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../database');
const User = require('../database/models/User');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/blocks', async (req, res) => {
  try {
    const rows = await query(`
      SELECT u.id,u.username,u.display_name,u.avatar,u.banner,u.banner_color,b.created_at
      FROM user_blocks b JOIN users u ON u.id=b.blocked_id
      WHERE b.blocker_id=$1 ORDER BY b.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao listar bloqueios:', error);
    res.status(500).json({ error: 'Erro ao carregar contas bloqueadas' });
  }
});

router.get('/blocks/:userId/status', async (req, res) => {
  try {
    const row = await queryOne(`
      SELECT EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2) AS blocked_by_me,
             EXISTS(SELECT 1 FROM user_blocks WHERE blocker_id=$2 AND blocked_id=$1) AS blocked_me`,
      [req.user.id, req.params.userId]);
    res.json(row || { blocked_by_me:false, blocked_me:false });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao verificar bloqueio' });
  }
});

router.post('/blocks/:userId', async (req, res) => {
  const targetId = req.params.userId;
  try {
    if (targetId === req.user.id) return res.status(400).json({ error: 'Você não pode bloquear a si mesmo' });
    if (!(await User.findById(targetId))) return res.status(404).json({ error: 'Usuário não encontrado' });
    await query('INSERT INTO user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.user.id,targetId]);
    await query('DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [req.user.id,targetId]);
    const io=req.app.get('io');
    if(io){io.to(`user-${req.user.id}`).emit('block-changed',{userId:targetId,blocked:true});io.to(`user-${targetId}`).emit('block-changed',{userId:req.user.id,blockedBy:true});}
    res.status(201).json({ success:true, blocked:true });
  } catch (error) {
    console.error('Erro ao bloquear usuário:', error);
    res.status(500).json({ error: 'Erro ao bloquear usuário' });
  }
});

router.delete('/blocks/:userId', async (req, res) => {
  try {
    await query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2', [req.user.id,req.params.userId]);
    const io=req.app.get('io');
    if(io){io.to(`user-${req.user.id}`).emit('block-changed',{userId:req.params.userId,blocked:false});io.to(`user-${req.params.userId}`).emit('block-changed',{userId:req.user.id,blockedBy:false});}
    res.json({ success:true, blocked:false });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao desbloquear usuário' });
  }
});

module.exports = router;
