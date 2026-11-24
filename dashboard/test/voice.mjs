// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DIDNT_PLAY, setIcons, voiceController, voiceNote, voiceOwner } from '../public/ui/kit/index.js';
import { citedSources, replayOf, shownRefs, voiceShown } from '../public/ui/ask/turns.js';
import { clock } from '../public/lib/words.js';
import { mediaType } from '../lib/life.mjs';

setIcons(JSON.parse(readFileSync(new URL('../../design/icons.json', import.meta.url), 'utf8')));

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const ANSWER = 'answer:1792396854000-0ab6d9';

class Media extends EventTarget {
  src = '';
  paused = true;
  currentTime = 0;
  duration = NaN;
  plays = 0;
  /** @type {Error | null} */
  refusal = null;

  play() {
    this.plays += 1;
    this.paused = false;
    return this.refusal ? Promise.reject(this.refusal) : Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.fire('pause');
  }

  load() {}

  /** @param {string} name */
  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }

  /** @param {string} name */
  fire(name) {
    this.dispatchEvent(new Event(name));
  }
}

function made() {
  const media = new Media();
  /** @type {string[]} */
  const painted = [];
  const voice = voiceController(() => media, sound => void painted.push(sound));
  /** @type {string[]} */
  const failed = [];
  /** @type {number[]} */
  const tokens = [];
  voice.hold({ failed: (sound, play) => {
    failed.push(sound);
    tokens.push(play);
  } });
  return { media, painted, voice, failed, tokens };
}

const settled = () => new Promise(done => setImmediate(done));

test('V1: a tap loads, plays only once the audio says it plays, pauses where it is and resumes from there, never from 0', () => {
  const { media, voice, painted } = made();
  assert.equal(voice.state(A), 'idle');
  voice.toggle(A, ANSWER);
  assert.equal(voice.state(A), 'loading');
  assert.equal(media.src, `/api/life/media?hash=${encodeURIComponent(A)}`);
  media.fire('playing');
  assert.equal(voice.state(A), 'playing');
  media.currentTime = 5;
  voice.toggle(A, ANSWER);
  assert.equal(voice.state(A), 'paused');
  assert.equal(media.paused, true);
  voice.toggle(A, ANSWER);
  assert.equal(voice.state(A), 'playing');
  assert.equal(media.currentTime, 5, 'a resume restarted the note');
  assert.equal(media.src, `/api/life/media?hash=${encodeURIComponent(A)}`);
  assert.ok(painted.length >= 4 && painted.every(sound => sound === A), 'a state change drew no bar of its sound');
});

test('V2: a tap on another bar of the same sound resumes it there and moves ownership; a surface that leaves stops only what it owns', () => {
  const { media, voice } = made();
  voice.toggle(A, ANSWER);
  media.fire('playing');
  voice.toggle(A, ANSWER);
  voice.toggle(A, 'panel');
  assert.equal(voice.state(A), 'playing');
  assert.equal(media.plays, 2, 'a resume loaded the note again');
  voice.stop(ANSWER);
  assert.equal(voice.state(A), 'playing', 'the answer stopped a note the panel resumed');
  voice.stop('panel');
  assert.equal(voice.state(A), 'idle');
  voice.toggle(A, ANSWER);
  voice.toggle(A, 'panel');
  assert.equal(voice.state(A), 'idle', 'a tap from another surface while loading did not cancel');
});

test('V3: a pause from another surface leaves ownership where it was', () => {
  const { media, voice } = made();
  voice.toggle(A, ANSWER);
  media.fire('playing');
  voice.toggle(A, 'panel');
  assert.equal(voice.state(A), 'paused');
  voice.stop('panel');
  assert.equal(voice.state(A), 'paused', 'the panel stopped a note it only paused');
  voice.stop(ANSWER);
  assert.equal(voice.state(A), 'idle');
});

test('V4: one note at a time: starting another stops the first, back to Ready', () => {
  const { media, voice } = made();
  voice.toggle(A, ANSWER);
  media.fire('playing');
  voice.toggle(B, 'panel');
  assert.equal(voice.state(A), 'idle');
  assert.equal(voice.state(B), 'loading');
  assert.equal(media.src, `/api/life/media?hash=${encodeURIComponent(B)}`);
});

