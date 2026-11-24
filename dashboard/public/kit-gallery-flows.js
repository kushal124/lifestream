// @ts-check
/** @import { HostState } from './lib/host.js' */
/** @import { ConnectorReport, StreamsReport } from './types.js' */
/** @import { FlowId, FlowSession, Seen } from './ui/flows/model.js' */
import { subscriptionOf } from './lib/host.js';
import { esc } from './lib/html.js';
import { sectionLabel } from './ui/kit/index.js';
import { detailOf, OPENED } from './ui/connectors/dialog.js';
import { AT_REST } from './ui/connectors/view.js';
import { detailMarkup } from './ui/connectors/detail.js';
import { AT, HOST_STATE, REPORT } from './kit-gallery-report.js';
import { flowOf, KNOCK_MS, sessionOf } from './ui/flows/model.js';
import { flowDialog } from './ui/flows/view.js';

const MIN = 60_000;
const LATER = AT + 10 * 365 * 86_400_000;

export const PAIR_QR = 'data:image/png;base64,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';

/** @param {string} label @param {string} html */
const specimen = (label, html) => `<div class="gallery__specimen"><p class="gallery__label mac-mono-label">${esc(label)}</p>${html}</div>`;
/** @param {string} name @param {string} body */
const group = (name, body) => `<section class="gallery__group">${sectionLabel(name)}${body}</section>`;

/** @typedef {Partial<Omit<FlowSession, 'busy' | 'hosted' | 'frame'>> & { busy?: string[] }} Did */

/**
 * @param {'step' | 'dialog'} frame
 * @param {Did} did
 * @param {boolean} [hosted]
 */
function sessionFor(frame, { busy = [], ...did }, hosted = true) {
  const session = { ...sessionOf(hosted, frame), ...did };
  for (const key of busy) session.busy.add(key);
  return session;
}

/**
 * @param {FlowId} id
 * @param {Seen} seen
 * @param {Did} did
 * @param {{ back?: string, now?: number, hosted?: boolean }} [more]
 */
const dialog = (id, seen, did, { back = '', now = AT, hosted = true } = {}) => `<div class="gallery__dialog">${
  flowDialog(flowOf(id, seen, sessionFor('dialog', did, hosted), now), { back })}</div>`;

/**
 * @param {string} label
 * @param {FlowId} id
 * @param {Seen} seen
 * @param {{ did?: Did, dialog?: Did | null, back?: string, now?: number }} [more]
 */
function both(label, id, seen, { did = {}, dialog: own = did, back = '', now = AT } = {}) {
  return specimen(label, '<div class="gallery__frames">' + (own ? dialog(id, seen, own, { back, now }) : '') + '</div>');
}

/** @param {Partial<HostState>} state @param {StreamsReport | null} [report] @returns {Seen} */
const seenOf = (state, report = REPORT) => ({ state: { ...HOST_STATE, needs: [], ...state }, report });


/** @param {NonNullable<HostState['vault']>['state']} state @param {number | null} [saved] */
const vault = (state, saved = null) => ({ vault: { state, saved_ms: saved } });
/** @param {Partial<HostState>} state */
const vaultSeen = state => seenOf(state);

const VAULT = () => group('Flows · the vault: Your vault, Create opens the app’s Recovery key window, kept, as the Accounts step and in a dialog', '<div class="gallery__stack">' + [
  both('To make: Your vault, Create', 'vault', vaultSeen(vault('none'))),
  both('Create pressed: busy until the app opens its window', 'vault', vaultSeen(vault('none')),
    { did: { busy: ['vault-open'] } }),
  both('Made and never kept: Create again', 'vault', vaultSeen(vault('unsaved'))),
  both('Locked on this Mac: Unlock opens the window on its Allow or Lost face', 'vault', vaultSeen(vault('locked'))),
  both('The app refused: its words in the line', 'vault', vaultSeen(vault('none')),
    { did: { failure: { key: 'vault-open', words: 'Lifestream couldn’t open the window.' } } }),
  both('Kept, however it was kept: Your vault, Kept; the dialog holds and offers Done', 'vault',
    vaultSeen(vault('saved', AT))),
  both('From an account’s To connect: its line names the account; back to it', 'vault', vaultSeen(vault('none')),
    { dialog: { then: 'gmail' }, back: 'Back to Gmail' }),
].join('') + '</div>');


