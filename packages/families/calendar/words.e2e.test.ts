import { afterEach, describe, expect, it } from "vitest";
import type { CalendarAdapter, DaySettings, Instant, ReaderOutput, Reminder } from "@lifestreamprotocol/core";
import type { Given } from "../family.js";
import { readLabels } from "../shared/labels.js";
import type { DayDocument } from "../days.js";
import { TestHome } from "../test/drive.js";
import { FED, NETWORKED } from "../test/fed.js";
import { calendarFamily } from "./family.js";

const ACCOUNT = "person-a@example.com";
const T0 = Date.UTC(2026, 9, 7, 12);
const at = (iso: string) => Date.parse(iso);

interface Task { title: string; done: string; modified: string; list?: string }

function store(product: string, vendor: string, authority: "own" | "mirror", units: "account" | "product", options: { folder?: boolean; word?: string } = {}): Given<CalendarAdapter> {
  const read = (content: unknown): Task => content as Task;
  return {
    product, name: `Example ${product}`, vendor, type: "plans", ...(options.folder === true ? { digest: `sha256:${product}` } : {}),
    adapter: {
      version: "1", kinds: ["reminder"], authority, keys: authority === "own" ? "name" : "held", units, ...(options.word === undefined ? {} : { reminderWord: options.word }),
      reminder({ version }) {
        const task = read(version.content);
        const value: Reminder = { title: task.title, due: null, completed: true, completed_ms: at(task.done), list: task.list ?? null, flagged: false };
        return { value, modified: at(task.modified) };
      },
      words({ version }) {
        return { title: read(version.content).title, text: "", who: [] };
      },
    },
  };
}

const task = (key: string, title: string, list?: string, modified = "2026-10-07T15:00:00Z"): ReaderOutput =>
  ({ kind: "reminder", key, content: { type: "example.task", title, done: "2026-10-07T15:00:00Z", modified, ...(list === undefined ? {} : { list }) } });

const STORES = [
  store("example-reminders", "example", "own", "product"),
  store("aaa-reminders", "example", "own", "product", { folder: true }),
  store("example-device", "example", "mirror", "product"),
  store("acme-tasks", "acme", "own", "account", { folder: true, word: "Task" }),
  store("acme-phone", "acme", "mirror", "product", { folder: true }),
  store("lone-device", "lone", "mirror", "product"),
];
const calendar = calendarFamily({ books: FED.labels })([...FED.calendar, ...STORES]);

function googleEvent(key: string, title: string, start: string, zone: string | null, time: Instant): ReaderOutput {
  const dtstart = zone === null ? `DTSTART:${start}Z` : `DTSTART;TZID=${zone}:${start}`;
  const vevent = ["BEGIN:VEVENT", "DTSTAMP:20261006T120000Z", `UID:${key}`, dtstart, `SUMMARY:${title}`, "LAST-MODIFIED:20261005T100000Z", "SEQUENCE:0", "END:VEVENT", ""].join("\r\n");
  return { kind: "event", key, content: { type: "calendar.event", content: vevent }, time };
}
const GOOGLE = `google-calendar:${ACCOUNT}:cloud`;
const hour = (iso: string): Instant => ({ start_ms: at(iso), end_ms: at(iso) + 3_600_000, precision: "s" });

const homes: TestHome[] = [];
function home(prefix: string): TestHome {
  const opened = new TestHome(`families-calendar-words-${prefix}-`);
  homes.push(opened);
  return opened;
}
afterEach(() => {
  for (const opened of homes.splice(0)) opened.close();
});

function atoms(h: TestHome, day: string, settings: DaySettings): { text: string; unit: string | undefined; source: string | undefined }[] {
  const rendered = h.renderDays([day], (view) => readLabels(view, null, NETWORKED), [calendar], settings).get(day)!;
  return (JSON.parse(rendered.json) as DayDocument).atoms.map((atom) => ({ text: atom.text, unit: atom.unit, source: atom.record?.source }));
}

