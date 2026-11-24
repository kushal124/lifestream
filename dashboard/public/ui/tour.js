// @ts-check
/** @import { Host } from '../lib/host.js' */
/** @import { Walk, WalkMoves } from './route.js' */
/** @import { SpotCard, SpotFace } from './kit/spotlight.js' */
import { ASK_SENT, spotlight } from './kit/index.js';

/** @typedef {{ title: string, line: string }} Words */

/** @typedef {'ask' | 'answer' | 'more' | 'devices' | 'agents' | 'people'} StepId */

/** @typedef {{ id: StepId, view: string, seg?: string, side?: boolean, ai?: boolean, hosted?: boolean }} Step */

export const QUESTION = 'What has my day looked like so far?';

export const READ_BOUND = 3000;

/** @type {readonly Step[]} */
export const STEPS = [
  { id: 'ask', view: 'ask' },
  { id: 'answer', view: 'ask', ai: true },
  { id: 'more', view: 'connectors', seg: 'not', side: true },
  { id: 'devices', view: 'connectors', side: true },
  { id: 'agents', view: 'agents', hosted: true },
  { id: 'people', view: 'people' },
];

export const WORDS = {
  ask: { title: 'Ask your first question', line: '' },
  chat: { title: 'This is Chat', line: 'Connect Claude or ChatGPT to ask anything about your life here. Timeline, People and '
    + 'Search work without it.' },
  seen: { title: 'Your first answer', line: 'Personal details were hidden before it was sent. Click the eye to see what your AI saw.' },
  answered: { title: 'Your first answer', line: 'Each number opens the message, email or photo it came from.' },
  failed: { title: 'No answer this time', line: 'Your question is saved in Chat. Try it again after the tour.' },
  more: { title: 'Add more connectors', line: 'Gmail, Google Calendar, Granola and more.' },
  devices: { title: 'Add your iPhone and Chrome', line: 'Your iPhone adds where you go and your health. Chrome brings in sites '
    + 'like ChatGPT and Claude. Each takes a minute.' },
  agents: { title: 'Connect an agent', line: 'Let Claude, ChatGPT, Instinct, Grok Bot or any MCP app read your Lifestream. You '
    + 'choose what each sees, and see everything it reads here.' },
  people: { title: 'Name your people and places', line: 'Lifestream joins each person across apps and finds the places you go. '
    + 'Naming them makes answers better.' },
};

export const SEE = 'See what your AI saw';

export const NOT_NOW = 'Not now';

/**
 * @param {{ hosted: boolean, ai: boolean }} walk
 * @returns {Step[]}
 */
export const walkSteps = ({ hosted, ai }) => STEPS.filter(step => (hosted || !step.hosted) && (ai || !step.ai));

/** @typedef {'running' | 'done' | 'failed'} Answer */

/**
 * @param {Element | null} scope
 * @returns {{ answer: Answer, eye: HTMLElement | null, turn: Element | null }}
 */
function answerOf(scope) {
  const turns = scope?.querySelectorAll('.ck-ask-turn') ?? [];
  const turn = turns[turns.length - 1] ?? null;
  const said = turn?.querySelector('.ck-answer:not(.is-pacing)') ?? null;
  const eye = /** @type {HTMLElement | null} */ (turn?.querySelector('[data-ck-seen-eye]') ?? null);
  const refused = turn?.querySelector('[data-ask-retry], .ck-answer > .ck-in-place') ?? scope?.querySelector('[data-part="notice"] .ck-in-place');
  const answer = said && !turn?.querySelector('.ck-answer > .ck-in-place') ? 'done' : refused ? 'failed' : 'running';
  return { answer, eye, turn };
}

/**
 * @param {object} parts
 * @param {Document} parts.doc
 * @param {Host | null} parts.host
 * @param {() => boolean} parts.covered
 * @returns {Walk}
 */
