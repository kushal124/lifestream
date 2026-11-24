// @ts-check
/** @import { Mount } from '../ui/route.js' */
/** @import { Host, HostState } from '../lib/host.js' */
/** @import { AgentGuides, AgentsList as AgentsAnswer } from '../types.js' */
/** @import { StreamDialogs } from '../ui/connectors/layer.js' */
/** @import { AgentsList, GuidesList, ListRow } from '../ui/agents/list.js' */
import {
  button, connectorLine, connectorLineReading, connectorLines, pageHead, pageLack, reading, sectionLabel, sectionLabelReading,
  settingRow, settingsSection, settingTile,
} from '../ui/kit/index.js';
import { fetchAgents } from '../lib/api.js';
import { agentsList } from '../ui/agents/list.js';
import { CONNECT_ID } from '../ui/agents/detail.js';
import { guidesThrough } from '../ui/agents/guides.js';
import { GUIDE, PAGE } from '../ui/agents/words.js';
import { put } from '../ui/flows/frame.js';

/**
 * @param {ListRow} row
 */
const lineOf = row => connectorLine({ name: row.name, icon: row.icon, line: row.line, place: row.place, set_up: true, dim: row.dim,
  end: row.review ? { act: { label: PAGE.review, busy: false, attrs: { 'data-ag-open': row.review } } } : { last: row.when },
  opens: { 'data-ag-open': row.opens } });

/** @param {GuidesList} guides */
const guidesSection = guides => ({ name: guides.title, count: null, head: sectionLabel(guides.title),
  attrs: { 'data-ag-guides': '' },
  rows: settingsSection({ attrs: { class: 'ck-ssection--card' },
    rows: guides.rows.map(row => settingRow({ label: row.name, line: row.line, lead: settingTile(row.mark),
      go: { value: row.connected ? GUIDE.connected : '', attrs: { 'data-ag-open': row.opens } } })) }) });

/**
 * @param {AgentsList} list
 */
export const bodyMarkup = list => connectorLines([
  ...list.guides ? [guidesSection(list.guides)] : [],
  ...list.sections.map(section => ({ name: section.name, count: section.count, rows: section.rows.map(lineOf).join('') }))], PAGE.title);

export const readingMarkup = () => '<div aria-hidden="true">' + connectorLines([{ name: '', count: null,
  head: sectionLabelReading(5), rows: [0, 1, 2, 3].map(connectorLineReading).join('') }], PAGE.reading) + '</div>';

/**
 * @param {boolean} adds
 */
export const toolsMarkup = adds => adds ? button(PAGE.connect, {
  attrs: { 'data-ag-open': CONNECT_ID } }) : '';

const FRAME = '<div class="ck-page">'
  + '<header class="ck-page__bar" data-window-drag>' + pageHead({ title: PAGE.title, tools: ['<div data-part="tools"></div>'] })
  + '</header><div class="ck-page__scroll"><div class="ck-page__body"><div class="ck-page__main">'
  + `<div data-part="body" data-tour="agents">${readingMarkup()}</div></div>`
  + '<aside class="ck-page__side ck-page__side--top" aria-hidden="true"></aside></div></div></div>';

/**
 * @param {HTMLElement} container
 * @param {import('../ui/route.js').PageContext} context
 * @param {Host | null} host
 * @param {StreamDialogs} dialogs
 * @param {{ list?: () => Promise<AgentsAnswer> } & Partial<Pick<import('../ui/agents/guides.js').GuidesIO, 'guides'>>} [io]
 * @returns {ReturnType<Mount>}
 */
export function mountAgents(container, context, host, dialogs, { list = fetchAgents, ...io } = {}) {
  const { guides } = { ...guidesThrough(host), ...io };
  context.title(PAGE.title);
  container.innerHTML = FRAME;
  const root = /** @type {HTMLElement} */ (container.querySelector('.ck-page'));
  /** @param {string} name */
  const part = name => /** @type {HTMLElement} */ (root.querySelector(`[data-part="${name}"]`));
  /** @type {AgentsAnswer | null} */
  let answer = null;
  /** @type {AgentGuides | null} */
  let apps = null;
  let failed = '';
  /** @type {HostState | null} */
  let state = host?.state ?? null;
  let asked = 0;
  const drawn = { tools: '', body: '' };

  /**
   * @param {keyof typeof drawn} name
   * @param {string} markup
   */
  function show(name, markup) {
    if (drawn[name] === markup) return;
    put(part(name), markup);
    drawn[name] = markup;
  }

  function draw() {
    reading(root, answer === null && !failed, PAGE.reading);
    if (answer === null) {
      if (failed) show('body', pageLack(failed, { retry: { 'data-ag-retry': '' } }));
      return;
    }
    const shown = agentsList({ readers: answer.readers, state, guides: apps });
    show('tools', toolsMarkup(shown.adds));
    show('body', bodyMarkup(shown));
  }

  const read = () => {
    const mine = ++asked;
    return list().then(async read => {
      if (mine !== asked) return;
      const empty = !read.readers.some(each => each.kind !== 'chat' && each.state === 'connected');
      const missed = empty && state ? await guides().then(each => {
        apps = each;
        return '';
      }, error => /** @type {Error} */ (error).message || PAGE.failed) : '';
      if (mine !== asked) return;
      answer = missed && !apps ? null : read;
      failed = answer ? '' : missed;
      draw();
    }, error => {
      if (mine !== asked) return;
      failed = /** @type {Error} */ (error).message || PAGE.failed;
      draw();
    });
  };

  root.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    const opener = /** @type {HTMLElement | null} */ (target.closest('[data-ag-open]'));
    if (opener) return context.dialog(/** @type {string} */ (opener.dataset.agOpen));
    const doer = /** @type {HTMLElement | null} */ (target.closest('[data-cn-do]'));
    if (doer) return void dialogs.run(/** @type {string} */ (doer.dataset.cnDo), doer.dataset.cnLabel);
    if (target.closest('[data-ag-retry]')) {
      failed = '';
      draw();
      void read();
    }
  });

  new MutationObserver(() => {
    if (!container.hidden) void read();
  }).observe(container, { attributes: true, attributeFilter: ['hidden'] });
  let open = dialogs.id;
  dialogs.follow(() => {
    if (open && !dialogs.id && !container.hidden) void read();
    open = dialogs.id;
  });
  let heard = '';
  host?.follow(next => {
    state = next;
    const now = JSON.stringify([next.agent_asks.map(each => each.id), next.agent_requests.map(each => each.id)]);
    if (now !== heard && heard && !container.hidden) void read();
    heard = now;
    draw();
  });
  void read();
  return { update: () => undefined };
}
