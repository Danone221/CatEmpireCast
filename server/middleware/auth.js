const jwt = require('jsonwebtoken');
const config = require('../config');
const User = require('../database/models/User');

async function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }
    req.user = user;
    next();
  } catch (error) {
    console.error('Erro ao autenticar:', error);
    res.status(401).json({ error: 'Token inválido' });
  }
}

async function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      const user = await User.findById(decoded.id);
      if (user) req.user = user;
    } catch (e) {}
  }
  next();
}

module.exports = { authenticate, optionalAuth };
