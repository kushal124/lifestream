// @ts-check
/** @import { Access, AccessDraft, AgentAsk, AgentRead, AnswerRequest, DraftAccess, Edit, EditRequest, EditTarget, Narrowed, SignIn,
 *   Version } from '../types.js' */
import { askAnswer, ERASED, refusalWords } from './agents.js';
import { phraseWords } from './words.js';

/** @param {unknown} error */
const codeOf = error => String(/** @type {{ code?: unknown }} */ (error)?.code ?? '');

/** @param {unknown} error */
export const wordsOf = error => {
  const said = /** @type {{ said?: unknown }} */ (error)?.said;
  return typeof said === 'string' && said ? said : refusalWords(error);
};

/**
 * @param {object} parts
 * @param {EditTarget} parts.target
 * @param {(asked: EditRequest) => Promise<AccessDraft>} parts.edit
 * @param {() => void} parts.changed
 * @param {(code: string, words: string) => void} [parts.stale]
 */
export function draftEditor({ target, edit, changed, stale = () => {} }) {
  /** @type {AccessDraft | null} */
  let draft = null;
  let busy = false;
  let failed = '';
  let era = 0;
  let closed = false;

  /**
   * @param {EditRequest} asked
   * @returns {Promise<boolean>}
   */
  const send = asked => {
    const mine = era;
    busy = true;
    failed = '';
    changed();
    return edit(asked).then(answer => {
      if (closed || mine !== era) return false;
      draft = answer;
      busy = false;
      changed();
      return true;
    }, error => {
      if (closed || mine !== era) return false;
      busy = false;
      failed = refusalWords(error);
      changed();
      const code = codeOf(error);
      if (code === 'ACCESS_CHANGED' || code === 'AGENT_REQUEST_GONE') stale(code, failed);
      return false;
    });
  };

  return {
    get draft() {
      return draft;
    },
    get busy() {
      return busy;
    },
    get failed() {
      return failed;
    },
    /**
     * @param {DraftAccess} access
     * @param {Version | null} expect
     */
    start(access, expect) {
      era += 1;
      draft = null;
      return send({ target, access, expect, edit: null });
    },
    drop() {
      era += 1;
      draft = null;
      busy = false;
      changed();
    },
    /** @param {AccessDraft} next */
    hold(next) {
      era += 1;
      draft = next;
      busy = false;
      failed = '';
      changed();
    },
    /** @param {Edit} tapped */
    tap(tapped) {
      if (closed || busy || !draft) return Promise.resolve(false);
      return send({ target, access: draft.access, expect: draft.expect, edit: tapped });
    },
    /** @param {string} words */
    say(words) {
      failed = words;
      changed();
    },
    close() {
      closed = true;
      era += 1;
    },
  };
}

/** @typedef {ReturnType<typeof draftEditor>} DraftEditor */

/**
 * @typedef {object} SettingsIO
 * @property {(asked: EditRequest) => Promise<AccessDraft>} edit
 * @property {(id: string, saved: { access: DraftAccess, expect: Version }) => Promise<AccessDraft>} save
 * @property {((id: string, saved: { access: DraftAccess, expect: Version }) => Promise<AccessDraft>) | null} widen
 * @property {(id: string) => Promise<AgentRead>} read
 */

/** @param {{ reader: string, io: SettingsIO, changed: () => void }} parts */
export function settingsEditor({ reader, io, changed }) {
  /** @type {AccessDraft | null} */
  let saved = null;
  /** @type {AccessDraft | null} */
  let held = null;
  /** @type {Narrowed | null} */
  let narrowed = null;
  let saving = false;
  let note = '';
  let closed = false;
  const preview = draftEditor({ target: { reader }, edit: io.edit, changed, stale: (_code, words) => void again(words) });

  /** @param {AgentRead} read */
  const open = read => {
    saved = { access: read.access, expect: read.version, view: read.view, narrowed: null, saved: null };
    held = null;
    narrowed = null;
    preview.hold(saved);
  };

  /** @param {string} words */
  const again = words => {
    saving = true;
    note = words;
    changed();
    return io.read(reader).then(read => {
      if (closed) return;
      open(read);
    }, () => undefined).finally(() => {
      if (closed) return;
      saving = false;
      note = words;
      changed();
    });
  };

  /** @param {AccessDraft} draft */
  const commit = async draft => {
    const sent = { access: draft.access, expect: /** @type {Version} */ (draft.expect) };
    saving = true;
    changed();
    try {
      const answer = draft.view.widens && io.widen ? await io.widen(reader, sent) : await io.save(reader, sent);
      if (!closed) {
        saved = answer;
        if (answer.expect !== sent.expect) narrowed = null;
        preview.hold(answer);
      }
    } catch (error) {
      if (closed) return;
      saving = false;
      await again(wordsOf(error));
      return;
    }
    if (closed) return;
    saving = false;
    changed();
  };

  return {
    /** @param {AgentRead} read */
    open(read) {
      note = '';
      open(read);
    },
    get draft() {
      return held ?? preview.draft ?? saved;
    },
    get held() {
      return held;
    },
    get saved() {
      return saved?.view ?? null;
    },
    get busy() {
      return saving || preview.busy;
    },
    get note() {
      return preview.failed || note;
    },
    get narrowed() {
      return narrowed;
    },
    get undoes() {
      return io.widen !== null;
    },
    /** @param {Edit} tapped */
    async tap(tapped) {
      if (closed || saving || preview.busy || !saved) return;
      note = '';
      if (!await preview.tap(tapped)) return;
      const draft = /** @type {AccessDraft} */ (preview.draft);
      if (draft.narrowed && draft.saved) {
        saved = { ...draft.saved, expect: draft.expect, narrowed: null, saved: null };
        narrowed = draft.narrowed;
        held = draft.view.widens || draft.view.screen !== null ? draft : null;
        return changed();
      }
      if (draft.view.widens || draft.view.screen !== null) {
        held = draft;
        return changed();
      }
      held = null;
      await commit(draft);
    },
    async save() {
      const draft = held;
      if (!draft || saving) return;
      held = null;
      await commit(draft);
    },
    cancel() {
      held = null;
      if (saved) preview.hold(saved);
    },
    async undo() {
      const undoing = narrowed;
      const put = io.widen;
      if (closed || saving || !undoing || !put) return;
      saving = true;
      changed();
      try {
        const answer = await put(reader, undoing.undo);
        if (closed) return;
        saved = answer;
        narrowed = null;
        preview.hold(answer);
      } catch (error) {
        if (closed) return;
        saving = false;
        await again(wordsOf(error));
        return;
      }
      saving = false;
      changed();
    },
    close() {
      closed = true;
      preview.close();
    },
  };
}

