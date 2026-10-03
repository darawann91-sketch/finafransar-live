// Finafransar LIVE – server entry point.
import http from 'node:http';
import { config, assertProductionConfig } from './config.js';
import { Router, HttpError, sendJson, serveStatic, securityHeaders } from './lib/http.js';
import { Sessions } from './db.js';
import { Hub } from './realtime/hub.js';
import { hubRef } from './streaming/index.js';
import { shopify } from './shopify/index.js';
import { bootstrapAdmin } from './auth.js';
import * as svc from './services/lives.js';
import { registerViewerRoutes } from './routes/viewer.js';
import { registerStudioRoutes } from './routes/studio.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

assertProductionConfig();
bootstrapAdmin();

const trustProxy = process.env.TRUST_PROXY === '1' || config.isProd;
const router = new Router();
registerViewerRoutes(router, { trustProxy });
registerStudioRoutes(router, { trustProxy });
registerWebhookRoutes(router);
router.get('/healthz', (req, res) => sendJson(res, 200, { ok: true, provider: config.streaming.provider, shopify: shopify.mode }));

const statics = serveStatic(new URL('../public', import.meta.url).pathname, '/static/');

// CORS: only the storefront may call the viewer API cross-origin.
const corsOrigins = new Set([config.storeUrl, `https://${config.shopify.shop}`, ...config.extraOrigins]);
try {
  const u = new URL(config.storeUrl);
  corsOrigins.add(`${u.protocol}//${u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname}`);
} catch {}

function applyCors(req, res, pathname) {
  if (!pathname.startsWith('/api/stream/')) return false;
  const origin = req.headers.origin;
  if (origin && corsOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  securityHeaders(res);
  try {
    if (applyCors(req, res, pathname)) return;
    if ((req.method === 'GET' || req.method === 'HEAD') && statics(req, res, pathname)) return;
    const m = router.match(req.method, pathname);
    if (!m) throw new HttpError(404, 'not_found');
    await m.handler(req, res, m.params, url);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(req.method, pathname, e);
    if (!res.headersSent) sendJson(res, status, { error: e.code || 'server_error', message: status >= 500 ? 'Något gick fel' : e.message });
    else res.end();
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

const hub = new Hub({
  server,
  trustProxy,
  handlers: {
    onJoin: svc.onJoin,
    onLeave: svc.onLeave,
    onMessage: svc.onMessage,
    onViewerCount: svc.onViewerCount,
    snapshot: svc.snapshot,
    canWatch: svc.canWatch,
  },
});
hubRef.current = hub;
svc.attachHub(hub);
svc.resumeAfterRestart();

setInterval(() => Sessions.gc(), 3600_000).unref();

server.listen(config.port, () => {
  console.log(`Finafransar LIVE på ${config.publicUrl} (port ${config.port}) – streaming: ${config.streaming.provider}, shopify: ${shopify.mode}`);
  if (shopify.mode === 'live' && config.publicUrl.startsWith('https://')) {
    // Pretty storefront URLs (idempotent): /live -> current live, /live/admin -> Studio
    shopify.createRedirect('/live', config.proxyPrefix).catch((e) => console.error('Redirect /live:', e.message));
    shopify.createRedirect('/live/admin', `${config.publicUrl}/admin`).catch((e) => console.error('Redirect /live/admin:', e.message));
    shopify.ensureWebhooks(`${config.publicUrl}/webhooks/orders-create`).then(
      () => console.log('Webhook orders/create OK'),
      (e) => console.error('Kunde inte registrera webhook (köp-statistik):', e.message)
    );
  }
});

const shutdown = () => {
  console.log('Stänger ner…');
  server.close();
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
