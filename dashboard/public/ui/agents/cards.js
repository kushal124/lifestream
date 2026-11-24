// @ts-check
/** @import { Host, HostState } from '../../lib/host.js' */
/** @import { AgentAsk, AnswerReply, AskAnswer, SignIn, SignInRead } from '../../types.js' */
/** @import { Attributes } from '../../lib/html.js' */
import { fetchAsk, fetchSignIn } from '../../lib/api.js';
import { answerWord, askAnswer, refusalWords, signInAnswer } from '../../lib/agents.js';
import { parseRoute } from '../../lib/hash.js';
import { phraseWords } from '../../lib/words.js';
import { accessFoot, agentCard, askBody, pickSection, button, settingRow, settingsSection, settingTile, settingValue } from '../kit/index.js';
import { accessRows, answerKeys, answerOrder, askOf, CONNECT_ID, plainly } from './detail.js';
import { GUIDE_PAGE } from './guides.js';
import { drafts } from './drafts.js';
import { ACCESS, ASKED, PAGE, SIGNING } from './words.js';

/** @param {string} id @param {number | string} answer @returns {Attributes} */
const pick = (id, answer) => ({ 'data-agent-pick': JSON.stringify({ id, answer }) });

/**
 * @param {SignIn} request
 * @param {{ view: import('../../types.js').AccessView, count: string, busy: number | 'deny' | null, refused: string }} shown
 */
export function signInCard(request, { view, count, busy, refused }) {
  const held = busy !== null;
  const sees = settingsSection({ heading: SIGNING.sees, attrs: { class: 'ck-ssection--card' },
    act: button(SIGNING.edit, { variant: 'plain', size: 'sm', disabled: held, attrs: { 'data-agent-change': `signin:${request.id}` } }),
    rows: accessRows(view).map(row => settingRow({ label: row.name, lead: settingTile(row.icon), end: settingValue(row.value) })) });
  return agentCard({ id: request.id, title: request.head, line: phraseWords(request.over_line), count,
    body: sees + pickSection({ label: request.pick, line: request.pick_line,
      choices: request.choices.map(n => ({ n, busy: busy === n, attrs: pick(request.id, n) })) }),
    foot: accessFoot({ said: plainly(refused || SIGNING.only), acts: button(SIGNING.deny, { variant: 'plain', size: 'sm',
      busy: busy === 'deny', disabled: held, attrs: pick(request.id, 'deny') }) }) });
}

/**
 * @param {AgentAsk} ask
 * @param {{ count: string, busy: AskAnswer | null, offer: boolean, said: string, erased: boolean }} shown
 */
export function askCard(ask, { count, busy, offer, said, erased }) {
  const answers = offer ? answerOrder(ask, erased).map(answer => button(ask.choices.find(each => each.answer === answer)?.words ?? '', {
    variant: answer === ask.default ? 'primary' : answer === 'no' ? 'plain' : 'secondary', size: 'sm', key: answerKeys(ask, answer),
    busy: busy === answer, disabled: busy !== null,
    attrs: { ...pick(ask.id, answer), 'data-access-key': answerKeys(ask, answer), ...answer === ask.default ? { 'data-access-default': '' } : {} },
  })).join('') : '';
  return agentCard({ id: ask.id, title: ask.head, line: phraseWords(ask.asked_line), count, body: askBody(askOf(ask)),
    foot: accessFoot({ said: plainly(said), acts: button(PAGE.review, { variant: 'plain', size: 'sm', disabled: busy !== null,
      attrs: { 'data-agent-change': `ask:${ask.id}` } })
      + (answers ? `<div class="ck-agent__answers" role="group" aria-label="Answer">${answers}</div>` : '') }) });
}

/** @param {string} words */
export const noticeCard = words => agentCard({ id: 'notice', title: words, role: 'status',
  foot: accessFoot({ acts: button(ACCESS.done, { size: 'sm', attrs: { 'data-agent-ok': '' } }) }) });

/**
 * @param {HTMLElement} holder
 * @param {Host} host
 * @param {(shown: boolean) => void} shown
 * @param {{ read?: (id: string) => Promise<AgentAsk>, signIn?: (id: string) => Promise<SignInRead> }} [parts]
 */
