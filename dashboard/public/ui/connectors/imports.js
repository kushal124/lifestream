// @ts-check
/** @import { ImportFileReport, ImportHeld, ImportReport, ImportWhich, StreamsReport } from '../../types.js' */
/** @import { HostBackup, HostBackupLeft, HostBackups, HostState } from '../../lib/host.js' */
/** @import { Act, Do } from './words.js' */
/** @import { Face } from './page.js' */
/** @import { Callout, Detail, Opened, Panel, PanelRow } from './dialog.js' */
import { dayAt } from '../../lib/home-clock.js';
import { count, dateOf, listWords, sizeWords } from '../../lib/words.js';
import { STATE_LOOKS } from '../kit/connector-row.js';
import { actsOf } from './page.js';
import { panelOf, rowOf } from './dialog.js';
import { DETAIL, FILE_PLACE } from './words.js';

export const IMPORT = 'import:';
export const IMPORTS_TYPE = { key: 'imports', name: 'Imports', icon: 'archive' };
export const IMPORTS_SEG = 'imports';
/** @param {ImportReport} kind */
const listsBackups = kind => kind.lists === 'backups';
export const IMPORTS_STEP = 'imports';
/** @param {string} id */
export const otherKey = id => `import.${id}.account`;

/**
 * @param {StreamsReport} report
 * @param {HostState | null} state
 */
export const pastToBring = (report, state) => state !== null && report.setup !== null && report.imports.length > 0
  && !report.setup.skipped.includes(IMPORTS_STEP) && !report.imports.some(kind => kind.held.length > 0 || kind.coming.length > 0);

/**
 * @param {StreamsReport | null} report
 * @param {HostState | null} state
 * @returns {{ title: string, show: Act, close: Act } | null}
 */
export function bannerOf(report, state) {
  if (!report || !pastToBring(report, state)) return null;
  return { title: `Import your past: ${listWords(report.imports.map(kind => kind.name), 3)}`,
    show: { label: 'Show imports', variant: 'secondary', do: { at: IMPORTS_SEG } },
    close: { label: 'Dismiss', do: { host: { act: 'skip', step: IMPORTS_STEP } } } };
}

/** @param {ImportReport} kind */
const importing = kind => kind.held.length > 0 || kind.coming.length > 0;

/**
 * @param {ImportReport} kind
 * @returns {Face}
 */
const importFace = kind => ({ id: `${IMPORT}${kind.kind}`, opens: `${IMPORT}${kind.kind}`, name: kind.name, icon: kind.icon,
  places: [FILE_PLACE], type: IMPORTS_TYPE.key, state: kind.health.state, set_up: importing(kind), starter: false,
  line: importing(kind) ? kind.line : kind.reads ?? (kind.products.length ? listWords(kind.products.map(product => product.name))
    : kind.takes), last: '', act: null,
  find: [kind.name, kind.takes, kind.reads ?? '', ...kind.products.map(product => product.name)].filter(Boolean) });

/** @param {StreamsReport} report */
export const importFaces = report => report.imports.map(importFace);


/** @typedef {{ label: string, steps: { title: string, words: string, open: Act | null }[] }} Guide */

/** @typedef {{ title: string, words: string, line: string, choose: Act | null, elsewhere: string }} Drop */

/** @typedef {{ callout: Callout | null, question: Panel | null, panel: Panel, open: Act | null }} Part */

/**
 * @typedef {object} ImportBody
 * @property {Callout[]} needs
 * @property {{ label: string, glyph: string }[]} chips
 * @property {Guide} guide
 * @property {Panel | null} backups
 * @property {Drop | null} drop
 * @property {{ label: string, coming: Panel | null, parts: Part[] } | null} yours
 */

/**
 * @param {ImportReport} kind
 * @returns {string}
 */
const readsOf = kind => kind.reads ?? (kind.products.length ? kind.products.map(product => product.name).join(' · ') : kind.takes);

/**
 * @param {ImportReport} kind
 * @returns {{ label: string, glyph: string }[]}
 */
const chipsOf = kind => [...listsBackups(kind) ? [] : [{ label: DETAIL.file, glyph: 'file' }],
  ...kind.wait ? [{ label: kind.wait, glyph: 'time' }] : []];

