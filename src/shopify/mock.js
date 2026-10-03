// Mock Shopify Admin for development/tests (SHOPIFY_MODE=mock).
// Same interface as shopifyLive in admin.js.
import { FIXTURE_PRODUCTS } from './fixtures.js';
import { normalizeProduct, normalizeSearchHit } from './normalize.js';

export const mockState = { discounts: new Map(), redirects: new Map(), customers: new Map() };

export const shopifyMock = {
  mode: 'mock',
  async searchProducts(text) {
    const t = String(text || '').toLowerCase().trim();
    return FIXTURE_PRODUCTS.filter((p) => !t || p.title.toLowerCase().includes(t)).map(normalizeSearchHit);
  },
  async getProducts(ids) {
    return ids.map((id) => FIXTURE_PRODUCTS.find((p) => p.legacyResourceId === String(id))).filter(Boolean).map(normalizeProduct);
  },
  async createDiscount({ code, percent, endsAt, productIds }) {
    if (mockState.discounts.has(code)) {
      const e = new Error('Code must be unique');
      e.taken = true;
      throw e;
    }
    const discountId = `gid://shopify/DiscountCodeNode/${Date.now()}`;
    mockState.discounts.set(code, { discountId, percent, endsAt, productIds, active: true });
    return { discountId };
  },
  async deactivateDiscount(discountId) {
    for (const d of mockState.discounts.values()) if (d.discountId === discountId) d.active = false;
  },
  async createRedirect(path, target) {
    mockState.redirects.set(path, target);
    return `gid://shopify/UrlRedirect/${mockState.redirects.size}`;
  },
  async customer(id) {
    if (mockState.customers.has(String(id))) return mockState.customers.get(String(id));
    const first = ['Sara', 'Emma', 'Lina', 'Moa', 'Ida', 'Elin', 'Nora'][Number(id) % 7];
    const last = 'ABEHLMNS'[Number(id) % 8];
    // ids >= 9000 simulate "just created an account" (registration analytics)
    const createdAt = Number(id) >= 9000 ? new Date().toISOString() : new Date(Date.now() - 400 * 86400_000).toISOString();
    return { id: `gid://shopify/Customer/${id}`, firstName: first, lastName: last, createdAt };
  },
  async ensureWebhooks() {},
};
