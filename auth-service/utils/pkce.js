const crypto = require('crypto');

function base64URLEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function validatePKCE(verifier, challenge, method = 'S256') {
  if (method === 'S256') {
    const hash = crypto.createHash('sha256').update(verifier).digest();
    const encoded = base64URLEncode(hash);
    return encoded === challenge;
  } else if (method === 'plain') {
    return verifier === challenge;
  }
  return false;
}

function generateAuthCode() {
  const bytes = crypto.randomBytes(32);
  return base64URLEncode(bytes);
}

module.exports = {
  validatePKCE,
  generateAuthCode
};
