// Real product data snapshot from finafransar.com (Admin API, 2026-10-03),
// used ONLY in SHOPIFY_MODE=mock for local development and automated tests.
const lengths = (start, end, skip = []) => {
  const out = [];
  for (let i = start; i <= end; i++) if (!skip.includes(i)) out.push(String(i));
  return out;
};

const single = (pid, vid, price, qty) => ({
  variants: { nodes: [{ id: `gid://shopify/ProductVariant/${vid}`, legacyResourceId: vid, title: 'Default Title', price, compareAtPrice: null, availableForSale: qty > 0, inventoryQuantity: qty, selectedOptions: [{ name: 'Title', value: 'Default Title' }] }] },
  options: [{ name: 'Title', values: ['Default Title'] }],
});

const lengthProduct = (baseVid, values, soldOut = []) => ({
  options: [{ name: 'Längder', values }],
  variants: {
    nodes: values.map((v, i) => ({
      id: `gid://shopify/ProductVariant/${baseVid + i}`,
      legacyResourceId: String(baseVid + i),
      title: v,
      price: '99.00',
      compareAtPrice: '169.00',
      availableForSale: !soldOut.includes(v),
      inventoryQuantity: soldOut.includes(v) ? 0 : 3 + (i % 4),
      selectedOptions: [{ name: 'Längder', value: v }],
    })),
  },
});

const img = (f) => ({ preview: { image: { url: `https://cdn.shopify.com/s/files/1/0998/4334/2710/files/${f}` } } });
const LASH_IMG = 'volymfransar-003-l-boej-1289881.jpg?v=1787611357';

export const FIXTURE_PRODUCTS = [
  { id: 'gid://shopify/Product/15764045857142', legacyResourceId: '15764045857142', title: 'Noir Lock – Franslim med 0,5 Sek Torktid', handle: 'noir-lock', status: 'ACTIVE', totalInventory: 3,
    description: 'Önskar du ett snabbtorkande franslim som verkligen levererar? Noir Lock torkar på bara 0,5 sekunder och ger fransstylister hög prestanda med stark vidhäftning för professionella resultat varje gång.',
    featuredMedia: img('franslim_1787094666.webp?v=1790893322'), priceRangeV2: { minVariantPrice: { amount: '499.0' } }, ...single('15764045857142', '58013618897270', '499.00', 3) },
  { id: 'gid://shopify/Product/15769495208310', legacyResourceId: '15769495208310', title: 'Volymfransar 0.05 D böj', handle: 'volymfransar-0-05-d-boj-2', status: 'ACTIVE', totalInventory: 51,
    description: 'Volymfransar 0.05 D-böj är professionella volymfransar i premium koreansk PBT-fiber, för fransstylister som vill skapa fylliga set med tydligt lyft och en intensiv blick.',
    featuredMedia: img(LASH_IMG), priceRangeV2: { minVariantPrice: { amount: '99.0' } }, ...lengthProduct(58036667580790, lengths(6, 20, [7, 11, 12, 17])) },
  { id: 'gid://shopify/Product/15769748406646', legacyResourceId: '15769748406646', title: 'Singelfransar 0.15 CC böj', handle: 'singelfransar-0-15-cc-boj', status: 'ACTIVE', totalInventory: 35,
    description: 'Singelfransar 0.15 CC-böj används för klassisk 1:1-fransförlängning, där en frans fästs på varje naturlig frans. Premium koreansk PBT-fiber.',
    featuredMedia: img(LASH_IMG), priceRangeV2: { minVariantPrice: { amount: '99.0' } }, ...lengthProduct(58038710468982, lengths(6, 20), ['6', '10']) },
  { id: 'gid://shopify/Product/15899239874934', legacyResourceId: '15899239874934', title: 'Precisionspincett Lucia', handle: 'precisionspincett-for-fransforlangning', status: 'ACTIVE', totalInventory: 5,
    description: 'VETUS MCS-24A är en professionell precisionspincett utvecklad för dig som arbetar med fransförlängning och behöver hög precision och kontroll i varje moment.',
    featuredMedia: img('7BB35566-3C19-43C5-8321-E27E21E7A04B.png?v=1790881847'), priceRangeV2: { minVariantPrice: { amount: '299.0' } }, ...single('15899239874934', '58818360672630', '299.00', 5) },
  { id: 'gid://shopify/Product/15765422342518', legacyResourceId: '15765422342518', title: 'Mini Fläkt för Franslim', handle: 'mini-flakt', status: 'ACTIVE', totalInventory: 16,
    description: 'En praktisk och uppladdningsbar minifläkt speciellt framtagen för fransbehandlingar och lash lift.',
    featuredMedia: img('mini-flaekt-1826313_1787094679.webp?v=1787094977'), priceRangeV2: { minVariantPrice: { amount: '179.0' } }, ...single('15765422342518', '58023395524982', '179.00', 16) },
  { id: 'gid://shopify/Product/15765852553590', legacyResourceId: '15765852553590', title: 'Limskakare för Franslim', handle: 'limskakare', status: 'ACTIVE', totalInventory: 5,
    description: 'En elektrisk skakare som blandar franslim snabbt och jämnt för optimal konsistens och bättre retention.',
    featuredMedia: img('limskakare-2201737_1787094707.webp?v=1787094994'), priceRangeV2: { minVariantPrice: { amount: '299.0' } }, ...single('15765852553590', '58026493280630', '299.00', 5) },
  { id: 'gid://shopify/Product/15765742584182', legacyResourceId: '15765742584182', title: 'Silikontejp', handle: 'silikontejp', status: 'ACTIVE', totalInventory: 19,
    description: 'Ett oumbärligt hjälpmedel för alla lash-tekniker vid fransförlängning.',
    featuredMedia: img('silikontejp-7831584_1787094698.webp?v=1787094988'), priceRangeV2: { minVariantPrice: { amount: '19.0' } }, ...single('15765742584182', '58026310730102', '19.00', 19) },
];
