import type { RecordRef } from "@lifestreamprotocol/core";
import { received, type DayEpisodes, type Episode, type EpisodesFile } from "./day-episodes.js";
import { callOf, count, counted, duration, NB, quietLineOf, type QuietLine } from "./day-words.js";
import type { DayAtom } from "./days.js";

export interface WherePoint {
  latitude: number;
  longitude: number;
  id?: string;
}

export interface WherePiece {
  kind: "stay" | "move" | "gap";
  start_ms: number;
  end_ms: number;
  point: WherePoint | null;
  units: string[];
  names?: { point: { words: string | null; area?: { city?: string | null } | null } | null };
  place: { slug: string; name: string } | null;
  spot?: string | null;
}

export interface KnownPlace {
  slug: string;
  home?: boolean;
  radius_m?: number;
}

export interface KnownPerson {
  id: string;
  name: string;
  photo?: { crop?: string | null; card?: string | null } | null;
  chats: { key: string }[];
  handles: { id: string; kind: string }[];
}

export interface CallParty {
  record: RecordRef;
  who: string[];
  title: string;
}

export interface DaySideExtras {
  where: WherePiece[];
  places: KnownPlace[];
  people: KnownPerson[];
  calls: CallParty[];
}

export interface SideFigure {
  key: "asleep" | "steps" | "recovery" | "sent" | "received";
  value: string;
  words: string;
}

export interface ContactRun {
  glyph: "message" | "call" | "call-missed";
  value: string;
  quiet: boolean;
}

export interface SidePlace {
  key: string;
  slug: string | null;
  name: string;
  line: string | null;
  home: boolean;
  quiet: boolean;
  ms: number;
  length: string;
  spoken: string;
  point: WherePoint;
  radius_m: number | null;
  rows: string[];
}

export interface SidePerson {
  key: string;
  person: string | null;
  name: string;
  photo: string | null;
  runs: ContactRun[];
  spoken: string;
  rows: string[];
}

export interface SideGroup {
  chat: string;
  title: string;
  runs: ContactRun[];
  spoken: string;
  quiet: boolean;
  rows: string[];
}

export interface SideCall {
  key: string;
  at_ms: number;
  person: string | null;
  name: string;
}

export interface DaySide {
  figures: SideFigure[];
  located: boolean;
  places: SidePlace[];
  people: SidePerson[];
  groups: SideGroup[];
  unreturned: SideCall[];
}

export interface PeopleBy {
  chat: Map<string, KnownPerson>;
  handle: Map<string, KnownPerson>;
  name: Map<string, KnownPerson | undefined>;
}

export const NO_SIDE: DaySideExtras = { where: [], places: [], people: [], calls: [] };

interface Tally {
  sent: number;
  received: number;
  calls: number;
  call_ms: number;
  missed: number;
}

const NO_TALLY: Tally = { sent: 0, received: 0, calls: 0, call_ms: 0, missed: 0 };

interface Call {
  episode: Episode & { at_ms: number };
  party: CallParty | null;
  way: string;
}

interface Context {
  day: DayEpisodes;
  atoms: Map<number, DayAtom>;
  byId: Map<string, Episode>;
  byHandle: Map<string, KnownPerson>;
}

const recordKey = (ref: RecordRef): string => `${ref.source} ${ref.kind} ${ref.key}`;

const pointKey = (point: WherePoint): string => `${point.latitude},${point.longitude}${point.id ? `,${point.id}` : ""}`;

const handleValue = (handle: { id: string; kind: string }): string => handle.kind === "network" ? handle.id : handle.id.slice(handle.id.indexOf(":") + 1);

const connected = (way: string): boolean => way === "You called" || way === "They called";

const chatOf = (atom: DayAtom | undefined): string | undefined => atom?.block?.key ?? atom?.unit;

const rowLine = (episode: Episode): string => episode.row.words.map((run) => run.type === "text" ? run.text : "").filter(Boolean).join(" · ");

const plain = (words: string): string => words.replaceAll(NB, " ");

function spokenLength(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return plain(counted(seconds, "second"));
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return plain([hours ? counted(hours, "hour") : "", rest || !hours ? counted(rest, "minute") : ""].filter(Boolean).join(" "));
}

function figuresOf(day: DayEpisodes, today: boolean): SideFigure[] {
  const { asleep_ms: asleep, steps, recovery, sent, received: to } = day.figures;
  return [
    asleep === null ? null : { key: "asleep", value: duration(asleep), words: "asleep" },
    steps === null ? null : { key: "steps", value: count(steps), words: today ? "steps so far" : "steps" },
    recovery === null ? null : { key: "recovery", value: count(recovery), words: "recovery" },
    sent === null ? null : { key: "sent", value: count(sent), words: sent === 1 ? "message sent" : "messages sent" },
    to === null ? null : { key: "received", value: count(to), words: "to you" },
  ].filter((figure): figure is SideFigure => figure !== null);
}

