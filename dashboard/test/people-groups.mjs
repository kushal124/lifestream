import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSON_ANSWER, peoplePage } from './stand-ins/people-page.mjs';

const page = peoplePage({ file: 'people-groups', faces: false });
const { shot, click, text, go, stub, load, seen } = page;
/** @type {Awaited<ReturnType<typeof page.open>>['chrome']} */
let chrome;

const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;
const DAY = '2026-10-20';
const START = Date.parse(`${DAY}T04:00:00Z`);
const NOON = Date.parse(`${DAY}T12:00:00Z`);
const NIGHT = Date.parse('2026-10-21T02:30:00Z');
const NOW = Date.now();

const DIRECT = 'whatsapp:15550000001@s.whatsapp.net';
const YOURS = Array.from({ length: 6 }, (_, at) => `whatsapp:12036300000000010${at}@g.us`);
const ARCHIVED = 'whatsapp:120363000000000201@g.us';
const SILENT = 'imessage:+15550000005,+15550000006';
const NEVER = 'whatsapp:120363000000000202@g.us';

/**
 * @param {string} key
 * @param {string} label
 * @param {Record<string, unknown>} [more]
 */
const chat = (key, label, more = {}) => ({ key, network: key.split(':')[0], chat: key.slice(key.indexOf(':') + 1),
  group: true, label, total: 500, mine: 20, first_ms: NOW - 400 * DAY_MS, last_ms: NOW - DAY_MS, quiet: null,
  word: null, ...more });

const CHATS = [
  chat(DIRECT, '', { group: false, total: 80, mine: 30 }),
  ...YOURS.map((key, at) => chat(key, `Group ${at + 1}`, { last_ms: NOW - (at + 1) * HOUR })),
  chat(ARCHIVED, 'Group Archived', { quiet: { why: 'archived', last_day: '2026-09-01' }, last_ms: NIGHT }),
  chat(SILENT, 'Group Silent', { quiet: { why: 'silent', last_day: '2026-06-12' }, last_ms: NOON }),
  chat(NEVER, 'Group Never', { quiet: { why: 'silent', last_day: null }, mine: 0, last_ms: NOW - 40 * DAY_MS }),
];

/**
 * @param {string} id
 * @param {string} name
 * @param {Record<string, unknown>} more
 */
const person = (id, name, more) => ({ id, name, by: 'contact', person: null, handles: [], networks: ['whatsapp'],
  chats: [], received: 10, sent: 10, first_ms: NOW - 300 * DAY_MS, last_ms: NOW - DAY_MS, last_30: 1, days_count: 4,
  score: 1, ...more });

const A = person('person:person-a', 'Person A', { last_ms: NOW - 2 * DAY_MS, last_30: 40,
  chats: [DIRECT, ...YOURS, ARCHIVED, SILENT].map((key, at) => ({ key, count: key === YOURS[5] ? 95 : 90 - at })) });
const B = person('person:person-b', 'Person B', { last_ms: NOW - HOUR, last_30: 20, chats: [{ key: SILENT, count: 2 }] });
const C = person('person:person-c', 'Person C', { last_ms: NOW - 10 * DAY_MS, last_30: 5 });

const PEOPLE = { position: '100:0', zone: 'UTC', day_start_hour: 4, people: [C, A, B], chats: CHATS,
  organise: { queue: [], organised: 3, often: 0 }, others: 0 };

/** @param {string} name */
const fixture = name => JSON.parse(readFileSync(new URL(`../../homelink/Tests/Fixtures/pages/${name}.json`, import.meta.url), 'utf8'));
const LIST = fixture('people.full');
const PERSON = fixture('person.full');
const GROUP = fixture('group.full');
const DAY_PAGE = fixture('day.placeless');
const MOMENT = fixture('moment.missed');
const THREAD = fixture('thread.full');

/**
 * @param {string} key
 * @param {string} title
 * @param {string[]} said
 */