/** @typedef {ReturnType<typeof settingsEditor>} SettingsEditor */

/**
 * @param {object} parts
 * @param {'signin' | 'ask'} parts.kind
 * @param {string} parts.id
 * @param {{ edit: (asked: EditRequest) => Promise<AccessDraft>, read: (id: string) => Promise<AgentAsk> }} parts.io
 * @param {(id: string) => Access | null} parts.kept
 * @param {() => void} parts.changed
 */
export function requestEditor({ kind, id, io, kept, changed }) {
  const draft = draftEditor({ target: { request: id }, edit: io.edit, changed, stale: (code, words) => {
    if (code === 'AGENT_REQUEST_GONE') end(words);
    else check(true);
  } });
  /** @type {AgentAsk | null} */
  let ask = null;
  /** @type {string | null} */
  let ended = null;
  let checking = false;
  let reading = false;
  let fresh = false;
  /** @type {number | null} */
  let from = null;
  let said = '';
  let unread = '';
  let erased = false;
  /** @type {DraftAccess | null} */
  let drawn = null;
  /** @type {{ agent_requests: SignIn[], agent_asks: AgentAsk[] } | null | undefined} */
  let seen;
  let closed = false;

  /** @param {string} words */
  const end = words => {
    ended = words;
    checking = false;
    draft.close();
    changed();
  };
  /** @param {boolean} restart */
  const check = restart => {
    if (kind !== 'ask' || closed || ended !== null) return;
    checking = true;
    if (restart) {
      fresh = true;
      draft.drop();
    }
    changed();
    if (reading) return;
    reading = true;
    io.read(id).then(now => {
      reading = false;
      if (closed || ended !== null) return;
      ask = now;
      unread = '';
      if (now.state !== 'open') return end(phraseWords(now.outcome));
      checking = false;
      if (fresh || from !== now.version || !draft.draft) {
        fresh = false;
        from = now.version;
        return void draft.start(now.proposed, now.version);
      }
      changed();
    }, error => {
      reading = false;
      if (closed || ended !== null) return;
      if (String(/** @type {{ code?: unknown }} */ (error)?.code ?? '') === 'AGENT_REQUEST_GONE') return end(refusalWords(error));
      unread = refusalWords(error);
      changed();
    });
  };

  return {
    get ask() {
      return ask;
    },
    get draft() {
      return ended !== null ? null : draft.draft;
    },
    get ended() {
      return ended ?? '';
    },
    get over() {
      return ended !== null;
    },
    get checking() {
      return checking;
    },
    get busy() {
      return draft.busy;
    },
    get erased() {
      return erased;
    },
    get note() {
      return said || draft.failed || unread;
    },
    /** @param {{ agent_requests: SignIn[], agent_asks: AgentAsk[] } | null} state */
    follow(state) {
      if (closed || ended !== null || state === seen) return;
      const first = seen === undefined;
      seen = state;
      if (kind === 'signin') {
        if (!state) return;
        const signIn = state.agent_requests.find(each => each.id === id) ?? null;
        if (signIn ? !first : draft.busy) return;
        const access = signIn ? kept(id) ?? signIn.access : draft.draft?.access ?? drawn ?? kept(id);
        if (!access) return end('');
        drawn = access;
        void draft.start(access, null);
        return;
      }
      if (first) return check(true);
      if (!state) return;
      const listed = state.agent_asks.find(each => each.id === id);
      if (!listed) return check(false);
      if (from !== null && listed.version !== from) return check(true);
      if (checking) check(false);
    },
    /** @param {Edit} tapped */
    tap(tapped) {
      if (ended !== null || checking) return Promise.resolve(false);
      said = '';
      return draft.tap(tapped);
    },
    /** @param {(answer: AnswerRequest) => Promise<unknown>} send */
    async allow(send) {
      const made = draft.draft;
      if (kind !== 'ask' || closed || ended !== null || checking || draft.busy || !made || !ask) return false;
      said = '';
      try {
        await send(askAnswer(ask, ask.default, made));
        return true;
      } catch (error) {
        if (closed) return false;
        const code = String(/** @type {{ code?: unknown }} */ (error)?.code ?? '');
        said = /** @type {Error} */ (error)?.message || refusalWords(error);
        erased = code === ERASED;
        if (code === 'AGENT_REQUEST_GONE') end(said);
        else if (!erased) check(code === 'ACCESS_CHANGED');
        else changed();
        return false;
      }
    },
    close() {
      closed = true;
      draft.close();
    },
  };
}

/** @typedef {ReturnType<typeof requestEditor>} RequestEditor */
