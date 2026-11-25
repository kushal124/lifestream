import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASKED, BROKEN, BROUGHT, BROUGHT_ALONE, DONE, holding, IMPORTS_STATE, importsReport, KEPT, NEEDS, NO_ROOM, OLDER,
  READING, REFUSED_FILES, REFUSED_WHOLE, SCENES, SENDING_FILES, SPOTIFY, TAKEOUT,
} from '../public/kit-gallery-imports.js';
import { HOST_STATE } from '../public/kit-gallery-report.js';
import { endOf, needsOf } from '../public/ui/connectors/page.js';
import { importsLastInEachView, wholePage as pageOf } from './stand-ins/whole-page.mjs';
import { detailOf, OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { AT_REST, bodyMarkup } from '../public/ui/connectors/view.js';
import { bannerOf, IMPORTS_SEG, otherKey } from '../public/ui/connectors/imports.js';
import { esc } from '../public/lib/html.js';
import { icon } from '../public/ui/kit/icon.js';
import { openDoor } from '../lib/door.mjs';
import { createViewer } from '../server.mjs';
import { openChrome } from '../tools/chrome.mjs';
import { hostScript } from './stand-ins/onboarding-home.mjs';
import { until } from './until.mjs';

/** @typedef {import('../public/types.js').StreamsReport} StreamsReport */
/** @typedef {import('../public/types.js').ImportFileReport} ImportFileReport */
/** @typedef {import('../public/lib/host.js').HostState} HostState */
const NONE = { query: '', place: /** @type {''} */ ('') };
const TAKEOUT_ID = 'import:google-takeout';
const SPOTIFY_ID = 'import:spotify';
const { guide: GUIDE_LABEL, held: YOURS_LABEL } = TAKEOUT.titles;
const ON_MAC = TAKEOUT.drop.away;
/** @param {import('../public/types.js').ImportHeld} held */
const reworded = held => importsReport({ takeout: { ...holding(held.line, held),
  titles: { reads: 'Read today', guide: 'Getting it', held: 'Yours' }, drop: { ...TAKEOUT.drop, choose: 'Pick a file', away: 'On the Mac only' } } });
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.build', 'e2e', 'imports');
const seen = { acts: /** @type {Record<string, unknown[]>} */ ({}), shots: /** @type {object[]} */ ([]),
  window: { door: /** @type {unknown[]} */ ([]), host: /** @type {unknown[]} */ ([]) } };

/** @param {ReturnType<typeof pageOf>} page */
const rows = page => page.sections.flatMap(section => section.faces);
/** @param {ReturnType<typeof pageOf>} page @param {string} id */
const row = (page, id) => rows(page).find(face => face.id === id);
/** @param {string} name */
const scene = name => {
  const found = SCENES.find(each => each.name.startsWith(name));
  assert.ok(found, name);
  return found;
};
/**
 * @param {StreamsReport} report
 * @param {HostState | null} state
 * @param {string} [id]
 * @param {Partial<import('../public/ui/connectors/dialog.js').Opened>} [opened]
 */
const windowFor = (report, state, id = TAKEOUT_ID, opened = {}) => {
  const detail = detailOf(report, state, id, { ...OPENED, ...opened });
  assert.ok(detail?.import);
  return /** @type {NonNullable<typeof detail> & { import: NonNullable<NonNullable<typeof detail>['import']> }} */ (detail);
};
/** @param {import('../public/kit-gallery-imports.js').Scene} at */
const windowOf = at => windowFor(at.report, at.state, `import:${at.kind}`);
/** @param {string} markup */
const actsIn = markup => [...markup.matchAll(/(?:data-cn-do|data-value)="([^"]*)"/gu)]
  .map(match => JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&#39;', '\'').replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>').replaceAll('&amp;', '&')))
  .filter(each => each && typeof each === 'object');
/** @param {string} markup */
const hostActs = markup => actsIn(markup).filter(each => 'host' in each).map(each => each.host);
/** @param {import('../public/ui/connectors/dialog.js').Panel | null | undefined} panel */
const said = panel => panel?.rows.map(each => [each.label, each.line, /** @type {any} */ (each.end)?.words ?? null]);
/** @param {import('../public/ui/connectors/dialog.js').PanelRow | undefined} at */
const endActs = at => /** @type {any} */ (at?.end)?.acts?.map((/** @type {any} */ act) => [act.label, act.do]) ?? [];
/** @param {ImportFileReport} file */
const fileSaid = file => [file.name, '', [file.words, file.line].filter(Boolean).join(' · ')];
/**
 * @param {string} markup
 * @param {string} words
 */
const times = (markup, words) => markup.split(esc(words)).length - 1;

test('I1: Imports the last section, each kind\'s row first; the streams an import alone brings in their kinds, opening it', () => {
  for (const at of SCENES) {
    const page = pageOf(at.report, IMPORTS_STATE, NONE);
    const imports = page.sections.filter(section => section.key === 'imports');
    assert.ok(imports.every(section => section.name === 'Imports') && importsLastInEachView(at.report, IMPORTS_STATE, NONE), at.name);
    assert.deepEqual(imports.flatMap(section => section.faces).filter(face => face.id.startsWith('import:')).map(face => face.id).sort(),
      at.report.imports.map(kind => `import:${kind.kind}`).sort(), at.name);
    for (const id of BROUGHT_ALONE) assert.equal(row(page, id)?.opens, TAKEOUT_ID, `${at.name}: ${id}`);
  }
  const fresh = pageOf(importsReport(), IMPORTS_STATE, NONE);
  assert.deepEqual([TAKEOUT_ID, SPOTIFY_ID].map(id => [row(fresh, id)?.opens, row(fresh, id)?.set_up]), [[TAKEOUT_ID, false], [SPOTIFY_ID, false]]);
  assert.match(bodyMarkup(fresh, AT_REST, ''), new RegExp(`data-cn-open="${TAKEOUT_ID}"`, 'u'));
});

test('I2: a kind\'s row is its line and health as the home sends them; what it reads before anything is held', () => {
  for (const at of SCENES) {
    const face = row(pageOf(at.report, IMPORTS_STATE, NONE), TAKEOUT_ID);
    const kind = at.report.imports[0];
    const held = kind.held.length > 0 || kind.coming.length > 0;
    assert.deepEqual([face?.state, face?.name, face?.icon, face?.set_up], [kind.health.state, kind.name, kind.icon, held], at.name);
    if (held) assert.equal(face?.line, kind.line, at.name);
    const end = face && endOf(face);
    if (end && held && !['ok', 'syncing', 'quiet'].includes(kind.health.state)) assert.ok('word' in end, `${at.name}: its state word`);
  }
  assert.equal(row(pageOf(importsReport(), IMPORTS_STATE, NONE), TAKEOUT_ID)?.line,
    'Calendar, Contacts, Google Photos, Mail and My Activity', 'what it reads while nothing is held');
  assert.equal(row(pageOf(importsReport({ takeout: holding(BROUGHT, DONE) }), IMPORTS_STATE, NONE), TAKEOUT_ID)?.line, BROUGHT);
});

test('I3: the window\'s shape: what it reads in the head, a file you download and the provider\'s wait first, the steps with their one button, the drop the last step, Your imports', () => {
  const fresh = windowOf(scene('Nothing yet'));
  assert.deepEqual([fresh.name, fresh.line, fresh.foot, fresh.icon],
    ['Google Takeout', TAKEOUT.products.map(product => product.name).join(' · '), null, 'archive']);
  assert.ok(TAKEOUT.wait, 'the fixture says Google\'s wait');
  assert.deepEqual(fresh.import.chips, [{ label: 'A file you download', glyph: 'file' }, { label: TAKEOUT.wait, glyph: 'time' }]);
  assert.deepEqual([fresh.import.guide.label, fresh.import.guide.steps.map(step => [step.title, step.words])], [GUIDE_LABEL,
    TAKEOUT.guide.map(step => [step.title ?? '', step.words])]);
  assert.deepEqual(fresh.import.guide.steps.map(step => step.open && [step.open.label, step.open.out, step.open.do]), [
    ['Open Google Takeout', true, { host: { act: 'open', what: 'site', url: 'https://takeout.google.com/' } }], null, null]);
  assert.equal(fresh.import.yours, null, 'nothing coming or held: no Your imports');
  const markup = detailMarkup(fresh, AT_REST);
  assert.doesNotMatch(markup, /ck-dialog__act|ck-dialog__foot|role="switch"/u, 'no button in the head, no switch, no foot');
  const steps = markup.slice(markup.indexOf(`<ol class="ck-numbered" aria-label="${esc(GUIDE_LABEL)}">`));
  assert.ok(steps.length < markup.length, 'the steps under the guide\'s label');
  const marks = [...steps.slice(0, steps.indexOf('</ol>')).matchAll(/<li class="ck-numbered__step is-([a-z]+)">/gu)].map(match => match[1]);
  assert.deepEqual(marks, [...TAKEOUT.guide.map(() => 'idle'), 'here'], 'the drop the last step, the one due');
  assert.ok(steps.lastIndexOf('is-here') < steps.indexOf(esc(TAKEOUT.drop.words)), 'the drop zone in the last step');
  assert.match(markup, /Open Google Takeout<\/span><svg/su, 'the button ends in ↗');
  assert.deepEqual(windowFor(importsReport(), null).import.guide.steps.map(step => [step.words, step.open && [step.open.label,
    step.open.out, step.open.do]]), TAKEOUT.guide.map(step => [step.words, step.open
    ? [step.open.label, true, { link: step.open.url }] : null]));
  assert.match(detailMarkup(windowFor(importsReport(), null), AT_REST),
    /<a [^>]*href="https:\/\/takeout\.google\.com\/"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>.*?Open Google Takeout<\/span><svg/su,
    'in a browser a link in a new tab, ending in ↗');
  const titled = windowFor(reworded(READING), IMPORTS_STATE).import;
  assert.deepEqual([titled.guide.label, titled.yours?.label], ['Getting it', 'Yours']);
  assert.equal(windowOf(scene('A kind of one product')).line, SPOTIFY.reads);
  const drawn = detailMarkup(windowOf(scene('Checking and sending')), AT_REST);
  const at = ['A file you download', GUIDE_LABEL, TAKEOUT.drop.words, YOURS_LABEL].map(words => drawn.indexOf(esc(words)));
  assert.ok(at.every(index => index >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in order');
});

test('I4: the drop zone: the kind\'s words, Choose… on this Mac, "On your Mac" in a browser', () => {
  const here = windowOf(scene('Nothing yet')).import.drop;
  assert.deepEqual([here.words, here.line, here.elsewhere, here.choose?.label, here.choose?.do], [TAKEOUT.drop.words,
    TAKEOUT.drop.line, '', 'Choose…', { host: { act: 'import', do: 'choose', kind: 'google-takeout' } }]);
  assert.match(detailMarkup(windowOf(scene('Nothing yet')), AT_REST),
    /<section class="ck-drop" data-ck-drop>[^]*?<p class="ck-drop__words mac-body">Drop your Google Takeout here<\/p>[^]*?Choose…[^]*?<\/section>/u);
  const browser = windowFor(importsReport(), null);
  assert.deepEqual([browser.import.drop.choose, browser.import.drop.elsewhere], [null, ON_MAC]);
  assert.match(detailMarkup(browser, AT_REST), /<section class="ck-drop ck-drop--still" data-ck-drop>.*On your Mac/su);
  assert.equal(windowFor(reworded(READING), IMPORTS_STATE).import.drop.choose?.label, 'Pick a file');
  assert.equal(windowFor(reworded(READING), null).import.drop.elsewhere, 'On the Mac only');
});

test('I5: the files coming, in the home\'s words; Choose again and Remove only where this Mac lost or refused one', () => {
  const sending = windowOf(scene('Checking and sending')).import.yours;
  assert.equal(sending?.label, YOURS_LABEL);
  assert.deepEqual(said(sending?.coming), SENDING_FILES.map(fileSaid));
  assert.ok(sending?.coming?.rows.every(each => endActs(each).length === 0), 'nothing to press while it checks or sends');
  const refused = windowOf(scene('Refused or not found')).import.yours?.coming?.rows ?? [];
  assert.deepEqual(refused.map(each => [each.label, endActs(each)]), [
    ['notes.zip', [['Remove', { host: { act: 'import', do: 'forget', kind: 'google-takeout', file: 'file-04' } }]]],
    ['takeout-20261003T080000Z-1-001.zip', [
      ['Choose again', { host: { act: 'import', do: 'again', kind: 'google-takeout', file: 'file-05' } }],
      ['Remove', { host: { act: 'import', do: 'forget', kind: 'google-takeout', file: 'file-05' } }]]],
    ['takeout-20261027T080000Z-1-001.zip', []]]);
  assert.deepEqual(said(windowOf(scene('Refused or not found')).import.yours?.coming), REFUSED_FILES.map(fileSaid));
  const browser = windowFor(importsReport({ takeout: { coming: REFUSED_FILES } }), null).import.yours?.coming?.rows ?? [];
  assert.deepEqual(browser.map(each => [each.label, endActs(each)]), REFUSED_FILES.map(file => [file.name, []]));
});

test('I6: whose it is, asked as the home asks it: its accounts, Another… typed, each answer the home\'s choose', () => {
  const asked = windowOf(scene('Whose it is')).import;
  const [part] = asked.yours?.parts ?? [];
  assert.equal(part.callout, null, 'its question, never a callout too');
  assert.deepEqual(asked.needs, [], 'its need said by its question alone');
  const need = `import:${ASKED.id}:whose`;
  const [question, other] = part.question?.rows ?? [];
  assert.equal(question.label, ASKED.ask?.words);
  const menu = /** @type {any} */ (question.end).menu;
  assert.deepEqual(menu.choices.map((/** @type {any} */ each) => [each.words, each.do]),
    (ASKED.ask?.choices ?? []).map(account => [account, { home: { need, do: 'choose', account } }]));
  assert.equal(other.label, ASKED.ask?.another);
  assert.deepEqual(endActs(other).map(([label]) => label), ['Choose']);
  assert.equal(/** @type {any} */ (other.end).acts[0].disabled, true);
  const typed = windowFor(scene('Whose it is').report, IMPORTS_STATE, TAKEOUT_ID,
    { fields: { [otherKey(ASKED.id)]: ' person-c@example.com ' } }).import.yours?.parts[0].question?.rows[1];
  assert.deepEqual(/** @type {any} */ (typed?.end).acts.map((/** @type {any} */ act) => [act.disabled, act.do]),
    [[false, { home: { need, do: 'choose', account: 'person-c@example.com' } }]]);
  const asks = /** @type {NonNullable<typeof ASKED.ask>} */ (ASKED.ask);
  const renamed = windowFor(reworded({ ...ASKED, ask: { ...asks, choose: 'Pick', another: 'Someone else…' } }), IMPORTS_STATE)
    .import.yours?.parts[0].question?.rows[1];
  assert.deepEqual([renamed?.label, endActs(renamed).map(([label]) => label)], ['Someone else…', ['Pick']]);
  const alone = windowFor(importsReport({ takeout: holding(ASKED.line, { ...ASKED, ask: { ...asks, choices: ['person-a'], other: false } }) }),
    null).import.yours?.parts[0].question;
  assert.equal(alone?.rows.length, 1);
  assert.deepEqual(/** @type {any} */ (alone?.rows[0].end).menu.choices[0].do, { home: { need, do: 'choose', account: 'person-a' } });
  assert.deepEqual(part.panel.rows.slice(1).map(endActs), ASKED.files.map(file => file.acts.map(act => [act.label,
    { home: { need: 'need' in act ? act.need : '', do: 'let-go' } }])));
  assert.ok(ASKED.files.every(file => file.acts.length === 1), 'the stand-in offers Let go on its file');
  const markup = detailMarkup(windowFor(scene('Whose it is').report, null), AT_REST);
  assert.doesNotMatch(markup, /ck-callout/u, 'its question, never a callout');
  assert.ok(!actsIn(markup).some(each => 'open' in each), 'no Choose opening this window');
});

test('I7: each import in the home\'s words: its files, Let go, Skip it, its products, Open a day, the note once in', () => {
  for (const [name, held] of /** @type {const} */ ([['Bringing in', [READING]], ['Waiting for room', [NO_ROOM]],
    ['A read that broke', [BROKEN]], ['In, files kept', [KEPT]], ['In:', [DONE]], ['Two imports', [DONE, OLDER]]])) {
    const yours = windowOf(scene(name)).import.yours;
    assert.equal(yours?.label, YOURS_LABEL, name);
    assert.deepEqual(yours?.parts.map(part => said(part.panel)), held.map(each => [[each.name, each.line, null],
      ...each.files.map(fileSaid), ...each.products.map(product => [product.line, '', null])]), name);
    assert.deepEqual(yours?.parts.map(part => part.panel.rows[0].lead), held.map(each => ({ look: each.health.state })), name);
    assert.deepEqual(yours?.parts.map(part => part.open && [part.open.label, part.open.do]), held.map(each => each.open_day
      ? [each.open, { to: { view: 'days', patch: { on: each.open_day } } }] : null), name);
    assert.deepEqual(yours?.parts.map(part => part.panel.note), held.map(each => each.downloaded ?? ''), `${name}: the home's note, verbatim`);
  }
  const kept = windowOf(scene('In, files kept'));
  const [part] = kept.import.yours?.parts ?? [];
  assert.deepEqual(endActs(part.panel.rows[1]), [['Let go', { home: { need: KEPT.files[0].acts[0].need, do: 'let-go' } }]]);
  assert.deepEqual([part.callout?.title, part.callout?.acts.map(act => [act.label, act.do])], [KEPT.health.words,
    [['Skip it', { home: { need: NEEDS.kept.id, do: 'skip' } }]]]);
  assert.deepEqual(kept.import.needs, [], 'its need said in its callout alone');
  assert.equal(times(detailMarkup(kept, AT_REST), KEPT.health.words), 1);
  assert.equal(part.panel.note, '', 'the home sends no note: none');
  const broken = windowOf(scene('A read that broke'));
  assert.deepEqual([broken.import.yours?.parts[0].callout?.kind, broken.import.needs], ['warning', []]);
  assert.equal(times(detailMarkup(broken, AT_REST), BROKEN.health.words), 1);
  assert.deepEqual(windowOf(scene('Waiting for room')).import.yours?.parts[0].callout?.title, NO_ROOM.health.words);
  const done = windowOf(scene('In:')).import.yours?.parts[0];
  assert.deepEqual([done?.callout, done?.panel.note], [null, 'You can delete the file you downloaded.']);
  assert.equal(windowOf(scene('Bringing in')).import.yours?.parts[0].panel.note, '', 'not before it is in');
  const own = windowFor(reworded({ ...DONE, open: 'See the day', downloaded: 'Your download may go.' }), IMPORTS_STATE).import.yours?.parts[0];
  assert.deepEqual([own?.open?.label, own?.panel.note], ['See the day', 'Your download may go.']);
  const notice = /** @type {NonNullable<typeof DONE.notice>} */ (DONE.notice);
  for (const state of [IMPORTS_STATE, null]) {
    const markup = detailMarkup(windowFor(scene('In:').report, state), AT_REST);
    assert.deepEqual([times(markup, notice.title), times(markup, notice.body)], [0, 0]);
  }
  const wholeScene = scene('Refused whole');
  const whole = windowOf(wholeScene).import;
  const [refused] = whole.yours?.parts ?? [];
  assert.equal(refused.callout, null, 'its row says it: no callout repeats it');
  assert.deepEqual(endActs(refused.panel.rows[0]), [['Skip it', { home: { need: NEEDS.whole.id, do: 'skip' } }]]);
  assert.deepEqual(endActs(refused.panel.rows[1]), [['Let go', { home: { need: REFUSED_WHOLE.files[0].acts[0].need, do: 'let-go' } }]]);
  assert.deepEqual(whole.needs, [], 'its need said on its row alone');
  assert.equal(times(detailMarkup(windowOf(wholeScene), AT_REST), REFUSED_WHOLE.health.words), 1, 'the refusal said once in its window');
  assert.ok(wholeScene.report.needs.some(need => need.id === NEEDS.whole.id), 'Needs you still lists it');
  assert.deepEqual(done?.panel.rows.map(each => each.dim), [false, false, false, false, true]);
});

test('I8: only the import acts and the steps\' Open on this Mac, none in a browser; every need and target the home\'s', () => {
  for (const at of SCENES) {
    const markup = detailMarkup(windowOf(at), AT_REST);
    seen.acts[at.name] = actsIn(markup);
    const needs = new Set([...at.report.needs.map(need => need.id), ...at.report.imports.flatMap(kind => kind.held.flatMap(held =>
      [`import:${held.id}:whose`, ...held.health.acts.flatMap(act => 'need' in act ? [act.need] : []),
        ...held.files.flatMap(file => file.acts.flatMap(act => 'need' in act ? [act.need] : []))]))]);
    for (const act of actsIn(markup).filter(each => 'home' in each)) assert.ok(needs.has(act.home.need), `${at.name}: ${act.home.need}`);
    const acts = hostActs(markup);
    if (at.state === null) {
      assert.deepEqual(acts, [], at.name);
      assert.match(markup, new RegExp(ON_MAC, 'u'), at.name);
      const links = [...markup.matchAll(/<a [^>]*href="([^"]*)"[^>]*target="_blank"/gu)].map(match => match[1]);
      assert.deepEqual(links, at.report.imports.find(each => each.kind === at.kind)?.guide.flatMap(step => step.open ? [step.open.url] : []),
        `${at.name}: each step's page an outside link`);
      continue;
    }
    const kind = at.report.imports.find(each => `import:${each.kind}` === `import:${at.kind}`);
    const files = new Set(kind?.coming.map(file => file.id));
    const sites = new Set(kind?.guide.map(step => step.open?.url).filter(Boolean));
    for (const act of acts) {
      const shape = Object.keys(act).sort().join(',');
      assert.ok(act.act === 'import' ? act.kind === at.kind && (act.do === 'choose' ? shape === 'act,do,kind'
        : ['again', 'forget'].includes(act.do) && shape === 'act,do,file,kind' && files.has(act.file))
        : act.act === 'open' && act.what === 'site' && sites.has(act.url), `${at.name}: ${JSON.stringify(act)}`);
    }
  }
});

test('I9: the banner once, Your past on the same terms, both showing Imports; Needs you counts a need', () => {
  const state = IMPORTS_STATE;
  const fresh = importsReport();
  const banner = bannerOf(fresh, state);
  assert.equal(banner?.title, `Import your past: ${TAKEOUT.name} and ${SPOTIFY.name}`);
  assert.deepEqual([banner?.show.label, banner?.show.do], ['Show imports', { at: IMPORTS_SEG }]);
  assert.deepEqual([banner?.close.label, banner?.close.do], ['Dismiss', { host: { act: 'skip', step: 'imports' } }]);
  assert.equal(bannerOf(fresh, null), null, 'not in a browser, which knows no mark');
  const marked = { ...fresh, setup: { skipped: ['imports'], at: null, you: true } };
  assert.equal(bannerOf(marked, state), null);
  assert.equal(bannerOf(scene('Checking and sending').report, state), null, 'a file coming');
  assert.equal(bannerOf(scene('In:').report, state), null, 'held');
  const markup = bodyMarkup(pageOf(fresh, state, NONE), AT_REST, '');
  assert.equal(markup.split(`<span class="ck-strip__mark">${icon('archive', { size: 'sm' })}</span>`).length - 1, 1, 'its one row');
  const calm = needsOf(importsReport({ takeout: holding(READING.line, READING) }), state).length;
  assert.equal(needsOf(importsReport({ takeout: holding(KEPT.line, KEPT), needs: [NEEDS.kept] }), state).length, calm + 1);
});

test('I11: Where and the search keep the kinds\' rows', () => {
  const home = scene('In a browser').report;
  const state = IMPORTS_STATE;
  assert.ok(rows(pageOf(home, state, { ...NONE, query: 'my activity' })).some(face => face.id === TAKEOUT_ID));
  assert.ok(rows(pageOf(home, state, { ...NONE, query: 'every play' })).some(face => face.id === SPOTIFY_ID), 'by what it reads');
  const files = pageOf(importsReport(), state, { ...NONE, place: 'file' });
  assert.ok([TAKEOUT_ID, SPOTIFY_ID, ...BROUGHT_ALONE].every(id => rows(files).some(face => face.id === id)));
  assert.ok(pageOf(importsReport(), state, NONE).placeCounts.file >= 2 + BROUGHT_ALONE.length);
  assert.equal(rows(pageOf(importsReport(), state, { ...NONE, place: 'chrome' })).some(face => face.id.startsWith('import:')), false);
});

async function standInDoor() {
  const door = {
    /** @type {Parameters<typeof importsReport>[0]} */
    scene: {},
    acts: /** @type {Record<string, string>[]} */ ([]),
    url: '',
  };
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  /** @param {import('node:http').IncomingMessage} request @returns {Promise<any>} */
  const bodyOf = request => new Promise(done => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => done(JSON.parse(body)));
  });
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://door').pathname;
    /** @param {number} status @param {unknown} body */
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.method === 'GET' && path === '/v1/connectors') return json(200, { position: '1:0', ...importsReport(door.scene) });
    if (request.method === 'POST' && path === '/v1/act') {
      door.acts.push(await bodyOf(request));
      return json(200, { acted: true });
    }
    if (request.method === 'GET' && path === '/v1/feed') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': open\n\n');
      feeds.add(response);
      response.on('close', () => feeds.delete(response));
      return undefined;
    }
    return json(404, { error: 'not here' });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  door.url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return { door, close: async () => {
    for (const feed of feeds) feed.end();
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  } };
}

