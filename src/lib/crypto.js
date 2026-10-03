import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

export function randomId(len = 10) {
  // URL-safe, unambiguous alphabet (no 0/O/1/l/I).
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
export const hmacB64 = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64');

// ---- JWT (HS256) ----------------------------------------------------------
export function signJwt(payload, secret, { expiresInSec, notBefore } = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, ...payload };
  if (expiresInSec) body.exp = now + expiresInSec;
  if (notBefore !== undefined) body.nbf = notBefore;
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyJwt(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  if (!safeEqual(expected, s)) return null;
  try {
    const header = JSON.parse(fromB64url(h).toString());
    if (header.alg !== 'HS256') return null;
    const payload = JSON.parse(fromB64url(p).toString());
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now >= payload.exp) return null;
    if (payload.nbf && now < payload.nbf) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- Password hashing (scrypt, built into Node) ---------------------------
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Used to keep login timing identical whether or not the e-mail exists.
export const DUMMY_HASH = hashPassword(randomToken(16));
