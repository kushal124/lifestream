// @ts-check
/** @import { Act as ReportAct, ConnectorReport, DeviceRow, Need, Route, State, StreamsReport } from '../../types.js' */
/** @import { Act as PageAct, StreamRow } from '../../pages.js' */
/** @import { HostNeed, HostState } from '../../lib/host.js' */
/** @import { Act, Do, Place, PlaceKey } from './words.js' */
import { counted, found, lineWhen, listWords } from '../../lib/words.js';
import { lacks } from '../../lib/reach.js';
import { needAct, PAGE, PLACES, placesOf } from './words.js';
import { STATE_WORDS } from '../kit/connector-row.js';
import { SETTINGS_CHROME, SETTINGS_HOME, SETTINGS_IPHONE, SETTINGS_MAC } from './settings.js';
import { IMPORT, importFaces, IMPORTS_TYPE, bannerOf } from './imports.js';
import { dismissedOwn, stampOf } from './dismissed.js';
import { DISMISS } from '../kit/status-strip.js';

/**
 * @typedef {object} Face
 * @property {string} id
 * @property {string | null} opens
 * @property {string} name
 * @property {string} icon
 * @property {Place[]} places
 * @property {string} type
 * @property {State} state
 * @property {boolean} set_up
 * @property {boolean} starter
 * @property {string} line
 * @property {string} last
 * @property {Act | null} act
 * @property {string[]} find
 */

/** @typedef {{ key: string, name: string, faces: Face[] }} Section */

/** @typedef {{ title: string, show: Act, close: Act }} Banner */

/** @typedef {{ id: string, weight: 'stopped' | 'advice', title: string, line: string, act: Act | null, dismiss: Act | null }} Alert */

/** @typedef {{ flow: 'phone' | 'browser', label: string }} Wanted */

/** @typedef {{ id: string, name: string, icon: string, state: State | null, line: string | null, reported: { word: boolean, line: boolean }, group: 'home' | 'devices' | 'removed', wanted: Wanted | null }} SideRow */

/**
 * @typedef {object} Page
 * @property {boolean} read
 * @property {Banner | null} banner
 * @property {Alert[]} alerts
 * @property {Section[]} sections
 * @property {string} empty
 * @property {Entry | null} entry
 * @property {SideRow[]} side
 * @property {number} count
 * @property {string} announce
 * @property {Record<PlaceKey, number>} placeCounts
 * @property {Shown} shown
 * @property {Record<Shown, number>} shownCounts
 */

/** @typedef {'connected' | 'not'} Shown */

/** @typedef {{ query: string, place: PlaceKey | '', shown?: Shown | '' }} Filter */

/** @typedef {{ prompt: string, open: boolean }} Entry */

const START_KEY = 'start';

/**
 * @param {{ prompt: string, blank: string }} adding
 * @param {string} query
 */
export const promptFor = (adding, query) => query ? adding.prompt.replaceAll(adding.blank, () => query) : adding.prompt;


/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 */
export const routesOf = (connector, state) => state ? connector.routes.filter(route => state.signins.includes(route.way)) : [];

/**
 * @param {ConnectorReport} connector
 * @param {Route} route
 * @returns {Do}
 */
export const routeAct = (connector, route) => ({ host: { act: 'sheet', connector: connector.id, route: route.id } });

export const TYPED = /** @type {const} */ (['text', 'email', 'date', 'secret']);

/** @param {import('../../types.js').MemberState} member */
export const typed = member => member.control !== null && /** @type {readonly string[]} */ (TYPED).includes(member.control);

/** @param {StreamsReport | null} report */
export const chromeBrings = report => (report?.connectors ?? []).filter(each => each.roads.includes('chrome'));

/**
 * @param {ConnectorReport} connector
 * @returns {import('../../types.js').MemberState[]}
 */
export function formOf(connector) {
  const routed = new Set(connector.routes.flatMap(route => route.sets));
  return connector.members.filter(member => member.panel === 'account' && !routed.has(member.key) && member.control !== null);
}

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {Do | null}
 */
export function formDo(connector, state) {
  const form = formOf(connector);
  if (!state || !form.length) return null;
  if (!form.some(member => member.control === 'secret')) return { page: 'form' };
  return vaultFirst(state, connector.id) ?? { page: 'form' };
}

