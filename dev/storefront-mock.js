// LOCAL DEVELOPMENT ONLY – simulates the parts of www.finafransar.com that the
// live system touches, so the full customer journey can be tested offline:
//   /live/:id                       -> Shopify URL redirect to /apps/live/:id?ref=share
//   /apps/live/*                    -> Shopify App Proxy (signed) -> live server /proxy/*
//   /customer_authentication/login  -> new customer accounts login (e-mail code) + return_to
//   /cart.js /cart/add.js /cart/change.js /cart/update.js  -> Ajax Cart API
//   /checkout                       -> placeholder for Shopify Checkout
import http from 'node:http';
import { signAppProxy } from '../src/shopify/index.js';
import { FIXTURE_PRODUCTS } from '../src/shopify/fixtures.js';

const PORT = Number(process.env.STORE_PORT || 3001);
const APP = process.env.APP_URL || 'http://localhost:8080';
const carts = new Map(); // cartId -> { items: [], attributes: {}, discount: null }

const variants = new Map();
for (const p of FIXTURE_PRODUCTS) {
  for (const v of p.variants.nodes) {
    variants.set(String(v.legacyResourceId), { product: p, v });
  }
}

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]));
const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
};

function cartFor(req, res) {
  let id = cookies(req).cart;
  if (!id || !carts.has(id)) {
    id = Math.random().toString(36).slice(2);
    carts.set(id, { items: [], attributes: {}, discount: null });
    res.setHeader('Set-Cookie', `cart=${id}; Path=/; SameSite=Lax`);
  }
  return carts.get(id);
}

function cartJson(cart) {
  const pct = cart.discount ? Number((cart.discount.match(/(\d+)/) || [])[1] || 0) : 0;
  const items = cart.items.map((it) => {
    const { product, v } = variants.get(it.id);
    const unit = Math.round(Number(v.price) * 100);
    const line = unit * it.quantity;
    const final = Math.round(line * (1 - pct / 100));
    return {
      key: `${it.id}:x`, id: Number(it.id), variant_id: Number(it.id), quantity: it.quantity,
      product_title: product.title, variant_title: v.title === 'Default Title' ? null : v.title,
      image: product.featuredMedia.preview.image.url, price: unit, line_price: line, original_line_price: line, final_line_price: final,
      properties: it.properties,
    };
  });
  const original = items.reduce((a, b) => a + b.original_line_price, 0);
  const total = items.reduce((a, b) => a + b.final_line_price, 0);
  return {
    item_count: items.reduce((a, b) => a + b.quantity, 0), items, total_price: total, original_total_price: original, items_subtotal_price: total,
    attributes: cart.attributes, currency: 'SEK',
    discount_codes: cart.discount ? [{ code: cart.discount, applicable: true }] : [],
  };
}

