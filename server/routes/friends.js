const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../database');
const User = require('../database/models/User');
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.use(authenticate);

async function findUser(username) {
  const normalized = String(username || '').trim().replace(/^@/, '');
  if (!normalized) return null;
  return User.findByUsername(normalized);
}

router.get('/friends', async (req, res) => {
  try {
    const rows = await query(`
      SELECT f.user_id, f.friend_id, f.status, f.created_at, f.updated_at,
             u.id, u.username, u.display_name, u.avatar, u.banner, u.status AS presence
      FROM friends f
      JOIN users u ON u.id = CASE WHEN f.user_id=$1 THEN f.friend_id ELSE f.user_id END
      WHERE (f.user_id=$1 OR f.friend_id=$1) AND f.status='accepted'
      ORDER BY COALESCE(u.display_name,u.username)
    `, [req.user.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Erro ao carregar amigos' }); }
});

router.get('/friends/requests', async (req, res) => {
  try {
    const incoming = await query(`
      SELECT f.user_id AS requester_id, f.created_at, u.username, u.display_name, u.avatar
      FROM friends f JOIN users u ON u.id=f.user_id
      WHERE f.friend_id=$1 AND f.status='pending' ORDER BY f.created_at DESC
    `, [req.user.id]);
    const outgoing = await query(`
      SELECT f.friend_id AS target_id, f.created_at, u.username, u.display_name, u.avatar
      FROM friends f JOIN users u ON u.id=f.friend_id
      WHERE f.user_id=$1 AND f.status='pending' ORDER BY f.created_at DESC
    `, [req.user.id]);
    res.json({ incoming, outgoing });
  } catch (e) { res.status(500).json({ error: 'Erro ao carregar solicitações' }); }
});

router.post('/friends/request', async (req, res) => {
  try {
    const target = await findUser(req.body.username);
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Você não pode adicionar a si mesmo' });
    const block = await queryOne('SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1', [req.user.id,target.id]);
    if (block) return res.status(403).json({ error: 'Não é possível enviar solicitação para este usuário' });

    const existing = await queryOne(`SELECT * FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1) ORDER BY CASE WHEN friend_id=$1 THEN 0 ELSE 1 END LIMIT 1`, [req.user.id, target.id]);
    if (existing?.status === 'accepted') return res.status(409).json({ error: 'Vocês já são amigos' });
    if (existing?.status === 'pending') {
      if (existing.user_id === target.id && existing.friend_id === req.user.id) {
        await query('UPDATE friends SET status=\'accepted\', updated_at=extract(epoch FROM now())::bigint WHERE user_id=$1 AND friend_id=$2', [target.id, req.user.id]);
        await query('INSERT INTO friends(user_id,friend_id,status) VALUES($1,$2,\'accepted\') ON CONFLICT(user_id,friend_id) DO UPDATE SET status=\'accepted\',updated_at=extract(epoch FROM now())::bigint', [req.user.id, target.id]);
        return res.json({ success: true, accepted: true, message: 'Solicitação aceita.' });
      }
      return res.status(409).json({ error: 'Solicitação já enviada' });
    }
    if (existing?.status === 'blocked') return res.status(403).json({ error: 'Não é possível enviar esta solicitação' });

    await query('INSERT INTO friends(user_id,friend_id,status) VALUES($1,$2,\'pending\')', [req.user.id, target.id]);
    await query(`INSERT INTO notifications(id,user_id,type,title,description,target) VALUES($1,$2,'friend_request',$3,$4,$5::jsonb)`, [uuidv4(), target.id, 'Nova solicitação de amizade', 'Um usuário enviou uma solicitação de amizade.', JSON.stringify({ userId:req.user.id })]);
    res.status(201).json({ success: true, message: 'Solicitação enviada.' });
  } catch (e) {
    if (e?.code === '23505') return res.status(409).json({ error: 'Solicitação já enviada' });
    console.error('Erro ao enviar solicitação de amizade:', e);
    res.status(500).json({ error: 'Erro ao enviar solicitação' });
  }
});

router.post('/friends/requests/:userId/accept', async (req, res) => {
  try {
    const requester = req.params.userId;
    const block = await queryOne('SELECT 1 FROM user_blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1', [req.user.id,requester]);
    if (block) return res.status(403).json({ error: 'Não é possível aceitar esta solicitação' });
    const pending = await queryOne('SELECT * FROM friends WHERE user_id=$1 AND friend_id=$2 AND status=\'pending\'', [requester, req.user.id]);
    if (!pending) return res.status(404).json({ error: 'Solicitação não encontrada' });
    await query('UPDATE friends SET status=\'accepted\', updated_at=extract(epoch FROM now())::bigint WHERE user_id=$1 AND friend_id=$2', [requester, req.user.id]);
    await query('INSERT INTO friends(user_id,friend_id,status) VALUES($1,$2,\'accepted\') ON CONFLICT(user_id,friend_id) DO UPDATE SET status=\'accepted\',updated_at=extract(epoch FROM now())::bigint', [req.user.id, requester]);
    res.json({ success:true });
  } catch (e) { res.status(400).json({ error:'Erro ao aceitar solicitação' }); }
});

router.delete('/friends/:userId', async (req, res) => {
  try {
    await query('DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [req.user.id, req.params.userId]);
    res.json({ success:true });
  } catch (e) { res.status(500).json({ error:'Erro ao remover amizade' }); }
});

module.exports = router;
