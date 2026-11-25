// @ts-check
/** @import { ConnectorReport, Made, MemberState, ModelFile, ModelsRead, Processing, Step, StreamsReport } from './types.js' */
import FIXTURE_MADE from '../../homelink/Tests/Fixtures/made.json' with { type: 'json' };
import FIXTURE_MODELS from '../../homelink/Tests/Fixtures/models.json' with { type: 'json' };
import { REPORT } from './kit-gallery-report.js';

/** @param {string} value @param {string} words @param {string | null} [note] @returns {Step} */
const step = (value, words, note = null) => ({ value, words, note });

const HOME_MODELS = /** @type {ModelsRead} */ (/** @type {unknown} */ (FIXTURE_MODELS));

const [OFF, PRICED, PLAN, LOCAL] = HOME_MODELS.defaults.pictures.steps;
const PARAKEET = HOME_MODELS.defaults.audio.steps[2];

const NEW = REPORT.day;
const MONTH = '2026-09-28';
const YEAR = '2025-10-28';

const ON_MAC = HOME_MODELS.runners[0].name;
const PLANNED = `${PLAN.words} · Anthropic`;
const QWEN = `${LOCAL.words} · ${ON_MAC}`;

const RANGE_ROW = /** @type {const} */ ({ member: 'llm.range', shape: null, line: null, privacy: null });

/**
 * @param {string} work
 * @param {string} label
 * @param {string} about
 * @param {string} value
 * @param {string} words
 * @param {string} named
 * @param {Step[]} routes
 * @param {MemberState['waiting']} [waiting]
 * @returns {MemberState}
 */
const workMember = (work, label, about, value, words, named, routes, waiting = []) => ({ key: `llm.${work}`, kind: 'choice',
  label, about, value, words, from: value === 'default' ? 'declaration' : 'person', default: null,
  steps: [step('off', 'Off'), step('default', 'Default', named), ...routes], panel: null, control: 'menu', where: null, ...waiting.length ? { waiting } : {} });

/**
 * @param {string | null} value
 * @param {string} words
 * @param {[string, string, string]} notes
 * @returns {MemberState}
 */
const rangeMember = (value, words, [month, year, all]) => ({ key: 'llm.range', kind: 'choice', label: 'Range', about: 'How far back a model reads this stream\'s items.',
  value, words, from: value === null ? 'unset' : 'person', default: null, panel: null, control: 'menu', where: null,
  steps: [step(NEW, 'New only', 'Nothing from before'), step(MONTH, 'Last 30 days', month), step(YEAR, 'Last year', year),
    step('all', 'All time', all)] });

const ABOUT = {
  libraryPhotos: 'A model writes a short description of each photo, so you can search your photos by what is in them.',
  mail: 'A model reads each email, and writes one line for each automated one: what it is and what it says.',
  aiChats: 'A model shortens very long messages in your AI chats to a line or two. Short ones are shown as written.',
};

/** @param {string} id */
const homePart = id => {
  const connector = /** @type {ConnectorReport} */ (REPORT.connectors.find(each => each.id === id));
  const processing = /** @type {Processing} */ (connector.processing);
  return { members: connector.members.filter(member => member.key.startsWith('llm.')),
    processing: { rows: [...processing.rows.filter(row => row.shape !== null), RANGE_ROW] } };
};

/** @type {Record<string, { members: MemberState[], processing: Processing }>} */
export const PARTS = {
  whatsapp: homePart('whatsapp'),
  gmail: { members: [
    workMember('mail', 'Email summaries', ABOUT.mail, 'default', QWEN, LOCAL.words, [LOCAL, PRICED, PLAN]),
    rangeMember(NEW, 'New only', ['1,830 emails', '21,406 emails', '64,212 emails'])],
  processing: { rows: [{ member: 'llm.mail', shape: 'done', line: 'Up to date · 5 could not be processed', privacy: null }, RANGE_ROW] } },
  chatgpt: { members: [
    workMember('chats', 'Chat summaries', ABOUT.aiChats, 'off', 'Off', LOCAL.words, [LOCAL, PRICED, PLAN]),
    rangeMember('all', 'All time', ['412 messages', '3,980 messages', '9,115 messages'])],
  processing: { rows: [{ member: 'llm.chats', shape: 'off', line: null, privacy: null }, RANGE_ROW] } },
  claude: { members: [
    workMember('chats', 'Chat summaries', ABOUT.aiChats, PLAN.value, PLANNED, LOCAL.words, [LOCAL, PRICED, PLAN],
      [{ name: ON_MAC, kind: 'mac', line: `Waiting for ${ON_MAC} to take the change` }]),
    rangeMember(YEAR, 'Last year', ['208 messages', '2,214 messages', '2,960 messages'])],
  processing: { rows: [{ member: 'llm.chats', shape: 'waiting', line: /** @type {string} */ (PLAN.note), privacy: null }, RANGE_ROW] } },
  'apple-photos': { members: [
    workMember('photos', 'Photo descriptions', ABOUT.libraryPhotos, LOCAL.value, QWEN, PRICED.words, [LOCAL, PRICED, PLAN]),
    rangeMember('2026-01-01', '1 Jan 2026', ['640 photos', '7,310 photos', '31,577 photos'])],
  processing: { rows: [{ member: 'llm.photos', shape: 'done', line: 'Up to date', privacy: null }, RANGE_ROW] } },
  screen: homePart('screen'),
};

const BACKFILL_ABOUT = /** @type {Record<string, string>} */ ({
  whatsapp: 'Your chats from before Lifestream, read from your phone’s own backup.',
  'apple-photos': 'Every photo already in your library, read once, oldest last.',
});

