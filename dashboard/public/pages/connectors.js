// @ts-check
/** @import { Mount } from '../ui/route.js' */
/** @import { Host, HostState } from '../lib/host.js' */
/** @import { ReportReader } from '../lib/report.js' */
/** @import { StreamsReport } from '../types.js' */
/** @import { Filter } from '../ui/connectors/page.js' */
/** @import { PlaceKey } from '../ui/connectors/words.js' */
/** @import { StreamDialogs } from '../ui/connectors/layer.js' */
import {
  COPIED_MS, inPlaceLine, installFilterMenus, pageHead, pageLack, reading, searchField, searchWaiting, showCopied, waitLine,
} from '../ui/kit/index.js';
import { dismissOwn, onDismissed } from '../ui/connectors/dismissed.js';
import { pageOf } from '../ui/connectors/page.js';
import { lacks } from '../lib/reach.js';
import { UNREAD } from '../lib/report.js';
import { bodyMarkup, menusMarkup, saidMarkup, sideMarkup } from '../ui/connectors/view.js';
import { put } from '../ui/flows/frame.js';
import { copyText } from '../ui/dom.js';
import { applyGeometry } from '../ui/geometry.js';
import { whileShown } from '../ui/live.js';
import { IMPORTS_SEG } from '../ui/connectors/imports.js';
import { PAGE } from '../ui/connectors/words.js';

const LOADING = 'Reading your connectors';

/**
 * @param {string} seg
 * @returns {import('../ui/connectors/page.js').Shown | ''}
 */
const shownOf = seg => seg === 'connected' ? 'connected' : seg === 'not' || seg === IMPORTS_SEG ? 'not' : '';

/** @param {boolean} hosted */
const frame = hosted => '<div class="ck-page">'
  + '<header class="ck-page__bar" data-window-drag>' + pageHead({ title: PAGE.title, tools: [
    '<div class="cn-menus" data-part="menus"></div>',
    searchField({ placeholder: PAGE.search, shortcut: hosted ? '⌘F' : '/', outlined: true, attrs: { 'data-cn-q': '' } }),
  ] }) + '</header>'
  + '<div class="ck-page__scroll" data-part="scroll"><div class="ck-page__body"><div class="ck-page__main">'
  + '<div class="cn-said" data-part="said"></div>'
  + '<p class="sr-only" aria-live="polite" data-part="count"></p>'
  + '<div class="cn-body" data-part="body"></div></div>'
  + '<aside class="ck-page__side ck-page__side--top cn-side" aria-label="Lifestream and devices" data-part="side"></aside></div></div></div>';

/**
 * @param {HTMLElement} container
 * @param {import('../ui/route.js').PageContext} context
 * @param {Host | null} host
 * @param {ReportReader} reports
 * @param {StreamDialogs} dialogs
 * @returns {ReturnType<Mount>}
 */
