// @ts-check
import { productName } from './kinds.js';
import { count, counted, duration, yearsOf } from './words.js';

/**
 * @typedef {{ kind: 'person', id: string } | { kind: 'new', name: string }} Target
 * @typedef {{ network: string, messages: number }} Channel
 * @typedef {{ key: string, target: Target, name: string, face: string | null, channels: Channel[], messages: number, reason: string, you?: true }} Suggestion
 * @typedef {{ person: { key: string, id: string, name: string, face: string | null, photo: any }, screen: number, screens: number, waiting: number }} Checked
 * @typedef {{ id: string, faces: number, photos: number, years: [number, number] | null, year_count: number, sample: string[], suggestions: Suggestion[], sure: boolean, every?: string[], crops?: Record<string, string>, times?: Record<string, number | null>, check?: Checked }} Card
 * @typedef {{ id: string, name: string, origin: string, messages: number, channels: Channel[], target: Target, groups_only?: true, named?: number }} Someone
 * @typedef {{ building: boolean, progress: { read: number, total: number }, error: string | null, took_ms: number | null }} Reading
 * @typedef {{ people: number, faces: number, by: Record<string, number> }} Maybes
 * @typedef {Reading & { ready: true, position: string, owner: { id: string, name: string } | null, cards: Card[], checks: Card[], maybe: Maybes, someone: Someone[], crops: Record<string, string>, people_position: string }} Deck
 * @typedef {Reading & { ready: false }} Unread
 * @typedef {{ key: string, name: string, face: string | null }} Named
 * @typedef {{ card: string, kind: 'answer', n: number, act: string | null, named: Named | null, field: string, row: number, rowKey: string | null, out: Set<string> }} Answer
 * @typedef {Answer | { card: string, kind: 'skip', n: number, act: null }} Step
 * @typedef {{ history: Step[], steps: number, open: string | null, kept: Card | null, field: string, typed: boolean, lit: number | null, litKey: string | null, out: Set<string>, all: boolean, peek: string | null, undone: Answer | null, past: boolean, ended: boolean, began: number, only: string | null }} Sitting
 * @typedef {'card' | 'checkpoint' | 'finish' | 'empty'} View
 * @typedef {{ kind: 'suggestion', suggestion: Suggestion } | { kind: 'someone', someone: Someone } | { kind: 'new', name: string } | { kind: 'aside' }} Row
 * @typedef {{ kind: 'yes', kept: number, out: number } | { kind: 'no', faces: number }} CheckRow
 */

export const BIG = 10;
const SUGGESTED = 3;
export const SCREEN = 36;

/**
 * @param {Deck} deck
 * @param {number} now
 * @param {string | null} [only]
 * @returns {Sitting}
 */
export function newSitting(deck, now, only = null) {
  return { history: [], steps: 0, open: null, kept: null, field: '', typed: false, lit: null, litKey: null, out: new Set(),
    all: false, peek: null, undone: null, past: only !== null || (deck.cards[0]?.photos ?? 0) < BIG, ended: false,
    began: now, only };
}

/**
 * @param {Card} card
 * @param {string} only
 */
const checksOf = (card, only) => card.check !== undefined && (card.check.person.id === only || card.check.person.key === only);

/**
 * @param {Deck} deck
 * @param {string | null} only
 */
function cardsOf(deck, only) {
  if (only === null) return [...deck.cards, ...deck.checks];
  const theirs = deck.checks.filter(card => checksOf(card, only));
  const keys = new Set([only, ...theirs.map(card => /** @type {Checked} */ (card.check).person.key)]);
  const named = deck.cards.filter(card => card.suggestions[0] !== undefined
    && (keys.has(card.suggestions[0].key) || (card.suggestions[0].target.kind === 'person' && keys.has(card.suggestions[0].target.id))));
  return [...theirs, ...named];
}

/**
 * @param {Deck} deck
 * @param {Sitting} sitting
 * @param {string} id
 */
const cardOf = (deck, sitting, id) => [...deck.cards, ...deck.checks].find(card => card.id === id)
  ?? (sitting.kept?.id === id ? sitting.kept : undefined);

/**
 * @param {Deck} deck
 * @param {Sitting} sitting
 * @returns {Card[]}
 */
export function queueOf(deck, sitting) {
  const taken = new Set(sitting.history.map(step => step.card));
  const id = sitting.open;
  const first = id === null || taken.has(id) ? undefined : cardOf(deck, sitting, id);
  return [...(first ? [first] : []), ...cardsOf(deck, sitting.only).filter(card => card !== first && !taken.has(card.id))];
}

/**
 * @param {Deck} deck
 * @param {Sitting} sitting
 * @returns {View}
 */
