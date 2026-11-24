// @ts-check
/** @import { Square } from '../kit/move-and-scale.js' */

export const SIDE = 1024;
const QUALITY = 0.85;

/**
 * @param {Blob} file
 * @returns {Promise<{ src: string, width: number, height: number } | null>}
 */
export async function openPicture(file) {
  const src = URL.createObjectURL(file);
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(src);
    return null;
  }
  return { src, width: image.naturalWidth, height: image.naturalHeight };
}

const AROUND = 2.5;

/**
 * @param {{ width: number, height: number }} picture
 * @param {readonly number[]} box
 * @returns {Square}
 */
export function aroundFace({ width, height }, box) {
  const [x1 = 0, y1 = 0, x2 = width, y2 = height] = box;
  const side = Math.round(Math.min(width, height, AROUND * Math.max(x2 - x1, y2 - y1)));
  const hold = (/** @type {number} */ at, /** @type {number} */ most) => Math.round(Math.min(Math.max(0, at), Math.max(0, most - side)));
  return { x: hold((x1 + x2) / 2 - side / 2, width), y: hold((y1 + y2) / 2 - side / 2, height), side };
}

/**
 * @param {Blob} file
 * @param {Square} square
 * @returns {Promise<{ jpeg: Blob, hash: string, base64: string }>}
 */
export async function makeSquare(file, { x, y, side }) {
  const size = Math.min(side, SIDE);
  const oriented = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const drawn = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' }));
  drawn.fillStyle = '#ffffff';
  drawn.fillRect(0, 0, size, size);
  drawn.imageSmoothingQuality = 'high';
  drawn.drawImage(oriented, x, y, side, side, 0, 0, size, size);
  oriented.close();
  const jpeg = await new Promise((done, fail) => canvas.toBlob(blob => (blob ? done(blob) : fail(new Error('The photo could not be made.'))),
    'image/jpeg', QUALITY));
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = `sha256:${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return { jpeg, hash, base64: btoa(binary) };
}
