// @ts-check
/** @import { ConnectorReport, ExportRow, Health, ImportFileReport, ImportHeld, ImportReport, ImportWhich, Need, StreamsReport } from './types.js' */
/** @import { HostBackup, HostBackups, HostState } from './lib/host.js' */
import { HOST_STATE, REPORT } from './kit-gallery-report.js';

const TAKEOUT_KIND = 'google-takeout';
const DROP_LINE = 'Lifestream reads a copy. Your files are never moved or deleted.';
const TITLES = { reads: 'What Lifestream reads today', guide: 'How to get it', held: 'Your imports' };
const IMPORTS = { key: 'imports', name: 'Imports', icon: 'archive' };

/**
 * @param {Health['state']} state
 * @param {Partial<Health>} [more]
 * @returns {Health}
 */
const health = (state, more = {}) => ({ state, reason: null, words: '', since_ms: null, next_ms: null, acts: [], detail: null, ...more });

/** @type {ImportReport} */
export const TAKEOUT = {
  kind: TAKEOUT_KIND, name: 'Google Takeout', icon: 'archive', takes: 'A download you make at Google', file: 'zip', wait: 'Minutes, or hours with photos', reads: null,
  products: [{ id: 'calendar', name: 'Calendar' }, { id: 'contacts', name: 'Contacts' }, { id: 'google-photos', name: 'Google Photos' },
    { id: 'mail', name: 'Mail' }, { id: 'my-activity', name: 'My Activity' }],
  guide: [
    { title: 'Ask Google', words: 'On Google Takeout, press Deselect all, then tick the products listed above. Under My Activity press Multiple formats and choose JSON.',
      open: { label: 'Open Google Takeout', url: 'https://takeout.google.com/' } },
    { title: 'Make the export', words: 'Press Next step. Keep Send download link via email, Export once and .zip, choose 10 GB files, and press Create export.' },
    { title: 'Wait for the email', words: 'Google emails you when it\'s ready: minutes for a few products, hours with photos. Download every file.' },
  ],
  recognise: ['Takeout/Mail/**/*.mbox', 'Takeout/Calendar/**/*.ics', 'Takeout/Contacts/*/*.vcf', 'Takeout/Google Photos/**'],
  leaves: [],
  root: 'Takeout/',
  drop: { words: 'Drop your Google Takeout here', line: DROP_LINE, choose: 'Choose…', away: 'On your Mac' }, titles: TITLES,
  health: health('ok'), line: 'A download you make at Google', coming: [], held: [],
};

/** @type {ImportReport} */
export const SPOTIFY = {
  kind: 'spotify', name: 'Spotify', icon: 'listening', takes: 'Spotify takes up to 30 days', file: 'zip', wait: 'Up to 30 days',
  reads: 'Every play since your account began, with how long it played.',
  products: [], guide: [{ title: 'Ask Spotify', words: 'On Spotify’s Privacy page, tick Extended streaming history, then press Request data.',
    open: { label: 'Open Spotify’s Privacy page', url: 'https://spotify.example.com/privacy' } },
  { title: 'Wait for the email', words: 'Spotify takes up to 30 days. When it emails you, download the zip.' }],
  recognise: ['**/Streaming_History_Audio_*.json'],
  leaves: ['**/ReadMeFirst_*.pdf'],
  drop: { words: 'Drop the zip here', line: 'Lifestream reads a copy; your file stays where it is.', choose: 'Choose file…', away: 'On your Mac' },
  titles: TITLES, health: health('ok'), line: 'Spotify takes up to 30 days', coming: [], held: [],
};

/**
 * @param {string} id
 * @param {string} name
 * @param {ImportFileReport['state']} state
 * @param {string} words
 * @param {string} line
 * @param {Partial<ImportFileReport>} [more]
 * @returns {ImportFileReport}
 */
const file = (id, name, state, words, line, more = {}) => ({ id, name, bytes: 1_000_000, state, words, line, acts: [], ...more });

