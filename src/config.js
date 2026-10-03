// Central configuration. All secrets come from environment variables and are
// only ever used server-side. Nothing in here is sent to the browser except
// values explicitly marked PUBLIC below.
import { readFileSync, existsSync } from 'node:fs';

// Minimal .env loader (no dependency). Existing env vars win.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const isProd = env('NODE_ENV', 'development') === 'production';

export const config = {
  isProd,
  port: Number(env('PORT', 8080)),

  // PUBLIC: where this app is reachable directly (studio, websocket, static).
  publicUrl: env('PUBLIC_URL', 'http://localhost:8080').replace(/\/$/, ''),
  // PUBLIC: the Shopify storefront (viewer pages are served on this origin via App Proxy).
  storeUrl: env('STORE_URL', 'https://www.finafransar.com').replace(/\/$/, ''),
  // Extra origins allowed to open the websocket (comma separated).
  extraOrigins: env('EXTRA_ORIGINS', '').split(',').map((s) => s.trim()).filter(Boolean),
  // App proxy prefix as configured in Shopify (prefix + subpath).
  proxyPrefix: env('APP_PROXY_PREFIX', '/apps/live'),

  dataDir: env('DATA_DIR', './data'),

  // Signing secret for viewer tokens. MUST be long and random in production.
  appSecret: env('APP_SECRET', isProd ? '' : 'dev-only-secret-change-me-dev-only-secret'),

  shopify: {
    // "mock" uses local fixtures (development / tests). "live" calls the real Admin API.
    mode: env('SHOPIFY_MODE', isProd ? 'live' : 'mock'),
    shop: env('SHOPIFY_SHOP', 'zrhvuy-pz.myshopify.com'),
    clientId: env('SHOPIFY_CLIENT_ID', ''),
    clientSecret: env('SHOPIFY_CLIENT_SECRET', ''),
    apiVersion: env('SHOPIFY_API_VERSION', '2026-07'),
    // App proxy requests are signed with the app's client secret.
    proxySecret: env('SHOPIFY_CLIENT_SECRET', isProd ? '' : 'dev-proxy-secret'),
    currency: env('SHOP_CURRENCY', 'SEK'),
  },

  streaming: {
    provider: env('STREAM_PROVIDER', isProd ? 'livekit' : 'devmesh'),
    // Broadcast quality. 1080 = Full HD (recommended). 1440 / 2160 only when the
    // host sends from a computer with a real camera and a fast uplink.
    // Viewers always get simulcast layers (1080/720/360) and adapt automatically.
    maxHeight: Number(env('STREAM_MAX_HEIGHT', 1080)),
    maxBitrateKbps: Number(env('STREAM_MAX_BITRATE_KBPS', 4500)),
    livekit: {
      // wss://<project>.livekit.cloud  or your self-hosted wss://live-media.finafransar.com
      url: env('LIVEKIT_URL', ''),
      apiKey: env('LIVEKIT_API_KEY', ''),
      apiSecret: env('LIVEKIT_API_SECRET', ''),
    },
  },

  live: {
    previewSeconds: Number(env('PREVIEW_SECONDS', 10)),
    // How many free previews a single IP gets per live per hour (stops refresh-abuse).
    previewsPerIpPerHour: Number(env('PREVIEWS_PER_IP_PER_HOUR', 4)),
    chatMaxLength: 200,
  },

  bootstrapAdmin: {
    email: env('ADMIN_EMAIL', ''),
    password: env('ADMIN_PASSWORD', ''),
    name: env('ADMIN_NAME', 'Admin'),
  },
};

export function assertProductionConfig() {
  if (!config.isProd) return;
  const missing = [];
  if (!config.appSecret || config.appSecret.length < 32) missing.push('APP_SECRET (minst 32 tecken)');
  if (!config.publicUrl.startsWith('https://')) missing.push('PUBLIC_URL (måste vara https)');
  if (config.shopify.mode === 'live') {
    if (!config.shopify.clientId) missing.push('SHOPIFY_CLIENT_ID');
    if (!config.shopify.clientSecret) missing.push('SHOPIFY_CLIENT_SECRET');
  }
  if (config.streaming.provider === 'livekit') {
    const lk = config.streaming.livekit;
    if (!lk.url || !lk.apiKey || !lk.apiSecret) missing.push('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET');
  }
  if (config.streaming.provider === 'devmesh') missing.push('STREAM_PROVIDER=devmesh är bara för utveckling');
  if (missing.length) {
    console.error('Saknad/ogiltig konfiguration:\n - ' + missing.join('\n - '));
    process.exit(1);
  }
}
