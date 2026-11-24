(() => {
  const QUIET_MS = 1_200;
  window.lifestreamHost = {
    kind: 'mac', version: 6,
    state: { inset: { left: 78, centre: 20 }, recorder: { signal: 'engaged', words: 'Recording' },
      reach: { state: 'answering', revision: 1, tone: null, title: null, line: null, meta: null, acts: [] }, sending: null,
      grants: [], needs: [], held: [], folder: null, unit: null, installed: [], browsers: [],
      pairing: null, ask_login: { chatgpt: { state: 'signed_in' }, claude: { state: 'absent' } }, connect_requests: null, never: null },
  };
  if (!window.webkit) window.webkit = { messageHandlers: { lifestream: { postMessage: async () => ({}) } } };

  const frames = [];
  let ticking = true;
  /** @type {((at: number) => void) | null} */
  let onFrame = null;
  (function tick(at) {
    frames.push(at);
    onFrame?.(at);
    if (ticking) requestAnimationFrame(tick);
  })(performance.now());
  performance.setResourceTimingBufferSize?.(10_000);

  const channel = new MessageChannel();
  const waiting = [];
  channel.port1.onmessage = () => waiting.shift()?.(performance.now());
  /**
   * @param {() => any} [look]
   * @returns {Promise<{ raf: number, after: number, saw: any }>}
   */
  const painted = look => new Promise(done => requestAnimationFrame(() => {
    const raf = performance.now();
    const saw = look?.();
    waiting.push(after => done({ raf, after, saw }));
    channel.port2.postMessage(0);
  }));
  const pause = ms => new Promise(done => setTimeout(done, ms));
  const main = () => document.getElementById('main');
  const find = selector => [...document.querySelectorAll(selector)].find(found => !found.closest('.main__section[hidden]')) ?? null;
  const heard = [];
  const Feed = window.EventSource;
  window.EventSource = class extends Feed {
    constructor(...asked) {
      super(...asked);
      this.addEventListener('message', event => {
        try { heard.push([performance.now(), JSON.parse(event.data).kind]); } catch { heard.push([performance.now(), '?']); }
      });
      this.addEventListener('reset', () => heard.push([performance.now(), 'reset']));
    }
  };
  const skeleton = () => Boolean(find('#main .ck-sk, #main .ck-loading'));
  const readingNow = () => Boolean(find('#main .ck-reading, #main .ck-loading'));

  const changes = { count: 0, last: 0, unmounted: 0, mounted: 0 };
  const watch = new MutationObserver(records => {
    for (const record of records) {
      changes.count += record.addedNodes.length + record.removedNodes.length + (record.type === 'characterData' ? 1 : 0);
      if (record.target === main()) {
        changes.unmounted += record.removedNodes.length;
        changes.mounted += record.addedNodes.length;
      }
    }
    changes.last = performance.now();
  });
  watch.observe(document, { childList: true, subtree: true, characterData: true });

  async function settle(since, most = 20_000) {
    for (;;) {
      await pause(100);
      const now = performance.now();
      const last = Math.max(changes.last, since);
      if (now - last >= QUIET_MS && !readingNow()) return last;
      if (now - since > most) return null;
    }
  }

  /**
   * @param {string} name
   * @param {() => void} act
   * @param {{ quick?: boolean }} [options]
   */
  async function step(name, act, { quick = false } = {}) {
    const start = performance.now();
    const before = changes.count;
    act();
    void document.documentElement.offsetHeight;
    const work = performance.now() - start;
    const next = await painted();
    const flash = skeleton();
    const atFrame = changes.count;
    const result = { name, work, frame: work + next.after - next.raf, shown: next.after - start, flash, settled: null, late: 0,
      changed: atFrame - before };
    if (!quick) {
      const last = await settle(start);
      result.settled = last === null ? null : last - start;
      result.late = changes.count - atFrame;
    }
    told.push(result);
    return result;
  }

  function framesBetween(from, to, dropMs) {
    const shown = frames.filter(at => at >= from && at <= to);
    const gaps = shown.slice(1).map((at, index) => at - shown[index]);
    return { frames: shown.length, drops: gaps.filter(gap => gap > dropMs).length,
      hangs: gaps.filter(gap => gap >= 250).length, longest: gaps.reduce((most, gap) => Math.max(most, gap), 0) };
  }

  const shownSection = () => document.querySelector('#main > .main__section:not([hidden])');
  const ready = () => {
    const section = shownSection();
    return Boolean(section?.firstElementChild) && !section.querySelector('.ck-reading, .ck-loading, .ck-sk:not(.cn-device__state .ck-sk)');
  };
  const moving = () => document.getAnimations().some(each => each.playState === 'running'
    && each.effect?.getComputedTiming?.().iterations !== Infinity);
  const tallest = () => {
    const section = shownSection();
    const boxes = [...(section?.querySelectorAll('*') ?? [])].filter(each => each.scrollHeight > each.clientHeight + 40
      && each.clientHeight > 120 && /auto|scroll/u.test(getComputedStyle(each).overflowY));
    return boxes.sort((one, other) => other.scrollHeight - other.clientHeight - (one.scrollHeight - one.clientHeight))[0] ?? section;
  };
  const load = { frame: 0, ready: 0 };
  onFrame = at => {
    if (!load.frame && main()?.firstElementChild && document.querySelector('.sidebar__item')) load.frame = at;
    if (!load.ready && ready()) load.ready = at;
  };

  /** @type {any} */
  let armed = null;
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(type, event => {
      if (armed?.on === type && armed.began === null) armed.begin(event);
    }, { capture: true });
  }

  function readsBetween(from, to) {
    const reads = performance.getEntriesByType('resource')
      .filter(each => each.startTime >= from - 1 && each.startTime <= to && new URL(each.name).pathname.startsWith('/api/')
        && new URL(each.name).pathname !== '/api/feed');
    return { reads: reads.length, readMs: reads.reduce((most, each) => Math.max(most, each.responseEnd - from), 0) };
  }

  async function follow(run) {
    let last = run.began;
    while (!run.over) {
      const { raf, after, saw } = await painted(() => {
        const met = run.result !== null || run.done();
        return { changed: run.changed, met, moving: met && moving(), marks: Object.keys(run.marks).filter(name => run.marks[name]()),
          flash: skeleton() };
      });
      if (run.over) return;
      run.longest = Math.max(run.longest, raf - last);
      run.frames += 1;
      last = raf;
      const shown = after - run.began;
      if (run.first === null && saw.changed) {
        run.first = shown;
        run.flash = saw.flash;
      }
      for (const name of saw.marks) {
        run.at[name] = shown;
        delete run.marks[name];
      }
      if (run.result === null && saw.met) run.result = shown;
      if (run.result !== null && (!saw.moving || shown - run.result > 2_000)) {
        run.rest = shown;
        run.end(false);
      }
    }
  }

  /** @type {any[]} */
  const told = [];
  const go = hash => () => {
    location.hash = hash;
  };
  const link = view => () => {
    const anchor = document.querySelector(`.sidebar__item[href="#view=${view}"]`);
    if (anchor) anchor.click();
    else location.hash = `#view=${view}`;
  };
  const scroller = () => /** @type {HTMLElement} */ (find('#main .ck-page__scroll, #main .ask-stage, #main [data-part="stage"]')
    ?? find('#main > .main__section') ?? main());

  window.speed = {
    frames,
    told,
    async launch() {
      const opened = performance.now();
      while (!(main()?.firstElementChild && document.querySelector('.sidebar__item'))) {
        if (performance.now() - opened > 60_000) throw new Error('no page drawn in a minute');
        await pause(1);
      }
      const first = await painted();
      const flash = skeleton();
      const last = await settle(0, 30_000);
      return { firstFrame: first.after, settled: last, flash };
    },
    tab: (view, options) => step(`tab:${view}`, link(view), options),
    route: (name, hash, options) => step(name, go(hash), options),
    click: (name, selector, options) => step(name, () => /** @type {HTMLElement} */ (find(selector))?.click(), options),
    has: selector => Boolean(find(selector)),
    /**
     * @param {string} name
     * @param {number} px
     * @param {number} budgetMs
     * @param {number} dropMs
     */
    async scroll(name, px, budgetMs, dropMs) {
      const pane = scroller();
      if (!pane) return null;
      const start = performance.now();
      const works = [];
      for (const way of [1, -1]) {
        for (let at = 0; at < 400; at += 1) {
          const was = pane.scrollTop;
          const began = performance.now();
          pane.scrollTop += way * px;
          void document.documentElement.offsetHeight;
          const done = performance.now();
          const next = await painted();
          works.push(done - began + next.after - next.raf);
          if (pane.scrollTop === was) break;
        }
      }
      const end = performance.now();
      const result = { name, height: pane.scrollHeight, steps: works.length, works,
        hitches: works.filter(work => work > budgetMs).length, ...framesBetween(start, end, dropMs) };
      told.push(result);
      return result;
    },
    /**
     * @param {string} name
     * @param {string} selector
     * @param {string} words
     */
    async type(name, selector, words) {
      const field = /** @type {HTMLInputElement | null} */ (find(selector));
      if (!field) return null;
      field.focus();
      const keys = [];
      for (const key of words) {
        keys.push(await step(`${name}:key`, () => {
          field.value += key;
          field.dispatchEvent(new InputEvent('input', { bubbles: true, data: key, inputType: 'insertText' }));
        }, { quick: true }));
      }
      const last = await settle(performance.now());
      return { keys, settled: last };
    },
    placesListed: count => [...document.querySelectorAll('#main .pl-card [data-pl-open]')].slice(0, count)
      .map(row => /** @type {HTMLElement} */ (row).dataset.plOpen),
    /**
     * @param {string} slug
     * @param {number} ms
     * @param {number} dropMs
     */
    async placeOpen(slug, ms, dropMs) {
      location.hash = '#view=places';
      await settle(performance.now());
      const row = /** @type {HTMLElement | null} */ (find(`#main .pl-card [data-pl-open="${CSS.escape(slug)}"]`));
      if (!row) return null;
      const start = performance.now();
      row.click();
      await pause(ms);
      const result = { name: `place-open:${slug}`, ...framesBetween(start, start + ms, dropMs) };
      told.push(result);
      return result;
    },
    async viewerOpen(slug, ms, dropMs) {
      const photo = /** @type {HTMLElement | null} */ (find('#main [data-pl-photo="0"]'));
      if (!photo) return null;
      const start = performance.now();
      photo.click();
      const viewer = () => /** @type {HTMLElement | null} */ (document.querySelector('.ck-viewer'));
      while (performance.now() - start < ms && viewer()?.dataset.facts !== 'read' && viewer()?.dataset.facts !== 'failed') await painted();
      const end = performance.now();
      const result = { name: `viewer-open:${slug}`, facts: viewer()?.dataset.facts ?? null, ms: end - start, ...framesBetween(start, end, dropMs) };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      if (viewer()) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await painted();
      told.push(result);
      return result;
    },
    key: (name, key, options) => step(name, () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }, options),
    framesBetween,
    painted,
    ready,
    moving,
    quiet() {
      ticking = false;
      onFrame = null;
    },
    /** @param {() => Element | null | undefined} found */
    aim(found) {
      const element = found();
      if (!element) return null;
      const within = () => {
        const { top, bottom } = element.getBoundingClientRect();
        return top >= 0 && bottom <= innerHeight;
      };
      if (!within()) element.scrollIntoView({ block: 'center' });
      const box = element.getClientRects()[0];
      if (!box) return null;
      const x = box.left + Math.min(box.width / 2, 40);
      const y = box.top + box.height / 2;
      const top = document.elementFromPoint(x, y);
      if (top && (top === element || top.contains(element) || element.contains(top))) return { x, y };
      return { covered: top ? `${top.tagName.toLowerCase()}.${String(top.className.baseVal ?? top.className).split(/\s+/u)[0]}` : 'nothing at that point' };
    },
    /**
     * @param {string} name
     * @param {() => boolean} done
     * @param {{ on?: string, most?: number, marks?: Record<string, () => boolean> }} [options]
     */
    arm(name, done, { on = 'pointerdown', most = 10_000, marks = {} } = {}) {
      const run = armed = { name, done, on, marks, at: {}, began: /** @type {number | null} */ (null), input: 0, first: null, result: null,
        rest: null, flash: false, longest: 0, frames: 0, changed: false, over: false, timedOut: false,
        /** @type {(timedOut: boolean) => void} */ end: () => {}, heard: /** @type {Promise<void>} */ (Promise.resolve()) };
      const seen = new MutationObserver(() => {
        run.changed = true;
      });
      seen.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
      const over = new Promise(done => {
        run.end = timedOut => {
          run.over = true;
          run.timedOut = timedOut;
          seen.disconnect();
          clearTimeout(timer);
          done(undefined);
        };
      });
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      run.heard = new Promise(heard => {
        run.begin = event => {
          const now = performance.now();
          run.began = event.timeStamp > 0 && event.timeStamp <= now ? event.timeStamp : now;
          run.input = now - run.began;
          timer = setTimeout(() => run.end(true), most);
          void follow(run);
          heard(undefined);
        };
      });
      run.finished = over;
    },
    async outcome() {
      const run = armed;
      armed = null;
      const heard = await Promise.race([run.heard.then(() => true), pause(2_000)]);
      if (!heard) {
        run.end(false);
        return { name: run.name, unheard: true };
      }
      await run.finished;
      const until = run.began + (run.result ?? run.first ?? 0);
      const result = { name: run.name, input: run.input, first: run.first ?? run.result, result: run.timedOut ? null : run.result,
        rest: run.rest, flash: run.flash, longest: run.longest, frames: run.frames, timedOut: run.timedOut, at: run.at,
        ...readsBetween(run.began, until) };
      told.push(result);
      return result;
    },
    async calm(quietMs = 250, most = 4_000) {
      const from = performance.now();
      for (;;) {
        await pause(50);
        const now = performance.now();
        if (now - Math.max(changes.last, from) >= quietMs && !readingNow() && !moving()) return true;
        if (now - from > most) return false;
      }
    },
    async opened(most = 30_000) {
      const from = performance.now();
      while (!load.ready && performance.now() - from < most) await pause(20);
      const shown = performance.getEntriesByType('resource');
      const paints = Object.fromEntries(performance.getEntriesByType('paint').map(each => [each.name, each.startTime]));
      const [navigation] = performance.getEntriesByType('navigation');
      const of = pattern => shown.filter(each => pattern.test(new URL(each.name).pathname));
      const scripts = of(/\.m?js$/u);
      const styles = of(/\.css$/u);
      const before = at => scripts.filter(each => each.responseEnd <= at);
      let rounds = 0;
      let round = -1;
      for (const each of [...scripts].sort((one, other) => one.startTime - other.startTime)) {
        if (each.startTime >= round) {
          rounds += 1;
          round = each.responseEnd;
        }
      }
      const endOf = list => list.reduce((most, each) => Math.max(most, each.responseEnd), 0);
      const lastBefore = endOf(before(load.frame || Infinity));
      return { scripts: scripts.length, styles: styles.length, rounds, scriptsEnd: endOf(scripts), stylesEnd: endOf(styles),
        scriptBytes: scripts.reduce((sum, each) => sum + (each.decodedBodySize || 0), 0),
        styleBytes: styles.reduce((sum, each) => sum + (each.decodedBodySize || 0), 0),
        firstContent: paints['first-contentful-paint'] ?? null,
        domInteractive: navigation?.domInteractive ?? null, loaded: navigation?.loadEventEnd ?? null,
        frame: load.frame || null, ready: load.ready || null, evaluate: load.frame ? load.frame - lastBefore : null };
    },
    framesStart() {
      const shown = [];
      const pane = tallest();
      pane.scrollTop = 0;
      const from = pane.scrollTop;
      let on = true;
      const tick = () => {
        shown.push(performance.now());
        if (on) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.speedFramesEnd = dropMs => {
        on = false;
        const gaps = shown.slice(1).map((at, index) => at - shown[index]);
        return { frames: shown.length, ms: shown.at(-1) - shown[0], moved: Math.abs(pane.scrollTop - from), height: pane.scrollHeight,
          drops: gaps.filter(gap => gap > dropMs).length, hangs: gaps.filter(gap => gap >= 250).length,
          longest: gaps.reduce((most, gap) => Math.max(most, gap), 0) };
      };
    },
    framesEnd: dropMs => window.speedFramesEnd(dropMs),
    feedSince: since => {
      const kinds = {};
      for (const [at, kind] of heard) if (at >= since) kinds[kind] = (kinds[kind] ?? 0) + 1;
      return kinds;
    },
    readsSince: since => {
      const kinds = {};
      for (const each of performance.getEntriesByType('resource')) {
        if (each.startTime < since || !each.name.includes('/api/') || each.name.includes('/api/feed')) continue;
        const route = new URL(each.name).pathname.split('/').slice(2, 4).join('/');
        kinds[route] = (kinds[route] ?? 0) + 1;
      }
      return kinds;
    },
    readsSoFar: () => performance.getEntriesByType('resource').filter(each => {
      const path = new URL(each.name).pathname;
      return path.startsWith('/api/') && path !== '/api/feed';
    }).length,
    scrollerAt() {
      const box = tallest()?.getBoundingClientRect();
      return box?.height > 0 ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
    },
    settle: since => settle(since ?? performance.now()),
    nodes: () => document.getElementsByTagName('*').length,
    pages: () => ({ unmounted: changes.unmounted, mounted: changes.mounted }),
  };
})();
