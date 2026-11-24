// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answer, again, back, BIG, canBack, checkAnswer, checkedWords, checkRows, end, failed, finishOf, keepMarks, keyCommand,
  moved, newSitting, openingLight, pass, payoffWords, putBack, queueOf, retake, rowsOf, settle, skip, spanWords, typeInto, viewOf,
  waitingWords,
} from '../public/lib/faces.js';
import { namingFaces } from '../public/ui/people/naming.js';

/** @typedef {import('../public/lib/faces.js').Card} Card */
/** @typedef {import('../public/lib/faces.js').Deck} Deck */
/** @typedef {import('../public/lib/faces.js').Suggestion} Suggestion */
/** @typedef {import('../public/lib/faces.js').Someone} Someone */

/**
 * @param {string} id
 * @param {string} name
 * @param {Partial<Suggestion>} [more]
 * @returns {Suggestion}
 */
const suggestion = (id, name, more = {}) => ({ key: id, target: { kind: 'person', id }, name, face: null,
  channels: [{ network: 'whatsapp', messages: 1240 }], messages: 1240, reason: `looks like ${name}`, ...more });

/**
 * @param {string} id
 * @param {number} photos
 * @param {Partial<Card>} [more]
 * @returns {Card}
 */
const card = (id, photos, more = {}) => ({ id, faces: photos, photos, years: [2020, 2023], year_count: 4,
  sample: Array.from({ length: Math.min(12, photos) }, (_, at) => `${id}-face-${at}`), suggestions: [], sure: false, ...more });

/**
 * @param {Card[]} cards
 * @param {Someone[]} [someone]
 * @param {Card[]} [checks]
 * @returns {Deck}
 */
const deckOf = (cards, someone = [], checks = []) => ({ ready: true, building: false, progress: { read: 1, total: 1 }, error: null,
  took_ms: 1, position: '', crops: {}, owner: { id: 'person:owner', name: 'Person Owner' }, cards, checks,
  maybe: { people: new Set(checks.map(each => each.check?.person.key)).size, faces: checks.reduce((sum, each) => sum + each.sample.length, 0), by: {} },
  someone });

/**
 * @param {string} slug
 * @param {number} faces
 * @param {{ screen?: number, screens?: number, waiting?: number }} [more]
 * @returns {Card}
 */
const check = (slug, faces, { screen = 1, screens = 1, waiting = faces } = {}) => {
  const sample = Array.from({ length: faces }, (_, at) => `${slug}-maybe-${screen}-${at}`);
  return { id: `check:${slug}:${sample[0]}`, faces: faces, photos: faces, years: null, year_count: 0, sample, suggestions: [], sure: true,
    check: { person: { key: `person:${slug}`, id: `person:${slug}`, name: `Person ${slug.slice(-1).toUpperCase()} Example`, face: null, photo: null },
      screen, screens, waiting } };
};

/**
 * @param {Deck} deck
 * @param {string} id
 */
const byId = (deck, id) => /** @type {Card} */ (deck.cards.find(card => card.id === id));

const shownOf = (/** @type {Deck} */ deck, /** @type {ReturnType<typeof newSitting>} */ sitting) => {
  const [first] = queueOf(deck, sitting);
  if (viewOf(deck, sitting) === 'card') settle(sitting, first ?? null);
  return first?.id ?? null;
};

/** @param {string} key @param {{ metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean }} [mods] */
const key = (key, mods = {}) => ({ key, ...mods });

