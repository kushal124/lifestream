// @ts-check
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, constants, homedir, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome.mjs';
import { NEWEST, askChats, days, faces, people, person, places } from './speed-life.mjs';
import { openGate, pressPlan, report, summary } from './speed-press.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
if (process.argv[2] === '--hold') {
  const run = Number(process.argv[3]);
  console.log('held');
  setInterval(() => {
    try {
      process.kill(run, 0);
    } catch {
      process.exit(0);
    }
  }, 500);
  await new Promise(() => {});
}
const PRESS = process.argv.includes('--press');
const NOISY = process.argv.includes('--noisy');
if (PRESS) {
  const holder = spawn(join(REPO, 'tools', 'test-lock.sh'), [process.execPath, fileURLToPath(import.meta.url), '--hold', String(process.pid)],
    { stdio: ['ignore', 'pipe', 'inherit'], detached: true, env: { ...process.env, ...NOISY ? { LIFESTREAM_TEST_HERE: '1' } : { LIFESTREAM_TEST_EXCLUSIVE: '1' } } });
  await new Promise((done, fail) => {
    holder.once('exit', code => fail(new Error(`the test lock's holder exited with ${code}`)));
    createInterface({ input: /** @type {import('node:stream').Readable} */ (holder.stdout) }).once('line', done);
  });
  holder.removeAllListeners('exit');
  holder.unref();
} else if (!process.env.LIFESTREAM_TEST_LOCKED && !process.argv.includes('--serve')) {
  const locked = spawn(join(REPO, 'tools', 'test-lock.sh'), [process.execPath, ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, LIFESTREAM_TEST_EXCLUSIVE: '1' } });
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(signal, () => locked.kill(signal));
  process.exit(await new Promise(done => locked.once('exit', (code, signal) => done(code ?? (signal ? 128 + constants.signals[signal] : 1)))));
}
const OUT = join(REPO, 'dashboard', '.build', 'speed');
const PROBE = await readFile(join(REPO, 'dashboard', 'tools', 'speed-probe.js'), 'utf8');
const option = (/** @type {string} */ name, /** @type {string} */ fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const LABEL = option('label', 'run');
const DASHBOARD = resolve(option('dashboard', join(REPO, 'dashboard')));
const { createViewer } = await import(join(DASHBOARD, 'server.mjs'));
const { openDoor } = await import(join(DASHBOARD, 'lib', 'door.mjs'));
const FACTORS = option('factors', process.argv.includes('--check') ? '10' : PRESS ? '1' : '1,10,100').split(',').map(Number);
const REPS = Number(option('reps', process.argv.includes('--check') ? '1' : '3'));
const ENGINE = option('engine', 'chrome');
const PROFILE = process.argv.includes('--profile');
const TRACE = process.argv.includes('--trace');
const BUDGET_MS = 1000 / 120;
const DROP_MS = 25;
const SWITCHES = 200;
const FOLDS = 20;
const BURSTS = 10;
const BUSY_MS = 1_500;
const CHECK = process.argv.includes('--check');
const PLACE_OPEN_MS = 3_000;
const PLACE_DROP_MS = 20;
const PLACES_OPENED = 5;
const BUDGETS = { switchP50Ms: BUDGET_MS, switchP99Ms: 2 * BUDGET_MS, typedP99Ms: 2 * BUDGET_MS };
const HOME_MS = { 'life/people': 50, faces: 50, 'life/places': 5, 'life/days': 500, 'ask/chats': 30, ask: 10 };
const VIEWS = ['ask', 'days', 'people', 'places', 'connectors', 'search'];

if (process.argv.includes('--place-open')) {
  await placeOpen(option('at', ''));
  process.exit(process.exitCode ?? 0);
}

const PRESS_ON = option('on', 'live');
if (PRESS && PRESS_ON !== 'life') {
  await pressLive();
  if (PRESS_ON === 'live') process.exit(process.exitCode ?? 0);
}

const child = spawn(process.execPath, ['--import', 'tsx', '--import', './testing/process.mjs', join('packages', 'home', 'test', 'dashboard-home.ts')], {
  cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'],
});
/** @type {{ url: string, tokens: { reader: string }, day: string, jpeg: string }} */
const home = await new Promise((done, fail) => {
  child.once('exit', code => fail(new Error(`the synthetic home exited with ${code}`)));
  createInterface({ input: /** @type {import('node:stream').Readable} */ (child.stdout) }).on('line', text => {
    const line = JSON.parse(text);
    if (line.ready) done(line);
  });
});
const scratch = await mkdtemp(join(tmpdir(), 'dashboard-speed-'));
const viewer = await createViewer({ door: openDoor({ url: home.url, token: () => home.tokens.reader }) });
const passOn = /** @type {(req: any, res: any) => void} */ (viewer.listeners('request')[0]);
await new Promise(done => viewer.listen(0, '127.0.0.1', () => done(undefined)));
const viewerHost = `127.0.0.1:${/** @type {any} */ (viewer.address()).port}`;
const JPEG = Buffer.from(home.jpeg, 'base64');

/**
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} value
 */
function sendJSON(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  /** @param {unknown} part */
  const write = part => {
    if (Array.isArray(part) && part.length > 1_000) {
      res.write('[');
      for (let at = 0; at < part.length; at += 1_000) {
        res.write((at ? ',' : '') + part.slice(at, at + 1_000).map(each => JSON.stringify(each)).join(','));
      }
      res.write(']');
    } else if (part && typeof part === 'object' && !Array.isArray(part)) {
      res.write('{');
      Object.entries(part).forEach(([key, inner], at) => {
        res.write(`${at ? ',' : ''}${JSON.stringify(key)}:`);
        write(inner);
      });
      res.write('}');
    } else res.write(JSON.stringify(part) ?? 'null');
  };
  write(value);
  res.end();
}

/** @param {number} factor */
async function serveLife(factor) {
  const life = people(factor);
  /** @type {Record<string, () => unknown>} */
  const made = {};
  const once = (/** @type {string} */ key, /** @type {() => unknown} */ make) => () => (made[key] ??= /** @type {any} */ (make()));
  const answers = {
    'life/people': once('people', () => life),
    faces: once('faces', () => faces(factor, life)),
    'life/places': once('places', () => places(factor)),
    'life/days': once('days', () => days(factor)),
    ask: () => ({ model: 'synthetic/model', login: 'ready' }),
  };
  const asked = { count: 0 };
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  let seq = 0;
  /** @param {{ kind: string, key: string }[]} messages */
  const tell = messages => {
    for (const message of messages) {
      seq += 1;
      for (const feed of feeds) feed.write(`data: ${JSON.stringify({ seq, ...message })}\n\n`);
    }
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://speed');
    const route = url.pathname.replace(/^\/api\//u, '');
    if (url.pathname.startsWith('/api/') && route !== 'feed') asked.count += 1;
    /** @type {(() => unknown) | null} */
    let answer = null;
    if (route === 'feed') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(': open\n\n');
      feeds.add(res);
      req.on('close', () => feeds.delete(res));
      return;
    }
    if (route === 'life/people' && url.searchParams.has('id')) answer = () => person(life, url.searchParams.get('id') ?? '');
    else if (route === 'ask/chats') answer = () => askChats(factor, url.searchParams.get('after') ?? '');
    else if (route === 'life/picture') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
      res.end(JPEG);
      return;
    } else if (route in answers) answer = answers[/** @type {keyof typeof answers} */ (route)];
    if (!answer) {
      req.headers.host = viewerHost;
      if (req.headers.origin) req.headers.origin = `http://${viewerHost}`;
      if (req.headers.referer) req.headers.referer = `http://${viewerHost}/`;
      passOn(req, res);
      return;
    }
    const value = answer();
    const held = HOME_MS[/** @type {keyof typeof HOME_MS} */ (route)] ?? 20;
    setTimeout(() => {
      if (value === null) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"Not found."}');
      } else sendJSON(res, value);
    }, held);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return { server, url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`, life, asked, tell,
    close: () => {
      for (const feed of feeds) feed.end();
    } };
}

/** @param {string} profile */
async function openChrome(profile) {
  const chrome = await launchChrome({ profile,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  /** @type {any[]} */
  const traced = [];
  /** @type {(() => void) | null} */
  let traceDone = null;
  chrome.on('Tracing.dataCollected', params => traced.push(...params.value));
  chrome.on('Tracing.tracingComplete', () => traceDone?.());
  if (process.env.SPEED_VERBOSE) {
    chrome.on('Runtime.exceptionThrown', params => console.error('page:', params.exceptionDetails.exception?.description ?? params.exceptionDetails.text));
    chrome.on('Runtime.consoleAPICalled', params => {
      if (params.type === 'error') console.error('page console:', JSON.stringify(params.args.map((/** @type {any} */ arg) => arg.value ?? arg.description)));
    });
    chrome.on('Network.loadingFailed', params => console.error('page load failed:', params.errorText));
  }
  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  const send = (method, params = {}) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    return Promise.race([chrome.send(method, params), new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error(`two minutes and no answer to ${method}`)), 120_000);
    })]).finally(() => clearTimeout(timer));
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await send('Page.enable');
  await send('Inspector.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Performance.enable', { timeDomain: 'timeTicks' });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  return {
    send,
    /** @param {string} url */
    async open(url) {
      await send('Network.clearBrowserCache');
      await send('Page.navigate', { url: 'about:blank' });
      await send('Page.navigate', { url });
    },
    reload: () => send('Page.reload'),
    /** @param {string} expression */
    async run(expression) {
      const began = Date.now();
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      const answer = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        new Promise((_, fail) => {
          timer = setTimeout(() => fail(new Error(`a minute and no answer to ${expression}`)), 60_000);
        })]).finally(() => clearTimeout(timer));
      if (process.env.SPEED_VERBOSE) console.error(`${Date.now() - began} ms ${expression}`);
      if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? 'failed in the page');
      return answer.result?.value;
    },
    async metrics() {
      const answer = await send('Performance.getMetrics');
      return Object.fromEntries((answer.metrics ?? []).map((/** @type {any} */ each) => [each.name, each.value]));
    },
    async startTrace() {
      traced.length = 0;
      await send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline',
        'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'v8.execute', 'blink.user_timing',
        'disabled-by-default-v8.cpu_profiler', 'loading', 'latencyInfo'] } });
    },
    async endTrace() {
      const done = new Promise(finish => {
        traceDone = () => finish(undefined);
      });
      await send('Tracing.end');
      await done;
      return { traceEvents: traced.slice() };
    },
    close: chrome.close,
  };
}

/** @param {string} [extra] */
async function openWebKit(extra = '') {
  const binary = join(OUT, 'page-speed');
  await new Promise((done, fail) => spawn('swiftc', ['-O', join(REPO, 'macos-app', 'benchmarks', 'PageSpeed.swift'), '-o', binary],
    { stdio: 'inherit' }).once('exit', code => code === 0 ? done(undefined) : fail(new Error(`swiftc exited with ${code}`))));
  const probe = join(OUT, 'speed-probe-run.js');
  await writeFile(probe, `${PROBE}\n${extra}`);
  const driver = spawn(binary, [probe], { stdio: ['pipe', 'pipe', 'inherit'] });
  /** @type {((line: any) => void)[]} */
  const waiting = [];
  createInterface({ input: /** @type {import('node:stream').Readable} */ (driver.stdout) })
    .on('line', text => waiting.shift()?.(JSON.parse(text)));
  /** @param {object} command @returns {Promise<any>} */
  const ask = command => new Promise(done => {
    waiting.push(done);
    driver.stdin?.write(`${JSON.stringify(command)}\n`);
  });
  return {
    act: ask,
    /** @param {string} url */
    open: url => ask({ cmd: 'open', url, fresh: true }),
    reload: () => ask({ cmd: 'reload' }),
    /** @param {string} expression */
    async run(expression) {
      const began = Date.now();
      const answer = await ask({ cmd: 'run', js: expression });
      if (process.env.SPEED_VERBOSE) console.error(`${Date.now() - began} ms ${expression}`);
      if ('error' in answer) throw new Error(PRESS ? 'the page did not answer' : answer.error);
      return JSON.parse(answer.json);
    },
    async metrics() {
      return { footprint: (await ask({ cmd: 'footprint' })).value };
    },
    /** @param {string} _method */
    send: async _method => ({}),
    async close() {
      const exited = new Promise(done => driver.once('exit', done));
      driver.stdin?.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
      await exited;
    },
  };
}

/** @param {any} profile */
function heaviest(profile) {
  /** @type {Map<number, any>} */
  const nodes = new Map(profile.nodes.map((/** @type {any} */ node) => [node.id, node]));
  /** @type {Map<string, number>} */
  const self = new Map();
  const deltas = profile.timeDeltas;
  profile.samples.forEach((/** @type {number} */ sample, /** @type {number} */ at) => {
    const frame = nodes.get(sample)?.callFrame;
    if (!frame) return;
    const where = `${frame.functionName || '(anonymous)'} ${frame.url.replace(/^.*\/\/[^/]+/u, '')}:${frame.lineNumber + 1}`;
    self.set(where, (self.get(where) ?? 0) + (deltas[at + 1] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((sum, ms) => sum + ms, 0);
  return { totalMs: total, top: [...self.entries()].sort((left, right) => right[1] - left[1]).slice(0, 25)
    .map(([where, ms]) => ({ where, ms: Math.round(ms), share: Math.round(ms / total * 1000) / 10 })) };
}

/** @param {number} factor */
async function measure(factor) {
  const life = await serveLife(factor);
  const page = ENGINE === 'webkit' ? await openWebKit() : await openChrome(join(scratch, `chrome-${factor}`));
  const someone = life.life.people.filter(each => each.sent > 0).sort((left, right) => right.last_ms - left.last_ms)[0]?.id ?? '';
  /** @type {any[]} */
  const samples = [];
  /** @type {any[]} */
  const launches = [];
  /** @type {any[]} */
  const stress = [];
  /** @type {any} */
  let profile = null;
  /** @type {any} */
  let trace = null;
  /** @type {any[]} */
  const memory = [];
  /** @type {any[]} */
  const failures = [];
  const record = (/** @type {string} */ temp, /** @type {any} */ result) => {
    if (result) samples.push({ temp, ...result });
  };
  /** @param {string} temp */
  const pass = async temp => {
    for (const view of VIEWS) {
      record(temp, await page.run(view === 'search' ? `speed.route('tab:search', '#view=search')` : `speed.tab('${view}')`));
      if (view === 'people' && someone) {
        record(temp, await page.run(`speed.route('open:person', ${JSON.stringify(`#view=people&focus=${encodeURIComponent(someone)}`)})`));
        record(temp, await page.run(`speed.route('back:people', '#view=people')`));
        record(temp, await page.run(`speed.route('open:faces', '#view=people&focus=faces')`));
        record(temp, await page.run(`speed.route('back:people', '#view=people')`));
      }
      if (view === 'places' && await page.run(`speed.has('[data-pl-open]')`)) {
        record(temp, await page.run(`speed.click('open:place', '[data-pl-open]')`));
        record(temp, await page.run(`speed.route('back:places', '#view=places')`));
        record(temp, await page.run(`speed.route('tab:trips', '#view=places&seg=trips')`));
        record(temp, await page.run(`speed.route('back:places', '#view=places')`));
      }
      if (view === 'days') {
        record(temp, await page.run(`speed.route('open:other-day', '#view=days&on=2026-09-20')`));
        if (await page.run(`speed.has('[data-d-row]')`)) {
          record(temp, await page.run(`speed.click('open:moment', '[data-d-row]')`));
          record(temp, await page.run(`speed.key('close:moment', 'Escape')`));
        }
      }
      if (view === 'connectors' && await page.run(`speed.has('[data-cn-open]')`)) {
        record(temp, await page.run(`speed.click('open:stream', '[data-cn-open]')`));
        record(temp, await page.run(`speed.key('close:stream', 'Escape')`));
      }
    }
  };
  for (let rep = 0; rep < REPS; rep += 1) {
    try {
      const opened = Date.now();
      await page.open(`${life.url}/#view=ask`);
      launches.push({ temp: 'cold', ...await page.run('speed.launch()'), wall: Date.now() - opened });
      await pass('cold');
      await pass('warm');
      memory.push({ rep, after: 'passes', ...pick(await page.metrics()) });
      await page.reload();
      launches.push({ temp: 'warm', ...await page.run('speed.launch()') });
    } catch (error) {
      failures.push({ rep, error: String(/** @type {Error} */ (error).message ?? error) });
    }
  }
  /**
   * @param {string} part
   * @param {() => Promise<void>} run
   */
  const part = async (part, run) => {
    try {
      await run();
    } catch (error) {
      failures.push({ stress: part, error: String(/** @type {Error} */ (error).message ?? error) });
    }
  };
  /** @type {Record<string, number>} */
  let before = {};
  let startedAt = 0;
  await part('warm pass', async () => {
    await pass('reloaded');
    if (PROFILE && ENGINE === 'chrome') {
      await page.send('Profiler.enable');
      await page.send('Profiler.setSamplingInterval', { interval: 200 });
      await page.send('Profiler.start');
    }
    if (TRACE && ENGINE === 'chrome') await page.startTrace();
    before = await page.metrics();
    startedAt = await page.run('performance.now()');
  });
  await part('switches', async () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    let last = '';
    const at = await page.run('performance.now()');
    const was = await page.metrics();
    const pagesWas = await page.run('speed.pages()');
    const askedWas = life.asked.count;
    for (let step = 0; step < SWITCHES; step += 1) {
      let view = VIEWS[Math.floor(next() * VIEWS.length)];
      if (view === last) view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
      last = view;
      const result = await page.run(view === 'search' ? `speed.route('tab:search', '#view=search', { quick: true })`
        : `speed.tab('${view}', { quick: true })`);
      stress.push({ kind: 'switch', ...result });
    }
    const switched = await page.run(`speed.framesBetween(${at}, performance.now(), ${DROP_MS})`);
    const now = await page.metrics();
    const pages = await page.run('speed.pages()');
    stress.push({ kind: 'switches', ...switched, mainMs: (now.TaskDuration - was.TaskDuration) * 1000,
      reads: life.asked.count - askedWas, unmounted: pages.unmounted - pagesWas.unmounted });
  });
  for (const [view, name] of [['people', 'scroll:people'], ['places', 'scroll:places'], ['days', 'scroll:day'],
    ['connectors', 'scroll:streams'], ['ask', 'scroll:ask']]) {
    await part(name, async () => {
      await page.run(`speed.tab('${view}')`);
      const was = await page.metrics();
      const scrolled = await page.run(`speed.scroll('${name}', 900, ${BUDGET_MS}, ${DROP_MS})`);
      const now = await page.metrics();
      if (!scrolled) throw new Error('no scroller');
      const { works, ...told } = scrolled;
      stress.push({ kind: 'scroll', ...told, work: spread(works), mainMs: (now.TaskDuration - was.TaskDuration) * 1000 });
    });
  }
  for (const [hash, name, selector, words] of [
    ['#view=people', 'type:people', '[data-people-find]', 'person 0012'],
    ['#view=places', 'type:places', '[data-pl-find]', 'synthetic place 00'],
    ['#view=connectors', 'type:streams', '#main .ck-page__bar input', 'whatsapp'],
    ['#view=search', 'type:search', '#main .sx-field input, #main input[type="search"]', 'synthetic hello'],
  ]) {
    await part(name, async () => {
      await page.run(`speed.route('to:${name}', ${JSON.stringify(hash)})`);
      const was = await page.metrics();
      const at = await page.run('performance.now()');
      const typed = await page.run(`speed.type('${name}', ${JSON.stringify(selector)}, ${JSON.stringify(words)})`);
      const now = await page.metrics();
      const framed = await page.run(`speed.framesBetween(${at}, performance.now(), ${DROP_MS})`);
      if (!typed) throw new Error(`no field ${selector}`);
      for (const key of typed.keys) samples.push({ temp: 'warm', ...key });
      stress.push({ kind: 'type', name, keys: typed.keys.length, settled: typed.settled === null ? null : typed.settled - at,
        ...framed, mainMs: (now.TaskDuration - was.TaskDuration) * 1000 });
    });
  }
  await part('fold:day', async () => {
    await page.run(`speed.route('to:fold', '#view=days&on=2026-09-28')`);
    const marked = await page.run(`(() => {
      const blocks = [...document.querySelectorAll('#main .dy-block--stay')].filter(block => block.querySelector(':scope > [data-d-stay]'));
      const largest = blocks.sort((one, other) => other.querySelectorAll('.dy-name').length - one.querySelectorAll('.dy-name').length)[0];
      if (largest) largest.dataset.speedFold = '';
      return Boolean(largest);
    })()`);
    if (!marked) throw new Error('no stay to fold');
    const was = await page.metrics();
    const askedWas = life.asked.count;
    const at = await page.run('performance.now()');
    for (let turn = 0; turn < FOLDS; turn += 1) {
      samples.push({ temp: 'warm', ...await page.run(`speed.click('fold', '#main [data-speed-fold] > [data-d-stay]')`) });
    }
    const now = await page.metrics();
    stress.push({ kind: 'fold', name: `fold:day (${FOLDS} opens and folds)`, ...await page.run(`speed.framesBetween(${at}, performance.now(), ${DROP_MS})`),
      reads: life.asked.count - askedWas, mainMs: (now.TaskDuration - was.TaskDuration) * 1000 });
  });
  await part('home busy', async () => {
    await page.run(`speed.tab('places')`);
    const was = await page.metrics();
    const at = await page.run('performance.now()');
    const askedWas = life.asked.count;
    for (let burst = 0; burst < BURSTS; burst += 1) {
      life.tell([{ kind: 'day', key: new Date(NEWEST).toISOString().slice(0, 10) }, { kind: 'extract', key: 'messages' }, { kind: 'extract', key: 'labels' },
        { kind: 'people', key: 'people' }, { kind: 'import', key: 'faces:synthetic/1' }, { kind: 'import', key: 'ask:synthetic/1' }]);
      await new Promise(done => setTimeout(done, BUSY_MS));
    }
    const now = await page.metrics();
    stress.push({ kind: 'busy', name: `home busy (${BURSTS} bursts)`, ...await page.run(`speed.framesBetween(${at}, performance.now(), ${DROP_MS})`),
      reads: life.asked.count - askedWas, mainMs: (now.TaskDuration - was.TaskDuration) * 1000 });
    for (const view of ['people', 'days', 'ask', 'connectors']) samples.push({ temp: 'warm', ...await page.run(`speed.tab('${view}')`), name: `after busy:${view}` });
  });
  await part('the whole stress', async () => {
    const after = await page.metrics();
    stress.push({ kind: 'all', ...await page.run(`speed.framesBetween(${startedAt}, performance.now(), ${DROP_MS})`),
      mainMs: (after.TaskDuration - before.TaskDuration) * 1000 });
    memory.push({ after: 'stress', ...pick(after) });
    if (TRACE && ENGINE === 'chrome') trace = await page.endTrace();
    if (PROFILE && ENGINE === 'chrome') profile = (await page.send('Profiler.stop')).profile;
  });
  for (const each of stress.filter(item => item.kind === 'switch')) {
    samples.push({ temp: 'warm', ...each, name: 'switch (200 random)' }, { temp: 'warm', ...each, name: `switch to ${each.name.slice(4)}` });
  }
  await page.close();
  life.close();
  await new Promise(done => life.server.close(() => done(undefined)));
  return { factor, launches, samples, stress: stress.filter(item => item.kind !== 'switch'), memory, failures, profile, trace };
}

