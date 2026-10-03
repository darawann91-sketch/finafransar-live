// Finafransar LIVE Studio – host/admin app (served on the live app domain).
import { createSocket } from '../stream/socket.js';
import { createPublisher } from '../stream/publisher.js';

const root = document.getElementById('studio');
const VENDOR = { livekit: '/static/vendor/livekit-client.esm.mjs' };
const A = { host: null, csrf: null, provider: null };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const put = (el, ...kids) => el && el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
const $ = (s, r = document) => r.querySelector(s);
const kr = (v) => `${Number(v || 0).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} kr`;
const num = (v) => Number(v || 0).toLocaleString('sv-SE');
const ERR = {
  invalid_credentials: 'Fel e-post eller lösenord', too_many_attempts: 'För många försök – vänta 15 minuter',
  login_required: 'Logga in igen', forbidden: 'Du har inte behörighet', csrf: 'Sessionen har gått ut – ladda om sidan',
  product_not_in_live: 'Lägg först till produkten i live-produkterna', no_live_products: 'Lägg till live-produkter först (eller välj Hela butiken)',
  invalid_code: 'Koden får bara innehålla A–Z, 0–9, - och _', not_live: 'Liven är inte igång', weak_password: 'Lösenordet måste vara minst 12 tecken',
  email_taken: 'E-posten används redan', shopify_discount_failed: 'Shopify kunde inte skapa rabattkoden', code_taken: 'Koden finns redan – välj en annan',
};
let toastT;
function toast(t, ms = 2600) {
  let el = $('.toast');
  if (!el) document.body.append((el = h('div', { class: 'toast', role: 'status' })));
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), ms);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(A.csrf && method !== 'GET' ? { 'X-CSRF-Token': A.csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/me') showLogin();
    const e = new Error(ERR[j.error] || j.message || 'Något gick fel');
    e.code = j.error;
    throw e;
  }
  return j;
}
const guard = (fn) => async (...a) => {
  try { return await fn(...a); } catch (e) { toast(e.message); }
};

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------
function showLogin() {
  teardownStudio();
  const err = h('div', { class: 'err', role: 'alert' });
  const email = h('input', { class: 'in', type: 'email', autocomplete: 'username', required: true, id: 'email' });
  const pw = h('input', { class: 'in', type: 'password', autocomplete: 'current-password', required: true, id: 'password' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'LOGGA IN');
  put(root, 
    h('div', { class: 'login' },
      h('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          err.textContent = '';
          try {
            const r = await api('POST', '/api/auth/login', { email: email.value, password: pw.value });
            Object.assign(A, { host: r.host, csrf: r.csrf, provider: r.provider });
            history.replaceState(null, '', '/admin');
            showDashboard();
          } catch (e2) {
            err.textContent = e2.message;
          } finally {
            btn.disabled = false;
          }
        },
      },
        h('div', { class: 'k' }, 'FINAFRANSAR LIVE'),
        h('h1', {}, 'Creator login'),
        h('label', { class: 'f' }, h('span', {}, 'E-POST'), email),
        h('label', { class: 'f' }, h('span', {}, 'LÖSENORD'), pw),
        err,
        btn
      )
    )
  );
}

const logout = guard(async () => {
  await api('POST', '/api/auth/logout');
  A.host = A.csrf = null;
  showLogin();
});

function brandbar(...right) {
  return h('div', { class: 'brandbar' },
    h('div', { class: 'logo' }, 'FINAFRANSAR ', h('b', {}, 'LIVE'), ' STUDIO'),
    h('div', { class: 'sp' }),
    ...right,
    h('button', { class: 'linkbtn', onclick: logout }, 'Logga ut')
  );
}

// ---------------------------------------------------------------------------
// dashboard
// ---------------------------------------------------------------------------
let dashTab = 'lives';
async function showDashboard() {
  teardownStudio();
  history.replaceState(null, '', '/admin');
  const isAdmin = A.host.role === 'admin';
  const tabs = h('div', { class: 'tabs-top' },
    [['lives', 'Lives'], ...(isAdmin ? [['hosts', 'Hosts'], ['blocks', 'Blockerade']] : []), ['account', 'Konto']].map(([k, t]) =>
      h('button', { class: dashTab === k ? 'on' : '', onclick: () => { dashTab = k; showDashboard(); } }, t))
  );
  const body = h('div', {});
  put(root, h('div', { class: 'wrap' }, brandbar(h('span', { class: 'muted' }, `${A.host.name} · ${A.host.role === 'admin' ? 'Admin' : 'Host'}`)), tabs, body));
  if (dashTab === 'lives') return renderLives(body);
  if (dashTab === 'hosts') return renderHosts(body);
  if (dashTab === 'blocks') return renderBlocks(body);
  return renderAccount(body);
}

