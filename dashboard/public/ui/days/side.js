// @ts-check
/** @import { DaySide, SideFigure, SideGroup, SidePerson, SidePlace } from '../../pages.js' */
/** @import { MapMark, MapView } from '../kit/map.js' */
import { esc } from '../../lib/html.js';
import { counted } from '../../lib/words.js';
import { figureLine, figureLineReading, figureRow, figureRowReading } from '../kit/figure-row.js';
import { installMaps, mapFrame } from '../kit/map.js';
import { personRow, personRowReading } from '../kit/person-row.js';
import { pillPopover, popoverFocus } from '../kit/pill-popover.js';
import { placeUnit, placeUnitReading } from '../kit/place-unit.js';
import { bar } from '../kit/skeleton.js';
import { sectionLabel, sectionLabelReading } from '../kit/surface.js';

export const DAY_MAP = 'day-map';
export const FIGURES_SHOWN = 3;
export const PEOPLE_SHOWN = 14;
export const GROUPS_SHOWN = 5;
const DISC_MIN_MS = 10 * 60_000;
const UNSET_DEG = 0.02;
const DISC_LEAST = 6;
const DISC_MORE = 18;
const ONE_STAY_REACH = 3;
const SPOT_REACH_M = 80;

/** @typedef {{ more: boolean, moreGroups: boolean }} SideMore */

/** @param {{ latitude: number, longitude: number }} point */
const placed = point => Math.hypot(point.latitude, point.longitude) > UNSET_DEG;

/**
 * @param {HTMLElement} root
 * @param {{ changed: () => void, reveal: (ids: string) => void }} acts
 */
export function installDaySide(root, { changed, reveal }) {
  /** @type {Set<string>} */
  const more = new Set();
  /** @type {Set<string>} */
  const stood = new Set();
  let settled = '';
  /** @type {ReadonlyMap<string, SidePlace>} */
  let units = new Map();
  /** @type {{ key: string, panel: HTMLElement } | null} */
  let popped = null;
  const focus = popoverFocus(root);
  /** @type {{ latitude: number, longitude: number } | null} */
  let moment = null;
  /** @type {{ day: string, side: DaySide } | null} */
  let drawn = null;

  const maps = installMaps(root, {
    open: (id, key) => {
      if (id !== DAY_MAP) return;
      const unit = units.get(key);
      if (unit?.slug) location.hash = placePage(unit.slug);
      else reveal(unit?.rows.join(' ') ?? '');
    },
    pointed: (id, key) => {
      if (id !== DAY_MAP) return;
      for (const unit of root.querySelectorAll('[data-d-unit]')) {
        unit.closest('.ck-punit')?.classList.toggle('is-lit', key !== '' && /** @type {HTMLElement} */ (unit).dataset.dUnit === key);
      }
    },
  });

  root.addEventListener('pointerover', event => {
    const unit = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest?.('[data-d-unit]') ?? null);
    maps.emphasise(DAY_MAP, unit ? String(unit.dataset.dUnit) : '');
  });
  root.addEventListener('pointerleave', () => maps.emphasise(DAY_MAP, ''));
  root.addEventListener('click', event => {
    const pressed = /** @type {Element} */ (event.target).closest?.('[data-side-more]');
    if (!pressed) return;
    more.add(String(/** @type {HTMLElement} */ (pressed).dataset.sideMore));
    changed();
  });

  const frameOf = () => /** @type {HTMLElement | null} */ (root.querySelector(`[data-map="${DAY_MAP}"]`));

  /**
   * @param {string} day
   * @param {DaySide} side
   */
  function drawMap(day, side) {
    drawn = { day, side };
    const frame = frameOf();
    const small = Boolean(frame?.closest('.ck-popover'));
    const whole = mapViewOf(day, side);
    const view = whole ? { ...whole, small, lit: moment ? [moment] : [] } : null;
    frame?.classList.toggle('is-waiting', view === null);
    maps.settle(view ? { [DAY_MAP]: view } : frame ? { [DAY_MAP]: { ...waiting(day), small } } : {});
  }

  return {
    /**
     * @param {string} day
     * @returns {SideMore}
     */
    more: day => ({ more: more.has(day), moreGroups: more.has(`${day} groups`) }),

    /** @param {{ latitude: number, longitude: number } | null} point */
    moment(point) {
      if (moment?.latitude === point?.latitude && moment?.longitude === point?.longitude) return;
      moment = point;
      if (drawn && drawn.day === settled) drawMap(drawn.day, drawn.side);
    },

    /**
     * @param {string} day
     * @param {DaySide} side
     */
    settle(day, side) {
      drawMap(day, side);
      units = new Map(side.places.map(place => [place.key, place]));
      if (settled !== day) stood.clear();
      const parts = [...root.querySelectorAll('[data-side-part]')].map(part => /** @type {const} */ ([
        /** @type {HTMLElement} */ (part), String(/** @type {HTMLElement} */ (part).dataset.sidePart)]));
      for (const [part, name] of parts) {
        if (part.classList.contains('is-reading') || part.querySelector(':scope > .ck-sk')) stood.delete(name);
        else if (!stood.has(name)) {
          if (settled === day) part.classList.add('is-arriving');
          stood.add(name);
        }
      }
      settled = day;
      const panel = /** @type {HTMLElement | null} */ (root.querySelector('.ck-popover'));
      const key = panel?.closest('[data-pop]')?.getAttribute('data-pop') ?? '';
      if (panel) {
        const top = panel.getBoundingClientRect().top;
        panel.style.maxHeight = `${Math.max(160, innerHeight - top - 16)}px`;
      }
      if (popped && popped.key !== key) {
        const pill = /** @type {HTMLElement | null} */ (root.querySelector(`[data-pop="${popped.key}"] .ck-pill`));
        const leaving = popped.panel;
        if (pill && !panel) {
          leaving.classList.add('is-leaving');
          pill.after(leaving);
          leaving.addEventListener('animationend', () => leaving.remove(), { once: true });
        }
      }
      focus();
      popped = panel ? { key, panel } : null;
    },
  };
}