test('S1: every letter and digit is typed, on an empty field and after a name is deleted; ⌘ or ⌃ with one is not', () => {
  const letters = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'é', 'ß', '-', '\'', '/', '.'];
  for (const field of ['', 'So', 'Sonal Parab']) {
    for (const each of letters) {
      assert.deepEqual(keyCommand(key(each), { view: 'card', field, answered: true, skipped: true }), { kind: 'type' }, `${each} on “${field}”`);
    }
  }
  assert.equal(keyCommand(key(' '), { view: 'card', field: '', answered: false, skipped: false }), null);
  assert.deepEqual(keyCommand(key(' '), { view: 'card', field: 'Sonal', answered: false, skipped: false }), { kind: 'type' });
  assert.deepEqual(keyCommand(key('Backspace'), { view: 'card', field: 'S', answered: false, skipped: false }), { kind: 'type' });
  for (const mods of [{ metaKey: true }, { ctrlKey: true }]) {
    for (const each of ['s', 'x', 'n', '1', 'a']) assert.equal(keyCommand(key(each, mods), { view: 'card', field: '', answered: false, skipped: false }), null);
  }
  for (const view of /** @type {const} */ (['checkpoint', 'finish', 'empty'])) {
    for (const each of ['s', 'x', 'z', 'n', 'y', 'f', '1', '2', '3']) {
      assert.equal(keyCommand(key(each), { view, field: '', answered: true, skipped: true }), null, `${each} on ${view}`);
    }
  }
});

test('S2: the keys of the card, the checkpoint and the finish', () => {
  const empty = { view: /** @type {const} */ ('card'), field: '', answered: false, skipped: false };
  const text = { ...empty, field: 'Son' };
  for (const at of [empty, text]) {
    assert.deepEqual(keyCommand(key('ArrowUp'), at), { kind: 'up' });
    assert.deepEqual(keyCommand(key('ArrowDown'), at), { kind: 'down' });
    assert.deepEqual(keyCommand(key('Enter'), at), { kind: 'take' });
  }
  assert.deepEqual(keyCommand(key('ArrowRight'), empty), { kind: 'skip' });
  assert.deepEqual(keyCommand(key('ArrowLeft'), empty), { kind: 'back' });
  assert.deepEqual(keyCommand(key('z', { metaKey: true }), empty), { kind: 'back' });
  assert.equal(keyCommand(key('ArrowRight'), text), null);
  assert.equal(keyCommand(key('ArrowLeft'), text), null);
  assert.equal(keyCommand(key('z', { metaKey: true }), text), null);
  assert.equal(keyCommand(key('z', { metaKey: true, shiftKey: true }), empty), null);
  assert.deepEqual(keyCommand(key('Escape'), text), { kind: 'clear' });
  assert.deepEqual(keyCommand(key('Escape'), empty), { kind: 'leave' });
  assert.deepEqual(keyCommand(key('Escape'), { ...empty, answered: true }), { kind: 'finish' });
  assert.deepEqual(keyCommand(key('Enter'), { ...empty, view: 'checkpoint' }), { kind: 'keep' });
  assert.deepEqual(keyCommand(key('Escape'), { ...empty, view: 'checkpoint' }), { kind: 'finish' });
  assert.deepEqual(keyCommand(key('Enter'), { ...empty, view: 'finish', skipped: true }), { kind: 'again' });
  assert.equal(keyCommand(key('Enter'), { ...empty, view: 'finish', skipped: false }), null);
  assert.deepEqual(keyCommand(key('Escape'), { ...empty, view: 'finish' }), { kind: 'leave' });
  assert.deepEqual(keyCommand(key('Escape'), { ...empty, view: 'empty' }), { kind: 'leave' });

  assert.equal(moved(null, 4, 1), 0);
  assert.equal(moved(null, 4, -1), 3);
  assert.equal(moved(0, 4, -1), 0);
  assert.equal(moved(3, 4, 1), 3);
  assert.equal(moved(1, 4, 1), 2);
});

