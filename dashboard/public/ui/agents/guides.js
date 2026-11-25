// @ts-check
/** @import { AccessDraft, AccessView, AgentAddress, AgentGuides, AnswerReply, Bolded, Connected, DraftAccess, EditRequest, Guide, GuideAddress, GuideLink, GuideStep, GuideValue, KeyApp, KeyRequest, MadeKey, SignIn, SignInRead } from '../../types.js' */
/** @import { Host, HostAct, HostState } from '../../lib/host.js' */
/** @import { Detail, DetailPart, PanelRow } from '../connectors/dialog.js' */
/** @import { Act, Do } from '../connectors/words.js' */
/** @import { AgentReads, Seen } from './detail.js' */
import { signInAnswer } from '../../lib/agents.js';
import { draftEditor } from '../../lib/editor.js';
import { phraseWords } from '../../lib/words.js';
import { panelOf, rowOf } from '../connectors/dialog.js';
import { accessRows, agentDialog, backLabel, bare, codePart, CONNECT_ID, controlFoot, detailOf, NAME_FIELD, pageInside, plainly } from './detail.js';
import { AGENT, GUIDE, HOST_SLOT, NAME_SLOT, PAGE } from './words.js';

export const GUIDE_PAGE = 'guide:';
export const FINISHING_MS = 2_000;

/** @typedef {'here' | 'later' | 'done' | 'plain'} StepMark */
/** @typedef {'checking' | 'fix' | 'check' | 'turn-on' | null} AddressMark */
/** @typedef {{ copied: boolean, setup: boolean, returned: boolean, shown: string | null, outcome: 'wrong' | 'denied' | 'finishing' | null, editing: boolean }} SignInDialog */
/** @typedef {{ id: string, app: string | null, host: string | null, at_ms: number }} Waiting */
/** @typedef {{ id: string, state: SignInRead['state'], reader: string | null }} Read */
/** @typedef {{ state: 'on' | 'off' } | { state: 'fix', act: unknown }} AddressSeen */
/** @typedef {{ address: AddressMark, head: 'need' | 'short' | 'done', marks: StepMark[], shows: string[], lines: string[], signin: string | null, other: string | null, foot: string[] }} SignInState */
/** @typedef {{ linked: boolean, named: string | null, setup: boolean, making: boolean, made: 'refused' | 'unknown' | 'made' | null, done: boolean }} KeyDialog */
/** @typedef {{ address: AddressMark, head: 'need' | 'done', marks: StepMark[], shows: string[], lines: string[], foot: string[] }} KeyState */

/**
 * @typedef {{ copy: { address: boolean } } | { fix: 'turn-on' | 'check' | 'tailscale' } | { fix: 'web', url: string } | { open: string } | { app: 'Messages' }
 *   | { linked: true } | { make: true } | { done: true } | { again: true } | { internet: string }} GuideDo
 */

/** @param {AddressSeen | AgentAddress | null} address @returns {AddressMark} */
export const addressMark = address => address === null ? 'checking' : address.state !== 'fix' ? null : address.act ? 'fix' : 'check';

/**
 * @param {Guide} guide
 * @param {boolean} setup
 * @param {AddressSeen | AgentAddress | null} address
 */
const tailscale = (guide, setup, address) => {
  const shown = setup && guide.address !== null;
  const blocked = shown && address?.state !== 'on';
  return { shown, blocked, mark: /** @type {AddressMark} */ (blocked && address?.state === 'off' ? 'turn-on' : addressMark(address)),
    marks: /** @type {StepMark[]} */ (['here', ...guide.steps.map(() => 'later')]), shows: ['tailscale', ...guide.steps.map(() => 'line')] };
};

/**
 * @template {{ marks: StepMark[], shows: string[] }} State
 * @param {State} state
 * @param {boolean} shown
 * @returns {State}
 */
const afterTailscale = (state, shown) => shown ? { ...state, marks: ['done', ...state.marks], shows: ['tailscale', ...state.shows] } : state;

/** @param {Guide} guide */
const loopback = guide => guide.steps.some(step => step.kind === 'name');

/**
 * @param {Guide} guide
 * @param {string} words
 * @param {string} named
 */
const filled = (guide, words, named) => words.replaceAll(NAME_SLOT, named || guide.name);

/**
 * @param {object} seen
 * @param {Guide} seen.guide
 * @param {SignInDialog} seen.dialog
 * @param {AddressSeen | AgentAddress | null} seen.address
 * @param {Waiting[]} seen.waiting
 * @param {Read | null} seen.read
 * @returns {SignInState}
 */
