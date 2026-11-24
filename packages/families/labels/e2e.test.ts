import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { civilDay, digest, type DaySettings, type ExtractRow, type Json, type OpenView, type ReaderOutput } from "@lifestreamprotocol/core";
import { renderDay } from "../days.js";
import { linesOnly, type Family, type Labels } from "../family.js";
import { labelsFrom, placesUnit, readLabels } from "../shared/labels.js";
import { dayReader, shuffled, TestHome } from "../test/drive.js";
import { labelsFamily } from "./family.js";
import { FED, NETWORKED } from "../test/fed.js";
import { pin } from "../test/pin.js";

const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";
const ARTIFACT_DIR = mkdtempSync(join(tmpdir(), "lifestream-labels-"));
const ARTIFACT: Record<string, Json> = {};
const HOME = "unit-a";
const FAMILY = labelsFamily({ home: HOME, messages: NETWORKED.messages, mail: FED.mail })(FED.labels);
const PEOPLE = `people:local:${HOME}`;
const CONTACTS = "apple-contacts:person-a@example.com:iphone-aa01";
const WHATSAPP = "whatsapp:15550000000:iphone-aa01";
const PLACES = `places:local:${HOME}`;
const CAMERAS = `cameras:local:${HOME}`;
const DEVICES = `devices:local:${HOME}`;
const DAY: DaySettings = { zone: "Asia/Kolkata", day_start_hour: 4 };

afterAll(() => {
  writeFileSync(join(ARTIFACT_DIR, "labels.json"), `${JSON.stringify(ARTIFACT, null, 2)}\n`);
  if (!KEEP) rmSync(ARTIFACT_DIR, { recursive: true, force: true });
});

const card = (key: string, name: string, phone: string, email?: string): ReaderOutput => ({
  kind: "contact", key, content: { card: `BEGIN:VCARD\r\nFN:${name}\r\nTEL:${phone}\r\n${email === undefined ? "" : `EMAIL:${email}\r\n`}END:VCARD\r\n` },
});
const person = (slug: string, name: string, handles: [string, string][], merged_into: string | null = null): ReaderOutput => ({
  kind: "person", key: slug, content: {
    type: "people.person", slug, name, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: handles[0] === undefined ? null : { kind: handles[0][0], value: handles[0][1] }, handles: handles.slice(1).map(([kind, value]) => ({ kind, value })),
    excluded: [], dismissed: [], merged_into,
  },
});
const pushName = (jid: string, name: string): ReaderOutput => ({ kind: "pushname", key: jid, content: { type: "whatsapp.pushname", ZJID: jid, ZPUSHNAME: name } });
const chat = (key: string, partner: string, contact?: string): ReaderOutput => ({
  kind: "chat", key, content: { type: "whatsapp.chat", chat: { ZPARTNERNAME: partner, ...(contact === undefined ? {} : { ZCONTACTJID: contact }) } },
});
const place = (id: string, name: string, latitude: number): ReaderOutput => ({ kind: "place", key: id, content: { type: "places.place", name, centre: { latitude, longitude: 20 }, radius_m: 100, ids: [] } });

function deliveries(): { source: string; stated_ms: number; rows: ReaderOutput[] }[] {
  return [
    { source: PEOPLE, stated_ms: 1_000, rows: [person("person-a", "Person A", [["phone", "+15550000001"]]), person("person-b", "Person B", [["email", "person-b@example.com"]], "person-a")] },
    { source: CONTACTS, stated_ms: 2_000, rows: [card("c1", "Card A", "+15550000001"), card("c2", "Card C", "+15550000003", "person-c@example.com")] },
    { source: WHATSAPP, stated_ms: 3_000, rows: [pushName("15550000004@s.whatsapp.net", "Pusher D"), chat("123456789012345@lid", "Partner D", "15550000004@s.whatsapp.net"), chat("120363000000000001@g.us", "Group Alpha")] },
    { source: PLACES, stated_ms: 4_000, rows: [place("desk", "Synthetic Desk", 10), place("park", "Synthetic Park", 10.5)] },
  ];
}

function answers(labels: Labels): Json {
  const ids = ["+15550000001", "person-b@example.com", "+15550000003", "person-c@example.com", "15550000001@s.whatsapp.net",
    "15550000004@s.whatsapp.net", "123456789012345@lid", "120363000000000001@g.us", "+15550000009"];
  const points: [number, number][] = [[10, 20], [10.5, 20], [10.01, 20], [-40, -70]];
  return {
    people: ids.map((id) => [id, (labels.person(id) ?? null) as unknown as Json]),
    providers: ids.map((id) => [id, (labels.provider?.(id) ?? null) as unknown as Json]),
    places: points.map(([latitude, longitude]) => [latitude, longitude, labels.place(latitude, longitude)?.name ?? null, (labels.nearest(latitude, longitude) ?? null) as unknown as Json]),
  } as unknown as Json;
}