const talk = (key, title, said) => ({ ...THREAD, chat: key, day: DAY, title,
  messages: said.map((text, at) => ({ ...THREAD.messages[0], key: `${key}-${at}`, text, at_ms: START + 8 * HOUR + at * 60_000,
    ...at === said.length - 1 ? { who: 'me', name: 'the user', mine: true } : { who: 'jid:15550000002@s.whatsapp.net', name: 'Person B', mine: false } })) });

/**
 * @param {string} row
 * @param {string} key
 * @param {string} title
 * @param {string} count
 * @param {string} product
 */
const quietMoment = (row, key, title, count, product) => ({ ...MOMENT, day: DAY, moment: { ...MOMENT.moment, key: row, row,
  kind: 'conversation', icon: 'meeting', title, name: title, start_ms: null, end_ms: null, untimed: count, products: [product],
  people: [], record: null, marks: [], source: { records: [], more: 0, units: [{ family: 'messages', unit: `${DAY}:${key}` }], atoms: 1,
    start_ms: null, end_ms: null }, view: { view: 'quiet', chat: key } } });

/**
 * @param {string} chat
 * @param {string} title
 * @param {string} count
 * @param {string} row
 */
const quietGroup = (chat, title, count, row) => ({ chat, title, runs: [{ glyph: 'message', value: count, quiet: true }],
  spoken: `${title}, ${count} messages received`, quiet: true, rows: [row] });
const PAID = { ...DAY_PAGE.also.rows[0], key: 'e2', words: [{ ...DAY_PAGE.also.rows[0].words[0], text: '−12.00 USD' },
  { ...DAY_PAGE.also.rows[0].words[1], text: 'SHOP A' }] };
const QUIET_DAY = { ...DAY_PAGE, day: DAY, all_day: [], chapters: [], plans: [], end_ms: START + DAY_MS,
  also: { folded: false, names: [{ text: PAID.name, first_row: PAID.key, at_ms: null }], rows: [PAID] },
  side: { figures: [], located: false, places: [], unreturned: [],
    people: [{ ...DAY_PAGE.side.people[0], key: DIRECT, person: A.id, name: 'Person A', runs: [{ glyph: 'message', value: '1', quiet: false }],
      spoken: 'Person A, 1 message received', rows: [] }],
    groups: [quietGroup(ARCHIVED, 'Group Archived', '14', 'e3'), quietGroup(SILENT, 'Group Silent', '3', 'e4')] } };
const MOMENTS = {
  a3: quietMoment('e3', ARCHIVED, 'Group Archived', '14 messages', 'WhatsApp'),
  e3: quietMoment('e3', ARCHIVED, 'Group Archived', '14 messages', 'WhatsApp'),
  e4: quietMoment('e4', SILENT, 'Group Silent', '3 messages', 'iMessage'),
};

/** @param {string} key */
const chatOf = key => /** @type {(typeof CHATS)[number]} */ (CHATS.find(each => each.key === key));
/** @param {(typeof CHATS)[number]} each */
const chatRow = each => ({ chat: each.key, title: each.label, photo: null, when: { kind: 'at', at_ms: each.last_ms }, line: null, find: [each.label] });
/**
 * @param {string} key
 * @param {number} count
 */
const whereOf = (key, count) => {
  const each = chatOf(key);
  return { chat: key, title: each.group ? each.label : 'WhatsApp', group: each.group, network: 'WhatsApp',
    when: { kind: 'at', at_ms: each.last_ms }, count, line: `${count} messages`, quiet: Boolean(each.quiet) };
};
/**
 * @param {string} key
 * @param {string} title
 * @param {string[]} said
 */
const talkOf = (key, title, said) => ({ day: DAY, chat: key, title, group: true, network: 'WhatsApp', folded: [],
  lines: said.map((text, at) => ({ who: at === said.length - 1 ? 'person:person-me' : 'person:person-b', name: at === said.length - 1 ? 'You' : 'Person B',
    text, forwarded: false, at_ms: START + 8 * HOUR + at * 60_000, mine: at === said.length - 1, n: 3 })) });
