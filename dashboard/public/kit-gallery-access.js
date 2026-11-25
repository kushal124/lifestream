// @ts-check
import LIST from '../../homelink/Tests/Fixtures/agents/door/list.json' with { type: 'json' };
import READER from '../../homelink/Tests/Fixtures/agents/door/reader-agent.json' with { type: 'json' };
import READER_READS from '../../homelink/Tests/Fixtures/agents/door/reader-reads.json' with { type: 'json' };
import EDIT_MODE_ONLY from '../../homelink/Tests/Fixtures/agents/door/edit-mode-only.json' with { type: 'json' };
import EDIT_MODE_BUT from '../../homelink/Tests/Fixtures/agents/door/edit-mode-but.json' with { type: 'json' };
import EDIT_SPLIT from '../../homelink/Tests/Fixtures/agents/door/edit-narrowed-widening-waits.json' with { type: 'json' };
import DISCONNECTED from '../../homelink/Tests/Fixtures/agents/door/disconnect.json' with { type: 'json' };
import LIST_DISCONNECTED from '../../homelink/Tests/Fixtures/agents/door/list-disconnected.json' with { type: 'json' };
import READER_ASK from '../../homelink/Tests/Fixtures/agents/door/reader-ask.json' with { type: 'json' };
import OVERLAPPING from '../../homelink/Tests/Fixtures/agents/door/reader-overlapping.json' with { type: 'json' };
import NO_ACCESS from '../../homelink/Tests/Fixtures/agents/door/reader-no-access.json' with { type: 'json' };
import CHAT from '../../homelink/Tests/Fixtures/agents/door/reader-chat.json' with { type: 'json' };
import HISTORY from '../../homelink/Tests/Fixtures/agents/door/history.json' with { type: 'json' };
import HISTORY_KIND from '../../homelink/Tests/Fixtures/agents/door/history-kind.json' with { type: 'json' };
import HISTORY_REFUSED from '../../homelink/Tests/Fixtures/agents/door/history-refused.json' with { type: 'json' };
import HISTORY_REPEATS from '../../homelink/Tests/Fixtures/agents/door/history-repeats.json' with { type: 'json' };
import HISTORY_WAITING from '../../homelink/Tests/Fixtures/agents/door/history-waiting.json' with { type: 'json' };
import HISTORY_NONE from '../../homelink/Tests/Fixtures/agents/door/history-no-calls.json' with { type: 'json' };
import READ from '../../homelink/Tests/Fixtures/agents/door/read.json' with { type: 'json' };
import READ_JOINED from '../../homelink/Tests/Fixtures/agents/door/read-joined.json' with { type: 'json' };
import READ_REFUSED from '../../homelink/Tests/Fixtures/agents/door/read-refused.json' with { type: 'json' };
import THINGS from '../../homelink/Tests/Fixtures/agents/door/things.json' with { type: 'json' };
import THINGS_GONE from '../../homelink/Tests/Fixtures/agents/door/things-gone.json' with { type: 'json' };
import WAITING from '../../homelink/Tests/Fixtures/agents/door/waiting.json' with { type: 'json' };
import WAITING_SIGN_IN from '../../homelink/Tests/Fixtures/agents/door/waiting-sign-in.json' with { type: 'json' };
import EDIT_ASK from '../../homelink/Tests/Fixtures/agents/door/edit-ask.json' with { type: 'json' };
import EDIT_SIGN_IN from '../../homelink/Tests/Fixtures/agents/door/edit-sign-in.json' with { type: 'json' };
import PROPOSE_NARROWED from '../../homelink/Tests/Fixtures/agents/door/propose-narrowed.json' with { type: 'json' };
import PROPOSE_ASKED from '../../homelink/Tests/Fixtures/agents/door/propose-asked.json' with { type: 'json' };
import PROPOSE_UNCHANGED from '../../homelink/Tests/Fixtures/agents/door/propose-unchanged.json' with { type: 'json' };
import PROPOSE_ASKED_SCREEN from '../../homelink/Tests/Fixtures/agents/door/propose-asked-screen.json' with { type: 'json' };
import ASK_DECLINED from '../../homelink/Tests/Fixtures/agents/door/ask-declined.json' with { type: 'json' };
import PERSON_ONLY from '../../homelink/Tests/Fixtures/agents/door/answer-person-only.json' with { type: 'json' };
import ASK_ERASED from '../../homelink/Tests/Fixtures/agents/door/ask-erased.json' with { type: 'json' };
import ERASED_REFUSED from '../../homelink/Tests/Fixtures/agents/door/answer-erased.json' with { type: 'json' };
import ANSWERED from '../../homelink/Tests/Fixtures/agents/door/answer-once.json' with { type: 'json' };
import SIGNED_IN from '../../homelink/Tests/Fixtures/agents/door/answer-sign-in.json' with { type: 'json' };
import SIGN_IN_DENIED from '../../homelink/Tests/Fixtures/agents/door/answer-sign-in-deny.json' with { type: 'json' };
import SIGN_IN_WRONG from '../../homelink/Tests/Fixtures/agents/door/answer-sign-in-wrong.json' with { type: 'json' };
import GUIDES from '../../homelink/Tests/Fixtures/pages/agentGuides.mac.json' with { type: 'json' };
import { NOT_SURE } from './lib/agents.js';
import { esc } from './lib/html.js';
import { dayAt } from './lib/home-clock.js';
import { AT, HOST_STATE } from './kit-gallery-report.js';
import { agentDetail, draftDetail, HISTORY_FOLDS, NO_AGENT_READS, OPEN_FIELD, SINCE_FIELD, whenWords } from './ui/agents/detail.js';
import { ASKED } from './ui/agents/words.js';
import { askCard, noticeCard, signInCard } from './ui/agents/cards.js';
import { agentsList } from './ui/agents/list.js';
import { PAGE as AGENTS_PAGE } from './ui/agents/words.js';
import { bodyMarkup, readingMarkup, toolsMarkup } from './pages/agents.js';
import { OPENED } from './ui/connectors/dialog.js';
import { detailMarkup } from './ui/connectors/detail.js';
import { AT_REST } from './ui/connectors/view.js';
import { accessChatCard, accessNarrowed } from './ui/kit/access-card.js';
import { pageHead, pageLack, sectionLabel } from './ui/kit/index.js';
import { phraseWords } from './lib/words.js';

