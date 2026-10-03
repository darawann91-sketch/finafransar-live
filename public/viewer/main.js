// Finafransar LIVE – viewer app (served on the storefront via App Proxy).
import { I } from './icons.js';
import { Cart, cartDiscountCodes } from './cart.js';
import { createSocket } from '../stream/socket.js';
import { createPlayer } from '../stream/player.js';

const boot = JSON.parse(document.getElementById('ffl-boot').textContent);
const app = document.getElementById('app');
const LS_PREVIEW = `ffl_pv_${boot.liveId}`;
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const S = {
  live: null,
  products: [],
  activeId: null,
  deal: null,
  pinned: null,
  viewers: 0,
  likes: 0,
  me: { guest: boot.viewer.guest, name: boot.viewer.name, mutedUntil: 0 },
  cart: null,
  serverOffset: 0,
  soundOn: false,
  state: 'loading', // live | gate | ended | blocked
  chatVisible: true,
  attrSet: false,
  openProductId: boot.openProductId,
};
let player = null;
let socket = null;

// Embedded as the full-screen takeover on the storefront homepage.
const EMBED = (() => { try { return window.top !== window.self; } catch { return true; } })();
function go(url) {
  try { if (EMBED) { window.top.location.href = url; return; } } catch {}
  location.href = url;
}
function closeEmbed() {
  try { window.parent.postMessage({ type: 'ffl-live-close' }, location.origin); } catch {}
}
if (EMBED) {
  document.documentElement.classList.add('ffl-embed');
  // Links (login, product pages, store) must open in the full window, not inside the frame.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank') return;
    e.preventDefault();
    if (a.getAttribute('href') === boot.storeUrl) return closeEmbed();
    go(a.href);
  }, true);
}


// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // ONLY for static icons
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const put = (el, ...kids) => el && el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const $ = (sel, root = document) => root.querySelector(sel);
const fmtCount = (n) => {
  n = Number(n) || 0;
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace('.0', '').replace('.', ',') + 'K';
  if (n < 1_000_000) return Math.round(n / 1000) + 'K';
  return (n / 1_000_000).toFixed(1).replace('.0', '').replace('.', ',') + 'M';
};
const fmtKr = (v) => `${Number(v).toLocaleString('sv-SE', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })} kr`;
const serverNow = () => Date.now() + S.serverOffset;
const track = (name, data) => socket?.send({ t: 'event', name, data });
const loginUrl = (productId) => {
  const back = `${boot.pathPrefix}/${boot.liveId}?auth=1${productId ? `&p=${productId}` : ''}`;
  return `/customer_authentication/login?return_to=${encodeURIComponent(back)}`;
};

