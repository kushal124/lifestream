import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installClock } from '../public/lib/home-clock.js';
import { momentAt, openingOf, routeOf } from '../public/lib/opening.js';
import { cursorExpired, newest, onClock, pageJoined, readingWords, unopened } from '../public/ui/search/query.js';
import {
  chipsShown, hitListReading, keyOf, kindsList, listState, rowWords, seeAllList, seePage, upcomingRow, whenWords,
} from '../public/ui/search/hit-list.js';
import {
  chipChoices, countSpoken, countWords, kindsParams, pageParams, searchChips, seeParams, timeChoices, timeRange, trackParams,
} from '../public/ui/search/filter-pills.js';
import {
  monthsOf, ownRows, playsOf, previewFailed, sittingPage, trackCount, trackFacts, trackPage, wholeCount,
} from '../public/ui/search/preview.js';
import { matched } from '../public/ui/kit/index.js';
import { remembered } from '../public/ui/search/recent-searches.js';
import { clockFor } from './stand-ins/clock.mjs';

installClock(clockFor('UTC', 4));

/**
 * @param {string} name
 * @returns {any}
 */
const contract = name => JSON.parse(readFileSync(new URL(`../../packages/home/test/contract/${name}.json`, import.meta.url), 'utf8'));

/**
 * @param {string} name
 * @returns {any}
 */
const fixture = name => JSON.parse(readFileSync(new URL(`../../homelink/Tests/Fixtures/pages/${name}.json`, import.meta.url), 'utf8'));

const FULL = fixture('search.full');
const KIND = fixture('searchKind.full');
const READING = fixture('search.reading');
const TODAY = FULL.today;
const PLAYS_DAY = '2026-11-14';
const NB = ' ';
const RIVERSIDE = { title: 'Riverside', artist: 'The Quiet Hours' };
const AT_NINE = Date.parse(`${TODAY}T09:00:00Z`);

/** @param {string} markup @param {string} name */
const values = (markup, name) => [...markup.matchAll(new RegExp(`${name}="([^"]*)"`, 'gu'))].map(match => match[1]);

/** @param {string} text @param {string} part */
const times = (text, part) => text.split(part).length - 1;

const MONTH = { kind: 'date', when: { kind: 'month', month: '2026-09' }, opens: { page: 'month', month: '2026-09', day: '2026-09-20' } };
const AI = { ...FULL.top[0], ref: 'record.synthetic-ai', family: 'ai', title: 'Synthetic trip plan', line: 'ChatGPT · You: a «lighthouse» trip',
  when: { kind: 'at', at_ms: AT_NINE } };
const WINDOW = contract('citations').r7;
const SITTING = {
  kind: 'sitting', key: 'u:screen:local:macbook-pro-0001/1793595600000', title: 'Booked the trip',
  line: `2${NB}windows · Example Browser · your «trip»`, said: 'the «trip» booked', when: { kind: 'at', at_ms: AT_NINE },
  windows: [{ ref: WINDOW.ref, app: WINDOW.app, title: WINDOW.title, line: 'Example Browser · your «trip»',
    when: { kind: 'at', at_ms: AT_NINE + 60_000 }, opens: WINDOW.opens }],
  windows_line: `1 of 2${NB}windows`, opens: { page: 'days', day: TODAY, focus: 'u:screen:local:macbook-pro-0001/1793595600000' },
};

test('W1: the chips are All and each kind of the home\'s answer in its order with its count, a partial count "n+" ("at least n" spoken); Any time at the end', () => {
  assert.deepEqual(chipChoices(FULL).map(each => [each.value, each.label, each.count]),
    [['', 'All', String(FULL.total.n)], ...FULL.kinds.map((/** @type {any} */ kind) => [kind.family, kind.title, String(kind.count.n)])]);
  const partial = { ...FULL, total: { n: 1747, partial: true }, kinds: [{ ...FULL.kinds[0], count: { n: 1180, partial: true } },
    { ...FULL.kinds[0], family: 'listening', title: 'Listening', count: null }] };
  assert.deepEqual(chipChoices(partial).map(each => [each.count, each.spoken]),
    [['1,747+', 'at least 1,747'], ['1,180+', 'at least 1,180'], ['', '']], 'an unread kind no number');
  const chips = searchChips({ answer: partial, family: 'messages', time: '', held: FULL.held, today: TODAY });
  assert.deepEqual(values(chips, 'data-value').slice(0, 3), ['', 'messages', 'listening']);
  assert.deepEqual(values(chips, 'aria-checked').slice(0, 3), ['false', 'true', 'false']);
  assert.ok(chips.indexOf('data-search-menu="time"') > chips.lastIndexOf('data-value="listening"'), 'Any time after the kinds');
  assert.ok(chips.includes('aria-label="Messages, at least 1,180"'));
  assert.deepEqual(timeChoices({ first: '2024-03-01' }, PLAYS_DAY).map(each => each.value), ['month', 'year', '2025', '2024']);
  assert.deepEqual([countWords(null), countSpoken(null)], ['', '']);
  const list = kindsList(partial, { today: TODAY }).markup;
  assert.ok(list.includes('<span class="sx-kind__count">1,180+</span>'), 'a head says n+');
});

