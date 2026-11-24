import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, answering, chatting, CHAT, FIELD, leftOn, MAC, offering, QUESTION, resting, SEE, seeing, tourPage, WORDS }
  from './stand-ins/tour-page.mjs';

const page = tourPage({ file: 'tour-first' });
/** @type {Awaited<ReturnType<typeof page.journey>>['chrome']} */
let chrome;
/** @type {Awaited<ReturnType<typeof page.journey>>['front']} */
let front;

before(async () => {
  await page.open();
  ({ chrome, front } = await page.journey('tour-first'));
});

afterEach(() => {
  front?.reset();
  assert.deepEqual(chrome?.thrown.splice(0), []);
});

after(() => page.close());

const { docks: docked, edit, field, holds, key, load, offered, pressOn, snap } = page;
const ANSWER = 'A quiet morning. You were in Keynote from nine, then on a call with Person A.';
const HIDDEN = { seen: { asked: [], answered: [{ start: ANSWER.indexOf('Person A'), end: ANSWER.indexOf('Person A') + 8,
  placeholder: 'Person 1' }] } };
const LONG = Array.from({ length: 14 }, (_, at) => `At ${8 + at}:00 you worked on the plan in Keynote, then answered a few messages `
  + 'and took a short walk before the next call.').join('\n\n') + '\n\nLater you were on a call with Person A.';
const LONG_HIDDEN = { seen: { asked: [], answered: [{ start: LONG.indexOf('Person A'), end: LONG.indexOf('Person A') + 8,
  placeholder: 'Person 1' }] } };
const SHOWN = '#main > .main__section:not([hidden])';
const EYE = `${SHOWN} [data-ck-seen-eye]`;