/**
 * @param {import('./lib/host.js').HostSubscription['state']} state
 * @param {Partial<import('./lib/host.js').HostSubscription>} [said]
 */
const plan = (state, said = {}) => subscriptionOf({ state, ...said });
/** @param {Partial<import('./lib/host.js').HostAskLogin>} login */
const login = login => seenOf({ ask_login: { chatgpt: plan('absent'), claude: plan('absent'), ...login } });
const CODE = plan('signing_in', { attempt: 'login-1', code: 'QX4F-7KD2', url: 'https://auth.example.com/device' });
const ANTHROPIC = plan('signing_in', { attempt: '0f3a9c2e7b1d4a60', url: 'https://claude.example.com/oauth/authorize' });

/**
 * @param {string} label
 * @param {Seen} seen
 * @param {Did} [did]
 */
const stepped = (label, seen, did = {}) => specimen(label, `<div class="gallery__frames">${dialog('model', seen, did)}</div>`);

const MODEL = () => group('Flows · a model: a ChatGPT or Claude plan', '<div class="gallery__stack">' + [
  stepped('None yet', login({})),
  stepped('Connect pressed: busy until the home answers', login({}), { busy: ['connect:claude'] }),
  stepped('Downloading each maker’s program, its share in its line, no act',
    login({ chatgpt: plan('fetching', { bytes: 120_000_000, total: 347_000_000 }), claude: plan('fetching', { bytes: 120_000_000, total: 324_000_000 }) })),
  stepped('Downloaded, not signed in: Sign in', login({ chatgpt: plan('signed_out'), claude: plan('signed_out') })),
  stepped('ChatGPT’s code, with its copy button; Open page opens OpenAI’s page', login({ chatgpt: CODE })),
  stepped('Claude: approve on Anthropic’s page, or type the code it shows here', login({ claude: ANTHROPIC })),
  stepped('A code typed for Claude', login({ claude: ANTHROPIC }), { code: 'synthetic-code#synthetic-state' }),
  stepped('The code ran out: why in its line, Try again', login({ chatgpt: plan('failed', { why: 'This code ran out.' }) })),
  stepped('A download that failed: why in its line, Try again', login({ claude: plan('failed', { why: 'This Mac is offline.' }) })),
  stepped('Signed in to both: the account, and Claude’s plan', login({
    chatgpt: plan('signed_in', { account: 'person-a@example.com', plan: 'plus' }),
    claude: plan('signed_in', { account: 'person-a@example.com', plan: 'max' }) })),
  specimen('In a browser: every act rests and says where it is taken', `<div class="gallery__frames">${
    dialog('model', login({}), {}, { hosted: false })}</div>`),
].join('') + '</div>');


const PAIRING = { pairing: { link: 'lifestream://pair?code=ABCD2345', code: 'ABCD2345', qr: PAIR_QR, why: null, match: '4F7K',
  expires_ms: LATER }, phone_app: { link: 'https://testflight.example.com/join/AAAA0000', qr: PAIR_QR } };
/** @type {StreamsReport} */
const NONE = { ...REPORT, devices: REPORT.devices.filter(device => device.kind !== 'phone') };
const UNIT = /** @type {string} */ (REPORT.devices.find(device => device.kind === 'phone' && device.pass !== null)?.unit);

