// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { button, iconButton } from './button.js';
import { icon } from './icon.js';
import { inPlaceLine } from './states.js';
import { pathChecklist } from './pill-popover.js';
import { signalShape } from './signal.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */
/** @typedef {'warning' | 'caution' | 'waiting' | 'done'} Severity */
/** @typedef {'stopped' | 'advice'} Weight */
/** @typedef {{ label: string, busy?: boolean, attrs: Attributes }} StripAct */

/**
 * @typedef {object} Strip
 * @property {Severity} [tone]
 * @property {Weight} [weight]
 * @property {string} [icon]
 * @property {string} title
 * @property {string} [line]
 * @property {string} [meta]
 * @property {string} [more]
 * @property {string} [lead]
 * @property {StripAct[]} [actions]
 * @property {Attributes | null} [details]
 * @property {boolean} [open]
 * @property {string} [popover]
 * @property {StripAct | null} [close]
 * @property {string} [said]
 * @property {string} [end]
 */

/** @type {Record<Weight, Severity>} */
const WEIGHT_TONE = { stopped: 'warning', advice: 'caution' };

export const DISMISS = 'Dismiss · comes back if it gets worse';

/**
 * @param {Strip} strip
 * @param {{ place?: 'window' | 'page' }} [options]
 */
export function statusStrip({ tone, weight, icon: meaning = '', title, line = '', meta = '', more = '', lead = '', actions = [], details = null,
  open = false, popover = '', close = null, said = '', end = '' }, { place = 'page' } = {}) {
  const shown = weight ? WEIGHT_TONE[weight] : tone;
  const mark = shown ? signalShape(shown, { size: 14 }) : icon(meaning, { size: 'sm' });
  const words = said ? said
    : line || meta || more ? `<span class="ck-strip__line mac-body">${esc(line)}${meta ? `<span class="ck-strip__meta">${line ? ' · ' : ''}${esc(meta)}</span>` : ''}${more}</span>` : '';
  const acts = lead + actions.map(act => button(act.label, { size: 'sm', busy: act.busy ?? false, attrs: act.attrs, className: 'ck-strip__act' })).join('')
    + (close ? iconButton('close', close.label, { attrs: close.attrs, disabled: close.busy ?? false, className: 'ck-strip__close' }) : '')
    + (details ? iconButton('forward', 'Details', { className: 'ck-strip__details',
      attrs: { 'aria-expanded': String(open), 'aria-haspopup': 'dialog', ...details } }) : '')
    + end;
  return `<div${attributes({ class: `ck-strip ck-strip--${place}${weight ? ` ck-strip--${weight}` : tone ? ` ck-strip--${tone}` : ''}`,
    role: shown === 'warning' ? 'alert' : 'status' })}>`
    + `<span class="ck-strip__mark">${mark}</span>`
    + `<span class="ck-strip__words"><span class="ck-strip__title mac-headline">${esc(title)}</span>${words}</span>`
    + (acts ? `<span class="ck-strip__acts">${acts}</span>` : '')
    + (open && popover ? popover : '') + '</div>';
}

/**
 * @param {Strip[]} strips
 * @param {{ open: boolean, toggle: Attributes }} fold
 */
export function foldedStrips(strips, { open, toggle }) {
  const [first, ...rest] = strips;
  if (!first) return '';
  if (rest.length === 0) return `<div class="ck-stack">${statusStrip(first)}</div>`;
  if (open) {
    return `<div class="ck-stack is-open">${strips.map(strip => statusStrip(strip)).join('')}`
      + `<button${attributes({ class: 'ck-stack__less mac-body', type: 'button', 'aria-expanded': 'true', ...toggle })}>`
      + `<span>Show less</span>${icon('collapse', { size: 'xs' })}</button></div>`;
  }
  const more = ` <button${attributes({ class: 'ck-strip__more', type: 'button', 'aria-expanded': 'false', ...toggle })}>`
    + `· ${rest.length} more${icon('expand', { size: 'xs' })}</button>`;
  return `<div class="ck-stack is-folded ck-stack--${first.weight ?? 'advice'}">${statusStrip({ ...first, more })}`
    + '<span class="ck-stack__sliver" aria-hidden="true"></span><span class="ck-stack__sliver" aria-hidden="true"></span></div>';
}