export function signInState({ guide, dialog, address, waiting, read }) {
  const step = tailscale(guide, dialog.setup, address);
  if (step.blocked) {
    return { address: step.mark, head: 'need', marks: step.marks, shows: step.shows, lines: [], signin: null, other: null, foot: [] };
  }
  const mine = waiting.filter(each => each.app === guide.app && each.id !== read?.id).sort((one, two) => two.at_ms - one.at_ms);
  const kept = mine.find(each => each.id === dialog.shown) ?? mine[0] ?? null;
  /** @type {string[]} */
  const said = read?.state === 'wrong' ? ['yes.wrong'] : read?.state === 'denied' ? ['yes.denied'] : [];
  const phase = read?.reader ? 'connected' : read?.state === 'approved' ? 'finishing' : kept ? dialog.editing ? 'edit' : 'arrived'
    : read?.state === 'denied' ? 'denied' : read || dialog.copied ? 'waiting' : 'line';
  const gone = read?.state === 'gone' && phase === 'waiting' ? [dialog.outcome === 'finishing' ? 'yes.unfinished' : 'yes.out'] : [];
  const whole = phase === 'line' || (phase === 'waiting' && !read);
  const first = guide.steps[0]?.kind ?? 'add';
  const shownFirst = !whole ? 'one-line' : dialog.copied ? 'copied' : first;
  const markFirst = phase === 'connected' ? 'done' : whole ? 'here' : dialog.copied ? 'done' : 'plain';
  const others = waiting.filter(each => each.app !== guide.app).sort((one, two) => two.at_ms - one.at_ms);
  const lines = [
    ...(shownFirst === 'copied' || (step.shown && whole)) && address?.state === 'on' ? ['addr.on'] : [],
    ...phase === 'connected' ? [] : phase === 'finishing' ? [] : said,
    ...gone,
    ...phase === 'waiting' && dialog.returned && !read ? ['yes.hint'] : [],
    ...phase === 'connected' ? ['connected.line', ...guide.done.ask ? ['done.ask'] : []] : [],
  ];
  return afterTailscale({
    address: addressMark(address),
    head: phase === 'connected' ? 'done' : ['arrived', 'edit', 'finishing', 'denied'].includes(phase) ? 'short' : 'need',
    marks: [markFirst, phase === 'connected' ? 'done' : phase === 'line' ? 'later' : 'here'],
    shows: [shownFirst, phase === 'line' ? 'line' : phase],
    lines,
    signin: phase === 'arrived' || phase === 'edit' ? kept?.id ?? null : null,
    other: phase === 'waiting' ? others[0]?.id ?? null : null,
    foot: phase === 'arrived' ? ['pick_line', 'deny'] : phase === 'edit' ? ['done'] : phase === 'denied' ? ['start-again']
      : phase === 'connected' ? [...guide.done.open ? ['open'] : [], 'done'] : [],
  }, step.shown);
}

/**
 * @param {object} seen
 * @param {Guide} seen.guide
 * @param {KeyDialog} seen.dialog
 * @param {AddressSeen | AgentAddress | null} seen.address
 * @returns {KeyState}
 */
export function keyState({ guide, dialog, address }) {
  const { steps } = guide;
  if (steps[0]?.kind === 'elsewhere') return { address: null, head: 'need', marks: ['here'], shows: ['elsewhere'], lines: [], foot: [] };
  const before = steps.find(step => step.kind === 'message' || step.kind === 'name') ?? null;
  const ready = !before || (before.kind === 'message' ? dialog.linked : Boolean(dialog.named));
  const made = dialog.made === 'made';
  const done = made && dialog.done;
  const give = steps.find(step => step.kind === 'give');
  const warns = give?.kind === 'give' && give.warn !== null;
  /** @type {{ mark: StepMark, show: string }[]} */
  const drawn = steps.map(step => {
    if (step.kind === 'message' || step.kind === 'name') return { mark: ready ? 'done' : 'here', show: step.kind };
    if (step.kind === 'sees') return made ? { mark: 'done', show: 'sees-done' } : { mark: ready ? 'here' : 'later', show: ready ? 'sees' : 'line' };
    return made ? { mark: done ? 'done' : 'here', show: done ? 'one-line' : 'rows' } : { mark: 'later', show: 'line' };
  });
  const step = tailscale(guide, dialog.setup, address);
  const mark = guide.address === null ? null : step.mark;
  /** @type {string[]} */
  const foot = made ? done ? [...guide.done.open ? ['open'] : [], 'done'] : ['done']
    : !ready ? before?.kind === 'message' ? [] : ['make-waits'] : dialog.making ? ['making'] : mark ? ['make-waits'] : ['make'];
  if (step.blocked) return { address: mark, head: 'need', marks: step.marks, shows: step.shows, lines: [], foot };
  return afterTailscale({
    address: mark,
    head: done ? 'done' : 'need',
    marks: drawn.map(each => done ? 'done' : each.mark),
    shows: drawn.map(each => each.show),
    lines: dialog.made === 'unknown' ? ['give.unknown'] : done ? ['connected.line', ...guide.done.ask ? ['done.ask'] : []]
      : made ? [...warns ? ['give.warn'] : [], 'give.once'] : [],
    foot,
  }, step.shown);
}

/** @param {SignIn} signin @returns {Waiting} */
const waitingOf = signin => ({ id: signin.id, app: signin.app ?? null, host: signin.host, at_ms: signin.at_ms });

/**
 * @typedef {object} GuidesIO
 * @property {() => Promise<AgentGuides>} guides
 * @property {() => Promise<AgentAddress>} address
 * @property {(asked: { on: boolean, reader?: string }) => Promise<AgentAddress>} turn
 * @property {(asked: KeyRequest) => Promise<MadeKey>} key
 * @property {(id: string) => Promise<SignInRead>} signin
 * @property {(asked: EditRequest) => Promise<AccessDraft>} edit
 * @property {() => Promise<{ requests: SignIn[] }>} waiting
 */

