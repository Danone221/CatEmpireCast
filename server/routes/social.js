const express = require('express');
const router = express.Router();
const User = require('../database/models/User');
const { authenticate } = require('../middleware/auth');

router.get('/users/by-username/:username', authenticate, async (req, res) => {
  try {
    const username = String(req.params.username || '').trim().replace(/^@/, '');
    if (!username) return res.status(400).json({ error: 'Informe um username' });
    const user = await User.findByUsername(username);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'Você não pode adicionar a si mesmo' });
    res.json(await User.getPublicProfile(user.id));
  } catch (e) { res.status(500).json({ error: 'Erro ao buscar usuário' }); }
});

module.exports = router;