function within(pieces: WherePiece[], start_ms: number, end_ms: number): WherePiece[] {
  return pieces.flatMap((piece) => {
    const clipped = { ...piece, start_ms: Math.max(piece.start_ms, start_ms), end_ms: Math.min(piece.end_ms, end_ms) };
    return clipped.start_ms < clipped.end_ms ? [clipped] : [];
  });
}

interface Heads {
  pieces: Map<string, WherePiece[]>;
  head: Map<WherePiece, Episode>;
}

function headsOf(ctx: Context, where: WherePiece[]): Heads {
  const stays = where.filter((piece) => piece.kind === "stay" && piece.units.length).sort((left, right) => left.start_ms - right.start_ms);
  const found: Heads = { pieces: new Map(), head: new Map() };
  for (const chapter of ctx.day.chapters) {
    const episode = chapter.kind === "stay" && chapter.episode ? ctx.byId.get(chapter.episode) : undefined;
    if (!episode || episode.kind !== "stay") continue;
    const units = new Set(episode.atoms.map((n) => ctx.atoms.get(n)?.unit));
    const end = Math.max(chapter.end_ms, chapter.start_ms + 1);
    const pieces = stays.filter((piece) => units.has(piece.units[0]) && piece.start_ms < end && chapter.start_ms < piece.end_ms);
    if (!pieces.length) continue;
    found.pieces.set(episode.id, pieces);
    for (const piece of pieces) if (!found.head.has(piece)) found.head.set(piece, episode);
  }
  return found;
}

function placesOf(ctx: Context, where: WherePiece[], known: KnownPlace[]): SidePlace[] {
  const places = new Map<string, SidePlace & { first_ms: number }>();
  const stays = ctx.day.episodes.filter((episode) => episode.kind === "stay" && episode.start_ms !== null);
  const heads = headsOf(ctx, where);
  const homes = new Set(known.flatMap((place) => place.home ? [place.slug] : []));
  const radii = new Map(known.flatMap((place) => place.radius_m === undefined ? [] : [[place.slug, place.radius_m] as const]));
  for (const piece of where) {
    if (piece.kind !== "stay" || !piece.point) continue;
    const slug = piece.place?.slug ?? null;
    const stay = slug ? undefined : heads.head.get(piece);
    const name = piece.place ? piece.place.name : stay ? stay.row.name : piece.names?.point?.words ?? piece.names?.point?.area?.city;
    if (!name) continue;
    const point = (stay && heads.pieces.get(stay.id)?.[0]?.point) || piece.point;
    const key = slug ?? `spot:${pointKey(point)}`;
    let place = places.get(key);
    if (!place) {
      place = {
        key, slug, name, line: stay ? rowLine(stay) || null : null, home: slug !== null && homes.has(slug), quiet: Boolean(stay?.row.quiet),
        ms: 0, length: "", spoken: "", point: piece.point, radius_m: slug === null ? null : radii.get(slug) ?? null, rows: [], first_ms: piece.start_ms,
      };
      places.set(key, place);
    }
    place.ms += piece.end_ms - piece.start_ms;
    for (const each of stays) {
      const end = each.end_ms ?? each.start_ms as number;
      if ((each.start_ms as number) < piece.end_ms && end > piece.start_ms && !place.rows.includes(each.id)) place.rows.push(each.id);
    }
  }
  return [...places.values()].sort((left, right) => right.ms - left.ms || left.first_ms - right.first_ms)
    .map(({ first_ms: _, ...place }) => ({ ...place, length: duration(place.ms), spoken: `${place.name}, ${spokenLength(place.ms)}` }));
}

function callsOf(ctx: Context, parties: CallParty[]): Call[] {
  const byRecord = new Map(parties.map((party) => [recordKey(party.record), party]));
  return ctx.day.episodes.flatMap((episode) => {
    if (episode.kind !== "call" || episode.at_ms === null) return [];
    const atom = ctx.atoms.get(episode.atoms[0] as number) as DayAtom;
    const party = atom.record ? byRecord.get(recordKey(atom.record)) ?? null : null;
    return [{ episode: episode as Episode & { at_ms: number }, party: party?.who.length ? party : null, way: callOf(atom.text).way }];
  });
}

