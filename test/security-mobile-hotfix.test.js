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

test('mobile login cards avoid backdrop-filter compositor glitches', () => {
  const css = source('client/login-real-theme.css');
  const html = source('client/index.html');
  assert.match(css, /@media\(max-width:860px\)[\s\S]*-webkit-backdrop-filter:none!important/);
  assert.match(css, /backdrop-filter:none!important/);
  assert.match(css, /contain:paint/);
  assert.match(css, /transform:none!important/);
  assert.match(html, /login-real-theme\.css\?v=20261001-mobilefix1/);
});

test('production static surface blocks login lab pages', () => {
  const app = source('server/app.js');
  assert.match(app, /login-lab-\\d\+\\\.html/);
});
