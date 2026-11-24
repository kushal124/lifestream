// @ts-check
/** @import { ConnectorReport, Copy } from '../../types.js' */
import { homeThere } from '../../lib/report.js';
import { freeWords } from '../../lib/words.js';
import { modelOf } from '../flows/model.js';

export const SETUP_FAILED = 'Setup didn’t finish. Try again.';

/**
 * @typedef {'place' | 'welcome' | 'where' | 'key' | 'name' | 'login' | 'mac' | 'range' | 'record' | 'ai' | 'media' | 'set'} Screen
 */

/** @typedef {import('../flows/model.js').Seen} Seen */

/** @typedef {Map<string, boolean>} Picked */

const FULL_DISK = 'fullDiskAccess';
const PHOTOS = 'photos';
export const FACES = 'faces';

/** @param {ConnectorReport} connector */
const macWay = connector => connector.ways.find(way => way.road === 'mac') ?? null;

/** @param {Seen} seen @param {string} id */
const grantOf = (seen, id) => seen.state?.grants.find(grant => grant.id === id) ?? null;
/** @param {Seen} seen @param {string} id */
const granted = (seen, id) => grantOf(seen, id)?.granted === true;
/** @param {Seen} seen @param {string} id */
const waitsOn = (seen, id) => {
  const grant = grantOf(seen, id);
  return grant !== null && !grant.granted && !grant.optional;
};
/** @param {Seen} seen */
const grantsRead = seen => seen.state !== null && seen.state.grants.length > 0;
/** @param {Seen} seen @param {string} id */
const connectorOf = (seen, id) => seen.report?.connectors.find(connector => connector.id === id) ?? null;
/** @param {Seen} seen @param {Screen} screen */
const skipped = (seen, screen) => seen.report?.setup?.skipped.includes(screen) === true;

/**
 * @param {Seen} seen
 * @param {ConnectorReport} connector
 */
const grantsWanted = (seen, connector) => {
  const unit = seen.state?.unit ?? null;
  const acts = [...(macWay(connector)?.requirements ?? []).filter(requirement => !requirement.met).flatMap(requirement =>
    requirement.act ? [requirement.act] : []),
  ...(seen.report?.needs ?? []).filter(need => need.connector === connector.id && need.unit === unit).flatMap(need => need.acts)];
  return [...new Set(acts.flatMap(act => act.do === 'grant' && (!unit || act.unit === unit)
    && grantOf(seen, act.grant)?.optional !== true ? [act.grant] : []))];
};

/**
 * @param {Seen} seen
 * @returns {{ id: string, name: string, icon: string, words: string, grants: string[] }[]}
 */
export const sensesOf = seen => (seen.report?.connectors ?? []).filter(connector => connector.sensor
  && macWay(connector)?.requirements.some(requirement => requirement.kind === 'grant'))
  .map(connector => ({ id: connector.id, name: connector.name, icon: connector.icon, words: connector.records,
    grants: grantsWanted(seen, connector) }));

/** @param {Seen} seen @param {string} id */
const senseOf = (seen, id) => sensesOf(seen).find(sense => sense.id === id);

/** @param {Seen} seen @param {Picked} picked @param {string} id */
const senseOn = (seen, picked, id) => picked.get(id) ?? connectorOf(seen, id)?.on ?? true;

/** @param {Seen} seen @param {string} id */
const senseNeeds = (seen, id) => (senseOf(seen, id)?.grants ?? []).filter(grant => waitsOn(seen, grant));

/** @param {Seen} seen */
const sensesHeld = seen => sensesOf(seen).every(sense => !senseOn(seen, new Map(), sense.id)
  || senseNeeds(seen, sense.id).length === 0);

/** @param {ConnectorReport} connector */
const readOnMac = connector => connector.shown === 'stream' && connector.roads.includes('mac') && !connector.sensor
  && !connector.mac_grants.includes(PHOTOS);

/** @param {Seen} seen */
export const photoStreams = seen => (seen.report?.connectors ?? []).filter(connector => connector.mac_grants.includes(PHOTOS));

/** @param {Seen} seen */
const keyWaits = seen => seen.state?.setup?.state === 'key';

/** @param {Seen} seen */
const loginWaits = seen => seen.state?.setup?.state === 'login-items';

/** @param {Seen} seen */
const rangeSet = seen => seen.report?.setup?.at !== null && seen.report?.setup?.at !== undefined
  && SCREENS.indexOf(/** @type {Screen} */ (seen.report.setup.at)) > SCREENS.indexOf('range');

