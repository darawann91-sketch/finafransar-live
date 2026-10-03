// End-to-end test of the whole journey with real browsers (Chromium, fake
// camera), the real live server, dev-mesh WebRTC and the mock storefront.
//   node test/e2e.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let pw;
for (const p of ['playwright', '/home/claude/.npm-global/lib/node_modules/playwright']) {
  try { pw = require(p); break; } catch {}
}
const { chromium, devices } = pw;

const APP = 'http://localhost:8080';
const STORE = 'http://localhost:3001';
const SHOTS = process.env.SHOTS || 'test/screenshots';
mkdirSync(SHOTS, { recursive: true });
const env = {
  ...process.env,
  NODE_ENV: 'development',
  STORE_URL: STORE,
  PUBLIC_URL: APP,
  DATA_DIR: mkdtempSync(path.join(tmpdir(), 'ffl-e2e-')),
  ADMIN_EMAIL: 'lela@finafransar.test',
  ADMIN_PASSWORD: 'testlosenord-123456',
  PREVIEW_SECONDS: '10',
};

const procs = [];
const start = (file) => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[${file}] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`[${file} ERR] ${d}`));
  procs.push(p);
};
start('src/server.js');
start('dev/storefront-mock.js');
await new Promise((r) => setTimeout(r, 1500));

let failures = 0;
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`✅ ${name} (${Date.now() - t0} ms)`);
    console.log(results.at(-1));
  } catch (e) {
    failures++;
    results.push(`❌ ${name}: ${process.env.VERBOSE_ERR ? e.message.split('\n').slice(0,14).join(' / ') : e.message.split('\n')[0]}`);
    console.log(results.at(-1));
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const pageErrors = [];
const watch = (page, label) => {
  page.setDefaultTimeout(10000);
  page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.g|cdn\.shopify|ERR_|Failed to load resource/.test(m.text()) && pageErrors.push(`${label} console: ${m.text()}`));
};
const videoPlaying = (page) => page.waitForFunction(() => { const v = document.querySelector('#video'); return v && v.readyState >= 2 && v.videoWidth > 0 && !v.paused; }, null, { timeout: 20000 });

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

// ---------------------------------------------------------------- HOST
const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera', 'microphone'] });
const host = await hostCtx.newPage();
watch(host, 'host');
let liveId;

await step('Host: /admin visar creator login', async () => {
  await host.goto(`${APP}/admin`);
  await host.waitForSelector('text=Creator login');
  await host.screenshot({ path: `${SHOTS}/01-host-login.png` });
});
await step('Host: fel lösenord nekas', async () => {
  await host.fill('#email', 'lela@finafransar.test');
  await host.fill('#password', 'fel-losenord-xx');
  await host.click('button[type=submit]');
  await host.waitForSelector('text=Fel e-post eller lösenord');
});
await step('Host: inloggning + skapa live', async () => {
  await host.fill('#password', 'testlosenord-123456');
  await host.click('button[type=submit]');
  await host.waitForSelector('#create-live');
  await host.fill('#new-title', 'Kvällens lash live');
  await host.click('#create-live');
  await host.waitForSelector('#go-live');
  liveId = host.url().match(/live\/([a-z0-9]+)/)[1];
  expect(liveId, 'no live id');
});
await step('Host: söker och väljer Shopify-produkter', async () => {
  for (const q of ['noir', 'volym', 'pincett']) {
    await host.fill('#product-search', q);
    await host.waitForTimeout(450);
    await host.click('#search-results button:has-text("VÄLJ")');
    await host.waitForTimeout(250);
  }
  const n = await host.locator('#p-products .card').first().locator('.prod').count();
  expect(n === 3, `expected 3 live products, got ${n}`);
});
await step('Kund kan inte nå Studio-API utan inloggning', async () => {
  const r = await fetch(`${APP}/api/studio/lives`);
  expect(r.status === 401, `status ${r.status}`);
  const r2 = await fetch(`${APP}/api/studio/lives/${liveId}/start`, { method: 'POST' });
  expect(r2.status === 401, `start status ${r2.status}`);
});
await step('CSRF-skydd: mutation utan token nekas även med giltig cookie', async () => {
  const cookies = await hostCtx.cookies(APP);
  const sid = cookies.find((c) => c.name.includes('ffl_sid'));
  const r = await fetch(`${APP}/api/studio/lives/${liveId}/start`, { method: 'POST', headers: { Cookie: `${sid.name}=${sid.value}`, 'Content-Type': 'application/json' } });
  expect(r.status === 403, `status ${r.status}`);
});
await step('Host: kamera + mikrofon + STARTA LIVE', async () => {
  await host.click('#cam-btn');
  await host.waitForFunction(() => document.querySelector('#preview')?.videoWidth > 0, null, { timeout: 10000 });
  await host.click('#go-live');
  await host.waitForSelector('#status.live', { timeout: 10000 });
  await host.waitForSelector('#end-btn');
});
await step('Host: VISA NU (fäster Noir Lock)', async () => {
  await host.click('#p-products .prod:has-text("Noir Lock") .show-now');
  await host.waitForSelector('#p-products .prod.active:has-text("Noir Lock")');
  await host.screenshot({ path: `${SHOTS}/02-host-studio-live.png` });
});

