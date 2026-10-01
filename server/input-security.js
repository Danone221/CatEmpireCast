function sanitizeAttachment(file, { maxBytes = 8 * 1024 * 1024, allowedTypes = [] } = {}) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return null;

  const type = String(file.type || '').trim().toLowerCase();
  const allowed = new Set((allowedTypes || []).map(value => String(value).toLowerCase()));
  if (!type || !allowed.has(type)) {
    throw Object.assign(new Error('Tipo de arquivo não permitido'), { status: 400 });
  }

  const data = String(file.data || '');
  const prefix = `data:${type};base64,`;
  if (!data.startsWith(prefix)) {
    throw Object.assign(new Error('Conteúdo do arquivo inválido'), { status: 400 });
  }

  const encoded = data.slice(prefix.length).replace(/[\r\n]/g, '');
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) {
    throw Object.assign(new Error('Arquivo Base64 inválido'), { status: 400 });
  }

  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
  if (!decodedBytes || decodedBytes > maxBytes) {
    throw Object.assign(new Error('Arquivo excede o limite permitido'), { status: 413 });
  }

  const name = String(file.name || 'arquivo')
    .replace(/[\\/\0\r\n]/g, '_')
    .replace(/[<>"]/g, '')
    .slice(0, 160) || 'arquivo';

  return { name, type, size: decodedBytes, data: `${prefix}${encoded}` };
}

function cleanMessageText(value, maxLength = 2000) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

module.exports = { sanitizeAttachment, cleanMessageText };
