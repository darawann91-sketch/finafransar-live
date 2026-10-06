// Host/Admin authentication (separate from Shopify customers and from
// Shopify admin). Sessions: random 256-bit id in an HttpOnly+Secure+
// SameSite=Strict cookie, only the SHA-256 of it is stored. Every mutating
// request also needs the per-session CSRF token in X-CSRF-Token.
import { config } from './config.js';
import { Hosts, Sessions } from './db.js';
import { randomToken, sha256, verifyPassword, hashPassword, DUMMY_HASH, safeEqual, signJwt } from './lib/crypto.js';
import { parseCookies, setCookie, HttpError } from './lib/http.js';
import { RateLimiter } from './lib/ratelimit.js';
import { isEmail } from './lib/sanitize.js';

const COOKIE = config.isProd ? '__Host-ffl_sid' : 'ffl_sid';
const SESSION_TTL_MS = 12 * 3600_000;
const ipLimiter = new RateLimiter({ capacity: 10, refillPerSec: 10 / 900 }); // 10 / 15 min
const emailLimiter = new RateLimiter({ capacity: 5, refillPerSec: 5 / 900 });

export async function login(req, res, { email, password }, ip) {
  if (!ipLimiter.take(ip)) throw new HttpError(429, 'too_many_attempts');
  if (!isEmail(email) || typeof password !== 'string' || password.length > 200) throw new HttpError(400, 'invalid_credentials');
  if (!emailLimiter.take(email.toLowerCase())) throw new HttpError(429, 'too_many_attempts');
  const host = Hosts.byEmail(email);
  const ok = verifyPassword(password, host?.password_hash || DUMMY_HASH);
  if (!host || !ok || !host.active) throw new HttpError(401, 'invalid_credentials');

  const sid = randomToken(32);
  const csrf = randomToken(24);
  Sessions.create({ idHash: sha256(sid), hostId: host.id, csrf, expiresAt: Date.now() + SESSION_TTL_MS, ip, ua: String(req.headers['user-agent'] || '').slice(0, 200) });
  Hosts.touchLogin(host.id);
  setCookie(res, COOKIE, sid, { secure: config.isProd, sameSite: 'Strict', maxAge: SESSION_TTL_MS / 1000 });
  return { csrf, host: publicHost(host) };
}

export function logout(req, res) {
  const sid = parseCookies(req)[COOKIE];
  if (sid) Sessions.delete(sha256(sid));
  setCookie(res, COOKIE, '', { secure: config.isProd, maxAge: 0 });
}

// Studio sessions come from the cookie (Live Studio) or, for the community web
// app/app ("go live" without a second login), from "Authorization: Bearer <sid>".
// A bearer token is never sent automatically by the browser, so CSRF/origin
// checks only apply to the cookie.
function sessionId(req) {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization || ''));
  if (m) return { sid: m[1], via: 'bearer' };
  const sid = parseCookies(req)[COOKIE];
  return sid ? { sid, via: 'cookie' } : null;
}

export function currentSession(req) {
  const k = sessionId(req);
  if (!k) return null;
  const s = Sessions.get(sha256(k.sid));
  if (!s || !s.active) return null;
  return { csrf: s.csrf, via: k.via, host: { id: s.host_id, email: s.email, name: s.name, role: s.role } };
}

// Session for a creator signed in through the community (see routes/sso.js).
export function createBearerSession(req, host, ip) {
  const sid = randomToken(32);
  const csrf = randomToken(24);
  Sessions.create({ idHash: sha256(sid), hostId: host.id, csrf, expiresAt: Date.now() + SESSION_TTL_MS, ip, ua: String(req.headers['user-agent'] || '').slice(0, 200) });
  Hosts.touchLogin(host.id);
  return { sid, csrf };
}

// Guard for studio/admin API routes.
export function requireHost(req, { roles = ['admin', 'host'], mutating = req.method !== 'GET' } = {}) {
  const s = currentSession(req);
  if (!s) throw new HttpError(401, 'login_required');
  if (!roles.includes(s.host.role)) throw new HttpError(403, 'forbidden');
  if (s.via === 'bearer') {
    // From the community app: going live, chat and products. Live deals (real
    // discount codes) stay in Live Studio, and only for admins there.
    if (s.host.role !== 'admin' && /\/deal(?:$|[/?])/.test(String(req.url || ''))) throw new HttpError(403, 'use_studio', 'Live-deals startas i Live Studio.');
    return s.host;
  }
  if (mutating) {
    const token = req.headers['x-csrf-token'];
    if (!token || !safeEqual(token, s.csrf)) throw new HttpError(403, 'csrf');
    const origin = req.headers.origin;
    if (config.isProd && origin && origin !== config.publicUrl) throw new HttpError(403, 'bad_origin');
  }
  return s.host;
}

// Short-lived token the studio uses to open its websocket.
export function hostWsToken(host, liveId) {
  return signJwt({ typ: 'host', sub: `host-${host.id}`, hostId: host.id, role: host.role, name: host.name, live: liveId }, config.appSecret, { expiresInSec: 120 });
}

export const publicHost = (h) => ({ id: h.id, email: h.email, name: h.name, role: h.role });

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 12 || pw.length > 200) throw new HttpError(400, 'weak_password', 'Lösenordet måste vara minst 12 tecken');
}

export function bootstrapAdmin() {
  const { email, password, name } = config.bootstrapAdmin;
  if (Hosts.count() > 0 || !email || !password) return;
  validatePassword(password);
  Hosts.create({ email, name, passwordHash: hashPassword(password), role: 'admin' });
  console.log(`Skapade första admin-kontot: ${email}`);
}