const page = (title, inner) => `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui;max-width:520px;margin:40px auto;padding:0 18px;color:#111}input,button{font:inherit;height:48px;border-radius:10px;border:1px solid #ccc;padding:0 12px;width:100%;margin:6px 0}button{background:#000;color:#fff;border:0;font-weight:700}small{color:#777}</style></head><body>${inner}</body></html>`;

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // Shopify URL redirect created by the live server for each live
  const m = p.match(/^\/live\/([a-z0-9]+)\/?$/);
  if (m) {
    res.writeHead(301, { Location: `/apps/live/${m[1]}?ref=share` });
    return res.end();
  }
  if (p === '/live' || p === '/live/') {
    res.writeHead(301, { Location: '/apps/live' });
    return res.end();
  }

  // App Proxy
  if (p === '/apps/live' || p.startsWith('/apps/live/')) {
    const rest = p.slice('/apps/live'.length);
    const params = Object.fromEntries(url.searchParams);
    const customer = cookies(req).mock_customer;
    const signed = signAppProxy({ ...params, shop: 'zrhvuy-pz.myshopify.com', logged_in_customer_id: customer || '', path_prefix: '/apps/live' });
    const r = await fetch(`${APP}/proxy${rest}?${signed}`, { redirect: 'manual' });
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/html', 'Cache-Control': 'no-store' });
    return res.end(text);
  }

  // New customer accounts login (simplified: e-mail -> "code" -> logged in)
  if (p === '/customer_authentication/login') {
    const back = url.searchParams.get('return_to') || '/';
    if (!back.startsWith('/')) return send(res, 400, 'return_to must be relative');
    if (req.method === 'POST') {
      const form = new URLSearchParams(await body(req));
      const email = form.get('email') || 'kund@example.com';
      const id = String(1000 + ([...email].reduce((a, c) => a + c.charCodeAt(0), 0) % 8000) + (form.get('new') ? 9000 : 0));
      res.writeHead(302, { Location: back, 'Set-Cookie': `mock_customer=${id}; Path=/; SameSite=Lax` });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page('Logga in – Finafransar', `<h2>Logga in eller skapa konto</h2><p><small>Shopify skickar en 6-siffrig kod till din e-post (simulerat).</small></p>
<form method="post"><input name="email" type="email" placeholder="E-post" value="sara@example.com" required><label><input type="checkbox" name="new" value="1" style="width:auto;height:auto"> Nytt konto</label><button id="login-submit">Fortsätt</button></form>`));
  }

  // Ajax Cart API
  if (p === '/cart.js') return send(res, 200, cartJson(cartFor(req, res)));
  if (p === '/cart/add.js' && req.method === 'POST') {
    const cart = cartFor(req, res);
    const data = JSON.parse((await body(req)) || '{}');
    for (const it of data.items || []) {
      const ref = variants.get(String(it.id));
      if (!ref) return send(res, 404, { status: 404, message: 'Cart Error', description: 'Produkten hittades inte' });
      const existing = cart.items.find((x) => x.id === String(it.id));
      const qty = (existing?.quantity || 0) + Number(it.quantity || 1);
      if (!ref.v.availableForSale || qty > ref.v.inventoryQuantity) {
        return send(res, 422, { status: 422, message: 'Cart Error', description: `Alla ${ref.v.inventoryQuantity} ${ref.product.title} finns i din varukorg.` });
      }
      if (existing) existing.quantity = qty;
      else cart.items.push({ id: String(it.id), quantity: qty, properties: it.properties || {} });
    }
    return send(res, 200, { items: data.items });
  }
  if (p === '/cart/change.js' && req.method === 'POST') {
    const cart = cartFor(req, res);
    const data = JSON.parse((await body(req)) || '{}');
    const id = String(data.id).split(':')[0];
    const it = cart.items.find((x) => x.id === id);
    if (it) {
      if (data.quantity <= 0) cart.items = cart.items.filter((x) => x !== it);
      else it.quantity = data.quantity;
    }
    return send(res, 200, cartJson(cart));
  }
  if (p === '/cart/update.js' && req.method === 'POST') {
    const cart = cartFor(req, res);
    const data = JSON.parse((await body(req)) || '{}');
    if (data.attributes) Object.assign(cart.attributes, data.attributes);
    if (typeof data.discount === 'string') cart.discount = data.discount.toUpperCase() || null;
    return send(res, 200, cartJson(cart));
  }
  if (p === '/checkout') {
    const cart = cartJson(cartFor(req, res));
    const code = url.searchParams.get('discount');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page('Kassa', `<h2 id="checkout-h">Shopify Checkout (simulerad)</h2><p>${cart.item_count} varor · ${(cart.total_price / 100).toFixed(2)} kr</p><p id="checkout-discount">Rabattkod: ${(code || cart.discount_codes[0]?.code || '–')}</p><p>Attribut: <code id="checkout-attrs">${JSON.stringify(cart.attributes)}</code></p>`));
  }
  if (p === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page('Finafransar', '<h1>Finafransar (mock)</h1><p><a href="/live">Finafransar LIVE</a></p>'));
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`Mock-butik på http://localhost:${PORT} -> app ${APP}`));
