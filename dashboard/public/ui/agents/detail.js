// @ts-check
/** @import { AccessView, AccessViewCategory, AccessWindow, AgentAsk, AgentRead, AnswerRequest, AskAnswer, Bolded, Edit, HistoryLine, HistoryPage, Limit, Narrowed, ReadPage, SignIn, Switch, ThingsPage } from '../../types.js' */
/** @import { HostState } from '../../lib/host.js' */
/** @import { Detail, DetailPart, Menu, Opened, PanelRow } from '../connectors/dialog.js' */
/** @import { Do } from '../connectors/words.js' */
import { askAnswer, askChanges, askChoices, signInAnswer } from '../../lib/agents.js';
import { routeOf } from '../../lib/opening.js';
import { clock, phraseWords } from '../../lib/words.js';
import { panelOf, rowOf } from '../connectors/dialog.js';
import { ACCESS, AGENT, ASKED, HIDES, PAGE, SIGNING } from './words.js';

export const SINCE_FIELD = 'access.since';

/** @param {string} id */
export const codeField = id => `signin.code:${id}`;

/**
 * @param {SignIn} signin
 * @param {Opened} opened
 * @param {boolean} answering
 * @param {(code: string) => AnswerRequest} answerOf
 * @returns {DetailPart}
 */
export function codePart(signin, opened, answering, answerOf) {
  const typed = opened.fields?.[codeField(signin.id)] ?? '';
  const code = typed.replace(/[\s-]+/gu, '');
  return bare({ label: signin.pick, panel: panelOf({ rows: [rowOf(SIGNING.code, { end: { field: { key: codeField(signin.id), label: signin.pick,
    kind: 'text', value: typed, placeholder: '000 000', max: 7 }, acts: [{ label: SIGNING.allow, variant: 'primary',
    disabled: answering || !/^[0-9]{6}$/u.test(code), do: { answer: answerOf(code) } }] } })] }) });
}
export const OPEN_FIELD = 'access.open';
export const NAME_FIELD = 'agents.name';
export const HISTORY_FOLDS = 'history.folds';
export const EDITOR_BUSY = 'access:editor';
export const CONNECT_ID = 'agents:connect';
export const READ_PAGE = 'read:';
export const THINGS_PAGE = 'things:';

/** @param {AccessView} view */
export const accessRows = view => [
  { icon: 'streams', name: AGENT.reads, value: view.reads },
  { icon: 'time', name: AGENT.far, value: view.window.words },
  ...view.hide ? [{ icon: 'hidden', name: AGENT.hides, value: view.hide.words }] : [],
];

/** @param {string} id */
export const agentDialog = id => `agent:${id}`;

/** @param {string} id */
export const isAgentDialog = id => /^(agent|signin|ask):[^/]+$/u.test(id) || id === CONNECT_ID;

/** @typedef {{ view: AccessView, busy: boolean, note: string, held: boolean, narrowed?: Narrowed | null, undoes?: boolean, before?: AccessView | null, access?: import('../../types.js').DraftAccess, expect?: import('../../types.js').Version | null }} EditorShown */

/**
 * @typedef {object} AgentReads
 * @property {AgentRead | null} one
 * @property {string} oneFailed
 * @property {HistoryPage | null} history
 * @property {string} historyFailed
 * @property {string} kind
 * @property {ReadPage | null} read
 * @property {string} readFailed
 * @property {ThingsPage | null} things
 * @property {string} thingsFailed
 * @property {SignIn | null} signin
 * @property {EditorShown | null} editor
 * @property {string} editorFailed
 * @property {boolean} over
 * @property {AgentAsk | null} asked
 * @property {boolean} answering
 * @property {boolean} erased
 * @property {boolean} checking
 * @property {string} said
 * @property {boolean} saidErased
 */

/** @type {AgentReads} */
export const NO_AGENT_READS = { one: null, oneFailed: '', history: null, historyFailed: '', kind: '', read: null, readFailed: '', things: null,
  thingsFailed: '', signin: null, editor: null, editorFailed: '', over: false, asked: null, answering: false, erased: false, checking: false, said: '',
  saidErased: false };

/** @typedef {{ fold: { words: string, open: boolean, do: Do } } | { menu: Menu }} Differs */

/** @typedef {{ name: string, icon: string, line: string, check: Switch, waits: boolean, do: Do, differs: Differs | null, count: { n: string, words: string } | null, inner: ControlLine[] }} ControlLine */

/** @typedef {{ label: string, aside: string, mode: { label: string, choices: { value: string, words: string, chosen: boolean, do: Do }[] }, modeLine: string, lines: ControlLine[] }} Control */

