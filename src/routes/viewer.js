// Customer-facing routes.
//  GET  /proxy[/:liveId]        <- Shopify App Proxy (www.finafransar.com/apps/live/…)
//  POST /api/stream/viewer      <- stream credentials (CORS from the storefront)
import { config } from '../config.js';
import { Lives, Events } from '../db.js';
import { shopify, verifyAppProxy } from '../shopify/index.js';
import { signJwt, verifyJwt, randomId } from '../lib/crypto.js';
import { sendHtml, sendJson, HttpError, clientIp } from '../lib/http.js';
import { isLiveId, isNumericId } from '../lib/sanitize.js';
import { viewerPage, infoPage } from '../views/pages.js';
import * as svc from '../services/lives.js';

// The live page may be framed by the storefront itself (homepage takeover).
const frameHeaders = {
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': `frame-ancestors 'self' ${new URL(config.storeUrl).origin} https://finafransar.com https://www.finafransar.com`,
};

const nameCache = new Map(); // customerId -> { name, createdAt, at }

async function customerProfile(customerId) {
  const c = nameCache.get(customerId);
  if (c && Date.now() - c.at < 3600_000) return c;
  let name = 'Kund';
  let createdAt = null;
  try {
    const cust = await shopify.customer(customerId);
    if (cust) {
      const first = (cust.firstName || '').trim();
      const lastInitial = (cust.lastName || '').trim().slice(0, 1);
      name = first ? `${first}${lastInitial ? ` ${lastInitial}.` : ''}` : 'Kund';
      createdAt = cust.createdAt ? Date.parse(cust.createdAt) : null;
    }
  } catch (e) {
    console.error('customer lookup failed', e.message);
  }
  const entry = { name: name.slice(0, 30), createdAt, at: Date.now() };
  nameCache.set(customerId, entry);
  if (nameCache.size > 50_000) nameCache.clear();
  return entry;
}

export function registerViewerRoutes(router, { trustProxy }) {
  const handleProxy = async (req, res, { liveId }, url) => {
    const proxy = verifyAppProxy(url.searchParams);
    const allowUnsigned = !config.isProd && process.env.DEV_ALLOW_UNSIGNED === '1';
    if (!proxy && !allowUnsigned) throw new HttpError(401, 'invalid_proxy_signature');
    const pathPrefix = proxy?.pathPrefix || config.proxyPrefix;
    const customerId = proxy?.customerId && isNumericId(proxy.customerId) ? proxy.customerId : null;

    let live;
    if (liveId) {
      if (!isLiveId(liveId)) return notFound(res);
      live = Lives.get(liveId);
      if (!live) return notFound(res);
    } else {
      live = Lives.current();
      if (!live) {
        const recent = Lives.list({ limit: 3 }).filter((l) => l.status === 'ended');
        return sendHtml(res, 200, infoPage({
          title: 'Finafransar LIVE',
          heading: 'Ingen live just nu',
          text: 'Nästa Finafransar LIVE kommer snart. Följ oss på Instagram så missar du inget.',
          ctaHref: config.storeUrl, ctaText: 'Till butiken', upcoming: recent,
        }));
      }
    }
    if (live.status === 'draft') {
      return sendHtml(res, 200, infoPage({ title: live.title, heading: 'Liven har inte börjat än', text: `“${live.title}” startar snart. Ladda om sidan när det är dags.`, ctaHref: config.storeUrl, ctaText: 'Till butiken' }));
    }
    if (live.status === 'ended') {
      return sendHtml(res, 200, infoPage({ title: live.title, heading: 'Liven är slut', text: `Tack för att du var med på “${live.title}”. Alla produkter finns kvar i butiken.`, ctaHref: config.storeUrl, ctaText: 'Shoppa i butiken' }));
    }

    // ---- identity ----------------------------------------------------------
    const ref = url.searchParams.get('ref') === 'share' ? 'share' : null;
    let viewer;
    if (customerId) {
      const prof = await customerProfile(customerId);
      viewer = { sub: `c_${customerId}`, name: prof.name, guest: false };
      if (url.searchParams.get('auth') === '1') {
        const isNew = prof.createdAt && Date.now() - prof.createdAt < 30 * 60_000;
        Events.add(live.id, isNew ? 'registration' : 'login', viewer.sub);
      }
    } else {
      // App Proxy strips cookies, so a guest identity is per page load. The
      // real limit on previews is enforced per IP in the service layer.
      viewer = { sub: `g_${randomId(12)}`, name: 'Gäst', guest: true };
    }
    if (ref) Events.add(live.id, 'share_visit', viewer.sub);

    const token = signJwt({ typ: 'viewer', sub: viewer.sub, name: viewer.name, guest: viewer.guest, ref, live: live.id }, config.appSecret, { expiresInSec: 12 * 3600 });
    const products = await svc.liveProducts(live.id);
    const active = products.find((p) => p.id === live.active_product_id);
    const openProduct = url.searchParams.get('p');

    const boot = {
      liveId: live.id,
      title: live.title,
      token,
      viewer: { name: viewer.name, guest: viewer.guest },
      api: config.publicUrl,
      ws: config.publicUrl.replace(/^http/, 'ws') + '/ws',
      storeUrl: config.storeUrl,
      pathPrefix,
      shareUrl: svc.shareUrl(live),
      previewSeconds: config.live.previewSeconds,
      provider: config.streaming.provider,
      currency: config.shopify.currency,
      openProductId: openProduct && isNumericId(openProduct) ? openProduct : null,
      vendor: { livekit: `${config.publicUrl}/static/vendor/livekit-client.esm.mjs` },
    };
    sendHtml(res, 200, viewerPage(boot, {
      title: `🔴 LIVE: ${live.title} | Finafransar`,
      description: live.description || 'Titta live och shoppa direkt i sändningen.',
      image: active?.image || products[0]?.image || null,
      url: svc.shareUrl(live),
    }), { 'Cache-Control': 'private, no-store', ...frameHeaders });
  };

  // GET /apps/live/status  (via App Proxy, same origin as the storefront)
  router.get('/proxy/status', (req, res, params, url) => {
    if (!verifyAppProxy(url.searchParams) && !(!config.isProd && process.env.DEV_ALLOW_UNSIGNED === '1')) throw new HttpError(401, 'invalid_proxy_signature');
    sendJson(res, 200, svc.liveStatus(), { 'Cache-Control': 'no-store' });
  });
  router.get('/proxy', (req, res, params, url) => handleProxy(req, res, {}, url));
  router.get('/proxy/:liveId', (req, res, params, url) => handleProxy(req, res, params, url));

  router.post('/api/stream/viewer', async (req, res) => {
    const auth = String(req.headers.authorization || '');
    const claims = verifyJwt(auth.startsWith('Bearer ') ? auth.slice(7) : '', config.appSecret);
    if (!claims || claims.typ !== 'viewer') throw new HttpError(401, 'invalid_token');
    const creds = await svc.viewerStreamCredentials(claims.live, { sub: claims.sub, name: claims.name, guest: claims.guest }, clientIp(req, trustProxy));
    sendJson(res, 200, creds);
  });
}

function notFound(res) {
  sendHtml(res, 404, infoPage({ title: 'Hittades inte', heading: 'Den här liven finns inte', text: 'Länken kan vara fel eller så har liven tagits bort.', ctaHref: config.storeUrl, ctaText: 'Till butiken' }));
}