/**
 * @param {Host | null} host
 * @returns {Omit<GuidesIO, 'edit' | 'waiting'>}
 */
export function guidesThrough(host) {
  /** @param {HostAct} message @returns {Promise<any>} */
  const ask = message => host ? host.act(message).then(reply => reply.answer) : Promise.reject(new Error(PAGE.browser));
  return {
    guides: () => ask({ act: 'agent-guides' }),
    address: () => ask({ act: 'agent-address' }),
    turn: asked => ask({ act: 'agent-address', ...asked }),
    key: asked => ask({ act: 'agent-key', ...asked }),
    signin: id => ask({ act: 'agent-signin', id }),
  };
}

/**
 * @typedef {object} GuideOpen
 * @property {string} app
 * @property {SignInDialog} signin
 * @property {KeyDialog} key
 * @property {SignIn | null} held
 * @property {Read | null} read
 * @property {Connected | null} connected
 * @property {MadeKey | null} made
 * @property {string} failed
 * @property {boolean} reading
 * @property {string | null} asked
 * @property {ReturnType<typeof draftEditor> | null} draft
 */

/** @param {string} app @returns {GuideOpen} */
const fresh = app => ({ app, signin: { copied: false, setup: false, returned: false, shown: null, outcome: null, editing: false },
  key: { linked: false, named: null, setup: false, making: false, made: null, done: false }, held: null, read: null, connected: null,
  made: null, failed: '', reading: false, asked: null, draft: null });

/** @param {unknown} error */
const codeOf = error => String(/** @type {{ code?: unknown }} */ (error)?.code ?? '');

/** @param {unknown} error */
const wordsOf = error => /** @type {Error} */ (error)?.message || AGENT.unreached;

/**
 * @param {object} parts
 * @param {GuidesIO} parts.io
 * @param {() => void} parts.draw
 * @param {(target: { url: string } | { app: 'Tailscale' | 'Messages' }) => void} parts.open
 * @param {Pick<Window, 'addEventListener'> | null} [parts.page]
 * @param {(run: () => void, ms: number) => unknown} [parts.later]
 */
