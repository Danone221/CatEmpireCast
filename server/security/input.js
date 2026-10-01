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

module.exports = { isSafeImageRef, isSafeBannerValue };
