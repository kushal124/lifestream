import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { pixels, stacked } from '../tools/png.mjs';

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
 * @param {Buffer[]} rows
 * @param {number} width
 * @param {number} pixel
 */
function encoded(rows, width, pixel) {
  const out = rows.map((row, y) => {
    const filter = y % 5;
    const above = y > 0 ? rows[y - 1] : Buffer.alloc(row.length);
    const line = Buffer.alloc(row.length + 1);
    line[0] = filter;
    for (let x = 0; x < row.length; x += 1) {
      const left = x >= pixel ? row[x - pixel] : 0, up = above[x], corner = x >= pixel ? above[x - pixel] : 0;
      const guess = left + up - corner;
      const paeth = Math.abs(guess - left) <= Math.abs(guess - up) && Math.abs(guess - left) <= Math.abs(guess - corner)
        ? left : Math.abs(guess - up) <= Math.abs(guess - corner) ? up : corner;
      line[x + 1] = row[x] - [0, left, up, (left + up) >> 1, paeth][filter];
    }
    return line;
  });
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(rows.length, 4);
  header[8] = 8;
  header[9] = pixel === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(out))), chunk('IEND', Buffer.alloc(0))]);
}

function picture(height, width, pixel, seed) {
  return Array.from({ length: height }, (_, y) => Buffer.from(Array.from({ length: width * pixel },
    (_, x) => (x * 37 + y * 101 + seed * 13 + ((x * y) >> 3)) % 256)));
}

test('windows stacked into one picture with their shared rows once', () => {
  for (const pixel of [3, 4]) {
    const width = 7;
    const page = picture(23, width, pixel, pixel);
    const windows = [page.slice(0, 10), page.slice(10, 20), page.slice(13, 23)];
    const png = stacked(windows.map((rows, index) => ({ png: encoded(rows, width, pixel), skip: index === 2 ? 7 : 0 })));
    const read = pixels(png);
    assert.equal(read.width, width);
    assert.equal(read.height, 23);
    assert.equal(read.colour, pixel === 4 ? 6 : 2);
    assert.deepEqual(read.rows, page);
  }
});

test('pictures that do not stack refused', () => {
  const rows = picture(5, 4, 4, 1);
  assert.throws(() => stacked([{ png: encoded(rows, 4, 4) }, { png: encoded(picture(5, 3, 4, 1), 3, 4) }]), /3 wide/u);
  assert.throws(() => stacked([{ png: encoded(rows, 4, 4) }, { png: encoded(picture(5, 4, 3, 1), 4, 3) }]), /colour type 2/u);
  assert.throws(() => stacked([{ png: Buffer.from('not a picture') }]), /not a PNG/u);
});