export function guidesFrame({ io, draw, open, page = null, later = setTimeout }) {
  /** @type {AgentGuides | null} */
  let guides = null;
  let guidesFailed = '';
  /** @type {AgentAddress | null} */
  let address = null;
  let addressFailed = '';
  /** @type {Promise<AgentAddress | null> | null} */
  let turning = null;
  /** @type {GuideOpen | null} */
  let opened = null;
  let showing = false;
  /** @type {HostState | null} */
  let state = null;
  /** @type {SignIn[] | null} */
  let listed = null;
  let named = '';
  let era = 0;
  let rounding = false;

  const readGuides = () => io.guides().then(answer => {
    guides = answer;
    guidesFailed = '';
  }, error => {
    guidesFailed = wordsOf(error);
  }).then(draw);

  /** @param {AgentAddress} answer */
  const heard = answer => {
    address = answer;
    addressFailed = '';
    if (!opened) return;
    if (answer.state === 'fix') opened.signin.setup = opened.key.setup = true;
    if (opened.key.made === 'refused' && answer.state === 'on') opened.key.made = null;
  };

  /** @param {number} mine @param {unknown} error */
  const failed = (mine, error) => {
    if (mine === era) addressFailed = wordsOf(error);
  };

  const readAddress = () => {
    const mine = era;
    return io.address().then(answer => {
      if (mine === era) heard(answer);
    }, error => failed(mine, error)).then(() => {
      draw();
      roundAddress();
    });
  };

  /** @param {GuideOpen} at */
  const settingUp = at => showing && opened === at && Boolean(guideOf(at.app)?.address) && at.signin.setup && address?.state !== 'on';

  const roundAddress = () => {
    const at = opened;
    if (rounding || !at || !settingUp(at)) return;
    rounding = true;
    later(() => {
      if (!settingUp(at)) {
        rounding = false;
        return void roundAddress();
      }
      void Promise.resolve(turning ?? readAddress()).then(() => {
        rounding = false;
        roundAddress();
      });
    }, FINISHING_MS);
  };

  /** @returns {Promise<AgentAddress | null>} */
  const turnOn = () => {
    if (turning) return turning;
    const mine = era;
    turning = io.turn({ on: true }).then(answer => {
      if (mine === era) heard(answer);
      return answer;
    }, async error => {
      if (codeOf(error) === 'OUTCOME_UNKNOWN' && mine === era) await readAddress();
      else failed(mine, error);
      return null;
    }).finally(() => {
      turning = null;
      draw();
      roundAddress();
    });
    return turning;
  };

  const readWaiting = () => io.waiting().then(answer => {
    listed = answer.requests;
    draw();
  }, () => undefined);

  /** @returns {SignIn[]} */
  const listedNow = () => state?.agent_requests ?? listed ?? [];

  /** @returns {SignIn[]} */
  const waitingNow = () => {
    const held = opened?.held;
    const now = listedNow();
    return held && opened?.read?.id !== held.id && !now.some(each => each.id === held.id) ? [...now, held] : now;
  };

  /** @param {string} app */
  const guideOf = app => guides?.apps.find(each => each.app === app) ?? null;

  /** @param {string} id */
  const readSignIn = id => {
    const at = opened;
    if (!at || at.reading) return;
    at.reading = true;
    at.asked = id;
    const again = () => later(() => {
      if (opened === at && showing) readSignIn(id);
    }, FINISHING_MS);
    void io.signin(id).then(said => said.state === 'waiting' ? null : said, () => null).then(landed => {
      at.reading = false;
      if (opened !== at) return;
      if (!landed) return void again();
      const was = at.read;
      if (was?.id === id && was.state === 'approved' && landed.state === 'gone') at.signin.outcome = 'finishing';
      at.read = { id, state: landed.state, reader: landed.reader };
      if (landed.connected) at.connected = landed.connected;
      if (landed.state === 'approved' && !landed.reader) {
        at.signin.outcome = 'finishing';
        again();
      }
      draw();
    });
  };

  const watchSignIns = () => {
    const at = opened;
    const guide = at && guideOf(at.app);
    if (!at || !guide || guide.how !== 'sign-in') return;
    const now = signInState(seenOf(guide, at));
    if (now.signin && now.signin !== at.signin.shown) {
      at.signin.shown = now.signin;
      if (at.read && at.read.id !== now.signin && at.read.state === 'gone') at.read = null;
    }
    const shown = at.signin.shown;
    const listedOne = listedNow().find(each => each.id === shown);
    if (listedOne) at.held = listedOne;
    else if (shown && at.read?.id !== shown && at.asked !== shown) readSignIn(shown);
  };

  /**
   * @param {Guide} guide
   * @param {GuideOpen} at
   */
  const seenOf = (guide, at) => ({ guide, dialog: at.signin, address, waiting: waitingNow().map(waitingOf), read: at.read });

  /** @param {Guide} guide @param {GuideOpen} at */
  const keyOf = (guide, at) => ({ guide, address,
    dialog: { ...at.key, named: loopback(guide) ? (at.made?.name ?? named.trim()) || null : null } });

  /** @param {Guide} guide @param {GuideOpen} at @returns {Shown} */
  const shownOf = (guide, at) => ({ at, address, failed: addressFailed, step: guide.address });

  /** @param {Guide} guide */
  const startDraft = guide => {
    const sees = guide.steps.find(step => step.kind === 'sees');
    if (!opened || !sees || sees.kind !== 'sees') return;
    const app = /** @type {KeyApp} */ (guide.app);
    const draft = draftEditor({ target: { key: app }, edit: io.edit, changed: draw });
    opened.draft = draft;
    draft.hold({ access: /** @type {DraftAccess} */ (sees.access), expect: null, view: /** @type {AccessView} */ (sees.view), narrowed: null,
      saved: null });
  };

  page?.addEventListener('focus', () => {
    const at = opened;
    if (!at || !showing) return;
    at.signin.returned = at.signin.copied;
    void readAddress();
    if (!state) void readWaiting();
    draw();
  });

  /**
   * @param {Guide} guide
   * @param {GuideOpen} at
   */
  async function makeKey(guide, at) {
    if (at.key.making || !at.draft?.draft) return;
    at.key.making = true;
    at.key.made = null;
    at.failed = '';
    draw();
    const wide = !loopback(guide);
    const reached = wide ? await turnOn() : null;
    if (wide && reached?.state !== 'on') {
      at.key.making = false;
      at.key.made = 'refused';
      draw();
      return;
    }
    const name = at.made?.name ?? named.trim();
    /** @type {KeyRequest} */
    const asked = { app: /** @type {KeyApp} */ (guide.app), ...wide ? {} : { name }, access: at.draft.draft.access };
    await io.key(asked).then(made => {
      at.made = made;
      at.connected = made.connected;
      at.key.made = 'made';
    }, error => {
      const code = codeOf(error);
      at.key.made = code === 'ADDRESS_NOT_READY' ? 'refused' : code === 'OUTCOME_UNKNOWN' ? 'unknown' : null;
      at.failed = at.key.made ? '' : /** @type {Error} */ (error).message;
      if (code === 'ADDRESS_NOT_READY') void readAddress();
    });
    at.key.making = false;
    draw();
  }

  return {
    /**
     * @param {{ id: string, pages: readonly string[], state: HostState | null, shown: boolean, fields: Readonly<Record<string, string>> }} at
     */
    follow(at) {
      state = at.state;
      if (NAME_FIELD in at.fields) named = at.fields[NAME_FIELD] ?? '';
      const here = at.shown && at.id === CONNECT_ID;
      const app = here && at.pages[0]?.startsWith(GUIDE_PAGE) ? at.pages[0].slice(GUIDE_PAGE.length) : '';
      if (here && !showing) void readGuides();
      showing = here;
      if ((opened?.app ?? '') !== app) {
        opened?.draft?.close();
        era += 1;
        opened = app ? fresh(app) : null;
        named = at.fields[NAME_FIELD] ?? '';
        address = null;
        addressFailed = '';
        turning = null;
        if (app) {
          void readAddress();
          if (!state) void readWaiting();
        }
      }
      const guide = opened && guideOf(opened.app);
      if (opened && guide && guide.how === 'key' && !opened.draft) startDraft(guide);
      if (opened) opened.signin.editing = at.pages.length > 1;
      watchSignIns();
      roundAddress();
    },
    get editing() {
      const at = opened;
      const guide = at && guideOf(at.app);
      if (!at || !guide) return '';
      if (guide.how === 'key') return '';
      const shown = signInState(seenOf(guide, at)).signin;
      return shown ? `signin:${shown}` : '';
    },
    get draft() {
      return opened?.draft ?? null;
    },
    /**
     * @param {Seen} seen
     * @param {AgentReads} reads
     * @returns {Detail}
     */
    detail(seen, reads) {
      const pages = seen.opened.pages;
      if (!guides) {
        return detailOf(CONNECT_ID, '', 'ai-apps', guidesFailed ? { line: guidesFailed } : { line: null, reading: true });
      }
      const at = opened;
      const guide = at && guideOf(at.app);
      if (!at || !guide) return listDetail(guides);
      const back = { label: guides.title, above: true };
      const inside = pages.length > 1 ? pages.at(-1) ?? '' : '';
      if (guide.how === 'key') {
        return keyDetail(guide, keyState(keyOf(guide, at)), { shown: shownOf(guide, at), named, seen, inside, back });
      }
      const now = signInState(seenOf(guide, at));
      const signin = now.signin ? waitingNow().find(each => each.id === now.signin) ?? null : null;
      const page = inside && signin && reads.editor ? pageInside(reads.editor, inside, signin.name, seen.opened, true) : null;
      if (page && reads.editor) {
        return detailOf(CONNECT_ID, page.name, 'streams', { back: { label: backLabel(pages, guide.head, reads), above: true }, line: page.line,
          said: page.said, parts: page.parts, foot: inside === 'access' ? controlFoot(reads.editor.view, reads.editor, 'signin', reads.checking) : null });
      }
      return signInDetail(guide, now, { shown: shownOf(guide, at), signin, seen, reads, back, other: now.other
        ? waitingNow().find(each => each.id === now.other) ?? null : null });
    },
    /**
     * @param {string} id
     * @param {AnswerReply} reply
     */
    answered(id, reply) {
      const at = opened;
      if (!at || at.signin.shown !== id) return;
      if (reply.state === 'approved' || reply.state === 'wrong' || reply.state === 'denied') {
        at.read = { id, state: reply.state, reader: reply.reader };
        if (reply.connected) at.connected = reply.connected;
        at.signin.outcome = reply.state === 'approved' ? 'finishing' : reply.state;
        if (reply.state === 'approved' && !reply.reader) readSignIn(id);
      } else at.read = { id, state: 'gone', reader: null };
      draw();
    },
    /**
     * @param {GuideDo} doing
     * @returns {Promise<'close' | undefined>}
     */
    async act(doing) {
      const at = opened;
      const guide = at && guideOf(at.app);
      if ('open' in doing) return void open({ url: doing.open });
      if ('app' in doing) return void open({ app: doing.app });
      if (!at || !guide) return;
      if ('copy' in doing) {
        if (!doing.copy.address) return;
        at.signin.copied = true;
        at.signin.returned = false;
        draw();
        await turnOn();
        return;
      }
      if ('internet' in doing) {
        const mine = era;
        await io.turn({ on: true, reader: doing.internet }).then(answer => {
          if (mine !== era) return;
          address = answer.state === 'fix' ? address : answer;
          at.failed = answer.state === 'fix' ? answer.words : '';
        }, error => {
          if (mine === era) at.failed = wordsOf(error);
        });
        draw();
        return;
      }
      if ('fix' in doing) {
        if (doing.fix === 'check') return void await readAddress();
        if (doing.fix === 'tailscale') return void open({ app: 'Tailscale' });
        if (doing.fix === 'web') return void open({ url: doing.url });
        const answer = await turnOn();
        if (answer?.state === 'fix' && answer.act?.to === 'web' && answer.act.url) open({ url: answer.act.url });
        return;
      }
      if ('linked' in doing) {
        at.key.linked = true;
        draw();
        return;
      }
      if ('make' in doing) return void await makeKey(guide, at);
      if ('again' in doing) {
        at.held = null;
        at.asked = null;
        at.read = null;
        at.signin.shown = null;
        at.signin.outcome = null;
        draw();
        return;
      }
      if (guide.how === 'key' && at.key.made === 'made' && !at.key.done && !loopback(guide)) {
        at.key.done = true;
        draw();
        return;
      }
      return 'close';
    },
  };
}

