// @ts-check
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pixels, stacked } from './png.mjs';

const [main, lane, out = join(dirname(fileURLToPath(import.meta.url)), '..', '.build', 'shot-diff')] = process.argv.slice(2);
if (!main || !lane) {
  console.error('usage: node dashboard/tools/shot-diff.mjs <main\'s shots> <the lane\'s shots> [<out>]');
  process.exit(1);
}

/**
 * @param {string} root
 * @returns {string[]}
 */
const shots = root => readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(path => path.endsWith('.png')).sort();

const before = new Set(shots(main));
const after = new Set(shots(lane));
const changed = [];
for (const path of [...before].filter(each => after.has(each))) {
  const [old, now] = [readFileSync(join(main, path)), readFileSync(join(lane, path))];
  if (old.equals(now)) continue;
  const [a, b] = [pixels(old), pixels(now)];
  if (a.width !== b.width || a.colour !== b.colour) {
    changed.push(`${path} (${a.width} wide → ${b.width} wide, not drawn)`);
    continue;
  }
  const pair = join(out, path);
  mkdirSync(dirname(pair), { recursive: true });
  writeFileSync(pair, stacked([{ png: old }, { png: now }]));
  changed.push(path);
}
const gone = [...before].filter(each => !after.has(each));
const added = [...after].filter(each => !before.has(each));
for (const [title, paths] of /** @type {const} */ ([['changed', changed], ['only in main', gone], ['only in the lane', added]])) {
  if (paths.length) console.log(`${title}:\n${paths.map(path => `  ${path}`).join('\n')}`);
}
console.log(changed.length ? `${changed.length} changed; the pairs, main's above the lane's, in ${relative(process.cwd(), resolve(out)) || '.'}`
  : 'no shot changed');
