// @ts-check

/**
 * @typedef {{ start: number, end: number, type: string, who?: string, shown?: string }} Mark
 * @typedef {{ text: string, free?: true, whole?: string, known?: Mark[], is?: string, who?: string, shown?: string }} Piece
 * @typedef {{ lines: unknown[] }} Told
 * @typedef {string | Told} Answer
 */

export const HANDLE = /^r[1-9][0-9]*$/u;

export class Said {
  /** @param {Piece[]} pieces @param {unknown} plain */
  constructor(pieces, plain) {
    this.pieces = pieces;
    this.plain = plain;
  }

  toJSON() {
    return this.plain;
  }
}

export class Joined {
  /** @param {(string | Said | Joined | Hidden)[]} parts */
  constructor(parts) {
    /** @type {(string | Said | Hidden)[]} */
    this.parts = parts.flatMap(part => (part instanceof Joined ? part.parts : [part]));
  }

  toJSON() {
    return this.parts.map(part => (typeof part === 'string' ? part : part instanceof Hidden ? part.text : plainString(part))).join('');
  }
}

export class Hidden {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
  }

  toJSON() {
    return this.text;
  }
}

/**
 * @param {string} text
 * @param {string} [whole]
 */
export function free(text, whole) {
  return new Said([{ text, free: true, ...(whole === undefined || whole === text ? {} : { whole }) }], text);
}

/**
 * @param {string} text
 * @param {string | null} [who]
 */
export function named(text, who) {
  return new Said([{ text, is: 'person', ...(typeof who === 'string' ? { who } : {}) }], text);
}

/** @param {(string | Said | Joined | Hidden)[]} parts */
export function joined(...parts) {
  return new Joined(parts);
}

/** @param {Said} said */
function plainString(said) {
  return typeof said.plain === 'string' ? said.plain : JSON.stringify(said.plain);
}
