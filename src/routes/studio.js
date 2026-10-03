// Live Studio + Admin API. Every route is authorized server-side.
import { config } from '../config.js';
import { Lives, Hosts, Blocks, Reports, Sessions } from '../db.js';
import { shopify } from '../shopify/index.js';
import { streaming } from '../streaming/index.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { readJson, sendJson, sendHtml, HttpError, clientIp } from '../lib/http.js';
import { cleanText, isEmail } from '../lib/sanitize.js';
import { login, logout, currentSession, requireHost, hostWsToken, publicHost, validatePassword } from '../auth.js';
import { studioPage, studioHeaders } from '../views/pages.js';
import * as svc from '../services/lives.js';

const liveFor = (id, host) => {
  const live = Lives.get(id);
  svc.assertCanControl(live, host);
  return live;
};

const liveSummary = (l) => ({ ...svc.publicLive(l), likes: l.likes, peakViewers: l.peak_viewers, createdAt: l.created_at, hostId: l.host_id });

export function registerStudioRoutes(router, { trustProxy }) {
  // ---- page ------------------------------------------------------------------
  const page = (req, res) => sendHtml(res, 200, studioPage(), studioHeaders());
  router.get('/admin', page);
  router.get('/admin/:rest*', page);
  router.get('/', (req, res) => {
    res.writeHead(302, { Location: '/admin' });
    res.end();
  });

  // ---- auth ------------------------------------------------------------------
  router.get('/api/auth/me', (req, res) => {
    const s = currentSession(req);
    if (!s) throw new HttpError(401, 'login_required');
    sendJson(res, 200, { host: s.host, csrf: s.csrf, provider: config.streaming.provider });
  });
  router.post('/api/auth/login', async (req, res) => {
    const body = await readJson(req);
    const r = await login(req, res, { email: String(body.email || '').trim(), password: body.password }, clientIp(req, trustProxy));
    sendJson(res, 200, { ...r, provider: config.streaming.provider });
  });
  router.post('/api/auth/logout', (req, res) => {
    logout(req, res);
    sendJson(res, 200, { ok: true });
  });
  router.post('/api/auth/password', async (req, res) => {
    const host = requireHost(req);
    const { current, next } = await readJson(req);
    const row = Hosts.byId(host.id);
    if (!verifyPassword(String(current || ''), row.password_hash)) throw new HttpError(400, 'wrong_password');
    validatePassword(next);
    Hosts.update(host.id, { passwordHash: hashPassword(next) });
    sendJson(res, 200, { ok: true });
  });

  // ---- lives -----------------------------------------------------------------
  router.get('/api/studio/lives', (req, res) => {
    const host = requireHost(req);
    const lives = Lives.list({ hostId: host.role === 'admin' ? undefined : host.id, limit: 50 });
    sendJson(res, 200, { lives: lives.map(liveSummary) });
  });

  router.post('/api/studio/lives', async (req, res) => {
    const host = requireHost(req);
    const body = await readJson(req);
    const live = svc.createLive(host, body);
    if (Array.isArray(body.productIds)) await svc.setProducts(live, body.productIds);
    sendJson(res, 201, { live: liveSummary(Lives.get(live.id)) });
  });

  router.get('/api/studio/lives/:id', async (req, res, { id }) => {
    const host = requireHost(req);
    const live = liveFor(id, host);
    const products = await svc.liveProducts(live.id, { force: true });
    sendJson(res, 200, {
      live: liveSummary(live),
      products,
      activeProductId: live.active_product_id,
      deal: live.deal && live.deal.endsAt > Date.now() ? { code: live.deal.code, percent: live.deal.percent, endsAt: live.deal.endsAt, scope: live.deal.scope } : null,
      pinnedMessageId: live.pinned_message_id,
    });
  });

  router.patch('/api/studio/lives/:id', async (req, res, { id }) => {
    const host = requireHost(req);
    const live = liveFor(id, host);
    const updated = svc.updateLive(live, await readJson(req));
    sendJson(res, 200, { live: liveSummary(updated) });
  });

  router.put('/api/studio/lives/:id/products', async (req, res, { id }) => {
    const host = requireHost(req);
    const live = liveFor(id, host);
    const { productIds } = await readJson(req);
    sendJson(res, 200, { products: await svc.setProducts(live, productIds) });
  });

  router.post('/api/studio/lives/:id/start', async (req, res, { id }) => {
    const host = requireHost(req);
    const live = await svc.startLive(liveFor(id, host));
    sendJson(res, 200, { live: liveSummary(live), stream: streaming.hostCredentials(live, host) });
  });

  router.get('/api/studio/lives/:id/stream', (req, res, { id }) => {
    const host = requireHost(req);
    const live = liveFor(id, host);
    if (live.status !== 'live') throw new HttpError(409, 'not_live');
    sendJson(res, 200, { stream: streaming.hostCredentials(live, host) });
  });

  router.get('/api/studio/lives/:id/ws-token', (req, res, { id }) => {
    const host = requireHost(req);
    const live = liveFor(id, host);
    sendJson(res, 200, { token: hostWsToken(host, live.id), ws: config.publicUrl.replace(/^http/, 'ws') + '/ws' });
  });

  router.post('/api/studio/lives/:id/end', async (req, res, { id }) => {
    const host = requireHost(req);
    const live = await svc.endLive(liveFor(id, host));
    sendJson(res, 200, { live: liveSummary(live), stats: svc.stats(live.id) });
  });

  router.post('/api/studio/lives/:id/active-product', async (req, res, { id }) => {
    const host = requireHost(req);
    const { productId } = await readJson(req);
    sendJson(res, 200, { activeProductId: await svc.setActiveProduct(liveFor(id, host), productId ?? null) });
  });

  router.post('/api/studio/lives/:id/deal', async (req, res, { id }) => {
    const host = requireHost(req);
    const deal = await svc.startDeal(liveFor(id, host), await readJson(req));
    sendJson(res, 200, { deal: { code: deal.code, percent: deal.percent, endsAt: deal.endsAt, scope: deal.scope } });
  });

  router.delete('/api/studio/lives/:id/deal', async (req, res, { id }) => {
    const host = requireHost(req);
    await svc.endDeal(liveFor(id, host));
    sendJson(res, 200, { deal: null });
  });

  router.post('/api/studio/lives/:id/pin', async (req, res, { id }) => {
    const host = requireHost(req);
    const { messageId } = await readJson(req);
    svc.pinMessage(liveFor(id, host), messageId ?? null);
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/studio/lives/:id/messages/:mid/:action', async (req, res, { id, mid, action }) => {
    const host = requireHost(req);
    const live = liveFor(id, host);
    const body = await readJson(req).catch(() => ({}));
    switch (action) {
      case 'delete': svc.deleteMessage(live, mid, host); break;
      case 'mute': return sendJson(res, 200, { until: svc.muteAuthor(live, mid, body.minutes) });
      case 'block': svc.blockAuthor(live, mid, host, body.reason); break;
      case 'dismiss': svc.dismissReport(live, mid); break;
      default: throw new HttpError(404, 'unknown_action');
    }
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/studio/lives/:id/reports', (req, res, { id }) => {
    const host = requireHost(req);
    const live = liveFor(id, host);
    sendJson(res, 200, { reports: Reports.open(live.id) });
  });

  router.get('/api/studio/lives/:id/stats', (req, res, { id }) => {
    const host = requireHost(req);
    const live = liveFor(id, host);
    sendJson(res, 200, svc.stats(live.id));
  });

  router.get('/api/studio/products', async (req, res, params, url) => {
    requireHost(req);
    const q = cleanText(url.searchParams.get('q') || '', 60);
    sendJson(res, 200, { products: await shopify.searchProducts(q) });
  });

  // ---- admin only -------------------------------------------------------------
  const admin = (req) => requireHost(req, { roles: ['admin'] });

  router.get('/api/admin/hosts', (req, res) => {
    admin(req);
    sendJson(res, 200, { hosts: Hosts.list() });
  });

  router.post('/api/admin/hosts', async (req, res) => {
    admin(req);
    const { email, name, role, password } = await readJson(req);
    if (!isEmail(email)) throw new HttpError(400, 'invalid_email');
    if (!['admin', 'host'].includes(role)) throw new HttpError(400, 'invalid_role');
    validatePassword(password);
    if (Hosts.byEmail(email)) throw new HttpError(409, 'email_taken');
    const id = Hosts.create({ email: email.trim(), name: cleanText(name, 60) || email, passwordHash: hashPassword(password), role });
    sendJson(res, 201, { host: publicHost(Hosts.byId(id)) });
  });

  router.patch('/api/admin/hosts/:hid', async (req, res, { hid }) => {
    const me = admin(req);
    const target = Hosts.byId(Number(hid));
    if (!target) throw new HttpError(404, 'host_not_found');
    const body = await readJson(req);
    if (body.role !== undefined && !['admin', 'host'].includes(body.role)) throw new HttpError(400, 'invalid_role');
    if (target.id === me.id && (body.active === false || body.role === 'host')) throw new HttpError(400, 'cannot_demote_self');
    if (body.password !== undefined) validatePassword(body.password);
    Hosts.update(target.id, {
      name: body.name !== undefined ? cleanText(body.name, 60) : undefined,
      role: body.role,
      active: body.active,
      passwordHash: body.password ? hashPassword(body.password) : undefined,
    });
    if (body.active === false || body.password) Sessions.deleteForHost(target.id);
    sendJson(res, 200, { host: publicHost(Hosts.byId(target.id)) });
  });

  router.get('/api/admin/blocks', (req, res) => {
    admin(req);
    sendJson(res, 200, { blocks: Blocks.list() });
  });

  router.delete('/api/admin/blocks/:sub', (req, res, { sub }) => {
    admin(req);
    Blocks.remove(sub);
    sendJson(res, 200, { ok: true });
  });
}
