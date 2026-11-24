// @ts-check
/** @import { Door, FeedMessage } from './door.mjs' */
/** @import { HomeClock, LifeReader } from './life.mjs' */
/** @import { Card, Channel, Checked, Someone, Suggestion, Target } from '../public/lib/faces.js' */
import { NO_TOKEN, seqOf } from './door.mjs';
import { readBehind } from './behind.mjs';
import { statusError } from './errors.mjs';
import { BIG, SCREEN } from '../public/lib/faces.js';
import { handleValue } from '../public/lib/kinds.js';
import { lookup } from '../public/lib/home-clock.js';
import { counted } from '../public/lib/words.js';


/**
 * @typedef {{ is: string } | { is_not: string[] } | { ignore: true }} FaceContent
 * @typedef {{ position: string | null, persons: Map<string, any>, faces: Map<string, FaceContent> }} Landed
 * @typedef {{ version: number, person: (slug: string) => any, face: (key: string) => FaceContent | null, follow: (slug: string) => string, slugs: () => string[] }} Word
 */

const NO_PEOPLE = { people: [], chats: [], position: '' };
const PERSON_READS = 8;
const SUGGESTIONS = 3;
/** @param {{ kind: string, value: string }} sender */
const senderId = sender => (sender.kind === 'network' ? sender.value : `${sender.kind}:${sender.value}`);

const BUSIEST_DAYS = 60;
const SHARED_DAYS = 3;
const SHARED_SHARE = 0.2;
const MOST_MESSAGED = 200;
const SAMPLE = 12;
const FACE_KEY = /^([0-9a-f]{64}):(\d+),(\d+),(\d+),(\d+)$/u;

/**
 * @typedef {{ face: string, score: number }} MaybeFace
 * @typedef {{ face: string, person: string, cluster: string }} FaceRow
 * @typedef {{ senders: { kind: string, value: string, faces: number }[], labels: { name: string, faces: number }[] }} Evidence
 * @typedef {{ face: string, at_ms: number | null, crop: string | null }} ClusterFace
 * @typedef {{ size: number, photos: number, years: [number, number] | null, year_count: number, faces: ClusterFace[], outliers: string[], chat_share: number, suggested: { person: string, score: number }[], evidence: Evidence }} ClusterContent
 * @typedef {object} FacesIndex
 * @property {Map<string, ClusterContent>} clusters
 * @property {Map<string, FaceRow>} rows
 * @property {Map<string, number | null>} times
 * @property {Map<string, string | null>} crops
 * @property {Map<string, MaybeFace[]>} maybe
 * @property {string} position
 */

/**
 * @param {Door | null} door
 * @param {LifeReader} life
 * @param {{ now?: () => number }} [options]
 */