/** @typedef {{ id: Screen, dot: number, done: (seen: Seen) => boolean, shown?: (seen: Seen) => boolean, once?: boolean }} Step */

/** @type {Step[]} */
export const STEPS = [
  { id: 'place', dot: 0, done: seen => seen.state?.placement == null, shown: seen => seen.state?.placement != null },
  { id: 'welcome', dot: 0, done: seen => homeThere(seen.state) },
  { id: 'where', dot: 1, done: seen => homeThere(seen.state) },
  { id: 'key', dot: 1, done: seen => !keyWaits(seen), shown: keyWaits },
  { id: 'login', dot: 1, done: seen => !loginWaits(seen), shown: loginWaits },
  { id: 'name', dot: 1, done: seen => seen.report?.setup?.you === true, once: true },
  { id: 'mac', dot: 2, done: seen => granted(seen, FULL_DISK) },
  { id: 'range', dot: 2, done: rangeSet, once: true },
  { id: 'record', dot: 3, done: seen => seen.report !== null && grantsRead(seen) && sensesHeld(seen) },
  { id: 'ai', dot: 4, done: seen => modelOf(seen).connected || skipped(seen, 'ai') },
  { id: 'media', dot: 4, done: seen => skipped(seen, 'media') },
  { id: 'set', dot: 5, done: () => true },
];

export const DOTS = 6;

export const SCREENS = STEPS.map(step => step.id);

export const BEFORE = /** @type {Screen[]} */ (['place', 'welcome', 'where', 'key', 'login']);

/**
 * @param {Screen} screen
 * @returns {string}
 */
export const leftAs = screen => screen === 'mac' ? 'found' : screen;

/** @param {Screen} screen */
export const stepOf = screen => /** @type {Step} */ (STEPS.find(step => step.id === screen));

/**
 * @param {Screen} screen
 * @param {Seen} seen
 */
export const done = (screen, seen) => stepOf(screen).done(seen);

/**
 * @param {Screen} screen
 * @param {Seen} seen
 */
export const shown = (screen, seen) => stepOf(screen).shown?.(seen) ?? true;

/**
 * @param {Screen} screen
 * @param {Seen} seen
 */
export const passed = (screen, seen) => stepOf(screen).once === true && done(screen, seen);

/**
 * @param {Screen} screen
 * @param {Seen} seen
 * @returns {Screen | null}
 */
export const nextOf = (screen, seen) => SCREENS.slice(SCREENS.indexOf(screen) + 1)
  .find(each => !BEFORE.includes(each) && shown(each, seen) && !passed(each, seen)) ?? null;

/**
 * @param {Screen} screen
 * @param {Seen} seen
 * @returns {Screen | null}
 */
export function backOf(screen, seen) {
  if (screen === 'where') return 'welcome';
  if (BEFORE.includes(screen) || screen === 'name') return null;
  return [...SCREENS.slice(0, SCREENS.indexOf(screen))].reverse()
    .find(each => !BEFORE.includes(each) && shown(each, seen)) ?? null;
}

/**
 * @param {Seen} seen
 * @returns {Screen | null}
 */
export function resume(seen) {
  if (shown('place', seen)) return 'place';
  const due = owed(seen);
  if (due) return due;
  if (!homeThere(seen.state)) return (seen.state?.setup?.state ?? 'idle') !== 'idle' ? 'where' : 'welcome';
  if (!done('name', seen)) return 'name';
  const kept = /** @type {Screen} */ (seen.report?.setup?.at ?? '');
  if (!SCREENS.includes(kept) || BEFORE.includes(kept) || kept === 'name') return 'mac';
  return passed(kept, seen) ? nextOf(kept, seen) : kept;
}

/**
 * @param {Seen} seen
 * @returns {Screen | null}
 */
export function owed(seen) {
  if (keyWaits(seen)) return 'key';
  if (loginWaits(seen)) return 'login';
  return null;
}

const OWING = /** @type {Screen[]} */ (['welcome', 'where', 'key', 'login']);

/**
 * @param {Screen} asked
 * @param {Seen} seen
 * @returns {Screen}
 */
export const landing = (asked, seen) => OWING.includes(asked) ? owed(seen) ?? asked : asked;

/**
 * @param {Seen} seen
 * @param {Picked} picked
 * @returns {{ id: string, icon: string, name: string, on: boolean, count: string, sources: string[] }[]}
 */
