// @ts-check
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');

/**
 * @param {Buffer} png
 * @returns {{ width: number, height: number, colour: number, rows: Buffer[] }}
 */
export function pixels(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0, height = 0, colour = 0;
  /** @type {Buffer[]} */
  const data = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colour = body[9];
      if (body[8] !== 8 || (colour !== 2 && colour !== 6) || body[12] !== 0) {
        throw new Error(`a PNG of depth ${body[8]}, colour type ${colour}, interlace ${body[12]}: only 8-bit RGB or RGBA, not interlaced`);
      }
    }
    if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const pixel = colour === 6 ? 4 : 3;
  const stride = width * pixel;
  const filtered = inflateSync(Buffer.concat(data));
  /** @type {Buffer[]} */
  const rows = [];
  let above = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (stride + 1)];
    const row = Buffer.from(filtered.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= pixel ? row[x - pixel] : 0;
      const up = above[x];
      const corner = x >= pixel ? above[x - pixel] : 0;
      if (filter === 1) row[x] += left;
      else if (filter === 2) row[x] += up;
      else if (filter === 3) row[x] += (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - corner;
        const toLeft = Math.abs(guess - left), toUp = Math.abs(guess - up), toCorner = Math.abs(guess - corner);
        row[x] += toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
      } else if (filter !== 0) throw new Error(`a PNG row of filter ${filter}`);
    }
    rows.push(row);
    above = row;
  }
  return { width, height, colour, rows };
}

/** @param {string} type @param {Buffer} body */
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * @param {{ png: Buffer, skip?: number }[]} pictures
 * @returns {Buffer}
 */
export function stacked(pictures) {
  /** @type {Buffer[]} */
  const rows = [];
  let width = 0, colour = 0;
  for (const [index, { png, skip = 0 }] of pictures.entries()) {
    const picture = pixels(png);
    if (index === 0) ({ width, colour } = picture);
    if (picture.width !== width || picture.colour !== colour) {
      throw new Error(`picture ${index} is ${picture.width} wide of colour type ${picture.colour}, the first ${width} of ${colour}`);
    }
    rows.push(...picture.rows.slice(skip));
  }
  const stride = rows[0]?.length ?? 0;
  const filtered = Buffer.alloc(rows.length * (stride + 1));
  for (let y = 0; y < rows.length; y += 1) {
    const at = y * (stride + 1);
    filtered[at] = 2;
    for (let x = 0; x < stride; x += 1) filtered[at + 1 + x] = rows[y][x] - (y > 0 ? rows[y - 1][x] : 0);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rows.length, 4);
  header[8] = 8;
  header[9] = colour;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(filtered)), chunk('IEND', Buffer.alloc(0))]);
}
