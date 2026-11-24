// @ts-check
/** @import { StreamsReport } from './types.js' */
/** @import { HostState } from './lib/host.js' */
import FIXTURE from '../../homelink/Tests/Fixtures/report.json' with { type: 'json' };
import { subscriptionOf } from './lib/host.js';
import { STATES } from './kit-gallery-reach.js';

export const REPORT = /** @type {StreamsReport} */ (/** @type {unknown} */ (FIXTURE));
export const AT = REPORT.at_ms;

/** @type {HostState} */
export const HOST_STATE = {
  inset: { left: 78, centre: 20 },
  recorder: { signal: 'engaged', words: 'Recording' },
  reach: STATES.answering,
  sending: null,
  grants: [
    { id: 'screenRecording', title: 'Screen Recording', why: 'What is on your screen, every two seconds.', granted: true,
      optional: false, asking: false, denied: false },
    { id: 'accessibility', title: 'Accessibility', why: 'Which window and page is in front, and its text.',
      granted: true, optional: false, asking: false, denied: false },
    { id: 'microphone', title: 'Microphone', why: 'The microphone, while another app is using it.',
      granted: true, optional: false, asking: false, denied: false },
    { id: 'systemAudio', title: 'System Audio Recording', why: 'What this Mac plays while the microphone is in use.',
      granted: false, optional: false, asking: false, denied: false },
    { id: 'fullDiskAccess', title: 'Full Disk Access', why: 'Your messages, notes, calls and other apps’ history.',
      granted: false, optional: false, asking: false, denied: false },
    { id: 'bluetooth', title: 'Bluetooth', why: 'When a Bluetooth device connects and disconnects.',
      granted: false, optional: true, asking: false, denied: false },
  ],
  needs: [
    { id: 'update', line: 'Lifestream could not update its home',
      detail: 'Lifestream keeps running the release it has. What the install said: the self-check refused.',
      acts: [{ id: 'try-again', label: 'Try again', tone: 'warning' }], home: false },
    { id: REPORT.needs[0].id, line: REPORT.needs[0].words, detail: null, acts: [], home: true },
    ...REPORT.needs.filter(need => need.reason === 'password').map(need => ({ id: need.id, line: need.words, detail: null,
      acts: need.acts.filter(act => act.do === 'set').map(act => ({ id: 'do', label: act.label, tone: /** @type {const} */ ('caution') })), home: true })),
  ],
  update: null,
  folder: '/Users/Shared/Lifestream',
  unit: 'macbook-pro-0001',
  signins: ['key', 'device', 'client'],
  browsers: [],
  pairing: null,
  phone_app: null,
  ask_login: {
    chatgpt: subscriptionOf({ state: 'signed_in', account: 'person-a@example.com', plan: 'plus' }),
    claude: subscriptionOf({ state: 'absent' }) },
  connect_requests: null,
  placement: null,
  machine: null,
  account_name: null,
  setup: { state: 'idle', error: null, waiting: null, key: null },
  vault: { state: 'saved', saved_ms: null },
  apps: { private_windows: true, offered: [
    { id: 'com.example.vault', name: 'Vault', icon: 'lifestream-app://icon/com.example.vault', suggested: true },
    { id: 'com.example.keys', name: 'Keys', icon: 'lifestream-app://icon/com.example.keys', suggested: true },
    { id: 'com.apple.keychainaccess', name: 'Keychain Access', icon: 'lifestream-app://icon/com.apple.keychainaccess', suggested: true },
    { id: 'com.example.chat', name: 'Chat App', icon: 'lifestream-app://icon/com.example.chat', suggested: false },
    { id: 'com.example.notes', name: 'Notes App', icon: 'lifestream-app://icon/com.example.notes', suggested: false },
  ] },
  agent_requests: [],
  agent_asks: [],
  general: { login: true, auto_update: true, version: '2026.11.10', update: null, by_hand: null },
};