/** @type {Record<string, { words: string, since: { kind: 'day', day: string } | null }>} */
const QUIET = {
  [ARCHIVED]: { words: 'You archived it in WhatsApp', since: null },
  [SILENT]: { words: 'You last wrote', since: { kind: 'day', day: '2026-06-12' } },
  [NEVER]: { words: 'You never wrote in it', since: null },
};
/** @param {(typeof CHATS)[number]} each */
const groupOf = each => ({ ...GROUP, position: '100:0', total: each.total, talk: null,
  head: { ...GROUP.head, title: each.label, word: 'rule', quiet: each.key in QUIET, why: QUIET[each.key] ?? null } });
const PAGES = {
  people: { ...LIST, groups: { yours: CHATS.filter(each => each.group && !each.quiet).map(chatRow),
    quiet: CHATS.filter(each => each.quiet).map(chatRow), quiet_line: '3 groups' } },
  /** @type {Record<string, unknown>} */
  persons: {
    [A.id]: { ...PERSON, position: '100:0', head: { ...PERSON.head, name: A.name }, talk: null, where: [whereOf(DIRECT, 90),
      whereOf(YOURS[5], 95), ...YOURS.slice(0, 5).map((key, at) => whereOf(key, 89 - at)), whereOf(ARCHIVED, 83), whereOf(SILENT, 82)] },
    [B.id]: { ...PERSON, position: '100:0', head: { ...PERSON.head, name: B.name }, where: [whereOf(SILENT, 2)],
      talk: { ...talkOf(SILENT, 'Group Silent', ['Anyone up for the hike?', 'Count me out']), network: 'iMessage' } },
  },
  /** @type {Record<string, any>} */
  groups: Object.fromEntries(CHATS.filter(each => each.group).map(each => [each.key, groupOf(each)])),
};
PAGES.groups[ARCHIVED].talk = talkOf(ARCHIVED, 'Group Archived', ['Sale today only', 'Last call for the sale', 'Thanks']);

const TALKS = {
  [`${ARCHIVED} ${DAY}`]: talk(ARCHIVED, 'Group Archived', ['Sale today only', 'Last call for the sale', 'Thanks']),
  [`${SILENT} ${DAY}`]: talk(SILENT, 'Group Silent', ['Anyone up for the hike?', 'Count me out']),
};

const STUB = `(url, init, real) => {
  const answer = ${JSON_ANSWER};
  const G = window.groups;
  const query = new URLSearchParams(url.split('?')[1] ?? '');
  if (url.split('?')[0] === 'api/page/people') return answer(G.pages.people);
  if (url.startsWith('api/page/person?')) {
    const found = G.pages.persons[query.get('id')];
    return found ? answer(found) : answer({ error: 'No one.', code: 'PERSON_UNKNOWN' }, 404);
  }
  if (url.startsWith('api/page/group?')) {
    const found = G.pages.groups[query.get('chat')];
    return found ? answer(found) : answer({ error: 'No group.', code: 'CHAT_UNKNOWN' }, 404);
  }
  if (url === 'api/life/people') return answer(G.people);
  if (url.startsWith('api/page/peopleFind?')) return new Promise(() => {});
  if (url.startsWith('api/life/people/photos?')) return answer({ position: '', photos: [], total: 0 });
  if (url.startsWith('api/page/day?') && query.get('day') === G.day.day) return answer(G.day);
  if (url.startsWith('api/page/moment?') && query.get('day') === G.day.day && G.moments[query.get('focus')]) {
    return answer(G.moments[query.get('focus')]);
  }
  if (url.startsWith('api/page/thread?')) {
    (window.conversations ??= []).push([query.get('chat'), query.get('day')]);
    const found = G.talks[query.get('chat') + ' ' + query.get('day')];
    return found ? answer(found) : answer({ error: 'No conversation.' }, 404);
  }
  if (url === 'api/owner/act') {
    (window.acts ??= []).push(JSON.parse(init.body));
    const said = () => window.groups.refuse ? answer({ error: window.groups.refuse, code: 'GROUP_REFUSED' }, 422)
      : answer({ act: 'act-' + window.acts.length, id: null, position: window.groups.next });
    if (!window.holdingActs) return said();
    return new Promise(done => {
      window.releaseActs = () => done(said());
    });
  }
  if (url.startsWith('api/page/connectors')) {
    return real(url, init).then(response => response.json()).then(report => answer({ ...report,
      connectors: report.connectors.map(each => each.id !== 'whatsapp' ? each
        : { ...each, quiet: G.quiet }) }));
  }
  return real(url, init);
}`;

