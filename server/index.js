const app = require('./app');
const http = require('http');
const { setupSocket } = require('./socket');
const config = require('./config');
const db = require('./database');
const { initPlatformSchema } = require('./database/platform');
const { startMediaServer } = require('./media');

const server = http.createServer(app);
const io = setupSocket(server);
app.set('io', io);

const PORT = config.port;

async function start() {
  try {
    await db.initSchema();
    // Expande o schema existente sem apagar ou resetar dados antigos.
    await initPlatformSchema();

    server.listen(PORT, () => {
      console.log(`🐱 Cat Empire rodando em http://localhost:${PORT}`);
      console.log(`📡 Modo: ${config.nodeEnv}`);
      console.log('🗄️  Banco: Postgres');
      console.log('🧩 Plataforma: schema expandido sem reset destrutivo');
    });

    startMediaServer(io);
  } catch (error) {
    console.error('❌ Falha ao inicializar o banco de dados:', error);
    process.exit(1);
  }
}

start();

async function shutdown(message) {
  console.log(message);
  try { await db.pool.end(); } finally { process.exit(0); }
}
process.on('SIGINT', () => shutdown('🛑 Desligando...'));
process.on('SIGTERM', () => shutdown('🛑 Desligando (SIGTERM)...'));