test('S3: the card shown is the deck less what the sitting took, Back\'s card first, by id', () => {
  const deck = deckOf([card('a', 40), card('b', 30), card('c', 20)]);
  const sitting = newSitting(deck, 0);
  assert.equal(shownOf(deck, sitting), 'a');
  answer(sitting, byId(deck, 'a'), null, 0);
  assert.equal(shownOf(deck, sitting), 'b');
  skip(sitting, 'b');
  assert.equal(shownOf(deck, sitting), 'c');
  back(sitting, deck);
  assert.equal(shownOf(deck, sitting), 'b');
  const newer = deckOf([card('b', 31), card('c', 20), card('d', 15)]);
  assert.equal(queueOf(newer, sitting)[0], newer.cards[0]);
  assert.deepEqual(queueOf(newer, sitting).map(each => each.id), ['b', 'c', 'd']);
  const without = deckOf([card('c', 20), card('d', 15)]);
  assert.equal(shownOf(without, sitting), 'c');
  assert.deepEqual(queueOf(newer, sitting).map(each => each.id), ['c', 'b', 'd']);
  assert.ok(sitting.history.every(step => typeof step.card === 'string'));
  assert.ok(sitting.open === null || typeof sitting.open === 'string');
});

test('S4: take a row, Back, Set aside, Back, Skip: the deck moves each time', () => {
  const deck = deckOf([card('a', 40, { suggestions: [suggestion('p1', 'Person A')], sure: true }), card('b', 30), card('c', 20)]);
  const sitting = newSitting(deck, 0);
  assert.equal(shownOf(deck, sitting), 'a');
  answer(sitting, byId(deck, 'a'), { key: 'p1', name: 'Person A', face: null }, 0);
  assert.equal(shownOf(deck, sitting), 'b');
  assert.equal(back(sitting, deck)?.card, 'a');
  assert.equal(shownOf(deck, sitting), 'a');
  answer(sitting, byId(deck, 'a'), null, 0);
  assert.equal(shownOf(deck, sitting), 'b');
  assert.equal(back(sitting, deck)?.card, 'a');
  assert.equal(shownOf(deck, sitting), 'a');
  skip(sitting, 'a');
  assert.equal(shownOf(deck, sitting), 'b');
  assert.equal(back(sitting, deck)?.card, 'a');
  assert.equal(shownOf(deck, sitting), 'a');
  skip(sitting, 'a');
  skip(sitting, 'b');
  skip(sitting, 'c');
  assert.equal(viewOf(deck, sitting), 'finish');
});

test('S5: Back is one answer deep; skips before it can still be taken back', () => {
  const deck = deckOf([card('a', 40), card('b', 30), card('c', 20), card('d', 15)]);
  const sitting = newSitting(deck, 0);
  assert.equal(canBack(sitting), false);
  assert.equal(back(sitting, deck), undefined);
  answer(sitting, byId(deck, 'a'), null, 0);
  skip(sitting, 'b');
  answer(sitting, byId(deck, 'c'), null, 0);
  assert.equal(back(sitting, deck)?.card, 'c');
  assert.equal(canBack(sitting), true);
  assert.equal(back(sitting, deck)?.card, 'b');
  assert.equal(canBack(sitting), false);
  assert.equal(back(sitting, deck), undefined);
  assert.equal(shownOf(deck, sitting), 'b');
  answer(sitting, byId(deck, 'b'), null, 0);
  assert.equal(canBack(sitting), true);
  assert.equal(back(sitting, deck)?.card, 'b');
});

test('S6: a failed answer leaves the sitting and comes first, the answers after it stand; a failed undo stands again', () => {
  const deck = deckOf([card('a', 40), card('b', 30), card('c', 20)]);
  const sitting = newSitting(deck, 0);
  shownOf(deck, sitting);
  sitting.out.add('a-face-1');
  typeInto(sitting, deck.cards[0], 'Pers');
  const first = answer(sitting, byId(deck, 'a'), { key: 'p1', name: 'Person A', face: null }, 1);
  shownOf(deck, sitting);
  const second = answer(sitting, byId(deck, 'b'), null, 0);
  assert.equal(shownOf(deck, sitting), 'c');
  failed(sitting, first);
  assert.equal(shownOf(deck, sitting), 'a');
  assert.deepEqual([[...sitting.out], sitting.field, sitting.lit], [['a-face-1'], 'Pers', 1]);
  assert.deepEqual(sitting.history, [second]);
  assert.equal(finishOf(sitting).named.length, 0);

  const retaken = answer(sitting, byId(deck, 'a'), null, 0);
  assert.equal(back(sitting, deck), retaken);
  assert.equal(shownOf(deck, sitting), 'a');
  putBack(sitting, retaken, 'not-sent');
  assert.equal(shownOf(deck, sitting), 'c');
  assert.equal(sitting.history.at(-1), retaken);
  assert.equal(canBack(sitting), true);
  assert.equal(back(sitting, deck), retaken);
});

