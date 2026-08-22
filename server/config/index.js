require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const jwtSecret = String(process.env.JWT_SECRET || '').trim();
const weakJwtSecrets = new Set(['cat_empire_secret', 'cat_empire_local_development_only', 'troque_por_um_valor_aleatorio_e_secreto']);

if (nodeEnv === 'production' && (jwtSecret.length < 32 || weakJwtSecrets.has(jwtSecret))) {
  throw new Error('JWT_SECRET deve ser definido com pelo menos 32 caracteres em produção.');
}

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv,
  jwtSecret: jwtSecret || 'cat_empire_local_development_only',
  databaseUrl: process.env.DATABASE_URL || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  discordClientId: process.env.DISCORD_CLIENT_ID || '',
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  discordRedirectUri: process.env.DISCORD_REDIRECT_URI || '',
  media: {
    enabled: process.env.MEDIA_SERVER_ENABLED === 'true',
    rtmpPort: Number(process.env.MEDIA_RTMP_PORT || 1935),
    httpPort: Number(process.env.MEDIA_HTTP_PORT || 8000),
    // Host público (com protocolo) de onde o navegador vai puxar o
    // HTTP-FLV pra tocar o cast. Se o servidor de mídia estiver rodando
    // junto (mesma máquina/host que o app principal), normalmente é o
    // mesmo domínio do app, só que na porta MEDIA_HTTP_PORT.
    publicRtmpHost: process.env.MEDIA_PUBLIC_RTMP_HOST || '',
    publicHttpBase: process.env.MEDIA_PUBLIC_HTTP_BASE || ''
  },
  upload: {
    maxSize: 50 * 1024 * 1024,
    allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'application/pdf']
  }
};