export function mountConnectors(container, context, host, reports, dialogs) {
  context.title(PAGE.title);
  /** @type {Filter} */
  const filter = { query: '', place: '' };
  container.innerHTML = frame(host !== null);
  const root = /** @type {HTMLElement} */ (container.querySelector('.ck-page'));
  const field = /** @type {HTMLInputElement} */ (root.querySelector('[data-cn-q]'));
  /** @param {string} name */
  const part = name => /** @type {HTMLElement} */ (root.querySelector(`[data-part="${name}"]`));
  /** @type {StreamsReport | null} */
  let report = reports.seen.report;
  let failure = reports.failure();
  /** @type {HostState | null} */
  let state = host?.state ?? null;
  const drawn = { menus: '', said: '', body: '', side: '' };
  let removed = false;
  let adding = false;
  const alerts = { open: false, copied: '' };

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
    const drawn = reports.drawn();
    reading(root, report === null && drawn?.kind !== 'lack', LOADING);
    searchWaiting(field, report === null);
    root.classList.toggle('ck-lacks', lacks(state?.reach));
    const view = dialogs.view;
    show('said', report && failure && !view.error ? inPlaceLine(failure) : saidMarkup(dialogs.said()));
    filter.shown = shownOf(context.route.seg);
    const page = pageOf(report, state, filter, { unanswered: drawn !== null, adding });
    const failed = report || drawn?.kind !== 'lack' ? ''
      : pageLack(drawn.words ?? UNREAD, drawn.retry ? { retry: { 'data-connectors-retry': '' } } : {});
    const lack = !report && drawn && drawn.kind !== 'lack' ? pageLack(PAGE.elsewhere, { reach: true }) : '';
    if (!part('menus').querySelector('[aria-expanded="true"]')) show('menus', menusMarkup(page, filter));
    if (page.alerts.length < 2) alerts.open = false;
    const body = bodyMarkup(page, view, dialogs.id, failed, { away: lacks(state?.reach), alerts, filter }) + lack;
    show('body', !report && drawn?.kind === 'wait' ? body.replace(waitLine(), waitLine(drawn.words)) : body);
    applyGeometry(part('body'));
    show('side', sideMarkup(page, removed));
    if (report && part('count').textContent !== page.announce) part('count').textContent = page.announce;
  }

  /** @param {string} at */
  function showAt(at) {
    const label = part('body').querySelector(`[data-cn-area="${CSS.escape(at)}"]`);
    if (label instanceof HTMLElement) label.scrollIntoView({ block: 'start' });
  }

  const read = () => reports.read();
  const heard = () => {
    report = reports.seen.report;
    failure = reports.failure();
    draw();
  };

  /**
   * @param {string} key
   * @param {string} [label]
   */
  function run(key, label) {
    const doing = /** @type {import('../ui/connectors/words.js').Do} */ (JSON.parse(key));
    if ('at' in doing && doing.at === IMPORTS_SEG) return context.set({ seg: IMPORTS_SEG });
    if ('at' in doing) return showAt(doing.at);
    if ('fold' in doing && doing.fold === 'adding') {
      adding = !adding;
      return draw();
    }
    if ('fold' in doing && doing.fold === 'alerts') {
      alerts.open = !alerts.open;
      return draw();
    }
    if ('dismiss' in doing) return dismissOwn(doing.dismiss);
    if ('fold' in doing) {
      removed = !removed;
      return draw();
    }
    void dialogs.run(key, label);
  }

  root.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    const copying = /** @type {HTMLElement | null} */ (target.closest('[data-cn-copy]'));
    if (copying) {
      const alert = copying.dataset.cnAlert;
      void copyText(copying.dataset.cnCopy ?? '').then(() => {
        if (!alert) return showCopied(copying);
        alerts.copied = alert;
        draw();
        window.setTimeout(() => {
          if (alerts.copied !== alert) return;
          alerts.copied = '';
          draw();
        }, COPIED_MS);
      });
      return;
    }
    const seg = /** @type {HTMLElement | null} */ (target.closest('[data-cn-seg]'));
    if (seg) return context.set({ seg: seg.dataset.cnSeg ?? '' });
    const opener = /** @type {HTMLElement | null} */ (target.closest('[data-cn-open]'));
    const doer = /** @type {HTMLElement | null} */ (target.closest('[data-cn-do]'));
    const flow = /** @type {HTMLElement | null} */ (target.closest('[data-cn-flow]'))?.dataset.cnFlow;
    if (flow) context.flow(flow);
    else if (doer) run(/** @type {string} */ (doer.dataset.cnDo), doer.dataset.cnLabel);
    else if (opener) context.dialog(/** @type {string} */ (opener.dataset.cnOpen));
    else if (target.closest('[data-connectors-retry]')) {
      failure = '';
      draw();
      void read();
    }
  });

  installFilterMenus(root, (menu, value) => {
    if (menu.dataset.cnMenu === 'place') filter.place = /** @type {PlaceKey | ''} */ (value);
    draw();
  });

  field.addEventListener('input', () => {
    filter.query = field.value;
    draw();
  });

  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || container.hidden) return;
    if (host && event.metaKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      field.focus();
      field.select();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const active = document.activeElement;
    if (active === field) {
      if (event.key === 'Escape') {
        event.preventDefault();
        field.blur();
      }
      return;
    }
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    if (event.key === '/') {
      event.preventDefault();
      field.focus();
      field.select();
    }
  });
  reports.follow(heard, container);
  onDismissed(draw);
  const { hear } = whileShown(container, draw, () => undefined);
  dialogs.follow(() => hear(undefined));
  host?.follow(next => {
    state = next;
    draw();
  });
  let at = context.route.seg === IMPORTS_SEG ? IMPORTS_SEG : '';
  reports.follow(() => {
    if (!at || !report) return;
    showAt(at);
    at = '';
  }, container);
  draw();
  void read();
  return {
    update(route) {
      draw();
      if (route.seg !== IMPORTS_SEG) return;
      if (report) showAt(IMPORTS_SEG);
      else at = IMPORTS_SEG;
    },
  };
}