test('V5: a second tap while loading cancels, back to Ready, and is no failure', async () => {
  const { media, voice, failed } = made();
  media.refusal = Object.assign(new Error('aborted'), { name: 'AbortError' });
  voice.toggle(A, ANSWER);
  voice.toggle(A, ANSWER);
  await settled();
  assert.equal(voice.state(A), 'idle');
  assert.equal(media.src, '');
  assert.deepEqual(failed, []);
});

test('V6: a tap while a question records is refused: Ready, nothing loaded, nothing failed', () => {
  const { media, voice, failed } = made();
  let recording = true;
  voice.hold({ refuses: () => recording });
  voice.toggle(A, ANSWER);
  assert.equal(voice.state(A), 'idle');
  assert.equal(media.plays, 0);
  assert.deepEqual(failed, []);
  recording = false;
  voice.toggle(A, ANSWER);
  assert.equal(voice.state(A), 'loading');
});

test('V7: audio that fails to load or decode fails the sound once and says so; a tap again loads it afresh', async () => {
  const { media, voice, failed } = made();
  voice.toggle(A, ANSWER);
  media.fire('error');
  assert.equal(voice.state(A), 'failed');
  assert.deepEqual(failed, [A]);
  assert.equal(media.src, '');
  voice.toggle(A, ANSWER);
  assert.equal(voice.state(A), 'loading');
  voice.toggle(A, ANSWER);
  media.refusal = Object.assign(new Error('refused'), { name: 'NotSupportedError' });
  voice.toggle(B, ANSWER);
  await settled();
  assert.equal(voice.state(B), 'failed');
  assert.deepEqual(failed, [A, B]);
});

test('V8: played through is Ready at 0; the length is the stated one, else the loaded one', () => {
  const { media, voice } = made();
  voice.toggle(A, ANSWER);
  media.duration = 12.4;
  media.fire('loadedmetadata');
  media.fire('playing');
  media.currentTime = 12.4;
  media.fire('ended');
  assert.equal(voice.state(A), 'idle');
  assert.equal(media.currentTime, 0);
  assert.deepEqual(voice.time(A), { at: 0, of: 12.4 });
});

test('V9: a stop with no owner stops what plays, whoever owns it', () => {
  const { media, voice } = made();
  voice.toggle(A, ANSWER);
  media.fire('playing');
  voice.stop();
  assert.equal(voice.state(A), 'idle');
});

test('V10: a question’s own note plays from the address its bar carries; none given, nothing happens', () => {
  const { media, voice } = made();
  voice.toggle('own:s2', ANSWER);
  assert.equal(voice.state('own:s2'), 'idle');
  assert.equal(media.plays, 0);
  voice.toggle('own:s1', ANSWER, 'blob:local-note');
  assert.equal(media.src, 'blob:local-note');
  voice.toggle(A, ANSWER);
  assert.equal(voice.state('own:s1'), 'idle', 'a question’s note and a cited note played together');
});

test('V11: a bar names its sound and owner, its length or –:–– until loaded, its caption opening the thread; every face and the failed line drawn at once', () => {
  const bar = voiceNote({ audio: A, seconds: 23, owner: ANSWER, caption: 'Person A · Wed 4 Nov, 21:40', open: { 'data-ask-cite': '0 r1' } });
  assert.match(bar, new RegExp(`class="ck-voice ck-voice-cite" data-voice="${A}" data-voice-owner="${ANSWER}" data-voice-seconds="23"`, 'u'));
  assert.match(bar, /data-voice-time><span>0:23<\/span>/u);
  assert.match(bar, /<button type="button" class="ck-voice-cite__caption mac-subhead" data-ask-cite="0 r1">Person A · Wed 4 Nov, 21:40<\/button>/u);
  assert.deepEqual([...bar.matchAll(/data-voice-face="(\w+)"/gu)].map(([, face]) => face), ['play', 'pause', 'loading'],
    'a face the player would have to swap in');
  assert.match(bar, /This voice note didn’t play\.<\/span><button type="button" class="ck-in-place__act mac-headline" data-voice-play>Try again<\/button>/u,
    'Try again is not a play of the bar’s own sound');
  assert.ok(bar.indexOf('data-voice-play>Try again') < bar.lastIndexOf('</div>'), 'Try again outside its bar');
  assert.match(voiceNote({ audio: A, owner: ANSWER, failed: 'The home didn’t answer.' }), /The home didn’t answer\./u);
  const unstated = voiceNote({ audio: A, owner: 'panel', mine: true });
  assert.match(unstated, />–:––</u);
  assert.match(unstated, /class="ck-audio is-mine"/u);
  assert.doesNotMatch(unstated, /ck-voice-cite/u);
});

