const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('v4 profile updates retain PostgreSQL placeholders and bounded settings', () => {
  const expansion = source('server/routes/expansion.js');
  assert.match(expansion, /fields\.push\(`\$\{key\}=\$\$\{values\.length\}`\)/);
  assert.match(expansion, /WHERE id=\$\$\{values\.length\} RETURNING/);
  assert.match(expansion, /boundedJson\(req\.body\.settings, \{\}, 32768\)/);
});

test('v4 cross-tenant channel references and custom media are validated', () => {
  const expansion = source('server/routes/expansion.js');
  assert.match(expansion, /requireChannelInServer/);
  assert.match(expansion, /SELECT id FROM channels WHERE id=\$1 AND server_id=\$2/);
  assert.match(expansion, /securityLevels/);
  assert.match(expansion, /notificationModes/);
  assert.match(expansion, /validateImageValue\(req\.body\.image,\{maxLength:200000\}\)/);
  assert.match(expansion, /Usuário não é membro deste servidor/);
  assert.match(expansion, /proprietário do servidor não pode ser moderado/);
});

test('REST DMs reuse canonical message and attachment validation', () => {
  const dm = source('server/routes/dm.js');
  assert.match(dm, /sanitizeAttachment/);
  assert.match(dm, /cleanMessageText\(req\.body\.content, 2000\)/);
  assert.match(dm, /Esta conversa está bloqueada/);
  assert.match(dm, /validateImageValue\(req\.body\.icon/);
});

test('invite preview recognizes HttpOnly cookie sessions', () => {
  const api = source('server/routes/api.js');
  assert.match(api, /accessTokenFromRequest\(req\)/);
  assert.doesNotMatch(api, /authHeader\.split\(' '\)\[1\]/);
  const profileRouteOccurrences = (api.match(/router\.put\('\/me\/profile'/g) || []).length;
  assert.equal(profileRouteOccurrences, 0);
});

test('realtime DB-writing voice events have abuse limits', () => {
  const socket = source('server/socket.js');
  assert.match(socket, /rateLimited\(socket, 'audio-toggle', 40, 10_000\)/);
  assert.match(socket, /rateLimited\(socket, 'register-native-screen', 10, 10_000\)/);
  assert.match(socket, /const safeMuted = !!muted/);
});

test('Android native bridge is restricted to the canonical HTTPS origin', () => {
  const activity = source('CatEmpireCast/app/src/main/java/com/danonin/catempirecast/MainActivity.kt');
  const service = source('CatEmpireCast/app/src/main/java/com/danonin/catempirecast/BroadcastService.kt');
  const manifest = source('CatEmpireCast/app/src/main/AndroidManifest.xml');
  assert.match(activity, /isTrustedAppUrl/);
  assert.match(activity, /uri\.scheme\.equals\("https"/);
  assert.match(activity, /removeJavascriptInterface\("CatEmpireNative"\)/);
  assert.match(activity, /if \(!isTrustedAppUrl\(request\.origin\)\)/);
  assert.doesNotMatch(activity, /host\.endsWith\("onrender\.com"\)/);
  assert.match(activity, /WebView\.setWebContentsDebuggingEnabled\(false\)/);
  assert.match(service, /CookieManager\.getInstance\(\)\.getCookie\(baseUrl\)/);
  assert.match(service, /options\.extraHeaders = mapOf\("Cookie" to listOf\(cookieHeader\)\)/);
  assert.match(manifest, /android:allowBackup="false"/);
});

test('Discord OAuth parsing and upstream calls are bounded', () => {
  const auth = source('server/routes/auth.js');
  assert.match(auth, /try \{[\s\S]*decodeURIComponent\(raw\)/);
  assert.match(auth, /AbortSignal\.timeout\(10000\)/);
});

test('platform friendship acceptance requires a real incoming pending request', () => {
  const platform = source('server/routes/platform.js');
  assert.match(platform, /SELECT 1 FROM friends WHERE user_id=\$1 AND friend_id=\$2 AND status='pending'/);
  assert.match(platform, /if \(!pending\) return res\.status\(404\)/);
  assert.match(platform, /user_blocks/);
});

test('platform role and permission mutations enforce hierarchy and tenant scope', () => {
  const platform = source('server/routes/platform.js');
  assert.match(platform, /Role\.update/);
  assert.match(platform, /Number\(role\.position \|\| 0\) >= level/);
  assert.match(platform, /assertScopedReference/);
  assert.match(platform, /Referência não pertence a este servidor/);
  assert.match(platform, /cleanPermissionMap/);
});

test('REST server messages re-check membership and reject unsafe attachment schemes', () => {
  const messaging = source('server/routes/messaging.js');
  assert.match(messaging, /requireMemberByChannel\(message\.channel_id, req\.user\.id\)/);
  assert.match(messaging, /sanitizeAttachment/);
  assert.match(messaging, /parsed\.protocol !== 'https:'/);
  assert.match(messaging, /server_members WHERE server_id=\$1 AND user_id=\$2/);
  assert.match(messaging, /server_roles WHERE server_id=\$1 AND id=\$2/);
});

test('group DMs enforce existing block relationships', () => {
  const dm = source('server/routes/dm.js');
  assert.match(dm, /blocker_id = ANY\(\$1::text\[\]\)/);
  assert.match(dm, /JOIN group_dm_members gm ON gm\.group_id=\$1/);
});

test('dev-only presentation assets remain outside the public static surface', () => {
  const app = source('server/app.js');
  for (const name of ['community-test-theme.css','rx-test-theme.css','crystal-theme.css','login-depth-theme.css']) {
    assert.match(app, new RegExp(name.replace('.', '\\.'), 'i'));
  }
  assert.match(app, /Cache-Control', 'no-store'/);
  assert.match(app, /Permissions-Policy/);
});

test('canonical role router owns all role CRUD verbs without platform duplicates', () => {
  const roles = source('server/routes/roles.js');
  const platform = source('server/routes/platform.js');
  assert.match(roles, /router\.patch\('\/servers\/:serverId\/roles\/:roleId', updateRole\)/);
  assert.match(roles, /router\.put\('\/servers\/:serverId\/roles\/:roleId', updateRole\)/);
  assert.doesNotMatch(platform, /router\.(get|post|put|patch|delete)\('\/servers\/:serverId\/roles(?:\/|')/);
});

test('structured server content is bounded before persistence', () => {
  const messaging = source('server/routes/messaging.js');
  const structure = source('server/routes/structure.js');
  assert.match(messaging, /boundedJson\(embeds, \[\], 32768\)/);
  assert.match(messaging, /boundedJson\(attachment\.metadata \|\| \{\}, \{\}, 8192\)/);
  assert.match(structure, /cleanPermissionMap/);
  assert.match(structure, /sanitizePlainText\(req\.body\.topic, 1000\)/);
});

test('canonical HTML supports HEAD and Android networking overrides old transitive client deps', () => {
  const app = source('server/app.js');
  const gradle = source('CatEmpireCast/app/build.gradle');
  assert.match(app, /\['GET','HEAD'\]\.includes\(req\.method\)/);
  assert.match(gradle, /socket\.io-client:2\.1\.2/);
  assert.match(gradle, /okhttp:4\.12\.0/);
});