const UNLOCK = /** @type {Do} */ ({ host: { act: 'vault', do: 'unlock' } });

/**
 * @param {HostState} state
 * @param {string} then
 * @returns {Do | null}
 */
function vaultFirst(state, then) {
  const vault = state.vault?.state ?? null;
  if (vault === 'locked' || vault === 'lost') return UNLOCK;
  return vault === 'saved' ? null : { flow: 'vault', then, make: vault === 'none' || vault === 'unsaved' };
}

/**
 * @param {import('../../types.js').MemberState} member
 * @param {HostState} state
 */
export const settableHere = (member, state) => member.where === null || member.where.unit === state.unit;

/**
 * @param {ConnectorReport} connector
 * @param {HostState | null} state
 * @returns {Do | null}
 */
export function signInOf(connector, state) {
  const routes = routesOf(connector, state);
  if (routes.length > 1) return { page: 'signin' };
  return routes.length ? routeAct(connector, routes[0]) : null;
}

/**
 * @param {ConnectorReport} connector
 * @param {string} label
 * @returns {Act}
 */
export const uploadAct = (connector, label) => ({ label, do: { host: { act: 'upload', connector: connector.id } } });

/**
 * @param {ReportAct | PageAct} act
 * @param {ConnectorReport | null} connector
 * @param {HostState | null} state
 * @returns {Act | null}
 */
export function actOf(act, connector, state) {
  if (act.do === 'try' || act.do === 'skip' || act.do === 'let-go') return { label: act.label, do: { home: { need: act.need, do: act.do } } };
  if (act.do === 'import') return { label: act.label, do: { open: `${IMPORT}${act.kind}` } };
  if (act.do === 'copy') return { label: act.label, do: { copy: act.text } };
  if (act.do === 'read' || act.do === 'ignore') {
    return { label: act.label, do: { home: { need: act.need, do: act.do, of: act.of } } };
  }
  if (act.do === 'report') {
    return connector && { label: act.label, variant: 'plain', do: { feedback: { connector: act.of, name: connector.name } } };
  }
  if (!state) return null;
  if (act.do === 'resume') return { label: act.label, do: { host: { act: 'resume', connector: act.of } } };
  if (act.do === 'turn') return { label: act.label, do: { host: { act: 'turn', sources: act.ids, on: true } } };
  if (act.do === 'open') return { label: act.label, out: true, do: { host: { act: 'open', what: 'site', url: act.url } } };
  if (act.do === 'pair') return { label: act.label, do: { flow: 'phone' } };
  if (act.do === 'extension' || act.do === 'browser') return { label: act.label, do: { flow: 'browser' } };
  if (act.do === 'storage') return { label: act.label, do: { host: { act: 'open', what: 'storage' } } };
  if (act.do === 'vault') {
    const vault = state.vault?.state ?? null;
    return { label: act.label, do: vault === 'locked' || vault === 'lost' ? UNLOCK : { host: { act: 'vault', do: 'open' } } };
  }
  if (act.do === 'install') return { label: act.label, do: { host: { act: 'faces', do: 'on' } } };
  if (act.do === 'grant') return act.unit === state.unit ? { label: act.label, do: { host: { act: 'allow', grants: [act.grant] } } } : null;
  if (!connector) return null;
  if (act.do === 'upload') return uploadAct(connector, act.label);
  if (act.do === 'refresh') return { label: act.label, do: { host: { act: 'refresh', connector: act.of } } };
  if (act.do === 'signin') {
    const route = routesOf(connector, state).find(each => each.id === act.of);
    if (!route) return null;
    return { label: act.label, do: vaultFirst(state, connector.id) ?? routeAct(connector, route) };
  }
  if (act.do === 'set') {
    const member = connector.members.find(each => each.key === act.member);
    if (!member) return null;
    if (member.control === 'path') {
      return settableHere(member, state) ? { label: act.label, do: { host: { act: 'choose-file', connector: connector.id, member: member.key } } } : null;
    }
    const form = formOf(connector).includes(member) ? formDo(connector, state) : null;
    return form && { label: act.label, do: form };
  }
  return null;
}

/**
 * @param {ReportAct[]} acts
 * @param {ConnectorReport | null} connector
 * @param {HostState | null} state
 * @returns {Act[]}
 */
