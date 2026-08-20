const app = require('./app');
const http = require('http');
const { setupSocket } = require('./socket');
const config = require('./config');
const db = require('./database');
const { startMediaServer } = require('./media');

const server = http.createServer(app);

// Configurar Socket.IO
const io = setupSocket(server);
// Disponível pras rotas HTTP (ex: /api/servers/:id/join) avisarem quem já
// está com a página aberta que alguém novo entrou no servidor.
app.set('io', io);

const PORT = config.port;

async function start() {
  try {
    // Garante que as tabelas existam antes de aceitar requisições/conexões.
    await db.initSchema();
    server.listen(PORT, () => {
      console.log(`🐱 Cat Empire rodando em http://localhost:${PORT}`);
      console.log(`📡 Modo: ${config.nodeEnv}`);
      console.log(`🗄️  Banco: Postgres`);
    });
    // O servidor de RTMP/HTTP-FLV do cast externo roda em portas próprias
    // (não a mesma do Express). Só liga se MEDIA_SERVER_ENABLED=true — em
    // hosts como o Render (plano web padrão), a porta RTMP (1935) não fica
    // exposta publicamente, então isso normalmente precisa rodar num host
    // separado que exponha portas TCP arbitrárias. Veja o README.
    startMediaServer(io);
  } catch (error) {
    console.error('❌ Falha ao inicializar o banco de dados:', error);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Desligando...');
  await db.pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Desligando (SIGTERM)...');
  await db.pool.end();
  process.exit(0);
});