/** @param {{ next?: string, refuse?: string }} [more] */
const answer = ({ next = '200:0', refuse = '' } = {}) => chrome.evaluate(`window.groups = ${JSON.stringify({
  people: PEOPLE, pages: PAGES, day: QUIET_DAY, moments: MOMENTS, talks: TALKS, quiet: 2, next, refuse })}; true`);

/**
 * @param {string} key
 * @param {Record<string, unknown>} head
 * @param {string} position
 */
const served = (key, head, position) => {
  const group = PAGES.groups[key];
  PAGES.groups[key] = { ...group, position, head: { ...group.head, ...head } };
  return answer({ next: `${Number(position.split(':')[0]) + 100}:0` });
};

/**
 * @param {string} key
 * @param {Record<string, unknown>} change
 * @param {string} position
 * @param {string} words
 */
async function answered(key, change, position, words) {
  await served(key, change, position);
  const menu = `document.querySelector('[data-people-word="${key}"]')`;
  await chrome.evaluate(`(() => {
    window.shown = [];
    const observer = new MutationObserver(() => {
      const menu = ${menu};
      if (menu) window.shown.push(menu.querySelector('.ck-fmenu__btn').getAttribute('aria-disabled') + ':'
        + menu.querySelector('.ck-menubtn__words').textContent);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    window.stopShown = () => observer.disconnect();
    window.releaseActs();
  })()`);
  await chrome.until(`${menu}.querySelector('.ck-menubtn__words').textContent === ${JSON.stringify(words)}
    && ${menu}.querySelector('.ck-fmenu__btn').getAttribute('aria-disabled') !== 'true'`);
  const shown = /** @type {string[]} */ (await chrome.evaluate('(window.stopShown(), window.shown)'));
  assert.deepEqual([...new Set(shown.filter(each => !each.startsWith('true:')).map(each => each.slice(each.indexOf(':') + 1)))], [words],
    'the menu busy from the act until the read after its answer');
}

/**
 * @param {string} key
 * @param {string} value
 */
async function pick(key, value) {
  await click(`[data-people-word="${key}"] .ck-fmenu__btn`);
  await chrome.until(`!document.querySelector('[data-people-word="${key}"] .ck-fmenu__panel').hidden`);
  await click(`[data-people-word="${key}"] .ck-fmenu__item[data-value="${value}"]`);
}

const quietRow = () => chrome.evaluate(`(() => {
  const row = document.querySelector('.pp-quiet-word .ck-srow');
  return row && [row.querySelector('.ck-srow__label').textContent,
    row.querySelector('.ck-srow__line')?.textContent ?? '', row.querySelector('.ck-menubtn__words').textContent,
    row.querySelector('.ck-fmenu__btn').getAttribute('aria-disabled') === 'true'];
})()`);