test('W1: the list is the home\'s top hits in its order, then each kind in its order with its rows; See all where the home says', () => {
  const screen = { family: 'screen', title: 'Mac', count: { n: 1, partial: false }, upcoming: null, see: false, unread: null, rows: [SITTING] };
  const answer = { ...FULL, top: [MONTH, ...FULL.top], kinds: [...FULL.kinds, screen] };
  const { markup, shown } = kindsList(answer, { today: TODAY });
  const rows = [...answer.top, ...answer.kinds.flatMap((/** @type {any} */ kind) => kind.rows)];
  assert.deepEqual(shown.map(each => each.thing), rows);
  assert.deepEqual(shown.map(each => each.key), rows.map(keyOf));
  assert.deepEqual(values(markup, 'data-search-row').map(Number), shown.map((_, at) => at));
  assert.equal(new Set(shown.map(each => each.key)).size, shown.length, 'no row twice');
  assert.equal(markup.split('class="sx-kind ').length - 1, 1 + answer.kinds.length);
  assert.deepEqual(values(markup, 'data-search-see'),
    answer.kinds.filter((/** @type {any} */ kind) => kind.see).map((/** @type {any} */ kind) => kind.family));
  assert.deepEqual(kindsList(FULL, { today: TODAY }).shown.map(each => each.key), FULL.top.map((/** @type {any} */ row) => row.ref));
  assert.deepEqual(seePage(KIND, TODAY).rows.map(keyOf), KIND.rows.map((/** @type {any} */ row) => row.ref), 'a kind\'s page in its order');
});

test('W1: each row draws the home\'s title and line as they came; an AI hit names its app once; times are worded from the home\'s values', () => {
  const words = { today: TODAY };
  for (const row of FULL.top) {
    const drawn = rowWords(row, words);
    assert.deepEqual([drawn.title, drawn.line], [row.title, row.line ?? '']);
  }
  const ai = rowWords(AI, words);
  assert.deepEqual([ai.title, ai.line], [AI.title, AI.line]);
  assert.equal(times(`${ai.title}\n${ai.line}`, 'ChatGPT'), 1);
  assert.equal(ai.when, '09:00');
  assert.equal(rowWords(AI, { ...words, dated: true }).when, 'Today');
  assert.equal(whenWords({ kind: 'day', day: '2026-10-04' }, words), 'Yesterday');
  assert.equal(whenWords(null, words), '');
  const person = rowWords({ kind: 'person', ref: 'p', name: 'Person A', line: `214${NB}messages`, picture: null, opens: null }, words);
  assert.deepEqual([person.title, person.line], ['Person A', `214${NB}messages`]);
  const track = rowWords({ kind: 'track', ref: 't', title: 'Riverside', artist: 'The Quiet Hours', line: `212${NB}plays · The Quiet Hours` }, words);
  assert.deepEqual([track.title, track.line, track.when], ['Riverside', `212${NB}plays · The Quiet Hours`, '']);
  assert.match(rowWords({ ...AI, family: 'photos', picture: `sha256:${'a'.repeat(64)}` }, words).lead, /class="ck-pic ck-trow__picture"/u);
  const named = { kind: /** @type {const} */ ('person'), ref: 'person.synthetic-a', name: 'Person A', line: null,
    opens: { page: /** @type {const} */ ('people'), id: 'phone:+15550000001', person: 'person:person-a', group: null } };
  assert.match(rowWords({ ...named, picture: 'b'.repeat(64) }, words).lead, new RegExp(`class="ck-pic ck-face__photo" data-src="[^"]*${'b'.repeat(64)}`, 'u'),
    'a person draws the face the home gives');
  assert.doesNotMatch(rowWords({ ...named, picture: null }, words).lead, /ck-face__photo/u, 'no photo, their initials');
  assert.equal(matched('a <b> «x» & «y'), 'a &lt;b&gt; <mark>x</mark> &amp; <mark>y</mark>');
});