export function facesReader(door, life, { now = Date.now } = {}) {
  const reading = { progress: { read: 0, total: 0 }, took_ms: /** @type {number | null} */ (null) };
  const busiest = {
    days: /** @type {Map<string, Record<string, number>>} */ (new Map()),
    position: /** @type {string | null} */ (null),
    building: /** @type {Promise<void> | null} */ (null),
  };
  const spelled = {
    people: /** @type {Map<string, string>} */ (new Map()),
    key: /** @type {string | null} */ (null),
    building: /** @type {Promise<void> | null} */ (null),
  };
  let opens = 0;
  /** @type {{ key: string, index: FacesIndex, deck: ReturnType<typeof deckOf> } | null} */
  let made = null;

  const indexRead = readBehind(async () => {
    const began = now();
    const progress = { read: 0, total: 0 };
    reading.progress = progress;
    const value = await readIndex(reach(), progress);
    reading.took_ms = now() - began;
    return value;
  }, { open: () => opens > 0, now, eager: true });

  let version = 0;
  const wordRead = readBehind(async () => wordOf(await readWord(reach(), life), ++version), { open: () => opens > 0, now, eager: true });
  let acted = '';
  /** @param {{ position: string | null }} word */
  const behind = word => acted !== '' && (word.position === null || seqOf(word.position) < seqOf(acted));

  async function caughtUp() {
    try {
      for (let word = wordRead.get(); word !== null && behind(word);) word = wordRead.building ? await wordRead.landed() : await wordRead.fresh();
    } catch {}
  }

  /** @param {FeedMessage} message */
  const heard = message => {
    if (message.kind === 'reset') {
      acted = '';
      indexRead.moved();
      return wordRead.moved();
    }
    if (message.kind === 'open') {
      if (opens++ > 0 && door?.position() === null) {
        indexRead.moved();
        wordRead.moved();
      }
      indexRead.opened();
      return wordRead.opened();
    }
    const { kind, key } = message.data;
    const home = kind === 'repair' || kind === 'undo' || kind === 'erase';
    if ((kind === 'import' && key.startsWith('faces:')) || home) indexRead.moved();
    if ((kind === 'import' && key.startsWith('people:')) || home) wordRead.moved();
  };
  door?.follow(heard);

  const reach = () => door ?? (() => { throw statusError(NO_TOKEN, 503); })();

  function served() {
    reach();
    return indexRead.get();
  }

  /** @param {any} people */
  function readBusiest(people) {
    if (busiest.building || busiest.position === people.position) return;
    const position = people.position;
    const ids = mostMessaged(people).map(each => /** @type {string} */ (each.id));
    /** @type {Map<string, Record<string, number>>} */
    const days = new Map();
    const next = async () => {
      for (let id = ids.shift(); id !== undefined; id = ids.shift()) days.set(id, (await life.person(id)).person.days);
    };
    busiest.building = Promise.all(Array.from({ length: PERSON_READS }, next)).then(() => {
      busiest.days = days;
    }, () => undefined).finally(() => {
      busiest.position = position;
      busiest.building = null;
    });
  }

  /**
   * @param {any} people
   * @param {FacesIndex} index
   */
  function readSenders(people, index) {
    const key = `${people.position}|${index.position}`;
    if (spelled.building || spelled.key === key) return;
    const listed = new Set((people.people ?? []).flatMap((/** @type {any} */ each) => each.handles.map((/** @type {any} */ handle) => handle.id)));
    const ids = [...new Set([...index.clusters.values()].flatMap(cluster => cluster.evidence.senders.map(senderId)))].filter(id => !listed.has(id));
    /** @type {Map<string, string>} */
    const found = new Map();
    const next = async () => {
      for (let id = ids.shift(); id !== undefined; id = ids.shift()) {
        const person = await life.person(id).then(answer => answer.person.id, (/** @type {any} */ error) => {
          if (error?.status === 404) return null;
          throw error;
        });
        if (typeof person === 'string') found.set(id, person);
      }
    };
    spelled.building = Promise.all(Array.from({ length: PERSON_READS }, next)).then(() => {
      spelled.people = found;
    }, () => undefined).finally(() => {
      spelled.key = key;
      spelled.building = null;
    });
  }

  function state() {
    const index = served();
    const said = wordRead.get();
    if (index === null || said === null) return null;
    const people = life.peopleNow() ?? NO_PEOPLE;
    if (people !== NO_PEOPLE) {
      readBusiest(people);
      readSenders(people, index);
    }
    return { index, said, people, clock: life.clockNow(), view: viewOf(index, said, people, spelled.people) };
  }

  const progress = () => ({
    building: indexRead.building || (indexRead.get() !== null && wordRead.get() === null), progress: { ...reading.progress },
    error: indexRead.error, took_ms: reading.took_ms,
  });

  const viewNow = () => state() ?? fail('Your faces are still being read.', 503);

  /** @param {NonNullable<ReturnType<typeof state>>} at */
  function deckAt(at) {
    const key = [at.index.position, at.said.version, at.people.position, busiest.position, spelled.key, at.clock?.id]
      .join('|');
    if (made?.key !== key || made.index !== at.index) {
      made = { key, index: at.index, deck: deckOf(at.index, at.view, at.people, busiest.days, at.clock) };
    }
    return made.deck;
  }

  if (door) {
    indexRead.get();
    wordRead.get();
  }

  return {
    /** @param {string} position */
    acted(position) {
      if (seqOf(position) > seqOf(acted)) acted = position;
    },

    settled: caughtUp,

    async deck() {
      await caughtUp();
      const at = state();
      if (at === null) return { ready: false, ...progress() };
      const people_building = at.people === NO_PEOPLE
        || at.clock === null
        || at.people.building === true
        || busiest.position !== at.people.position
        || spelled.key !== `${at.people.position}|${at.index.position}`;
      return { ready: true, ...deckAt(at), ...progress(), people_building, people_position: at.people.position };
    },

    /** @param {string} id */
    async card(id) {
      await caughtUp();
      const at = viewNow();
      const card = at.index.clusters.has(id) ? deckAt(at).cards.find(each => each.id === id) : undefined;
      if (!card) throw statusError('There is no such face group.', 404);
      const every = /** @type {{ faces: string[] }} */ (at.view.members.get(id)).faces;
      const times = Object.fromEntries(every.map(face => [photoOf(face), at.index.times.get(photoOf(face)) ?? null]));
      return { ...card, every, crops: cropsOf(at.index, every), times };
    },

    /** @param {string} id */
    async likely(id) {
      await caughtUp();
      const at = state();
      if (at === null) return { groups: [] };
      const key = at.view.keyOf(id);
      const groups = deckAt(at).cards.flatMap(card => {
        const theirs = card.suggestions.find(each => each.key === key);
        return theirs === undefined ? [] : [{ id: card.id, faces: card.faces, photos: card.photos, years: card.years,
          sample: card.sample, reason: theirs.reason, crops: cropsOf(at.index, card.sample) }];
      });
      return { groups };
    },

    /** @param {string} slug */
    payoff(slug) {
      const at = state();
      return at === null ? null : payoffOf(slug, at.index, at.view, at.clock);
    },
  };
}

