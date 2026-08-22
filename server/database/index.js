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

    CREATE TABLE IF NOT EXISTS channel_categories (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      UNIQUE (server_id, name)
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

    -- Mensagens privadas (DM) — 1 pra 1, sem canal/servidor envolvido.
    CREATE TABLE IF NOT EXISTS dm_messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT,
      file_name TEXT,
      file_type TEXT,
      file_size INTEGER,
      file_data TEXT,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint,
      edited_at BIGINT,
      read_at BIGINT
    );

    -- Links de convite para servidores
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uses INTEGER DEFAULT 0,
      max_uses INTEGER,
      expires_at BIGINT,
      created_at BIGINT NOT NULL DEFAULT extract(epoch FROM now())::bigint
    );

    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id);
    CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
    CREATE INDEX IF NOT EXISTS idx_channel_categories_server ON channel_categories(server_id, position);
    CREATE INDEX IF NOT EXISTS idx_dm_sender ON dm_messages(sender_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_dm_recipient ON dm_messages(recipient_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_invites_server ON invites(server_id);
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

  await addColumnIfMissing('users', 'bio', 'TEXT');
  await addColumnIfMissing('users', 'banner_color', 'TEXT');
  await addColumnIfMissing('servers', 'banner_color', 'TEXT');
  await addColumnIfMissing('servers', 'description', 'TEXT');
  await addColumnIfMissing('messages', 'edited_at', 'BIGINT');
  await addColumnIfMissing('dm_messages', 'file_name', 'TEXT');
  await addColumnIfMissing('dm_messages', 'file_type', 'TEXT');
  await addColumnIfMissing('dm_messages', 'file_size', 'INTEGER');
  await addColumnIfMissing('dm_messages', 'file_data', 'TEXT');
  await addColumnIfMissing('dm_messages', 'edited_at', 'BIGINT');
  await addColumnIfMissing('dm_messages', 'read_at', 'BIGINT');
  await addColumnIfMissing('invites', 'max_uses', 'INTEGER');
  await addColumnIfMissing('invites', 'expires_at', 'BIGINT');

  // Migração dos canais existentes: cada nome de categoria passa a existir
  // também como uma categoria persistente, inclusive categorias vazias criadas depois.
  await pool.query(`
    INSERT INTO channel_categories (id, server_id, name, position)
    SELECT gen_random_uuid()::text, x.server_id, x.category,
           ROW_NUMBER() OVER (PARTITION BY x.server_id ORDER BY x.category) - 1
    FROM (
      SELECT DISTINCT server_id, trim(category) AS category
      FROM channels
      WHERE category IS NOT NULL AND trim(category) <> ''
    ) x
    ON CONFLICT (server_id, name) DO NOTHING
  `);

  console.log('🗄️  Schema do Postgres verificado/criado com sucesso.');
}

// Helper de migração idempotente: adiciona a coluna só se ainda não existir.
async function addColumnIfMissing(table, column, type) {
  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (col.rowCount === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

module.exports = { pool, query, queryOne, initSchema };