/** @typedef {ReturnType<typeof guidesFrame>} GuidesFrame */

/**
 * @param {GuideLink | null} link
 * @param {boolean} hosted
 * @returns {Act | null}
 */
function linkAct(link, hosted) {
  if (!link) return null;
  if (link.to === 'web') return { label: link.label, out: true, variant: 'primary', do: { guide: { open: link.url } } };
  return hosted ? { label: link.label, out: true, variant: 'primary', do: { guide: { app: 'Messages' } } } : null;
}

/**
 * @param {string} where
 * @param {string[]} path
 * @returns {Bolded}
 */
const pathOf = (where, path) => path.length ? [{ text: where ? `${where}: ` : '' },
  ...path.flatMap((each, at) => [...at ? [{ text: ' › ' }] : [], { text: each, bold: /** @type {const} */ (true) }]), { text: '.' }] : [];

/**
 * @param {AgentGuides} guides
 * @returns {Detail}
 */
function listDetail(guides) {
  return detailOf(CONNECT_ID, guides.title, 'ai-apps', { line: '', parts: [
    bare({ panel: panelOf({ rows: guides.apps.map(guide => rowOf(guide.name, { lead: { icon: guide.mark },
      line: guide.line ?? '', go: { do: guide.connected ? { open: agentDialog(guide.connected) } : { page: `${GUIDE_PAGE}${guide.app}` },
        value: guide.connected ? GUIDE.connected : '' } })) }) }),
  ] });
}