/**
 * @param {string} day
 * @returns {MapView}
 */
const waiting = day => ({ frame: day, fit: [], around: 0, marks: [], here: null, focus: null, small: true, still: true });

/**
 * @param {string} day
 * @param {DaySide} side
 * @returns {MapView | null}
 */
export function mapViewOf(day, side) {
  const shown = side.places.filter(place => placed(place.point) && place.ms >= DISC_MIN_MS);
  if (!shown.length) return null;
  const most = Math.max(...shown.map(place => place.ms));
  /** @type {MapMark[]} */
  const marks = shown.map(place => ({ key: place.key, kind: 'place', latitude: place.point.latitude,
    longitude: place.point.longitude, weight: place.ms / 3_600_000, name: place.name, spent: place.length,
    r: DISC_LEAST + DISC_MORE * Math.sqrt(place.ms / most) }));
  const alone = shown.length === 1 ? shown[0] : null;
  return {
    frame: day,
    fit: alone ? [{ latitude: alone.point.latitude, longitude: alone.point.longitude, radius_m: (alone.radius_m ?? SPOT_REACH_M) * ONE_STAY_REACH }]
      : shown.map(place => ({ latitude: place.point.latitude, longitude: place.point.longitude })),
    around: 0, marks, here: null, focus: null, small: true, still: true,
  };
}

/** @param {string} slug */
const placePage = slug => `#view=places&focus=${encodeURIComponent(slug)}`;

/** @param {string} person */
const personPage = person => `#view=people&focus=${encodeURIComponent(person)}`;

/**
 * @param {string} words
 * @param {number | null} count
 */
const labelRow = (words, count) => sectionLabel(words, { count });

/** @param {SideFigure[]} figures */
const figuresOf = figures => figures.slice(0, FIGURES_SHOWN).map(figure => ({ key: figure.key, value: figure.value, caption: figure.words }));

/**
 * @param {string[]} names
 * @param {string} map
 */
const mapCard = (names, map) => `<div class="ds-card" data-side-part="map">${mapFrame(map,
  names.length ? `Map of the day: ${names.join(', ')}` : 'Map of the day', 'ds-map')}</div>`;

/** @param {SidePlace[]} units */
const unitsOf = units => '<ul class="ds-units">' + units.map(unit => `<li${unit.quiet ? ' class="is-quiet"' : ''}>${
  placeUnit({
  name: unit.name, minutes: unit.length, spoken: unit.spoken,
  line: unit.home ? 'Home' : unit.line || undefined,
  attrs: { 'data-d-unit': unit.key, 'data-d-rows': unit.rows.join(' '), 'data-d-place': unit.slug ? null : unit.key },
  open: unit.slug ? placePage(unit.slug) : null,
})}</li>`).join('') + '</ul>';

/** @param {number} count */
const unitsReading = count => `<ul class="ds-units" aria-hidden="true">${Array.from({ length: count }, (_, at) =>
  `<li>${placeUnitReading(at)}</li>`).join('')}</ul>`;

/**
 * @param {SidePerson[]} people
 * @param {string} day
 * @param {boolean} all
 */
function peopleOf(people, day, all) {
  const shown = all || people.length <= PEOPLE_SHOWN ? people : people.slice(0, PEOPLE_SHOWN);
  return '<ul class="ds-people">' + shown.map(row => `<li>${personRow({ name: row.name, photo: row.photo ?? '', runs: row.runs,
    spoken: row.spoken, attrs: { 'data-d-who': row.key, 'data-d-rows': row.rows.join(' '), 'data-d-person': row.person ? null : row.key },
    open: row.person ? personPage(row.person) : null })}</li>`).join('')
    + moreRow(people.length - shown.length, day) + '</ul>';
}