/** @param {string} selector */
const ids = selector => chrome.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
  .map(each => each.dataset.person)`);

const sideRows = () => chrome.evaluate(`[...document.querySelectorAll('.pp-side .ck-side__rows .ck-side__row')]
  .map(row => [row.querySelector('.ck-side__name').textContent, row.querySelector('.ck-side__count')?.textContent ?? '',
    Boolean(row.querySelector('.ck-tag'))])`);
/** @param {string} name */
const sideLine = name => chrome.evaluate(`[...document.querySelectorAll('.pp-side .ck-side__row')]
  .find(row => row.querySelector('.ck-side__name').textContent === ${JSON.stringify(name)})
  ?.querySelector('.ck-side__line > span')?.textContent ?? null`);

/** @param {string} words */
const labelled = words => `[...document.querySelectorAll('.ck-srow__label')]
  .some(each => each.textContent === ${JSON.stringify(words)})`;

before(async () => {
  await page.open();
  ({ chrome } = await page.journey('people-groups'));
  await load('#view=days', null);
  await answer();
  await stub(STUB);
});

after(async () => {
  seen.groupActs = await chrome?.evaluate('window.acts ?? []').catch(() => []) ?? [];
  seen.conversations = await chrome?.evaluate('window.conversations ?? []').catch(() => []) ?? [];
  await page.close();
});

test('G1: the list draws the home\'s answer in its order: Most, each section, AI apart; a word typed filters it in that order', async () => {
  await go('#view=people');
  const rows = LIST.sections.flatMap((/** @type {any} */ section) => section.rows);
  const listed = '.pp-main .pp-group:not(.pp-group--most) [data-person]';
  await chrome.until(`document.querySelectorAll('${listed}').length === ${rows.length}`);
  assert.deepEqual(await ids('.pp-main .pp-group--most [data-person]'), LIST.most.map((/** @type {any} */ each) => each.id));
  assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.pp-main .pp-group--most .pp-tile__line')].map(each => each.textContent)`),
    LIST.most.map((/** @type {any} */ each) => each.line));
  assert.deepEqual(await ids(listed), rows.map((/** @type {any} */ row) => row.id));
  assert.equal((await text('.pp-main .pp-group:not(.pp-group--most) .ck-section__label')).at(-1), 'No messages yet');
  const ai = LIST.ai.map((/** @type {any} */ row) => row.id);
  assert.ok(ai.length > 0 && ai.every((/** @type {string} */ id) => !rows.some((/** @type {any} */ row) => row.id === id)), 'an AI among the people');
  await click('[data-people-seg="ai"]');
  await chrome.until(`[...document.querySelectorAll('.pp-main [data-person]')].map(each => each.dataset.person).join(' ') === ${JSON.stringify(ai.join(' '))}`);
  await click('[data-people-seg=""]');
  await chrome.until(`document.querySelectorAll('${listed}').length === ${rows.length}`);
  const found = [LIST.you, ...rows, ...LIST.ai].filter(row => row.find.some((/** @type {string} */ each) => each.toLowerCase().includes('person')));
  await chrome.type('[data-people-find]', 'Person');
  await chrome.until(`document.querySelector('.pp-main .pp-group .ck-section')?.textContent === '${found.length} found'`);
  assert.deepEqual(await ids('.pp-main .ck-cgrid [data-person]'), found.map(row => row.id));
  await chrome.evaluate(`(() => { const field = document.querySelector('[data-people-find]'); field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await chrome.until(`document.querySelectorAll('${listed}').length === ${rows.length}
    && document.querySelector('.pp-main .pp-group .ck-section')?.textContent !== '${found.length} found'`);
});

test('G2: a person\'s groups, five of yours, then the rest behind N more groups', async () => {
  await go(`#view=people&focus=${encodeURIComponent(A.id)}`);
  await chrome.until(`document.querySelector('[data-people-groups="all"]')`);
  const yours = [['WhatsApp', '90', false], ['Group 6', '95', false], ['Group 1', '89', false],
    ['Group 2', '88', false], ['Group 3', '87', false], ['Group 4', '86', false]];
  assert.deepEqual(await sideRows(), [...yours, ['3 more groups', '', false]]);
  assert.equal(await sideLine('WhatsApp'), 'Yesterday', 'the line says when the chat last spoke');
  assert.equal(await sideLine('3 more groups'), null, 'the more row says how many alone');
  await shot('person-groups', `document.querySelector('[data-people-groups="all"]')`);
  await click('[data-people-groups="all"]');
  await chrome.until(`!document.querySelector('[data-people-groups]')`);
  assert.deepEqual(await sideRows(), [...yours, ['Group 5', '85', false], ['Group Archived', '83', true],
    ['Group Silent', '82', true]]);
  assert.equal(await sideLine('Group Archived'), '20 Oct');
  assert.equal(await chrome.evaluate(`document.querySelectorAll('.pp-side .ck-side__row.is-quiet').length`), 2);
  await shot('person-groups-all', `document.querySelectorAll('.pp-side .ck-side__row.is-quiet').length === 2`);
  await click('[data-people-edit="open"]');
  await chrome.until(`document.querySelector('.pp-window [data-o-do="groups"]')`);
  const windowRows = () => chrome.evaluate(`[...document.querySelectorAll('.pp-window .ck-side__row')].map(row => [
    row.querySelector('.ck-side__name').textContent, row.querySelector('.ck-side__count')?.textContent ?? '',
    row.classList.contains('is-quiet')])`);
  assert.deepEqual(await windowRows(), [...yours, ['3 more groups', '', false]]);
  await shot('edit-groups', `document.querySelector('.pp-window [data-o-do="groups"]')`);
  await click('.pp-window [data-o-do="groups"]');
  await chrome.until(`!document.querySelector('.pp-window [data-o-do="groups"]') && document.querySelectorAll('.pp-window .ck-side__row').length === 9`);
  assert.deepEqual((await windowRows()).slice(6), [['Group 5', '85', false], ['Group Archived', '83', true],
    ['Group Silent', '82', true]]);
  await shot('edit-groups-all', `document.querySelectorAll('.pp-window .ck-side__row').length === 9`);
  await chrome.press('Escape');
  await chrome.until(`!document.querySelector('.pp-panel')`);
});

