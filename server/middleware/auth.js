const { SESSION_COOKIE, getCookie, verifySessionToken } = require('../security/session');

function getBearer(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return '';
  const token = String(match[1] || '').trim();
  if (!token || token === 'null' || token === 'undefined') return '';
  return token;
}

async function resolveSession(req) {
  const token = getBearer(req) || getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  return verifySessionToken(token);
}

async function authenticate(req, res, next) {
  try {
    const session = await resolveSession(req);
    if (!session?.user) {
      return res.status(401).json({ error: 'Sessão não fornecida' });
    }
    req.user = session.user;
    req.auth = session.decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada' });
  }
}

async function optionalAuth(req, res, next) {
  try {
    const session = await resolveSession(req);
    if (session?.user) {
      req.user = session.user;
      req.auth = session.decoded;
    }
  } catch {}
  next();
}

module.exports = { authenticate, optionalAuth, resolveSession };
