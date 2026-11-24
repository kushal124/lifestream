// @ts-check

/**
 * @typedef {import('../hiding.mjs').Placed} Placed
 * @typedef {Placed | { start: number, end: number, added: string }} Span
 * @typedef {{ asked: Span[], spoken?: string, answered: Placed[], photos?: (string | null)[] }} Seen
 * @typedef {{ text: string }} Piece
 * @typedef {{ words: string, spoken: boolean, asked: Span[], question: string, answer: string, answered: Placed[], written: string, drawn: boolean[] }} Turned
 */

/**
 * @param {string} text
 * @param {readonly Span[]} spans
 */
export function modelText(text, spans) {
  let out = '';
  let from = 0;
  for (const span of spans) {
    out += text.slice(from, span.start) + ('placeholder' in span ? span.placeholder : span.added);
    from = span.end;
  }
  return out + text.slice(from);
}

/**
 * @param {string} text
 * @param {readonly Span[]} spans
 */
function fits(text, spans) {
  let from = 0;
  for (const span of spans) {
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < from || span.end < span.start || span.end > text.length) return false;
    if ('added' in span ? span.added === '' || span.end !== span.start : span.placeholder === '') return false;
    from = span.end;
  }
  return true;
}

/**
 * @param {readonly Piece[]} pieces
 * @param {string} words
 * @param {boolean} spoken
 * @param {readonly Placed[]} spans
 * @returns {Span[] | null}
 */
export function askedOf(pieces, words, spoken, spans) {
  const joined = pieces.map(piece => piece.text).join('');
  const start = spoken ? pieces[0]?.text.length ?? 0 : 0;
  const end = start + words.length;
  if (joined.slice(start, end) !== words) return null;
  /** @type {Span[]} */
  const asked = [];
  /** @param {number} at */
  const offset = at => (at <= start ? 0 : words.length);
  /**
   * @param {number} from
   * @param {number} to
   */
  const add = (from, to) => {
    for (const [left, right] of [[from, Math.min(to, start)], [Math.max(from, end), to]]) {
      if (right <= left) continue;
      const at = offset(left);
      const last = asked.at(-1);
      if (last !== undefined && 'added' in last && last.start === at) last.added += joined.slice(left, right);
      else asked.push({ start: at, end: at, added: joined.slice(left, right) });
    }
  };
  let cursor = 0;
  for (const span of [...spans].sort((one, other) => one.start - other.start)) {
    const inside = span.start >= start && span.end <= end;
    const outside = span.end <= start || span.start >= end;
    if (!inside && !outside) return null;
    add(cursor, span.start);
    if (inside) asked.push({ start: span.start - start, end: span.end - start, placeholder: span.placeholder });
    else asked.push({ start: offset(span.start), end: offset(span.start), placeholder: span.placeholder });
    cursor = span.end;
  }
  add(cursor, joined.length);
  return asked;
}

/**
 * @param {Turned} turn
 * @returns {{ seen: Seen | null } | { differs: true }}
 */
export function seenOf(turn) {
  const right = fits(turn.words, turn.asked) && fits(turn.answer, turn.answered) && turn.answered.every(span => span.end > span.start)
    && modelText(turn.words, turn.asked) === turn.question && modelText(turn.answer, turn.answered) === turn.written;
  if (!right) return { differs: true };
  if (turn.asked.length === 0 && turn.answered.length === 0 && !turn.drawn.includes(true)) return { seen: null };
  return { seen: { asked: turn.asked, ...(turn.spoken ? { spoken: turn.words } : {}), answered: turn.answered } };
}
