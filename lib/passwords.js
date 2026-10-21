// Password hashing (bcrypt). Stored passwords are bcrypt hashes; a value that is
// not a hash is a legacy plain-text password that has not been migrated yet.
'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROUNDS = 10;

const isHash = v => typeof v === 'string' && /^\$2[aby]\$\d{2}\$.{53}$/.test(v);

const hashPassword = plain => bcrypt.hash(String(plain), ROUNDS);

// Constant-time compare for legacy plain-text values (compares fixed-length digests).
function legacyEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

async function verifyPassword(plain, stored) {
  if (!stored || typeof plain !== 'string') return false;
  return isHash(stored) ? bcrypt.compare(plain, stored) : legacyEqual(plain, stored);
}

// Hash every plain-text password in place. Idempotent: hashes are skipped, and each
// update only applies if the stored value is still the same plain text (safe if
// several server instances run this at once). passwordVersion is not changed, so
// nobody is logged out.
async function migratePlainPasswords(User) {
  const users = await User.find({}, { _id: 1, username: 1, password: 1 }).lean();
  let migrated = 0;
  for (const u of users) {
    if (!u.password || isHash(u.password)) continue;
    const r = await User.updateOne({ _id: u._id, password: u.password },
                                   { $set: { password: await hashPassword(u.password) } });
    migrated += r.modifiedCount || 0;
  }
  return migrated;
}

module.exports = { isHash, hashPassword, verifyPassword, migratePlainPasswords };
