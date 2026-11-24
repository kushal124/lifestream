import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bundledProgram } from '../../testing/program.mjs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { until } from './until.mjs';
import { openDoor } from '../lib/door.mjs';
import { boundedQueries, lifeReader, QUERY_BYTES } from '../lib/life.mjs';
import { facesReader } from '../lib/faces.mjs';
import { clockFor } from './stand-ins/clock.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const summary = { acts: [] };
let child;
let home;
let dashboard;
let dir;
let url;
const waiting = [];

async function command(cmd) {
  const answer = new Promise(done => waiting.push(done));
  child.stdin.write(`${JSON.stringify({ cmd })}\n`);
  const line = await answer;
  assert.equal(line.ok, true, line.error);
  return line.value;
}

async function read(path, expected = 200) {
  const response = await fetch(`${url}${path}`);
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}

async function fromDoor(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${home.url}${path}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${home.tokens.dashboard}` } });
  assert.equal(response.status, 200);
  return response.json();
}

async function settledDeck(what = 'the deck read whole', ready = () => true) {
  return until(what, async () => {
    const deck = await read('/api/faces');
    return deck.ready && !deck.building && !deck.people_building && ready(deck) ? deck : undefined;
  });
}

const KINDS = ['person', 'face', 'photo', 'details'];

async function stated() {
  const held = new Map();
  for (const kind of KINDS) {
    for (const each of (await fromDoor('/v1/records', { source: home.faces.people_source, kind, limit: '1024' })).records) {
      held.set(`${kind}/${each.key}`, { kind, key: each.key, version: each.head.version, content: each.content });
    }
  }
  return held;
}

function statedBetween(before, after) {
  const made = [...after].filter(([at, now]) => before.get(at)?.version !== now.version)
    .map(([, { kind, key, content }]) => ({ kind, key, content }));
  const gone = [...before].filter(([at]) => !after.has(at)).map(([, { kind, key }]) => ({ kind, key, gone: true }));
  return [...made, ...gone].sort((left, right) => KINDS.indexOf(left.kind) - KINDS.indexOf(right.kind) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
}

async function act(action, expected = 200, request = randomUUID()) {
  const before = expected === 200 ? await stated() : null;
  const response = await fetch(`${url}/api/owner/act`, {
    method: 'POST', body: JSON.stringify({ of: 'people', ...action, request }), headers: { 'content-type': 'application/json', 'x-viewer-request': '1' },
  });
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  if (before === null) return body;
  const answer = { ...body, statements: statedBetween(before, await stated()) };
  summary.acts.push({ action, statements: answer.statements, payoff: body.payoff });
  return answer;
}

const facesOf = tag => Object.values(home.faces.faces).flat().filter(face => face.tag === tag && !face.maybe).map(face => face.face).sort();
const faceOf = (photo, tag) => home.faces.faces[photo].find(face => face.tag === tag).face;
const cardOf = (deck, face) => deck.cards.find(card => card.sample.includes(face));
const sorted = list => [...list].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
const OWNER = 'phone:+15550000009';
const record = (slug, given) => ({ type: 'people.person', slug, name: null, full_name: null, show: 'name', entity: null, relationship: null,
  hidden: false, me: false, anchor: null, handles: [], excluded: [], dismissed: [], also_called: [], merged_into: null, ...given });

before(async () => {
  child = spawn(process.execPath, [...bundledProgram(join('packages', 'home', 'test', 'dashboard-home.ts')), 'faces'], {
    cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  home = await new Promise((done, fail) => {
    child.once('exit', code => fail(new Error(`the synthetic home exited with ${code}`)));
    lines.on('line', text => {
      const line = JSON.parse(text);
      if (line.ready) done(line);
      else waiting.shift()?.(line);
    });
  });
  dir = await mkdtemp(join(tmpdir(), 'dashboard-faces-'));
  dashboard = await createViewer({ door: openDoor({ url: home.url, token: () => home.tokens.dashboard }) });
  await new Promise(done => dashboard.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${dashboard.address().port}`;
});

after(async () => {
  await new Promise(done => dashboard?.close(done));
  if (child) await command('stop').catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
  const out = join(tmpdir(), 'lifestream-e2e');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'dashboard-faces.json'), `${JSON.stringify(summary, null, 2)}\n`);
});

