// @ts-check
/** @import { Camera, CameraWord } from '../../lib/where.js' */
import { esc } from '../../lib/html.js';
import { count, counted, shiftDay } from '../../lib/words.js';
import { dayWords, notMine, whyWords, wordWords, yearsOf } from '../../lib/where.js';
import {
  button, choiceRows, dialog, emptyState, inPlaceLine, picture, settingRow, settingsSection, settingTile, textField, toggle,
} from '../kit/index.js';
import { editNote } from './place.js';

/** @typedef {{ camera: string, why: '' | 'stopped' | 'never', when: '' | 'last' | 'day', stopped: string, first: string, last: string }} Removal */

/**
 * @param {object} view
 * @param {Camera[] | null} view.cameras
 * @param {string | null} view.source
 * @param {string} view.failed
 * @param {Map<string, CameraWord>} view.sending
 * @param {Map<string, boolean>} view.yours
 * @param {string} view.refused
 */
export function camerasDialog({ cameras, source, sending, yours, refused, failed }) {
  const retry = failed ? inPlaceLine(failed, { retry: { 'data-pl-cameras-again': '' } }) : '';
  if (cameras === null) {
    return dialog({ icon: 'photos', title: 'Cameras', line: LINE, body: retry, close: { 'data-pl-close': '' } });
  }
  const missing = source ? '' : editNote({
    text: 'Lifestream has no devices source yet, so your word cannot be saved. The dashboard’s README says how to '
      + 'add it.',
    error: true,
  });
  const byPhotos = (/** @type {Camera} */ a, /** @type {Camera} */ b) => b.photos - a.photos;
  const isYours = (/** @type {Camera} */ camera) => yours.get(camera.camera) ?? camera.mine;
  /** @param {string} heading @param {Camera[]} part @param {string} [line] */
  const part = (heading, part, line = '') => settingsSection({ heading, line, attrs: { class: 'pl-cameras' },
    rows: part.sort(byPhotos).map(camera => cameraRow(camera, { sending: sending.get(camera.camera) })) });
  const body = cameras.length
    ? part('Yours', cameras.filter(isYours), RULE) + part('Not yours', cameras.filter(camera => !isYours(camera)))
    : emptyState('photo', 'No camera yet.', { detail: 'Lifestream lists the cameras once your photos are read.' });
  return dialog({
    icon: 'photos', title: 'Cameras', line: LINE,
    body: missing + retry + editNote(refused ? { text: refused, error: true } : null) + body,
    close: { 'data-pl-close': '' },
  });
}

const LINE = 'Only photos from your own cameras count towards where you were.';
const RULE = 'A camera with 50 photos or more, or a paired phone’s own, until you say otherwise.';

/**
 * @param {Camera} camera
 * @param {{ sending: CameraWord | undefined }} state
 */
export function cameraRow(camera, { sending }) {
  const busy = sending !== undefined;
  const name = camera.name;
  const said = wordWords(camera);
  const attrs = { 'data-pl-camera': camera.camera };
  const sample = camera.sample
    ? picture({ hash: camera.sample, size: 'tile', alt: '' }, {
      className: 'pl-camera__sample', attrs: { loading: 'lazy', 'data-keep': `sample:${camera.sample}` },
    })
    : sampleMarkup();
  const line = [counted(camera.photos, 'photo'), yearsOf(camera), said ? `${said} · You said` : whyWords(camera)]
    .filter(Boolean).join(' · ');
  const end = (camera.word ? button('Set automatically', { variant: 'plain', busy: sending === 'count',
    disabled: busy, attrs: { 'data-pl-count': '', ...attrs } }) : '')
    + toggle({ on: camera.mine, label: `${name} is yours`, busy,
      attrs: camera.mine ? { 'data-pl-ask-why': '', ...attrs } : { 'data-pl-mine': 'true', ...attrs } });
  return settingRow({ label: name, lead: sample, line, end,
    attrs: { class: 'pl-camera', tabindex: '-1', title: camera.camera, 'data-pl-row': camera.camera } });
}

/**
 * @param {Camera} camera
 * @param {Removal} removal
 * @param {string} today
 */
