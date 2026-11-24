import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@lifestreamprotocol/core";
import type { Fixture } from "../../../test/drive.js";

export const ACCOUNT = "person-a@example.com";
export const API_SOURCE = `google-calendar:${ACCOUNT}:cloud`;
export const EXPORT_SOURCE = `google-calendar:${ACCOUNT}:export`;
export const FETCHED_AT = "2026-09-07T04:00:00.000Z";

const hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export const PRIMARY_PAGE_1: JsonObject[] = [
  {
    kind: "calendar#event",
    id: "evt0001",
    status: "confirmed",
    iCalUID: "evt0001@google.com",
    summary: "Synthetic planning, a long title that runs past the seventy-five octet fold — with ünïcödé",
    description: "Line one\nLine two; with a comma, and a backslash \\ here",
    location: "Room 1, Example Building",
    created: "2026-08-01T10:00:00.000Z",
    updated: "2026-08-02T11:30:15.250Z",
    sequence: 2,
    transparency: "opaque",
    organizer: { email: "person-b@example.com", displayName: 'Person "B"' },
    attendees: [
      { email: ACCOUNT, responseStatus: "accepted", self: true },
      { email: "person-c@example.com", displayName: "Person C", optional: true, responseStatus: "needsAction" },
      { email: "person-b@example.com", organizer: true, responseStatus: "tentative" },
    ],
    start: { dateTime: "2026-09-08T10:00:00+05:30", timeZone: "Asia/Kolkata" },
    end: { dateTime: "2026-09-08T11:00:00.000+05:30", timeZone: "Asia/Kolkata" },
  },
  {
    kind: "calendar#event",
    id: "evt0002",
    status: "confirmed",
    iCalUID: "evt0002@google.com",
    summary: "Synthetic trip",
    start: { date: "2026-09-10" },
    end: { date: "2026-09-13" },
  },
  {
    kind: "calendar#event",
    id: "evt0003",
    status: "confirmed",
    iCalUID: "evt0003@google.com",
    summary: "One synthetic day",
    transparency: "transparent",
    start: { date: "2026-09-14" },
    end: { date: "2026-09-15" },
  },
];

export const PRIMARY_PAGE_2: JsonObject[] = [
  {
    kind: "calendar#event",
    id: "series01",
    status: "confirmed",
    iCalUID: "series01@google.com",
    summary: "Weekly synthetic sync",
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20260921T033000Z"],
    start: { dateTime: "2026-09-07T09:00:00+05:30", timeZone: "Asia/Kolkata" },
    end: { dateTime: "2026-09-07T09:30:00+05:30", timeZone: "Asia/Kolkata" },
  },
  {
    kind: "calendar#event",
    id: "series01_20260914T033000Z",
    status: "confirmed",
    iCalUID: "series01@google.com",
    summary: "Weekly synthetic sync (moved)",
    recurringEventId: "series01",
    originalStartTime: { dateTime: "2026-09-14T09:00:00+05:30", timeZone: "Asia/Kolkata" },
    start: { dateTime: "2026-09-14T11:00:00+05:30", timeZone: "Asia/Kolkata" },
    end: { dateTime: "2026-09-14T11:30:00+05:30", timeZone: "Asia/Kolkata" },
  },
  {
    kind: "calendar#event",
    id: "series02_20260920",
    status: "cancelled",
    iCalUID: "series02@google.com",
    recurringEventId: "series02",
    originalStartTime: { date: "2026-09-20" },
    start: { date: "2026-09-20" },
    end: { date: "2026-09-21" },
  },
  { kind: "calendar#event", id: "evt0009", status: "cancelled" },
  { kind: "calendar#event", id: "evt0010", status: "cancelled", iCalUID: "evt0010@google.com" },
];

export const SECOND_PAGE: JsonObject[] = [
  {
    kind: "calendar#event",
    id: "utc0001",
    status: "confirmed",
    iCalUID: "utc0001@google.com",
    summary: "UTC synthetic call",
    start: { dateTime: "2026-09-09T15:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-09-09T15:45:00Z" },
  },
];

function page(items: JsonObject[], next: { nextPageToken?: string; nextSyncToken?: string }): Buffer {
  return Buffer.from(JSON.stringify({ kind: "calendar#events", summary: ACCOUNT, items, ...next }));
}

export function apiPull(): { files: Record<string, Buffer>; facts: JsonObject } {
  const files: Record<string, Buffer> = {
    "calendar-0-page-1.json": page(PRIMARY_PAGE_1, { nextPageToken: "page-2" }),
    "calendar-0-page-2.json": page(PRIMARY_PAGE_2, { nextSyncToken: "sync-primary-1" }),
    "calendar-1-page-1.json": page(SECOND_PAGE, { nextSyncToken: "sync-second-1" }),
  };
  const calendars = ["primary", "primary", "second@group.calendar.google.com"];
  const pages = Object.entries(files).map(([file, bytes], index) => ({ file, sha256: hex(bytes), bytes: bytes.length, calendar_id: calendars[index]! }));
  const manifest = {
    format: "org.lifestreamprotocol.google-calendar-api-pull/0.1",
    complete: true,
    account: ACCOUNT,
    fetched_at: FETCHED_AT,
    pages,
    next_sync_tokens: [
      { calendar_id: "primary", sync_token: "sync-primary-1" },
      { calendar_id: "second@group.calendar.google.com", sync_token: "sync-second-1" },
    ],
  };
  files["pull.json"] = Buffer.from(`${JSON.stringify(manifest)}\n`);
  return { files, facts: { fetched_at: FETCHED_AT, account: ACCOUNT, pages: pages.length } };
}