test('W1: a hit, a person, a group, a day and a named month open where the home says: a month at its newest written day, a group its own page', () => {
  for (const row of FULL.top) assert.deepEqual(routeOf(row.opens), { go: 'days', patch: { on: row.opens.day, focus: row.opens.focus } });
  assert.deepEqual(routeOf(MONTH.opens), { go: 'days', patch: { on: '2026-09-20' } });
  assert.equal(rowWords(/** @type {any} */ (MONTH), { today: TODAY }).title, 'September 2026');
  assert.equal(routeOf({ page: 'month', month: '2026-08', day: null }), null, 'a month with no written day opens nothing');
  const day = { kind: 'date', when: { kind: 'day', day: '2026-10-04' }, opens: { page: 'days', day: '2026-10-04', focus: null } };
  assert.deepEqual(routeOf(day.opens), { go: 'days', patch: { on: '2026-10-04' } });
  const dated = rowWords(/** @type {any} */ (day), { today: TODAY });
  assert.deepEqual([dated.title, dated.line], ['Yesterday', '']);
  assert.deepEqual(routeOf({ page: 'people', id: 'phone:+15550000001', person: 'person:person-a', group: null }), { go: 'people', patch: { focus: 'person:person-a' } });
  assert.deepEqual(routeOf({ page: 'people', id: 'whatsapp:120363000000000004@g.us', person: null, group: 'whatsapp:120363000000000004@g.us' }),
    { go: 'people', patch: { focus: 'chat:whatsapp:120363000000000004@g.us' } });
  assert.equal(listState({ words: 'september', kinds: { ...FULL, top: [MONTH], kinds: [] }, answer: 'found' }), 'date');
});

test('W1: See all is one read: the first screen\'s own parameters with see (and upcoming=1), then each next alone', () => {
  const words = [['query', 'riverside'], ['typing', '1']];
  assert.deepEqual([...kindsParams('riverside', '', TODAY)], words);
  assert.deepEqual([...kindsParams('riverside', '2025', TODAY)], [...words, ['from', '2025-01-01'], ['to', '2025-12-31']]);
  for (const time of ['', 'month', '2025']) {
    assert.deepEqual([...seeParams('riverside', { family: 'calendar', time, upcoming: false }, TODAY)],
      [...kindsParams('riverside', time, TODAY), ['see', 'calendar']], `the kinds read's own parameters (${time || 'any time'})`);
  }
  assert.deepEqual([...seeParams('riverside', { family: 'calendar', time: 'month', upcoming: true }, TODAY)],
    [...kindsParams('riverside', 'month', TODAY), ['see', 'calendar'], ['upcoming', '1']]);
  assert.deepEqual([...pageParams('cursor:see:photos:k2')], [['cursor', 'cursor:see:photos:k2']], 'a later page is its cursor alone');
  assert.deepEqual(timeRange('month', PLAYS_DAY), { from: '2026-11-01', to: '2026-11-30' });
});

test('W1: a See all page draws the home\'s rows in its order, its unread above them, its reading under them, the home\'s nothing alone; Upcoming above', () => {
  const words = { today: TODAY };
  const page = seePage(KIND, TODAY);
  const drawn = seeAllList(page, words, {});
  assert.deepEqual(drawn.shown.map(each => each.thing), KIND.rows);
  const newest = { kind: 'day', day: '2026-10-04' };
  const behind = seePage({ ...KIND, reading: { state: 'behind', line: `Still reading 2${NB}days, the newest`, newest } }, TODAY);
  assert.equal(behind.reading.replaceAll(NB, ' '), 'Still reading 2 days, the newest Sun 4 Oct');
  const still = seeAllList(behind, words, {}).markup;
  assert.ok(still.indexOf('Still reading') > still.lastIndexOf('data-search-row='), 'reading under the rows');
  const unread = seeAllList(seePage({ ...KIND, rows: [], unread: 'Too many plays match to count.' }, TODAY), words, {}).markup;
  assert.ok(unread.includes('class="sx-unread'));
  assert.equal(unread.includes('Nothing matches'), false);
  const empty = seeAllList(seePage({ ...KIND, rows: [], nothing: 'Nothing matches “riverside”.' }, TODAY), words, {});
  assert.equal(empty.shown.length, 0);
  assert.ok(empty.markup.includes('Nothing matches “riverside”.'), 'the home\'s sentence');
  const coming = seeAllList(page, words, { upcoming: { n: 2, partial: false } });
  assert.ok(coming.markup.indexOf('data-search-upcoming') < coming.markup.indexOf('data-search-row="0"'), 'Upcoming above the rows');
  assert.match(upcomingRow({ n: 50, partial: true }, false), />50\+</u);
  assert.ok(upcomingRow({ n: 50, partial: true }, false).includes('aria-label="Upcoming, at least 50"'));
  assert.match(upcomingRow(null, true), />Up to today</u);
  assert.equal(upcomingRow(null, false), '');
});