/**
 * @param {string} message
 * @param {number} status
 * @returns {never}
 */
function fail(message, status) {
  throw statusError(message, status);
}

/**
 * @param {FacesIndex} index
 * @param {Word} said
 * @param {any} people
 * @param {ReadonlyMap<string, string>} [spelledPeople]
 */
function viewOf(index, said, people, spelledPeople = new Map()) {
  const stated = said.face;
  const follow = said.follow;
  const personOf = (/** @type {FaceRow} */ row) => {
    const word = stated(row.face);
    if (word && 'is' in word) return follow(word.is);
    if (word && 'ignore' in word) return '';
    if (word && 'is_not' in word && word.is_not.includes(row.person)) return '';
    return row.person === '' ? '' : follow(row.person);
  };
  const clusterOf = (/** @type {FaceRow} */ row) => {
    const word = stated(row.face);
    return word && ('is' in word || 'ignore' in word) ? '' : row.cluster;
  };
  /** @type {Map<string, { faces: string[], photos: Set<string> }>} */
  const members = new Map();
  /** @type {Map<string, { photos: Set<string>, best: string, area: number }>} */
  const named = new Map();
  for (const row of index.rows.values()) {
    const photo = photoOf(row.face);
    const cluster = clusterOf(row);
    if (cluster !== '') {
      const found = members.get(cluster) ?? { faces: [], photos: new Set() };
      found.faces.push(row.face);
      found.photos.add(photo);
      members.set(cluster, found);
    }
    const slug = personOf(row);
    if (slug !== '') {
      const found = named.get(slug) ?? { photos: new Set(), best: row.face, area: -1 };
      const area = areaOf(row.face);
      if (area > found.area) Object.assign(found, { best: row.face, area });
      found.photos.add(photo);
      named.set(slug, found);
    }
  }
  const all = listedOf(people);
  const stream = new Map(all.map((/** @type {any} */ each) => [each.id, each]));
  const byHandle = new Map();
  for (const each of all) {
    for (const handle of each.handles) {
      byHandle.set(handle.id, each);
      byHandle.set(handleValue(handle), each);
    }
  }
  for (const [id, person] of spelledPeople) if (!byHandle.has(id) && stream.has(person)) byHandle.set(id, stream.get(person));
  const held = new Map();
  const listed = new Set();
  for (const slug of said.slugs()) {
    const record = said.person(slug);
    if (!record) continue;
    if (!record.merged_into && record.hidden !== true) listed.add(slug);
    for (const handle of [...(record.anchor ? [record.anchor] : []), ...(Array.isArray(record.handles) ? record.handles : [])]) {
      if (handle.kind === 'network') held.set(handle.value, follow(slug));
      else if (handle.kind === 'phone' || handle.kind === 'email' || handle.kind === 'jid') held.set(`${handle.kind}:${handle.value}`, follow(slug));
    }
  }
  const slugOf = (/** @type {any} */ person) => (person.person ? follow(person.person) : null)
    ?? person.handles.map((/** @type {any} */ handle) => held.get(handle.id)).find(Boolean) ?? null;
  const keyOf = (/** @type {string} */ id) => {
    if (id.startsWith('person:')) return `person:${follow(id.slice('person:'.length))}`;
    const person = stream.get(id) ?? byHandle.get(id);
    const slug = person ? slugOf(person) : null;
    return slug === null ? id : `person:${slug}`;
  };
  const nameOf = (/** @type {string} */ slug) => {
    const record = said.person(slug);
    const anchor = record?.anchor ? stream.get(`${record.anchor.kind}:${record.anchor.value}`) ?? byHandle.get(record.anchor.value) : undefined;
    const theirs = anchor && (!anchor.person || follow(anchor.person) === slug) ? anchor.name : undefined;
    return stream.get(`person:${slug}`)?.name ?? recordName(record) ?? theirs ?? record?.anchor?.value ?? slug;
  };
  const faceOf = (/** @type {string} */ slug) => {
    const photo = said.person(slug)?.photo;
    return typeof photo === 'string' && FACE_KEY.test(photo) ? photo : named.get(slug)?.best ?? null;
  };
  const chats = new Map((people.chats ?? []).map((/** @type {any} */ chat) => [chat.key, chat]));
  for (const each of people.people ?? []) {
    if (!each.person) continue;
    const slug = follow(each.person);
    if (said.person(slug)?.hidden !== true) listed.add(slug);
  }
  return { stated, follow, members, named, nameOf, faceOf, slugOf, keyOf, stream, byHandle, chats, listed };
}