test('F1 F5 F6: the deck, a crop and the write read other than the home holds or lets', async () => {
  const deck = await settledDeck();
  for (const gone of ['facts', 'named', 'talkers', 'stop_below']) assert.equal(gone in deck, false, gone);
  for (const card of deck.cards) assert.deepEqual(Object.keys(card).sort(), ['faces', 'id', 'photos', 'sample', 'suggestions', 'sure', 'year_count', 'years']);
  assert.equal(deck.cards.length, 6);
  assert.equal(cardOf(deck, faceOf('c1', 5)), undefined);
  assert.equal(cardOf(deck, faceOf('z1', 8)), undefined);
  assert.deepEqual(deck.owner, { id: OWNER, name: '+15550000009' });
  const mine = cardOf(deck, faceOf('o1', 1));
  assert.deepEqual(mine.suggestions.map(each => [each.key, each.name, each.reason, each.target, each.you, each.face]),
    [[OWNER, '+15550000009', 'the person your own accounts belong to', { kind: 'person', id: OWNER }, true, null]]);
  assert.equal(mine.photos, 8);
  assert.equal(deck.cards.filter(card => card.suggestions.some(each => each.you || each.key === OWNER)).length, 1);
  const a = cardOf(deck, faceOf('a1', 2));
  assert.deepEqual(a.suggestions.map(each => [each.name, each.reason, each.target]), [
    ['Person A', 'sent you 3\u00a0photos with this face', { kind: 'person', id: 'phone:+15550000001' }]]);
  assert.deepEqual(a.suggestions[0].channels, [{ network: 'whatsapp', messages: 15 }]);
  const b = cardOf(deck, faceOf('b1', 3));
  assert.deepEqual([b.suggestions[0].name, b.suggestions[0].reason, b.suggestions[0].target],
    ['Person B', 'named “Person B” in your photos’ labels', { kind: 'person', id: 'person:person-b' }]);
  assert.deepEqual(cardOf(deck, faceOf('s1', 4)).suggestions.map(each => [each.key, each.target]),
    [['new:person e', { kind: 'new', name: 'Person E' }]]);
  assert.deepEqual(deck.cards.filter(card => card.sure).map(card => card.id), []);
  const order = deck.cards.map(card => card.id);
  assert.ok(order.indexOf(a.id) < order.indexOf(b.id) && order.indexOf(mine.id) < order.indexOf(b.id), order.join(' '));
  const group = await read(`/api/faces/group?id=${encodeURIComponent(a.id)}`);
  assert.deepEqual({ ...group, every: undefined, crops: undefined, times: undefined }, { ...a, every: undefined, crops: undefined, times: undefined });
  assert.deepEqual(group.every.slice().sort(), facesOf(2));
  assert.deepEqual(Object.keys(group.times).sort(), [...new Set(group.every.map(face => face.split(':')[0]))].sort());
  assert.ok(Object.values(group.times).every(at => typeof at === 'number'), JSON.stringify(group.times));
  await read('/api/faces/group?id=nothing', 404);
  const clusters = new Map((await fromDoor('/v1/records', { source: home.faces.faces_source, kind: 'cluster' })).records
    .map(each => [each.key, each.content]));
  const byTime = faces => [...faces].sort((left, right) => left.at_ms - right.at_ms || (left.face < right.face ? -1 : 1)).map(each => each.face);
  assert.deepEqual(group.every.slice().sort(), clusters.get(a.id).faces.map(each => each.face).sort());
  assert.deepEqual(mine.sample, byTime(clusters.get(mine.id).faces));
  for (const face of [...a.sample, faceOf('a1', 2), ...group.every]) {
    const scan = await fromDoor('/v1/record', { source: home.faces.faces_source, kind: 'scan', key: face.split(':')[0] });
    const at = scan.version.content.faces.findIndex(each => `${face.split(':')[0]}:${each.box.map(Math.round).join(',')}` === face);
    const crop = scan.version.content.faces[at].crop;
    assert.equal(group.crops[face] ?? null, crop, face);
    if (a.sample.includes(face)) assert.equal(deck.crops[face] ?? null, crop, face);
  }
  const face = /** @type {string} */ (group.every.find(each => group.crops[each]));
  const asked = new URLSearchParams({ size: 'tile', recipe: '2' });
  const picture = await fetch(`${url}/api/life/picture?${new URLSearchParams({ hash: group.crops[face], size: 'tile', recipe: '2' })}`);
  const door = await fetch(`${home.url}/v1/pictures/${group.crops[face]}?${asked}`, { headers: { authorization: `Bearer ${home.tokens.dashboard}` } });
  const [passed, held] = await Promise.all([picture, door].map(async answer => Buffer.from(await answer.arrayBuffer())));
  assert.equal(picture.status, door.status);
  if (door.ok) {
    assert.equal(picture.headers.get('content-type'), door.headers.get('content-type'));
    assert.deepEqual(passed, held);
  }
  assert.equal((await fetch(`${url}/api/life/picture?${new URLSearchParams({ hash: group.crops[face], size: 'original' })}`)).status, 400);
  assert.equal((await fetch(`${url}/api/faces/crop?face=${encodeURIComponent(face)}`)).status, 404);
  const bare = await fetch(`${url}/api/owner/act`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(bare.status, 403);
  assert.equal((await fetch(`${url}/api/faces/act`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-viewer-request': '1' } })).status, 404);
  summary.deck = { owner: deck.owner, cards: deck.cards.map(card => ({ id: card.id, photos: card.photos, sure: card.sure, suggestions: card.suggestions.map(each => each.reason) })) };
});

test('F2 F3 F4: a first run states other than the README says, or the home does not name the faces', async () => {
  let deck = await settledDeck();

  const a = cardOf(deck, faceOf('a1', 2));
  const far = faceOf('a5', 2);
  const named = await act({ kind: 'name', cluster: a.id, target: a.suggestions[0].target, out: [far] });
  const [person, ...faces] = named.statements;
  assert.deepEqual(person, { kind: 'person', key: 'person-a', content: record('person-a', { anchor: { kind: 'phone', value: '+15550000001' } }) });
  assert.equal(named.id, 'person:person-a');
  assert.deepEqual(sorted(faces), facesOf(2).map(key => ({ kind: 'face', key, content: key === far ? { is_not: ['person-a'] } : { is: 'person-a' } })));
  assert.deepEqual(named.payoff, { slug: 'person-a', name: 'Person A', photos: 6, days: 6 });

  await command('settle');
  deck = await settledDeck('the deck sure of tag 6 as Person A', fresh => cardOf(fresh, faceOf('x1', 6))?.sure);
  const also = cardOf(deck, faceOf('x1', 6));
  assert.deepEqual([also.suggestions[0].key, also.suggestions[0].reason], ['person:person-a', 'looks like Person A in 6\u00a0named photos']);
  assert.ok(facesOf(2).includes(also.suggestions[0].face), 'a face of theirs to show');
  const two = cardOf(deck, faceOf('y1', 7));
  assert.deepEqual([two.sure, two.suggestions[0].key], [false, 'person:person-a']);
  const yes = await act({ kind: 'name', cluster: also.id, target: also.suggestions[0].target });
  assert.deepEqual(sorted(yes.statements), facesOf(6).map(key => ({ kind: 'face', key, content: { is: 'person-a' } })));
  assert.equal(yes.payoff.photos, 9);

  const b = cardOf(deck, faceOf('b1', 3));
  const nameB = await act({ kind: 'name', cluster: b.id, target: b.suggestions[0].target });
  assert.deepEqual(sorted(nameB.statements), facesOf(3).map(key => ({ kind: 'face', key, content: { is: 'person-b' } })));

  const stranger = cardOf(deck, faceOf('s1', 4));
  const marked = faceOf('s3', 4);
  const ignored = await act({ kind: 'ignore', cluster: stranger.id, out: [marked] });
  const aside = facesOf(4).filter(key => key !== marked);
  assert.deepEqual(sorted(ignored.statements), aside.map(key => ({ kind: 'face', key, content: { ignore: true } })));
  const undone = await act({ kind: 'undo', act: ignored.act });
  assert.deepEqual(sorted(undone.statements), aside.map(key => ({ kind: 'face', key, gone: true })));
  await act({ kind: 'undo', act: ignored.act }, 409);

  await command('settle');
  const said = (await fromDoor('/v1/records', { source: home.faces.people_source, kind: 'face', limit: '1024' })).records;
  const expected = new Map([
    ...facesOf(2).map(key => [key, key === far ? { is_not: ['person-a'] } : { is: 'person-a' }]),
    ...facesOf(6).map(key => [key, { is: 'person-a' }]), ...facesOf(3).map(key => [key, { is: 'person-b' }]),
  ]);
  assert.deepEqual(new Map(said.map(each => [each.key, each.content])), expected);
  const persons = (await fromDoor('/v1/records', { source: home.faces.people_source, kind: 'person' })).records.map(each => each.key);
  assert.deepEqual(persons, ['person-a', 'person-b']);
  const records = (await fromDoor('/v1/records', { source: home.faces.faces_source, kind: 'named' })).records;
  const who = new Map(records.flatMap(each => each.content.photos.map(photo => [photo.face, each.key])));
  for (const [tag, slug] of [[1, ''], [3, 'person-b'], [6, 'person-a'], [4, ''], [5, ''], [7, '']]) {
    for (const key of facesOf(tag)) assert.equal(who.get(key) ?? '', slug, `tag ${tag}`);
  }
  for (const key of facesOf(2)) assert.equal(who.get(key) ?? '', key === far ? '' : 'person-a');

  deck = await settledDeck('the stranger back and tag 6 named', fresh => cardOf(fresh, faceOf('s1', 4)) !== undefined && cardOf(fresh, faceOf('x1', 6)) === undefined);
  assert.equal(cardOf(deck, faceOf('b1', 3)), undefined);
  assert.equal(cardOf(deck, faceOf('o1', 1)).suggestions[0].you, true);
  summary.final = { people: said, persons, named: records.map(each => ({ person: each.key, faces: each.content.photos.map(photo => photo.face) })) };
});

test('F24: a person\'s likely groups, and a confirm\'s groups theirs and not, other than the deck says', async () => {
  let deck = await settledDeck();
  const likely = (/** @type {string} */ id) => read(`/api/faces/likely?id=${encodeURIComponent(id)}`);
  const theirsOn = (/** @type {any} */ card) => card.suggestions.find(each => each.key === 'person:person-a');
  const expected = deck.cards.filter(theirsOn).map(card => ({
    id: card.id, faces: card.faces, photos: card.photos, years: card.years, sample: card.sample, reason: theirsOn(card).reason,
    crops: Object.fromEntries(card.sample.filter(face => deck.crops[face]).map(face => [face, deck.crops[face]])),
  }));
  const seven = cardOf(deck, faceOf('y1', 7));
  assert.ok(expected.some(group => group.id === seven.id), 'tag 7, which the engine says looks like them');
  assert.deepEqual(await likely('person:person-a'), { groups: expected });
  assert.deepEqual(await likely('phone:+15550000001'), { groups: expected });

  const theirs = await act({ kind: 'confirm', id: 'person:person-a', groups: [seven.id] });
  assert.deepEqual(sorted(theirs.statements), facesOf(7).map(key => ({ kind: 'face', key, content: { is: 'person-a' } })));
  deck = await settledDeck();
  assert.equal(cardOf(deck, faceOf('y1', 7)), undefined);
  assert.equal((await likely('person:person-a')).groups.some(group => group.id === seven.id), false);
  await act({ kind: 'undo', act: theirs.act });
  await command('settle');
  deck = await settledDeck('tag 7 back in the deck', fresh => cardOf(fresh, faceOf('y1', 7)) !== undefined);
  await act({ kind: 'confirm', id: 'person:person-a', relationship: 'friend', groups: ['no-such-group'] }, 409);
  summary.likely = { person: 'person:person-a', groups: expected.map(group => [group.id, group.reason]) };
});

test('F7 F17: the owner split, You, a label two people share, the search by one-to-one chats', async () => {
  await command('faces-people');
  let deck = await settledDeck('the owner Person Zero and Person C to search', fresh => fresh.owner?.name === 'Person Zero' && fresh.someone.some(each => each.name === 'Person C')
    && fresh.someone.some(each => each.id === 'person:person-zero' && each.named === 2));
  const mine = cardOf(deck, faceOf('o1', 1));
  const you = mine.suggestions[0];
  assert.deepEqual([you.key, you.name, you.you, 'merge' in you, you.reason, mine.sure], [OWNER, 'Person Zero', true, false, 'the person your own accounts belong to', false]);
  assert.equal(mine.suggestions.filter(each => each.you || each.key === OWNER).length, 1);
  for (const card of deck.cards) if (card !== mine) assert.ok(!card.suggestions.some(each => each.you || each.key === OWNER), card.id);
  assert.deepEqual(cardOf(deck, faceOf('s1', 4)).suggestions.map(each => each.target.id).sort(), ['phone:+15550000005', 'phone:+15550000006']);
  assert.deepEqual(cardOf(deck, faceOf('y1', 7)).suggestions.map(each => each.key), ['person:person-a', 'person:person-zero']);
  const listed = new Map((await fromDoor('/v1/people')).people.map(each => [each.name, each]));
  const inChats = (/** @type {{ chats: { count: number }[] }} */ person) => person.chats.reduce((total, chat) => total + chat.count, 0);
  assert.ok(inChats(listed.get('Person C')) > listed.get('Person A').received + listed.get('Person A').sent);
  assert.equal(listed.get('Person C').received, 0, 'a group the owner never writes in counts toward no one');
  const names = deck.someone.map(each => each.name);
  assert.ok(names.indexOf('Person A') < names.indexOf('Person C'), names.join(', '));
  const c = deck.someone.find(each => each.name === 'Person C');
  assert.deepEqual([c.messages, c.channels, c.groups_only], [0, [], true]);
  const a = deck.someone.find(each => each.name === 'Person A');
  assert.deepEqual([a.messages, 'groups_only' in a], [15, false]);
  assert.deepEqual([deck.someone.find(each => each.id === 'person:person-zero')?.named, 'named' in c], [2, false]);

  const taken = await act({ kind: 'name', cluster: mine.id, target: you.target });
  const [made, ...faces] = taken.statements;
  assert.deepEqual(made, { kind: 'person', key: 'person-zero-2', content: record('person-zero-2', { anchor: { kind: 'phone', value: '+15550000009' }, me: true }) });
  assert.deepEqual(sorted(faces), facesOf(1).map(key => ({ kind: 'face', key, content: { is: 'person-zero-2' } })));
  assert.equal(taken.payoff.photos, 8);
  deck = await settledDeck();
  assert.equal(cardOf(deck, faceOf('o1', 1)), undefined);
  assert.equal(deck.cards.some(card => card.suggestions.some(each => each.you)), false);

  const undone = await act({ kind: 'undo', act: taken.act });
  assert.deepEqual(undone.statements.filter(each => each.kind === 'person'), []);
  assert.deepEqual(sorted(undone.statements.filter(each => each.kind === 'face')), facesOf(1).map(key => ({ kind: 'face', key, gone: true })));
  deck = await settledDeck('You on the owner\'s group again', fresh => cardOf(fresh, faceOf('o1', 1))?.suggestions[0]?.you === true);
  const notMe = await act({ kind: 'maybe', id: OWNER, yes: [], no: facesOf(1) });
  await settledDeck('You off the group said not the owner', fresh => !(cardOf(fresh, faceOf('o1', 1))?.suggestions ?? []).some(each => each.you));
  await act({ kind: 'undo', act: notMe.act });
  await command('settle');
  deck = await settledDeck('You on the owner\'s group once more', fresh => cardOf(fresh, faceOf('o1', 1))?.suggestions[0]?.you === true);
  const once = cardOf(deck, faceOf('o1', 1));

  await act({ kind: 'name', cluster: once.id, target: once.suggestions[0].target });
  await command('settle');
  const one = await fromDoor('/v1/people', { id: 'me' });
  assert.deepEqual([one.person.id, one.person.me], ['person:person-zero-2', true]);
  deck = await settledDeck('the owner person-zero-2', fresh => fresh.owner?.id === 'person:person-zero-2');
  assert.equal(deck.cards.some(card => card.suggestions.some(each => each.you)), false);
  summary.owner = { you, taken: taken.statements.filter(each => each.kind === 'person'), after: deck.owner };
});

test('F8: a labels request too long for the door: every request the dashboard makes stays within it', async () => {
  const ids = Array.from({ length: 300 }, (_, index) => `synthetic-person-${String(index).padStart(4, '0')}-with-a-long-address@example.com`);
  const chats = ids.map(id => `imessage:${id}`);
  const whole = new URLSearchParams([...ids.slice(0, 256).map(id => ['id', id]), ...chats.slice(0, 256).map(chat => ['chat', chat])]).toString();
  const refused = await fetch(`${home.url}/v1/labels?${whole}`, { headers: { authorization: `Bearer ${home.tokens.dashboard}` } });
  assert.equal(refused.status, 431);
  const queries = boundedQueries({ id: ids, chat: chats, point: [] });
  assert.ok(queries.length > 1);
  assert.deepEqual(queries.flatMap(query => query.id), ids);
  assert.deepEqual(queries.flatMap(query => query.chat), chats);
  for (const query of queries) {
    const text = new URLSearchParams(Object.entries(query).flatMap(([name, values]) => values.map(value => [name, value]))).toString();
    assert.ok(text.length <= QUERY_BYTES, `${text.length} bytes`);
    const answer = await fetch(`${home.url}/v1/labels?${text}`, { headers: { authorization: `Bearer ${home.tokens.dashboard}` } });
    assert.equal(answer.status, 200);
  }
  summary.labels = { refused: refused.status, requests: queries.length, bytes: whole.length };
});

test('F9: a page waits on a read of the faces, or two reads run at once', async () => {
  const real = openDoor({ url: home.url, token: () => home.tokens.dashboard });
  let reading = 0;
  let most = 0;
  /** @type {() => void} */
  let release = () => undefined;
  const held = new Promise(done => (release = () => done(undefined)));
  const slow = {
    ...real,
    follow: () => () => undefined,
    /** @type {typeof real.each} */
    each: async (path, params, member, visit) => {
      if (String(params.source).startsWith('people:')) return real.each(path, params, member, visit);
      reading++;
      most = Math.max(most, reading);
      try {
        await held;
        return await real.each(path, params, member, visit);
      } finally {
        reading--;
      }
    },
  };
  const faces = facesReader(slow, lifeReader(slow));
  try {
    const first = await faces.deck();
    await until('the faces\' read begun', async () => reading > 0);
    const asked = [first];
    for (let request = 0; request < 3; request++) asked.push(await faces.deck());
    assert.deepEqual(asked.map(deck => [deck.ready, deck.building]), asked.map(() => [false, true]));
    assert.equal(most, 1);
    release();
    await until('the deck read', async () => (await faces.deck()).ready);
    assert.equal(most, 1);
    summary.waits = { requests: asked.length, progress: first.progress };
  } finally {
    release();
    real.close();
  }
});

async function wrapped({ serve = true } = {}) {
  const real = openDoor({ url: home.url, token: () => home.tokens.dashboard });
  /** @type {string[]} */
  const reads = [];
  /** @type {((message: any) => void)[]} */
  const listeners = [];
  let lose = false;
  const door = {
    ...real,
    follow: listener => {
      listeners.push(listener);
      real.follow(() => undefined);
      return () => undefined;
    },
    each: (path, params, member, visit) => {
      if (path === '/v1/records') reads.push(`${String(params.source).split(':')[0]}:${params.kind}`);
      return real.each(path, params, member, visit);
    },
    act: async (path, body, given) => {
      const answer = await real.act(path, body, given);
      if (!lose) return answer;
      lose = false;
      throw Object.assign(new Error('Can\'t reach Lifestream.'), { status: 503, refused: false });
    },
  };
  const life = lifeReader(door);
  const faces = facesReader(door, life);
  const viewer = serve ? await createViewer({ door }) : null;
  if (viewer) await new Promise(done => viewer.listen(0, '127.0.0.1', done));
  const at = viewer ? `http://127.0.0.1:${viewer.address().port}` : '';
  return {
    faces, reads,
    close: () => (viewer ? new Promise(done => viewer.close(done)) : Promise.resolve()).finally(() => real.close()),
    hear: message => listeners.forEach(listener => listener(message)),
    loseNext: () => { lose = true; },
    act: async (action, request = randomUUID()) => {
      const response = await fetch(`${at}/api/owner/act`, {
        method: 'POST', body: JSON.stringify({ of: 'people', ...action, request }), headers: { 'content-type': 'application/json', 'x-viewer-request': '1' },
      });
      return { status: response.status, ...(await response.json()) };
    },
    settled: () => until('the deck read whole', async () => {
      const deck = await faces.deck();
      return deck.ready && !deck.building && !deck.people_building ? deck : undefined;
    }),
  };
}

test('F10: an undo lost to a restart, or one that is not the home\'s last action taken', async () => {
  const first = await wrapped();
  const restarted = await wrapped();
  try {
    const deck = await restarted.settled();
    const four = cardOf(deck, faceOf('s1', 4));
    const ignored = await first.act({ kind: 'ignore', cluster: four.id });
    assert.equal(ignored.status, 200, JSON.stringify(ignored));
    assert.deepEqual((await restarted.act({ kind: 'undo', act: 'people:local:nothing/20261008T120000.000Z.000000000000' })).code, 'NOT_LAST');
    const undone = await restarted.act({ kind: 'undo', act: ignored.act });
    assert.equal(undone.status, 200, JSON.stringify(undone));
    assert.equal((await first.act({ kind: 'undo', act: ignored.act })).status, 409);
    const was = (await fromDoor('/v1/people', { id: 'person:person-b' })).person.relationship;
    const edited = await first.act({ kind: 'confirm', id: 'person:person-b', relationship: 'colleague' });
    const later = await restarted.act({ kind: 'ignore', cluster: four.id });
    const refused = await first.act({ kind: 'undo', act: edited.act });
    assert.deepEqual([refused.status, refused.code], [409, 'NOT_LAST']);
    assert.equal((await restarted.act({ kind: 'undo', act: later.act })).status, 200);
    assert.equal((await first.act({ kind: 'confirm', id: 'person:person-b', relationship: was })).status, 200);
    await command('settle');
    summary.ids = [ignored.act, edited.act, later.act];
  } finally {
    await first.close();
    await restarted.close();
  }
});

test('F11: an answer lost on the way said other than OUTCOME_UNKNOWN, or sent again landing twice', async () => {
  const one = await wrapped();
  try {
    const deck = await one.settled();
    const seven = cardOf(deck, faceOf('y1', 7));
    const before = await stated();
    const request = randomUUID();
    one.loseNext();
    const lost = await one.act({ kind: 'ignore', cluster: seven.id }, request);
    assert.deepEqual([lost.status, lost.code, lost.again, lost.began], [503, 'OUTCOME_UNKNOWN', true, false]);
    const landed = statedBetween(before, await stated());
    assert.deepEqual(sorted(landed), facesOf(7).map(key => ({ kind: 'face', key, content: { ignore: true } })));
    const again = await one.act({ kind: 'ignore', cluster: seven.id }, request);
    assert.equal(again.status, 200, JSON.stringify(again));
    const mid = await stated();
    assert.deepEqual(statedBetween(before, mid), landed);
    assert.equal((await one.act({ kind: 'undo', act: again.act })).status, 200);
    assert.deepEqual(sorted(statedBetween(mid, await stated())), facesOf(7).map(key => ({ kind: 'face', key, gone: true })));
    assert.equal((await one.act({ kind: 'undo', act: again.act })).status, 409);
    const free = createServer();
    await new Promise(done => free.listen(0, '127.0.0.1', () => done(undefined)));
    const port = /** @type {import('node:net').AddressInfo} */ (free.address()).port;
    await new Promise(done => free.close(() => done(undefined)));
    const closed = openDoor({ url: `http://127.0.0.1:${port}`, token: () => home.tokens.dashboard });
    const nowhere = await createViewer({ door: closed });
    await new Promise(done => nowhere.listen(0, '127.0.0.1', done));
    try {
      const response = await fetch(`http://127.0.0.1:${nowhere.address().port}/api/owner/act`, { method: 'POST',
        body: JSON.stringify({ of: 'people', kind: 'ignore', cluster: seven.id, request: randomUUID() }), headers: { 'content-type': 'application/json', 'x-viewer-request': '1' } });
      assert.deepEqual([response.status, (await response.json()).code], [503, 'NOT_NOW']);
    } finally {
      await new Promise(done => nowhere.close(done));
    }
    await command('settle');
  } finally {
    await one.close();
  }
});

test('F12: the owner\'s delivery reads the labeler\'s records again, or the labeler\'s reads the owner\'s', async () => {
  const one = await wrapped({ serve: false });
  try {
    await one.settled();
    const deliveries = deliveryOf => ({ kind: 'event', id: '1', data: { seq: 1, at_ms: 0, kind: 'import', key: `${deliveryOf}/20261008T120000.000Z`, detail: {} } });
    one.reads.length = 0;
    one.hear(deliveries(home.faces.people_source));
    await until('the deck\'s read of the owner\'s records and faces', async () => one.reads.length >= 2);
    await one.settled();
    assert.deepEqual(one.reads, ['people:person', 'people:face']);
    one.reads.length = 0;
    one.hear(deliveries(home.faces.faces_source));
    await until('the labeler\'s clusters, names and maybes read', async () => one.reads.length >= 3);
    await one.settled();
    assert.deepEqual(one.reads, ['faces:cluster', 'faces:named', 'faces:maybe']);
    one.reads.length = 0;
    one.hear({ kind: 'reset', id: '2:1790000000000', data: { seq: 2, at_ms: 1790000000000 } });
    await until('every record read again', async () => one.reads.length >= 5);
    await one.settled();
    assert.deepEqual(one.reads.sort(), ['faces:cluster', 'faces:maybe', 'faces:named', 'people:face', 'people:person']);
    const deck = await one.settled();
    const card = deck.cards.find(each => each.suggestions.length > 0);
    one.reads.length = 0;
    const named = await act({ kind: 'ignore', cluster: card.id });
    one.faces.acted(named.position);
    assert.equal((await one.faces.deck()).cards.some(each => each.id === card.id), false, 'the deck made from the word before the answer');
    assert.deepEqual(one.reads, ['people:person', 'people:face']);
    await act({ kind: 'undo', act: named.act });
    await command('settle');
    summary.reads = { people: ['people:face', 'people:person'], faces: ['faces:cluster', 'faces:maybe', 'faces:named'] };
  } finally {
    await one.close();
  }
});

test('F13: a read that fails is tried again at once, against the door, over and over', async () => {
  const real = openDoor({ url: home.url, token: () => home.tokens.dashboard });
  let asked = 0;
  const empty = { ...real, follow: () => () => undefined, all: async (path, params, member) => {
    if (params.product === 'faces') asked++;
    const answer = await real.all(path, params, member);
    return { ...answer, items: answer.items.filter(row => row.product !== 'faces') };
  } };
  try {
    const faces = facesReader(empty, lifeReader(empty), { now: () => 0 });
    const deck = await until('the failed read\'s deck', async () => {
      const answer = await faces.deck();
      return answer.error ? answer : undefined;
    });
    assert.deepEqual([deck.ready, deck.building, /no faces yet/u.test(deck.error)], [false, false, true]);
    assert.deepEqual(await faces.likely('phone:+15550000001'), { groups: [] });
    await fromDoor('/v1/counts', { source: home.faces.faces_source, kind: 'image' });
    assert.equal(asked, 1);
  } finally {
    real.close();
  }
});

/**
 * @param {[string, number, number, { person: string, score: number }[]][]} groups
 * @param {Record<string, number>} named
 * @param {() => any[]} people
 * @param {{ maybe?: Record<string, string[]>, said?: Record<string, any> }} [more]
 */
function standIn(groups, named, people, { maybe = {}, said = {} } = {}) {
  const key = (/** @type {number} */ n) => `${n.toString(16).padStart(64, '0')}:1,2,3,4`;
  /** @type {Record<string, { key: string, content: any }[]>} */
  const records = { cluster: [], named: [], maybe: [] };
  let n = 0;
  const face = () => {
    const at = ++n;
    return { face: key(at), at_ms: Date.UTC(2020, 0, 1) + at * 86_400_000, crop: `sha256:${at.toString(16).padStart(64, 'c')}` };
  };
  for (const [id, photos, years, suggested] of groups) {
    const faces = Array.from({ length: photos }, face);
    records.cluster.push({ key: id, content: { size: photos, photos, years: [2020, 2019 + years], year_count: years, faces, outliers: [],
      chat_share: 0, suggested, evidence: { senders: [], labels: [] } } });
  }
  for (const [slug, photos] of Object.entries(named)) {
    const faces = Array.from({ length: photos }, face).reverse().map(each => ({ ...each, camera: true, tier: 'seed', size: 200 }));
    records.named.push({ key: slug, content: { photos: faces, labels: [] } });
  }
  for (const [slug, faces] of Object.entries(maybe)) records.maybe.push({ key: slug, content: { faces: faces.map(each => ({ face: each, score: 0.5, crop: null })) } });
  const word = { person: [], face: Object.entries(said).map(([key, content]) => ({ key, content })) };
  /** @type {((message: any) => void)[]} */
  const listeners = [];
  const door = /** @type {any} */ ({
    follow: (/** @type {(message: any) => void} */ listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    position: () => null,
    all: async () => ({ position: 'p1', items: [{ id: 'faces:local:macbook-pro-0001', product: 'faces' }] }),
    json: async () => ({ counts: { cluster: records.cluster.length, named: records.named.length, maybe: records.maybe.length } }),
    each: async (/** @type {string} */ _path, /** @type {any} */ params, /** @type {string} */ _member, /** @type {any} */ visit) => {
      visit((String(params.source).startsWith('people:') ? word : records)[params.kind]);
      return 'p1';
    },
  });
  let last = /** @type {any[] | null} */ (null);
  let position = 0;
  /** @type {any} */
  let clock = clockFor('UTC', 4, { first: '2019-12-01', last: '2020-12-31' });
  const life = /** @type {any} */ ({
    clockNow: () => clock,
    peopleNow: () => {
      const listed = people();
      if (listed !== last) [last, position] = [listed, position + 1];
      return { people: listed.filter(each => !each.me), you: listed.find(each => each.me) ?? null, chats: [], position: String(position) };
    },
    person: async () => ({ person: { days: {} } }),
    ownerSource: async () => 'people:local:macbook-pro-0001',
  });
  const faces = facesReader(door, life);
  const deck = () => until('the stand-in\'s deck read', async () => {
    const answer = await faces.deck();
    return answer.ready ? answer : undefined;
  });
  return Object.assign(deck, { faces, records, clocked: (/** @type {any} */ next) => { clock = next; },
    /** @param {any} message */
    tell: (/** @type {any} */ message) => listeners.forEach(listener => listener(message)) });
}

test('F18: a group under ten photos before one of ten or more', async () => {
  const deck = await standIn([['ten', 10, 1, []], ['nine', 9, 5, []], ['three', 3, 1, []]], {}, () => [])();
  assert.deepEqual(deck.cards.map(card => card.id), ['ten', 'nine', 'three']);
});

test('F20: You name your face and merge no one; lit only on a group the engine says looks like you', async () => {
  const owner = { id: 'person:person-zero', name: 'Person Zero', by: 'registry', person: 'person-zero', me: true, chats: [], received: 0, sent: 0,
    handles: [{ id: 'email:person-zero@example.com', kind: 'email', network: null, words: 'person-zero@example.com', from: 'Your Gmail', own: true }] };
  const namesake = { id: 'person:zero-a', name: 'Person Zero', by: 'registry', person: 'zero-a', me: false, chats: [], received: 0, sent: 0,
    handles: [] };
  /** @param {ReturnType<typeof standIn>} deck */
  const you = async deck => {
    const found = (await deck()).cards.find(card => card.suggestions[0]?.you);
    return [found.id, found.suggestions[0].key, 'merge' in found.suggestions[0], found.suggestions[0].reason, found.sure];
  };
  const split = standIn([['largest', 5, 1, []], ['looks', 3, 1, [{ person: 'zero-a', score: 0.6 }]]], { 'zero-a': 2 }, () => [owner, namesake]);
  assert.deepEqual(await you(split), ['largest', 'person:person-zero', false, 'the person your own accounts belong to', false]);
  assert.equal((await split()).cards.find(card => card.id === 'looks')?.suggestions[0]?.key, 'person:zero-a');
  const mine = standIn([['largest', 5, 1, []], ['mine', 3, 1, [{ person: 'person-zero', score: 0.6 }]]], {}, () => [owner]);
  assert.deepEqual(await you(mine), ['mine', 'person:person-zero', false, 'the person your own accounts belong to', true]);
});

test('F23: a large group\'s twelve not spread across its years, or a day counted that is not a face\'s time', async () => {
  const deck = standIn([['thirty', 30, 1, []]], { 'person-n': 3 }, () => []);
  const card = (await deck()).cards[0];
  const faces = deck.records.cluster[0].content.faces.map((/** @type {any} */ each) => each.face);
  assert.deepEqual(card.sample, Array.from({ length: 12 }, (_, at) => faces[Math.round(at * 29 / 11)]));
  const crops = new Map(deck.records.cluster[0].content.faces.map((/** @type {any} */ each) => [each.face, each.crop]));
  const given = (await deck()).crops;
  assert.deepEqual(card.sample.map(face => given[face]), card.sample.map(face => crops.get(face)));
  assert.deepEqual(deck.faces.payoff('person-n'), { slug: 'person-n', name: 'person-n', photos: 3, days: 3 });
});

test('F28: a deck kept past the clock it was filed by: a home started again with other days makes it anew', async () => {
  /** @type {any[]} */
  const nobody = [];
  const deck = standIn([['one', 1, 1, []]], { 'person-n': 3 }, () => nobody);
  const first = await until('the deck kept under one clock', async () => {
    const cards = (await deck()).cards;
    return (await deck()).cards === cards ? cards : undefined;
  });
  assert.equal(deck.faces.payoff('person-n')?.days, 3, 'days from 04:00 UTC: the 2nd, 3rd and 4th');
  deck.clocked({ id: 'long-day', runs: [{ day: '2019-12-27', start_ms: Date.UTC(2019, 11, 27), days: 7, zone: 'UTC' },
    { day: '2020-01-03', start_ms: Date.UTC(2020, 0, 6), days: 365, zone: 'UTC' }] });
  assert.notEqual((await deck()).cards, first, 'the deck made again under the new clock');
  assert.equal(deck.faces.payoff('person-n')?.days, 1);
});

test('F29: a photo\'s time restated under the same clock: its new day counted', async () => {
  const deck = standIn([['one', 1, 1, []]], { 'person-n': 3 }, () => []);
  await deck();
  assert.equal(deck.faces.payoff('person-n')?.days, 3);
  const [one, two] = deck.records.named[0].content.photos;
  one.at_ms = two.at_ms;
  deck.tell({ kind: 'event', data: { kind: 'import', key: 'faces:local:macbook-pro-0001/2' } });
  await until('the faces read again, the photo on its new day', async () => {
    await deck();
    return deck.faces.payoff('person-n')?.days === 2 || undefined;
  });
});

test('F19: an answer, its undo and the next answer on one group, back to back', async () => {
  const real = openDoor({ url: home.url, token: () => home.tokens.dashboard });
  /** @type {{ key: string, seq: number }[]} */
  const imports = [];
  let open = false;
  real.follow(message => {
    if (message.kind === 'open') open = true;
    if (message.kind === 'event' && message.data.kind === 'import') imports.push(message.data);
  });
  try {
    await until('the feed open', async () => open);
    for (const [tag, next] of /** @type {const} */ ([[4, { kind: 'ignore' }], [7, { kind: 'name', target: { kind: 'person', id: 'person:person-b' } }]])) {
      const face = facesOf(tag)[0];
      const group = cardOf(await settledDeck('the group holding the face', fresh => cardOf(fresh, face) !== undefined), face);
      const named = await act({ kind: 'name', cluster: group.id, target: { kind: 'person', id: 'person:person-a' } });
      const landed = await until('the answer imported', async () => imports.find(each => each.key === named.act));
      const labeled = await until('the labeler\'s run on it imported', async () => imports
        .find(each => each.key.startsWith(`${home.faces.faces_source}/`) && each.seq > landed.seq));
      await settledDeck('the deck read past the labeler\'s run', fresh => Number(fresh.position.split(':')[0]) >= labeled.seq);
      await act({ kind: 'undo', act: named.act });
      const answered = await act({ ...next, cluster: group.id });
      const content = next.kind === 'ignore' ? { ignore: true } : { is: 'person-b' };
      assert.deepEqual(sorted(answered.statements), facesOf(tag).map(key => ({ kind: 'face', key, content })), `tag ${tag}`);
    }
  } finally {
    real.close();
  }
});

test('F25: a person\'s Maybe faces a check screen of theirs, counted; answered, never asked again; undone, asked again', async () => {
  const maybe = home.faces.faces.m1[0].face;
  const deck = await settledDeck('Person A\'s Maybe face on a screen of theirs', fresh => fresh.checks?.some(card => card.sample.includes(maybe)));
  const screen = deck.checks.find(card => card.sample.includes(maybe));
  assert.deepEqual([screen.check.person.key, screen.check.screen, screen.check.screens, screen.check.waiting, screen.sure],
    ['person:person-a', 1, 1, screen.sample.length, true]);
  assert.equal(deck.maybe.by['person:person-a'], screen.sample.length);
  assert.ok(deck.maybe.people >= 1 && deck.maybe.faces >= screen.sample.length);
  assert.equal(deck.cards.some(card => card.sample.includes(maybe)), false);
  assert.match(String(deck.crops[maybe]), /^sha256:[0-9a-f]{64}$/u, 'a check face drawn by its crop');
  await command('settle');
  for (const action of [{ yes: [], no: [] }, { yes: [maybe], no: [maybe] }, { faces: [maybe], yes: false }]) {
    await act({ kind: 'maybe', id: screen.check.person.id, ...action }, 400);
  }
  const no = await act({ kind: 'maybe', id: screen.check.person.id, yes: [], no: [maybe] });
  assert.deepEqual(no.statements.filter(each => each.kind === 'face'), [{ kind: 'face', key: maybe, content: { is_not: ['person-a'] } }]);
  let after = await settledDeck('the face answered left the checks', fresh => !fresh.checks.some(card => card.sample.includes(maybe)));
  assert.equal(after.maybe.by['person:person-a'] ?? 0, 0);
  await command('settle');
  await act({ kind: 'undo', act: no.act });
  await settledDeck('the face asked again', fresh => fresh.checks.some(card => card.sample.includes(maybe)));
  await command('settle');
  const yes = await act({ kind: 'maybe', id: screen.check.person.id, yes: [maybe], no: [] });
  assert.deepEqual(yes.statements.filter(each => each.kind === 'face'), [{ kind: 'face', key: maybe, content: { is: 'person-a' } }]);
  after = await settledDeck('the face theirs left the checks', fresh => !fresh.checks.some(card => card.sample.includes(maybe)));
  await command('settle');
  await act({ kind: 'undo', act: yes.act });
  await settledDeck('the face asked once more', fresh => fresh.checks.some(card => card.sample.includes(maybe)));
  const lane = encodeURIComponent(home.faces.people_source);
  const put = await fetch(`${home.url}/v1/acquisitions/${lane}/20261008T120000.000Z.000000000000`, {
    method: 'PUT', body: `${JSON.stringify({ kind: 'face', key: maybe, content: { ignore: true } })}\n`,
    headers: { authorization: `Bearer ${home.tokens.dashboard}`, 'content-type': 'application/zip' } });
  assert.deepEqual([put.status, (await put.json()).code], [403, 'PRINCIPAL_SCOPE']);
  summary.checks = { screen: { id: screen.id, check: screen.check, sample: screen.sample }, maybe: deck.maybe, no: no.statements, yes: yes.statements };
});

test('F26: a Maybe face set aside asked again, or one said not someone else kept from the checks', async () => {
  const faces = Array.from({ length: 3 }, (_, at) => `${(at + 1).toString(16).padStart(64, 'e')}:1,2,3,4`);
  const checks = async (/** @type {Record<string, any>} */ said) => (await standIn([], { 'person-n': 1 }, () => [], { maybe: { 'person-n': faces }, said })())
    .checks.flatMap((/** @type {any} */ card) => card.sample);
  assert.deepEqual(await checks({}), faces);
  assert.deepEqual(await checks({ [faces[0]]: { ignore: true } }), faces.slice(1));
  assert.deepEqual(await checks({ [faces[1]]: { is_not: ['person-o'] } }), faces);
});

test('F27: an action\'s body held to the door\'s one bound: one within 2 MiB reaches the door, one past it is BODY_TOO_LARGE', async () => {
  const padded = async size => {
    const action = { of: 'people', kind: 'undo', act: 'no-such-act', request: randomUUID(), pad: '' };
    action.pad = 'x'.repeat(size - Buffer.byteLength(JSON.stringify(action)));
    const response = await fetch(`${url}/api/owner/act`, {
      method: 'POST', body: JSON.stringify(action), headers: { 'content-type': 'application/json', 'x-viewer-request': '1' },
    });
    return { status: response.status, code: (await response.json()).code };
  };
  const within = await padded(1_600_000);
  assert.notEqual(within.status, 413, JSON.stringify(within));
  assert.deepEqual(await padded(2 * 1024 * 1024 + 1), { status: 413, code: 'BODY_TOO_LARGE' });
});

test('F30: the dashboard a hop: it sends the door its wait less 1 s, answers by then, and passes began through', async () => {
  /** @type {(string | undefined)[]} */
  const heard = [];
  /** @type {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void} */
  let answer = () => {};
  const door = createServer((request, response) => {
    if (request.url !== '/v1/owner/act') {
      response.writeHead(404).end();
      return;
    }
    answer(request, response);
  });
  await new Promise(done => door.listen(0, '127.0.0.1', () => done(undefined)));
  const opened = openDoor({ url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (door.address()).port}`, token: () => 'token' });
  const viewer = await createViewer({ door: opened });
  await new Promise(done => viewer.listen(0, '127.0.0.1', done));
  /** @param {string | null} wait */
  const send = async wait => {
    const response = await fetch(`http://127.0.0.1:${viewer.address().port}/api/owner/act`, { method: 'POST',
      body: JSON.stringify({ of: 'people', kind: 'ignore', cluster: 'c1', request: randomUUID() }),
      headers: { 'content-type': 'application/json', 'x-viewer-request': '1', ...wait === null ? {} : { 'lifestream-wait': wait } } });
    return { status: response.status, ...(await response.json()) };
  };
  const json = (/** @type {import('node:http').ServerResponse} */ response, /** @type {number} */ status, /** @type {unknown} */ body) =>
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  try {
    answer = (request, response) => {
      heard.push(request.headers['lifestream-wait']);
      json(response, 503, { code: 'OUTCOME_UNKNOWN', message: 'Lifestream is still working on this.', again: true, began: true });
    };
    const began = await send('4000');
    assert.deepEqual([began.status, began.code, began.again, began.began], [503, 'OUTCOME_UNKNOWN', true, true]);
    assert.equal(heard.at(-1), '3000', 'the door sent other than the wait less 1 s');
    /** @type {() => void} */
    let release = () => {};
    answer = (request, response) => {
      heard.push(request.headers['lifestream-wait']);
      release = () => json(response, 200, { act: 'act-1', id: null, position: '9:1' });
    };
    const silent = await send('1500');
    assert.deepEqual([silent.status, silent.code, silent.again, silent.began], [503, 'OUTCOME_UNKNOWN', true, false]);
    assert.equal(heard.at(-1), '500');
    release();
    answer = (request, response) => {
      heard.push(request.headers['lifestream-wait']);
      json(response, 503, { code: 'NOT_NOW', message: 'Not saved: Lifestream is busy.', wait: 'busy' });
    };
    const busy = await send('4000');
    assert.deepEqual([busy.status, busy.code, busy.error, busy.wait], [503, 'NOT_NOW', 'Not saved: Lifestream is busy.', 'busy']);
    answer = (request, response) => {
      heard.push(request.headers['lifestream-wait']);
      json(response, 200, { act: 'act-2', id: null, position: '9:2' });
    };
    const told = heard.length;
    assert.deepEqual(await send(null), { status: 200, act: 'act-2', id: null, position: '9:2' });
    assert.equal(heard.at(-1), undefined, 'a request with no wait sent the door one');
    assert.deepEqual([(await send('soon')).status, (await send('1000')).status], [400, 400]);
    assert.equal(heard.length, told + 1, 'a wait the dashboard cannot keep reached the door');
  } finally {
    await new Promise(done => viewer.close(done));
    opened.close();
    door.closeAllConnections();
    await new Promise(done => door.close(() => done(undefined)));
  }
});
