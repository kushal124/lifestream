import { createHash } from "node:crypto";
import { afterStop, answered, clientRefresher, feeds, parse, Refused, request, rfc3339, Stopped, type Acquirer, type FetchedFile, type Json, type JsonObject, type Memory, type Stop } from "@lifestreamprotocol/connect/sdk";
import { PULL_FORMAT, PULL_MANIFEST } from "./reader.js";

function refuse(message: string): never {
  throw new Refused(`gcal-api: ${message}`);
}

export interface GcalApiSettings {
  account: string;
  signin: string;
  calendars: string[];
}

export interface GcalApiState {
  polled_ms: number;
  listing?: Listing;
}

interface Listing {
  calendar: string;
  query: Record<string, string>;
  page_token: string;
}

export interface CalendarEntry extends JsonObject {
  token: string;
}

export const CALENDAR = "calendar";
export const uidsOf = (calendar: string): string => `uid:${calendar}`;
export const UNRESOLVED = "unresolved";

export interface GcalApiDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export const EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars";
const CALENDAR_LIST_ENDPOINT = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const PAGE_SIZE = 2500;
const EXPIRED = 410;
const GOOGLE = clientRefresher("Google");

export function gcalApiAcquirer(settings: GcalApiSettings, dependencies: GcalApiDependencies = {}): Acquirer {
  const now = dependencies.now ?? Date.now;
  const source = `google-calendar:${settings.account}:cloud`;
  return {
    name: "gcal-api",
    source,
    async fetch(state, secrets, lent) {
      if (new Set(settings.calendars).size !== settings.calendars.length) refuse("the calendars list repeats a calendar");
      const previous = state as GcalApiState | null;
      const memory = lent.memory;
      const at = now();
      const fetchedAt = rfc3339(at);
      const timeMin = lent.start_ms === null ? undefined : rfc3339(lent.start_ms, "s");
      const moved = lent.from_ms !== undefined && lent.start_ms !== lent.from_ms;
      const get = (url: URL) => request(url, { method: "GET", headers: { accept: "application/json" } }, { ...dependencies, refresher: GOOGLE, secrets, secret: settings.signin });
      const stopped = (error: unknown): never => {
        if (error instanceof Stopped) afterStop(error.stop, false, undefined, "Google Calendar");
        throw error;
      };
      const listed = settings.calendars.length > 0 ? settings.calendars : await everyCalendar(get).catch(stopped);
      const resumed = !moved && previous?.listing !== undefined && listed.includes(previous.listing.calendar) ? previous.listing : undefined;
      if (resumed === undefined) memory.clear(UNRESOLVED);
      const calendars = resumed === undefined ? listed : [resumed.calendar, ...listed.filter((calendar) => calendar !== resumed.calendar)];
      const tokenOf = (calendar: string): string | undefined => (memory.get(CALENDAR, calendar) as CalendarEntry | undefined)?.token;
      const forgetToken = (calendar: string) => memory.drop(CALENDAR, calendar);
      const files: FetchedFile[] = [];
      const pages: JsonObject[] = [];
      const lookups: Record<string, Record<string, string>> = {};
      const next: JsonObject[] = [];
      const warnings: string[] = [];
      let listing: Listing | undefined;
      let listedInFull = false;
      let changes = 0;
      let stop: Stop | undefined;
      const full: Record<string, string> = { showDeleted: "true", ...(timeMin === undefined ? {} : { timeMin }) };
      const from = timeMin ?? "the beginning";
      for (const [index, calendar] of calendars.entries()) {
        const own: { files: FetchedFile[]; pages: JsonObject[]; items: Json[]; warnings: string[] } = { files: [], pages: [], items: [], warnings: [] };
        const going = resumed?.calendar === calendar ? resumed : undefined;
        const cursor = moved ? undefined : tokenOf(calendar);
        if (going === undefined) {
          if (moved) own.warnings.push(`the start moved: calendar ${calendar} was listed in full from ${from}`);
          else if (cursor === undefined) own.warnings.push(`calendar ${calendar} had no sync token and was listed in full from ${from}`);
        }
        let query: Record<string, string> = going?.query ?? (cursor !== undefined ? { syncToken: cursor } : { ...full });
        let pageToken = going?.page_token;
        let synced: string | undefined;
        let found: Record<string, string> = {};
        try {
          for (;;) {
            const answer = await list(get, calendar, pageToken === undefined ? query : { ...query, pageToken });
            if (answer === EXPIRED) {
              if (query.syncToken === undefined) refuse(`calendar ${calendar} answered ${EXPIRED} to a full list`);
              query = { ...full };
              pageToken = undefined;
              own.warnings.push(`calendar ${calendar}'s sync token expired; it was listed in full from ${from}`);
              continue;
            }
            const file = `calendar-${index}-page-${own.files.length + 1}.json`;
            const body = object(json(answer, file), file);
            if (!Array.isArray(body.items)) refuse(`${file} has no items array`);
            const items = lent.start_ms === null ? body.items : body.items.filter((item) => !endsBefore(item, lent.start_ms!));
            const kept = items.length === body.items.length ? answer : Buffer.from(JSON.stringify({ ...body, items }));
            own.files.push({ path: file, bytes: kept });
            own.pages.push({ file, sha256: createHash("sha256").update(kept).digest("hex"), bytes: kept.length, calendar_id: calendar });
            own.items.push(...items);
            const nextPage = optional(body.nextPageToken, `${file} nextPageToken`);
            synced = optional(body.nextSyncToken, `${file} nextSyncToken`) ?? synced;
            if (nextPage === undefined) break;
            pageToken = nextPage;
          }
        } catch (error) {
          if (!(error instanceof Stopped) || (next.length === 0 && own.files.length === 0)) return stopped(error);
          stop = error.stop;
          if (moved) for (const left of calendars.slice(index)) forgetToken(left);
          const missed: string[] = [];
          if (own.files.length > 0) found = learn(memory, calendar, own.items, missed);
          if (pageToken === undefined) memory.clear(UNRESOLVED);
          else {
            listing = { calendar, query, page_token: pageToken };
            for (const series of missed) memory.put(UNRESOLVED, series, true);
          }
        }
        if (stop === undefined) {
          if (synced === undefined) refuse(`calendar ${calendar} ended without a nextSyncToken`);
          found = learn(memory, calendar, own.items);
          if (going !== undefined && unresolvedKnown(memory, calendar)) {
            forgetToken(calendar);
            own.warnings.push(`calendar ${calendar} listed, after a stop, a series whose occurrence was sealed cancelled before it; it is listed in full again`);
          } else memory.put(CALENDAR, calendar, { token: synced } satisfies CalendarEntry);
          if (going !== undefined) memory.clear(UNRESOLVED);
          next.push({ calendar_id: calendar, sync_token: synced });
        }
        lookups[calendar] = found;
        files.push(...own.files);
        pages.push(...own.pages);
        warnings.push(...own.warnings);
        listedInFull ||= own.pages.length > 0 && query.syncToken === undefined;
        changes += own.items.length;
        if (stop !== undefined) break;
      }
      const named = Object.fromEntries(Object.entries(lookups).filter(([, found]) => Object.keys(found).length > 0));
      const manifest = {
        format: PULL_FORMAT,
        complete: true,
        account: settings.account,
        fetched_at: fetchedAt,
        ...(listedInFull && timeMin !== undefined ? { time_min: timeMin } : {}),
        pages,
        ...(Object.keys(named).length === 0 ? {} : { uids: named }),
        next_sync_tokens: next,
        ...(warnings.length === 0 ? {} : { warnings }),
      };
      files.push({ path: PULL_MANIFEST, bytes: Buffer.from(`${JSON.stringify(manifest)}\n`) });
      const polled: GcalApiState = { polled_ms: at, ...(listing === undefined ? {} : { listing }) };
      const facts = { fetched_at: fetchedAt, account: settings.account, pages: pages.length, ...(warnings.length === 0 ? {} : { warnings }), ...feeds(source, "gcal-api") };
      const sealsSomething = changes > 0 || listedInFull || warnings.length > 0 || stop !== undefined;
      if (!sealsSomething) return { files: [], facts, state: polled as unknown as JsonObject };
      return {
        files,
        facts,
        state: polled as unknown as JsonObject,
        ...afterStop(stop, true, polled as unknown as JsonObject, "Google Calendar"),
      };
    },
  };
}