test('G3: the Groups view, yours then one closed row of the quiet ones', async () => {
  await go('#view=people&seg=groups');
  await chrome.until(`document.querySelector('[data-people-quiet]')`);
  assert.deepEqual(await text('[data-people-seg="groups"] .ck-views__n'), ['6']);
  const names = () => text('.pp-main .ck-crow__name');
  const yours = ['Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5', 'Group 6'];
  assert.deepEqual(await names(), [...yours, 'Quiet']);
  assert.deepEqual(await text('[data-people-quiet] .ck-crow__words'), ['3 groups']);
  assert.deepEqual(await text('.pp-main .pp-group > .ck-section'), ['Your groups']);
  await shot('groups-quiet-closed', `document.querySelector('[data-people-quiet]')`);
  await click('[data-people-quiet]');
  await chrome.until(`!document.querySelector('[data-people-quiet]')`);
  assert.deepEqual(await names(), [...yours, 'Group Archived', 'Group Silent', 'Group Never']);
  assert.deepEqual(await text('.pp-main .pp-group > .ck-section'), ['Your groups', 'Quiet']);
  await shot('groups-quiet-open', `document.querySelectorAll('.pp-main .ck-crow__name').length === 9`);
});

test('G4: a group\'s page, why you are quiet and your word on it', async () => {
  for (const [key, why] of [[ARCHIVED, 'You archived it in WhatsApp'], [SILENT, 'You last wrote 12 Jun'],
    [NEVER, 'You never wrote in it']]) {
    await go(`#view=people&focus=${encodeURIComponent(`chat:${key}`)}`);
    await chrome.until(`document.querySelector('[data-people-word="${key}"]')`);
    assert.deepEqual(await quietRow(), ['Quiet', `Quiet now · ${why}`, 'Follow the rule', false]);
  }
  const mine = `[data-people-word="${YOURS[0]}"]`;
  await go(`#view=people&focus=${encodeURIComponent(`chat:${YOURS[0]}`)}`);
  await chrome.until(`document.querySelector('${mine}')`);
  assert.deepEqual(await quietRow(), ['Quiet', 'Not quiet', 'Follow the rule', false]);
  assert.deepEqual(await text(`${mine} .ck-fmenu__item .ck-flist__label`),
    ['Follow the rule', 'Always quiet', 'Never quiet']);
  await shot('group-yours', `document.querySelector('${mine}')`);
  await chrome.evaluate('window.holdingActs = true');
  await pick(YOURS[0], 'rule');
  await pick(YOURS[0], 'never');
  await chrome.until(`(window.acts ?? []).length === 1 && document.querySelector('${mine} .ck-fmenu__btn').getAttribute('aria-disabled') === 'true'`);
  const [first] = await chrome.evaluate('window.acts');
  assert.deepEqual({ ...first, request: typeof first.request },
    { of: 'people', kind: 'group', chat: YOURS[0], quiet: false, request: 'string' });
  assert.deepEqual(await quietRow(), ['Quiet', 'Not quiet', 'Follow the rule', true]);
  await answered(YOURS[0], { word: 'never', why: { words: 'You set it', since: null } }, '200:0', 'Never quiet');
  assert.deepEqual(await quietRow(), ['Quiet', 'Not quiet · You set it', 'Never quiet', false]);
  await pick(YOURS[0], 'rule');
  await chrome.until(`(window.acts ?? []).length === 2`);
  assert.equal((await chrome.evaluate('window.acts[1]')).quiet, null);
  await answered(YOURS[0], { word: 'rule', why: null }, '300:0', 'Follow the rule');
  const never = `[data-people-word="${NEVER}"]`;
  await go(`#view=people&focus=${encodeURIComponent(`chat:${NEVER}`)}`);
  await chrome.until(`document.querySelector('${never}')`);
  await pick(NEVER, 'always');
  await chrome.until(`(window.acts ?? []).length === 3`);
  const third = await chrome.evaluate('window.acts[2]');
  assert.deepEqual([third.kind, third.chat, third.quiet], ['group', NEVER, true]);
  await answered(NEVER, { word: 'always', quiet: true, why: { words: 'You set it', since: null } }, '400:0', 'Always quiet');
  assert.deepEqual(await quietRow(), ['Quiet', 'Quiet now · You set it', 'Always quiet', false]);
  await chrome.evaluate('window.holdingActs = false');
  await answer({ refuse: 'This chat is not a group.' });
  await pick(NEVER, 'never');
  await chrome.until(`document.querySelector('.pp-quiet-word .ck-in-place')?.textContent
    .includes('This chat is not a group.')`);
  assert.deepEqual(await quietRow(), ['Quiet', 'Quiet now · You set it', 'Always quiet', false]);
  await shot('group-refused', `document.querySelector('.pp-quiet-word .ck-in-place')`);
  await answer();
});

