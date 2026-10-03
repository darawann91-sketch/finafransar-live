// Persistence: SQLite (built into Node 22, WAL mode). One file on a
// persistent volume is plenty for a single live server. Products are NOT
// stored here – only references (Shopify product IDs) – Shopify stays the
// source of truth.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
const file = process.env.DB_FILE || path.join(config.dataDir, 'live.db');
export const db = new DatabaseSync(file);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','host')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT, ua TEXT
);

CREATE TABLE IF NOT EXISTS lives (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('draft','live','ended')),
  host_id INTEGER NOT NULL REFERENCES hosts(id),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  active_product_id TEXT,
  pinned_message_id INTEGER,
  deal_json TEXT,
  stream_room TEXT,
  redirect_gid TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  peak_viewers INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lives_status ON lives(status, started_at);

CREATE TABLE IF NOT EXISTS live_products (
  live_id TEXT NOT NULL REFERENCES lives(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (live_id, product_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  live_id TEXT NOT NULL REFERENCES lives(id) ON DELETE CASCADE,
  sub TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by INTEGER
);
CREATE INDEX IF NOT EXISTS messages_live ON messages(live_id, id);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  live_id TEXT NOT NULL,
  reporter_sub TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  UNIQUE (message_id, reporter_sub)
);

CREATE TABLE IF NOT EXISTS blocks (
  sub TEXT PRIMARY KEY,
  name TEXT,
  reason TEXT,
  blocked_by INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mutes (
  live_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  until INTEGER NOT NULL,
  PRIMARY KEY (live_id, sub)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  live_id TEXT NOT NULL,
  type TEXT NOT NULL,
  sub TEXT,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_live_type ON events(live_id, type);

CREATE TABLE IF NOT EXISTS viewer_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  live_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  guest INTEGER NOT NULL,
  ref TEXT,
  joined_at INTEGER NOT NULL,
  left_at INTEGER
);
CREATE INDEX IF NOT EXISTS vs_live ON viewer_sessions(live_id);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  live_id TEXT NOT NULL,
  total REAL NOT NULL,
  currency TEXT,
  customer_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_live ON orders(live_id);
`);

// Viewer sessions left open by a crash/restart are closed at boot.
db.prepare('UPDATE viewer_sessions SET left_at = joined_at WHERE left_at IS NULL').run();

export const now = () => Date.now();

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const q = (sql) => db.prepare(sql);

// ---- hosts / sessions ------------------------------------------------------
export const Hosts = {
  count: () => q('SELECT COUNT(*) AS n FROM hosts').get().n,
  byEmail: (email) => q('SELECT * FROM hosts WHERE email = ?').get(email),
  byId: (id) => q('SELECT * FROM hosts WHERE id = ?').get(id),
  list: () => q('SELECT id, email, name, role, active, created_at, last_login_at FROM hosts ORDER BY id').all(),
  create: ({ email, name, passwordHash, role }) =>
    q('INSERT INTO hosts (email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)').run(email, name, passwordHash, role, now()).lastInsertRowid,
  update: (id, { name, role, active, passwordHash }) => {
    const h = Hosts.byId(id);
    if (!h) return;
    q('UPDATE hosts SET name=?, role=?, active=?, password_hash=? WHERE id=?').run(
      name ?? h.name, role ?? h.role, active === undefined ? h.active : active ? 1 : 0, passwordHash ?? h.password_hash, id
    );
  },
  touchLogin: (id) => q('UPDATE hosts SET last_login_at=? WHERE id=?').run(now(), id),
};

export const Sessions = {
  create: (s) => q('INSERT INTO sessions (id_hash, host_id, csrf, created_at, expires_at, ip, ua) VALUES (?,?,?,?,?,?,?)').run(s.idHash, s.hostId, s.csrf, now(), s.expiresAt, s.ip, s.ua),
  get: (idHash) => q('SELECT s.*, h.email, h.name, h.role, h.active FROM sessions s JOIN hosts h ON h.id = s.host_id WHERE s.id_hash = ? AND s.expires_at > ?').get(idHash, now()),
  delete: (idHash) => q('DELETE FROM sessions WHERE id_hash = ?').run(idHash),
  deleteForHost: (hostId) => q('DELETE FROM sessions WHERE host_id = ?').run(hostId),
  gc: () => q('DELETE FROM sessions WHERE expires_at <= ?').run(now()),
};

// ---- lives -----------------------------------------------------------------
const parseLive = (r) => (r ? { ...r, deal: r.deal_json ? JSON.parse(r.deal_json) : null } : null);

export const Lives = {
  get: (id) => parseLive(q('SELECT * FROM lives WHERE id = ?').get(id)),
  current: () => parseLive(q("SELECT * FROM lives WHERE status = 'live' ORDER BY started_at DESC LIMIT 1").get()),
  listLive: () => q("SELECT * FROM lives WHERE status = 'live' ORDER BY started_at DESC").all().map(parseLive),
  list: ({ hostId, limit = 50 } = {}) =>
    (hostId
      ? q('SELECT * FROM lives WHERE host_id = ? ORDER BY created_at DESC LIMIT ?').all(hostId, limit)
      : q('SELECT * FROM lives ORDER BY created_at DESC LIMIT ?').all(limit)
    ).map(parseLive),
  create: ({ id, title, description, hostId }) =>
    q("INSERT INTO lives (id, title, description, status, host_id, created_at) VALUES (?,?,?,'draft',?,?)").run(id, title, description, hostId, now()),
  update: (id, fields) => {
    const allowed = ['title', 'description', 'status', 'started_at', 'ended_at', 'active_product_id', 'pinned_message_id', 'deal_json', 'stream_room', 'redirect_gid', 'likes', 'peak_viewers'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    q(`UPDATE lives SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
  },
  products: (id) => q('SELECT product_id FROM live_products WHERE live_id = ? ORDER BY position').all(id).map((r) => r.product_id),
  setProducts: (id, productIds) =>
    tx(() => {
      q('DELETE FROM live_products WHERE live_id = ?').run(id);
      const ins = q('INSERT INTO live_products (live_id, product_id, position) VALUES (?,?,?)');
      productIds.forEach((pid, i) => ins.run(id, String(pid), i));
    }),
  addLikes: (id, n) => q('UPDATE lives SET likes = likes + ? WHERE id = ?').run(n, id),
  bumpPeak: (id, n) => q('UPDATE lives SET peak_viewers = MAX(peak_viewers, ?) WHERE id = ?').run(n, id),
};