/** @param {string} key @param {string} audio @param {Record<string, unknown>} [more] */
const note = (key, audio, more = {}) => /** @type {import('../public/ui/ask/turns.js').AskThing} */ ({ ref: `record.${key}`, kind: 'message',
  day: '2026-11-04', at: '2026-11-04T21:40+00:00', title: 'Person A', chat: 'chat.a', chat_title: 'Person A',
  opens: { page: 'days', day: '2026-11-04', focus: `rec:whatsapp:local:phone-a message ${key}` },
  voice: { audio, record: `record.${key}`, seconds: 23, from: 'Person A' }, ...more });

test('V12: each failed-play outcome: no answer keeps the bar with the reach words; gone is erased; still held is the newer describe and says it didn’t play; no voice drops the bar', () => {
  const kept = note('k1', A);
  assert.deepEqual(voiceShown(kept, new Map()), { voice: kept.voice, failed: DIDNT_PLAY });
  const unanswered = replayOf('record.k1', null, 'Lifestream didn’t answer.');
  assert.deepEqual(voiceShown(kept, new Map([['record.k1', unanswered]])), { voice: kept.voice, failed: 'Lifestream didn’t answer.' });
  const unopened = replayOf('record.k1', { described: [], unopened: ['record.k1'] }, 'Lifestream didn’t answer.');
  assert.equal(unopened.cited, null, 'a ref the door left unopened read as described');
  const erased = replayOf('record.k1', { described: [{ ref: 'record.k1', kind: 'gone', why: 'erased' }] }, '');
  assert.equal(voiceShown(kept, new Map([['record.k1', erased]])), 'erased');
  const held = replayOf('record.k1', { described: [note('k1', B)] }, '');
  assert.deepEqual(voiceShown(kept, new Map([['record.k1', held]])), { voice: note('k1', B).voice, failed: DIDNT_PLAY });
  const lost = replayOf('record.k1', { described: [note('k1', B, { voice: undefined })] }, '');
  assert.equal(voiceShown(kept, new Map([['record.k1', lost]])), null);
  const line = { ...note('k1', A), ref: 'line.printed-again', kind: /** @type {const} */ ('line') };
  const lineGone = replayOf('line.printed-again', { described: [{ ref: 'line.printed-again', kind: 'gone', why: 'printed again' }] }, '');
  assert.deepEqual(voiceShown(line, new Map([['line.printed-again', lineGone], ['record.k1', held]])), { voice: note('k1', B).voice, failed: DIDNT_PLAY },
    'a line printed again read as an erased note');
});

const AT = `Wed 4 Nov, ${clock(Date.parse('2026-11-04T21:40+00:00'))}`;

test('V13: the newer describe is drawn over the kept citation; a voice citation never merges with its chat and day, and keeps its caption', () => {
  const refs = { r1: note('k1', A), r2: note('k2', B) };
  const held = replayOf('record.k2', { described: [note('k2', A)] }, '');
  const shown = shownRefs(refs, { replays: new Map([['record.k2', held]]), year: '2026' });
  assert.equal(shown.r1.block, undefined);
  assert.deepEqual(shown.r1.voice, { record: 'record.k1', audio: A, seconds: 23, caption: `Person A · ${AT}`, mine: false, failed: DIDNT_PLAY });
  assert.deepEqual(shown.r2.voice, { record: 'record.k2', audio: A, seconds: 23, caption: `Person A · ${AT}`, mine: false, failed: DIDNT_PLAY });
  const mine = shownRefs({ r1: note('k3', A, { voice: { audio: A, record: 'record.k3', mine: true } }) }, { year: '2026' });
  assert.equal(mine.r1.voice?.caption, `You · ${AT}`);
  const unnamed = shownRefs({ r1: note('k4', A, { voice: { audio: A, record: 'record.k4' }, chat_title: 'Group Alpha', title: 'Group Alpha' }) }, { year: '2026' });
  assert.equal(unnamed.r1.voice?.caption, `Someone · ${AT}`, 'a note with no speaker named after its chat');
  const erased = shownRefs(refs, { replays: new Map([['record.k1', replayOf('record.k1', { described: [{ ref: 'record.k1', kind: 'gone', why: '' }] }, '')]]) });
  assert.equal(erased.r1.voice?.erased, true);
  assert.equal(erased.r1.block, undefined, 'an erased note merged into its chat');
  const lost = shownRefs(refs, { replays: new Map([['record.k1', replayOf('record.k1', { described: [note('k1', A, { voice: undefined })] }, '')]]) });
  assert.equal(lost.r1.voice, undefined);
  assert.equal(lost.r1.block, 'chat.a', 'a citation whose audio is gone did not merge as a plain one');
  const turn = { text: 'Said [r1] and [r2].', refs };
  assert.deepEqual(citedSources(/** @type {import('../public/ui/ask/turns.js').Turn} */ (/** @type {unknown} */ (turn))).map(each => each.handles), [['r1'], ['r2']]);
});

