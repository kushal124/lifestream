// @ts-check
/** @import { Host, HostAct, HostState } from '../../lib/host.js' */
/** @import { ReportReader } from '../../lib/report.js' */
/** @import { StreamsReport } from '../../types.js' */
/** @import { PageChanges } from './changes.js' */
/** @import { Detail, Opened } from './dialog.js' */
import { sessionOf } from '../flows/model.js';
import { actRunner, flowFrame } from '../flows/frame.js';
import { OPENED } from './dialog.js';
import { fetchOutbound, fetchOutboundRow, fetchStorage } from '../../lib/api.js';
import { onHomeChange } from '../live.js';
import { pageReach } from '../../lib/reach.js';
import { storageReads } from './settings-storage.js';
import { isSettings, NO_PRIVACY, savedAct, settingsDetail, shownPage, TYPED } from './settings.js';
import { OUTBOUND_DAYS, outboundAt } from './settings-privacy.js';
import { today as homeToday } from '../../lib/home-clock.js';
import { shiftDay } from '../../lib/words.js';
import { SUBSCRIPTIONS } from './settings-models.js';

/** @typedef {{ id: string, state: HostState | null, opened: Opened, visible: boolean }} Standing */

/** @typedef {'system' | 'light' | 'dark'} Theme */

const KEPT = 'theme';

/** @returns {Theme} */
export function themeShown() {
  const kept = localStorage.getItem(KEPT);
  return kept === 'light' || kept === 'dark' ? kept : 'system';
}

/**
 * @param {Document} doc
 * @param {Theme} theme
 */
export function showTheme(doc, theme) {
  if (theme === 'system') {
    delete doc.documentElement.dataset.theme;
    localStorage.removeItem(KEPT);
    return;
  }
  doc.documentElement.dataset.theme = theme;
  localStorage.setItem(KEPT, theme);
}

/**
 * @param {Host | null} host
 * @param {ReportReader} reports
 * @param {PageChanges} changes
 * @param {{ draw: () => void, root: () => ParentNode | null, say: (words: string) => void }} parts
 */