test('S7: the checkpoint, once, before the first group under ten photos after the bigger ones', () => {
  const deck = deckOf([card('a', 40), card('b', BIG), card('c', BIG - 1), card('d', 3)]);
  const sitting = newSitting(deck, 0);
  assert.equal(viewOf(deck, sitting), 'card');
  answer(sitting, byId(deck, 'a'), null, 0);
  skip(sitting, 'b');
  assert.equal(viewOf(deck, sitting), 'checkpoint');
  back(sitting, deck);
  assert.equal(viewOf(deck, sitting), 'card');
  skip(sitting, 'b');
  pass(sitting);
  assert.equal(viewOf(deck, sitting), 'card');
  assert.equal(shownOf(deck, sitting), 'c');
  skip(sitting, 'c');
  skip(sitting, 'd');
  assert.equal(viewOf(deck, sitting), 'finish');
  again(sitting);
  assert.equal(shownOf(deck, sitting), 'b');
  skip(sitting, 'b');
  assert.equal(viewOf(deck, sitting), 'card');

  const done = newSitting(deck, 0);
  skip(done, 'a');
  skip(done, 'b');
  assert.equal(viewOf(deck, done), 'checkpoint');
  end(done);
  assert.equal(viewOf(deck, done), 'finish');
  again(done);
  skip(done, 'a');
  skip(done, 'b');
  assert.equal(viewOf(deck, done), 'card');

  const small = deckOf([card('c', 9), card('d', 3)]);
  assert.equal(viewOf(small, newSitting(small, 0)), 'card');
  const none = deckOf([]);
  assert.equal(viewOf(none, newSitting(none, 0)), 'empty');
});

test('S8: the rows: at most three suggestions, You first, the sure lit and no other, typing finds, Set aside last', () => {
  const me = suggestion('person:owner', 'Person Owner', { you: true, reason: 'the person your own accounts belong to' });
  const unsure = card('a', 40, { suggestions: [suggestion('p1', 'Person A'), suggestion('p2', 'Person B'),
    suggestion('p3', 'Person C'), suggestion('p4', 'Person D')] });
  assert.deepEqual(rowsOf(unsure, '', []).map(row => row.kind), ['suggestion', 'suggestion', 'suggestion', 'aside']);
  assert.equal(openingLight(unsure), null);
  const sure = { ...unsure, sure: true };
  assert.equal(openingLight(sure), 0);
  const mine = card('m', 60, { suggestions: [suggestion('p1', 'Person A'), me] });
  const rows = rowsOf(mine, '', []);
  assert.equal(rows[0].kind === 'suggestion' && rows[0].suggestion.you, true);
  assert.equal(openingLight(mine), null);
  assert.equal(openingLight({ ...mine, sure: true }), 0);
  assert.equal(rowsOf(card('n', 5), '', []).map(row => row.kind).join(), 'aside');

  /** @type {Someone[]} */
  const someone = [
    { id: 'g', name: 'Sonal Groups', origin: 'door', messages: 0, channels: [], target: { kind: 'person', id: 'g' }, groups_only: true },
    { id: 's', name: 'Sonal Parab', origin: 'door', messages: 12, channels: [{ network: 'whatsapp', messages: 12 }],
      target: { kind: 'person', id: 's' } },
  ];
  const typed = rowsOf(unsure, 'So', someone);
  assert.deepEqual(typed.map(row => row.kind === 'someone' ? row.someone.id : row.kind), ['s', 'g', 'new', 'aside']);
  const sitting = newSitting(deckOf([unsure]), 0);
  settle(sitting, unsure);
  typeInto(sitting, unsure, 'So');
  assert.equal(sitting.lit, 0);
  typeInto(sitting, unsure, '');
  assert.equal(sitting.lit, null);
});