/** @type {ImportReport} */
export const IPHONE_BACKUP = {
  kind: 'iphone-backup', name: 'iPhone backup', icon: 'phone-backup', takes: 'A backup in Finder', file: 'backup', wait: null, reads: null,
  products: [{ id: 'imessage', name: 'iMessage' }, { id: 'whatsapp', name: 'WhatsApp' }, { id: 'apple-calls', name: 'Calls' }],
  guide: [
    { words: 'Plug your iPhone into this Mac. In Finder, choose it in the sidebar.' },
    { words: 'Under Backups, choose Back up all of the data on your iPhone to this Mac and tick Encrypt local backup. Set a password: calls are in the backup only when it\'s encrypted.' },
    { words: 'Press Back Up Now. It takes an hour or more; the phone can stay in use.' },
  ],
  recognise: [], leaves: [], lists: 'backups', which: [],
  drop: { words: 'Drop your iPhone backup here', line: DROP_LINE, choose: 'Choose…', away: 'On your Mac' }, titles: TITLES,
  health: health('ok'), line: 'A backup in Finder', coming: [], held: [],
};

export const SENDING_FILES = [
  file('file-01', 'takeout-20261104T080000Z-1-001.zip', 'checking', 'Checking…', ''),
  file('file-02', 'takeout-20261104T080000Z-2-001.zip', 'sending', 'Sending', '12 MB of 41 MB'),
  file('file-03', 'takeout-20261104T080000Z-3-001.zip', 'waiting', 'Waiting', 'plug in your Mac'),
];
export const REFUSED_FILES = [
  file('file-04', 'notes.zip', 'refused', 'This isn\'t a Google Takeout', 'Choose the file Google Takeout sent you'),
  file('file-05', 'takeout-20261003T080000Z-1-001.zip', 'missing', 'Can\'t find it', 'Choose it again'),
  file('file-06', 'takeout-20261027T080000Z-1-001.zip', 'already', 'Already in', 'brought in 1 Nov'),
];

const PERSON_A = 'person-a@example.com';
/** @type {ImportHeld} */
export const DONE = {
  id: 'a000000000000001', account: PERSON_A, made_at: '2026-10-27T08:00:00.000Z', name: `27 Oct 2026 · ${PERSON_A}`,
  health: health('ok'), line: 'In · 2009–2026', ask: null, files: [],
  products: [{ id: 'calendar', name: 'Calendar', state: 'read', count: 1240, line: 'Calendar · 1,240 events' },
    { id: 'mail', name: 'Mail', state: 'read', count: 41000, line: 'Mail · 41,000 emails' },
    { id: 'my-activity', name: 'My Activity', state: 'read', count: 8200, line: 'My Activity · 8,200 so far · came as HTML · next time choose JSON: it holds more' },
    { id: 'drive', name: 'Drive', state: 'not-read', count: 0, line: 'Drive · not read yet' }],
  span: { from: '2009-03-01', to: '2026-10-27' }, open_day: '2019-03-14', open: 'Open a day',
  downloaded: 'You can delete the file you downloaded.',
  notice: { title: 'Your Google Takeout is in', body: 'Calendar, Mail and My Activity, 2009 to 2026' },
};
export const BROUGHT = 'Brought in 27 Oct · Calendar, Mail, 1 more';

/** @type {ImportHeld} */
export const READING = {
  ...DONE, health: health('syncing'), line: 'Bringing in · Mail 41,000 emails · Google Photos 12,000 so far', span: null, open_day: null,
  open: null, downloaded: null, notice: null,
  files: [file('b7cd0cf7a8054348', 'takeout-20261027T080000Z-1-001.zip', 'held', 'In Lifestream', '1 MB'),
    file('c2d0cf7a80543481', 'takeout-20261027T080000Z-2-001.zip', 'read', 'Read', '1 MB')],
  products: [{ id: 'mail', name: 'Mail', state: 'reading', count: 41000, line: 'Mail · 41,000 emails' },
    { id: 'google-photos', name: 'Google Photos', state: 'reading', count: 12000, line: 'Google Photos · 12,000 so far' },
    { id: 'calendar', name: 'Calendar', state: 'waiting', count: 0, line: 'Calendar · waiting' }],
};

/** @type {ImportHeld} */
export const ASKED = {
  ...READING, id: 'a000000000000003', account: null, name: '14 Nov 2026', products: [],
  files: [file('d1e2f3a4b5c6d7e8', 'takeout-20261114T080000Z-1-001.zip', 'held', 'In Lifestream', '1 MB',
    { acts: [{ do: 'let-go', label: 'Let go', need: 'import:a000000000000003:file:d1e2f3a4b5c6d7e8' }] })],
  health: health('needs-you', { reason: 'choose', words: 'Whose Google account is this Takeout from 14 Nov?',
    acts: [{ do: 'import', label: 'Choose', kind: TAKEOUT_KIND }] }),
  line: 'Whose Google account is this Takeout from 14 Nov?',
  ask: { words: 'Whose Google account is this Takeout from 14 Nov?', choices: [PERSON_A, 'person-b@example.com'], other: true,
    choose: 'Choose', another: 'Another…' },
};