/** @typedef {{ at: GuideOpen, address: AgentAddress | null, failed: string, step: GuideAddress | null }} Shown */

/**
 * @param {AgentAddress | null} address
 * @param {boolean} hosted
 * @returns {Act}
 */
function fixAct(address, hosted) {
  const act = address?.state === 'fix' ? address.act : null;
  if (!act || (act.to === 'web' && !act.url) || (act.to === 'tailscale' && !hosted)) {
    return { label: GUIDE.check, variant: 'secondary', do: { guide: { fix: 'check' } } };
  }
  if (act.to === 'web') return { label: act.label, variant: 'primary', out: true, do: { guide: { fix: 'web', url: act.url ?? '' } } };
  return { label: act.label, variant: 'primary', do: { guide: { fix: act.to } } };
}

/**
 * @param {Shown} shown
 * @param {StepMark} mark
 * @param {AddressMark} now
 * @param {boolean} hosted
 * @returns {StepShown}
 */
function tailscaleStep({ address, step }, mark, now, hosted) {
  const words = /** @type {GuideAddress} */ (step);
  if (mark === 'done') return { title: words.title, line: '', mark, parts: [], open: null };
  const ready = now === 'turn-on';
  const said = ready ? words.ready : address?.state === 'fix' ? address.words : GUIDE.getting;
  const button = ready ? { label: words.on, variant: /** @type {const} */ ('primary'), do: { guide: { fix: /** @type {const} */ ('turn-on') } } }
    : address ? fixAct(address, hosted) : null;
  return { title: words.title, line: words.line, mark, open: null, parts: [saidPart(said), ...button ? [bare({ button })] : []] };
}

/**
 * @param {string} failed
 * @returns {DetailPart[]}
 */
const failedParts = failed => failed ? [bare({ card: true, panel: panelOf({ rows: [rowOf(failed, { mark: { look: 'needs-you' },
  end: { acts: [{ label: GUIDE.check, variant: 'secondary', do: { guide: { fix: 'check' } } }] } })] }) })] : [];

/**
 * @param {GuideValue} value
 * @param {AgentAddress | null} address
 * @param {boolean} copied
 * @param {string} [failed]
 * @returns {PanelRow}
 */
function valueRow(value, address, copied, failed = '') {
  if (!value.address) return rowOf(value.label, { line: value.text, end: { copy: { value: value.text, label: value.label } } });
  const url = address?.url ?? null;
  if (!url) return rowOf(value.label, { line: address || failed ? '' : GUIDE.getting });
  const text = `${value.text}${url}`;
  return rowOf(value.label, { line: text, end: { copy: { value: text, label: value.label, copied, do: { guide: { copy: { address: true } } } } } });
}

/**
 * @param {string} words
 * @returns {DetailPart}
 */
const saidPart = words => bare({ said: plainly(words) });

/**
 * @param {string} words
 * @returns {DetailPart}
 */
const waitPart = words => bare({ panel: panelOf({ rows: [rowOf(words, { signal: 'engaged', pulse: true })] }) });

/**
 * @param {{ title: string, line: string, question: string } | null} ask
 * @returns {DetailPart[]}
 */
const askParts = ask => ask ? [bare({ label: ask.title, lines: [ask.line], card: true,
  panel: panelOf({ rows: [rowOf(ask.question, { end: { copy: { value: ask.question, label: ask.title } } })] }) })] : [];

/**
 * @typedef {{ title: string, line: string, mark: StepMark, parts: DetailPart[], open: Act | null, field?: { key: string, label: string, value: string, placeholder: string } }} StepShown
 */

/**
 * @template {{ address: AddressMark, marks: StepMark[], shows: string[] }} State
 * @param {State} now
 * @param {Shown} shown
 * @param {boolean} hosted
 * @returns {{ own: State, lead: StepShown[] }}
 */
function leadOf(now, shown, hosted) {
  if (now.shows[0] !== 'tailscale') return { own: now, lead: [] };
  return { own: { ...now, marks: now.marks.slice(1), shows: now.shows.slice(1) },
    lead: [tailscaleStep(shown, now.marks[0] ?? 'here', now.address, hosted)] };
}

/**
 * @param {Guide} guide
 * @param {SignInState} state
 * @param {{ shown: Shown, signin: SignIn | null, other: SignIn | null, seen: Seen, reads: AgentReads, back: { label: string, above: boolean } }} with
 * @returns {Detail}
 */