/** @typedef {{ level: { label: string, choices: { value: string, words: string, chosen: boolean, do: Do }[] }, heading: string, rows: { name: string, line: string, check: Switch, do: Do | null }[] }} Hides */

/** @typedef {{ days: { day: string, reads: string, rows: PanelRow[] }[], earlier: { words: string, do: Do } | null }} History */

/**
 * @param {string} today
 */
export const whenWords = today => ({ today, clock: (/** @type {number} */ ms) => clock(ms) });

/** @typedef {ReturnType<typeof whenWords>} When */

/**
 * @param {Partial<DetailPart>} part
 * @returns {DetailPart}
 */
export const bare = part => ({ label: '', lines: [], panel: null, acts: [], ...part });

/** @param {Edit} edit @returns {Do} */
const tap = edit => ({ edit });

/**
 * @param {string} id
 * @param {Limit} limit
 * @param {AccessView['times']} times
 * @param {(window: AccessWindow) => Edit} set
 * @param {string} scope
 * @returns {Menu}
 */
function windowMenu(id, limit, times, set, scope) {
  const now = 'window' in limit.value ? limit.value.window : undefined;
  /** @param {AccessView['times'][number]} time */
  const chosen = time => now !== undefined && (time.choice === 'since' ? now !== null && 'since_ms' in now
    : JSON.stringify(time.window) === JSON.stringify(now));
  return { id, busy: EDITOR_BUSY, label: AGENT.far, words: limit.words, find: '', date: null, choices: times.map((time, at) => ({
    words: time.words, note: '', default: false, chosen: chosen(time), parted: times[at + 1]?.choice === 'since',
    do: time.choice === 'since' ? { page: `since:${scope}` } : tap(set(time.window)) })) };
}

/**
 * @param {AccessView} view
 * @returns {Menu | null}
 */
const hidesMenu = view => view.hide && { id: 'access.hide', busy: EDITOR_BUSY, label: AGENT.hides, words: view.hide.words, find: '',
  date: null, choices: view.hide.choices.map((each, at, all) => ({ words: each.words, note: each.line ?? '', chosen: each.selected,
    default: false, parted: all[at + 1]?.level === 'custom',
    do: each.level === 'custom' ? { page: 'hides' } : tap({ hide: each.level }) })) };

/** @param {Switch} state */
const turned = state => state !== 'on';

/**
 * @param {Switch} now
 * @param {Switch | undefined} was
 */
const waiting = (now, was) => was !== undefined && now !== 'off' && (was === 'off' || (was === 'some' && now === 'on'));

/** @param {AccessViewCategory['reads']} reads */
const countOf = reads => reads ? { n: reads.n ? reads.n.toLocaleString('en-GB') : ACCESS.none, words: reads.words } : null;

/**
 * @param {AccessView} view
 * @param {Opened} opened
 * @param {AccessView | null} [before]
 * @returns {Control}
 */
export function controlOf(view, opened, before = null) {
  const open = opened.fields?.[OPEN_FIELD] ?? '';
  /** @type {ControlLine[]} */
  const lines = view.categories.map(category => {
    const was = before?.categories.find(each => each.type === category.type);
    const folds = category.accounts.length > 1 && category.differs !== null;
    const unfolded = folds && open === category.type;
    const limit = category.state === 'off' ? null : category.limit;
    /** @type {Differs | null} */
    const differs = folds ? { fold: { words: category.differs ?? '', open: unfolded,
      do: { typed: { key: OPEN_FIELD, value: unfolded ? '' : category.type } } } }
      : category.differs && limit ? { menu: { ...windowMenu(`access.type:${category.type}`, limit, view.times,
        window => ({ type: category.type, window }), `type:${category.type}`), words: category.differs } } : null;
    return {
      name: category.name, icon: category.icon, line: '', check: category.state, waits: waiting(category.state, was?.state),
      count: countOf(category.reads), do: tap({ type: category.type, on: turned(category.state) }), differs,
      inner: unfolded ? category.accounts.map(account => {
        const own = account.state === 'off' ? null : account.limit;
        const wasAccount = was?.accounts.find(each => each.account === account.account);
        return { name: account.name, icon: '', line: account.line ?? '', check: account.state,
          waits: waiting(account.state, wasAccount?.state), do: tap({ account: account.account, on: turned(account.state) }),
          differs: own && own.words !== limit?.words ? { menu: windowMenu(`access.account:${account.account}`, own, view.times,
            window => ({ account: account.account, window }), `account:${account.account}`) } : null, inner: [], count: null };
      }) : [],
    };
  });
  return {
    label: ACCESS.sees,
    aside: view.categories.some(category => category.reads) ? ACCESS.readsHead : '',
    mode: { label: AGENT.reads, choices: view.modes.map(each => ({ value: each.mode, words: each.words, chosen: each.mode === view.mode,
      do: tap({ mode: each.mode }) })) },
    modeLine: view.mode_line,
    lines,
  };
}