let toastTimer;
function toast(text, ms = 2600) {
  const t = $('.toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------
function render() {
  put(app,
    h('section', { class: 'stage', 'aria-label': 'Livevideo' },
      h('video', { id: 'video', playsinline: true, 'webkit-playsinline': true, autoplay: true, muted: true }),
      h('div', { class: 'status-msg', role: 'status' }, h('div', { class: 'spinner' }), h('span', { id: 'status-text' }, 'Ansluter till liven…')),
      h('header', { class: 'topbar' },
        h('span', { class: 'badge-live' }, 'LIVE'),
        h('span', { class: 'pill', 'aria-label': 'Tittare' }, h('span', { html: I.eye }), h('span', { id: 'viewers' }, '0')),
        h('div', { class: 'host-chip' }, h('b', { id: 'live-title' }, boot.title), h('span', {}, 'FINAFRANSAR')),
        h('button', { class: 'icon-btn', 'aria-label': 'Dela liven', onclick: share, html: I.share }),
        h('a', { class: 'icon-btn', href: boot.storeUrl, 'aria-label': 'Stäng', html: I.x })
      ),
      h('button', { class: 'cart-pill', id: 'cart-pill', onclick: () => openCart() }, h('span', { html: I.cart }), h('span', { id: 'cart-pill-text' }, '')),
      h('button', { class: 'sound-btn', id: 'sound-btn', onclick: enableSound }, h('span', { html: I.muted }), 'Tryck för ljud'),
      h('div', { class: 'hearts', id: 'hearts', 'aria-hidden': 'true' }),
      h('nav', { class: 'rail' },
        h('button', { class: 'rail-btn like', id: 'like-btn', 'aria-label': 'Gilla', onclick: like }, h('span', { class: 'ico', html: I.heartFill }), h('span', { id: 'likes' }, '0')),
        h('button', { class: 'rail-btn opt-chat', 'aria-label': 'Visa/dölj chatt', onclick: toggleChat }, h('span', { class: 'ico', html: I.chat }), h('span', {}, 'Chatt')),
        h('button', { class: 'rail-btn', 'aria-label': 'Shoppa', onclick: openShop }, h('span', { class: 'ico', html: I.bag }), h('span', { id: 'shop-count' }, 'Shoppa')),
        h('button', { class: 'rail-btn opt-share', 'aria-label': 'Dela', onclick: share }, h('span', { class: 'ico', html: I.share }), h('span', {}, 'Dela'))
      ),
      gateOverlay(),
      h('div', { class: 'overlay', id: 'ended' })
    ),
    h('section', { class: 'bottom' },
      h('div', { class: 'chat', id: 'chat' },
        h('div', { class: 'pinned', id: 'pinned' }),
        h('div', { class: 'chat-feed', id: 'feed', 'aria-live': 'polite' })
      ),
      h('div', { class: 'deal', id: 'deal', role: 'status' },
        h('div', { class: 'deal-l' },
          h('div', { class: 'k' }, '🔥 LIVE DEAL · ', h('b', { id: 'deal-code' }, '')),
          h('div', { class: 'v', id: 'deal-v' }, '')
        ),
        h('div', { class: 'timer', id: 'deal-timer' }, ''),
        h('button', { class: 'use', id: 'deal-use', onclick: applyDeal }, 'ANVÄND')
      ),
      h('div', { class: 'product-card', id: 'product-card', role: 'button', tabindex: '0', 'aria-label': 'Visa produkten', onclick: () => S.activeId && openProduct(S.activeId), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && S.activeId && openProduct(S.activeId) }),
      composer()
    ),
    h('section', { class: 'shop-row', id: 'shop-row' }, h('h3', {}, 'SHOPPA LIVE'), h('div', { class: 'row', id: 'shop-row-list' })),
    h('div', { class: 'backdrop', id: 'backdrop', onclick: closeSheets }),
    sheet('product', ''),
    sheet('shop', 'SHOPPA LIVE'),
    sheet('cart', 'DIN VARUKORG'),
    sheet('share', 'DELA LIVEN'),
    h('div', { class: 'toast', role: 'status', 'aria-live': 'assertive' })
  );
  S.state = 'live';
  app.dataset.state = 'live';
  app.dataset.video = 'connecting';
}

function composer() {
  if (S.me.guest) {
    return h('div', { class: 'composer' },
      h('a', { class: 'guest-cta', id: 'guest-cta', href: loginUrl() }, 'Logga in för att chatta och shoppa'),
      h('button', { class: 'shop', onclick: openShop, 'aria-label': 'Shoppa', html: I.bag })
    );
  }
  const input = h('input', { id: 'chat-input', type: 'text', maxlength: 200, placeholder: 'Skriv ett meddelande…', enterkeyhint: 'send', autocomplete: 'off', 'aria-label': 'Skriv ett meddelande' });
  const form = h('form', { class: 'field', onsubmit: (e) => { e.preventDefault(); sendChat(input); } }, input, h('button', { class: 'send', type: 'submit', 'aria-label': 'Skicka', html: I.send }));
  return h('div', { class: 'composer' }, form, h('button', { class: 'shop', onclick: openShop, 'aria-label': 'Shoppa' }, h('span', { html: I.bag }), h('span', { class: 'n', id: 'shop-n' }, '0')));
}

function gateOverlay() {
  return h('div', { class: 'overlay', id: 'gate', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gate-h' },
    h('div', { class: 'card' },
      h('div', { class: 'brand' }, 'FINAFRANSAR LIVE'),
      h('h2', { id: 'gate-h' }, 'Fortsätt titta på Finafransar LIVE'),
      h('p', {}, 'Skapa ett gratis konto för att fortsätta titta, chatta och shoppa.'),
      h('div', { class: 'perks' }, h('span', {}, '🔴 Se hela liven'), h('span', {}, '💬 Chatta'), h('span', {}, '🛍️ Live-deals')),
      h('a', { class: 'btn btn-light', id: 'gate-signup', href: loginUrl() }, 'SKAPA KONTO'),
      h('a', { class: 'btn btn-ghost', id: 'gate-login', href: loginUrl(), style: 'color:#fff' }, 'LOGGA IN')
    )
  );
}

function sheet(name, title) {
  return h('div', { class: 'sheet', id: `sheet-${name}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Produkt' },
    h('div', { class: 'grab' }),
    h('header', {}, h('h2', { id: `sheet-${name}-title` }, title), h('button', { class: 'x', 'aria-label': 'Stäng', onclick: closeSheets, html: I.x })),
    h('div', { class: 'body', id: `sheet-${name}-body` }),
    h('footer', { id: `sheet-${name}-foot` })
  );
}

// ---------------------------------------------------------------------------
// sheets
// ---------------------------------------------------------------------------
let openSheet = null;
function showSheet(name) {
  closeSheets(true);
  openSheet = name;
  $('#backdrop').classList.add('show');
  $(`#sheet-${name}`).classList.add('show');
}
function closeSheets(keepBackdrop) {
  document.querySelectorAll('.sheet.show').forEach((s) => s.classList.remove('show'));
  if (keepBackdrop !== true) $('#backdrop')?.classList.remove('show');
  openSheet = null;
}
// swipe-down to close (mobile)
document.addEventListener('touchstart', (e) => {
  const sh = e.target.closest?.('.sheet');
  if (!sh || !e.target.closest('.grab, header')) return;
  const y0 = e.touches[0].clientY;
  const move = (ev) => {
    const dy = ev.touches[0].clientY - y0;
    if (dy > 0) sh.style.transform = `translateY(${dy}px)`;
  };
  const end = (ev) => {
    const dy = (ev.changedTouches[0]?.clientY || y0) - y0;
    sh.style.transform = '';
    if (dy > 90) closeSheets();
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', end);
  };
  document.addEventListener('touchmove', move, { passive: true });
  document.addEventListener('touchend', end);
}, { passive: true });

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------
const productById = (id) => S.products.find((p) => p.id === String(id));
const priceHtml = (price, compare, varies) => {
  const frag = document.createDocumentFragment();
  frag.append(`${varies ? 'från ' : ''}${fmtKr(price)}`);
  if (compare && compare > price) frag.append(h('s', {}, fmtKr(compare)));
  return frag;
};

function renderProductCard() {
  const card = $('#product-card');
  const p = productById(S.activeId);
  if (!p) {
    card.classList.remove('show');
    return;
  }
  card.classList.toggle('sold-out', !p.available);
  put(card, 
    h('img', { src: thumb(p.image, 180), alt: '', loading: 'eager' }),
    h('div', { class: 'pc-info' },
      h('div', { class: 'eyebrow' }, '📌 VI VISAR NU'),
      h('div', { class: 't' }, p.title),
      h('div', { class: 'p' }, priceHtml(p.price, p.compareAtPrice, p.priceVaries))
    ),
    h('span', { class: 'buy-btn' }, p.available ? 'KÖP' : 'SLUTSÅLD')
  );
  card.classList.add('show');
}

const thumb = (url, w) => (url ? `${url}${url.includes('?') ? '&' : '?'}width=${w}` : '');

function productTile(p, onclick) {
  return h('button', { class: `pitem${p.available ? '' : ' sold'}`, onclick },
    p.id === S.activeId ? h('span', { class: 'now' }, 'VISAS NU') : null,
    h('img', { src: thumb(p.image, 400), alt: '', loading: 'lazy' }),
    h('div', { class: 'meta' }, h('div', { class: 't' }, p.title), h('div', { class: 'p' }, p.available ? priceHtml(p.price, null, p.priceVaries) : 'Slutsåld'))
  );
}

function renderShopLists() {
  const n = S.products.length;
  const sc = $('#shop-count');
  if (sc) sc.textContent = n ? `Shoppa (${n})` : 'Shoppa';
  const sn = $('#shop-n');
  if (sn) sn.textContent = String(n);
  const row = $('#shop-row-list');
  if (row) put(row, ...S.products.map((p) => productTile(p, () => openProduct(p.id))));
  if (openSheet === 'shop') fillShop();
}

function openShop() {
  fillShop();
  showSheet('shop');
  track('shop_open');
}
function fillShop() {
  const body = $('#sheet-shop-body');
  put($('#sheet-shop-foot'), );
  if (!S.products.length) {
    put(body, h('p', { class: 'empty' }, 'Produkterna visas här så fort hosten lägger till dem.'));
    return;
  }
  const sorted = [...S.products].sort((a, b) => (b.id === S.activeId) - (a.id === S.activeId));
  put(body, h('div', { class: 'plist' }, sorted.map((p) => productTile(p, () => openProduct(p.id)))));
}

// Product bottom sheet with variant picker + quantity
let pd = null;
function openProduct(id) {
  const p = productById(id);
  if (!p) return;
  const first = p.variants.find((v) => v.available) || p.variants[0];
  pd = { p, sel: [...(first?.options || [])], qty: 1 };
  fillProduct();
  showSheet('product');
  track('product_view', { productId: p.id });
}

function currentVariant() {
  if (!pd) return null;
  const { p, sel } = pd;
  if (!p.options.length) return p.variants[0];
  return p.variants.find((v) => v.options.every((o, i) => o === sel[i])) || null;
}

function fillProduct() {
  const { p } = pd;
  const v = currentVariant();
  $('#sheet-product-title').textContent = productById(S.activeId)?.id === p.id ? '📌 VISAS NU' : 'PRODUKT';
  const opts = p.options.map((o, oi) =>
    h('div', { class: 'opt' },
      h('div', { class: 'lbl' }, o.name.toUpperCase(), h('span', {}, pd.sel[oi] || '')),
      h('div', { class: 'chips', role: 'radiogroup', 'aria-label': o.name },
        o.values.map((val) => {
          const possible = p.variants.some((vv) => vv.available && vv.options[oi] === val && vv.options.every((x, i) => i === oi || x === pd.sel[i] || p.options.length === 1));
          return h('button', {
            class: `chip${pd.sel[oi] === val ? ' on' : ''}`, role: 'radio', 'aria-checked': pd.sel[oi] === val ? 'true' : 'false', disabled: !possible,
            onclick: () => { pd.sel[oi] = val; fillProduct(); },
          }, val);
        })
      )
    )
  );
  const max = 20;
  const qtyOut = h('output', {}, String(pd.qty));
  put($('#sheet-product-body'), 
    h('div', { class: 'pd-gallery' }, (p.images.length ? p.images : [p.image]).filter(Boolean).map((src) => h('img', { src: thumb(src, 800), alt: p.title }))),
    h('h3', { class: 'pd-title' }, p.title),
    h('div', { class: 'pd-price' },
      v ? fmtKr(v.price) : fmtKr(p.price),
      v?.compareAtPrice && v.compareAtPrice > v.price ? [h('s', {}, fmtKr(v.compareAtPrice)), h('span', { class: 'save' }, `−${Math.round((1 - v.price / v.compareAtPrice) * 100)}%`)] : null
    ),
    ...opts,
    h('div', { class: 'qty-row' },
      h('span', { class: 'lbl' }, 'ANTAL'),
      h('div', { class: 'stepper' },
        h('button', { 'aria-label': 'Minska', onclick: () => { pd.qty = Math.max(1, pd.qty - 1); qtyOut.textContent = pd.qty; } }, '−'),
        qtyOut,
        h('button', { 'aria-label': 'Öka', onclick: () => { pd.qty = Math.min(max, pd.qty + 1); qtyOut.textContent = pd.qty; } }, '+')
      )
    ),
    v?.lowStock ? h('div', { class: 'low' }, 'Få kvar i lager') : null,
    p.description ? h('p', { class: 'pd-desc' }, p.description) : null,
    h('a', { href: p.url, style: 'display:inline-block;margin-top:6px;font-size:13px;color:#555' }, 'Mer om produkten i butiken →')
  );
  const canBuy = v && v.available;
  const btn = h('button', { class: 'btn btn-primary', id: 'add-btn', disabled: !canBuy, onclick: () => addToCart(p, v, btn) },
    h('span', { html: I.cart }), canBuy ? 'LÄGG I VARUKORG' : v ? 'SLUTSÅLD' : 'VÄLJ ALTERNATIV');
  put($('#sheet-product-foot'), btn);
}

async function addToCart(p, v, btn) {
  if (S.me.guest) {
    go(loginUrl(p.id));
    return;
  }
  btn.disabled = true;
  const label = btn.lastChild.textContent;
  btn.lastChild.textContent = 'LÄGGER TILL…';
  try {
    await Cart.add(v.id, pd.qty, boot.liveId);
    if (!S.attrSet) {
      S.attrSet = true;
      Cart.attributes({ _finafransar_live: boot.liveId }).catch(() => (S.attrSet = false));
    }
    if (S.deal && !S.dealApplied) Cart.applyDiscount(S.deal.code).then(() => (S.dealApplied = true)).catch(() => {});
    track('add_to_cart', { productId: p.id, variantId: v.id, quantity: pd.qty, value: v.price * pd.qty });
    await refreshCart();
    closeSheets();
    toast(`✓ ${p.title} ligger i varukorgen`);
    navigator.vibrate?.(30);
  } catch (e) {
    toast(e.status === 422 ? e.message : 'Kunde inte lägga i varukorgen. Försök igen.');
  } finally {
    btn.disabled = false;
    btn.lastChild.textContent = label;
  }
}

// ---------------------------------------------------------------------------
// cart
// ---------------------------------------------------------------------------
async function refreshCart() {
  try {
    S.cart = await Cart.get();
    S.dealApplied = !!(S.deal && cartDiscountCodes(S.cart).includes(S.deal.code));
  } catch {
    return;
  }
  const pill = $('#cart-pill');
  const n = S.cart.item_count;
  if (n > 0) {
    $('#cart-pill-text').textContent = `${n} ${n === 1 ? 'produkt' : 'produkter'} · ${fmtKr(S.cart.total_price / 100)}`;
    pill.classList.add('show');
  } else pill.classList.remove('show');
  if (openSheet === 'cart') fillCart();
  renderDeal();
}

function openCart() {
  fillCart();
  showSheet('cart');
  track('cart_open');
  refreshCart();
}

function fillCart() {
  const c = S.cart;
  const body = $('#sheet-cart-body');
  const foot = $('#sheet-cart-foot');
  if (!c || !c.item_count) {
    put(body, h('p', { class: 'empty' }, 'Din varukorg är tom.'), h('button', { class: 'btn btn-primary', onclick: openShop }, 'SHOPPA LIVE-PRODUKTER'));
    put(foot, );
    return;
  }
  put(body, 
    ...c.items.map((it) => {
      const out = h('output', {}, String(it.quantity));
      return h('div', { class: 'cart-line' },
        h('img', { src: thumb(it.image, 160), alt: '' }),
        h('div', { class: 'm' },
          h('div', { class: 't' }, it.product_title),
          it.variant_title ? h('div', { class: 'v' }, it.variant_title) : null,
          h('div', { class: 'r' },
            h('div', { class: 'stepper' },
              h('button', { 'aria-label': 'Minska', onclick: () => changeLine(it, it.quantity - 1) }, it.quantity === 1 ? '×' : '−'),
              out,
              h('button', { 'aria-label': 'Öka', onclick: () => changeLine(it, it.quantity + 1) }, '+')
            ),
            h('span', { class: 'lp' }, fmtKr(it.final_line_price / 100))
          )
        )
      );
    })
  );
  const orig = c.original_total_price ?? c.items_subtotal_price;
  put(foot, 
    S.dealApplied ? h('div', { class: 'applied' }, `✓ Live-koden ${S.deal.code} är aktiverad`) : null,
    S.deal && !S.dealApplied ? h('button', { class: 'btn btn-gold', style: 'height:46px;margin-bottom:10px', onclick: applyDeal }, `🔥 ANVÄND ${S.deal.code} (−${S.deal.percent}%)`) : null,
    h('div', { class: 'totals' }, h('span', { class: 'k' }, 'TOTALT'), h('span', { class: 'v' }, orig > c.total_price ? h('s', {}, fmtKr(orig / 100)) : null, fmtKr(c.total_price / 100))),
    h('button', { class: 'btn btn-primary', onclick: checkout }, 'TILL KASSAN')
  );
}

async function changeLine(item, qty) {
  try {
    await Cart.change(item.key, Math.max(0, qty));
  } catch (e) {
    toast(e.message || 'Kunde inte uppdatera');
  }
  refreshCart();
}

function checkout() {
  track('checkout', { value: (S.cart?.total_price || 0) / 100 });
  const q = S.deal && !S.dealApplied ? `?discount=${encodeURIComponent(S.deal.code)}` : '';
  go(`/checkout${q}`);
}

// ---------------------------------------------------------------------------
// deal
// ---------------------------------------------------------------------------
let dealTimer = null;
function renderDeal() {
  const el = $('#deal');
  if (!el) return;
  clearInterval(dealTimer);
  if (!S.deal || S.deal.endsAt <= serverNow()) {
    el.classList.remove('show');
    return;
  }
  $('#deal-v').textContent = `${S.deal.percent} % rabatt`;
  $('#deal-code').textContent = S.deal.code;
  const use = $('#deal-use');
  use.textContent = S.dealApplied ? '✓ AKTIV' : 'ANVÄND';
  use.disabled = !!S.dealApplied;
  const tick = () => {
    const ms = S.deal ? S.deal.endsAt - serverNow() : 0;
    if (ms <= 0) {
      el.classList.remove('show');
      clearInterval(dealTimer);
      return;
    }
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    $('#deal-timer').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  tick();
  dealTimer = setInterval(tick, 1000);
  el.classList.add('show');
}

async function applyDeal() {
  if (!S.deal) return;
  if (S.me.guest) return go(loginUrl());
  try {
    await Cart.applyDiscount(S.deal.code);
    S.dealApplied = true;
    toast(`🔥 ${S.deal.code} aktiverad – ${S.deal.percent} % dras i kassan`);
  } catch {
    try { await navigator.clipboard.writeText(S.deal.code); toast(`Koden ${S.deal.code} är kopierad – klistra in i kassan`); } catch { toast(`Använd koden ${S.deal.code} i kassan`); }
  }
  refreshCart();
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------
function msgEl(m) {
  const mine = !S.me.guest && m.name === S.me.name && m.role === 'viewer' && m._mine;
  return h('div', { class: `msg${m.role === 'host' ? ' host' : ''}${mine ? ' mine' : ''}`, dataset: { id: m.id }, onclick: (e) => msgMenu(e, m) },
    m.role === 'host' ? h('span', { class: 'tag' }, 'HOST') : null,
    h('b', {}, m.name),
    m.text
  );
}

function addMessages(list, replace = false) {
  const feed = $('#feed');
  if (!feed) return;
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  if (replace) put(feed, );
  for (const m of list) feed.append(msgEl(m));
  while (feed.childElementCount > 80) feed.firstElementChild.remove();
  if (nearBottom || replace) feed.scrollTop = feed.scrollHeight;
}

function renderPinned() {
  const el = $('#pinned');
  if (!el) return;
  if (!S.pinned) return el.classList.remove('show');
  put(el, h('span', { class: 'pin-ico' }, '📌'), h('span', {}, h('b', {}, S.pinned.name), S.pinned.text));
  el.classList.add('show');
}

let pendingMine = [];
function sendChat(input) {
  const text = input.value.trim();
  if (!text) return;
  if (S.me.mutedUntil > Date.now()) return toast('Du är tillfälligt pausad från chatten');
  socket.send({ t: 'chat', text });
  pendingMine.push(text);
  if (pendingMine.length > 5) pendingMine.shift();
  input.value = '';
}

function msgMenu(ev, m) {
  document.querySelector('.msg-menu')?.remove();
  if (S.me.guest || m.role === 'host' || m._mine) return;
  const menu = h('div', { class: 'msg-menu', role: 'menu' },
    h('button', { role: 'menuitem', onclick: () => { socket.send({ t: 'report', messageId: m.id }); menu.remove(); } }, '⚑ Rapportera kommentar')
  );
  const r = ev.currentTarget.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, innerWidth - 220)}px`;
  menu.style.top = `${Math.max(10, r.top - 54)}px`;
  document.body.append(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

function toggleChat() {
  S.chatVisible = !S.chatVisible;
  $('#chat').classList.toggle('hidden', !S.chatVisible);
}

// ---------------------------------------------------------------------------
// likes
// ---------------------------------------------------------------------------
let likeQueue = 0;
let myRecentLikes = 0;
const HEART_COLORS = ['#ff2d55', '#ff6f91', '#c9a961', '#ffffff', '#ff8fab'];
function spawnHeart() {
  const layer = $('#hearts');
  if (!layer || layer.childElementCount > 36) return;
  const el = h('span', { class: 'heart', html: I.heartFill });
  el.style.color = HEART_COLORS[(Math.random() * HEART_COLORS.length) | 0];
  el.style.setProperty('--dx', `${Math.round(-50 + Math.random() * 60)}px`);
  el.style.setProperty('--rot', `${Math.round(-25 + Math.random() * 50)}deg`);
  el.style.animationDuration = `${1.8 + Math.random() * 1.2}s`;
  el.addEventListener('animationend', () => el.remove());
  layer.append(el);
}
function like() {
  if (S.me.guest) return toast('Skapa ett gratis konto för att gilla 💛');
  likeQueue++;
  myRecentLikes++;
  S.likes++;
  $('#likes').textContent = fmtCount(S.likes);
  $('#like-btn').classList.add('liked');
  spawnHeart();
  navigator.vibrate?.(8);
}
// Tap anywhere on the video to like (TikTok-style): a heart pops where the finger is.
let lastGuestToast = 0;
function tapHeart(x, y) {
  const el = h('span', { class: 'tap-heart', html: I.heartFill });
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty('--rot', `${Math.round(-20 + Math.random() * 40)}deg`);
  el.addEventListener('animationend', () => el.remove());
  document.body.append(el);
}
document.addEventListener('pointerup', (e) => {
  if (S.state !== 'live' || openSheet) return;
  const t = e.target;
  if (!t.closest?.('.stage')) return;
  if (t.closest('button, a, input, .product-card, .deal, .msg, .msg-menu, .overlay, .topbar, .rail, .chat, .composer, .cart-pill, .sound-btn')) return;
  if (S.me.guest) {
    if (Date.now() - lastGuestToast > 4000) { lastGuestToast = Date.now(); toast('Skapa ett gratis konto för att gilla 💛'); }
    return;
  }
  tapHeart(e.clientX, e.clientY);
  like();
});

setInterval(() => {
  if (likeQueue > 0 && socket) {
    socket.send({ t: 'like', n: Math.min(likeQueue, 20) });
    likeQueue = 0;
  }
}, 350);

// ---------------------------------------------------------------------------
// share
// ---------------------------------------------------------------------------
async function share() {
  const url = boot.shareUrl;
  const data = { title: `Finafransar LIVE: ${S.live?.title || boot.title}`, text: 'Kolla! Finafransar kör live just nu 💛', url };
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share(data);
      track('share', { channel: 'native' });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  const msg = `${data.text} ${url}`;
  const input = h('input', { value: url, readonly: true, 'aria-label': 'Länk till liven' });
  const item = (label, icon, href, channel) =>
    h('a', { href, target: '_blank', rel: 'noopener', onclick: () => track('share', { channel }) }, h('span', { class: 'ic', html: icon }), label);
  put($('#sheet-share-body'), 
    h('div', { class: 'share-grid' },
      item('WhatsApp', I.whatsapp, `https://wa.me/?text=${encodeURIComponent(msg)}`, 'whatsapp'),
      item('SMS', I.sms, `sms:?&body=${encodeURIComponent(msg)}`, 'sms'),
      item('Messenger', I.messenger, `fb-messenger://share/?link=${encodeURIComponent(url)}`, 'messenger'),
      h('button', { onclick: copyLink }, h('span', { class: 'ic', html: I.link }), 'Kopiera')
    ),
    h('div', { class: 'share-link' }, input, h('button', { onclick: copyLink }, 'KOPIERA'))
  );
  put($('#sheet-share-foot'), );
  showSheet('share');
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      input.select();
      document.execCommand?.('copy');
    }
    track('share', { channel: 'copy' });
    toast('Länken är kopierad ✓');
  }
}

// ---------------------------------------------------------------------------
// video + preview gate
// ---------------------------------------------------------------------------
function setVideoState(st) {
  app.dataset.video = st;
  const t = $('#status-text');
  if (t) t.textContent = st === 'reconnecting' ? 'Återansluter…' : st === 'waiting' ? 'Väntar på hosten…' : 'Ansluter till liven…';
  if (st === 'playing') {
    $('#sound-btn')?.classList.toggle('show', !S.soundOn);
    if (S.me.guest) startPreviewTimer();
  }
  if (st === 'full') {
    app.dataset.video = 'waiting';
    if (t) t.textContent = 'Liven är fullsatt just nu – vi försöker igen…';
    setTimeout(startVideo, 8000);
  }
}

async function startVideo() {
  if (S.state !== 'live') return;
  if (S.me.guest && ls.get(LS_PREVIEW)) return showGate();
  try {
    const res = await fetch(`${boot.api}/api/stream/viewer`, { method: 'POST', headers: { Authorization: `Bearer ${boot.token}` } });
    if (res.status === 403) return showGate();
    if (!res.ok) throw new Error('creds ' + res.status);
    const creds = await res.json();
    player?.disconnect();
    player = await createPlayer(creds, $('#video'), {
      vendor: boot.vendor,
      signal: socket,
      onState: setVideoState,
    });
  } catch (e) {
    console.warn('video', e);
    setTimeout(startVideo, 4000);
  }
}

let previewTimer = null;
function startPreviewTimer() {
  if (previewTimer) return;
  previewTimer = setTimeout(showGate, boot.previewSeconds * 1000);
}

function showGate() {
  if (S.state === 'gate') return;
  S.state = 'gate';
  ls.set(LS_PREVIEW, String(Date.now()));
  app.dataset.state = 'gate';
  closeSheets();
  freezeFrame();
  player?.disconnect();
  const pid = pd?.p?.id || S.activeId;
  $('#gate-signup').href = loginUrl(pid);
  $('#gate-login').href = loginUrl(pid);
  $('#gate').classList.add('show');
}

// Keep the last frame (blurred) behind the overlay instead of a black screen.
function freezeFrame() {
  const v = $('#video');
  try {
    if (!v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = Math.min(480, v.videoWidth);
    c.height = Math.round((c.width / v.videoWidth) * v.videoHeight);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    v.poster = c.toDataURL('image/jpeg', 0.7);
    v.srcObject = null;
  } catch {}
}

async function enableSound() {
  S.soundOn = true;
  $('#sound-btn').classList.remove('show');
  const v = $('#video');
  v.muted = false;
  try { await player?.startAudio(); } catch {}
  track('sound_on');
}

function showEnded() {
  S.state = 'ended';
  app.dataset.state = 'ended';
  freezeFrame();
  player?.disconnect();
  closeSheets();
  const hasCart = S.cart?.item_count > 0;
  put($('#ended'), 
    h('div', { class: 'card' },
      h('div', { class: 'brand' }, 'FINAFRANSAR LIVE'),
      h('h2', {}, 'Liven är slut – tack för att du tittade!'),
      h('p', {}, hasCart ? 'Din varukorg är sparad. Slutför köpet innan live-erbjudandet går ut.' : 'Alla produkter från liven finns kvar i butiken.'),
      hasCart ? h('button', { class: 'btn btn-light', onclick: checkout }, 'TILL KASSAN') : null,
      h('a', { class: 'btn btn-ghost', href: boot.storeUrl, style: 'color:#fff' }, 'FORTSÄTT SHOPPA')
    )
  );
  $('#ended').classList.add('show');
}

// ---------------------------------------------------------------------------
// realtime
// ---------------------------------------------------------------------------
function connect() {
  socket = createSocket({
    url: boot.ws,
    liveId: boot.liveId,
    getToken: async () => boot.token,
    onStatus: (st) => {
      if (st === 'blocked') {
        S.state = 'blocked';
        player?.disconnect();
        toast('Du har blockerats från Finafransar LIVE', 6000);
      }
      if (st === 'unavailable') showEnded();
    },
  });

  socket.on('hello', (m) => {
    S.serverOffset = m.serverNow - Date.now();
    S.live = m.live;
    S.products = m.products;
    S.activeId = m.activeProductId;
    S.deal = m.deal;
    S.pinned = m.pinned;
    S.viewers = m.viewers;
    S.likes = Math.max(S.likes, m.likes);
    S.me = { ...S.me, ...m.me };
    $('#live-title').textContent = m.live.title;
    $('#viewers').textContent = fmtCount(m.viewers);
    $('#likes').textContent = fmtCount(S.likes);
    addMessages(m.messages, true);
    renderPinned();
    renderProductCard();
    renderShopLists();
    renderDeal();
    if (m.live.status === 'ended') return showEnded();
    if (!player && S.state === 'live') startVideo();
    if (S.openProductId && productById(S.openProductId)) {
      openProduct(S.openProductId);
      S.openProductId = null;
      history.replaceState(null, '', location.pathname);
    }
  });
  socket.on('viewers', (m) => ($('#viewers').textContent = fmtCount(m.n)));
  socket.on('likes', (m) => {
    S.likes = Math.max(S.likes, m.total);
    $('#likes').textContent = fmtCount(S.likes);
    const others = Math.max(0, m.burst - myRecentLikes);
    myRecentLikes = 0;
    for (let i = 0; i < Math.min(others, 8); i++) setTimeout(spawnHeart, i * 110);
  });
  socket.on('chat', (m) => {
    const i = pendingMine.indexOf(m.m.text);
    if (i >= 0 && m.m.name === S.me.name) {
      m.m._mine = true;
      pendingMine.splice(i, 1);
    }
    addMessages([m.m]);
  });
  socket.on('chat_del', (m) => {
    for (const id of m.ids) document.querySelector(`.msg[data-id="${id}"]`)?.remove();
    if (S.pinned && m.ids.includes(S.pinned.id)) { S.pinned = null; renderPinned(); }
  });
  socket.on('pinned', (m) => { S.pinned = m.m; renderPinned(); });
  socket.on('product', (m) => {
    S.activeId = m.productId;
    renderProductCard();
    renderShopLists();
    if (m.productId) navigator.vibrate?.(15);
  });
  socket.on('products', (m) => {
    S.products = m.products;
    renderProductCard();
    renderShopLists();
    if (openSheet === 'product' && pd) {
      const fresh = productById(pd.p.id);
      if (fresh) { pd.p = fresh; fillProduct(); }
    }
  });
  socket.on('deal', (m) => {
    const isNew = m.deal && (!S.deal || S.deal.code !== m.deal.code);
    S.deal = m.deal;
    S.dealApplied = !!(S.deal && S.cart && cartDiscountCodes(S.cart).includes(S.deal.code));
    renderDeal();
    if (isNew) { toast(`🔥 LIVE DEAL: ${m.deal.percent} % med koden ${m.deal.code}`, 4000); navigator.vibrate?.([20, 40, 20]); }
    if (openSheet === 'cart') fillCart();
  });
  socket.on('live', (m) => { S.live = m.live; $('#live-title').textContent = m.live.title; });
  socket.on('live_status', (m) => m.status === 'ended' && showEnded());
  socket.on('preview_over', showGate);
  socket.on('muted', (m) => { S.me.mutedUntil = m.until; toast('Du har pausats från chatten en stund'); });
  socket.on('reported', () => toast('Tack! Kommentaren är rapporterad.'));
  socket.on('error', (m) => {
    const texts = {
      muted: 'Du är tillfälligt pausad från chatten',
      chat_slow: 'Lugnt – vänta ett par sekunder',
      chat_rejected: 'Meddelandet kunde inte skickas',
      login_required: 'Logga in för att chatta',
      blocked: 'Du kan inte chatta',
      slow_down: 'För många klick – vänta lite',
    };
    if (texts[m.code]) toast(texts[m.code]);
  });
}

// Keep the right rail above the product card / deal (chat is narrower, so it may sit beside the rail).
function layoutRail() {
  const bottom = $('.bottom');
  const chat = $('#chat');
  const rail = $('.rail');
  const hearts = $('#hearts');
  if (!bottom || !rail) return;
  if (matchMedia('(min-width: 960px)').matches) { rail.style.bottom = hearts.style.bottom = ''; return; }
  const chatH = chat.classList.contains('hidden') ? 0 : chat.offsetHeight + 10;
  const px = bottom.offsetHeight - chatH + 6;
  rail.style.bottom = `${px}px`;
  hearts.style.bottom = `${px + rail.offsetHeight - 40}px`;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
render();
new ResizeObserver(layoutRail).observe($('.bottom'));
addEventListener('resize', layoutRail);
connect();
refreshCart();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const v = $('#video');
    if (v && v.paused && S.state === 'live') v.play().catch(() => {});
    refreshCart();
  }
});
// First touch anywhere also unlocks audio-capable playback on iOS.
document.addEventListener('touchend', () => { const v = $('#video'); if (v?.paused && S.state === 'live') v.play().catch(() => {}); }, { once: true, passive: true });