test('S9: the finish counts each person once, the set aside and the skipped; Go through them again shows the skipped', () => {
  const deck = deckOf([card('a', 40), card('b', 30), card('c', 20), card('d', 15), card('e', 12)]);
  const sitting = newSitting(deck, 0);
  answer(sitting, byId(deck, 'a'), { key: 'person:p1', name: 'Person A', face: 'a-face-0' }, 0);
  answer(sitting, byId(deck, 'b'), { key: 'person:p1', name: 'Person A', face: 'a-face-0' }, 0);
  answer(sitting, byId(deck, 'c'), null, 0);
  skip(sitting, 'd');
  skip(sitting, 'e');
  assert.equal(viewOf(deck, sitting), 'finish');
  const finish = finishOf(sitting);
  assert.deepEqual([finish.named.map(each => each.name), finish.aside, finish.skipped], [['Person A'], 1, 2]);
  again(sitting);
  assert.deepEqual(queueOf(deck, sitting).map(each => each.id), ['d', 'e']);
  assert.equal(finishOf(sitting).skipped, 0);
  assert.equal(payoffWords({ name: 'Person A', photos: 135, days: 40 }), 'Person A · now in 135 photos');
  assert.equal(spanWords(card('a', 95)), 'in 95 photos, 2020–2023');
});

test('S10: a deck read again keeps the card\'s field and the marks on faces it still holds', () => {
  const deck = deckOf([card('a', 40), card('b', 30)]);
  const sitting = newSitting(deck, 0);
  shownOf(deck, sitting);
  typeInto(sitting, deck.cards[0], 'Pers');
  sitting.out.add('a-face-1');
  sitting.out.add('a-face-2');
  const newer = deckOf([card('a', 40, { sample: ['a-face-1', 'a-face-9'] }), card('b', 30)]);
  assert.equal(shownOf(newer, sitting), 'a');
  keepMarks(sitting, newer.cards[0].sample);
  assert.deepEqual([sitting.field, [...sitting.out]], ['Pers', ['a-face-1']]);
  skip(sitting, 'a');
  assert.equal(shownOf(newer, sitting), 'b');
  assert.deepEqual([sitting.field, sitting.out.size, sitting.all], ['', 0, false]);
});

test('S11: Back shows the last answer\'s card while the deck no longer holds it, the deck\'s once it does', () => {
  const deck = deckOf([card('a', 40), card('b', 30), card('c', 20)]);
  const sitting = newSitting(deck, 0);
  skip(sitting, 'a');
  answer(sitting, byId(deck, 'b'), { key: 'p1', name: 'Person A', face: null }, 0);
  const without = deckOf([card('a', 40), card('c', 20)]);
  assert.equal(shownOf(without, sitting), 'c');
  assert.equal(back(sitting, deck)?.card, 'b');
  assert.equal(queueOf(without, sitting)[0], deck.cards[1]);
  assert.equal(shownOf(without, sitting), 'b');
  assert.equal(viewOf(without, sitting), 'card');
  answer(sitting, deck.cards[1], null, 0);
  assert.equal(shownOf(without, sitting), 'c');
  back(sitting, deck);
  const holding = deckOf([card('a', 40), card('b', 31), card('c', 20)]);
  assert.equal(queueOf(holding, sitting)[0], holding.cards[1]);
  answer(sitting, holding.cards[1], null, 0);
  skip(sitting, 'c');
  back(sitting, deck);
  assert.equal(shownOf(deckOf([]), sitting), null);
});

