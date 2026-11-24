// @ts-check
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHATGPT_SIGNED_IN, hostScript, hostState, onboardingHome, SENSES } from './onboarding-home.mjs';
import { pageHarness } from './page-harness.mjs';

const NEVER = [/\bwe\b/i, /\babout \d+ ?(min|h|hours?|days?)\b/i];
const CUT = /…/u;

const WINDOW = { width: 1100, height: 720, scale: 1 };
const ZOOMED = { width: 550, height: 360, scale: 1 };
const ROOMY = { width: 1450, height: 950, scale: 1 };

const CLIPPED = `(() => {
  const at = n => Math.round(n * 10) / 10;
  const clipped = [];
  for (const each of document.querySelectorAll('.ob *')) {
    if (each.closest('.ck-held, svg > *')) continue;
    const box = each.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(each).visibility !== 'visible') continue;
    let down = true;
    for (let up = each.parentElement; up && up !== document.documentElement; up = up.parentElement) {
      const style = getComputedStyle(up);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const edge = up.getBoundingClientRect();
      const right = edge.left + up.clientLeft + up.clientWidth, bottom = edge.top + up.clientTop + up.clientHeight;
      const across = box.left < edge.left - 0.5 || box.right > right + 0.5;
      const scrolls = /auto|scroll/.test(style.overflowY);
      const below = down && !scrolls && (box.top < edge.top - 0.5 || box.bottom > bottom + 0.5);
      if (across || below) {
        clipped.push([(each.className.baseVal ?? each.className) || each.tagName, ...[box.left, box.top, box.width, box.height].map(at)].join(' '));
        break;
      }
      if (scrolls) down = false;
    }
  }
  const page = document.scrollingElement;
  if (page.scrollWidth > page.clientWidth || page.scrollHeight > page.clientHeight) clipped.push('the page scrolls');
  return clipped;
})()`;