function landed(order: (list: ReturnType<typeof deliveries>) => ReturnType<typeof deliveries>): { home: TestHome; units: Map<string, Json>; rows: Map<string, ExtractRow> } {
  const home = new TestHome("lifestream-labels-home-");
  for (const delivery of order(deliveries())) {
    home.land(delivery.source, delivery.stated_ms, delivery.rows);
    home.extractPass(FAMILY);
  }
  const rows = home.extracts("labels");
  return { home, units: new Map(rows.map((row) => [row.unit, row.content])), rows: new Map(rows.map((row) => [row.unit, row])) };
}

describe("labels family, end to end through core", () => {
  it("a day names an id or a point otherwise from the units than the labels over the same records do", () => {
    const { home, units, rows } = landed((list) => list);
    try {
      const direct = home.read((view) => readLabels(view, HOME, NETWORKED));
      const fromUnits = labelsFrom((unit) => rows.get(unit), DAY);
      expect(answers(fromUnits)).toEqual(answers(direct));
      expect(fromUnits.person("+15550000001")).toEqual({ id: "person:person-a", name: "Person A", by: "registry", slug: "person-a", me: false });
      expect(fromUnits.person("person-b@example.com")).toEqual({ id: "person:person-a", name: "Person A", by: "registry", slug: "person-a", me: false });
      expect(fromUnits.provider?.("123456789012345@lid")).toEqual({ name: "Partner D", pushName: "Pusher D", aliases: ["15550000004@s.whatsapp.net"] });
      expect(fromUnits.place(10.5, 20)?.name).toBe("Synthetic Park");
      expect(fromUnits.person("+15550000000")?.me).toBe(true);
      ARTIFACT.units = Object.fromEntries(units);
      pin(FAMILY, { labels: FED.labels, messages: NETWORKED.messages, mail: FED.mail }, [...rows.values()]);
    } finally {
      home.close();
    }
  });

  it("the same records arriving in another order make other units", () => {
    const inOrder = landed((list) => list);
    const reversed = landed((list) => [...list].reverse());
    const mixed = landed((list) => shuffled(list, 7));
    try {
      expect(Object.fromEntries(reversed.units)).toEqual(Object.fromEntries(inOrder.units));
      expect(Object.fromEntries(mixed.units)).toEqual(Object.fromEntries(inOrder.units));
    } finally {
      for (const each of [inOrder, reversed, mixed]) each.home.close();
    }
  });

  it("a card or a chat shell that changes no name reads every label again or writes a unit, or one that renames writes another's, or a card taken back leaves its unit", () => {
    const { home } = landed((list) => list);
    try {
      const same = home.land(CONTACTS, 5_000, [{ ...card("c2", "Card C", "+15550000003", "person-c@example.com"), content: { card: "BEGIN:VCARD\r\nFN:Card C\r\nTEL:+15550000003\r\nEMAIL:person-c@example.com\r\nBDAY:2000-01-01\r\nEND:VCARD\r\n" } }]);
      expect(same.changed).toBe(1);
      expect(home.extractPass(FAMILY)).toMatchObject({ touched: [], written: [] });
      const shell = chat("123456789012345@lid", "Partner D", "15550000004@s.whatsapp.net");
      const ticked = home.land(WHATSAPP, 5_500, [{ ...shell, content: { type: "whatsapp.chat", chat: { ...(shell.content as { chat: Record<string, Json> }).chat, ZLASTMESSAGETEXT: "synthetic last line", ZMESSAGECOUNTER: 7 } } }]);
      expect(ticked.changed).toBe(1);
      expect(home.extractPass(FAMILY)).toMatchObject({ touched: [], written: [] });
      home.land(CONTACTS, 6_000, [card("c2", "Card C2", "+15550000003", "person-c@example.com")]);
      expect(home.extractPass(FAMILY).written.sort()).toEqual(["email:person-c@example.com", "phone:+15550000003"]);
      home.land(CONTACTS, 7_000, [{ kind: "contact", key: "c2", content: null, gone: true }]);
      expect(home.extractPass(FAMILY).deleted.sort()).toEqual(["email:person-c@example.com", "phone:+15550000003"]);
      ARTIFACT.changes = { units: home.extracts("labels").map((row) => row.unit) };
    } finally {
      home.close();
    }
  });

  it("a chat shell's tick moves which copy's name wins, so the stored units differ from a rebuild over the same records", () => {
    const MAC = "whatsapp:15550000000:macbook-pro-0001";
    const jid = "15550000007@s.whatsapp.net";
    const shell = (partner: string, counter: number): ReaderOutput => ({
      kind: "chat", key: jid, content: { type: "whatsapp.chat", chat: { ZPARTNERNAME: partner, ZCONTACTJID: jid, ZMESSAGECOUNTER: counter } },
    });
    const steps: [string, number, ReaderOutput[]][] = [[MAC, 1_000, [shell("Name On Mac", 1)]], [WHATSAPP, 2_000, [shell("Name On Phone", 1)]], [MAC, 3_000, [shell("Name On Mac", 2)]]];
    const incremental = new TestHome("lifestream-labels-tick-");
    const rebuilt = new TestHome("lifestream-labels-tick-rebuilt-");
    try {
      for (const [source, stated_ms, rows] of steps) {
        incremental.land(source, stated_ms, rows);
        incremental.extractPass(FAMILY);
        rebuilt.land(source, stated_ms, rows);
      }
      rebuilt.extractPass(FAMILY);
      const units = (home: TestHome) => home.extracts("labels").map(({ unit, content }) => ({ unit, content }));
      expect(units(incremental)).toEqual(units(rebuilt));
      expect(rebuilt.read((view) => readLabels(view, HOME, NETWORKED).provider?.(jid))).toMatchObject({ name: "Name On Phone" });
      ARTIFACT.tick = units(rebuilt) as unknown as Json;
    } finally {
      incremental.close();
      rebuilt.close();
    }
  });
  it("a places unit code 1 stored, with no Google names and a place without ids, throws or names a point otherwise than its places", () => {
    const [older] = JSON.parse(readFileSync(new URL("./test/places.code-1.json", import.meta.url), "utf8")) as ExtractRow[];
    const table = placesUnit({ content: older!.content });
    expect(table.google).toEqual([]);
    expect(table.places.map((place) => [place.slug, place.ids])).toEqual([["desk", []], ["home", ["google:ChIJ-synthetic-home"]], ["park", []]]);
    const labels = labelsFrom((unit) => unit === "places" ? { content: older!.content } : undefined, { zone: "UTC", day_start_hour: 4 });
    const named = [[10, 20], [10.5, 20], [0, 0], [-40, -70]].map(([latitude, longitude]) => labels.place(latitude!, longitude!)?.name ?? null);
    expect(named).toEqual(["Synthetic Desk", "Synthetic Park", "Synthetic Home", null]);
    ARTIFACT.code_1_places = { table: table as unknown as Json, named };
  });

  it("adding a LID makes an unchanged older name beat a newer provider name", () => {
    const home = new TestHome("lifestream-labels-alias-");
    const mac = "whatsapp:15550000000:macbook-pro-0001";
    const jid = "15550000007@s.whatsapp.net";
    const lid = "123456789012347@lid";
    try {
      home.land(mac, 1_000, [chat(jid, "Older Name", jid)]);
      home.extractPass(FAMILY);
      home.land(WHATSAPP, 2_000, [chat(jid, "Newer Name", jid)]);
      home.extractPass(FAMILY);
      home.land(mac, 3_000, [{ kind: "chat", key: jid, content: { type: "whatsapp.chat", chat: { ZPARTNERNAME: "Older Name", ZCONTACTJID: jid, ZCONTACTIDENTIFIER: lid } } }]);
      home.extractPass(FAMILY);
      const labels = home.read((view) => readLabels(view, HOME, NETWORKED));
      expect(labels.provider?.(jid)).toEqual({ name: "Newer Name", aliases: [lid] });
      expect(home.extracts("labels").find((row) => row.unit === `jid:${jid}`)?.content).toEqual({ provider: { name: "Newer Name", aliases: [lid] } });
      ARTIFACT.alias = labels.table as unknown as Json;
    } finally {
      home.close();
    }
  });

});