/** @param {{ outcome: unknown }} answer */
const outcomeOf = answer => phraseWords(/** @type {import('./types.js').Phrase | null} */ (answer.outcome));

/** @typedef {import('./types.js').AgentAsk} AgentAsk */
/** @typedef {import('./types.js').AgentRead} AgentRead */
/** @typedef {import('./types.js').AgentRow} AgentRow */
/** @typedef {import('./types.js').SignIn} SignIn */
/** @typedef {import('./types.js').AccessDraft} AccessDraft */
/** @typedef {import('./types.js').HistoryPage} HistoryPage */
/** @typedef {import('./types.js').ReadPage} ReadPage */
/** @typedef {import('./types.js').ThingsPage} ThingsPage */
/** @typedef {import('./lib/host.js').HostState} HostState */
/** @typedef {import('./ui/agents/detail.js').AgentReads} AgentReads */
/** @typedef {import('./ui/connectors/dialog.js').Opened} Opened */

const ASKS = /** @type {AgentAsk[]} */ (WAITING.answer.asks);
const [CHAT_ASK, WHATSAPP] = /** @type {[AgentAsk, AgentAsk]} */ (ASKS);
export const SIGNIN = /** @type {SignIn} */ (WAITING_SIGN_IN.answer.requests[0]);
const READERS = /** @type {AgentRow[]} */ (LIST.answer.readers);
const ASKING = /** @type {AgentRead} */ (READER_ASK.answer);
const HISTORY_PAGE = /** @type {HistoryPage} */ (HISTORY.answer);
const ASKING_READS = /** @type {AgentRead} */ ({ ...READER_READS.answer, ask: ASKING.ask });
/** @type {HostState} */
const ASKS_STATE = { ...HOST_STATE, agent_asks: ASKS };

/** @param {AgentRead} read @returns {AgentReads} */
const readsOf = read => ({ ...NO_AGENT_READS, one: read, history: HISTORY_PAGE,
  editor: read.state === 'disconnected' ? null : { view: read.view, busy: false, note: '', held: false } });
/** @param {AccessDraft} draft @param {Partial<AgentReads>} [more] @returns {AgentReads} */
const draftReads = (draft, more = {}) => ({ ...NO_AGENT_READS, editor: { view: draft.view, busy: false, note: '', held: false,
  access: draft.access, expect: draft.expect }, ...more });

/** @param {...HistoryPage} pages @returns {HistoryPage} */
const historyOfAll = (...pages) => ({ ...pages[0], sessions: pages.flatMap(page => page.sessions) });

