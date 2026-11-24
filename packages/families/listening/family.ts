import {
  addDays, daysOf, digest, render,
  type DaySettings, type ExtractRow, type Json, type ListeningAdapter, type PlayEntry, type PlayHeard, type PlayItem, type RecordRef, type SourceRow, type Version, type View,
} from "@lifestreamprotocol/core";
import { factId, OPS, statingAccounts, type Change, type Collection, type DayFact, type DayInput, type DayLine, type DayProjection, type Extracted, type Family, type FamilyInput, type Given, type Touched } from "../family.js";
import { recordRead, recordText } from "../shared/text.js";
import { Stretches } from "../shared/stretches.js";

export const LISTENING_FAMILY = "listening";

const MINUTE = 60_000;
const DAY = 86_400_000;
export const SESSION_GAP_MS = 15 * MINUTE;
const LENGTH_SLACK_MS = MINUTE;
const LONGEST_HOLD_MS = 12 * 60 * MINUTE;
const LONG_LISTEN_MS = 15 * MINUTE;
const JOIN_SLACK_MS = MINUTE;
const NAMED_TRACKS = 3;
const NAMED_ARTISTS = 3;
const APPS: Readonly<Record<string, string>> = {
  "com.spotify.client": "Spotify", "com.apple.Music": "Music", "com.apple.podcasts": "Podcasts", "com.atebits.Tweetie2": "X",
  "com.google.ios.youtube": "YouTube", "com.apple.Safari": "Safari", "com.google.Chrome": "Chrome",
};

export type Item = PlayItem;

export interface Play extends Item {
  device: string;
  start_ms: number;
  end_ms: number | null;
  last_ms: number;
  keys: string[];
  offline?: true;
}

export interface ListeningDay {
  source: string;
  day: string;
  devices: { id: string; local: boolean }[];
  plays: Play[];
}

