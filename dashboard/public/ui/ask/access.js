// @ts-check
/** @import { Host, HostState } from '../../lib/host.js' */
/** @import { AccessChange, AgentAsk, AnswerRequest, AskAnswer } from '../../types.js' */
/** @import { Turn } from './turns.js' */
import { answerAgent, fetchAsk } from '../../lib/api.js';
import { askAnswer, ERASED, refusalWords } from '../../lib/agents.js';
import { accessChatCard, accessNarrowed } from '../kit/access-card.js';

export const AGAIN_MS = 10_000;

/** @param {{ host: Host | null, redraw: () => void, shown: () => Turn[], read?: (id: string) => Promise<AgentAsk>, answer?: (answer: AnswerRequest) => Promise<unknown>, later?: (run: () => void, ms: number) => void }} page */
export function chatAccess({ host, redraw, shown, read = fetchAsk, answer = answerAgent, later = (run, ms) => { setTimeout(run, ms); } }) {
  /**
   * @typedef {{ ask: AgentAsk | null, checking: boolean, failed: boolean, gone: string, reading: boolean }} Standing
   * @type {Map<string, Standing>}
   */
  const asks = new Map();

  /** @param {string} id */
  const readAsk = id => {
    const standing = asks.get(id);
    if (!standing || standing.gone !== '' || standing.reading) return;
    standing.reading = true;
    read(id).then(ask => {
      standing.ask = ask;
      standing.checking = false;
      standing.failed = false;
    }, error => {
      if (/** @type {{ code?: unknown }} */ (error)?.code === 'AGENT_REQUEST_GONE') {
        standing.gone = refusalWords(error);
        standing.checking = false;
      } else {
        standing.failed = true;
      }
    }).finally(() => {
      standing.reading = false;
      wait();
      redraw();
    });
  };
  /** @param {Standing} standing */
  const owed = standing => standing.gone === '' && (standing.checking || standing.failed);
  const again = () => {
    for (const [id, standing] of asks) if (owed(standing)) readAsk(id);
  };
  const shownOwed = () => shown().some(turn => turn.access.some(change => {
    const standing = change.kind === 'asked' ? asks.get(change.snapshot.id) : undefined;
    return standing !== undefined && !standing.reading && owed(standing);
  }));
  let pending = false;
  const wait = () => {
    if (host || pending || !shownOwed()) return;
    pending = true;
    later(() => {
      pending = false;
      if (shownOwed()) again();
    }, AGAIN_MS);
  };
  /** @param {string} id */
  const enter = id => {
    if (asks.has(id)) return;
    asks.set(id, { ask: null, checking: false, failed: false, gone: '', reading: false });
    readAsk(id);
  };

  /** @type {Set<string>} */
  let waiting = new Set();
  /** @param {HostState} state */
  const follow = state => {
    const now = new Set(state.agent_asks.map(each => each.id));
    for (const [id, standing] of asks) {
      if (waiting.has(id) && !now.has(id) && standing.ask?.state === 'open') standing.checking = true;
    }
    again();
    waiting = now;
    redraw();
  };
  host?.follow(follow);

  /** @type {Map<string, string>} */
  const busy = new Map();
  /** @type {Set<string>} */
  const undone = new Set();
  /** @type {Map<string, string>} */
  const said = new Map();
  /** @type {Set<string>} */
  const erased = new Set();

  /**
   * @param {string} key
   * @param {string} pressed
   * @param {() => Promise<unknown>} sending
   * @param {() => void} taken
   * @param {() => void} [after]
   * @param {(code: string) => void} [refused]
   */
  const tap = (key, pressed, sending, taken, after = () => {}, refused = () => {}) => {
    if (busy.size) return;
    busy.set(key, pressed);
    said.delete(key);
    redraw();
    sending().then(taken, error => {
      const refusal = /** @type {{ message: string, code?: string }} */ (error);
      said.set(key, refusal.message);
      refused(refusal.code ?? '');
    }).finally(() => {
      busy.delete(key);
      after();
      redraw();
    });
  };

  /**
   * @param {Turn[]} turns
   * @param {string} id
   * @returns {AccessChange | undefined}
   */
  const changeOf = (turns, id) => turns.flatMap(turn => turn.access).find(change => change.id === id);

  return {
    /** @param {Turn} turn */
    markup(turn) {
      return turn.access.map(change => {
        if (change.kind === 'unchanged') return accessNarrowed({ words: [{ text: change.words }], undo: null });
        if (change.kind === 'narrowed') {
          return accessNarrowed({ words: change.words, busy: busy.has(change.id), undone: undone.has(change.id),
            said: said.get(change.id) ?? '', undo: host ? { 'data-ask-access': JSON.stringify({ undo: change.id }) } : null });
        }
        const { snapshot } = change;
        enter(snapshot.id);
        wait();
        const standing = /** @type {Standing} */ (asks.get(snapshot.id));
        const now = standing.ask;
        return accessChatCard({ snapshot, now: now && now.state === 'open' && standing.checking ? null : now,
          gone: standing.gone,
          busy: /** @type {AskAnswer | null} */ (busy.get(change.id) ?? null), said: said.get(change.id) ?? '',
          erased: erased.has(snapshot.id),
          edit: { 'data-ask-access': JSON.stringify({ edit: snapshot.id }) },
          attrs: answer => ({ 'data-ask-access': JSON.stringify({ ask: change.id, answer }) }) });
      }).join('');
    },
    /**
     * @param {HTMLElement} control
     * @param {Turn[]} turns
     */
    press(control, turns) {
      const pressed = /** @type {{ undo?: string, ask?: string, answer?: AskAnswer, edit?: string }} */ (JSON.parse(control.dataset.askAccess ?? '{}'));
      if (pressed.edit) {
        window.location.hash = `#dialog=${encodeURIComponent(`ask:${pressed.edit}`)}`;
        return;
      }
      if (pressed.undo) {
        if (!host) return;
        const change = changeOf(turns, pressed.undo);
        if (change?.kind !== 'narrowed' || undone.has(change.id)) return;
        tap(change.id, 'undo', () => host.act({ act: 'agent-access', id: change.reader, access: change.undo.access,
          expect: change.undo.expect }), () => undone.add(change.id));
        return;
      }
      const change = pressed.ask ? changeOf(turns, pressed.ask) : undefined;
      if (change?.kind !== 'asked' || !pressed.answer) return;
      const id = change.snapshot.id;
      const standing = asks.get(id);
      const now = standing?.ask;
      if (!standing || !now || now.state !== 'open' || standing.checking || standing.gone !== '') return;
      const asked = askAnswer(now, pressed.answer);
      tap(change.id, pressed.answer, () => host ? host.act({ act: 'agent-answer', ...asked }) : answer(asked), () => undefined, () => {
        if (erased.has(id)) return;
        standing.checking = true;
        readAsk(id);
      }, code => {
        if (code === ERASED) erased.add(id);
      });
    },
  };
}
