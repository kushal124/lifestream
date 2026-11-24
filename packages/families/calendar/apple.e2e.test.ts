import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { DaySettings, Instant, JsonObject, ReaderOutput } from "@lifestreamprotocol/core";
import { readLabels } from "../shared/labels.js";
import type { DayDocument } from "../days.js";
import { TestHome } from "../test/drive.js";
import { FED, NETWORKED } from "../test/fed.js";
import { calendarFamily } from "./family.js";

const calendar = calendarFamily({ books: FED.labels })(FED.calendar);
const GOLDEN = new URL("./test/apple-day.golden.txt", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const MAC = "apple-calendar:person-a@example.com:macbook-pro-0001";
const OTHER_MAC = "apple-calendar:person-a@example.com:macbook-air-bb01";
const REMINDERS = "apple-reminders:person-a@example.com:macbook-pro-0001";
const EXPORT = "google-calendar:person-a@example.com:export";
const API = "google-calendar:person-a@example.com:cloud";
const T0 = Date.UTC(2026, 9, 7, 12);
const HOUR = 3_600_000;
const HOME = "/1/calendars/home/";

const at = (iso: string) => Date.parse(iso);
const cd = (iso: string) => at(iso) / 1000 - 978_307_200;
const timed = (start: string, end: string): Instant => ({ start_ms: at(start), end_ms: at(end), precision: "s" });
const date = (day: string): Instant => ({ start_ms: at(`${day}T00:00:00Z`), end_ms: at(`${day}T00:00:00Z`) + 24 * HOUR, precision: "day" });

function item(row: JsonObject, members: JsonObject = {}): JsonObject {
  return {
    type: "apple.calendar-item", item: row,
    calendar: { UUID: "SYNTH-CAL-0001", external_id: "/1/calendars/home/", title: "Home", color: "#1BADF8" },
    store: { name: "iCloud", type: 2, external_id: "SYNTH-STORE-ICLOUD" },
    location: null, start_location: null, end_location: null, client_location: null, organizer: null, self_attendee: null,
    suggestion: null, error: null, image: null, color: null,
    participants: [], recurrences: [], exception_dates: [], alarms: [], attachments: [], conferences: [], categories: [], actions: [], contacts: [],
    ...members,
  };
}

const PERSON_B = { entity_type: 8, type: 1, status: 0, role: 0, UUID: "SYNTH-PART-0001", email: "person-b@example.com", is_self: 0, identity: { display_name: "Person B", address: "mailto:person-b@example.com" } };
const SELF = { entity_type: 7, type: 1, status: 2, role: 1, UUID: "SYNTH-PART-0002", email: "person-a@example.com", is_self: 1, identity: { display_name: "Person A", address: "mailto:person-a@example.com" } };
const PERSON_C = { entity_type: 7, type: 1, status: 1, role: 1, UUID: "SYNTH-PART-0003", email: "person-c@example.com", is_self: 0, identity: { address: "mailto:person-c@example.com" } };

const INVITE: ReaderOutput = {
  kind: "event", key: `SYNTH-UID-0001:${HOME}`, time: timed("2026-10-07T13:30:00Z", "2026-10-07T14:30:00Z"),
  content: item(
    { summary: "Fake review", start_date: cd("2026-10-07T13:30:00Z"), start_tz: "America/New_York", end_date: cd("2026-10-07T14:30:00Z"), end_tz: "America/New_York",
      all_day: 0, status: 1, unique_identifier: "SYNTH-UID-0001", entity_type: 2, last_modified: cd("2026-10-01T00:00:00Z") },
    { organizer: PERSON_B, participants: [PERSON_B, SELF, PERSON_C], location: { title: "Fake Room 1", address: "1 Example Street\nFake City" },
      conferences: [{ uuid: "SYNTH-CONF-0001", url: "https://example.com/call/1", feature: "video" }] },
  ),
};
const INVITE_COPY: ReaderOutput = { ...INVITE, key: "SYNTH-UID-0001:SYNTH-CAL-0002", content: { ...INVITE.content as JsonObject, calendar: { UUID: "SYNTH-CAL-0002", title: "Work" } } };
const HOLIDAY: ReaderOutput = {
  kind: "event", key: "SYNTH-UID-0003:SYNTH-SUBSCRIPTION", time: date("2026-10-07"),
  content: item({ summary: "Fake holiday", start_date: cd("2026-10-07T00:00:00Z"), start_tz: "_float", end_date: cd("2026-10-07T23:59:59Z"), all_day: 1, unique_identifier: "SYNTH-UID-0003", entity_type: 2 },
    { calendar: { UUID: "SYNTH-CAL-0003", title: "Holidays", external_id: "SYNTH-SUBSCRIPTION" } }),
};
const SERIES: ReaderOutput = {
  kind: "event", key: `SYNTH-UID-0004:${HOME}`, time: timed("2026-10-07T15:00:00Z", "2026-10-07T15:30:00Z"),
  content: item({ summary: "Fake weekly", start_date: cd("2026-10-07T15:00:00Z"), start_tz: "Europe/London", end_date: cd("2026-10-07T15:30:00Z"), all_day: 0, unique_identifier: "SYNTH-UID-0004", entity_type: 2, has_recurrences: 1 },
    { recurrences: [{ frequency: 2, interval: 1, week_start: 1, count: 0, UUID: "SYNTH-RECUR-0001" }] }),
};
const FLOATING: ReaderOutput = {
  kind: "event", key: `SYNTH-UID-0005:${HOME}`,
  content: item({ summary: "Fake floating", start_date: cd("2026-10-07T09:00:00Z"), start_tz: "_float", end_date: cd("2026-10-07T10:00:00Z"), all_day: 0, unique_identifier: "SYNTH-UID-0005", entity_type: 2 }),
};
const SHARED_KEY = "SYNTH-UID-0006@google.com";
const SHARED_MAC: ReaderOutput = {
  kind: "event", key: `${SHARED_KEY}:SYNTH-CAL-0002`, time: timed("2026-10-07T17:00:00Z", "2026-10-07T17:30:00Z"),
  content: item({ summary: "Fake sync, Mac copy", start_date: cd("2026-10-07T17:00:00Z"), start_tz: "America/New_York", end_date: cd("2026-10-07T17:30:00Z"), all_day: 0, unique_identifier: SHARED_KEY, entity_type: 2, last_modified: cd("2026-10-06T00:00:00Z") },
    { calendar: { UUID: "SYNTH-CAL-0002", title: "person-a@example.com" }, store: { name: "person-a@example.com", type: 2 } }),
};
const SHARED_GOOGLE: ReaderOutput = {
  kind: "event", key: SHARED_KEY, time: timed("2026-10-07T17:00:00Z", "2026-10-07T17:30:00Z"),
  content: { type: "calendar.event", content: ["BEGIN:VEVENT", `UID:${SHARED_KEY}`, "DTSTART:20261007T170000Z", "DTEND:20261007T173000Z", "SUMMARY:Fake sync", "LAST-MODIFIED:20261005T000000Z", "END:VEVENT", ""].join("\r\n") },
};
const MOVED_KEY = `SYNTH-UID-0007:${HOME}`;
const MOVED_STALE: ReaderOutput = {
  kind: "event", key: MOVED_KEY, time: timed("2026-10-07T18:00:00Z", "2026-10-07T19:00:00Z"),
  content: item({ summary: "Fake dinner", start_date: cd("2026-10-07T18:00:00Z"), start_tz: "America/New_York", end_date: cd("2026-10-07T19:00:00Z"), all_day: 0, unique_identifier: "SYNTH-UID-0007", entity_type: 2, last_modified: cd("2026-10-01T00:00:00Z") }),
};
const MOVED: ReaderOutput = {
  kind: "event", key: MOVED_KEY, time: timed("2026-10-08T18:00:00Z", "2026-10-08T19:00:00Z"),
  content: item({ summary: "Fake dinner", start_date: cd("2026-10-08T18:00:00Z"), start_tz: "America/New_York", end_date: cd("2026-10-08T19:00:00Z"), all_day: 0, unique_identifier: "SYNTH-UID-0007", entity_type: 2, last_modified: cd("2026-10-05T00:00:00Z") }),
};

const CLOUD_USER = "_synthetic-user-0001";
function reminder(name: string, row: JsonObject, time?: Instant): ReaderOutput {
  return {
    kind: "reminder", key: `${name}:${CLOUD_USER}`, ...(time === undefined ? {} : { time }),
    content: { type: "apple.reminder", reminder: { ZIDENTIFIER: { $bytes64: "AAAA" }, ZCKIDENTIFIER: name, ...row },
      list: { entity: "REMCDList", ZNAME: "Fake list", ZCKIDENTIFIER: "SYNTH-LIST-0001" },
      account: { entity: "REMCDAccount", ZNAME: "iCloud", ZTYPE: 2, ZCKUSERRECORDNAME: CLOUD_USER },
      parent: null, objects: [], alerts: [] },
  };
}
const ERRAND_NAME = "11111111-2222-4333-8444-000000000001";
const ERRAND = reminder(ERRAND_NAME, { ZTITLE: "Fake errand", ZNOTES: "Synthetic errand notes.", ZALLDAY: 1, ZFLAGGED: 1, ZCOMPLETED: 0, ZDUEDATE: cd("2026-10-07T00:00:00Z"), ZLASTMODIFIEDDATE: cd("2026-10-02T00:00:00Z") }, date("2026-10-07"));
const CALL = reminder("11111111-2222-4333-8444-000000000002", {
  ZTITLE: "Fake call", ZALLDAY: 0, ZCOMPLETED: 1, ZDUEDATE: cd("2026-10-07T12:30:00Z"), ZTIMEZONE: "America/New_York", ZCOMPLETIONDATE: cd("2026-10-07T12:36:00Z"), ZLASTMODIFIEDDATE: cd("2026-10-07T12:36:00Z"),
}, { start_ms: at("2026-10-07T12:30:00Z"), precision: "s" });
const SOMEDAY_DONE = reminder("11111111-2222-4333-8444-000000000003", { ZTITLE: "Fake someday", ZCOMPLETED: 1, ZCOMPLETIONDATE: cd("2026-10-07T20:00:00Z") });
const SOMEDAY_OPEN = reminder("11111111-2222-4333-8444-000000000004", { ZTITLE: "Fake someday, open", ZCOMPLETED: 0 });
const DELETED = reminder("11111111-2222-4333-8444-000000000005", { ZTITLE: "Fake deleted", ZALLDAY: 1, ZMARKEDFORDELETION: 1, ZDUEDATE: cd("2026-10-07T00:00:00Z") }, date("2026-10-07"));
const LATE = reminder("11111111-2222-4333-8444-000000000006", {
  ZTITLE: "Fake late one", ZALLDAY: 1, ZCOMPLETED: 1, ZDUEDATE: cd("2026-10-06T00:00:00Z"), ZCOMPLETIONDATE: cd("2026-10-07T22:15:00Z"),
}, date("2026-10-06"));
const ERRAND_IN_CALENDAR: ReaderOutput = {
  kind: "reminder", key: `${ERRAND_NAME}:${HOME}`,
  content: item({ summary: "Fake errand (old)", description: "Synthetic errand notes, old.", entity_type: 3, due_date: cd("2026-10-07T00:00:00Z"), due_all_day: 1, due_tz: "_float", unique_identifier: ERRAND_NAME, last_modified: cd("2026-10-01T00:00:00Z") }),
};
const ERRAND_LOCAL: ReaderOutput = {
  ...ERRAND, key: `${ERRAND_NAME}:BBBBBBBB-0000-4000-8000-0000000000AC`,
  content: { ...ERRAND.content as JsonObject, reminder: { ...(ERRAND.content as { reminder: JsonObject }).reminder, ZTITLE: "Fake errand (local)", ZLASTMODIFIEDDATE: cd("2026-10-01T12:00:00Z") },
    account: { entity: "REMCDAccount", ZNAME: "Local", ZTYPE: 1 } },
};
const TASK: ReaderOutput = {
  kind: "reminder", key: "SYNTH-TASK-0001:SYNTH-CAL-0009",
  content: item({ summary: "Fake task", entity_type: 3, due_date: cd("2026-10-07T21:00:00Z"), due_all_day: 0, due_tz: "America/New_York", unique_identifier: "SYNTH-TASK-0001" },
    { calendar: { UUID: "SYNTH-CAL-0009", title: "Fake tasks" } }),
};

const MAC_ROWS = [INVITE, INVITE_COPY, HOLIDAY, SERIES, FLOATING, SHARED_MAC, MOVED, ERRAND_IN_CALENDAR, TASK];
const REMINDER_ROWS = [ERRAND, ERRAND_LOCAL, CALL, SOMEDAY_DONE, SOMEDAY_OPEN, DELETED, LATE];

const homes: TestHome[] = [];
function home(prefix: string): TestHome {
  const opened = new TestHome(`families-calendar-apple-${prefix}-`);
  homes.push(opened);
  return opened;
}
afterEach(() => {
  for (const opened of homes.splice(0)) opened.close();
});

function seed(h: TestHome): void {
  h.land(MAC, T0, MAC_ROWS);
  h.land(OTHER_MAC, T0, [MOVED_STALE]);
  h.land(REMINDERS, T0, REMINDER_ROWS);
  h.land(EXPORT, T0, [SHARED_GOOGLE]);
  h.extractPass(calendar, SETTINGS);
}

const extracts = (h: TestHome) => h.read((view) => [...view.extracts("calendar")].map(({ unit, reading, content, days, start_ms, end_ms }) =>
  ({ unit, reading, content, days, start_ms, end_ms })));

function render(h: TestHome, days: string[]): Map<string, DayDocument> {
  const rendered = h.renderDays(days, (view) => readLabels(view, null, NETWORKED), [calendar], SETTINGS);
  return new Map([...rendered].map(([day, files]) => [day, JSON.parse(files.json) as DayDocument]));
}

const atoms = (h: TestHome, days = ["2026-10-06", "2026-10-07", "2026-10-08"]) => [...render(h, days)].flatMap(([day, document]) =>
  document.atoms.map((atom) => ({ day, text: atom.text, source: atom.record?.source, key: atom.record?.key, units: atom.units })));

describe("calendar family: the Mac's stores", () => {
  it("an Apple event or reminder prints otherwise than the golden day", () => {
    const h = home("golden");
    seed(h);
    const printed = atoms(h);
    expect(printed.filter((atom) => atom.text.includes("Fake sync"))).toEqual([expect.objectContaining({ text: "Event “Fake sync”", source: EXPORT })]);
    expect(printed.filter((atom) => atom.text.includes("Fake review"))).toHaveLength(1);
    for (const title of ["Fake floating", "Fake someday, open", "Fake deleted"]) expect(printed.filter((atom) => atom.text.includes(title))).toEqual([]);
    expect(printed.filter((atom) => atom.text.includes("Fake errand"))).toEqual([expect.objectContaining({ source: REMINDERS, key: ERRAND.key })]);
    expect(printed.filter((atom) => atom.text.includes("Fake late one")).map((atom) => [atom.day, atom.text])).toEqual([
      ["2026-10-06", "Reminder “Fake late one” due, in Fake list, completed"],
      ["2026-10-07", "Reminder “Fake late one” completed, in Fake list"],
    ]);
    h.artifact("atoms.json", printed);
    const golden = h.renderDays(["2026-10-07"], (view) => readLabels(view, null, NETWORKED), [calendar], SETTINGS).get("2026-10-07")!.txt;
    if (UPDATE) writeFileSync(GOLDEN, golden);
    expect(golden).toBe(readFileSync(GOLDEN, "utf8"));
  });

  it("a meeting Google cancelled keeps printing from the Mac's copy, or the Mac's copy prints while Google holds it", () => {
    const h = home("cancel");
    h.land(MAC, T0, [SHARED_MAC]);
    h.extractPass(calendar, SETTINGS);
    const shared = () => atoms(h).filter((atom) => atom.key?.startsWith(SHARED_KEY)).map((atom) => [atom.source, atom.text]);
    expect(shared()).toEqual([[MAC, "Event “Fake sync, Mac copy”"]]);
    h.land(EXPORT, T0 + HOUR, [SHARED_GOOGLE]);
    const arrived = h.extractPass(calendar, SETTINGS);
    expect(arrived.deleted).toEqual([`apple-calendar:person-a@example.com/${SHARED_KEY}`]);
    expect(shared()).toEqual([[EXPORT, "Event “Fake sync”"]]);
    h.land(API, T0 + 2 * HOUR, [{ kind: "event", key: SHARED_KEY, content: null, gone: true }]);
    expect(h.extractPass(calendar, SETTINGS).deleted).toEqual([`person-a@example.com/${SHARED_KEY}`]);
    h.land(MAC, T0 + 3 * HOUR, [SHARED_MAC]);
    expect(h.extractPass(calendar, SETTINGS).written).toEqual([]);
    expect(shared()).toEqual([]);
    expect(h.read((view) => view.head({ source: MAC, kind: "event", key: SHARED_MAC.key })!.version)).not.toBe("gone");
    h.artifact("cancel.json", extracts(h));
  });

  it("a stale Mac's copy of a moved meeting prints on the day it moved from, or the two Macs' copies print twice", () => {
    const h = home("moved");
    seed(h);
    const dinner = atoms(h).filter((atom) => atom.text.includes("Fake dinner")).map((atom) => [atom.day, atom.source]);
    expect(dinner).toEqual([["2026-10-08", MAC]]);
    h.land(OTHER_MAC, T0 + HOUR, [MOVED]);
    h.extractPass(calendar, SETTINGS);
    expect(atoms(h).filter((atom) => atom.text.includes("Fake dinner")).map((atom) => [atom.day, atom.source])).toEqual([["2026-10-08", OTHER_MAC]]);
  });

  it("a Mac's event or reminder's search text misses its title, place, notes or people, or a reminder marked deleted has one", () => {
    const h = home("texts");
    seed(h);
    const id = (row: ReaderOutput) => row.key;
    const invite = {
      title: "Fake review", text: "Fake Room 1\n1 Example Street\nFake City",
      who: ["person-b@example.com", "person-a@example.com", "person-c@example.com"],
    };
    const titled = (title: string, text = "") => ({ title, text });
    expect(Object.fromEntries(h.texts(calendar).map(({ record, text }) => [record, text]))).toEqual({
      [`${EXPORT} event ${SHARED_KEY}`]: titled("Fake sync"),
      [`${MAC} event ${id(INVITE)}`]: invite,
      [`${MAC} event ${id(INVITE_COPY)}`]: invite,
      [`${MAC} event ${id(HOLIDAY)}`]: titled("Fake holiday"),
      [`${MAC} event ${id(SERIES)}`]: titled("Fake weekly"),
      [`${MAC} event ${id(FLOATING)}`]: titled("Fake floating"),
      [`${MAC} event ${id(SHARED_MAC)}`]: titled("Fake sync, Mac copy"),
      [`${MAC} event ${id(MOVED)}`]: titled("Fake dinner"),
      [`${MAC} reminder ${id(ERRAND_IN_CALENDAR)}`]: titled("Fake errand (old)", "Synthetic errand notes, old."),
      [`${MAC} reminder ${id(TASK)}`]: titled("Fake task"),
      [`${OTHER_MAC} event ${id(MOVED_STALE)}`]: titled("Fake dinner"),
      [`${REMINDERS} reminder ${id(ERRAND)}`]: titled("Fake errand", "Synthetic errand notes."),
      [`${REMINDERS} reminder ${id(ERRAND_LOCAL)}`]: titled("Fake errand (local)", "Synthetic errand notes."),
      [`${REMINDERS} reminder ${id(CALL)}`]: titled("Fake call"),
      [`${REMINDERS} reminder ${id(SOMEDAY_DONE)}`]: titled("Fake someday"),
      [`${REMINDERS} reminder ${id(SOMEDAY_OPEN)}`]: titled("Fake someday, open"),
      [`${REMINDERS} reminder ${id(DELETED)}`]: null,
      [`${REMINDERS} reminder ${id(LATE)}`]: titled("Fake late one"),
    });
    h.artifact("texts.json", h.texts(calendar));
  });

  it("units differ when the same data arrives in another order", () => {
    const forward = home("forward");
    seed(forward);
    const backward = home("backward");
    backward.land(EXPORT, T0, [SHARED_GOOGLE]);
    [...REMINDER_ROWS].reverse().forEach((row, index) => backward.land(REMINDERS, T0 + index, [row]));
    backward.land(OTHER_MAC, T0, [MOVED_STALE]);
    [...MAC_ROWS].reverse().forEach((row, index) => {
      backward.land(MAC, T0 + index, [row]);
      backward.extractPass(calendar, SETTINGS);
    });
    expect(extracts(backward)).toEqual(extracts(forward));
    forward.artifact("units.json", extracts(forward));
  });
});