async function renderLives(body) {
  const { lives } = await api('GET', '/api/studio/lives');
  const title = h('input', { class: 'in', placeholder: 'Kvällens lash live', maxlength: 80, id: 'new-title' });
  put(body, 
    h('div', { class: 'card' },
      h('h3', {}, 'NY LIVE'),
      h('label', { class: 'f' }, h('span', {}, 'LIVE-TITEL'), title),
      h('button', { class: 'btn gold block', id: 'create-live', onclick: guard(async () => {
        const { live } = await api('POST', '/api/studio/lives', { title: title.value || 'Kvällens lash live', description: '' });
        openStudio(live.id);
      }) }, '＋ SKAPA LIVE')
    ),
    h('div', { class: 'card' },
      h('h3', {}, 'DINA LIVES'),
      lives.length
        ? h('div', { class: 'lives' }, lives.map((l) => h('button', { class: 'live-row', onclick: () => openStudio(l.id) },
          h('span', { class: `tag ${l.status}` }, l.status === 'live' ? '🔴 LIVE' : l.status === 'draft' ? 'UTKAST' : 'AVSLUTAD'),
          h('div', { class: 'm' }, h('div', { class: 't' }, l.title), h('div', { class: 's' }, `${new Date(l.startedAt || l.createdAt).toLocaleString('sv-SE', { dateStyle: 'medium', timeStyle: 'short' })} · ❤️ ${num(l.likes)} · topp ${num(l.peakViewers)} tittare`)),
          h('span', { class: 'muted' }, '›'))))
        : h('p', { class: 'muted' }, 'Inga lives ännu.')
    )
  );
}

async function renderHosts(body) {
  const { hosts } = await api('GET', '/api/admin/hosts');
  const f = { email: h('input', { class: 'in', type: 'email' }), name: h('input', { class: 'in' }), pw: h('input', { class: 'in', type: 'password', autocomplete: 'new-password', minlength: 12 }), role: h('select', { class: 'in' }, h('option', { value: 'host' }, 'Host'), h('option', { value: 'admin' }, 'Admin')) };
  put(body, 
    h('div', { class: 'card' },
      h('h3', {}, 'HOSTS'),
      h('table', { class: 'table' },
        h('tr', {}, h('th', {}, 'NAMN'), h('th', {}, 'ROLL'), h('th', {}, 'STATUS'), h('th', {}, '')),
        hosts.map((x) => h('tr', {},
          h('td', {}, x.name, h('div', { class: 'muted' }, x.email)),
          h('td', {}, x.role === 'admin' ? 'Admin' : 'Host'),
          h('td', {}, x.active ? 'Aktiv' : 'Avstängd'),
          h('td', {}, x.id === A.host.id ? '' : h('button', { class: 'btn sm ghost', onclick: guard(async () => { await api('PATCH', `/api/admin/hosts/${x.id}`, { active: !x.active }); renderHosts(body); }) }, x.active ? 'Stäng av' : 'Aktivera'))
        ))
      )
    ),
    h('div', { class: 'card' },
      h('h3', {}, 'LÄGG TILL HOST'),
      h('div', { class: 'row2' }, h('label', { class: 'f' }, h('span', {}, 'NAMN'), f.name), h('label', { class: 'f' }, h('span', {}, 'ROLL'), f.role)),
      h('label', { class: 'f' }, h('span', {}, 'E-POST'), f.email),
      h('label', { class: 'f' }, h('span', {}, 'TILLFÄLLIGT LÖSENORD (MINST 12 TECKEN)'), f.pw),
      h('button', { class: 'btn primary block', onclick: guard(async () => {
        await api('POST', '/api/admin/hosts', { email: f.email.value, name: f.name.value, password: f.pw.value, role: f.role.value });
        toast('Host skapad');
        renderHosts(body);
      }) }, 'SKAPA HOST')
    )
  );
}

async function renderBlocks(body) {
  const { blocks } = await api('GET', '/api/admin/blocks');
  put(body, h('div', { class: 'card' }, h('h3', {}, 'BLOCKERADE TITTARE'),
    blocks.length ? h('table', { class: 'table' }, blocks.map((b) => h('tr', {},
      h('td', {}, b.name || b.sub, h('div', { class: 'muted' }, b.reason || '')),
      h('td', {}, new Date(b.created_at).toLocaleDateString('sv-SE')),
      h('td', {}, h('button', { class: 'btn sm ghost', onclick: guard(async () => { await api('DELETE', `/api/admin/blocks/${encodeURIComponent(b.sub)}`); renderBlocks(body); }) }, 'Häv'))
    ))) : h('p', { class: 'muted' }, 'Ingen är blockerad.')));
}

function renderAccount(body) {
  const cur = h('input', { class: 'in', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'in', type: 'password', autocomplete: 'new-password' });
  put(body, h('div', { class: 'card' }, h('h3', {}, 'BYT LÖSENORD'),
    h('label', { class: 'f' }, h('span', {}, 'NUVARANDE'), cur),
    h('label', { class: 'f' }, h('span', {}, 'NYTT (MINST 12 TECKEN)'), next),
    h('button', { class: 'btn primary block', onclick: guard(async () => { await api('POST', '/api/auth/password', { current: cur.value, next: next.value }); toast('Lösenordet är bytt'); cur.value = next.value = ''; }) }, 'SPARA')));
}

