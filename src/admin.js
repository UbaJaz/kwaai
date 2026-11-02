// The admin account's password. Only a hash is ever stored, in the ADMIN_PASSWORD_HASH environment variable, made
// with `npm run admin-hash`. The format is "scrypt$<salt hex>$<hash hex>"; scrypt is slow on purpose, so guessing is
// expensive even if the hash leaks.
const crypto = require('node:crypto');

const KEY_LENGTH = 64;

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// true only for the right password; a malformed stored value never matches
function checkPassword(password, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !/^[0-9a-f]{32}$/.test(saltHex || '') || !/^[0-9a-f]{128}$/.test(hashHex || '')) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  return crypto.timingSafeEqual(got, want);
}

const isValidHash = (stored) => /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(String(stored || ''));

module.exports = { hashPassword, checkPassword, isValidHash };
