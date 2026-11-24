// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { shape } from './skeleton.js';

/**
 * @param {string | null} picture
 * @param {{ label: string }} options
 */
export function qrCode(picture, { label }) {
  if (!picture) {
    return `<span class="ck-qr ck-qr--reading" aria-hidden="true">${shape()}</span>`;
  }
  return `<img${attributes({ class: 'ck-qr', src: picture, alt: label })}>`;
}