/** @type {ImportHeld} */
export const NO_ROOM = {
  ...READING, health: health('waiting', { reason: 'disk', words: 'Waiting for space on Lifestream\'s disk', line: 'your files are kept' }),
  line: 'Waiting for space on Lifestream\'s disk · 3 GB free to go on · your files are kept',
};

const BROKEN_NEED = 'job:import:youtube:person-a@example.com:export';
/** @type {ImportHeld} */
export const BROKEN = {
  ...READING, health: health('broken', { reason: 'import', words: 'Couldn\'t bring in YouTube', line: 'From your Google Takeout',
    since_ms: REPORT.at_ms - 3_600_000, acts: [{ do: 'skip', label: 'Skip it', need: BROKEN_NEED }] }),
  line: 'Bringing in · My Activity 0 so far',
};

const WHOLE_NEED = 'import:a000000000000005:refused';
/** @type {ImportHeld} */
export const REFUSED_WHOLE = {
  ...READING, id: 'a000000000000005', account: null, name: '12 Nov 2026', products: [],
  health: health('needs-you', { reason: 'import', words: 'Couldn\'t read this Google Takeout', line: 'From your Google Takeout',
    acts: [{ do: 'skip', label: 'Skip it', need: WHOLE_NEED }] }),
  line: 'Couldn\'t read this Google Takeout',
  files: [file('e5f6a7b8c9d0e1f2', 'takeout-20261112T080000Z-1-001.zip', 'kept', 'Kept', 'couldn\'t be read',
    { acts: [{ do: 'let-go', label: 'Let go', need: 'import:a000000000000005:file:e5f6a7b8c9d0e1f2' }] })],
};

const REFUSED_NEED = 'import:a000000000000002:refused';
/** @type {ImportHeld} */
export const KEPT = {
  id: 'a000000000000002', account: PERSON_A, made_at: '2026-10-20T08:00:00.000Z', name: `20 Oct 2026 · ${PERSON_A}`,
  health: health('needs-you', { reason: 'import', words: 'Couldn\'t read 1 file', line: 'From your Google Takeout',
    acts: [{ do: 'skip', label: 'Skip it', need: REFUSED_NEED }] }),
  line: 'In · 2009–2026 · 1 file couldn\'t be read', ask: null,
  files: [file('b9ab517384dca75a', 'takeout-20261020T080000Z-1-001.zip', 'kept', 'Kept', '1 file couldn\'t be read',
    { acts: [{ do: 'let-go', label: 'Let go', need: 'import:a000000000000002:file:b9ab517384dca75a' }] })],
  products: [{ id: 'my-activity', name: 'My Activity', state: 'partly', count: 0, line: 'My Activity · 1 file couldn\'t be read' }],
  span: { from: '2009-03-01', to: '2026-10-20' }, open_day: '2018-06-02', open: 'Open a day', downloaded: null, notice: null,
};

/** @type {ImportHeld} */
export const OLDER = {
  id: 'a000000000000004', account: 'person-b@example.com', made_at: '2026-09-01T08:00:00.000Z',
  name: '1 Sept 2026 · person-b@example.com', health: health('ok'), line: 'In · 2011–2026', ask: null, files: [],
  products: [{ id: 'calendar', name: 'Calendar', state: 'read', count: 612, line: 'Calendar · 612 events' }],
  span: { from: '2011-05-01', to: '2026-09-01' }, open_day: '2019-03-14', open: 'Open a day',
  downloaded: 'You can delete the files you downloaded.',
  notice: { title: 'Your Google Takeout is in', body: 'Calendar, 2011 to 2026' },
};

/**
 * @param {string} id
 * @param {Health} said
 * @returns {Need}
 */
const needOf = (id, said) => ({ ...said, line: said.line ?? null, streams: null, state: said.state === 'broken' ? 'broken' : 'needs-you', connector: TAKEOUT_KIND,
  copy: null, id, unit: null, at: null, weight: said.state === 'broken' ? 'stopped' : 'advice', banner: false, dismissed: false, kind: 'notice', about: null });
