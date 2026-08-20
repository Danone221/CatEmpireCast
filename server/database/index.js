const { Pool } = require('pg');
const config = require('../config');

if (!config.databaseUrl) {
  console.error('❌ DATABASE_URL não configurada. Defina a variável de ambiente apontando para o Postgres.');
}

// Conexões locais/internas (ex: rede interna do Render) geralmente não precisam de SSL.
// Conexões externas (ex: seu Postgres acessado de outro host) normalmente exigem.
const isLocal = /localhost|127\.0\.0\.1/.test(config.databaseUrl || '');
const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('❌ Erro inesperado no pool do Postgres:', err);
});

// Helper simples: executa uma query parametrizada e devolve as linhas.
async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result.rows;
}

// Executa uma query e devolve só a primeira linha (ou null).
async function queryOne(text, params = []) {
  const rows = await query(text, params);
  return rows[0] || null;
}

// ========== SCHEMA ==========
// Criação de tabelas e migrações. Chamado uma vez, na inicialização do servidor.
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT,
      avatar TEXT,
      password_hash TEXT,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      code TEXT UNIQUE NOT NULL,
      creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      role TEXT DEFAULT 'member',
      PRIMARY KEY (server_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('text', 'voice')),
      category TEXT,
      position INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT,
      file_name TEXT,
      file_type TEXT,
      file_size INTEGER,
      file_data TEXT,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE TABLE IF NOT EXISTS voice_states (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      joined_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      muted BOOLEAN DEFAULT FALSE,
      deafened BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (user_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id);
    CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
  `);

  // ===== Migração: coluna discord_id em bancos já existentes =====
  const col = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'discord_id'
  `);
  if (col.rowCount === 0) {
    await pool.query('ALTER TABLE users ADD COLUMN discord_id TEXT');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id)');
  }

  console.log('🗄️  Schema do Postgres verificado/criado com sucesso.');
}

module.exports = { pool, query, queryOne, initSchema };