describe('tour-first: the first question offered, sent, and its answer', () => {
  test('F1: the first question offered, its words exact, Send and Not now, nothing sent', async () => {
    await offered();
    await holds('ask', 1, 6);
    assert.equal(await field(), QUESTION);
    assert.match(await chrome.evaluate(`document.querySelector(${JSON.stringify(act('pass'))}).className`), /ck-btn--secondary/);
    assert.match(await chrome.evaluate(`document.querySelector(${JSON.stringify(act('lead'))}).className`), /ck-btn--primary/);
    assert.deepEqual(front.questions, []);
    assert.ok(front.asked.every(each => each.startsWith('GET ')), `Ask asked ${front.asked}`);
    await snap('first-offered', offering(6));
    await pressOn(act('pass'));
    await chrome.until(resting(3, 6, true));
    assert.equal(await field(), '', 'Not now withdrew the offered question');
    assert.deepEqual(front.questions, []);
    await key('Escape');
    await chrome.until(leftOn('connectors'));
  });

  test('F2: Send asks it; no card while it answers, then the eye is ringed; See what your AI saw turns it on', async () => {
    await offered();
    await pressOn(act('lead'));
    await chrome.until(`location.hash.includes('tour=2') && location.hash.includes(${JSON.stringify(CHAT)})`);
    assert.deepEqual(front.questions.map(each => each.question), [QUESTION]);
    await chrome.until(answering);
    await snap('first-answering', answering);
    front.answer(ANSWER, {}, HIDDEN);
    await chrome.until(seeing);
    await holds('answer', 2, 6);
    await snap('first-seen', seeing);
    await pressOn(act('pass'));
    await chrome.until(`${seeing} && document.querySelector('[data-ck-seen-eye]').getAttribute('aria-pressed') === 'true'`);
    await holds('answer', 2, 6, { focus: SEE });
    await pressOn(act('lead'));
    await chrome.until(resting(3, 6, true));
    await key('ArrowLeft');
    await chrome.until(seeing);
    await key('Escape');
    await chrome.until(leftOn('ask'));
  });

  test('F8: a long answer docks the card at the bottom right, off the answer; after What your AI saw closes, the eye and its whole ring sit above the composer', async () => {
    await offered();
    await pressOn(act('lead'));
    await chrome.until(answering);
    front.answer(LONG, {}, LONG_HIDDEN);
    await chrome.until(`${seeing} && document.querySelector('.ck-spot--docked')`);
    await pressOn(act('pass'));
    await chrome.until(`${seeing} && document.querySelector(${JSON.stringify(EYE)}).getAttribute('aria-pressed') === 'true'`);
    await pressOn(EYE);
    const box = name => `(each => { const r = each.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })(${name})`;
    const parts = `({ eye: ${box(`document.querySelector(${JSON.stringify(EYE)})`)},
      ring: ${box(`document.querySelector('.ck-spot__clip:not([hidden]) .ck-spot__ring')`)},
      stage: ${box(`document.querySelector('${SHOWN} .ak-stage')`)}, dock: ${box(`document.querySelector('${SHOWN} [data-tour="ask"]')`)},
      card: ${box(`document.querySelector('.ck-spot__card:not(.ck-spot__card--twin)')`)},
      answer: ${box(`[...document.querySelectorAll('${SHOWN} .ck-answer')].at(-1)`)} })`;
    await chrome.until(`${seeing} && document.querySelector(${JSON.stringify(EYE)}).getAttribute('aria-pressed') === 'false'
      && (p => p.ring.t >= p.stage.t && p.ring.b <= p.stage.b && p.ring.b <= p.dock.t)(${parts})`);
    const read = await chrome.evaluate(parts);
    assert.ok(read.ring.l <= read.eye.l && read.ring.b >= read.eye.b, `the ring ${JSON.stringify(read.ring)} holds the eye ${JSON.stringify(read.eye)}`);
    assert.ok(read.card.b <= read.dock.t - 13, `the card ${JSON.stringify(read.card)} over the composer ${JSON.stringify(read.dock)}`);
    assert.ok(read.card.t >= read.answer.b || read.card.l >= read.answer.r,
      `the card ${JSON.stringify(read.card)} over the answer ${JSON.stringify(read.answer)}`);
    await pressOn(act('aside'));
    await chrome.until(leftOn('ask'));
  });

  test('F3: an answer with nothing hidden, and an Ask that is down, keep the walk going from the corner', async () => {
    await offered();
    await pressOn(act('lead'));
    await chrome.until(answering);
    front.answer('A quiet morning, mostly in Keynote.');
    await docked('answered');
    await pressOn(act('lead'));
    await chrome.until(resting(3, 6, true));
    await key('Escape');
    front.reset();
    front.refuse('down');
    await offered();
    await pressOn(act('lead'));
    await docked('failed');
    await snap('first-failed', `document.querySelector('.ck-spot--docked[data-still]')`);
    await pressOn(act('lead'));
    await chrome.until(resting(3, 6, true));
    await key('Escape');
  });

  test('F4: their own words are sent instead; an empty field holds Send; the composer’s own send goes on too', async () => {
    await offered();
    await edit('');
    await chrome.until(`document.querySelector(${JSON.stringify(act('lead'))}).disabled`);
    await edit('Who did I talk to today?');
    await chrome.until(`!document.querySelector(${JSON.stringify(act('lead'))}).disabled`);
    await pressOn(act('lead'));
    await chrome.until(`location.hash.includes('tour=2')`);
    assert.deepEqual(front.questions.map(each => each.question), ['Who did I talk to today?']);
    await key('Escape');
    front.reset();
    await offered();
    await pressOn('#main > .main__section:not([hidden]) [data-tour="ask"] .ck-composer__send');
    await chrome.until(`location.hash.includes('tour=2')`);
    assert.deepEqual(front.questions.map(each => each.question), [QUESTION]);
    await key('Escape');
  });

  test('F5: no AI connected: Chat says what it does, its sign-in line lit with the field, the field left alone, and the walk has no answer step', async () => {
    front.signedIn(false);
    await load('#view=ask&tour=1', { ...MAC, ask_login: undefined });
    await chrome.until(`${chatting(5)} && document.querySelector(${JSON.stringify(FIELD)}).disabled`);
    await holds('ask', 1, 5, { ai: false });
    assert.equal(await field(), '');
    await pressOn(act('lead'));
    await chrome.until(resting(2, 5, true));
    assert.ok((await chrome.evaluate('location.hash')).startsWith('#view=connectors'));
    await key('Escape');
  });

  test('F6: an Ask that has not read yet gets its card at the bound, and offers once the read lands', async () => {
    front.holdReads(true);
    await load('#view=ask&tour=1', MAC);
    await chrome.until(resting(1, 6, true));
    front.holdReads(false);
    await chrome.until(offering(6));
    await key('Escape');
    await chrome.until(leftOn('ask'));
    assert.equal(await field(), '');
  });

  test('F7: Enter in the composer sends it; the walk goes to the answer, and back on step 1 it stays the AI walk with Next', async () => {
    await offered();
    await chrome.evaluate(`document.querySelector(${JSON.stringify(FIELD)}).focus()`);
    await key('Enter');
    await chrome.until(`location.hash.includes('tour=2') && location.hash.includes(${JSON.stringify(CHAT)})`);
    assert.deepEqual(front.questions.map(each => each.question), [QUESTION]);
    await chrome.until(answering);
    front.answer('A quiet morning, mostly in Keynote.');
    await docked('answered');
    await chrome.evaluate(`document.querySelector(${JSON.stringify(act('lead'))}).focus()`);
    await key('ArrowLeft');
    await chrome.until(`${resting(1, 6, true)}
      && document.querySelector('.ck-spot__title')?.textContent === ${JSON.stringify(WORDS.ask.title)}`);
    assert.equal(await field(), '', 'the sent question is not offered again');
    assert.equal(await chrome.evaluate(`document.querySelector(${JSON.stringify(act('lead'))}).textContent.trim()`), 'Next');
    await pressOn(act('lead'));
    await chrome.until(`location.hash.includes('tour=2')`);
    assert.equal(front.questions.length, 1, 'Next on step 1 sends nothing again');
    await key('Escape');
  });
});