// ---------------------------------------------------------------------------
// LIVE STUDIO
// ---------------------------------------------------------------------------
const ST = {};
function teardownStudio() {
  ST.socket?.close();
  ST.publisher?.stop();
  ST.stream?.getTracks().forEach((t) => t.stop());
  clearInterval(ST.clock);
  clearInterval(ST.statsTimer);
  clearInterval(ST.dealTimer);
  ST.wakeLock?.release?.().catch(() => {});
  for (const k of Object.keys(ST)) delete ST[k];
}

async function openStudio(liveId) {
  teardownStudio();
  history.replaceState(null, '', `/admin/live/${liveId}`);
  const d = await api('GET', `/api/studio/lives/${liveId}`);
  Object.assign(ST, {
    id: liveId, live: d.live, products: d.products, activeId: d.activeProductId, deal: d.deal, pinnedId: d.pinnedMessageId,
    tab: 'products', facing: 'user', micOn: true, viewers: 0, likes: d.live.likes, reports: 0, messages: [],
  });
  renderStudio();
  connectHostSocket();
  if (ST.live.status === 'live') {
    await startCamera().catch(() => {});
    if (ST.stream) await publish().catch((e) => toast('Kunde inte återansluta sändningen: ' + e.message));
  }
  if (ST.live.status === 'ended') { ST.tab = 'stats'; renderTabs(); }
  ST.statsTimer = setInterval(() => ST.tab === 'stats' && loadStats(), 10_000);
}

function renderStudio() {
  const L = ST.live;
  const isLive = L.status === 'live';
  const ended = L.status === 'ended';
  put(root, 
    h('div', { class: 'wrap' },
      brandbar(h('button', { class: 'linkbtn', onclick: () => showDashboard() }, '‹ Alla lives')),
      h('div', { class: 'st-head' },
        h('span', { class: `status${isLive ? ' live' : ''}`, id: 'status' }, isLive ? 'LIVE' : ended ? 'AVSLUTAD' : 'OFFLINE'),
        h('span', { class: 'metric', id: 'clock' }, isLive ? '00:00' : '–'),
        h('span', { class: 'metric' }, '👁 ', h('span', { id: 'm-viewers' }, num(ST.viewers))),
        h('span', { class: 'metric' }, '❤️ ', h('span', { id: 'm-likes' }, num(ST.likes)))
      ),
      h('div', { class: 'st-grid' },
        h('div', { class: 'st-left' },
          h('div', { class: 'preview' },
            h('video', { id: 'preview', playsinline: true, autoplay: true, muted: true, class: 'mirror' }),
            h('div', { class: 'pv-hearts', id: 'pv-hearts', 'aria-hidden': 'true' }),
            h('div', { class: 'pv-chat', id: 'pv-chat', 'aria-live': 'polite' }),
            h('div', { class: 'ph', id: 'ph' }, ended ? 'Liven är avslutad.' : 'Kameran är av. Tryck ”Aktivera kamera” – webbläsaren frågar om kamera och mikrofon.')
          ),
          ended ? null : h('div', { class: 'dev-row' },
            h('button', { class: 'btn', id: 'cam-btn', onclick: guard(startCamera) }, '📷 Aktivera kamera'),
            h('button', { class: 'btn', id: 'flip-btn', onclick: guard(flipCamera) }, '🔄 Byt kamera'),
            h('button', { class: 'btn', id: 'mic-btn', onclick: toggleMic }, h('span', { class: 'mic-on' }, '●'), ' Mikrofon')
          ),
          ended ? null : h('div', { class: 'dev-row' }, h('select', { class: 'in', id: 'cam-select', 'aria-label': 'Kamera', onchange: guard(() => startCamera({ deviceId: $('#cam-select').value })) }), h('select', { class: 'in', id: 'mic-select', 'aria-label': 'Mikrofon', onchange: guard(() => startCamera({ micId: $('#mic-select').value })) })),
          ended ? null : h('div', { style: 'margin-top:12px' },
            isLive
              ? h('button', { class: 'btn red block go-live', id: 'end-btn', onclick: endLiveClick }, '■ AVSLUTA LIVE')
              : h('button', { class: 'btn primary block go-live', id: 'go-live', onclick: guard(goLive) }, '🔴 STARTA LIVE')
          ),
          h('div', { class: 'card', style: 'margin-top:12px' },
            h('h3', {}, 'DELNINGSLÄNK'),
            h('div', { class: 'share-box' }, h('input', { class: 'in', readonly: true, value: L.shareUrl, id: 'share-url' }), h('button', { class: 'btn', onclick: () => { navigator.clipboard?.writeText(L.shareUrl); toast('Länken är kopierad'); } }, 'Kopiera')),
            A.provider === 'devmesh' ? h('p', { class: 'muted' }, 'Utvecklingsläge (dev mesh) – inte för riktiga sändningar.') : null
          )
        ),
        h('div', { class: 'st-right' },
          h('div', { class: 'tabs', id: 'tabs' }),
          h('div', { style: 'margin-top:12px' },
            h('section', { class: 'panel', id: 'p-details' }),
            h('section', { class: 'panel', id: 'p-products' }),
            h('section', { class: 'panel', id: 'p-chat' }),
            h('section', { class: 'panel', id: 'p-deal' }),
            h('section', { class: 'panel', id: 'p-stats' })
          )
        )
      )
    )
  );
  renderTabs();
  renderDetails();
  renderProducts();
  renderChat();
  renderDeal();
  if (isLive) startClock();
}