test('G5: a group\'s last conversation on a day you were quiet in it, as the home answers it, opening that day', async () => {
  await go(`#view=people&focus=${encodeURIComponent(`chat:${ARCHIVED}`)}`);
  await chrome.until(`document.querySelectorAll('.pp-talk .ck-bubble').length === 3`);
  assert.deepEqual(await chrome.evaluate(`document.querySelector('[data-people-open]').dataset.peopleOpen`), DAY);
  assert.deepEqual(await text('.pp-talk .ck-bubble'), ['Sale today only', 'Last call for the sale', 'Thanks']);
  assert.doesNotMatch((await text('.pp-talk__when'))[0], /Group/u);
  await shot('group-quiet', `document.querySelectorAll('.pp-talk .ck-bubble').length === 3`);
  await click('[data-people-open]');
  await chrome.until(`['Sale today only', 'Last call for the sale', 'Thanks']
    .every(words => document.querySelector('.pp .ck-panel')?.textContent.includes(words))`);
  await shot('group-quiet-open', `document.querySelector('.pp .ck-panel')?.textContent.includes('Thanks')`);
  await click('.pp .ck-panel [data-d-close]');
});

test('G5: a person\'s last conversation in a group folded that day, as the home answers it, the group its place', async () => {
  const asked = (await chrome.evaluate('window.conversations ?? []')).length;
  await go(`#view=people&focus=${encodeURIComponent(B.id)}`);
  await chrome.until(`document.querySelectorAll('.pp-talk .ck-bubble').length === 2`);
  assert.equal((await chrome.evaluate('window.conversations ?? []')).length, asked, 'People read a conversation of its own');
  assert.deepEqual(await text('.pp-talk .ck-bubble'), ['Anyone up for the hike?', 'Count me out']);
  assert.match((await text('.pp-talk__when'))[0], / · Group Silent$/u);
  await shot('person-quiet', `document.querySelectorAll('.pp-talk .ck-bubble').length === 2`);
});