export function actsOf(acts, connector, state) {
  const taken = acts.map(act => actOf(act, connector, state)).filter(act => act !== null);
  const reported = taken.filter(isReport);
  const rest = taken.filter(act => !isReport(act));
  return [...reported, ...rest.length < 2 ? rest
    : rest.map((act, at) => ({ ...act, variant: at === 0 ? 'primary' : act.variant ?? 'secondary' }))];
}

/** @param {Act} act */
export const isReport = act => 'feedback' in act.do;

/**
 * @param {ConnectorReport} connector
 * @param {'all' | 'history'} scope
 */
export const pausedOf = (connector, scope) => connector.pauses.some(pause => pause.scope === scope);

/**
 * @param {ConnectorReport} connector
 * @returns {Act}
 */
export const pausing = connector => {
  const what = connector.sensor ? ' reading' : '';
  return pausedOf(connector, 'all')
    ? { label: `Resume${what}`, do: { host: { act: 'resume', connector: connector.id } } }
    : { label: `Pause${what}`, do: { host: { act: 'pause', connector: connector.id } } };
};

/** @param {ConnectorReport} connector */
export const readingPaused = connector => connector.sensor && pausedOf(connector, 'all');

/**
 * @param {ConnectorReport} connector
 * @param {import('../../types.js').MemberState} member
 */
export const fieldHint = (connector, member) => member.placeholder ?? (member.control === 'email' ? 'name@example.com'
  : member.control === 'text' ? `As ${connector.name} shows it` : '');


/** @param {ConnectorReport} connector */
export const wholeLine = connector => [connector.lead, connector.line].filter(Boolean).join(' · ');

/** @param {ConnectorReport} connector */
export const opensOf = connector => connector.export?.opens ? `${IMPORT}${connector.export.import}` : connector.id;

/**
 * @param {StreamRow} row
 * @param {number} now
 */
export const rowLine = (row, now) => [row.time ? `${row.line} ${lineWhen(row.time, now)}` : row.line, ...row.more]
  .filter(Boolean).join(' · ');

/**
 * @param {StreamRow} row
 * @param {ConnectorReport[]} members
 * @param {HostState | null} state
 * @param {number} now
 * @returns {Face}
 */
function rowFace(row, members, state, now) {
  const [first] = [...members.filter(each => each.set_up), ...members];
  const lead = members.find(each => each.health.state === row.health.state) ?? first;
  const set_up = members.some(each => each.set_up);
  return {
    id: first.id, opens: opensOf(first), name: row.name, icon: row.icon, places: [...new Set(members.flatMap(placesOf))],
    type: first.type?.key ?? '', state: row.health.state, set_up, starter: members.some(each => each.starter),
    line: rowLine(row, now), last: set_up && row.last ? lineWhen(row.last, now) : '',
    act: row.act && actOf(row.act, lead, state), find: row.find,
  };
}

/** @type {Record<'mac' | 'phone', string>} */
const DEVICE_ICONS = { mac: 'work-mac', phone: 'phone-screen' };

/**
 * @param {DeviceRow} device
 * @param {HostState | null} state
 */
const deviceOpens = (device, state) => device.kind === 'mac' && device.unit === state?.unit ? SETTINGS_MAC
  : `${device.kind === 'mac' ? SETTINGS_MAC : SETTINGS_IPHONE}/${device.unit}`;

/**
 * @param {StreamsReport | null} report
 * @param {HostState | null} state
 * @returns {SideRow[]}
 */
