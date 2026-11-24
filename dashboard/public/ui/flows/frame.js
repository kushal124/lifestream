// @ts-check
/** @import { Host, HostAct, HostReply } from '../../lib/host.js' */
/** @import { ReportReader } from '../../lib/report.js' */
/** @import { Flow, FlowId, FlowSession } from './model.js' */
import { refusalOf } from '../../lib/host.js';
import { actWords, afterRecovery } from '../../lib/reach.js';
import { applyGeometry } from '../geometry.js';
import {
  arrivals, arrive, checkPanelHere, checkPanelTravel, installFilterMenus, reading, showCopied,
} from '../kit/index.js';
import { browserOf, browserSites, ELSEWHERE, flowOf, MODEL_ITEMS, modelOf, phoneOf, PLAN_IDS, sessionOf, SIGNING_MS }
  from './model.js';
import { flowDialog } from './view.js';

const PATIENCE_MS = 3000;

/**
 * @param {Host | null} host
 * @param {Pick<FlowSession, 'busy' | 'failure'>} session
 * @param {{ draw: () => void, reports: ReportReader, name: string }} frame
 */
export function actRunner(host, session, { draw, name }) {
  /**
   * @param {HostAct} message
   * @param {string} key
   * @returns {Promise<HostReply | null>}
   */
  async function act(message, key) {
    if (!host) {
      session.failure = { key, words: ELSEWHERE };
      draw();
      return null;
    }
    const busy = session.busy;
    const live = () => busy === session.busy;
    const held = busy.has(key);
    busy.add(key);
    session.failure = null;
    draw();
    const revision = host.state.reach?.revision ?? 0;
    try {
      const reply = await host.act(message);
      return live() ? reply : null;
    } catch (error) {
      if (live()) {
        const refusal = refusalOf(error);
        const failure = { key, words: actWords(refusal) };
        session.failure = failure;
        if (refusal.said === 'not-sent') {
          afterRecovery(host, revision, () => {
            if (session.failure !== failure) return;
            session.failure = null;
            draw();
          });
        }
      }
      return null;
    } finally {
      if (!held) busy.delete(key);
      if (live()) draw();
    }
  }
  /**
   * @param {HostAct} message
   * @returns {Promise<void>}
   */
  const quiet = message => host ? host.act(message).then(() => {}, error => {
    console.warn(`${name}: the app refused ${message.act}:`, error instanceof Error ? error.message : error);
  }) : Promise.resolve();
  return { act, quiet };
}

/** @typedef {ReturnType<typeof actRunner>} Runner */

/** @param {string} arg */
const subscription = arg => /** @type {import('./model.js').PlanId} */ (arg);

/** @typedef {{ then?: string, make?: boolean, onward?: (() => void) | null, opened?: Set<string>, models?: import('./model.js').ModelItem[] }} Opening */

/**
 * @param {object} parts
 * @param {FlowSession} parts.session
 * @param {ReportReader} parts.reports
 * @param {Runner} parts.runner
 * @param {() => void} parts.draw
 * @param {() => boolean} parts.shown
 * @param {() => ParentNode | null} parts.root
 * @param {() => void} [parts.leave]
 * @param {(words: string) => void} [parts.say]
 * @param {() => import('./model.js').Seen} [parts.seen]
 */
