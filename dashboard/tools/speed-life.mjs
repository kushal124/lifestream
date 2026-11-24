// @ts-check

export const LIVE = {
  people: 18_301, contact: 1_137, provider: 499, pushName: 5_062, sent: 1_998, chats: 5_103, groups: 751,
  cards: 914, someone: 18_353, places: 40, spots: 2_898, days: 5_304, atoms: 1_273,
  asks: 40,
};

const DAY_MS = 86_400_000;
export const NEWEST = Date.parse('2026-09-28T12:00:00Z');

/** @param {number} seed */
function draws(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const pad = (/** @type {number} */ n, width = 7) => String(n).padStart(width, '0');
const phone = (/** @type {number} */ n) => `1555${pad(n)}`;
const dayOf = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10);

/** @param {number} factor */
export function people(factor) {
  const draw = draws(1);
  const n = Math.round(LIVE.people * factor);
  const chatCount = Math.round(LIVE.chats * factor);
  const groupCount = Math.round(LIVE.groups * factor);
  const chats = [];
  for (let index = 0; index < chatCount; index += 1) {
    const group = index < groupCount;
    const last = NEWEST - Math.floor(draw() ** 3 * 12 * 365) * DAY_MS - Math.floor(draw() * DAY_MS);
    const total = Math.floor(draw() ** 4 * 4_000) + 1;
    const chat = group ? `1203630${pad(index, 11)}@g.us` : `${phone(index)}@s.whatsapp.net`;
    chats.push({
      key: `whatsapp:${chat}`, network: 'whatsapp', chat, group, label: group ? `Group ${pad(index, 5)}` : `Person ${pad(index, 5)}`,
      total, mine: group && draw() < 0.77 ? Math.floor(total * draw() * 0.5) : Math.floor(total * 0.4),
      first_ms: last - Math.floor(draw() * 6 * 365) * DAY_MS, last_ms: last,
    });
  }
  const shares = [LIVE.contact, LIVE.provider, LIVE.pushName].map(each => each / LIVE.people);
  const list = [];
  for (let index = 0; index < n; index += 1) {
    const pick = draw();
    const by = pick < shares[0] ? 'contact' : pick < shares[0] + shares[1] ? 'provider'
      : pick < shares[0] + shares[1] + shares[2] ? 'push-name' : 'none';
    const name = by === 'none' ? `unknown …${pad(index, 5)}` : `Person ${pad(index, 5)}`;
    const value = `${phone(index)}@s.whatsapp.net`;
    const last = NEWEST - Math.floor(draw() ** 3 * 12 * 365) * DAY_MS - Math.floor(draw() * DAY_MS);
    const received = Math.floor(draw() ** 5 * 3_000) + 1;
    const own = chats[groupCount + (index % Math.max(1, chatCount - groupCount))];
    const inGroups = Math.floor(draw() ** 6 * 6);
    list.push({
      id: `jid:${value}`, name, by, person: null, handles: [{ kind: 'jid', value, label: name }],
      networks: [draw() < 0.9 ? 'whatsapp' : 'imessage'],
      chats: [own, ...Array.from({ length: inGroups }, () => chats[Math.floor(draw() * groupCount)])]
        .filter(Boolean).map((chat, at) => ({ key: chat.key, count: Math.max(1, Math.floor(received / (at + 1))) })),
      received, sent: draw() < LIVE.sent / LIVE.people ? Math.floor(received * draw()) + 1 : 0,
      first_ms: last - Math.floor(draw() * 5 * 365) * DAY_MS, last_ms: last,
      last_30: NEWEST - last < 30 * DAY_MS ? Math.floor(draw() * 200) + 1 : 0,
      days_count: Math.floor(draw() ** 3 * 900) + 1, last_day: Math.floor(draw() * 40) + 1,
    });
  }
  return { position: '52:1792433479043', people: list, chats };
}

/**
 * @param {ReturnType<typeof people>} life
 * @param {string} id
 */
export function person(life, id) {
  const found = life.people.find(each => each.id === id);
  if (!found) return null;
  const draw = draws(found.received);
  /** @type {Record<string, number>} */
  const days = {};
  for (let at = 0; at < Math.min(found.days_count, 730); at += 1) {
    days[dayOf(found.last_ms - Math.floor(draw() * 2 * 365) * DAY_MS)] = Math.floor(draw() * 40) + 1;
  }
  days[dayOf(found.last_ms)] = found.last_day ?? 1;
  return { position: life.position, person: { ...found, days } };
}

/** @param {number} n */
const faceKey = n => `${(n * 2_654_435_761 >>> 0).toString(16).padStart(8, '0').repeat(8)}:${n % 900},${n % 1500},${(n % 400) + 100},${(n % 500) + 100}`;

/**
 * @param {number} factor
 * @param {ReturnType<typeof people>} life
 */