/**
 * @param {AccessView} view
 * @returns {PanelRow[]}
 */
const limitRows = view => [
  rowOf(AGENT.far, { menu: windowMenu('access.window', view.window, view.times, window => ({ window }), 'all') }),
  ...view.hide ? [rowOf(AGENT.hides, { menu: /** @type {Menu} */ (hidesMenu(view)) })] : [],
];

/**
 * @param {AccessView} view
 * @param {string} name
 * @returns {Hides | null}
 */
export function hidesOf(view, name) {
  const hide = view.hide;
  if (!hide) return null;
  return {
    level: { label: AGENT.hides, choices: hide.choices.filter(each => each.level !== 'custom' || each.selected)
      .map(each => ({ value: each.level, words: each.words, chosen: each.selected, do: tap({ hide: each.level }) })) },
    heading: ACCESS.hiddenFrom(name),
    rows: hide.types.map(type => ({ name: type.name, line: type.subtypes.map(each => each.name).join(', '),
      check: type.state === 'shown' ? 'off' : 'on',
      do: type.state === 'fixed' ? null : tap({ detail: type.type, hidden: type.state !== 'hidden' }) })),
  };
}

/** @param {string} text @returns {Bolded} */
export const plainly = text => text ? [{ text }] : [];

/** @param {Bolded} bolded */
const plainOf = bolded => bolded.map(run => run.text).join('');

/**
 * @param {AccessView} view
 * @param {{ held: boolean, busy: boolean, note: string, narrowed?: Narrowed | null, undoes?: boolean }} editor
 * @param {'reader' | 'signin' | 'ask'} kind
 * @param {boolean} checking
 * @returns {NonNullable<Detail['foot']>}
 */
export function controlFoot(view, { held, busy, note, narrowed = null, undoes = false }, kind, checking) {
  if (kind !== 'reader') {
    const done = kind === 'signin';
    return { start: null, said: plainly(note), mark: '', busy, end: [{ label: done ? ACCESS.done : ACCESS.allow, variant: 'primary',
      disabled: checking || busy, do: { editor: done ? 'done' : 'allow' } }] };
  }
  if (held) {
    const waits = [view.widening ?? plainly(view.screen ?? ''), undoes ? [] : plainly(PAGE.browser)]
      .filter(each => each.length > 0).flatMap((each, at) => at ? [{ text: ' ' }, ...each] : each);
    const saved = narrowed && !note ? narrowed.words : [];
    return { start: null, said: note ? plainly(note) : saved.length ? saved : waits, mark: note ? '' : saved.length ? 'done' : 'waiting',
      waits: saved.length ? waits : [], busy, end: [
      { label: ACCESS.cancel, variant: 'secondary', do: { editor: 'cancel' } },
      ...undoes ? [{ label: ACCESS.allow, variant: /** @type {const} */ ('primary'), keys: '↵', do: { editor: /** @type {const} */ ('save') } }] : []] };
  }
  return { start: null, said: note ? plainly(note) : narrowed?.words ?? [], mark: narrowed && !note ? 'done' : '', busy,
    end: narrowed && undoes ? [{ label: ACCESS.undo, variant: 'secondary', keys: '⌘Z', do: { editor: 'undo' } }] : [] };
}

/**
 * @param {string} scope
 * @param {string} date
 * @param {(day: string) => number} startOf
 * @returns {Edit | null}
 */
export function sinceEdit(scope, date, startOf) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  const window = { since_ms: startOf(date) };
  if (scope === 'all') return { window };
  if (scope.startsWith('type:')) return { type: scope.slice('type:'.length), window };
  if (scope.startsWith('account:')) return { account: scope.slice('account:'.length), window };
  return null;
}

/**
 * @param {HistoryLine} line
 * @param {When} when
 * @param {Do | null} [fold]
 * @returns {PanelRow}
 */
