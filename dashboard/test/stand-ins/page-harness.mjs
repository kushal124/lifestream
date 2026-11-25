// @ts-check
import { spawn } from 'node:child_process';
import { bundledProgram } from '../../../testing/program.mjs';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../../server.mjs';
import { openDoor } from '../../lib/door.mjs';
import { atExit, killedAtExit, openChrome, running } from '../../tools/chrome.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** @typedef {{ url: string, tokens: Record<string, string>, day: string, faces?: { people_source: string } }} Home */
/** @typedef {{ url: string, close: () => Promise<void> }} Front */

/** @typedef {{ shots: string[], waiting: string } & Record<string, unknown>} Seen */

/**
 * @template {Front} F
 * @param {{ file: string, seen: Seen, front: (home: Home) => Promise<F>, size: { width: number, height: number, scale?: number }, narrow?: { width: number, height: number, scale?: number }, zone?: string, ahead?: (front: F) => number, scrollbars?: boolean, args?: string[], script?: string, token?: string, mutable?: boolean, ending?: () => unknown }} options
 */
export function pageHarness({ file, seen, front: standIn, size, narrow, zone, ahead, scrollbars = false, args = [], script = 'dashboard-home.ts', token = 'reader', mutable = false,
  ending }) {
  const blank = structuredClone(seen);
  let journey = '';
  let out = '';
  let view = size;
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | undefined} */
  let child;
  /** @type {Home | undefined} */
  let home;
  /** @type {F | undefined} */
  let front;
  /** @type {ReturnType<typeof openDoor> | undefined} */
  let door;
  /** @type {import('node:http').Server | undefined} */
  let viewer;
  let port = 0;
  let dir = '';
  /** @type {((line: any) => void)[]} */
  const answers = [];
  /** @type {Awaited<ReturnType<typeof openChrome>> | undefined} */
  let chrome;
  let begun = 0;
  let ready = false;
  const keep = () => {
    if (!journey) return;
    seen.waiting = chrome?.waiting || seen.waiting;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${journey}.json`), `${JSON.stringify(seen, null, 2)}\n`);
  };
  const kept = atExit(keep);

  const browser = () => /** @type {Awaited<ReturnType<typeof openChrome>>} */ (chrome);

  async function startDashboard() {
    const served = /** @type {F} */ (front);
    const tokens = /** @type {Home} */ (home).tokens;
    door = openDoor({ url: served.url, token: () => tokens[token] });
    const dashboard = await createViewer({ key: null, door });
    viewer = dashboard;
    await new Promise(done => dashboard.listen(port, '127.0.0.1', () => done(undefined)));
    port = /** @type {import('node:net').AddressInfo} */ (dashboard.address()).port;
  }

  async function stopDashboard() {
    door?.close();
    if (viewer) {
      const served = viewer;
      served.closeAllConnections();
      await new Promise(done => served.close(() => done(undefined)));
    }
  }

  const opened = () => ({ home: /** @type {Home} */ (home), front: /** @type {F} */ (front), chrome: browser(),
    url: `http://127.0.0.1:${port}`, dir,
    restart: async () => {
      await stopDashboard();
      await startDashboard();
    } });

  async function ended() {
    seen.waiting = chrome?.waiting ?? '';
    try {
      if (journey) await ending?.();
    } finally {
      keep();
    }
  }

  return {
    get out() {
      return out;
    },

    async open() {
      dir = await mkdtemp(join(tmpdir(), `dashboard-${file}-`));
      const launching = openChrome({ profile: join(dir, 'chrome'), origin: () => `http://127.0.0.1:${port}`, scrollbars });
      launching.catch(() => undefined);
      const poolUrl = !mutable && script === 'dashboard-home.ts' && args.length === 0 ? process.env.LIFESTREAM_DASHBOARD_POOL : undefined;
      try {
        if (poolUrl) {
          const response = await fetch(`${poolUrl}/home/dashboard`, { method: 'POST' });
          if (!response.ok) throw new Error(`shared dashboard-home refused: ${response.status}`);
          home = /** @type {Home} */ (await response.json());
        } else {
          child = spawn(process.execPath, [...bundledProgram(join('packages', 'home', 'test', script)), ...args], { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] });
          killedAtExit(child);
          const started = child;
          home = await new Promise((done, fail) => {
            started.once('exit', code => fail(new Error(`the synthetic home exited with ${code}`)));
            createInterface({ input: started.stdout }).on('line', text => {
              const line = JSON.parse(text);
              if (line.ready) done(line);
              else answers.shift()?.(line);
            });
          });
        }
        front = await standIn(/** @type {Home} */ (home));
        await startDashboard();
        chrome = await launching;
        ready = true;
      } catch (error) {
        await launching.then(each => each.close(), () => undefined);
        throw error;
      }
      return opened();
    },

    /**
     * @param {string} name
     * @param {{ size?: { width: number, height: number, scale?: number } }} [options]
     */
    async journey(name, { size: own = size } = {}) {
      await ended();
      for (const key of Object.keys(seen)) delete seen[key];
      Object.assign(seen, structuredClone(blank));
      journey = name;
      out = join(REPO, 'dashboard', '.build', 'e2e', journey);
      begun = 0;
      view = own;
      const reuse = ready;
      ready = false;
      await Promise.all([
        reuse ? Promise.resolve() : (async () => {
          await stopDashboard();
          await /** @type {F} */ (front).close();
          front = await standIn(/** @type {Home} */ (home));
          await startDashboard();
        })(),
        reuse ? Promise.resolve() : browser().fresh(),
        rm(out, { recursive: true, force: true }).then(() => mkdir(out, { recursive: true })),
      ]);
      const setup = [];
      if (ahead) {
        setup.push(browser().send('Page.addScriptToEvaluateOnNewDocument',
          { source: `(() => { const real = Date.now; Date.now = () => real() + ${ahead(/** @type {F} */ (front))}; })()` }));
      }
      if (zone) setup.push(browser().send('Emulation.setTimezoneOverride', { timezoneId: zone }));
      setup.push(browser().size(view.width, view.height, view.scale));
      setup.push(browser().theme('dark'));
      await Promise.all(setup);
      return opened();
    },

    /**
     * @param {string} cmd
     * @param {Record<string, unknown>} [more]
     */
    async command(cmd, more = {}) {
      if (!child) throw new Error(`command(${cmd}) requires mutable: true on pageHarness`);
      const answer = /** @type {Promise<any>} */ (new Promise(done => answers.push(done)));
      /** @type {NonNullable<typeof child>} */ (child).stdin.write(`${JSON.stringify({ cmd, ...more })}\n`);
      const line = await answer;
      if (line.ok !== true) throw new Error(`the synthetic home refused ${cmd}: ${line.error}`);
      return line.value;
    },

    async close() {
      kept();
      try {
        await ended();
        await chrome?.close();
        await stopDashboard();
        await front?.close();
        if (child && running(child)) {
          const exited = once(child, 'exit');
          child.stdin.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
          await exited;
        }
        if (dir) await rm(dir, { recursive: true, force: true });
      } finally {
        keep();
      }
    },

    /**
     * @param {string} name
     * @param {string} ready
     */
    async shot(name, ready) {
      if (!journey) throw new Error(`shot ${name}: no journey yet; call journey(name) first`);
      begun += 1;
      const base = `${String(begun).padStart(2, '0')}-${name}`;
      /** @type {string[]} */
      const taken = [];
      const sizes = narrow ? [view, narrow] : [null];
      for (let index = 0; index < sizes.length; index += 1) {
        const at = sizes[index];
        const themes = /** @type {const} */ (index % 2 === 0 ? ['dark', 'light'] : ['light', 'dark']);
        for (let step = 0; step < themes.length; step += 1) {
          const theme = themes[step];
          await Promise.all([
            ...(step === 0 && at ? [browser().size(at.width, at.height, at.scale)] : []),
            browser().theme(theme),
          ]);
          await browser().until(ready, '', true);
          taken.push(join(out, `${base}${at ? `-${at.width}` : ''}-${theme}.png`));
          await browser().capture(/** @type {string} */ (taken.at(-1)));
        }
      }
      await Promise.all([
        ...(narrow ? [browser().size(view.width, view.height, view.scale)] : []),
        browser().theme('dark'),
      ]);
      seen.shots.push(base);
      return taken[0];
    },

    /** @param {string} selector */
    click: selector => browser().evaluate(`(() => {
  const found = document.querySelectorAll(${JSON.stringify(selector)});
  if (found.length !== 1) throw new Error(${JSON.stringify(selector)} + ' names ' + found.length);
  found[0].click();
})()`),

    /** @param {string} selector */
    words: selector => browser().evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent
  .replace(/\\s+/gu, ' ').trim()`),

    /** @param {string} selector */
    count: selector => browser().evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
  };
}
