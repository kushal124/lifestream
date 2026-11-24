// @ts-check
/** @import { StorageRead, StreamsReport } from '../../types.js' */
/** @import { DiskPart, Tone } from '../kit/disk-bar.js' */
/** @import { AreaPart } from '../kit/area-chart.js' */
/** @import { Bolded } from '../kit/bold-line.js' */
import { esc } from '../../lib/html.js';
import { pageReach } from '../../lib/reach.js';
import { productName } from '../../lib/kinds.js';
import { counted, dateOf, shiftDay, sizeWords } from '../../lib/words.js';
import { areaChart, barWidths, boldLine, diskBar, glide, settingsSection, usageRow } from '../kit/index.js';

const RANKED = 5;
const OTHER = 'other';
const OWN = 'own';
const GROWING = 1e6;
const WEEK = 7;
const SOON_DAYS = 30;
const FAR_DAYS = 5 * 365;
export const COALESCE_MS = 5_000;
export const COUNTING_MS = 3_000;

export const WORDS = {
  own: 'Index and AI',
  ownLine: 'Search, summaries and model answers',
  other: 'Other connectors',
  uncounted: 'Not yet counted',
  otherFiles: 'Other files',
  free: 'Free',
  counting: 'Counting…',
  yours: 'Lifestream',
  growth: 'Growth',
  uses: 'What uses the space',
  fewer: 'Show fewer',
  failed: 'Your storage couldn’t be read.',
  notHere: 'Your storage isn’t on this Mac yet.',
};

/** @typedef {{ id: string, part: string, name: string, tone: Tone, size: string, share: number, line: string, opens: string | null }} Usage */

/**
 * @typedef {object} StorageModel
 * @property {'map' | 'counting' | null} counting
 * @property {string} figure
 * @property {string} after
 * @property {string} disk
 * @property {{ label: string, parts: DiskPart[], key: { id: string, name: string, tone: Tone }[], time: string }} bar
 * @property {Bolded} sentence
 * @property {{ label: string, first: string, parts: AreaPart[], rate: number | null, room: { bytes: number, name: string } | null } | null} chart
 * @property {Usage[] | null} rows
 * @property {number} rest
 * @property {boolean} more
 */

/** @param {number | null} ms */
export function leftWords(ms) {
  if (ms === null) return '';
  return ms < 60_000 ? 'Less than a minute left' : `About ${counted(Math.round(ms / 60_000), 'minute')} left`;
}

/**
 * @param {StorageRead} read
 * @returns {'young' | 'full' | 'still' | 'rate'}
 */
function forecastOf({ growth }) {
  const soon = growth.days_left !== null && growth.days_left < SOON_DAYS;
  if (growth.readings < WEEK && !soon) return 'young';
  if (growth.days_left !== null && growth.days_left <= 0) return 'full';
  if (growth.bytes_a_day === null || growth.bytes_a_day <= 0) return 'still';
  return 'rate';
}

/**
 * @param {StorageRead} read
 * @param {string} today
 * @returns {Bolded}
 */
export function sentenceOf(read, today) {
  const { disk, growth } = read;
  const plain = (/** @type {string} */ text) => ({ text });
  const strong = (/** @type {string} */ text) => ({ text, bold: true });
  const named = disk.name ?? 'This Mac';
  const forecast = forecastOf(read);
  if (forecast === 'young') {
    return [plain(`Lifestream has been measuring for ${counted(Math.max(1, growth.readings), 'day')}. How fast it grows shows here after a week.`)];
  }
  if (forecast === 'full') return [plain(`${named} is full.`)];
  if (forecast === 'still' || growth.bytes_a_day === null) return [plain(`${named} is not filling.`)];
  const rate = [plain(`${named} fills by about `), strong(`${sizeWords(growth.bytes_a_day)} a day`), plain('.')];
  if (growth.days_left === null || growth.days_left > FAR_DAYS) return rate;
  return [...rate, plain(' At this rate it is full around '), strong(dateOf(shiftDay(today, growth.days_left), { year: true, long: true })),
    plain('.')];
}

/**
 * @param {string} id
 * @param {StreamsReport | null} report
 */
const nameOf = (id, report) => report?.connectors.find(each => each.id === id)?.name ?? productName(id);

/**
 * @param {StorageRead} read
 * @param {{ report: StreamsReport | null, today: string, more?: boolean }} options
 * @returns {StorageModel}
 */
