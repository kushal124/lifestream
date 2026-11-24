import {
  daysOf, digest, GONE, handleId, handleOf,
  type CalendarAdapter, type CalendarCopy, type CalendarEvent as EventRead, type DaySettings, type ExtractRow, type Instant, type Json, type Reminder,
  type RecordRef, type SourceRow, type Version, type View,
} from "@lifestreamprotocol/core";
import { joined, nameParty, printed, type Printed, type Printable } from "../shared/cast.js";
import { labelInputs, type Books } from "../shared/labels.js";
import { factId, OPS, type Change, type Collection, type DayFact, type DayLine, type DayProjection, type Family, type FamilyInput, type Given, type Labels, type RecordRead, type RecordText, type Touched } from "../family.js";
import { recordRead, recordText } from "../shared/text.js";

export const CALENDAR_FAMILY = "calendar";
export const EVENT = "event";
export const REMINDER = "reminder";
const DAY_MS = 86_400_000;

export interface CalendarEvent {
  [member: string]: Json;
  source: string;
  key: string;
  title: string;
  start_ms: number;
  end_ms: number | null;
  date_only: boolean;
  zone: string | null;
  status: string | null;
  organizer: { address: string; name: string | null } | null;
  attendees: number;
  response: string | null;
  video: boolean;
  location: string | null;
  repeats: string | null;
}

export interface CalendarReminder {
  [member: string]: Json;
  kind: "reminder";
  word: string;
  source: string;
  key: string;
  title: string;
  due: { start_ms: number; end_ms: number | null; date_only: boolean } | null;
  completed: boolean;
  completed_ms: number | null;
  list: string | null;
  flagged: boolean;
}

type Content = CalendarEvent | CalendarReminder;

interface Read<T> {
  value: T;
  modified: number;
  deleted: boolean;
  rank: [number, number];
}

export function calendarFamily(books: Books): (given: readonly Given<CalendarAdapter>[]) => Family {
  return (given) => calendarOver(books, given);
}