export function settingsFrame(host, reports, changes, { draw, root, say }) {
  /** @type {Standing} */
  let at = { id: '', state: null, opened: OPENED, visible: false };
  let query = '';
  let more = false;
  const onModels = () => shownPage(at.id) === 'models' && at.opened.pages.length === 0;
  const session = sessionOf(host !== null, 'dialog');
  const plans = flowFrame({ session, reports, draw, root, say, shown: onModels,
    runner: actRunner(host, session, { draw, reports, name: 'subscriptions' }) });
  const watching = changes.watch(draw);
  const onPrivacy = () => shownPage(at.id) === 'privacy';
  /** @type {Map<string, { list?: import('../../types.js').OutboundList, row?: import('../../types.js').OutboundOne, drawn?: import('../../lib/reach.js').Drawn } | null>} */
  const outbound = new Map();
  const reach = pageReach(host);
  /** @type {Map<string, import('../../lib/reach.js').Retry>} */
  const retries = new Map();
  /**
   * @param {string} key
   * @param {() => Promise<object>} read
   * @param {'list' | 'row'} as
   */
  const want = (key, read, as) => {
    if (outbound.has(key)) return;
    outbound.set(key, null);
    const begun = reach.begin(retries.get(key) ?? null);
    retries.delete(key);
    /** @param {import('../../lib/reach.js').Retry | null} [retry] */
    const again = (retry = null) => {
      if (!outbound.get(key)?.drawn) return;
      outbound.delete(key);
      if (retry) retries.set(key, retry);
      draw();
    };
    read().then(value => {
      if (!outbound.has(key)) return;
      outbound.set(key, { [as]: value });
      draw();
    }, error => {
      if (!outbound.has(key)) return;
      const drawn = reach.failed(error, begun, again);
      outbound.set(key, { drawn });
      if (drawn.kind === 'wait') setTimeout(() => again(), Math.max(0, drawn.until - Date.now()));
      draw();
    });
  };
  const outboundKeys = () => {
    if (shownPage(at.id) !== 'privacy') return { days: '', page: '', row: '' };
    const today = homeToday();
    const from = shiftDay(today, -(OUTBOUND_DAYS - 1));
    const days = `days:${from}:${today}`;
    want(days, () => fetchOutbound({ from, to: today }), 'list');
    const inside = at.opened.pages.at(-1) ?? '';
    let page = '';
    let row = '';
    if (inside.startsWith('outbound:')) {
      const { day: named, receiver } = outboundAt(inside);
      const day = named || today;
      page = `page:${inside}`;
      want(page, () => fetchOutbound({ from: day, to: day, ...receiver ? { receiver } : {} }), 'list');
    } else if (inside.startsWith('sent:')) {
      row = `row:${inside.slice('sent:'.length)}`;
      want(row, () => fetchOutboundRow(Number(inside.slice('sent:'.length))), 'row');
    }
    return { days, page, row };
  };
  const storage = storageReads({ fetch: fetchStorage, draw, seen: () => !document.hidden, reach });
  onHomeChange(change => {
    if (change.storage || change.reset) storage.moved();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) storage.seen();
  });
  host?.act({ act: 'appearance', theme: themeShown() }).catch(() => undefined);

  return {
    plans,
    get query() {
      return query;
    },
    /** @param {string} words */
    find(words) {
      query = words;
      draw();
    },
    /** @param {Standing} standing */
    follow(standing) {
      at = standing;
      if (!isSettings(at.id)) query = '';
      if (!at.id) more = false;
      if (onModels() && !plans.id) {
        plans.open('model', { models: [...SUBSCRIPTIONS] });
        return true;
      }
      if (!onModels() && plans.id) plans.close();
      plans.tick();
      watching.shown(onModels() && at.visible, { privacy: onPrivacy() && at.visible,
        screen: shownPage(at.id) === 'meaning' && at.visible });
      storage.shown(shownPage(at.id) === 'storage' && at.visible);
      if (!(onPrivacy() && at.visible)) outbound.clear();
      return false;
    },
    /**
     * @param {Omit<Standing, 'visible'> & { report: StreamsReport | null }} standing
     * @returns {Detail | null}
     */
    detail: ({ id, state, opened, report }) => {
      const keys = outboundKeys();
      const page = outbound.get(keys.page);
      const row = outbound.get(keys.row);
      const privacy = { ...NO_PRIVACY, read: changes.privacy.read, drawn: changes.privacy.drawn,
        days: outbound.get(keys.days)?.list ?? null, page: page?.list ?? null, row: row?.row ?? null,
        outbound: page?.drawn ?? row?.drawn ?? null };
      return settingsDetail({ report, models: changes.models.read, failed: changes.models.drawn, state, id, opened,
        subscriptions: plans.current(), theme: themeShown(), query, unread: reports.failure() !== '', privacy,
        screen: { read: changes.screen.read, drawn: changes.screen.drawn },
        storage: { read: storage.read, drawn: storage.drawn, more } });
    },
    /** @param {import('./settings.js').ReadFailed['reread']} read */
    reread(read) {
      if (read === 'storage') storage.again();
      else if (read === 'outbound') {
        for (const [key, kept] of outbound) if (kept?.drawn) outbound.delete(key);
        draw();
      } else changes.reread(read);
    },
    more() {
      more = !more;
      draw();
    },
    /** @param {Theme} theme */
    theme(theme) {
      showTheme(document, theme);
      host?.act({ act: 'appearance', theme }).catch(() => undefined);
      draw();
    },
    /**
     * @param {'openrouter' | 'cloudflare' | 'address' | 'name'} form
     * @param {Opened} opened
     * @param {StreamsReport | null} report
     * @returns {{ act: HostAct, forget: string } | null}
     */
    saved(form, opened, report) {
      const act = savedAct(form, opened, report);
      return act && { act, forget: act.act !== 'seal' ? '' : 'secret' in act && act.secret === 'cloudflare' ? TYPED.token : TYPED.key };
    },
  };
}

/** @typedef {ReturnType<typeof settingsFrame>} SettingsFrame */