// ---------------------------------------------------------------- VIEWER A (logged in, iPhone)
const iphone = devices['iPhone 13'];
const aCtx = await browser.newContext({ ...iphone, permissions: [] });
const a = await aCtx.newPage();
watch(a, 'viewerA');

await step('Kund A: loggar in och kommer tillbaka till /live', async () => {
  await a.goto(`${STORE}/customer_authentication/login?return_to=${encodeURIComponent('/apps/live')}`);
  await a.fill('input[name=email]', 'sara@example.com');
  await a.click('#login-submit');
  await a.waitForURL(/\/apps\/live/);
});
await step('Kund A: livevideo spelar (WebRTC) + tittarräknare', async () => {
  await videoPlaying(a);
  await a.waitForFunction(() => document.querySelector('#viewers')?.textContent === '1', null, { timeout: 5000 });
});
await step('Kund A: ser aktiv produkt (Noir Lock 499 kr)', async () => {
  await a.waitForSelector('#product-card.show:has-text("Noir Lock")');
  expect((await a.textContent('#product-card')).includes('499 kr'), 'price missing');
  await a.screenshot({ path: `${SHOTS}/03-viewer-iphone13.png` });
});
await step('Kund A: likes i realtid (host ser dem)', async () => {
  for (let i = 0; i < 5; i++) await a.click('#like-btn');
  await host.waitForFunction(() => Number(document.querySelector('#m-likes')?.textContent.replace(/\s/g, '')) >= 5, null, { timeout: 5000 });
});
await step('Kund A: trycker på videon = gilla (hjärta vid fingret)', async () => {
  const before = Number((await a.textContent('#likes')).replace(/\D/g, '')) || 0;
  await a.mouse.click(120, 260);
  await a.waitForSelector('.tap-heart', { timeout: 2000 });
  const after = Number((await a.textContent('#likes')).replace(/\D/g, '')) || 0;
  expect(after === before + 1, `likes ${before} -> ${after}`);
});
await step('Kund A: chattar – host ser meddelandet', async () => {
  await a.fill('#chat-input', 'vilken böj?');
  await a.press('#chat-input', 'Enter');
  await a.waitForSelector('#feed .msg:has-text("vilken böj?")');
  await host.click('#tabs button:has-text("Chatt")');
  await host.waitForSelector('#chat-list .cmsg:has-text("vilken böj?")');
  await host.waitForSelector('#pv-chat .pv-msg:has-text("vilken böj?")');
});
await step('Chat-spam begränsas (rate limit)', async () => {
  for (let i = 0; i < 6; i++) { await a.fill('#chat-input', `spam ${i}`); await a.press('#chat-input', 'Enter'); }
  await a.waitForTimeout(800);
  const n = await a.locator('#feed .msg:has-text("spam")').count();
  expect(n <= 3, `rate limit failed: ${n} spam messages got through`);
});
await step('XSS i chatten renderas som text', async () => {
  await a.waitForTimeout(2100);
  await a.fill('#chat-input', '<img src=x onerror=alert(1)>');
  await a.press('#chat-input', 'Enter');
  await a.waitForSelector('#feed .msg:has-text("<img src=x")');
  expect((await a.locator('#feed img').count()) === 0, 'html injected');
});
await step('Host: fäster kommentar – syns hos tittaren', async () => {
  await host.click('#chat-list .cmsg:has-text("vilken böj?")');
  await host.click('#chat-list .cmsg:has-text("vilken böj?") button:has-text("Fäst")');
  await a.waitForSelector('#pinned.show:has-text("vilken böj?")');
});
await step('Host: byter produkt i realtid (utan refresh)', async () => {
  await host.click('#tabs button:has-text("Produkter")');
  await host.click('#p-products .prod:has-text("Volymfransar") .show-now');
  await a.waitForSelector('#product-card.show:has-text("Volymfransar 0.05 D")', { timeout: 5000 });
});
await step('Kund A: KÖP → bottom sheet, välj längd 9 mm, 2 st → Shopify-varukorg', async () => {
  await a.click('#product-card');
  await a.waitForSelector('#sheet-product.show');
  await a.click('#sheet-product .chip:text-is("9")');
  await a.click('#sheet-product .stepper button[aria-label="Öka"]');
  await a.screenshot({ path: `${SHOTS}/04-viewer-product-sheet.png` });
  await a.click('#add-btn');
  await a.waitForSelector('#cart-pill.show:has-text("2 produkter · 198 kr")', { timeout: 5000 });
  const playing = await a.evaluate(() => !document.querySelector('#video').paused);
  expect(playing, 'video stopped while shopping');
});
await step('Kund A: shoppa alla live-produkter (🛍️) + lägg till en till', async () => {
  await a.click('.rail-btn[aria-label="Shoppa"]');
  await a.waitForSelector('#sheet-shop.show .pitem');
  expect((await a.locator('#sheet-shop .pitem').count()) === 3, 'expected 3 products');
  await a.click('#sheet-shop .pitem:has-text("Precisionspincett")');
  await a.waitForSelector('#sheet-product.show:has-text("Precisionspincett")');
  await a.click('#add-btn');
  await a.waitForSelector('#cart-pill.show:has-text("3 produkter · 497 kr")', { timeout: 5000 });
});
await step('Host: aktiverar LIVE DEAL 20 % i 15 min → synkad nedräkning', async () => {
  await host.click('#tabs button:has-text("Deal")');
  await host.click('#start-deal');
  await host.waitForSelector('#end-deal');
  await a.waitForSelector('#deal.show:has-text("LIVE20")', { timeout: 5000 });
  const t = await a.textContent('#deal-timer');
  expect(/^1[45]:\d\d$/.test(t.trim()), `timer ${t}`);
  await a.screenshot({ path: `${SHOTS}/05-viewer-deal.png` });
});
await step('Kund A: varukorg (drawer) → aktivera kod → TILL KASSAN (Shopify)', async () => {
  await a.click('#cart-pill');
  await a.waitForSelector('#sheet-cart.show .cart-line');
  await a.click('#sheet-cart-foot button:has-text("ANVÄND LIVE20")').catch(() => {});
  await a.waitForSelector('#sheet-cart-foot .applied', { timeout: 5000 });
  await a.screenshot({ path: `${SHOTS}/06-viewer-cart.png` });
  await a.click('#sheet-cart-foot button:has-text("TILL KASSAN")');
  await a.waitForURL(/\/checkout/);
  const disc = await a.textContent('#checkout-discount');
  const attrs = await a.textContent('#checkout-attrs');
  expect(disc.includes('LIVE20'), `discount: ${disc}`);
  expect(attrs.includes(liveId), `attrs: ${attrs}`);
  await a.goBack();
  await videoPlaying(a);
});

