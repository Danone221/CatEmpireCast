const User = require('../database/models/User');
const { bearerToken, verifyAccessToken } = require('../security');

async function authenticate(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  try {
    const decoded = await verifyAccessToken(token);
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }

    req.auth = decoded;
    req.authToken = token;
    req.user = user;
    next();
  } catch (error) {
    console.error('Erro ao autenticar:', error.message);
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

async function optionalAuth(req, res, next) {
  const token = bearerToken(req);
  if (token) {
    try {
      const decoded = await verifyAccessToken(token);
      const user = await User.findById(decoded.id);
      if (user) {
        req.auth = decoded;
        req.authToken = token;
        req.user = user;
      }
    } catch (_) {}
  }
  next();
}

module.exports = { authenticate, optionalAuth };