test('G6: Days draws the groups you were quiet in as the side\'s Groups, never the day\'s list, quieter, each opening its conversation that day', async () => {
  await go(`#view=days&on=${DAY}`);
  const untimed = '.dy-block[data-d-block="untimed"]', groups = '.dy-side [data-side-part="groups"]';
  await chrome.until(`document.querySelector('${untimed} [data-d-stay]') && document.querySelectorAll('${groups} [data-d-group]').length === 2`);
  assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.dy-block')].map(block => block.dataset.dBlock)`), ['untimed']);
  assert.deepEqual(await text(`${untimed} [data-d-stay] .dy-head__name`), ['Also that day']);
  assert.match((await text(`${untimed} .dy-row`))[0], /12\.00 USD/u);
  assert.equal(await chrome.evaluate(`document.querySelectorAll('${untimed} .dy-row').length`), 1);
  assert.equal(await chrome.evaluate(`document.querySelector('.dy-list').textContent.includes('Group Silent')`), false);
  assert.equal(await chrome.evaluate(`[...document.querySelectorAll('.dy-side [data-side-part]')].map(part => part.dataset.sidePart).join(' ')`),
    'people groups');
  assert.deepEqual((await text(`${groups} .ck-section__label`)).map(words => words.replace(/\s+/gu, ' ')), ['Groups 2']);
  assert.deepEqual(await text(`${groups} .ck-prow__name`), ['Group Archived', 'Group Silent']);
  assert.deepEqual((await text(`${groups} .ck-run`)).map(words => words.trim()), ['14', '3']);
  assert.equal(await chrome.evaluate(`document.querySelectorAll('${groups} li.is-quiet').length`), 2);
  const colour = (/** @type {string} */ selector) =>
    chrome.evaluate(`getComputedStyle(document.querySelector('${selector}')).color`);
  assert.notEqual(await colour(`${groups} li.is-quiet .ck-prow__name`), await colour('.dy-side [data-side-part="people"] .ck-prow__name'));
  await shot('day-quiet', `document.querySelector('${untimed} [data-d-stay]')`);
  await chrome.until(`document.querySelectorAll('${groups} [data-d-group]').length === 2`);
  const asked = (await chrome.evaluate('window.conversations ?? []')).length;
  await chrome.evaluate(`document.querySelectorAll('${groups} [data-d-group]')[1].click()`);
  await chrome.until(`['Anyone up for the hike?', 'Count me out']
    .every(words => document.querySelector('.dy-panel')?.textContent.includes(words))`);
  assert.deepEqual((await chrome.evaluate('window.conversations')).slice(asked), [[SILENT, DAY]]);
  await shot('day-quiet-open', `document.querySelector('.dy-panel')?.textContent.includes('Count me out')`);
});

test('G7: WhatsApp\'s Quiet groups, under its Settings, says how many of its groups you are quiet in, opening the Groups view', async () => {
  await go('#view=connectors&dialog=whatsapp');
  const quiet = `[...document.querySelectorAll('.ck-srow--go')].some(each => each.querySelector('.ck-srow__label')?.textContent === 'Quiet groups'
    && each.querySelector('.ck-srow__value')?.textContent === '2')`;
  await chrome.until(quiet);
  const headings = await chrome.evaluate(`[...document.querySelectorAll('.ck-dialog .ck-ssection__heading')].map(each => each.textContent)`);
  assert.ok(headings.includes('Settings') && !headings.includes('Groups'), `the groups' rows under Settings: ${headings}`);
  assert.deepEqual((await chrome.evaluate(`[...[...document.querySelectorAll('.ck-ssection')]
    .find(each => each.querySelector('.ck-ssection__heading')?.textContent === 'Settings').querySelectorAll('.ck-srow__label')]
    .map(each => each.textContent)`)).slice(-4),
  ['Archived groups are quiet', 'Quiet after', 'Count group messages', 'Quiet groups']);
  await shot('whatsapp-groups', quiet);
  await chrome.evaluate(`[...document.querySelectorAll('.ck-srow--go .ck-srow__hit')]
    .find(each => each.textContent.includes('Quiet groups')).click()`);
  await chrome.until(`location.hash.includes('view=people')
    && document.querySelector('[data-people-seg="groups"][aria-selected="true"]')`);
  assert.equal((await text('.pp-main .ck-crow__name'))[0], 'Group 1');
});