export function historyRowOf(line, when, fold = null) {
  const time = when.clock(line.at_ms);
  if (line.kind === 'change') {
    return rowOf(line.words, { lead: { icon: line.icon }, line: line.line ?? '', tone: line.tone === 'waiting' ? 'caution' : undefined,
      end: line.ask ? { acts: [{ label: PAGE.review, variant: 'secondary', do: { open: `ask:${line.ask}` } }] } : { time } });
  }
  if (line.kind === 'fold') {
    return rowOf(line.words, { lead: { icon: line.icon }, line: line.line, ...fold ? { go: { do: fold, value: '', time } } : { end: { time } } });
  }
  const opens = line.opens ? { go: { do: /** @type {Do} */ ({ page: `${READ_PAGE}${line.id}` }), value: '', time } } : { end: { time } };
  return rowOf(line.words, { lead: { icon: line.icon }, line: line.line ?? '', tail: line.kept ?? '',
    tone: line.tone === 'refused' ? 'warning' : undefined, ...opens });
}

/**
 * @param {HistoryPage} history
 * @param {string} id
 * @param {When} when
 * @param {Record<string, string>} fields
 * @returns {History}
 */
export function historyOf(history, id, when, fields = {}) {
  const folds = new Set((fields[HISTORY_FOLDS] ?? '').split(' ').filter(Boolean));
  /** @type {History['days']} */
  const days = [];
  for (const session of history.sessions) {
    const rows = session.lines.flatMap((line, at) => {
      if (line.kind !== 'fold') return [historyRowOf(line, when)];
      const key = `${session.key}.${at}`;
      const open = folds.has(key);
      const value = [...open ? [...folds].filter(each => each !== key) : [...folds, key]].join(' ');
      return [historyRowOf(line, when, { typed: { key: HISTORY_FOLDS, value } }),
        ...open ? line.lines.map(each => ({ ...historyRowOf(each, when), inset: true })) : []];
    });
    const last = days.at(-1);
    if (last?.day === session.day.words) last.rows.push(...rows);
    else days.push({ day: session.day.words, reads: session.day.reads ?? '', rows });
  }
  return { days, earlier: history.next ? { words: history.next.words, do: /** @type {Do} */ ({ earlier: id }) } : null };
}

/**
 * @param {HistoryPage} history
 * @param {AgentRead} agent
 * @param {Seen} seen
 * @returns {DetailPart[]}
 */
function historyPageParts(history, agent, seen) {
  const { days, earlier } = historyOf(history, agent.id, seen.when, seen.opened.fields ?? {});
  const chips = history.chips.length ? [bare({ kinds: { label: AGENT.kinds, value: history.kind ?? '',
    choices: history.chips.map(chip => ({ value: chip.kind, label: chip.name, count: chip.n.toLocaleString('en-GB') })) } })] : [];
  return [
    ...history.figure ? [bare({ figure: history.figure })] : [],
    ...chips,
    ...history.empty ? [bare({ label: history.empty.title, lines: [history.empty.line] })] : [],
    ...days.map(day => bare({ label: day.day, aside: plainly(day.reads), card: true, panel: panelOf({ rows: day.rows }) })),
    ...earlier ? [bare({ card: true, panel: panelOf({ rows: [rowOf(earlier.words, { go: { do: earlier.do, value: '' } })] }) })] : [],
  ];
}

/**
 * @param {HistoryPage} held
 * @param {HistoryPage} page
 * @returns {HistoryPage}
 */
export function historyWith(held, page) {
  const last = held.sessions.at(-1);
  const [first, ...rest] = page.sessions;
  if (!last || !first || first.key !== last.key) return { ...held, sessions: [...held.sessions, ...page.sessions], next: page.next };
  const fold = last.lines.at(-1);
  const [goesOn, ...after] = first.lines;
  const lines = fold?.kind === 'fold' && goesOn?.kind === 'fold' && goesOn.continues
    ? [...last.lines.slice(0, -1), { ...goesOn, at_ms: fold.at_ms, lines: [...fold.lines, ...goesOn.lines] }, ...after]
    : [...last.lines, ...first.lines];
  const joined = { ...last, from_ms: Math.min(last.from_ms, first.from_ms), lines };
  return { ...held, sessions: [...held.sessions.slice(0, -1), joined, ...rest], next: page.next };
}

/**
 * @typedef {object} Seen
 * @property {HostState | null} state
 * @property {Opened} opened
 * @property {boolean} home
 * @property {number} now
 * @property {When} when
 */

/**
 * @param {string} id
 * @param {string} name
 * @param {string} icon
 * @param {Partial<Detail>} [more]
 * @returns {Detail}
 */
export const detailOf = (id, name, icon, more = {}) => ({ id, icon, name, line: '', state: null, callout: null, figure: null, parts: [],
  panels: [], back: null, foot: null, confirm: null, reading: false, ticking: false, page: true, ...more });