describe("calendar family: the words a line prints", () => {
  it("an event in the day's zone spelled another way prints a zone, a name no runtime knows prints, or another zone prints none", () => {
    const h = home("zones");
    const settings: DaySettings = { zone: "Asia/Calcutta", day_start_hour: 4 };
    h.land(GOOGLE, T0, [
      googleEvent("kolkata-1@example.com", "Synthetic standup", "20261007T100000", "Asia/Kolkata", hour("2026-10-07T04:30:00Z")),
      googleEvent("windows-1@example.com", "Synthetic sync", "20261007T110000", "India Standard Time", hour("2026-10-07T05:30:00Z")),
      googleEvent("pacific-1@example.com", "Synthetic review", "20261006T230000", "America/Los_Angeles", hour("2026-10-07T06:00:00Z")),
      googleEvent("utc-1@example.com", "Synthetic call", "20261007T070000", "Etc/UTC", hour("2026-10-07T07:00:00Z")),
    ]);
    h.extractPass(calendar, settings);
    const printed = atoms(h, "2026-10-07", settings).map((atom) => atom.text);
    expect(printed).toEqual([
      "Event “Synthetic standup”",
      "Event “Synthetic sync”",
      "Event “Synthetic review”, in America/Los_Angeles time",
      "Event “Synthetic call”",
    ]);
    h.artifact("words.json", printed);
  });

  it("an own store's reminders take another's units, a mirror prints apart from its vendor's own store or joins a home folder's, or a reminder prints another store's word", () => {
    const h = home("units");
    const settings: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
    h.land(GOOGLE, T0, [googleEvent("meeting-1@example.com", "Synthetic planning", "20261007T140000", null, hour("2026-10-07T14:00:00Z"))]);
    h.land(`example-reminders:${ACCOUNT}:cloud`, T0, [task("rem-1", "Fake call back")]);
    h.land(`aaa-reminders:${ACCOUNT}:cloud`, T0, [task("rem-2", "Fake folder errand"), task("rem-1", "Fake call back, folder")]);
    h.land(`example-device:${ACCOUNT}:phone-aa01`, T0, [task("rem-1:list-a", "Fake call back", "Device list", "2026-10-07T14:00:00Z")]);
    h.land(`acme-tasks:${ACCOUNT}:cloud`, T0, [task("task-1", "Mail the invoice")]);
    h.land(`acme-phone:${ACCOUNT}:phone-aa01`, T0, [task("task-1:phone", "Mail the invoice", "Phone list", "2026-10-07T16:00:00Z")]);
    h.land(`lone-device:${ACCOUNT}:phone-aa01`, T0, [task("rem-9:list-z", "Fake lone one", "Lone list")]);
    h.extractPass(calendar, settings);

    const units = h.read((view) => [...view.extracts("calendar")].map((row) => row.unit).sort());
    expect(units).toEqual([
      `aaa-reminders:${ACCOUNT}/rem-1`,
      `aaa-reminders:${ACCOUNT}/rem-2`,
      `example-reminders:${ACCOUNT}/rem-1`,
      `lone-device:${ACCOUNT}/rem-9`,
      `${ACCOUNT}/meeting-1@example.com`,
      `${ACCOUNT}/task-1`,
    ]);
    const printed = atoms(h, "2026-10-07", settings);
    expect(printed.map(({ text, unit, source }) => [text, unit, source]).sort()).toEqual([
      ["Event “Synthetic planning”", `${ACCOUNT}/meeting-1@example.com`, GOOGLE],
      ["Reminder “Fake call back, folder” completed", `aaa-reminders:${ACCOUNT}/rem-1`, `aaa-reminders:${ACCOUNT}:cloud`],
      ["Reminder “Fake call back” completed", `example-reminders:${ACCOUNT}/rem-1`, `example-reminders:${ACCOUNT}:cloud`],
      ["Reminder “Fake folder errand” completed", `aaa-reminders:${ACCOUNT}/rem-2`, `aaa-reminders:${ACCOUNT}:cloud`],
      ["Reminder “Fake lone one” completed, in Lone list", `lone-device:${ACCOUNT}/rem-9`, `lone-device:${ACCOUNT}:phone-aa01`],
      ["Task “Mail the invoice” completed, in Phone list", `${ACCOUNT}/task-1`, `acme-phone:${ACCOUNT}:phone-aa01`],
    ]);
    h.artifact("words.json", { units, printed });
  });

  it("the units differ when the stores are handed in another order", () => {
    const forward = home("forward");
    const backward = home("backward");
    const reversed = calendarFamily({ books: FED.labels })([...STORES].reverse());
    for (const [h, family] of [[forward, calendarFamily({ books: FED.labels })(STORES)], [backward, reversed]] as const) {
      h.land(`aaa-reminders:${ACCOUNT}:cloud`, T0, [task("rem-1", "Fake call back, folder")]);
      h.land(`example-reminders:${ACCOUNT}:cloud`, T0, [task("rem-1", "Fake call back")]);
      h.land(`example-device:${ACCOUNT}:phone-aa01`, T0, [task("rem-1:list-a", "Fake call back", "Device list")]);
      h.extractPass(family);
    }
    const units = (h: TestHome) => h.read((view) => [...view.extracts("calendar")].map((row) => [row.unit, (row.content as { source: string }).source]).sort());
    expect(units(backward)).toEqual(units(forward));
    expect(units(forward)).toEqual([
      [`aaa-reminders:${ACCOUNT}/rem-1`, `aaa-reminders:${ACCOUNT}:cloud`],
      [`example-reminders:${ACCOUNT}/rem-1`, `example-reminders:${ACCOUNT}:cloud`],
    ]);
  });
});
