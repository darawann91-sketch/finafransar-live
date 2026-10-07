// Realtime transport: one websocket per viewer/host, grouped per live.
// Business rules live in services/lives.js – the hub only authenticates,
// routes, broadcasts, counts viewers and batches likes.
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { verifyJwt, randomId } from '../lib/crypto.js';
import { clientIp } from '../lib/http.js';
import { RateLimiter } from '../lib/ratelimit.js';

const MAX_MSG_BYTES = 8 * 1024;
const LOW_PRIORITY_BUFFER = 512 * 1024;

export class Hub {
  constructor({ server, handlers, trustProxy }) {
    this.handlers = handlers; // { onJoin, onLeave, onMessage, snapshot }
    this.rooms = new Map(); // liveId -> { conns:Set, subs:Map<sub,count>, likesPending, lastViewers }
    this.trustProxy = trustProxy;
    this.connLimiter = new RateLimiter({ capacity: 20, refillPerSec: 0.5 }); // per IP
    this.msgLimiter = new RateLimiter({ capacity: 40, refillPerSec: 10 }); // per conn, all msg types

    this.allowedOrigins = new Set([config.storeUrl, config.publicUrl, `https://${config.shopify.shop}`, ...config.extraOrigins]);
    // www / apex variants of the store domain
    try {
      const u = new URL(config.storeUrl);
      const alt = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
      this.allowedOrigins.add(`${u.protocol}//${alt}`);
    } catch {}

    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES, perMessageDeflate: false });
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));

    this.tick = setInterval(() => this.flush(), 400);
    this.heartbeat = setInterval(() => this.ping(), 25_000);
  }

  onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    const origin = req.headers.origin;
    if (config.isProd && (!origin || !this.allowedOrigins.has(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    const ip = clientIp(req, this.trustProxy);
    if (!this.connLimiter.take(ip)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      return socket.destroy();
    }
    const claims = verifyJwt(url.searchParams.get('token'), config.appSecret);
    const liveId = url.searchParams.get('live');
    if (!claims || !liveId || (claims.live && claims.live !== liveId) || !['viewer', 'host'].includes(claims.typ)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, claims, liveId, ip));
  }

  async onConnection(ws, claims, liveId, ip) {
    const conn = {
      id: randomId(12),
      ws,
      ip,
      liveId,
      sub: claims.sub,
      name: claims.name,
      role: claims.typ === 'host' ? claims.role : 'viewer', // 'admin' | 'host' | 'viewer'
      hostId: claims.hostId || null,
      guest: !!claims.guest,
      ref: claims.ref || null,
      alive: true,
    };
    ws.on('pong', () => (conn.alive = true));

    const ok = await this.handlers.onJoin(conn).catch((e) => {
      console.error('onJoin', e);
      return false;
    });
    if (!ok || ws.readyState !== ws.OPEN) {
      try { ws.close(4004, 'not_available'); } catch {}
      return;
    }
    this.room(liveId).conns.add(conn);
    if (conn.role === 'viewer') {
      const subs = this.room(liveId).subs;
      subs.set(conn.sub, (subs.get(conn.sub) || 0) + 1);
    }
    this.send(conn, { t: 'hello', connId: conn.id, serverNow: Date.now(), ...this.handlers.snapshot(liveId, conn) });
    // (dev mesh) a (re)connected host must re-offer to everyone already watching.
    if (conn.role !== 'viewer') this.broadcast(liveId, { t: 'host_online' }, { filter: (c) => c.role === 'viewer' });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (!this.msgLimiter.take(conn.id)) return this.send(conn, { t: 'error', code: 'slow_down' });
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'ping') return this.send(conn, { t: 'pong', serverNow: Date.now() });
      if (msg.t === 'rtc' || msg.t === 'mesh_join') return this.meshSignal(conn, msg);
      Promise.resolve(this.handlers.onMessage(conn, msg)).catch((e) => console.error('onMessage', e));
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => {});
  }

  onClose(conn) {
    const r = this.rooms.get(conn.liveId);
    if (r && r.conns.delete(conn)) {
      if (conn.role === 'viewer') {
        const c = (r.subs.get(conn.sub) || 1) - 1;
        if (c <= 0) r.subs.delete(conn.sub);
        else r.subs.set(conn.sub, c);
      }
      // Tell the host (dev mesh) to drop the peer connection.
      for (const h of r.conns) if (h.role !== 'viewer') this.send(h, { t: 'mesh_drop', id: conn.id });
    }
    this.handlers.onLeave(conn);
  }

  room(liveId) {
    let r = this.rooms.get(liveId);
    if (!r) {
      r = { conns: new Set(), subs: new Map(), likesPending: 0, likesTotal: null, lastViewers: -1 };
      this.rooms.set(liveId, r);
    }
    return r;
  }

  viewerCount(liveId) {
    return this.rooms.get(liveId)?.subs.size || 0;
  }

  send(conn, msg, lowPriority = false) {
    const ws = conn.ws;
    if (ws.readyState !== ws.OPEN) return;
    if (lowPriority && ws.bufferedAmount > LOW_PRIORITY_BUFFER) return; // slow client: skip cosmetic updates
    ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  broadcast(liveId, msg, { lowPriority = false, filter } = {}) {
    const r = this.rooms.get(liveId);
    if (!r) return;
    const data = JSON.stringify(msg);
    for (const c of r.conns) if (!filter || filter(c)) this.send(c, data, lowPriority);
  }

  toHosts(liveId, msg) {
    if (!msg) return;
    this.broadcast(liveId, msg, { filter: (c) => c.role !== 'viewer' });
  }

  hostCount(liveId) {
    const r = this.rooms.get(liveId);
    return r ? [...r.conns].filter((c) => c.role !== 'viewer').length : 0;
  }

  connsForSub(liveId, sub) {
    const r = this.rooms.get(liveId);
    return r ? [...r.conns].filter((c) => c.sub === sub) : [];
  }

  addLikes(liveId, n, totalAfter) {
    const r = this.room(liveId);
    r.likesPending += n;
    r.likesTotal = totalAfter;
  }

  // Batched, low-frequency fan-out of likes and viewer counts.
  flush() {
    for (const [liveId, r] of this.rooms) {
      if (r.likesPending > 0) {
        this.broadcast(liveId, { t: 'likes', total: r.likesTotal, burst: Math.min(r.likesPending, 30) }, { lowPriority: true });
        r.likesPending = 0;
      }
      const v = r.subs.size;
      if (v !== r.lastViewers) {
        r.lastViewers = v;
        this.broadcast(liveId, { t: 'viewers', n: v }, { lowPriority: true });
        this.handlers.onViewerCount?.(liveId, v);
      }
      if (r.conns.size === 0 && r.likesPending === 0) this.rooms.delete(liveId);
    }
  }

  ping() {
    for (const r of this.rooms.values()) {
      for (const c of r.conns) {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        try { c.ws.ping(); } catch {}
      }
    }
  }

  closeLive(liveId, msg) {
    const r = this.rooms.get(liveId);
    if (!r) return;
    for (const c of r.conns) {
      this.send(c, msg);
    }
  }

  // ---- dev mesh signalling (STREAM_PROVIDER=devmesh only) -----------------
  meshSignal(conn, msg) {
    if (config.streaming.provider !== 'devmesh') return;
    const r = this.rooms.get(conn.liveId);
    if (!r) return;
    if (msg.t === 'mesh_join' && conn.role === 'viewer') {
      if (!this.handlers.canWatch(conn)) return this.send(conn, { t: 'preview_over' });
      conn.streamIdentity = typeof msg.identity === 'string' ? msg.identity.slice(0, 80) : conn.sub;
      for (const h of r.conns) if (h.role !== 'viewer') this.send(h, { t: 'mesh_viewer', from: conn.id });
      return;
    }
    if (msg.t === 'rtc') {
      const payload = msg.data && typeof msg.data === 'object' ? msg.data : null;
      if (!payload) return;
      if (conn.role === 'viewer') {
        for (const h of r.conns) if (h.role !== 'viewer') this.send(h, { t: 'rtc', from: conn.id, data: payload });
      } else {
        const target = [...r.conns].find((c) => c.id === msg.to);
        if (target) this.send(target, { t: 'rtc', from: 'host', data: payload });
      }
    }
  }

  meshDropViewer(liveId, identity) {
    const r = this.rooms.get(liveId);
    if (!r) return;
    for (const c of r.conns) {
      if (c.role === 'viewer' && (c.streamIdentity === identity || c.sub === identity)) {
        for (const h of r.conns) if (h.role !== 'viewer') this.send(h, { t: 'mesh_drop', id: c.id });
      }
    }
  }
}
