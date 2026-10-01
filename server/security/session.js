const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../database/models/User');

const SESSION_COOKIE = 'cat_session';
const OAUTH_STATE_COOKIE = 'cat_oauth_state';

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge
  };
}

function getCookie(req, name) {
  return parseCookies(req?.headers?.cookie || '')[name] || '';
}

async function createSessionToken(user) {
  const state = await User.getAuthState(user.id);
  if (!state) throw new Error('Usuário não encontrado');
  return jwt.sign(
    { sub: state.id, username: state.username, av: Number(state.auth_version || 0) },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: '12h',
      issuer: 'cat-empire',
      audience: 'cat-empire-web'
    }
  );
}

async function verifySessionToken(token) {
  const decoded = jwt.verify(String(token || ''), config.jwtSecret, {
    algorithms: ['HS256'],
    issuer: 'cat-empire',
    audience: 'cat-empire-web'
  });
  const userId = decoded.sub || decoded.id;
  if (!userId || decoded.av === undefined) throw new Error('Sessão desatualizada');
  const state = await User.getAuthState(userId);
  if (!state || Number(state.auth_version || 0) !== Number(decoded.av)) {
    throw new Error('Sessão revogada');
  }
  const user = await User.findById(userId);
  if (!user) throw new Error('Usuário não encontrado');
  return { decoded, user };
}

async function createNativeCastToken(user, channelId) {
  const state = await User.getAuthState(user.id);
  if (!state) throw new Error('Usuário não encontrado');
  return jwt.sign(
    {
      sub: state.id,
      av: Number(state.auth_version || 0),
      purpose: 'native-cast',
      channelId: String(channelId)
    },
    config.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: '2m',
      issuer: 'cat-empire',
      audience: 'cat-empire-native-cast'
    }
  );
}

async function verifyNativeCastToken(token) {
  const decoded = jwt.verify(String(token || ''), config.jwtSecret, {
    algorithms: ['HS256'],
    issuer: 'cat-empire',
    audience: 'cat-empire-native-cast'
  });
  if (decoded.purpose !== 'native-cast' || !decoded.sub || !decoded.channelId || decoded.av === undefined) {
    throw new Error('Token de transmissão inválido');
  }
  const state = await User.getAuthState(decoded.sub);
  if (!state || Number(state.auth_version || 0) !== Number(decoded.av)) {
    throw new Error('Token de transmissão revogado');
  }
  return decoded;
}

async function issueSession(res, user) {
  const token = await createSessionToken(user);
  res.cookie(SESSION_COOKIE, token, cookieOptions(12 * 60 * 60 * 1000));
  res.set('Cache-Control', 'no-store');
  return token;
}

function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(0), maxAge: undefined });
  res.set('Cache-Control', 'no-store');
}

function createOAuthState() {
  return crypto.randomBytes(32).toString('base64url');
}

function setOAuthState(res, state) {
  res.cookie(OAUTH_STATE_COOKIE, state, cookieOptions(10 * 60 * 1000));
}

function consumeOAuthState(req, res, supplied) {
  const expected = getCookie(req, OAUTH_STATE_COOKIE);
  res.clearCookie(OAUTH_STATE_COOKIE, { ...cookieOptions(0), maxAge: undefined });
  if (!expected || !supplied) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(supplied));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  SESSION_COOKIE,
  OAUTH_STATE_COOKIE,
  getCookie,
  parseCookies,
  verifySessionToken,
  createNativeCastToken,
  verifyNativeCastToken,
  issueSession,
  clearSession,
  createOAuthState,
  setOAuthState,
  consumeOAuthState
};