export function viewOf(deck, sitting) {
  if (sitting.ended) return 'finish';
  const [card] = queueOf(deck, sitting);
  if (!card) return sitting.history.length ? 'finish' : 'empty';
  if (!sitting.past && !card.check && card.photos < BIG && card.id !== sitting.open) return 'checkpoint';
  return 'card';
}

/** @param {Card} card */
const suggestionsOf = card => [...card.suggestions]
  .sort((left, right) => Number(Boolean(right.you)) - Number(Boolean(left.you))).slice(0, SUGGESTED);

/**
 * @param {Card} card
 * @returns {number | null}
 */
export function openingLight(card) {
  return card.check || (card.suggestions.length && card.sure) ? 0 : null;
}

/**
 * @param {Card} card
 * @param {string} field
 * @param {Someone[]} someone
 * @returns {Row[]}
 */
export function rowsOf(card, field, someone) {
  const typed = field.trim();
  /** @type {Row[]} */
  const rows = typed
    ? [...searchPeople(someone, typed).map(each => /** @type {Row} */ ({ kind: 'someone', someone: each })),
      { kind: 'new', name: typed }]
    : suggestionsOf(card).map(suggestion => /** @type {Row} */ ({ kind: 'suggestion', suggestion }));
  return [...rows, { kind: 'aside' }];
}

/**
 * @param {Card} card
 * @param {Set<string>} out
 * @returns {CheckRow[]}
 */
export function checkRows(card, out) {
  const pressed = card.sample.filter(face => out.has(face)).length;
  const kept = card.sample.length - pressed;
  /** @type {CheckRow[]} */
  const no = [{ kind: 'no', faces: card.sample.length }];
  return kept === 0 ? no : [{ kind: 'yes', kept, out: pressed }, ...no];
}

/**
 * @param {Card} card
 * @param {Set<string>} out
 * @param {CheckRow} row
 */
export function checkAnswer(card, out, row) {
  const yes = row.kind === 'yes' ? card.sample.filter(face => !out.has(face)) : [];
  const no = row.kind === 'yes' ? card.sample.filter(face => out.has(face)) : [...card.sample];
  return { yes, no };
}

/**
 * @param {Sitting} sitting
 * @param {Card | null} card
 */
export function settle(sitting, card) {
  if (sitting.open !== (card?.id ?? null)) open(sitting, card);
}

/**
 * @param {Sitting} sitting
 * @param {Card | null} card
 */
function open(sitting, card) {
  sitting.open = card?.id ?? null;
  sitting.field = '';
  sitting.typed = false;
  sitting.out = new Set();
  sitting.all = false;
  sitting.peek = null;
  sitting.lit = card ? openingLight(card) : null;
  sitting.litKey = null;
}

/**
 * @param {Sitting} sitting
 * @param {Card} card
 * @param {string} value
 */
export function typeInto(sitting, card, value) {
  sitting.field = value;
  sitting.typed = true;
  sitting.lit = value.trim() ? 0 : openingLight(card);
  sitting.litKey = null;
}

/** @param {Row} row */
export const rowKey = row => row.kind === 'suggestion' ? `suggestion:${row.suggestion.key}`
  : row.kind === 'someone' ? `someone:${row.someone.id}` : row.kind;

/**
 * @param {Sitting} sitting
 * @param {string[]} keys
 * @returns {number | null}
 */
export function relight(sitting, keys) {
  if (sitting.lit === null || keys.length === 0) {
    sitting.litKey = null;
    return sitting.lit;
  }
  if (sitting.litKey !== null) {
    const at = keys.indexOf(sitting.litKey);
    sitting.lit = at >= 0 ? at : 0;
  }
  sitting.lit = Math.min(sitting.lit, keys.length - 1);
  sitting.litKey = keys[sitting.lit];
  return sitting.lit;
}

/**
 * @param {Sitting} sitting
 * @param {string[]} faces
 */
export function keepMarks(sitting, faces) {
  const held = new Set(faces);
  for (const face of [...sitting.out]) if (!held.has(face)) sitting.out.delete(face);
}

/**
 * @param {number | null} lit
 * @param {number} count
 * @param {1 | -1} by
 */
export function moved(lit, count, by) {
  if (lit === null) return by > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, lit + by));
}

/**
 * @param {Sitting} sitting
 * @param {Card} card
 * @param {Named | null} named
 * @param {number} row
 * @param {string | null} [rowKey]
 * @returns {Answer}
 */
export function answer(sitting, card, named, row, rowKey = null) {
  /** @type {Answer} */
  const step = { card: card.id, kind: 'answer', n: sitting.steps++, act: null, named, field: sitting.field, row, rowKey,
    out: new Set(sitting.out) };
  sitting.history.push(step);
  sitting.kept = card;
  sitting.undone = null;
  return step;
}