function endsBefore(item: Json, start_ms: number): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item) || item.status === "cancelled" || item.recurrence !== undefined) return false;
  const end = item.end !== null && typeof item.end === "object" && !Array.isArray(item.end) ? item.end : undefined;
  const at = typeof end?.dateTime === "string" ? Date.parse(end.dateTime) : typeof end?.date === "string" ? Date.parse(`${end.date}T00:00:00Z`) : Number.NaN;
  return Number.isFinite(at) && at <= start_ms;
}

function learn(memory: Memory, calendar: string, items: readonly Json[], missed: string[] = []): Record<string, string> {
  const part = uidsOf(calendar);
  const events = items.filter((item): item is JsonObject => item !== null && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string");
  const uidOf = (item: JsonObject) => typeof item.iCalUID === "string" && item.iCalUID.length > 0 ? item.iCalUID : undefined;
  for (const item of events) {
    const uid = uidOf(item);
    if (item.status !== "cancelled" && uid !== undefined) memory.put(part, item.id as string, uid);
  }
  const lookups: Record<string, string> = {};
  const cancelled = events.filter((item) => item.status === "cancelled");
  for (const item of cancelled) {
    const named = typeof item.recurringEventId === "string" ? item.recurringEventId : item.id as string;
    if (uidOf(item) !== undefined) continue;
    const known = memory.get(part, named);
    if (typeof known === "string") lookups[named] = known;
    else if (typeof item.recurringEventId === "string") missed.push(named);
  }
  for (const item of cancelled) if (typeof item.recurringEventId !== "string") memory.drop(part, item.id as string);
  return lookups;
}

function unresolvedKnown(memory: Memory, calendar: string): boolean {
  for (let page = memory.list(UNRESOLVED); page.length > 0; page = memory.list(UNRESOLVED, page.at(-1)![0])) {
    if (page.some(([series]) => memory.get(uidsOf(calendar), series) !== undefined)) return true;
  }
  return false;
}

async function everyCalendar(get: (url: URL) => ReturnType<typeof request>): Promise<string[]> {
  const calendars: string[] = [];
  let pageToken: string | undefined;
  for (let number = 1; ; number++) {
    const url = new URL(CALENDAR_LIST_ENDPOINT);
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showHidden", "true");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const response = answered(await get(url));
    if (!response.ok) refuse(`the calendar list answered HTTP ${response.status}`);
    const where = `the calendar list's page ${number}`;
    const body = object(json(Buffer.from(await response.arrayBuffer()), where), where);
    if (!Array.isArray(body.items)) refuse(`${where} has no items array`);
    for (const item of body.items) {
      const entry = object(item, `${where}'s entry`);
      if (typeof entry.id !== "string" || entry.id.length === 0) refuse(`${where} has an entry with no id`);
      if (entry.accessRole !== "freeBusyReader" && !calendars.includes(entry.id)) calendars.push(entry.id);
    }
    pageToken = optional(body.nextPageToken, `${where} nextPageToken`);
    if (pageToken === undefined) return calendars;
  }
}

async function list(get: (url: URL) => ReturnType<typeof request>, calendar: string, query: Record<string, string>): Promise<Buffer | typeof EXPIRED> {
  const url = new URL(`${EVENTS_ENDPOINT}/${encodeURIComponent(calendar)}/events`);
  url.searchParams.set("maxResults", String(PAGE_SIZE));
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = answered(await get(url));
  if (response.status === EXPIRED) return EXPIRED;
  if (!response.ok) refuse(`calendar ${calendar} answered HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function json(bytes: Buffer, where: string): Json {
  try {
    return parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refuse(`${where} is not UTF-8 JSON`);
  }
}

function object(value: Json, where: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`${where} is not a JSON object`);
  return value;
}

function optional(value: Json | undefined, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) refuse(`${where} must be non-empty text`);
  return value;
}