export function installTour({ doc, host, covered }) {
  const root = doc.documentElement;
  const hosted = host !== null;
  const login = host?.state.ask_login;
  let ai = !login || login.claude.state === 'signed_in' || login.chatgpt.state === 'signed_in';
  let steps = walkSteps({ hosted, ai });
  let at = 0;
  /** @type {ReturnType<typeof spotlight> | null} */
  let spot = null;
  /** @type {WalkMoves | null} */
  let moves = null;
  /** @type {HTMLTextAreaElement | null} */
  let offered = null;
  let sent = false;
  let waited = false;
  let bound = 0;
  let frame = 0;
  let led = false;
  let entering = false;
  let pressed = '';
  let over = '';
  /** @type {'' | 'always' | 'idle' | 'untyped'} */
  let wants = '';
  const said = doc.createElement('p');
  said.className = 'sr-only';
  said.setAttribute('aria-live', 'polite');
  doc.body.append(said);
  const watch = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(seek);
  });

  const bounds = () => {
    const top = 2 * (host?.state.inset?.centre ?? 0);
    const column = doc.querySelector('.column')?.getBoundingClientRect();
    return column?.width ? { top: Math.max(top, column.top), left: column.left, right: column.right, bottom: column.bottom }
      : { top, left: 0, right: root.clientWidth, bottom: root.clientHeight };
  };

  /** @param {Step} step */
  const scopeOf = step => doc.querySelector(`#main > .main__section--${step.view}`);

  const shownAsk = () => doc.querySelector('#main > .main__section--ask:not([hidden]) [data-tour="ask"]');

  /** @param {Element | null} hook */
  const fieldOf = hook => /** @type {HTMLTextAreaElement | null} */ (hook?.querySelector('textarea') ?? null);

  /**
   * @param {HTMLTextAreaElement} field
   * @param {string} words
   */
  function put(field, words) {
    field.value = words;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function withdraw() {
    if (offered?.value === QUESTION) put(offered, '');
    offered = null;
  }

  /** @param {Element | null} hook */
  function offer(hook) {
    const field = fieldOf(hook);
    if (!field || offered === field) return;
    withdraw();
    if (field.value) return;
    offered = field;
    put(field, QUESTION);
  }

  /** @param {number} by */
  function step(by) {
    let to = at + by;
    if (steps[to - 1]?.id === 'answer' && !sent) to += by;
    if (to > steps.length) return finish();
    led = true;
    if (to >= 1) moves?.to(to);
  }

  const forward = () => step(1);

  function send() {
    const field = fieldOf(shownAsk());
    if (!field?.value.trim() || field.disabled) return;
    field.form?.requestSubmit();
  }

  doc.addEventListener(ASK_SENT, () => {
    if (steps[at - 1]?.id !== 'ask') return;
    offered = null;
    sent = true;
    forward();
  });
  doc.addEventListener('input', event => {
    if (steps[at - 1]?.id === 'ask' && shownAsk()?.contains(/** @type {Node} */ (event.target)) && !frame) {
      frame = requestAnimationFrame(seek);
    }
  }, true);
  doc.defaultView?.addEventListener('resize', () => {
    if (!at) return;
    entering = true;
    if (!frame) frame = requestAnimationFrame(seek);
  });

  function seeIt() {
    const { eye } = answerOf(scopeOf(steps[at - 1]));
    if (eye && eye.getAttribute('aria-pressed') !== 'true') eye.click();
  }

  const lightUp = () => spotlight(doc.body, {
    bounds,
    lead: () => (steps[at - 1]?.id === 'ask' && ai && !sent ? send() : forward()),
    forward,
    back: () => step(-1),
    leave: () => moves?.end(''),
    pass: () => (steps[at - 1]?.id === 'answer' ? seeIt() : forward()),
    aside: () => moves?.end(''),
  });

  /**
   * @param {number} n
   * @param {Words} words
   * @param {{ lead?: string, pass?: string, aside?: string, held?: boolean, icon?: string }} [buttons]
   * @returns {SpotCard}
   */
  const cardOf = (n, words, { lead = n === steps.length ? 'Done' : 'Next', pass = '', aside = n < steps.length ? 'Skip tour' : '',
    held = false, icon = '' } = {}) => ({ ...words, lead, pass, aside, held, icon });

  /** @param {Element | null} scope */
  const blocksOf = scope => [...scope?.querySelectorAll('.ck-page__bar, .ck-page__main > *, .ck-page__side > *') ?? []];

  /**
   * @param {Step} step
   * @param {Element | null} scope
   * @returns {{ lit: Element | readonly Element[] | null, card: SpotCard | null, face: SpotFace }}
   */
  function faceOf(step, scope) {
    if (step.id === 'ask') {
      const hook = shownAsk();
      if (ai && !sent) offer(hook);
      const field = fieldOf(hook);
      const signIn = ai ? null : scope?.querySelector('[data-part="notice"]:not(:empty)') ?? null;
      const keeps = [...scope?.querySelectorAll('.ck-ask-home__heading, .ck-ask-starters, .ck-ask-thread > .ck-ask-turn > *') ?? []];
      return { lit: hook && signIn ? [hook, signIn] : hook, face: { keeps }, card: !ai ? cardOf(at, WORDS.chat)
        : sent ? cardOf(at, WORDS.ask)
          : cardOf(at, WORDS.ask, { lead: 'Send', icon: 'send', pass: NOT_NOW, held: !field?.value.trim() || field.disabled }) };
    }
    if (step.id === 'answer') {
      const dock = shownAsk();
      const { answer, eye, turn } = answerOf(scope);
      const face = { clears: dock ? [dock] : [], keeps: [...turn?.children ?? [], ...scope?.querySelectorAll('[data-part="notice"]') ?? []] };
      if (answer === 'running') return { lit: null, card: null, face };
      if (answer === 'done' && eye && dock) return { lit: eye, face: { ...face, start: true }, card: cardOf(at, WORDS.seen, { pass: SEE }) };
      return { lit: null, face, card: cardOf(at, answer === 'failed' ? WORDS.failed : WORDS.answered) };
    }
    const face = { side: Boolean(step.side), keeps: blocksOf(scope) };
    if (step.id === 'devices') return { lit: [...scope?.querySelectorAll('[data-tour="devices"] .cn-device--wanted') ?? []],
      face: { ...face, flush: true },
      card: cardOf(at, WORDS.devices) };
    if (step.id === 'agents') return { lit: scope?.querySelector('[data-tour="agents"] [data-ag-guides] .ck-ssection--card') ?? null,
      face, card: cardOf(at, WORDS.agents) };
    if (step.id === 'more') return { lit: scope?.querySelector('[data-tour="more"]') ?? null, face, card: cardOf(at, WORDS.more) };
    return { lit: null, face, card: cardOf(at, WORDS.people) };
  }

  function seek() {
    frame = 0;
    if (!at) return;
    if (over) return void spot?.show(null, null);
    const step = steps[at - 1];
    if (step.id === 'ask' && !spot && !waited && (shownAsk()?.getAttribute('data-read') ?? 'reading') === 'reading') {
      bound ||= window.setTimeout(() => {
        bound = 0;
        waited = true;
        seek();
      }, READ_BOUND);
      return;
    }
    const read = shownAsk()?.getAttribute('data-read') ?? 'reading';
    if (step.id === 'ask' && at === 1 && read !== 'reading') decide(Boolean(shownAsk()?.hasAttribute('data-tour-ready')));
    const light = spot ??= lightUp();
    const { lit, card, face } = faceOf(step, scopeOf(step));
    const first = lit === null ? null : 'length' in lit ? lit[0] ?? null : lit;
    const eyed = step.id === 'answer' ? first?.getAttribute('aria-pressed') ?? '' : '';
    if (eyed !== pressed) {
      pressed = eyed;
      entering ||= Boolean(first);
    }
    light.show(lit, card, face);
    if (entering && first) {
      light.reveal();
      entering = false;
    }
    if (first) for (const moving of first.getAnimations()) moving.finished.then(() => spot?.measure(), () => {});
    if (!card) {
      if (wants === 'always') wants = 'untyped';
      return;
    }
    const held = doc.activeElement;
    const free = !held || held === doc.body || Boolean(held.closest('.ck-spot'));
    const typing = (held instanceof HTMLTextAreaElement || held instanceof HTMLInputElement) && held.value.trim() !== '';
    if (wants === 'always' || (wants === 'idle' && free) || (wants === 'untyped' && !typing)) light.focus();
    wants = '';
    const heard = `${card.title}, ${at} of ${steps.length}`;
    if (said.textContent !== heard) said.textContent = heard;
  }

  /** @param {boolean} ready */
  function decide(ready) {
    if (ready === ai) return;
    ai = ready;
    steps = walkSteps({ hosted, ai });
  }

  function end() {
    withdraw();
    at = 0;
    sent = false;
    waited = false;
    clearTimeout(bound);
    bound = 0;
    watch.disconnect();
    cancelAnimationFrame(frame);
    frame = 0;
    led = false;
    entering = false;
    pressed = '';
    over = '';
    wants = '';
    void spot?.close();
    spot = null;
  }

  function finish() {
    moves?.end('ask');
  }

  host?.follow(() => spot?.measure());

  return {
    get stops() {
      return steps;
    },
    show(n, told, flow = '') {
      moves = told;
      if (!n) return end();
      if (covered()) return told.end('');
      if (n !== at) {
        wants = at === 0 || led ? 'always' : 'idle';
        entering = true;
      } else if (over && !flow) wants = 'idle';
      over = flow;
      led = false;
      at = n;
      const step = steps[n - 1];
      if (step.id !== 'ask') withdraw();
      watch.disconnect();
      const scope = scopeOf(step);
      if (scope) {
        watch.observe(scope, { subtree: true, childList: true, attributes: true,
          attributeFilter: ['class', 'hidden', 'disabled', 'aria-pressed', 'data-read', 'data-tour-ready'] });
      }
      if (step.id === 'ask') {
        const field = fieldOf(shownAsk());
        if (field) watch.observe(field, { attributes: true, attributeFilter: ['disabled'] });
      }
      cancelAnimationFrame(frame);
      seek();
    },
  };
}
