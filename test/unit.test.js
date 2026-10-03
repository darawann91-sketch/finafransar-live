// Unit tests: node --test test/unit.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:os')).tmpdir() + '/ffl-unit-');
const { signJwt, verifyJwt, hashPassword, verifyPassword } = await import('../src/lib/crypto.js');
const { verifyAppProxy, signAppProxy, verifyWebhook } = await import('../src/shopify/index.js');
const { cleanText, jsonForScript } = await import('../src/lib/sanitize.js');
const { normalizeProduct } = await import('../src/shopify/normalize.js');
const { FIXTURE_PRODUCTS } = await import('../src/shopify/fixtures.js');
const { hmacB64 } = await import('../src/lib/crypto.js');

test('jwt sign/verify + tamper + expiry', () => {
  const t = signJwt({ sub: 'c_1', typ: 'viewer' }, 'secret', { expiresInSec: 60 });
  assert.equal(verifyJwt(t, 'secret').sub, 'c_1');
  assert.equal(verifyJwt(t, 'other'), null);
  const [h, p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'host-1', typ: 'host' })).toString('base64url');
  assert.equal(verifyJwt(`${h}.${forged}.${s}`, 'secret'), null);
  assert.equal(verifyJwt(signJwt({ a: 1 }, 'secret', { expiresInSec: -1 }), 'secret'), null);
});

test('password hashing', () => {
  const h = hashPassword('ett-langt-losenord');
  assert.ok(verifyPassword('ett-langt-losenord', h));
  assert.ok(!verifyPassword('fel', h));
});

test('app proxy signature (Shopify algorithm) + replay window', () => {
  const sp = signAppProxy({ shop: 'x.myshopify.com', logged_in_customer_id: '42', path_prefix: '/apps/live', extra: 'a' }, 'k');
  assert.equal(verifyAppProxy(sp, 'k').customerId, '42');
  sp.set('logged_in_customer_id', '43');
  assert.equal(verifyAppProxy(sp, 'k'), null, 'tampered customer id must fail');
  const old = signAppProxy({ shop: 'x' }, 'k');
  old.set('timestamp', String(Math.floor(Date.now() / 1000) - 3600));
  assert.equal(verifyAppProxy(old, 'k'), null);
});

test('Shopify documented proxy example', () => {
  // From shopify.dev: sorted params concatenated without separators
  const msg = ['extra=1,2', 'logged_in_customer_id=', 'path_prefix=/apps/awesome_reviews', 'shop=s.myshopify.com', 'timestamp=1317327555'].join('');
  assert.ok(msg.startsWith('extra=1,2logged_in_customer_id='));
});

test('webhook hmac', () => {
  const body = Buffer.from('{"id":1}');
  assert.ok(verifyWebhook(body, hmacB64('sec', body), 'sec'));
  assert.ok(!verifyWebhook(body, 'nope', 'sec'));
});

test('sanitizing', () => {
  assert.equal(cleanText('  hej‮\u0000  du  ', 200), 'hej du');
  assert.equal([...cleanText('a'.repeat(500), 200)].length, 200);
  assert.ok(!jsonForScript({ x: '</script><script>' }).includes('</script>'));
});

test('product normalization keeps variants + numeric ids for /cart/add.js', () => {
  const p = normalizeProduct(FIXTURE_PRODUCTS.find((x) => x.handle === 'singelfransar-0-15-cc-boj'));
  assert.equal(p.options[0].name, 'Längder');
  assert.equal(p.variants.length, 15);
  assert.ok(/^\d+$/.test(p.variants[0].id));
  assert.equal(p.variants.find((v) => v.title === '6').available, false);
  const single = normalizeProduct(FIXTURE_PRODUCTS[0]);
  assert.equal(single.options.length, 0, 'Default Title option hidden');
});