const ics = (lines: string[]): Buffer => Buffer.from(lines.join("\r\n"), "utf8");

const ZONES = [
  "BEGIN:VTIMEZONE",
  "TZID:Asia/Kolkata",
  "X-LIC-LOCATION:Asia/Kolkata",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0530",
  "TZOFFSETTO:+0530",
  "TZNAME:GMT+05:30",
  "DTSTART:19700101T000000",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:GMT-04:00",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:GMT-05:00",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

export function primaryIcs(): Buffer {
  return ics([
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${ACCOUNT}`,
    "X-WR-TIMEZONE:Asia/Kolkata",
    ...ZONES,
    "BEGIN:VEVENT",
    "DTSTART:20260908T043000Z",
    "DTEND:20260908T053000Z",
    "DTSTAMP:20260907T040000Z",
    "UID:evt0001@google.com",
    "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=person-a@exa",
    " mple.com;X-NUM-GUESTS=0:mailto:person-a@example.com",
    "CREATED:20260801T100000Z",
    "DESCRIPTION:Line one\\nLine two\\; with a comma\\, and a backslash \\\\ here",
    "LAST-MODIFIED:20260802T113015Z",
    "LOCATION:Room 1\\, Example Building",
    "SEQUENCE:2",
    "STATUS:CONFIRMED",
    "SUMMARY:Synthetic planning",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20260910",
    "DTEND;VALUE=DATE:20260913",
    "DTSTAMP:20260907T040000Z",
    "UID:evt0002@google.com",
    "SUMMARY:Synthetic trip",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=Asia/Kolkata:20260907T090000",
    "DTEND;TZID=Asia/Kolkata:20260907T093000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO",
    "DTSTAMP:20260907T040000Z",
    "UID:series01@google.com",
    "SUMMARY:Weekly synthetic sync",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=Asia/Kolkata:20260914T110000",
    "DTEND;TZID=Asia/Kolkata:20260914T113000",
    "DTSTAMP:20260907T040000Z",
    "UID:series01@google.com",
    "RECURRENCE-ID;TZID=Asia/Kolkata:20260914T090000",
    "SUMMARY:Weekly synthetic sync (moved)",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20260715T090000",
    "DTEND;TZID=America/New_York:20260715T100000",
    "DTSTAMP:20260907T040000Z",
    "UID:ny0001@google.com",
    "SUMMARY:Summer synthetic call",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20261215T090000",
    "DTEND;TZID=America/New_York:20261215T100000",
    "DTSTAMP:20260907T040000Z",
    "UID:ny0002@google.com",
    "SUMMARY:Winter synthetic call",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
}

export function birthdaysIcs(): Buffer {
  return ics([
    "BEGIN:VCALENDAR",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20260920",
    "DTEND;VALUE=DATE:20260921",
    "RRULE:FREQ=YEARLY",
    "UID:bday0001@google.com",
    "SUMMARY:Synthetic birthday",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;VALUE=DATE:20260922",
    "DTEND;VALUE=DATE:20260923",
    "RECURRENCE-ID;VALUE=DATE:20260920",
    "UID:bday0001@google.com",
    "SUMMARY:Synthetic birthday (moved)",
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
}

export const EXPORT_FILES = {
  [`${ACCOUNT}.ics`]: primaryIcs,
  [`Birthdays_${ACCOUNT}.ics`]: birthdaysIcs,
};

export const EXPORT_FACTS: JsonObject = { exported_at: "2026-09-07T03:00:00Z", fetched_at: "2026-09-07T04:00:00Z" };

export const apiFixture: Fixture = (folder) => {
  const pull = apiPull();
  for (const [path, bytes] of Object.entries(pull.files)) writeFileSync(join(folder, path), bytes);
  return {
    source: API_SOURCE, facts: pull.facts, files: Object.fromEntries(Object.keys(pull.files).map((path) => [path, "trust" as const])),
    heads: [
      "event evt0001@google.com", "event evt0002@google.com", "event evt0003@google.com", "event series01@google.com",
      "event series01@google.com:20260914T033000Z", "event series02@google.com:20260920", "event utc0001@google.com",
    ],
  };
};

export const exportFixture: Fixture = (folder) => {
  for (const [path, make] of Object.entries(EXPORT_FILES)) writeFileSync(join(folder, path), make());
  const events = (keys: string[]) => ({ alone: keys.map((key) => `event ${key}`) });
  return {
    source: EXPORT_SOURCE,
    facts: EXPORT_FACTS,
    files: {
      [`${ACCOUNT}.ics`]: events(["evt0001@google.com", "evt0002@google.com", "series01@google.com", "series01@google.com:20260914T033000Z", "ny0001@google.com", "ny0002@google.com"]),
      [`Birthdays_${ACCOUNT}.ics`]: events(["bday0001@google.com", "bday0001@google.com:20260920"]),
    },
  };
};