describe("what a change reaches: each of these is impossible", () => {
  type Landing = [source: string, stated_ms: number, rows: ReaderOutput[]];
  const A_UNITS = ["email:person-b@example.com", "phone:+15550000001"];
  const edited = (row: ReaderOutput, patch: Record<string, Json>): ReaderOutput => ({ ...row, content: { ...row.content as Record<string, Json>, ...patch } });
  const personA = person("person-a", "Person A", [["phone", "+15550000001"]]);
  const personB = person("person-b", "Person B", [["email", "person-b@example.com"]], "person-a");
  const personC = person("person-c", "Person C", [["phone", "+15550000003"]]);
  const units = (home: TestHome) => home.extracts("labels").map(({ unit, content, reading }) => ({ unit, content, reading }));

  function reached(change: Landing[]): { pass: ReturnType<TestHome["extractPass"]>; stored: ReturnType<typeof units>; whole: ReturnType<typeof units>; before: ReturnType<typeof units> } {
    const base: Landing[] = [...deliveries().map(({ source, stated_ms, rows }): Landing => [source, stated_ms, rows]), [PEOPLE, 5_000, [personC]]];
    const incremental = new TestHome("lifestream-labels-reach-");
    const rebuilt = new TestHome("lifestream-labels-reach-whole-");
    try {
      for (const [source, stated_ms, rows] of base) {
        incremental.land(source, stated_ms, rows);
        incremental.extractPass(FAMILY);
      }
      const before = units(incremental);
      for (const [source, stated_ms, rows] of change) incremental.land(source, stated_ms, rows);
      const pass = incremental.extractPass(FAMILY);
      for (const [source, stated_ms, rows] of [...base, ...change]) rebuilt.land(source, stated_ms, rows);
      rebuilt.extractPass(FAMILY);
      return { pass, stored: units(incremental), whole: units(rebuilt), before };
    } finally {
      incremental.close();
      rebuilt.close();
    }
  }

  it("a place change touches a unit but places, or its places unit differs from the whole pass's", () => {
    const { pass, stored, whole } = reached([[PLACES, 6_000, [place("desk", "Synthetic Desk Renamed", 10)]]]);
    expect(pass).toEqual({ touched: ["places"], written: ["places"], deleted: [] });
    expect(stored).toEqual(whole);
    expect(placesUnit(stored.find((row) => row.unit === "places")!).places.map((each) => each.name)).toEqual(["Synthetic Desk Renamed", "Synthetic Park"]);
  });

  it("the last place gone leaves a places unit, or touches another", () => {
    const gone = (key: string): ReaderOutput => ({ kind: "place", key, content: null, gone: true });
    const { pass, stored, whole } = reached([[PLACES, 6_000, [gone("desk"), gone("park")]]]);
    expect(pass).toEqual({ touched: ["places"], written: [], deleted: ["places"] });
    expect(stored).toEqual(whole);
    expect(stored.map((row) => row.unit)).not.toContain("places");
  });

  it("a person renamed touches another person's unit, or writes their units otherwise than the whole pass", () => {
    const { pass, stored, whole, before } = reached([[PEOPLE, 6_000, [edited(personA, { name: "Person Renamed" })]]]);
    expect(pass).toEqual({ touched: A_UNITS, written: A_UNITS, deleted: [] });
    expect(stored).toEqual(whole);
    expect(stored.filter((row) => !A_UNITS.includes(row.unit))).toEqual(before.filter((row) => !A_UNITS.includes(row.unit)));
    expect(stored.find((row) => row.unit === "phone:+15550000001")!.content).toEqual({ person: { id: "person:person-a", name: "Person Renamed", by: "registry", slug: "person-a", me: false } });
  });

  it("a merged person renamed under a named root writes a unit, or a full name shown is not the name its units carry", () => {
    const merged = reached([[PEOPLE, 6_000, [edited(personB, { name: "Person B Renamed" })]]]);
    expect(merged.pass).toEqual({ touched: A_UNITS, written: [], deleted: [] });
    expect(merged.stored).toEqual(merged.whole);
    const full = reached([[PEOPLE, 6_000, [edited(personA, { full_name: "Person A Fullname", show: "full_name" })]]]);
    expect(full.pass).toEqual({ touched: A_UNITS, written: A_UNITS, deleted: [] });
    expect(full.stored).toEqual(full.whole);
    expect(full.stored.find((row) => row.unit === "email:person-b@example.com")!.content).toMatchObject({ person: { name: "Person A Fullname", by: "registry" } });
  });

  it("a rename in the run after a whole pass that carried its units writes a carried unit from its stored content, renamed, never as the whole pass would", () => {
    const base: Landing[] = [...deliveries().map(({ source, stated_ms, rows }): Landing => [source, stated_ms, rows]), [PEOPLE, 5_000, [personC]]];
    const anchored = { anchor: { kind: "phone", value: "+15550000005" } };
    const moved: Landing = [PEOPLE, 6_000, [edited(personC, anchored), edited(personA, { handles: [{ kind: "phone", value: "+15550000003" }] })]];
    const renamed: Landing = [PEOPLE, 7_000, [edited(personC, { ...anchored, name: "Person C Renamed" })]];
    const home = new TestHome("lifestream-labels-carried-");
    const rebuilt = new TestHome("lifestream-labels-carried-whole-");
    try {
      for (const [source, stated_ms, rows] of base) {
        home.land(source, stated_ms, rows);
        home.extractPass(FAMILY);
      }
      home.land(...moved);
      const carried = [...new Set([...units(home).map((row) => row.unit), "phone:+15550000005"])].sort();
      home.db.commit((tx) => {
        tx.tables.cursors.move(`extract:${FAMILY.name}`, { seq: tx.records.top(), at_ms: 0 });
        tx.records.carryUnits(FAMILY.name, carried);
      });
      const through = home.read((view) => view.through);
      home.land(...renamed);
      const built = home.read((view) => {
        const [statement] = [...view.statements(through, { sources: [PEOPLE], kinds: ["person"] })];
        const history = view.history(statement!);
        const change = { record: { source: PEOPLE, kind: "person", key: "person-c" }, before: view.version(history.at(-2)!.version), after: view.version(statement!.version) };
        const touched = new Set([...carried, ...FAMILY.touched([change], view).map((each) => each.unit)]);
        return [...touched].sort().map((unit) => [unit, FAMILY.extract(unit, view, home.blobs)?.content ?? null] as const);
      });
      for (const [source, stated_ms, rows] of [...base, moved, renamed]) rebuilt.land(source, stated_ms, rows);
      rebuilt.extractPass(FAMILY);
      const whole = new Map(units(rebuilt).map((row) => [row.unit, row.content]));
      expect(built).toEqual(built.map(([unit]) => [unit, whole.get(unit) ?? null]));
      expect(new Map(built).get("phone:+15550000003")).toMatchObject({ person: { id: "person:person-a" } });
    } finally {
      home.close();
      rebuilt.close();
    }
  });

  it("a handle moved, a name cleared, a merge or a place and a person in one change skip the whole pass, or it differs from a rebuild", () => {
    const cases: Landing[][] = [
      [[PEOPLE, 6_000, [edited(personA, { handles: [{ kind: "email", value: "person-a@example.com" }] })]]],
      [[PEOPLE, 6_000, [edited(personC, { name: null })]]],
      [[PEOPLE, 6_000, [edited(personC, { merged_into: "person-a" })]]],
      [[PEOPLE, 6_000, [edited(personA, { name: "Person Renamed" })]], [PLACES, 6_000, [place("desk", "Synthetic Desk Renamed", 10)]]],
    ];
    const outcomes = cases.map((change) => reached(change));
    for (const { pass, stored, whole, before } of outcomes) {
      expect(pass.touched).toEqual(expect.arrayContaining(before.map((row) => row.unit)));
      expect(stored).toEqual(whole);
    }
    expect(outcomes[1]!.stored.find((row) => row.unit === "phone:+15550000003")!.content).toMatchObject({ person: { name: "Card C", by: "contact" } });
    ARTIFACT.reach = outcomes.map(({ pass }) => pass) as unknown as Json;
  });
});

