// @ts-check
/** @import { Host, HostState } from '../lib/host.js' */
/** @import { Need, StreamsReport } from '../types.js' */
/** @import { Act } from './connectors/words.js' */
import { homeStrip, popoverFocus } from './kit/index.js';
import { actOf } from './connectors/page.js';
import { clock, dateWords, freeWords } from '../lib/words.js';
import { dayAt } from '../lib/home-clock.js';

export const BACK = 'Lifestream is back';
const BACK_MS = 3_000;

/** @param {number} ms */
const since = ms => `since ${dayAt(ms).day === dayAt(Date.now()).day ? clock(ms) : dateWords(ms, { weekday: true })}`;

/**
 * @param {HTMLElement} holder
 * @param {Pick<Host, 'act'> | null} host
 * @returns {{ state(state: HostState): void, report(report: StreamsReport | null): void }}
 */
export function installHomeStrip(holder, host) {
  /** @type {HostState | null} */
  let state = null;
  /** @type {Need[]} */
  let needs = [];
  /** @type {StreamsReport | null} */
  let report = null;
  /** @type {import('./kit/status-strip.js').BannerItem | null} */
  let back = null;
  let open = false;
  let listing = false;
  let said = '';
  let busy = '';
  const focus = popoverFocus(holder, { close: () => { open = false; listing = false; draw(); } });
  /** @param {Need} need @returns {Act | null} */
  const actOfNeed = need => need.acts.map(act => actOf(act, null, state)).find(Boolean) ?? null;
  const draw = () => {
    const others = needs.length ? needs.map(need => {
      const act = actOfNeed(need);
      return { tone: /** @type {const} */ ('warning'), title: need.words, line: need.line ?? '', meta: need.since_ms === null ? '' : since(need.since_ms),
        act: act && 'host' in act.do ? { label: act.label, busy: busy === need.id, attrs: { 'data-banner-act': need.id } } : null };
    }) : back ? [back] : [];
    const markup = homeStrip(state?.reach ?? null, { open, said, busy, others, listing });
    holder.hidden = !markup;
    patch(holder, markup);
    focus();
  };
  holder.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest('[data-home-details]')) {
      open = !open;
      listing = false;
      draw();
      return undefined;
    }
    if (target.closest('[data-home-more]')) {
      listing = !listing;
      open = false;
      draw();
      return undefined;
    }
    const banner = /** @type {HTMLButtonElement | null} */ (target.closest('[data-banner-act]'));
    if (banner && host && !banner.disabled && !busy) {
      const need = needs.find(each => each.id === banner.dataset.bannerAct);
      const act = need ? actOfNeed(need) : null;
      if (!need || !act || !('host' in act.do)) return undefined;
      busy = need.id;
      draw();
      return host.act(act.do.host).then(() => undefined, () => undefined).finally(() => { busy = ''; draw(); });
    }
    const button = /** @type {HTMLButtonElement | null} */ (target.closest('[data-home-act]'));
    if (!button || !host || button.disabled || busy) return undefined;
    busy = button.dataset.homeAct ?? '';
    said = '';
    draw();
    return host.act({ act: 'home', do: busy })
      .then(() => undefined, error => { said = error instanceof Error ? error.message : String(error); })
      .finally(() => { busy = ''; draw(); });
  });
  holder.ownerDocument?.addEventListener('pointerdown', event => {
    if ((open || listing) && !holder.contains(/** @type {Node} */ (event.target))) { open = false; listing = false; draw(); }
  });
  return {
    state(next) {
      if (JSON.stringify(next.reach) !== JSON.stringify(state?.reach ?? null)) {
        if (next.reach?.state !== state?.reach?.state) open = false;
        said = '';
      }
      state = next;
      draw();
    },
    report(next) {
      if (next === report) return;
      report = next;
      const now = (next?.needs ?? []).filter(need => need.banner);
      if (needs.length > 0 && now.length === 0 && next) {
        const shown = { tone: /** @type {const} */ ('done'), title: BACK, line: freeWords(next.disk.free_bytes) };
        back = shown;
        window.setTimeout(() => {
          if (back !== shown) return;
          back = null;
          draw();
        }, BACK_MS);
      }
      if (now.length > 0) back = null;
      if (now.length === 0) listing = false;
      needs = now;
      draw();
    },
  };
}

/**
 * @param {Element} holder
 * @param {string} markup
 */
function patch(holder, markup) {
  const next = holder.ownerDocument.createElement('template');
  next.innerHTML = markup;
  children(holder, next.content);
}

/**
 * @param {Node} into
 * @param {Node} from
 */
function children(into, from) {
  const wanted = [...from.childNodes];
  wanted.forEach((node, at) => {
    const have = into.childNodes[at];
    if (!have) into.appendChild(node);
    else if (!same(have, node)) into.replaceChild(node, have);
    else if (have.nodeType === Node.ELEMENT_NODE) {
      attrs(/** @type {Element} */ (have), /** @type {Element} */ (node));
      children(have, node);
    } else if (have.nodeValue !== node.nodeValue) have.nodeValue = node.nodeValue;
  });
  while (into.childNodes.length > wanted.length) into.lastChild?.remove();
}

/**
 * @param {Node} have
 * @param {Node} node
 */
function same(have, node) {
  return have.nodeType === node.nodeType && have.nodeName === node.nodeName;
}

/**
 * @param {Element} have
 * @param {Element} node
 */
function attrs(have, node) {
  for (const { name } of [...have.attributes]) if (!node.hasAttribute(name)) have.removeAttribute(name);
  for (const { name, value } of [...node.attributes]) if (have.getAttribute(name) !== value) have.setAttribute(name, value);
}