/** @param {AgentRead} agent */
export const agentIcon = agent => agent.mark;

/** @param {AgentRead} agent @param {When} when @returns {DetailPart[]} */
function historyParts(agent, when) {
  const { lines, all } = agent.recent;
  if (!lines.length && all === null) return [];
  return [bare({ label: AGENT.history, aside: plainly(agent.reads.since ?? ''), card: true, panel: panelOf({ rows: [
    ...lines.map(line => historyRowOf(line, when)),
    ...all === null ? [] : [rowOf(AGENT.seeAll, { go: { do: { page: 'history' }, value: '' } })],
  ] }) })];
}

/**
 * @param {AgentRead} agent
 * @param {AgentReads} reads
 * @param {Seen} seen
 * @returns {DetailPart[]}
 */
function agentParts(agent, reads, seen) {
  const figure = bare({ figure: agent.figure });
  const history = historyParts(agent, seen.when);
  const connection = agent.kind === 'chat' ? [] : [bare({ label: AGENT.connection, card: true,
    panel: panelOf({ rows: [rowOf(agent.how, { lead: { icon: 'link' } })] }) })];
  if (agent.state === 'disconnected') {
    const ask = `unlist:${agent.id}`;
    const unlist = agent.unlist;
    return [figure, ...history, ...connection, ...seen.home && unlist ? [bare({ button: { label: AGENT.unlistOpen, variant: 'plain', do: { ask } },
      confirm: { ask, question: unlist.ask, detail: unlist.line,
        yes: { label: AGENT.unlist, tone: 'warning', variant: 'primary', do: { unlist: agent.id } },
        no: { label: AGENT.notNow, variant: 'plain', do: { ask: '' } } } })] : []];
  }
  const editor = /** @type {EditorShown} */ (reads.editor);
  const { view } = editor;
  const access = bare({ label: AGENT.access, card: true, panel: panelOf({ rows: [
    rowOf(AGENT.reads, { line: view.reads, go: { do: { page: 'access' }, value: '' } }),
    ...limitRows(view),
  ] }) });
  const disconnect = seen.home && agent.disconnect ? [bare({ button: { label: AGENT.disconnectOpen(agent.name), variant: 'plain',
    tone: 'warning', do: { page: 'disconnect' } } })] : [];
  return [figure, ...editor.note ? [bare({ lines: [editor.note] })] : [], access, ...history, ...connection, ...disconnect];
}

/**
 * @param {AgentRead} agent
 * @param {Seen} seen
 * @returns {Detail['callout']}
 */
function askCallout(agent, seen) {
  const ask = agent.ask;
  if (!ask || agent.kind === 'chat' || agent.state === 'disconnected') return null;
  if (seen.state !== null && !seen.state.agent_asks.some(each => each.id === ask.id)) return null;
  return { kind: 'caution', title: ask.head, lines: [phraseWords(ask.under_line)],
    acts: [{ label: PAGE.review, variant: 'secondary', do: { open: `ask:${ask.id}` } }] };
}

/**
 * @param {import('../../types.js').Ended} ended
 * @returns {PanelRow}
 */
const endedRow = ended => rowOf(ended.name, { lead: { icon: ended.icon }, line: ended.line });

/**
 * @param {import('../../types.js').Disconnecting} disconnect
 * @returns {DetailPart[]}
 */
export const disconnectParts = disconnect => [
  bare({ label: AGENT.stops, card: true, panel: panelOf({ rows: disconnect.stops.map(endedRow) }) }),
  bare({ label: AGENT.stays, card: true, panel: panelOf({ rows: disconnect.stays.map(endedRow) }) }),
];

/**
 * @param {EditorShown} editor
 * @returns {Detail['foot']}
 */
const savedFoot = editor => editor.held || editor.narrowed ? controlFoot(editor.view, editor, 'reader', false) : null;

/**
 * @param {EditorShown} editor
 * @param {Opened} opened
 * @param {boolean} limits
 * @returns {DetailPart[]}
 */
const controlParts = (editor, opened, limits) => [bare({ control: controlOf(editor.view, opened, editor.before ?? null) }),
  ...limits ? [bare({ card: true, panel: panelOf({ rows: limitRows(editor.view) }) })] : []];

/**
 * @param {EditorShown} editor
 * @param {string} inside
 * @param {string} name
 * @param {Opened} opened
 * @param {boolean} [limits]
 * @returns {{ name: string, line: string, said?: Bolded, parts: DetailPart[] } | null}
 */