// ---------------------------------------------------------------- VIEWER B (guest via shared link, Android)
const pixel = devices['Pixel 7'];
const bCtx = await browser.newContext({ ...pixel });
const b = await bCtx.newPage();
watch(b, 'viewerB');
let gateAt = 0;
await step('Gäst: delad länk /live/ID öppnar liven direkt (ingen registrering först)', async () => {
  await b.goto(`${STORE}/live/${liveId}`);
  await b.waitForURL(/\/apps\/live\/[a-z0-9]+\?ref=share/);
  await videoPlaying(b);
  await b.screenshot({ path: `${SHOTS}/07-guest-preview.png` });
});
await step('Gäst: efter 10 s visas login-overlay ovanpå videon', async () => {
  const t0 = Date.now();
  await b.waitForSelector('#gate.show', { timeout: 16000 });
  gateAt = Date.now() - t0;
  expect(gateAt > 7000, `gate too early (${gateAt} ms)`);
  await b.screenshot({ path: `${SHOTS}/08-guest-gate.png` });
});
await step('Gäst: servern stänger strömmen (kan inte kringgås genom att dölja overlay)', async () => {
  await b.waitForTimeout(3500);
  const r = await b.evaluate(async () => {
    const boot = JSON.parse(document.getElementById('ffl-boot').textContent);
    const res = await fetch(`${boot.api}/api/stream/viewer`, { method: 'POST', headers: { Authorization: `Bearer ${boot.token}` } });
    return res.status;
  });
  expect(r === 403, `new credentials after preview should be refused, got ${r}`);
});
await step('Gäst: SKAPA KONTO → tillbaka till SAMMA live, inloggad', async () => {
  await b.click('#gate-signup');
  await b.waitForURL(/customer_authentication\/login/);
  await b.fill('input[name=email]', 'ny.kund@example.com');
  await b.check('input[name=new]');
  await b.click('#login-submit');
  await b.waitForURL(new RegExp(`/apps/live/${liveId}\\?auth=1`));
  await videoPlaying(b);
  await b.waitForSelector('#chat-input');
});
await step('Ny kund: produkten hon tittade på före login öppnas automatiskt igen', async () => {
  await b.waitForSelector('#sheet-product.show:has-text("Volymfransar 0.05 D")', { timeout: 5000 });
  expect(!b.url().includes('p='), 'url not cleaned');
});
await step('Ny kund: kan shoppa och chatta direkt', async () => {
  await b.click('#sheet-product .chip:text-is("10")');
  await b.click('#add-btn');
  await b.waitForSelector('#cart-pill.show:has-text("1 produkt")');
  await b.fill('#chat-input', 'pris?');
  await b.press('#chat-input', 'Enter');
  await a.waitForSelector('#feed .msg:has-text("pris?")');
  await b.screenshot({ path: `${SHOTS}/09-new-customer-shopping.png` });
});
await step('Rapportera + host blockerar → meddelanden försvinner för alla', async () => {
  await a.click('#feed .msg:has-text("pris?")');
  await a.click('.msg-menu button');
  await host.click('#tabs button:has-text("Chatt")');
  await host.waitForSelector('#reports .cmsg:has-text("pris?")', { timeout: 5000 });
  await host.click('#reports .cmsg:has-text("pris?") button:has-text("Blockera")');
  await a.waitForFunction(() => ![...document.querySelectorAll('#feed .msg')].some((m) => m.textContent.includes('pris?')), null, { timeout: 5000 });
});
await step('Viewer kan inte manipulera host-funktioner via websocket', async () => {
  await a.evaluate(() => {
    const boot = JSON.parse(document.getElementById('ffl-boot').textContent);
    const ws = new WebSocket(`${boot.ws}?live=${boot.liveId}&token=${encodeURIComponent(boot.token)}`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'product', productId: '1' }));
  });
  await a.waitForTimeout(600);
  expect((await a.textContent('#product-card')).includes('Volymfransar'), 'product changed by viewer');
});