const PHONE = () => group('Flows · the iPhone: its two parts, then each phone paired', '<div class="gallery__stack">' + [
  both('No phone yet: it opens at the code to scan, what to type and what to check, Get the app above the code', 'phone',
    seenOf(PAIRING, NONE)),
  both('Get the app pressed: the app from TestFlight in the code’s place, I have the app back to the code', 'phone',
    seenOf(PAIRING, NONE), { did: { part: 'app' } }),
  both('No TestFlight code from the app: part 2 alone, unnumbered', 'phone', seenOf({ ...PAIRING, phone_app: null }, NONE)),
  both('This Mac can’t listen: the app’s words in the code’s place', 'phone', seenOf({ ...PAIRING,
    pairing: { ...PAIRING.pairing, link: null, code: null, qr: null, why: 'Lifestream can’t open its Wi-Fi connection.' } }, NONE),
    { did: { part: 'pair' } }),
  both('Paired since it opened: the phone’s head, Paired at its right, its streams as tiles as the home’s phone ways '
    + 'say them, one waiting on the person in the home’s words; Pair another iPhone in the foot; the dialog holds',
  'phone', seenOf(PAIRING), { dialog: { before: new Set() } }),
  both('Pair another iPhone pressed: part 2 again under the phones', 'phone', seenOf(PAIRING),
    { did: { another: new Set(), part: 'pair' }, dialog: { another: new Set(), before: new Set(), part: 'pair' } }),
  both('From Lifestream, a phone already paired: the code alone, the paired one no news here', 'phone', seenOf(PAIRING),
    { dialog: { before: new Set([UNIT]) } }),
].join('') + '</div>');


const CHROME = { id: 'chrome', name: 'Chrome', profiles: [{ id: 'Default', name: 'Person A' }] };
const ARC = { id: 'arc', name: 'Arc', profiles: [{ id: 'Default', name: 'Person A' }] };
/**
 * @param {boolean} present
 * @param {Partial<ConnectorReport>} [patch]
 * @returns {StreamsReport}
 */
const extension = (present, patch = {}) => ({ ...REPORT,
  connectors: REPORT.connectors.map(each => each.roads.includes('chrome') ? { ...each, ...patch } : each),
  extension: { ...REPORT.extension, present, browsers: present ? REPORT.extension.browsers : [] } });
/** @param {Partial<HostState>} state @param {StreamsReport} report */
const browserSeen = (state, report) => seenOf({ browsers: [ARC, CHROME], ...state }, report);
const ASKING = { connect_requests: [{ id: 'request-1', browser: 'Arc' }] };
const WAITING = extension(false, { chosen: false, signed_in: null, checking: false, browser: null });
/** @param {Partial<ConnectorReport>} patch */
const LOOKED = patch => extension(true, { chosen: false, checking: false, ...patch });

const BROWSER = () => group('Flows · the browser extension: the extension, then its sites', '<div class="gallery__stack">' + [
  both('No Chrome-family browser on this Mac', 'browser', browserSeen({ browsers: [] }, WAITING)),
  both('One browser: Add to Chrome; the sites wait for it', 'browser', browserSeen({ browsers: [CHROME] }, WAITING)),
  both('Two browsers: which one, a menu beside its name', 'browser', browserSeen({}, WAITING)),
  both('Arc asks to connect: a dialog over the step; in a dialog, the items’ place, its answers in the foot', 'browser',
    browserSeen(ASKING, WAITING)),
  both('Put away unanswered: the request stands, the extension’s Allow Arc asks it again', 'browser', browserSeen(ASKING, WAITING),
    { did: { closed: new Set(['Arc']) } }),
  both('Connected: Added; each site’s sign-in first looked at, its control the working face', 'browser',
    browserSeen({}, LOOKED({ signed_in: null, checking: true }))),
  both('Its sites signed in: Connect, which chooses each; nothing read before', 'browser',
    browserSeen({}, LOOKED({ signed_in: true }))),
  both('Its sites not signed in: Sign in opens each', 'browser', browserSeen({}, LOOKED({ signed_in: false }))),
  both('The look could not tell: said so, and Sign in opens the site', 'browser', browserSeen({}, LOOKED({ signed_in: null }))),
  both('Its sites connected: the dialog says so over its panel, and holds', 'browser', browserSeen({}, REPORT)),
  both('Opened from Arc’s knock: it waits for the next', 'browser', browserSeen({}, WAITING),
    { dialog: { knock: { at: AT, since: AT - 4 * MIN, browser: 'Arc' } } }),
  both('No knock came: where to ask again', 'browser', browserSeen({}, WAITING),
    { dialog: { knock: { at: AT - KNOCK_MS, since: AT - 4 * MIN, browser: 'Arc' } } }),
  both('The knock’s request: since when it has been asking', 'browser', browserSeen(ASKING, WAITING),
    { dialog: { knock: { at: AT, since: AT - 4 * MIN, browser: 'Arc' } } }),
  both('Opened before the report is read: the extension’s row as it is, its sites’ skeletons', 'browser',
    browserSeen({}, /** @type {any} */ (null))),
].join('') + '</div>');