/**
 * @param {ImportReport} kind
 * @param {HostState | null} state
 * @returns {Guide}
 */
const guideOf = (kind, state) => ({ label: kind.titles.guide, steps: kind.guide.map(step => ({ title: step.title ?? '', words: step.words,
  open: step.open ? { label: step.open.label, variant: 'secondary', out: true,
    do: state ? { host: { act: 'open', what: 'site', url: step.open.url } } : { link: step.open.url } } : null })) });

/**
 * @param {{ state: import('../../types.js').State, words: string, line?: string | null, acts: import('../../types.js').Act[] }} said
 * @param {HostState | null} state
 * @returns {Callout}
 */
const calloutOf = (said, state) => ({ kind: STATE_LOOKS[said.state], title: said.words, lines: said.line ? [said.line] : [],
  acts: actsOf(said.acts.filter(act => act.do !== 'import'), null, state) });

/**
 * @param {ImportReport} kind
 * @param {ImportFileReport} file
 * @param {HostState | null} state
 * @returns {PanelRow}
 */
function fileRow(kind, file, state) {
  /** @param {string} label @param {'again' | 'forget'} doing @returns {Act} */
  const mac = (label, doing) => ({ label, variant: doing === 'again' ? 'secondary' : 'plain',
    do: { host: { act: 'import', do: doing, kind: kind.kind, file: file.id } } });
  const mine = !state ? [] : [...file.state === 'missing' ? [mac('Choose again', 'again')] : [],
    ...file.state === 'missing' || file.state === 'refused' ? [mac('Remove', 'forget')] : []];
  const acts = [...actsOf(file.acts, null, state), ...mine];
  const words = [file.words, file.line].filter(Boolean).join(' · ');
  return rowOf(file.name, { lead: { icon: 'file' }, end: acts.length ? { words, acts } : { words } });
}

/**
 * @param {ImportHeld} held
 * @param {Opened} opened
 * @returns {Panel | null}
 */
function questionOf(held, opened) {
  const { ask } = held;
  if (!ask) return null;
  const need = `import:${held.id}:whose`;
  /** @param {string} account @returns {Do} */
  const choose = account => ({ home: { need, do: 'choose', account } });
  /** @type {PanelRow[]} */
  const rows = [rowOf(ask.words, { lead: { icon: 'online' }, end: ask.choices.length ? { menu: { id: need, busy: '',
    label: ask.words, words: 'Choose an account', find: '', date: null, choices: ask.choices.map(each => ({ words: each, note: '',
      chosen: false, default: false, do: choose(each) })) } } : null })];
  if (ask.other) {
    const key = otherKey(held.id);
    const typed = (opened.fields?.[key] ?? '').trim();
    rows.push(rowOf(ask.another, { end: { field: { key, label: 'Another account', kind: 'text', value: opened.fields?.[key] ?? '',
      placeholder: 'Its email or user name' }, acts: [{ label: ask.choose, variant: 'secondary', disabled: !typed, do: choose(typed) }] } }));
  }
  return panelOf({ rows });
}

/**
 * @param {ImportWhich} which
 * @returns {Panel}
 */
function whichOf(which) {
  /** @param {string} unit @returns {Do} */
  const choose = unit => ({ home: { need: which.need, do: 'choose', account: unit } });
  return panelOf({ rows: [rowOf(which.words, { lead: { icon: 'phone-backup' }, line: which.line }),
    ...which.choices.map(choice => rowOf(choice.words, { lead: { icon: 'phone' }, line: choice.line,
      end: { acts: [{ label: which.choose, variant: 'secondary', do: choose(choice.unit) }] } }))] });
}

/**
 * @param {ImportReport} kind
 * @param {ImportHeld} held
 * @param {HostState | null} state
 * @param {Opened} opened
 * @param {{ question: Panel | null, words: string } | null} which
 * @returns {Part}
 */
