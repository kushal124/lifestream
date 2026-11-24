import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaySettings, Json, ReaderOutput } from "@lifestreamprotocol/core";
import { checkDayFile } from "../days.js";
import type { Family } from "../family.js";
import { buildLabels } from "../shared/labels.js";
import { screenFamily } from "../screen/family.js";
import { FED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { shuffled, TestHome } from "../test/drive.js";
import { phoneFamily, type PhoneDay } from "./family.js";

const GOLDEN = new URL("./test/phone.golden.json", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const LABELS = buildLabels({ people: [], contacts: [], places: [] });
const DAY = "2026-10-06";
const LOG = "screen-time:person-a@example.com:macbook-pro-0001";
const LOG_MINI = "screen-time:person-a@example.com:mac-mini-aa43";
const RECORDER = "screen:local:macbook-pro-0001";
const MAC = "0000AAAA-0000-4000-8000-000000000001";
const MINI = "0000CCCC-0000-4000-8000-000000000003";
const PHONE = "0000BBBB-0000-4000-8000-000000000002";
const TABLET = "0000DDDD-0000-4000-8000-000000000004";
const DEVICES = { [PHONE]: "iPhone" };
const NAMED = phoneFamily({ devices: DEVICES })(FED.phone);
const S = 1_000;
const MIN = 60 * S;
const local = (clock: string, day = DAY) => Date.parse(`${day}T${clock}-04:00`);


function basic(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/gu, "").replace(".000", "");
}

let entry = 0;
function focus(device: string, t: number, app: string, coming: boolean, own = false): ReaderOutput {
  const seconds = t / 1000 - 978_307_200;
  return {
    kind: "app-focus", key: `${device}:${basic(t)}:${app}:${coming ? "in" : "out"}`, time: { start_ms: t, precision: "ms" },
    content: {
      type: "biome.app-in-focus", format: 10, written: seconds,
      fields: { "2": 1, "3": coming ? 1 : 0, "4": seconds, "6": app, "9": "1.0.0", "10": "100", "11": 1, "12": 1, "13": 0 },
    },
    locator: `${own ? "local" : `remote/${device}`}/810000000000000.segb:entry ${++entry}`,
  };
}

function used(device: string, app: string, from: number | null, to: number | null, own = false): ReaderOutput[] {
  return [...(from === null ? [] : [focus(device, from, app, true, own)]), ...(to === null ? [] : [focus(device, to, app, false, own)])];
}

function phoneDay(): ReaderOutput[] {
  return [
    ...used(PHONE, "com.example.social", local("07:12:00"), local("07:21:00")),
    ...used(PHONE, "com.example.chat", local("07:21:00"), local("07:27:00")),
    ...used(PHONE, "com.apple.mobilesafari", local("07:27:00"), local("07:30:00")),
    ...used(PHONE, "com.example.notes", local("07:33:00"), local("07:33:20")),
    ...used(PHONE, "com.example.maps", local("07:40:00"), null),
    ...used(PHONE, "com.example.camera", null, local("12:00:00")),
    ...used(PHONE, "com.example.video", local("19:58:00"), local("20:10:00")),
    ...used(PHONE, "com.example.reader", local("21:00:00"), local("03:30:00", "2026-10-07")),
  ];
}

function macAndTablet(): ReaderOutput[] {
  return [
    ...used(MAC, "com.example.browser", local("09:00:00"), local("09:30:00"), true),
    ...used(TABLET, "com.example.books", local("13:00:00"), local("13:05:00")),
  ];
}

function miniDay(): ReaderOutput[] {
  return [
    ...phoneDay().slice(0, 8),
    ...used(MAC, "com.example.browser", local("09:00:00"), local("09:30:00")),
    ...used(MINI, "com.example.terminal", local("16:00:00"), local("16:20:00"), true),
  ];
}

function sitting(): ReaderOutput[] {
  const rows: ReaderOutput[] = [];
  for (let t = local("09:00:00"); t < local("09:30:00"); t += 10 * S) {
    rows.push({
      kind: "frame", key: basic(t), time: { start_ms: t, precision: "ms" },
      content: {
        type: "screen.lifestream.frame", status: "captured", application: { bundleID: "com.example.browser", name: "Browser", pid: 42 },
        frontWindow: { windowID: 7 }, windows: [{ windowID: 7, title: "Example page" }], ocr: [{ text: "Example page: synthetic line" }],
      },
    });
  }
  return rows;
}


const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function open(prefix: string, phone: Family = NAMED): TestHome {
  const home = new TestHome(`families-phone-${prefix}-`, { families: [screenFamily({ zone: SETTINGS.zone })(FED.screen), phone], settings: SETTINGS });
  homes.push(home);
  return home;
}

const STATED = Date.parse("2026-10-08T00:00:00Z");

function landDay(home: TestHome): void {
  home.deliver(RECORDER, local("10:00:00"), sitting());
  home.deliver(LOG, STATED, [...phoneDay(), ...macAndTablet()]);
  home.deliver(LOG_MINI, STATED, miniDay());
}

function phoneLines(home: TestHome, day = DAY): string[] {
  const txt = home.render(day, LABELS).txt.split("\n");
  return txt.filter((line) => /^(\d{4}-\d\d-\d\d )?\d\d:\d\d(–\S+)? (iPhone|Device)/u.test(line));
}

function contents(home: TestHome): PhoneDay[] {
  return home.extracts("phone").map((row) => row.content as unknown as PhoneDay);
}


describe("phone: what must be impossible", () => {
  it("the Mac's own focus prints as another device's stretch", () => {
    const home = open("own");
    landDay(home);
    expect([...new Set(contents(home).map((content) => content.device))].sort()).toEqual([PHONE, TABLET]);
    const txt = home.render(DAY, LABELS).txt;
    expect(txt).not.toContain("com.example.browser");
    expect(txt).not.toContain("com.example.terminal");
    home.artifact("own", { units: home.extracts("phone").map((row) => row.unit) });
  });

  it("a Mac's focus another Mac shipped first stays a device's stretch once its own log says it is a Mac", () => {
    const home = open("own-later");
    home.deliver(LOG_MINI, STATED, miniDay());
    expect(contents(home).map((content) => content.device)).toContain(MAC);
    home.deliver(LOG, STATED + MIN, [...phoneDay(), ...macAndTablet()]);
    expect([...new Set(contents(home).map((content) => content.device))].sort()).toEqual([PHONE, TABLET]);
    expect(home.render(DAY, LABELS).txt).not.toContain("com.example.browser");
  });

  it("an end never stated is given a length, a start never stated is lost, or the gap splits a stretch wrongly", () => {
    const home = open("stretches");
    landDay(home);
    expect(phoneLines(home)).toEqual([
      "07:12–07:33 iPhone: com.example.social 9 min, com.example.chat 6 min, com.apple.mobilesafari 3 min, com.example.notes <1 min",
      "07:40 iPhone: com.example.maps (no end stated)",
      "12:00 iPhone: com.example.camera (no start stated)",
      "13:00–13:05 Device 0000DDDD: com.example.books 5 min",
      "19:58–20:10 iPhone: com.example.video 12 min",
      "21:00 iPhone: com.example.reader (no end stated)",
      "2026-10-07 03:30 iPhone: com.example.reader (no start stated)",
    ]);
    const day = home.render(DAY, LABELS);
    expect(checkDayFile(JSON.parse(day.json))).toEqual([]);
    home.artifact("stretches", { txt: day.txt });
  });

  it("a record two Macs' logs hold prints twice", () => {
    const home = open("twice");
    landDay(home);
    const morning = contents(home).flatMap((content) => content.focus).filter((each) => each.start_ms < local("07:35:00"));
    expect(morning.map((each) => each.app)).toEqual(["com.example.social", "com.example.chat", "com.apple.mobilesafari", "com.example.notes"]);
    expect(new Set(morning.map((each) => each.record.source))).toEqual(new Set([LOG_MINI]));
  });

  it("a focus across UTC midnight is split or lost", () => {
    const home = open("midnight");
    landDay(home);
    const video = contents(home).flatMap((content) => content.focus.map((each) => ({ ...each, day: content.day }))).filter((each) => each.app === "com.example.video");
    expect(video.map((each) => [each.day, each.stated, each.end_ms - each.start_ms])).toEqual([["2026-10-06", "both", 12 * MIN]]);
  });

  it("a leaving that lands later leaves its focus open", () => {
    const home = open("later");
    landDay(home);
    const delivered = home.deliver(LOG, STATED + MIN, [focus(PHONE, local("07:44:00"), "com.example.maps", false)]);
    expect(delivered.written).toEqual([`phone ${PHONE}/2026-10-06`]);
    expect(phoneLines(home)[1]).toBe("07:40–07:44 iPhone: com.example.maps 4 min");
  });

  it("the order deliveries land in changes an extract", () => {
    const first = open("first");
    landDay(first);
    const second = open("second");
    const rows = shuffled([...miniDay().map((row) => [LOG_MINI, row] as const), ...[...phoneDay(), ...macAndTablet()].map((row) => [LOG, row] as const)], 7);
    rows.forEach(([source, row], index) => second.deliver(source, STATED + index, [row]));
    second.deliver(RECORDER, local("10:00:00"), sitting());
    const units = (home: TestHome) => home.extracts("phone").map((row) => ({ unit: row.unit, reading: row.reading, days: row.days }));
    expect(units(second)).toEqual(units(first));
    second.artifact("order", { units: units(second) });
  });

  it("a named device prints by its sync id", () => {
    const home = open("unnamed", phoneFamily({})(FED.phone));
    landDay(home);
    expect(phoneLines(home)[0]).toMatch(/^07:12–07:33 Device 0000BBBB: /u);
    expect(phoneFamily({})(FED.phone).code).not.toBe(NAMED.code);
  });

  it("the golden day: the phone's stretches beside the Mac's sitting", () => {
    const home = open("golden");
    landDay(home);
    const day = home.render(DAY, LABELS);
    expect(checkDayFile(JSON.parse(day.json))).toEqual([]);
    checkGolden("extracts", home.extracts("phone").map((row) => ({ unit: row.unit, days: row.days, content: row.content })));
    checkGolden("day", day.txt);
    pin(NAMED, { phone: FED.phone }, home.extracts("phone"));
  });
});

function checkGolden(member: string, value: unknown): void {
  const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Json> : {};
  if (UPDATE) {
    golden[member] = value as Json;
    mkdirSync(dirname(GOLDEN.pathname), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`);
    return;
  }
  expect(golden[member], `${GOLDEN.pathname} has no ${member}; run with LIFESTREAM_UPDATE_GOLDEN=1`).toBeDefined();
  expect(value).toEqual(golden[member]);
}
