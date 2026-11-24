import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { MODELS } from '../public/kit-gallery-llm.js';
import { detailOf, OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { GROUPS, NOTES, savedAct, settingsAt, settingsDetail, TYPED } from '../public/ui/connectors/settings.js';
import { STATUS_UNREAD } from '../public/ui/connectors/settings-pages.js';
import { STATES as REACH_STATES } from '../public/kit-gallery-reach.js';
import { AT_REST } from '../public/ui/connectors/view.js';
import { FLOWS } from '../public/lib/hash.js';
import { meaningAct, meaningOn, meaningParts, MEANING_BUSY, MEANING_COST, MEANING_EXAMPLE } from '../public/ui/connectors/settings-search.js';
import { LACKS, SCREEN_EVERY, workShown } from '../public/ui/connectors/changes.js';
import { keyOf, movesMeaning, movesPrivacy } from '../public/ui/connectors/pending.js';
import { SETTINGS_MEANING } from '../public/ui/connectors/settings.js';
import { NO_CHANGES, partsOf } from '../public/ui/onboarding/view.js';
import { sessionOf } from '../public/ui/flows/model.js';
import { STATE_OFF, STATE_ON } from './fixtures/screen.mjs';

/** @typedef {import('../public/ui/connectors/dialog.js').Detail} Detail */
/** @typedef {import('../public/lib/host.js').HostState} HostState */

const PAGES = GROUPS.flatMap(group => group.pages);
const OWN = PAGES.filter(page => page.mac).map(page => page.id);
const ELSEWHERE = { ...HOST_STATE, folder: null };
const AWAY = { ...HOST_STATE, reach: REACH_STATES.held };

/**
 * @param {string} id
 * @param {{ state?: HostState | null, report?: import('../public/types.js').StreamsReport | null, opened?: Partial<typeof OPENED>, query?: string, unread?: boolean, screen?: { read: any, failed: string } }} [read]
 */
const at = (id, { state = HOST_STATE, report = REPORT, opened = {}, query = '', unread = false, screen = undefined } = {}) => settingsDetail({ report,
  models: MODELS, failed: '', state, id, opened: { ...OPENED, ...opened }, subscriptions: null, query, unread, screen });
/** @param {Detail} detail */
const rowsOf = detail => detail.parts.flatMap(part => part.panel?.rows ?? []);
/**
 * @param {Detail} detail
 * @param {string} label
 */
const rowOf = (detail, label) => rowsOf(detail).find(row => row.label === label);
/**
 * @param {Detail} detail
 * @returns {any[]}
 */
const actsOf = detail => [...detailMarkup(detail, AT_REST).matchAll(/data-cn-do="([^"]*)"/gu)]
  .map(match => JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&#39;', '\'')));
/** @param {Detail} detail */
const hostActs = detail => actsOf(detail).flatMap(each => 'host' in each ? [each.host] : []).map(each => each.act);
const ON_HOME = ['pause', 'resume', 'home-setting', 'device-name', 'retire-phone', 'seal', 'models', 'agent-access', 'agent-answer'];

test('P1: every page draws; the Mac\'s own neither listed nor drawn in a browser', () => {
  for (const page of PAGES) {
    const detail = at(`settings/${page.id}`);
    assert.ok(detail, page.id);
    assert.doesNotThrow(() => detailMarkup(detail, AT_REST), page.id);
    const browser = at(`settings/${page.id}`, { state: null });
    assert.equal(browser === null, OWN.includes(page.id), `${page.id} in a browser`);
  }
  assert.deepEqual(OWN, ['recovery', 'updates']);
  const listed = /** @param {Detail | null} detail */ detail => detail?.nav?.groups.flatMap(group => group.items.map(item => item.id));
  assert.deepEqual(listed(at('settings')), PAGES.map(page => page.id));
  assert.deepEqual(listed(at('settings', { state: null })), PAGES.map(page => page.id).filter(id => !OWN.includes(id)));
  assert.ok(PAGES.some(page => page.id === 'privacy'), 'Privacy is listed, under Models');
});

test('P2: the route opens its page at its row; the old ids open nothing', () => {
  assert.deepEqual(settingsAt('settings'), { page: 'home', row: '' });
  assert.deepEqual(settingsAt('settings/iphone/iphone-12-cc03'), { page: 'iphone', row: 'iphone-12-cc03' });
  assert.equal(at('settings/iphone/iphone-12-cc03')?.at, 'iphone-12-cc03');
  assert.equal(at('settings')?.name, 'General');
  for (const old of ['home', 'agents', 'extension', 'device:macbook-pro-0001', 'this-mac', 'settings/general', 'settings/nowhere']) {
    assert.equal(at(old), null, old);
    assert.equal(detailOf(REPORT, HOST_STATE, old, OPENED), null, old);
  }
});

test('P3: reading, a browser, a home that does not answer, a Mac that does not hold it', () => {
  for (const page of ['home', 'time', 'iphone', 'chrome', 'advanced']) {
    const reading = /** @type {Detail} */ (at(`settings/${page}`, { report: null }));
    assert.equal(reading.reading, true, page);
    assert.deepEqual(reading.parts, [], page);
    assert.equal(reading.note, '', page);
  }
  assert.equal(at('settings/time')?.reading, false);
  const stale = /** @type {Detail} */ (at('settings/home', { unread: true }));
  assert.equal(rowOf(stale, 'Status')?.line, STATUS_UNREAD);
  assert.deepEqual(hostActs(stale).filter(act => ON_HOME.includes(act)), [], 'nothing acts on a home that does not answer');
  for (const [state, report, unread, note] of /** @type {const} */ ([[null, REPORT, false, NOTES.browser], [AWAY, REPORT, false, ''],
    [HOST_STATE, null, true, ''], [HOST_STATE, REPORT, true, ''], [ELSEWHERE, REPORT, false, NOTES.elsewhere],
    [HOST_STATE, REPORT, false, '']])) {
    for (const page of ['home', 'iphone', 'chrome', 'models', 'advanced']) {
      assert.equal(at(`settings/${page}`, { state, report, unread })?.note, note, `${page}: ${note}`);
    }
    for (const page of ['mac', 'appearance']) assert.equal(at(`settings/${page}`, { state, report, unread })?.note, '', page);
  }
  for (const page of PAGES.map(each => each.id)) {
    const browser = at(`settings/${page}`, { state: null });
    if (browser) assert.deepEqual(hostActs(browser), [], `${page} in a browser`);
    for (const state of [AWAY, ELSEWHERE]) {
      const detail = at(`settings/${page}`, { state });
      if (detail) assert.deepEqual(hostActs(detail).filter(act => ON_HOME.includes(act)), [], `${page} away from the home`);
    }
  }
  const away = /** @type {Detail} */ (at('settings/home', { state: AWAY, report: null, unread: true }));
  assert.equal(away.reading, false);
  assert.equal(rowOf(away, 'Status')?.line, 'Needs you');
  assert.deepEqual(rowOf(away, 'Status')?.waiting ?? [], []);
  assert.deepEqual(actsOf(away).filter(each => each.host?.act === 'home'), [], 'the strip\'s act is the strip\'s');
  const gone = /** @type {Detail} */ (at('settings/home', { state: { ...HOST_STATE, reach: REACH_STATES.unreachable }, report: null, unread: true }));
  assert.equal(rowOf(gone, 'Status')?.line, 'Can’t reach');
  assert.equal(rowOf(/** @type {Detail} */ (at('settings/home', { state: AWAY })), 'Status')?.line, 'Needs you');
  const sending = /** @type {Detail} */ (at('settings/home', { state: { ...HOST_STATE, sending: 'Waiting for space on Lifestream\'s disk' } }));
  assert.equal(rowOf(sending, 'This Mac')?.line, 'Waiting for space on Lifestream\'s disk');
  assert.equal(rowOf(/** @type {Detail} */ (at('settings/home')), 'This Mac'), undefined, 'nothing to say, no line');
  const elsewhere = /** @type {Detail} */ (at('settings/mac', { state: ELSEWHERE }));
  for (const act of ['general-login', 'allow', 'uninstall']) assert.ok(hostActs(elsewhere).includes(act), act);
  assert.ok(!actsOf(elsewhere).some(each => String(each.page).startsWith('rename:')), 'Rename… away from the home');
});

test('P4: each control sends its act', () => {
  const home = /** @type {Detail} */ (at('settings/home'));
  assert.deepEqual(/** @type {any} */ (rowOf(home, 'Pause Lifestream')?.end)?.toggle.do, { host: { act: 'pause', target: 'home' } });
  const paused = /** @type {Detail} */ (at('settings/home', { report: { ...REPORT, paused: [...REPORT.paused,
    { ...REPORT.paused[0], target: 'home', title: 'Paused: Lifestream' }] } }));
  assert.deepEqual(/** @type {any} */ (rowOf(paused, 'Pause Lifestream')?.end)?.toggle.do, { host: { act: 'resume', target: 'home' } });
  assert.ok(actsOf(home).some(each => each.host?.act === 'resume' && each.host.target === REPORT.paused[0].target));
  const cap = /** @type {any} */ (rowOf(/** @type {Detail} */ (at('settings/advanced')), 'Model calls at once')?.end).menu;
  const { model_cap_default: fallback } = REPORT.home.settings;
  for (const choice of cap.choices) {
    assert.deepEqual(choice.do, { host: { act: 'home-setting', key: 'model.cap', value: Number(choice.words) === fallback ? null : Number(choice.words) } });
    assert.equal(choice.default, Number(choice.words) === fallback);
  }
  assert.ok(cap.choices.some((/** @type {any} */ each) => each.chosen && Number(each.words) === REPORT.home.settings.model_cap));
  assert.equal(cap.busy, 'home-setting:model.cap');
  const odd = { ...REPORT, home: { ...REPORT.home, settings: { ...REPORT.home.settings, model_cap: 3, model_cap_default: 12 } } };
  const offered = /** @type {any} */ (rowOf(/** @type {Detail} */ (at('settings/advanced', { report: odd })), 'Model calls at once')?.end).menu.choices;
  assert.ok(offered.some((/** @type {any} */ each) => each.words === '3' && each.chosen));
  assert.ok(offered.some((/** @type {any} */ each) => each.words === '12' && each.default));
  const macs = REPORT.devices.filter(each => each.kind === 'mac' && !each.retired);
  assert.ok(macs.length > 1, 'the gallery holds another Mac');
  for (const mac of macs) {
    assert.ok(actsOf(/** @type {Detail} */ (at('settings/mac'))).some(each => each.page === `rename:${mac.unit}`), mac.unit);
    const opened = { ...OPENED, pages: [`rename:${mac.unit}`] };
    const rename = /** @type {Detail} */ (at('settings/mac', { opened }));
    assert.equal(rename.back?.label, rename.name);
    assert.equal(rename.parts[0].label, '', 'no heading over the one row');
    assert.deepEqual(/** @type {any} */ (rename.parts[0].panel?.rows[0].end)?.field.value, mac.name);
    assert.equal(/** @type {any} */ (rename.parts[0].panel?.rows[0].end)?.field.max, 64);
    assert.match(detailMarkup(rename, AT_REST), /maxlength="64"/u);
    assert.equal(savedAct('name', opened, REPORT), null, 'its own name');
    assert.deepEqual(savedAct('name', { ...opened, fields: { [TYPED.name]: ' Studio Mac ' } }, REPORT),
      { act: 'device-name', unit: mac.unit, name: 'Studio Mac' });
  }
  assert.equal(savedAct('name', { ...OPENED, fields: { [TYPED.name]: 'Studio Mac' } }, REPORT), null, 'no Rename… page open');
  const theme = /** @type {any} */ (rowOf(/** @type {Detail} */ (at('settings/appearance')), 'Theme')?.end).segmented;
  assert.deepEqual(theme.choices.map((/** @type {any} */ each) => [each.value, each.chosen]), [['system', true], ['light', false], ['dark', false]]);
  const words = 'This build does not update itself. A new build is installed by hand.';
  const general = { ...(/** @type {NonNullable<HostState['general']>} */ (HOST_STATE.general)), by_hand: words };
  const byHand = /** @type {Detail} */ (at('settings/updates', { state: { ...HOST_STATE, general } }));
  assert.deepEqual(rowsOf(byHand).map(row => [row.label, row.line]), [['Version', words]]);
  assert.deepEqual(hostActs(byHand), []);
  assert.ok(rowsOf(/** @type {Detail} */ (at('settings/updates'))).length > 1);
});

test('P5: Day and time and Advanced say the home\'s settings', () => {
  const settings = { ...REPORT.home.settings, zone: 'Asia/Kolkata', day_start_hour: 5, helpers: /** @type {const} */ ('auto'),
    helpers_resolved: 8, port: 4680, lan_port: 4682 };
  const report = { ...REPORT, home: { ...REPORT.home, settings } };
  const time = /** @type {Detail} */ (at('settings/time', { report }));
  assert.match(/** @type {any} */ (rowOf(time, 'Time zone')?.end).words, /^Asia\/Kolkata · GMT\+5:30$/u);
  assert.equal(/** @type {any} */ (rowOf(time, 'A day starts at')?.end).words, '5:00 AM');
  const advanced = /** @type {Detail} */ (at('settings/advanced', { report }));
  assert.equal(/** @type {any} */ (rowOf(advanced, 'Background work')?.end).words, 'Automatic · 8');
  assert.equal(/** @type {any} */ (rowOf(advanced, 'Port')?.end).words, '4680');
  assert.equal(/** @type {any} */ (rowOf(advanced, 'Local network port')?.end).words, '4682');
  assert.equal(/** @type {any} */ (rowOf(/** @type {Detail} */ (at('settings/advanced')), 'Background work')?.end).words,
    String(REPORT.home.settings.helpers));
  const { settings: _, ...older } = REPORT.home;
  for (const page of ['time', 'advanced']) {
    const detail = /** @type {Detail} */ (at(`settings/${page}`, { report: /** @type {any} */ ({ ...REPORT, home: older }) }));
    assert.equal(detail.reading, true, page);
    assert.doesNotThrow(() => detailMarkup(detail, AT_REST), page);
  }
});

test('P6: search keeps the pages whose name or rows hold what is typed', () => {
  const found = /** @param {string} query */ query => at('settings/home', { query })?.nav?.groups.flatMap(group => group.items.map(item => item.id));
  assert.deepEqual(found('port'), ['advanced']);
  assert.deepEqual(found('THEME'), ['appearance']);
  assert.deepEqual(found('zzz'), []);
  assert.match(detailMarkup(/** @type {Detail} */ (at('settings/home', { query: 'zzz' })), AT_REST), /No settings match\./u);
});

test('P7: a device\'s streams each open their own dialog in a new history entry', () => {
  for (const id of ['settings/mac', 'settings/iphone']) {
    const streams = rowsOf(/** @type {Detail} */ (at(id))).filter(row => row.go && 'open' in row.go.do);
    assert.ok(streams.length > 0, id);
    for (const row of streams) {
      const go = /** @type {any} */ (row.go).do;
      assert.equal(go.push, true, `${id}: ${row.label}`);
      assert.ok(detailOf(REPORT, HOST_STATE, go.open, OPENED), `${id}: ${go.open} opens`);
    }
  }
});

test('P8: every dialog hash the Mac app sends draws its page', () => {
  /** @type {string[]} */
  const hashes = JSON.parse(readFileSync(new URL('./mac-hashes.json', import.meta.url), 'utf8'));
  assert.ok(hashes.length > 0);
  for (const hash of hashes) {
    const params = new URLSearchParams(hash);
    const dialog = params.get('dialog') ?? '';
    assert.ok(at(dialog), hash);
    const flow = params.get('flow');
    if (flow) assert.ok(/** @type {readonly string[]} */ (FLOWS).includes(flow), hash);
  }
});

test('P9: Search by meaning: off by default, every part a setting, turning off asked once more while it holds data', () => {
  const RUNNER = `runner-${HOST_STATE.unit}`;
  const meaning = (/** @type {any} */ read, more = {}) => /** @type {Detail} */ (at(SETTINGS_MEANING, { screen: { read, drawn: null }, ...more }));
  assert.ok(GROUPS.find(group => group.label === 'Models')?.pages.some(page => page.id === 'meaning'));
  assert.deepEqual(settingsAt(SETTINGS_MEANING), { page: 'meaning', row: '' });
  assert.equal(at(SETTINGS_MEANING)?.reading, true);
  assert.deepEqual(at(SETTINGS_MEANING)?.parts, []);
  const failed = /** @type {Detail} */ (at(SETTINGS_MEANING, { screen: { read: null, drawn: { kind: 'lack', words: null, retry: true } } }));
  assert.equal(failed.reading, false);
  assert.deepEqual(failed.parts, []);
  assert.ok(detailMarkup(failed, AT_REST).includes(LACKS.screen));
  assert.ok(actsOf(failed).some(act => act.reread === 'screen'), 'Try again reads the screen search\'s state again');
  const off = meaning(STATE_OFF);
  const toggle = /** @type {any} */ (rowOf(off, 'Search by meaning')?.end).toggle;
  assert.equal(toggle.on, false);
  assert.deepEqual(toggle.do, { host: { act: 'home-setting', settings: { 'search.meaning': RUNNER } } });
  assert.equal(/** @type {any} */ (rowOf(off, 'Model')?.end).menu.words, 'EmbeddingGemma 2');
  assert.match(rowOf(off, 'Model')?.line ?? '', /303 MB/u);
  assert.equal(rowOf(off, 'Model')?.tag, 'Runs on this Mac only');
  assert.equal(/** @type {any} */ (rowOf(off, 'When it runs')?.end).menu.words, 'Only when plugged in and idle');
  assert.equal(rowOf(off, 'Delete meaning data'), undefined);
  assert.equal(rowOf(off, 'Searchable'), undefined);
  assert.deepEqual(actsOf(off).flatMap(each => 'host' in each ? [each.host] : []),
    [{ act: 'home-setting', settings: { 'search.meaning': RUNNER } }]);
  const choices = (/** @type {string} */ label) => /** @type {any} */ (rowOf(off, label)?.end).menu.choices.map((/** @type {any} */ each) => each.do.host);
  assert.deepEqual(choices('Model'), [{ act: 'home-setting', settings: { 'search.meaning.model': 'embeddinggemma-2-q8-512' } }]);
  assert.deepEqual(choices('When it runs'), [{ act: 'home-setting', settings: { 'search.meaning.power': 'plugged-idle' } }]);
  const on = meaning(STATE_ON);
  const searchable = /** @type {any} */ (rowOf(on, 'Searchable'));
  assert.deepEqual(searchable.progress, { label: 'Searchable so far', share: 0.62, words: '62% of your screen, newest first' });
  assert.equal(searchable.line, 'Waiting for macbook-pro-0001 to be idle.');
  assert.equal(searchable.end, null);
  assert.equal(rowOf(meaning({ ...STATE_ON, waits: null, waits_line: null }), 'Searchable')?.line,
    'It reads when this Mac is plugged in and idle.');
  assert.match(/** @type {any} */ (rowOf(meaning({ ...STATE_ON, embedded: 99_999, named: 100_000, queued: 1 }), 'Searchable'))?.progress.words, /^99% /u);
  assert.equal(/** @type {any} */ (rowOf(on, 'On disk')?.end).words, '46 MB');
  const done = { ...STATE_ON, embedded: 100_000, named: 100_000, queued: 0, waits: null, waits_line: null };
  const caught = /** @type {any} */ (rowOf(meaning(done), 'Searchable'));
  assert.equal(caught.line, 'Caught up with your screen.');
  assert.deepEqual(caught.end, { words: 'All of your screen', done: true });
  assert.equal(caught.progress, null);
  const skipped = /** @type {any} */ (rowOf(meaning({ ...done, embedded: 99_000, named: 99_000, skipped: 1_000 }), 'Searchable'));
  assert.equal(skipped.line, 'Caught up with your screen. 1,000 could not be read.');
  assert.equal(skipped.end, null);
  assert.deepEqual(skipped.progress, { label: 'Searchable so far', share: 0.99, words: '99% of your screen, newest first' });
  assert.equal(/** @type {any} */ (rowOf(meaning({ ...STATE_ON, skipped: 3 }), 'Searchable')).line,
    'Waiting for macbook-pro-0001 to be idle. 3 could not be read.');
  assert.equal(rowOf(meaning({ ...STATE_ON, embedded: 0, named: 0, queued: 0, waits: null, waits_line: null }), 'Searchable')?.line,
    'It starts once this Mac has recorded your screen.');
  const flip = /** @type {any} */ (rowOf(on, 'Search by meaning'));
  assert.deepEqual(flip.end.toggle.do, { ask: 'meaning-off' });
  assert.equal(flip.confirm.question, 'Turn off meaning search?');
  assert.match(flip.confirm.detail, /46 MB/u);
  assert.deepEqual(flip.confirm.yes.do, { host: { act: 'home-setting', settings: { 'search.meaning': 'off' } } });
  assert.doesNotMatch(detailMarkup(on, AT_REST), /Turn off meaning search\?/u, 'the question waits for the press');
  assert.match(detailMarkup(on, { ...AT_REST, asking: 'meaning-off' }), /Turn off meaning search\?/u);
  assert.equal(rowOf(on, 'Delete meaning data'), undefined);
  const empty = /** @type {any} */ (rowOf(meaning({ ...STATE_ON, vectors_bytes: 0 }), 'Search by meaning'));
  assert.deepEqual(empty.end.toggle.do, { host: { act: 'home-setting', settings: { 'search.meaning': 'off' } } });
  assert.equal(empty.confirm, null);
  assert.equal(rowOf(meaning({ ...STATE_OFF, vectors_bytes: 1_000_000 }), 'On disk'), undefined);
  for (const state of [null, AWAY, ELSEWHERE]) {
    const away = meaning(STATE_ON, { state });
    assert.deepEqual(actsOf(away).filter(each => 'host' in each || 'ask' in each), [], String(state?.unit));
    assert.equal(/** @type {any} */ (rowOf(away, 'Search by meaning')?.end).words, 'On');
  }
  const write = /** @type {any} */ (meaningAct(true, RUNNER));
  assert.equal(keyOf(write), MEANING_BUSY);
  assert.equal(keyOf(/** @type {any} */ (meaningAct(false, null))), MEANING_BUSY);
  assert.equal(meaningAct(true, null), null, 'no runner, no turning on');
  assert.equal(movesMeaning(write), true);
  assert.equal(movesPrivacy(write, null), false);
  assert.equal(meaningParts({ state: STATE_OFF, failed: false, acts: true, runner: RUNNER }).reading, false);
  assert.equal(SCREEN_EVERY, 10_000);
  assert.equal(workShown({ ...STATE_OFF, vectors_bytes: 1_000_000 }, true), false);
  assert.equal(workShown(STATE_OFF, true), true);
  assert.equal(workShown({ ...STATE_ON, embedded: 0, waits: null, waits_line: null }, false), false);
  assert.equal(workShown({ ...STATE_ON, embedded: 0 }, false), true);
  assert.equal(workShown({ ...STATE_ON, waits: null, waits_line: null }, false), true);
  assert.equal(workShown(STATE_OFF, false), false);
});

test('P10: the setup’s record screen never offers Search by meaning, which stays in Settings with its act', () => {
  const session = /** @type {any} */ ({ ...sessionOf(true, 'dialog'), picked: new Map(), dialog: null,
    how: false, changes: { ...NO_CHANGES, busy: new Set(), screen: { read: STATE_ON, drawn: null, failed: '' } }, nameTyped: null,
    span: null, cost: { read: null, failed: '' }, saved: false, recovery: null,
    drafted: null, redrafted: false, failure: null });
  const seen = /** @type {any} */ ({ state: HOST_STATE, report: REPORT, screen: STATE_ON });
  const body = partsOf('record', seen, session, null).body ?? '';
  assert.match(body, /Screen/u);
  assert.doesNotMatch(body, /Search by meaning|data-ob="meaning"/u);
  assert.match(MEANING_EXAMPLE, /^Ask for /u);
  assert.match(MEANING_COST, /303 MB/u);
  assert.deepEqual(meaningAct(true, `runner-${HOST_STATE.unit}`), { act: 'home-setting', settings: { 'search.meaning': `runner-${HOST_STATE.unit}` } });
  assert.deepEqual(meaningAct(false, null), { act: 'home-setting', settings: { 'search.meaning': 'off' } });
});

test('P11: the door\'s own screen states draw Search by meaning, on and off', () => {
  const door = JSON.parse(readFileSync(new URL('./fixtures/screen-door.json', import.meta.url), 'utf8'));
  const meaning = (/** @type {any} */ read) => /** @type {Detail} */ (at(SETTINGS_MEANING, { screen: { read, drawn: null } }));
  const on = meaning(door.state);
  assert.equal(meaningOn(door.state), true);
  assert.equal(/** @type {any} */ (rowOf(on, 'Search by meaning')?.end).toggle.on, true);
  assert.equal(rowOf(on, 'Searchable')?.line, 'Caught up with your screen.');
  assert.deepEqual(/** @type {any} */ (rowOf(on, 'Searchable')?.end), { words: 'All of your screen', done: true });
  assert.ok(rowOf(on, 'On disk'));
  assert.deepEqual(/** @type {any} */ (rowOf(on, 'Search by meaning')?.end).toggle.do, { ask: 'meaning-off' });
  const off = meaning(door.state_off);
  assert.equal(meaningOn(door.state_off), false);
  assert.equal(/** @type {any} */ (rowOf(off, 'Search by meaning')?.end).toggle.on, false);
  assert.equal(rowOf(off, 'Searchable'), undefined);
  assert.equal(rowOf(off, 'On disk'), undefined);
});

test('P12: This Mac\'s Command line says what the command says, Install or Remove, and gives the agent\'s line to copy', () => {
  const prompt = 'Lifestream runs on this Mac. Run ~/.local/bin/lifestream help connectors and follow it to add a connector for ___; type each lifestream command it names as ~/.local/bin/lifestream.';
  /** @param {import('../public/lib/host.js').HostCommand | null} command */
  const mac = command => /** @type {Detail} */ (at('settings/mac', { state: { ...HOST_STATE,
    general: { .../** @type {NonNullable<HostState['general']>} */ (HOST_STATE.general), command } } }));
  /** @param {Detail} detail */
  const commandActs = detail => actsOf(detail).flatMap(each => 'host' in each && each.host.act === 'general-command' ? [each.host] : []);
  /** @param {Detail} detail */
  const copies = detail => [...detailMarkup(detail, AT_REST).matchAll(/data-cn-copy="([^"]*)"/gu)]
    .map(match => match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&#39;', '\''));

  const installed = mac({ state: 'installed', words: 'lifestream works in new terminal windows.', prompt });
  assert.equal(rowOf(installed, 'Command line')?.line, 'lifestream works in new terminal windows.');
  assert.deepEqual(commandActs(installed), [{ act: 'general-command', do: 'remove' }]);
  assert.deepEqual(rowOf(installed, 'Agent prompt')?.end, { copy: { value: prompt, label: 'agent prompt' } });
  assert.deepEqual(copies(installed), [prompt]);
  assert.match(detailMarkup(installed, AT_REST), /aria-label="Copy agent prompt"/u);
  const rows = rowsOf(installed).map(row => row.label);
  assert.equal(rows.indexOf('Command line'), rows.indexOf('Open at login') + 1, rows.join(', '));

  const whole = prompt.replace('~/.local/bin/lifestream', '"$HOME/Library/Application Support/Lifestream/current/bin/lifestream"');
  const absent = mac({ state: 'absent', words: 'Not installed.', prompt: whole });
  assert.equal(rowOf(absent, 'Command line')?.line, 'Not installed.');
  assert.deepEqual(commandActs(absent), [{ act: 'general-command', do: 'install' }]);
  assert.deepEqual(copies(absent), [whole]);

  const other = 'Another program named lifestream is in ~/.local/bin. Lifestream left it alone.';
  const blocked = mac({ state: 'blocked', words: other, prompt: whole });
  assert.equal(rowOf(blocked, 'Command line')?.line, other);
  assert.equal(rowOf(blocked, 'Command line')?.end, null);
  assert.deepEqual(commandActs(blocked), []);

  const manual = 'lifestream is in ~/.local/bin, and Lifestream sets up PATH only for zsh, bash and fish: run it as /Users/person-a/.local/bin/lifestream, or add ~/.local/bin to your shell\'s PATH yourself.';
  const tcsh = mac({ state: 'installed', words: manual, prompt });
  assert.equal(rowOf(tcsh, 'Command line')?.line, manual);
  const tcshRows = rowsOf(tcsh).map(row => row.label);
  assert.deepEqual(tcshRows.slice(tcshRows.indexOf('Command line'), tcshRows.indexOf('Command line') + 2), ['Command line', 'Agent prompt']);
  assert.deepEqual(copies(tcsh), [prompt]);

  assert.equal(rowOf(mac(null), 'Command line'), undefined);
  assert.equal(rowOf(mac(null), 'Agent prompt'), undefined);
  const browser = at('settings/mac', { state: null });
  assert.equal(browser && rowOf(browser, 'Command line'), undefined);
});

test('P13: Recovery key: a row and one button for each state of the vault, each the app\'s window or its unlock, and no new vault on the page', () => {
  /** @param {unknown} vault */
  const recovery = vault => /** @type {Detail} */ (at('settings/recovery', { state: { ...HOST_STATE, vault: /** @type {any} */ (vault) } }));
  const SAVED = Date.UTC(2026, 10, 17, 15);
  const open = { host: { act: 'vault', do: 'open' } };
  const unlock = { host: { act: 'vault', do: 'unlock' } };
  for (const [state, words, label, does, done] of /** @type {const} */ ([
    ['none', 'No vault yet', 'Create…', open, false],
    ['unsaved', 'Not saved', 'Show a new key…', open, false],
    ['saved', 'Saved on 17 Nov 2026', 'Make a new key…', open, true],
    ['locked', 'Locked on this Mac', 'Allow', unlock, false],
    ['lost', 'Locked on this Mac', 'Unlock…', unlock, false],
  ])) {
    const page = recovery({ state, saved_ms: state === 'saved' ? SAVED : null });
    assert.deepEqual(rowsOf(page).map(row => row.label), ['Recovery key'], `${state}: another row beside Recovery key`);
    const end = /** @type {any} */ (rowOf(page, 'Recovery key')?.end);
    assert.deepEqual([end.words, end.done, end.acts.map((/** @type {any} */ act) => [act.label, act.do])], [words, done, [[label, does]]], state);
    assert.doesNotMatch(detailMarkup(page, AT_REST), /Start a new vault|may still open/u, state);
    assert.ok(actsOf(page).every(each => !each.flow && (!each.host || each.host.act !== 'vault' || ['open', 'unlock'].includes(each.host.do))),
      `${state}: an act beside open and unlock`);
  }
  assert.equal(/** @type {any} */ (rowOf(recovery({ state: 'saved', saved_ms: null }), 'Recovery key')?.end).words, 'Saved',
    'a saved key with no date read as dated');
  assert.equal(rowOf(recovery({ state: 'saved', saved_ms: null }), 'Recovery key')?.line,
    'Unlocks your saved sign-ins and keys if you move Lifestream to another Mac, or lose this one.', 'not encrypted');
  assert.equal(rowOf(recovery({ state: 'saved', saved_ms: null, keyed: true }), 'Recovery key')?.line,
    'Opens everything Lifestream keeps if you move Lifestream to another Mac, or lose this one.', 'an encrypted Lifestream');
  assert.deepEqual(rowsOf(recovery(null)), [], 'a vault the app has not said drew a row');
});
