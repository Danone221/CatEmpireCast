const SAFE_IMAGE_DATA = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i;
const SAFE_HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SAFE_FILE_TYPES = new Set([
  'image/jpeg','image/png','image/gif','image/webp',
  'video/mp4','video/webm','audio/mpeg','audio/ogg','application/pdf'
]);

function isSafeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch (_) {
    return false;
  }
}

function isSafeImageSource(value, maxLength = 1300000) {
  if (typeof value !== 'string' || !value || value.length > maxLength) return false;
  return SAFE_IMAGE_DATA.test(value) || isSafeHttpsUrl(value);
}

function normalizeImageSource(value, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  if (!isSafeImageSource(value, maxLength)) {
    throw Object.assign(new Error('Formato de imagem inválido'), { status: 400 });
  }
  return value;
}

function normalizeHexColor(value) {
  if (value === null || value === undefined || value === '') return null;
  const color = String(value).trim();
  if (!SAFE_HEX_COLOR.test(color)) {
    throw Object.assign(new Error('Cor inválida'), { status: 400 });
  }
  return color.toLowerCase();
}

function normalizeSocketFile(file, maxBytes = 8 * 1024 * 1024) {
  if (!file) return null;
  const type = String(file.type || '').toLowerCase();
  if (!SAFE_FILE_TYPES.has(type)) {
    throw Object.assign(new Error('Tipo de arquivo não permitido'), { status: 400 });
  }
  const data = String(file.data || '');
  const prefix = `data:${type};base64,`;
  if (!data.startsWith(prefix)) {
    throw Object.assign(new Error('Conteúdo do arquivo inválido'), { status: 400 });
  }
  const encoded = data.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw Object.assign(new Error('Conteúdo do arquivo inválido'), { status: 400 });
  }
  const estimatedBytes = Math.floor(encoded.length * 3 / 4);
  if (estimatedBytes > maxBytes) {
    throw Object.assign(new Error('Arquivo muito grande'), { status: 413 });
  }
  return {
    name: String(file.name || 'arquivo').replace(/[\r\n\0]/g, '').slice(0, 255),
    type,
    size: estimatedBytes,
    data
  };
}

module.exports = {
  isSafeImageSource,
  normalizeImageSource,
  normalizeHexColor,
  normalizeSocketFile
};