export const NEEDS = { broken: needOf(BROKEN_NEED, BROKEN.health), kept: needOf(REFUSED_NEED, KEPT.health),
  asked: needOf(`import:${ASKED.id}:whose`, ASKED.health), whole: needOf(WHOLE_NEED, REFUSED_WHOLE.health) };

/**
 * @param {string} line
 * @param {ImportHeld[]} held
 * @returns {Partial<ImportReport>}
 */
export const holding = (line, ...held) => ({ held, health: held[0].health, line });

/** @type {Record<string, ExportRow>} */
const FED = {
  'google-photos': { import: TAKEOUT_KIND, name: 'Google Takeout', icon: 'archive', opens: true, line: 'A download you make at Google' },
  google: { import: TAKEOUT_KIND, name: 'Google Takeout', icon: 'archive', opens: true, line: 'A download you make at Google' },
  gmail: { import: TAKEOUT_KIND, name: 'Google Takeout', icon: 'archive', opens: false, line: 'A download you make at Google' },
  spotify: { import: 'spotify', name: 'Spotify export', icon: 'listening', opens: false, line: 'A download you ask Spotify for' },
};
export const BROUGHT_ALONE = ['google-photos', 'google'];

/**
 * @param {ConnectorReport} connector
 * @returns {ConnectorReport}
 */
const fedStream = connector => ({ ...connector, export: FED[connector.id] ?? null,
  ...BROUGHT_ALONE.includes(connector.id) ? { type: IMPORTS, set_up: false, line: 'Comes with a Google Takeout',
    health: { ...connector.health, state: /** @type {const} */ ('setup'),
      acts: [{ do: /** @type {const} */ ('import'), label: 'Show', kind: TAKEOUT_KIND }] } } : {} });

/**
 * @param {{ takeout?: Partial<ImportReport>, spotify?: Partial<ImportReport>, backup?: Partial<ImportReport>, needs?: Need[] }} [patch]
 * @returns {StreamsReport}
 */
export const importsReport = ({ takeout = {}, spotify = {}, backup, needs = [] } = {}) => ({ ...REPORT,
  setup: { skipped: [], at: null, you: true },
  needs: [...REPORT.needs.filter(need => need.connector !== TAKEOUT_KIND && need.connector !== 'spotify'), ...needs],
  connectors: REPORT.connectors.map(fedStream),
  imports: [{ ...TAKEOUT, ...takeout }, { ...SPOTIFY, ...spotify }, ...backup ? [{ ...IPHONE_BACKUP, ...backup }] : []] });

/** @type {HostState} */
export const IMPORTS_STATE = HOST_STATE;

/** @typedef {{ name: string, kind: string, report: StreamsReport, state: HostState | null }} Scene */

/** @param {string} name @param {StreamsReport} report @param {HostState | null} [state] @param {string} [kind] @returns {Scene} */
const scene = (name, report, state = IMPORTS_STATE, kind = TAKEOUT_KIND) => ({ name, kind, report, state });

/** @type {Scene[]} */
export const SCENES = [
  scene('Nothing yet: what is read, how to get it, the drop zone', importsReport()),
  scene('A kind of one product: its reader\'s sentence', importsReport(), IMPORTS_STATE, 'spotify'),
  scene('Checking and sending on this Mac', importsReport({ takeout: { coming: SENDING_FILES, line: 'Sending · 1 of 3 files' } })),
  scene('Refused or not found on this Mac, and a file already in', importsReport({ takeout: { coming: REFUSED_FILES } })),
  scene('Whose it is, asked: the accounts and Another…', importsReport({ takeout: holding(ASKED.line, ASKED), needs: [NEEDS.asked] })),
  scene('Bringing in: per product, in its words', importsReport({ takeout: holding(READING.line, READING) })),
  scene('Waiting for room on the home', importsReport({ takeout: holding(NO_ROOM.line, NO_ROOM) })),
  scene('A read that broke, Skip it', importsReport({ takeout: holding(BROKEN.line, BROKEN), needs: [NEEDS.broken] })),
  scene('Refused whole: Skip it, its file Let go', importsReport({ takeout: holding(REFUSED_WHOLE.line, REFUSED_WHOLE),
    needs: [NEEDS.whole] })),
  scene('In, files kept: Let go and Skip it', importsReport({ takeout: holding('Brought in 20 Oct · 1 file couldn\'t be read', KEPT),
    needs: [NEEDS.kept] })),
  scene('In: what came, Open a day, the files may go', importsReport({ takeout: holding(BROUGHT, DONE) })),
  scene('Two imports, newest first', importsReport({ takeout: holding(BROUGHT, DONE, OLDER) })),
  scene('In a browser: the home\'s acts alone, the drop zone on the Mac', importsReport({ takeout: {
    ...holding(ASKED.line, ASKED, KEPT), coming: [...SENDING_FILES.slice(1, 2), ...REFUSED_FILES.slice(0, 2)] },
  needs: [NEEDS.asked, NEEDS.kept] }), null),
];