function calendarOver(books: Books, given: readonly Given<CalendarAdapter>[]): Family {
  const byProduct = new Map(given.map((each) => [each.product, each]));
  const givenOf = (product: string): Given<CalendarAdapter> | undefined => byProduct.get(product);
  const adapterOf = (source: SourceRow | undefined): CalendarAdapter | undefined => source === undefined ? undefined : givenOf(source.product)?.adapter;
  const reads = (kind: string) => given.filter((each) => each.adapter.kinds.includes(kind) && (kind === EVENT ? each.adapter.event : each.adapter.reminder) !== undefined);
  const ownEvents = reads(EVENT).filter((each) => each.adapter.authority === "own");
  const mirrorEvents = reads(EVENT).filter((each) => each.adapter.authority === "mirror");
  const reminderStores = reads(REMINDER);
  const ownReminders = reminderStores.filter((each) => each.adapter.authority === "own")
    .sort((left, right) => Number(left.digest !== undefined) - Number(right.digest !== undefined) || compare(left.product, right.product));
  const namerOf = (store: Given<CalendarAdapter>): Given<CalendarAdapter> =>
    store.adapter.authority === "own" ? store : ownReminders.find((own) => own.vendor === store.vendor) ?? store;
  const joinedTo = (namer: Given<CalendarAdapter>) => reminderStores.filter((store) => namerOf(store) === namer);
  const inputs: FamilyInput[] = given.map((each) => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" }));

  const ownerOf = (product: string, adapter: CalendarAdapter, account: string) => adapter.units === "account" ? account : `${product}:${account}`;
  const unitOf = (source: SourceRow, kind: string, name: string): string => {
    const store = givenOf(source.product)!;
    const named = kind === REMINDER ? namerOf(store) : store;
    return `${ownerOf(named.product, named.adapter, source.account)}/${name}`;
  };
  const copiesOf = (view: View, source: SourceRow, kind: string, name: string): Version[] => {
    if (adapterOf(source)!.keys === "name") {
      const head = view.head({ source: source.id, kind, key: name });
      return head === undefined || head.version === GONE ? [] : [view.version(head.version)];
    }
    return view.keyedUnder(source.id, kind, `${name}:`).filter((head) => heldName(head.key) === name).map((head) => view.version(head.version));
  };
  const nameOfKey = (source: SourceRow, key: string) => adapterOf(source)!.keys === "name" ? key : heldName(key);
  const sourcesOf = (view: View, of: readonly Given<CalendarAdapter>[], account?: string) =>
    view.sources({ product: of.map((each) => each.product) }).filter((row) => account === undefined || row.account === account);
  const rankOf = (source: SourceRow, copy: CalendarCopy<unknown>): [number, number] => [adapterOf(source)!.authority === "own" ? 0 : 1, copy.rank ?? 0];

  function readCopies<T extends EventRead | Reminder>(view: View, source: SourceRow, kind: string, name: string): Shown<T>[] {
    const adapter = adapterOf(source)!;
    const read = (kind === EVENT ? adapter.event : adapter.reminder) as ((record: { source: SourceRow; version: Version }) => CalendarCopy<T> | null) | undefined;
    if (read === undefined) return [];
    return copiesOf(view, source, kind, name).flatMap((version) => {
      const copy = read.call(adapter, { source, version });
      return copy === null ? [] : [{ value: copy.value, modified: copy.modified, deleted: copy.deleted ?? false, rank: rankOf(source, copy), source: source.id, key: version.key }];
    });
  }

  function ownEvent(account: string, name: string, view: View): CalendarEvent | null {
    const replicas: Shown<EventRead>[] = [];
    let cancelled: number | null = null;
    for (const source of sourcesOf(view, ownEvents, account)) {
      if (adapterOf(source)!.keys === "name") {
        const head = view.head({ source: source.id, kind: EVENT, key: name });
        if (head?.version === GONE) cancelled = Math.max(cancelled ?? head.stated_ms, head.stated_ms);
      }
      replicas.push(...readCopies<EventRead>(view, source, EVENT, name));
    }
    const shown = choose(replicas);
    return shown === null || (cancelled !== null && shown.modified <= cancelled) ? null : eventOf(shown);
  }

  function mirrorEvent(product: string, account: string, name: string, view: View): CalendarEvent | null {
    if (sourcesOf(view, ownEvents).some((own) => holds(view, own, EVENT, name))) return null;
    const mirror = given.filter((each) => each.product === product);
    const shown = choose(sourcesOf(view, mirror, account).flatMap((source) => readCopies<EventRead>(view, source, EVENT, name)));
    return shown === null ? null : eventOf(shown);
  }

  function reminderOf(namer: Given<CalendarAdapter>, account: string, name: string, view: View): CalendarReminder | null {
    const shown = choose(sourcesOf(view, joinedTo(namer), account).flatMap((source) => readCopies<Reminder>(view, source, REMINDER, name)));
    if (shown === null || shown.deleted || (shown.value.due === null && shown.value.completed_ms === null)) return null;
    return { kind: "reminder", source: shown.source, key: shown.key, ...shown.value, word: namer.adapter.reminderWord ?? "Reminder" };
  }

  function holds(view: View, source: SourceRow, kind: string, name: string): boolean {
    return adapterOf(source)!.keys === "name" ? view.head({ source: source.id, kind, key: name }) !== undefined : copiesOf(view, source, kind, name).length > 0;
  }

  function parse(unit: string, view: View): { kind: string; account: string; name: string; given: Given<CalendarAdapter> } | null {
    const slash = unit.indexOf("/");
    if (slash < 0) return null;
    const owner = unit.slice(0, slash);
    const name = unit.slice(slash + 1);
    for (const kind of [EVENT, REMINDER]) {
      for (const each of reads(kind)) {
        for (const source of sourcesOf(view, [each])) {
          if (unitOf(source, kind, name) === unit && holds(view, source, kind, name)) return { kind, account: source.account, name, given: kind === REMINDER ? namerOf(each) : each };
        }
      }
    }
    for (const namer of new Set(reminderStores.map(namerOf))) {
      if (namer.adapter.units === "product" && owner.startsWith(`${namer.product}:`)) return { kind: REMINDER, account: owner.slice(namer.product.length + 1), name, given: namer };
    }
    return null;
  }

  return {
    name: CALENDAR_FAMILY,
    type: "plans",
    code: "7",
    inputs: [...inputs, ...labelInputs(books)],

    touched(changes: readonly Change[], view: View): Touched[] {
      return changes.flatMap((change): Touched[] => {
        const source = view.source(change.record.source);
        const adapter = adapterOf(source);
        const { kind, key } = change.record;
        if (source === undefined || adapter === undefined || !adapter.kinds.includes(kind) || (kind !== EVENT && kind !== REMINDER)) return [];
        const name = nameOfKey(source, key);
        if (kind === EVENT && adapter.authority === "own") {
          const mirrored = sourcesOf(view, mirrorEvents).filter((mirror) => copiesOf(view, mirror, EVENT, name).length > 0);
          return [{ unit: unitOf(source, EVENT, name) }, ...mirrored.map((mirror) => ({ unit: unitOf(mirror, EVENT, name) }))];
        }
        return [{ unit: unitOf(source, kind, name) }];
      });
    },

    extract(unit: string, view: View) {
      const thing = parse(unit, view);
      if (thing === null) return null;
      const content: Content | null = thing.kind === REMINDER ? reminderOf(thing.given, thing.account, thing.name, view)
        : thing.given.adapter.authority === "own" ? ownEvent(thing.account, thing.name, view)
        : mirrorEvent(thing.given.product, thing.account, thing.name, view);
      if (content === null) return null;
      const times = instantsOf(content);
      return {
        content,
        start_ms: Math.min(...times.map((time) => time.start_ms)),
        end_ms: times.length === 1 ? times[0]!.end_ms ?? null : Math.max(...times.map((time) => time.end_ms ?? time.start_ms)),
        reading: digest(content),
      };
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      return [...new Set(instantsOf(extract.content as Content).flatMap((time) => daysOf(time, settings)))].sort();
    },

    text: {
      version: "1",
      kinds: [EVENT, REMINDER].filter((kind) => given.some((each) => each.adapter.kinds.includes(kind))),
      of(record, version, _files, view): RecordText | null {
        const source = view.source(record.source);
        const words = adapterOf(source)?.words({ source: source!, version }) ?? null;
        return words === null ? null : recordText({ title: words.title, text: words.text, who: words.who });
      },
    },

    read: {
      of(record, version, _files, view): RecordRead | null {
        const source = view.source(record.source);
        const words = adapterOf(source)?.words({ source: source!, version }) ?? null;
        return words === null ? null : recordRead({ title: words.title, text: words.text, who: words.who });
      },
    },

    day(input): DayProjection {
      const lines: DayLine[] = [];
      const facts: DayFact[] = [];
      for (const extract of input.extracts) {
        const content = extract.content as Content;
        if (isReminder(content)) {
          lines.push(...reminderLines(extract.unit, content, input.day, input.settings));
          continue;
        }
        const event = content;
        const record = { source: event.source, kind: EVENT, key: event.key };
        const line = lines.push({
          family: "calendar",
          unit: extract.unit, units: [extract.unit],
          start_ms: event.start_ms,
          end_ms: datesEnd(event),
          ...(event.date_only ? { date_only: true } : {}),
          ...eventText(event, input.settings.zone, input.labels),
          record,
        }) - 1;
        facts.push(eventFact(extract.unit, event, input.sources.get(event.source)?.account ?? "", record, line));
      }
      return { lines, facts };
    },
    collections: CALENDAR_COLLECTIONS,
  };
}

export const CALENDAR_COLLECTIONS: Readonly<Record<string, Collection>> = {
  events: {
    keys: ["title", "response", "status"],
    measures: { minutes: { unit: "min", ops: OPS, time: "start", split: "clock", readings: ["meetings.minutes"], from: "derived" } },
  },
};

function eventFact(unit: string, event: CalendarEvent, account: string, record: RecordRef, line: number): DayFact {
  const keys: Record<string, string> = { title: event.title };
  if (event.response !== null) keys["response"] = event.response;
  if (event.status !== null) keys["status"] = event.status;
  const organizer = event.organizer?.address;
  const handle = organizer === undefined || organizer.toLowerCase() === account.toLowerCase() ? null : handleOf(organizer);
  const who = handle === null ? [] : [{ handle: handleId(handle), role: "attendee" as const }];
  const id = factId("events", unit);
  if (event.date_only) {
    const date = midnightOf(event.start_ms);
    return { of: "events", id, time_ms: date, start_ms: date, end_ms: date, date_only: true, keys, measures: {}, who, from: { units: [unit], record, alone: true }, lines: [line] };
  }
  const end = event.end_ms ?? event.start_ms;
  return {
    of: "events", id, time_ms: event.start_ms, start_ms: event.start_ms, end_ms: end, keys,
    measures: event.end_ms === null ? {} : { minutes: (end - event.start_ms) / 60_000 },
    who, from: { units: [unit], record, alone: true }, lines: [line],
  };
}

interface Shown<T> extends Read<T> {
  source: string;
  key: string;
}

function eventOf(shown: Shown<EventRead>): CalendarEvent {
  const { title, start_ms, end_ms, date_only, zone, status, organizer, attendees, response, video, location, repeats } = shown.value;
  return {
    source: shown.source, key: shown.key, title, start_ms, end_ms, date_only, zone, status,
    organizer: organizer === null ? null : { address: organizer.address, name: organizer.name }, attendees, response, video, location, repeats,
  };
}

function choose<T>(replicas: Shown<T>[]): Shown<T> | null {
  const byRank = (left: Shown<T>, right: Shown<T>) =>
    left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1] || compare(left.source, right.source) || compare(left.key, right.key);
  const newest = [...replicas].sort((left, right) => right.modified - left.modified || byRank(left, right))[0];
  if (newest === undefined) return null;
  const printed = (replica: Shown<T>) => digest(replica.value as unknown as Json);
  return { ...replicas.filter((replica) => printed(replica) === printed(newest)).sort(byRank)[0]!, modified: newest.modified, deleted: newest.deleted };
}

