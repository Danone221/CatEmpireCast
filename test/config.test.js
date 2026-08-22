const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('produção recusa um segredo JWT ausente ou curto', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server/config')"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'curto' },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET/);
});

test('produção rejeita segredo composto apenas por espaços', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server/config')"], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: ' '.repeat(40) }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});

test('produção aceita um segredo JWT forte', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./server/config')"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});