/** @param {string} day */
const noonOf = day => Date.parse(`${day}T12:00:00Z`);

/**
 * @param {string} id
 * @param {Partial<HostBackup>} [more]
 * @returns {HostBackup}
 */
const backup = (id, more = {}) => ({ id, name: 'Work iPhone', made_ms: noonOf('2026-08-28'),
  encrypted: true, finished: true, read: 'unread', in_ms: null, doing: null, done: 0, of: 0, why: null, need_bytes: null,
  left: [], ...more });

export const BACKUP_ROWS = {
  unread: backup('backup-a-20260828'),
  plain: backup('backup-b-20260302', { name: 'iPhone 15', made_ms: noonOf('2026-03-02'), encrypted: false }),
  making: backup('backup-c-20261116', { made_ms: noonOf('2026-11-16'), finished: false }),
  in: backup('backup-a-20260828', { read: 'in', in_ms: noonOf('2026-11-16') }),
  opening: backup('backup-a-20260828', { read: 'opening' }),
  messages: backup('backup-a-20260828', { read: 'reading', doing: 'iMessage' }),
  whatsapp: backup('backup-a-20260828', { read: 'reading', doing: 'WhatsApp', done: 41_000, of: 96_000 }),
  calls: backup('backup-a-20260828', { read: 'reading', doing: 'Calls' }),
  room: backup('backup-a-20260828', { read: 'reading', doing: 'WhatsApp', why: 'room', need_bytes: 14_000_000_000 }),
  home: backup('backup-a-20260828', { read: 'reading', doing: 'WhatsApp', why: 'home' }),
  sending: backup('backup-a-20260828', { read: 'sending', in_ms: noonOf('2026-11-16') }),
  remade: backup('backup-a-20260828', { read: 'stopped', why: 'remade' }),
  unreadable: backup('backup-a-20260828', { read: 'stopped', left: [{ store: 'WhatsApp', why: 'unreadable' }] }),
  partly: backup('backup-a-20260828', { read: 'in', in_ms: noonOf('2026-11-16'), left: [{ store: 'WhatsApp', why: 'unreadable' }] }),
  left: backup('backup-a-20260828', { read: 'in', in_ms: noonOf('2026-11-16'),
    left: [{ store: 'iMessage', why: 'lost' }, { store: 'WhatsApp', why: 'too-large' }, { store: 'Calls', why: 'lost' }] }),
  quit: backup('backup-a-20260828', { read: 'stopped' }),
};

export const BACKUP_COMING = [
  file('file-11', 'iMessage', 'waiting', 'Waiting its turn', ''),
  file('file-12', 'WhatsApp', 'sending', 'Sending', '4.1 GB of 11.8 GB'),
  file('file-13', 'Calls', 'waiting', 'Waiting its turn', ''),
];

/**
 * @param {HostBackups} backups
 * @returns {HostState}
 */
export const backupsState = backups => ({ ...IMPORTS_STATE, backups });
/** @param {HostBackup[]} rows */
const listed = (...rows) => backupsState({ state: 'listed', rows });

const PHONE = '+15550000001';
/** @type {ImportHeld[]} */
export const BACKUP_HELD = [
  { id: 'b000000000000001', account: PERSON_A, made_at: '2026-08-28T12:00:00.000Z', name: 'Work iPhone · backup of 28 Aug',
    health: health('syncing'), line: 'Bringing in', ask: null, files: [],
    products: [{ id: 'imessage', name: 'iMessage', state: 'reading', count: 16475, line: 'iMessage · 16,475 messages' },
      { id: 'apple-calls', name: 'Calls', state: 'reading', count: 1876, line: 'Calls · 1,876 calls' }],
    span: null, open_day: null, open: null, downloaded: null, notice: null },
  { id: 'b000000000000002', account: PHONE, made_at: '2026-08-28T12:00:00.000Z', name: 'Work iPhone · backup of 28 Aug',
    health: health('ok'), line: 'In · 2014–2026', ask: null, files: [],
    products: [{ id: 'whatsapp', name: 'WhatsApp', state: 'read', count: 2739513, line: 'WhatsApp · 2,739,513 messages' }],
    span: { from: '2014-01-01', to: '2026-08-28' }, open_day: '2019-03-14', open: 'Open a day', downloaded: null, notice: null },
];

