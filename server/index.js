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

      INSERT INTO server_roles (id,server_id,name,color,position,permissions)
      SELECT md5(s.id || ':admin'),s.id,'ADMIN',90,NULL::text,'{"administrator":true}'::jsonb
      FROM servers s
      WHERE NOT EXISTS (SELECT 1 FROM server_roles r WHERE r.server_id=s.id AND r.name='ADMIN');
      INSERT INTO server_roles (id,server_id,name,color,position,permissions)
      SELECT md5(s.id || ':moderator'),s.id,'MODERATOR',70,NULL::text,'{"manage_messages":true,"mute_members":true,"timeout_members":true}'::jsonb
      FROM servers s
      WHERE NOT EXISTS (SELECT 1 FROM server_roles r WHERE r.server_id=s.id AND r.name='MODERATOR');
      INSERT INTO server_roles (id,server_id,name,color,position,permissions)
      SELECT md5(s.id || ':staff'),s.id,'STAFF',50,NULL::text,'{"manage_channels":true,"manage_messages":true}'::jsonb
      FROM servers s
      WHERE NOT EXISTS (SELECT 1 FROM server_roles r WHERE r.server_id=s.id AND r.name='STAFF');
      INSERT INTO server_roles (id,server_id,name,color,position,permissions)
      SELECT md5(s.id || ':member'),s.id,'MEMBER',10,NULL::text,'{"view_channel":true,"send_messages":true,"connect":true}'::jsonb
      FROM servers s
      WHERE NOT EXISTS (SELECT 1 FROM server_roles r WHERE r.server_id=s.id AND r.name='MEMBER');

      INSERT INTO server_role_members(role_id,server_id,user_id)
      SELECT r.id,s.id,s.creator_id
      FROM servers s JOIN server_roles r ON r.server_id=s.id AND r.name='OWNER'
      WHERE NOT EXISTS (SELECT 1 FROM server_role_members rm WHERE rm.role_id=r.id AND rm.user_id=s.creator_id);
      INSERT INTO server_role_members(role_id,server_id,user_id)
      SELECT r.id,s.id,sm.user_id
      FROM server_members sm JOIN servers s ON s.id=sm.server_id JOIN server_roles r ON r.server_id=s.id AND r.name='MEMBER'
      WHERE sm.role='member'
        AND NOT EXISTS (SELECT 1 FROM server_role_members rm WHERE rm.role_id=r.id AND rm.user_id=sm.user_id);
    `);

    server.listen(PORT, () => {
      console.log(`🐱 Cat Empire rodando em http://localhost:${PORT}`);
      console.log(`📡 Modo: ${config.nodeEnv}`);
      console.log('🗄️  Banco: Postgres');
      console.log('🧩 Plataforma: schema expandido sem reset destrutivo');
      console.log('🗂️  Estrutura: categorias e canais com suporte a text/voice/stage/forum');
      console.log('👑 Hierarquia: OWNER > ADMIN > MODERATOR > STAFF > MEMBER > @EVERYONE');
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
