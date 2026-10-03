// Live business logic: sessions, products, chat, likes, deals, moderation,
// preview enforcement and analytics. Transport-agnostic (talks to the hub
// through a small interface).
import { config } from '../config.js';
import { Lives, Messages, Reports, Blocks, Mutes, Events, ViewerSessions, Orders, Hosts } from '../db.js';
import { shopify } from '../shopify/index.js';
import { streaming } from '../streaming/index.js';
import { randomId } from '../lib/crypto.js';
import { cleanText, containsBlocked, isNumericId, isDiscountCode } from '../lib/sanitize.js';
import { RateLimiter, WindowCounter } from '../lib/ratelimit.js';
import { HttpError } from '../lib/http.js';

let hub = null;
export const attachHub = (h) => (hub = h);

const chatLimiter = new RateLimiter({ capacity: 3, refillPerSec: 0.5 }); // 1 msg / 2 s, burst 3
const likeLimiter = new RateLimiter({ capacity: 40, refillPerSec: 12 });
const eventLimiter = new RateLimiter({ capacity: 20, refillPerSec: 4 });
const previewCounter = new WindowCounter(60 * 60_000);

const productCache = new Map(); // liveId -> { list, at }
const likeBuffer = new Map(); // liveId -> n not yet in DB
const likeTotals = new Map(); // liveId -> total (DB + buffer)
const dealTimers = new Map();
const guestPreviews = new Map(); // `${liveId}:${sub}` -> untilMs
const lastChat = new Map(); // sub -> { text, at }

// ---------------------------------------------------------------------------
// Shapes sent to clients
// ---------------------------------------------------------------------------
const publicMsg = (m, forHost) => {
  if (!m) return null;
  const o = { id: Number(m.id), name: m.name, role: m.role, text: m.text, at: m.created_at ?? m.createdAt };
  if (forHost) o.sub = m.sub;
  return o;
};

const publicDeal = (d) => (d && d.endsAt > Date.now() ? { code: d.code, percent: d.percent, endsAt: d.endsAt, scope: d.scope } : null);

export function shareUrl(live) {
  return live.redirect_gid ? `${config.storeUrl}/live/${live.id}` : `${config.storeUrl}${config.proxyPrefix}/${live.id}?ref=share`;
}

export function publicLive(live) {
  const host = Hosts.byId(live.host_id);
  return {
    id: live.id,
    title: live.title,
    description: live.description,
    status: live.status,
    startedAt: live.started_at,
    endedAt: live.ended_at,
    hostName: host?.name || 'Finafransar',
    shareUrl: shareUrl(live),
  };
}

// ---------------------------------------------------------------------------
// Products (Shopify is the source of truth, we only cache for 60 s)
// ---------------------------------------------------------------------------
export async function liveProducts(liveId, { force = false } = {}) {
  const c = productCache.get(liveId);
  if (!force && c && Date.now() - c.at < 60_000) return c.list;
  const ids = Lives.products(liveId);
  let list = [];
  try {
    const fetched = await shopify.getProducts(ids);
    const byId = new Map(fetched.map((p) => [p.id, p]));
    list = ids.map((id) => byId.get(id)).filter((p) => p && p.active);
  } catch (e) {
    console.error('Shopify getProducts failed', e.message);
    if (c) return c.list; // serve stale rather than nothing
  }
  productCache.set(liveId, { list, at: Date.now() });
  return list;
}

const productsSignature = (list) => JSON.stringify(list.map((p) => [p.id, p.price, p.variants.map((v) => [v.id, v.available, v.price])]));