export function heldName(key: string): string {
  return key.slice(0, Math.max(0, key.lastIndexOf(":")));
}

function isReminder(content: Content): content is CalendarReminder {
  return content.kind === "reminder";
}

function reminderLines(unit: string, reminder: CalendarReminder, day: string, settings: DaySettings): DayLine[] {
  const { word } = reminder;
  const title = `“${reminder.title === "" ? `Untitled ${word.toLowerCase()}` : reminder.title}”`;
  const list = reminder.list === null ? "" : `, in ${reminder.list}`;
  const record = { source: reminder.source, kind: REMINDER, key: reminder.key };
  const lines: DayLine[] = [];
  const due = reminder.due;
  if (due !== null && daysOf(dueInstant(due), settings).includes(day)) {
    lines.push({
      family: "calendar", unit, units: [unit], start_ms: due.start_ms, end_ms: datesEnd(due),
      ...(due.date_only ? { date_only: true } : {}),
      text: `${word} ${title} due${list}${reminder.flagged ? ", flagged" : ""}${reminder.completed ? ", completed" : ""}`,
      record,
    });
  }
  if (reminder.completed_ms !== null && daysOf(doneInstant(reminder.completed_ms), settings).includes(day)) {
    lines.push({ family: "calendar", unit, units: [unit], start_ms: reminder.completed_ms, end_ms: null, text: `${word} ${title} completed${list}`, record });
  }
  return lines;
}

