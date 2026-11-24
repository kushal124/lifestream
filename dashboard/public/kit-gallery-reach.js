// @ts-check
/** @import { Reach } from './lib/reach.js' */
import { esc } from './lib/html.js';
import { homeStrip, inPlaceLine, lines, loading, pageLack, sectionLabel, waitLine } from './ui/kit/index.js';

/** @type {Record<string, Reach>} */
export const STATES = {
  answering: { state: 'answering', revision: 7, tone: null, title: null, line: null, meta: null, acts: [], last: null, checking: false, path: [] },
  'answering, its last send held': { state: 'answering', revision: 7, tone: null, title: null, line: null, meta: null, acts: [], last: null, checking: false, path: [] },
  'answering, just reached again': { state: 'answering', revision: 8, tone: 'done', title: 'Lifestream is back', line: null, meta: null, acts: [], last: null, checking: false, path: [] },
  waiting: { state: 'waiting', revision: 7, tone: null, title: null, line: null, meta: null, acts: [], last: null, checking: false, path: [] },
  'waiting, after a start': { state: 'waiting', revision: 7, tone: 'waiting', title: 'Lifestream is starting', line: 'It answers in a moment.', meta: null, acts: [], last: null, checking: false, path: [] },
  starting: { state: 'starting', revision: 7, tone: 'waiting', title: 'Lifestream is starting', line: 'It answers in a moment.', meta: null, acts: [], last: null, checking: false, path: [] },
  unreachable: { state: 'unreachable', revision: 7, tone: 'warning', title: 'Can\'t reach Lifestream', line: 'Lifestream isn\'t answering', meta: 'since 14:02', acts: [], last: 'Last reached 14:02', checking: false, path: [
    { id: 'lifestream', name: 'Lifestream on this Mac', state: 'passed', value: 'Running', fix: null, act: null },
    { id: 'drive', name: 'Lifestream\'s drive', state: 'passed', value: 'Connected', fix: null, act: null },
    { id: 'home', name: 'Lifestream', state: 'failed', value: 'Not answering', fix: 'Lifestream asks it again on its own', act: null }] },
  'unreachable, checking again': { state: 'unreachable', revision: 7, tone: 'warning', title: 'Can\'t reach Lifestream', line: 'Lifestream isn\'t answering', meta: 'since 14:02', acts: [], last: 'Last reached 14:02', checking: true, path: [
    { id: 'lifestream', name: 'Lifestream on this Mac', state: 'passed', value: 'Running', fix: null, act: null },
    { id: 'drive', name: 'Lifestream\'s drive', state: 'passed', value: 'Connected', fix: null, act: null },
    { id: 'home', name: 'Lifestream', state: 'failed', value: 'Not answering', fix: 'Lifestream asks it again on its own', act: null }] },
  'unreachable, Lifestream not running': { state: 'unreachable', revision: 7, tone: 'warning', title: 'Lifestream isn\'t running', line: 'Nothing is read or saved', meta: 'since Sat 14 Nov', acts: [{ do: 'open', label: 'Start Lifestream' }], last: 'Last reached Sat 14 Nov · 14:02', checking: false, path: [
    { id: 'lifestream', name: 'Lifestream on this Mac', state: 'failed', value: 'Not running', fix: 'Open it, and Lifestream starts again', act: { do: 'open', label: 'Open' } },
    { id: 'drive', name: 'Lifestream\'s drive', state: 'passed', value: 'Connected', fix: null, act: null },
    { id: 'home', name: 'Lifestream', state: 'unchecked', value: 'Not checked', fix: null, act: null }] },
  held: { state: 'held', revision: 7, tone: 'warning', title: 'Lifestream is held', line: 'The drive holding it went away.', meta: 'since 14:02', acts: [{ do: 'verify', label: 'Check again' }], last: null, checking: false, path: [] },
  'update, the home\'s': { state: 'update', revision: 7, tone: 'caution', title: 'Lifestream needs an update', line: 'Update it on your Mac', meta: null, acts: [], last: null, checking: false, path: [] },
  'update, this Mac\'s': { state: 'update', revision: 7, tone: 'caution', title: 'Update Lifestream on this Mac', line: 'What it records waits here', meta: null, acts: [], last: null, checking: false, path: [] },
  refused: { state: 'refused', revision: 7, tone: 'caution', title: 'Lifestream no longer knows this Mac', line: 'Pair it again to send', meta: null, acts: [{ do: 'pair', label: 'Pair again' }], last: null, checking: false, path: [] },
  unpaired: { state: 'unpaired', revision: 0, tone: 'caution', title: 'This Mac isn\'t paired', line: 'Pair it to send what it records', meta: null, acts: [], last: null, checking: false, path: [] },
};

