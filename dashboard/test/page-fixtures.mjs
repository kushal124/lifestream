// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { esc } from '../public/lib/html.js';
import { namingBody } from '../public/ui/places/naming.js';
import { askLine, placeBody } from '../public/ui/places/place.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../../homelink/Tests/Fixtures/pages');
const CONTRACT = join(here, '../../packages/home/contract/pages.json');
const NAME = /^([A-Za-z]+)\.([a-z0-9-]+)\.json$/u;

/** @typedef {{ name: string, page: string, value: unknown }} Fixture */

/** @returns {Fixture[]} */
function fixtures() {
  if (!existsSync(FIXTURES)) return [];
  return readdirSync(FIXTURES).filter(name => name.endsWith('.json')).sort().map(name => {
    const page = NAME.exec(name)?.[1];
    assert.ok(page, `${name} is named <page>.<case>.json`);
    return { name, page, value: JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) };
  });
}

/**
 * @param {Fixture[]} answers
 * @returns {Record<string, string[]>}
 */
function typecheck(answers) {
  /** @type {Map<string, string>} */
  const virtual = new Map(answers.map((answer, index) => [join(here, `page-fixture-${index}.ts`),
    `import type { Pages } from '../public/pages.js';\nexport const answer: Pages[${JSON.stringify(answer.page)}] = ${JSON.stringify(answer.value)};\n`]));
  const options = { strict: true, noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const host = ts.createCompilerHost(options);
  const fromDisk = { getSourceFile: host.getSourceFile.bind(host), fileExists: host.fileExists.bind(host), readFile: host.readFile.bind(host) };
  host.getSourceFile = (file, language, ...rest) => {
    const text = virtual.get(file);
    return text === undefined ? fromDisk.getSourceFile(file, language, ...rest) : ts.createSourceFile(file, text, language);
  };
  host.fileExists = file => virtual.has(file) || fromDisk.fileExists(file);
  host.readFile = file => virtual.get(file) ?? fromDisk.readFile(file);
  const program = ts.createProgram([...virtual.keys()], options, host);
  /** @type {Record<string, string[]>} */
  const wrong = {};
  [...virtual.keys()].forEach((file, index) => {
    const source = /** @type {ts.SourceFile} */ (program.getSourceFile(file));
    wrong[answers[index].name] = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
      .map(each => ts.flattenDiagnosticMessageText(each.messageText, ' '));
  });
  return wrong;
}

const ROW = { id: 'person:0001', name: 'Person A', named: true, face: false, photo: null, when: { kind: 'month', month: '2026-10' }, line: null, find: ['person a'] };
const FIND = { position: '12:1763700000000', today: '2026-11-21', rows: [ROW], profiles: [] };

test('F1: every fixture of the home names a page of the contract and is what pages.d.ts says that page answers', () => {
  const pages = Object.keys(JSON.parse(readFileSync(CONTRACT, 'utf8')).pages);
  const all = fixtures();
  assert.deepEqual(all.filter(fixture => !pages.includes(fixture.page)).map(fixture => fixture.name), [], 'every fixture names a page');
  const wrong = typecheck(all);
  assert.deepEqual(Object.entries(wrong).filter(([, errors]) => errors.length > 0), [], 'every fixture typechecks');
});

test('F2: the typecheck takes a whole answer and refuses a missing nullable, an extra member, an unknown value and a when that is a number', () => {
  const { photo: _photo, ...noPhoto } = ROW;
  const wrong = typecheck([
    { name: 'whole', page: 'peopleFind', value: FIND },
    { name: 'no-photo', page: 'peopleFind', value: { ...FIND, rows: [noPhoto] } },
    { name: 'extra', page: 'peopleFind', value: { ...FIND, more: true } },
    { name: 'unknown-tag', page: 'peopleFind', value: { ...FIND, rows: [{ ...ROW, when: { kind: 'week', week: '2026-W47' } }] } },
    { name: 'when-zero', page: 'peopleFind', value: { ...FIND, rows: [{ ...ROW, when: 0 }] } },
  ]);
  assert.deepEqual(wrong.whole, []);
  for (const name of ['no-photo', 'extra', 'unknown-tag', 'when-zero']) assert.ok(wrong[name].length > 0, `${name} is refused`);
  assert.match(wrong['no-photo'].join(' '), /photo/u);
  assert.match(wrong.extra.join(' '), /more/u);
});

/** @param {string} name */
const fixture = name => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

/**
 * @param {import('../public/pages.js').HomeAsk} ask
 * @param {(today: string) => string} draw
 */
function drawsAsk(ask, draw) {
  assert.equal(ask.since.kind, 'day', 'the first night is a day');
  const since = ask.since.kind === 'day' ? ask.since.day : '';
  const today = new Date(Date.parse(`${since}T12:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  const weekday = new Date(`${since}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const drawn = draw(today);
  assert.ok(drawn.includes(esc('Is this home?')), 'the question is drawn');
  assert.ok(drawn.includes(esc(`${ask.line}, since ${weekday}.`)), `the words then the worded day: ${ask.line}, since ${weekday}.`);
}

test('F3: the Places page draws Is this home? from the asking fixtures, the words then the first night worded as a day', () => {
  /** @type {import('../public/pages.js').Places} */
  const places = fixture('places.asking.json');
  const spot = places.to_name.find(row => row.ask !== null);
  assert.ok(spot?.ask, 'places.asking holds a spot to name that asks');
  const ask = spot.ask;
  drawsAsk(ask, today => namingBody({ key: spot.key, typed: '', placeholder: '', ask: askLine(ask, today),
    photos: [], witnessed: spot.line, last: '', reach: null, rows: null, credit: false, error: '', refused: '' }));
  /** @type {import('../public/pages.js').Place} */
  const place = fixture('place.asking.json');
  assert.ok(place.ask_home, 'place.asking holds a place that asks');
  drawsAsk(place.ask_home, today => placeBody({ one: place, allVisits: false, rowOf: () => null, shown: { today, here: null, counting: false },
    now: Date.parse(`${today}T12:00:00Z`) }));
});
