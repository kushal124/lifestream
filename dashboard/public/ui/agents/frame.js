// @ts-check
/** @import { Host, HostState } from '../../lib/host.js' */
/** @import { Detail, Opened } from '../connectors/dialog.js' */
/** @import { AccessDraft, AgentAsk, AgentRead, AnswerRequest, AnswerReply, Edit, EditRequest, HistoryPage, Access, DraftAccess, ReadPage, ThingsPage, Version } from '../../types.js' */
/** @import { AgentReads } from './detail.js' */
import {
  answerAgent, editAccess, fetchAgent, fetchAgentHistory, fetchAsk, fetchRead, fetchThings, fetchWaiting, saveAccess,
} from '../../lib/api.js';
import { answerKey, answerWord } from '../../lib/agents.js';
import { requestEditor, settingsEditor } from '../../lib/editor.js';
import { today } from '../../lib/home-clock.js';
import { drafts } from './drafts.js';
import { guidesFrame, guidesThrough } from './guides.js';
import {
  agentDetail, CONNECT_ID, draftDetail, EDITOR_BUSY, historyWith, NO_AGENT_READS, READ_PAGE, SINCE_FIELD, sinceEdit,
  THINGS_PAGE, thingsWith, whenWords,
} from './detail.js';
import { AGENT } from './words.js';

/**
 * @typedef {object} AgentsIO
 * @property {(id: string) => Promise<AgentRead>} reader
 * @property {(id: string, before?: string, kind?: string) => Promise<HistoryPage>} history
 * @property {(id: string, call: string) => Promise<ReadPage>} read
 * @property {(id: string, call: string, before?: string) => Promise<ThingsPage>} things
 * @property {(id: string) => Promise<AgentAsk>} ask
 * @property {(asked: EditRequest) => Promise<AccessDraft>} edit
 * @property {(id: string, saved: { access: DraftAccess, expect: Version }) => Promise<AccessDraft>} save
 * @property {(answer: AnswerRequest) => Promise<unknown>} answer
 */

/** @type {AgentsIO} */
export const AGENTS_IO = { reader: fetchAgent, history: fetchAgentHistory, read: fetchRead, things: fetchThings, ask: fetchAsk,
  edit: editAccess, save: saveAccess, answer: answerAgent };

/** @typedef {{ id: string, state: HostState | null, opened: Opened, shown: boolean, zone: string }} AgentsAt */

/** @typedef {{ edit: Edit } | { editor: 'save' | 'cancel' | 'done' | 'allow' | 'undo' } | { since: string } | { answer: AnswerRequest } | { earlier: string } | { kind: string } | { things: string } | { disconnect: string } | { unlist: string } | { guide: import('./guides.js').GuideDo }} AgentsDoing */

/**
 * @param {string} dialog
 * @returns {string}
 */
const keyOf = dialog => /^(agent|signin|ask):[^/]+$/u.test(dialog) ? dialog : '';

/**
 * @param {object} parts
 * @param {Host | null} parts.host
 * @param {() => void} parts.draw
 * @param {() => boolean} parts.holdsHome
 * @param {(key: string, run: () => Promise<void>) => Promise<unknown>} parts.hold
 * @param {AgentsIO} [parts.io]
 * @param {Pick<Window, 'addEventListener'> | null} [parts.page]
 */
