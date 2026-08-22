const app = require('./app');
const http = require('http');
const { setupSocket } = require('./socket');
const config = require('./config');
const db = require('./database');
const { initPlatformSchema } = require('./database/platform');
const { initMessagingSchema } = require('./database/messaging');
const { initStageSchema } = require('./database/stage');
const { initExpansionSchema } = require('./database/expansion');
const { startMediaServer } = require('./media');

const server = http.createServer(app);
const io = setupSocket(server);
app.set('io', io);

const PORT = config.port;

async function start() {
  try {
    await db.initSchema();
    await initPlatformSchema();
    await initMessagingSchema();
    await initStageSchema();
    await initExpansionSchema();

    await db.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS banner TEXT;
      ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner TEXT;
      ALTER TABLE channel_categories ADD COLUMN IF NOT EXISTS collapsed BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE channel_categories ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS category_id TEXT REFERENCES channel_categories(id) ON DELETE SET NULL;
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS user_limit INTEGER DEFAULT 0;
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS bitrate INTEGER DEFAULT 64000;
      ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
      ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK(type IN ('text','voice','stage','forum'));

      INSERT INTO server_roles (id,server_id,name,color,position,permissions)
      SELECT md5(s.id || ':admin'),s.id,'ADMIN','#e74c3c',90,'{"administrator":true}'::jsonb
      FROM servers s
      WHERE NOT EXISTS (SELECT 1 FROM server_roles r WHERE r.server_id=s.id AND r.name='ADMIN');
      INSERT INTO server_roles (id,server_id,name,color,position,permissions)
      SELECT md5(s.id || ':moderator'),s.id,'MODERATOR','#f1c40f',70,'{"manage_messages":true,"mute_members":true,"timeout_members":true}'::jsonb
      FROM servers s
      WHERE NOT EXISTS (SELECT 1 FROM server_roles r WHERE r.server_id=s.id AND r.name='MODERATOR');
      INSERT INTO server_roles (id,server_id,name,color,position,permissions)
      SELECT md5(s.id || ':staff'),s.id,'STAFF','#3498db',50,'{"manage_channels":true,"manage_messages":true}'::jsonb
      FROM servers s
      WHERE NOT EXISTS (SELECT 1 FROM server_roles r WHERE r.server_id=s.id AND r.name='STAFF');
      INSERT INTO server_roles (id,server_id,name,color,position,permissions)
      SELECT md5(s.id || ':member'),s.id,'MEMBER','#95a5a6',10,'{"view_channel":true,"send_messages":true,"connect":true}'::jsonb
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
      console.log('🧩 Plataforma: expansão completa sem reset destrutivo');
      console.log('🗂️  Estrutura: categorias, text/voice/stage/forum, threads e permissões');
      console.log('🎙️  Stage: moderadores, palestrantes e audiência persistidos');
      console.log('👑 Hierarquia: OWNER > ADMIN > MODERATOR > STAFF > MEMBER > @EVERYONE');
      console.log('💬 Mensagens: reações, anexos, menções, respostas e pins habilitados');
      console.log('🌐 V4 API: perfis, segurança, comunidade, convites, emojis, stickers, moderação, onboarding, automod e pesquisa');
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
