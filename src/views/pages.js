// Server-rendered HTML shells. The viewer page is returned through the
// Shopify App Proxy, so it is served on www.finafransar.com (same origin as
// the real cart) but contains no theme/app scripts – fast and distraction-free.
import { config } from '../config.js';
import { escapeHtml, jsonForScript } from '../lib/sanitize.js';

const assetVersion = Date.now().toString(36);
const asset = (p) => `${config.publicUrl}/static/${p}?v=${assetVersion}`;

function csp() {
  const pub = new URL(config.publicUrl);
  const wsPub = `${pub.protocol === 'https:' ? 'wss' : 'ws'}://${pub.host}`;
  const lk = config.streaming.livekit.url;
  const lkHttp = lk ? lk.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:') : '';
  const connect = ["'self'", config.publicUrl, wsPub, lk, lkHttp, lk ? 'wss://*.livekit.cloud https://*.livekit.cloud' : ''].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    `script-src ${config.publicUrl}`,
    `style-src ${config.publicUrl} https://fonts.googleapis.com 'unsafe-inline'`,
    'font-src https://fonts.gstatic.com',
    "img-src 'self' https: data: blob:",
    "media-src 'self' blob: mediastream:",
    `connect-src ${connect}`,
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

const head = ({ title, description, image, url }) => `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#000000">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp())}">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Finafransar">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ''}
${url ? `<meta property="og:url" content="${escapeHtml(url)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:wght@600;700&display=swap">
<link rel="stylesheet" href="${asset('viewer/viewer.css')}">
</head>`;

export function viewerPage(boot, meta) {
  return `${head(meta)}
<body class="ffl">
<div id="app" class="app" data-state="loading">
  <noscript><p class="noscript">Finafransar LIVE kräver JavaScript.</p></noscript>
</div>
<script type="application/json" id="ffl-boot">${jsonForScript(boot)}</script>
<script type="module" src="${asset('viewer/main.js')}"></script>
</body>
</html>`;
}

export function infoPage({ title, heading, text, ctaHref, ctaText, upcoming }) {
  return `${head({ title, description: text })}
<body class="ffl ffl-info">
<main class="info-page">
  <div class="brand"><span class="dot"></span> FINAFRANSAR <b>LIVE</b></div>
  <h1>${escapeHtml(heading)}</h1>
  <p>${escapeHtml(text)}</p>
  ${upcoming?.length ? `<ul class="past">${upcoming.map((l) => `<li><span>${escapeHtml(l.title)}</span></li>`).join('')}</ul>` : ''}
  <a class="btn btn-primary" href="${escapeHtml(ctaHref)}">${escapeHtml(ctaText)}</a>
</main>
</body>
</html>`;
}

export function studioPage() {
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<meta name="robots" content="noindex, nofollow">
<title>Finafransar LIVE Studio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:wght@600;700&display=swap">
<link rel="stylesheet" href="/static/studio/studio.css?v=${assetVersion}">
</head>
<body class="studio">
<div id="studio"></div>
<script type="module" src="/static/studio/main.js?v=${assetVersion}"></script>
</body>
</html>`;
}

export function studioHeaders() {
  const pub = new URL(config.publicUrl);
  const wsPub = `${pub.protocol === 'https:' ? 'wss' : 'ws'}://${pub.host}`;
  const lk = config.streaming.livekit.url;
  const lkHttp = lk ? lk.replace(/^wss:/, 'https:') : '';
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' https: data: blob:",
      "media-src 'self' blob: mediastream:",
      `connect-src 'self' ${wsPub} ${lk} ${lkHttp} ${lk ? 'wss://*.livekit.cloud https://*.livekit.cloud' : ''}`.trim(),
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'Permissions-Policy': 'camera=(self), microphone=(self)',
  };
}
