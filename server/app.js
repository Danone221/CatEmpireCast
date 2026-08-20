const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const config = require('./config');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');

const app = express();

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // flv.js (player do cast externo via RTMP/HTTP-FLV) vem do jsdelivr;
      // o resto do JS continua tudo same-origin.
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      // cdn.discordapp.com: é de lá que vem a foto de perfil de quem loga
      // com Discord — sem isso o navegador bloqueia o avatar e ele quebra.
      imgSrc: ["'self'", "data:", "blob:", "https://cdn.discordapp.com"],
      mediaSrc: ["'self'", "blob:"],
      // http(s)/ws(s) amplo: o player HTTP-FLV do cast externo pode estar
      // num host de mídia separado (ver server/media.js), então não dá pra
      // travar em 'self' aqui.
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
app.use('/auth', authRoutes);

// Fallback para SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

module.exports = app;
