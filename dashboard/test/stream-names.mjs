import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLM_REPORT } from '../public/kit-gallery-llm.js';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { AI_PAGE, detailOf, OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { AT_REST } from '../public/ui/connectors/view.js';
import { flows } from '../public/kit-gallery-flows.js';
import { atExit, openChrome } from '../tools/chrome.mjs';

/** @typedef {import('../public/types.js').StreamsReport} StreamsReport */

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.build', 'e2e', 'stream-names');
const NAMED_ROLES = new Set(['button', 'checkbox', 'switch', 'combobox', 'textbox', 'searchbox', 'menu', 'menuitem',
  'menuitemradio', 'menuitemcheckbox', 'tab', 'tabpanel', 'link', 'slider', 'spinbutton', 'radio', 'radiogroup',
  'listbox', 'dialog']);

/**
 * @param {StreamsReport} report
 * @param {string} name
 * @returns {{ at: string, markup: string }[]}
 */
function dialogsOf(report, name) {
  /** @type {{ at: string, markup: string }[]} */
  const found = [];
  for (const connector of report.connectors.filter(each => each.shown === 'stream' || each.shown === 'home')) {
    const lists = connector.members.filter(each => each.kind === 'list').map(each => `list:${each.key}`);
    for (const [host, state] of /** @type {const} */ ([['host', HOST_STATE], ['web', null]])) {
      const first = detailOf(report, state, connector.id, OPENED);
      if (!first) continue;
      found.push({ at: `${name} ${host} ${connector.id}`, markup: detailMarkup(first, AT_REST) });
      const works = (connector.processing?.rows ?? []).filter(row => row.shape !== null).map(row => `${AI_PAGE}${row.member}`);
      for (const page of ['signin', 'form', 'copies', ...lists, ...works]) {
        const detail = detailOf(report, state, connector.id, { ...OPENED, pages: [page] });
        if (detail && detail.back) found.push({ at: `${name} ${host} ${connector.id}/${page}`, markup: detailMarkup(detail, AT_REST) });
      }
    }
  }
  return found;
}

let dir = '';
/** @type {Awaited<ReturnType<typeof openChrome>> | undefined} */
let chrome;
/** @type {Record<string, unknown>} */
const seen = {};

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-stream-names-'));
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin: 'http://127.0.0.1:9' });
  await chrome.send('Accessibility.enable');
});

function keep() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'stream-names.json'), `${JSON.stringify(seen, null, 2)}\n`);
}
const kept = atExit(keep);

after(async () => {
  kept();
  keep();
  await chrome?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** @type {Record<string, number>} */
const roles = {};

const WORDED = new Set(['button', 'switch', 'tab', 'link', 'menuitemradio', 'menuitem', 'checkbox', 'radio']);

const VISIBLE = `function () {
  const words = node => node.nodeType === 3 ? node.textContent : node.nodeType !== 1 || node.matches('[aria-hidden="true"], .sr-only, [hidden], svg') ? ''
    : [...node.childNodes].map(words).join(' ');
  return words(this).replace(/\\s+/gu, ' ').trim().toLowerCase();
}`;

/**
 * @param {string} name
 * @param {string} shown
 */
function holdsWords(name, shown) {
  const said = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  let at = 0;
  for (const word of shown.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const found = said.indexOf(word, at);
    if (found < 0) return false;
    at = found + word.length;
  }
  return true;
}

/**
 * @param {string} markup
 * @returns {Promise<string[]>}
 */
async function unnamed(markup) {
  const page = /** @type {NonNullable<typeof chrome>} */ (chrome);
  await page.evaluate(`document.body.innerHTML = ${JSON.stringify(markup)};
    for (const list of document.querySelectorAll('.ck-fmenu__panel[hidden]')) list.hidden = false; document.body.childElementCount`);
  const { nodes } = /** @type {{ nodes: { role?: { value?: string }, name?: { value?: string }, ignored?: boolean, backendDOMNodeId?: number }[] }} */
    (await page.send('Accessibility.getFullAXTree'));
  /** @type {string[]} */
  const found = [];
  for (const node of nodes) {
    const role = node.role?.value ?? '';
    if (node.ignored || !NAMED_ROLES.has(role)) continue;
    roles[role] = (roles[role] ?? 0) + 1;
    const name = (node.name?.value ?? '').replace(/\s+/gu, ' ').trim();
    if (name !== '' && !WORDED.has(role)) continue;
    const { object } = /** @type {{ object: { objectId: string } }} */ (await page.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId }));
    if (name !== '') {
      const shown = /** @type {{ result: { value: string } }} */ (await page.send('Runtime.callFunctionOn',
        { objectId: object.objectId, functionDeclaration: VISIBLE, returnByValue: true })).result.value;
      if (holdsWords(name, shown)) continue;
      found.push(`${role} named ${JSON.stringify(name)} shows ${JSON.stringify(shown)}`);
      continue;
    }
    const { outerHTML } = /** @type {{ outerHTML: string }} */ (await page.send('DOM.getOuterHTML', { backendNodeId: node.backendDOMNodeId }));
    found.push(`${role}: ${outerHTML.slice(0, 200)}`);
  }
  return found;
}

test('N1, N2: the read itself finds a switch, a menu button, a field and a dialog with no name, and a button named otherwise than its words, and takes one named by its words', async () => {
  const found = await unnamed('<div role="dialog"><button type="button"></button><button type="button" role="switch" aria-checked="true"></button>'
    + '<button type="button" aria-haspopup="menu" aria-expanded="false"><svg></svg></button><input type="text" value="x">'
    + '<button type="button" role="switch" aria-checked="false" aria-label="Spam">Spam</button><label>Path <input type="text"></label>'
    + '<button type="button" aria-label="Turn on">Bring it in<span class="sr-only">, needs you</span></button></div>');
  assert.deepEqual(found.map(each => each.split(/:| named/u)[0]), ['dialog', 'button', 'switch', 'button', 'textbox', 'button']);
  for (const role of Object.keys(roles)) delete roles[role];
});

test('N1, N2: every control of every connector\'s page and each page it pushes, with the host or none, has a name', async () => {
  const dialogs = [...dialogsOf(REPORT, 'report'), ...dialogsOf(LLM_REPORT, 'llm')];
  assert.ok(dialogs.length > 50, `${dialogs.length} dialogs read: the gallery's streams should open many more`);
  /** @type {Record<string, string[]>} */
  const faults = {};
  for (const { at, markup } of dialogs) {
    const found = await unnamed(markup);
    if (found.length > 0) faults[at] = found;
  }
  seen.read = dialogs.map(each => each.at);
  seen.unnamed = faults;
  seen.roles = roles;
  assert.deepEqual(faults, {});
  for (const role of ['button', 'switch', 'textbox', 'dialog', 'menu', 'menuitemradio']) assert.ok((roles[role] ?? 0) > 0, `no ${role} read`);
});

test('N1, N2: every control of every flow a stream dialog mounts as its page (the vault, a model plan, the iPhone, the browser extension, To connect) has a name', async () => {
  const found = await unnamed(flows());
  seen.flows = found;
  assert.deepEqual(found, []);
});
