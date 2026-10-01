const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');

function source(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('invite consumption is atomic and race-safe', () => {
  const invite = source('server/database/models/Invite.js');
  const api = source('server/routes/api.js');
  assert.match(invite, /consumeForUser\(code, userId\)/);
  assert.match(invite, /FOR UPDATE/);
  assert.match(invite, /ON CONFLICT \(server_id, user_id\) DO NOTHING/);
  assert.match(invite, /COALESCE\(i\.uses, 0\) \+ 1/);
  assert.match(api, /Invite\.consumeForUser\(invite\.code, req\.user\.id\)/);
  assert.doesNotMatch(api, /Invite\.use\(invite\.code\)/);
});

test('realtime signaling is rate-limited and payload-bounded', () => {
  const socket = source('server/socket.js');
  assert.match(socket, /payloadWithinLimit/);
  assert.match(socket, /rateLimited\(socket, 'voice-signal'/);
  assert.match(socket, /rateLimited\(socket, 'native-screen-signal'/);
  assert.match(socket, /rateLimited\(socket, 'dm-typing'/);
  assert.match(socket, /Buffer\.byteLength\(JSON\.stringify/);
});

test('mobile login is one stable card with bounded shader work', () => {
  const css = source('client/login-real-theme.css');
  const html = source('client/index.html');
  const shader = source('client/liquid-metal-react.jsx');
  assert.match(css, /real-mobile-card-stable/);
  assert.match(css, /\.real-login-card\{[\s\S]*border-radius:22px!important/);
  assert.match(css, /\.real-visual-pane\{[\s\S]*position:absolute!important/);
  assert.match(css, /\.real-form-pane\{[\s\S]*contain:none!important/);
  assert.match(css, /#liquidMetalReactRoot canvas\{[\s\S]*filter:none!important/);
  assert.match(shader, /minPixelRatio: mobile \? 1 : 1\.5/);
  assert.match(shader, /maxPixelCount: mobile/);
  assert.match(shader, /webglcontextlost/);
  assert.match(html, /login-real-theme\.css\?v=20261001-mobilefix2/);
  assert.match(html, /liquid-metal-react\.bundle\.js\?v=20261001-mobilefix2/);
});

test('production static surface blocks labs and unused legacy clients', () => {
  const app = source('server/app.js');
  assert.match(app, /login-lab\(\?:-\\d\+\)\?\\\.html/);
  assert.match(app, /blockedPublicFiles/);
  assert.match(app, /features-v2\.js/);
  assert.match(app, /vnextPages = new Set\(\['\/server\.html', '\/dms\.html'\]\)/);
});

test('browser sessions use HttpOnly cookies instead of exposing JWTs', () => {
  const auth = source('server/routes/auth.js');
  const security = source('server/security.js');
  const middleware = source('server/middleware/auth.js');
  const socket = source('server/socket.js');
  const app = source('client/app.js');
  assert.match(auth, /HttpOnly; SameSite=Lax/);
  assert.match(auth, /token: 'cookie'/);
  assert.match(auth, /#discord_token=cookie/);
  assert.match(security, /SESSION_COOKIE_NAME = 'cat_session'/);
  assert.match(security, /accessTokenFromRequest/);
  assert.match(middleware, /accessTokenFromRequest\(req\)/);
  assert.match(socket, /sessionTokenFromCookieHeader/);
  assert.match(app, /token = 'cookie'/);
});

test('legacy clients do not recover credentials from query strings', () => {
  for (const file of ['client/banner-persist.js','client/features-v2.js','client/features-v3.js','client/features-v3-fix.js','client/profile-v5.js']) {
    const js = source(file);
    assert.doesNotMatch(js, /get\(['"]token['"]\)/);
    assert.doesNotMatch(js, /get\(['"]userId['"]\)/);
  }
  assert.match(source('client/platform-api.js'), /localStorage\.getItem\('cat_token'\)/);
});
