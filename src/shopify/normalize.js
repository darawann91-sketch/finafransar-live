// Turns an Admin GraphQL Product node into the compact shape the live UI uses.
// Variant IDs are the numeric (legacy) IDs because the storefront Ajax Cart
// API (/cart/add.js) expects those.
import { config } from '../config.js';

const money = (v) => (v === null || v === undefined ? null : Number(v));

export function normalizeProduct(p) {
  if (!p || !p.id) return null;
  const variants = (p.variants?.nodes || []).map((v) => ({
    id: String(v.legacyResourceId),
    title: v.title,
    price: money(v.price),
    compareAtPrice: money(v.compareAtPrice),
    available: !!v.availableForSale,
    // Only expose a coarse stock hint, never exact inventory numbers.
    lowStock: typeof v.inventoryQuantity === 'number' && v.inventoryQuantity > 0 && v.inventoryQuantity <= 3,
    options: (v.selectedOptions || []).map((o) => o.value),
  }));
  const options = (p.options || []).filter((o) => !(o.name === 'Title' && o.values?.length === 1 && o.values[0] === 'Default Title'));
  const availableVariants = variants.filter((v) => v.available);
  const priced = availableVariants.length ? availableVariants : variants;
  const minPrice = priced.length ? Math.min(...priced.map((v) => v.price)) : null;
  const cheapest = priced.find((v) => v.price === minPrice);
  const images = [
    p.featuredMedia?.preview?.image?.url,
    ...((p.media?.nodes || []).map((m) => m.preview?.image?.url)),
  ].filter(Boolean);
  return {
    id: String(p.legacyResourceId),
    gid: p.id,
    title: p.title,
    handle: p.handle,
    active: p.status === 'ACTIVE',
    description: (p.description || '').slice(0, 400),
    image: images[0] || null,
    images: [...new Set(images)].slice(0, 6),
    url: `${config.storeUrl}/products/${p.handle}`,
    options: options.map((o) => ({ name: o.name, values: o.values })),
    price: minPrice,
    compareAtPrice: cheapest?.compareAtPrice ?? null,
    priceVaries: new Set(variants.map((v) => v.price)).size > 1,
    available: availableVariants.length > 0,
    variants,
  };
}

export function normalizeSearchHit(p) {
  return {
    id: String(p.legacyResourceId),
    title: p.title,
    handle: p.handle,
    active: p.status === 'ACTIVE',
    image: p.featuredMedia?.preview?.image?.url || null,
    price: money(p.priceRangeV2?.minVariantPrice?.amount),
    totalInventory: p.totalInventory,
  };
}