let dir = '';
/** @type {import('node:http').Server | undefined} */
let viewer;
/** @type {Awaited<ReturnType<typeof openChrome>> | undefined} */
let chrome;
/** @type {Awaited<ReturnType<typeof standInDoor>> | undefined} */
let home;
/** @type {ReturnType<typeof openDoor> | undefined} */
let client;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-imports-'));
  home = await standInDoor();
  client = openDoor({ url: home.door.url, token: () => 'stub-token' });
  const served = await createViewer({ key: null, door: client });
  viewer = served;
  await new Promise(done => served.listen(0, '127.0.0.1', () => done(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (served.address()).port}`;
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin });
  await chrome.size(1440, 1000, 1);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
});

after(async () => {
  await writeFile(join(OUT, 'imports.json'), `${JSON.stringify({ ...seen, waiting: chrome?.waiting ?? '' }, null, 2)}\n`)
    .catch(() => undefined);
  await chrome?.close();
  if (viewer) {
    const served = viewer;
    served.closeAllConnections();
    await new Promise(done => served.close(() => done(undefined)));
  }
  client?.close();
  await home?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const GROUP = `[...document.querySelectorAll('.gallery__group')].find(group =>
  group.querySelector('.ck-section__label').textContent.startsWith('Streams · Imports'))`;

test('I12: every state of a kind\'s window in the gallery, shot whole, dark and light', async () => {
  const browser = /** @type {NonNullable<typeof chrome>} */ (chrome);
  await browser.theme('dark');
  await browser.load(`kit-gallery.html#group=${encodeURIComponent('Streams · Imports')}`, '');
  await browser.until(`${GROUP} && ${GROUP}.querySelectorAll('[data-import-scene]').length > 0`);
  await browser.evaluate(`for (const group of document.querySelectorAll('.gallery__group')) if (group !== ${GROUP}) group.remove();`);
  const scenes = await browser.evaluate(`[...${GROUP}.querySelectorAll('[data-import-scene]')].map(each => ({
    scene: each.dataset.importScene, tall: each.querySelector('.ck-dialog').getBoundingClientRect().height }))`);
  assert.deepEqual(scenes.map((/** @type {any} */ each) => each.scene), SCENES.map(each => each.name));
  const pages = await browser.evaluate(`${GROUP}.querySelectorAll('.gallery__page').length`);
  assert.equal(pages, 2);
  assert.equal(await browser.evaluate(`${GROUP}.querySelectorAll('.ck-drop.is-over').length`), 1, 'the DropZone lit');
  for (const theme of /** @type {const} */ (['dark', 'light'])) {
    await browser.theme(theme);
    /** @param {string} selector @param {number} at @param {string} name */
    const shoot = async (selector, at, name) => {
      const box = await browser.evaluate(`(() => { const each = ${GROUP}.querySelectorAll('${selector}')[${at}];
        each.scrollIntoView(); const box = each.getBoundingClientRect();
        return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height }; })()`);
      const picture = await browser.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: true,
        clip: { ...box, scale: 1 } });
      await writeFile(join(OUT, `${name}-${theme}.png`), Buffer.from(picture.data, 'base64'));
    };
    for (let at = 0; at < pages; at += 1) await shoot('.gallery__page', at, `page-${at + 1}`);
    for (const [at, each] of scenes.entries()) {
      const name = `${String(at + 1).padStart(2, '0')}-${each.scene.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48)}`;
      await shoot('[data-import-scene]', at, name);
      if (theme === 'dark') seen.shots.push({ shot: name, scene: each.scene, tall: Math.round(each.tall) });
    }
  }
  const sideways = await browser.evaluate(`[...${GROUP}.querySelectorAll('[data-import-scene]')].flatMap(each => {
    const body = each.querySelector('.ck-dialog__body');
    const edge = body.getBoundingClientRect().right - parseFloat(getComputedStyle(body).paddingRight);
    const past = [...body.querySelectorAll('*')].filter(part => part.getBoundingClientRect().right
      + Math.min(0, parseFloat(getComputedStyle(part).marginRight) || 0) > edge + 0.5)
      .map(part => part.getAttribute('class') || part.tagName);
    return past.length ? [{ scene: each.dataset.importScene, past: [...new Set(past)].slice(0, 6) }] : [];
  })`);
  assert.deepEqual(sideways, [], 'a window\'s body wider than the window');
  assert.deepEqual(browser.thrown.splice(0), []);
});

