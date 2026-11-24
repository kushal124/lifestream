import { afterEach, describe, expect, it } from "vitest";
import type { DaySettings, JsonObject, ReaderOutput, Version } from "@lifestreamprotocol/core";
import type { Change, Family } from "./family.js";
import { messagesFamily } from "./messages/family.js";
import { physicalFamily } from "./physical/family.js";
import { screenFamily } from "./screen/family.js";
import { FED } from "./test/fed.js";
import { TestHome } from "./test/drive.js";
import { webFamily } from "./web/family.js";

const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 4 };
const MACHINE = "macbook-pro-0001";
const S = 1_000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const BASE = Date.parse("2026-10-06T00:00:00Z");
const at = (hours: number) => BASE + Math.round(hours * HOUR);


function frame(key: string, t: number, title: string): ReaderOutput {
  return {
    kind: "frame", key, time: { start_ms: t, precision: "ms" },
    content: {
      type: "screen.lifestream.frame", status: "captured", ocrStatus: "ok", displayID: 1,
      application: { bundleID: "com.example.editor", name: "Editor", pid: 42 }, frontWindow: { windowID: 7 },
      windows: [{ windowID: 7, title }], ocr: [{ text: `${title}: synthetic line` }],
    },
  };
}

function chromeTime(ms: number): string {
  return String(BigInt(ms) * 1000n + 11_644_473_600_000_000n);
}

function chromeVisit(id: number, t: number, url: string, title: string): ReaderOutput {
  return {
    kind: "page-visit", key: `visit-${id}`, time: { start_ms: t, precision: "ms" },
    content: {
      type: "chrome.visit",
      visit: {
        id, url: id, visit_time: chromeTime(t), from_visit: 0, external_referrer_url: "", transition: 0x30000000,
        segment_id: 0, visit_duration: 0, incremented_omnibox_typed_score: 0, opener_visit: 0, originator_cache_guid: "",
        originator_visit_id: 0, originator_from_visit: 0, originator_opener_visit: 0, is_known_to_sync: 0,
        consider_for_ntp_most_visited: 1, visited_link_id: 0, app_id: null,
      },
      url: { id, url, title, hidden: 0 },
      visit_source: null, context_annotations: null, content_annotations: null,
    },
  };
}

const APPLE_EPOCH_S = 978_307_200;
const CHAT = "15550000002@s.whatsapp.net";

function whatsapp(stanza: string, t: number, text: string): ReaderOutput {
  const date = t / 1000 - APPLE_EPOCH_S;
  return {
    kind: "msg", key: `${CHAT}:${stanza}`, time: { start_ms: t, precision: "ms" },
    content: {
      type: "whatsapp.msg",
      message: {
        ZSTANZAID: stanza, ZTEXT: text, ZFROMJID: CHAT, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date, ZMESSAGETYPE: 0,
        ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: 0, ZSTARRED: 0, ZMEDIASECTIONID: null, ZPHASH: null,
        ZENCRETRYCOUNT: 0, ZFILTEREDRECIPIENTCOUNT: 0, ZCHILDMESSAGESDELIVEREDCOUNT: 0, ZCHILDMESSAGESPLAYEDCOUNT: 0,
        ZCHILDMESSAGESREADCOUNT: 0, ZDATAITEMVERSION: 1,
      },
      session_jid: CHAT, parent_stanza_id: null, media_item: null, group_member_jid: null, blobs: [],
    },
  };
}

const INSTALL = "11111111-1111-4111-8111-111111111111";
const PROCESS = "22222222-2222-4222-8222-222222222222";
const HOME = { latitude: 0, longitude: 0 };
const OFFICE = { latitude: 0, longitude: 0.0135 };

function fix(sequence: number, t: number, point: { latitude: number; longitude: number }): ReaderOutput {
  const iso = (ms: number) => new Date(ms).toISOString();
  const payload: JsonObject = {
    location: { timestamp_rfc3339_utc: iso(t), timestamp_unix_seconds: t / 1_000, latitude: point.latitude, longitude: point.longitude,
      horizontal_accuracy: 5, vertical_accuracy: 3, altitude: 12, speed: 0, course: 90 },
    capture_context: { engine: "app_owned", authorization: "always" },
  };
  return {
    kind: "fix", key: `${INSTALL}:${sequence}`, time: { start_ms: t + 1_500, precision: "ms" },
    content: { type: "location.fix", content: { schema_version: 1, domain: "location", kind: "fix", sequence,
      captured: { wall_rfc3339: iso(t + 1_500), wall_unix_seconds: (t + 1_500) / 1_000, elapsed_seconds: sequence * 7.5 },
      process_instance_id: PROCESS, payload } },
  };
}

