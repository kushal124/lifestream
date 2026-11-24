import { instant, isObject, span, TimeError, type CalendarAdapter, type Instant, type InputRecord, type JsonObject } from "@lifestreamprotocol/connect/sdk";

const RESPONSES: Record<number, string> = { 1: "NEEDS-ACTION", 2: "ACCEPTED", 3: "DECLINED", 4: "TENTATIVE" };
const STATUSES: Record<number, string> = { 1: "CONFIRMED", 2: "TENTATIVE", 3: "CANCELLED" };
const FREQUENCIES: Record<number, string> = { 1: "daily", 2: "weekly", 3: "monthly", 4: "yearly" };

export const calendarAdapter: CalendarAdapter = {
  version: "1",
  kinds: ["event", "reminder"],
  authority: "mirror",
  keys: "held",
  units: "product",

  event({ version }: InputRecord) {
    const content = version.content;
    if (!isObject(content) || content.type !== "apple.calendar-item" || !isObject(content.item) || version.time === undefined) return null;
    const item = content.item;
    const time = version.time;
    const date_only = time.precision === "day";
    const organizer = isObject(content.organizer) ? content.organizer : null;
    const participants = list(content.participants);
    const self = isObject(content.self_attendee) ? content.self_attendee : participants.find((each) => each.is_self === 1);
    const answering = self !== undefined && (organizer === null || self.UUID !== organizer.UUID);
    const location = isObject(content.location) ? content.location : null;
    const frequency = list(content.recurrences)[0]?.frequency;
    const startZone = text(item.start_tz);
    return {
      modified: seconds(item.last_modified) ?? Number.NEGATIVE_INFINITY,
      value: {
        title: text(item.summary) ?? "",
        start_ms: time.start_ms,
        end_ms: time.end_ms ?? null,
        date_only,
        zone: date_only || startZone === null || startZone === "_float" ? null : startZone,
        status: typeof item.status === "number" ? STATUSES[item.status] ?? null : null,
        organizer: organizer === null ? null : partyOf(organizer),
        attendees: participants.filter((each) => organizer === null || each.UUID !== organizer.UUID).length,
        response: answering && typeof self.status === "number" ? RESPONSES[self.status] ?? null : null,
        video: list(content.conferences).length > 0 || text(item.conference_url) !== null,
        location: location === null ? null : text(location.title) ?? text(location.address)?.replace(/\s*\n\s*/gu, ", ") ?? null,
        repeats: frequency === undefined ? null : typeof frequency === "number" && FREQUENCIES[frequency] !== undefined ? FREQUENCIES[frequency] : "",
      },
    };
  },

  reminder({ version }: InputRecord) {
    const content = version.content;
    if (!isObject(content) || content.type !== "apple.calendar-item" || !isObject(content.item)) return null;
    const item = content.item;
    const done = seconds(item.completion_date);
    const at = due(item);
    return {
      modified: seconds(item.last_modified) ?? Number.NEGATIVE_INFINITY,
      value: {
        title: text(item.summary) ?? "",
        due: at === null ? null : { start_ms: at.start_ms, end_ms: at.end_ms ?? null, date_only: at.precision === "day" },
        completed: done !== null,
        completed_ms: done,
        list: isObject(content.calendar) ? text(content.calendar.title) : null,
        flagged: false,
      },
    };
  },

  words({ version }: InputRecord) {
    const content = version.content;
    if (!isObject(content) || content.type !== "apple.calendar-item" || !isObject(content.item)) return null;
    const location = isObject(content.location) ? content.location : null;
    const parties = [...(isObject(content.organizer) ? [content.organizer] : []), ...list(content.participants)];
    return {
      title: text(content.item.summary),
      text: [text(location?.title), text(location?.address), text(content.item.description)].filter((part) => part !== null).join("\n"),
      who: parties.flatMap((party) => partyOf(party)?.address ?? []),
    };
  },
};

function due(item: JsonObject): Instant | null {
  const at = seconds(item.due_date);
  if (at === null) return null;
  if (item.due_all_day === 1) {
    const date = instant(new Date(at).toISOString().slice(0, 10), "date");
    return span(date, date);
  }
  const zone = text(item.due_tz);
  return zone === null || zone === "_float" ? null : { start_ms: at, precision: "s" };
}

function partyOf(participant: JsonObject): { address: string; name: string | null } | null {
  const identity = isObject(participant.identity) ? participant.identity : {};
  const address = text(participant.email) ?? text(identity.address)?.replace(/^mailto:/iu, "") ?? null;
  return address === null ? null : { address: address.toLowerCase(), name: text(identity.display_name) };
}

function seconds(value: unknown): number | null {
  if (typeof value !== "number") return null;
  try {
    return instant(value, "apple-s").start_ms;
  } catch (error) {
    if (error instanceof TimeError) return null;
    throw error;
  }
}

function list(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
