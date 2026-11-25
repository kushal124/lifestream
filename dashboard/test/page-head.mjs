import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { openChrome } from '../tools/chrome.mjs';

const OUT = fileURLToPath(new URL('../.build/e2e/page-head/', import.meta.url));
const PANE = 1600;
const seen = {};
let dir;
let viewer;
let chrome;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-page-head-'));
  viewer = await createViewer({ key: null });
  await new Promise(done => viewer.listen(0, '127.0.0.1', done));
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin: `http://127.0.0.1:${viewer.address().port}` });
  await mkdir(OUT, { recursive: true });
  await chrome.size(PANE, 900, 1);
  await chrome.load('kit-gallery.html#group=__none__', '');
  await chrome.until("document.querySelector('#main')?.dataset.galleryReady === '1'");
  await chrome.evaluate(`(async () => {
    const chat = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/ask.css' });
    await new Promise((done, fail) => { chat.onload = done; chat.onerror = fail; document.head.append(chat); });
    window.kit = await import('/ui/kit/index.js');
    window.days = await import('/ui/days/head.js');
    window.kit.installPageHeads(document);
  })()`);
});

after(async () => {
  await writeFile(join(OUT, 'page-head.json'), JSON.stringify({ seen, thrown: chrome?.thrown }, null, 2));
  await chrome?.close();
  viewer?.closeAllConnections();
  await new Promise(done => viewer ? viewer.close(done) : done());
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** @param {string} page */
const put = page => chrome.evaluate(`(() => {
  document.body.innerHTML = '<main class="main">' + ${JSON.stringify(page)} + '</main>';
  const main = document.querySelector('.main');
  Object.assign(main.style, { position: 'fixed', inset: '0' });
  main.style.setProperty('--stage-width', '760px');
  main.style.setProperty('--stage', 'var(--raised)');
  for (const line of document.querySelectorAll('[data-line]')) Object.assign(line.style, { height: '40px', margin: '0' });
})()`);

const lines = count => Array.from({ length: count }, (_, at) => `<p data-line>Line ${at + 1}</p>`).join('');

const head = () => chrome.evaluate(`(() => {
  const bar = document.querySelector('.ck-page__bar');
  return { scrolled: document.querySelector('.ck-page').classList.contains('is-scrolled'),
    line: getComputedStyle(bar).boxShadow, name: getComputedStyle(bar.querySelector('.ck-page__name') ?? bar).opacity };
})()`);

test('the kit marks the head while the page scrolls, through a redraw of the head and a shrink back to the top', async () => {
  await put('<div class="ck-page"><header class="ck-page__bar"></header><div class="ck-under">'
    + `<div class="ck-page__scroll"><div class="ck-page__body ck-page__body--one"><div class="ck-page__main">${lines(60)}</div></div></div></div></div>`);
  await chrome.evaluate(`document.querySelector('.ck-page__bar').innerHTML = kit.pageHead({ back: { label: 'People' }, name: 'Person A' })`);
  const top = await head();
  assert.deepEqual({ scrolled: top.scrolled, line: top.line, name: top.name }, { scrolled: false, line: 'none', name: '0' });

  await chrome.evaluate(`document.querySelector('.ck-page__scroll').scrollTop = 200`);
  await chrome.until(`document.querySelector('.ck-page').classList.contains('is-scrolled')`, 'scrolled');
  const down = await head();
  assert.match(down.line, /inset/u);
  await chrome.until(`getComputedStyle(document.querySelector('.ck-page__name')).opacity === '1'`, 'the name shown');

  await chrome.evaluate(`document.querySelector('.ck-page__bar').innerHTML = kit.pageHead({ back: { label: 'People' }, name: 'Person B' })`);
  assert.equal((await head()).scrolled, true);
  await chrome.evaluate(`(() => {
    const fresh = document.createElement('header');
    fresh.className = 'ck-page__bar';
    fresh.innerHTML = kit.pageHead({ title: 'People' });
    document.querySelector('.ck-page__bar').replaceWith(fresh);
  })()`);
  const redrawn = await head();
  assert.equal(redrawn.scrolled, true);
  assert.match(redrawn.line, /inset/u);
  await chrome.shoot(join(OUT, 'scrolled.png'));

  await chrome.evaluate(`document.querySelector('.ck-page__main').innerHTML = '<p>Line 1</p>'`);
  await chrome.until(`!document.querySelector('.ck-page').classList.contains('is-scrolled')`, 'back at the top');
  assert.equal((await head()).line, 'none');
  seen.scrolled = { top, down, redrawn };
});

test("Chat's stage is the page's scroll: a conversation restored where it was scrolled draws the line", async () => {
  await put('<div class="ck-page ak"><header class="ck-page__bar ak-bar"></header><div class="ak-under"><div class="ak-main">'
    + '<div class="ak-stage ck-page__scroll ak-stage--thread"></div></div></div></div>');
  await chrome.evaluate(`(() => {
    document.querySelector('.ak-bar').innerHTML = kit.pageHead({ lead: '<h1 class="ak-bar__title">A conversation</h1>' });
    const stage = document.querySelector('.ak-stage');
    stage.innerHTML = ${JSON.stringify(lines(60))};
    for (const line of stage.children) Object.assign(line.style, { height: '40px', margin: '0' });
    stage.scrollTop = 600;
  })()`);
  await chrome.until(`document.querySelector('.ak').classList.contains('is-scrolled')`, 'the conversation restored');
  assert.match((await head()).line, /inset/u);
});

test('on a wide pane the controls end at the pane\'s inset and the title on the frame\'s edge', async () => {
  await put('<div class="ck-page"><header class="ck-page__bar"></header><div class="ck-under"><div class="ck-page__scroll">'
    + `<div class="ck-page__body ck-page__body--one"><div class="ck-page__main">${lines(4)}</div></div></div></div></div>`);
  await chrome.evaluate(`document.querySelector('.ck-page__bar').innerHTML = kit.pageHead({ title: 'Search', tools: [
    kit.button('Filter', { variant: 'secondary' }), kit.searchField({ placeholder: 'Search' })] })`);
  const edges = await chrome.evaluate(`(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    return { title: Math.round(box('.ck-page__title').left), main: Math.round(box('.ck-page__main').left),
      tools: Math.round(${PANE} - box('.ck-page__tools').right), search: Math.round(${PANE} - box('.ck-page__tools > :last-child').right) };
  })()`);
  seen.wide = edges;
  assert.deepEqual(edges, { title: 120, main: 120, tools: 24, search: 24 });
});

test("a stage stands under the head: the head and its hairline span the pane over Days' map", async () => {
  await put('<div class="ck-page dy"><header class="ck-page__bar dy-bar"></header><div class="ck-under">'
    + `<div class="ck-page__scroll dy-scroll"><div class="dy-body"><div class="dy-main"><div class="dy-day">${lines(60)}</div></div></div></div></div>`
    + '<aside class="dy-side ck-page__stage"><div>The map</div></aside></div>');
  await chrome.evaluate(`document.querySelector('.dy-bar').innerHTML = days.dayBar({ day: '2026-10-21', today: '2026-10-23',
    previous: '2026-10-20', next: '2026-10-22', picking: false })`);
  await chrome.evaluate(`document.querySelector('.dy-scroll').scrollTop = 200`);
  await chrome.until(`document.querySelector('.dy').classList.contains('is-scrolled')`, 'the day scrolled');
  const boxes = await chrome.evaluate(`(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const bar = box('.dy-bar'), stage = box('.dy-side');
    return { bar: [Math.round(bar.left), Math.round(bar.right)], line: getComputedStyle(document.querySelector('.dy-bar')).boxShadow,
      stage: { top: Math.round(stage.top - bar.bottom), right: Math.round(stage.right), width: Math.round(stage.width) },
      title: Math.round(box('.dy-lead').left - box('.dy-main').left), tools: Math.round(${PANE} - box('.dy-bar .ck-page__tools').right) };
  })()`);
  seen.stage = boxes;
  await chrome.shoot(join(OUT, 'stage.png'));
  assert.deepEqual(boxes.bar, [0, PANE], 'the head spans the pane, over the stage');
  assert.match(boxes.line, /inset/u);
  assert.deepEqual(boxes.stage, { top: 0, right: PANE, width: 760 }, 'the stage starts under the head, on the pane\'s right edge');
  assert.equal(boxes.title, 0, 'the title on the list\'s edge');
  assert.equal(boxes.tools, 24, 'the controls at the pane\'s inset');
});

test('a secondary button keeps its outline under the pointer, its hover fill under it', async () => {
  await put('<div><button type="button" class="ck-btn ck-btn--secondary" id="one">Edit</button></div>');
  const shadow = 'getComputedStyle(document.getElementById("one")).boxShadow';
  const rest = await chrome.evaluate(shadow);
  await chrome.hover('#one');
  await chrome.until(`document.getElementById('one').matches(':hover')`, 'the pointer over it');
  const hovered = await chrome.evaluate(shadow);
  seen.hover = { rest, hovered };
  assert.match(rest, /inset/u);
  assert.ok(hovered.startsWith(`${rest}, `), `the outline first, then the fill: ${hovered}`);
  assert.equal(hovered.split('inset').length - 1, 2);
  await chrome.hover('');
});

test('a list row marks its phrase wherever it stands in its meta or its value', async () => {
  await put('<div class="ck-lrows"></div>');
  const rows = await chrome.evaluate(`(() => {
    document.querySelector('.ck-lrows').innerHTML = [
      kit.listRow({ title: 'Northside', meta: '2 places · Here now', here: 'Here now', attrs: { id: 'city' } }),
      kit.listRow({ title: 'River Flat', meta: 'Here now · 2h 30m today', here: 'Here now', attrs: { id: 'place' } }),
      kit.listRow({ title: 'Lantern Park', short: true, value: 'Here now', here: 'Here now', attrs: { id: 'once' } }),
      kit.listRow({ title: 'Harbour', meta: '3 places · Yesterday', attrs: { id: 'away' } }),
    ].join('');
    const read = id => { const row = document.getElementById(id);
      return { marked: [...row.querySelectorAll('.ck-lrow__here')].map(each => each.textContent),
        words: (row.querySelector('.ck-lrow__meta') ?? row.querySelector('.ck-lrow__end')).textContent }; };
    return { city: read('city'), place: read('place'), once: read('once'), away: read('away') };
  })()`);
  seen.rows = rows;
  assert.deepEqual(rows, {
    city: { marked: ['Here now'], words: '2 places · Here now' },
    place: { marked: ['Here now'], words: 'Here now · 2h 30m today' },
    once: { marked: ['Here now'], words: 'Here now' },
    away: { marked: [], words: '3 places · Yesterday' },
  });
});