/**
 * @param {Sitting} sitting
 * @param {string} card
 */
export function skip(sitting, card) {
  sitting.history.push({ card, kind: 'skip', n: sitting.steps++, act: null });
}

/** @param {Sitting} sitting */
export function canBack(sitting) {
  const last = sitting.history.at(-1);
  return last !== undefined && (last.kind === 'skip' || sitting.undone === null);
}

/**
 * @param {Sitting} sitting
 * @param {Deck} deck
 * @returns {Step | undefined}
 */
export function back(sitting, deck) {
  if (!canBack(sitting)) return undefined;
  const step = /** @type {Step} */ (sitting.history.pop());
  if (step.kind === 'answer') sitting.undone = step;
  open(sitting, cardOf(deck, sitting, step.card) ?? null);
  if (step.kind === 'answer' && isCheck(step.card) && sitting.open === step.card) {
    sitting.out = new Set(step.out);
    sitting.lit = step.row;
    sitting.litKey = step.rowKey;
  }
  sitting.ended = false;
  return step;
}

/**
 * @param {Sitting} sitting
 * @param {Answer} step
 */
export function failed(sitting, step) {
  sitting.history = sitting.history.filter(each => each !== step);
  if (sitting.undone === step) sitting.undone = null;
  if (sitting.history.some(each => each.card === step.card)) return false;
  sitting.open = step.card;
  sitting.field = step.field;
  sitting.typed = false;
  sitting.lit = step.row;
  sitting.litKey = step.rowKey;
  sitting.out = new Set(step.out);
  sitting.all = false;
  sitting.peek = null;
  sitting.ended = false;
  return true;
}

/**
 * @param {Sitting} sitting
 * @param {Step} step
 * @param {'not-sent' | 'refused' | 'saving' | 'unknown'} said
 */
export function putBack(sitting, step, said) {
  if (sitting.history.some(each => each.card === step.card && each.kind === 'answer')) return;
  const history = sitting.history.filter(each => each.card !== step.card);
  const at = history.findIndex(each => each.n > step.n);
  history.splice(at < 0 ? history.length : at, 0, step);
  sitting.history = history;
  if (said !== 'not-sent' && step.kind === 'answer') {
    if (history.filter(each => each.kind === 'answer').at(-1) === step) sitting.undone = step;
  } else if (sitting.undone === step) sitting.undone = null;
}

/**
 * @param {Sitting} sitting
 * @param {Card} card
 * @param {Answer} step
 * @returns {Answer | undefined}
 */
export function retake(sitting, card, step) {
  if (card.id !== step.card || sitting.history.some(each => each.card === step.card)) return undefined;
  /** @type {Answer} */
  const given = { ...step, n: sitting.steps++, act: null, named: step.named && { ...step.named }, out: new Set(step.out) };
  sitting.history.push(given);
  sitting.kept = card;
  sitting.undone = null;
  return given;
}

/** @param {Sitting} sitting */
export function pass(sitting) {
  sitting.past = true;
}

/** @param {Sitting} sitting */
export function end(sitting) {
  sitting.ended = true;
  sitting.past = true;
}

/** @param {Sitting} sitting */
export function again(sitting) {
  sitting.history = sitting.history.filter(step => step.kind !== 'skip');
  sitting.open = null;
  sitting.ended = false;
}

/** @param {string} id */
export const isCheck = id => id.startsWith('check:');

/** @param {Sitting} sitting */
export function finishOf(sitting) {
  /** @type {Map<string, Named>} */
  const named = new Map();
  let aside = 0;
  let checked = 0;
  let skipped = 0;
  for (const step of sitting.history) {
    if (step.kind === 'skip') skipped += 1;
    else if (isCheck(step.card)) checked += 1;
    else if (step.named) named.set(step.named.key, step.named);
    else aside += 1;
  }
  return { named: [...named.values()], aside, checked, skipped };
}

/**
 * @param {{ key: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean }} event
 * @param {{ view: View, field: string, typed?: boolean, answered: boolean, skipped: boolean, check?: boolean, peeking?: boolean }} at
 * @returns {{ kind: 'type' | 'up' | 'down' | 'take' | 'skip' | 'back' | 'clear' | 'finish' | 'leave' | 'keep' | 'again' | 'peek' } | null}
 */
