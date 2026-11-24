// @ts-check

/**
 * @typedef {{ dwell: number, quiet: number, word: number }} AskPace
 * @typedef {{ type: 'chat' } | { type: 'step', call: number, words: string, said?: string } | { type: 'step', call: number, words: string, ms: number, error?: string } | { type: 'text', delta: string } | { type: 'done', message: { text: string, end?: 'done' | 'stopped' | 'failed', thought_ms?: number } }} AskLiveEvent
 * @typedef {{ line: string, working: boolean, shown: string, thought: number | null, settled: boolean }} AskLiveView
 * @typedef {{ end: number, size: number, visible: number }} Cut
 * @typedef {{ thinking: true } | { said: string } | { call: number }} Waiting
 */

const THINKING = 'Thinking';
const CITATION = /\[r\d+(?:\s*,\s*r\d+)*\]/gu;
const CITATION_ALONE = /^\[r\d+(?:\s*,\s*r\d+)*\][.,;:!?]*$/u;
const MARKS = /^(?:#{1,6}|>|[-*+]|\d{1,9}[.)]) +/u;
const ROW_MARK = /^\s*(?:[-*+]\s+|\d{1,9}[.)]\s+|#{1,6}\s+|>\s*)/u;

/** @param {number} ms */
export function took(ms) {
  const tenths = Math.round(Math.max(0, ms) / 100);
  if (tenths < 10) return `0.${tenths}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)}m${rest ? ` ${rest}s` : ''}`;
}

/** @param {number} ms */
export const thoughtFor = ms => `Thought for ${took(ms)}`;

/** @param {string} c */
const space = c => c === ' ' || c === '\t' || c === '\n';
/** @param {string} c */
const blank = c => /\s/u.test(c);

/**
 * @param {string[]} c
 * @param {number} from
 * @param {string} mark
 * @param {number} [to]
 */
const indexOf = (c, from, mark, to = c.length) => {
  for (let at = from; at < to; at += 1) if (c[at] === mark) return at;
  return -1;
};

/** @param {string[]} c */
const trimmed = c => {
  let end = c.length;
  while (end > 0 && blank(c[end - 1])) end -= 1;
  return end;
};

/** @param {string} line */
const marks = line => {
  let taken = 0;
  let rest = line;
  for (let mark = MARKS.exec(rest); mark; mark = MARKS.exec(rest)) {
    taken += [...mark[0]].length;
    rest = rest.slice(mark[0].length);
  }
  return taken;
};

/**
 * @param {string[]} c
 * @param {number} start
 * @param {boolean} final
 * @returns {number | null}
 */
const unit = (c, start, final) => {
  let index = start;
  while (index < c.length) {
    const char = c[index];
    if (space(char)) return index;
    if (char === '`') {
      const close = indexOf(c, index + 1, '`');
      if (close < 0) return final ? c.length : null;
      index = close + 1;
    } else if (char === '[') {
      if (index > start && c[index + 1] === 'r') return index;
      const nl = indexOf(c, index, '\n');
      const lineEnd = nl < 0 ? c.length : nl;
      const close = indexOf(c, index, ']', lineEnd);
      if (close < 0) {
        if (lineEnd === c.length && !final) return null;
        index += 1;
        continue;
      }
      index = close + 1;
      if (index < c.length && c[index] === '(') {
        const target = indexOf(c, index, ')', lineEnd);
        if (target < 0) return final || lineEnd < c.length ? lineEnd : null;
        index = target + 1;
      }
    } else index += 1;
  }
  return final ? index : null;
};

/**
 * @param {string[]} c
 * @param {number} lineEnd
 * @param {string} mark
 * @param {boolean} final
 * @returns {number | null}
 */
const fence = (c, lineEnd, mark, final) => {
  if (lineEnd < 0) return null;
  let start = lineEnd + 1;
  while (start < c.length) {
    const end = indexOf(c, start, '\n');
    if (c.slice(start, end < 0 ? c.length : end).join('').trim().startsWith(mark)) return end >= 0 ? end : final ? c.length : null;
    if (end < 0) return null;
    start = end + 1;
  }
  return null;
};

/**
 * @param {string[]} c
 * @param {number} begin
 * @param {boolean} final
 * @returns {number | null}
 */
const table = (c, begin, final) => {
  let start = begin;
  while (start < c.length) {
    const end = indexOf(c, start, '\n');
    if (!c.slice(start, end < 0 ? c.length : end).join('').trim().startsWith('|')) return start - 1;
    if (end < 0) return final ? c.length : null;
    start = end + 1;
  }
  return final ? trimmed(c) : null;
};

/** @param {string} slice */
const visible = slice => [...slice.replace(CITATION, '').replace(/\]\([^)]*\)/gu, '').replace(/\n[ \t]*(?:(?:#{1,6}|>|[-*+]|\d{1,9}[.)]) +)*/gu, '')]
  .filter(c => !'*`[]\n'.includes(c)).length;

/**
 * @param {string} text
 * @param {boolean} final
 * @returns {Cut[]}
 */
export function cutsOf(text, final) {
  const c = [...text];
  /** @type {Cut[]} */
  const cuts = [];
  let last = 0;
  let index = 0;
  let lineStart = true;
  /** @param {number} end @param {boolean} [whole] */
  const cut = (end, whole = false) => {
    const slice = c.slice(last, end).join('');
    const cited = CITATION_ALONE.test(slice.trim());
    const seen = whole || cited ? 0 : visible(slice);
    cuts.push({ end, size: cited ? 2 : Math.max(1, whole ? [...slice].length : seen), visible: seen });
    last = end;
  };
  scan: while (index < c.length) {
    if (lineStart) {
      let start = index;
      while (start < c.length && (c[start] === ' ' || c[start] === '\t')) start += 1;
      if (start < c.length && c[start] === '\n') {
        index = start + 1;
        continue;
      }
      const nl = indexOf(c, start, '\n');
      const rest = c.slice(start, nl < 0 ? c.length : nl).join('');
      if (nl < 0 && !final && !rest.includes(' ')) break;
      if (rest.startsWith('```') || rest.startsWith('~~~')) {
        const close = fence(c, nl, rest.slice(0, 3), final);
        if (close === null) {
          if (final) cut(trimmed(c));
          break scan;
        }
        cut(close, true);
        index = close;
        lineStart = false;
        continue;
      }
      if (rest.startsWith('|')) {
        const close = table(c, start, final);
        if (close === null) {
          if (final) cut(trimmed(c));
          break scan;
        }
        cut(close, true);
        index = close;
        lineStart = false;
        continue;
      }
      index = start + marks(rest);
      lineStart = false;
      continue;
    }
    const char = c[index];
    if (char === '\n') {
      index += 1;
      lineStart = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      index += 1;
      continue;
    }
    const end = unit(c, index, final);
    if (end === null) break;
    cut(end);
    index = end;
  }
  if (final && last < trimmed(c)) cut(trimmed(c));
  return cuts;
}

/** @param {string} shown */
export function closed(shown) {
  const rows = shown.split('\n');
  let from = 0;
  rows.forEach((row, at) => {
    if (!row.trim()) from = at + 1;
  });
  /** @type {string[]} */
  const open = [];
  /** @param {string} mark */
  const toggle = mark => {
    if (open.at(-1) === mark) open.pop();
    else open.push(mark);
  };
  for (const row of rows.slice(from)) {
    const words = [...row.replace(ROW_MARK, '')];
    for (let at = 0; at < words.length; at += 1) {
      const c = words[at];
      if (c === '`') toggle('`');
      else if (open.at(-1) === '`') continue;
      else if ((c === '*' || c === '~') && words[at + 1] === c) {
        toggle(c + c);
        at += 1;
      } else if (c === '*') toggle('*');
    }
  }
  return shown + open.reverse().join('');
}

/**
 * @param {number} askedMs
 * @param {AskPace} pace
 * @param {{ followed?: boolean }} [options]
 */
export function askLive(askedMs, pace, { followed = false } = {}) {
  const dwell = pace.dwell / 1000;
  const quiet = pace.quiet / 1000;
  const word = pace.word / 1000;
  const asked = askedMs / 1000;
  /** @type {{ call: number, going: string, done: string | null }[]} */
  const steps = [];
  /** @type {{ working: string } | { thought: number } | null} */
  let line = { working: 'Sending' };
  let phraseAt = asked;
  /** @type {Waiting[]} */
  let queue = [];
  let named = false;
  let stillSince = asked;
  let released = '';
  /** @type {number | null} */
  let arrived = null;
  /** @type {Cut[]} */
  let cuts = [];
  /** @type {number[]} */
  const revealed = [];
  let turnLeft = 0;
  let paceAt = asked;
  let deadline = asked;
  let clock = asked;
  let runFrom = 0;
  let answering = false;
  let ended = false;
  /** @type {number | null} */
  let given = null;
  /** @type {number | null} */
  let settledAt = null;
  /** @type {AskLiveView | null} */
  let view = null;

  const anyOpen = () => steps.some(step => step.done === null);
  /** @param {number} seconds */
  const ms = seconds => Math.round(Math.max(0, seconds) * 1000);
  const rate = () => {
    let backlog = 0;
    for (let at = revealed.length; at < cuts.length; at += 1) backlog += cuts[at].size;
    backlog += turnLeft;
    return Math.max(1 / word, backlog / Math.max(deadline - paceAt, word));
  };
  /** @param {number} time */
  const pace_ = time => {
    if (!(time > paceAt)) return;
    if (turnLeft > 0) turnLeft = Math.max(0, turnLeft - (time - paceAt) * rate());
    paceAt = time;
  };
  /** @param {string} words @param {number} time */
  const say = (words, time) => {
    if (line && 'working' in line && line.working === words) return;
    line = { working: words };
    phraseAt = time;
  };
  /** @param {number} time */
  const settle = time => {
    settledAt = time;
    queue = [];
    if (followed && given !== null) line = { thought: given };
    else if (!answering) line = named ? { thought: given ?? ms(time - asked) } : null;
  };
  /** @param {boolean} final @param {number} time */
  const recut = (final, time) => {
    const shownEnd = revealed.length ? cuts[revealed.length - 1].end : 0;
    const known = cuts.at(-1)?.end ?? 0;
    cuts = [...cuts.slice(0, revealed.length), ...cutsOf(released, final).filter(each => each.end > shownEnd)];
    if ((cuts.at(-1)?.end ?? 0) > known) deadline = time + quiet;
  };
  /** @param {number} time */
  const reveal = time => {
    const index = revealed.length;
    revealed.push(time);
    turnLeft = cuts[index].size;
    paceAt = time;
    if (index >= runFrom && !answering) {
      answering = true;
      queue = [];
      line = { thought: ms((arrived ?? time) - asked) };
      phraseAt = time;
    }
    if (ended && revealed.length === cuts.length) settle(time);
  };
  /** @param {number} time */
  const roll = time => {
    /** @param {number} call */
    const open = call => steps.findLast(step => step.call === call)?.done === null;
    let waiting = queue;
    queue = [];
    while (waiting.length > 1) {
      const [first] = waiting;
      if ('said' in first) break;
      if ('thinking' in first) {
        waiting = waiting.slice(1);
        continue;
      }
      const laterOpen = waiting.slice(1).some(each => 'call' in each && open(each.call));
      if (!open(first.call) || laterOpen) {
        waiting = waiting.slice(1);
        continue;
      }
      break;
    }
    const [first] = waiting;
    if (!first) return;
    queue = waiting.slice(1);
    if ('thinking' in first) say(THINKING, time);
    else if ('said' in first) say(first.said, time);
    else say(steps.findLast(step => step.call === first.call)?.going ?? THINKING, time);
  };
  /** @returns {[number, 'roll' | 'quiet' | 'reveal'] | null} */
  const next = () => {
    /** @type {[number, 'roll' | 'quiet' | 'reveal'] | null} */
    let soonest = null;
    /** @param {number} at @param {'roll' | 'quiet' | 'reveal'} due */
    const consider = (at, due) => {
      if (soonest === null || at < soonest[0]) soonest = [at, due];
    };
    if (!answering && !ended) {
      if (queue.length) consider(phraseAt + dwell, 'roll');
      else if (named && arrived === null && !(line && 'working' in line && line.working === THINKING) && !anyOpen()) {
        consider(Math.max(phraseAt + dwell, stillSince + quiet), 'quiet');
      }
    }
    if (revealed.length < cuts.length) consider(paceAt + turnLeft / rate(), 'reveal');
    return soonest;
  };
  /** @param {number} time */
  const due = time => {
    for (let found = next(); settledAt === null && found !== null && Math.max(found[0], clock) <= time; found = next()) {
      const at = Math.max(found[0], clock);
      clock = at;
      pace_(at);
      if (found[1] === 'roll') roll(at);
      else if (found[1] === 'quiet') say(THINKING, at);
      else reveal(at);
    }
  };
  /** @param {number} time */
  const advance = time => {
    due(time);
    if (settledAt === null) pace_(time);
    clock = Math.max(clock, time);
  };
  /** @param {number} time */
  const end = time => {
    ended = true;
    recut(true, time);
    if (revealed.length === cuts.length) settle(time);
  };

  return {
    /**
     * @param {AskLiveEvent} event
     * @param {number} nowMs
     */
    hear(event, nowMs) {
      const time = nowMs / 1000;
      advance(time);
      if (ended) return;
      if (event.type === 'chat') {
        if (named) return;
        named = true;
        stillSince = time;
        queue.push({ thinking: true });
      } else if (event.type === 'step' && !('ms' in event)) {
        named = true;
        if (event.said) queue.push({ said: event.said });
        answering = false;
        runFrom = cuts.length;
        arrived = null;
        steps.push({ call: event.call, going: event.words, done: null });
        queue.push({ call: event.call });
      } else if (event.type === 'step') {
        const step = steps.findLast(each => each.call === event.call);
        if (step) step.done = event.words;
        else steps.push({ call: event.call, going: event.words, done: event.words });
        if (!anyOpen()) stillSince = time;
      } else if (event.type === 'text' && event.delta) {
        arrived ??= time;
        released += event.delta;
        recut(false, time);
      } else if (event.type === 'done') {
        given = event.message.thought_ms ?? null;
        if ((event.message.end ?? 'done') === 'done') {
          if (event.message.text !== released) {
            released = event.message.text;
            cuts = cutsOf(released, true);
            revealed.splice(cuts.length);
          }
          end(time);
        } else {
          end(time);
          while (revealed.length < cuts.length) reveal(time);
          if (settledAt === null) settle(time);
        }
      }
      advance(time);
    },
    /**
     * @param {number} nowMs
     * @returns {AskLiveView}
     */
    at(nowMs) {
      due(nowMs / 1000);
      const shownEnd = settledAt !== null ? [...released].length : revealed.length ? cuts[revealed.length - 1].end : 0;
      const shown = [...released].slice(0, shownEnd).join('');
      const text = settledAt !== null ? shown : closed(shown);
      const working = line !== null && 'working' in line;
      const said = line === null ? '' : 'working' in line ? line.working : thoughtFor(line.thought);
      const thought = line !== null && 'thought' in line ? line.thought : null;
      const settled = settledAt !== null;
      if (view && view.line === said && view.working === working && view.shown === text && view.settled === settled) return view;
      view = { line: said, working, shown: text, thought, settled };
      return view;
    },
    answer: () => released,
  };
}
