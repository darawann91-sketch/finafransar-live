// Thin wrapper around Shopify's storefront Ajax Cart API. The viewer page is
// served on the shop's own domain (App Proxy), so these calls hit the REAL
// cart – the same one as the theme's cart drawer and checkout.
const json = async (res) => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.description || body.message || `Cart error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
};

const post = (path, data) =>
  fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(data),
  }).then(json);

export const Cart = {
  get: () => fetch('/cart.js', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(json),
  add: (variantId, quantity, liveId) => post('/cart/add.js', { items: [{ id: Number(variantId), quantity, properties: { _live: liveId } }] }),
  change: (key, quantity) => post('/cart/change.js', { id: key, quantity }),
  attributes: (attrs) => post('/cart/update.js', { attributes: attrs }),
  applyDiscount: (code) => post('/cart/update.js', { discount: code }),
};

export const cartDiscountCodes = (cart) =>
  (cart?.discount_codes || []).filter((d) => d.applicable !== false).map((d) => String(d.code).toUpperCase());
