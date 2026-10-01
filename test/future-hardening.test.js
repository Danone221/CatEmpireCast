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
