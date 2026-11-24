// @ts-check
import { cutAtWord, cutName, textWidth as width } from '../kit/cut.js';

const TITLES_ROOM = 120;

/** @param {Element} element */
const fontOf = element => getComputedStyle(element).font;

/** @param {HTMLElement} element */
function restore(element) {
  restoreCuts(element);
  for (const moved of /** @type {NodeListOf<HTMLElement>} */ (element.querySelectorAll('[data-title], [data-after-title]'))) {
    moved.hidden = true;
  }
}

/** @param {HTMLElement} element */
function restoreCuts(element) {
  for (const part of /** @type {NodeListOf<HTMLElement>} */ (element.querySelectorAll('[data-cut]'))) {
    part.hidden = false;
    part.removeAttribute('data-cut');
  }
  for (const part of /** @type {NodeListOf<HTMLElement>} */ (element.querySelectorAll('[data-full]'))) {
    part.textContent = part.dataset.full ?? '';
    part.removeAttribute('data-full');
  }
  for (const tile of /** @type {NodeListOf<HTMLElement>} */ (element.querySelectorAll('.dy-tile.is-more'))) {
    tile.classList.remove('is-more');
  }
  for (const more of /** @type {NodeListOf<HTMLElement>} */ (element.querySelectorAll('.dy-names__more'))) more.hidden = true;
}

/** @param {HTMLElement} title */
const showTitle = title => {
  title.hidden = false;
  const join = title.nextElementSibling;
  if (join instanceof HTMLElement && join.hasAttribute('data-after-title')) join.hidden = false;
};

/** @param {HTMLElement} part */
const hide = part => {
  part.hidden = true;
  part.dataset.cut = '';
};

/**
 * @param {HTMLElement} part
 * @param {string} words
 */
const replace = (part, words) => {
  part.dataset.full = part.textContent ?? '';
  part.textContent = words;
};

/** @param {HTMLElement} root */
export function fitWithin(root) {
  const fitted = /** @type {HTMLElement[]} */ ([...root.matches('[data-d-fit]') ? [root] : [], ...root.querySelectorAll('[data-d-fit]')])
    .filter(element => element.isConnected && !skipped(element));
  for (const element of fitted) restore(element);
  const plans = fitted.map(element => planOf(element)).filter(plan => plan !== null);
  for (const plan of plans) plan();
  const moved = fitted.filter(element => element.dataset.dFit === 'words' && element.querySelector('[data-title]:not([hidden])'));
  for (const element of moved) restoreCuts(element);
  const again = moved.map(element => planOf(element)).filter(plan => plan !== null);
  for (const plan of again) plan();
}

/** @param {HTMLElement} element */
const skipped = element => element.closest('.dy-rows__run') !== null && !element.checkVisibility({ contentVisibilityAuto: true });

/**
 * @param {HTMLElement} element
 * @returns {(() => void) | null}
 */
function planOf(element) {
  const box = element.getBoundingClientRect();
  if (!box.width) return null;
  const style = getComputedStyle(element);
  const room = element.clientWidth - parseFloat(style.paddingRight) + 0.5;
  const left = box.left;
  /** @param {Element} part */
  const end = part => part.getBoundingClientRect().right - left;
  /** @param {Element} part */
  const start = part => part.getBoundingClientRect().left - left;
  switch (element.dataset.dFit) {
    case 'names': return namesPlan(element, room, end, style, box.top);
    case 'tiles': return tilesPlan(element, room, start);
    case 'label': return labelPlan(element, room, style);
    case 'head': return headPlan(element, room, end, start);
    case 'name': return namePlan(element, room, end, start);
    default: return wordsPlan(element, room, end, start);
  }
}

/**
 * @param {HTMLElement} element
 * @param {number} room
 * @param {(part: Element) => number} end
 * @param {CSSStyleDeclaration} style
 * @param {number} top
 */