export function pageInside(editor, inside, name, opened, limits = false) {
  const { view } = editor;
  if (inside === 'access') return { name: AGENT.reads, line: '', said: view.sentence, parts: controlParts(editor, opened, limits) };
  if (inside === 'hides') {
    const hides = hidesOf(view, name);
    return hides && { name: HIDES.title, line: view.hide?.words ?? '', parts: [bare({ hides })] };
  }
  if (inside.startsWith('since:')) {
    const scope = inside.slice('since:'.length);
    const value = opened.fields?.[SINCE_FIELD] ?? '';
    return { name: ACCESS.since, line: '', parts: [bare({ panel: panelOf({ rows: [rowOf(ACCESS.since, { end: { field: { key: SINCE_FIELD,
      label: ACCESS.since, kind: 'date', value, placeholder: '' }, acts: [{ label: ACCESS.set, variant: 'primary',
      disabled: !/^\d{4}-\d{2}-\d{2}$/u.test(value), do: { since: scope } }] } })] }) })] };
  }
  return null;
}

/**
 * @param {string} page
 * @param {AgentReads | null} reads
 * @param {string} root
 */
const pageWord = (page, reads, root) => page === 'access' ? AGENT.reads : page === 'hides' ? HIDES.title
  : page === 'history' ? AGENT.history : page.startsWith(READ_PAGE) ? reads?.read?.title ?? AGENT.history : root;

/**
 * @param {string[]} pages
 * @param {string} root
 * @param {AgentReads | null} reads
 * @returns {string}
 */
export const backLabel = (pages, root, reads) => pages.length > 1 ? pageWord(/** @type {string} */ (pages.at(-2)), reads, root) : root;

/**
 * @param {ReadPage} read
 * @returns {DetailPart[]}
 */
export function readParts(read) {
  const seen = read.refused ? [bare({ refused: read.refused })] : read.figure ? [bare({ amount: {
    n: read.figure.n.toLocaleString('en-GB'), words: read.figure.words,
    parts: read.kinds.map(kind => ({ id: kind.kind, name: kind.name, n: kind.n })) } })] : [];
  const kept = read.kept && !read.refused ? [bare({ label: AGENT.kept, lines: [read.kept.about], card: true, panel: panelOf({
    rows: read.kept.rows.map(row => rowOf(row.name, { end: { words: row.value } })), note: read.kept.held ?? '' }) })] : [];
  return [...seen, ...kept, ...read.why ? [bare({ label: AGENT.why, said: read.why })] : []];
}

/**
 * @param {ReadPage} read
 * @returns {Detail['foot']}
 */
export const readFoot = read => read.show && !read.refused ? { start: null, said: plainly(AGENT.seeExactly), end: [{ label: read.show.words,
  variant: 'secondary', do: { page: `${THINGS_PAGE}${read.id}` } }] } : null;

/**
 * @param {ThingsPage} things
 * @param {string} call
 * @returns {DetailPart[]}
 */
export function thingsParts(things, call) {
  return [
    ...things.groups.map(group => bare({ label: group.name, aside: plainly(group.n.toLocaleString('en-GB')), card: true,
      panel: panelOf({ rows: group.things.map(thing => {
        const route = routeOf(thing.opens);
        return rowOf(thing.title, { lead: { icon: group.icon }, line: thing.line ?? '',
          ...route ? { go: { do: /** @type {Do} */ ({ to: { view: route.go, patch: route.patch } }), value: '', time: thing.when ?? '' } }
            : { end: thing.when ? { time: thing.when } : null } });
      }) }) })),
    ...things.next ? [bare({ card: true, panel: panelOf({ rows: [rowOf(AGENT.showMore, { go: { do: { things: call }, value: '' } })] }) })] : [],
  ];
}

/**
 * @param {ThingsPage} held
 * @param {ThingsPage} page
 * @returns {ThingsPage}
 */
export function thingsWith(held, page) {
  const groups = held.groups.map(group => {
    const more = page.groups.find(each => each.kind === group.kind);
    return more ? { ...group, things: [...group.things, ...more.things] } : group;
  });
  return { ...held, groups: [...groups, ...page.groups.filter(each => !held.groups.some(group => group.kind === each.kind))],
    next: page.next };
}

/**
 * @param {string} id
 * @param {AgentRead} agent
 * @param {AgentReads} reads
 * @param {string} inside
 * @param {{ label: string, above: boolean }} back
 * @returns {Detail | null}
 */
