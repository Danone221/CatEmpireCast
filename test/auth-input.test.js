const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUsername, validateRegistration, validateLogin } = require('../server/auth-input');

test('normaliza o nome de usuário', () => {
  assert.equal(normalizeUsername('  Cat_User  '), 'cat_user');
});

test('aceita um cadastro válido e aplica nome de exibição padrão', () => {
  assert.deepEqual(validateRegistration({ username: 'cat_user', password: 'segura123' }), {
    value: { username: 'cat_user', password: 'segura123', displayName: 'cat_user' }
  });
});

test('rejeita usuário, senha e nome de exibição fora dos limites', () => {
  assert.ok(validateRegistration({ username: 'a!', password: 'segura123' }).error);
  assert.ok(validateRegistration({ username: 'usuario', password: 'curta' }).error);
  assert.ok(validateRegistration({ username: 'usuario', password: 'segura123', displayName: 'x'.repeat(51) }).error);
});

test('login rejeita campos ausentes e limita entradas', () => {
  assert.ok(validateLogin({ username: '', password: '' }).error);
  assert.ok(validateLogin({ username: 'x'.repeat(31), password: 'segura123' }).error);
  assert.deepEqual(validateLogin({ username: ' Cat_User ', password: 'segura123' }), {
    value: { username: 'cat_user', password: 'segura123' }
  });
});