function unreturnedOf(calls: Call[]): Set<string> {
  return new Set(calls.filter(({ episode, party, way }) => way === "Missed" && party
    && !calls.some((other) => connected(other.way) && other.episode.at_ms > episode.at_ms && other.party?.who.some((id) => party.who.includes(id))))
    .map(({ episode }) => episode.id));
}

function runsOf(tally: Tally): ContactRun[] {
  const runs: ContactRun[] = [];
  if (tally.sent > 0) runs.push({ glyph: "message", value: count(tally.sent), quiet: false });
  if (tally.calls > 0) runs.push({ glyph: "call", value: tally.calls === 1 ? duration(tally.call_ms) : count(tally.calls), quiet: false });
  if (tally.missed > 0) runs.push({ glyph: "call-missed", value: count(tally.missed), quiet: false });
  if (!runs.length && tally.received > 0) runs.push({ glyph: "message", value: count(tally.received), quiet: true });
  return runs;
}

function spokenOf(name: string, tally: Tally): string {
  const parts = [name];
  if (tally.sent > 0) parts.push(`${counted(tally.sent, "message")} sent`);
  if (tally.calls > 0) parts.push(counted(tally.calls, "call"));
  if (tally.calls === 1) parts.push(spokenLength(tally.call_ms));
  if (tally.missed > 0) parts.push(counted(tally.missed, "missed call"));
  if (!tally.sent && !tally.calls && !tally.missed && tally.received > 0) parts.push(`${counted(tally.received, "message")} received`);
  return plain(parts.join(", "));
}

interface PersonTally extends Tally {
  key: string;
  name: string;
  person: KnownPerson | null;
  first_ms: number;
  rows: string[];
}

interface Caller {
  key: string;
  name: string;
  person: KnownPerson | null;
}

function callerOf(party: CallParty, byHandle: Map<string, KnownPerson>): Caller {
  const person = party.who.map((id) => byHandle.get(id)).find(Boolean) ?? null;
  return { key: person?.id ?? `call:${[...party.who].sort().join(" ")}`, name: person?.name ?? (party.title || party.who.join(", ")), person };
}

function peopleOf(ctx: Context, known: KnownPerson[], calls: Call[], unreturned: Set<string>): SidePerson[] {
  const byChat = peopleBy(known).chat;
  const tallies = new Map<string, PersonTally>();
  const tallyOf = (key: string, name: string, person: KnownPerson | null, first: number): PersonTally => {
    const tally = tallies.get(key) ?? { ...NO_TALLY, key, name, person, first_ms: first, rows: [] };
    tally.first_ms = Math.min(tally.first_ms, first);
    tallies.set(key, tally);
    return tally;
  };
  for (const contact of ctx.day.people.contacts) {
    const person = byChat.get(contact.key) ?? null;
    const tally = tallyOf(person?.id ?? contact.key, person?.name ?? contact.title, person, contact.first_ms);
    tally.sent += contact.sent;
    tally.received += contact.received;
    for (const episode of ctx.day.episodes) {
      if (episode.kind === "conversation" && episode.at_ms !== null && chatOf(ctx.atoms.get(episode.atoms[0] as number)) === contact.key
        && !tally.rows.includes(episode.id)) tally.rows.push(episode.id);
    }
  }
  for (const { episode, party, way } of calls) {
    if (!party) continue;
    const caller = callerOf(party, ctx.byHandle);
    const tally = tallyOf(caller.key, caller.name, caller.person, episode.at_ms);
    if (connected(way)) {
      tally.calls += 1;
      tally.call_ms += Math.max(0, (episode.end_ms ?? episode.at_ms) - (episode.start_ms ?? episode.at_ms));
    }
    if (unreturned.has(episode.id)) tally.missed += 1;
    tally.rows.push(episode.id);
  }
  return [...tallies.values()]
    .sort((left, right) => right.sent + right.calls - (left.sent + left.calls) || left.first_ms - right.first_ms || (left.key < right.key ? -1 : 1))
    .map((tally) => ({
      key: tally.key, person: tally.person?.id ?? null, name: tally.name, photo: tally.person?.photo?.crop ?? tally.person?.photo?.card ?? null,
      runs: runsOf(tally), spoken: spokenOf(tally.name, tally), rows: tally.rows,
    }));
}

const byName = (left: { title: string; chat: string }, right: { title: string; chat: string }): number =>
  left.title < right.title ? -1 : left.title > right.title ? 1 : left.chat < right.chat ? -1 : left.chat > right.chat ? 1 : 0;