export function removalWord(camera, { why, when, stopped, first, last }, today) {
  if (why === 'never') return notMine(camera, null);
  if (why !== 'stopped') return null;
  if (when === 'last' && last) return notMine(camera, shiftDay(last, 1));
  const dated = when === 'day' && /^\d{4}-\d{2}-\d{2}$/u.test(stopped) && (!first || first <= stopped) && stopped <= today;
  return dated ? notMine(camera, stopped) : null;
}

/**
 * @param {Camera} camera
 * @param {Removal} removal
 * @param {string} today
 */
export function removePage(camera, removal, today) {
  const { why, when, stopped, first, last } = removal;
  const word = removalWord(camera, removal, today);
  const then = (/** @type {string} */ words) => `<p class="pl-unmine__then mac-body" role="status">${esc(words)}</p>`;
  const question = (/** @type {string} */ words) => `<h3 class="pl-unmine__ask mac-headline">${esc(words)}</h3>`;
  const all = counted(camera.photos, 'photo');
  const keeps = word === null ? '' : kept(word, { photos: camera.photos, first, last });
  const day = textField({ label: 'When did you stop?', name: 'stopped', type: 'date', value: stopped,
    attrs: { 'data-pl-stopped': camera.camera, min: first || null, max: today } });
  const whenRows = last
    ? choiceRows({ label: 'When did you stop?', picked: when, attrs: value => ({ 'data-pl-when': value }), choices: [
      { value: 'last', title: 'After its last photo', end: esc(dayWords(last)) },
      { value: 'day', title: 'On another day', end: when === 'day' ? day : '' },
    ] })
    : day;
  const stoppedPart = why !== 'stopped' ? '' : '<section class="pl-unmine__part">' + question('When did you stop?')
    + whenRows + (keeps ? then(keeps) : '') + '</section>';
  const body = '<p class="pl-unmine__lead mac-body">Nothing is deleted. Its photos stay in your days; they only stop '
    + 'counting towards understanding your location.</p>'
    + '<section class="pl-unmine__part">' + question('Why isn’t it yours?') + choiceRows({
      label: 'Why isn’t it yours?', picked: why, attrs: value => ({ 'data-pl-why': value }), choices: [
        { value: 'stopped', title: 'I stopped using it' },
        { value: 'never', title: 'It was never mine' },
      ],
    }) + (why === 'never' && keeps ? then(keeps) : '') + '</section>' + stoppedPart;
  return dialog({
    icon: 'photo',
    tile: camera.sample ? picture({ hash: camera.sample, size: 'tile', alt: '' }) : '',
    title: `Remove ${camera.name}?`, line: [all, yearsOf(camera)].filter(Boolean).join(' · '),
    body: `<div class="pl-unmine">${body}</div>`,
    foot: '<span></span>' + button('Cancel', { variant: 'plain', attrs: { 'data-pl-why-back': '' } })
      + button('Mark as not mine', { variant: 'primary', disabled: word === null, attrs: { 'data-pl-unmine': camera.camera } }),
    close: { 'data-pl-close': '' },
  });
}

/**
 * @param {import('../../lib/where.js').Said} word
 * @param {{ photos: number, first: string, last: string }} camera
 */
function kept(word, { photos, first, last }) {
  const toward = 'towards understanding your location';
  const ends = word.mine ? (word.to ? shiftDay(word.to, 1) : '') : word.from ?? '';
  const begins = word.mine ? word.from ?? '' : '';
  if (!ends) return photos === 1 ? `Its photo won’t count ${toward}.` : `None of its ${count(photos)} photos will count ${toward}.`;
  if (last && ends > last && (!begins || !first || begins <= first)) {
    return (photos === 1 ? `Its photo still counts ${toward}.` : `All ${count(photos)} of its photos still count ${toward}.`)
      + (ends === shiftDay(last, 1) ? ` Any it takes after ${dayWords(last)} won’t.` : ` Any it takes from ${dayWords(ends)} on won’t.`);
  }
  if (begins) return `Its photos from ${dayWords(begins)} until ${dayWords(ends)} still count ${toward}. The rest don’t.`;
  return `Photos before ${dayWords(ends)} still count ${toward}. From ${dayWords(ends)} on, they don’t.`;
}

const sampleMarkup = () => settingTile('photo');

export function sampleTile() {
  const holder = document.createElement('span');
  holder.innerHTML = sampleMarkup();
  return /** @type {Element} */ (holder.firstElementChild);
}
