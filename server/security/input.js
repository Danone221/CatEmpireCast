function isSafeImageRef(value, maxLength = 700000) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text.length > maxLength) return false;
  if (/^\/(?!\/)/.test(text)) return true;
  if (/^https:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return url.protocol === 'https:';
    } catch {
      return false;
    }
  }
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\r\n]+$/i.test(text);
}

function isSafeBannerValue(value, maxLength = 700000) {
  if (value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return true;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(text)) return true;
  return isSafeImageRef(text, maxLength);
}

function sanitizeAttachment(file, maxBytes = 8 * 1024 * 1024, allowedTypes = []) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
  const type = String(file.type || '').trim().toLowerCase();
  const allowed = new Set((allowedTypes || []).map(value => String(value).toLowerCase()));
  if (!type || !allowed.has(type)) throw Object.assign(new Error('Tipo de arquivo não permitido'), { status: 400 });
  const data = String(file.data || '');
  const prefix = `data:${type};base64,`;
  if (!data.startsWith(prefix)) throw Object.assign(new Error('Conteúdo do arquivo inválido'), { status: 400 });
  const encoded = data.slice(prefix.length).replace(/[\r\n]/g, '');
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/i.test(encoded)) throw Object.assign(new Error('Arquivo Base64 inválido'), { status: 400 });
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
  if (!decodedBytes || decodedBytes > maxBytes) throw Object.assign(new Error('Arquivo excede o limite permitido'), { status: 413 });
  const name = String(file.name || 'arquivo').replace(/[\\/\0\r\n]/g, '_').slice(0, 160);
  return { name, type, size: decodedBytes, data };
}

module.exports = { isSafeImageRef, isSafeBannerValue, sanitizeAttachment };