// ---------------------------------------------------------------- responsiveness screenshots
await step('Responsivitet: iPhone SE, iPhone 15 Pro Max, Galaxy S9+, iPad, desktop', async () => {
  const sizes = [
    ['iphone-se', devices['iPhone SE']],
    ['iphone-15-pro-max', devices['iPhone 15 Pro Max'] || devices['iPhone 14 Pro Max']],
    ['galaxy-s9', devices['Galaxy S9+']],
    ['ipad', devices['iPad (gen 7)']],
    ['desktop', { viewport: { width: 1440, height: 900 } }],
  ];
  for (const [name, dev] of sizes) {
    const ctx = await browser.newContext({ ...dev });
    await ctx.addCookies([{ name: 'mock_customer', value: '1003', url: STORE }]);
    const p = await ctx.newPage();
    watch(p, name);
    await p.goto(`${STORE}/apps/live/${liveId}`);
    await videoPlaying(p);
    await p.waitForTimeout(500);
    // no horizontal scroll, buy button big enough
    const m = await p.evaluate(() => {
      const b = document.querySelector('#product-card .buy-btn')?.getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1, buyH: b?.height || 0 };
    });
    expect(!m.overflow, `${name}: horizontal overflow`);
    expect(m.buyH >= 44, `${name}: buy button ${m.buyH}px`);
    await p.screenshot({ path: `${SHOTS}/10-${name}.png` });
    await ctx.close();
  }
});