const counted = (camera: string, photos: number, phones: string[] = []): ReaderOutput => ({
  kind: "camera", key: camera,
  content: { type: "cameras.camera", make: "Synthetic Make", model: "Synthetic Camera", photos, first_ms: Date.UTC(2026, 8, 1), last_ms: Date.UTC(2026, 9, 1), sample: `sha256:${"a".repeat(64)}`, phones },
});
const word = (camera: string, mine: boolean, dates: { from?: string; to?: string } = {}): ReaderOutput => ({ kind: "camera", key: camera, content: { type: "devices.camera", mine, ...dates } });

const STRANGER = "synthetic-make/synthetic-camera";
const PHONE = "phone/iphone-aa01";
const PROBES = "upload:local:unit-a";

const probe: Family = {
  name: "probe",
  type: "photos",
  code: "1",
  inputs: [{ sources: { product: ["upload"] }, kinds: ["probe"], role: "evidence" }],
  touched: (changes) => changes.map((change) => ({ unit: change.record.key })),
  extract(unit, view) {
    const head = view.head({ source: PROBES, kind: "probe", key: unit });
    if (head === undefined || head.version === "gone") return null;
    const content = view.version(head.version).content as { camera: string; at_ms: number };
    return { content, start_ms: content.at_ms, end_ms: content.at_ms, reading: digest(content) };
  },
  days: (row, settings) => [civilDay(row.start_ms!, settings)],
  day: linesOnly((input) => input.extracts.map((row) => {
    const { camera, at_ms } = row.content as { camera: string; at_ms: number };
    return { family: "probe", unit: row.unit, units: [row.unit], start_ms: at_ms, end_ms: null, text: `${camera}: ${input.labels.mine(camera, at_ms) ? "mine" : "not mine"}` };
  })),
};

