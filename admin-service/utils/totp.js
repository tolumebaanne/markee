/**
 * TOTP — RFC 6238 / RFC 4226 implementation using Node's built-in crypto.
 * No external dependencies.
 */
const crypto = require('crypto');

// ── Base32 ────────────────────────────────────────────────────────────────────
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_CHARS[(val >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_CHARS[(val << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  str = str.toUpperCase().replace(/=+$/, '');
  let bits = 0, val = 0, idx = 0;
  const out = Buffer.alloc(Math.floor((str.length * 5) / 8));
  for (const ch of str) {
    const n = BASE32_CHARS.indexOf(ch);
    if (n === -1) throw new Error('Invalid base32 character: ' + ch);
    val = (val << 5) | n;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[idx++] = (val >> bits) & 0xff;
    }
  }
  return out.slice(0, idx);
}

// ── HOTP — RFC 4226 ───────────────────────────────────────────────────────────
function hotp(secret, counter) {
  const key    = base32Decode(secret);
  const msg    = Buffer.alloc(8);
  // Write 64-bit counter big-endian
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const hmac  = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code   = ((hmac[offset] & 0x7f) << 24) |
                 ((hmac[offset + 1] & 0xff) << 16) |
                 ((hmac[offset + 2] & 0xff) << 8) |
                 (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

// ── TOTP — RFC 6238 ───────────────────────────────────────────────────────────
const STEP = 30; // 30-second window

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function totpCode(secret, offsetSteps = 0) {
  const counter = Math.floor(Date.now() / 1000 / STEP) + offsetSteps;
  return hotp(secret, counter);
}

/**
 * Verify a TOTP code.
 * Accepts codes from one step before and one step after (±30s clock drift).
 */
function verifyTotp(secret, token) {
  if (!token || token.length !== 6) return false;
  for (const offset of [-1, 0, 1]) {
    if (totpCode(secret, offset) === token) return true;
  }
  return false;
}

/**
 * Build the otpauth:// URI for QR code generation.
 */
function otpauthUri(secret, email, issuer = 'Markee Admin') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Generate 8 single-use recovery codes (hex, formatted as XXXX-XXXX).
 */
function generateRecoveryCodes() {
  return Array.from({ length: 8 }, () => {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

module.exports = { generateSecret, verifyTotp, otpauthUri, generateRecoveryCodes };
