// Input sanitation. Output escaping is ALSO done on the client (textContent
// only, never innerHTML for user content) – this is defence in depth.

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

export function cleanText(input, maxLen) {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFC').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  if ([...s].length > maxLen) s = [...s].slice(0, maxLen).join('');
  return s;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Safe JSON for embedding inside <script> tags.
export function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export const isLiveId = (s) => typeof s === 'string' && /^[a-z0-9]{6,16}$/.test(s);
export const isNumericId = (s) => /^\d{1,20}$/.test(String(s));
export const isDiscountCode = (s) => typeof s === 'string' && /^[A-Z0-9_-]{3,24}$/.test(s);

// Very small blocklist; moderators handle the rest. Extend as needed.
const BAD_WORDS = ['hora', 'fitta', 'kuk','nigger', 'n1gger'];
export function containsBlocked(text) {
  const t = ` ${text.toLowerCase()} `;
  return BAD_WORDS.some((w) => t.includes(` ${w} `));
}