/** @param {{ file: string }} options */
export function onboardingPage({ file }) {
  /** @type {{ shots: string[], acts: unknown[], waiting: string, words: Record<string, string> } & Record<string, unknown>} */
  const seen = { shots: [], acts: [], waiting: '', words: {} };
  const page = pageHarness({ file, seen, size: WINDOW, scrollbars: true,
    front: home => onboardingHome({ door: { url: home.url, token: home.tokens.reader }, day: home.day }) });
  /** @type {Awaited<ReturnType<typeof page.journey>>['chrome'] | undefined} */
  let chrome;
  /** @type {Awaited<ReturnType<typeof page.journey>>['front'] | undefined} */
  let front;

  const browser = () => /** @type {NonNullable<typeof chrome>} */ (chrome);
  const { click } = page;
  let view = WINDOW;

  /**
   * @param {string} name
   * @param {string} ready
   */
  const shot = async (name, ready) => {
    const path = await page.shot(name, `(${ready}) && [...document.querySelectorAll('.ob img')]
      .every(each => !/^(https?|data):/u.test(each.src) || (each.complete && each.naturalWidth > 0))`);
    const drawn = await browser().evaluate(`document.querySelector('.ob')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`);
    seen.words[name] = drawn;
    for (const never of NEVER) assert.ok(!never.test(drawn), `${name} says ${never}: ${drawn}`);
    const prose = await browser().evaluate(`(() => { const copy = document.querySelector('.ob')?.cloneNode(true);
      copy?.querySelectorAll('button').forEach(each => each.remove());
      return copy?.textContent.replace(/\\s+/g, ' ').trim() ?? ''; })()`);
    assert.ok(!CUT.test(prose), `${name} cuts a line short outside a button that opens a dialog: ${prose}`);
    return path;
  };

  /** @param {{ width: number, height: number, scale: number }} size */
  const resize = async ({ width, height, scale }) => {
    const seen = browser().evaluate(`innerWidth === ${width} && innerHeight === ${height} || new Promise(done =>
      addEventListener('resize', () => requestAnimationFrame(() => done(true)), { once: true }))`);
    await browser().size(width, height, scale);
    await seen;
  };

  /**
   * @param {{ width: number, height: number, scale: number }} size
   * @param {string} name
   * @param {string} ready
   * @param {string} where
   */
  const at = async (size, name, ready, where) => {
    await resize(size);
    try {
      await browser().until(ready);
      assert.deepEqual(await browser().evaluate(CLIPPED), [], `${name}: clipped at ${where}`);
      return await shot(name, ready);
    } finally {
      await resize(view);
    }
  };

  /** @returns {Promise<string[]>} */
  const layout = () => browser().evaluate(`(() => {
    const at = (/** @type {number} */ n) => Math.round(n * 10) / 10;
    const boxes = [...document.querySelectorAll('.ck-onb__band, .ck-onb__head, .ck-onb__body > *, .ck-onb__sheet > *, '
      + '.ck-onb__foot, .ck-dialog')].filter(each => !each.closest('.ck-held')).map(each => { const box = each.getBoundingClientRect();
      return [each.className.split(' ')[0], ...[box.left, box.top, box.width, box.height].map(at)].join(' '); });
    const controls = [...document.querySelectorAll('.ob :is(.ck-btn, .ck-ibtn, .ck-done, .ck-working)')]
      .filter(each => !each.closest('.ck-held, .ck-onb__foot'))
      .map(each => { const box = each.getBoundingClientRect(); return ['control', ...[box.right, box.top, box.height].map(at)].join(' '); });
    return [...boxes, ...controls];
  })()`);

  return {
    seen,
    layout,

    /**
     * @param {string[]} before
     * @param {string} what
     */
    async still(before, what) {
      const now = await layout();
      assert.deepEqual(before.filter(box => !now.includes(box)), [], `${what} moved something: ${JSON.stringify(now)}`);
    },

    /**
     * @param {string} where
     * @returns {Promise<{ off: number[], overflows: boolean }>}
     */
    async lined(where) {
      const edges = await browser().evaluate(`(() => {
        const box = document.querySelector('.ck-onb__col').getBoundingClientRect();
        const back = document.querySelector('.ck-onb__back .ck-btn__label, .ck-onb__back .ck-btn')?.getBoundingClientRect();
        const end = document.querySelector('.ck-onb__end > :last-child')?.getBoundingClientRect();
        const rows = [...document.querySelectorAll('.ck-onb__body > :is(.ck-onb__sheet, .ob-plans)')].map(each => each.getBoundingClientRect());
        const stage = document.querySelector('.ck-onb__stage');
        return { overflows: stage.scrollHeight > stage.clientHeight, off: [back ? back.left - box.left : 0, end ? end.right - box.right : 0,
          ...rows.flatMap(each => [each.left - box.left, each.right - box.right])] };
      })()`);
      assert.ok(edges.off.every((/** @type {number} */ each) => Math.abs(each) <= 0.5),
        `${where}: off the column by ${JSON.stringify(edges)}`);
      return edges;
    },

    open: page.open,

    /**
     * @param {string} name
     * @param {{ size?: { width: number, height: number, scale?: number } }} [options]
     */
    async journey(name, options) {
      view = options?.size ?? WINDOW;
      ({ front, chrome } = await page.journey(name, options));
      return { front, chrome };
    },

    async close() {
      await page.close();
      await contactSheet();
    },

    /**
     * @param {string} hash
     * @param {unknown} host
     */
    load: (hash, host) => browser().load(hash, host === null ? '' : hostScript(host)),

    shot,

    /**
     * @param {string} name
     * @param {string} ready
     */
    async zoomed(name, ready) {
      return await at(ZOOMED, name, ready, '200 %');
    },

    /**
     * @param {string} name
     * @param {string} ready
     */
    async roomy(name, ready) {
      return await at(ROOMY, name, ready, 'the VM’s window');
    },
    click,

    /** @param {string} selector */
    text: selector => browser().evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter(each => !each.closest('.ck-held')).map(${SAID})`),

    /** @returns {Promise<any[]>} */
    async acts() {
      const posted = await browser().evaluate('window.hostActs.splice(0)');
      seen.acts.push(...posted);
      return posted.map((/** @type {any} */ { type: _, ...act }) => act);
    },

    /** @param {unknown} state */
    setState: state => browser().evaluate(`window.setHostState(${JSON.stringify(state)})`),

    primaries: () => browser().evaluate(`document.querySelectorAll('.ck-onb__foot .ck-btn--primary').length`),

    /**
     * @param {string} selector
     * @param {string[]} off
     */
    async turned(selector, off) {
      await browser().evaluate('window.hostHolds.turn = true');
      await click(selector);
      await browser().until('window.hostActs.length === 1');
      /** @type {NonNullable<typeof front>} */ (front).turnOff(off);
      await browser().evaluate('delete window.hostHolds.turn; window.hostRelease()');
    },
  };
}

/** @param {string} screen */
export const on = screen => `location.hash.includes('seg=${screen}') && document.querySelector('.ob[data-screen="${screen}"] .ck-onb')`;
export const UNHELD = `(each => { let words = ''; const walk = document.createTreeWalker(each, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    if (!node.parentElement?.closest('.ck-held')) words += node.data;
  }
  return words; })`;
export const SAID = `(each => ${UNHELD}(each).trim().replace(/\\s+/g, ' '))`;
/** @param {string} words */
export const shows = words => `${UNHELD}(document.querySelector('.ob') ?? document.createElement('i')).includes(${JSON.stringify(words)})`;
export const VAULT_ROW = `Math.round(document.querySelector('[data-item="vault"]').getBoundingClientRect().height * 10) / 10`;
/** @param {string} id */
export const kept = id => `document.querySelector('[data-ob="pick"][data-id="${id}"]')?.getAttribute('aria-checked')`;
/** @param {string} name */
export const named = name => `document.querySelector('[data-ob="name"]')?.value === ${JSON.stringify(name)}`;

/**
 * @param {string[]} granted
 * @param {Record<string, unknown>} [more]
 */
export const state = (granted, more) => hostState({ granted, more: { setup: null, ...more } });

export const signedOut = state(['fullDiskAccess', ...SENSES]);
export const signedIn = { ...signedOut, ask_login: CHATGPT_SIGNED_IN };
export const given = state(['fullDiskAccess', ...SENSES, 'photos'], { ask_login: CHATGPT_SIGNED_IN });
export const vaulted = { ...given, vault: { state: 'saved', saved_ms: null } };

const E2E = fileURLToPath(new URL('../../.build/e2e/', import.meta.url));
const JOURNEYS = ['onboarding-journey', 'onboarding-after', 'flows'];

/** @returns {Promise<string>} */
export async function contactSheet() {
  const parts = [];
  for (const journey of JOURNEYS) {
    /** @type {string[]} */
    const states = await readFile(join(E2E, journey, `${journey}.json`), 'utf8')
      .then(text => JSON.parse(text).shots ?? [], () => []);
    parts.push(`<section><h2>${journey} <small>${states.length ? `${states.length} states` : 'not run'}</small></h2>`
      + states.map(name => `<figure><figcaption>${name}</figcaption><div>`
        + ['dark', 'light'].map(theme => `<a href="${journey}/${name}-${theme}.png"><img loading="lazy" alt="${name}, ${theme}" `
          + `src="${journey}/${name}-${theme}.png"></a>`).join('') + '</div></figure>').join('') + '</section>');
  }
  const path = join(E2E, 'onboarding-sheet.html');
  await writeFile(path, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Onboarding, every shot</title>
<style>
  :root { color-scheme: dark; --ground: #0b1014; --ink: #e8edf0; --soft: #8b979e; --line: #1f2a30; }
  body { margin: 0; padding: 32px; background: var(--ground); color: var(--ink); font: 13px/1.4 -apple-system, system-ui, sans-serif; }
  h1 { margin: 0 0 24px; font-size: 20px; font-weight: 600; }
  h2 { margin: 40px 0 16px; padding-bottom: 8px; border-bottom: 1px solid var(--line); font-size: 15px; font-weight: 600; }
  small { color: var(--soft); font-weight: 400; }
  figure { margin: 0 0 24px; }
  figcaption { margin-bottom: 6px; color: var(--soft); font-family: ui-monospace, monospace; }
  figure > div { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; }
</style>
<h1>Onboarding, every shot <small>1100×720 (a zoomed shot at 200 %), dark then light</small></h1>
${parts.join('\n')}
`);
  return path;
}