function renderTabs() {
  const tabs = [['products', 'Produkter'], ['chat', 'Chatt'], ['deal', 'Deal'], ['details', 'Titel'], ['stats', 'Statistik']];
  put($('#tabs'), ...tabs.map(([k, t]) =>
    h('button', { class: ST.tab === k ? 'on' : '', onclick: () => { ST.tab = k; renderTabs(); if (k === 'stats') loadStats(); } },
      t, k === 'chat' && ST.reports ? h('span', { class: 'dot' }, String(ST.reports)) : null)));
  for (const [k] of tabs) $(`#p-${k}`).classList.toggle('on', ST.tab === k);
}

function startClock() {
  clearInterval(ST.clock);
  const t0 = ST.live.startedAt;
  const tick = () => {
    const s = Math.max(0, Math.floor((Date.now() - t0) / 1000));
    const hh = Math.floor(s / 3600);
    $('#clock').textContent = `${hh ? hh + ':' : ''}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  ST.clock = setInterval(tick, 1000);
}

// ---- details --------------------------------------------------------------
function renderDetails() {
  const t = h('input', { class: 'in', maxlength: 80, value: ST.live.title, id: 'title' });
  const d = h('textarea', { class: 'in', maxlength: 500, id: 'desc' });
  d.value = ST.live.description || '';
  const save = guard(async () => {
    const { live } = await api('PATCH', `/api/studio/lives/${ST.id}`, { title: t.value, description: d.value });
    ST.live = { ...ST.live, ...live };
    toast('Sparat');
  });
  put($('#p-details'), h('div', { class: 'card' },
    h('label', { class: 'f' }, h('span', {}, 'LIVE-TITEL'), t),
    h('label', { class: 'f' }, h('span', {}, 'BESKRIVNING'), d),
    h('button', { class: 'btn primary block', onclick: save }, 'SPARA')));
}

// ---- products ---------------------------------------------------------------
function renderProducts() {
  const ids = ST.products.map((p) => p.id);
  const results = h('div', { id: 'search-results' });
  const q = h('input', { class: 'in', placeholder: 'Sök produkt… t.ex. franslim', id: 'product-search', type: 'search', enterkeyhint: 'search' });
  let deb;
  const search = async () => {
    const { products } = await api('GET', `/api/studio/products?q=${encodeURIComponent(q.value)}`);
    put(results, ...products.map((p) => h('div', { class: 'prod' },
      h('img', { src: p.image ? `${p.image}${p.image.includes('?') ? '&' : '?'}width=120` : '', alt: '' }),
      h('div', { class: 'm' }, h('div', { class: 't' }, p.title), h('div', { class: 'p' }, `${kr(p.price)} · ${p.totalInventory ?? '–'} i lager`)),
      ids.includes(p.id)
        ? h('button', { class: 'btn sm ghost', disabled: true }, '✓ Vald')
        : h('button', { class: 'btn sm primary', onclick: guard(async () => saveProducts([...ids, p.id])) }, 'VÄLJ')
    )));
  };
  q.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(guard(search), 280); });

  put($('#p-products'), 
    h('div', { class: 'card' },
      h('h3', {}, `LIVE-PRODUKTER (${ST.products.length})`),
      ST.products.length ? null : h('p', { class: 'muted' }, 'Sök och välj de Shopify-produkter du ska visa. Tryck ”VISA NU” när du visar en produkt – den dyker upp hos alla tittare direkt.'),
      ST.products.map((p, i) => h('div', { class: `prod${p.id === ST.activeId ? ' active' : ''}` },
        h('img', { src: p.image ? `${p.image}${p.image.includes('?') ? '&' : '?'}width=120` : '', alt: '' }),
        h('div', { class: 'm' }, h('div', { class: 't' }, p.title), h('div', { class: 'p' }, `${p.priceVaries ? 'från ' : ''}${kr(p.price)}${p.available ? '' : ' · SLUTSÅLD'}`)),
        h('div', { class: 'acts' },
          h('button', { class: `show-now${p.id === ST.activeId ? ' on' : ''}`, 'data-pid': p.id, onclick: guard(() => setActive(p.id === ST.activeId ? null : p.id)) }, p.id === ST.activeId ? '📌 VISAS' : 'VISA NU'),
          h('button', { class: 'iconbtn', 'aria-label': 'Flytta upp', disabled: i === 0, onclick: guard(() => { const a = [...ids]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; return saveProducts(a); }) }, '▲'),
          h('button', { class: 'iconbtn', 'aria-label': 'Ta bort', onclick: guard(() => saveProducts(ids.filter((x) => x !== p.id))) }, '✕')
        )
      ))
    ),
    h('div', { class: 'card' }, h('h3', {}, 'SÖK PRODUKT'), q, h('div', { style: 'margin-top:10px' }, results))
  );
  guard(search)();
}

async function saveProducts(ids) {
  const { products } = await api('PUT', `/api/studio/lives/${ST.id}/products`, { productIds: ids });
  ST.products = products;
  if (ST.activeId && !products.some((p) => p.id === ST.activeId)) ST.activeId = null;
  const q = $('#product-search')?.value;
  renderProducts();
  if (q) { $('#product-search').value = q; $('#product-search').dispatchEvent(new Event('input')); }
}

async function setActive(pid) {
  const { activeProductId } = await api('POST', `/api/studio/lives/${ST.id}/active-product`, { productId: pid });
  ST.activeId = activeProductId;
  renderProducts();
  toast(pid ? '📌 Produkten visas nu för alla tittare' : 'Produktkortet är dolt');
}

// ---- chat / moderation ----------------------------------------------------
function renderChat() {
  const list = h('div', { class: 'chat-list', id: 'chat-list' });
  const input = h('input', { class: 'in', placeholder: 'Skriv som host…', maxlength: 200, id: 'host-chat' });
  put($('#p-chat'), 
    h('div', { class: 'card' },
      h('h3', {}, 'CHATT'),
      list,
      h('form', { class: 'send-row', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) { ST.socket?.send({ t: 'chat', text: input.value }); input.value = ''; } } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Skicka')),
      ST.pinnedId ? h('button', { class: 'btn sm ghost', style: 'margin-top:10px', onclick: guard(async () => { await api('POST', `/api/studio/lives/${ST.id}/pin`, { messageId: null }); }) }, 'Ta bort fäst kommentar') : null
    ),
    h('div', { class: 'card', id: 'reports-card' }, h('h3', {}, `RAPPORTERADE (${ST.reports})`), h('div', { id: 'reports' }))
  );
  for (const m of ST.messages) list.append(chatRow(m));
  list.scrollTop = list.scrollHeight;
  loadReports();
}

function chatRow(m) {
  const row = h('div', { class: `cmsg${m.role === 'host' ? ' host' : ''}${m.id === ST.pinnedId ? ' pinned' : ''}`, 'data-id': m.id },
    h('b', {}, m.role === 'host' ? `${m.name} (host)` : m.name), m.text);
  const act = (label, fn, cls = 'ghost') => h('button', { class: `btn sm ${cls}`, onclick: guard(async (e) => { e.stopPropagation(); await fn(); }) }, label);
  const acts = h('div', { class: 'acts' },
    act(m.id === ST.pinnedId ? 'Lossa' : '📌 Fäst', () => api('POST', `/api/studio/lives/${ST.id}/pin`, { messageId: m.id === ST.pinnedId ? null : m.id })),
    act('🗑 Radera', () => api('POST', `/api/studio/lives/${ST.id}/messages/${m.id}/delete`)),
    m.role === 'viewer' ? act('🔇 Muta 10 min', async () => { await api('POST', `/api/studio/lives/${ST.id}/messages/${m.id}/mute`, { minutes: 10 }); toast(`${m.name} är mutad i 10 min`); }) : null,
    m.role === 'viewer' ? act('⛔ Blockera', async () => { await api('POST', `/api/studio/lives/${ST.id}/messages/${m.id}/block`, { reason: 'Blockerad från studion' }); toast(`${m.name} är blockerad`); }, 'red') : null
  );
  row.append(acts);
  row.addEventListener('click', () => row.classList.toggle('open'));
  return row;
}

async function loadReports() {
  const el = $('#reports');
  if (!el) return;
  const { reports } = await api('GET', `/api/studio/lives/${ST.id}/reports`).catch(() => ({ reports: [] }));
  ST.reports = reports.length;
  $('#reports-card h3').textContent = `RAPPORTERADE (${reports.length})`;
  put(el, ...(reports.length ? reports.map((r) => h('div', { class: 'cmsg open' },
    h('b', {}, r.name), r.text, h('div', { class: 'muted' }, `${r.reports} rapport${r.reports > 1 ? 'er' : ''}`),
    h('div', { class: 'acts' },
      h('button', { class: 'btn sm ghost', onclick: guard(async () => { await api('POST', `/api/studio/lives/${ST.id}/messages/${r.message_id}/delete`); loadReports(); }) }, 'Radera'),
      h('button', { class: 'btn sm red', onclick: guard(async () => { await api('POST', `/api/studio/lives/${ST.id}/messages/${r.message_id}/block`, { reason: 'Rapporterad' }); loadReports(); }) }, 'Blockera'),
      h('button', { class: 'btn sm ghost', onclick: guard(async () => { await api('POST', `/api/studio/lives/${ST.id}/messages/${r.message_id}/dismiss`); loadReports(); }) }, 'Ignorera')
    ))) : [h('p', { class: 'muted' }, 'Inga rapporterade kommentarer.')]));
  renderTabs();
}

// ---- deal ---------------------------------------------------------------------
function renderDeal() {
  clearInterval(ST.dealTimer);
  const el = $('#p-deal');
  if (ST.deal && ST.deal.endsAt > Date.now()) {
    const tm = h('div', { class: 'tm' });
    const tick = () => {
      const ms = ST.deal ? ST.deal.endsAt - Date.now() : 0;
      if (ms <= 0) { ST.deal = null; return renderDeal(); }
      tm.textContent = `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')} kvar`;
    };
    tick();
    ST.dealTimer = setInterval(tick, 1000);
    put(el, h('div', { class: 'deal-live' },
      h('div', { class: 'muted' }, '🔥 LIVE DEAL AKTIV'),
      h('div', { class: 'v' }, `${ST.deal.percent} % RABATT`),
      h('div', { class: 'c' }, `Kod: ${ST.deal.code}`),
      tm,
      h('div', { class: 'muted', style: 'margin-bottom:12px' }, ST.deal.scope === 'all' ? 'Gäller hela butiken' : 'Gäller live-produkterna'),
      h('button', { class: 'btn ghost block', id: 'end-deal', onclick: guard(async () => { await api('DELETE', `/api/studio/lives/${ST.id}/deal`); ST.deal = null; renderDeal(); toast('Dealen är avslutad'); }) }, 'AVSLUTA DEAL NU')));
    return;
  }
  const f = { percent: 20, minutes: 15, scope: 'live_products' };
  const code = h('input', { class: 'in', value: 'LIVE20', maxlength: 24, id: 'deal-code', style: 'text-transform:uppercase' });
  let codeTouched = false;
  code.addEventListener('input', () => (codeTouched = true));
  const chipRow = (vals, key, fmt) => {
    const row = h('div', { class: 'chips' });
    const draw = () => put(row, ...vals.map((v) => h('button', { class: `chip${f[key] === v ? ' on' : ''}`, onclick: () => { f[key] = v; if (key === 'percent' && !codeTouched) code.value = `LIVE${v}`; draw(); } }, fmt(v))));
    draw();
    return row;
  };
  put(el, h('div', { class: 'card' },
    h('h3', {}, 'LIVE DEAL'),
    h('p', { class: 'muted' }, 'Skapar en riktig Shopify-rabattkod som slutar gälla automatiskt när nedräkningen är slut. Alla tittare ser samma nedräkning.'),
    h('label', { class: 'f' }, h('span', {}, 'RABATT')), chipRow([10, 15, 20, 25, 30, 40], 'percent', (v) => `${v} %`),
    h('label', { class: 'f' }, h('span', {}, 'TID')), chipRow([5, 10, 15, 30, 60], 'minutes', (v) => `${v} min`),
    h('label', { class: 'f' }, h('span', {}, 'GÄLLER')), chipRow(['live_products', 'all'], 'scope', (v) => (v === 'all' ? 'Hela butiken' : 'Live-produkter')),
    h('label', { class: 'f' }, h('span', {}, 'KOD'), code),
    h('button', { class: 'btn gold block', id: 'start-deal', disabled: ST.live.status !== 'live', onclick: guard(async () => {
      const { deal } = await api('POST', `/api/studio/lives/${ST.id}/deal`, { percent: f.percent, minutes: f.minutes, scope: f.scope, code: code.value.toUpperCase() });
      ST.deal = deal;
      renderDeal();
      toast(`🔥 ${deal.code} är aktiv`);
    }) }, ST.live.status === 'live' ? '🔥 AKTIVERA LIVE DEAL' : 'Starta liven först')));
}

