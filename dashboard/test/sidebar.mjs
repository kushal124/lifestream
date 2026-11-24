// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { accountMarkup, finishMarkup, searchRow, sectionRows } from '../public/ui/sections.js';
import { ACCOUNTS, finishItems } from '../public/ui/finish.js';

/** @typedef {import('../public/lib/host.js').HostState} HostState */

const YOU = { id: 'person-sam', name: 'Sam de Rivera', photo: '' };
const PROFILE = { value: 'profile', words: 'Profile', key: '', note: '' };
/** @type {HostState} */
const MAC = { ...HOST_STATE, update: null };
/** @type {HostState} */
const WAITING = { ...HOST_STATE, update: { id: 'update:ready', line: 'Lifestream 2026.10.28 is ready', detail: null,
  acts: [{ id: 'do', label: 'Restart to Update', tone: 'caution' }], home: false } };

/** @param {string} markup */
const itemsOf = markup => [...markup.matchAll(/<div[^>]*role="menuitem"[^>]*data-value="([^"]*)"[^>]*>(.*?)<\/div>/gu)]
  .map(([, value, inner]) => ({ value, words: /ck-flist__label">([^<]*)/u.exec(inner)?.[1] ?? '',
    key: /ck-flist__tag[^"]*">([^<]*)/u.exec(inner)?.[1] ?? '', note: /ck-flist__note[^"]*">([^<]*)/u.exec(inner)?.[1] ?? '' }));

test('S1: the person’s row holds Profile while the home knows them, Settings, the Mac’s key with a host, and the update only with a host and one waiting', () => {
  const browser = accountMarkup(YOU, null);
  assert.deepEqual(itemsOf(browser), [PROFILE, { value: 'settings', words: 'Settings', key: '', note: '' }]);
  assert.match(browser, /class="ck-account__name ck-navrow__words">Sam de Rivera</u);
  assert.match(browser, /<button type="button" class="ck-fmenu__btn ck-navrow ck-account__btn"/u);
  assert.match(browser, /class="ck-mono ck-mono--xs"/u);
  assert.doesNotMatch(browser, /ck-account__dot|ck-flist__rule/u);
  assert.match(browser, /aria-label="Sam de Rivera: Settings"/u);
  const mac = accountMarkup(YOU, MAC);
  assert.deepEqual(itemsOf(mac), [PROFILE, { value: 'settings', words: 'Settings', key: '⌘,', note: '' }]);
  assert.match(mac, /<kbd class="ck-flist__tag ck-flist__key mac-body">⌘,<\/kbd>/u);
  assert.doesNotMatch(mac, /ck-account__dot/u);
  const waiting = accountMarkup(YOU, WAITING);
  assert.deepEqual(itemsOf(waiting), [PROFILE, { value: 'settings', words: 'Settings', key: '⌘,', note: '' },
    { value: 'do', words: 'Restart to Update', key: '', note: 'Lifestream 2026.10.28 is ready' }]);
  assert.match(waiting, /class="ck-account__dot"/u);
  assert.match(waiting, /title="Lifestream 2026\.10\.28 is ready"/u);
  assert.match(waiting, /<hr class="ck-flist__rule">/u);
  assert.deepEqual(itemsOf(accountMarkup(YOU, { ...WAITING, update: { ...WAITING.update, acts: [] } }))
    .map(item => item.value), ['profile', 'settings']);
  const nobody = accountMarkup(null, null);
  assert.match(nobody, /class="ck-account__name ck-navrow__words">You</u);
  assert.match(nobody, /ck-mono--unnamed/u);
  assert.deepEqual(itemsOf(nobody).map(item => item.value), ['settings']);
});

test('S2: Search is a row of the sections’ shape, ⌘K at its end, lit only while Search is open, the walk’s hook', () => {
  const shut = searchRow(false);
  assert.match(shut, /^<a class="sidebar__item ck-navrow" id="sidebar-search" href="#view=search"/u);
  assert.match(shut, /<span class="sidebar__words ck-navrow__words">Search<\/span><kbd class="sidebar__key">⌘K<\/kbd><\/a>$/u);
  assert.match(shut, /aria-keyshortcuts="Meta\+K"/u);
  assert.doesNotMatch(shut, /is-on|aria-current|<input/u);
  const open = searchRow(true);
  assert.match(open, /class="sidebar__item ck-navrow is-on"/u);
  assert.match(open, /aria-current="page"/u);
});

test('S3: the open section lit by its fill alone, its icon the outline; Connectors and Agents say their counts', () => {
  /**
   * @param {string} markup
   * @param {string} view
   */
  const iconOf = (markup, view) => new RegExp(`href="#view=${view}"[^>]*>(<svg.*?</svg>)`, 'u').exec(markup)?.[1];
  const onDays = sectionRows('days', {});
  assert.match(onDays, /<a class="sidebar__item ck-navrow is-on" href="#view=days" aria-current="page">/u);
  assert.equal(iconOf(onDays, 'days'), iconOf(sectionRows('ask', {}), 'days'), 'the open row’s icon not the outline');
  assert.doesNotMatch(onDays, /sidebar__count|sidebar__lantern|ck-signal/u);
  const two = sectionRows('days', { connectors: 2 });
  assert.match(two, /<span class="sidebar__words ck-navrow__words">Connectors<\/span><span class="sidebar__count ck-count ck-count--need" title="2 things need you"><span aria-hidden="true">2<\/span>/u);
  assert.match(two, /<span class="sr-only">2 things need you<\/span>/u);
  assert.match(sectionRows('days', { connectors: 1 }), /title="1 thing needs you"/u);
  assert.equal((two.match(/sidebar__count/gu) ?? []).length, 1, 'a count on another row');
  const asks = sectionRows('days', { agents: 2 });
  assert.match(asks, /href="#view=agents"[^>]*>.*?<span class="sidebar__words ck-navrow__words">Agents<\/span><span class="sidebar__count ck-count ck-count--need"/u);
  assert.equal((asks.match(/sidebar__count/gu) ?? []).length, 1, 'the agents row alone counts its asks');
});

test('S9: Finish setting up counts what is done, hides on its ×, says where it went, and comes back from the account menu', () => {
  const items = [
    { id: 'ask', title: 'Ask your first question', done: true, href: '#view=ask', flow: '' },
    { id: 'iphone', title: 'Connect your iPhone', done: false, href: '', flow: 'phone' },
    { id: 'agent', title: 'Connect an agent', done: false, href: '#view=agents', flow: '' },
  ];
  const shown = { hidden: false, gone: false, flying: false };
  const card = finishMarkup(items, shown);
  assert.match(card, />1 of 3 done</u, 'never the tour card\'s bare "1 of 6"');
  assert.match(card, /data-finish-hide/u);
  assert.match(card, /data-finish-flow="phone"/u);
  assert.match(card, /href="#view=agents"/u);
  assert.match(card, /is-done.*Ask your first question/u);
  assert.match(card, /aria-label="Finish setting up, 2 left"/u, 'the collapsed sidebar’s ring says how many are left');
  assert.match(finishMarkup(items, { ...shown, flying: true }), /class="ck-finish is-flying"/u);
  assert.equal(finishMarkup(items, { ...shown, hidden: true }), '');
  assert.match(finishMarkup(items, { ...shown, hidden: true, gone: true }), /Hidden\. It’s in your account menu\. <button[^>]*data-finish-undo/u);
  assert.equal(finishMarkup(items.map(item => ({ ...item, done: true })), shown), '', 'gone by itself once all are done');
  assert.deepEqual(itemsOf(accountMarkup(YOU, MAC, null, true)).map(item => item.value), ['profile', 'finish', 'settings']);
  assert.deepEqual(itemsOf(accountMarkup(YOU, MAC)).map(item => item.value), ['profile', 'settings']);
});

test('S10: Finish setting up’s list is the first question, the iPhone, Chrome, the accounts, an agent and a model, each done as the home and the Mac say', () => {
  const asked = finishItems({ state: HOST_STATE, report: REPORT, models: null }, true);
  const ids = asked.map(item => item.id);
  assert.deepEqual(ids.filter(id => id !== 'accounts'), ['ask', 'iphone', 'browser', 'agent', 'model']);
  assert.equal(asked[0].done, true);
  assert.equal(finishItems({ state: HOST_STATE, report: REPORT, models: null }, false)[0].done, false);
  assert.equal(asked.find(item => item.id === 'browser')?.done, true, 'the extension is present');
  assert.deepEqual(asked.filter(item => item.flow).map(item => item.flow), ['phone', 'browser']);
  assert.ok(asked.filter(item => item.id === 'accounts').every(item => item.title === ACCOUNTS), 'the accounts item’s label never names one');
});