export function sideOf(report, state) {
  /**
   * @param {string} id
   * @param {string} name
   * @param {string} icon
   * @param {State | null} look
   * @param {string | null} line
   * @param {{ reported?: SideRow['reported'], group?: SideRow['group'], wanted?: Wanted | null }} [more]
   * @returns {SideRow}
   */
  const row = (id, name, icon, look, line, { reported = { word: true, line: true }, group = 'devices', wanted = null } = {}) =>
    ({ id, name, icon, state: look, line, reported, group, wanted });
  const home = report?.home ?? null;
  const reach = state?.reach ?? null;
  const stopped = reach && lacks(reach) && home?.health.state !== 'paused' ? reach.meta ?? '' : null;
  /** @type {State | null} */
  const look = stopped !== null ? reach?.tone === 'warning' ? 'broken' : 'needs-you'
    : home ? home.health.state : state ? 'ok' : null;
  /** @type {SideRow[]} */
  const rows = [row(SETTINGS_HOME, home?.name ?? 'Lifestream', 'home', look, stopped ?? home?.health.words ?? null,
    { reported: { word: !state, line: stopped === null }, group: 'home' })];
  /** @param {DeviceRow} device */
  const deviceRow = device => row(deviceOpens(device, state), device.name, DEVICE_ICONS[device.kind], device.health.state,
    device.health.words, { group: device.retired ? 'removed' : 'devices' });
  const devices = report?.devices ?? [];
  rows.push(...devices.filter(each => !each.retired).map(deviceRow));
  const wants = state !== null && report !== null;
  if (wants && !devices.some(each => each.kind === 'phone' && !each.retired)) {
    rows.push(row('phone', 'iPhone', 'phone-screen', null, WANTED.phone, { wanted: { flow: 'phone', label: 'Connect' } }));
  }
  const sites = chromeBrings(report).map(each => each.name);
  rows.push(wants && !extensionOn(report) ? row(SETTINGS_CHROME, 'Chrome', 'web', null,
    sites.length ? `Your ${listWords(sites, 3)} history` : WANTED.browser, { wanted: { flow: 'browser', label: 'Add' } })
    : row(SETTINGS_CHROME, report?.extension.name ?? 'Chrome extension', 'web', report?.extension.health.state ?? null,
      report?.extension.health.words ?? null));
  rows.push(...devices.filter(each => each.retired).map(deviceRow));
  return rows;
}

const WANTED = { phone: 'Where you go, your health, and Chat on the go', browser: 'Sites with no export of their own' };

/** @param {StreamsReport | null} report */
export const extensionOn = report => report?.extension.present === true
  || (report?.connectors ?? []).some(connector => connector.chosen === true);


/**
 * @param {Face} face
 * @param {Filter} filter
 */
const shownBy = (face, { query, place }) => (!place || face.places.some(each => each.key === place)) && found(face.find, query);

/**
 * @param {StreamsReport | null} report
 * @param {HostState | null} state
 * @param {boolean} [unanswered]
 * @param {Set<string>} [dismissed]
 * @returns {HostNeed[]}
 */
export function ownNeeds(report, state, unanswered = false, dismissed = dismissedOwn()) {
  const stated = new Set((report?.needs ?? []).map(need => need.id));
  const away = unanswered || lacks(state?.reach);
  return (state?.needs ?? []).filter(need => ((!need.home && !stated.has(need.id)) || (!report && away)) && !dismissed.has(stampOf(need)));
}

/**
 * @param {StreamsReport | null} report
 * @param {HostState | null} state
 * @param {boolean} [unanswered]
 * @param {Set<string>} [dismissed]
 * @returns {Alert[]}
 */
export function needsOf(report, state, unanswered = false, dismissed = dismissedOwn()) {
  /** @param {Need} need @returns {Alert} */
  const fromHome = need => {
    const mac = state?.needs.find(each => each.id === need.id);
    const acts = mac && !mac.home ? need.acts.filter(act => act.do !== 'vault') : need.acts;
    const home = actsOf(acts, report?.connectors.find(each => each.id === need.connector) ?? null, state);
    const hosted = !mac ? [] : mac.acts.filter(each => !home.some(act => act.label === each.label)).map(each => needAct(mac, each));
    return { id: need.id, weight: need.weight, title: need.words, line: need.line ?? '', act: home[0] ?? hosted[0] ?? null,
      dismiss: need.weight === 'advice' ? { label: DISMISS, do: { home: { need: need.id, do: 'dismiss' } } } : null };
  };
  /** @param {HostNeed} need @returns {Alert} */
  const own = need => ({ id: need.id, weight: 'advice', title: need.line, line: need.detail ?? '',
    act: need.acts.length ? needAct(need, need.acts[0]) : null, dismiss: { label: DISMISS, do: { dismiss: stampOf(need) } } });
  return [...ownNeeds(report, state, unanswered, dismissed).map(own), ...(report?.needs ?? []).filter(need => !need.banner).map(fromHome)];
}

