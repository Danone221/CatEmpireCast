const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../database/models/User');
const config = require('../config');
const { validateRegistration, validateLogin } = require('../auth-input');
const { authenticate, resolveSession } = require('../middleware/auth');
const {
  issueSession,
  clearSession,
  createOAuthState,
  setOAuthState,
  consumeOAuthState
} = require('../security/session');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' }
});

const oauthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de autenticação.' }
});

router.post('/register', authLimiter, async (req, res) => {
  try {
    const parsed = validateRegistration(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { username, password, displayName } = parsed.value;
    if (await User.findByUsername(username)) {
      return res.status(400).json({ error: 'Usuário já existe' });
    }
    const user = await User.create({ username, password, displayName });
    await issueSession(res, user);
    res.json({ user });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'Usuário já existe' });
    console.error('Erro ao registrar:', error?.code || error?.message);
    res.status(500).json({ error: 'Erro ao registrar' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const parsed = validateLogin(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { username, password } = parsed.value;
    const user = await User.authenticate(username, password);
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });
    await issueSession(res, user);
    res.json({ user });
  } catch (error) {
    console.error('Erro ao fazer login:', error?.code || error?.message);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

router.get('/discord', oauthLimiter, (req, res) => {
  if (!config.discordClientId || !config.discordClientSecret || !config.discordRedirectUri) {
    return res.status(500).send('Integração com Discord não configurada no servidor.');
  }
  const state = createOAuthState();
  setOAuthState(res, state);
  res.set('Cache-Control', 'no-store');
  const params = new URLSearchParams({
    client_id: config.discordClientId,
    redirect_uri: config.discordRedirectUri,
    response_type: 'code',
    scope: 'identify',
    state
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

router.get('/discord/callback', oauthLimiter, async (req, res) => {
  const { code, state, error: discordError } = req.query;
  if (!consumeOAuthState(req, res, state)) {
    return res.redirect('/?discordError=invalid_state');
  }
  if (discordError) {
    return res.redirect('/?discordError=' + encodeURIComponent(String(discordError).slice(0, 80)));
  }
  if (!code) return res.redirect('/?discordError=missing_code');

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: config.discordRedirectUri
      })
    });
    if (!tokenRes.ok) {
      console.error('Discord token exchange failed:', tokenRes.status);
      return res.redirect('/?discordError=token_exchange_failed');
    }

    const tokenData = await tokenRes.json();
    if (!tokenData?.access_token) {
      return res.redirect('/?discordError=token_exchange_failed');
    }

    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!profileRes.ok) {
      console.error('Discord profile fetch failed:', profileRes.status);
      return res.redirect('/?discordError=profile_fetch_failed');
    }

    const profile = await profileRes.json();
    if (!profile?.id) return res.redirect('/?discordError=invalid_profile');

    const avatar = profile.avatar
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
      : null;

    const user = await User.findOrCreateByDiscord({
      discordId: String(profile.id),
      username: (profile.username || `user${profile.id}`).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30) || `user_${String(profile.id).slice(-6)}`,
      displayName: String(profile.global_name || profile.username || 'Discord User').slice(0, 32),
      avatar
    });

    await issueSession(res, user);
    res.redirect('/?discord=success');
  } catch (error) {
    console.error('Erro no callback do Discord:', error?.code || error?.message);
    res.redirect('/?discordError=unexpected_error');
  }
});

router.get('/verify', authenticate, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ user: req.user });
});

router.post('/logout', async (req, res) => {
  try {
    const session = await resolveSession(req);
    if (session?.user) await User.bumpAuthVersion(session.user.id);
  } catch {}
  clearSession(res);
  res.json({ success: true });
});

module.exports = router;
