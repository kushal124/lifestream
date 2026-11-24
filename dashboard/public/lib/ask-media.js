// @ts-check

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];
export const PHOTO_ACCEPT = [...PHOTO_TYPES, '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp'].join(',');

export const RATE = 16_000;
export const SECOND_BYTES = RATE * 2;

/** @param {number} bytes */
export const tooLarge = bytes => `Too large to send: over ${Math.round(bytes / 1024 / 1024)} MB.`;
export const NOT_A_PHOTO = 'Only photos can go with a question.';

/** @typedef {{ name: string, type: string, size: number, lastModified: number }} PickedFile */

/** @param {PickedFile} file */
export function photoKind(file) {
  const type = file.type.toLowerCase();
  if (type === 'image/jpeg' || type === 'image/jpg') return 'JPEG';
  if (type === 'image/png') return 'PNG';
  if (type === 'image/heic' || type === 'image/heif') return 'HEIC';
  if (type === 'image/webp') return 'WEBP';
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  return { jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', heic: 'HEIC', heif: 'HEIC', webp: 'WEBP' }[extension] ?? '';
}

/** @param {PickedFile} file */
export const sameFile = file => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

/**
 * @template {PickedFile} F
 * @param {F[]} files
 * @param {{ attached: PickedFile[], limits: { photos: number, photo_bytes: number } }} held
 * @returns {{ take: F[], said: string }}
 */
export function photosToTake(files, { attached, limits }) {
  const seen = new Set(attached.map(sameFile));
  /** @type {F[]} */
  const take = [];
  let said = '';
  for (const file of files) {
    if (attached.length + take.length >= limits.photos) break;
    if (seen.has(sameFile(file))) continue;
    if (!photoKind(file)) said ||= NOT_A_PHOTO;
    else if (file.size > limits.photo_bytes) said ||= tooLarge(limits.photo_bytes);
    else {
      seen.add(sameFile(file));
      take.push(file);
    }
  }
  return { take, said };
}

export function mint() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {number} from */
export function downsampler(from) {
  const step = from / RATE;
  let heard = 0;
  let next = step;
  let sum = 0;
  let count = 0;
  /**
   * @param {Float32Array} block
   * @returns {Int16Array}
   */
  return block => {
    /** @type {number[]} */
    const out = [];
    for (const sample of block) {
      sum += sample;
      count += 1;
      heard += 1;
      if (heard < next) continue;
      out.push(toInt16(sum / count));
      sum = 0;
      count = 0;
      next += step;
    }
    return Int16Array.from(out);
  };
}

/** @param {number} sample */
const toInt16 = sample => Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));

/** @param {number} most */
export function seconds(most) {
  let held = new Uint8Array(SECOND_BYTES);
  let filled = 0;
  let taken = 0;
  return {
    /** @param {Int16Array} samples @returns {Uint8Array[]} */
    push(samples) {
      /** @type {Uint8Array[]} */
      const done = [];
      const room = Math.max(0, most - taken);
      const bytes = littleEndian(samples.length > room ? samples.subarray(0, room) : samples);
      taken += bytes.length / 2;
      let at = 0;
      while (at < bytes.length) {
        const part = Math.min(SECOND_BYTES - filled, bytes.length - at);
        held.set(bytes.subarray(at, at + part), filled);
        filled += part;
        at += part;
        if (filled === SECOND_BYTES) {
          done.push(held);
          held = new Uint8Array(SECOND_BYTES);
          filled = 0;
        }
      }
      return done;
    },
    get full() { return taken >= most; },
    /** @returns {Uint8Array} */
    rest: () => held.slice(0, filled),
  };
}

/** @param {Int16Array} samples */
function littleEndian(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, at) => view.setInt16(at * 2, sample, true));
  return bytes;
}

/** @param {Int16Array} samples */
export function levelOf(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const db = 10 * Math.log10(Math.max(sum / samples.length, 1) / (32_768 * 32_768));
  return Math.max(0, Math.min(1, (db + 50) / 50));
}

/** @param {number} bytes */
export const noteMs = bytes => Math.round(bytes / 2 / RATE * 1000);

/** @param {Uint8Array[]} parts */
export function wavOf(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const wav = new Uint8Array(44 + length);
  const view = new DataView(wav.buffer);
  /** @param {number} at @param {string} words */
  const text = (at, words) => [...words].forEach((letter, index) => view.setUint8(at + index, letter.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length, true);
  let at = 44;
  for (const part of parts) {
    wav.set(part, at);
    at += part.length;
  }
  return wav;
}

/**
 * @param {number[]} levels
 * @param {number} bars
 */
export function barsOf(levels, bars) {
  if (levels.length <= bars) return levels;
  return Array.from({ length: bars }, (_, at) => {
    const from = Math.floor(at * levels.length / bars);
    const to = Math.max(from + 1, Math.floor((at + 1) * levels.length / bars));
    return Math.max(...levels.slice(from, to));
  });
}