export function flowFrame({ session, reports, runner, draw, shown, root, leave = () => {}, say = () => {},
  seen = () => reports.seen }) {
  /** @type {FlowId | ''} */
  let id = '';
  /** @type {Flow['hold']} */
  let holding = '';
  /** @type {(() => void) | null} */
  let onward = null;
  let settling = 0;
  let said = '';
  let wake = 0;
  let wakeAt = /** @type {number | null} */ (null);
  /** @param {Flow['hold']} wanted */
  function hold(wanted) {
    if (wanted === holding) return;
    if (holding === 'pairing' || holding === 'connect-wait') void runner.quiet({ act: holding, do: 'close' });
    if (holding === 'sign-in') {
      const model = modelOf(seen());
      for (const of of PLAN_IDS) {
        if (!session.models.includes(of)) continue;
        if (model[of].state === 'fetching' || model[of].state === 'signing_in' || session.busy.has(`connect:${of}`)) {
          void runner.quiet({ act: 'ask-login', do: 'cancel', of });
        }
      }
    }
    holding = wanted;
    if (wanted === 'pairing' || wanted === 'connect-wait') void runner.quiet({ act: wanted, do: 'open' });
  }

  const pairedNow = () => new Set(phoneOf(seen()).phones.flatMap(phone => phone.pass === null ? [] : [phone.pass]));

  let knocking = false;

  function knocked() {
    const { state, report } = seen();
    if (!knocking || !report) return;
    knocking = false;
    const knock = report.needs.find(need => need.acts.some(act => act.do === 'browser'));
    const asking = knock?.acts.find(act => act.do === 'browser');
    if (!knock || asking?.do !== 'browser') return;
    const station = state?.browsers?.find(each => each.id === asking.of || each.name === asking.of) ?? null;
    session.knock = { at: Date.now(), since: knock.since_ms, browser: station?.name ?? asking.of };
    if (station) session.chosen = station.id;
  }

  const fresh = () => Object.assign(session, sessionOf(session.hosted, session.frame));

  /**
   * @param {FlowId} next
   * @param {Opening} [opening]
   */
  function open(next, { then = '', make = false, onward: after = null, opened = new Set(), models = [...MODEL_ITEMS] } = {}) {
    close();
    id = next;
    const { report } = seen();
    Object.assign(fresh(), { then, opened, models, before: session.frame === 'dialog' && report ? pairedNow() : null });
    knocking = next === 'browser';
    knocked();
    onward = after;
    draw();
    if (make) void press('vault-open', '', null);
  }

  function close() {
    if (!id) return;
    hold('');
    window.clearTimeout(settling);
    window.clearTimeout(wake);
    settling = 0;
    wakeAt = null;
    onward = null;
    said = '';
    fresh();
    id = '';
  }

  /** @returns {Flow | null} */
  const current = () => id ? flowOf(id, seen(), session) : null;

  /** @returns {Flow | null} */
  function tick() {
    if (!id) return null;
    const { report } = seen();
    if (session.frame === 'dialog' && session.before === null && report) session.before = pairedNow();
    knocked();
    const another = session.another;
    if (another && [...pairedNow()].some(install => !another.has(install))) session.another = null;
    const flow = flowOf(id, seen(), session);
    hold(shown() ? flow.hold : '');
    if (flow.wake !== wakeAt) {
      window.clearTimeout(wake);
      wakeAt = flow.wake;
      if (wakeAt !== null) wake = window.setTimeout(draw, Math.max(0, wakeAt - Date.now()) + 50);
    }
    if (flow.said !== said) {
      said = flow.said;
      if (said) say(said);
    }
    if (flow.holds && onward && !settling && document.hasFocus()) {
      settling = window.setTimeout(() => {
        settling = 0;
        const after = onward;
        if (!after || !id || !flowOf(id, seen(), session).holds || !document.hasFocus()) return void draw();
        onward = null;
        after();
      }, PATIENCE_MS);
    }
    return flow;
  }

  /**
   * @param {'done' | 'back' | 'escape' | 'close'} how
   * @param {() => void} [leaving]
   */
  function tryLeave(how, leaving = leave) {
    const flow = current();
    if (!flow) return true;
    const request = browserOf(seen(), session).request;
    if (flow.question && request && (how === 'escape' || how === 'back' || how === 'close')) {
      session.closed.add(request.browser);
      draw();
      return false;
    }
    if (how === 'done' && flow.holds && onward) {
      const after = onward;
      onward = null;
      window.clearTimeout(settling);
      settling = 0;
      after();
      return true;
    }
    leaving();
    return true;
  }

  async function sendCode() {
    const code = session.code.trim();
    const attempt = modelOf(seen()).claude.attempt;
    if (!code || !attempt) {
      session.failure = { key: 'send-code', words: 'Paste the code Anthropic’s page shows.' };
      return draw();
    }
    if (await runner.act({ act: 'ask-login', do: 'code', of: 'claude', attempt, code }, 'send-code')) session.code = '';
    draw();
  }

  /**
   * @param {string} what
   * @param {string} arg
   * @param {HTMLElement | null} target
   */
  async function press(what, arg, target) {
    const data = target?.dataset ?? {};
    const state = seen().state;
    switch (what) {
      case 'pair-another':
        session.another = pairedNow();
        session.part = 'pair';
        return draw();
      case 'phone-app':
      case 'pair-code': {
        const part = what === 'phone-app' ? 'app' : 'pair';
        session.part = part;
        draw();
        const turn = root()?.querySelector(`[data-flow="${what === 'phone-app' ? 'pair-code' : 'phone-app'}"]`);
        if (turn instanceof HTMLElement) return turn.focus();
        const name = /** @type {HTMLElement | null | undefined} */ (root()?.querySelector(
          `[data-part="${part}"] .ck-grow__name`));
        if (name) name.tabIndex = -1;
        return name?.focus();
      }
      case 'vault-open': return void await runner.act({ act: 'vault', do: 'open' }, 'vault-open');
      case 'vault-unlock': return void await runner.act({ act: 'vault', do: 'unlock' }, 'vault-unlock');
      case 'connect': return void await runner.act({ act: 'ask-login', do: 'start', of: subscription(arg) }, `connect:${arg}`);
      case 'sign-out': return void await runner.act({ act: 'ask-login', do: 'sign_out', of: subscription(arg) }, `sign-out:${arg}`);
      case 'cancel-login':
        session.signing = { attempt: '', until: 0 };
        return void await runner.act({ act: 'ask-login', do: 'cancel', of: subscription(arg) }, `cancel-login:${arg}`);
      case 'code-field':
        session.code = arg;
        return;
      case 'send-code': return sendCode();
      case 'copy-code': {
        const code = modelOf(seen()).chatgpt.code;
        if (!code) return;
        try {
          await navigator.clipboard.writeText(code);
          if (session.failure?.key === 'copy-code') {
            session.failure = null;
            draw();
          }
          showCopied(/** @type {HTMLElement} */ (root()?.querySelector('[data-flow="copy-code"]') ?? target));
        } catch {
          session.failure = { key: 'copy-code', words: 'Lifestream couldn’t copy the code. Select it and copy it.' };
          draw();
        }
        return;
      }
      case 'open-page': {
        const signing = { attempt: `${arg}:${modelOf(seen())[subscription(arg)].attempt ?? ''}`, until: Date.now() + SIGNING_MS };
        session.signing = signing;
        if (!(await runner.act({ act: 'open', what: 'site', url: data.url ?? '' }, `open-page:${arg}`)) && session.signing === signing) {
          session.signing = { attempt: '', until: 0 };
          draw();
        }
        return;
      }
      case 'add-browser': {
        const browser = state?.browsers?.find(each => each.id === session.chosen) ?? state?.browsers?.[0];
        if (!browser) return;
        return void await runner.act({ act: 'open', what: 'browser-store', browser: browser.id }, 'add-browser');
      }
      case 'connect-site': {
        const site = browserSites(seen(), session.connected).find(each => each.id === arg);
        if (!site || (site.state !== 'in' && site.state !== 'withheld') || !site.connect) return;
        if (!await runner.act(site.connect, `connect-site:${arg}`)) return draw();
        const pressed = session.connected;
        pressed.add(arg);
        reports.whenAnswered(() => {
          pressed.delete(arg);
          draw();
        });
        void reports.read();
        return draw();
      }
      case 'open-site':
        if (await runner.act({ act: 'open', what: 'site', url: data.url ?? '', browser: data.browser ?? '' },
          `open-site:${arg}`)) session.opened.add(arg);
        return draw();
      case 'connect-open':
        session.closed.delete(data.browser ?? '');
        return draw();
      case 'connect-yes': {
        const asked = state?.connect_requests?.find(each => each.id === data.id);
        const from = state?.browsers?.find(each => each.name === asked?.browser);
        if (!(await runner.act({ act: 'connect-answer', id: data.id ?? '', allow: true }, what))) return;
        if (from) session.chosen = from.id;
        draw();
        return void await reports.read();
      }
      case 'done': case 'back': case 'close': return void tryLeave(what);
    }
  }

  window.addEventListener('focus', () => {
    if (!id || !shown()) return;
    if (id === 'browser') void reports.read();
    draw();
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    holding = '';
    if (id) draw();
  });

  return {
    open,
    close,
    current,
    tick,
    tryLeave,
    press,
    get id() {
      return id;
    },
    /** @param {string} value */
    picked(value) {
      session.chosen = value;
      draw();
    },
  };
}