// Background refresh of stock/prices while a live is running.
setInterval(async () => {
  for (const live of Lives.listLive()) {
    const before = productCache.get(live.id)?.list || [];
    const after = await liveProducts(live.id, { force: true });
    if (productsSignature(before) !== productsSignature(after)) hub?.broadcast(live.id, { t: 'products', products: after });
  }
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Snapshot for a (re)connecting client
// ---------------------------------------------------------------------------
export function snapshot(liveId, conn) {
  const live = Lives.get(liveId);
  const forHost = conn.role !== 'viewer';
  const pinned = live.pinned_message_id ? Messages.get(live.pinned_message_id) : null;
  return {
    live: publicLive(live),
    viewers: hub.viewerCount(liveId),
    likes: likeTotals.get(liveId) ?? live.likes,
    products: productCache.get(liveId)?.list || [],
    activeProductId: live.active_product_id,
    deal: publicDeal(live.deal),
    pinned: pinned && !pinned.deleted_at ? publicMsg(pinned, forHost) : null,
    messages: Messages.recent(liveId).map((m) => publicMsg(m, forHost)),
    me: {
      name: conn.name,
      role: conn.role,
      guest: conn.guest,
      mutedUntil: conn.role === 'viewer' ? Mutes.until(liveId, conn.sub) : 0,
    },
    reports: forHost ? Reports.open(liveId).length : undefined,
  };
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------
export async function onJoin(conn) {
  const live = Lives.get(conn.liveId);
  if (!live) return false;
  if (conn.role === 'viewer') {
    if (live.status !== 'live') return false;
    if (!conn.guest && Blocks.is(conn.sub)) {
      hub.send(conn, { t: 'blocked' });
      return false;
    }
    conn.sessionId = ViewerSessions.open(live.id, conn.sub, conn.guest, conn.ref);
  } else {
    // host/admin websocket: must own the live (admins may join any)
    if (conn.role !== 'admin' && live.host_id !== conn.hostId) return false;
  }
  await liveProducts(live.id);
  return true;
}

export function onLeave(conn) {
  if (conn.sessionId) ViewerSessions.close(conn.sessionId);
}

export function onViewerCount(liveId, n) {
  Lives.bumpPeak(liveId, n);
}

export function canWatch(conn) {
  if (!conn.guest) return true;
  const until = guestPreviews.get(`${conn.liveId}:${conn.sub}`);
  return !!until && Date.now() < until;
}

export async function onMessage(conn, msg) {
  switch (msg.t) {
    case 'chat':
      return handleChat(conn, msg);
    case 'like':
      return handleLike(conn, msg);
    case 'event':
      return handleEvent(conn, msg);
    case 'report':
      return handleReport(conn, msg);
    default:
      return;
  }
}

function handleChat(conn, msg) {
  const live = Lives.get(conn.liveId);
  if (!live || live.status !== 'live') return;
  if (conn.guest) return hub.send(conn, { t: 'error', code: 'login_required' });
  if (conn.role === 'viewer') {
    if (Blocks.is(conn.sub)) return hub.send(conn, { t: 'error', code: 'blocked' });
    const mutedUntil = Mutes.until(conn.liveId, conn.sub);
    if (mutedUntil > Date.now()) return hub.send(conn, { t: 'error', code: 'muted', until: mutedUntil });
    if (!chatLimiter.take(conn.sub)) return hub.send(conn, { t: 'error', code: 'chat_slow' });
  }
  const text = cleanText(msg.text, config.live.chatMaxLength);
  if (!text) return;
  if (conn.role === 'viewer' && containsBlocked(text)) return hub.send(conn, { t: 'error', code: 'chat_rejected' });
  const prev = lastChat.get(conn.sub);
  if (prev && prev.text === text && Date.now() - prev.at < 15_000) return;
  lastChat.set(conn.sub, { text, at: Date.now() });
  if (lastChat.size > 20_000) lastChat.clear();

  const role = conn.role === 'viewer' ? 'viewer' : 'host';
  const m = Messages.add({ liveId: conn.liveId, sub: conn.sub, name: conn.name, role, text });
  hub.broadcast(conn.liveId, { t: 'chat', m: publicMsg(m, false) }, { filter: (c) => c.role === 'viewer' });
  hub.broadcast(conn.liveId, { t: 'chat', m: publicMsg(m, true) }, { filter: (c) => c.role !== 'viewer' });
  if (role === 'viewer') Events.add(conn.liveId, 'comment', conn.sub);
}

function handleLike(conn, msg) {
  if (conn.guest || conn.role !== 'viewer') return;
  const n = Math.max(1, Math.min(20, Number(msg.n) | 0));
  if (!likeLimiter.take(conn.sub, n)) return;
  const live = Lives.get(conn.liveId);
  if (!live || live.status !== 'live') return;
  likeBuffer.set(conn.liveId, (likeBuffer.get(conn.liveId) || 0) + n);
  const total = (likeTotals.get(conn.liveId) ?? live.likes) + n;
  likeTotals.set(conn.liveId, total);
  hub.addLikes(conn.liveId, n, total);
}

function flushLikes() {
  for (const [liveId, n] of likeBuffer) {
    if (n > 0) Lives.addLikes(liveId, n);
  }
  likeBuffer.clear();
}
setInterval(flushLikes, 5000).unref();

const EVENT_TYPES = new Set(['product_view', 'add_to_cart', 'checkout', 'share', 'cart_open', 'sound_on', 'shop_open']);

function handleEvent(conn, msg) {
  if (!EVENT_TYPES.has(msg.name)) return;
  if (!eventLimiter.take(conn.id)) return;
  const d = msg.data && typeof msg.data === 'object' ? msg.data : {};
  const data = {};
  if (isNumericId(d.productId)) data.productId = String(d.productId);
  if (isNumericId(d.variantId)) data.variantId = String(d.variantId);
  if (Number.isInteger(d.quantity) && d.quantity > 0 && d.quantity < 100) data.quantity = d.quantity;
  if (typeof d.channel === 'string') data.channel = d.channel.slice(0, 20);
  if (typeof d.value === 'number' && d.value >= 0 && d.value < 1e6) data.value = Math.round(d.value * 100) / 100;
  Events.add(conn.liveId, msg.name, conn.sub, Object.keys(data).length ? data : null);
}

function handleReport(conn, msg) {
  if (conn.guest) return;
  const m = Messages.get(Number(msg.messageId));
  if (!m || m.live_id !== conn.liveId || m.sub === conn.sub) return;
  if (Reports.add(m.id, conn.liveId, conn.sub)) {
    hub.send(conn, { t: 'reported', messageId: m.id });
    hub.toHosts(conn.liveId, { t: 'reports', count: Reports.open(conn.liveId).length });
  }
}

// ---------------------------------------------------------------------------
// Stream credentials + 10 second preview enforcement
// ---------------------------------------------------------------------------
export async function viewerStreamCredentials(liveId, viewer, ip) {
  const live = Lives.get(liveId);
  if (!live || live.status !== 'live') throw new HttpError(404, 'not_live');
  const identity = `${viewer.sub}.${randomId(5)}`;
  if (viewer.guest) {
    const key = `${liveId}:${viewer.sub}`;
    const existing = guestPreviews.get(key);
    if (existing && Date.now() >= existing) throw new HttpError(403, 'preview_over');
    if (!existing) {
      const count = previewCounter.hit(`${liveId}:${ip}`);
      if (count > config.live.previewsPerIpPerHour) throw new HttpError(403, 'preview_over');
      // +3 s grace for connection setup; the client shows the gate at exactly 10 s of video.
      const until = Date.now() + (config.live.previewSeconds + 3) * 1000;
      guestPreviews.set(key, until);
      Events.add(liveId, 'preview_start', viewer.sub);
      setTimeout(() => endGuestPreview(live, viewer.sub, identity), until - Date.now()).unref();
    }
  }
  return { ...streaming.viewerCredentials(live, { identity, name: viewer.name }, { guest: viewer.guest }), identity, previewSeconds: viewer.guest ? config.live.previewSeconds : null };
}

async function endGuestPreview(live, sub, identity) {
  const conns = hub.connsForSub(live.id, sub);
  if (conns.length) Events.add(live.id, 'preview_complete', sub);
  for (const c of conns) hub.send(c, { t: 'preview_over' });
  try {
    await streaming.removeViewer(live, identity);
  } catch (e) {
    console.error('removeViewer', e.message);
  }
  setTimeout(() => guestPreviews.delete(`${live.id}:${sub}`), 6 * 3600_000).unref();
}

// ---------------------------------------------------------------------------
// Host / admin actions (authorization is checked by the route layer)
// ---------------------------------------------------------------------------
export function assertCanControl(live, host) {
  if (!live) throw new HttpError(404, 'live_not_found');
  if (host.role !== 'admin' && live.host_id !== host.id) throw new HttpError(403, 'forbidden');
}

export function createLive(host, { title, description }) {
  const t = cleanText(title, 80) || 'Finafransar LIVE';
  const d = cleanText(description, 500);
  let id;
  do id = randomId(8); while (Lives.get(id));
  Lives.create({ id, title: t, description: d, hostId: host.id });
  return Lives.get(id);
}

export function updateLive(live, { title, description }) {
  const fields = {};
  if (title !== undefined) fields.title = cleanText(title, 80) || live.title;
  if (description !== undefined) fields.description = cleanText(description, 500);
  Lives.update(live.id, fields);
  const updated = Lives.get(live.id);
  hub.broadcast(live.id, { t: 'live', live: publicLive(updated) });
  return updated;
}

export async function setProducts(live, productIds) {
  if (!Array.isArray(productIds) || productIds.length > 50 || !productIds.every(isNumericId)) throw new HttpError(400, 'invalid_products');
  const ids = [...new Set(productIds.map(String))];
  const found = await shopify.getProducts(ids);
  const ok = new Set(found.filter((p) => p.active).map((p) => p.id));
  const valid = ids.filter((id) => ok.has(id));
  Lives.setProducts(live.id, valid);
  if (live.active_product_id && !ok.has(live.active_product_id)) {
    Lives.update(live.id, { active_product_id: null });
    hub.broadcast(live.id, { t: 'product', productId: null });
  }
  const list = await liveProducts(live.id, { force: true });
  hub.broadcast(live.id, { t: 'products', products: list });
  return list;
}

export async function setActiveProduct(live, productId) {
  if (productId !== null) {
    if (!isNumericId(productId)) throw new HttpError(400, 'invalid_product');
    const list = await liveProducts(live.id);
    if (!list.some((p) => p.id === String(productId))) throw new HttpError(400, 'product_not_in_live');
  }
  const pid = productId === null ? null : String(productId);
  Lives.update(live.id, { active_product_id: pid });
  hub.broadcast(live.id, { t: 'product', productId: pid });
  if (pid) Events.add(live.id, 'product_pinned', null, { productId: pid });
  return pid;
}

export async function startLive(live) {
  if (live.status === 'live') return live;
  if (live.status !== 'draft') throw new HttpError(409, 'live_already_ended');
  const room = await streaming.createRoom(live);
  Lives.update(live.id, { status: 'live', started_at: Date.now(), stream_room: room });
  Events.add(live.id, 'live_start');
  // Pretty share link on the storefront domain. Non-fatal if it fails.
  try {
    const gid = await shopify.createRedirect(`/live/${live.id}`, `${config.proxyPrefix}/${live.id}?ref=share`);
    Lives.update(live.id, { redirect_gid: gid });
  } catch (e) {
    console.error('createRedirect failed (share link falls back to /apps/live/…):', e.message);
  }
  return Lives.get(live.id);
}

export async function endLive(live) {
  if (live.status !== 'live') return live;
  flushLikes();
  if (live.deal) await endDeal(live).catch(() => {});
  Lives.update(live.id, { status: 'ended', ended_at: Date.now() });
  Events.add(live.id, 'live_end');
  hub.broadcast(live.id, { t: 'live_status', status: 'ended' });
  ViewerSessions.closeAllForLive(live.id);
  streaming.endRoom(live).catch((e) => console.error('endRoom', e.message));
  return Lives.get(live.id);
}

export async function startDeal(live, { percent, minutes, code, scope }) {
  if (live.status !== 'live') throw new HttpError(409, 'not_live');
  percent = Number(percent);
  minutes = Number(minutes);
  if (!Number.isInteger(percent) || percent < 1 || percent > 90) throw new HttpError(400, 'invalid_percent');
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) throw new HttpError(400, 'invalid_minutes');
  scope = scope === 'all' ? 'all' : 'live_products';
  let wanted = String(code || `LIVE${percent}`).toUpperCase().replace(/\s+/g, '');
  if (!isDiscountCode(wanted)) throw new HttpError(400, 'invalid_code');
  if (live.deal) await endDeal(live);

  const endsAt = Date.now() + Math.round(minutes * 60_000);
  const productIds = scope === 'live_products' ? Lives.products(live.id) : null;
  if (scope === 'live_products' && !productIds.length) throw new HttpError(400, 'no_live_products');

  let created;
  let finalCode = wanted;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      created = await shopify.createDiscount({ code: finalCode, title: `Finafransar LIVE ${live.id} – ${percent}%`, percent, endsAt, productIds });
      break;
    } catch (e) {
      if (!e.taken) throw new HttpError(502, 'shopify_discount_failed', e.message);
      finalCode = `${wanted}${randomId(3).toUpperCase()}`.slice(0, 24);
    }
  }
  if (!created) throw new HttpError(409, 'code_taken');

  const deal = { code: finalCode, percent, endsAt, scope, discountId: created.discountId };
  Lives.update(live.id, { deal_json: JSON.stringify(deal) });
  scheduleDealEnd(live.id, deal);
  Events.add(live.id, 'deal_start', null, { percent });
  hub.broadcast(live.id, { t: 'deal', deal: publicDeal(deal) });
  return deal;
}

