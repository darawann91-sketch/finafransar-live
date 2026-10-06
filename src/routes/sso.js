// "Go live" from the Finafransar community (web app/app) without a second login.
// The browser sends a one-time code from Finafransar PRIVILEGE; we redeem it
// server-to-server (single use, 60 s) and open a Studio session for that member.
// Members become hosts automatically (role "host": their own lives only).
import { config } from '../config.js';
import { Hosts } from '../db.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { readJson, sendJson, HttpError, clientIp } from '../lib/http.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { cleanText, isEmail } from '../lib/sanitize.js';
import { createBearerSession, publicHost } from '../auth.js';

const limiter = new RateLimiter({ capacity: 10, refillPerSec: 10 / 600 });

async function redeem(code) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${config.privilegeUrl}/api/live/redeem`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), signal: ctl.signal,
    });
    if (r.status === 401) throw new HttpError(401, 'invalid_code', 'Försök igen.');
    if (!r.ok) throw new HttpError(502, 'community_unavailable', 'Communityt svarar inte just nu.');
    return (await r.json()).member;
  } finally { clearTimeout(t); }
}

export function registerSsoRoutes(router, { trustProxy }) {
  router.post('/api/sso/creator', async (req, res) => {
    const ip = clientIp(req, trustProxy);
    if (!limiter.take(ip)) throw new HttpError(429, 'too_many_attempts');
    const { code } = await readJson(req);
    if (typeof code !== 'string' || code.length < 20 || code.length > 100) throw new HttpError(400, 'invalid_code');
    const m = await redeem(code);
    const email = String(m?.email || '').trim().toLowerCase();
    if (!isEmail(email)) throw new HttpError(400, 'invalid_member');
    let host = Hosts.byEmail(email);
    if (host && !host.active) throw new HttpError(403, 'host_disabled', 'Ditt Live-konto är avstängt.');
    if (!host) {
      const id = Hosts.create({ email, name: cleanText(m.name || m.username, 60) || email, passwordHash: hashPassword(randomToken(24)), role: 'host' });
      host = Hosts.byId(id);
    }
    const s = createBearerSession(req, host, ip);
    sendJson(res, 200, { sid: s.sid, host: publicHost(host), provider: config.streaming.provider, ws: config.publicUrl.replace(/^http/, 'ws') + '/ws' });
  });
}