export function faces(factor, life) {
  const draw = draws(2);
  const cards = Math.round(LIVE.cards * factor);
  const target = (/** @type {number} */ index) => ({ kind: 'person', id: life.people[index % life.people.length].id });
  const someone = Array.from({ length: Math.round(LIVE.someone * factor) }, (_, index) => ({
    id: life.people[index % life.people.length].id, name: life.people[index % life.people.length].name, origin: 'contact',
    messages: Math.floor(draw() ** 4 * 5_000),
    channels: [{ network: 'whatsapp', label: 'WhatsApp', messages: Math.floor(draw() * 500) }], target: target(index),
  }));
  const photos = Array.from({ length: cards }, () => Math.floor(draw() * 250) + 2).sort((left, right) => right - left);
  const sample = (/** @type {number} */ index) => Array.from({ length: 12 }, (_, at) => faceKey(index * 20 + at));
  return {
    ready: true, position: '52:1792433479043',
    owner: null,
    cards: Array.from({ length: cards }, (_, index) => ({
      id: (index * 40_503 >>> 0).toString(16).padStart(16, '0'),
      faces: photos[index] + Math.floor(draw() * 20), photos: photos[index], years: [2014 + (index % 8), 2026],
      year_count: (index % 8) + 1, sample: sample(index),
      suggestions: index % 3 === 0 ? [] : [{ key: life.people[index % life.people.length].id, target: target(index),
        name: `Person ${pad(index, 5)}`, face: null, channels: [], messages: 0, reason: 'sent you 3 photos with this face' }],
      sure: index % 3 === 1,
    })),
    someone,
    crops: Object.fromEntries(Array.from({ length: cards }, (_, index) => sample(index)).flat()
      .map(face => [face, `sha256:${face.slice(0, 64)}`])),
    building: false, progress: { read: 1_200 * factor, total: 1_200 * factor }, error: null,
    took_ms: 40, people_building: false,
  };
}

/** @param {number} factor */
export function places(factor) {
  const draw = draws(3);
  const count = Math.round(LIVE.places * factor);
  const list = Array.from({ length: count }, (_, index) => {
    const last = NEWEST - Math.floor(draw() ** 2 * 3 * 365) * DAY_MS;
    return {
      slug: `place-${pad(index, 6)}`, name: `Synthetic Place ${pad(index, 6)}`, latitude: (draw() - 0.5) * 120,
      longitude: (draw() - 0.5) * 340, radius_m: 80, ids: [], also: [], stays: Math.floor(draw() * 400) + 1,
      days: Math.floor(draw() * 300) + 1, hours: Math.floor(draw() * 3_000) + 1, longest_day_hours: Math.floor(draw() * 14) + 1,
      first_ms: last - Math.floor(draw() * 5 * 365) * DAY_MS, last_ms: last, today_hours: last === NEWEST ? 3 : 0,
      area: { city: `City ${index % 97}`, region: `Region ${index % 23}`, country: `Country ${index % 11}` },
    };
  });
  const newest = list.reduce((best, place) => place.last_ms > best.last_ms ? place : best, list[0]);
  const spots = Array.from({ length: Math.round(LIVE.spots * factor) }, (_, index) => {
    const last = NEWEST - Math.floor(draw() * 4 * 365) * DAY_MS;
    const spot = { latitude: (draw() - 0.5) * 120, longitude: (draw() - 0.5) * 340, stays: Math.floor(draw() * 30) + 1,
      days: Math.floor(draw() * 20) + 1, hours: Math.floor(draw() * 100) + 1, longest_day_hours: Math.floor(draw() * 10) + 1,
      first_ms: last - Math.floor(draw() * 365) * DAY_MS, last_ms: last, worth: index % 4 === 0,
      area: { city: `City ${index % 97}`, region: `Region ${index % 23}`, country: `Country ${index % 11}` } };
    return spot.worth ? { ...spot, key: `spot:${spot.latitude.toFixed(4)},${spot.longitude.toFixed(4)}`,
      witnessed: `You were here on ${spot.days} days in 2026.`, photos: [], photos_count: 0 } : spot;
  });
  return { zone: 'UTC', day_start_hour: 4, position: '52:1792433479043', day: dayOf(NEWEST), day_until_ms: NEWEST + DAY_MS, landed: [],
    here: { latitude: newest.latitude, longitude: newest.longitude, start_ms: NEWEST - 3_600_000, end_ms: NEWEST, slug: newest.slug },
    places: list, spots, hidden: [] };
}

const FAMILIES = ['ai', 'calendar', 'calls', 'health', 'listening', 'mail', 'messages', 'money', 'notes', 'phone',
  'photos', 'physical', 'screen', 'voice', 'web'];

/** @param {number} factor */
export function days(factor) {
  const draw = draws(4);
  return Array.from({ length: Math.round(LIVE.days * factor) }, (_, index) => {
    /** @type {Record<string, number>} */
    const families = {};
    let total = 0;
    for (const family of FAMILIES) {
      const count = draw() < 0.5 ? Math.floor(draw() ** 2 * 400) : 0;
      families[family] = count;
      total += count;
    }
    return { day: dayOf(NEWEST - index * DAY_MS), total, families };
  });
}

/**
 * @param {number} factor
 * @param {string} after
 */
export function askChats(factor, after) {
  const total = Math.round(LIVE.asks * factor);
  const from = after ? Number(after) : 0;
  const chats = [];
  for (let index = from; index < Math.min(total, from + 50); index += 1) {
    const last = NEWEST - index * 3 * 3_600_000;
    chats.push({ chat: `chat-${pad(index, 6)}`, title: `A synthetic question ${pad(index, 6)}`, first_ms: last - 600_000,
      last_ms: last, messages: 2 + (index % 9) });
  }
  return from + 50 < total ? { chats, next: String(from + 50) } : { chats };
}