function partOf(kind, held, state, opened, which) {
  const { health } = held;
  const asked = held.ask !== null || which !== null;
  const callout = asked || health.state === 'ok' || health.state === 'syncing' || !health.words || health.words === held.line
    ? null : calloutOf(health, state);
  const acts = callout || asked ? [] : actsOf(health.acts.filter(act => act.do !== 'import'), null, state);
  const status = rowOf(held.name, { lead: { look: health.state }, line: held.line === which?.words ? '' : held.line, end: acts.length ? { acts } : null });
  const products = held.products.map(product => rowOf(product.line,
    { dim: product.state === 'not-read' || product.state === 'skipped' }));
  /** @type {Act | null} */
  const open = held.open_day && held.open
    ? { label: held.open, variant: 'secondary', do: { to: { view: 'days', patch: { on: held.open_day } } } } : null;
  return { callout, question: which ? which.question : questionOf(held, opened), open, panel: panelOf({
    rows: [status, ...held.files.map(file => fileRow(kind, file, state)), ...products], note: held.downloaded ?? '' }) };
}


export const BACKUP_WORDS = {
  label: 'Backups on this Mac',
  read: 'Read it',
  again: 'Read it again',
  plain: 'Not encrypted: your calls aren\'t in it. iMessage and WhatsApp are.',
  making: 'Backing up in Finder…',
  opening: 'Opening…',
  reading: 'Reading your backup',
  media: 'photos and files',
  brought: 'Brought in',
  sending: 'Sending to Lifestream',
  remade: 'Your iPhone started a new backup. Read it when it\'s done.',
  /** @type {Record<HostBackupLeft['why'], (stores: string[]) => string>} */
  left: {
    unreadable: stores => `${listWords(stores)} couldn't be read from this backup.`,
    'too-large': stores => `${listWords(stores)} ${stores.length > 1 ? 'are' : 'is'} too large to send to Lifestream.`,
    lost: stores => `${listWords(stores)} didn't reach Lifestream.`,
  },
  waiting: 'Waiting',
  home: 'Waiting for Lifestream',
  /** @param {number | null} bytes */
  room: bytes => bytes ? `needs ${sizeWords(bytes)} free on this Mac` : 'needs more free space on this Mac',
  none: 'No backup on this Mac yet. Follow the steps above, then come back.',
  blind: 'Lifestream can\'t see your backups.',
  settings: 'Open Privacy Settings',
};

/** @param {HostBackupLeft[]} left */
const leftWords = left => /** @type {HostBackupLeft['why'][]} */ (['unreadable', 'too-large', 'lost']).flatMap(why => {
  const stores = left.filter(each => each.why === why).map(each => each.store);
  return stores.length ? [BACKUP_WORDS.left[why](stores)] : [];
}).join(' ');

/**
 * @param {HostBackup} backup
 * @returns {PanelRow}
 */
function backupRow(backup) {
  const made = dateOf(dayAt(backup.made_ms).day, { year: true });
  const whole = `${backup.name} · ${made}`;
  /** @param {string} label @returns {Act} */
  const read = label => ({ label, variant: 'secondary', do: { host: { act: 'import', do: 'backup-read', id: backup.id } } });
  const lead = { icon: 'phone-backup' };
  const left = leftWords(backup.left);
  const working = backup.read === 'opening' || backup.read === 'reading';
  if (backup.why === 'room' && working) {
    return rowOf(whole, { lead, line: BACKUP_WORDS.room(backup.need_bytes), end: { words: BACKUP_WORDS.waiting } });
  }
  if (backup.why === 'home' && working) return rowOf(whole, { lead, end: { words: BACKUP_WORDS.home } });
  if (backup.read === 'opening') return rowOf(whole, { lead, end: { words: BACKUP_WORDS.opening } });
  if (backup.read === 'reading') {
    const media = backup.of > 0 ? [`${count(backup.done)} of ${count(backup.of)} ${BACKUP_WORDS.media}`] : [];
    return rowOf(whole, { lead, line: [BACKUP_WORDS.reading, backup.doing ?? '', ...media].filter(Boolean).join(' · ') });
  }
  if (backup.read === 'sending') return rowOf(whole, { lead, end: { words: BACKUP_WORDS.sending } });
  if (!backup.finished) return rowOf(`${backup.name} · ${BACKUP_WORDS.making}`, { lead });
  if (backup.read === 'in') {
    const brought = `${BACKUP_WORDS.brought} ${backup.in_ms === null ? '' : dateOf(dayAt(backup.in_ms).day)}`.trim();
    return rowOf(whole, { lead, line: left, end: left ? { words: brought, acts: [read(BACKUP_WORDS.again)] } : { words: brought } });
  }
  if (backup.read === 'stopped' && backup.why === 'remade') return rowOf(whole, { lead, line: BACKUP_WORDS.remade });
  if (backup.read === 'stopped' && left) return rowOf(whole, { lead, line: left, end: { acts: [read(BACKUP_WORDS.again)] } });
  return rowOf(whole, { lead, line: backup.encrypted ? '' : BACKUP_WORDS.plain, end: { acts: [read(BACKUP_WORDS.read)] } });
}

