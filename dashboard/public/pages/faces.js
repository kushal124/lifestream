// @ts-check
/** @import { Answer, Card, CheckRow, Deck, Row, Sitting, Target, Unread } from '../lib/faces.js' */
import { count, counted } from '../lib/words.js';
import { button, emptyState, pageLack, personFace, quietRing, reading, readingAgain, waitLine } from '../ui/kit/index.js';
import { actUntilAnswered, fetchFaceGroup, fetchFaces, notSaved, pictureUrl } from '../lib/api.js';
import { readHost } from '../lib/host.js';
import { pageReach, wordsOr } from '../lib/reach.js';
import {
  again, answer, asideWords, back, BIG, canBack, channelWords, checkAnswer, checkedWords, checkRows, end, failed,
  finishOf, finishWords, firstName, keepMarks, keyCommand, moved, newSitting, pass, payoffWords, putBack, queueOf,
  relight, retake, rowKey, rowsOf, settle, skip, smallerWords, someoneWords, spanWords, typeInto, viewOf, waitingWords,
} from '../lib/faces.js';
import {
  namingAsk, namingCard, namingCheck, namingFaces, namingFoot, namingLeft, namingPeek, namingReading, namingRows,
  namingStop, placePeek, SHOWN,
} from '../ui/people/naming.js';
import { photoOf } from '../ui/people/list.js';
import { changedPast, onHomeChange } from '../ui/live.js';

const NOT_HERE = 'Your faces aren’t on this Mac yet.';
const UNREAD = 'Your faces couldn’t be read.';

/** @param {unknown} error */
const messageOf = error => wordsOr(error, '');
const LONG_PRESS_MS = 500;

/**
 * @param {HTMLElement} main
 * @param {{ leave: () => void, tools: HTMLElement | null, only?: string | null, deck?: Deck | Unread | null }} page
 * @returns {{ stop: () => void, saved: () => Promise<boolean> }}
 */