/** @param {any} record */
const recordName = record => record === undefined ? undefined
  : (record.show === 'full_name' && record.full_name) || record.name || record.full_name || undefined;

/** @typedef {ReturnType<typeof viewOf>} View */

/**
 * @param {any} people
 * @returns {any[]}
 */
const listedOf = people => [...people.people ?? [], ...people.you ? [people.you] : []];

/**
 * @param {FacesIndex} index
 * @param {View} view
 * @param {any} people
 * @param {Map<string, Record<string, number>>} days
 * @param {HomeClock | null} clock
 */
function deckOf(index, view, people, days, clock) {
  const me = people.you ?? null;
  const owner = me === null ? null : { id: /** @type {string} */ (me.id), name: /** @type {string} */ (me.name), slug: view.slugOf(me) };
  const ranked = rankedPeople(people, days);
  const open = [...view.members].filter(([id]) => index.clusters.has(id));
  const asked = owner !== null && (owner.slug === null || !view.named.has(owner.slug));
  const ownerKey = asked ? view.keyOf(/** @type {{ id: string }} */ (owner).id) : null;
  /** @type {Suggestion | null} */
  let you = null;
  let youCard = null;
  let youSure = false;
  if (asked && owner !== null) {
    const own = me.handles.some((/** @type {any} */ handle) => handle.own === true);
    you = { ...suggestionOf({ kind: 'person', id: owner.id }, view, own ? 'the person your own accounts belong to' : ''), you: true };
    const offered = owner.slug === null ? open : open.filter(([, members]) => !notThem(members.faces, view).has(/** @type {string} */ (owner.slug)));
    const theirs = offered.filter(([id]) => {
      const best = /** @type {ClusterContent} */ (index.clusters.get(id)).suggested[0];
      return best !== undefined && owner.slug !== null && view.follow(best.person) === owner.slug;
    });
    youCard = [...(theirs.length > 0 ? theirs : offered)].sort(([a, left], [b, right]) => right.photos.size - left.photos.size || a.localeCompare(b))[0]?.[0] ?? null;
    youSure = theirs.length > 0;
  }
  /** @type {Map<string, number>} */
  const scores = new Map();
  /** @type {Card[]} */
  const cards = [];
  for (const [id, members] of open) {
    const cluster = /** @type {ClusterContent} */ (index.clusters.get(id));
    const card = cardOf(id, index, view);
    if (id === youCard && you !== null) {
      card.suggestions = [you, ...suggestionsFor(id, cluster, index, view, clock, ranked, [you.key]).slice(0, SUGGESTIONS - 1)];
      card.sure = youSure;
    } else {
      card.suggestions = suggestionsFor(id, cluster, index, view, clock, ranked, ownerKey === null ? [] : [ownerKey]);
      const best = cluster.suggested[0] === undefined ? null : view.follow(cluster.suggested[0].person);
      const theirs = best === null ? undefined : view.named.get(best);
      card.sure = theirs !== undefined && card.suggestions[0]?.key === `person:${best}` && ![...members.photos].some(photo => theirs.photos.has(photo));
    }
    const first = card.suggestions[0]?.messages ?? 0;
    scores.set(id, card.photos * Math.max(1, card.year_count) * (1 + Math.log10(1 + first)));
    cards.push(card);
  }
  cards.sort((left, right) => Number(right.photos >= BIG) - Number(left.photos >= BIG)
    || /** @type {number} */ (scores.get(right.id)) - /** @type {number} */ (scores.get(left.id)) || left.id.localeCompare(right.id));
  const { checks, maybe } = checksOf(index, view);
  return {
    position: index.position,
    owner: owner === null ? null : { id: owner.id, name: owner.name },
    cards,
    checks,
    maybe,
    someone: everyone(view, people),
    crops: cropsOf(index, [...cards, ...checks].flatMap(card => [...card.sample,
      ...card.suggestions.flatMap(each => each.face ?? []), ...(card.check?.person.face ? [card.check.person.face] : [])])),
  };
}

