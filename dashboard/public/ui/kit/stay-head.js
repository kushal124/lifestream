// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { ARRIVES, bar } from './skeleton.js';
import { icon } from './icon.js';

const NAME_IT = 'Name it';

/**
 * @param {object} head
 * @param {string} head.key
 * @param {string} head.time
 * @param {string} head.icon
 * @param {string} head.name
 * @param {string | null} head.line
 * @param {string} head.length
 * @param {boolean} head.open
 * @param {boolean} head.button
 * @param {string} [head.label]
 * @param {boolean} [head.quiet]
 * @param {string} [head.spot]
 */
export function stayHead({ key, time, icon: glyph, name, line, length, open, button, label = '', quiet = false,
  spot = '' }) {
  const said = line === null ? `<span class="dy-head__line mac-body">${bar(2)}</span>`
    : line ? `<span class="dy-head__line mac-body ${ARRIVES}" data-w="text">${esc(line)}</span>` : '';
  const tail = quiet ? `<span class="dy-head__sub">${said}${spot ? nameIt(spot, name) : NAME_SLOT}</span>` : said;
  const press = {
    'data-d-stay': key, 'data-d-nav': '', tabindex: '-1', 'aria-expanded': String(open),
    'aria-label': `${open ? 'Fold' : 'Open'} ${name}${label ? `, ${label}` : ''}`,
  };
  const own = button && !quiet;
  const tag = own ? 'button' : 'div';
  return `<${tag}${attributes({
    type: own ? 'button' : null,
    class: `dy-head${glyph ? '' : ' dy-head--none'}${quiet ? ' dy-head--quiet' : ''}${open ? ' is-open' : ''}`,
    'data-k': 'head',
    ...(own ? press : {}),
  })}>`
    + (quiet && button ? `<button${attributes({ type: 'button', class: 'dy-head__press', ...press })}></button>` : '')
    + `<span class="dy-head__time mac-mono-time" data-c="time">${esc(time)}</span>`
    + (glyph ? `<span class="dy-head__disc" aria-hidden="true">${icon(glyph)}</span>` : '')
    + `<span class="dy-head__caret dy-caret" data-c="icon">${button ? icon('forward') : ''}</span>`
    + `<span class="dy-head__title" data-c="name" data-d-fit="head"><span class="dy-head__name mac-title-2" data-w="text">${esc(name)}</span>${tail}</span>`
    + `<span class="dy-head__length mac-mono-data" data-c="count">${esc(length)}</span>`
    + `</${tag}>`;
}

export const NAME_SLOT = `<span class="dy-head__slot mac-body" aria-hidden="true">${NAME_IT}</span>`;

/**
 * @param {string} spot
 * @param {string} name
 */
export const nameIt = (spot, name) => `<a${attributes({ class: 'dy-head__slot dy-nameit mac-body',
  href: `#view=places&focus=${encodeURIComponent(spot)}`, 'data-d-nameit': spot,
  'aria-label': `${NAME_IT}, ${name}` })}>${NAME_IT}</a>`;

export const stayHeadReading = () => '<div class="dy-head is-reading" aria-hidden="true">'
  + `<span class="dy-head__time mac-mono-time" data-c="time">${bar(2)}</span>`
  + '<span class="dy-head__disc dy-head__disc--reading ck-sk"></span><span class="dy-head__caret"></span>'
  + `<span class="dy-head__title" data-c="name"><span class="dy-head__name mac-title-2">${bar(6)}</span>`
  + `<span class="dy-head__line mac-body">${bar(2)}</span></span>`
  + `<span class="dy-head__length mac-mono-data" data-c="count">${bar(2)}</span></div>`;
