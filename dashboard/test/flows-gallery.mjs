import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { openChrome } from '../tools/chrome.mjs';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.build', 'e2e', 'flows-gallery');
/** @type {{ shots: { shot: string, group: string, state: string, frames: number }[] }} */
const seen = { shots: [] };
let dir = '';
/** @type {import('node:http').Server | undefined} */
let viewer;
/** @type {Awaited<ReturnType<typeof openChrome>> | undefined} */
let chrome;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-flows-gallery-'));
  const served = await createViewer({ key: null });
  viewer = served;
  await new Promise(done => served.listen(0, '127.0.0.1', () => done(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (served.address()).port}`;
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin });
  await chrome.size(1440, 1600, 1);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
});

after(async () => {
  await writeFile(join(OUT, 'flows-gallery.json'), `${JSON.stringify(seen, null, 2)}\n`).catch(() => undefined);
  await chrome?.close();
  if (viewer) {
    const served = viewer;
    served.closeAllConnections();
    await new Promise(done => served.close(() => done(undefined)));
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

const SPECIMENS = `[...document.querySelectorAll('.gallery__group')].filter(group =>
  /^(Flows|To connect)/.test(group.querySelector('.ck-section__label').textContent))
  .flatMap(group => [...group.querySelectorAll('.gallery__specimen')])`;

test('every flow in every state, in its dialog, and To connect for each way the home sends', async () => {
  const browser = /** @type {NonNullable<typeof chrome>} */ (chrome);
  await browser.theme('dark');
  await browser.load('kit-gallery.html#group=Flows&group=To%20connect', '');
  await browser.until(`${SPECIMENS}.length > 0 && document.querySelectorAll('.gallery__frames').length > 30`);
  await browser.evaluate(`for (const group of document.querySelectorAll('.gallery__group')) {
    if (!/^(Flows|To connect)/.test(group.querySelector('.ck-section__label').textContent)) group.remove(); }`);
  const specimens = await browser.evaluate(`${SPECIMENS}.map(specimen => ({
    group: specimen.closest('.gallery__group').querySelector('.ck-section__label').textContent,
    state: specimen.querySelector('.gallery__label').textContent,
    frames: specimen.querySelectorAll('.gallery__dialog').length,
    whole: specimen.getBoundingClientRect().height <= innerHeight,
    tall: Math.max(0, ...[...specimen.querySelectorAll('.ck-dialog')].map(each => each.getBoundingClientRect().height)),
    unmarked: [...specimen.querySelectorAll('.ck-chk')].filter(row => !row.querySelector('.ck-chk__mark .ck-checkdisc, .ck-chk__mark .ck-here, .ck-chk__mark .ck-ring')).length }))`);
  const groups = [...new Set(specimens.map((/** @type {any} */ each) => each.group))];
  assert.deepEqual(groups.map(group => group.split(':')[0]), ['Flows · the vault', 'Flows · a model', 'Flows · the iPhone',
    'Flows · the browser extension', 'To connect · each way and requirement as the home sends it, in its dialog']);
  assert.ok(specimens.every((/** @type {any} */ each) => each.frames > 0), 'a specimen with no frame');
  assert.deepEqual(specimens.filter((/** @type {any} */ each) => each.group.startsWith('Flows') && each.frames !== 1)
    .map((/** @type {any} */ each) => each.state), [], 'a flow’s state drawn other than in its one dialog');
  assert.deepEqual(specimens.filter((/** @type {any} */ each) => each.group.startsWith('Flows') && each.tall > 780).map((/** @type {any} */ each) =>
    `${each.state}: ${Math.round(each.tall)}`), [], 'a state taller than the Mac window');
  assert.deepEqual(specimens.filter((/** @type {any} */ each) => each.unmarked).map((/** @type {any} */ each) => each.state), []);
  assert.deepEqual(specimens.filter((/** @type {any} */ each) => !each.whole).map((/** @type {any} */ each) => each.state), [],
    'a specimen taller than its shot');
  for (const theme of /** @type {const} */ (['dark', 'light'])) {
    await browser.theme(theme);
    for (const [at, specimen] of specimens.entries()) {
      const box = await browser.evaluate(`(() => { const specimen = ${SPECIMENS}[${at}]; specimen.scrollIntoView();
        const box = specimen.getBoundingClientRect();
        return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: Math.min(box.height, innerHeight) }; })()`);
      const picture = await browser.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { ...box, scale: 1 } });
      const name = `${String(at + 1).padStart(2, '0')}-${specimen.group.startsWith('To connect') ? 'to-connect'
        : specimen.group.split(' · ')[1].split(':')[0].replace(/^the /u, '').replace(/^a /u, '').replaceAll(' ', '-')}`;
      await writeFile(join(OUT, `${name}-${theme}.png`), Buffer.from(picture.data, 'base64'));
      if (theme === 'dark') seen.shots.push({ shot: name, group: specimen.group, state: specimen.state, frames: specimen.frames });
    }
  }
  assert.deepEqual(browser.thrown.splice(0), []);
});