/**
 * @param {any} run
 * @returns {string[]}
 */
function missedBudgets(run) {
  const at = `${run.factor}×`;
  /** @type {string[]} */
  const missed = run.failures.map((/** @type {any} */ each) => `${at} failed: ${JSON.stringify(each)}`);
  const samples = /** @type {any[]} */ (run.samples);
  const switches = spread(samples.filter(each => each.name === 'switch (200 random)').map(each => each.frame));
  if (!switches) missed.push(`${at} no switch measured`);
  else {
    if (switches.p50 > BUDGETS.switchP50Ms) missed.push(`${at} a switch's first frame at p50 ${ms(switches.p50)} ms, over ${ms(BUDGETS.switchP50Ms)}`);
    if (switches.p99 > BUDGETS.switchP99Ms) missed.push(`${at} a switch's first frame at p99 ${ms(switches.p99)} ms, over ${ms(BUDGETS.switchP99Ms)}`);
  }
  const flashed = samples.filter(each => each.temp === 'warm' && each.name.startsWith('tab:') && each.flash);
  if (flashed.length) missed.push(`${at} ${flashed.length} sections opened again showed a skeleton: ${[...new Set(flashed.map(each => each.name))].join(', ')}`);
  for (const field of ['people', 'places', 'streams']) {
    const keys = spread(samples.filter(each => each.name === `type:${field}:key`).map(each => each.frame));
    if (keys && keys.p99 > BUDGETS.typedP99Ms) missed.push(`${at} a key typed in ${field}'s field drawn at p99 ${ms(keys.p99)} ms, over ${ms(BUDGETS.typedP99Ms)}`);
  }
  for (const each of run.stress) {
    if (each.hangs) missed.push(`${at} ${each.hangs} hangs in ${each.name ?? each.kind}`);
    if (each.kind === 'scroll' && each.hitches) missed.push(`${at} ${each.hitches} scrolled frames over ${ms(BUDGET_MS)} ms in ${each.name}`);
    if (each.kind === 'busy' && each.reads > BURSTS) missed.push(`${at} ${each.reads} reads of the home in ${BURSTS} bursts on Places`);
    if (each.kind === 'switches' && each.reads) missed.push(`${at} ${each.reads} reads of the home while switching`);
    if (each.kind === 'fold' && each.reads) missed.push(`${at} ${each.reads} reads of the home while a stay opened and folded`);
    if (each.kind === 'fold' && each.drops) missed.push(`${at} ${each.drops} frames dropped while a stay opened and folded`);
    if (each.kind === 'switches' && each.unmounted) missed.push(`${at} ${each.unmounted} pages thrown away while switching`);
  }
  return missed;
}