await step('Live Studio på mobil (host sänder från telefonen)', async () => {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], permissions: ['camera', 'microphone'] });
  const p = await ctx.newPage();
  watch(p, 'host-mobile');
  await p.goto(`${APP}/admin`);
  await p.fill('#email', 'lela@finafransar.test');
  await p.fill('#password', 'testlosenord-123456');
  await p.click('button[type=submit]');
  await p.waitForSelector('.live-row');
  await p.click('.live-row');
  await p.waitForSelector('#status.live');
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(!overflow, 'studio horizontal overflow on mobile');
  await p.screenshot({ path: `${SHOTS}/13-host-studio-mobile.png`, fullPage: true });
  await ctx.close();
});

// ---------------------------------------------------------------- stats + end
await step('Statistik: tittare, likes, köp-tratt, preview, registreringar, delningar', async () => {
  await host.click('#tabs button:has-text("Statistik")');
  await host.waitForSelector('#p-stats .stat');
  const s = await host.evaluate(async (id) => (await fetch(`/api/studio/lives/${id}/stats`)).json(), liveId);
  expect(s.totalViewers >= 3, `totalViewers ${s.totalViewers}`);
  expect(s.likes >= 5, `likes ${s.likes}`);
  expect(s.addToCart >= 3, `addToCart ${s.addToCart}`);
  expect(s.checkouts >= 1, `checkouts ${s.checkouts}`);
  expect(s.previewStarts >= 1 && s.previewCompletions >= 1, `preview ${s.previewStarts}/${s.previewCompletions}`);
  expect(s.registrations >= 1, `registrations ${s.registrations}`);
  expect(s.visitorsFromShare >= 1, `fromShare ${s.visitorsFromShare}`);
  expect(s.peakViewers >= 2, `peak ${s.peakViewers}`);
  await host.screenshot({ path: `${SHOTS}/11-host-stats.png`, fullPage: true });
});
await step('Host: AVSLUTA LIVE → tittarna ser "Liven är slut"', async () => {
  await host.click('#end-btn');
  await host.click('#end-btn');
  await host.waitForSelector('#status:has-text("AVSLUTAD")');
  await a.waitForSelector('#ended.show', { timeout: 5000 });
  await a.screenshot({ path: `${SHOTS}/12-viewer-ended.png` });
  const r = await fetch(`${STORE}/apps/live/${liveId}`);
  expect((await r.text()).includes('Liven är slut'), 'ended page');
});

console.log('\n' + results.join('\n'));
if (pageErrors.length) console.log('\nSidfel:\n' + [...new Set(pageErrors)].slice(0, 20).join('\n'));
console.log(`\n${results.length - failures}/${results.length} steg OK`);
await browser.close();
procs.forEach((p) => p.kill());
process.exit(failures ? 1 : 0);