export function storageModel(read, { report, today: day, more = false }) {
  const { disk, home, series } = read;
  const counting = read.counting === null ? null : read.counting.map ? 'map' : 'counting';
  const today = series ? shiftDay(series.first_day, Math.max(0, (series.parts[0]?.bytes.length ?? 1) - 1)) : day;
  const total = Math.max(1, disk.total_bytes);
  const free = Math.max(0, Math.min(disk.free_bytes, total));
  const used = total - free;
  const share = (/** @type {number} */ bytes) => bytes / total * 100;
  const named = disk.name ?? 'this Mac';
  const ranked = home.streams.slice(0, RANKED);
  const rest = home.streams.slice(RANKED);
  const restBytes = rest.reduce((sum, stream) => sum + stream.bytes, 0);
  const toneOf = new Map(ranked.map((stream, at) => [stream.connector, /** @type {Tone} */ (`s${at + 1}`)]));
  const opens = (/** @type {string} */ id) => report?.connectors.some(each => each.id === id) ? id : null;
  const outside = Math.max(0, used - home.bytes);
  const freePart = { id: '', name: WORDS.free, tone: /** @type {Tone} */ ('free'), share: share(free), size: sizeWords(free) };
  const diskWords = `${sizeWords(free)} free of ${sizeWords(total)} on ${named}`;
  const sentence = sentenceOf(read, today);
  if (counting === 'map') {
    return { counting, figure: WORDS.counting, after: '', disk: diskWords, sentence, chart: null, rows: null, rest: 0, more: false,
      bar: { label: `${capitalOf(named)}: used ${sizeWords(used)}, counting, ${sizeWords(free)} free`, time: '',
        parts: [{ id: '', name: WORDS.uncounted, tone: 'uncounted', share: share(used), size: sizeWords(used) }, freePart],
        key: [{ id: '', name: WORDS.uncounted, tone: 'uncounted' }] } };
  }
  /** @type {DiskPart[]} */
  const parts = [
    ...ranked.map(stream => ({ id: stream.connector, name: nameOf(stream.connector, report), tone: /** @type {Tone} */ (toneOf.get(stream.connector)),
      share: share(stream.bytes), size: sizeWords(stream.bytes) })),
    ...rest.length ? [{ id: OTHER, name: WORDS.other, tone: /** @type {Tone} */ ('other'), share: share(restBytes), size: sizeWords(restBytes) }] : [],
    { id: OWN, name: WORDS.own, tone: 'own', share: share(home.own.bytes), size: sizeWords(home.own.bytes) },
  ];
  const elsewhere = counting ? WORDS.uncounted : `Other files on ${named}`;
  const bar = {
    label: counting ? `${capitalOf(named)}: counted so far ${sizeWords(home.bytes)}, not yet counted ${sizeWords(outside)}, ${sizeWords(free)} free`
      : `${capitalOf(named)}: Lifestream ${sizeWords(home.bytes)}, other files ${sizeWords(outside)}, ${sizeWords(free)} free`,
    parts: [...parts, { id: '', name: elsewhere, tone: /** @type {Tone} */ (counting ? 'uncounted' : 'disk'), share: share(outside), size: sizeWords(outside) },
      freePart],
    key: [...parts.map(part => ({ id: part.id, name: part.name, tone: part.tone })),
      { id: '', name: counting ? WORDS.uncounted : WORDS.otherFiles, tone: /** @type {Tone} */ (counting ? 'uncounted' : 'disk') }],
    time: counting ? leftWords(read.counting?.left_ms ?? null) : '',
  };
  const young = series !== null && series.first_day > shiftDay(today, -WEEK);
  /** @param {number | null} week */
  const weekOf = week => week === null ? '' : week < GROWING ? 'Not growing'
    : young && series ? `+${sizeWords(week)} since ${dateOf(series.first_day)}` : `+${sizeWords(week)} this week`;
  const whole = Math.max(1, home.bytes);
  /** @type {(stream: StorageRead['home']['streams'][number], tone: Tone, part: string) => Usage} */
  const row = (stream, tone, part) => ({ id: stream.connector, part, name: nameOf(stream.connector, report), tone, size: sizeWords(stream.bytes),
    share: stream.bytes / whole * 100, line: weekOf(stream.week_bytes), opens: opens(stream.connector) });
  const rows = [
    ...ranked.map(stream => row(stream, /** @type {Tone} */ (toneOf.get(stream.connector)), stream.connector)),
    ...more ? rest.map(stream => row(stream, 'other', OTHER)) : [],
    { id: OWN, part: OWN, name: WORDS.own, tone: /** @type {Tone} */ ('own'), size: sizeWords(home.own.bytes), share: home.own.bytes / whole * 100,
      line: WORDS.ownLine, opens: null },
  ];
  const chart = counting || !series ? null : {
    label: `Lifestream’s size since ${dateOf(series.first_day, { year: true })}`,
    first: series.first_day,
    parts: series.parts.map(part => ({ id: part.part, bytes: part.bytes,
      name: part.part === OTHER ? WORDS.other : part.part === OWN ? WORDS.own : nameOf(part.part, report),
      tone: /** @type {Tone} */ (part.part === OTHER ? 'other' : part.part === OWN ? 'own' : toneOf.get(part.part) ?? 'other') })),
    rate: forecastOf(read) === 'rate' ? read.growth.bytes_a_day : null,
    room: { bytes: home.bytes + free - disk.keep_bytes - disk.coming_bytes, name: `${capitalOf(named)} full` },
  };
  return { counting, figure: counting ? WORDS.counting : sizeWords(home.bytes), after: counting ? `${sizeWords(home.bytes)} so far` : WORDS.yours,
    disk: diskWords, bar, sentence, chart, rows, rest: rest.length, more };
}