function stay(first: number, point: typeof HOME, from: number, to: number): ReaderOutput[] {
  const rows: ReaderOutput[] = [];
  for (let t = at(from), sequence = first; t < at(to); t += MIN) rows.push(fix(sequence++, t, point));
  return rows;
}


interface Case {
  family: Family;
  source: string;
  rows: ReaderOutput[];
  a: ReaderOutput;
  b: ReaderOutput;
}

const CASES: Record<string, () => Case> = {
  screen: () => {
    const rows: ReaderOutput[] = [];
    for (const from of [13, 19]) for (let t = at(from); t < at(from + 0.5); t += 10 * S) rows.push(frame(`f${t}`, t, "notes.txt"));
    return { family: screenFamily({ zone: "UTC" })(FED.screen), source: `screen:local:${MACHINE}`, rows, a: frame("moved", at(13.6), "draft.txt"), b: frame("moved", at(18.9), "draft-2.txt") };
  },
  physical: () => ({
    family: physicalFamily({ photos: FED.photos })(FED.physical), source: "location:local:iphone-0001",
    rows: [...stay(1, HOME, 7, 9), ...stay(1_000, OFFICE, 10, 12)],
    a: fix(5_000, at(8.5) + 30 * S, HOME), b: fix(5_000, at(14), OFFICE),
  }),
  web: () => ({
    family: webFamily({ screen: FED.screen })(FED.web), source: `chrome:profile-2:${MACHINE}`,
    rows: [chromeVisit(1, at(10.6), "https://docs.example/start", "Start")],
    a: chromeVisit(2, at(10.3), "https://news.example/a", "Headlines"), b: chromeVisit(2, at(15.3), "https://news.example/a", "Headlines"),
  }),
  messages: () => ({
    family: messagesFamily({ books: FED.labels })(FED.messages), source: `whatsapp:15550000000:${MACHINE}`,
    rows: [whatsapp("S0", at(10), "a synthetic hello")],
    a: whatsapp("S1", at(11), "a synthetic reply"), b: whatsapp("S1", at(24 + 11), "a synthetic reply"),
  }),
};

const rowsOf = (home: TestHome, family: Family) => home.extracts(family.name).map(({ unit, reading, start_ms, end_ms, days }) => ({ unit, reading, start_ms, end_ms, days }));

function catchUp(home: TestHome, family: Family, record: Change["record"], cursor: number): string[] {
  const built = home.read((view) => {
    const version = (id: string | undefined): Version | undefined => id === undefined || id === "gone" ? undefined : view.version(id);
    const ids: (string | undefined)[] = [];
    for (const statement of view.history(record)) {
      if (statement.late) continue;
      if (statement.seq <= cursor) ids[0] = statement.version;
      else if (statement.version !== ids.at(-1)) ids.push(statement.version);
    }
    const changes = ids.slice(1).map((id, index): Change => {
      const before = version(ids[index]);
      const after = version(id);
      return { record, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) };
    });
    expect(changes).toHaveLength(2);
    const units = new Set<string>();
    for (const touched of family.touched(changes, view)) {
      units.add(touched.unit);
      if (touched.previous !== undefined) units.add(touched.previous);
    }
    return [...units].sort().map((unit) => ({ unit, extracted: family.extract(unit, view, home.blobs), seq: view.through }));
  });
  home.db.commit((tx) => {
    for (const { unit, extracted, seq } of built) {
      if (extracted === null) {
        tx.derived.extracts.delete(family.name, unit);
        continue;
      }
      const row = { family: family.name, unit, code: family.code, seq, days: [] as string[], ...extracted };
      row.days = family.days(row, SETTINGS);
      tx.derived.extracts.put(row);
    }
  });
  return built.map((each) => each.unit);
}

describe("a record changed and changed back since the cursor", () => {
  let home: TestHome | undefined;
  afterEach(() => {
    home?.close();
    home = undefined;
  });

  for (const [name, make] of Object.entries(CASES)) {
    it(`${name}: two changes of one record in one call name the units of every version`, () => {
      const { family, source, rows, a, b } = make();
      home = new TestHome(`lifestream-touched-${name}-`, { families: [family], settings: SETTINGS });
      home.land(source, at(30), [...rows, a]);
      const cursor = home.read((view) => view.through);
      home.extractPass(family);
      const withA = rowsOf(home, family);
      home.land(source, at(31), [b]);
      home.extractPass(family);
      expect(rowsOf(home, family)).not.toEqual(withA);
      home.land(source, at(32), [a]);
      const named = catchUp(home, family, { source, kind: a.kind, key: a.key }, cursor);
      expect(named.length).toBeGreaterThan(0);
      expect(rowsOf(home, family)).toEqual(withA);
    });
  }
});