test('V14: the bar follows the audio itself: a pause the system makes shows paused, a play from a media key shows playing, the owner kept', () => {
  const { media, voice } = made();
  voice.toggle(A, ANSWER);
  media.fire('playing');
  media.pause();
  assert.equal(voice.state(A), 'paused', 'a system pause still drawn as playing');
  media.paused = false;
  media.fire('playing');
  assert.equal(voice.state(A), 'playing');
  voice.stop('panel');
  assert.equal(voice.state(A), 'playing', 'a media key moved the note to another owner');
  voice.stop(ANSWER);
  assert.equal(voice.state(A), 'idle');
});

test('V15: every play of a sound is numbered, and its failure says which, so a late describe of an older play is told apart', () => {
  const { media, voice, tokens } = made();
  voice.toggle(A, ANSWER);
  media.fire('error');
  assert.deepEqual(tokens, [1]);
  assert.equal(voice.plays(A), 1);
  voice.toggle(A, ANSWER);
  assert.equal(voice.plays(A), 2, 'a play again kept the failed play’s number');
  media.fire('playing');
  voice.toggle(A, ANSWER);
  voice.toggle(A, ANSWER);
  assert.equal(voice.plays(A), 2, 'a resume counted as a new play');
  assert.equal(voice.plays(B), 0);
});

test('V16: a tap marks voice-tap and the first sound voice-playing, once per play, for the tap-to-sound budget', () => {
  performance.clearMarks();
  const { media, voice } = made();
  voice.toggle(A, ANSWER);
  assert.deepEqual(performance.getEntriesByName('voice-tap').map(mark => /** @type {PerformanceMark} */ (mark).detail), [A]);
  assert.equal(performance.getEntriesByName('voice-playing').length, 0, 'loading marked as playing');
  media.fire('playing');
  media.pause();
  voice.toggle(A, ANSWER);
  media.fire('playing');
  assert.deepEqual(performance.getEntriesByName('voice-playing').map(mark => /** @type {PerformanceMark} */ (mark).detail), [A],
    'a resume marked as the first sound');
  assert.ok(performance.getEntriesByName('voice-tap')[0].startTime <= performance.getEntriesByName('voice-playing')[0].startTime);
});

test('V17: owners are minted once per surface and never repeat', () => {
  const owners = [voiceOwner('panel'), voiceOwner('panel'), voiceOwner('answer')];
  assert.equal(new Set(owners).size, 3);
  assert.ok(owners.every(owner => /^(?:panel|answer):\d+$/u.test(owner)));
});

test('V18: the media route types each kept voice-note format as WebAudioTests serves it to the Mac app’s WebKit', () => {
  const swift = readFileSync(new URL('../../macos-app/Tests/LifestreamTests/WebAudioTests.swift', import.meta.url), 'utf8');
  const table = /static let served[^=]*=\s*\[([^\]]*)\]/u.exec(swift)?.[1] ?? '';
  const served = [...table.matchAll(/\("([^"]+)", "([^"]+)"\)/gu)].map(([, name, type]) => [name, type]);
  assert.deepEqual(served.map(([name]) => name).sort(), ['imessage-aac.caf', 'imessage-opus.caf', 'iphone.m4a', 'whatsapp.ogg']);
  for (const [name, type] of served) {
    const head = new Uint8Array(readFileSync(new URL(`../../packages/core/test/audio/${name}`, import.meta.url)).subarray(0, 16));
    assert.equal(mediaType(head), type, `${name} served to WebKit as a type the route never gives it`);
  }
});
