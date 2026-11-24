// @ts-check
import { notSaved } from '../../lib/api.js';
import { esc } from '../../lib/html.js';
import { actSaid, requestState, wordsOr } from '../../lib/reach.js';
import { count } from '../../lib/words.js';
import { inPlaceLine, button, dialog, emptyState, nameRow } from '../kit/index.js';
import { rowFace } from './list.js';

/** @typedef {NonNullable<import('../../pages.js').People['businesses']>['offered'][number]} Offered */

/**
 * @param {Map<string, boolean>} ticks
 * @param {Offered} offer
 */
const tickKeys = (ticks, offer) => [...new Set([offer.id, ...offer.handles.map(handle => handle.id)])].filter(key => ticks.has(key));

/**
 * @param {Map<string, boolean>} ticks
 * @param {Offered} offer
 */
export const tickedIn = (ticks, offer) => {
  const keys = tickKeys(ticks, offer);
  return keys.length > 0 && keys.every(key => ticks.get(key) === true);
};

/**
 * @param {Map<string, boolean>} ticks
 * @param {Offered} offer
 * @param {boolean} on
 */
const setTick = (ticks, offer, on) => {
  const keys = tickKeys(ticks, offer);
  for (const key of keys.length ? keys : [offer.id]) ticks.set(key, on);
};

/**
 * @param {Offered[]} offered
 * @param {Map<string, boolean>} ticks
 */
export const toMark = (offered, ticks) => offered.filter(offer => tickedIn(ticks, offer)).map(offer => offer.id);

/**
 * @param {object} view
 * @param {Offered[]} view.offered
 * @param {Map<string, boolean>} view.ticks
 * @param {'' | 'mark' | 'undo'} view.busy
 * @param {number} view.marked
 * @param {Failure | null} view.failure
 */
export function businessesDialog({ offered, ticks, busy, marked, failure }) {
  const ticked = toMark(offered, ticks).length;
  const rows = offered.map(offer => nameRow({
    lead: { face: rowFace(offer, 'sm') }, name: offer.name, line: offer.why ?? '', end: { tick: tickedIn(ticks, offer) },
    label: [offer.name, offer.why].filter(Boolean).join(', '), attrs: { 'data-people-business': offer.id, disabled: busy ? '' : null },
  }));
  const body = rows.length ? `<div class="ck-namerows">${rows.join('')}</div>`
    : emptyState('work-mac', 'No businesses to accept.', { detail: 'Lifestream offers one here when something says a business, not a person.' });
  const said = failure ? inPlaceLine(failure.words ?? '', { said: failure.said, retry: { 'data-people-businesses-again': '' } })
    : marked ? `<span>${esc(`${count(marked)} marked as ${marked === 1 ? 'a business' : 'businesses'}`)}</span>`
      + button('Undo', { variant: 'plain', size: 'sm', busy: busy === 'undo', disabled: busy === 'mark', attrs: { 'data-people-businesses-undo': '' } })
      : '';
  return dialog({
    icon: 'work-mac', title: 'Businesses', line: LINE, body,
    foot: `<div class="pp-foot__said mac-subhead" role="status">${said}</div>`
      + button(ticked === offered.length ? 'Mark all as businesses' : `Mark ${count(ticked)} as ${ticked === 1 ? 'a business' : 'businesses'}`, {
        variant: 'primary', busy: busy === 'mark', disabled: ticked === 0 || busy === 'undo', attrs: { 'data-people-businesses-mark': '' },
      }),
    close: { 'data-people-businesses-close': '' },
  });
}

/** @typedef {{ said: import('../../lib/reach.js').Said, words: string }} Failure */

const LINE = 'Lifestream thinks these may be businesses. Untick any that is a person.';

/**
 * @param {object} page
 * @param {(action: Record<string, unknown>) => Promise<{ act: string | null, position: string }>} page.act
 * @param {() => void} page.changed
 */
export function acceptAll({ act, changed }) {
  /** @type {{ act: string, ids: string[] } | null} */
  let done = null;
  /** @type {{ ticks: Map<string, boolean>, busy: '' | 'mark' | 'undo', failure: Failure | null, resend: ((offered: Offered[]) => Promise<void>) | null, why: Map<string, string> } | null} */
  let dialog = null;

  /**
   * @param {NonNullable<typeof dialog>} state
   * @param {Offered[]} offered
   * @param {string[]} ids
   */
  async function markIds(state, offered, ids) {
    Object.assign(state, { busy: 'mark', failure: null, resend: null });
    changed();
    try {
      const answered = await act({ kind: 'businesses', ids });
      if (answered.act) done = { act: answered.act, ids };
    } catch (error) {
      const refused = /** @type {{ refused?: { id: string, message: string }[] }} */ (error).refused;
      for (const { id, message } of refused ?? []) {
        const row = offered.find(offer => offer.id === id);
        if (row) setTick(state.ticks, row, false);
        else state.ticks.set(id, false);
        state.why.set(id, message);
      }
      state.failure = actSaid(requestState(error));
      if (state.failure.said === 'not-sent') state.resend = now => markIds(state, now, ids);
    } finally {
      state.busy = '';
      changed();
    }
  }

  /**
   * @param {NonNullable<typeof dialog>} state
   * @param {{ act: string, ids: string[] }} last
   */
  async function undoMark(state, last) {
    Object.assign(state, { busy: 'undo', failure: null, resend: null });
    changed();
    try {
      await act({ kind: 'undo', act: last.act });
      if (done === last) done = null;
    } catch (error) {
      state.failure = notSaved(error, wordsOr(error, ''), 'Not undone');
      if (state.failure.said === 'not-sent') state.resend = () => undoMark(state, last);
    } finally {
      state.busy = '';
      changed();
    }
  }

  return {
    isOpen: () => dialog !== null,
    marked: () => done?.ids.length ?? 0,
    /** @param {Offered[]} offered */
    open(offered) {
      dialog = { ticks: new Map(offered.map(offer => [offer.id, true])), busy: '', failure: null, resend: null, why: new Map() };
    },
    close() {
      if (dialog?.busy) return false;
      dialog = null;
      return true;
    },
    /**
     * @param {Offered[]} offered
     * @param {string} id
     */
    toggle(offered, id) {
      const row = offered.find(offer => offer.id === id);
      if (!dialog || dialog.busy || !row) return;
      setTick(dialog.ticks, row, !tickedIn(dialog.ticks, row));
    },
    /** @param {Offered[]} offered */
    view(offered) {
      if (!dialog) return null;
      const why = dialog.why;
      return { offered: offered.map(row => why.has(row.id) ? { ...row, why: /** @type {string} */ (why.get(row.id)) } : row),
        ticks: dialog.ticks, busy: dialog.busy, marked: done?.ids.length ?? 0, failure: dialog.failure };
    },
    /** @param {Offered[]} offered */
    async mark(offered) {
      const state = dialog;
      if (!state || state.busy) return;
      const ids = toMark(offered, state.ticks);
      if (ids.length) await markIds(state, offered, ids);
    },
    async undo() {
      const state = dialog;
      const last = done;
      if (!state || !last || state.busy) return;
      await undoMark(state, last);
    },
    /** @param {Offered[]} offered */
    async again(offered) {
      const resend = dialog && !dialog.busy ? dialog.resend : null;
      if (resend) await resend(offered);
    },
  };
}