/**
 * @param {FacesIndex} index
 * @param {View} view
 */
function checksOf(index, view) {
  /** @type {Map<string, Map<string, number>>} */
  const theirs = new Map();
  for (const [slug, faces] of index.maybe) {
    const root = view.follow(slug);
    const kept = theirs.get(root) ?? new Map();
    for (const { face, score } of faces) {
      const word = view.stated(face);
      if (word && ('is' in word || 'ignore' in word)) continue;
      if (word && 'is_not' in word && word.is_not.some(not => view.follow(not) === root)) continue;
      kept.set(face, Math.max(score, kept.get(face) ?? -Infinity));
    }
    theirs.set(root, kept);
  }
  const people = [...theirs].filter(([, faces]) => faces.size > 0)
    .sort(([a, left], [b, right]) => right.size - left.size || a.localeCompare(b));
  /** @type {Card[]} */
  const checks = [];
  /** @type {Record<string, number>} */
  const by = {};
  let total = 0;
  for (const [root, faces] of people) {
    const key = `person:${root}`;
    const door = view.stream.get(key);
    const ordered = [...faces].sort(([a, left], [b, right]) => right - left || (a < b ? -1 : a > b ? 1 : 0)).map(([face]) => face);
    /** @type {Checked['person']} */
    const person = { key, id: door?.id ?? key, name: view.nameOf(root), face: view.faceOf(root), photo: door?.photo ?? null };
    const screens = Math.ceil(ordered.length / SCREEN);
    for (let at = 0; at < screens; at++) {
      const sample = ordered.slice(at * SCREEN, (at + 1) * SCREEN);
      checks.push({
        id: `check:${root}:${sample[0]}`, faces: sample.length, photos: new Set(sample.map(photoOf)).size, years: null,
        year_count: 0, sample, suggestions: [], sure: true,
        check: { person, screen: at + 1, screens, waiting: ordered.length },
      });
    }
    by[key] = ordered.length;
    total += ordered.length;
  }
  return { checks, maybe: { people: people.length, faces: total, by } };
}

/**
 * @param {FacesIndex} index
 * @param {Iterable<string>} faces
 * @returns {Record<string, string>}
 */
function cropsOf(index, faces) {
  /** @type {Record<string, string>} */
  const crops = {};
  for (const face of faces) {
    const crop = index.crops.get(face);
    if (crop) crops[face] = crop;
  }
  return crops;
}

/**
 * @param {string} face
 * @returns {string}
 */
const photoOf = face => face.slice(0, face.indexOf(':'));

/**
 * @param {string} face
 * @returns {number}
 */
function areaOf(face) {
  const [, , x1 = 0, y1 = 0, x2 = 0, y2 = 0] = (FACE_KEY.exec(face) ?? []).map(Number);
  return (x2 - x1) * (y2 - y1);
}

/**
 * @param {string[]} faces
 * @param {FacesIndex} index
 */
