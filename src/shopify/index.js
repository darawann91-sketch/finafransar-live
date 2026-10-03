import { config } from '../config.js';
import { shopifyLive } from './admin.js';
import { shopifyMock } from './mock.js';
import { hmacHex, hmacB64, safeEqual } from '../lib/crypto.js';

export const shopify = config.shopify.mode === 'live' ? shopifyLive : shopifyMock;

// ---- App Proxy signature ---------------------------------------------------
// https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
export function verifyAppProxy(searchParams, secret = config.shopify.proxySecret) {
  const signature = searchParams.get('signature');
  if (!signature || !secret) return null;
  const grouped = new Map();
  for (const [k, v] of searchParams) {
    if (k === 'signature') continue;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(v);
  }
  const message = [...grouped.entries()].map(([k, vs]) => `${k}=${vs.join(',')}`).sort().join('');
  if (!safeEqual(hmacHex(secret, message), signature)) return null;
  // Replay window: Shopify signs every proxied request with a fresh timestamp.
  const ts = Number(searchParams.get('timestamp'));
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return null;
  return {
    shop: searchParams.get('shop'),
    customerId: searchParams.get('logged_in_customer_id') || null,
    pathPrefix: searchParams.get('path_prefix') || config.proxyPrefix,
  };
}

// Used by the local storefront mock and the tests to sign proxied requests.
export function signAppProxy(params, secret = config.shopify.proxySecret) {
  const sp = new URLSearchParams(params);
  sp.set('timestamp', String(Math.floor(Date.now() / 1000)));
  const grouped = new Map();
  for (const [k, v] of sp) {
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(v);
  }
  const message = [...grouped.entries()].map(([k, vs]) => `${k}=${vs.join(',')}`).sort().join('');
  sp.set('signature', hmacHex(secret, message));
  return sp;
}

// ---- Webhook HMAC ------------------------------------------------------------
export function verifyWebhook(rawBody, hmacHeader, secret = config.shopify.clientSecret) {
  if (!hmacHeader || !secret) return false;
  return safeEqual(hmacB64(secret, rawBody), hmacHeader);
}
