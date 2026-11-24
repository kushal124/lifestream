// @ts-check
/** @import { Do } from './words.js' */
/** @import { Dated } from './dialog.js' */
import { fetchRangeStep } from '../../lib/api.js';
import { wordsOr } from '../../lib/reach.js';

/** @typedef {{ dated: () => Dated | null, clear: () => void }} RangeDates */

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * @param {HTMLElement} root
 * @param {object} parts
 * @param {() => void} parts.draw
 * @param {() => string} parts.markup
 * @param {(doing: Do) => void} parts.send
 * @returns {RangeDates}
 */
export function installRangeDates(root, { draw, markup, send }) {
  /** @type {Dated | null} */
  let dated = null;

  function say() {
    if (!root.querySelector('.ck-fmenu--float [aria-expanded="true"]')) return draw();
    const next = document.createElement('template');
    next.innerHTML = markup();
    for (const said of root.querySelectorAll('.ck-fmenu__said[data-said-of]')) {
      const of = CSS.escape(said.getAttribute('data-said-of') ?? '');
      const fresh = next.content.querySelector(`.ck-fmenu__said[data-said-of="${of}"]`);
      if (fresh && said.innerHTML !== fresh.innerHTML) said.innerHTML = fresh.innerHTML;
    }
  }

  /**
   * @param {string} connector
   * @param {string} member
   * @param {string} value
   */
  async function ask(connector, member, value) {
    const asked = { connector, member, value, step: null, failed: '' };
    dated = asked;
    say();
    /** @type {import('../../types.js').Step | null} */
    let step = null;
    let failed = '';
    try {
      step = await fetchRangeStep(connector, value);
    } catch (error) {
      failed = wordsOr(error, 'What this date would read couldn’t be read.');
    }
    if (dated !== asked) return;
    dated = { ...asked, step, failed };
    say();
  }

  /** @param {Element} at */
  const closeMenu = at => at.closest('.ck-fmenu')?.querySelector('.ck-fmenu__btn')?.setAttribute('aria-expanded', 'false');

  root.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.cnDate || !DAY.test(input.value)) return;
    const { connector, member, asks } = JSON.parse(input.dataset.cnDate);
    if (asks) return void ask(connector, member, input.value);
    closeMenu(input);
    send({ host: { act: 'setting', connector, member, value: input.value } });
  });
  root.addEventListener('click', event => {
    const said = /** @type {Element} */ (event.target).closest('.ck-fmenu__said [data-cn-do]');
    if (!said || said.matches(':disabled')) return;
    closeMenu(said);
    dated = null;
  }, { capture: true });

  return {
    dated: () => dated,
    clear() {
      dated = null;
    },
  };
}