test('W2: a track opens its page: plays, a bar a month for twelve months, every play newest first with its day, time and app; exact to the track', () => {
  assert.deepEqual([...trackParams(RIVERSIDE)], [['of', 'plays'], ['match.track', '=Riverside'], ['match.artist', '=The Quiet Hours'],
    ['measure', 'times'], ['op', 'sum'], ['by', 'month']]);
  assert.deepEqual([...trackParams(RIVERSIDE, { month: '2026-11' })].slice(-4),
    [['by', 'item'], ['order', 'time'], ['from', '2026-11-01'], ['to', '2026-11-30']]);
  assert.equal(trackParams({ title: 'Home', artist: null }).get('match.artist'), null);
  assert.deepEqual(trackParams({ title: 'Home', artist: null }).getAll('by'), ['month', 'artist'], 'a track with no artist reads its months by artist too');
  const months = contract('count-plays-by-month');
  const november = contract('count-plays-by-item');
  assert.deepEqual(monthsOf(months).map(each => each.month), ['2026-11', '2026-10', '2026-09', '2026-08', '2026-07', '2026-06']);
  const plays = playsOf(november);
  assert.equal(plays.length, november.rows.length);
  assert.ok(plays.every((play, at) => at === 0 || play.at <= plays[at - 1].at), 'newest first');
  const facts = trackFacts({ track: RIVERSIDE, months, pages: [november], oldest: november }, PLAYS_DAY);
  assert.equal(facts.plays, 212);
  assert.equal(facts.album, 'Low Tide');
  assert.equal(facts.bars.length, 12);
  assert.equal(facts.bars.at(-1)?.month, '2026-11');
  assert.equal(facts.bars.at(-1)?.n, 20);
  assert.deepEqual(facts.older, ['2026-10', '2026-09', '2026-08', '2026-07', '2026-06']);
  const page = trackPage({ track: RIVERSIDE, months, pages: [november], oldest: november }, PLAYS_DAY);
  assert.deepEqual(values(page, 'data-search-play'), plays.map(play => play.day));
  assert.equal(values(page, 'data-week-bar').length, 12);
  assert.equal(values(page, 'data-search-earlier').length, 1);
  assert.equal(values(trackPage({ track: RIVERSIDE, months, pages: [november, november, november, november, november, november],
    oldest: november }, PLAYS_DAY), 'data-search-earlier').length, 0);
  assert.equal(values(trackPage({ track: RIVERSIDE, months: null, pages: [], oldest: null }, PLAYS_DAY), 'data-search-play').length, 0);
});

test('W2: a track with no artist counts only its own plays, as its row groups them, never another artist\'s track of that name', async () => {
  const months = contract('count-plays-by-month');
  const november = contract('count-plays-by-item');
  const home = { title: 'Riverside', artist: null };
  const byArtist = { ...months, columns: ['month', 'artist', 'n', 'sum', 'missing', 'ref'],
    rows: months.rows.flatMap((/** @type {any[]} */ row) => [[row[0], null, 5, 5, 0, `${row[4]}a`], [row[0], 'The Quiet Hours', row[1], row[2], 0, row[4]]]) };
  const own = ownRows(byArtist, home);
  assert.equal(own.rows.length, months.rows.length);
  assert.equal(trackFacts({ track: home, months: own, pages: [], oldest: null }, PLAYS_DAY).plays, 5 * months.rows.length);
  assert.equal(ownRows(byArtist, RIVERSIDE), byArtist, 'a named artist is the home\'s exact match');
  const artistAt = november.columns.indexOf('artist');
  const mixed = { ...november, rows: november.rows.map((/** @type {any[]} */ row, /** @type {number} */ at) => at % 2 ? row
    : row.map((value, column) => column === artistAt ? null : value)) };
  /** @type {string[]} */
  const asked = [];
  const read = async (/** @type {URLSearchParams} */ params) => {
    asked.push(params.getAll('by').join(','));
    return mixed;
  };
  const plays = await trackCount(read, home, { month: '2026-11' });
  assert.deepEqual(asked, ['item']);
  assert.equal(plays.rows.length, Math.ceil(november.rows.length / 2));
  assert.ok(plays.rows.every((/** @type {any[]} */ row) => row[artistAt] === null));
  assert.equal((await trackCount(read, home)).rows.length, Math.ceil(november.rows.length / 2));
  assert.deepEqual(asked.slice(1), ['month,artist']);
});

