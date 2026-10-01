const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'development';
process.env.CORS_ORIGIN = 'https://cat-empire-n6qv.onrender.com';

const {
  originAllowed,
  sanitizePlainText,
  validateImageValue
} = require('../server/security');

test('plain text sanitizer removes HTML tag delimiters', () => {
  assert.equal(sanitizePlainText('<iframe srcdoc="x">bio</iframe>', 190), 'iframe srcdoc="x"bio/iframe');
});

test('image validation rejects local and dangerous schemes', () => {
  assert.throws(() => validateImageValue('file:///etc/passwd'));
  assert.throws(() => validateImageValue('http://169.254.169.254/latest/meta-data/'));
  assert.throws(() => validateImageValue('https://127.0.0.1/private'));
  assert.equal(validateImageValue('🐱', { allowShortText: true }), '🐱');
});

test('configured production origin is accepted and foreign origins are rejected', () => {
  assert.equal(originAllowed('https://cat-empire-n6qv.onrender.com'), true);
  assert.equal(originAllowed('https://evil.example'), false);
});

test('websocket identity is derived from verified handshake auth', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/socket.js'), 'utf8');
  assert.match(source, /io\.use\(async \(socket, next\)/);
  assert.match(source, /verifyAccessToken\(token\)/);
  assert.match(source, /const userId = socket\.userId/);
  assert.doesNotMatch(source, /socket\.on\('register',[\s\S]{0,250}User\.findById\(userId\)/);
});

test('server profile patch cannot mass-assign owner identity', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/routes/expansion.js'), 'utf8');
  const start = source.indexOf("router.patch('/servers/:serverId/profile'");
  const end = source.indexOf("router.get('/servers/:serverId/security'", start);
  const block = source.slice(start, end);
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /owner_id|creator_id|is_owner/);
});