export function agentsFrame({ host, draw, holdsHome, hold, io = AGENTS_IO, page = globalThis.window ?? null }) {
  /** @type {AgentsAt} */
  let at = { id: '', state: null, opened: /** @type {Opened} */ (/** @type {unknown} */ ({ pages: [], typed: '' })), shown: false,
    zone: 'UTC' };
  let agents = { ...NO_AGENT_READS };
  let reading = '';
  let said = '';
  let saidErased = false;
  /** @type {import('../../types.js').SignIn | null} */
  let signin = null;
  /** @type {Set<string>} */
  const answering = new Set();
  /** @type {Set<string>} */
  const guided = new Set();
  let guide = '';
  const guides = guidesFrame({ io: { ...guidesThrough(host), edit: io.edit, waiting: fetchWaiting }, draw, page, open: target => {
    if ('app' in target) return void host?.act({ act: 'open', what: 'app', app: target.app }).catch(() => undefined);
    if (host) return void host.act({ act: 'open', what: 'site', url: target.url }).catch(() => undefined);
    window.open(target.url, '_blank', 'noopener');
  } });
  /** @param {AnswerRequest} answer @returns {Promise<unknown>} */
  const answered = answer => host ? host.act({ act: 'agent-answer', ...answer }).then(reply => reply.answer) : io.answer(answer);
  /**
   * @typedef {{ key: string, reader: import('../../lib/editor.js').SettingsEditor | null, request: import('../../lib/editor.js').RequestEditor | null }} Editing
   * @type {Editing | null}
   */
  let editing = null;
  /** @param {unknown} error */
  const wordsOf = error => /** @type {Error} */ (error).message || AGENT.unreached;
  /** @param {unknown} error */
  const refusalOf = error => ({ code: String(/** @type {{ code?: unknown }} */ (error).code ?? ''), message: wordsOf(error) });
  /** @param {string} id */
  const readReader = id => io.reader(id).then(one => {
    if (reading === id) {
      agents = { ...agents, one, oneFailed: '' };
      if (editing?.key === `agent:${id}`) editing.reader?.open(one);
      draw();
    }
    return one;
  });
  /** @param {string} id */
  const readOne = id => Promise.all([
    readReader(id).catch(error => {
      if (reading === id) agents = { ...agents, one: null, oneFailed: wordsOf(error) };
    }),
    io.history(id, undefined, agents.kind || undefined).then(history => ({ history, historyFailed: '' }),
      error => ({ history: null, historyFailed: wordsOf(error) }))
      .then(landed => {
        if (reading === id) agents = { ...agents, ...landed };
      }),
  ]).then(draw);
  let opening = '';
  /** @param {string} id @param {string} page */
  const readPage = (id, page) => {
    if (!id || page === opening) return;
    opening = page;
    if (page.startsWith(READ_PAGE)) {
      const call = page.slice(READ_PAGE.length);
      if (agents.read?.id === call) return;
      agents = { ...agents, read: null, readFailed: '' };
      void io.read(id, call).then(read => ({ read, readFailed: '' }), error => ({ read: null, readFailed: wordsOf(error) })).then(landed => {
        if (reading !== id || opening !== page) return;
        agents = { ...agents, ...landed };
        draw();
      });
      return;
    }
    if (!page.startsWith(THINGS_PAGE)) return;
    const call = page.slice(THINGS_PAGE.length);
    agents = { ...agents, things: null, thingsFailed: '' };
    void io.things(id, call).then(things => ({ things, thingsFailed: '' }), error => ({ things: null, thingsFailed: wordsOf(error) }))
      .then(landed => {
        if (reading !== id || opening !== page) return;
        agents = { ...agents, ...landed };
        draw();
      });
  };
  /**
   * @param {string} key
   * @returns {Editing}
   */
  const editorOf = key => {
    const id = key.slice(key.indexOf(':') + 1);
    if (!key.startsWith('agent:')) {
      return { key, reader: null, request: requestEditor({ kind: key.startsWith('ask:') ? 'ask' : 'signin', id, changed: draw,
        io: { edit: io.edit, read: io.ask }, kept: each => drafts.of(each)?.access ?? null }) };
    }
    const reader = settingsEditor({ reader: id, changed: draw, io: {
      edit: io.edit, save: io.save, read: readReader,
      get widen() {
        if (!holdsHome() || !host) return null;
        return (/** @type {string} */ reader, /** @type {{ access: DraftAccess, expect: number }} */ saved) => host
          .act({ act: 'agent-access', id: reader, ...saved })
          .then(reply => /** @type {AccessDraft} */ (reply.answer), error => {
            const { code, message } = refusalOf(error);
            throw Object.assign(new Error(message), { said: message, code });
          });
      },
    } });
    return { key, reader, request: null };
  };
  const editorNow = () => editing?.reader ?? editing?.request ?? null;

  /** @returns {AgentReads} */
  const readsNow = () => {
    const editor = editorNow();
    const draft = editor?.draft ?? null;
    const note = editor?.note ?? '';
    const request = editing?.request ?? null;
    const held = editing?.reader?.held != null;
    return { ...agents, said, saidErased, asked: request?.ask ?? null, answering: answering.size > 0, erased: request?.erased ?? false,
      checking: request?.checking ?? false, signin,
      editor: draft ? { view: draft.view, busy: editor?.busy ?? false, note, held, access: draft.access, expect: draft.expect,
        narrowed: editing?.reader?.narrowed ?? null, undoes: editing?.reader?.undoes ?? false,
        before: held ? editing?.reader?.saved ?? null : null } : null,
      editorFailed: draft ? '' : request?.ended || note, over: request?.over ?? false };
  };

  return {
    /** @param {AgentsAt} standing */
    follow(standing) {
      at = standing;
      guides.follow({ id: at.id, pages: at.opened.pages, state: at.state, shown: at.shown, fields: at.opened.fields ?? {} });
      const now = at.shown && at.id === CONNECT_ID ? at.opened.pages[0] ?? '' : '';
      if (now !== guide) {
        for (const id of guided) drafts.forget(id);
        guided.clear();
        guide = now;
      }
      const key = !at.shown ? '' : at.id === CONNECT_ID ? guides.editing : keyOf(at.id);
      if (editing && editing.key !== key) {
        editing.reader?.close();
        editing.request?.close();
        editing = null;
      }
      const id = key.startsWith('agent:') ? key.slice('agent:'.length) : '';
      if (id !== reading) {
        reading = id;
        opening = '';
        agents = { ...NO_AGENT_READS };
        said = '';
        saidErased = false;
        if (id) void readOne(id);
      }
      if (key.startsWith('signin:')) {
        const id = key.slice('signin:'.length);
        signin = at.state?.agent_requests.find(each => each.id === id) ?? (signin?.id === id ? signin : null);
      } else signin = null;
      if (!key) said = '';
      readPage(id, [...at.opened.pages].reverse().find(page => page.startsWith(READ_PAGE) || page.startsWith(THINGS_PAGE)) ?? '');
      if (key && !editing) {
        editing = editorOf(key);
        if (editing.reader && agents.one?.id === id) editing.reader.open(agents.one);
      }
      editing?.request?.follow(at.state);
    },
    get reads() {
      return readsNow();
    },
    /**
     * @param {{ id: string, state: HostState | null, opened: Opened, home: boolean, now: number }} seen
     * @returns {Detail | null}
     */
    detail({ id, state, opened, home, now }) {
      const shown = { state, opened, home, now, when: whenWords(today()) };
      if (id === CONNECT_ID) return guides.detail(shown, readsNow());
      if (id.startsWith('agent:')) return agentDetail(id, readsNow(), shown);
      if (id.startsWith('signin:') || id.startsWith('ask:')) return draftDetail(id, readsNow(), shown);
      return null;
    },
    /**
     * @param {AgentsDoing} doing
     * @returns {Promise<'close' | 'back' | undefined>}
     */
    async act(doing) {
      if ('guide' in doing) return guides.act(doing.guide);
      const keyDraft = at.id === CONNECT_ID ? guides.draft : null;
      if (keyDraft && ('edit' in doing || 'since' in doing)) {
        /** @type {'back' | undefined} */
        let result;
        await hold(EDITOR_BUSY, async () => {
          if ('edit' in doing) return void await keyDraft.tap(doing.edit);
          const edit = sinceEdit(doing.since, at.opened.fields?.[SINCE_FIELD] ?? '', day => dayStartIn(day, at.zone));
          if (edit) await keyDraft.tap(edit);
          result = 'back';
        });
        draw();
        return result;
      }
      if ('earlier' in doing) {
        const before = agents.history?.next?.before;
        if (!before || agents.one?.id !== doing.earlier) return;
        const kind = agents.kind;
        await hold(`earlier:${doing.earlier}`, async () => {
          const page = await io.history(doing.earlier, before, kind || undefined);
          if (!agents.history || agents.one?.id !== doing.earlier || agents.kind !== kind) return;
          agents = { ...agents, history: historyWith(agents.history, page) };
        });
        draw();
        return;
      }
      if ('kind' in doing) {
        const id = reading;
        if (!id) return;
        const kind = doing.kind;
        agents = { ...agents, kind };
        draw();
        await hold(`history:${id}`, async () => {
          const history = await io.history(id, undefined, kind || undefined);
          if (reading !== id || agents.kind !== kind) return;
          agents = { ...agents, history, historyFailed: '' };
        });
        draw();
        return;
      }
      if ('things' in doing) {
        const before = agents.things?.next;
        const id = reading;
        if (!before || !id) return;
        await hold(`things:${doing.things}`, async () => {
          const page = await io.things(id, doing.things, before);
          if (!agents.things || reading !== id) return;
          agents = { ...agents, things: thingsWith(agents.things, page) };
        });
        draw();
        return;
      }
      if ('disconnect' in doing || 'unlist' in doing) {
        const id = 'disconnect' in doing ? doing.disconnect : doing.unlist;
        if (!host || agents.one?.id !== id) return;
        /** @type {'close' | 'back' | undefined} */
        let after;
        await hold(JSON.stringify(doing), async () => {
          if ('disconnect' in doing) {
            await host.act({ act: 'agent-disconnect', id });
            await readOne(id);
            after = 'back';
            return;
          }
          await host.act({ act: 'agent-unlist', id });
          after = 'close';
        });
        return after;
      }
      if ('answer' in doing) {
        const answer = doing.answer;
        if (answering.has(answer.id)) return;
        said = '';
        saidErased = false;
        answering.add(answer.id);
        await hold(answerKey(answer), async () => {
          await answered(answer).then(reply => {
            const landed = reply && typeof reply === 'object' && 'outcome' in reply ? /** @type {AnswerReply} */ (reply) : null;
            said = landed && !(at.id === CONNECT_ID) ? answerWord({ answer: landed }).words : '';
            if (landed) guides.answered(answer.id, landed);
          }, error => {
            ({ words: said, erased: saidErased } = answerWord({ refused: refusalOf(error) }));
          });
          if (reading) await readOne(reading);
        }).finally(() => answering.delete(answer.id));
        draw();
        return;
      }
      const session = editing;
      const editor = editorNow();
      if (!session || !editor) return;
      /** @type {'close' | 'back' | undefined} */
      let result;
      await hold(EDITOR_BUSY, async () => {
        if ('edit' in doing) return void await editor.tap(doing.edit);
        if ('since' in doing) {
          const edit = sinceEdit(doing.since, at.opened.fields?.[SINCE_FIELD] ?? '', day => dayStartIn(day, at.zone));
          if (edit) await editor.tap(edit);
          result = 'back';
          return;
        }
        if (doing.editor === 'save') return void await session.reader?.save();
        if (doing.editor === 'cancel') return session.reader?.cancel();
        if (doing.editor === 'undo') return void await session.reader?.undo();
        const request = session.request;
        const draft = request?.draft;
        if (!request || !draft || request.busy || request.checking) return;
        if (doing.editor === 'done') {
          const id = session.key.slice('signin:'.length);
          drafts.keep(id, { access: /** @type {Access} */ (draft.access), view: draft.view });
          if (at.id === CONNECT_ID) guided.add(id);
          result = at.opened.pages.length ? 'back' : 'close';
          return;
        }
        if (await request.allow(answered)) result = 'close';
      });
      draw();
      return result;
    },
  };
}

/**
 * @param {string} day
 * @param {string} zone
 */
export function dayStartIn(day, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  /** @param {number} ms */
  const offset = ms => {
    const said = Object.fromEntries(parts.formatToParts(ms).map(each => [each.type, each.value]));
    return Date.UTC(Number(said.year), Number(said.month) - 1, Number(said.day), Number(said.hour), Number(said.minute),
      Number(said.second)) - ms;
  };
  const wall = Date.parse(`${day}T00:00:00Z`);
  const first = wall - offset(wall);
  return wall - offset(first);
}

/** @typedef {ReturnType<typeof agentsFrame>} AgentsFrame */