export function mountFaces(main, page) {
  let alive = true;
  /** @type {Deck | null} */
  let deck = null;
  /** @type {Unread | null} */
  let unread = null;
  /** @type {import('../lib/reach.js').Drawn | null} */
  let failure = null;
  const reach = pageReach(readHost(window), main);
  /** @param {import('../lib/reach.js').Retry | null} [retry] */
  const readAgain = (retry = null) => void read(retry);
  /** @type {Sitting | null} */
  let sitting = null;
  let payoff = '';
  /** @type {{ said: import('../lib/reach.js').Said, words: string, again: (() => void) | null } | null} */
  let note = null;
  /** @type {Map<string, string[] | null>} */
  const groups = new Map();
  /** @type {Map<string, string>} */
  const crops = new Map();
  /** @param {string} face */
  const pictureOf = face => crops.get(face) ?? '';
  /** @param {Record<string, string> | undefined} named */
  const keepCrops = named => {
    for (const [face, crop] of Object.entries(named ?? {})) crops.set(face, crop);
  };
  let shipping = Promise.resolve();
  /**
   * @param {string} lead
   * @returns {{ waiting: (error: unknown) => void, left: () => boolean, answered: () => void }}
   */
  const checking = lead => {
    /** @type {typeof note} */
    let shown = null;
    return {
      waiting: error => {
        if (!alive) return;
        shown = { ...notSaved(error, messageOf(error), lead), again: null };
        note = shown;
        draw();
      },
      left: () => !alive,
      answered: () => {
        if (!alive || note === null || note !== shown) return;
        note = null;
        draw();
      },
    };
  };
  let refused = 0;
  let deckAsked = 0;
  /** @type {Map<string, number>} */
  const groupAsked = new Map();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let rereading;
  /** @type {Map<string, string>} */
  const drawn = new Map();
  /** @type {Set<string>} */
  const ahead = new Set();
  /** @type {string | null} */
  let hovered = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pressing;
  let pressed = false;

  reading(main, true);
  if (page.tools) reading(page.tools, true);
  main.innerHTML = namingReading(null);

  const field = () => /** @type {HTMLInputElement | null} */ (main.querySelector('#face-name'));
  const shown = () => (deck && sitting && viewOf(deck, sitting) === 'card' ? queueOf(deck, sitting)[0] ?? null : null);
  const answered = () => Boolean(sitting?.history.some(step => step.kind === 'answer'));

  function draw() {
    if (!alive) return;
    if (!deck || !sitting) {
      const stopped = failure?.kind === 'lack' || Boolean(unread?.error && !unread.building);
      reading(main, !stopped);
      if (page.tools) reading(page.tools, !stopped);
      putTools(stopped ? '' : null);
      const markup = failure?.kind === 'lack' ? failedView(failure.words ?? UNREAD, failure.retry)
        : failure ? readingView(unread).replace(waitLine(), readingAgain(failure, NOT_HERE)) : readingView(unread);
      if (main.innerHTML !== markup) main.innerHTML = markup;
      return;
    }
    reading(main, false);
    if (page.tools) reading(page.tools, false);
    const view = viewOf(deck, sitting);
    const queue = queueOf(deck, sitting);
    putTools(view === 'card' || view === 'checkpoint' ? leftWords(queue) : '');
    if (view !== 'card') {
      settle(sitting, null);
      if (sitting.only !== null && (view === 'finish' || view === 'empty')) {
        page.leave();
        return;
      }
      main.innerHTML = view === 'checkpoint' ? checkpointView(queue.filter(card => !card.check && card.photos < BIG).length)
        : view === 'finish' ? finishView(sitting) : emptyView();
      return;
    }
    const card = queue[0];
    settle(sitting, card);
    const every = groups.get(card.id);
    if (every || !sitting.all) keepMarks(sitting, every ?? card.sample);
    const onScreen = /** @type {HTMLElement | null} */ (main.querySelector('[data-f-card]'));
    if (onScreen?.dataset.fCard === card.id) {
      drawPart('faces', card);
      drawPart('rows', card);
      drawPart('foot', card);
      const input = field();
      if (input && input.value !== sitting.field) input.value = sitting.field;
    } else {
      const parts = { faces: facesPart(card, sitting), rows: rowsPart(card, sitting), foot: footPart(sitting) };
      for (const [part, markup] of Object.entries(parts)) drawn.set(part, markup);
      main.innerHTML = card.check ? namingCheck({ id: card.id, ask: askPart(card), ...parts })
        : namingCard({ id: card.id, field: sitting.field, ...parts });
      placePeek(main);
      const input = field();
      if (input) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
    prefetch(queue.slice(1, 3));
  }

  /** @param {Card[]} queue */
  function leftWords(queue) {
    const names = queue.filter(card => !card.check).length;
    const people = new Set(queue.flatMap(card => (card.check ? [card.check.person.key] : []))).size;
    return [names ? `${counted(names, 'group')} to name` : '', people ? `${counted(people, 'person', 'people')} to check` : '']
      .filter(Boolean).join(' · ');
  }

  /**
   * @param {'faces' | 'rows' | 'foot'} part
   * @param {Card} card
   */
  function drawPart(part, card) {
    const at = main.querySelector(`#face-${part}`);
    if (!at || !sitting) return;
    const markup = part === 'faces' ? facesPart(card, sitting) : part === 'rows' ? rowsPart(card, sitting) : footPart(sitting);
    if (drawn.get(part) === markup) return;
    drawn.set(part, markup);
    if (part !== 'faces') {
      at.innerHTML = markup;
      return;
    }
    const scrolled = at.querySelector('.naming-gridbox')?.scrollTop ?? 0;
    at.outerHTML = markup;
    const box = main.querySelector('#face-faces .naming-gridbox');
    if (box) box.scrollTop = scrolled;
    placePeek(main);
  }

  /** @param {string | null} left */
  function putTools(left) {
    const markup = (left === '' ? '' : namingLeft(left))
      + (left ? button('Done', { variant: 'plain', key: 'Esc', attrs: { 'data-f-done': '' } }) : '');
    if (!page.tools || drawn.get('tools') === markup) return;
    drawn.set('tools', markup);
    page.tools.innerHTML = markup;
  }

  /** @param {Card[]} next */
  function prefetch(next) {
    for (const card of next) {
      for (const face of [...card.sample.slice(0, SHOWN), ...card.suggestions.map(each => each.face)]) {
        const hash = face ? pictureOf(face) : '';
        if (!hash || ahead.has(hash)) continue;
        ahead.add(hash);
        new Image().src = pictureUrl(hash, 'tile');
      }
    }
  }

  /**
   * @param {Card} card
   * @param {Sitting} at
   */
  function facesPart(card, at) {
    if (card.check) {
      const name = firstName(card.check);
      const faces = card.sample.map((face, index) => ({
        hash: pictureOf(face), label: `Face ${index + 1}`, on: at.out.has(face), attrs: { 'data-f-face': face },
      }));
      const peek = at.peek ? namingPeek({ hash: `sha256:${at.peek.slice(0, at.peek.indexOf(':'))}`, face: at.peek,
        words: 'Space or Esc to close' }) : '';
      return namingFaces({ faces, all: false, more: null,
        span: faces.length === 1 ? '' : `Best matches first. Click any that aren’t ${name}, then ⏎.`,
        label: `Faces that may be ${name}`, peek });
    }
    const every = at.all ? groups.get(card.id) ?? null : null;
    const faces = (every ?? card.sample.slice(0, SHOWN)).map((face, index) => ({
      hash: pictureOf(face), label: `Face ${index + 1}`, on: at.out.has(face), attrs: { 'data-f-face': face },
    }));
    const more = card.faces <= SHOWN ? null : every ? { label: `Show ${SHOWN}` }
      : { label: `Show all ${count(card.faces)}`, busy: at.all };
    return namingFaces({ faces, all: Boolean(every), span: spanWords(card), more });
  }

  /**
   * @param {Card} card
   * @param {Sitting} at
   */
  function rowsPart(card, at) {
    if (card.check) {
      const checks = checkRows(card, at.out);
      return namingRows(checks.map(row => checkWords(row, card)), relight(at, checks.map(row => row.kind)));
    }
    const rows = rowsOf(card, at.field, deck?.someone ?? []);
    const none = rows.length === 1 && !at.field.trim() ? 'No suggestion from your messages or Google Photos' : '';
    return namingRows(rows.map(rowWords), relight(at, rows.map(rowKey)), none);
  }

  /** @param {Card} card */
  function askPart(card) {
    const check = /** @type {NonNullable<Card['check']>} */ (card.check);
    return namingAsk({ face: personFace({ name: check.person.name, photo: faceOfCheck(check), size: 'tile' }),
      name: firstName(check), waiting: waitingWords(check) });
  }

  /** @param {NonNullable<Card['check']>} check */
  const faceOfCheck = check => photoOf(check.person) || (check.person.face ? pictureOf(check.person.face) : '');

  /**
   * @param {CheckRow} row
   * @param {Card} card
   * @returns {import('../ui/people/naming.js').NamingRow}
   */
  function checkWords(row, card) {
    const check = /** @type {NonNullable<Card['check']>} */ (card.check);
    const name = firstName(check);
    const one = card.sample.length === 1;
    if (row.kind === 'no') {
      return { lead: quietRing('close'), name: one ? `This isn’t ${name}` : `None of these are ${name}`,
        line: one ? 'It leaves the list, and stays unnamed' : 'They leave the list, and stay unnamed' };
    }
    return {
      lead: personFace({ name: check.person.name, photo: faceOfCheck(check) }),
      name: row.out ? `Add ${count(row.kept)} to ${name}` : one ? `This is ${name}` : `All ${count(row.kept)} are ${name}`,
      line: row.out ? `The ${count(row.out)} you clicked ${row.out === 1 ? 'is' : 'are'} not ${name}`
        : one ? 'Their face, in this photo' : `Click any that aren’t ${name} first`,
    };
  }

  /**
   * @param {Row} row
   * @returns {import('../ui/people/naming.js').NamingRow}
   */
  function rowWords(row) {
    if (row.kind === 'suggestion') {
      const { suggestion } = row;
      return {
        lead: personFace({ name: suggestion.name, photo: suggestion.face ? pictureOf(suggestion.face) : '' }),
        name: suggestion.you ? `You · ${suggestion.name}` : suggestion.name,
        line: [channelWords(suggestion.channels), suggestion.reason].filter(Boolean).join(' · '),
      };
    }
    if (row.kind === 'someone') {
      return { lead: personFace({ name: row.someone.name }), name: row.someone.name, line: someoneWords(row.someone) };
    }
    if (row.kind === 'new') {
      return { lead: quietRing('add'), name: `New person “${row.name}”`, line: 'Not in your people yet' };
    }
    return { lead: quietRing('close'), name: 'Set aside', line: 'Not someone you’ll name, or not a face' };
  }

  /** @param {Sitting} at */
  const footPart = at => namingFoot({ said: payoff, failure: note && { said: note.said, words: note.words, again: note.again !== null },
    back: canBack(at) });

  /** @param {number} smaller */
  const checkpointView = smaller => namingStop({
    title: `That’s everyone in ${BIG} or more photos`, line: smallerWords(smaller),
    acts: button('Keep going', { variant: 'primary', key: '⏎', attrs: { 'data-f-keep': '' } })
      + button('Done', { variant: 'plain', key: 'Esc', attrs: { 'data-f-finish': '' } }),
  });

  /** @param {Sitting} at */
  function finishView(at) {
    const { named, aside, checked, skipped } = finishOf(at);
    const done = [aside ? `${count(aside)} set aside` : '', checked ? `${counted(checked, 'screen')} checked` : '',
      skipped ? `${count(skipped)} skipped` : ''].filter(Boolean).join(' · ');
    return namingStop({
      title: named.length ? finishWords(named.length, Date.now() - at.began) : done,
      named: named.map(each => ({ name: each.name, photo: each.face ? pictureOf(each.face) : '' })),
      line: named.length ? done : '',
      acts: (skipped
        ? button('Go through the skipped again', { variant: 'primary', key: '⏎', attrs: { 'data-f-again': '' } }) : '')
        + button('Done', { variant: skipped ? 'plain' : 'primary', key: 'Esc', attrs: { 'data-f-leave': '' } }),
    });
  }

  const emptyView = () => namingStop({
    title: 'Everyone in your photos is named or set aside',
    line: 'New photos of the people you named are named as they arrive.',
    acts: button('Done', { variant: 'primary', key: 'Esc', attrs: { 'data-f-leave': '' } }),
  });

  /** @param {Unread | null} at */
  function readingView(at) {
    if (at?.error && !at.building) return failedView(at.error, true);
    const { read: done, total } = at?.progress ?? { read: 0, total: 0 };
    return namingReading(total > 0
      ? { value: `${count(Math.min(done, total))} of ${count(total)}`, share: Math.min(1, done / total) } : null);
  }

  /** @param {string} why @param {boolean} retry */
  const failedView = (why, retry) => {
    if (why.startsWith('Lifestream has no faces yet.')) {
      return emptyState('faces', 'No faces yet', { detail: 'Find the people in your photos.',
        action: { label: 'Turn on faces', href: '#view=people&focus=faces&dialog=faces' } });
    }
    return `<div class="naming-page">${pageLack(why, retry ? { retry: { 'data-f-retry': '' } } : {})}</div>`;
  };

  /**
   * @param {Answer} step
   * @param {Record<string, unknown>} action
   * @param {string} said
   */
  function ship(step, action, said) {
    shipping = shipping.then(async () => {
      try {
        const told = checking('Not saved');
        const reply = await actUntilAnswered({ ...action, of: 'people' }, told);
        told.answered();
        step.act = reply.act;
        if (step.named && reply.id) step.named.key = reply.id;
        if (reply.payoff && alive && sitting?.history.findLast(each => each.kind === 'answer') === step) {
          payoff = payoffWords(reply.payoff);
          const card = shown();
          if (card) drawPart('foot', card);
        }
      } catch (error) {
        if (!alive || !sitting) return;
        if (failed(sitting, step)) {
          refused += 1;
          const failure = notSaved(error, messageOf(error));
          note = { ...failure, again: failure.said !== 'not-sent' ? null : () => {
            const card = shown();
            const given = card && sitting ? retake(sitting, card, step) : undefined;
            if (!given) return;
            note = null;
            payoff = said;
            ship(given, action, said);
            draw();
          } };
          payoff = '';
        }
        draw();
      }
    });
  }

  /** @param {number | null} index */
  function take(index) {
    const card = shown();
    if (!card || !sitting || !deck || index === null) return;
    if (card.check) {
      const row = checkRows(card, sitting.out)[index];
      if (!row) return;
      const { person } = card.check;
      const said = checkAnswer(card, sitting.out, row);
      note = null;
      payoff = checkedWords(card.check, said);
      const step = answer(sitting, card, { key: person.key, name: person.name, face: person.face }, index, row.kind);
      ship(step, { kind: 'maybe', id: person.id, ...said }, payoff);
      draw();
      return;
    }
    const row = rowsOf(card, sitting.field, deck.someone)[index];
    if (!row) return;
    const out = [...sitting.out];
    note = null;
    if (row.kind === 'aside') {
      payoff = asideWords(card);
      ship(answer(sitting, card, null, index, rowKey(row)), { kind: 'ignore', cluster: card.id }, payoff);
      draw();
      return;
    }
    /** @type {{ target: Target, name: string, face: string | null }} */
    const chosen = row.kind === 'suggestion' ? { target: row.suggestion.target, name: row.suggestion.name, face: row.suggestion.face }
      : row.kind === 'someone' ? { target: row.someone.target, name: row.someone.name, face: null }
        : { target: { kind: 'new', name: row.name }, name: row.name, face: null };
    const { target, name } = chosen;
    const key = target.kind === 'person' ? target.id : `new:${target.name.toLocaleLowerCase()}`;
    const step = answer(sitting, card, { key, name, face: chosen.face ?? card.sample[0] ?? null }, index, rowKey(row));
    payoff = name;
    ship(step, { kind: 'name', cluster: card.id, target, out }, payoff);
    draw();
  }

  function skipShown() {
    const card = shown();
    if (!card || !sitting) return;
    skip(sitting, card.id);
    note = null;
    draw();
  }

  function goBack() {
    if (!sitting || !deck) return;
    const at = sitting;
    const step = back(at, deck);
    if (!step) return;
    payoff = '';
    note = null;
    if (step.kind === 'answer') {
      shipping = shipping.then(async () => {
        if (step.act === null) return;
        try {
          const told = checking('Not undone');
          await actUntilAnswered({ of: 'people', kind: 'undo', act: step.act }, told);
          told.answered();
        } catch (error) {
          if (!alive) return;
          const failure = notSaved(error, messageOf(error), 'Not undone');
          putBack(at, step, failure.said);
          refused += 1;
          note = { ...failure, again: failure.said !== 'not-sent' ? null : () => {
            if (sitting?.history.at(-1) === step) goBack();
          } };
          draw();
        }
      });
    }
    draw();
  }

  function done() {
    const view = deck && sitting ? viewOf(deck, sitting) : 'empty';
    if (!sitting || sitting.only !== null || view === 'finish' || view === 'empty' || !answered()) {
      page.leave();
      return;
    }
    end(sitting);
    draw();
  }

  /** @param {Card} card */
  function showAll(card) {
    if (!sitting) return;
    sitting.all = !(sitting.all && groups.get(card.id));
    if (!sitting.all) return drawPart('faces', card);
    if (!groups.get(card.id)) readGroup(card.id);
    drawPart('faces', card);
  }

  /** @param {string} id */
  function readGroup(id) {
    if (!groups.has(id)) groups.set(id, null);
    const mine = (groupAsked.get(id) ?? 0) + 1;
    groupAsked.set(id, mine);
    fetchFaceGroup(id).then(group => {
      if (groupAsked.get(id) !== mine) return;
      keepCrops(group.crops);
      groups.set(id, group.every ?? group.sample);
    }, () => {
      if (groupAsked.get(id) !== mine) return;
      groups.delete(id);
      if (sitting?.open === id) {
        sitting.all = false;
        note = { said: 'refused', words: 'Couldn’t read all of this group’s faces.', again: null };
      }
    }).finally(() => {
      if (alive && sitting?.open === id) draw();
    });
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (!alive || !deck || !sitting || !main.isConnected || main.closest('[hidden]') || event.isComposing) return;
    const input = field();
    const target = event.target;
    const inDeck = target === document.body || (target instanceof Node && (main.contains(target)
      || Boolean(page.tools?.contains(target))));
    if (!inDeck) return;
    if (target instanceof Element && target !== input && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (event.key === 'Enter' && target instanceof HTMLButtonElement && target.dataset.fFace === undefined) return;
    const command = keyCommand(event, { view: viewOf(deck, sitting), field: sitting.field, typed: sitting.typed,
      answered: answered(), skipped: finishOf(sitting).skipped > 0, check: Boolean(shown()?.check),
      peeking: sitting.peek !== null });
    if (!command) return;
    if (command.kind === 'type') {
      if (input && document.activeElement !== input) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      }
      return;
    }
    event.preventDefault();
    const card = shown();
    if (command.kind === 'peek') {
      const face = sitting.peek ? null : hovered ?? (/** @type {HTMLElement | null} */ (document.activeElement)?.dataset?.fFace ?? null);
      if (card && (sitting.peek || face)) peekAt(card, face);
    } else if (command.kind === 'up' || command.kind === 'down') {
      if (!card) return;
      const count = card.check ? checkRows(card, sitting.out).length : rowsOf(card, sitting.field, deck.someone).length;
      sitting.lit = moved(sitting.lit, count, command.kind === 'down' ? 1 : -1);
      sitting.litKey = null;
      drawPart('rows', card);
      main.querySelector('.naming-rows .ck-namerow.is-lit')?.scrollIntoView({ block: 'nearest' });
    } else if (command.kind === 'take') take(sitting.lit);
    else if (command.kind === 'skip') skipShown();
    else if (command.kind === 'back') goBack();
    else if (command.kind === 'clear' && card) {
      if (input) input.value = '';
      typeInto(sitting, card, '');
      drawPart('rows', card);
    } else if (command.kind === 'finish') {
      end(sitting);
      draw();
    } else if (command.kind === 'leave') done();
    else if (command.kind === 'keep') {
      pass(sitting);
      draw();
    } else if (command.kind === 'again') {
      again(sitting);
      draw();
    }
  }

  /**
   * @param {Card} card
   * @param {string | null} face
   */
  function peekAt(card, face) {
    if (!sitting) return;
    sitting.peek = face !== null && card.sample.includes(face) ? face : null;
    drawPart('faces', card);
  }

  main.addEventListener('mouseover', event => {
    const face = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-f-face]'));
    hovered = face?.dataset.fFace ?? null;
  });
  main.addEventListener('mouseleave', () => {
    hovered = null;
  });
  main.addEventListener('pointerdown', event => {
    const face = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-f-face]'));
    const card = shown();
    pressed = false;
    clearTimeout(pressing);
    if (!face || !card?.check) return;
    pressing = setTimeout(() => {
      pressed = true;
      peekAt(card, face.dataset.fFace ?? null);
    }, LONG_PRESS_MS);
  });
  for (const ended of ['pointerup', 'pointercancel', 'pointerleave']) main.addEventListener(ended, () => clearTimeout(pressing));

  main.addEventListener('input', event => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    const card = shown();
    if (input.id !== 'face-name' || !card || !sitting) return;
    typeInto(sitting, card, input.value);
    drawPart('rows', card);
  });

  /** @param {MouseEvent} event */
  function onClick(event) {
    const control = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(
      '[data-f-face],[data-f-row],[data-f-back],[data-f-skip],[data-f-all],[data-f-keep],[data-f-finish],[data-f-again],'
      + '[data-f-leave],[data-f-done],[data-f-retry],[data-f-peek],[data-f-again-act]'));
    if (!control) return;
    if (pressed) {
      pressed = false;
      return;
    }
    const data = control.dataset;
    if (data.fRetry !== undefined) {
      failure = null;
      unread = null;
      draw();
      void read();
    } else if (data.fLeave !== undefined) page.leave();
    else if (data.fDone !== undefined) done();
    if (!deck || !sitting) return;
    if (data.fAgainAct !== undefined) {
      note?.again?.();
      return;
    }
    const card = shown();
    if (data.fPeek !== undefined && card) {
      peekAt(card, null);
      return;
    }
    if (data.fFace !== undefined && card) {
      const out = !sitting.out.has(data.fFace);
      if (out) sitting.out.add(data.fFace);
      else sitting.out.delete(data.fFace);
      control.classList.toggle('is-on', out);
      control.setAttribute('aria-pressed', String(out));
      drawn.set('faces', facesPart(card, sitting));
      if (card.check) {
        sitting.lit = Math.min(sitting.lit ?? 0, checkRows(card, sitting.out).length - 1);
        drawPart('rows', card);
      }
      const input = field();
      if (input && document.activeElement !== input) {
        const { selectionStart, selectionEnd, selectionDirection } = input;
        input.focus({ preventScroll: true });
        input.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
      }
    } else if (data.fRow !== undefined) take(Number(data.fRow));
    else if (data.fBack !== undefined) goBack();
    else if (data.fSkip !== undefined) skipShown();
    else if (data.fAll !== undefined && card) showAll(card);
    else if (data.fKeep !== undefined) {
      pass(sitting);
      draw();
    } else if (data.fFinish !== undefined) {
      end(sitting);
      draw();
    } else if (data.fAgain !== undefined) {
      again(sitting);
      draw();
    }
  }

  main.addEventListener('click', onClick);
  page.tools?.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);

  /** @param {Deck} fresh */
  function stand(fresh) {
    deck = fresh;
    keepCrops(fresh.crops);
    failure = null;
    sitting ??= newSitting(fresh, Date.now(), page.only ?? null);
  }

  /** @param {import('../lib/reach.js').Retry | null} [retry] */
  async function read(retry = null) {
    clearTimeout(rereading);
    const mine = ++deckAsked;
    const begun = reach.begin(retry);
    try {
      const fresh = await fetchFaces();
      if (!alive || mine !== deckAsked) return;
      if (!fresh.ready) {
        unread = fresh;
        if (deck === null) draw();
        rereading = setTimeout(() => void read(), fresh.building ? 1_000 : 10_000);
        return;
      }
      stand(fresh);
      const asked = /** @type {Sitting} */ (sitting).open;
      const open = asked !== null && groups.has(asked) ? asked : null;
      for (const id of [...groups.keys()]) if (id !== open) groups.delete(id);
      if (open) readGroup(open);
      draw();
    } catch (error) {
      if (!alive || deck || mine !== deckAsked) return;
      failure = reach.failed(error, begun, readAgain);
      if (failure.kind === 'wait') rereading = setTimeout(() => readAgain(), Math.max(0, failure.until - Date.now()));
      draw();
    }
  }

  const stop = onHomeChange(change => {
    if (!alive) return;
    const people = change.people && changedPast(change.peopleChanged, deck?.people_position);
    if (change.reset || people || [...change.imports].some(source => source.startsWith('faces:') || source.startsWith('people:'))) void read();
  });
  if (page.deck?.ready) {
    stand(page.deck);
    draw();
  }
  void read();

  return {
    stop: () => {
      alive = false;
      clearTimeout(rereading);
      reach.close();
      clearTimeout(pressing);
      stop();
      document.removeEventListener('keydown', onKey);
      page.tools?.removeEventListener('click', onClick);
    },
    saved: async () => {
      const before = refused;
      for (let waited = null; waited !== shipping;) {
        waited = shipping;
        await waited;
      }
      return alive && refused === before;
    },
  };
}
