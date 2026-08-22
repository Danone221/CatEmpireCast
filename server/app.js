const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');
const extraRoutes = require('./routes/extra');
const authRoutes = require('./routes/auth');
const featureRoutes = require('./routes/features');
const settingsRoutes = require('./routes/settings');
const socialRoutes = require('./routes/social');

const app = express();

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://cdn.discordapp.com"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:", "http:", "https:"]
    }
  }
}));
app.use(cors({ origin: config.corsOrigin }));
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Arquivos estáticos
app.use(express.static(path.join(__dirname, '../client')));

// Rotas
app.use('/api', apiRoutes);
app.use('/api', extraRoutes);
app.use('/api', socialRoutes);
app.use('/api/features', featureRoutes);
app.use('/api/features', settingsRoutes);
app.use('/auth', authRoutes);

// Rotas de convite
app.get(['/invite', '/invite/:code', '/invite/:code/*'], (req, res) => {
  res.sendFile(path.join(__dirname, '../client/invite.html'));
});

// Fallback para SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

module.exports = app;