function namesPlan(element, room, end, style, top) {
  const names = /** @type {HTMLElement[]} */ ([...element.querySelectorAll('.dy-name')]);
  const more = /** @type {HTMLElement} */ (element.querySelector('.dy-names__more'));
  if (!names.length) return null;
  const height = parseFloat(style.lineHeight);
  const lines = style.flexWrap === 'wrap' ? Math.max(1, Math.floor(parseFloat(style.maxHeight) / height)) : 1;
  /** @param {HTMLElement} name */
  const lineOf = name => Math.floor((name.getBoundingClientRect().top - top) / height + 0.01);
  const at = names.map(name => ({ end: end(name), line: lineOf(name) }));
  const last = /** @type {{ end: number, line: number }} */ (at.at(-1));
  if (last.line < lines && last.end <= room) return null;
  const comma = /** @type {HTMLElement | null} */ (element.querySelector('.dy-names__comma'));
  const commaWidth = comma ? comma.getBoundingClientRect().width : 0;
  const font = fontOf(more);
  let kept = 0;
  for (let n = names.length - 1; n >= 1; n -= 1) {
    const before = at[n - 1];
    const fits = before.line < lines - 1 || (before.line === lines - 1 && before.end + commaWidth + width(`+${names.length - n}`, font) <= room);
    if (before.line < lines && before.end <= room && fits) {
      kept = n;
      break;
    }
  }
  return () => {
    names.forEach((name, index) => {
      if (index < kept) return;
      hide(name);
      const after = name.nextElementSibling;
      if (after?.classList.contains('dy-names__comma')) hide(/** @type {HTMLElement} */ (after));
    });
    more.textContent = `+${names.length - kept}`;
    more.hidden = false;
  };
}

/**
 * @param {HTMLElement} element
 * @param {number} room
 * @param {(part: Element) => number} start
 */
function tilesPlan(element, room, start) {
  const tiles = /** @type {HTMLElement[]} */ ([...element.querySelectorAll('.dy-tile')]);
  const total = Number(element.dataset.total ?? tiles.length);
  if (!tiles.length) return null;
  const pitch = tiles[1] ? tiles[1].offsetLeft - tiles[0].offsetLeft : tiles[0].offsetWidth;
  const fits = Math.max(1, Math.min(tiles.length, Math.floor((room - start(tiles[0]) - tiles[0].offsetWidth) / pitch) + 1));
  if (fits >= total) return null;
  return () => {
    tiles.forEach((tile, at) => {
      if (at >= fits) hide(tile);
    });
    const door = tiles[fits - 1];
    door.classList.add('is-more');
    const more = /** @type {HTMLElement} */ (door.querySelector('.dy-tile__more'));
    replace(more, `+${total - fits + 1}`);
  };
}

/**
 * @param {HTMLElement} element
 * @param {number} room
 * @param {CSSStyleDeclaration} style
 */
function labelPlan(element, room, style) {
  if (element.scrollWidth <= room) return null;
  const cut = cutName(element.textContent ?? '', style.font, room - parseFloat(style.paddingLeft));
  return () => replace(element, cut);
}

/**
 * @param {HTMLElement} element
 * @param {number} room
 * @param {(part: Element) => number} end
 * @param {(part: Element) => number} start
 */
function headPlan(element, room, end, start) {
  const name = /** @type {HTMLElement} */ (element.querySelector('.dy-head__name'));
  const line = /** @type {HTMLElement | null} */ (element.querySelector('.dy-head__line[data-w]'));
  const slot = /** @type {HTMLElement | null} */ (element.querySelector('.dy-head__slot'));
  const gap = slot ? parseFloat(getComputedStyle(/** @type {HTMLElement} */ (slot.parentElement)).columnGap) || 0 : 0;
  const reserve = slot ? end(slot) - start(slot) + gap : 0;
  const below = slot !== null && slot.getBoundingClientRect().top > name.getBoundingClientRect().bottom - 1;
  const last = slot ?? (line && !line.hidden ? line : name);
  if (below) {
    const cutName = end(name) > room ? cutAtWord(name.textContent ?? '', fontOf(name), room) : null;
    const cutLine = line && end(/** @type {HTMLElement} */ (slot)) > room
      ? cutAtWord(line.textContent ?? '', fontOf(line), room - reserve - start(line)) : undefined;
    if (cutName === null && cutLine === undefined) return null;
    return () => {
      if (cutName !== null) replace(name, cutName);
      if (line && cutLine !== undefined) (cutLine === null ? hide(line) : replace(line, cutLine));
    };
  }
  if (end(last) <= room) return null;
  if (line && end(name) < room - reserve) {
    const cut = cutAtWord(line.textContent ?? '', fontOf(line), room - reserve - start(line));
    return () => (cut === null ? hide(line) : replace(line, cut));
  }
  const cut = cutAtWord(name.textContent ?? '', fontOf(name), room - reserve);
  return () => {
    if (line) hide(line);
    if (cut !== null) replace(name, cut);
  };
}

