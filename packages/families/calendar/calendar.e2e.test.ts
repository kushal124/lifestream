import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { daysOf, type DaySettings, type Instant, type Json, type ReaderOutput } from "@lifestreamprotocol/core";
import { readLabels } from "../shared/labels.js";
import { renderDay, type DayDocument, tableUnits } from "../days.js";
import { dayReader, sha256, TestHome } from "../test/drive.js";
import { FED, NETWORKED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { calendarFamily } from "./family.js";

const calendar = calendarFamily({ books: FED.labels })(FED.calendar);
const GOLDEN = new URL("./test/day.golden.txt", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const EXPORT = "google-calendar:person-a@example.com:export";
const API = "google-calendar:person-a@example.com:cloud";
const CONTACTS = "apple-contacts:person-a@example.com:iphone-aa01";
const T0 = Date.UTC(2026, 9, 6, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Event { key: string; lines: string[]; time: Instant; modified?: string | undefined; stamp?: string; sequence?: number; extra?: Record<string, Json> }

function vevent(event: Event): string {
  return [
    "BEGIN:VEVENT",
    `DTSTAMP:${event.stamp ?? "20261006T120000Z"}`,
    `UID:${event.key.split(":")[0]}`,
    ...event.lines,
    ...(event.modified === undefined ? [] : [`LAST-MODIFIED:${event.modified}`]),
    `SEQUENCE:${event.sequence ?? 0}`,
    "END:VEVENT",
    "",
  ].join("\r\n");
}

function row(event: Event): ReaderOutput {
  return { kind: "event", key: event.key, content: { type: "calendar.event", content: vevent(event), ...event.extra }, time: event.time };
}

const at = (iso: string) => Date.parse(iso);
const dates = (first: string, after: string): Instant => ({ start_ms: at(`${first}T00:00:00Z`), end_ms: at(`${after}T00:00:00Z`), precision: "day" });

const MEETING: Event = {
  key: "meeting-1@example.com",
  time: { start_ms: at("2026-10-07T16:00:00Z"), end_ms: at("2026-10-07T17:00:00Z"), offset_min: -420, precision: "s" },
  modified: "20261005T100000Z",
  lines: [
    "DTSTART;TZID=America/Los_Angeles:20261007T090000",
    "DTEND;TZID=America/Los_Angeles:20261007T100000",
    "SUMMARY:Synthetic planning\\, round two",
    "ORGANIZER;CN=Person B:mailto:person-b@example.com",
    "ATTENDEE;CN=Person A;PARTSTAT=ACCEPTED:mailto:Person-A@example.com",
    "ATTENDEE;CN=Person B;PARTSTAT=ACCEPTED:mailto:person-b@example.com",
    "ATTENDEE;PARTSTAT=TENTATIVE:mailto:person-c@example.com",
    "X-GOOGLE-CONFERENCE:https://meet.google.com/aaa-bbbb-ccc",
    "LOCATION:Room 4\\, synthetic building",
    "DESCRIPTION:Agenda for the synthetic meeting.",
  ],
};
const MEETING_API: Event = { ...MEETING, lines: MEETING.lines.map((line) => line.startsWith("DESCRIPTION:") ? "DESCRIPTION:(placeholder)" : line) };
const HOLIDAY: Event = { key: "holiday-1@example.com", time: dates("2026-10-08", "2026-10-09"), modified: "20261001T000000Z", lines: ["DTSTART;VALUE=DATE:20261008", "DTEND;VALUE=DATE:20261009", "SUMMARY:Synthetic holiday", "TRANSP:TRANSPARENT"] };
const TRIP: Event = { key: "trip-1@example.com", time: dates("2026-10-09", "2026-10-12"), modified: "20261001T000000Z", lines: ["DTSTART;VALUE=DATE:20261009", "DTEND;VALUE=DATE:20261012", "SUMMARY:Synthetic trip"] };
const SERIES: Event = {
  key: "series-1@example.com",
  time: { start_ms: at("2026-10-06T15:00:00Z"), end_ms: at("2026-10-06T15:30:00Z"), offset_min: 0, precision: "s" },
  modified: "20261001T000000Z",
  lines: ["DTSTART:20261006T150000Z", "DTEND:20261006T153000Z", "RRULE:FREQ=WEEKLY;BYDAY=TU", "SUMMARY:Synthetic standup"],
};
const CANCELLED: Event = {
  key: "series-1@example.com:20261013T150000Z",
  time: { start_ms: at("2026-10-13T15:00:00Z"), end_ms: at("2026-10-13T15:30:00Z"), offset_min: 0, precision: "s" },
  modified: "20261002T000000Z",
  lines: ["RECURRENCE-ID:20261013T150000Z", "DTSTART:20261013T150000Z", "DTEND:20261013T153000Z", "STATUS:CANCELLED", "SUMMARY:Synthetic standup"],
};
const LATE: Event = {
  key: "late-1@example.com",
  time: { start_ms: at("2026-10-08T03:30:00Z"), end_ms: at("2026-10-08T09:00:00Z"), offset_min: 0, precision: "s" },
  modified: "20261001T000000Z",
  lines: ["DTSTART:20261008T033000Z", "DTEND:20261008T090000Z", "SUMMARY:Synthetic night shift", "STATUS:TENTATIVE"],
};

const EXPORT_EVENTS = [MEETING, HOLIDAY, TRIP, SERIES, CANCELLED, LATE];
const API_EVENTS = [MEETING_API, SERIES, CANCELLED];

function card(name: string, email: string): ReaderOutput {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nEMAIL:${email}\r\nEND:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
}

const extracts = (h: TestHome) => h.read((view) => [...view.extracts("calendar")].map(({ unit, reading, content, days, start_ms, end_ms }) =>
  ({ unit, reading, content, days, start_ms, end_ms })));

function renderAll(h: TestHome, settings = SETTINGS): Map<string, DayDocument> {
  const days = h.read((view) => [...new Set([...view.extracts("calendar")].flatMap((extract) => calendar.days(extract, settings)))].sort());
  const rendered = h.renderDays(days, (view) => readLabels(view, null, NETWORKED), [calendar], settings);
  return new Map([...rendered].map(([day, files]) => [day, JSON.parse(files.json) as DayDocument]));
}

const homes: TestHome[] = [];
function home(prefix: string): TestHome {
  const opened = new TestHome(`families-calendar-${prefix}-`);
  homes.push(opened);
  return opened;
}
afterEach(() => {
  for (const opened of homes.splice(0)) opened.close();
});

function seed(h: TestHome, settings = SETTINGS): void {
  h.land(EXPORT, T0, EXPORT_EVENTS.map(row));
  h.land(API, T0, API_EVENTS.map(row));
  h.extractPass(calendar, settings);
}

describe("calendar family", () => {
  it("an event You organised from another address of theirs names the owner by name, or names anyone but the user", () => {
    const h = home("you");
    const you = (me: boolean): ReaderOutput => ({
      kind: "person", key: "sam",
      content: {
        type: "people.person", slug: "sam", name: "Sam", full_name: "Sam Example", show: "name", entity: "person", relationship: null, hidden: false, me,
        anchor: { kind: "email", value: "sam@example.com" }, handles: [{ kind: "email", value: "sam-work@example.com" }], excluded: [], dismissed: [], merged_into: null,
      },
    });
    const STANDUP: Event = {
      key: "standup-1@example.com", time: { start_ms: at("2026-10-07T13:00:00Z"), end_ms: at("2026-10-07T13:15:00Z"), offset_min: 0, precision: "s" },
      lines: [
        "DTSTART:20261007T130000Z", "DTEND:20261007T131500Z", "SUMMARY:Standup", "ORGANIZER;CN=Sam:mailto:sam-work@example.com",
        ...["sam-work@example.com", "person-b@example.com", "person-c@example.com", "person-d@example.com"].map((address) => `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${address}`),
      ],
    };
    h.land(EXPORT, T0, [row(STANDUP)]);
    h.land("people:local:macbook-pro-0001", T0, [you(false)]);
    h.extractPass(calendar, SETTINGS);
    const line = () => [...renderAll(h).values()].flatMap((day) => day.atoms).find((atom) => atom.family === "calendar")?.text;
    const before = line();
    expect(before).toMatch(/^Event “Standup”, organised by Sam, 4 attendees\b/u);
    h.land("people:local:macbook-pro-0001", T0 + 1, [you(true)]);
    const after = line();
    expect(after).toMatch(/^Event “Standup”, organised by the user, 4 attendees\b/u);
    h.artifact("you.json", { before, after });
  });

  it("an event's search text misses its title, place, notes or people, or holds its ids and times", () => {
    const h = home("texts");
    seed(h);
    const meeting = {
      title: "Synthetic planning, round two",
      text: "Room 4, synthetic building\nAgenda for the synthetic meeting.",
      who: ["person-b@example.com", "person-a@example.com", "person-c@example.com"],
    };
    const titled = (title: string) => ({ title, text: "" });
    expect(Object.fromEntries(h.texts(calendar).map(({ record, text }) => [record, text]))).toEqual({
      [`${API} event ${MEETING.key}`]: { ...meeting, text: "Room 4, synthetic building\n(placeholder)" },
      [`${API} event ${SERIES.key}`]: titled("Synthetic standup"),
      [`${API} event ${CANCELLED.key}`]: titled("Synthetic standup"),
      [`${EXPORT} event ${MEETING.key}`]: meeting,
      [`${EXPORT} event ${HOLIDAY.key}`]: titled("Synthetic holiday"),
      [`${EXPORT} event ${TRIP.key}`]: titled("Synthetic trip"),
      [`${EXPORT} event ${SERIES.key}`]: titled("Synthetic standup"),
      [`${EXPORT} event ${CANCELLED.key}`]: titled("Synthetic standup"),
      [`${EXPORT} event ${LATE.key}`]: titled("Synthetic night shift"),
    });
    h.artifact("texts.json", h.texts(calendar));
  });

  it("an extract is written when only an unread field ticked", () => {
    const h = home("tick");
    seed(h);
    const before = extracts(h);
    const tick = (event: Event, index: number, api: boolean): Event => ({
      ...event, stamp: "20261007T080000Z", sequence: index + 3,
      ...(api ? { modified: "20261006T235959Z", extra: { etag: `"${index}-synthetic"`, updated: "2026-10-06T23:59:59.000Z" } } : {}),
    });
    const landed = [h.land(EXPORT, T0 + HOUR, EXPORT_EVENTS.map((event, index) => row(tick(event, index, false)))),
      h.land(API, T0 + HOUR, API_EVENTS.map((event, index) => row(tick(event, index, true))))];
    expect(landed.reduce((sum, value) => sum + value.changed, 0)).toBe(EXPORT_EVENTS.length + API_EVENTS.length);
    const pass = h.extractPass(calendar, SETTINGS);
    expect(pass.touched).toHaveLength(EXPORT_EVENTS.length);
    expect(pass.written).toEqual([]);
    expect(extracts(h)).toEqual(before);
    h.artifact("tick.json", { changedPaths: landed.map((value) => value.changedPaths), pass });
  });

  it("units differ when the same data arrives in another order", () => {
    const forward = home("forward");
    seed(forward);
    const backward = home("backward");
    API_EVENTS.forEach((event, index) => backward.land(API, T0 + index, [row(event)]));
    [...EXPORT_EVENTS].reverse().forEach((event, index) => backward.land(EXPORT, T0 + index, [row(event)]));
    backward.land(EXPORT, T0 - DAY, [row({ ...MEETING, lines: [...MEETING.lines.slice(0, 2), "SUMMARY:An older title"] })]);
    backward.extractPass(calendar, SETTINGS);
    expect(extracts(backward)).toEqual(extracts(forward));
    forward.artifact("units.json", extracts(forward));
    pin(calendar, { calendar: FED.calendar }, extracts(forward));
  });

  it("an event asks a model", () => {
    const h = home("asks");
    seed(h);
    expect(calendar.plan).toBeUndefined();
    expect(calendar.items).toBeUndefined();
    expect(calendar.prompts).toBeUndefined();
    const rendered = renderAll(h);
    expect([...rendered.values()].flatMap((day) => day.atoms).filter((atom) => atom.item !== undefined)).toEqual([]);
  });

  it("one event on two channels prints twice", () => {
    const h = home("replicas");
    seed(h);
    const atoms = [...renderAll(h).values()].flatMap((day) => day.atoms);
    const meeting = atoms.filter((atom) => atom.text.startsWith("Event “Synthetic planning"));
    expect(meeting).toHaveLength(1);
    expect(meeting[0]!.record!.source).toBe(EXPORT);
    h.land(API, T0 + HOUR, [row({ ...MEETING_API, modified: "20261006T000000Z", lines: [...MEETING_API.lines, "STATUS:CANCELLED"] })]);
    expect(h.extractPass(calendar, SETTINGS).written).toHaveLength(1);
    const moved = [...renderAll(h).values()].flatMap((day) => day.atoms).filter((atom) => atom.text.startsWith("Event “Synthetic planning"));
    expect(moved.map((atom) => [atom.record!.source, atom.text.endsWith("cancelled")])).toEqual([[API, true]]);
  });

  it("a cancellation on one channel brings back the other channel's older copy", () => {
    const h = home("cancel");
    seed(h);
    const unit = `person-a@example.com/${MEETING.key}`;
    const meetingLines = () => [...renderAll(h).values()].flatMap((day) => day.atoms).filter((atom) => atom.units.includes(unit)).map((atom) => atom.text);
    expect(meetingLines()).toHaveLength(1);
    h.land(API, T0 + HOUR, [{ kind: "event", key: MEETING.key, content: null, gone: true }]);
    expect(h.extractPass(calendar, SETTINGS).deleted).toEqual([unit]);
    expect(meetingLines()).toEqual([]);
    h.land(EXPORT, T0 + 2 * HOUR, [row({ ...MEETING, stamp: "20261006T140000Z" })]);
    const stale = h.extractPass(calendar, SETTINGS);
    expect(stale.touched).toEqual([unit]);
    expect(stale.written).toEqual([]);
    expect(meetingLines()).toEqual([]);
    h.land(EXPORT, T0 + 3 * HOUR, [row({ ...MEETING, modified: "20261006T143000Z" })]);
    expect(h.extractPass(calendar, SETTINGS).written).toEqual([unit]);
    expect(meetingLines()).toHaveLength(1);
    h.artifact("cancel.json", extracts(h));
  });

  it("an event with no LAST-MODIFIED prints nothing", () => {
    const h = home("unmodified");
    const BARE: Event = { ...LATE, key: "bare-1@example.com", modified: undefined, lines: ["DTSTART:20261008T033000Z", "DTEND:20261008T090000Z", "SUMMARY:Synthetic bare event"] };
    const unit = `person-a@example.com/${BARE.key}`;
    h.land(EXPORT, T0, [row(BARE)]);
    expect(h.extractPass(calendar, SETTINGS).written).toEqual([unit]);
    const lines = () => [...renderAll(h).values()].flatMap((day) => day.atoms).filter((atom) => atom.units.includes(unit)).map((atom) => atom.text);
    expect(lines()).toEqual(["Event “Synthetic bare event”", "Event “Synthetic bare event”"]);
    h.land(API, T0 + HOUR, [{ kind: "event", key: BARE.key, content: null, gone: true }]);
    expect(h.extractPass(calendar, SETTINGS).deleted).toEqual([unit]);
    expect(lines()).toEqual([]);
    h.artifact("unmodified.json", extracts(h));
  });

  it("a renamed contact re-asks anything", () => {
    const h = home("rename");
    const before = card("Person B", "person-b@example.com");
    h.land(CONTACTS, T0, [before]);
    seed(h);
    const first = extracts(h);
    const named = [...renderAll(h).values()].flatMap((day) => day.atoms).filter((atom) => atom.text.includes("organised by Person B,"));
    expect(named).toHaveLength(1);
    h.land(CONTACTS, T0 + HOUR, [{ ...before, content: null, gone: true }, card("Person B Renamed", "person-b@example.com")]);
    expect(h.extractPass(calendar, SETTINGS)).toEqual({ touched: [], written: [], deleted: [] });
    expect(extracts(h)).toEqual(first);
    const renamed = [...renderAll(h).values()].flatMap((day) => day.atoms).filter((atom) => atom.text.includes("organised by Person B Renamed"));
    expect(renamed).toHaveLength(1);
  });

  it("renderDay reads outside days()", () => {
    const h = home("days");
    seed(h);
    const range = Array.from({ length: 12 }, (_, index) => new Date(at("2026-10-04T00:00:00Z") + index * DAY).toISOString().slice(0, 10));
    const printed = new Map<string, string[]>();
    const reads: { day: string; unit: string; days: string[] }[] = [];
    h.read((view) => {
      const reader = dayReader(view);
      for (const day of range) {
        const files = renderDay(day, [calendar], {
          ...reader,
          extractsOn: (family, on) => [...reader.extractsOn(family, on)].map((extract) => {
            reads.push({ day: on, unit: extract.unit, days: extract.days });
            return extract;
          }),
        }, SETTINGS, tableUnits(readLabels(view, null, NETWORKED)));
        for (const atom of (JSON.parse(files.json) as DayDocument).atoms) for (const unit of atom.units) printed.set(unit, [...printed.get(unit) ?? [], day]);
      }
    });
    for (const entry of reads) expect(entry.days).toContain(entry.day);
    for (const event of EXPORT_EVENTS) {
      expect(printed.get(`person-a@example.com/${event.key}`), event.key).toEqual(daysOf(event.time, SETTINGS));
    }
    expect(printed.get(`person-a@example.com/${LATE.key}`)).toEqual(["2026-10-07", "2026-10-08"]);
    expect(printed.get(`person-a@example.com/${TRIP.key}`)).toEqual(["2026-10-09", "2026-10-10", "2026-10-11"]);
    const extract = h.read((view) => view.extract("calendar", `person-a@example.com/${MEETING.key}`)!);
    const stray = h.read((view) => renderDay("2026-10-20", [calendar], { ...dayReader(view), extractsOn: () => [{ ...extract, days: ["2026-10-20"] }] }, SETTINGS, tableUnits(readLabels(view, null, NETWORKED))));
    expect((JSON.parse(stray.json) as DayDocument).atoms).toEqual([]);
    h.artifact("reads.json", { reads, printed: Object.fromEntries(printed) });

    const golden = h.renderDays(["2026-10-07"], (view) => readLabels(view, null, NETWORKED), [calendar], SETTINGS).get("2026-10-07")!.txt;
    if (UPDATE) writeFileSync(GOLDEN, golden);
    expect(golden).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("a date-only event moves to another date when the zone changes", () => {
    const place = (settings: DaySettings) => {
      const h = home("zone");
      seed(h, settings);
      const days = renderAll(h, settings);
      return Object.fromEntries([...days].map(([day, document]) => [day, document.atoms.filter((atom) => atom.flags.includes("date_only")).flatMap((atom) => atom.units)]).filter(([, units]) => units!.length > 0));
    };
    const newYork = place(SETTINGS);
    expect(place({ zone: "Pacific/Kiritimati", day_start_hour: 0 })).toEqual(newYork);
    expect(place({ zone: "Pacific/Pago_Pago", day_start_hour: 6 })).toEqual(newYork);
    expect(newYork).toEqual({
      "2026-10-08": [`person-a@example.com/${HOLIDAY.key}`],
      "2026-10-09": [`person-a@example.com/${TRIP.key}`],
      "2026-10-10": [`person-a@example.com/${TRIP.key}`],
      "2026-10-11": [`person-a@example.com/${TRIP.key}`],
    });
  });
});