function scheduleDealEnd(liveId, deal) {
  clearTimeout(dealTimers.get(liveId));
  const ms = Math.max(0, deal.endsAt - Date.now());
  dealTimers.set(
    liveId,
    setTimeout(() => {
      const live = Lives.get(liveId);
      if (live?.deal?.code === deal.code) {
        // Shopify expires the code itself via endsAt; we only clear the UI.
        Lives.update(liveId, { deal_json: null });
        hub?.broadcast(liveId, { t: 'deal', deal: null });
      }
    }, Math.min(ms, 2 ** 31 - 1))
  );
}

export async function endDeal(live) {
  const d = live.deal;
  if (!d) return;
  clearTimeout(dealTimers.get(live.id));
  try {
    await shopify.deactivateDiscount(d.discountId);
  } catch (e) {
    console.error('deactivateDiscount', e.message);
  }
  Lives.update(live.id, { deal_json: null });
  hub.broadcast(live.id, { t: 'deal', deal: null });
}

export function pinMessage(live, messageId) {
  if (messageId === null) {
    Lives.update(live.id, { pinned_message_id: null });
    hub.broadcast(live.id, { t: 'pinned', m: null });
    return null;
  }
  const m = Messages.get(Number(messageId));
  if (!m || m.live_id !== live.id || m.deleted_at) throw new HttpError(404, 'message_not_found');
  Lives.update(live.id, { pinned_message_id: m.id });
  hub.broadcast(live.id, { t: 'pinned', m: publicMsg(m, false) }, { filter: (c) => c.role === 'viewer' });
  hub.broadcast(live.id, { t: 'pinned', m: publicMsg(m, true) }, { filter: (c) => c.role !== 'viewer' });
  return m;
}