export function keyCommand(event, at) {
  const { key } = event;
  const command = Boolean(event.metaKey || event.ctrlKey);
  if (at.view === 'checkpoint') {
    if (command) return null;
    return key === 'Enter' ? { kind: 'keep' } : key === 'Escape' ? { kind: 'finish' } : null;
  }
  if (at.view === 'finish') {
    if (command) return null;
    return key === 'Enter' && at.skipped ? { kind: 'again' } : key === 'Escape' ? { kind: 'leave' } : null;
  }
  if (at.view === 'empty') return !command && (key === 'Enter' || key === 'Escape') ? { kind: 'leave' } : null;
  if (at.check) {
    if (command) return key.toLowerCase() === 'z' && !event.shiftKey ? { kind: 'back' } : null;
    if (key === ' ' || (key === 'Escape' && at.peeking)) return { kind: 'peek' };
    if (at.peeking) return null;
    if (key === 'ArrowUp') return { kind: 'up' };
    if (key === 'ArrowDown') return { kind: 'down' };
    if (key === 'Enter') return { kind: 'take' };
    if (key === 'ArrowRight') return { kind: 'skip' };
    if (key === 'ArrowLeft') return { kind: 'back' };
    if (key === 'Escape') return at.answered ? { kind: 'finish' } : { kind: 'leave' };
    return null;
  }
  const empty = at.field === '';
  if (command) return key.toLowerCase() === 'z' && !event.shiftKey && empty && !at.typed ? { kind: 'back' } : null;
  if ([...key].length === 1) return key === ' ' && empty ? null : { kind: 'type' };
  if (key === 'Backspace' || key === 'Delete') return empty ? null : { kind: 'type' };
  if (key === 'ArrowUp') return { kind: 'up' };
  if (key === 'ArrowDown') return { kind: 'down' };
  if (key === 'Enter') return { kind: 'take' };
  if (key === 'ArrowRight') return empty ? { kind: 'skip' } : null;
  if (key === 'ArrowLeft') return empty ? { kind: 'back' } : null;
  if (key === 'Escape') return !empty ? { kind: 'clear' } : at.answered ? { kind: 'finish' } : { kind: 'leave' };
  return null;
}

/**
 * @param {Someone[]} someone
 * @param {string} typed
 * @param {number} [limit]
 */
function searchPeople(someone, typed, limit = 6) {
  const words = typed.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  const found = someone.filter(each => {
    const name = each.name.toLocaleLowerCase();
    return words.every(word => name.includes(word));
  });
  const starts = (/** @type {Someone} */ each) => (each.name.toLocaleLowerCase().startsWith(words[0]) ? 0 : 1);
  return found.sort((left, right) => starts(left) - starts(right) || right.messages - left.messages
    || left.name.localeCompare(right.name)).slice(0, limit);
}

/** @param {Card} card */
export const spanWords = card => [`in ${counted(card.photos, 'photo')}`, yearsOf(card.years)].filter(Boolean)
  .join(', ');

/** @param {Channel[]} channels */
export function channelWords(channels) {
  return channels.map((channel, index) => `${productName(channel.network)}, `
    + `${index === 0 ? counted(channel.messages, 'message') : count(channel.messages)}`).join('; ');
}

/** @param {Someone} someone */
export const someoneWords = someone => (someone.channels.length ? channelWords(someone.channels)
  : someone.groups_only ? 'in groups only' : '');

/** @param {{ name: string, photos: number, days: number | null }} payoff */
export const payoffWords = payoff => `${payoff.name} · now in ${counted(payoff.photos, 'photo')}`;

/** @param {Card} card */
export const asideWords = card => `Set aside · ${counted(card.faces, 'face')}`;

/** @param {Checked} check */
export const firstName = check => check.person.name.trim().split(/\s+/u)[0] || check.person.name;

/** @param {Checked} check */
export const waitingWords = check => (check.screens > 1 ? `${check.screen} of ${count(check.screens)} screens · ` : '')
  + counted(check.waiting, 'face');

/**
 * @param {Checked} check
 * @param {{ yes: string[], no: string[] }} answer
 */
export function checkedWords(check, { yes, no }) {
  const name = firstName(check);
  return [yes.length ? `${count(yes.length)} added to ${name}` : '', no.length ? `${count(no.length)} not ${name}` : '']
    .filter(Boolean).join(' · ');
}

/** @param {number} left */
export const smallerWords = left => `${counted(left, 'smaller group')} left`;

/**
 * @param {number} named
 * @param {number} took
 */
export const finishWords = (named, took) => `${counted(named, 'person', 'people')} named · in ${duration(took)}`;

/** @param {Reading} reading */
export function readingWords(reading) {
  if (reading.error && !reading.building) return reading.error;
  const { read, total } = reading.progress;
  return total > 0 ? `Reading your faces: ${count(Math.min(read, total))} of ${count(total)}` : 'Reading your faces…';
}