export function listeningFamily(given: readonly Given<ListeningAdapter>[]): Family {
  const byProduct = new Map(given.map((each) => [each.product, each]));
  const fedOf = (source: Pick<SourceRow, "product"> | undefined, kind: string): Given<ListeningAdapter> | undefined => {
    const fed = source === undefined ? undefined : byProduct.get(source.product);
    return fed?.adapter.kinds.includes(kind) === true ? fed : undefined;
  };
  const readingOf = (view: View, source: string): Reading | undefined => {
    const row = view.source(source);
    const fed = row === undefined ? undefined : byProduct.get(row.product);
    return row === undefined || fed === undefined ? undefined : { row, adapter: fed.adapter, log: fed.adapter.player === false };
  };
  return {
    name: LISTENING_FAMILY,
    type: "listening",
    code: "2",
    inputs: given.map((each): FamilyInput => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),
    text: {
      version: "2",
      kinds: [...new Set(given.flatMap((each) => each.adapter.kinds))].sort(),
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const item = fedOf(source, record.kind)?.adapter.play({ source: source!, version }) ?? null;
        if (item === null) return null;
        return recordText({ title: item.title, text: [item.artist, item.album].filter((part) => part !== null).join("\n") });
      },
    },

    read: {
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const item = fedOf(source, record.kind)?.adapter.play({ source: source!, version }) ?? null;
        return item === null ? null : recordRead({ title: item.title, text: [item.artist, item.album].filter((part) => part !== null).join("\n") });
      },
    },

    touched(changes: readonly Change[], view: View): Touched[] {
      const bySource = new Map<string, Position[]>();
      const units = new Set<string>();
      for (const change of changes) {
        const version = change.after ?? change.before;
        const at = version?.time?.start_ms;
        if (at === undefined) continue;
        const { source, kind, key } = change.record;
        const reading = readingOf(view, source);
        if (reading === undefined || !reading.adapter.kinds.includes(kind)) continue;
        if (!reading.log) units.add(`${source}/${utcDay(at)}`);
        else {
          let positions = bySource.get(source);
          if (positions === undefined) bySource.set(source, (positions = []));
          positions.push({ device: entryOf(reading, version!, key, at).device, at, key });
        }
      }
      for (const [source, positions] of bySource) {
        const starts = new Log(view, readingOf(view, source)!).playStarts(positions);
        positions.forEach(({ at }, index) => {
          for (let day = utcDay(Math.min(at, starts[index]!)); day <= utcDay(at + LONGEST_HOLD_MS); day = addDays(day, 1)) units.add(`${source}/${day}`);
        });
      }
      return [...units].sort().map((unit) => ({ unit }));
    },

    extract(unit: string, view: View): Extracted | null {
      const slash = unit.lastIndexOf("/");
      const source = unit.slice(0, slash);
      const day = unit.slice(slash + 1);
      const start = Date.parse(`${day}T00:00:00Z`);
      const reading = readingOf(view, source);
      if (reading === undefined) return null;
      const log = new Log(view, reading);
      const plays = reading.log ? log.playsStarting(start, start + DAY) : historyPlays(view, reading, start, start + DAY);
      if (plays.length === 0) return null;
      const devices = [...new Set(plays.map((play) => play.device))].sort().map((id) => ({ id, local: reading.log && log.isLocal(plays.find((play) => play.device === id)!.keys[0]!) }));
      const content: ListeningDay = { source, day, devices, plays };
      return {
        content: content as unknown as Json,
        start_ms: Math.min(...plays.map((play) => play.start_ms)),
        end_ms: Math.max(...plays.map(extent)),
        reading: digest(content as unknown as Json),
      };
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      if (extract.start_ms === null) return [];
      return daysOf({ start_ms: extract.start_ms - DAY, end_ms: (extract.end_ms ?? extract.start_ms) + DAY, precision: "ms" }, settings);
    },

    day(input: DayInput): DayProjection {
      const plays: Placed[] = [];
      const copies = new Map<string, string>();
      for (const extract of input.extracts) {
        const content = extract.content as unknown as ListeningDay;
        for (const device of content.devices) {
          if (device.local) copies.set(device.id, input.sources.get(content.source)?.copy ?? device.id);
        }
      }
      for (const extract of input.extracts) {
        const content = extract.content as unknown as ListeningDay;
        const row = input.sources.get(content.source);
        const fed = row === undefined ? undefined : byProduct.get(row.product);
        if (fed === undefined) continue;
        const player = fed.adapter.player === false ? null : fed.name;
        for (const play of content.plays) {
          const who = player === null ? copies.get(play.device) ?? `synced device ${play.device.slice(0, 8)}`
            : play.device === "" ? player : `${player} on ${play.device}`;
          const on = player === null ? copies.get(play.device) ?? play.device : play.device === "" ? null : play.device;
          plays.push({ ...play, source: content.source, unit: extract.unit, kind: fed.adapter.kinds[0]!, who, on, player });
        }
      }
      const lines: DayLine[] = [];
      const facts: DayFact[] = [];
      for (const group of listenings(plays)) {
        const first = group.plays[0]!;
        const end = Math.max(...group.plays.map(extent));
        const runs = runsOf(group.plays);
        lines.push({
          family: LISTENING_FAMILY, unit: first.unit, units: [...new Set(group.plays.map((play) => play.unit))], start_ms: first.start_ms, end_ms: end > first.start_ms ? end : null,
          text: `${[...new Set(group.plays.map((play) => play.who))].join(" and ")}: ${words(group.plays, runs)}`,
          record: recordOf(first),
        });
        facts.push(...runs.map(playFact));
      }
      return statingAccounts({ lines, facts }, (unit) => [unit.slice(0, unit.lastIndexOf("/"))]);
    },
    collections: LISTENING_COLLECTIONS,
  };
}

export const LISTENING_COLLECTIONS: Readonly<Record<string, Collection>> = {
  plays: {
    keys: ["track", "artist", "album", "app", "device"],
    measures: {
      minutes: { unit: "min", ops: OPS, time: "start", split: "clock", from: "derived" },
      times: { unit: "count", ops: OPS, time: "start", split: "whole", from: "derived" },
    },
  },
};

interface Reading {
  row: SourceRow;
  adapter: ListeningAdapter;
  log: boolean;
}


interface Entry extends PlayEntry {
  key: string;
  at: number;
}

class Log {
  readonly #kept = new Stretches<Entry>((entry) => entry.at);

  constructor(readonly view: View, readonly reading: Reading) {}