/** @typedef {ReturnType<typeof flowFrame>} FlowFrame */

/**
 * @param {HTMLElement} root
 * @param {() => FlowFrame | null} frame
 */
export function installFlow(root, frame) {
  root.addEventListener('click', event => {
    const target = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-flow]'));
    const flow = frame();
    if (!target || !flow?.id || target.matches('input, [type="submit"]')) return;
    const key = target.dataset.flow ?? '';
    const cut = key.indexOf(':');
    void flow.press(cut < 0 ? key : key.slice(0, cut), cut < 0 ? '' : key.slice(cut + 1), target);
  });
  root.addEventListener('input', event => {
    const field = event.target;
    if (field instanceof HTMLInputElement && field.dataset.flow === 'code-field') {
      void frame()?.press(field.dataset.flow, field.value, field);
    }
  });
  root.addEventListener('submit', event => {
    const form = /** @type {HTMLFormElement} */ (event.target);
    if (form.dataset.flowForm !== 'code') return;
    event.preventDefault();
    void frame()?.press('send-code', '', form);
  });
}

/** @param {FlowFrame} frame */
export const leavesBack = frame => !frame.id || frame.tryLeave('back', () => {});

const KEYS = ['data-cn-open', 'data-cn-do', 'data-cn-close', 'data-cn-add', 'data-cn-field', 'data-cn-date', 'data-flow', 'data-ob',
  'data-ck-choice', 'data-pl-stopped', 'data-pl-why-back', 'data-pl-unmine', 'data-pl-row', 'data-people-business',
  'data-people-businesses-mark', 'data-people-businesses-undo', 'data-people-businesses-again', 'data-people-photo',
  'data-people-photos', 'aria-controls'];