/** @param {string} label @param {string} html */
const specimen = (label, html) => `<div class="gallery__specimen"><p class="gallery__label mac-mono-label">${esc(label)}</p>${html}</div>`;
/** @param {string} name @param {string} body */
const group = (name, body) => `<section class="gallery__group">${sectionLabel(name)}${body}</section>`;

/**
 * @param {{ readers: AgentRow[] | null, state?: HostState | null, failed?: string }} shown
 */
function agentsPage({ readers, state = ASKS_STATE, failed = '' }) {
  const guides = /** @type {import('./types.js').AgentGuides} */ (/** @type {unknown} */ (GUIDES));
  const list = readers ? agentsList({ readers, state, guides }) : null;
  const head = '<header class="ck-page__bar">' + pageHead({ title: AGENTS_PAGE.title, tools: [list ? toolsMarkup(list.adds) : ''] })
    + '</header>';
  const body = list ? bodyMarkup(list) : failed ? pageLack(failed, { retry: {} }) : readingMarkup();
  return `<div class="gallery__page ck-page${!list && !failed ? ' ck-reading' : ''}">${head}<div class="ck-page__scroll">`
    + `<div class="ck-page__body ck-page__body--one"><div class="ck-page__main">${body}</div></div></div></div>`;
}

/**
 * @param {string} label
 * @param {string} shot
 * @param {string} html
 */
const pageWindow = (label, shot, html) => specimen(label,
  `<div class="gallery__window gallery__connectors" data-shot="${esc(shot)}" data-geo="width:1226px;height:860px">${html}</div>`);

/**
 * @param {Partial<Opened>} opened
 * @param {HostState | null} [state]
 */
const seenOf = (opened, state = ASKS_STATE) => ({ state, opened: { ...OPENED, ...opened }, home: state !== null, now: AT,
  when: whenWords(dayAt(AT).day) });

/**
 * @param {string} label
 * @param {string} shot
 * @param {string} card
 */
const cardWindow = (label, shot, card) => pageWindow(label, shot, agentsPage({ readers: READERS })
  + `<div class="gallery__layer">${card}</div>`);

/**
 * @param {string} label
 * @param {string} shot
 * @param {import('./ui/connectors/dialog.js').Detail} detail
 * @param {string} [asking]
 */
const dialogWindow = (label, shot, detail, asking = '') => pageWindow(label, shot, agentsPage({ readers: READERS })
  + detailMarkup(detail, { ...AT_REST, asking }));

/**
 * @param {string} label
 * @param {string} shot
 * @param {AgentRead} read
 * @param {string} [asking]
 */
const goneWindow = (label, shot, read, asking = '') => pageWindow(label, shot,
  agentsPage({ readers: /** @type {AgentRow[]} */ (LIST_DISCONNECTED.answer.readers) })
  + detailMarkup(agentDetail(`agent:${read.id}`, readsOf(read), seenOf({})), { ...AT_REST, asking }));

/**
 * @param {string} label
 * @param {string} shot
 * @param {AgentRead} read
 * @param {Partial<Opened>} [opened]
 * @param {Partial<AgentReads>} [more]
 * @param {string} [asking]
 */
const agentWindow = (label, shot, read, opened = {}, more = {}, asking = '') => dialogWindow(label, shot,
  agentDetail(`agent:${read.id}`, { ...readsOf(read), ...more }, seenOf(opened)), asking);

const FOLD_KEY = (() => {
  const session = HISTORY_PAGE.sessions[0];
  const at = session?.lines.findIndex(line => line.kind === 'fold') ?? -1;
  return session && at >= 0 ? `${session.key}.${at}` : '';
})();