function groupsOf(ctx: Context, quiet: Map<string, QuietLine>): SideGroup[] {
  const wrote = ctx.day.people.groups.map((group) => {
    const parts = ctx.day.episodes.filter((episode) => episode.kind === "conversation" && episode.at_ms !== null
      && episode.atoms.some((n) => chatOf(ctx.atoms.get(n)) === group.key));
    const tally = {
      ...NO_TALLY,
      sent: parts.reduce((sum, episode) => sum + (episode.sent ?? 0), 0),
      received: parts.reduce((sum, episode) => sum + episode.atoms.filter((n) => {
        const atom = ctx.atoms.get(n);
        return atom !== undefined && received(atom);
      }).length, 0),
    };
    return { chat: group.key, title: group.title, tally, quiet: false, rows: parts.map((episode) => episode.id) };
  }).sort((left, right) => right.tally.sent - left.tally.sent || byName(left, right));
  const written = new Set(wrote.map((group) => group.chat));
  const still = [...quiet].flatMap(([id, line]) => written.has(line.chat) ? [] : [{
    chat: line.chat, title: line.title, quiet: true, rows: [id],
    tally: { ...NO_TALLY, received: Number(/[\d,]+/u.exec(line.count)?.[0]?.replaceAll(",", "") ?? 0) },
  }]).sort((left, right) => right.tally.received - left.tally.received || byName(left, right));
  return [...wrote, ...still].map(({ tally, ...group }) => ({ ...group, runs: runsOf(tally), spoken: spokenOf(group.title, tally) }));
}

export function peopleBy(people: readonly KnownPerson[]): PeopleBy {
  const name = new Map<string, KnownPerson | undefined>();
  for (const person of people) name.set(person.name, name.has(person.name) ? undefined : person);
  return {
    chat: new Map(people.flatMap((person) => person.chats.map((chat): [string, KnownPerson] => [chat.key, person]))),
    handle: new Map(people.flatMap((person) => person.handles.map((handle): [string, KnownPerson] => [handleValue(handle), person]))),
    name,
  };
}

function contextOf(file: EpisodesFile, day: DayEpisodes, people: KnownPerson[]): Context {
  const atoms = new Map(file.atoms.map((atom) => [atom.n, atom]));
  const byId = new Map(day.episodes.map((episode) => [episode.id, episode]));
  return { day, atoms, byId, byHandle: peopleBy(people).handle };
}

const whereOn = (file: EpisodesFile, where: WherePiece[], now_ms: number | null): WherePiece[] =>
  within(where, file.window.start_ms, Math.min(file.window.end_ms, now_ms ?? Infinity));

export function spotsToName(file: EpisodesFile, where: WherePiece[], day: DayEpisodes, now_ms: number | null): Map<string, string> {
  const ctx = contextOf(file, day, []);
  const found = new Map<string, string>();
  for (const [id, [first]] of headsOf(ctx, whereOn(file, where, now_ms)).pieces) {
    if ((ctx.byId.get(id) as Episode).row.quiet && first?.spot) found.set(id, first.spot);
  }
  return found;
}

export function staysAtHome(file: EpisodesFile, extras: Pick<DaySideExtras, "where" | "places">, day: DayEpisodes, now_ms: number | null): Set<string> {
  const homes = new Set(extras.places.flatMap((place) => place.home ? [place.slug] : []));
  if (!homes.size) return new Set();
  const ctx = contextOf(file, day, []);
  return new Set([...headsOf(ctx, whereOn(file, extras.where, now_ms)).pieces]
    .flatMap(([id, pieces]) => pieces.some((piece) => piece.place !== null && homes.has(piece.place.slug)) ? [id] : []));
}

export function daySide(file: EpisodesFile, extras: DaySideExtras, day: DayEpisodes, now_ms: number | null): DaySide {
  const ctx = contextOf(file, day, extras.people);
  const { atoms, byId, byHandle } = ctx;
  const quiet = new Map(day.also.flatMap((id) => {
    const line = quietLineOf(atoms.get((byId.get(id) as Episode).atoms[0] as number) as DayAtom);
    return line ? [[id, line] as const] : [];
  }));
  const calls = callsOf(ctx, extras.calls);
  const unreturned = unreturnedOf(calls);
  const where = whereOn(file, extras.where, now_ms);
  return {
    figures: figuresOf(day, now_ms !== null),
    located: day.chapters.some((chapter) => chapter.kind === "stay" || chapter.kind === "move"),
    places: placesOf(ctx, where, extras.places),
    people: peopleOf(ctx, extras.people, calls, unreturned),
    groups: groupsOf(ctx, quiet),
    unreturned: calls.flatMap(({ episode, party }) => {
      if (!party || !unreturned.has(episode.id)) return [];
      const { name, person } = callerOf(party, byHandle);
      return [{ key: episode.id, at_ms: episode.at_ms, person: person?.id ?? null, name }];
    }),
  };
}