/** @typedef {import('../../lib/reach.js').Reach} Reach */

/** @type {Record<import('../../lib/reach.js').ReachLink['state'], import('./pill-popover.js').PathLink['state']>} */
const LINK_MARK = { passed: 'done', failed: 'warning', unchecked: 'unchecked' };

/** @typedef {{ tone: Severity, title: string, line?: string, meta?: string, act?: StripAct | null }} BannerItem */

/** @param {BannerItem[]} items */
const bannerList = items => `<div${attributes({ class: 'ck-popover ck-banners', role: 'dialog', 'aria-label': 'Lifestream', tabindex: '-1' })}>`
  + items.map(item => '<div class="ck-banners__row">'
    + `<span class="ck-strip__mark">${signalShape(item.tone, { size: 14 })}</span>`
    + `<span class="ck-banners__words"><span class="ck-strip__title mac-headline">${esc(item.title)}</span>`
    + (item.line || item.meta ? `<span class="ck-strip__line mac-body">${esc(item.line ?? '')}`
      + `${item.meta ? `<span class="ck-strip__meta">${item.line ? ' · ' : ''}${esc(item.meta)}</span>` : ''}</span>` : '')
    + (item.act ? button(item.act.label, { size: 'sm', busy: item.act.busy ?? false, attrs: item.act.attrs, className: 'ck-strip__act' }) : '')
    + '</span></div>').join('') + '</div>';

/**
 * @param {(Pick<Reach, 'tone' | 'title' | 'line' | 'meta' | 'acts'> & Partial<Pick<Reach, 'last' | 'path' | 'checking'>> & { state?: string }) | null} reach
 * @param {{ open?: boolean, said?: string, busy?: string, others?: BannerItem[], listing?: boolean }} [options]
 */
export function homeStrip(reach, { open = false, said = '', busy = '', others = [], listing = false } = {}) {
  const { tone = null, title = null, line = null, meta = null, acts = [], last = null, path = [], checking = false } = reach ?? {};
  const act = (/** @type {{ do: string, label: string }} */ each) => ({ label: each.label,
    busy: busy === each.do || (each.do === 'probe' && checking), attrs: { 'data-home-act': each.do } });
  /** @type {BannerItem | null} */
  const own = tone && title && !(tone === 'done' && others.length) ? { tone, title, line: line ?? '', meta: meta ?? '',
    act: acts[0] ? act(acts[0]) : null } : null;
  const items = own && own.tone === 'warning' ? [own, ...others] : [...others, ...own ? [own] : []];
  const [first] = items;
  if (!first) return '';
  const saidLine = said ? inPlaceLine(said) : '';
  const more = items.length > 1 ? `<button${attributes({ class: 'ck-strip__count mac-body', type: 'button', 'data-home-more': '',
    'aria-expanded': String(listing), 'aria-haspopup': 'dialog', 'aria-label': `${items.length - 1} more` })}>`
    + `+${items.length - 1}${icon('expand', { size: 'xs' })}</button>` : '';
  const details = first === own && path.length > 0 && acts.length === 0;
  const popover = listing && more ? bannerList(items) : details && open ? pathChecklist({ title: first.title, meta: last ?? '', said: saidLine,
    links: path.map(link => ({ state: LINK_MARK[link.state], name: link.name, value: link.value, ...link.fix ? { fix: link.fix } : {},
      ...link.act ? { act: act(link.act) } : {} })),
    foot: act({ do: 'probe', label: 'Try again' }) }) : '';
  return statusStrip({ tone: first.tone, title: first.title, line: first.line ?? '', meta: first.meta ?? '',
    actions: first.act ? [first.act] : [], details: details ? { 'data-home-details': '' } : null, open: Boolean(popover), popover,
    said: details && open ? '' : saidLine, lead: more }, { place: 'window' });
}