/** @param {Record<string, number>} metrics */
const pick = metrics => metrics.footprint !== undefined ? { footprintMB: Math.round(metrics.footprint / 1e6) }
  : { heapMB: Math.round((metrics.JSHeapUsedSize ?? 0) / 1e6), nodes: metrics.Nodes, mainS: Math.round((metrics.TaskDuration ?? 0) * 100) / 100 };

/** @param {number[]} values */
function spread(values) {
  const sorted = values.filter(value => typeof value === 'number').sort((left, right) => left - right);
  if (!sorted.length) return null;
  const at = (/** @type {number} */ share) => sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] };
}

const ms = (/** @type {number | undefined | null} */ value) => value === null || value === undefined || Number.isNaN(value) ? '–'
  : value >= 100 ? String(Math.round(value)) : value.toFixed(1);
const row = (/** @type {any} */ values) => values ? `${ms(values.p50)} / ${ms(values.p95)} / ${ms(values.p99)} / ${ms(values.max)}` : '–';

/** @param {any[]} runs */
function table(runs) {
  const lines = [`# Page speed: ${LABEL}`, '', `${ENGINE === 'webkit' ? 'WebKit (WKWebView as the Mac app configures it), a 1440×900 window on this Mac\'s screen'
    : 'Chrome headless, 1440×900 at 2×'}; ${REPS} cold runs a factor; `
    + `the home's answers held ${JSON.stringify(HOME_MS)} ms. Times in ms as p50 / p95 / p99 / max. `
    + '`frame`: the main thread\'s time to the first frame (the act\'s script, style, layout and the frame\'s rendering, with any '
    + 'task that ran before the frame\'s end was told); `work`: the act\'s script, style and layout alone; '
    + '`shown`: when that frame was painted at 60 Hz; `settled`: to the last change in the page; `flash`: first frames that '
    + 'showed a skeleton; `late`: elements changed after the first frame (median).', ''];
  for (const run of runs) {
    lines.push(`## ${run.factor}×`, '');
    if (run.failures.length) lines.push(`Failed: ${run.failures.map((/** @type {any} */ each) => JSON.stringify(each)).join('; ')}`, '');
    lines.push('| launch | first usable frame | settled | flash | n |', '|---|---|---|---|---|');
    for (const temp of ['cold', 'warm']) {
      const shown = run.launches.filter((/** @type {any} */ each) => each.temp === temp);
      lines.push(`| ${temp} | ${row(spread(shown.map((/** @type {any} */ each) => each.firstFrame)))} | ${row(spread(shown.map((/** @type {any} */ each) => each.settled)))} | `
        + `${shown.filter((/** @type {any} */ each) => each.flash).length}/${shown.length} | ${shown.length} |`);
    }
    lines.push('', '| interaction | temp | frame | work | shown | settled | flash | late | n |', '|---|---|---|---|---|---|---|---|---|');
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const sample of run.samples) {
      const key = `${sample.name}|${sample.temp}`;
      groups.set(key, [...(groups.get(key) ?? []), sample]);
    }
    for (const [key, group] of [...groups.entries()].sort()) {
      const [name, temp] = key.split('|');
      const late = spread(group.map(each => each.late));
      lines.push(`| ${name} | ${temp} | ${row(spread(group.map(each => each.frame)))} | ${row(spread(group.map(each => each.work)))} | `
        + `${row(spread(group.map(each => each.shown)))} | `
        + `${row(spread(group.map(each => each.settled)))} | ${group.filter(each => each.flash).length}/${group.length} | `
        + `${late ? late.p50 : '–'} | ${group.length} |`);
    }
    lines.push('', '| stress | frames | scrolled frame work | hitches (>8.3 ms) | drops (>25 ms) | hangs (≥250 ms) | longest gap | main thread ms |',
      '|---|---|---|---|---|---|---|---|');
    for (const each of run.stress) {
      lines.push(`| ${each.kind === 'switches' ? `${SWITCHES} switches` : each.name ?? each.kind} | ${each.frames} | ${row(each.work)} | `
        + `${each.hitches ?? '–'} | ${each.drops} | ${each.hangs} | ${ms(each.longest)} | ${ms(each.mainMs)} |`);
    }
    const switches = run.stress.find((/** @type {any} */ each) => each.kind === 'switches');
    if (switches?.reads !== undefined) {
      lines.push('', `During the ${SWITCHES} switches the page read the home ${switches.reads} times and threw away `
        + `${switches.unmounted} pages.`);
    }
    const busy = run.stress.find((/** @type {any} */ each) => each.kind === 'busy');
    if (busy) lines.push('', `While the home was busy the page read it ${busy.reads} times.`);
    lines.push('', '| memory | script heap MB | web process footprint MB | elements | main thread s |', '|---|---|---|---|---|');
    for (const each of run.memory) {
      lines.push(`| ${each.after}${each.rep === undefined ? '' : ` (run ${each.rep + 1})`} | ${each.heapMB ?? '–'} | ${each.footprintMB ?? '–'} | `
        + `${each.nodes ?? '–'} | ${each.mainS ?? '–'} |`);
    }
    if (run.profile) {
      const top = heaviest(run.profile);
      lines.push('', `Heaviest functions of the stress, by self time (${Math.round(top.totalMs)} ms sampled):`, '',
        '| function | ms | share |', '|---|---|---|', ...top.top.map(each => `| \`${each.where}\` | ${each.ms} | ${each.share}% |`));
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** @param {string} at */
async function placeOpen(at) {
  if (!at) throw new Error('--place-open measures a running dashboard: --at <its address>, as http://127.0.0.1:4317');
  const folder = await mkdtemp(join(tmpdir(), 'dashboard-place-open-'));
  const page = ENGINE === 'webkit' ? await openWebKit() : await openChrome(join(folder, 'chrome'));
  /** @type {any[]} */
  const opened = [];
  /** @type {any[]} */
  const photos = [];
  /** @type {any[]} */
  const failures = [];
  try {
    for (let rep = 0; rep < REPS; rep += 1) {
      try {
        await page.open(`${at}/#view=places`);
        await page.run('speed.launch()');
        const named = option('places', '');
        const slugs = named ? named.split(',') : await page.run(`speed.placesListed(${PLACES_OPENED})`);
        for (const temp of ['cold', 'warm']) {
          for (const slug of slugs) {
            const result = await page.run(`speed.placeOpen(${JSON.stringify(slug)}, ${PLACE_OPEN_MS}, ${PLACE_DROP_MS})`);
            if (result) opened.push({ rep, temp, slug, ...result });
            else failures.push({ rep, temp, slug, error: 'no row in the list' });
            const viewed = result ? await page.run(`speed.viewerOpen(${JSON.stringify(slug)}, ${PLACE_OPEN_MS}, ${PLACE_DROP_MS})`) : null;
            if (viewed) photos.push({ rep, temp, slug, ...viewed });
          }
        }
      } catch (error) {
        failures.push({ rep, error: String(/** @type {Error} */ (error).message ?? error) });
      }
    }
  } finally {
    await page.close();
    await rm(folder, { recursive: true, force: true });
  }
  const lines = [`# A place opened: ${LABEL}`, '', `${ENGINE === 'webkit' ? 'WebKit (WKWebView as the Mac app configures it)'
    : 'Chrome headless, 1440×900 at 2×'} over ${at}; ${REPS} runs, each place cold (the page loaded afresh, its cache cleared) `
    + `then warm; frames from the click to ${PLACE_OPEN_MS} ms after.`, '',
  `| place | temp | frames | drops (>${PLACE_DROP_MS} ms) | hangs (≥250 ms) | longest gap ms |`, '|---|---|---|---|---|---|',
  ...opened.map(each => `| ${each.slug} | ${each.temp} | ${each.frames} | ${each.drops} | ${each.hangs} | ${Math.round(each.longest)} |`)];
  if (photos.length) lines.push('', `Its first photo opened in the photo viewer (\`viewer-open\`): frames from the click to its facts drawn.`, '',
    `| place | temp | facts | ms | frames | drops (>${PLACE_DROP_MS} ms) | hangs (≥250 ms) | longest gap ms |`, '|---|---|---|---|---|---|---|---|',
    ...photos.map(each => `| ${each.slug} | ${each.temp} | ${each.facts} | ${Math.round(each.ms)} | ${each.frames} | ${each.drops} | ${each.hangs} | ${Math.round(each.longest)} |`));
  if (failures.length) lines.push('', `Failed: ${failures.map(each => JSON.stringify(each)).join('; ')}`);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `${LABEL}.json`), JSON.stringify({ at, engine: ENGINE, opened, photos, failures }, null, 1));
  await writeFile(join(OUT, `${LABEL}.md`), `${lines.join('\n')}\n`);
  console.log(join(OUT, `${LABEL}.md`));
  if (failures.length) process.exitCode = 1;
}