function messageOf(live, messageId) {
  const m = Messages.get(Number(messageId));
  if (!m || m.live_id !== live.id) throw new HttpError(404, 'message_not_found');
  return m;
}

export function deleteMessage(live, messageId, host) {
  const m = messageOf(live, messageId);
  Messages.softDelete(m.id, host.id);
  Reports.resolve(m.id);
  hub.broadcast(live.id, { t: 'chat_del', ids: [m.id] });
  if (live.pinned_message_id === m.id) pinMessage(live, null);
  hub.toHosts(live.id, { t: 'reports', count: Reports.open(live.id).length });
}

export function muteAuthor(live, messageId, minutes) {
  const m = messageOf(live, messageId);
  if (m.role !== 'viewer') throw new HttpError(400, 'cannot_moderate_host');
  const mins = Math.max(1, Math.min(24 * 60, Number(minutes) || 10));
  const until = Date.now() + mins * 60_000;
  Mutes.set(live.id, m.sub, until);
  for (const c of hub.connsForSub(live.id, m.sub)) hub.send(c, { t: 'muted', until });
  return until;
}

export function blockAuthor(live, messageId, host, reason) {
  const m = messageOf(live, messageId);
  if (m.role !== 'viewer') throw new HttpError(400, 'cannot_moderate_host');
  Blocks.add(m.sub, m.name, cleanText(reason || '', 200), host.id);
  const ids = Messages.idsBySub(live.id, m.sub);
  Messages.deleteAllBySub(live.id, m.sub, host.id);
  ids.forEach((id) => Reports.resolve(id));
  hub.broadcast(live.id, { t: 'chat_del', ids });
  for (const c of hub.connsForSub(live.id, m.sub)) {
    hub.send(c, { t: 'blocked' });
    c.ws.close(4003, 'blocked');
  }
  hub.toHosts(live.id, { t: 'reports', count: Reports.open(live.id).length });
}