/**
 * @param {Partial<HostState>} [state]
 * @param {string[]} [ungranted]
 */
const macOf = (state = {}, ungranted = []) => ({ ...HOST_STATE, needs: [], ...state,
  grants: HOST_STATE.grants.map(grant => ({ ...grant, granted: !grant.optional && !ungranted.includes(grant.id) })) });

/** @type {StreamsReport} */
const SIGNED_OUT = { ...REPORT, connectors: REPORT.connectors.map(each => each.id !== 'gmail' ? each : { ...each,
  health: { ...each.health, state: 'needs-you', reason: 'signed-out', words: 'Sign in to Gmail again',
    acts: [{ do: 'signin', label: 'Sign in', of: 'gmail-imap' }] } }) };

/**
 * @param {HostState | null} state
 * @param {string} id
 * @param {{ pages?: string[], report?: StreamsReport }} [more]
 */
const toConnect = (state, id, { pages = [], report = REPORT } = {}) => {
  const detail = detailOf(report, state, id, { ...OPENED, pages });
  return detail ? `<div class="gallery__dialog">${detailMarkup(detail, AT_REST)}</div>` : '';
};
/** @param {string} label @param {string} html */
const one = (label, html) => specimen(label, `<div class="gallery__dialogs">${html}</div>`);

const CONNECT = () => group('To connect · each way and requirement as the home sends it, in its dialog',
  '<div class="gallery__stack">' + [
    one('A sign-in, no vault yet: Create vault first, then the account', toConnect(macOf(vault('none')), 'granola')),
    one('Its key made and never kept: Show a new key', toConnect(macOf(vault('unsaved')), 'granola')),
    one('The vault locked on this Mac: its need’s Allow', toConnect(macOf(vault('locked')), 'granola')),
    one('The vault ready: Sign in, the route’s sheet; two routes, the choice its page',
      toConnect(macOf(vault('saved')), 'granola') + toConnect(macOf(vault('saved')), 'granola', { pages: ['signin'] })),
    one('One route drawn by this Mac: its sheet from Sign in', toConnect(macOf({ ...vault('saved'), signins: ['key'] }), 'granola')),
    one('Signed in once, signed out since: Sign in again', toConnect(macOf(vault('saved')), 'gmail', { report: SIGNED_OUT })),
    one('Two ways: this Mac’s, ready, and a file’s Upload; a stream on in Chrome',
      toConnect(macOf(), 'whatsapp') + toConnect(macOf(), 'claude')),
    one('A phone’s grant: the home’s words, no button here', toConnect(macOf(), 'apple-photos') + toConnect(macOf(), 'location')),
    one('Turned off; a labeler installed', toConnect(macOf(), 'spotify') + toConnect(macOf(), 'faces')),
    one('In a browser: every row, no act, and where it is done', toConnect(null, 'granola') + toConnect(null, 'claude')),
  ].join('') + '</div>');

export const flows = () => [VAULT(), MODEL(), PHONE(), BROWSER(), CONNECT()].join('');