export function accessGallery() {
  const none = () => ({});
  const at = '<div class="gallery__rows">';
  const signInDraft = /** @type {AccessDraft} */ (EDIT_SIGN_IN.answer);
  const askDraft = /** @type {AccessDraft} */ (EDIT_ASK.answer);
  const narrowed = /** @type {AccessDraft} */ (EDIT_MODE_ONLY.answer);
  const widening = /** @type {AccessDraft} */ (EDIT_MODE_BUT.answer);
  const split = /** @type {AccessDraft} */ (EDIT_SPLIT.answer);
  const disconnected = /** @type {AgentRead} */ (DISCONNECTED.answer);
  const reads = /** @type {AgentRead} */ (READER_READS.answer);
  const reader = /** @type {AgentRead} */ (READER.answer);
  const opening = reader.view.categories.find(each => each.accounts.length > 1)?.type ?? '';
  return [
    group('Agent access · over the window', at + [
      specimen('An agent’s ask: who asks and for what, today, what it says, its answers, Review', askCard(WHATSAPP, { count: ASKED.asks(3),
        busy: null, offer: true, said: '', erased: false })),
      specimen('An answer on its way: that answer busy, the rest still', askCard(WHATSAPP, { count: '', busy: WHATSAPP.default,
        offer: true, said: '', erased: false })),
      specimen('A tap whose reply never came: read before a button', askCard(WHATSAPP, { count: '', busy: null, offer: false,
        said: NOT_SURE, erased: false })),
      specimen('An ask erased since: No alone', askCard(/** @type {AgentAsk} */ (ASK_ERASED.answer), { count: '', busy: null, offer: true,
        said: '', erased: true })),
      specimen('An approval refused as erased: the door’s words, No alone', askCard(WHATSAPP, { count: '', busy: null, offer: true,
        said: ERASED_REFUSED.answer.message, erased: true })),
      specimen('A sign-in: the home’s view, Edit, its lines', signInCard(SIGNIN, { view: SIGNIN.view, count: '', busy: null, refused: '' })),
      specimen('A sign-in, its draft kept: the draft’s rows', signInCard(SIGNIN, { view: signInDraft.view, count: '', busy: null, refused: '' })),
      specimen('An answer: the home’s outcome', noticeCard(outcomeOf(ANSWERED.answer))),
      specimen('A sign-in allowed: the home’s outcome', noticeCard(outcomeOf(SIGNED_IN.answer))),
      specimen('A sign-in not allowed: the home’s outcome', noticeCard(outcomeOf(SIGN_IN_DENIED.answer))),
      specimen('A number not the page’s: the home’s outcome', noticeCard(outcomeOf(SIGN_IN_WRONG.answer))),
    ].join('') + '</div>'),
    group('Agent access · Chat', at + [
      specimen('A narrowing, saved, with Undo', accessNarrowed({ words: PROPOSE_NARROWED.answer.words, undo: {} })),
      specimen('A change that changed nothing: its words alone', accessNarrowed({ words: [{ text: PROPOSE_UNCHANGED.answer.words }],
        undo: null })),
      specimen('Chat’s ask, open', accessChatCard({ snapshot: /** @type {AgentAsk} */ (PROPOSE_ASKED.answer.snapshot), now: CHAT_ASK,
        attrs: none, edit: {} })),
      specimen('Chat’s ask turning the screen on: its line', accessChatCard({ snapshot: /** @type {AgentAsk} */ (PROPOSE_ASKED_SCREEN.answer.snapshot),
        now: CHAT_ASK, attrs: none })),
      specimen('Chat’s ask answered from a browser: the door’s words', accessChatCard({ snapshot: /** @type {AgentAsk} */ (PROPOSE_ASKED.answer.snapshot), now: CHAT_ASK,
        said: PERSON_ONLY.answer.message, attrs: none })),
      specimen('Chat’s ask, ended: its outcome', accessChatCard({ snapshot: /** @type {AgentAsk} */ (PROPOSE_ASKED.answer.snapshot),
        now: /** @type {AgentAsk} */ (ASK_DECLINED.answer), attrs: none })),
    ].join('') + '</div>'),
    group('Agents · the page', '<div class="gallery__windows">' + [
      pageWindow('The agents: Needs you, Connected, In Lifestream', 'agents-list',
        agentsPage({ readers: READERS })),
      pageWindow('No agent connected yet: the page is the list of apps', 'agents-empty',
        agentsPage({ readers: READERS.filter(each => each.kind === 'chat'), state: HOST_STATE })),
      pageWindow('While the list is read', 'agents-reading', agentsPage({ readers: null })),
      pageWindow('The list not read', 'agents-failed', agentsPage({ readers: null, failed: AGENTS_PAGE.failed })),
      pageWindow('In a browser: no Connect, its asks from the list', 'agents-browser', agentsPage({ readers: READERS, state: null })),
      pageWindow('A disconnected agent under Disconnected', 'agents-list-disconnected',
        agentsPage({ readers: /** @type {AgentRow[]} */ (LIST_DISCONNECTED.answer.readers) })),
    ].join('') + '</div>'),
    group('Agents · an agent', '<div class="gallery__windows">' + [
      agentWindow('An agent: its ask, Access, History, Connection, Disconnect', 'agents-claude', ASKING),
      agentWindow('An agent with an ask and its reads: the frame stays 640, the body scrolls', 'agents-page-ask', ASKING_READS),
      agentWindow('Its reads: the figure, the week, the sentence, the last two reads', 'agents-page', reads),
      agentWindow('A narrowing saved from a menu: Saved, Undo ⌘Z', 'agents-page-saved', reads, {}, { editor: { view: narrowed.view,
        busy: false, note: '', held: false, narrowed: narrowed.narrowed, undoes: true } }),
      agentWindow('A widening from a menu waits: Cancel, Allow ↵', 'agents-page-widen', reads, {}, { editor: { view: widening.view,
        busy: false, note: '', held: true, narrowed: null, undoes: true } }),
      agentWindow('An agent with no ask', 'agents-agent', reader),
      agentWindow('Overlapping grants', 'agents-mixed', /** @type {AgentRead} */ (OVERLAPPING.answer)),
      agentWindow('No access', 'agents-none', /** @type {AgentRead} */ (NO_ACCESS.answer)),
      agentWindow('Chat: no Connection, no Disconnect', 'agents-chat', /** @type {AgentRead} */ (CHAT.answer)),
      agentWindow('Disconnect: the home’s Stops and Stays', 'agents-disconnect', ASKING, { pages: ['disconnect'] }),
      goneWindow('Disconnected: its history, Remove from the list…', 'agents-disconnected', disconnected),
      goneWindow('Remove from the list: asked first', 'agents-disconnected-remove', disconnected, `unlist:${disconnected.id}`),
      agentWindow('History: the figure, a section a day, its rows', 'agents-history', reads, { pages: ['history'] }),
      agentWindow('History: a fold opened', 'agents-history-open', reads, { pages: ['history'], fields: { [HISTORY_FOLDS]: FOLD_KEY } }),
      agentWindow('History: every kind of row, the figure and its chips', 'agents-history-busy', reads, { pages: ['history'] },
        { history: historyOfAll(/** @type {HistoryPage} */ (HISTORY_REPEATS.answer), /** @type {HistoryPage} */ (HISTORY_WAITING.answer),
          /** @type {HistoryPage} */ (HISTORY_REFUSED.answer), /** @type {HistoryPage} */ (HISTORY.answer)) }),
      agentWindow('History: a chip picked, the home’s filter', 'agents-history-kind', reads, { pages: ['history'] },
        { history: /** @type {HistoryPage} */ (HISTORY_KIND.answer), kind: 'messages' }),
      agentWindow('History: never read', 'agents-history-none', reads, { pages: ['history'] },
        { history: /** @type {HistoryPage} */ (HISTORY_NONE.answer) }),
      agentWindow('A read: its figure, its kinds, what was kept, why it could, Show', 'agents-read', reads,
        { pages: ['history', `read:${READ_JOINED.answer.id}`] }, { read: /** @type {ReadPage} */ (READ_JOINED.answer) }),
      agentWindow('A read with its kinds kept', 'agents-read-one', reads,
        { pages: ['history', `read:${READ.answer.id}`] }, { read: /** @type {ReadPage} */ (READ.answer) }),
      agentWindow('A read refused: no figure, no Kept, no Show', 'agents-read-refused', reads,
        { pages: ['history', `read:${READ_REFUSED.answer.id}`] }, { read: /** @type {ReadPage} */ (READ_REFUSED.answer) }),
      agentWindow('The things a read saw', 'agents-things', reads,
        { pages: ['history', `read:${READ.answer.id}`, `things:${READ.answer.id}`] },
        { read: /** @type {ReadPage} */ (READ.answer), things: /** @type {ThingsPage} */ (THINGS.answer) }),
      agentWindow('The things, some gone', 'agents-things-gone', reads,
        { pages: ['history', `read:${READ.answer.id}`, `things:${READ.answer.id}`] },
        { read: /** @type {ReadPage} */ (READ.answer), things: /** @type {ThingsPage} */ (THINGS_GONE.answer) }),
    ].join('') + '</div>'),
    group('Agents · Access', '<div class="gallery__windows">' + [
      agentWindow('Access: Everything but, one list, its windows', 'agents-access', reader, { pages: ['access'] }),
      agentWindow('Access: a kind’s accounts open', 'agents-access-account', reader, { pages: ['access'],
        fields: { [OPEN_FIELD]: opening } }),
      agentWindow('Access: each kind’s reads in 30 days', 'agents-access-reads', reads, { pages: ['access'] }),
      agentWindow('Access: to Only these saves at once, Undo ⌘Z', 'agents-access-narrowed', reads, { pages: ['access'] },
        { editor: { view: narrowed.view, busy: false, note: '', held: false, narrowed: narrowed.narrowed, undoes: true } }),
      agentWindow('Access: a narrowing saved in a browser: no Undo', 'agents-access-narrowed-browser', reads, { pages: ['access'] },
        { editor: { view: narrowed.view, busy: false, note: '', held: false, narrowed: narrowed.narrowed, undoes: false } }),
      agentWindow('Access: to Everything but waits for Allow', 'agents-access-widen', reads, { pages: ['access'] },
        { editor: { view: widening.view, busy: false, note: '', held: true, before: narrowed.view } }),
      agentWindow('Access: a narrowing saved while a widening waits: two lines, Cancel, Allow ↵', 'agents-access-split', reads,
        { pages: ['access'] }, { editor: { view: split.view, busy: false, note: '', held: true, narrowed: split.narrowed, undoes: true,
          before: split.saved?.view ?? null } }),
      agentWindow('Access: overlapping grants', 'agents-access-mixed', /** @type {AgentRead} */ (OVERLAPPING.answer), { pages: ['access'] }),
      agentWindow('Hides: the level, then each type', 'agents-hides', reader, { pages: ['hides'] }),
      agentWindow('Since…: a date', 'agents-since', reader, { pages: ['access', 'since:all'], fields: { [SINCE_FIELD]: '2026-10-01' } }),
    ].join('') + '</div>'),
    group('Agents · over the window', '<div class="gallery__windows">' + [
      cardWindow('An ask over Agents: ↵ ⌘↵ esc, Review, 1 of 3', 'agents-ask-card', askCard(WHATSAPP, { count: ASKED.asks(3), busy: null,
        offer: true, said: '', erased: false })),
      cardWindow('An answer on its way: its own button busy, the rest held', 'agents-ask-card-busy', askCard(WHATSAPP, { count: '',
        busy: WHATSAPP.default, offer: true, said: '', erased: false })),
      cardWindow('After: the home’s outcome', 'agents-ask-after', noticeCard(outcomeOf(ANSWERED.answer))),
      cardWindow('A sign-in over Agents: the code is the yes', 'agents-signin-card', signInCard(SIGNIN, { view: SIGNIN.view, count: '',
        busy: null, refused: '' })),
    ].join('') + '</div>'),
    group('Agents · a sign-in and an ask', '<div class="gallery__windows">' + [
      dialogWindow('A sign-in: what it will see, the code', 'agents-signin', draftDetail(`signin:${SIGNIN.id}`, draftReads(signInDraft),
        seenOf({}, { ...ASKS_STATE, agent_requests: [SIGNIN] }))),
      dialogWindow('A sign-in’s access: Done', 'agents-signin-access', draftDetail(`signin:${SIGNIN.id}`, draftReads(signInDraft),
        seenOf({ pages: ['access'] }, { ...ASKS_STATE, agent_requests: [SIGNIN] }))),
      dialogWindow('An ask: today, what it says, what it would also see, its answers', 'agents-ask', draftDetail(`ask:${WHATSAPP.id}`,
        draftReads(askDraft, { asked: WHATSAPP }), seenOf({}))),
      dialogWindow('An ask’s access from what it proposes: Allow', 'agents-ask-access', draftDetail(`ask:${WHATSAPP.id}`,
        draftReads(askDraft, { asked: WHATSAPP }), seenOf({ pages: ['access'] }))),
      dialogWindow('An ask answered: the home’s outcome', 'agents-ask-answered', draftDetail(`ask:${WHATSAPP.id}`,
        { ...draftReads(askDraft, { asked: /** @type {AgentAsk} */ (ASK_DECLINED.answer) }), editor: null, over: true,
          editorFailed: outcomeOf(ASK_DECLINED.answer) }, seenOf({}))),
      dialogWindow('An ask’s access while how it stands is read: Allow waits', 'agents-ask-checking', draftDetail(`ask:${WHATSAPP.id}`,
        draftReads(askDraft, { asked: WHATSAPP, checking: true }), seenOf({ pages: ['access'] }))),
    ].join('') + '</div>'),
  ].join('');
}