function readDetail(id, agent, reads, inside, back) {
  if (inside.startsWith(READ_PAGE)) {
    const call = inside.slice(READ_PAGE.length);
    const read = reads.read?.id === call ? reads.read : null;
    if (!read) return detailOf(id, '', agentIcon(agent), { back, line: reads.readFailed || null, reading: !reads.readFailed });
    return detailOf(id, read.title, agentIcon(agent), { back, line: read.line, parts: readParts(read), foot: readFoot(read) });
  }
  if (!inside.startsWith(THINGS_PAGE)) return null;
  const call = inside.slice(THINGS_PAGE.length);
  const things = reads.things;
  if (!things) return detailOf(id, '', agentIcon(agent), { back, line: reads.thingsFailed || null, reading: !reads.thingsFailed });
  return detailOf(id, things.title, agentIcon(agent), { back, line: things.gone ?? '', parts: thingsParts(things, call) });
}

/**
 * @param {string} id
 * @param {AgentReads} reads
 * @param {Seen} seen
 * @returns {Detail}
 */
export function agentDetail(id, reads, seen) {
  const pages = seen.opened.pages;
  const agent = reads.one;
  const gone = agent?.state === 'disconnected';
  if (!agent || (!reads.editor && !gone)) {
    return detailOf(id, '', 'ai-apps', reads.oneFailed ? { line: reads.oneFailed } : { line: null, reading: true });
  }
  const inside = pages.at(-1);
  if (!inside) {
    return detailOf(id, agent.name, agentIcon(agent), { line: agent.disconnected ?? agent.reads.line, parts: agentParts(agent, reads, seen),
      callout: askCallout(agent, seen), foot: reads.editor ? savedFoot(reads.editor) : null });
  }
  const back = { label: backLabel(pages, agent.name, reads), above: true };
  if (inside === 'history') {
    const history = reads.history;
    return detailOf(id, AGENT.history, 'time', { back, line: '', parts: history
      ? historyPageParts(history, agent, seen)
      : [bare({ lines: [reads.historyFailed] })], reading: !history && !reads.historyFailed });
  }
  const opened = readDetail(id, agent, reads, inside, back);
  if (opened) return opened;
  if (inside === 'disconnect' && agent.disconnect) {
    return detailOf(id, agent.disconnect.head, agentIcon(agent), { back, line: agent.disconnect.line,
      parts: disconnectParts(agent.disconnect),
      foot: { start: null, end: [{ label: AGENT.cancel, variant: 'plain', do: { back: true } },
        { label: agent.disconnect.confirm, tone: 'warning', variant: 'primary', do: { disconnect: agent.id } }] } });
  }
  if (!reads.editor) return detailOf(id, agent.name, agentIcon(agent), { back, parts: [] });
  const page = pageInside(reads.editor, inside, agent.name, seen.opened);
  if (!page) return detailOf(id, agent.name, agentIcon(agent), { back, parts: [] });
  return detailOf(id, page.name, 'streams', { back, line: page.line, said: page.said, parts: page.parts,
    foot: inside === 'access' ? controlFoot(reads.editor.view, reads.editor, 'reader', false) : null });
}

/**
 * @param {AgentAsk} ask
 * @param {boolean} erased
 * @returns {AskAnswer[]}
 */
export const answerOrder = (ask, erased) => askChoices(ask, erased).map(each => each.answer)
  .sort((one, two) => (one === 'no' ? 0 : one === ask.default ? 2 : 1) - (two === 'no' ? 0 : two === ask.default ? 2 : 1));

/**
 * @param {AgentAsk} ask
 * @param {AskAnswer} answer
 */
export const answerKeys = (ask, answer) => answer === ask.default ? '↵' : answer === 'no' ? 'esc' : '⌘↵';

/** @param {Seen} seen */
const asksWaiting = seen => (seen.state?.agent_asks.filter(each => each.by !== 'chat').length ?? 0) + (seen.state?.agent_requests.length ?? 0);

/**
 * @param {string} id
 * @param {AgentAsk} ask
 * @param {AgentReads} reads
 * @param {Seen} seen
 * @returns {Detail}
 */
