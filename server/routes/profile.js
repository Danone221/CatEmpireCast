const express = require('express');
const router = express.Router();
const User = require('../database/models/User');
const { query } = require('../database');
const { authenticate } = require('../middleware/auth');
const { sanitizePlainText, validateImageValue } = require('../security');

function safeBanner(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  return validateImageValue(raw, { maxLength: 900000 });
}

router.put('/me/profile', authenticate, async (req, res) => {
  try {
    const data = {};

    if (typeof req.body?.displayName === 'string') {
      const displayName = sanitizePlainText(req.body.displayName, 32);
      if (!displayName) return res.status(400).json({ error: 'Nome de exibição inválido' });
      data.display_name = displayName;
    }

    if (typeof req.body?.bio === 'string') {
      data.bio = sanitizePlainText(req.body.bio, 190);
    }

    if (req.body?.bannerColor !== undefined) {
      data.banner_color = safeBanner(req.body.bannerColor);
    }

    if (req.body?.banner !== undefined) {
      data.banner = safeBanner(req.body.banner);
    }

    if (req.body?.avatar !== undefined) {
      data.avatar = validateImageValue(req.body.avatar, { maxLength: 700000 });
    }

    const user = await User.update(req.user.id, data);
    const io = req.app.get('io');

    if (io) {
      const servers = await User.getServers(req.user.id);
      for (const s of servers) io.to(`server-${s.id}`).emit('member-profile-updated', user);
      io.to(`user-${req.user.id}`).emit('profile-updated', user);

      const peers = await query(
        `SELECT DISTINCT CASE WHEN sender_id=$1 THEN recipient_id ELSE sender_id END AS user_id
         FROM dm_messages
         WHERE sender_id=$1 OR recipient_id=$1
         LIMIT 500`,
        [req.user.id]
      );
      for (const peer of peers) io.to(`user-${peer.user_id}`).emit('profile-updated', user);
    }

    res.json(user);
  } catch (error) {
    if (/imagem|URL|banner/i.test(String(error.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Erro ao salvar perfil:', error);
    res.status(500).json({ error: 'Erro ao salvar perfil' });
  }
});

module.exports = router;
