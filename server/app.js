const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const apiRoutes = require('./routes/api');
const extraRoutes = require('./routes/extra');
const authRoutes = require('./routes/auth');
const featureRoutes = require('./routes/features');
const settingsRoutes = require('./routes/settings');
const socialRoutes = require('./routes/social');
const platformRoutes = require('./routes/platform');
const structureRoutes = require('./routes/structure');
const messagingRoutes = require('./routes/messaging');

const app = express();

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

// A camada V4/VNext é funcional: o HTML/CSS-base existente continua sendo a identidade visual.
const clientDir = path.join(__dirname, '../client');
const htmlFiles = new Set(['/', '/index.html', '/server.html', '/dms.html', '/invite.html']);
app.use((req, res, next) => {
  if (req.method !== 'GET' || !htmlFiles.has(req.path) || !String(req.headers.accept || '').includes('text/html')) return next();
  const file = req.path === '/' ? 'index.html' : req.path.slice(1);
  const fullPath = path.join(clientDir, file);
  fs.readFile(fullPath, 'utf8', (err, html) => {
    if (err) return next();
    if (!html.includes('data-cat-empire-v4')) {
      html = html.replace('</body>', '<script src="/vnext-loader.js" data-cat-empire-loader></script></body>');
    }
    res.type('html').send(html);
  });
});

app.use(express.static(clientDir));

app.use('/api', apiRoutes);
app.use('/api', extraRoutes);
app.use('/api', socialRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/platform', structureRoutes);
app.use('/api/platform', messagingRoutes);
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
