const express = require('express');
const router = express.Router();
const User = require('../database/models/User');
const jwt = require('jsonwebtoken');
const config = require('../config');

// Registrar
router.post('/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }
    const existing = await User.findByUsername(username);
    if (existing) {
      return res.status(400).json({ error: 'Usuário já existe' });
    }
    const user = await User.create({ username, password, displayName });
    const token = jwt.sign({ id: user.id, username: user.username }, config.jwtSecret, { expiresIn: '7d' });
    res.json({ user, token });
  } catch (error) {
    console.error('Erro ao registrar:', error);
    res.status(500).json({ error: 'Erro ao registrar' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }
    const user = await User.authenticate(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, config.jwtSecret, { expiresIn: '7d' });
    res.json({ user, token });
  } catch (error) {
    console.error('Erro ao fazer login:', error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

// Passo 1: redireciona o navegador para a tela de autorização do Discord
router.get('/discord', (req, res) => {
  if (!config.discordClientId || !config.discordRedirectUri) {
    return res.status(500).send('Integração com Discord não configurada no servidor (variáveis de ambiente ausentes).');
  }
  const params = new URLSearchParams({
    client_id: config.discordClientId,
    redirect_uri: config.discordRedirectUri,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// Passo 2: callback do Discord — troca o code por token, busca o perfil e loga o usuário
router.get('/discord/callback', async (req, res) => {
  const { code, error: discordError } = req.query;
  if (discordError) {
    return res.redirect('/?discordError=' + encodeURIComponent(discordError));
  }
  if (!code) {
    return res.redirect('/?discordError=missing_code');
  }
  try {
    // Troca o código de autorização por um access_token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.discordRedirectUri
      })
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('Erro ao trocar código do Discord:', errText);
      return res.redirect('/?discordError=token_exchange_failed');
    }
    const tokenData = await tokenRes.json();

    // Busca o perfil do usuário autenticado
    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!profileRes.ok) {
      return res.redirect('/?discordError=profile_fetch_failed');
    }
    const profile = await profileRes.json();

    const avatar = profile.avatar
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
      : null;

    const user = await User.findOrCreateByDiscord({
      discordId: profile.id,
      username: (profile.username || `user${profile.id}`).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30) || `user_${profile.id.slice(-6)}`,
      displayName: profile.global_name || profile.username,
      avatar
    });

    const jwtToken = jwt.sign({ id: user.id, username: user.username }, config.jwtSecret, { expiresIn: '7d' });
    // Envia o resultado pro cliente via hash da URL (não fica salvo no histórico do servidor)
    res.redirect('/#discord_token=' + encodeURIComponent(jwtToken));
  } catch (error) {
    console.error('Erro no callback do Discord:', error);
    res.redirect('/?discordError=unexpected_error');
  }
});

// Verificar token
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' });
    }
    const decoded = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }
    res.json({ user });
  } catch (error) {
    console.error('Erro ao verificar token:', error);
    res.status(401).json({ error: 'Token inválido' });
  }
});

module.exports = router;