/**
 * @param {SideGroup[]} groups
 * @param {string} day
 * @param {boolean} all
 */
function groupsOf(groups, day, all) {
  const shown = all || groups.length <= GROUPS_SHOWN ? groups : groups.slice(0, GROUPS_SHOWN);
  return '<ul class="ds-people">' + shown.map(group => `<li${group.quiet ? ' class="is-quiet"' : ''}>${personRow({
    name: group.title, runs: group.runs, spoken: group.spoken,
    attrs: { 'data-d-group': group.rows[0] ?? '', 'data-d-rows': group.rows.join(' ') } })}</li>`).join('')
    + moreRow(groups.length - shown.length, `${day} groups`) + '</ul>';
}

/**
 * @param {DaySide} side
 * @param {string} day
 * @param {SideMore} more
 */
const groupsPart = (side, day, more) => labelRow('Groups', side.groups.length) + groupsOf(side.groups, day, more.moreGroups);

/**
 * @param {number} rest
 * @param {string} key
 */
const moreRow = (rest, key) => rest > 0 ? '<li><button type="button" class="ds-more mac-body"'
  + ` data-side-more="${esc(key)}">${esc(counted(rest, 'more', 'more'))}</button></li>` : '';

/** @param {number} count */
const peopleReading = count => `<ul class="ds-people" aria-hidden="true">${Array.from({ length: count }, (_, at) =>
  `<li>${personRowReading(at)}</li>`).join('')}</ul>`;

/**
 * @param {string} day
 * @param {DaySide} side
 * @param {SideMore} more
 * @param {{ map?: string }} [view]
 */
export function daySide(day, side, more, { map = DAY_MAP } = {}) {
  const figures = figuresOf(side.figures);
  const mapped = side.located && mapViewOf(day, side) !== null;
  return `<div class="ds${mapped ? '' : ' ds--rail'}">`
    + (mapped ? mapCard(side.places.map(unit => unit.name), map) : '')
    + (figures.length ? `<div class="ds-figures" data-map-over="${esc(map)}"${figures.every(figure => figure.key === 'sent' || figure.key === 'received') ? ' data-figures="messages"' : ''}>${figureRow(figures)}</div>` : '')
    + '<div class="ds-foot">'
    + (side.located ? '<section class="ds-part" data-side-part="places" aria-label="Places">'
      + labelRow('Places', side.places.length) + unitsOf(side.places) + '</section>' : '')
    + (side.people.length ? '<section class="ds-part" data-side-part="people" aria-label="People">'
      + labelRow('People', side.people.length) + peopleOf(side.people, day, more.more) + '</section>' : '')
    + (side.groups.length ? '<section class="ds-part" data-side-part="groups" aria-label="Groups">'
      + groupsPart(side, day, more) + '</section>' : '')
    + '</div></div>';
}

export const daySideReading = () => '<div class="ds" aria-hidden="true">'
  + '<div class="ds-card"><div class="ck-map ds-map"></div></div>'
  + `<div class="ds-figures">${figureRowReading()}</div>`
  + '<div class="ds-foot">'
  + `<section class="ds-part">${sectionLabelReading(3)}${unitsReading(2)}</section>`
  + `<section class="ds-part">${sectionLabelReading(3)}${peopleReading(5)}</section>`
  + '</div></div>';

/**
 * @param {string} day
 * @param {DaySide} side
 * @param {SideMore & { open: string }} view
 * @param {{ map?: string }} [drawn]
 */
export function sidePills(day, side, view, { map = DAY_MAP } = {}) {
  const mapped = side.located && mapViewOf(day, side) !== null;
  const pills = [
    side.people.length || side.groups.length ? pillPopover({ key: 'people', label: 'People',
      count: side.people.length, open: view.open === 'people', attrs: { 'data-d-pill': 'people' },
      body: (side.people.length ? `<div class="ds-part" data-side-part="people">${peopleOf(side.people, day, view.more)}</div>` : '')
        + (side.groups.length ? `<div class="ds-part" data-side-part="groups">${groupsPart(side, day, view)}</div>` : '') }) : '',
    side.located ? pillPopover({ key: 'places', label: 'Places', count: side.places.length,
      open: view.open === 'places', attrs: { 'data-d-pill': 'places' },
      body: (mapped ? mapCard(side.places.map(unit => unit.name), map) : '')
        + `<div class="ds-part" data-side-part="places">${unitsOf(side.places)}</div>` }) : '',
  ].join('');
  return `<div class="ds-line">${figureLine(figuresOf(side.figures))}<div class="ds-pills">${pills}</div></div>`;
}

export const sidePillsReading = () => `<div class="ds-line" aria-hidden="true">${figureLineReading()}<div class="ds-pills">`
  + ['People', 'Places'].map(label => `<span class="ck-pill"><span class="ck-pill__label mac-headline">${label}</span>`
    + `<span class="ck-pill__count mac-mono-data">${bar(1)}</span></span>`).join('') + '</div></div>';