function signInDetail(guide, state, { shown, signin, other, seen, reads, back }) {
  const { at, address } = shown;
  const hosted = seen.state !== null;
  const { own: now, lead } = leadOf(state, shown, hosted);
  const [first, yes] = guide.steps;
  const step2 = yes?.kind === 'yes' ? yes : null;
  if (!step2) return detailOf(CONNECT_ID, guide.head, guide.mark, { back, line: guide.need, parts: [] });
  const has = (/** @type {string} */ line) => now.lines.includes(line);
  /** @type {StepShown} */
  let one;
  if (now.shows[0] === 'one-line' || now.shows[0] === 'line' || !first || (first.kind !== 'add' && first.kind !== 'message')) {
    one = { title: first?.title ?? '', line: now.shows[0] === 'line' && first?.kind === 'message' ? first.line : '', mark: now.marks[0],
      parts: [], open: null };
  } else {
    const copied = now.shows[0] === 'copied';
    const values = first.kind === 'add' ? first.values : [first.value];
    const rows = bare({ panel: panelOf({ rows: values.map(value => valueRow(value, address, copied, shown.failed)) }) });
    const on = has('addr.on') && address?.state === 'on' ? [saidPart(address.line)] : [];
    one = first.kind === 'add'
      ? { title: first.title, line: '', mark: now.marks[0], open: linkAct(first.open, hosted), parts: [
        ...first.path.length ? [bare({ said: pathOf(first.where, first.path) })] : [], rows, ...on,
        ...first.then ? [saidPart(first.then)] : []] }
      : { title: first.title, line: first.line, mark: now.marks[0], open: linkAct(first.open, hosted), parts: [rows, ...on] };
  }
  const outcome = [...has('yes.wrong') ? [step2.wrong] : [], ...has('yes.denied') ? [step2.denied] : [],
    ...has('yes.unfinished') ? [step2.unfinished] : [], ...has('yes.out') ? [step2.out] : []];
  /** @type {StepShown} */
  let two = { title: step2.title, line: step2.line, mark: now.marks[1], parts: [], open: null };
  const phase = now.shows[1];
  const live = reads.editor !== null && !reads.over;
  if (phase === 'waiting') {
    const otherLine = other ? step2.other.replaceAll(HOST_SLOT, other.host ?? other.name) : '';
    two = { ...two, line: '', parts: [...outcome.map(saidPart), waitPart(step2.wait), ...has('yes.hint') ? [saidPart(step2.hint)] : [],
      ...other ? [bare({ panel: panelOf({ rows: [rowOf(otherLine, { mark: { look: 'needs-you' },
        go: { do: { open: `signin:${other.id}` }, value: '' } })] }) })] : []] };
  } else if (phase === 'finishing') {
    two = { ...two, line: '', parts: [waitPart(step2.finishing)] };
  } else if (phase === 'denied') {
    two = { ...two, line: '', parts: outcome.map(saidPart) };
  } else if (phase === 'connected') {
    two = { ...two, title: step2.reads, line: '' };
  } else if ((phase === 'arrived' || phase === 'edit') && signin) {
    const view = reads.editor?.view ?? signin.view;
    const rows = accessRows(view).map(row => rowOf(row.name, { lead: { icon: row.icon }, end: { words: row.value } }));
    const access = /** @type {import('../../types.js').Access | null} */ (reads.editor?.access ?? null);
    two = { title: signin.head, line: outcome[0] ?? phraseWords(signin.over_line), mark: now.marks[1], open: null, parts: [
      bare({ label: step2.sees, panel: panelOf({ rows }),
        acts: live ? [{ label: GUIDE.edit, variant: 'plain', do: { page: 'access' } }] : [] }),
      ...live ? [codePart(signin, seen.opened, reads.answering, code => signInAnswer(signin.id, code, access))] : []] };
  }
  const done = now.head === 'done';
  const shownSignin = phase === 'arrived' && signin;
  /** @type {Detail['foot']} */
  const foot = shownSignin ? { start: null, said: plainly(reads.said || (reads.over ? reads.editorFailed : signin.pick_line)), mark: '',
    busy: reads.editor?.busy === true, end: live ? [{ label: GUIDE.deny, variant: 'plain', disabled: reads.answering,
      do: { answer: signInAnswer(signin.id, 'deny', null) } }] : [] }
    : phase === 'denied' ? { start: null, end: [{ label: GUIDE.again, variant: 'secondary', do: { guide: { again: true } } }] }
      : done ? { start: null, end: [{ label: GUIDE.done, variant: 'plain', do: { guide: { done: true } } },
        ...[linkAct(guide.done.open, hosted)].filter(act => act !== null)] } : null;
  return detailOf(CONNECT_ID, done ? guide.done.title : guide.head, guide.mark, { back,
    line: done ? at.connected?.line ?? '' : now.head === 'need' ? guide.need : '',
    parts: [...failedParts(shown.failed), bare({ steps: [...lead, one, two] }), ...done ? askParts(guide.done.ask) : []], foot });
}

/**
 * @param {MadeKey} made
 * @param {AgentAddress | null} address
 * @returns {MadeKey['rows']}
 */
const rowsOf = (made, address) => made.rows.some(row => row.text.startsWith('https://')) || !address?.url ? made.rows
  : [...made.rows, { label: GUIDE.internet, text: address.url }];