const photo = (key: string, camera: string, wall: string): ReaderOutput => ({ kind: "probe", key, content: { camera, at_ms: Date.parse(`${wall}+05:30`) } });

function mineOf(home: TestHome, photos: readonly [string, number][]): boolean[] {
  return home.read((view) => {
    const labels = labelsFrom((unit) => view.extract("labels", unit), DAY);
    return photos.map(([camera, at_ms]) => labels.mine(camera, at_ms));
  });
}

function rendered(home: TestHome, day: string): { text: string; inputs: string; read: string[] } {
  return home.read((view: OpenView) => {
    const out = renderDay(day, [probe], dayReader(view), DAY, (unit) => view.extract("labels", unit));
    return { text: out.txt, inputs: out.inputs, read: out.units.filter((unit) => unit.family === "labels").map((unit) => unit.unit) };
  });
}

describe("the cameras' units: each of these is impossible", () => {
  it("K3 K4 K5: a stray camera of 49 photos is the owner's, its 50th does not make it so, its 51st writes a unit, or a count reads every label", () => {
    const home = new TestHome("lifestream-labels-cameras-", { settings: DAY });
    try {
      home.land(PEOPLE, 1_000, [person("person-a", "Person A", [["phone", "+15550000001"]])]);
      home.extractPass(FAMILY, DAY);
      home.land(CAMERAS, 2_000, [counted(STRANGER, 49)]);
      const first = home.extractPass(FAMILY, DAY);
      expect(first).toEqual({ touched: [`camera:${STRANGER}`], written: [`camera:${STRANGER}`], deleted: [] });
      const unit = () => home.extracts("labels").find((row) => row.unit === `camera:${STRANGER}`)!;
      expect(unit().content).toEqual({ mine_by_count: false });
      const at = Date.parse("2026-10-01T12:00:00+05:30");
      const mine = () => mineOf(home, [[STRANGER, at]])[0];
      expect(mine()).toBe(false);
      home.land(CAMERAS, 3_000, [counted(STRANGER, 50)]);
      expect(home.extractPass(FAMILY, DAY).written).toEqual([`camera:${STRANGER}`]);
      expect(unit().content).toEqual({ mine_by_count: true });
      expect(mine()).toBe(true);
      const before = unit();
      home.land(CAMERAS, 4_000, [counted(STRANGER, 51)]);
      const fiftyFirst = home.extractPass(FAMILY, DAY);
      expect(fiftyFirst).toEqual({ touched: [`camera:${STRANGER}`], written: [], deleted: [] });
      expect([unit().reading, unit().seq]).toEqual([before.reading, before.seq]);
      home.land(PEOPLE, 4_500, [person("person-a", "Person Renamed", [["phone", "+15550000001"]])]);
      expect(home.extractPass(FAMILY).touched).not.toContain(`camera:${STRANGER}`);
      home.land(CAMERAS, 5_000, [{ kind: "camera", key: STRANGER, content: null, gone: true }]);
      expect(home.extractPass(FAMILY, DAY).deleted).toEqual([`camera:${STRANGER}`]);
      expect(mine()).toBe(false);
      ARTIFACT.counts = { first, fiftyFirst } as unknown as Json;
    } finally {
      home.close();
    }
  });

  it("K1 K2 K7: a mark leaves the camera's photos the owner's, reaches other dates than it names, reads a date in UTC, or renders a day its photos are not on", () => {
    const home = new TestHome("lifestream-labels-word-", { settings: DAY });
    try {
      home.land(CAMERAS, 1_000, [counted(STRANGER, 60), counted("synthetic-make/other-camera", 80)]);
      home.extractPass(FAMILY, DAY);
      home.land(PROBES, 1_000, [
        photo("p1", STRANGER, "2026-10-01T12:00:00"), photo("p2", STRANGER, "2026-10-02T02:00:00"), photo("p3", STRANGER, "2026-10-02T05:00:00"),
        photo("p4", "synthetic-make/other-camera", "2026-10-05T12:00:00"),
      ]);
      home.extractPass(probe, DAY);
      const days = ["2026-10-01", "2026-10-02", "2026-10-05"];
      const byCount = new Map(days.map((day) => [day, rendered(home, day)]));
      expect(byCount.get("2026-10-01")!.text).toMatch(/synthetic-make\/synthetic-camera: mine\n.*synthetic-make\/synthetic-camera: mine\n/su);
      expect(byCount.get("2026-10-02")!.read).toEqual([`camera:${STRANGER}`]);
      expect(byCount.get("2026-10-05")!.read).toEqual(["camera:synthetic-make/other-camera"]);

      home.land(DEVICES, 2_000, [word(STRANGER, false)]);
      expect(home.extractPass(FAMILY, DAY).written).toEqual([`camera:${STRANGER}`]);
      const marked = new Map(days.map((day) => [day, rendered(home, day)]));
      expect(marked.get("2026-10-01")!.text).not.toMatch(/synthetic-camera: mine/u);
      expect(marked.get("2026-10-02")!.text).toMatch(/synthetic-camera: not mine/u);
      expect(days.filter((day) => marked.get(day)!.inputs !== byCount.get(day)!.inputs)).toEqual(["2026-10-01", "2026-10-02"]);

      home.land(DEVICES, 3_000, [word(STRANGER, false, { from: "2026-10-02" })]);
      home.extractPass(FAMILY, DAY);
      const from = rendered(home, "2026-10-01").text;
      expect(from.match(/synthetic-camera: (?:not )?mine/gu)).toEqual(["synthetic-camera: mine", "synthetic-camera: mine"]);
      expect(rendered(home, "2026-10-02").text).toMatch(/synthetic-camera: not mine/u);
      const at = (wall: string) => Date.parse(`${wall}+05:30`);
      expect(mineOf(home, ["2026-09-01T12:00:00", "2026-10-02T03:59:59", "2026-10-02T04:00:00", "2027-01-01T12:00:00"].map((wall) => [STRANGER, at(wall)])))
        .toEqual([true, true, false, false]);

      home.land(DEVICES, 4_000, [word("synthetic-make/new-camera", true, { to: "2026-10-03" })]);
      home.extractPass(FAMILY, DAY);
      expect(mineOf(home, [["synthetic-make/new-camera", at("2026-10-03T23:00:00")], ["synthetic-make/new-camera", at("2026-10-04T05:00:00")]])).toEqual([true, false]);
      home.land(DEVICES, 5_000, [{ kind: "camera", key: STRANGER, content: null, gone: true }]);
      home.extractPass(FAMILY, DAY);
      expect(rendered(home, "2026-10-02").text).not.toMatch(/not mine/u);
      ARTIFACT.word = { byCount: Object.fromEntries(byCount), marked: Object.fromEntries(marked) } as unknown as Json;
    } finally {
      home.close();
    }
  });

  it("K6: a paired phone's camera is not the owner's from its first photo, or a camera no one counted is", () => {
    const home = new TestHome("lifestream-labels-paired-", { settings: DAY });
    try {
      const NEW = "apple/iphone-17-pro";
      home.land(CAMERAS, 1_000, [counted(PHONE, 1), counted(NEW, 3, ["iphone-17-pro-0042"]), counted("google/pixel-9", 1)]);
      home.extractPass(FAMILY, DAY);
      const at = Date.parse("2026-10-01T12:00:00+05:30");
      expect(mineOf(home, [[PHONE, at], [NEW, at], ["google/pixel-9", at], ["phone/iphone-bb02", at], [STRANGER, at]])).toEqual([true, true, false, false, false]);
      expect(home.extracts("labels").map((row) => [row.unit, row.content])).toEqual([
        [`camera:${NEW}`, { mine_by_count: true, paired: true }], ["camera:google/pixel-9", { mine_by_count: false }], [`camera:${PHONE}`, { mine_by_count: true, paired: true }],
      ]);
      home.land(CAMERAS, 2_000, [counted(NEW, 4, ["iphone-17-pro-0042"])]);
      expect(home.extractPass(FAMILY, DAY).written).toEqual([]);
    } finally {
      home.close();
    }
  });
});

