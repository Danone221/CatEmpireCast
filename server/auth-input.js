const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function validateRegistration(body = {}) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || '');
  const displayName = String(body.displayName || '').trim();

  if (!USERNAME_PATTERN.test(username)) {
    return { error: 'O usuário deve ter de 3 a 30 caracteres: letras minúsculas, números ou _' };
  }
  if (password.length < 8 || password.length > 128) {
    return { error: 'A senha deve ter de 8 a 128 caracteres' };
  }
  if (displayName.length > 50) {
    return { error: 'O nome de exibição deve ter no máximo 50 caracteres' };
  }

  return { value: { username, password, displayName: displayName || username } };
}

function validateLogin(body = {}) {
  const username = normalizeUsername(body.username);
  const password = String(body.password || '');
  if (!username || !password) return { error: 'Usuário e senha são obrigatórios' };
  if (username.length > 30 || password.length > 128) return { error: 'Credenciais inválidas' };
  return { value: { username, password } };
}

module.exports = { normalizeUsername, validateRegistration, validateLogin };