/** @type {Reach} */
export const DRIVE_AWAY = { state: 'unreachable', revision: 7, tone: 'warning', title: 'Lifestream\'s drive isn\'t connected', line: 'Connect its drive and it starts again', meta: 'since 12:55', acts: [], last: 'Last reached 12:55', checking: false, path: [
    { id: 'lifestream', name: 'Lifestream on this Mac', state: 'passed', value: 'Running', fix: null, act: null },
    { id: 'drive', name: 'Lifestream\'s drive', state: 'failed', value: 'Not connected', fix: 'Connect it, and Lifestream starts again', act: null },
    { id: 'home', name: 'Lifestream', state: 'unchecked', value: 'Waits for its drive', fix: null, act: null }] };

/** @param {string} label @param {string} html @param {string} [className] */
const specimen = (label, html, className = '') => `<div class="gallery__specimen${className ? ` ${className}` : ''}">`
  + `<p class="gallery__label mac-mono-label">${esc(label)}</p>${html}</div>`;
/** @param {string} name @param {string} body */
const group = (name, body) => `<section class="gallery__group">${sectionLabel(name)}${body}</section>`;

const firstRead = (/** @type {string} */ lack) => lines(3) + waitLine() + pageLack(lack, { reach: true });

export const reach = () => [
  group('StatusStrip · across the window, each reach state the Mac states, nothing while it answers or waits', '<div class="gallery__stack">'
    + Object.entries(STATES).map(([name, state]) => specimen(name, homeStrip(state) || '<p class="mac-footnote">Nothing</p>')).join('')
    + specimen('An act pressed: busy, its size kept', homeStrip(STATES.held, { busy: 'verify' }))
    + specimen('An act refused: said in place, in the strip’s line', homeStrip(STATES.held, { said: 'Lifestream is not held.' }))
    + specimen('Details: the checklist of the path, Lifestream not running, a popover under the strip',
      homeStrip(STATES['unreachable, Lifestream not running'], { open: true }), 'gallery__specimen--pop')
    + specimen('Details: the home silent, its fix', homeStrip(STATES.unreachable, { open: true }), 'gallery__specimen--pop')
    + '</div>'),
  group('PageLack', '<div class="gallery__stack">' + [
    specimen('Failed of itself: Try again', pageLack('Your connectors couldn’t be read.', { retry: {} })),
    specimen('Refused: the home’s own words', pageLack('Lifestream holds no such day.')),
    specimen('Failed for reach, its root lacking: nothing to press, it reads again by itself',
      pageLack('Your connectors aren’t on this Mac yet.', { reach: true }), 'ck-lacks'),
  ].join('') + '</div>'),
  group('PageLack · a first read past patience, as reach waits and as it lacks', '<div class="gallery__stack">' + [
    specimen('Reach waits: “Waiting for Lifestream.”', firstRead('Your connectors aren’t on this Mac yet.'), 'ck-root ck-reading'),
    specimen('Reach lacks: the line hidden, the lack in its place', firstRead('Your connectors aren’t on this Mac yet.'),
      'ck-root ck-reading ck-lacks'),
    specimen('A wait of this read alone: the door’s words', lines(3) + waitLine('The search index is busy. Try again in a moment.'),
      'ck-root ck-reading'),
  ].join('') + '</div>'),
  group('Loading · a page’s mark with a wait’s words, and while reach lacks', '<div class="gallery__stack">' + [
    specimen('A wait’s words under the mark', loading('Reading', { words: 'Chat isn’t answering on your Mac' })),
    specimen('Reach lacks: nothing, the lack in its place', loading('Reading') + pageLack('Your people aren’t on this Mac yet.',
      { reach: true }), 'ck-lacks'),
  ].join('') + '</div>'),
  group('In place · one quiet line where it failed', '<div class="gallery__stack">' + [
    specimen('Never sent: Try again, which sends it once more', inPlaceLine('', { said: 'not-sent', retry: {} })),
    specimen('Refused: the home’s words, nothing to press', inPlaceLine('Lifestream is building its index.', { said: 'refused', retry: {} })),
    specimen('Not known: the home’s words, nothing to press', inPlaceLine('Lifestream didn\'t say whether this was done.',
      { said: 'unknown', retry: {} })),
    specimen('A save not landed: its words and Try again', inPlaceLine('Not saved: Lifestream didn’t answer', { retry: {} })),
    specimen('A field’s: one line under the field', inPlaceLine('That date doesn’t exist')),
    specimen('What stands in the way: the triangle, its own way out', inPlaceLine('Chat needs your Claude sign-in on your Mac.',
      { retry: {}, label: 'Sign in with Claude…', shape: 'caution' })),
  ].join('') + '</div>'),
].join('');