describe("the groups' units: each of these is impossible", () => {
  const IM = "imessage:person-me@example.com:macbook-pro-0001";
  const MAC = "whatsapp:15550000000:macbook-pro-0001";
  const GROUPS = `groups:local:${HOME}`;
  const GROUP = "120363000000000001@g.us";
  const PEOPLE_E = "+15550000004,person-e@example.com";
  const handle = (canonical: string, kind: "phone" | "email") => ({ raw: canonical, canonical, kind });
  const imChat = (guid: string, participants: ReturnType<typeof handle>[]): ReaderOutput => ({ kind: "chat", key: guid, content: { type: "imessage.chat", guid, style: 43, service: "iMessage", participants } });
  const imState = (guid: string, name: string | null): ReaderOutput => ({ kind: "chat-state", key: `macbook-pro-0001:${guid}`, content: { type: "imessage.chat-state", chat_guid: guid, unit_id: "macbook-pro-0001", state: { display_name: name } } });
  const shell = (key: string, partner: string, archived: number): ReaderOutput => ({ kind: "chat", key, content: { type: "whatsapp.chat", chat: { ZPARTNERNAME: partner, ZCONTACTJID: key, ZARCHIVED: archived, ZSESSIONTYPE: key.endsWith("@g.us") ? 1 : 0 } } });
  const month = (key: string, yours: [string, string][]): ReaderOutput => ({ kind: "month", key, content: { yours } });
  const stored = (home: TestHome) => labelsFrom((unit) => home.read((view) => view.extract("labels", unit)), DAY);

  it("G1: an iMessage group unnamed by its chat-state, a one-to-one chat named by one, or a rename that leaves the old name", () => {
    const home = new TestHome("lifestream-labels-imessage-");
    try {
      home.land(IM, 1_000, [
        imChat("chat-g", [handle("+15550000004", "phone"), handle("person-e@example.com", "email")]), imState("chat-g", "Group Synthetic"),
        imChat("chat-d", [handle("+15550000004", "phone")]), imState("chat-d", "Not A Group"),
      ]);
      expect(home.extractPass(FAMILY).written).toEqual(["email:person-me@example.com", `imessage:${PEOPLE_E}`]);
      expect(stored(home).person("person-me@example.com")?.me).toBe(true);
      expect(stored(home).provider?.(PEOPLE_E, "imessage")).toEqual({ name: "Group Synthetic" });
      expect(home.read((view) => readLabels(view, HOME, NETWORKED).provider?.(PEOPLE_E, "imessage"))).toEqual({ name: "Group Synthetic" });
      home.land(IM, 2_000, [imState("chat-g", "Group Renamed")]);
      expect(home.extractPass(FAMILY).written).toEqual([`imessage:${PEOPLE_E}`]);
      expect(stored(home).provider?.(PEOPLE_E, "imessage")).toEqual({ name: "Group Renamed" });
      home.land(IM, 3_000, [imState("chat-g", null)]);
      expect(home.extractPass(FAMILY).deleted).toEqual([`imessage:${PEOPLE_E}`]);
      expect(stored(home).provider?.(PEOPLE_E, "imessage")).toBeUndefined();
      ARTIFACT.imessage = home.extracts("labels").map(({ unit, content }) => ({ unit, content })) as unknown as Json;
    } finally {
      home.close();
    }
  });

  it("G2: a group archived on one copy alone reads as archived, one unarchived keeps it, or an archived one-to-one chat says so", () => {
    const home = new TestHome("lifestream-labels-archived-");
    const B = "15550000002@s.whatsapp.net";
    try {
      home.land(MAC, 1_000, [shell(GROUP, "Group Alpha", 1), shell(B, "Person B", 1)]);
      home.land(WHATSAPP, 2_000, [shell(GROUP, "Group Alpha", 0), shell(B, "Person B", 1)]);
      home.extractPass(FAMILY);
      expect(stored(home).provider?.(GROUP)).toEqual({ name: "Group Alpha" });
      expect(stored(home).provider?.(B)).toEqual({ name: "Person B" });
      home.land(WHATSAPP, 3_000, [shell(GROUP, "Group Alpha", 1)]);
      expect(home.extractPass(FAMILY).written).toEqual([`jid:${GROUP}`]);
      expect(stored(home).provider?.(GROUP)).toEqual({ name: "Group Alpha", archived: true });
      home.land(MAC, 4_000, [shell(GROUP, "Group Alpha", 0)]);
      expect(home.extractPass(FAMILY).written).toEqual([`jid:${GROUP}`]);
      expect(stored(home).provider?.(GROUP)).toEqual({ name: "Group Alpha" });
    } finally {
      home.close();
    }
  });

  it("G3 G4: a month lands in no unit, its change writes another's, a gone month keeps its unit, or a day misses the month it read", () => {
    const home = new TestHome("lifestream-labels-groups-");
    const quietProbe: Family = {
      ...probe,
      name: "quiet",
      day: linesOnly((input) => input.extracts.map((row) => ({
        family: "quiet", unit: row.unit, units: [row.unit], start_ms: (row.content as { at_ms: number }).at_ms, end_ms: null,
        text: `${GROUP}: ${input.labels.quiet("whatsapp", GROUP, input.day) ? "quiet" : "yours"}`,
      }))),
    };
    const day = (on: string) => home.read((view) => {
      const out = renderDay(on, [quietProbe], dayReader(view), DAY, (unit) => view.extract("labels", unit));
      return { text: out.txt.split("\n").find((line) => line.includes(GROUP)) ?? null, inputs: out.inputs, read: out.units.filter((unit) => unit.family === "labels").map((unit) => unit.unit) };
    });
    try {
      home.land(PROBES, 500, [photo("p1", STRANGER, "2026-09-10T12:00:00"), photo("p2", STRANGER, "2026-10-10T12:00:00"), photo("p3", STRANGER, "2026-10-05T12:00:00")]);
      home.extractPass(quietProbe);
      const before = day("2026-10-10");
      expect(before.text).toContain("yours");
      expect(before.read).toContain(`group:whatsapp:${GROUP}:2026-10`);
      home.land(GROUPS, 1_000, [month(`whatsapp:${GROUP}:2026-09`, [["2026-09-01", "2026-09-30"]]), month(`whatsapp:${GROUP}:2026-10`, [["2026-10-01", "2026-10-05"]])]);
      expect(home.extractPass(FAMILY).written.sort()).toEqual([`group:whatsapp:${GROUP}:2026-09`, `group:whatsapp:${GROUP}:2026-10`]);
      const after = day("2026-10-10");
      expect(after.text).toContain("quiet");
      expect(after.inputs).not.toBe(before.inputs);
      expect(day("2026-10-05").text).toContain("yours");
      const september = day("2026-09-10");
      home.land(GROUPS, 2_000, [month(`whatsapp:${GROUP}:2026-10`, [["2026-10-01", "2026-10-31"]])]);
      expect(home.extractPass(FAMILY)).toMatchObject({ written: [`group:whatsapp:${GROUP}:2026-10`] });
      expect(day("2026-09-10").inputs).toBe(september.inputs);
      expect(day("2026-10-10").text).toContain("yours");
      home.land(GROUPS, 3_000, [{ kind: "month", key: `whatsapp:${GROUP}:2026-09`, content: null, gone: true }]);
      expect(home.extractPass(FAMILY).deleted).toEqual([`group:whatsapp:${GROUP}:2026-09`]);
      ARTIFACT.groups = { units: home.extracts("labels").map(({ unit, content }) => ({ unit, content })), september: day("2026-09-10").text } as unknown as Json;
    } finally {
      home.close();
    }
  });
});
