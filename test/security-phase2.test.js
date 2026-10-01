const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sanitizeAttachment, cleanMessageText } = require('../server/input-security');

test('attachment validator accepts only allowed MIME and bounded base64', () => {
  const file = sanitizeAttachment(
    { name: '../x.png', type: 'image/png', data: 'data:image/png;base64,aGVsbG8=' },
    { maxBytes: 1024, allowedTypes: ['image/png'] }
  );
  assert.equal(file.name, '.._x.png');
  assert.equal(file.size, 5);
  assert.throws(() => sanitizeAttachment(
    { name: 'x.svg', type: 'image/svg+xml', data: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { maxBytes: 1024, allowedTypes: ['image/png'] }
  ));
});

test('message cleaner strips control bytes and caps length', () => {
  assert.equal(cleanMessageText('  hi\u0000there  ', 20), 'hithere');
  assert.equal(cleanMessageText('x'.repeat(50), 10), 'x'.repeat(10));
});

test('JWT hardening has auth versioning and no legacy-token fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/security.js'), 'utf8');
  assert.match(source, /auth_version/);
  assert.match(source, /expiresIn:\s*'12h'/);
  assert.match(source, /decoded\?\.av === undefined/);
  assert.doesNotMatch(source, /legacy:/);
  assert.doesNotMatch(source, /const legacy = jwt\.verify/);
});

test('logout revokes token and bumps user auth version', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/routes/auth.js'), 'utf8');
  assert.match(source, /await revokeAccessToken\(token\)/);
  assert.match(source, /await User\.bumpAuthVersion\(decoded\.id\)/);
  assert.match(source, /code_challenge_method:\s*'S256'/);
  assert.match(source, /timingSafeEqual/);
});

test('app has abuse limits, strict parsers and prototype-pollution guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/app.js'), 'utf8');
  assert.match(source, /app\.disable\('x-powered-by'\)/);
  assert.match(source, /mutationLimiter/);
  assert.match(source, /strict:\s*true/);
  assert.match(source, /__proto__/);
  assert.match(source, /dotfiles:\s*'deny'/);
  assert.match(source, /segments\.includes\('\.\.'\)/);
});

test('socket messages require membership, room join and payload validation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/socket.js'), 'utf8');
  assert.match(source, /sanitizeAttachment/);
  assert.match(source, /cleanMessageText/);
  assert.match(source, /socket\.textChannel !== channelId/);
  assert.match(source, /rateLimited\(socket, 'send-message'/);
  assert.match(source, /rateLimited\(socket, 'send-dm'/);
});

test('User model prevents arbitrary column assignment', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/database/models/User.js'), 'utf8');
  assert.match(source, /const allowed = new Set\(\['display_name', 'avatar', 'banner', 'bio', 'banner_color'\]\)/);
  assert.match(source, /auth_version = auth_version \+ 1/);
});

test('global search is tenant-scoped to server membership', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/routes/expansion.js'), 'utf8');
  const start = source.indexOf("router.get('/search'");
  const end = source.indexOf('// ===== MEMBER DETAILS =====', start);
  const block = source.slice(start, end);
  assert.ok(block.length > 0);
  assert.match(block, /JOIN server_members sm ON sm\.server_id=/);
  assert.match(block, /sm\.user_id=\$2/);
  assert.match(block, /m\.deleted_at IS NULL/);
});

test('reaction reads filter message ids by authenticated access', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/routes/features.js'), 'utf8');
  const start = source.indexOf("router.get('/reactions'");
  const end = source.indexOf("router.post('/reactions/toggle'", start);
  const block = source.slice(start, end);
  assert.ok(block.length > 0);
  assert.match(block, /sender_id=\$2 OR recipient_id=\$2/);
  assert.match(block, /JOIN server_members sm/);
  assert.match(block, /allowedIds/);
});

test('server settings reuse canonical validation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/routes/settings.js'), 'utf8');
  assert.match(source, /sanitizePlainText/);
  assert.match(source, /validateImageValue/);
});

test('active clients never accept auth credentials from query strings', () => {
  for (const file of ['runtime-v5.js', 'mentions-v5.js', 'room.js', 'dms.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../client', file), 'utf8');
    assert.doesNotMatch(source, /q\.get\(['\"]token['\"]\)/);
    assert.doesNotMatch(source, /q\.get\(['\"]userId['\"]\)/);
  }
});

test('user profile updates keep PostgreSQL values parameterized', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/database/models/User.js'), 'utf8');
  assert.match(source, /fields\.push/);
  assert.match(source, /\$\$\{i\}/);
});

test('persisted attachment URLs are escaped before HTML interpolation', () => {
  for (const file of ['room.js', 'dms.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../client', file), 'utf8');
    assert.match(source, /href=\"\$\{esc\(m\.file_data\)\}\"/);
  }
});
