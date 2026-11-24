// @ts-check

/**
 * @param {unknown} value
 * @returns {string}
 */
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[/** @type {keyof ESCAPES} */ (c)]);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * @param {string} text
 * @param {number} units
 * @returns {string}
 */
export function textHead(text, units) {
  if (text.length <= units) return text;
  if (units <= 0) return '';
  const last = text.charCodeAt(units - 1), next = text.charCodeAt(units);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? units - 1 : units);
}

/**
 * @typedef {Record<string, string | number | boolean | null | undefined>} Attributes
 * @param {Attributes} [record]
 */
export function attributes(record = {}) {
  return Object.entries(record).map(([name, value]) => {
    if (value === false || value === null || value === undefined) return '';
    return value === true ? ` ${name}` : ` ${name}="${esc(value)}"`;
  }).join('');
}
