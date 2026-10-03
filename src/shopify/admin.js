// Shopify Admin GraphQL client (server-side only).
// Auth: client credentials grant for a Dev Dashboard app installed on the
// store (tokens live ~24h and are refreshed automatically).
import { config } from '../config.js';
import { normalizeProduct, normalizeSearchHit } from './normalize.js';

const S = config.shopify;
let token = null;
let tokenExpiresAt = 0;
let tokenPromise = null;

async function getToken() {
  if (token && Date.now() < tokenExpiresAt - 5 * 60_000) return token;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const res = await fetch(`https://${S.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: S.clientId, client_secret: S.clientSecret }),
    });
    if (!res.ok) throw new Error(`Shopify token request failed: ${res.status} ${await res.text()}`);
    const j = await res.json();
    token = j.access_token;
    tokenExpiresAt = Date.now() + (Number(j.expires_in) || 86_000) * 1000;
    return token;
  })().finally(() => (tokenPromise = null));
  return tokenPromise;
}

export async function gql(query, variables = {}, attempt = 0) {
  const t = await getToken();
  const res = await fetch(`https://${S.shop}/admin/api/${S.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': t },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 && attempt === 0) {
    token = null;
    return gql(query, variables, 1);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return gql(query, variables, attempt + 1);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) {
    const throttled = j.errors?.some?.((e) => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`Shopify GraphQL error: ${res.status} ${JSON.stringify(j.errors || j).slice(0, 500)}`);
  }
  return j.data;
}

const PRODUCT_FIELDS = `
  id legacyResourceId title handle status description(truncateAt: 400)
  featuredMedia { preview { image { url altText } } }
  media(first: 6) { nodes { preview { image { url } } } }
  options { name values }
  variants(first: 100) { nodes { id legacyResourceId title price compareAtPrice availableForSale inventoryQuantity selectedOptions { name value } } }
`;

export const shopifyLive = {
  mode: 'live',

  async searchProducts(text) {
    // Free-text words (Shopify prefix-matches title/sku/vendor etc.).
    const safe = String(text || '').replace(/["\\:()*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const query = safe ? `${safe.split(' ').map((w) => `${w}*`).join(' ')} status:active` : 'status:active';
    const sortKey = safe ? 'RELEVANCE' : 'UPDATED_AT';
    const data = await gql(
      `query Search($q: String!) { products(first: 25, query: $q, sortKey: ${sortKey}) { nodes { id legacyResourceId title handle status totalInventory featuredMedia { preview { image { url } } } priceRangeV2 { minVariantPrice { amount } } } } }`,
      { q: query }
    );
    return data.products.nodes.map(normalizeSearchHit);
  },

  async getProducts(ids) {
    if (!ids.length) return [];
    const gids = ids.map((id) => `gid://shopify/Product/${id}`);
    const data = await gql(`query ByIds($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} } } }`, { ids: gids });
    return data.nodes.map(normalizeProduct).filter(Boolean);
  },

  async createDiscount({ code, title, percent, endsAt, productIds }) {
    const customerGets = {
      value: { percentage: percent / 100 },
      items: productIds?.length
        ? { products: { productsToAdd: productIds.map((id) => `gid://shopify/Product/${id}`) } }
        : { all: true },
    };
    const data = await gql(
      `mutation LiveDeal($input: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $input) { codeDiscountNode { id } userErrors { field message code } } }`,
      {
        input: {
          title,
          code,
          startsAt: new Date().toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          context: { all: 'ALL' },
          customerGets,
          combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
        },
      }
    );
    const r = data.discountCodeBasicCreate;
    if (r.userErrors?.length) {
      const err = new Error(r.userErrors.map((e) => e.message).join('; '));
      err.taken = r.userErrors.some((e) => e.code === 'TAKEN' || /unik|unique|taken|already/i.test(e.message));
      throw err;
    }
    return { discountId: r.codeDiscountNode.id };
  },

  async deactivateDiscount(discountId) {
    const data = await gql(
      `mutation End($id: ID!) { discountCodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { field message } } }`,
      { id: discountId }
    );
    const errs = data.discountCodeDeactivate.userErrors;
    if (errs?.length) throw new Error(errs.map((e) => e.message).join('; '));
  },

  // Creates the pretty share URL  /live/<id>  ->  /apps/live/<id>?ref=share
  async createRedirect(path, target) {
    const existing = await gql(`query R($q: String!) { urlRedirects(first: 5, query: $q) { nodes { id path target } } }`, { q: `path:${path}` });
    const hit = existing.urlRedirects.nodes.find((n) => n.path === path);
    if (hit) return hit.id;
    const data = await gql(
      `mutation Redir($r: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $r) { urlRedirect { id path target } userErrors { field message } } }`,
      { r: { path, target } }
    );
    const r = data.urlRedirectCreate;
    if (r.userErrors?.length) throw new Error(r.userErrors.map((e) => e.message).join('; '));
    return r.urlRedirect.id;
  },

  async customer(id) {
    const data = await gql(`query Cust($id: ID!) { customer(id: $id) { id firstName lastName createdAt } }`, { id: `gid://shopify/Customer/${id}` });
    return data.customer;
  },

  async ensureWebhooks(callbackUrl) {
    const data = await gql(`query { webhookSubscriptions(first: 50) { nodes { id topic uri } } }`);
    const have = data.webhookSubscriptions.nodes.some((n) => n.topic === 'ORDERS_CREATE' && n.uri === callbackUrl);
    if (have) return;
    const r = await gql(
      `mutation W($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`,
      { topic: 'ORDERS_CREATE', sub: { uri: callbackUrl, format: 'JSON', includeFields: ['id', 'note_attributes', 'line_items', 'current_total_price', 'total_price', 'currency', 'customer'] } }
    );
    const errs = r.webhookSubscriptionCreate.userErrors;
    if (errs?.length) throw new Error(errs.map((e) => e.message).join('; '));
  },
};
