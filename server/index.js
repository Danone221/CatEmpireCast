const app = require('./app');
const http = require('http');
const { setupSocket } = require('./socket');
const config = require('./config');
const db = require('./database');
const { initPlatformSchema } = require('./database/platform');
const { initMessagingSchema } = require('./database/messaging');
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
    // Expande mensagens/reações/anexos/menções de forma compatível com dados antigos.
    await initMessagingSchema();

    // Compatibilidade estrutural: categorias continuam separadas dos canais,
    // e canais novos podem ser text/voice/stage/forum sem alterar dados antigos.
    await db.query(`
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS category_id TEXT REFERENCES channel_categories(id) ON DELETE SET NULL;
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS user_limit INTEGER DEFAULT 0;
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS bitrate INTEGER DEFAULT 64000;
      ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
      ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK(type IN ('text','voice','stage','forum'));
    `);

    server.listen(PORT, () => {
      console.log(`🐱 Cat Empire rodando em http://localhost:${PORT}`);
      console.log(`📡 Modo: ${config.nodeEnv}`);
      console.log('🗄️  Banco: Postgres');
      console.log('🧩 Plataforma: schema expandido sem reset destrutivo');
      console.log('🗂️  Estrutura: categorias e canais com suporte a text/voice/stage/forum');
      console.log('💬 Mensagens: reações, anexos, menções, respostas e pins habilitados');
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