test('S12: a refusal on a card answered again since says nothing; Back stays for an answer the home can still undo', () => {
  const deck = deckOf([card('a', 40), card('b', 30), card('c', 20)]);
  const sitting = newSitting(deck, 0);
  const first = answer(sitting, byId(deck, 'a'), null, 0);
  back(sitting, deck);
  const again = answer(sitting, byId(deck, 'a'), { key: 'p1', name: 'Person A', face: null }, 1);
  assert.equal(failed(sitting, first), false);
  assert.deepEqual(sitting.history, [again]);
  assert.equal(shownOf(deck, sitting), 'b');
  const second = answer(sitting, byId(deck, 'b'), null, 0);
  assert.equal(back(sitting, deck), second);
  assert.equal(canBack(sitting), false);
  assert.equal(failed(sitting, second), true);
  assert.equal(canBack(sitting), true);
  assert.equal(back(sitting, deck), again);
});

test('S13: a refused undo puts the answer back in its place, over a skip of its card taken meanwhile', () => {
  const deck = deckOf([card('a', 40), card('b', 30), card('c', 20)]);
  const sitting = newSitting(deck, 0);
  const given = answer(sitting, byId(deck, 'a'), { key: 'p1', name: 'Person A', face: null }, 0);
  given.act = 'act-1';
  back(sitting, deck);
  skip(sitting, 'a');
  putBack(sitting, given, 'refused');
  assert.deepEqual(sitting.history, [given]);
  assert.equal(given.act, 'act-1');
  assert.deepEqual([finishOf(sitting).named.length, finishOf(sitting).skipped], [1, 0]);

  const other = deckOf([card('a', 40), card('b', 30), card('c', 20)]);
  const order = newSitting(other, 0);
  skip(order, 'b');
  const before = answer(order, byId(other, 'a'), null, 0);
  assert.equal(back(order, other), before);
  assert.equal(back(order, other)?.card, 'b');
  const after = answer(order, byId(other, 'b'), null, 0);
  putBack(order, before, 'refused');
  assert.deepEqual(order.history, [before, after]);
  assert.equal(back(order, other), after);
});

test('S17: an undo lost or refused leaves Back spent for it; an answer never sent is given again as it was given', () => {
  for (const said of /** @type {const} */ (['unknown', 'refused'])) {
    const deck = deckOf([card('a', 40), card('b', 30), card('c', 20)]);
    const sitting = newSitting(deck, 0);
    const first = answer(sitting, byId(deck, 'a'), null, 0);
    first.act = 'act-1';
    const given = answer(sitting, byId(deck, 'b'), { key: 'p1', name: 'Person A', face: null }, 0);
    given.act = 'act-2';
    assert.equal(back(sitting, deck), given);
    putBack(sitting, given, said);
    assert.equal(sitting.history.at(-1), given, `${said}: the answer drawn as standing`);
    assert.equal(canBack(sitting), false, `${said}: Back offers the same undo again`);
    assert.equal(back(sitting, deck), undefined);
    skip(sitting, 'c');
    assert.equal(canBack(sitting), true);
    assert.equal(back(sitting, deck)?.kind, 'skip');
    assert.equal(canBack(sitting), false);
    const next = answer(sitting, byId(deck, 'c'), null, 0);
    assert.equal(back(sitting, deck), next, `${said}: Back disabled for an answer given since`);
  }
  const deck = deckOf([card('a', 40), card('b', 30), card('c', 20)]);
  const sitting = newSitting(deck, 0);
  const taken = answer(sitting, byId(deck, 'a'), null, 0);
  back(sitting, deck);
  const since = answer(sitting, byId(deck, 'b'), null, 0);
  putBack(sitting, taken, 'unknown');
  assert.deepEqual(sitting.history, [taken, since]);
  assert.equal(back(sitting, deck), since);

  const ranked = deckOf([card('a', 40, { suggestions: [suggestion('person:p1', 'Person A'), suggestion('person:p2', 'Person B')] }), card('b', 30)]);
  const deck2 = newSitting(ranked, 0);
  shownOf(ranked, deck2);
  deck2.out.add('a-face-1');
  typeInto(deck2, byId(ranked, 'a'), 'Pers');
  const named = answer(deck2, byId(ranked, 'a'), { key: 'person:p1', name: 'Person A', face: null }, 0, 'suggestion:person:p1');
  assert.equal(failed(deck2, named), true);
  const moved = deckOf([card('a', 40, { suggestions: [suggestion('person:p2', 'Person B'), suggestion('person:p1', 'Person A')] }), card('b', 30)]);
  assert.equal(shownOf(moved, deck2), 'a');
  typeInto(deck2, byId(moved, 'a'), 'Person B');
  deck2.out.clear();
  const given = retake(deck2, byId(moved, 'a'), named);
  assert.ok(given);
  assert.deepEqual([given.named, given.field, given.row, given.rowKey, [...given.out]],
    [{ key: 'person:p1', name: 'Person A', face: null }, 'Pers', 0, 'suggestion:person:p1', ['a-face-1']]);
  assert.equal(shownOf(moved, deck2), 'b');
  const fresh = newSitting(ranked, 0);
  const lost = answer(fresh, byId(ranked, 'a'), null, 0);
  failed(fresh, lost);
  answer(fresh, byId(ranked, 'a'), { key: 'person:p2', name: 'Person B', face: null }, 1);
  assert.equal(retake(fresh, byId(ranked, 'a'), lost), undefined);
  assert.equal(fresh.history.length, 1);
});