async function pressLive() {
  const lane = option('server', 'home') === 'lane';
  const folder = await mkdtemp(join(tmpdir(), 'dashboard-press-'));
  /** @param {import('../lib/door.mjs').Door | null} door */
  const serving = async door => {
    const server = await createViewer({ door });
    await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
    return server;
  };
  const token = async () => process.env.LIFESTREAM_DOOR_TOKEN
    ?? (await readFile(join(process.env.LIFESTREAM_MACHINE_DIR ?? join(homedir(), 'Library', 'Application Support', 'Lifestream'), 'reader-token'), 'utf8')).trim();
  const reader = lane ? await token() : '';
  const own = await serving(lane ? openDoor({ url: process.env.LIFESTREAM_DOOR ?? 'http://127.0.0.1:4680', token: () => reader }) : null);
  const ownPort = /** @type {any} */ (own.address()).port;
  const gate = await openGate({ api: lane ? ownPort : 4317, files: ownPort });
  try {
    await pressRun(gate.url, lane ? 'the live home, through this checkout\'s server' : 'the live home, through the live dashboard', 'live', gate);
  } finally {
    await gate.close();
    await new Promise(done => own.close(() => done(undefined)));
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * @param {string} url
 * @param {string} where
 * @param {string} name
 * @param {{ told: () => object } | null} gate
 */
async function pressRun(url, where, name, gate) {
  await mkdir(OUT, { recursive: true });
  const loadStart = loadavg()[0].toFixed(1);
  const page = await openWebKit(`window.lifestreamHost.state.unit = '';`);
  try {
    const run = await pressPlan(page, url, Number(option('reps', '3')), line => console.log(line),
      option('parts', '').split(',').filter(Boolean), Date.now() + Number(option('most', '900')) * 1000);
    const stood = await page.act({ cmd: 'window' });
    const told = summary({ label: LABEL, where, reps: Number(option('reps', '3')), noisy: NOISY,
      machine: { loadStart, loadEnd: loadavg()[0].toFixed(1), cores: availableParallelism(), slots: NOISY ? 'one' : 'every',
        seen: !stood.occluded && stood.onActiveSpace }, run, gate: gate?.told() ?? null });
    const file = join(OUT, `${LABEL}-${name}`);
    const against = join(OUT, `${option('against', 'baseline')}-${name}.json`);
    const before = await readFile(against, 'utf8').then(JSON.parse, () => null);
    await writeFile(`${file}.json`, JSON.stringify(told, null, 1));
    await writeFile(`${file}.md`, report(told, before));
    if (process.argv.includes('--save-baseline')) {
      await writeFile(join(OUT, `baseline-${name}.json`), JSON.stringify(told, null, 1));
      await writeFile(join(OUT, `baseline-${name}.md`), report(told));
    }
    console.log(`${file}.md`);
    if (run.missing.length) console.log(`not measured: ${run.missing.length} (listed at the top of the report)`);
  } finally {
    await page.close();
  }
}

if (PRESS) {
  for (const factor of FACTORS) {
    const life = await serveLife(factor);
    await pressRun(life.url, `the synthetic life at ${factor}×`, `life-${factor}x`, null);
    life.close();
    await new Promise(done => life.server.close(() => done(undefined)));
  }
  await new Promise(done => viewer.close(() => done(undefined)));
  child.stdin?.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
  await new Promise(done => child.once('exit', done));
  await rm(scratch, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--serve')) {
  const life = await serveLife(FACTORS[0]);
  console.log(`The page over the synthetic life at ${FACTORS[0]}×: ${life.url}/#view=ask`);
  await new Promise(() => {});
}
await mkdir(OUT, { recursive: true });
const runs = [];
for (const factor of FACTORS) {
  console.log(`${factor}×: measuring`);
  const run = await measure(factor);
  if (run.profile) await writeFile(join(OUT, `${LABEL}-${factor}x.cpuprofile`), JSON.stringify(run.profile));
  if (run.trace) await writeFile(join(OUT, `${LABEL}-${factor}x.trace.json`), JSON.stringify(run.trace));
  runs.push({ ...run, trace: undefined });
  await writeFile(join(OUT, `${LABEL}.json`), JSON.stringify(runs.map(each => ({ ...each, profile: each.profile ? heaviest(each.profile) : null })), null, 1));
  await writeFile(join(OUT, `${LABEL}.md`), table(runs));
}
console.log(join(OUT, `${LABEL}.md`));
if (CHECK) {
  const missed = runs.flatMap(missedBudgets);
  for (const each of missed) console.log(`missed: ${each}`);
  console.log(missed.length ? `${missed.length} budgets missed` : 'every budget held');
  if (missed.length) process.exitCode = 1;
}
await new Promise(done => viewer.close(() => done(undefined)));
child.stdin?.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
await new Promise(done => child.once('exit', done));
await rm(scratch, { recursive: true, force: true });
