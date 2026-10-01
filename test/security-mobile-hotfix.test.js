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
  assert.match(socket, /rateLimited\(socket, 'send-attachment', 4, 60_000\)/);
  assert.match(socket, /rateLimited\(socket, 'send-dm-attachment', 4, 60_000\)/);
  assert.match(socket, /rateLimited\(socket, 'edit-message'/);
  assert.match(socket, /rateLimited\(socket, 'edit-dm'/);
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

test('websocket upgrades enforce origin and schema migrations constrain identifiers', () => {
  const socket = source('server/socket.js');
  const db = source('server/database/index.js');
  assert.match(socket, /allowRequest\(req, callback\)/);
  assert.match(socket, /originAllowed\(origin\)/);
  assert.match(db, /identifier = \/\^\[a-z_\]/);
  assert.match(db, /allowedTypes = new Set/);
  assert.match(db, /Migração de schema inválida/);
});

test('message mutations re-check current access and blocked DMs cannot be edited', () => {
  const socket = source('server/socket.js');
  assert.match(socket, /memberRole = channel \? await ServerModel\.getMemberRole/);
  assert.match(socket, /if \(!memberRole\) return socket\.emit\('error', \{ message: 'Acesso ao canal negado' \}\)/);
  assert.match(socket, /role === 'admin' \|\| role === 'owner'/);
  assert.match(socket, /if \(block\) return socket\.emit\('error', \{ message: 'Esta conversa está bloqueada' \}\)/);
});

test('reserved system role names cannot be spoofed by custom roles', () => {
  const role = source('server/database/models/Role.js');
  assert.match(role, /isSystemRoleName/);
  assert.match(role, /Nome do cargo inválido ou reservado/);
  assert.match(role, /trim\(\)\.toLowerCase\(\)/);
});

test('alternate REST message routes keep the same authorization and input guards', () => {
  const dm = source('server/routes/dm.js');
  const messaging = source('server/routes/messaging.js');
  assert.match(dm, /sanitizeAttachment/);
  assert.match(dm, /cleanMessageText/);
  assert.match(dm, /Esta conversa está bloqueada/);
  assert.match(dm, /Não é possível adicionar um usuário bloqueado ao grupo/);
  assert.match(messaging, /await requireMemberByChannel\(message\.channel_id, req\.user\.id\)/);
  assert.match(messaging, /normalizeStoredAttachment/);
  assert.match(messaging, /validatePublicHttpsUrl/);
  assert.match(messaging, /Menção inválida para este servidor/);
});

test('platform role update and assignment enforce hierarchy and tenant scope', () => {
  const platform = source('server/routes/platform.js');
  const role = source('server/database/models/Role.js');
  assert.match(platform, /Role\.update\(req\.params\.serverId, req\.params\.roleId, next\)/);
  assert.match(platform, /Você não pode editar um cargo acima ou igual à sua hierarquia/);
  assert.match(platform, /Cargos reservados não podem ser atribuídos manualmente/);
  assert.match(platform, /Membro não encontrado neste servidor/);
  assert.match(platform, /Referência de permissão inválida para este servidor/);
  assert.match(role, /Este cargo é gerenciado pelo sistema/);
});

test('V4 server profile uses PostgreSQL placeholders and admin payloads are bounded', () => {
  const expansion = source('server/routes/expansion.js');
  const platform = source('server/routes/platform.js');
  assert.match(expansion, /fields\.push\(\`\$\{key\}=\$\$\{values\.length\}\`\)/);
  assert.match(expansion, /WHERE id=\$\$\{values\.length\}/);
  assert.match(expansion, /validateServerChannel/);
  assert.match(expansion, /requireModerationTarget/);
  assert.match(expansion, /boundedJson\(questions,32768/);
  assert.match(platform, /validateServerIds/);
  assert.match(platform, /requireModerationTarget/);
  assert.match(platform, /boundedJson\(rules,32768/);
});

test('feature settings allow both owner and admin', () => {
  const settings = source('server/routes/settings.js');
  assert.match(settings, /\['admin', 'owner'\]\.includes\(role\)/);
});

test('Engine.IO handshakes have pre-auth resource limits', () => {
  const socket = source('server/socket.js');
  assert.match(socket, /handshakeBuckets/);
  assert.match(socket, /allowHandshake\(req\)/);
  assert.match(socket, /bucket\.count <= 120/);
  assert.match(socket, /handshakeBuckets\.size >= 10_000/);
});

test('generic external attachment URLs require public HTTPS', () => {
  const security = source('server/security.js');
  assert.match(security, /function validatePublicHttpsUrl/);
  assert.match(security, /parsed\.protocol !== 'https:'/);
  assert.match(security, /isPrivateHost\(parsed\.hostname\)/);
});

