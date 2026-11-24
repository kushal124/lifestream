import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLM_REPORT } from '../public/kit-gallery-llm.js';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { AI_PAGE, detailOf, formActs, OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { actOf } from '../public/ui/connectors/page.js';
import { actKey } from '../public/ui/connectors/pending.js';
import { AT_REST, doAttrs, landed, refusalAt, refusing, saidMarkup } from '../public/ui/connectors/view.js';
import { inPlaceLine } from '../public/ui/kit/states.js';
import { NOT_SENT, UNKNOWN } from '../public/lib/reach.js';
import { esc } from '../public/lib/html.js';

/** @typedef {import('../public/ui/connectors/dialog.js').Detail} Detail */
/** @typedef {import('../public/types.js').StreamsReport} StreamsReport */
/** @typedef {import('../public/types.js').ConnectorReport} ConnectorReport */

const MAC = { ...HOST_STATE, needs: [], vault: { state: /** @type {const} */ ('saved'), saved_ms: null } };

/**
 * @param {StreamsReport} report
 * @param {any} state
 * @param {string} id
 * @param {Partial<import('../public/ui/connectors/dialog.js').Opened>} [opened]
 */
const open = (report, state, id, opened = {}) => /** @type {Detail} */ (detailOf(report, state, id, { ...OPENED, ...opened }));
const every = () => [REPORT, LLM_REPORT].flatMap(report => report.connectors
  .filter(each => each.shown !== null).flatMap(connector => [HOST_STATE, null].map(state => ({ report, connector, state,
    detail: open(report, state, connector.id) }))));
/**
 * @param {StreamsReport} report
 * @param {string} id
 * @param {(connector: ConnectorReport) => ConnectorReport} change
 * @returns {StreamsReport}
 */
const changing = (report, id, change) => ({ ...report, connectors: report.connectors.map(each => each.id === id ? change(each) : each) });
/**
 * @param {Detail} detail
 * @param {string} part
 * @param {string} label
 */
const rowIn = (detail, part, label) => detail.panels.find(panel => panel.label === part)?.rows.find(row => row.label === label);

/**
 * @param {StreamsReport} report
 * @param {any} state
 * @param {string} id
 * @returns {Detail[]}
 */
const pagesOf = (report, state, id) => {
  const detail = open(report, state, id);
  const pushed = detail.panels.flatMap(panel => panel.rows).flatMap(row => {
    const page = /** @type {any} */ (row.go?.do)?.page;
    return typeof page === 'string' && page.startsWith(AI_PAGE) ? [open(report, state, id, { pages: [page] })] : [];
  });
  return [detail, ...pushed];
};

test('R1: a row never repeats its label as its line; no info mark on a row or a heading, on the page or a page it pushes', () => {
  for (const { report, connector, state } of every()) {
    for (const each of pagesOf(report, state, connector.id)) {
      for (const row of each.panels.flatMap(panel => panel.rows)) assert.notEqual(row.line, row.label, `${connector.id} › ${row.label}`);
      assert.ok(!detailMarkup(each, AT_REST).includes('ck-tip__mark'), `${connector.id} ${each.name}: no info mark`);
    }
  }
  const chatgpt = open(LLM_REPORT, HOST_STATE, 'chatgpt');
  assert.equal(rowIn(chatgpt, 'Settings', 'Check every')?.line, '', 'Check every says it all');
  assert.match(rowIn(chatgpt, 'Settings', 'Check now')?.line ?? '', /^Checked /u);
  assert.ok(rowIn(chatgpt, 'History', 'Catch up every'), 'Catch up every under History');
  const photos = open(LLM_REPORT, HOST_STATE, 'whatsapp', { pages: [`${AI_PAGE}llm.photos`] }).panels[0].rows[0];
  assert.ok(photos?.does && photos.line && photos.mark, 'on its page, what it does over what it is now');
});

test('R2: every source keeps its tile, its state the shape before its line', () => {
  for (const { connector, detail } of every()) {
    for (const row of detail.panels.find(panel => panel.label === 'Comes from')?.rows ?? []) {
      if (row.go) continue;
      assert.ok(row.lead && ('icon' in row.lead || 'app' in row.lead), `${connector.id} › ${row.label}: a tile`);
    }
  }
  const screen = /** @type {ConnectorReport} */ (REPORT.connectors.find(each => each.id === 'screen'));
  const quiet = screen.copies.find(copy => copy.health.state === 'quiet');
  assert.ok(quiet, 'the fixture holds a quiet copy');
  const row = rowIn(open(REPORT, HOST_STATE, 'screen'), 'Comes from', quiet.name);
  assert.deepEqual([row?.lead, row?.signal], [{ icon: 'work-mac' }, 'idle']);
});

test('R3, R4: the account and the copy it is read by are one row, with Change; its form is never rows of Comes from', () => {
  for (const { report, connector, detail } of every()) {
    const labels = report.connectors.find(each => each.id === connector.id)?.members.filter(member => member.panel === 'account')
      .map(member => member.label) ?? [];
    const comes = detail.panels.find(panel => panel.label === 'Comes from')?.rows.map(row => row.label) ?? [];
    for (const label of labels) assert.ok(!comes.includes(label), `${connector.id}: ${label} is no row of Comes from`);
  }
  const gmail = /** @type {ConnectorReport} */ (REPORT.connectors.find(each => each.id === 'gmail'));
  const rows = open(REPORT, HOST_STATE, 'gmail').panels.find(panel => panel.label === 'Comes from')?.rows ?? [];
  assert.deepEqual(rows.filter(row => row.label !== 'Google Takeout' && row.label !== 'Export').map(row => [row.label, row.line]),
    [[gmail.account?.name, gmail.copies[0].line]]);
  const end = rows[0].end;
  assert.ok(end && 'acts' in end && end.acts?.[0]?.label === 'Change', 'Change at its end');
  const whoop = open(REPORT, HOST_STATE, 'whoop').panels.find(panel => panel.label === 'Comes from')?.rows ?? [];
  assert.equal(whoop.length, 1);
  const act = whoop[0].end && 'acts' in whoop[0].end ? whoop[0].end.acts?.[0] : null;
  assert.equal(act?.label, 'Change');
  const changed = changing(REPORT, 'gmail', connector => ({ ...connector,
    account: connector.account && { ...connector.account, name: 'person-b@example.com', copy: null } }));
  const apart = open(changed, HOST_STATE, 'gmail').panels.find(panel => panel.label === 'Comes from')?.rows.map(row => row.label);
  assert.deepEqual(apart?.slice(0, 2), ['person-b@example.com', gmail.copies[0].name]);
  const many = changing(REPORT, 'gmail', connector => ({ ...connector, copies: [connector.copies[0], ...Array.from({ length: 6 },
    (_, at) => ({ ...connector.copies[0], id: `gmail:person-a@example.com:other-${at}`, name: `Gmail ${at + 2}` }))] }));
  const page = open(many, HOST_STATE, 'gmail', { pages: ['copies'] }).panels[0].rows;
  const first = page[0];
  assert.deepEqual([page.length, first.label, first.end && 'acts' in first.end ? first.end.acts?.[0]?.label : null],
    [7, gmail.account?.name, 'Change']);
});

test('R3: a stream not set up asks its sign-in as its step, opening its form; once set up its page is Account, Save', () => {
  const fresh = changing(REPORT, 'whoop', connector => ({ ...connector, set_up: false, account: null, copies: [],
    ways: [{ road: 'poll', ready: false, requirements: [{ kind: 'form', met: false, words: 'Sign in to WHOOP',
      line: 'Your WHOOP email and password.', act: { do: 'set', label: 'Sign in', member: 'email' } }] }] }));
  const asked = open(fresh, MAC, 'whoop');
  assert.deepEqual(asked.panels, [], 'no section before it is set up');
  const step = asked.connect?.ways[0]?.rows[0];
  assert.deepEqual([step?.name, step?.line, step?.mark, step?.act?.label, step?.act?.do],
    ['Sign in to WHOOP', 'Your WHOOP email and password.', 'here', 'Sign in', { page: 'form' }]);
  assert.equal(open(fresh, null, 'whoop').connect?.ways[0]?.rows[0]?.act, null, 'no act in a browser');
  const held = changing(REPORT, 'whoop', connector => ({ ...connector,
    members: connector.members.map(member => member.control === 'secret' ? { ...member, held: true } : member) }));
  const whoop = /** @type {ConnectorReport} */ (held.connectors.find(each => each.id === 'whoop'));
  const typed = { ...OPENED, pages: ['form'], fields: { 'whoop.email': 'person-b@example.com' } };
  const page = open(held, MAC, 'whoop', typed);
  assert.deepEqual([page.name, page.foot?.end.map(act => [act.label, act.disabled])], ['Account', [['Save', false]]]);
  assert.match(page.signin?.fields.find(field => field.key === 'whoop.password')?.placeholder ?? '', /^Kept\./u);
  assert.deepEqual(formActs(whoop, typed), [{ act: 'setting', connector: 'whoop', member: 'email', value: 'person-b@example.com' }]);
  const off = changing(held, 'whoop', connector => ({ ...connector, set_up: false }));
  const offWhoop = /** @type {ConnectorReport} */ (off.connectors.find(each => each.id === 'whoop'));
  assert.equal(open(off, MAC, 'whoop', typed).name, 'Account');
  assert.ok(!formActs(offWhoop, typed).some(act => act.act === 'turn'), 'nothing turned on');
  const unheld = open(REPORT, MAC, 'whoop', typed);
  assert.deepEqual([unheld.signin?.fields.find(field => field.key === 'whoop.password')?.placeholder.startsWith('Kept'),
    unheld.foot?.end[0]?.disabled], [false, true]);
  const both = { ...typed, fields: { ...typed.fields, 'whoop.password': 'synthetic-pass' } };
  assert.deepEqual(formActs(/** @type {ConnectorReport} */ (REPORT.connectors.find(each => each.id === 'whoop')), both).map(act => act.act), ['setting', 'seal']);
});

test('R5: one of the home\'s own is titled by what its switch does, never the dialog\'s name', () => {
  for (const { connector, detail } of every().filter(each => each.connector.shown === 'home')) {
    const own = detail.panels.find(panel => panel.label === 'Settings')?.rows[0];
    assert.ok(own && own.label !== detail.name && own.line && own.line !== connector.records, `${connector.id}: ${own?.label}`);
  }
});

test('R6: no value at a row\'s end is cut, and a list says how many it holds', () => {
  for (const { report, connector, state } of every()) {
    for (const each of pagesOf(report, state, connector.id)) {
      const markup = detailMarkup(each, AT_REST);
      for (const [, value] of markup.matchAll(/class="(?:ck-srow__value|ck-svalue)">(?:<[^>]+>)*([^<]*)</gu)) {
        assert.ok(!value.includes('…'), `${connector.id} ${each.name}: "${value}"`);
      }
    }
  }
  const calendars = changing(REPORT, 'google-calendar', connector => ({ ...connector, set_up: true, members: connector.members.map(member =>
    member.key === 'calendars' ? { ...member, value: ['Work', 'Holidays', 'Family'], words: '3' } : member) }));
  assert.match(detailMarkup(open(calendars, HOST_STATE, 'google-calendar'), AT_REST), /<span class="ck-srow__value">3<\/span>/u);
  const quiet = rowIn(open(LLM_REPORT, HOST_STATE, 'whatsapp'), 'Settings', 'Quiet groups');
  assert.match(quiet?.go?.value ?? '', /^\d[\d,]*$/u);
});

test('R7: History\'s state is one SettingRow: how far back, its line led by its mark, Pause or Resume at its end', () => {
  const chatgpt = /** @type {ConnectorReport} */ (LLM_REPORT.connectors.find(each => each.id === 'chatgpt'));
  const status = open(LLM_REPORT, HOST_STATE, 'chatgpt').panels.find(panel => panel.label === 'History')?.rows[0];
  const reading = status?.end && 'acts' in status.end ? status.end.acts?.map(act => act.label) : [];
  assert.deepEqual([status?.label, status?.mark, status?.line.startsWith('Reading'), reading],
    [chatgpt.history?.words, { status: 'running' }, true, ['Pause']]);
  const held = { ...changing(LLM_REPORT, 'whatsapp', connector => ({ ...connector,
    pauses: [{ scope: 'history', by: 'person', reason: 'paused by hand', at_ms: LLM_REPORT.at_ms }] })),
  paused: [{ target: 'pause:whatsapp:history', by: 'person', reason: 'paused by hand', at_ms: LLM_REPORT.at_ms, holds: null,
    title: 'Paused: WhatsApp’s history', line: 'paused by hand · since 09:00' }] };
  const whatsapp = /** @type {ConnectorReport} */ (held.connectors.find(each => each.id === 'whatsapp'));
  const row = open(/** @type {StreamsReport} */ (held), HOST_STATE, 'whatsapp').panels.find(panel => panel.label === 'History')?.rows[0];
  const end = row?.end && 'acts' in row.end ? row.end.acts?.map(act => act.label) : [];
  assert.deepEqual([row?.label, row?.mark, row?.line.startsWith('Paused by hand · since 09:00'), row?.line.includes('Paused:'), end],
    [whatsapp.history?.words, { status: 'paused' }, true, false, ['Resume']]);
  const markup = detailMarkup(open(/** @type {StreamsReport} */ (held), HOST_STATE, 'whatsapp'), AT_REST);
  assert.match(markup, new RegExp(`<span class="ck-srow__label">${esc(whatsapp.history?.words ?? '')}</span>.*?<span class="ck-srow__line"><span class="ck-srow__mark"`, 'su'));
});

test('R2 drawn: a source whose state is said keeps its line, its photo count never taken into the head', () => {
  const photos = /** @type {ConnectorReport} */ (REPORT.connectors.find(each => each.copies.some(copy => /photos? · last /u.test(copy.line))));
  assert.ok(photos, 'the fixture holds a source saying its photos');
  const at = photos.copies.findIndex(copy => /photos? · last /u.test(copy.line));
  const quiet = changing(REPORT, photos.id, connector => ({ ...connector, copies: connector.copies.map((copy, index) => index === at
    ? { ...copy, health: { ...copy.health, state: 'quiet' } } : copy) }));
  const detail = open(quiet, HOST_STATE, photos.id);
  const row = detail.panels.flatMap(panel => panel.rows).find(each => each.signal && /photos? · last /u.test(each.line));
  assert.ok(row, 'its line kept, its shape before it');
  assert.ok(!detail.line?.includes('Last added') || photos.copies.filter(copy => /photos? · last /u.test(copy.line)).length > 1);
  assert.match(detailMarkup(detail, AT_REST), /class="ck-srow__line"><svg class="ck-signal__shape"[^]*?<\/svg>\d[\d,]*\sphotos? · last /u);
  for (const { detail: each } of every()) {
    for (const source of each.panels.find(panel => panel.label === 'Comes from')?.rows ?? []) {
      if (source.dim) assert.ok(source.end === null || !('toggle' in source.end) || !source.end.toggle.on, `${each.id} › ${source.label}: dim while on`);
    }
  }
});

test('R8: no callout asks what To connect asks; a head never says ". ·", nor what it reads', () => {
  for (const { connector, detail } of every()) {
    const asked = detail.connect?.ways.flatMap(way => way.rows.map(row => row.name)) ?? [];
    assert.ok(!detail.callout || !asked.includes(detail.callout.title), `${connector.id}: asked twice`);
    assert.ok(!/\.\s·/u.test(detail.line ?? ''), `${connector.id}: "${detail.line}"`);
  }
  const lasting = changing(REPORT, 'gmail', connector => ({ ...connector, records: 'Your last 100 emails.',
    figure: connector.figure && { ...connector.figure, today: 0, week: [0, 0, 0, 0, 0, 0, 0] } }));
  const gmail = open(lasting, HOST_STATE, 'gmail');
  assert.deepEqual([gmail.line?.includes('Your last 100 emails.'), gmail.figure !== null], [false, true]);
});

test('U1: a stream\'s Upload is the host\'s, of that stream; its refusal said in its To connect row', () => {
  const own = REPORT.connectors.find(each => each.shown === 'stream' && each.export === null);
  assert.ok(own);
  const upload = { do: /** @type {const} */ ('upload'), label: 'Upload' };
  const pressed = actOf(upload, own, HOST_STATE);
  assert.deepEqual(pressed, { label: 'Upload', do: { host: { act: 'upload', connector: own.id } } });
  assert.equal(actOf(upload, own, null), null, 'none in a browser');
  assert.equal(actKey({ act: 'upload', connector: own.id }), `upload:${own.id}`);
  const words = 'Lifestream could not copy that file.';
  const view = { ...AT_REST, error: words, at: doAttrs(/** @type {any} */ (pressed))['data-cn-do'] };
  assert.equal(refusalAt(/** @type {any} */ (pressed), view), words);
  assert.equal(refusalAt({ label: 'Upload', do: { host: { act: 'upload', connector: 'another-stream' } } }, view), '');
});

test('U2: a stream an import feeds: its Comes from row the kind\'s, Show opening its window, in a browser too', () => {
  const own = REPORT.connectors.find(each => each.shown === 'stream' && each.set_up);
  assert.ok(own);
  const fed = { import: 'google-takeout', name: 'Google Takeout', icon: 'archive', opens: false, line: 'Brought in 1 Nov' };
  const report = changing(REPORT, own.id, connector => ({ ...connector, export: fed }));
  for (const state of [HOST_STATE, null]) {
    const comes = open(report, state, own.id).panels.find(panel => panel.label === 'Comes from');
    const row = comes?.rows.find(each => each.label === 'Google Takeout');
    assert.deepEqual([row?.lead, row?.line, /** @type {any} */ (row?.end)?.acts], [{ icon: 'archive' }, 'Brought in 1 Nov',
      [{ label: 'Show', variant: 'plain', do: { open: 'import:google-takeout' } }]], String(state));
    assert.ok(!comes?.rows.some(each => /** @type {any} */ (each.end)?.acts?.some((/** @type {any} */ act) =>
      act.label === 'Get export' || act.label === 'Upload')), 'no Get export, no Upload');
  }
  for (const state of [HOST_STATE, null]) {
    assert.deepEqual(actOf({ do: 'import', label: 'Show', kind: 'google-takeout' }, own, state),
      { label: 'Show', do: { open: 'import:google-takeout' } });
  }
});

test('U3: a refusal is said over the report read after its act, and goes at the next report; a read that fails keeps it', () => {
  const words = 'Update Lifestream on this Mac to do Allow.';
  const pressed = { label: 'Allow', do: { host: { act: 'allow', grants: ['store:browser-a'] } } };
  /** @type {import('../public/ui/connectors/view.js').View} */
  const view = { ...AT_REST, busy: new Set() };
  const after = { ...REPORT };
  landed(view, after);
  refusing(view, { said: 'refused', words }, doAttrs(pressed)['data-cn-do'], pressed.label, after);
  assert.equal(saidMarkup(view).includes(words), true, 'the refusal is not said');
  assert.equal(saidMarkup(view), inPlaceLine(words, { said: 'refused' }), 'the kit\'s in-place line');
  assert.doesNotMatch(saidMarkup(view), /Try again/u, 'a refusal offered again');
  landed(view, after);
  assert.equal(view.error, words);
  landed(view, { ...REPORT });
  assert.deepEqual([view.error, view.at, saidMarkup(view)], ['', '', '']);
  refusing(view, { said: 'not-sent', words: 'The Mac\'s own words.' }, doAttrs(pressed)['data-cn-do'], pressed.label, after);
  const unsent = saidMarkup(view);
  assert.match(unsent, new RegExp(`>${NOT_SENT}<`, 'u'));
  assert.doesNotMatch(unsent, /The Mac/u);
  const again = /** @type {RegExpMatchArray} */ (unsent.match(/<button[^>]*>Try again<\/button>/u));
  assert.ok(again, unsent);
  assert.ok(again[0].includes(`data-cn-do="${esc(doAttrs(pressed)['data-cn-do'])}"`), again[0]);
  assert.ok(again[0].includes('data-cn-label="Allow"'), again[0]);
  refusing(view, { said: 'unknown', words: '' }, doAttrs(pressed)['data-cn-do'], pressed.label, after);
  assert.match(saidMarkup(view), new RegExp(esc(UNKNOWN), 'u'));
  assert.doesNotMatch(saidMarkup(view), /Try again|<button/u, 'an outcome not known offered again');
  assert.equal(refusalAt(pressed, view), UNKNOWN);
});

test('U4: a week with nothing in it says "No <nouns> this week", never "added"', () => {
  const detail = REPORT.connectors.map(each => open(REPORT, HOST_STATE, each.id)).find(each => each.figure?.noun);
  assert.ok(detail?.figure, 'the fixture has a stream with a week');
  const empty = { ...detail, figure: { ...detail.figure, today: 0, week: [0, 0, 0, 0, 0, 0, 0] } };
  const drawn = detailMarkup(empty, AT_REST);
  const noun = /** @type {[string, string]} */ (detail.figure.noun)[1];
  assert.match(drawn, new RegExp(`<p class="ck-none__text[^"]*">No ${noun} this week`, 'u'));
  assert.equal(/added this week/u.test(drawn), false);
});
