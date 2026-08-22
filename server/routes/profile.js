const express = require('express');
const router = express.Router();
const User = require('../database/models/User');
const { query } = require('../database');
const { authenticate } = require('../middleware/auth');

router.put('/me/profile', authenticate, async (req, res) => {
  try {
    const data = {};
    if (typeof req.body?.displayName === 'string' && req.body.displayName.trim()) data.display_name = req.body.displayName.trim().slice(0, 32);
    if (typeof req.body?.bio === 'string') data.bio = req.body.bio.slice(0, 190);
    if (typeof req.body?.bannerColor === 'string' || req.body?.bannerColor === null) data.banner_color = req.body.bannerColor || null;
    if (typeof req.body?.banner === 'string' || req.body?.banner === null) {
      if (req.body.banner && req.body.banner.length > 900000) return res.status(400).json({ error: 'Banner muito grande (máx. ~650KB).' });
      data.banner = req.body.banner || null;
    }
    if (typeof req.body?.avatar === 'string') {
      if (req.body.avatar.length > 700000) return res.status(400).json({ error: 'Imagem muito grande (máx. ~500KB).' });
      data.avatar = req.body.avatar;
    }
    const user = await User.update(req.user.id, data);
    const io = req.app.get('io');
    if (io) {
      const servers = await User.getServers(req.user.id);
      for (const s of servers) io.to(`server-${s.id}`).emit('member-profile-updated', user);
      io.to(`user-${req.user.id}`).emit('profile-updated', user);
      const peers = await query(`
        SELECT DISTINCT CASE WHEN sender_id=$1 THEN recipient_id ELSE sender_id END AS user_id
        FROM dm_messages WHERE sender_id=$1 OR recipient_id=$1 LIMIT 500`, [req.user.id]);
      for (const peer of peers) io.to(`user-${peer.user_id}`).emit('profile-updated', user);
    }
    res.json(user);
  } catch (error) {
    console.error('Erro ao salvar perfil:', error);
    res.status(500).json({ error: 'Erro ao salvar perfil' });
  }
});

module.exports = router;