function askDetail(id, ask, reads, seen) {
  const editor = reads.editor;
  const open = editor !== null && !reads.over;
  const changes = open && askChanges(ask, reads.erased);
  const adds = (ask.adds.length ? ask.adds : [ask.wants]).map(add => rowOf(add, { lead: { icon: kindIcon(editor?.view ?? null, add) },
    line: ask.under ?? '',
    end: changes ? { acts: [{ label: ASKED.edit, variant: 'plain', do: { page: 'access' } }] } : null }));
  const many = asksWaiting(seen);
  const said = reads.over ? reads.editorFailed : reads.said || editor?.note || (many > 1 ? ASKED.asks(many) : '');
  const made = editor ? { access: /** @type {import('../../types.js').DraftAccess} */ (editor.access), expect: editor.expect ?? null,
    view: editor.view, narrowed: null, saved: null } : null;
  return detailOf(id, ask.head, 'ai-apps', { line: phraseWords(ask.asked_line),
    parts: [bare({ ask: askOf(ask) }), bare({ label: ASKED.adds, card: true, panel: panelOf({ rows: adds }) })],
    foot: { start: null, said: plainly(said), mark: '', busy: editor?.busy === true, end: open ? answerOrder(ask, reads.erased).map(answer => ({
      label: ask.choices.find(each => each.answer === answer)?.words ?? '', keys: answerKeys(ask, answer),
      variant: answer === ask.default ? /** @type {const} */ ('primary') : answer === 'no' ? 'plain' : 'secondary',
      disabled: reads.checking || reads.answering || editor?.busy === true,
      do: { answer: askAnswer(ask, answer, made) } })) : [] } });
}

/**
 * @param {AccessView | null} view
 * @param {string} name
 */
const kindIcon = (view, name) => view?.categories.find(each => each.name === name)?.icon ?? 'streams';

/**
 * @param {AgentAsk} ask
 * @returns {{ today: Bolded, says: { title: string, reason: string } | null, screen: string }}
 */
export const askOf = ask => ({ today: ask.today, says: ask.reason ? { title: ask.says_title, reason: ask.reason } : null,
  screen: ask.screen ?? '' });

/**
 * @param {string} id
 * @param {SignIn} signin
 * @param {AgentReads} reads
 * @param {Opened} opened
 * @returns {Detail}
 */
function signinDetail(id, signin, reads, opened) {
  const editor = reads.editor;
  const access = /** @type {import('../../types.js').Access | null} */ (editor?.access ?? null);
  const rows = accessRows(editor?.view ?? signin.view).map(row => rowOf(row.name, { lead: { icon: row.icon }, end: { words: row.value } }));
  const live = !reads.over && editor !== null;
  /** @param {string} answer @returns {AnswerRequest} */
  const answerOf = answer => signInAnswer(signin.id, answer, access);
  return detailOf(id, signin.head, 'ai-apps', { line: phraseWords(signin.over_line),
    parts: [bare({ label: SIGNING.sees, card: true, acts: live ? [{ label: SIGNING.edit, variant: 'plain', do: { page: 'access' } }] : [],
      panel: panelOf({ rows }) }),
    ...live ? [codePart(signin, opened, reads.answering, answerOf)] : []],
    foot: { start: null, said: plainly(reads.said || (reads.over ? reads.editorFailed : SIGNING.only)), mark: '', busy: editor?.busy === true,
      end: live ? [{ label: SIGNING.deny, variant: 'plain', disabled: reads.answering, do: { answer: answerOf('deny') } }] : [] } });
}

/**
 * @param {string} id
 * @param {AgentReads} reads
 * @param {Seen} seen
 * @returns {Detail}
 */
export function draftDetail(id, reads, seen) {
  const signin = id.startsWith('signin:') ? seen.state?.agent_requests.find(each => each.id === id.slice('signin:'.length))
    ?? (reads.signin?.id === id.slice('signin:'.length) ? reads.signin : null) : null;
  const ask = id.startsWith('ask:') ? reads.asked : null;
  const name = signin?.name ?? ask?.name ?? '';
  const editor = reads.editor;
  const inside = seen.opened.pages.at(-1);
  if (!inside && ask) return askDetail(id, ask, reads, seen);
  if (!inside && signin) return signinDetail(id, signin, reads, seen.opened);
  if (!signin && !ask || !editor) {
    const failed = reads.editorFailed;
    return detailOf(id, name, 'ai-apps', failed ? { line: failed } : { line: null, reading: !reads.over });
  }
  const root = signin?.head ?? ask?.head ?? '';
  const page = inside ? pageInside(editor, inside, name, seen.opened, true) : null;
  return detailOf(id, page?.name ?? root, 'streams', { back: { label: backLabel(seen.opened.pages, root, reads), above: true },
    line: page?.line ?? '', said: page?.said, parts: page?.parts ?? [],
    foot: inside === 'access' ? controlFoot(editor.view, editor, signin ? 'signin' : 'ask', reads.checking) : null });
}

/** @param {SignIn} signin */
export const signinDialog = signin => `signin:${signin.id}`;