// ---- chat / moderation -----------------------------------------------------
export const Messages = {
  add: ({ liveId, sub, name, role, text }) => {
    const created = now();
    const id = q('INSERT INTO messages (live_id, sub, name, role, text, created_at) VALUES (?,?,?,?,?,?)').run(liveId, sub, name, role, text, created).lastInsertRowid;
    return { id: Number(id), liveId, sub, name, role, text, createdAt: created };
  },
  recent: (liveId, limit = 60) =>
    q('SELECT * FROM (SELECT * FROM messages WHERE live_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?) ORDER BY id').all(liveId, limit),
  get: (id) => q('SELECT * FROM messages WHERE id = ?').get(id),
  softDelete: (id, by) => q('UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), by, id),
  deleteAllBySub: (liveId, sub, by) => q('UPDATE messages SET deleted_at = ?, deleted_by = ? WHERE live_id = ? AND sub = ? AND deleted_at IS NULL').run(now(), by, liveId, sub),
  idsBySub: (liveId, sub) => q('SELECT id FROM messages WHERE live_id = ? AND sub = ?').all(liveId, sub).map((r) => r.id),
};

export const Reports = {
  add: (messageId, liveId, reporterSub) => {
    try {
      q('INSERT INTO reports (message_id, live_id, reporter_sub, created_at) VALUES (?,?,?,?)').run(messageId, liveId, reporterSub, now());
      return true;
    } catch {
      return false; // duplicate report
    }
  },
  open: (liveId) =>
    q(`SELECT m.id AS message_id, m.sub, m.name, m.text, m.created_at, COUNT(r.id) AS reports
       FROM reports r JOIN messages m ON m.id = r.message_id
       WHERE r.live_id = ? AND r.resolved_at IS NULL AND m.deleted_at IS NULL
       GROUP BY m.id ORDER BY reports DESC, m.id DESC`).all(liveId),
  resolve: (messageId) => q('UPDATE reports SET resolved_at = ? WHERE message_id = ?').run(now(), messageId),
};

export const Blocks = {
  is: (sub) => !!q('SELECT 1 FROM blocks WHERE sub = ?').get(sub),
  add: (sub, name, reason, by) => q('INSERT OR REPLACE INTO blocks (sub, name, reason, blocked_by, created_at) VALUES (?,?,?,?,?)').run(sub, name, reason, by, now()),
  remove: (sub) => q('DELETE FROM blocks WHERE sub = ?').run(sub),
  list: () => q('SELECT * FROM blocks ORDER BY created_at DESC').all(),
};

export const Mutes = {
  until: (liveId, sub) => q('SELECT until FROM mutes WHERE live_id = ? AND sub = ?').get(liveId, sub)?.until || 0,
  set: (liveId, sub, until) => q('INSERT OR REPLACE INTO mutes (live_id, sub, until) VALUES (?,?,?)').run(liveId, sub, until),
};

// ---- analytics -------------------------------------------------------------
export const Events = {
  add: (liveId, type, sub = null, data = null) =>
    q('INSERT INTO events (live_id, type, sub, data, created_at) VALUES (?,?,?,?,?)').run(liveId, type, sub, data ? JSON.stringify(data) : null, now()),
  counts: (liveId) => Object.fromEntries(q('SELECT type, COUNT(*) AS n FROM events WHERE live_id = ? GROUP BY type').all(liveId).map((r) => [r.type, r.n])),
  uniqueCounts: (liveId) => Object.fromEntries(q('SELECT type, COUNT(DISTINCT sub) AS n FROM events WHERE live_id = ? GROUP BY type').all(liveId).map((r) => [r.type, r.n])),
  productViews: (liveId) => q("SELECT json_extract(data,'$.productId') AS product_id, COUNT(*) AS views FROM events WHERE live_id = ? AND type = 'product_view' GROUP BY 1 ORDER BY 2 DESC").all(liveId),
  addToCartByProduct: (liveId) => q("SELECT json_extract(data,'$.productId') AS product_id, SUM(COALESCE(json_extract(data,'$.quantity'),1)) AS qty FROM events WHERE live_id = ? AND type = 'add_to_cart' GROUP BY 1 ORDER BY 2 DESC").all(liveId),
};

export const ViewerSessions = {
  open: (liveId, sub, guest, ref) => Number(q('INSERT INTO viewer_sessions (live_id, sub, guest, ref, joined_at) VALUES (?,?,?,?,?)').run(liveId, sub, guest ? 1 : 0, ref || null, now()).lastInsertRowid),
  close: (id) => q('UPDATE viewer_sessions SET left_at = ? WHERE id = ? AND left_at IS NULL').run(now(), id),
  closeAllForLive: (liveId) => q('UPDATE viewer_sessions SET left_at = ? WHERE live_id = ? AND left_at IS NULL').run(now(), liveId),
  stats: (liveId) =>
    q(`SELECT COUNT(DISTINCT sub) AS total_viewers,
              COUNT(DISTINCT CASE WHEN ref = 'share' THEN sub END) AS from_shared,
              COUNT(DISTINCT CASE WHEN guest = 1 THEN sub END) AS guests,
              COALESCE(SUM(COALESCE(left_at, ?) - joined_at), 0) AS total_ms
       FROM viewer_sessions WHERE live_id = ?`).get(now(), liveId),
};

export const Orders = {
  upsert: (o) => q('INSERT OR IGNORE INTO orders (order_id, live_id, total, currency, customer_id, created_at) VALUES (?,?,?,?,?,?)').run(o.orderId, o.liveId, o.total, o.currency, o.customerId, now()),
  stats: (liveId) => q('SELECT COUNT(*) AS purchases, COALESCE(SUM(total),0) AS revenue FROM orders WHERE live_id = ?').get(liveId),
};