function datesEnd(time: { start_ms: number; end_ms: number | null; date_only: boolean }): number | null {
  return time.date_only && (time.end_ms === null || time.end_ms - time.start_ms <= DAY_MS) ? null : time.end_ms;
}

function eventText(event: CalendarEvent, zone: string, labels: Labels): Printed {
  const parts: Printable[] = [`Event “${event.title === "" ? "Untitled event" : event.title}”`];
  if (event.organizer !== null) parts.push(printed`organised by ${nameParty({ id: event.organizer.address, kind: "email", provider: event.organizer.name }, labels)}`);
  if (event.attendees > 0) parts.push(`${event.attendees} attendee${event.attendees === 1 ? "" : "s"}`);
  if (event.response !== null) parts.push(RESPONSES[event.response] ?? `you ${event.response.toLowerCase()}`);
  if (event.video) parts.push("video call");
  if (event.location !== null) parts.push(event.location);
  const own = event.zone === null ? null : knownZone(event.zone);
  if (own !== null && own !== "UTC" && own !== knownZone(zone)) parts.push(`in ${event.zone} time`);
  if (event.repeats !== null) parts.push(event.repeats === "" ? "repeats" : `repeats ${event.repeats}`);
  if (event.status === "CANCELLED") parts.push("cancelled");
  else if (event.status !== null && event.status !== "CONFIRMED") parts.push(event.status.toLowerCase());
  return joined(parts, ", ");
}

const zones = new Map<string, string | null>();
export function knownZone(zone: string): string | null {
  let known = zones.get(zone);
  if (known === undefined) {
    try {
      known = new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
      known = null;
    }
    zones.set(zone, known);
  }
  return known;
}

const RESPONSES: Record<string, string> = {
  ACCEPTED: "you accepted", DECLINED: "you declined", TENTATIVE: "you said maybe", "NEEDS-ACTION": "you have not replied",
};

function instantsOf(content: Content): Instant[] {
  if (!isReminder(content)) return [dueInstant(content)];
  return [...(content.due === null ? [] : [dueInstant(content.due)]), ...(content.completed_ms === null ? [] : [doneInstant(content.completed_ms)])];
}

function dueInstant(time: { start_ms: number; end_ms: number | null; date_only: boolean }): Instant {
  return { start_ms: time.start_ms, ...(time.end_ms === null ? {} : { end_ms: time.end_ms }), precision: time.date_only ? "day" : "ms" };
}

function doneInstant(at: number): Instant {
  return { start_ms: at, precision: "ms" };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function midnightOf(ms: number): number {
  return ms - (ms % DAY_MS);
}