export function macSources(seen, picked) {
  const report = seen.report;
  if (!report) return [];
  const browsers = new Set((seen.state?.browsers ?? []).map(browser => browser.id));
  const reading = granted(seen, FULL_DISK);
  const found = (/** @type {ConnectorReport} */ connector) => connector.copies.length > 0
    || (macWay(connector)?.requirements ?? []).some(requirement => requirement.kind === 'app' && requirement.met);
  return report.connectors.filter(connector => readOnMac(connector) && !browsers.has(connector.product) && found(connector)
    && !readEmpty(connector, connector.copies)).map(connector => {
    const on = picked.get(connector.id) ?? connector.on;
    return { id: connector.id, icon: connector.icon, name: connector.name, on, sources: [connector.id],
      count: reading && on ? heldCount(connector.copies.filter(copy => copy.on), seen.state?.unit) : '' };
  });
}

/**
 * @param {ConnectorReport} connector
 * @param {Copy[]} copies
 */
const readEmpty = (connector, copies) => copies.length > 0
  && copies.every(copy => copy.held === 0 && copy.health.state !== 'broken' && copy.health.state !== 'needs-you')
  && (connector.figure?.checked_ms ?? null) !== null;

/**
 * @param {Copy[]} copies
 * @param {string | null | undefined} unit
 */
function heldCount(copies, unit) {
  const here = unit ? copies.filter(copy => copy.unit === unit) : copies;
  if (!here.length || here.some(copy => copy.held === null)) return '';
  const held = here.reduce((sum, copy) => sum + (copy.held ?? 0), 0);
  return held > 0 ? held.toLocaleString('en-US') : '';
}

/** @param {Seen} seen @param {string} id */
export function keptOf(seen, id) {
  if (senseOf(seen, id)) return connectorOf(seen, id)?.on ?? null;
  return macSources(seen, new Map()).find(source => source.id === id)?.on ?? null;
}

/** @param {Seen} seen */
export const fullDiskTitle = seen => grantOf(seen, FULL_DISK)?.title || 'Full Disk Access';

/**
 * @param {Seen} seen
 * @param {{ picked: Picked }} session
 */
export function macOf(seen, { picked }) {
  const unit = seen.state?.unit;
  const detected = seen.report !== null && (seen.state === null || (seen.state.browsers !== null
    && seen.report.devices.some(device => device.unit === unit && device.found !== null)));
  const photos = grantOf(seen, PHOTOS);
  const library = photoStreams(seen);
  return {
    sources: macSources(seen, picked),
    detected,
    full: { title: fullDiskTitle(seen), granted: granted(seen, FULL_DISK), asking: grantOf(seen, FULL_DISK)?.asking === true },
    photos: { shown: photos !== null || library.length > 0, granted: photos?.granted === true,
      asking: photos?.asking === true, denied: photos?.denied === true, grant: photos !== null },
    faces: connectorOf(seen, FACES),
  };
}

/** @typedef {'idle' | 'ask' | 'asking' | 'allowed' | 'off'} SenseState */

/**
 * @param {Seen} seen
 * @param {{ picked: Picked, busy: Set<string> }} session
 */
export function recordOf(seen, { picked, busy }) {
  const known = grantsRead(seen) && seen.report !== null;
  const rows = sensesOf(seen).map(sense => {
    const connector = connectorOf(seen, sense.id);
    const on = senseOn(seen, picked, sense.id);
    const needs = senseNeeds(seen, sense.id);
    const asking = needs.length > 0 && (busy.has(`allow-row:${sense.id}`)
      || needs.some(id => grantOf(seen, id)?.asking === true));
    /** @type {SenseState} */
    const state = !known || !connector ? 'idle' : !on ? 'off' : needs.length === 0 ? 'allowed' : asking ? 'asking' : 'ask';
    return { ...sense, on, state, needs };
  });
  return { rows, asking: rows.some(row => row.state === 'asking'), held: rows.every(row => row.state === 'allowed'),
    never: neverOf(seen) };
}

/** @typedef {{ app?: string, site?: string, mode: 'activity' | 'exclude' }} ModeItem */

export const PASSWORD_MANAGERS = new Set(['com.1password.1password', 'com.agilebits.onepassword7', 'com.apple.Passwords',
  'com.apple.keychainaccess', 'com.bitwarden.desktop', 'com.lastpass.LastPass', 'com.dashlane.dashlanephonefinal',
  'org.keepassxc.keepassxc', 'com.protonpass.mac']);

