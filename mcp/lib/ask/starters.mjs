// @ts-check
import { DoorRefusal } from '../errors.mjs';


/** @type {readonly { kind: string, question: string, records: readonly string[], except?: readonly string[], days: readonly [number, number] }[]} */
export const STARTERS = [
  { kind: 'places', question: 'Where have I been today?', records: ['place-visit', 'trip', 'fix'], days: [0, 0] },
  { kind: 'walking', question: 'How far did I walk today?', records: ['day-summary', 'motion'], days: [0, 0] },
  { kind: 'photos', question: 'What did I photograph this week?', records: ['photo', 'img'], days: [-6, 0] },
  { kind: 'sleep', question: 'How did I sleep last night?', records: ['sleep'], days: [-1, 0] },
  { kind: 'workouts', question: 'What was my last workout?', records: ['workout'], days: [-29, 0] },
  { kind: 'people', question: 'Who did I talk to most this week?', records: ['msg', 'call'], except: ['ask', 'chatgpt', 'claude'], days: [-6, 0] },
  { kind: 'calendar', question: 'What’s on my calendar this week?', records: ['event'], days: [0, 6] },
  { kind: 'screen', question: 'What did I work on yesterday?', records: ['frame'], days: [-1, -1] },
  { kind: 'music', question: 'What have I been listening to lately?', records: ['now-playing', 'play'], days: [-6, 0] },
  { kind: 'mail', question: 'What came in my mail this week?', records: ['mailmsg'], days: [-6, 0] },
];

const MOST = 3;
const DAY_MS = 86_400_000;

/**
 * @typedef {{ kind: string, question: string }} Starter
 * @typedef {import('../door.mjs').Door} Door
 * @typedef {Pick<ReturnType<typeof import('../memory.mjs').openMemory>, 'clock'>} Memory
 */

/** @param {{ memory: Memory, any: (door: Door) => Promise<boolean>, now?: () => number }} options */
export function openStarters({ memory, any, now = Date.now }) {
  /** @type {Map<string, Promise<Starter[]>>} */
  const reading = new Map();
  return {
    /** @param {Door} door @returns {Promise<Starter[]>} */
    read(door) {
      const under = reading.get(door.pass);
      if (under !== undefined) return under;
      const read = (async () => (await any(door) ? [] : startersOf(door, memory, now())))()
        .catch(() => /** @type {Starter[]} */ ([]))
        .finally(() => reading.delete(door.pass));
      reading.set(door.pass, read);
      return read;
    },
  };
}

/**
 * @param {Door} door
 * @param {Memory} memory
 * @param {number} at
 * @returns {Promise<Starter[]>}
 */
export async function startersOf(door, memory, at) {
  const sources = await everySource(door);
  const each = STARTERS.map(starter => sources.flatMap(source => (starter.except ?? []).includes(source.product) ? []
    : (source.kinds ?? []).filter(kind => starter.records.includes(kind)).map(kind => ({ source: source.id, kind }))));
  const clock = await memory.clock(door);
  const today = clock.dayAt(at);
  /** @param {number} k */
  const dayOn = k => clock.dayAt(today.start_ms + k * DAY_MS + DAY_MS / 2);
  const holds = STARTERS.map(async (starter, place) => {
    const named = /** @type {{ source: string, kind: string }[]} */ (each[place]);
    if (named.length === 0) return false;
    const from_ms = dayOn(starter.days[0]).start_ms;
    const to_ms = dayOn(starter.days[1]).end_ms;
    const found = await Promise.all(named.map(({ source, kind }) => recordIn(door, { source, kind, from_ms, to_ms })));
    return found.some(Boolean);
  });
  for (const hold of holds) hold.catch(() => undefined);
  /** @type {Starter[]} */
  const offered = [];
  for (const [place, hold] of holds.entries()) {
    if (offered.length === MOST) break;
    if (!await hold) continue;
    const { kind, question } = /** @type {(typeof STARTERS)[number]} */ (STARTERS[place]);
    offered.push({ kind, question });
  }
  return offered;
}

/**
 * @param {Door} door
 * @returns {Promise<{ id: string, product: string, kinds?: string[] }[]>}
 */
async function everySource(door) {
  const sources = [];
  for (let after; ;) {
    const page = await door.json('/v1/sources', { limit: 1024, after });
    sources.push(...page.sources);
    if (page.next === undefined) return sources;
    after = page.next;
  }
}

/**
 * @param {Door} door
 * @param {{ source: string, kind: string, from_ms: number, to_ms: number }} asked
 */
async function recordIn(door, asked) {
  try {
    return (await door.json('/v1/records', { ...asked, limit: 1 })).records.length > 0;
  } catch (error) {
    if (!(error instanceof DoorRefusal) || error.code !== 'SOURCE_UNKNOWN') throw error;
    return false;
  }
}