  #all(lo: number, hi: number): Entry[] {
    this.#kept.cover(lo, hi, (from, to) => {
      const found: Entry[] = [];
      for (const kind of this.reading.adapter.kinds) {
        for (const { head, version } of this.view.records(this.reading.row.id, kind, { start_ms: from, end_ms: to })) {
          if (head.start_ms === null || head.start_ms < from || head.start_ms >= to) continue;
          found.push(entryOf(this.reading, version, head.key, head.start_ms));
        }
      }
      return found;
    });
    return this.#kept.within(lo, hi);
  }

  playStarts(positions: readonly Position[]): number[] {
    const order = positions.map((_, index) => index).sort((left, right) => positions[left]!.at - positions[right]!.at || compare(positions[left]!.key, positions[right]!.key));
    if (order.length === 0) return [];
    const first = positions[order[0]!]!.at;
    const last = positions[order.at(-1)!]!.at;
    for (let back = LONGEST_HOLD_MS; ; back *= 2) {
      const walks = new Walks(first - back);
      const starts: (number | undefined)[] = [];
      let next = 0;
      const settle = (entry: Entry | undefined) => {
        for (; next < order.length; next++) {
          const position = positions[order[next]!]!;
          if (entry !== undefined && before(entry, position)) return;
          const walk = walks.of(position.device);
          starts[order[next]!] = walk === undefined ? position.at : walk.playStart(position.at);
        }
      };
      for (const entry of this.#all(first - back, last + 1)) {
        settle(entry);
        walks.step(entry);
      }
      settle(undefined);
      if (starts.every((start) => start !== undefined)) return starts;
    }
  }

  playsStarting(lo: number, hi: number): Play[] {
    let read = lo - LONGEST_HOLD_MS;
    const walks = new Walks(read);
    const walkTo = (to: number) => {
      for (const entry of this.#all(read, to)) walks.step(entry);
      read = to;
    };
    const starting = (play: Play) => play.start_ms >= lo && play.start_ms < hi;
    walkTo(hi);
    while (walks.undecided(read).some(starting)) walkTo(read + LONGEST_HOLD_MS);
    return walks.plays().filter(starting);
  }

  isLocal(key: string): boolean {
    return this.reading.adapter.kinds.some((kind) => this.view.history({ source: this.reading.row.id, kind, key }).some((statement) => statement.locator?.startsWith("local/") === true));
  }
}

interface Position {
  device: string;
  at: number;
  key: string;
}

class Walks {
  readonly #walks = new Map<string, Walk>();

  constructor(readonly from: number) {}

  step(entry: Entry): void {
    let walk = this.#walks.get(entry.device);
    if (walk === undefined) this.#walks.set(entry.device, (walk = new Walk(this.from)));
    walk.step(entry);
  }

  of(device: string): Walk | undefined {
    return this.#walks.get(device);
  }

