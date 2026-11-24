// @ts-check
import { attributes } from '../../lib/html.js';
import { pictureUrl } from '../../lib/api.js';

/** @typedef {{ hash: string, size: import('../../lib/api.js').PictureSize, alt: string }} Picture */

/**
 * @param {Picture} shown
 * @param {{ className?: string, attrs?: import('../../lib/html.js').Attributes }} [options]
 */
export const picture = (shown, { className = '', attrs = {} } = {}) => `<img${attributes({
  class: `ck-pic ${className}`.trim(), 'data-src': pictureUrl(shown.hash, shown.size), alt: shown.alt, decoding: 'async', draggable: 'false',
  ...attrs,
})}>`;

/**
 * @param {Picture} shown
 * @param {{ className?: string, imageClass?: string, overlay?: string }} [options]
 */
export const pictureFrame = (shown, { className = '', imageClass = '', overlay = '' } = {}) =>
  `<div${attributes({ class: `ck-picture ${className}`.trim() })}>`
  + picture(shown, { className: `ck-picture__image ${imageClass}`.trim() }) + overlay + '</div>';