test('W2: a track\'s month follows the count\'s next until it is null before it is drawn, so last is the newest play', async () => {
  const november = contract('count-plays-by-item');
  const half = Math.ceil(november.rows.length / 2);
  /** @type {string[]} */
  const asked = [];
  const read = async (/** @type {URLSearchParams} */ params) => {
    asked.push(String(params));
    if (!params.has('cursor')) return { ...november, rows: november.rows.slice(0, half), next: 'cursor:count:2' };
    return { ...november, rows: november.rows.slice(half), next: null };
  };
  const whole = await wholeCount(read, trackParams({ title: 'Riverside', artist: null }, { month: '2026-11' }));
  assert.deepEqual(asked.slice(1), ['cursor=cursor%3Acount%3A2']);
  assert.deepEqual([whole.rows, whole.next], [november.rows, null]);
  const months = contract('count-plays-by-month');
  const facts = trackFacts({ track: RIVERSIDE, months, pages: [whole], oldest: whole }, PLAYS_DAY);
  assert.equal(facts.list.length, november.rows.length);
  assert.equal(facts.list[0].at, playsOf(november)[0].at, 'the newest play of the whole month');
});

test('W2: a sitting opens the home\'s summary, its said words and its windows, each window opening the focus the home gave it', () => {
  const page = sittingPage(/** @type {any} */ (SITTING), TODAY);
  assert.deepEqual(values(page, 'data-search-window'), ['0']);
  assert.equal(values(page, 'data-search-day').length, 1);
  assert.match(page, /<mark>trip<\/mark>/u);
  assert.ok(page.replaceAll(NB, ' ').includes('1 of 2 windows'), 'the home\'s words for how many it lists');
  assert.ok(page.includes('>Booked the trip<'));
  const [window] = SITTING.windows;
  assert.deepEqual(momentAt(window.opens), { on: WINDOW.day, focus: WINDOW.opens.focus }, 'the focus the home gave it');
  assert.deepEqual(routeOf(SITTING.opens), { go: 'days', patch: { on: TODAY, focus: SITTING.key } });
  assert.equal(keyOf(/** @type {any} */ (SITTING)), SITTING.key, 'a sitting is kept by the home\'s key');
});

test('W2: the preview follows the selection: only the newest selection\'s read is drawn, one read behind at most, none once the words go', async () => {
  let selected = 'row 0';
  /** @type {{ key: string, answer: (value: string) => void }[]} */
  const reads = [];
  /** @type {string[]} */
  const drawn = [];
  const preview = newest(() => new Promise(answer => reads.push({ key: selected, answer })), answer => drawn.push(answer), () => selected);
  const settle = () => new Promise(done => setImmediate(done));
  const first = preview.ask();
  selected = 'row 1';
  void preview.ask();
  selected = 'row 2';
  void preview.ask();
  assert.deepEqual(reads.map(each => each.key), ['row 0']);
  reads[0].answer('row 0 read');
  await settle();
  assert.deepEqual(reads.map(each => each.key), ['row 0', 'row 2']);
  assert.deepEqual(drawn, []);
  reads[1].answer('row 2 read');
  await first;
  assert.deepEqual(drawn, ['row 2 read']);
  selected = 'row 3';
  const second = preview.ask();
  preview.drop();
  reads[2].answer('row 3 read');
  await second;
  assert.deepEqual([reads.length, drawn], [3, ['row 2 read']]);
});

