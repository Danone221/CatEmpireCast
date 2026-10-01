const crypto = require('crypto');
const net = require('net');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { query, queryOne } = require('./database');

const TOKEN_ISSUER = 'cat-empire';
const TOKEN_AUDIENCE = 'cat-empire-web';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function configuredOrigins() {
  return String(config.corsOrigin || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function originAllowed(origin) {
  if (!origin) return true;
  const origins = configuredOrigins();
  if (config.nodeEnv !== 'production' && origins.includes('*')) return true;
  return origins.includes(origin);
}

function requestOriginAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (origin) return originAllowed(origin);

  const referer = String(req.headers.referer || '').trim();
  if (referer) {
    try { return originAllowed(new URL(referer).origin); }
    catch (_) { return false; }
  }

  return String(req.headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site';
}

function csrfOriginGuard(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  if (!requestOriginAllowed(req)) {
    return res.status(403).json({ error: 'Origem da requisição não autorizada' });
  }
  next();
}

function sanitizePlainText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, maxLength);
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) return true;

  if (net.isIP(host) === 4) {
    const octets = host.split('.').map(Number);
    const [a, b] = octets;
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) return true;
  }

  if (net.isIP(host) === 6) {
    const normalized = host.toLowerCase();
    if (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.') ||
      normalized.startsWith('::ffff:169.254.')
    ) return true;
  }

  return false;
}

function validateImageValue(value, { allowShortText = false, maxLength = 700000 } = {}) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw || raw.length > maxLength) throw new Error('Imagem inválida ou muito grande');

  if (allowShortText && raw.length <= 16 && !/[<>]/.test(raw) && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return raw;
  }

  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\r\n]+$/i.test(raw)) {
    return raw;
  }

  let parsed;
  try { parsed = new URL(raw); } catch (_) { throw new Error('URL de imagem inválida'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || isPrivateHost(parsed.hostname)) {
    throw new Error('URL de imagem não permitida');
  }
  return parsed.toString();
}

async function createAccessToken(user) {
  const state = await queryOne('SELECT auth_version FROM users WHERE id=$1', [user.id]);
  if (!state) throw new Error('Usuário não encontrado');
  const authVersion = Number(state.auth_version || 0);

  return jwt.sign(
    { id: user.id, username: user.username, av: authVersion },
    config.jwtSecret,
    {
      expiresIn: '12h',
      algorithm: 'HS256',
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      jwtid: crypto.randomUUID()
    }
  );
}

async function verifyAccessToken(token, { allowRevoked = false } = {}) {
  const raw = String(token || '').trim();
  if (!raw || raw.length > 8192) throw new Error('Token inválido');

  const decoded = jwt.verify(raw, config.jwtSecret, {
    algorithms: ['HS256'],
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE
  });

  if (!decoded?.id || !decoded?.jti || !decoded?.exp || decoded?.av === undefined) {
    throw new Error('Token incompleto');
  }

  const authState = await queryOne('SELECT auth_version FROM users WHERE id=$1', [decoded.id]);
  if (!authState || Number(authState.auth_version || 0) !== Number(decoded.av)) {
    throw new Error('Sessão revogada');
  }

  if (!allowRevoked) {
    const revoked = await queryOne(
      'SELECT 1 FROM revoked_tokens WHERE jti=$1 AND expires_at > extract(epoch FROM now())::bigint',
      [decoded.jti]
    );
    if (revoked) throw new Error('Token revogado');
  }
  return decoded;
}

async function revokeAccessToken(token) {
  const decoded = await verifyAccessToken(token, { allowRevoked: true });
  await query(
    `INSERT INTO revoked_tokens (jti, user_id, expires_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (jti) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
    [decoded.jti, decoded.id, decoded.exp]
  );
  return decoded;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

module.exports = {
  TOKEN_ISSUER,
  TOKEN_AUDIENCE,
  bearerToken,
  configuredOrigins,
  createAccessToken,
  csrfOriginGuard,
  originAllowed,
  requestOriginAllowed,
  revokeAccessToken,
  sanitizePlainText,
  validateImageValue,
  verifyAccessToken
};