const WHICH = 'Which iPhone is this backup from?';
/** @type {ImportHeld[]} */
export const BACKUP_ASKED = [PERSON_A, PHONE].map((account, at) => ({ id: `b00000000000000${at + 3}`, account,
  made_at: '2026-08-28T12:00:00.000Z', name: 'iPhone 17 Pro · backup of 28 Aug',
  health: health('needs-you', { reason: 'choose', words: WHICH, line: 'Your iPhone backup',
    acts: [{ do: 'import', label: 'Choose', kind: 'iphone-backup' }] }),
  line: WHICH, ask: null, files: [], products: [], span: null, open_day: null, open: null, downloaded: null, notice: null }));

/** @type {ImportWhich} */
export const BACKUP_WHICH = {
  need: `import:${BACKUP_ASKED[0].id}:which`, words: WHICH, line: 'iPhone 17 Pro · 28 Aug 2026',
  imports: BACKUP_ASKED.map(held => held.id), choose: 'Choose',
  choices: [
    { unit: 'iphone-17-pro-aa01', words: 'iPhone 17 Pro', line: 'WhatsApp and iMessage already here from this phone' },
    { unit: 'iphone-17-pro-aa02', words: 'iPhone 17 Pro', line: 'last heard from 14 Nov' },
    { unit: 'iphone-15-aa03', words: 'iPhone 15', line: 'removed' },
    { unit: 'new', words: 'An iPhone not set up with Lifestream', line: '' },
  ],
};

export const WHICH_SCENE = {
  backup: { ...holding(WHICH, ...BACKUP_ASKED), which: [BACKUP_WHICH] },
  needs: [{ ...needOf(BACKUP_WHICH.need, BACKUP_ASKED[0].health), connector: 'iphone-backup' }],
};

/** @type {Scene[]} */
export const BACKUP_SCENES = [
  scene('Backups on this Mac: unread, not encrypted, being made, read before', importsReport({ backup: {} }),
    listed(BACKUP_ROWS.making, BACKUP_ROWS.in, BACKUP_ROWS.plain), 'iphone-backup'),
  scene('Read it', importsReport({ backup: {} }), listed(BACKUP_ROWS.unread), 'iphone-backup'),
  scene('Opening, then reading each store', importsReport({ backup: {} }),
    listed(BACKUP_ROWS.opening, BACKUP_ROWS.messages, BACKUP_ROWS.whatsapp, BACKUP_ROWS.calls), 'iphone-backup'),
  scene('Waiting for room on this Mac, then for the home', importsReport({ backup: {} }), listed(BACKUP_ROWS.room, BACKUP_ROWS.home),
    'iphone-backup'),
  scene('Sending: each store by its words', importsReport({ backup: { coming: BACKUP_COMING } }), listed(BACKUP_ROWS.sending),
    'iphone-backup'),
  scene('What can go wrong: remade, a store unread, stores left out, a quit', importsReport({ backup: {} }),
    listed(BACKUP_ROWS.remade, BACKUP_ROWS.unreadable, BACKUP_ROWS.partly, BACKUP_ROWS.left, BACKUP_ROWS.quit), 'iphone-backup'),
  scene('Brought in: its imports below, in the road\'s words', importsReport({ backup: holding('Bringing in', ...BACKUP_HELD) }),
    listed(BACKUP_ROWS.in), 'iphone-backup'),
  scene('Which iPhone is this backup from?, once above its imports', importsReport(WHICH_SCENE), listed(BACKUP_ROWS.in),
    'iphone-backup'),
  scene('No backup on this Mac yet', importsReport({ backup: {} }), backupsState({ state: 'none', rows: [] }), 'iphone-backup'),
  scene('This Mac can\'t see the backups', importsReport({ backup: {} }), backupsState({ state: 'no-access', rows: [] }), 'iphone-backup'),
  scene('Another Mac: On your Mac', importsReport({ backup: holding('Bringing in', ...BACKUP_HELD) }), IMPORTS_STATE, 'iphone-backup'),
  scene('In a browser: On your Mac', importsReport({ backup: holding('Bringing in', ...BACKUP_HELD) }), null, 'iphone-backup'),
];