/** @param {Seen} seen */
export function neverOf(seen) {
  const screen = seen.report?.connectors.find(connector => connector.members.some(member => member.items === 'modes'))
    ?? null;
  const member = screen?.members.find(each => each.items === 'modes') ?? null;
  const apps = seen.state?.apps ?? null;
  const items = /** @type {ModeItem[]} */ ((Array.isArray(member?.value) ? member.value : []).filter(item => item
    && typeof item === 'object' && (typeof item.app === 'string' || typeof item.site === 'string')
    && (item.mode === 'activity' || item.mode === 'exclude')));
  const out = items.filter(item => item.mode === 'exclude');
  const named = out.flatMap(item => {
    const app = item.app ? apps?.offered.find(each => each.id === item.app) ?? null : null;
    return app ? [app] : [];
  });
  const sites = out.flatMap(item => item.site ? [item.site] : []);
  const privately = apps?.private_windows === true;
  const shown = screen !== null && member !== null && member.panel !== null;
  return { apps: named, added: named.filter(app => !PASSWORD_MANAGERS.has(app.id)), sites, privately, items, shown,
    editable: shown && apps !== null,
    screen: shown ? screen : null, member: shown ? member : null };
}

/** @param {number} days */
export function roomWords(days) {
  const whole = Math.max(0, Math.floor(days));
  if (whole < 1) return 'less than a day';
  if (whole < 7) return 'a few days';
  if (whole < 14) return 'about a week';
  if (whole < 60) return `about ${Math.round(whole / 7)} weeks`;
  if (whole < 730) return `about ${Math.round(whole / 30)} months`;
  return `about ${Math.round(whole / 365)} years`;
}

const TIGHT_DAYS = 90;

export const DEFAULT_FOLDER = '~/Lifestream';

/** @param {string} folder */
export const driveOf = folder => /^\/Volumes\/([^/]+)/u.exec(folder)?.[1] ?? null;

/**
 * @param {Seen} seen
 * @param {{ busy: Set<string> }} session
 */
export function whereOf(seen, { busy }) {
  const machine = seen.state?.machine ?? null;
  const days = machine?.days_of_room ?? null;
  const setup = seen.state?.setup ?? null;
  const folder = machine?.folder || DEFAULT_FOLDER;
  const free = machine?.free_bytes == null ? '' : freeWords(machine.free_bytes);
  return {
    drive: machine?.disk?.name ?? driveOf(folder),
    external: driveOf(folder) !== null,
    folder,
    home: machine?.home ?? null,
    free,
    room: days === null || !free ? '' : `${free.replace(/ free$/u, '')} lasts ${roomWords(days)}.`,
    tight: days !== null && days < TIGHT_DAYS,
    working: homeThere(seen.state) || setup?.state === 'working' || busy.has('setup'),
    starting: setup?.state === 'working' ? setup.waiting ?? '' : '',
    error: setup?.state === 'failed' ? setup.error || SETUP_FAILED : '',
  };
}

export const NAME_LIMIT = 120;

/** @param {string} typed */
export const nameText = typed => typed.replace(/\s+/gu, ' ').trim();

/** @param {string} typed */
export const nameHolds = typed => nameText(typed).length > 0 && nameText(typed).length <= NAME_LIMIT;

/** @param {Seen} seen */
export const accountName = seen => nameText(seen.state?.account_name ?? '');

const SPAN_KEY = 'lifestream.setup.span';

/** @typedef {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} SpanStore */

/**
 * @param {SpanStore} store
 * @param {Seen} seen
 * @returns {{ months: number | null } | null}
 */
export function keptSpan(store, seen) {
  const folder = seen.state?.machine?.folder ?? null;
  if (folder === null) return null;
  try {
    const kept = JSON.parse(store.getItem(SPAN_KEY) ?? 'null');
    if (kept?.folder !== folder || kept.unit !== (seen.state?.unit ?? null)) return null;
    return typeof kept.months === 'number' || kept.months === null ? { months: kept.months } : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ months: number | null } | null} span
 * @param {SpanStore} store
 * @param {Seen} seen
 */
export const heldSpan = (span, store, seen) => span ?? keptSpan(store, seen);

/**
 * @param {SpanStore} store
 * @param {Seen} seen
 * @param {{ months: number | null } | null} span
 */
export function keepSpan(store, seen, span) {
  const folder = seen.state?.machine?.folder ?? null;
  if (span === null || folder === null) store.removeItem(SPAN_KEY);
  else store.setItem(SPAN_KEY, JSON.stringify({ folder, unit: seen.state?.unit ?? null, months: span.months }));
}