/**
 * @param {HTMLElement} element
 * @param {number} room
 * @param {(part: Element) => number} end
 * @param {(part: Element) => number} start
 */
function namePlan(element, room, end, start) {
  const title = /** @type {HTMLElement} */ (element.querySelector('.dy-row__title'));
  const note = /** @type {HTMLElement | null} */ (element.querySelector('.dy-row__note'));
  if (end(note ?? title) <= room) return null;
  const moves = /** @type {HTMLElement | null} */ (element.closest('.dy-row')?.querySelector('[data-title]') ?? null);
  if (note && end(title) <= room) {
    if (moves) {
      return () => {
        hide(note);
        showTitle(moves);
      };
    }
    const cut = cutAtWord(note.textContent ?? '', fontOf(note), room - start(note));
    return () => (cut === null ? hide(note) : replace(note, cut));
  }
  const cut = cutAtWord(title.textContent ?? '', fontOf(title), room);
  return () => {
    if (note) hide(note);
    if (moves) showTitle(moves);
    if (cut !== null) replace(title, cut);
  };
}

/**
 * @param {HTMLElement} element
 * @param {number} room
 * @param {(part: Element) => number} end
 * @param {(part: Element) => number} start
 */
function wordsPlan(element, room, end, start) {
  const runs = /** @type {HTMLElement[]} */ ([...element.querySelectorAll('[data-w]')]).filter(part => !part.hidden);
  const over = runs.findIndex(part => end(part) > room);
  if (over < 0) return null;
  const part = runs[over];
  const quotedBefore = runs.slice(0, over).some(each => each.dataset.w === 'quote');
  const goneFrom = (/** @type {number} */ from) => () => {
    for (const each of runs.slice(from)) {
      hide(each);
      const join = each.previousElementSibling;
      if (join instanceof HTMLElement && join.classList.contains('dy-w__join')) hide(join);
    }
  };
  /** @type {() => void} */
  let cut = goneFrom(over);
  const left = room - start(part);
  switch (part.dataset.w) {
    case 'quote':
    case 'text': {
      if (part.dataset.w === 'quote' && quotedBefore) break;
      const words = part.textContent ?? '';
      const quoted = part.dataset.w === 'quote';
      const shown = cutAtWord(quoted ? words.slice(1, -1) : words, fontOf(part), left, quoted ? '“' : '', quoted ? '”' : '');
      if (shown !== null) {
        cut = () => {
          replace(part, shown);
          goneFrom(over + 1)();
        };
      }
      break;
    }
    case 'list':
    case 'titles': {
      const items = /** @type {HTMLElement[]} */ ([...part.querySelectorAll('[data-i]')]);
      const kept = items.filter(item => end(item) <= room).length;
      if (!kept || (part.dataset.w === 'titles' && (left < TITLES_ROOM || end(items[0]) > room))) break;
      cut = () => {
        for (const item of items.slice(kept)) {
          hide(item);
          const comma = item.previousElementSibling;
          if (comma instanceof HTMLElement && comma.classList.contains('dy-w__comma')) hide(comma);
        }
        goneFrom(over + 1)();
      };
      break;
    }
    case 'tiles': {
      const tiles = /** @type {HTMLElement[]} */ ([...part.querySelectorAll('.dy-w__tile')]);
      const kept = tiles.filter(tile => end(tile) <= room).length;
      if (!kept) break;
      cut = () => {
        for (const tile of tiles.slice(kept)) hide(tile);
        const more = part.querySelector('.dy-w__more');
        if (more instanceof HTMLElement) hide(more);
        goneFrom(over + 1)();
      };
      break;
    }
    default:
      break;
  }
  return cut;
}