  plays(): Play[] {
    return [...this.#walks.keys()].sort().flatMap((device) => this.#walks.get(device)!.plays);
  }

  undecided(read: number): Play[] {
    return [...this.#walks.values()].flatMap((walk) => walk.undecided(read));
  }
}

class Walk {
  readonly plays: Play[] = [];
  #last: Entry | undefined;
  #play: Play | undefined;
  #known = false;

  constructor(readonly from: number) {}

  step(entry: Entry): void {
    const last = this.#last;
    const play = this.#play;
    if (entry.changed) {
      if (play !== undefined && ends(last!, entry)) {
        play.end_ms = entry.at;
        this.#play = undefined;
      }
      return;
    }
    this.#last = entry;
    if (play !== undefined && continues(last!, entry)) {
      play.keys.push(entry.key);
      play.last_ms = entry.at;
      return;
    }
    if (play !== undefined && entry.at - last!.at <= hold(last!)) play.end_ms = entry.at;
    this.#play = undefined;
    if (!entry.playing) return;
    const { device, title, artist, album, app, length_s } = entry;
    this.#play = { device, title, artist, album, app, length_s, start_ms: entry.at, end_ms: null, last_ms: entry.at, keys: [entry.key] };
    this.#known = last !== undefined || entry.at - LONGEST_HOLD_MS >= this.from;
    this.plays.push(this.#play);
  }

  playStart(at: number): number | undefined {
    const play = this.#play;
    if (play === undefined || at - play.last_ms > LONGEST_HOLD_MS) return at;
    return this.#known ? play.start_ms : undefined;
  }

  undecided(read: number): Play[] {
    return this.#play !== undefined && this.#play.last_ms + hold(this.#last!) >= read ? [this.#play] : [];
  }
}

function entryOf(reading: Reading, version: Version, key: string, at: number): Entry {
  const stated = reading.adapter.play({ source: reading.row, version }) as PlayEntry | null;
  return { ...(stated ?? NOTHING), key, at };
}

const NOTHING: PlayEntry = { device: "", playing: false, changed: false, title: null, artist: null, album: null, app: null, length_s: null };

function hold(entry: Item): number {
  return Math.min(LONGEST_HOLD_MS, entry.length_s === null ? SESSION_GAP_MS : entry.length_s * 1000 + LENGTH_SLACK_MS);
}

function continues(entry: Entry, next: Entry): boolean {
  return entry.playing && next.playing && sameItem(entry, next) && next.at - entry.at <= hold(entry);
}

function ends(entry: Entry, changed: Entry): boolean {
  return entry.playing && changed.changed && sameItem(entry, changed) && changed.at - entry.at <= hold(entry);
}

function sameItem(left: Item, right: Item): boolean {
  return left.title === right.title && left.artist === right.artist && left.album === right.album && left.length_s === right.length_s;
}

function before(left: Pick<Entry, "at" | "key">, right: Pick<Entry, "at" | "key">): boolean {
  return left.at < right.at || (left.at === right.at && left.key < right.key);
}


function historyPlays(view: View, reading: Reading, lo: number, hi: number): Play[] {
  const plays: Play[] = [];
  for (const kind of reading.adapter.kinds) {
    for (const { head, version } of view.records(reading.row.id, kind, { start_ms: lo, end_ms: hi })) {
      if (head.start_ms === null || head.start_ms < lo || head.start_ms >= hi) continue;
      const play = heardOf(reading.adapter.play({ source: reading.row, version }) as PlayHeard | null, head.key, head.start_ms);
      if (play !== null) plays.push(play);
    }
  }
  return plays.sort((left, right) => compare(left.device, right.device) || left.start_ms - right.start_ms || compare(left.keys[0]!, right.keys[0]!));
}

function heardOf(heard: PlayHeard | null, key: string, end: number): Play | null {
  const played = heard?.played_ms;
  if (heard === null || typeof played !== "number" || !(played > 0)) return null;
  const { device, title, artist, album, app, length_s } = heard;
  return {
    device, app, length_s, title, artist, album, start_ms: end - Math.round(played), end_ms: end, last_ms: end, keys: [key],
    ...(heard.offline === true ? { offline: true as const } : {}),
  };
}


interface Placed extends Play {
  source: string;
  unit: string;
  kind: string;
  who: string;
  on: string | null;
  player: string | null;
}

function extent(play: Play): number {
  return play.end_ms ?? play.last_ms;
}

function listenings(plays: readonly Placed[]): { plays: Placed[] }[] {
  const byDevice = new Map<string, Placed[]>();
  for (const play of plays) {
    const key = `${play.source}\u0000${play.device}\u0000${play.offline === true ? "offline" : ""}`;
    byDevice.set(key, [...(byDevice.get(key) ?? []), play]);
  }
  const sessions: Placed[][] = [];
  for (const key of [...byDevice.keys()].sort()) {
    const ordered = byDevice.get(key)!.sort(byStart);
    let session: Placed[] = [];
    let reach = -Infinity;
    for (const play of ordered) {
      if (session.length > 0 && play.start_ms - reach > SESSION_GAP_MS) {
        sessions.push(session);
        session = [];
      }
      session.push(play);
      reach = Math.max(reach, extent(play));
    }
    if (session.length > 0) sessions.push(session);
  }
  const parent = sessions.map((_, index) => index);
  const root = (index: number): number => (parent[index] === index ? index : (parent[index] = root(parent[index]!)));
  for (let left = 0; left < sessions.length; left++) {
    for (let right = left + 1; right < sessions.length; right++) {
      if (sessions[left]!.some((one) => sessions[right]!.some((other) => joined(one, other)))) parent[root(right)] = root(left);
    }
  }
  const groups = new Map<number, Placed[]>();
  sessions.forEach((session, index) => groups.set(root(index), [...(groups.get(root(index)) ?? []), ...session]));
  return [...groups.values()].map((group) => ({ plays: group.sort(byStart) })).sort((left, right) => byStart(left.plays[0]!, right.plays[0]!));
}

function joined(one: Placed, other: Placed): boolean {
  if (one.source === other.source && one.device === other.device) return false;
  if (one.offline === true || other.offline === true) return false;
  if (one.title === null || fold(one.title) !== fold(other.title) || fold(one.artist) !== fold(other.artist)) return false;
  return one.start_ms <= extent(other) + JOIN_SLACK_MS && other.start_ms <= extent(one) + JOIN_SLACK_MS;
}

function fold(value: string | null): string {
  return (value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function byStart(left: Placed, right: Placed): number {
  return left.start_ms - right.start_ms || compare(left.device, right.device) || compare(left.keys[0]!, right.keys[0]!) || compare(left.source, right.source);
}

interface Heard {
  item: Item;
  spans: [number, number][];
  open: boolean;
  plays: Placed[];
}

function runsOf(plays: readonly Placed[]): Heard[] {
  const heard: Heard[] = [];
  for (const play of plays) {
    const span: [number, number] = [play.start_ms, extent(play)];
    const same = (one: Heard) => one.item.title !== null && fold(one.item.title) === fold(play.title) && fold(one.item.artist) === fold(play.artist);
    const into = heard.at(-1) !== undefined && same(heard.at(-1)!) ? heard.at(-1) : heard.find((one) => same(one) && one.spans.some(([lo, hi]) => play.start_ms <= hi + JOIN_SLACK_MS && lo <= span[1] + JOIN_SLACK_MS));
    if (into === undefined) heard.push({ item: play, spans: [span], open: play.end_ms === null, plays: [play] });
    else {
      into.spans.push(span);
      into.plays.push(play);
      into.open = into.open || play.end_ms === null;
      if (into.item.app === null && play.app !== null) into.item = { ...into.item, app: play.app };
    }
  }
  return heard;
}

function playFact(run: Heard): DayFact {
  const first = run.plays[0]!;
  const minutes = covered(run.spans) / MINUTE;
  const length = run.plays.find((play) => play.length_s !== null)?.length_s ?? null;
  const app = run.item.app === null ? first.player : APPS[run.item.app] ?? run.item.app;
  const keys = Object.entries({ track: run.item.title, artist: run.item.artist, album: run.item.album, app, device: first.on })
    .filter((entry): entry is [string, string] => entry[1] !== null);
  return {
    of: "plays", id: factId("plays", `${first.source}\u0000${first.keys[0]!}`),
    time_ms: first.start_ms, start_ms: first.start_ms, end_ms: Math.max(...run.spans.map(([, hi]) => hi)),
    keys: Object.fromEntries(keys),
    measures: { minutes, times: length === null ? 1 : Math.max(1, Math.round((minutes * 60) / length)) },
    who: [], from: { units: [...new Set(run.plays.map((play) => play.unit))], record: recordOf(first) }, lines: [],
  };
}

function recordOf(play: Placed): RecordRef {
  return { source: play.source, kind: play.kind, key: play.keys[0]! };
}

function words(plays: readonly Placed[], heard: readonly Heard[]): string {
  const long = heard.filter((one) => covered(one.spans) >= LONG_LISTEN_MS);
  const tracks = heard.filter((one) => !long.includes(one));
  const parts: string[] = [];
  if (tracks.length > 0 && tracks.length <= NAMED_TRACKS) parts.push(`${tracks.map((one) => named(one.item)).join(", ")}${apps(tracks)}`);
  else if (tracks.length > NAMED_TRACKS) parts.push(`${tracks.length} tracks${apps(tracks)}${artists(tracks)}`);
  const pieces = long.map((one) => `${named(one.item)}${apps([one])}, ${Math.round(covered(one.spans) / MINUTE)} min`);
  let said = parts.length === 0 ? pieces.join("; ") : pieces.length === 0 ? parts[0]! : `${parts[0]} (${pieces.join("; ")})`;
  const last = plays.reduce((latest, play) => (extent(play) >= extent(latest) ? play : latest));
  if (last.end_ms === null) said += `; no end stated for ${last.title ?? "the last item"}`;
  if (plays[0]!.offline === true) said += "; offline, timed when logged";
  return said;
}

function artists(tracks: readonly Heard[]): string {
  const time = new Map<string, number>();
  for (const one of tracks) {
    if (one.item.artist !== null) time.set(one.item.artist, (time.get(one.item.artist) ?? 0) + covered(one.spans));
  }
  const order = [...time.keys()];
  const ranked = order.sort((left, right) => time.get(right)! - time.get(left)! || order.indexOf(left) - order.indexOf(right));
  if (ranked.length === 0) return "";
  const shown = ranked.slice(0, NAMED_ARTISTS).join(", ");
  const rest = ranked.length - NAMED_ARTISTS;
  return ` — ${shown}${rest > 0 ? ` and ${rest} other${rest === 1 ? "" : "s"}` : ""}`;
}

function apps(heard: readonly Heard[]): string {
  const names = [...new Set(heard.flatMap((one) => (one.item.app === null ? [] : [APPS[one.item.app] ?? one.item.app])))];
  return names.length === 0 ? "" : ` in ${names.join(" and ")}`;
}

function named(item: Item): string {
  const title = item.title ?? "an untitled item";
  return item.artist === null ? title : `${title} by ${item.artist}`;
}

function covered(spans: readonly [number, number][]): number {
  let total = 0;
  let reach = -Infinity;
  for (const [lo, hi] of [...spans].sort((left, right) => left[0] - right[0])) {
    const from = Math.max(lo, reach);
    if (hi > from) total += hi - from;
    reach = Math.max(reach, hi);
  }
  return total;
}

function utcDay(ms: number): string {
  return render(ms, "UTC", "day");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