test('S14: ⌘Z goes Back on an empty field only while nothing was typed on the card', () => {
  const deck = deckOf([card('a', 40), card('b', 30)]);
  const sitting = newSitting(deck, 0);
  skip(sitting, 'a');
  shownOf(deck, sitting);
  const undoKey = key('z', { metaKey: true });
  const at = () => ({ view: /** @type {const} */ ('card'), field: sitting.field, typed: sitting.typed, answered: false, skipped: true });
  assert.deepEqual(keyCommand(undoKey, at()), { kind: 'back' });
  typeInto(sitting, deck.cards[1], 'Sonl');
  typeInto(sitting, deck.cards[1], '');
  assert.equal(keyCommand(undoKey, at()), null);
  assert.deepEqual(keyCommand(key('ArrowLeft'), at()), { kind: 'back' });
  skip(sitting, 'b');
  back(sitting, deck);
  shownOf(deck, sitting);
  assert.deepEqual(keyCommand(undoKey, at()), { kind: 'back' });
});

test('S15: a deck read again in another order keeps the card shown, until it is answered, skipped or gone', () => {
  const deck = deckOf([card('a', 40), card('b', 30), card('c', 20)]);
  const sitting = newSitting(deck, 0);
  assert.equal(shownOf(deck, sitting), 'a');
  typeInto(sitting, deck.cards[0], 'Pers');
  const reordered = deckOf([card('c', 20), card('b', 30), card('a', 40)]);
  assert.equal(shownOf(reordered, sitting), 'a');
  assert.equal(sitting.field, 'Pers');
  skip(sitting, 'a');
  assert.equal(shownOf(reordered, sitting), 'c');
  assert.equal(shownOf(deckOf([card('b', 30)]), sitting), 'b');
});