test('W3: the list\'s state: recent before words, reading rows before the first answer, the home\'s reading line while it builds, nothing alone, else the kinds', () => {
  const none = { ...FULL, top: [], kinds: [], nothing: 'Nothing matches “river”.' };
  assert.equal(listState({ words: ' ', kinds: FULL, answer: 'found' }), 'recent');
  assert.equal(listState({ words: 'river', kinds: null, answer: 'none' }), 'reading');
  assert.equal(listState({ words: 'river', kinds: READING, answer: 'found' }), 'building');
  assert.equal(readingWords(READING.reading, TODAY), READING.reading.line);
  assert.equal(listState({ words: 'river', kinds: null, answer: 'lack' }), 'lack');
  assert.equal(listState({ words: 'river', kinds: null, answer: 'waiting' }), 'waiting');
  assert.equal(listState({ words: 'river', kinds: FULL, answer: 'lack' }), 'kinds', 'a failure keeps the last answer');
  assert.equal(listState({ words: 'river', kinds: none, answer: 'found' }), 'nothing');
  assert.equal(chipsShown('date', { family: '', time: '' }), false);
  assert.equal(chipsShown('nothing', { family: '', time: '' }), false);
  assert.equal(chipsShown('nothing', { family: '', time: '2024' }), true);
  assert.equal(chipsShown('building', { family: '', time: '' }), false);
  assert.equal(chipsShown('kinds', { family: '', time: '' }), true);
  assert.equal(hitListReading().split('class="ck-trow ck-trow--reading"').length - 1, 6);
  assert.equal(readingWords(null, TODAY), '');
});

test('W3: a later See all page states its own unread and reading; an expired next asks the first page again, never Try again', () => {
  const unread = 'Screen search is getting ready.';
  const page = { rows: ['a', 'b'], next: 'n1', unread, reading: 'Still reading Sat 14 Nov' };
  assert.deepEqual(pageJoined(page, { rows: ['c'], next: 'n2', unread, reading: '' }), { rows: ['a', 'b', 'c'], next: 'n2', unread, reading: '' });
  assert.deepEqual(pageJoined(page, { rows: ['c'], next: null, unread: '', reading: '' }),
    { rows: ['a', 'b', 'c'], next: null, unread: '', reading: '' });
  assert.equal(cursorExpired(Object.assign(new Error('changed'), { code: 'CURSOR_EXPIRED' })), true);
  assert.equal(cursorExpired(Object.assign(new Error('busy'), { code: 'NOT_NOW' })), false);
  assert.equal(cursorExpired(new Error('gone')), false);
  assert.equal(cursorExpired(null), false);
});

test('W3: the preview\'s failure offers Try again; a citation the door does not describe opens nothing, a window opens as a moment', () => {
  assert.equal(values(previewFailed('The day could not be read.', true), 'data-search-preview-retry').length, 1);
  assert.equal(values(previewFailed('Gone.', false), 'data-search-preview-retry').length, 0);
  const cited = contract('citations');
  assert.equal(openingOf(cited.r12), null);
  assert.equal(unopened('Asha', cited.r12.why), `Couldn’t open Asha: ${cited.r12.why}`);
  assert.deepEqual(openingOf(cited.r9), { go: 'people', patch: { focus: 'phone:+15550000001' } }, 'a kept person opens by its handle');
  assert.deepEqual(openingOf(cited.r10), { go: 'people', patch: { focus: `chat:${cited.r10.opens.group}` } });
  assert.deepEqual(openingOf(cited.r11), { go: 'places', patch: { focus: 'example-cafe' } });
  assert.deepEqual(openingOf(cited.r7), { panel: true });
});

test('W3: the words ask the home again only when its clock moves; the first clock in place of the stand-in, the same day, draws the answer held again', () => {
  assert.equal(onClock({ clock: true, clockMoved: false }, 'lighthouse'), 'draw', 'the first clock replacing the stand-in asks nothing');
  assert.equal(onClock({ clock: true, clockMoved: true }, 'lighthouse'), 'ask', 'a clock that moved asks the words again');
  assert.equal(onClock({ clock: true, clockMoved: true }, '  '), 'draw', 'with no words nothing is asked');
  assert.equal(onClock({ clock: false, clockMoved: false }, 'lighthouse'), null, 'a change with no clock leaves the list');
});

test('the recent searches, newest first, each once whatever its case or spaces, five at most, none empty', () => {
  let recent = /** @type {string[]} */ ([]);
  for (const words of ['dinner', 'Person A', '  ', 'trip', 'DINNER ', 'passport', 'flights', 'person  a', 'notes']) {
    recent = remembered(recent, words);
  }
  assert.deepEqual(recent, ['notes', 'person a', 'flights', 'passport', 'DINNER']);
  const same = ['a'];
  assert.equal(remembered(same, ' '), same);
});
