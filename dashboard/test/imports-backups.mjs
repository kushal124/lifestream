// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_ASKED, BACKUP_COMING, BACKUP_HELD, BACKUP_ROWS, BACKUP_SCENES, BACKUP_WHICH, backupsState, holding, IMPORTS_STATE, importsReport,
  IPHONE_BACKUP, WHICH_SCENE,
} from '../public/kit-gallery-imports.js';
import { detailOf, OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { AT_REST } from '../public/ui/connectors/view.js';
import { BACKUP_WORDS } from '../public/ui/connectors/imports.js';
import { readHost } from '../public/lib/host.js';
import { esc } from '../public/lib/html.js';
import { openDoor } from '../lib/door.mjs';
import { createViewer } from '../server.mjs';
import { openChrome } from '../tools/chrome.mjs';
import { hostScript } from './stand-ins/onboarding-home.mjs';
import { until } from './until.mjs';

/** @typedef {import('../public/types.js').StreamsReport} StreamsReport */
/** @typedef {import('../public/lib/host.js').HostState} HostState */
/** @typedef {import('../public/lib/host.js').HostBackup} HostBackup */
const ID = 'import:iphone-backup';
const NB = ' ';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.build', 'e2e', 'imports-backups');
const seen = { shots: /** @type {object[]} */ ([]), host: /** @type {unknown[]} */ ([]) };

/**
 * @param {StreamsReport} report
 * @param {HostState | null} state
 * @param {string} [id]
 */
const windowFor = (report, state, id = ID) => {
  const detail = detailOf(report, state, id, OPENED);
  assert.ok(detail?.import);
  return /** @type {NonNullable<typeof detail> & { import: NonNullable<NonNullable<typeof detail>['import']> }} */ (detail);
};
/** @param {HostBackup[]} rows */
const listing = (...rows) => backupsState({ state: 'listed', rows });
/** @param {import('../public/ui/connectors/dialog.js').PanelRow} row */
const rowSaid = row => {
  const end = /** @type {any} */ (row.end);
  return [row.label, row.line, end?.words ?? null, (end?.acts ?? []).map((/** @type {any} */ act) => [act.label, act.do])];
};
/** @param {HostBackup} backup */
const said = backup => {
  const rows = windowFor(importsReport({ backup: {} }), listing(backup)).import.backups?.rows ?? [];
  assert.equal(rows.length, 1);
  return rowSaid(rows[0]);
};
/** @param {string} markup */
const actsIn = markup => [...markup.matchAll(/data-cn-do="([^"]*)"/gu)]
  .map(match => JSON.parse(match[1].replaceAll('&quot;', '"').replaceAll('&#39;', '\'').replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>').replaceAll('&amp;', '&')));
/** @param {string} id */
const read = id => ({ host: { act: 'import', do: 'backup-read', id } });

test('B1: the host\'s backups read as the host contract fixes them, anything else none', () => {
  /** @param {unknown} backups */
  const stated = backups => {
    const host = readHost({ lifestreamHost: { kind: 'mac', version: 6, state: { backups } },
      addEventListener: () => undefined, removeEventListener: () => undefined });
    assert.ok(host);
    return host.state.backups;
  };
  assert.equal(stated(undefined), null);
  assert.equal(stated({ state: 'some', rows: [] }), null, 'a state it does not know');
  assert.deepEqual(stated({ state: 'none', rows: [BACKUP_ROWS.unread] }), { state: 'none', rows: [] });
  assert.deepEqual(stated({ state: 'no-access' }), { state: 'no-access', rows: [] });
  assert.deepEqual(stated({ state: 'listed', rows: [BACKUP_ROWS.whatsapp, { ...BACKUP_ROWS.unread, id: '' },
    { ...BACKUP_ROWS.unread, name: '' }, 'row'] }), { state: 'listed', rows: [BACKUP_ROWS.whatsapp] });
  assert.deepEqual(stated({ state: 'listed', rows: [{ ...BACKUP_ROWS.unread, read: 'eaten', why: 'tired', in_ms: 'x', done: -4 }] })
    ?.rows, [{ ...BACKUP_ROWS.unread, read: 'unread', why: null, in_ms: null, done: 0 }]);
  assert.deepEqual(stated({ state: 'listed', rows: [BACKUP_ROWS.home, { ...BACKUP_ROWS.unread, why: 'unreadable:WhatsApp' }] })
    ?.rows.map(row => row.why), ['home', null]);
  assert.deepEqual(stated({ state: 'listed', rows: [{ ...BACKUP_ROWS.sending, bytes: 9 }] })?.rows, [BACKUP_ROWS.sending],
    'sending read; no size kept');
  assert.deepEqual(stated({ state: 'listed', rows: [{ ...BACKUP_ROWS.left, left: [...BACKUP_ROWS.left.left, { store: 'WhatsApp', why: 'tired' },
    { store: '', why: 'lost' }, 'row'] }, { ...BACKUP_ROWS.unread, left: 'x' }] })?.rows.map(row => row.left),
  [BACKUP_ROWS.left.left, []], 'each store left out with a why it knows');
  assert.deepEqual(stated({ state: 'listed', rows: [BACKUP_ROWS.room, { ...BACKUP_ROWS.room, need_bytes: -1 },
    { ...BACKUP_ROWS.room, need_bytes: '14' }] })?.rows.map(row => row.need_bytes), [14_000_000_000, null, null]);
});

test('B2: no backups in the host\'s state: "On your Mac", never Read it; every other kind as it was', () => {
  const report = importsReport({ backup: holding('Bringing in', ...BACKUP_HELD) });
  for (const state of [null, IMPORTS_STATE, { ...IMPORTS_STATE, backups: null }]) {
    const window = windowFor(report, state);
    assert.equal(window.import.backups, null);
    assert.deepEqual([window.import.drop?.words, window.import.drop?.choose, window.import.drop?.elsewhere],
      [IPHONE_BACKUP.drop.words, null, IPHONE_BACKUP.drop.away]);
    const markup = detailMarkup(window, AT_REST);
    assert.match(markup, /<section class="ck-drop ck-drop--still" data-ck-drop>.*On your Mac/su);
    assert.doesNotMatch(markup, new RegExp(`${BACKUP_WORDS.read}|${BACKUP_WORDS.label}`, 'u'));
    assert.deepEqual(actsIn(markup).filter(each => 'host' in each), [], 'no act of a Mac\'s');
    assert.equal(window.import.yours?.parts.length, 2);
  }
  const takeout = windowFor(report, listing(BACKUP_ROWS.unread), 'import:google-takeout').import;
  assert.deepEqual([takeout.backups, takeout.drop?.choose?.do], [null, { host: { act: 'import', do: 'choose', kind: 'google-takeout' } }]);
});

test('B3: a row per read and why, each in the guide\'s words, no size', () => {
  const whole = 'Work iPhone · 28 Aug 2026';
  const id = BACKUP_ROWS.unread.id;
  assert.deepEqual(said(BACKUP_ROWS.unread), [whole, '', null, [['Read it', read(id)]]]);
  assert.deepEqual(said(BACKUP_ROWS.plain), ['iPhone 15 · 2 Mar 2026',
    'Not encrypted: your calls aren\'t in it. iMessage and WhatsApp are.', null, [['Read it', read(BACKUP_ROWS.plain.id)]]]);
  assert.deepEqual(said(BACKUP_ROWS.making), ['Work iPhone · Backing up in Finder…', '', null, []]);
  assert.deepEqual(said(BACKUP_ROWS.in), [whole, '', 'Brought in 16 Nov', []]);
  assert.deepEqual(said(BACKUP_ROWS.opening), [whole, '', 'Opening…', []]);
  assert.deepEqual(said(BACKUP_ROWS.messages), [whole, 'Reading your backup · iMessage', null, []]);
  assert.deepEqual(said(BACKUP_ROWS.whatsapp), [whole, 'Reading your backup · WhatsApp · 41,000 of 96,000 photos and files', null, []]);
  assert.deepEqual(said(BACKUP_ROWS.calls), [whole, 'Reading your backup · Calls', null, []]);
  assert.deepEqual(said(BACKUP_ROWS.room), [whole, `needs 14${NB}GB free on this Mac`, 'Waiting', []]);
  assert.deepEqual(said({ ...BACKUP_ROWS.room, need_bytes: null }), [whole, 'needs more free space on this Mac', 'Waiting', []],
    'a Mac that says no number');
  assert.deepEqual(said(BACKUP_ROWS.home), [whole, '', 'Waiting for Lifestream', []]);
  assert.deepEqual(said(BACKUP_ROWS.sending), [whole, '', 'Sending to Lifestream', []], 'no Read it again while a store is owed');
  assert.deepEqual(said(BACKUP_ROWS.remade), [whole, 'Your iPhone started a new backup. Read it when it\'s done.', null, []]);
  assert.deepEqual(said(BACKUP_ROWS.unreadable), [whole, 'WhatsApp couldn\'t be read from this backup.', null,
    [['Read it again', read(id)]]]);
  assert.deepEqual(said(BACKUP_ROWS.partly), [whole, 'WhatsApp couldn\'t be read from this backup.',
    'Brought in 16 Nov', [['Read it again', read(id)]]]);
  assert.deepEqual(said(BACKUP_ROWS.left), [whole,
    'WhatsApp is too large to send to Lifestream. iMessage and Calls didn\'t reach Lifestream.', 'Brought in 16 Nov',
    [['Read it again', read(id)]]], 'each store left out by name and why');
  assert.deepEqual(said({ ...BACKUP_ROWS.quit, left: [{ store: 'iMessage', why: 'too-large' }, { store: 'WhatsApp', why: 'too-large' }] }),
    [whole, 'iMessage and WhatsApp are too large to send to Lifestream.', null, [['Read it again', read(id)]]]);
  assert.deepEqual(said(BACKUP_ROWS.quit), [whole, '', null, [['Read it', read(id)]]], 'a quit: Read it again, as unread');
  assert.deepEqual(said({ ...BACKUP_ROWS.messages, finished: false })[1], 'Reading your backup · iMessage');
  const rows = windowFor(importsReport({ backup: {} }), listing(BACKUP_ROWS.making, BACKUP_ROWS.in, BACKUP_ROWS.plain))
    .import.backups?.rows.map(row => row.label);
  assert.deepEqual(rows, ['Work iPhone · Backing up in Finder…', whole, 'iPhone 15 · 2 Mar 2026']);
  const named = windowFor(importsReport({ backup: holding('Brought in 16 Nov', ...BACKUP_HELD) }), listing(BACKUP_ROWS.in, BACKUP_ROWS.plain))
    .import.backups?.rows.map(row => row.label);
  assert.deepEqual(named, [whole, 'iPhone 15 · 2 Mar 2026'], 'named by the backup itself, never by an import made in its second');
});

test('B4: no backup yet, and no Full Disk Access, each its sentence; Open Privacy Settings the host\'s', () => {
  const none = windowFor(importsReport({ backup: {} }), backupsState({ state: 'none', rows: [] })).import.backups;
  assert.deepEqual([none?.label, none?.rows.map(rowSaid)], ['Backups on this Mac',
    [['No backup on this Mac yet. Follow the steps above, then come back.', '', null, []]]]);
  const empty = windowFor(importsReport({ backup: {} }), listing()).import.backups;
  assert.deepEqual(empty?.rows.map(row => row.label), [BACKUP_WORDS.none], 'listed with no row: none yet');
  const blind = windowFor(importsReport({ backup: {} }), backupsState({ state: 'no-access', rows: [] })).import.backups;
  assert.deepEqual(blind?.rows.map(rowSaid), [['Lifestream can\'t see your backups.', '', null,
    [['Open Privacy Settings', { host: { act: 'import', do: 'backup-settings' } }]]]]);
});

test('B5: the backups in the drop zone\'s place, no zone for another disk, Your imports last', () => {
  const window = windowFor(importsReport({ backup: { ...holding('Bringing in', ...BACKUP_HELD), coming: BACKUP_COMING } }),
    listing(BACKUP_ROWS.sending));
  assert.equal(window.import.drop, null, 'Finder makes backups in one place: no zone, no Choose…');
  const markup = detailMarkup(window, AT_REST);
  assert.doesNotMatch(markup, /data-ck-drop|Choose…|another disk/u);
  assert.equal(window.line, IPHONE_BACKUP.products.map(product => product.name).join(' · '), 'what it reads in the head');
  const at = [window.line, IPHONE_BACKUP.titles.guide, BACKUP_WORDS.label, IPHONE_BACKUP.titles.held]
    .map(words => markup.indexOf(esc(words)));
  assert.ok(at.every(index => index >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in order');
  assert.doesNotMatch(markup, /type="password"/u, 'no password asked by the page');
  assert.deepEqual(actsIn(markup).filter(each => 'host' in each), [], 'the row sending: nothing to press');
  assert.deepEqual(window.import.yours?.coming?.rows.map(row => row.label), ['iMessage', 'WhatsApp', 'Calls']);
});

test('B8: Which iPhone is this backup from?, once, above the imports it holds back, each answer the home\'s act', () => {
  const need = BACKUP_WHICH.need;
  /** @param {string} account */
  const choose = account => ({ home: { need, do: 'choose', account } });
  for (const state of [listing(BACKUP_ROWS.in), IMPORTS_STATE, null]) {
    const window = windowFor(importsReport(WHICH_SCENE), state);
    assert.deepEqual(window.import.needs, [], 'the question once, never again as a need on the one list');
    const [first, second] = window.import.yours?.parts ?? [];
    assert.deepEqual(first.question?.rows.map(rowSaid), [
      ['Which iPhone is this backup from?', 'iPhone 17 Pro · 28 Aug 2026', null, []],
      ['iPhone 17 Pro', 'WhatsApp and iMessage already here from this phone', null, [['Choose', choose('iphone-17-pro-aa01')]]],
      ['iPhone 17 Pro', 'last heard from 14 Nov', null, [['Choose', choose('iphone-17-pro-aa02')]]],
      ['iPhone 15', 'removed', null, [['Choose', choose('iphone-15-aa03')]]],
      ['An iPhone not set up with Lifestream', '', null, [['Choose', choose('new')]]],
    ]);
    assert.equal(second.question, null, 'asked once a backup, not once an import');
    for (const part of [first, second]) {
      assert.equal(part.callout, null);
      assert.deepEqual(part.panel.rows[0].end, null, 'no Choose on the status row beside the question');
      assert.equal(part.panel.rows[0].line, '', 'the question said once, not again on each import\'s row');
    }
    const markup = detailMarkup(window, AT_REST);
    const at = [IPHONE_BACKUP.titles.held, 'Which iPhone is this backup from?', ...BACKUP_ASKED.map(held => held.name)]
      .reduce((/** @type {number[]} */ found, words) => [...found, markup.indexOf(esc(words), (found.at(-1) ?? -1) + 1)], []);
    assert.ok(at.every(index => index >= 0), 'Your imports, the question, then the imports it holds back');
    assert.equal(markup.split(esc('Which iPhone is this backup from?')).length - 1, 1, 'drawn once');
    assert.deepEqual(actsIn(markup).filter(each => 'home' in each), BACKUP_WHICH.choices.map(each => choose(each.unit)));
  }
  const later = windowFor(importsReport({ backup: { ...WHICH_SCENE.backup, held: [BACKUP_HELD[1], ...BACKUP_ASKED] },
    needs: WHICH_SCENE.needs }), null).import.yours?.parts ?? [];
  assert.deepEqual(later.map(part => part.question === null), [true, false, true]);
});

test('B9: the backups by the home\'s flag on the kind, not its name', () => {
  const state = listing(BACKUP_ROWS.unread);
  const plain = windowFor(importsReport({ backup: { lists: undefined } }), state).import;
  assert.deepEqual([plain.backups, plain.drop?.words, plain.drop?.choose?.do],
    [null, IPHONE_BACKUP.drop.words, { host: { act: 'import', do: 'choose', kind: 'iphone-backup' } }]);
  const flagged = windowFor(importsReport({ takeout: { lists: 'backups' } }), state, 'import:google-takeout').import;
  assert.deepEqual([flagged.backups?.label, flagged.drop], [BACKUP_WORDS.label, null]);
});

let dir = '';
/** @type {import('node:http').Server | undefined} */
let viewer;
/** @type {Awaited<ReturnType<typeof openChrome>> | undefined} */
let chrome;
/** @type {Awaited<ReturnType<typeof standInDoor>> | undefined} */
let home;
/** @type {ReturnType<typeof openDoor> | undefined} */
let client;

async function standInDoor() {
  const door = { /** @type {Parameters<typeof importsReport>[0]} */ scene: { backup: {} }, acts: /** @type {unknown[]} */ ([]), url: '' };
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://door').pathname;
    /** @param {number} status @param {unknown} body */
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.method === 'GET' && path === '/v1/connectors') return json(200, { position: '1:0', ...importsReport(door.scene) });
    if (request.method === 'POST' && path === '/v1/act') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        door.acts.push(JSON.parse(body));
        json(200, { acted: 'chosen' });
      });
      return undefined;
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

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-imports-backups-'));
  home = await standInDoor();
  client = openDoor({ url: home.door.url, token: () => 'stub-token' });
  const served = await createViewer({ door: client });
  viewer = served;
  await new Promise(done => served.listen(0, '127.0.0.1', () => done(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (served.address()).port}`;
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin });
  await chrome.size(1440, 1000, 1);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
});

after(async () => {
  await writeFile(join(OUT, 'imports-backups.json'), `${JSON.stringify({ ...seen, waiting: chrome?.waiting ?? '' }, null, 2)}\n`)
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

const SCENE = '[data-backup-scene]';

test('B6: every state of the backup\'s window in the gallery, shot whole, dark and light', async () => {
  const browser = /** @type {NonNullable<typeof chrome>} */ (chrome);
  await browser.theme('dark');
  await browser.load(`kit-gallery.html#group=${encodeURIComponent('Streams · Imports')}`, '');
  await browser.until(`document.querySelectorAll('${SCENE}').length > 0`);
  await browser.evaluate(`(() => { const ours = document.querySelector('${SCENE}').closest('.gallery__dialogs');
    for (const group of document.querySelectorAll('.gallery__group')) if (!group.contains(ours)) group.remove();
    for (const each of document.querySelectorAll('.gallery__dialogs')) if (each !== ours) each.remove(); })()`);
  const names = await browser.evaluate(`[...document.querySelectorAll('${SCENE}')].map(each => each.dataset.backupScene)`);
  assert.deepEqual(names, BACKUP_SCENES.map(each => each.name));
  for (const theme of /** @type {const} */ (['dark', 'light'])) {
    await browser.theme(theme);
    for (const [at, name] of names.entries()) {
      const box = await browser.evaluate(`(() => { const each = document.querySelectorAll('${SCENE}')[${at}];
        each.scrollIntoView(); const box = each.getBoundingClientRect();
        return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height }; })()`);
      const picture = await browser.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: true, clip: { ...box, scale: 1 } });
      const shot = `${String(at + 1).padStart(2, '0')}-${String(name).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48)}`;
      await writeFile(join(OUT, `${shot}-${theme}.png`), Buffer.from(picture.data, 'base64'));
      if (theme === 'dark') seen.shots.push({ shot, scene: name });
    }
  }
  const sideways = await browser.evaluate(`[...document.querySelectorAll('${SCENE}')].flatMap(each => {
    const body = each.querySelector('.ck-dialog__body');
    const edge = body.getBoundingClientRect().right - parseFloat(getComputedStyle(body).paddingRight);
    const past = [...body.querySelectorAll('*')].filter(part => part.getBoundingClientRect().right
      + Math.min(0, parseFloat(getComputedStyle(part).marginRight) || 0) > edge + 0.5)
      .map(part => part.getAttribute('class') || part.tagName);
    return past.length ? [{ scene: each.dataset.backupScene, past: [...new Set(past)].slice(0, 6) }] : [];
  })`);
  assert.deepEqual(sideways, [], 'a window\'s body wider than the window');
  assert.deepEqual(browser.thrown.splice(0), []);
});

test('B7: in the Mac window, Read it the host\'s, the row following the host as it reads; in a browser no act', async () => {
  const page = /** @type {NonNullable<typeof chrome>} */ (chrome);
  const { door } = /** @type {NonNullable<typeof home>} */ (home);
  /** @returns {Promise<any[]>} */
  const acts = async () => {
    const posted = (await page.evaluate('window.hostActs.splice(0)')).map((/** @type {any} */ { type: _, ...act }) => act)
      .filter((/** @type {any} */ act) => act.act === 'import');
    seen.host.push(...posted);
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
  const SET_UP = { setup: { state: 'done', error: null, waiting: null } };
  /** @param {import('../public/lib/host.js').HostBackups} backups */
  const setState = backups => page.evaluate(`window.setHostState(${JSON.stringify({ ...IMPORTS_STATE, ...SET_UP, backups })})`);
  const DIALOG = `document.querySelector('.ck-dialog')`;
  /** @param {string} words */
  const BUTTON = words => `[...(${DIALOG}?.querySelectorAll('button') ?? [])].find(each => each.textContent.trim() === ${JSON.stringify(words)})`;
  /** @param {string} words */
  const SAYS = words => `(${DIALOG}?.textContent ?? '').includes(${JSON.stringify(words)})`;
  await page.size(1180, 860, 1);
  await page.theme('dark');

  door.scene = { backup: {} };
  const unread = listing(BACKUP_ROWS.unread, BACKUP_ROWS.plain);
  await page.load(`#view=connectors&dialog=${ID}`, hostScript({ ...unread, ...SET_UP }));
  await page.until(`${SAYS(BACKUP_WORDS.label)} && Boolean(${BUTTON('Read it')})`);
  assert.deepEqual(await acts(), [], 'nothing told on opening');
  await shot('listed');

  await page.evaluate(`${BUTTON('Read it')}.click()`);
  await page.until('window.hostActs.length > 0');
  assert.deepEqual(await acts(), [{ act: 'import', do: 'backup-read', id: BACKUP_ROWS.unread.id, label: 'Read it' }]);
  assert.equal(await page.evaluate(`Boolean(${DIALOG}.querySelector('input[type="password"]'))`), false);

  await setState({ state: 'listed', rows: [BACKUP_ROWS.whatsapp] });
  await page.until(SAYS('Reading your backup · WhatsApp · 41,000 of 96,000 photos and files'));
  assert.equal(await page.evaluate(`Boolean(${BUTTON('Read it')})`), false, 'nothing to press while it reads');
  await shot('reading');
  await setState({ state: 'listed', rows: [BACKUP_ROWS.sending] });
  await page.until(SAYS('Sending to Lifestream'));
  assert.equal(await page.evaluate(`Boolean(${BUTTON('Read it again')})`), false, 'nothing to press while a store is owed');
  await setState({ state: 'listed', rows: [BACKUP_ROWS.left] });
  await page.until(`${SAYS('Brought in 16 Nov')} && ${SAYS('iMessage and Calls didn\'t reach Lifestream.')}`);
  await shot('left');

  await page.evaluate(`${BUTTON('Read it again')}.click()`);
  await page.until('window.hostActs.length > 0');
  assert.deepEqual(await acts(), [{ act: 'import', do: 'backup-read', id: BACKUP_ROWS.left.id, label: 'Read it again' }]);

  await setState({ state: 'no-access', rows: [] });
  await page.until(`Boolean(${BUTTON('Open Privacy Settings')})`);
  await shot('no-access');
  await page.evaluate(`${BUTTON('Open Privacy Settings')}.click()`);
  await page.until('window.hostActs.length > 0');
  assert.deepEqual(await acts(), [{ act: 'import', do: 'backup-settings', label: 'Open Privacy Settings' }]);

  door.scene = { backup: holding('Bringing in', ...BACKUP_HELD) };
  await page.load(`#view=connectors&dialog=${ID}`, '');
  await page.until(`${SAYS(IPHONE_BACKUP.drop.away)} && ${SAYS(BACKUP_HELD[0].name)}`);
  assert.equal(await page.evaluate(`Boolean(${BUTTON('Read it')}) || ${SAYS(BACKUP_WORDS.label)}`), false);
  await shot('browser');
  assert.deepEqual(door.acts, [], 'the home is told nothing');

  door.scene = WHICH_SCENE;
  await page.load(`#view=connectors&dialog=${ID}`, '');
  await page.until(`${SAYS(BACKUP_WHICH.words)} && ${SAYS('An iPhone not set up with Lifestream')}`);
  await shot('which');
  await page.evaluate(`[...${DIALOG}.querySelectorAll('button')].filter(each => each.textContent.trim() === 'Choose')[1].click()`);
  await until('the answer at the door', () => door.acts.length > 0);
  assert.deepEqual(door.acts.splice(0), [{ need: BACKUP_WHICH.need, do: 'choose', account: 'iphone-17-pro-aa02' }]);
  assert.deepEqual(page.thrown.splice(0), []);
});