test('S16: check cards follow the name cards; two of 36 pressed out answer 34 theirs and two not; Space; one person alone', () => {
  const named = card('g-named', 40, { suggestions: [suggestion('person:person-s', 'Person S')], sure: true });
  const small = card('g-small', 4);
  const s1 = check('person-s', 36, { screen: 1, screens: 2, waiting: 50 });
  const s2 = check('person-s', 14, { screen: 2, screens: 2, waiting: 50 });
  const t1 = check('person-t', 3);
  const deck = deckOf([named, small], [], [s1, s2, t1]);
  const sitting = newSitting(deck, 0);
  assert.deepEqual(queueOf(deck, sitting).map(each => each.id), [named.id, small.id, s1.id, s2.id, t1.id]);
  skip(sitting, named.id);
  assert.equal(viewOf(deck, sitting), 'checkpoint');
  pass(sitting);
  skip(sitting, small.id);
  assert.equal(viewOf(deck, sitting), 'card');
  assert.equal(shownOf(deck, sitting), s1.id);
  assert.equal(openingLight(s1), 0);
  assert.deepEqual(checkRows(s1, new Set()), [{ kind: 'yes', kept: 36, out: 0 }, { kind: 'no', faces: 36 }]);
  const out = new Set([s1.sample[3], s1.sample[20]]);
  const [yes, no] = checkRows(s1, out);
  assert.deepEqual([yes, no], [{ kind: 'yes', kept: 34, out: 2 }, { kind: 'no', faces: 36 }]);
  const taken = checkAnswer(s1, out, yes);
  assert.equal(taken.yes.length, 34);
  assert.deepEqual(taken.no, [s1.sample[3], s1.sample[20]]);
  assert.ok(taken.yes.every(face => !out.has(face)));
  assert.deepEqual(checkAnswer(s1, out, no), { yes: [], no: s1.sample });
  const drawn = namingFaces({ faces: s1.sample.map(face => ({ src: '', label: face, on: false, attrs: { 'data-f-face': face } })), all: false, span: '', more: null });
  assert.equal(drawn.match(/data-f-face=/gu)?.length, 36);
  assert.deepEqual(checkRows(t1, new Set(t1.sample)), [{ kind: 'no', faces: 3 }]);
  assert.equal(checkedWords(/** @type {any} */ (s1.check), taken), '34 added to Person · 2 not Person');
  assert.equal(waitingWords(/** @type {any} */ (s1.check)).replace(/\s/gu, ' '), '1 of 2 screens · 50 faces');
  const at = { view: /** @type {const} */ ('card'), field: '', answered: false, skipped: false, check: true };
  assert.deepEqual(keyCommand(key(' '), at), { kind: 'peek' });
  assert.deepEqual(keyCommand(key('Escape'), { ...at, peeking: true }), { kind: 'peek' });
  for (const each of ['ArrowUp', 'ArrowDown', 'Enter', 'ArrowRight']) assert.equal(keyCommand(key(each), { ...at, peeking: true }), null, each);
  assert.deepEqual(keyCommand(key('Enter'), at), { kind: 'take' });
  assert.deepEqual(keyCommand(key('z', { metaKey: true }), at), { kind: 'back' });
  assert.equal(keyCommand(key('s'), at), null, 'a letter is no command on a check card');
  for (const face of out) sitting.out.add(face);
  const said = answer(sitting, s1, null, 1);
  assert.equal(shownOf(deck, sitting), s2.id);
  assert.equal(back(sitting, deck), said);
  assert.equal(shownOf(deck, sitting), s1.id);
  assert.deepEqual([[...sitting.out].sort(), sitting.lit], [[...out].sort(), 1]);
  sitting.lit = 0;
  const again = answer(sitting, s1, null, 0);
  shownOf(deck, sitting);
  failed(sitting, again);
  assert.equal(shownOf(deck, sitting), s1.id);
  assert.deepEqual([[...sitting.out].sort(), sitting.lit], [[...out].sort(), 0]);
  answer(sitting, s1, null, 0);
  assert.equal(shownOf(deck, sitting), s2.id);
  assert.deepEqual(finishOf(sitting), { named: [], aside: 0, checked: 1, skipped: 2 });
  const alone = newSitting(deck, 0, 'person:person-s');
  assert.deepEqual(queueOf(deck, alone).map(each => each.id), [s1.id, s2.id, named.id]);
  assert.equal(viewOf(deck, alone), 'card');
});