export function installAgentCards(holder, host, shown, { read = fetchAsk, signIn = fetchSignIn } = {}) {
  /** @type {{ id: string, answer: number | string } | null} */
  let busy = null;
  /** @type {Map<string, string>} */
  const said = new Map();
  /** @type {Set<string>} */
  const held = new Set();
  /** @type {Set<string>} */
  const erased = new Set();
  let notice = '';
  let noticeOf = '';
  /** @type {HostState} */
  let state = host.state;
  /** @type {boolean | null} */
  let standing = null;
  let focused = '';
  /** @type {{ id: string, ask: boolean, over: string } | null} */
  let drawn = null;
  let away = '';

  const dialogAt = () => (parseRoute(window.location.hash).dialog ?? '').split('/');
  const dialogShown = () => dialogAt()[0];
  /** @param {SignIn} request */
  const guided = request => dialogAt()[0] === CONNECT_ID && Boolean(request.app) && dialogAt()[1] === `${GUIDE_PAGE}${request.app}`;

  /** @param {{ id: string, ask: boolean, over: string }} left */
  const readLeft = left => (left.ask ? read(left.id) : signIn(left.id)).then(said => {
    notice = 'state' in said && said.state === 'gone' ? left.over : phraseWords(said.outcome);
  }, error => {
    const gone = /** @type {{ code?: string }} */ (error).code === 'AGENT_REQUEST_GONE';
    notice = !gone ? '' : left.ask ? refusalWords(error) : left.over;
  }).finally(() => {
    if (away !== left.id) return;
    if (notice) noticeOf = left.id;
    else away = '';
    draw();
  });

  const draw = () => {
    const signins = state.agent_requests;
    const left = drawn;
    if (left && !busy && noticeOf !== left.id && !(left.ask ? state.agent_asks : signins).some(each => each.id === left.id)) {
      drawn = null;
      away = left.id;
      notice = '';
      void readLeft(left);
    }
    const asks = state.agent_asks.filter(each => each.by !== 'chat');
    for (const id of drafts.ids()) if (!signins.some(each => each.id === id)) drafts.forget(id);
    for (const id of [...held, ...erased, ...said.keys()]) {
      if (signins.some(each => each.id === id) || asks.some(each => each.id === id)) continue;
      held.delete(id);
      erased.delete(id);
      said.delete(id);
    }
    const [request] = signins;
    const ask = request ? null : asks[0] ?? null;
    const more = signins.length + asks.length - 1;
    const current = request?.id ?? ask?.id ?? '';
    const holding = away !== '';
    if (!holding && current && current !== noticeOf) notice = '';
    const aside = request ? dialogShown() === `signin:${request.id}` || guided(request)
      : ask ? dialogShown() === `ask:${ask.id}` : false;
    const count = more ? ASKED.asks(more + 1) : '';
    const markup = holding ? notice ? noticeCard(notice) : '' : aside ? '' : request ? signInCard(request, { view: drafts.of(request.id)?.view ?? request.view, count,
      busy: busy?.id === request.id ? /** @type {number | 'deny'} */ (busy.answer) : null, refused: said.get(request.id) ?? '' })
      : ask ? askCard(ask, { count, busy: busy?.id === ask.id ? /** @type {AskAnswer} */ (busy.answer) : null,
        offer: !held.has(ask.id), said: said.get(ask.id) ?? '', erased: erased.has(ask.id) })
        : notice ? noticeCard(notice) : '';
    const was = !holder.hidden;
    holder.hidden = !markup;
    if (holder.innerHTML !== markup) holder.innerHTML = markup;
    const card = ask && !aside && !holding ? ask.id : '';
    if (card && card !== focused && !was) /** @type {HTMLElement | null} */ (holder.querySelector('[data-access-default]'))?.focus();
    focused = card;
    if (!holding) drawn = aside ? null : request ? { id: request.id, ask: false, over: request.over }
      : ask ? { id: ask.id, ask: true, over: '' } : null;
    if (standing !== !holder.hidden) shown(standing = !holder.hidden);
  };

  /** @param {string} id */
  const readAsk = id => read(id).then(ask => {
    if (ask.state === 'open') return void held.delete(id);
    said.set(id, phraseWords(ask.outcome));
    notice = phraseWords(ask.outcome);
    noticeOf = id;
  }, error => {
    if (/** @type {{ code?: string }} */ (error).code !== 'AGENT_REQUEST_GONE') return;
    said.set(id, refusalWords(error));
    notice = refusalWords(error);
    noticeOf = id;
  }).finally(draw);

  holder.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest('[data-agent-ok]')) {
      notice = '';
      away = '';
      return draw();
    }
    const change = /** @type {HTMLElement | null} */ (target.closest('[data-agent-change]'));
    if (change) {
      window.location.hash = `#dialog=${encodeURIComponent(change.dataset.agentChange ?? '')}`;
      return;
    }
    const pressed = /** @type {HTMLElement | null} */ (target.closest('[data-agent-pick]'));
    if (!pressed || busy) return;
    const chosen = /** @type {{ id: string, answer: number | 'deny' | AskAnswer }} */ (JSON.parse(pressed.dataset.agentPick ?? '{}'));
    const ask = state.agent_asks.find(each => each.id === chosen.id) ?? null;
    if (ask && held.has(ask.id)) return;
    const answer = ask ? askAnswer(ask, /** @type {AskAnswer} */ (chosen.answer))
      : signInAnswer(chosen.id, /** @type {number | 'deny'} */ (chosen.answer), drafts.of(chosen.id)?.access ?? null);
    busy = chosen;
    said.delete(chosen.id);
    draw();
    host.act({ act: 'agent-answer', ...answer }).then(reply => {
      notice = answerWord({ answer: /** @type {AnswerReply} */ (reply.answer) }).words;
      noticeOf = chosen.id;
      if (ask) held.add(ask.id);
      else drafts.forget(chosen.id);
    }, error => {
      const refusal = /** @type {{ message: string, code?: string }} */ (error);
      const word = answerWord({ refused: { code: refusal.code ?? '', message: refusal.message } });
      if (ask) {
        said.set(ask.id, word.words);
        if (word.erased) return void erased.add(ask.id);
        held.add(ask.id);
        void readAsk(ask.id);
        return;
      }
      if (state.agent_requests.some(each => each.id === chosen.id)) said.set(chosen.id, word.words);
      notice = word.words;
      noticeOf = chosen.id;
    }).finally(() => {
      busy = null;
      draw();
    });
  });

  document.addEventListener('keydown', event => {
    if (holder.hidden || event.defaultPrevented || event.target instanceof HTMLInputElement) return;
    const key = event.key === 'Escape' ? 'esc' : event.key === 'Enter' && event.metaKey ? '⌘↵' : '';
    const pressed = key ? holder.querySelector(`[data-access-key="${key}"]:not(:disabled)`) : null;
    if (!(pressed instanceof HTMLElement)) return;
    event.preventDefault();
    pressed.click();
  });

  window.addEventListener('hashchange', draw);
  drafts.follow(draw);
  host.follow(next => {
    state = next;
    draw();
  });
}
