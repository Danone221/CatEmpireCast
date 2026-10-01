const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const User = require('../database/models/User');
const config = require('../config');
const { validateRegistration, validateLogin } = require('../auth-input');
const { authenticate } = require('../middleware/auth');
const {
  bearerToken,
  createAccessToken,
  revokeAccessToken
} = require('../security');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' }
});

function parseCookies(req) {
  const out = {};
  for (const chunk of String(req.headers.cookie || '').split(';')) {
    const index = chunk.indexOf('=');
    if (index <= 0) continue;
    out[chunk.slice(0, index).trim()] = decodeURIComponent(chunk.slice(index + 1).trim());
  }
  return out;
}

function oauthCookie(name, value, maxAge = 600) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearOauthCookies(res) {
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `cat_oauth_state=; Path=/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  res.append('Set-Cookie', `cat_oauth_verifier=; Path=/auth/discord/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

router.post('/register', authLimiter, async (req, res) => {
  try {
    const parsed = validateRegistration(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { username, password, displayName } = parsed.value;
    const existing = await User.findByUsername(username);
    if (existing) return res.status(400).json({ error: 'Usuário já existe' });

    const user = await User.create({ username, password, displayName });
    res.set('Cache-Control', 'no-store');
    res.json({ user, token: createAccessToken(user) });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'Usuário já existe' });
    console.error('Erro ao registrar:', error);
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

    res.set('Cache-Control', 'no-store');
    res.json({ user, token: createAccessToken(user) });
  } catch (error) {
    console.error('Erro ao fazer login:', error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

router.post('/logout', async (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(204).end();

  try {
    await revokeAccessToken(token);
  } catch (error) {
    if (!/revogado/i.test(String(error.message || ''))) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
  }
  res.set('Cache-Control', 'no-store');
  res.status(204).end();
});

router.get('/discord', authLimiter, (req, res) => {
  if (!config.discordClientId || !config.discordRedirectUri) {
    return res.status(500).send('Integração com Discord não configurada no servidor.');
  }

  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  res.append('Set-Cookie', oauthCookie('cat_oauth_state', state));
  res.append('Set-Cookie', oauthCookie('cat_oauth_verifier', verifier));

  const params = new URLSearchParams({
    client_id: config.discordClientId,
    redirect_uri: config.discordRedirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256'
  });

  res.set('Cache-Control', 'no-store');
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

router.get('/discord/callback', authLimiter, async (req, res) => {
  const { code, state, error: discordError } = req.query;
  const cookies = parseCookies(req);
  clearOauthCookies(res);

  if (discordError) {
    return res.redirect('/?discordError=' + encodeURIComponent(String(discordError).slice(0, 80)));
  }
  if (!code || !state || !safeEqual(state, cookies.cat_oauth_state) || !cookies.cat_oauth_verifier) {
    return res.redirect('/?discordError=invalid_oauth_state');
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: config.discordRedirectUri,
        code_verifier: cookies.cat_oauth_verifier
      })
    });

    if (!tokenRes.ok) {
      console.error('Erro ao trocar código do Discord. HTTP', tokenRes.status);
      return res.redirect('/?discordError=token_exchange_failed');
    }

    const tokenData = await tokenRes.json();
    if (!tokenData?.access_token) {
      return res.redirect('/?discordError=token_exchange_failed');
    }

    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!profileRes.ok) return res.redirect('/?discordError=profile_fetch_failed');

    const profile = await profileRes.json();
    const avatar = profile.avatar
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
      : null;

    const user = await User.findOrCreateByDiscord({
      discordId: profile.id,
      username: (profile.username || `user${profile.id}`).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30) || `user_${profile.id.slice(-6)}`,
      displayName: String(profile.global_name || profile.username || 'Discord User').replace(/[<>]/g, '').slice(0, 32),
      avatar
    });

    const appToken = createAccessToken(user);
    res.set('Cache-Control', 'no-store');
    res.redirect('/#discord_token=' + encodeURIComponent(appToken));
  } catch (error) {
    console.error('Erro no callback do Discord:', error.message);
    res.redirect('/?discordError=unexpected_error');
  }
});

router.get('/verify', authenticate, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ user: req.user });
});

module.exports = router;