/**
 * @param {StreamsReport} report
 * @param {HostState | null} state
 * @returns {Section[]}
 */
function sectionsOf(report, state) {
  const now = Date.now();
  const streams = report.connectors.filter(each => each.shown === 'stream');
  const byId = new Map(streams.map(each => [each.id, each]));
  const imported = new Set(report.imports.filter(kind => kind.products.length === 0).map(kind => kind.kind));
  /** @param {ConnectorReport} member */
  const onlyImported = member => !member.set_up && member.roads.every(road => road === 'upload')
    && imported.has(member.export?.import ?? '');
  const faces = [...importFaces(report), ...report.rows.flatMap(row => {
    const members = row.ids.map(id => byId.get(id)).filter(each => each !== undefined);
    return members.length && !members.every(onlyImported) ? [rowFace(row, members, state, now)] : [];
  })];
  const names = new Map([...streams.map(each => /** @type {const} */ ([each.type?.key ?? '', each.type?.name ?? ''])),
    [IMPORTS_TYPE.key, IMPORTS_TYPE.name]]);
  const fresh = !faces.some(face => face.set_up);
  const starting = fresh ? faces.filter(face => face.starter) : [];
  /** @type {Map<string, Face[]>} */
  const kinds = new Map();
  for (const face of faces.filter(each => !starting.includes(each))) kinds.set(face.type, [...kinds.get(face.type) ?? [], face]);
  const imports = kinds.get(IMPORTS_TYPE.key);
  kinds.delete(IMPORTS_TYPE.key);
  if (imports) kinds.set(IMPORTS_TYPE.key, imports);
  return [...starting.length ? [{ key: START_KEY, name: PAGE.start, faces: starting }] : [],
    ...[...kinds].map(([key, list]) => ({ key, name: names.get(key) ?? '',
      faces: [...list.filter(face => face.set_up), ...list.filter(face => !face.set_up)] }))];
}

/**
 * @param {StreamsReport | null} report
 * @param {HostState | null} state
 * @param {Filter} filter
 * @param {{ unanswered?: boolean, adding?: boolean }} [read]
 * @returns {Page}
 */
export function pageOf(report, state, filter, { unanswered = false, adding = false } = {}) {
  const query = filter.query.trim();
  const all = report ? sectionsOf(report, state) : [];
  /** @param {Filter} shown */
  /** @param {Filter} kept @param {Shown} side */
  const keptOn = (kept, side) => all.map(section => ({ ...section, faces: section.faces.filter(face => shownBy(face, kept)
    && face.set_up === (side === 'connected')) })).filter(section => section.faces.length > 0);
  /** @param {Section[]} list */
  const rows = list => list.reduce((sum, section) => sum + section.faces.length, 0);
  const shownCounts = { connected: rows(keptOn({ query, place: filter.place }, 'connected')),
    not: rows(keptOn({ query, place: filter.place }, 'not')) };
  /** @type {Shown} */
  const shown = filter.shown || (report && !all.some(section => section.faces.some(face => face.set_up)) ? 'not' : 'connected');
  /** @param {Filter} kept */
  const kept = kept => keptOn(kept, shown);
  const sections = kept({ query, place: filter.place });
  const count = rows(sections);
  return {
    read: report !== null,
    banner: bannerOf(report, state),
    alerts: needsOf(report, state, unanswered),
    sections,
    empty: report && count === 0 ? PAGE.none : '',
    entry: report && shown === 'not' ? { prompt: promptFor(report.adding, query), open: adding } : null,
    side: sideOf(report, state),
    count, announce: counted(count, PAGE.one),
    placeCounts: /** @type {Record<PlaceKey, number>} */ (Object.fromEntries(PLACES.map(place =>
      [place.key, rows(kept({ query, place: place.key }))]))),
    shown, shownCounts,
  };
}

/**
 * @param {Face} face
 * @returns {{ act: Act } | { connect: string } | { state: State, word: string } | { last: string }}
 */
export const endOf = face => face.act ? { act: face.act } : !face.set_up ? { connect: PAGE.connect }
  : STATE_WORDS[face.state] ? { state: face.state, word: /** @type {string} */ (STATE_WORDS[face.state]) } : { last: face.last };

/** @param {import('../../lib/host.js').HostReply} reply */
export const appAdded = reply => reply.added === true;