/**
 * @param {Guide} guide
 * @param {KeyState} state
 * @param {{ shown: Shown, named: string, seen: Seen, inside: string, back: { label: string, above: boolean } }} with
 * @returns {Detail}
 */
function keyDetail(guide, state, { shown, named, seen, inside, back }) {
  const { at, address } = shown;
  const hosted = seen.state !== null;
  const name = at.made?.name ?? named.trim();
  const pages = seen.opened.pages;
  const draft = at.draft?.draft ?? null;
  const editor = draft ? { view: draft.view, busy: at.draft?.busy === true, note: at.draft?.failed ?? '', held: false } : null;
  const page = inside && editor ? pageInside(editor, inside, filled(guide, guide.name, name), seen.opened, true) : null;
  if (page) {
    return detailOf(CONNECT_ID, page.name, 'streams', { back: { label: backLabel(pages, filled(guide, guide.head, name), null), above: true },
      line: page.line, said: page.said, parts: page.parts,
      foot: inside === 'access' ? { start: null, end: [{ label: GUIDE.done, variant: 'primary', do: { back: true } }] } : null });
  }
  const { own: now, lead } = leadOf(state, shown, hosted);
  const has = (/** @type {string} */ line) => now.lines.includes(line);
  /** @type {StepShown[]} */
  const steps = guide.steps.map((step, index) => {
    const mark = now.marks[index] ?? 'later';
    const show = now.shows[index];
    const title = filled(guide, step.title, name);
    if (step.kind === 'elsewhere') return { title, line: step.line, mark, parts: [], open: null };
    if (show === 'line') return { title, line: step.kind === 'message' ? step.line : '', mark, parts: [], open: null };
    if (step.kind === 'message') {
      return mark === 'done' ? { title, line: '', mark, parts: [], open: null } : { title, line: step.line, mark,
        open: linkAct(step.open, hosted), parts: [bare({ panel: panelOf({ rows: [valueRow(step.value, address, false, shown.failed)] }) }),
          ...step.next ? [bare({ button: { label: step.next, variant: 'secondary', do: { guide: { linked: true } } } })] : []] };
    }
    if (step.kind === 'name') {
      return at.made ? { title, line: at.made.name, mark, parts: [], open: null } : { title, line: '', mark, open: null, parts: [],
        field: { key: NAME_FIELD, label: step.title, value: named, placeholder: step.placeholder } };
    }
    if (step.kind === 'sees') {
      const view = draft?.view ?? /** @type {AccessView} */ (step.view);
      if (show === 'sees-done') return { title, line: view.reads, mark, parts: [], open: null };
      return { title, line: '', mark, open: null, parts: [bare({ label: step.sees,
        acts: [{ label: GUIDE.edit, variant: 'plain', do: { page: 'access' } }],
        panel: panelOf({ rows: accessRows(view).map(row => rowOf(row.name, { lead: { icon: row.icon }, end: { words: row.value } })) }) })] };
    }
    if (step.kind !== 'give' || show !== 'rows' || !at.made) return { title, line: '', mark, parts: [], open: null };
    return { title, line: '', mark, open: null, parts: [
      ...step.path.length ? [bare({ said: pathOf(step.where ?? '', step.path) })] : [],
      bare({ panel: panelOf({ rows: rowsOf(at.made, address).map((row, place) => rowOf(row.label, { line: row.text, end: { copy: { value: row.text,
        label: row.label, ...loopback(guide) && row.text.startsWith('https://') && place > 0
          ? { do: { guide: { internet: at.made?.reader ?? '' } } } : {} } } })) }) }),
      ...step.then ? [saidPart(step.then)] : [],
      ...has('give.warn') && step.warn ? [saidPart(step.warn)] : [],
      ...has('give.once') ? [saidPart(step.once)] : []] };
  });
  const done = now.head === 'done';
  const sees = guide.steps.find(step => step.kind === 'sees');
  const make = sees?.kind === 'sees' ? sees.make : '';
  /** @type {Act[]} */
  const end = [...now.foot.filter(each => each !== 'open'), ...now.foot.filter(each => each === 'open')].flatMap(/** @returns {Act[]} */ each => {
    if (each === 'make' || each === 'make-waits') return [{ label: make, variant: 'primary', disabled: each === 'make-waits', do: { guide: { make: true } } }];
    if (each === 'making') return [{ label: GUIDE.making, variant: 'primary', disabled: true, do: { guide: { make: true } } }];
    if (each === 'open') return [linkAct(guide.done.open, hosted)].filter(act => act !== null);
    return [{ label: GUIDE.done, variant: now.foot.includes('open') ? 'plain' : 'primary', do: { guide: { done: true } } }];
  });
  const give = guide.steps.find(step => step.kind === 'give');
  const said = has('give.unknown') && give?.kind === 'give' ? give.unknown : at.failed;
  return detailOf(CONNECT_ID, filled(guide, done ? guide.done.title : guide.head, name), guide.mark, { back,
    line: done ? at.connected?.line ?? '' : guide.need,
    parts: [...failedParts(guide.address ? shown.failed : ''), bare({ steps: [...lead, ...steps] }), ...done ? askParts(guide.done.ask) : []],
    foot: end.length || said ? { start: null, said: plainly(said), mark: '', end } : null });
}