/**
 * @param {HostBackups} backups
 * @returns {Panel}
 */
function backupsOf(backups) {
  if (backups.state === 'no-access') {
    return panelOf({ label: BACKUP_WORDS.label, rows: [rowOf(BACKUP_WORDS.blind, { end: { acts: [{ label: BACKUP_WORDS.settings,
      variant: 'secondary', do: { host: { act: 'import', do: 'backup-settings' } } }] } })] });
  }
  if (backups.state === 'none' || !backups.rows.length) return panelOf({ label: BACKUP_WORDS.label, rows: [rowOf(BACKUP_WORDS.none)] });
  return panelOf({ label: BACKUP_WORDS.label, rows: backups.rows.map(backupRow) });
}

/**
 * @param {ImportReport} kind
 * @param {HostState | null} state
 * @returns {Drop | null}
 */
function dropOf(kind, state) {
  if (listsBackups(kind) && state?.backups) return null;
  const here = state !== null && !listsBackups(kind);
  return { title: DETAIL.dropHere, words: kind.drop.words, line: kind.drop.line, elsewhere: here ? '' : kind.drop.away,
    choose: here ? { label: kind.drop.choose, variant: 'secondary', do: { host: { act: 'import', do: 'choose', kind: kind.kind } } } : null };
}

/**
 * @param {ImportReport} kind
 * @param {StreamsReport} report
 * @param {HostState | null} state
 * @param {Opened} opened
 * @returns {ImportBody}
 */
function bodyOf(kind, report, state, opened) {
  const said = new Set([...kind.held.flatMap(held => [held.health.words, `import:${held.id}:whose`,
    ...held.health.acts.flatMap(act => 'need' in act ? [act.need] : [])]), ...(kind.which ?? []).map(which => which.need)]);
  /** @type {Map<string, { question: Panel | null, words: string }>} */
  const whichAt = new Map();
  for (const which of kind.which ?? []) {
    const first = kind.held.find(held => which.imports.includes(held.id));
    for (const id of which.imports) whichAt.set(id, { question: id === first?.id ? whichOf(which) : null, words: which.words });
  }
  const coming = kind.coming.map(file => fileRow(kind, file, state));
  return {
    needs: report.needs.filter(need => need.connector === kind.kind && !said.has(need.id) && !said.has(need.words))
      .map(need => calloutOf(need, state)),
    chips: chipsOf(kind),
    guide: guideOf(kind, state),
    backups: listsBackups(kind) && state?.backups ? backupsOf(state.backups) : null,
    drop: dropOf(kind, state),
    yours: coming.length || kind.held.length ? { label: kind.titles.held, coming: coming.length ? panelOf({ rows: coming }) : null,
      parts: kind.held.map(held => partOf(kind, held, state, opened, whichAt.get(held.id) ?? null)) } : null,
  };
}

/**
 * @param {StreamsReport} report
 * @param {HostState | null} state
 * @param {string} id
 * @param {Opened} opened
 * @returns {Detail | null}
 */
export function importDetail(report, state, id, opened) {
  const kind = report.imports.find(each => `${IMPORT}${each.kind}` === id);
  if (!kind) return null;
  return { id, icon: kind.icon, name: kind.name, line: readsOf(kind), state: kind.health.state,
    callout: null, figure: null, parts: [], panels: [], back: null, foot: null, confirm: null,
    reading: false, ticking: false, page: true, import: bodyOf(kind, report, state, opened) };
}
