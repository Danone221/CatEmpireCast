const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');

const roots = ['client', 'server', 'scripts'];
const files = ['server.js'];

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile() && path.endsWith('.js')) files.push(path);
  }
}

for (const root of roots) collect(root);

for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Sintaxe validada em ${files.length} arquivos JavaScript.`);
