const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
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

const app = express();

if (config.nodeEnv === 'production') app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://cdn.discordapp.com'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'http:', 'https:']
    }
  }
}));
app.use(cors({ origin: config.corsOrigin }));
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

const clientDir = path.join(__dirname, '../client');
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

app.use(express.static(clientDir));

app.use('/api', profileRoutes);
app.use('/api', apiRoutes);
app.use('/api', extraRoutes);
app.use('/api', socialRoutes);
app.use('/api/social', friendsRoutes);
app.use('/api/social', blocksRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/platform', structureRoutes);
app.use('/api/platform', roleRoutes);
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

module.exports = app;