// ---- stats --------------------------------------------------------------------
async function loadStats() {
  const s = await api('GET', `/api/studio/lives/${ST.id}/stats`).catch(() => null);
  if (!s) return;
  const conv = s.totalViewers ? ((s.purchases / s.totalViewers) * 100).toFixed(1).replace('.', ',') : '0';
  const tile = (k, v, big) => h('div', { class: `stat${big ? ' big' : ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const fmtDur = (sec) => `${Math.floor(sec / 60)} min ${sec % 60} s`;
  const pmap = new Map(ST.products.map((p) => [p.id, p.title]));
  put($('#p-stats'), 
    h('div', { class: 'stats' },
      tile('Köp', num(s.purchases)), tile('Omsättning', kr(s.revenue)),
      tile('Tittare nu', num(s.viewersNow)), tile('Peak', num(s.peakViewers)),
      tile('Totalt tittare', num(s.totalViewers)), tile('Snittid', fmtDur(s.avgWatchSeconds)),
      tile('Likes', num(s.likes)), tile('Kommentarer', num(s.comments)),
      tile('Delningar', num(s.shares)), tile('Från delade länkar', num(s.visitorsFromShare)),
      tile('Produktvisningar', num(s.productViews)), tile('Lägg i varukorg', num(s.addToCart)),
      tile('Till kassan', num(s.checkouts)), tile('Konvertering', `${conv} %`),
      tile('Nya konton', num(s.registrations)), tile('Inloggningar', num(s.logins)),
      tile('Preview startade', num(s.previewStarts)), tile('Preview 10 s klar', num(s.previewCompletions))
    ),
    s.products.addToCart.length ? h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'MEST TILLAGDA'),
      h('table', { class: 'table' }, s.products.addToCart.slice(0, 10).map((r) => h('tr', {}, h('td', {}, pmap.get(r.product_id) || r.product_id), h('td', {}, `${num(r.qty)} st`))))) : null,
    h('p', { class: 'muted', style: 'margin-top:10px' }, 'Köp räknas när Shopify skickar ordern (orders/create) med live-märkningen från varukorgen.')
  );
}

// ---------------------------------------------------------------------------
// camera, microphone, broadcast
// ---------------------------------------------------------------------------
async function startCamera(opts = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Webbläsaren stöder inte kamera. Använd Safari eller Chrome via https.');
  const maxH = 1080; // matches server ladder; desktop 1440/2160 is negotiated by the browser if available
  const video = {
    width: { ideal: Math.round((maxH * 16) / 9) }, height: { ideal: maxH }, frameRate: { ideal: 30, max: 30 },
    ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : { facingMode: { ideal: ST.facing } }),
  };
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(opts.micId ? { deviceId: { exact: opts.micId } } : {}) };
  // iOS only allows one camera stream at a time: stop the old one first.
  ST.stream?.getVideoTracks().forEach((t) => t.stop());
  const fresh = await navigator.mediaDevices.getUserMedia({ video, audio });
  const old = ST.stream;
  ST.stream = fresh;
  fresh.getAudioTracks().forEach((t) => (t.enabled = ST.micOn));
  old?.getTracks().forEach((t) => t.stop());
  const v = $('#preview');
  v.srcObject = fresh;
  v.classList.toggle('mirror', ST.facing === 'user' && !opts.deviceId);
  $('#ph').style.display = 'none';
  $('#cam-btn').textContent = '📷 Kamera aktiv';
  if (ST.publisher) {
    await ST.publisher.replaceVideoTrack(fresh.getVideoTracks()[0]);
    await ST.publisher.replaceAudioTrack(fresh.getAudioTracks()[0]);
    ST.publisher.setStream?.(fresh);
  }
  await fillDevices();
}

async function fillDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const curCam = ST.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  const curMic = ST.stream?.getAudioTracks()[0]?.getSettings().deviceId;
  put($('#cam-select'), ...cams.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === curCam }, d.label || `Kamera ${i + 1}`)));
  put($('#mic-select'), ...mics.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === curMic }, d.label || `Mikrofon ${i + 1}`)));
}

async function flipCamera() {
  ST.facing = ST.facing === 'user' ? 'environment' : 'user';
  await startCamera();
  toast(ST.facing === 'user' ? 'Frontkamera' : 'Bakre kamera');
}

function toggleMic() {
  ST.micOn = !ST.micOn;
  ST.stream?.getAudioTracks().forEach((t) => (t.enabled = ST.micOn));
  ST.publisher?.setMicEnabled(ST.micOn);
  put($('#mic-btn'), h('span', { class: ST.micOn ? 'mic-on' : 'mic-off' }, '●'), ST.micOn ? ' Mikrofon' : ' Mikrofon av');
  toast(ST.micOn ? 'Mikrofonen är på' : 'Mikrofonen är avstängd');
}

async function goLive() {
  if (!ST.stream) await startCamera();
  const btn = $('#go-live');
  btn.disabled = true;
  btn.textContent = 'STARTAR…';
  try {
    const { live, stream } = await api('POST', `/api/studio/lives/${ST.id}/start`);
    ST.live = live;
    await publish(stream);
    renderStudio();
    $('#preview').srcObject = ST.stream;
    $('#ph').style.display = 'none';
    $('#cam-btn').textContent = '📷 Kamera aktiv';
    await fillDevices();
    toast('🔴 Du är LIVE!');
    try { ST.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '🔴 STARTA LIVE';
    throw e;
  }
}

async function publish(creds) {
  if (!creds) creds = (await api('GET', `/api/studio/lives/${ST.id}/stream`)).stream;
  ST.publisher?.stop();
  ST.publisher = await createPublisher(creds, ST.stream, {
    signal: ST.socket,
    vendor: VENDOR,
    onState: (s) => {
      if (s === 'reconnecting') toast('Sändningen återansluter…');
      if (s === 'disconnected' && ST.live?.status === 'live') toast('Sändningen bröts – försöker igen', 4000);
    },
  });
}

let endArmed = false;
function endLiveClick() {
  const b = $('#end-btn');
  if (!endArmed) {
    endArmed = true;
    b.textContent = 'TRYCK IGEN FÖR ATT AVSLUTA';
    setTimeout(() => { endArmed = false; if ($('#end-btn')) $('#end-btn').textContent = '■ AVSLUTA LIVE'; }, 3000);
    return;
  }
  guard(async () => {
    const { live } = await api('POST', `/api/studio/lives/${ST.id}/end`);
    ST.publisher?.stop();
    ST.publisher = null;
    ST.stream?.getTracks().forEach((t) => t.stop());
    ST.stream = null;
    ST.live = live;
    ST.deal = null;
    ST.tab = 'stats';
    ST.wakeLock?.release?.().catch(() => {});
    renderStudio();
    loadStats();
    toast('Liven är avslutad');
  })();
}

// re-acquire wake lock when returning to the tab
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && ST.live?.status === 'live') {
    try { ST.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
});

// ---------------------------------------------------------------------------
// host websocket
// ---------------------------------------------------------------------------
function connectHostSocket() {
  const s = createSocket({
    url: location.origin.replace(/^http/, 'ws') + '/ws',
    liveId: ST.id,
    getToken: async () => (await api('GET', `/api/studio/lives/${ST.id}/ws-token`)).token,
  });
  ST.socket = s;
  s.on('hello', (m) => {
    ST.viewers = m.viewers;
    ST.likes = m.likes;
    ST.messages = m.messages;
    ST.pinnedId = m.pinned?.id || null;
    ST.reports = m.reports || 0;
    $('#m-viewers').textContent = num(m.viewers);
    $('#m-likes').textContent = num(m.likes);
    put($('#pv-chat'));
    m.messages.slice(-5).forEach(previewChat);
    if (ST.tab !== 'chat') renderChat();
    else renderChat();
    renderTabs();
  });
  s.on('viewers', (m) => { ST.viewers = m.n; $('#m-viewers') && ($('#m-viewers').textContent = num(m.n)); });
  s.on('likes', (m) => {
    ST.likes = m.total;
    $('#m-likes') && ($('#m-likes').textContent = num(m.total));
    for (let i = 0; i < Math.min(m.burst || 1, 8); i++) setTimeout(previewHeart, i * 120);
  });
  s.on('chat', (m) => {
    previewChat(m.m);
    ST.messages.push(m.m);
    if (ST.messages.length > 200) ST.messages.shift();
    const list = $('#chat-list');
    if (!list) return;
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.append(chatRow(m.m));
    if (near) list.scrollTop = list.scrollHeight;
  });
  s.on('chat_del', (m) => {
    ST.messages = ST.messages.filter((x) => !m.ids.includes(x.id));
    m.ids.forEach((id) => document.querySelector(`.cmsg[data-id="${id}"]`)?.remove());
  });
  s.on('pinned', (m) => { ST.pinnedId = m.m?.id || null; renderChat(); });
  s.on('reports', (m) => { ST.reports = m.count; loadReports(); });
  s.on('products', (m) => { ST.products = m.products; });
  s.on('deal', (m) => { ST.deal = m.deal; renderDeal(); });
}

// Comments + hearts on top of the host's own camera preview (like TikTok),
// so the host can read the chat without leaving the camera view.
function previewChat(m) {
  const box = $('#pv-chat');
  if (!box || !m) return;
  const el = h('div', { class: `pv-msg${m.role === 'host' ? ' host' : ''}` }, h('b', {}, m.name), ' ', m.text);
  box.append(el);
  while (box.childElementCount > 6) box.firstElementChild.remove();
}
const HEART_COLORS = ['#ff2d55', '#ff6f91', '#c9a961', '#ffffff'];
function previewHeart() {
  const layer = $('#pv-hearts');
  if (!layer || layer.childElementCount > 30) return;
  const el = h('span', { class: 'pv-heart' }, '❤');
  el.style.color = HEART_COLORS[(Math.random() * HEART_COLORS.length) | 0];
  el.style.setProperty('--dx', `${Math.round(-40 + Math.random() * 50)}px`);
  el.addEventListener('animationend', () => el.remove());
  layer.append(el);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async () => {
  try {
    const me = await api('GET', '/api/auth/me');
    Object.assign(A, { host: me.host, csrf: me.csrf, provider: me.provider });
    const m = location.pathname.match(/^\/admin\/live\/([a-z0-9]+)/);
    if (m) await openStudio(m[1]).catch(() => showDashboard());
    else showDashboard();
  } catch {
    showLogin();
  }
})();
