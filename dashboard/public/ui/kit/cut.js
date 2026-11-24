// @ts-check

/** @type {CanvasRenderingContext2D | null} */
let measure = null;

/**
 * @param {string} text
 * @param {string} font
 */
export function textWidth(text, font) {
  measure ??= /** @type {CanvasRenderingContext2D} */ (document.createElement('canvas').getContext('2d'));
  if (measure.font !== font) measure.font = font;
  return measure.measureText(text).width;
}

const CUT = '…';

/**
 * @param {string} text
 * @param {string} font
 * @param {number} room
 * @param {string} [opening]
 * @param {string} [closing]
 * @returns {string | null}
 */
export function cutAtWord(text, font, room, opening = '', closing = '') {
  const words = text.split(' ');
  for (let n = words.length - 1; n >= 1; n -= 1) {
    const shown = `${opening}${words.slice(0, n).join(' ').replace(/[\s,;:.·–—-]+$/u, '')}${CUT}${closing}`;
    if (textWidth(shown, font) <= room) return shown;
  }
  return null;
}

/**
 * @param {string} text
 * @param {string} font
 * @param {number} room
 */
export function cutName(text, font, room) {
  if (textWidth(text, font) <= room) return text;
  const cut = cutAtWord(text, font, room);
  if (cut !== null) return cut;
  const letters = [...text];
  while (letters.length > 1) {
    letters.pop();
    const shown = `${letters.join('')}${CUT}`;
    if (textWidth(shown, font) <= room) return shown;
  }
  return '';
}

/**
 * @param {string[]} words
 * @param {string} font
 * @param {number} room
 */
function linesOf(words, font, room) {
  let lines = 0;
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, font) > room) {
      lines += 1;
      line = word;
    } else line = next;
  }
  return lines + (line ? 1 : 0);
}

/**
 * @param {string} text
 * @param {string} font
 * @param {number} room
 * @param {number} lines
 */
export function cutToLines(text, font, room, lines) {
  const words = text.split(' ');
  if (linesOf(words, font, room) <= lines) return text;
  for (let n = words.length - 1; n >= 1; n -= 1) {
    const shown = `${words.slice(0, n).join(' ').replace(/[\s,;:.·–—-]+$/u, '')}${CUT}`;
    if (linesOf(shown.split(' '), font, room) <= lines) return shown;
  }
  return cutName(text, font, room);
}