/** @param {Element | null} element */
export function focusKey(element) {
  if (!(element instanceof HTMLElement)) return '';
  if (element.classList.contains('ck-tip__mark')) {
    return `[aria-describedby="${CSS.escape(element.getAttribute('aria-describedby') ?? '')}"]`;
  }
  if (element.getAttribute('role') === 'tabpanel' && element.id) return `#${CSS.escape(element.id)}`;
  const capsule = element.closest('.ck-fmenu')?.querySelector('.ck-fmenu__btn')?.getAttribute('aria-controls');
  if (capsule) return `[aria-controls="${CSS.escape(capsule)}"]`;
  const name = KEYS.find(key => element.hasAttribute(key));
  if (!name) return '';
  const id = element.dataset.id;
  return `[${name}="${CSS.escape(element.getAttribute(name) ?? '')}"]${id ? `[data-id="${CSS.escape(id)}"]` : ''}`;
}

/**
 * @param {Element} standing
 * @param {Element} fresh
 */
function takeAttributes(standing, fresh) {
  for (const { name } of [...standing.attributes]) if (!fresh.hasAttribute(name)) standing.removeAttribute(name);
  for (const { name, value } of [...fresh.attributes]) standing.setAttribute(name, value);
}

/**
 * @param {HTMLElement} into
 * @param {string} markup
 * @param {{ keep?: string, scroll?: boolean }} [options]
 */
export function put(into, markup, { keep = '', scroll = true } = {}) {
  const active = document.activeElement;
  const key = into.contains(active) ? focusKey(active) : '';
  const typing = active instanceof HTMLInputElement && into.contains(active) ? active : null;
  const caret = typing?.type === 'text' ? [typing.selectionStart, typing.selectionEnd] : null;
  const standing = keep ? into.querySelector(keep) : null;
  const next = document.createElement('template');
  next.innerHTML = markup;
  const fresh = standing ? next.content.querySelector(keep) : null;
  if (standing && fresh) {
    const said = arrivals(standing);
    const here = checkPanelHere(standing);
    const scrolled = scroll ? standing.querySelector('.ck-dialog__body')?.scrollTop ?? 0 : 0;
    const drawnAs = typing && key ? fresh.querySelector(key) : null;
    if (typing && drawnAs && typing.value === (drawnAs.getAttribute('value') ?? '')) {
      takeAttributes(typing, drawnAs);
      drawnAs.replaceWith(typing);
    }
    const switches = new Map([...standing.querySelectorAll('[role="switch"][aria-label]')].reverse()
      .map(each => [each.getAttribute('aria-label'), each]));
    for (const drawn of fresh.querySelectorAll('[role="switch"][aria-label]')) {
      const was = switches.get(drawn.getAttribute('aria-label'));
      if (!was) continue;
      switches.delete(drawn.getAttribute('aria-label'));
      takeAttributes(was, drawn);
      drawn.replaceWith(was);
    }
    const keeps = new Map([...standing.querySelectorAll('[data-keep]')].map(each => [each.getAttribute('data-keep'), each]));
    for (const drawn of fresh.querySelectorAll('[data-keep]')) {
      const was = keeps.get(drawn.getAttribute('data-keep'));
      if (!was) continue;
      keeps.delete(drawn.getAttribute('data-keep'));
      drawn.replaceWith(was);
    }
    takeAttributes(standing, fresh);
    standing.replaceChildren(...fresh.childNodes);
    arrive(standing, said);
    checkPanelTravel(standing, here);
    const body = standing.querySelector('.ck-dialog__body');
    if (body) body.scrollTop = scrolled;
    standing.classList.toggle('is-scrolled', (body?.scrollTop ?? 0) > 0);
  } else into.replaceChildren(next.content);
  const again = key ? /** @type {HTMLElement | null} */ (into.querySelector(key)) : null;
  if (again && again !== document.activeElement) again.focus({ preventScroll: true });
  if (caret && again instanceof HTMLInputElement && again.type === 'text') again.setSelectionRange(caret[0], caret[1]);
}

