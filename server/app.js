const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const apiRoutes = require('./routes/api');
const profileRoutes = require('./routes/profile');
const extraRoutes = require('./routes/extra');
const authRoutes = require('./routes/auth');
const featureRoutes = require('./routes/features');
const settingsRoutes = require('./routes/settings');
const socialRoutes = require('./routes/social');
const friendsRoutes = require('./routes/friends');
const blocksRoutes = require('./routes/blocks');
const platformRoutes = require('./routes/platform');
const structureRoutes = require('./routes/structure');
const roleRoutes = require('./routes/roles');
const dmRoutes = require('./routes/dm');
const messagingRoutes = require('./routes/messaging');
const stageRoutes = require('./routes/stage');
const expansionRoutes = require('./routes/expansion');
const db = require('./database');
const { csrfOriginGuard, originAllowed } = require('./security');

const app = express();

app.disable('x-powered-by');
app.set('query parser', 'simple');
if (config.nodeEnv === 'production') app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://cdn.discordapp.com', 'https://media.discordapp.net'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  }
}));

app.use((req, res, next) => {
  const origin = String(req.headers.origin || '').trim();
  if (origin && !originAllowed(origin)) {
    return res.status(403).json({ error: 'Origem não autorizada' });
  }
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || originAllowed(origin)) return callback(null, true);
    return callback(new Error('Origem não autorizada'));
  },
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em instantes.' }
});
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas alterações em pouco tempo.' }
});

app.use('/api', apiLimiter);
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return mutationLimiter(req, res, next);
  }
  next();
});

app.use(compression());
app.use(express.json({ limit: '10mb', strict: true }));
app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 100 }));

function hasDangerousObjectKeys(value, depth = 0) {
  if (!value || typeof value !== 'object') return false;
  if (depth > 12) return true;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return true;
    if (hasDangerousObjectKeys(value[key], depth + 1)) return true;
  }
  return false;
}

app.use((req, res, next) => {
  if (hasDangerousObjectKeys(req.body) || hasDangerousObjectKeys(req.query)) {
    return res.status(400).json({ error: 'Estrutura de entrada inválida' });
  }
  if (Object.values(req.query || {}).some(Array.isArray)) {
    return res.status(400).json({ error: 'Parâmetros duplicados não são permitidos' });
  }
  if (req.path.startsWith('/api/') && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const length = Number(req.headers['content-length'] || 0);
    if (length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'Corpo da requisição muito grande' });
    }
    if (length > 0 && !req.is('application/json')) {
      return res.status(415).json({ error: 'Content-Type deve ser application/json' });
    }
  }
  next();
});

app.use((req, res, next) => {
  const rawPath = String(req.originalUrl || '').split('?')[0];
  let decoded = rawPath;
  try {
    for (let i = 0; i < 2; i++) decoded = decodeURIComponent(decoded);
  } catch (_) {
    return res.status(400).json({ error: 'Caminho inválido' });
  }
  const normalized = decoded.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (normalized.includes('\0') || segments.includes('..') || /(^|\/)\.(?!well-known(?:\/|$))/.test(normalized)) {
    return res.status(400).json({ error: 'Caminho inválido' });
  }
  next();
});

app.use(csrfOriginGuard);
app.use(['/api', '/auth'], (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Toda mutação de servidor aprovada publica um evento único. Assim clientes
// conectados atualizam somente os dados afetados, sem reload/F5.
app.use('/api', (req, res, next) => {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  const match = String(req.originalUrl || '').match(/^\/api\/(?:(?:platform|features|v4)\/)?servers\/([^/?]+)/);
  if (!match) return next();
  const targetServerId = decodeURIComponent(match[1]);
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const io = req.app.get('io');
    if (io) io.to(`server-${targetServerId}`).emit('server-data-changed', {
      serverId: targetServerId,
      method: req.method,
      path: String(req.originalUrl || '').split('?')[0],
      changedAt: Date.now()
    });
  });
  next();
});

app.get('/health', async (req, res) => {
  try {
    await db.queryOne('SELECT 1 AS ok');
    res.status(200).json({ status: 'ok', database: 'ok' });
  } catch (error) {
    console.error('❌ Health check: Postgres indisponível:', error.code || error.message);
    res.status(503).json({ status: 'degraded', database: 'unavailable' });
  }
});

const clientDir = path.join(__dirname, '../client');

app.use((req, res, next) => {
  if (req.method === 'GET' && /^\/login-lab-\d+\.html$/i.test(req.path)) {
    return res.status(404).type('text').send('Not Found');
  }
  next();
});

const htmlFiles = new Set(['/', '/index.html', '/server.html', '/dms.html', '/invite.html']);
app.use((req, res, next) => {
  if (req.method !== 'GET' || !htmlFiles.has(req.path) || !String(req.headers.accept || '').includes('text/html')) return next();
  const file = req.path === '/' ? 'index.html' : req.path.slice(1);
  const fullPath = path.join(clientDir, file);
  fs.readFile(fullPath, 'utf8', (err, html) => {
    if (err) return next();
    // Keep HTML pages deterministic. Do not inject legacy profile/runtime layers
    // at request time; the pages explicitly load their canonical scripts.
    html = html.replace(/<script[^>]+(?:profile-v5|features-v4-final)[^>]*><\/script>/gi, '');
    if (!html.includes('data-cat-empire-v4') && !html.includes('vnext-loader.js')) {
      html = html.replace('</body>', '<script src="/vnext-loader.js?v=20260822" data-cat-empire-loader></script></body>');
    }
    res.type('html').send(html);
  });
});

app.use(express.static(clientDir, { dotfiles: 'deny', index: false, redirect: false }));

app.use('/api', profileRoutes);
app.use('/api', apiRoutes);
app.use('/api', extraRoutes);
app.use('/api', socialRoutes);
app.use('/api/social', friendsRoutes);
app.use('/api/social', blocksRoutes);
app.use('/api/platform', roleRoutes);
app.use('/api/platform', structureRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/platform', dmRoutes);
app.use('/api/platform', messagingRoutes);
app.use('/api/platform', stageRoutes);
app.use('/api/v4', expansionRoutes);
app.use('/api/features', featureRoutes);
app.use('/api/features', settingsRoutes);
app.use('/auth', authRoutes);

app.get(['/invite', '/invite/:code', '/invite/:code/*'], (req, res) => {
  res.sendFile(path.join(__dirname, '../client/invite.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return res.status(404).json({ error: 'Rota não encontrada' });
  }
  res.status(404).type('text').send('Not Found');
});

module.exports = app;