/** @type {StreamsReport} */
export const LLM_REPORT = { ...REPORT, connectors: REPORT.connectors.map(/** @returns {ConnectorReport} */ each => ({ ...each,
  members: [...each.members.filter(member => !member.key.startsWith('llm.')), ...PARTS[each.id]?.members ?? []],
  processing: PARTS[each.id]?.processing ?? null, backfill_about: BACKFILL_ABOUT[each.id] ?? null })) };

export const SHAPED = ['whatsapp', 'gmail', 'chatgpt', 'claude', 'apple-photos', 'screen'];

export const LONGEST = 'whatsapp';

const HOME_RUNNER = HOME_MODELS.runners[0];

/** @type {Record<string, ModelFile>} */
const FILES = Object.fromEntries(HOME_RUNNER.files.map(({ id, name, about, state, line, suggested, fits }) =>
  [id, { id, name, about, state, line, suggested, fits }]));

const [QWEN_FILE, PARAKEET_FILE, NEMOTRON_FILE] = HOME_RUNNER.files.map(file => file.id);

/**
 * @param {string} id
 * @param {Partial<ModelFile>} said
 * @returns {ModelFile}
 */
const fileOf = (id, said) => ({ ...FILES[id], ...said });

/** @type {ModelsRead} */
export const MODELS = {
  ...HOME_MODELS,
  runners: [
    { ...HOME_RUNNER, files: HOME_RUNNER.files.map(file => FILES[file.id]) },
    { unit: 'runner-mac-mini-bb17', name: 'Mac mini', line: null, paused: 'Paused by you · since 14:02', battery: null, files: [
      fileOf(QWEN_FILE, { state: 'failed', line: 'The download stopped: this Mac has 2 GB free.' }),
    ] },
    { unit: 'runner-imac-cc31', name: 'iMac', line: 'iMac\'s runner is not running', paused: null, battery: null, files: [] },
  ],
};

/**
 * @param {{ on: boolean, held: string | null }} battery
 * @returns {ModelsRead}
 */
const withBattery = battery => ({ ...MODELS, runners: MODELS.runners.map((runner, at) => at === 0 ? { ...runner, battery } : runner) });
export const ON_BATTERY = withBattery({ on: true, held: 'On battery · older items wait until it\'s plugged in' });
export const BATTERY_SPENT = withBattery({ on: false, held: null });

/** @type {ModelsRead} */
export const MODELS_BARE = {
  defaults: { pictures: { value: OFF.value, words: OFF.words, steps: [OFF] },
    audio: { value: OFF.value, words: OFF.words, steps: [OFF] },
    text: { value: null, words: HOME_MODELS.defaults.text.words, steps: [] } },
  runners: [{ ...HOME_RUNNER, files: [
    fileOf(QWEN_FILE, { state: 'absent', line: FILES[NEMOTRON_FILE].line, suggested: true }),
    fileOf(PARAKEET_FILE, { state: 'absent', line: FILES[NEMOTRON_FILE].line, suggested: true }),
    fileOf(NEMOTRON_FILE, { suggested: true }),
  ] }],
  openrouter: { connected: false },
  cloudflare: { connected: false },
  address: null,
};

const ASKED = { family: 'photos', item: 'sha256:viewer-0', prompt: 'describe-photo@3' };
const HEARD = { family: 'voice', item: 'whatsapp:synthetic/msg/v1', prompt: 'transcribe-voice@2' };

const MADE = /** @type {Record<string, Made>} */ ({ ...FIXTURE_MADE, done: { ...FIXTURE_MADE.done, line: 'Vision One · 9 Nov' } });

/**
 * @param {NonNullable<Made['ask']>} ask
 * @param {Step} other
 * @returns {Record<string, Made>}
 */
const madeOf = (ask, other) => ({
  ...Object.fromEntries(Object.entries(MADE).map(([state, made]) => [state, { ...made, ask: made.ask && ask }])),
  again: { ...MADE.done, ask, choose: [other] },
});

export const DESCRIBED = madeOf(ASKED, LOCAL);

export const TRANSCRIBED = madeOf(HEARD, { ...PARAKEET, note: LOCAL.note });

/** @type {Step} */
export const RANGE_STEP = { value: '2024-03-03', words: 'Back to 3 Mar 2024', note: '12,400 photos · about $34' };

export const LONGEST_VALUE = PLANNED;

/**
 * @param {import('./lib/host.js').HostSubscription['state']} state
 * @param {Partial<import('./lib/host.js').HostSubscription>} [said]
 * @returns {import('./lib/host.js').HostSubscription}
 */
const subscription = (state, said = {}) => ({ state, bytes: null, total: null, attempt: null, url: null, code: null,
  account: null, plan: null, why: null, ...said });

export const SUBSCRIBED = /** @type {Record<string, import('./lib/host.js').HostAskLogin>} */ ({
  none: { chatgpt: subscription('absent'), claude: subscription('absent') },
  mixed: { chatgpt: subscription('fetching', { bytes: 120_000_000, total: 347_000_000 }),
    claude: subscription('signed_in', { account: 'person-a@example.com', plan: 'max' }) },
  signing: { chatgpt: subscription('signing_in', { attempt: 'login-1', code: 'QX4F-7KD2', url: 'https://auth.example.com/device' }),
    claude: subscription('signing_in', { attempt: '0f3a9c2e7b1d4a60', url: 'https://claude.example.com/oauth/authorize' }) },
  failed: { chatgpt: subscription('signed_out'), claude: subscription('failed', { why: 'Claude sign-in didn’t finish.' }) },
});