export function dismissReport(live, messageId) {
  const m = messageOf(live, messageId);
  Reports.resolve(m.id);
  hub.toHosts(live.id, { t: 'reports', count: Reports.open(live.id).length });
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
export function stats(liveId) {
  flushLikes();
  const live = Lives.get(liveId);
  const ev = Events.counts(liveId);
  const uniq = Events.uniqueCounts(liveId);
  const vs = ViewerSessions.stats(liveId);
  const ord = Orders.stats(liveId);
  return {
    live: publicLive(live),
    viewersNow: live.status === 'live' ? hub.viewerCount(liveId) : 0,
    peakViewers: live.peak_viewers,
    totalViewers: vs.total_viewers,
    avgWatchSeconds: vs.total_viewers ? Math.round(vs.total_ms / 1000 / vs.total_viewers) : 0,
    durationSeconds: live.started_at ? Math.round(((live.ended_at || Date.now()) - live.started_at) / 1000) : 0,
    likes: live.likes,
    comments: ev.comment || 0,
    shares: ev.share || 0,
    productViews: ev.product_view || 0,
    addToCart: ev.add_to_cart || 0,
    checkouts: ev.checkout || 0,
    purchases: ord.purchases,
    revenue: ord.revenue,
    registrations: uniq.registration || 0,
    logins: uniq.login || 0,
    visitorsFromShare: vs.from_shared,
    previewStarts: uniq.preview_start || 0,
    previewCompletions: uniq.preview_complete || 0,
    products: {
      views: Events.productViews(liveId),
      addToCart: Events.addToCartByProduct(liveId),
    },
  };
}

// Called once at boot: resume deal timers for lives that were running.
export function resumeAfterRestart() {
  for (const live of Lives.listLive()) {
    if (live.deal) {
      if (live.deal.endsAt > Date.now()) scheduleDealEnd(live.id, live.deal);
      else Lives.update(live.id, { deal_json: null });
    }
  }
}

export function recordOrder({ orderId, liveId, total, currency, customerId }) {
  if (!Lives.get(liveId)) return false;
  Orders.upsert({ orderId: String(orderId), liveId, total: Number(total) || 0, currency, customerId: customerId ? String(customerId) : null });
  return true;
}