/**
 * @param {HTMLElement} container
 * @param {Host} host
 * @param {ReportReader} reports
 * @param {{ leave: () => void, inert: (on: boolean) => void }} parts
 * @returns {{ show: (id: string) => void, leaves: () => boolean }}
 */
export function flowOverlay(container, host, reports, { leave, inert }) {
  const session = sessionOf(true, 'dialog');
  /** @type {HTMLElement | null} */
  let opener = null;
  let drawn = '';
  const runner = actRunner(host, session, { draw: () => draw(), reports, name: 'flow' });
  const frame = flowFrame({ session, reports, runner, draw: () => draw(),
    shown: () => true, root: () => container, leave, say: words => {
      const live = container.querySelector('[data-flow-said]');
      if (live) live.textContent = words;
    } });

  function draw() {
    const flow = frame.tick();
    reading(container, flow !== null && reports.seen.report === null);
    const markup = flow ? flowDialog(flow) : '';
    if (markup === drawn) return;
    const into = container.querySelector('[data-flow-dialog]');
    if (!(into instanceof HTMLElement)) return;
    put(into, markup, { keep: drawn !== '' && markup !== '' ? '.ck-dialog' : '' });
    applyGeometry(into);
    drawn = markup;
  }

  container.innerHTML = '<div data-flow-dialog></div><p class="sr-only" aria-live="polite" data-flow-said></p>';
  installFlow(container, () => frame);
  installFilterMenus(container, (_, value) => frame.picked(value));
  container.addEventListener('click', event => {
    if (/** @type {Element} */ (event.target).matches('[data-scrim]')) frame.tryLeave('close');
  });
  document.addEventListener('keydown', event => {
    if (!frame.id || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      frame.tryLeave('escape');
    } else if (event.key === 'Enter') primary(container, event);
  });
  host.follow(() => draw());
  reports.follow(() => {
    if (frame.id) draw();
  });

  return {
    show(id) {
      if (!id) {
        frame.close();
        draw();
        inert(false);
        opener?.focus();
        opener = null;
        return;
      }
      const flow = /** @type {FlowId} */ (id);
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      inert(true);
      frame.open(flow);
      void reports.read();
      focusFirst(container);
    },
    leaves: () => leavesBack(frame),
  };
}

const PRIMARY = '.ck-dialog__foot .ck-btn--primary:not(:disabled)';

/**
 * @param {ParentNode} root
 * @param {KeyboardEvent} event
 * @param {string} [selector]
 */
export function primary(root, event, selector = PRIMARY) {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLButtonElement
    || active instanceof HTMLAnchorElement) return;
  const press = /** @type {HTMLElement | null} */ (root.querySelector(selector));
  if (!press) return;
  event.preventDefault();
  press.click();
}

/** @param {ParentNode} root */
export function focusFirst(root) {
  const isStream = root.querySelector('[data-cn-close]');
  if (isStream) {
    const surface = /** @type {HTMLElement} */ (root.querySelector('.ck-dialog'));
    surface.tabIndex = -1;
    surface.focus({ preventScroll: true });
    return;
  }
  const first = ['.fl-body :is(button, input):not(:disabled)', '.ck-dialog__foot :is(button, a[href]):not(:disabled)',
    '[data-flow="back"]'].map(selector => /** @type {HTMLElement | null} */ (root.querySelector(selector))).find(Boolean);
  if (first) return first.focus();
  const dialog = /** @type {HTMLElement | null} */ (root.querySelector('.ck-dialog'));
  if (!dialog) return;
  dialog.tabIndex = -1;
  dialog.focus();
}