function sampleOf(faces, index) {
  const time = (/** @type {string} */ face) => index.times.get(photoOf(face)) ?? null;
  const ordered = [...faces].sort((left, right) => {
    const [a, b] = [time(left), time(right)];
    if (a !== b) return a === null ? 1 : b === null ? -1 : a - b;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (ordered.length <= SAMPLE) return ordered;
  return Array.from({ length: SAMPLE }, (_, at) => ordered[Math.round(at * (ordered.length - 1) / (SAMPLE - 1))]);
}

/**
 * @param {string} id
 * @param {FacesIndex} index
 * @param {View} view
 * @returns {Card}
 */
function cardOf(id, index, view) {
  const cluster = /** @type {ClusterContent} */ (index.clusters.get(id));
  const members = /** @type {{ faces: string[], photos: Set<string> }} */ (view.members.get(id));
  return {
    id, faces: members.faces.length, photos: members.photos.size, years: cluster.years, year_count: cluster.year_count,
    sample: sampleOf(members.faces, index), suggestions: [], sure: false,
  };
}

/**
 * @param {any} people
 * @returns {any[]}
 */
function mostMessaged(people) {
  return [...(people.people ?? [])].sort((/** @type {any} */ left, /** @type {any} */ right) =>
    right.received + right.sent - (left.received + left.sent) || left.id.localeCompare(right.id))
    .slice(0, MOST_MESSAGED);
}

/**
 * @param {any} people
 * @param {Map<string, Record<string, number>>} days
 */
function rankedPeople(people, days) {
  return mostMessaged(people).map(person => ({
    person,
    busiest: new Set(Object.entries(days.get(person.id) ?? {})
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, BUSIEST_DAYS)
      .map(([day]) => day)),
  }));
}

/**
 * @param {string} id
 * @param {ClusterContent} cluster
 * @param {FacesIndex} index
 * @param {View} view
 * @param {HomeClock | null} clock
 * @param {ReturnType<typeof rankedPeople>} ranked
 * @param {string[]} skip
 * @returns {Suggestion[]}
 */
function suggestionsFor(id, cluster, index, view, clock, ranked, skip) {
  /** @type {Suggestion[]} */
  const found = [];
  const faces = /** @type {{ faces: string[] }} */ (view.members.get(id)).faces;
  const seen = new Set([...skip, ...[...notThem(faces, view)].map(slug => `person:${slug}`)]);
  /** @param {Target | null} target @param {string} reason */
  const add = (target, reason) => {
    if (target === null || found.length >= SUGGESTIONS) return;
    const suggestion = suggestionOf(target, view, reason);
    if (seen.has(suggestion.key)) return;
    seen.add(suggestion.key);
    found.push(suggestion);
  };
  for (const slug of new Set(cluster.suggested.map(each => view.follow(each.person)))) {
    const photos = view.named.get(slug)?.photos.size;
    if (photos !== undefined) add({ kind: 'person', id: `person:${slug}` }, `looks like ${view.nameOf(slug)} in ${counted(photos, 'named photo')}`);
  }
  for (const sender of cluster.evidence.senders) {
    add(targetOf(view.byHandle.get(senderId(sender))), `sent you ${counted(sender.faces, 'photo')} with this face`);
  }
  for (const label of cluster.evidence.labels) {
    for (const target of labelTargets(label.name, view)) add(target, `named “${label.name}” in your photos’ labels`);
  }
  const days = found.length < SUGGESTIONS && clock ? daysOf(/** @type {{ photos: Set<string> }} */ (view.members.get(id)).photos, index, clock) : null;
  if (days !== null && days.size > 0) {
    let best = null;
    for (const candidate of ranked) {
      let shared = 0;
      for (const day of candidate.busiest) if (days.has(day)) shared++;
      if (shared >= SHARED_DAYS && shared >= SHARED_SHARE * Math.min(days.size, BUSIEST_DAYS) && (best === null || shared > best.shared)) best = { candidate, shared };
    }
    if (best) add(targetOf(best.candidate.person), `in your photos on ${best.shared} of the days you messaged most`);
  }
  return found;
}

/**
 * @param {string[]} faces
 * @param {View} view
 * @returns {Set<string>}
 */
function notThem(faces, view) {
  /** @type {Set<string> | null} */
  let not = null;
  for (const face of faces) {
    const word = view.stated(face);
    /** @type {Set<string>} */
    const these = new Set(word && 'is_not' in word ? word.is_not.map(view.follow) : []);
    /** @type {Set<string>} */
    const before = not ?? these;
    not = new Set([...before].filter(slug => these.has(slug)));
    if (not.size === 0) break;
  }
  return not ?? new Set();
}

/**
 * @param {any} person
 * @returns {Target | null}
 */
const targetOf = person => person ? { kind: 'person', id: person.id } : null;

/**
 * @param {string} name
 * @param {View} view
 * @returns {Target[]}
 */
function labelTargets(name, view) {
  const wanted = name.trim().toLocaleLowerCase();
  const same = (/** @type {string} */ each) => each.trim().toLocaleLowerCase() === wanted;
  const found = [
    ...[...view.stream.values()].filter((/** @type {any} */ each) => !each.person && view.slugOf(each) === null && same(each.name))
      .map((/** @type {any} */ each) => /** @type {string} */ (each.id)),
    ...[...view.listed].filter(slug => same(view.nameOf(slug))).map(slug => `person:${slug}`),
  ];
  return found.length > 0 ? found.map(id => ({ kind: 'person', id })) : [{ kind: 'new', name: name.trim() }];
}

/**
 * @param {Target} target
 * @param {View} view
 * @param {string} reason
 * @returns {Suggestion}
 */
function suggestionOf(target, view, reason) {
  const person = target.kind === 'person' ? view.stream.get(target.id) : undefined;
  const key = target.kind === 'person' ? view.keyOf(target.id) : `new:${target.name.toLocaleLowerCase()}`;
  const slug = key.startsWith('person:') ? key.slice('person:'.length) : null;
  const name = target.kind === 'new' ? target.name : person?.name ?? (slug === null ? target.id : view.nameOf(slug));
  const channels = person ? channelsOf(person, view.chats) : [];
  return {
    key, target, name, face: slug === null ? null : view.faceOf(slug), channels,
    messages: channels.reduce((sum, channel) => sum + channel.messages, 0), reason,
  };
}

/**
 * @param {any} person
 * @param {Map<string, any>} chats
 * @returns {Channel[]}
 */
export function channelsOf(person, chats) {
  /** @type {Map<string, number>} */
  const by = new Map();
  let sent = person.sent;
  for (const { key, count } of /** @type {{ key: string, count: number }[]} */ (person.chats)) {
    const chat = chats.get(key);
    if (chat?.group !== false) continue;
    const mine = Math.min(chat.mine, sent);
    sent -= mine;
    const network = key.slice(0, key.indexOf(':'));
    by.set(network, (by.get(network) ?? 0) + count + mine);
  }
  return [...by].map(([network, messages]) => ({ network, messages }))
    .sort((left, right) => right.messages - left.messages || left.network.localeCompare(right.network));
}

/**
 * @param {Iterable<string>} photos
 * @param {FacesIndex} index
 * @param {HomeClock} clock
 * @returns {Set<string>}
 */
function daysOf(photos, index, clock) {
  /** @type {Set<string>} */
  const days = new Set();
  for (const photo of photos) {
    const at_ms = index.times.get(photo);
    if (typeof at_ms === 'number') days.add(lookup(clock, at_ms).day);
  }
  return days;
}

/**
 * @param {View} view
 * @param {any} people
 * @returns {Someone[]}
 */
function everyone(view, people) {
  /** @param {string | null} slug */
  const namedIn = slug => {
    const photos = slug === null ? 0 : view.named.get(slug)?.photos.size ?? 0;
    return photos > 0 ? { named: photos } : {};
  };
  /** @type {Someone[]} */
  const list = listedOf(people).map((/** @type {any} */ each) => {
    const channels = channelsOf(each, view.chats);
    return {
      id: each.id, name: each.name, origin: each.by, messages: channels.reduce((sum, channel) => sum + channel.messages, 0),
      channels, target: { kind: 'person', id: each.id }, ...(channels.length === 0 && each.chats.length > 0 ? { groups_only: true } : {}),
      ...namedIn(view.slugOf(each)),
    };
  });
  const met = new Set(list.map(each => each.id));
  for (const slug of view.named.keys()) {
    if (met.has(`person:${slug}`)) continue;
    met.add(`person:${slug}`);
    list.push({ id: `person:${slug}`, name: view.nameOf(slug), origin: 'record', messages: 0, channels: [], target: { kind: 'person', id: `person:${slug}` },
      ...namedIn(slug) });
  }
  return list.sort((left, right) => right.messages - left.messages || left.name.localeCompare(right.name));
}

/**
 * @param {string} slug
 * @param {FacesIndex} index
 * @param {View} view
 * @param {HomeClock | null} clock
 */
function payoffOf(slug, index, view, clock) {
  const found = view.named.get(slug);
  const photos = found?.photos ?? new Set();
  const days = clock ? daysOf(photos, index, clock).size : null;
  return { slug, name: view.nameOf(slug), photos: photos.size, days };
}

/**
 * @param {Door} door
 * @param {{ read: number, total: number }} progress
 * @returns {Promise<FacesIndex>}
 */
async function readIndex(door, progress) {
  const { position, items: all } = await door.all('/v1/sources', { product: 'faces' }, 'sources');
  const source = all[0];
  if (!source) throw statusError('Lifestream has no faces yet. Turn faces on in Connectors and it scans the photos.', 404);
  const { counts } = await door.json('/v1/counts', { source: source.id, kind: ['cluster', 'named', 'maybe'] });
  progress.total += (counts.cluster ?? 0) + (counts.named ?? 0) + (counts.maybe ?? 0);
  /** @type {FacesIndex} */
  const index = { clusters: new Map(), rows: new Map(), times: new Map(), crops: new Map(), maybe: new Map(), position };
  /**
   * @param {ClusterFace} face
   * @returns {FaceRow}
   */
  const seen = ({ face, at_ms, crop }) => {
    index.times.set(photoOf(face), at_ms);
    index.crops.set(face, crop);
    return index.rows.get(face) ?? { face, person: '', cluster: '' };
  };
  await records(door, progress, source.id, 'cluster', ({ key, content }) => {
    index.clusters.set(key, content);
    for (const face of /** @type {ClusterContent} */ (content).faces) index.rows.set(face.face, { ...seen(face), cluster: key });
  });
  await records(door, progress, source.id, 'named', ({ key, content }) => {
    for (const face of /** @type {ClusterFace[]} */ (content.photos)) index.rows.set(face.face, { ...seen(face), person: key });
  });
  await records(door, progress, source.id, 'maybe', ({ key, content }) => {
    const faces = /** @type {{ face: string, score: number, crop: string | null }[]} */ (content.faces ?? []);
    for (const { face, crop } of faces) if (!index.crops.has(face)) index.crops.set(face, crop);
    index.maybe.set(key, faces.map(({ face, score }) => ({ face, score })));
  });
  return index;
}

/**
 * @param {Door} door
 * @param {{ read: number, total: number }} progress
 * @param {string} source
 * @param {string} kind
 * @param {(record: any) => void} take
 */
function records(door, progress, source, kind, take) {
  return door.each('/v1/records', { source, kind }, 'records', page => {
    for (const record of page) take(record);
    progress.read += page.length;
  });
}

/**
 * @param {Door} door
 * @param {LifeReader} life
 * @returns {Promise<Landed>}
 */
async function readWord(door, life) {
  const source = await life.ownerSource('people');
  /** @type {Landed} */
  const word = { position: null, persons: new Map(), faces: new Map() };
  if (source === null) return word;
  word.position = await door.each('/v1/records', { source, kind: 'person' }, 'records', page => {
    for (const record of page) word.persons.set(record.key, record.content);
  });
  await door.each('/v1/records', { source, kind: 'face' }, 'records', page => {
    for (const record of page) word.faces.set(record.key, record.content);
  });
  return word;
}

/**
 * @param {Landed} landed
 * @param {number} version
 * @returns {Word & { position: string | null }}
 */
function wordOf(landed, version) {
  /** @param {string} slug */
  const follow = slug => {
    const seen = new Set();
    let at = slug;
    while (!seen.has(at)) {
      seen.add(at);
      const next = landed.persons.get(at)?.merged_into;
      if (typeof next !== 'string' || next === '') break;
      at = next;
    }
    return at;
  };
  return {
    version, position: landed.position, person: slug => landed.persons.get(slug), face: key => landed.faces.get(key) ?? null,
    follow, slugs: () => [...landed.persons.keys()],
  };
}

/** @typedef {ReturnType<typeof facesReader>} FacesReader */