test('I13: in the Mac window: Choose… and Open the host\'s, a drop sends nothing, Let go and an answer reach the door', async () => {
  const page = /** @type {NonNullable<typeof chrome>} */ (chrome);
  const { door } = /** @type {NonNullable<typeof home>} */ (home);
  /** @returns {Promise<any[]>} */
  const acts = async () => {
    const posted = (await page.evaluate('window.hostActs.splice(0)')).map((/** @type {any} */ { type: _, ...act }) => act)
      .filter((/** @type {any} */ act) => ['import', 'open'].includes(act.act));
    seen.window.host.push(...posted);
    return posted;
  };
  /** @param {string} name */
  const shot = async name => {
    for (const theme of /** @type {const} */ (['dark', 'light'])) {
      await page.theme(theme);
      await page.shoot(join(OUT, `window-${name}-${theme}.png`));
      seen.shots.push({ shot: `window-${name}-${theme}` });
    }
    await page.theme('dark');
  };
  const DIALOG = `document.querySelector('.ck-dialog')`;
  const ZONE = `${DIALOG}?.querySelector('[data-ck-drop]')`;
  /** @param {string} words */
  const BUTTON = words => `[...${DIALOG}.querySelectorAll('button')].find(each => each.textContent.trim() === ${JSON.stringify(words)})`;
  /** @param {string} kind */
  const drag = kind => `(() => { const data = new DataTransfer(); data.items.add(new File(['x'], 'takeout-20261029T140000Z-1-001.zip'));
    ${ZONE}.querySelector('.ck-drop__words').dispatchEvent(new DragEvent(${JSON.stringify(kind)}, { bubbles: true, cancelable: true, dataTransfer: data })); })()`;
  const LIT = `${ZONE}.classList.contains('is-over')`;
  const host = hostScript({ ...HOST_STATE, setup: { state: 'done', error: null } });
  await page.size(1180, 860, 1);
  await page.theme('dark');

  door.scene = {};
  await page.load(`#view=connectors&dialog=${TAKEOUT_ID}`, host);
  await page.until(`${DIALOG}?.querySelector('.ck-dialog__line')?.textContent === ${JSON.stringify(TAKEOUT.products.map(product => product.name).join(' · '))}`);
  assert.ok(await page.evaluate(`(() => { const box = ${DIALOG}.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; })()`),
    'the window in the Mac window');
  assert.deepEqual(await acts(), [], 'nothing told on opening');
  await shot('nothing-yet');

  assert.equal(await page.evaluate(LIT), false);
  await page.evaluate(drag('dragenter'));
  await page.until(LIT);
  await page.evaluate(drag('dragover'));
  await shot('dragged-over');
  await page.evaluate(drag('dragleave'));
  await page.until(`!${LIT}`);
  await page.evaluate(drag('dragenter'));
  await page.until(LIT);
  await page.evaluate(drag('drop'));
  await page.until(`!${LIT}`);
  assert.deepEqual(await acts(), [], 'the drop is the window\'s: the page sends nothing');

  await page.evaluate(`${BUTTON('Choose…')}.click()`);
  await page.until(`window.hostActs.length > 0`);
  assert.deepEqual(await acts(), [{ act: 'import', do: 'choose', kind: 'google-takeout', label: 'Choose…' }]);
  await page.evaluate(`${BUTTON('Open Google Takeout')}.click()`);
  await page.until(`window.hostActs.length > 0`);
  assert.deepEqual(await acts(), [{ act: 'open', what: 'site', url: 'https://takeout.google.com/', label: 'Open Google Takeout' }]);
  await page.evaluate(`${DIALOG}.querySelector('[data-cn-close]').click()`);
  await page.until(`!${DIALOG}`);

  door.scene = { takeout: { coming: REFUSED_FILES } };
  await page.load(`#view=connectors&dialog=${TAKEOUT_ID}`, host);
  await page.until(`Boolean(${DIALOG}) && Boolean(${BUTTON('Choose again')})`);
  await shot('refused');
  await page.evaluate(`${BUTTON('Choose again')}.click()`);
  await page.until(`window.hostActs.length > 0`);
  assert.deepEqual(await acts(), [{ act: 'import', do: 'again', kind: 'google-takeout', file: 'file-05', label: 'Choose again' }]);

  door.scene = { takeout: holding(ASKED.line, ASKED, KEPT), needs: [NEEDS.asked, NEEDS.kept] };
  await page.load(`#view=connectors&dialog=${TAKEOUT_ID}`, host);
  const FIELD = `.ck-dialog [data-cn-field="${otherKey(ASKED.id)}"]`;
  await page.until(`Boolean(document.querySelector(${JSON.stringify(FIELD)})) && Boolean(${BUTTON('Let go')})`);
  await shot('asked-and-kept');
  await page.type(FIELD, 'person-c@example.com');
  await page.until(`${BUTTON('Choose')} && !${BUTTON('Choose')}.disabled`);
  await page.evaluate(`${BUTTON('Choose')}.click()`);
  await until('the answer at the door', () => door.acts.length === 1);
  await page.evaluate(`${BUTTON('Let go')}.click()`);
  await until('Let go at the door', () => door.acts.length === 2);
  assert.deepEqual(door.acts, [
    { need: `import:${ASKED.id}:whose`, do: 'choose', account: 'person-c@example.com' },
    { need: ASKED.files[0].acts[0].need, do: 'let-go' }]);
  seen.window.door.push(...door.acts.splice(0));
  assert.deepEqual(await acts(), [], 'the home\'s acts never the host\'s');

  door.scene = { takeout: holding(BROUGHT, DONE) };
  await page.load(`#view=connectors&seg=${IMPORTS_SEG}`, host);
  const FED = `[...document.querySelectorAll('.ck-cline__open')].find(each => each.dataset.cnOpen === ${JSON.stringify(TAKEOUT_ID)} && each.textContent !== 'Google Takeout')`;
  await page.until(`Boolean(${FED})`);
  await shot('add-more');
  await page.evaluate(`${FED}.click()`);
  await page.until(`${DIALOG}?.querySelector('.ck-dialog__title')?.textContent === 'Google Takeout'`);
  await page.evaluate(`${DIALOG}.querySelector('[data-cn-close]').click()`);
  await page.until(`!${DIALOG}`);

  await page.evaluate(`location.hash = '#view=connectors&dialog=gmail'`);
  await page.until(`Boolean(${DIALOG}) && Boolean(${BUTTON('Show')})`);
  await shot('comes-from');
  await page.evaluate(`${BUTTON('Show')}.click()`);
  await page.until(`${DIALOG}?.querySelector('.ck-dialog__title')?.textContent === 'Google Takeout'`);

  door.scene = {};
  await page.load(`#view=connectors&dialog=${TAKEOUT_ID}`, '');
  await page.until(`Boolean(${ZONE}) && ${ZONE}.textContent.includes(${JSON.stringify(ON_MAC)})`);
  await page.evaluate(drag('dragenter'));
  assert.equal(await page.evaluate(LIT), false, 'a zone that takes no drop never lights');
  assert.deepEqual(await page.evaluate(`[...${DIALOG}.querySelectorAll('.ck-numbered a')].map(each => [each.textContent.trim(),
    each.getAttribute('href'), each.target])`), [['Open Google Takeout', 'https://takeout.google.com/', '_blank']],
  'the company\'s page an outside link, in a new tab');
  await shot('browser');
  assert.deepEqual(door.acts, [], 'the home is told nothing on opening');
  assert.deepEqual(page.thrown.splice(0), []);
});