/** @param {string} words */
const capitalOf = words => words.replace(/^./u, letter => letter.toUpperCase());

/** @param {number} rest */
export const moreWords = rest => `Show ${counted(rest, 'more connector', 'more connectors')}`;

export const MORE = /** @type {const} */ ({ rest: 'toggle' });

/** @param {StorageModel} model */
export function storageMarkup(model) {
  const figure = `<div class="cn-storage__head"><p class="cn-storage__figure">${esc(model.figure)}`
    + (model.after ? `<span class="cn-storage__after">${esc(model.after)}</span>` : '') + '</p>'
    + `<p class="cn-storage__disk">${esc(model.disk)}</p></div>`;
  const sentence = boldLine(model.sentence);
  const rows = model.rows?.map(row => usageRow({ part: row.part, name: row.name, tone: row.tone, line: row.line, share: row.share,
    size: row.size, go: row.opens ? { 'data-cn-do': JSON.stringify({ open: row.opens, push: true }) } : null })) ?? [];
  const more = model.rest ? `<button type="button" class="cn-storage__more" aria-expanded="${model.more}"`
    + ` data-cn-do="${esc(JSON.stringify(MORE))}">${esc(model.more ? WORDS.fewer : moreWords(model.rest))}</button>` : '';
  return '<div class="cn-storage" data-lights>'
    + settingsSection({ body: figure + diskBar(model.bar) })
    + settingsSection({ heading: WORDS.growth, body: sentence + (model.chart ? areaChart(model.chart) : '') })
    + (model.rows ? settingsSection({ heading: WORDS.uses, rows, body: more }) : '')
    + '</div>';
}

/** @param {ParentNode} root */
export const storageBefore = root => ({ widths: barWidths(root), bar: root.querySelector('.cn-storage .ck-disk') !== null,
  chart: root.querySelector('.cn-storage .ck-area') !== null });

/**
 * @param {ParentNode} root
 * @param {ReturnType<typeof storageBefore>} before
 */
export function storageAfter(root, before) {
  glide(root, before.widths);
  const chart = root.querySelector('.cn-storage .ck-area');
  if (chart && before.bar && !before.chart) chart.classList.add('is-arriving');
}

/** @param {{ fetch: () => Promise<StorageRead>, draw: () => void, now?: () => number, later?: (run: () => void, ms: number) => unknown, cancel?: (timer: unknown) => void, seen?: () => boolean, reach?: ReturnType<typeof pageReach> }} parts */
export function storageReads({ fetch, draw, now = Date.now, later = (run, ms) => setTimeout(run, ms),
  cancel = timer => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer)), seen = () => true,
  reach = pageReach(null) }) {
  /** @type {StorageRead | null} */
  let read = null;
  /** @type {import('../../lib/reach.js').Drawn | null} */
  let drawn = null;
  let on = false;
  let flying = false;
  let again = false;
  /** @type {import('../../lib/reach.js').Retry | null} */
  let retry = null;
  let last = -Infinity;
  let notBefore = -Infinity;
  /** @type {unknown} */
  let timer = null;
  let due = Infinity;

  const stop = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    due = Infinity;
  };
  /** @param {number} when */
  const at = when => {
    const allowed = Math.max(when, notBefore);
    if (!on || due <= allowed) return;
    stop();
    due = allowed;
    timer = later(() => void go(), Math.max(0, allowed - now()));
  };
  async function go() {
    stop();
    if (!on) return;
    if (now() < notBefore) {
      at(notBefore);
      return;
    }
    if (flying || !seen()) {
      again = true;
      return;
    }
    flying = true;
    last = now();
    const begun = reach.begin(retry);
    retry = null;
    try {
      read = await fetch();
      drawn = null;
    } catch (error) {
      drawn = reach.failed(error, begun, readAgain);
    }
    flying = false;
    if (!on) return;
    draw();
    if (drawn?.kind === 'wait') at(notBefore = now() + Math.max(0, drawn.until - Date.now()));
    if (again) at(last + COALESCE_MS);
    again = false;
    if (read?.counting) at(now() + COUNTING_MS);
  }

  /** @param {import('../../lib/reach.js').Retry | null} [given] */
  const readAgain = (given = null) => {
    if (!on) return;
    if (given) retry = given;
    if (flying) again = true;
    else void go();
  };

  return {
    get read() {
      return read;
    },
    get failed() {
      return drawn?.kind === 'lack' ? drawn.words ?? WORDS.failed : '';
    },
    get drawn() {
      return drawn;
    },
    /** @param {boolean} shown */
    shown(shown) {
      if (shown === on) return;
      on = shown;
      again = false;
      retry = null;
      stop();
      if (on) void go();
    },
    moved() {
      if (!on) return;
      if (flying) again = true;
      else at(Math.max(now(), last + COALESCE_MS));
    },
    again() {
      readAgain();
    },
    seen() {
      if (!on || flying || !(again || (drawn?.kind === 'lack' && timer === null))) return;
      again = false;
      void go();
    },
  };
}
