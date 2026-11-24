import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { BlobStore, Delivery, JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, damageOverflow, deliver, macBundle, openTestHome } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { gcalExport } from "../google/reader.js";
import { appleCalendar, CALENDAR_FILE } from "./reader.js";
import { createCalendarStore, DAY, DAY0, KEYS, reversed, SEQUENCE, SOURCE, write } from "./test/fixture.js";

const SNAPSHOT = { snapshot_taken_at: "2026-09-23T04:00:00.000Z", kind: "snapshot", through: SEQUENCE };

function shipped(blobs: BlobStore, path: string, facts: JsonObject = SNAPSHOT): Delivery {
  return deliver(blobs, SOURCE, { [CALENDAR_FILE]: readFileSync(path) }, facts);
}

const ms = (seconds: number): number => (seconds + 978_307_200) * 1000;
const withoutCalendar = (key: string): string => key.slice(0, key.lastIndexOf(":"));
const day = (date: string): number => Date.parse(`${date}T00:00:00Z`);

describe("Apple Calendar: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected, or drops a field the store states", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "Calendar.sqlitedb");
      createCalendarStore(path);
      const landed = await home.land(appleCalendar, shipped(home.blobs, path));
      expect(landed).toMatchObject({ new: 8, refused: 0, duplicated: 0 });
      const heads = home.heads(SOURCE);
      expect(heads.map((head) => [head.kind, head.key, head.start_ms, head.end_ms])).toEqual([
        ["event", KEYS.meeting, ms(DAY0 + DAY + 30_600), ms(DAY0 + DAY + 34_200)],
        ["event", KEYS.meetingCopy, ms(DAY0 + DAY + 30_600), ms(DAY0 + DAY + 34_200)],
        ["event", KEYS.series, ms(DAY0 + DAY + 30_600), ms(DAY0 + DAY + 32_400)],
        ["event", KEYS.moved, ms(DAY0 + 8 * DAY + 36_000), ms(DAY0 + 8 * DAY + 37_800)],
        ["event", KEYS.holiday, day("2026-10-02"), day("2026-10-03")],
        ["event", KEYS.allDaySeries, day("2026-10-02"), day("2026-10-04")],
        ["event", KEYS.allDayMoved, day("2026-10-10"), day("2026-10-11")],
        ["event", KEYS.floating, null, null],
      ].sort((left, right) => String(left[1]).localeCompare(String(right[1]))));

      const meeting = heads.find((head) => head.key === KEYS.meeting)!.content as JsonObject;
      const item = meeting.item as JsonObject;
      expect(item).toMatchObject({ summary: "Fake meeting", description: "Agenda: fake", url: "https://example.com/meet", start_tz: "America/New_York", unique_identifier: "SYNTH-UID-0001" });
      expect(item.external_rep).toEqual({ $bytes64: Buffer.from("bplist00").toString("base64") });
      for (const pointer of ["ROWID", "calendar_id", "location_id", "organizer_id"]) expect(item).not.toHaveProperty(pointer);
      expect(meeting.calendar).toEqual({ UUID: "SYNTH-CAL-0001", external_id: "/1/calendars/home/", title: "Home", color: "#1BADF8" });
      expect(meeting.store).toEqual({ name: "iCloud", type: 2, external_id: "SYNTH-STORE-ICLOUD", persistent_id: "SYNTH-PERSIST-0001", constraint_path: "CalDAVCalendarConstraints" });
      expect(meeting.location).toEqual({ title: "Fake Room 1", address: "1 Example Street", latitude: 1.5, longitude: 2.5 });
      expect((meeting.participants as JsonObject[]).map((each) => [each.email, (each.identity as JsonObject).address])).toEqual(
        expect.arrayContaining([["person-a@example.com", "mailto:person-a@example.com"], ["person-b@example.com", "mailto:person-b@example.com"]]),
      );
      expect((meeting.organizer as JsonObject).email).toBe("person-a@example.com");
      expect(meeting.alarms).toEqual([{ trigger_interval: -900, type: 0, UUID: "SYNTH-ALARM-0001", default_alarm: 0 }]);
      expect(meeting.conferences).toEqual([{ uuid: "SYNTH-CONF-0001", url: "https://example.com/call/1", feature: "video" }]);
      const series = heads.find((head) => head.key === KEYS.series)!.content as JsonObject;
      expect((series.recurrences as JsonObject[])[0]).toMatchObject({ frequency: 2, interval: 1, UUID: "SYNTH-RECUR-0001" });
      expect(series.exception_dates).toEqual([{ date: DAY0 + 15 * DAY + 30_600, sync_order: 0 }]);
      expect(heads.every((head) => head.gone === false)).toBe(true);
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the same delivery again writes a new version", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "Calendar.sqlitedb");
      createCalendarStore(path);
      await home.land(appleCalendar, shipped(home.blobs, path));
      const again = await home.land(appleCalendar, shipped(home.blobs, path, { ...SNAPSHOT, snapshot_taken_at: "2026-09-24T04:00:00.000Z" }));
      expect(again).toMatchObject({ new: 0, changed: 0, restated: 8, gone: 0 });
      artifact(home.dir, "again.json", again);
    } finally {
      home.close();
    }
  });

  it("an edit is missed, a sync-state change moves a head, or a deleted event lands a gone", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "Calendar.sqlitedb");
      createCalendarStore(path);
      await home.land(appleCalendar, shipped(home.blobs, path));
      write(path, "UPDATE CalendarItem SET summary = 'Fake meeting, renamed', last_modified = last_modified + 60 WHERE ROWID = 1");
      write(path, "UPDATE Calendar SET sync_token = 'sync-token-9'; UPDATE Store SET last_sync_start = 811600000.5");
      const through = write(path, "DELETE FROM CalendarItem WHERE ROWID = 4; DELETE FROM OccurrenceCache");
      const facts = { snapshot_taken_at: "2026-09-23T04:05:00.000Z", kind: "delta", after: SEQUENCE, through };
      const landed = await home.land(appleCalendar, shipped(home.blobs, path, facts));
      expect(landed).toMatchObject({ changed: 1, new: 0, restated: 6, gone: 0 });
      expect(landed.changedPaths).toEqual({ "item.last_modified": 1, "item.summary": 1 });
      const holiday = home.heads(SOURCE).find((head) => head.key === KEYS.holiday)!;
      expect(holiday.gone).toBe(false);
      artifact(home.dir, "delta.json", { landed, heads: home.heads(SOURCE).map((head) => [head.key, head.version]) });
    } finally {
      home.close();
    }
  });

  it("a changes delivery is read as less than it holds", async () => {
    const home = openTestHome();
    try {
      const changes = macBundle(home, SOURCE, new URL("./test/changes-bundle.zip", import.meta.url));
      expect(changes.facts.kind).toBe("changes");
      const file = join(home.dir, "changes.sqlite");
      writeFileSync(file, home.blobs.bytes(changes.files.find((each) => each.path === CALENDAR_FILE)!.blob));
      const db = new Database(file, { readonly: true });
      const items = Number((db.prepare("SELECT count(*) AS n FROM CalendarItem").get() as { n: number }).n);
      db.close();
      const rows = await collect(appleCalendar.read(changes, home.blobs));
      expect(rows.length).toBe(items);
      expect(await home.land(appleCalendar, changes, rows)).toMatchObject({ refused: 0 });
      artifact(home.dir, "changes.json", { items, rows: rows.length });
    } finally {
      home.close();
    }
  });

  it("a store lacking what this connector reads, or a file that is no database, is read", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "Calendar.sqlitedb");
      createCalendarStore(path);
      const db = new Database(path);
      db.exec("ALTER TABLE CalendarItem DROP COLUMN orig_date");
      db.close();
      await expect(collect(appleCalendar.read(shipped(home.blobs, path), home.blobs))).rejects.toThrow(/calendar\.sqlite CalendarItem lacks columns this connector reads: orig_date/u);
      const junk = deliver(home.blobs, SOURCE, { [CALENDAR_FILE]: Buffer.from("not a database") }, SNAPSHOT);
      await expect(collect(appleCalendar.read(junk, home.blobs))).rejects.toThrow(Refused);
      const empty = deliver(home.blobs, SOURCE, { "other.sqlite": Buffer.from("x") }, SNAPSHOT);
      await expect(collect(appleCalendar.read(empty, home.blobs))).rejects.toThrow(/carries no calendar\.sqlite/u);
    } finally {
      home.close();
    }
  });

  it("one meeting the Mac's store and Google's export both hold is named otherwise in each", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "Calendar.sqlitedb");
      createCalendarStore(path);
      const apple = (await collect(appleCalendar.read(shipped(home.blobs, path), home.blobs))).map((row) => row.key);
      const ics = [
        "BEGIN:VCALENDAR", "VERSION:2.0",
        "BEGIN:VEVENT", "UID:SYNTH-UID-0002@google.com", "DTSTART:20260921T083000Z", "DTEND:20260921T090000Z", "RRULE:FREQ=WEEKLY", "END:VEVENT",
        "BEGIN:VEVENT", "UID:SYNTH-UID-0002@google.com", "RECURRENCE-ID:20260928T083000Z", "DTSTART:20260928T100000Z", "DTEND:20260928T103000Z", "END:VEVENT",
        "BEGIN:VEVENT", "UID:SYNTH-UID-0004", "RECURRENCE-ID;VALUE=DATE:20261009", "DTSTART;VALUE=DATE:20261010", "DTEND;VALUE=DATE:20261011", "END:VEVENT",
        "END:VCALENDAR", "",
      ].join("\r\n");
      const google = deliver(home.blobs, "google-calendar:person-a@example.com:export", { "person-a@example.com.ics": Buffer.from(ics) }, { exported_at: "2026-09-23T04:00:00.000Z" });
      const keys = (await collect(gcalExport.read(google, home.blobs))).map((row) => row.key);
      expect(keys).toEqual([withoutCalendar(KEYS.series), withoutCalendar(KEYS.moved), withoutCalendar(KEYS.allDayMoved)]);
      expect(apple.map(withoutCalendar)).toEqual(expect.arrayContaining(keys));
      artifact(home.dir, "keys.json", { apple, google: keys });
    } finally {
      home.close();
    }
  });

  it("one invitation in two calendars lands under keys that move when the first copy is deleted or the rows are renumbered", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "Calendar.sqlitedb");
      createCalendarStore(path);
      await home.land(appleCalendar, shipped(home.blobs, path));
      const first = home.heads(SOURCE);
      const copy = first.find((head) => head.key === KEYS.meetingCopy)!;
      expect(withoutCalendar(copy.key)).toBe(withoutCalendar(KEYS.meeting));

      const rebuilt = reversed(path);
      const again = await home.land(appleCalendar, shipped(home.blobs, path, { snapshot_taken_at: "2026-09-23T04:05:00.000Z", kind: "delta", after: SEQUENCE, through: rebuilt }));
      expect(again).toMatchObject({ new: 0, changed: 0, restated: 8, gone: 0, duplicated: 0 });
      expect(home.heads(SOURCE).map((head) => [head.key, head.version])).toEqual(first.map((head) => [head.key, head.version]));

      const deleted = write(path, "DELETE FROM CalendarItem WHERE ROWID = 108");
      const after = await home.land(appleCalendar, shipped(home.blobs, path, { snapshot_taken_at: "2026-09-23T04:10:00.000Z", kind: "delta", after: rebuilt, through: deleted }));
      expect(after).toMatchObject({ new: 0, changed: 0, restated: 7, gone: 0, duplicated: 0 });
      expect(home.heads(SOURCE).find((head) => head.key === KEYS.meetingCopy)!.version).toBe(copy.version);
      artifact(home.dir, "copies.json", { first: first.map((head) => [head.key, head.version]), again, after });
    } finally {
      home.close();
    }
  });

  it("one UID twice in one calendar lands a version chosen by the order of the store's rows", async () => {
    const home = openTestHome();
    try {
      const twice = (rowid: number) => "INSERT INTO CalendarItem (ROWID, summary, start_date, start_tz, end_date, end_tz, all_day, calendar_id, orig_item_id, unique_identifier, UUID, entity_type) " +
        `SELECT ${rowid}, 'Fake holiday, again', start_date, start_tz, end_date, end_tz, all_day, calendar_id, 0, unique_identifier, 'SYNTH-LOCAL-0009', 2 FROM CalendarItem WHERE unique_identifier = 'SYNTH-UID-0003'`;
      const heads: [string, string][][] = [];
      for (const [name, rebuild, rowid] of [["after", false, 9], ["before", true, 1]] as const) {
        const path = join(home.dir, `${name}.sqlitedb`);
        createCalendarStore(path);
        if (rebuild) reversed(path);
        const through = write(path, twice(rowid));
        const each = openTestHome();
        try {
          const landed = await each.land(appleCalendar, shipped(each.blobs, path, { ...SNAPSHOT, through }));
          expect(landed).toMatchObject({ new: 8, duplicated: 1, refused: 0 });
          heads.push(each.heads(SOURCE).map((head) => [head.key, head.version]));
        } finally {
          each.close();
        }
      }
      expect(heads[1]).toEqual(heads[0]);
      artifact(home.dir, "twice.json", heads[0]);
    } finally {
      home.close();
    }
  });

  it("an item the store cannot return is dropped, refused twice, or holds back the copy that shares its key", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "damaged.sqlitedb");
      createCalendarStore(path);
      const through = write(path,
        "INSERT INTO CalendarItem (ROWID, summary, start_date, start_tz, end_date, end_tz, all_day, calendar_id, orig_item_id, unique_identifier, UUID, entity_type, app_link) " +
        "SELECT 20, summary, start_date, start_tz, end_date, end_tz, all_day, calendar_id, 0, unique_identifier, 'SYNTH-LOCAL-0020', 2, randomblob(20000) FROM CalendarItem WHERE unique_identifier = 'SYNTH-UID-0003'; " +
        "INSERT INTO CalendarItem (ROWID, summary, start_date, start_tz, end_date, end_tz, all_day, calendar_id, orig_item_id, unique_identifier, UUID, entity_type) " +
        "SELECT 21, hex(randomblob(10000)), start_date, start_tz, end_date, end_tz, all_day, calendar_id, 0, 'SYNTH-UID-0099', 'SYNTH-LOCAL-0021', 2 FROM CalendarItem WHERE unique_identifier = 'SYNTH-UID-0003' LIMIT 1");
      damageOverflow(path, "CalendarItem");
      const landed = await home.land(appleCalendar, shipped(home.blobs, path, { ...SNAPSHOT, through }));
      expect(landed).toMatchObject({ new: 8, refused: 2 });
      expect(landed.refusals.map((refusal) => `${refusal.key}: ${refusal.violations.join("; ")}`).sort()).toEqual([
        expect.stringMatching(/^CalendarItem ROWID 20: SQLite cannot return it: SQLITE_CORRUPT/u),
        expect.stringMatching(/^CalendarItem ROWID 21: SQLite cannot return it: SQLITE_CORRUPT/u),
      ]);
      expect(home.heads(SOURCE).map((head) => head.key)).toContain(KEYS.holiday);
      artifact(home.dir, "damaged.json", { landed, keys: home.heads(SOURCE).map((head) => head.key) });
    } finally {
      home.close();
    }
  });

  it("a calendar named with a ':', or by no external_id, or a reminder, makes a key whose calendar is not its last part", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "Calendar.sqlitedb");
      createCalendarStore(path);
      const through = write(path, `
        UPDATE Calendar SET external_id = 'https://example.com/fake:100%.ics' WHERE ROWID = 3;
        UPDATE Calendar SET external_id = NULL WHERE ROWID = 1;
        INSERT INTO CalendarItem (ROWID, summary, calendar_id, orig_item_id, unique_identifier, UUID, entity_type, all_day)
          VALUES (9, 'Fake task', 1, 0, 'SYNTH-TASK-0001', 'SYNTH-LOCAL-0009', 3, 0)`);
      const rows = await collect(appleCalendar.read(shipped(home.blobs, path, { ...SNAPSHOT, through }), home.blobs));
      const keys = Object.fromEntries(rows.map((row) => [row.locator, [row.kind, row.key]]));
      expect(keys["CalendarItem row 1"]).toEqual(["event", "SYNTH-UID-0001:SYNTH-CAL-0001"]);
      expect(keys["CalendarItem row 4"]).toEqual(["event", "SYNTH-UID-0003:https%3A//example.com/fake%3A100%25.ics"]);
      expect(keys["CalendarItem row 6"]).toEqual(["event", "SYNTH-UID-0004:20261009:https%3A//example.com/fake%3A100%25.ics"]);
      expect(keys["CalendarItem row 9"]).toEqual(["reminder", "SYNTH-TASK-0001:SYNTH-CAL-0001"]);
      expect(withoutCalendar(keys["CalendarItem row 6"]![1])).toBe(withoutCalendar(KEYS.allDayMoved));
      artifact(home.dir, "names.json", keys);
    } finally {
      home.close();
    }
  });
});
