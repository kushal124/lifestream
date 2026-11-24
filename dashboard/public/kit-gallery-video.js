// @ts-check
import { attributes, esc } from './lib/html.js';
import { picture, liveStage, sectionLabel, videoLabel, videoMark, videoStage, videoTile } from './ui/kit/index.js';

/** @param {string} label @param {string} html */
const specimen = (label, html) => `<div class="gallery__specimen"><p class="gallery__label mac-mono-label">${esc(label)}</p>${html}</div>`;
/** @param {string} name @param {string} body */
const group = (name, body) => `<section class="gallery__group">${sectionLabel(name)}${body}</section>`;

const filmless = (/** @type {string} */ markup) => markup.replace(/ src="\/api\/life\/media\?hash=[^"]*"/gu, '');

/** @param {{ hash: string, length_ms?: number | null, video?: boolean, live?: boolean }[]} tiles */
const tiles = tiles => '<div class="ck-photos ck-photos--4" role="group" aria-label="Photos">' + tiles.map(tile => `<button${attributes({
  type: 'button', class: 'ck-photo', 'aria-label': tile.video ? videoLabel(tile.length_ms) : tile.live ? 'Live Photo' : 'Photo' })}>`
  + picture({ hash: tile.hash, size: 'tile', alt: '' }, { className: 'ck-photo__img' })
  + (tile.video ? videoMark({ length_ms: tile.length_ms }) : '') + '</button>').join('') + '</div>';

/** @param {string} html */
const stage = html => `<div class="gallery__spot ck-viewer__stage" data-theme="dark">${html}</div>`;

export const video = () => [
  group('VideoMark · a video’s tile: its poster, the play glyph and its length as a player writes it', '<div class="gallery__stack">' + [
    specimen('Posters drawn: 0:42, 2:10, an hour’s 1:02:05; a Live Photo, its still alone', tiles([
      { hash: 'scene-3', length_ms: 42_400, video: true }, { hash: 'scene-5', length_ms: 130_000, video: true },
      { hash: 'scene-6', length_ms: 3_725_000, video: true }, { hash: 'scene-4', live: true }])),
    specimen('No length (a video only Takeout holds, a message’s video): the glyph alone', tiles([
      { hash: 'scene-1', video: true }, { hash: 'scene-7', video: true }])),
    specimen('Its poster being made, or none can be, or the engine could not run: the box, its mark at once', tiles([
      { hash: 'lost', length_ms: 42_000, video: true }, { hash: 'lost', video: true }, { hash: 'scene-2', length_ms: 8_000, video: true }])),
    specimen('Where no list holds it (a thread’s bubble): videoTile, opening the viewer',
      `<div class="ck-msg__pics is-1">${videoTile({ hash: 'scene-6', length_ms: 75_000 })}</div>`),
  ].join('') + '</div>'),
  group('Video stage · in the viewer, by its state', '<div class="gallery__stack">' + [
    specimen('Playing: the browser’s controls on its own frame, over its poster, the screen picture',
      stage(filmless(videoStage({ hash: 'scene-6', alt: 'Video, Sat 11 Oct' })))),
    specimen('Its poster being made or none: the player’s box, starting without it',
      stage(filmless(videoStage({ hash: 'lost', alt: 'Video, Sat 11 Oct' })))),
    specimen('A class no player here plays: the poster stays, the words and Download at its foot',
      stage(videoStage({ hash: 'scene-6', state: 'cannot' }))),
    specimen('The home out of reach: the page lack in the same place; it plays once the home answers',
      stage(videoStage({ hash: 'scene-2', state: 'reach' }))),
  ].join('') + '</div>'),
  group('Live Photo · its still, its motion over it, LIVE at its top left corner', '<div class="gallery__stack">' + [
    specimen('At rest', stage(filmless(liveStage({ hash: 'scene-4', motion: 'scene-4', alt: 'Live Photo, Sat 11 Oct' })))),
    specimen('Playing: LIVE pressed, the motion over the still', stage(filmless(liveStage({ hash: 'scene-5', motion: 'scene-5',
      alt: 'Live Photo, Sat 11 Oct', playing: true })))),
    specimen('Its motion not held, or its facts not read yet: the still, no LIVE', stage(liveStage({ hash: 'scene-1', motion: null }))),
    specimen('Its motion failed as a video does: the still, no LIVE, the words', stage(liveStage({ hash: 'scene-2', motion: 'scene-2',
      failed: 'reach' }))),
  ].join('') + '</div>'),
].join('');
