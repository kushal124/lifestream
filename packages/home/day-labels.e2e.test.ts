import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, openHome, openHomeFolder, type HomeDb, type JobRow } from "@lifestreamprotocol/core";
import { extractKind, rebuildExtracts, renderKind } from "./derive.js";
import { nameDevice } from "./devices.js";
import { startHome, type Home } from "./home.js";
import { LANE, type HelperEnv, type Kind, type Main, type Running } from "./jobs.js";
import { effective } from "./settings.js";
import fakeRegistry, { fakeRows } from "./test/fakes.js";
import { askHome } from "./socket.js";
import { artifact, FAKES, makeRoot, readHome, removeRoot, REPO, until, TICK_MS } from "./test/harness-root.js";
import { ship, type Planned } from "./test/harness-deliveries.js";
import { testSocket } from "./test/folder.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";
import { homeOf } from "./registry.js";


const COUNT = 300;
const FIRST = "2025-01-01";
const DAYS = Array.from({ length: COUNT }, (_, index) => addDays(FIRST, index));
const NOTES = "apple-notes:local:device-a";
const CONTACTS = "apple-contacts:local:device-a";
const WHATSAPP = "whatsapp:15550000000:iphone-aa01";
const HOME_UNIT = "device-home";
const PLACES = `places:local:${HOME_UNIT}`;
const DESK = { latitude: 10, longitude: 20 };
const PARK = { latitude: 10.5, longitude: 20 };
const NEAR_DESK = { latitude: 10.01, longitude: 20 };

const PRINTS: Record<number, { who?: string; where?: { latitude: number; longitude: number }; on?: string }> = {
  10: { who: "+15550000001" }, 20: { who: "+15550000001" }, 25: { who: "+15550000004" },
  30: { who: "15550000002@s.whatsapp.net" }, 40: { who: "15550000002@s.whatsapp.net" }, 50: { who: "15550000003@s.whatsapp.net" },
  60: { where: DESK }, 70: { where: DESK }, 80: { where: NEAR_DESK }, 90: { where: PARK },
  100: { on: "macbook-pro-0001" }, 105: { on: "macbook-pro-0001" }, 110: { on: "mac-mini-bb01" },
};
const day = (index: number): string => DAYS[index]!;

const card = (name: string, phone: string) => ({ card: `BEGIN:VCARD\r\nFN:${name}\r\nTEL:${phone}\r\nEND:VCARD\r\n` });
const pushName = (jid: string, name: string) => ({ type: "whatsapp.pushname", ZJID: jid, ZPUSHNAME: name });
const place = (name: string, centre: { latitude: number; longitude: number }) => ({ type: "places.place", name, centre, radius_m: 100, ids: [] });

interface Change {
  marked: string[];
  render_ms: number;
  rewritten: string[];
}

describe("a label change marks only the days whose printed names changed", () => {
  let root: string;
  let home: Home;
  let shipped = 0;
  const report: Record<string, unknown> = { days: COUNT };

  const count = (sql: string, ...params: unknown[]): number => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
  const text = (index: number): string => readFileSync(join(root, "days", `${day(index)}.day.txt`), "utf8");
  const files = (): Map<string, string> => new Map(readdirSync(join(root, "days")).filter((name) => !name.startsWith("."))
    .map((name) => [name, readFileSync(join(root, "days", name), "utf8")]));
  const quietButRender = (): boolean => count("SELECT count(*) FROM deliveries WHERE state = 'imported'") === shipped &&
    count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running') AND kind <> 'render'") === 0;
  const quiet = (): boolean => quietButRender() && count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0 &&
    count("SELECT count(*) FROM dirty_days") === 0;
  const send = async (delivery: Planned): Promise<void> => {
    await ship(root, delivery);
    shipped++;
  };
  const labels = (): string => JSON.stringify(readHome(root, (db) => db.prepare("SELECT unit, reading FROM extracts WHERE family = 'labels' ORDER BY unit").all()));
  const start = async (): Promise<void> => {
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
  };

  async function change(make: () => Promise<void>): Promise<Change> {
    const sock = testSocket(root);
    await askHome(sock, "pause", ["kind:render", "--reason", "the test reads what the change marked"]);
    const before = files();
    const was = labels();
    await make();
    await until("the labels family read the change", () => labels() !== was && quietButRender());
    const marked = readHome(root, (db) => db.prepare("SELECT day FROM dirty_days ORDER BY day").pluck().all() as string[]).filter((each) => DAYS.includes(each));
    const resumed = Date.now();
    await askHome(testSocket(root), "resume", ["kind:render"]);
    await until("the marked days rendered", quiet);
    const render_ms = Date.now() - resumed;
    const after = files();
    const rewritten = [...new Set([...before.keys(), ...after.keys()].filter((name) => before.get(name) !== after.get(name)).map((name) => name.slice(0, 10)))]
      .filter((each) => DAYS.includes(each)).sort();
    return { marked, render_ms, rewritten };
  }

  beforeAll(async () => {
    root = makeRoot("lifestream-day-labels-", {
      sources: { [NOTES]: "fake-rows", [CONTACTS]: "fake-rows", [WHATSAPP]: "fake-rows", [PLACES]: "fake-rows" },
      settings: { unit: HOME_UNIT }, helpers: 3,
    });
    await start();
    await send({ source: CONTACTS, fetched_ms: Date.now(), rows: [
      { kind: "contact", key: "c1", content: card("Person A", "+15550000001") },
      { kind: "contact", key: "c4", content: card("Person D", "+15550000004") },
    ] });
    await send({ source: WHATSAPP, fetched_ms: Date.now(), rows: [
      { kind: "pushname", key: "p2", content: pushName("15550000002@s.whatsapp.net", "Pusher B") },
      { kind: "pushname", key: "p3", content: pushName("15550000003@s.whatsapp.net", "Pusher C") },
    ] });
    for (const [unit, model] of [["macbook-pro-0001", "MacBook Pro"], ["mac-mini-bb01", "Mac mini"]]) await askHome(testSocket(root), "device", ["add", unit!, "--model", model!]);
    await send({ source: PLACES, fetched_ms: Date.now(), rows: [
      { kind: "place", key: "desk", content: place("Synthetic Desk", DESK) }, { kind: "place", key: "park", content: place("Synthetic Park", PARK) },
      { kind: "place", key: "bench", content: place("Synthetic Bench", { latitude: -40, longitude: -70 }) },
    ] });
    const began = Date.now();
    await send({ source: NOTES, fetched_ms: Date.now(), rows: DAYS.map((each, index) => {
      const at = Date.parse(`${each}T12:00:00Z`);
      return { kind: "note", key: `n${index}`, content: { text: `synthetic note ${index}`, at, ...PRINTS[index] }, at };
    }) });
    await until("every day rendered", () => existsSync(join(root, "days")) && DAYS.every((each) => existsSync(join(root, "days", `${each}.day.json`))) && quiet());
    report.first_render_ms = Date.now() - began;
    expect(text(10)).toContain("with Person A");
    expect(text(30)).toContain("with Pusher B");
    expect(text(60)).toContain("at Synthetic Desk");
    expect(text(80)).toContain("at an unnamed place 1.1 km from Synthetic Desk");
    expect(text(90)).toContain("at Synthetic Park");
    expect(text(100)).toContain("synthetic note 100 on MacBook Pro");
  });

  afterAll(async () => {
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "day-labels.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) {
      artifact(root, "day-labels", report);
      removeRoot(root);
    }
  });

  it("renaming one contact marks every day with files; the days that print it keep the old name", async () => {
    const result = await change(() => send({ source: CONTACTS, fetched_ms: Date.now(), rows: [{ kind: "contact", key: "c1", content: card("Person A2", "+15550000001") }] }));
    report.contact = result;
    expect(result.marked).toEqual([day(10), day(20)]);
    expect(result.rewritten).toEqual([day(10), day(20)]);
    for (const index of [10, 20]) expect(text(index)).toContain("with Person A2");
    expect(text(25)).toContain("with Person D");
  });

  it("a push name change on one chat marks days that never print it; the days that print it keep the old name", async () => {
    const result = await change(() => send({ source: WHATSAPP, fetched_ms: Date.now(), rows: [{ kind: "pushname", key: "p2", content: pushName("15550000002@s.whatsapp.net", "Pusher B2") }] }));
    report.push_name = result;
    expect(result.marked).toEqual([day(30), day(40)]);
    expect(result.rewritten).toEqual([day(30), day(40)]);
    for (const index of [30, 40]) expect(text(index)).toContain("with Pusher B2");
    expect(text(50)).toContain("with Pusher C");
  });

  it("a place the owner renames marks days that name no point, or misses a day that names a point by its nearest place", async () => {
    const result = await change(() => send({ source: PLACES, fetched_ms: Date.now(), rows: [{ kind: "place", key: "desk", content: place("Synthetic Office", DESK) }] }));
    report.owner_place = result;
    expect(result.marked).toEqual([day(60), day(70), day(80), day(90)]);
    expect(result.rewritten).toEqual([day(60), day(70), day(80), day(90)]);
    for (const index of [60, 70]) expect(text(index)).toContain("at Synthetic Office");
    expect(text(80)).toContain("at an unnamed place 1.1 km from Synthetic Office");
    expect(text(90)).toContain("at Synthetic Park");
  });

  it("naming a Mac marks every day with files, or misses a day that named it", async () => {
    const sock = testSocket(root);
    await askHome(sock, "pause", ["kind:render", "--reason", "the test reads what the name marked"]);
    const before = files();
    await askHome(sock, "device", ["name", "macbook-pro-0001", "Synthetic Mac"]);
    const marked = readHome(root, (db) => db.prepare("SELECT day FROM dirty_days ORDER BY day").pluck().all() as string[]);
    const resumed = Date.now();
    await askHome(sock, "resume", ["kind:render"]);
    await until("the marked days rendered", quiet);
    const render_ms = Date.now() - resumed;
    const after = files();
    const rewritten = [...new Set([...before.keys(), ...after.keys()].filter((name) => before.get(name) !== after.get(name)).map((name) => name.slice(0, 10)))].sort();
    report.device_name = { marked, render_ms, rewritten };
    expect(marked).toEqual([day(100), day(105)]);
    expect(rewritten).toEqual([day(100), day(105)]);
    for (const index of [100, 105]) expect(text(index)).toContain("on Synthetic Mac");
    expect(text(110)).toContain("on Mac mini");
  });

  it("a render that asked a name before the labels family read a new contact, and landed after it, keeps no name", async () => {
    const hold = join(root, "render.hold");
    const index = 120;
    const at = Date.parse(`${day(index)}T15:00:00Z`);
    writeFileSync(hold, "");
    await send({ source: NOTES, fetched_ms: Date.now(), rows: [{ kind: "note", key: "late", content: { text: "synthetic late note", at, who: "+15550000009", render_hold: hold }, at }] });
    await until("the render holding the view it reads the labels from", () => existsSync(`${hold}.held`));
    await send({ source: CONTACTS, fetched_ms: Date.now(), rows: [{ kind: "contact", key: "c9", content: card("Person Z", "+15550000009") }] });
    await until("the labels family read the new contact", () => count("SELECT count(*) FROM extracts WHERE family = 'labels' AND unit = 'phone:+15550000009'") === 1);
    rmSync(hold);
    await until("the day rendered under the labels it reads now", () => quiet() && text(index).includes("synthetic late note with Person Z"));
    report.late_render = { day: day(index), printed: text(index).split("\n").filter((line) => line.includes("synthetic late note")) };
  });
});

describe("an own account's source added after the labels were built", () => {
  const UNIT = "device-home";
  const PEOPLE = `people:local:${UNIT}`;
  const FIRST_NUMBER = "15550000010";
  const OWN_WHATSAPP = `whatsapp:${FIRST_NUMBER}:iphone-aa01`;
  const SECOND_WHATSAPP = "whatsapp:15550000011:iphone-aa01";
  const SECOND_ADDRESS = "sam-work@example.com";
  const GMAIL = `gmail:${SECOND_ADDRESS}:cloud`;
  const NAMED = [`+${FIRST_NUMBER}`, SECOND_ADDRESS, "+15550000011"];
  const WHEN = ["2026-09-01", "2026-09-02", "2026-09-03"];
  let root: string | undefined;
  let home: Home | undefined;
  afterAll(async () => {
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("a Gmail source, then a second WhatsApp account, added with nothing else moving leaves its handle naming anyone but the user", async () => {
    root = makeRoot("lifestream-day-labels-own-", { sources: { [NOTES]: "fake-rows", [OWN_WHATSAPP]: "fake-rows", [PEOPLE]: "fake-rows" } });
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "import", subject: PEOPLE, started_ms: Date.now() });
      tx.records.land(run, { id: `${PEOPLE}/you`, source: PEOPLE, stated_ms: Date.now() }, [{ kind: "person", key: "sam", content: {
        type: "people.person", slug: "sam", name: "Sam", full_name: "Sam Example", show: "name", entity: "person", relationship: null, hidden: false, me: true,
        anchor: { kind: "phone", value: `+${FIRST_NUMBER}` }, handles: [], excluded: [], dismissed: [], merged_into: null,
      } }], { person: (content) => typeof content === "object" && content !== null ? [] : ["a person is an object"] }, { has: () => true });
      tx.tables.runs.end(run, { ended_ms: Date.now(), outcome: "ok" });
    });
    db.close();
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
    const count = (sql: string, ...params: unknown[]): number => readHome(root!, (read) => read.prepare(sql).pluck().get(...params) as number);
    const quiet = () => count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0 && count("SELECT count(*) FROM dirty_days") === 0;
    const line = (index: number): string => {
      const path = join(root!, "days", `${WHEN[index]}.day.txt`);
      return existsSync(path) ? readFileSync(path, "utf8").split("\n").find((each) => each.includes(`own note ${index}`))?.replace(/^\d\d:\d\d /u, "") ?? "" : "";
    };
    let shipped = 0;
    const imported = () => count("SELECT count(*) FROM deliveries WHERE state = 'imported'") === shipped;
    const send = async (delivery: Planned) => {
      await ship(root!, delivery);
      shipped++;
    };
    await send({ source: NOTES, fetched_ms: Date.now(), rows: NAMED.map((who, index) => {
      const at = Date.parse(`${WHEN[index]}T12:00:00Z`);
      return { kind: "note", key: `own-${index}`, content: { text: `own note ${index}`, at, who }, at };
    }) });
    await until("every note's day rendered", () => imported() && quiet() && WHEN.every((_, index) => line(index) !== ""));
    const before = NAMED.map((_, index) => line(index));
    expect(before).toEqual(["own note 0 with the user", `own note 1 with ${SECOND_ADDRESS}`, "own note 2 with +15550000011"]);

    const unread = [{ kind: "msg", key: "unread", content: {} }];
    const added = (source: string) => ({ sources: [{ id: source, connector: "fake-rows" }] });
    await send({ source: GMAIL, fetched_ms: Date.now(), rows: unread, facts: added(GMAIL) });
    await until("the mailbox's address names the user", () => imported() && quiet() && line(1) === "own note 1 with the user");
    const reason = (JSON.parse(readHome(root, (read) => read.prepare("SELECT value FROM meta WHERE key = 'fingerprint:labels'").pluck().get() as string)) as { reason?: string[] }).reason;
    expect(reason).toEqual(["own_account"]);
    expect(line(2)).toBe("own note 2 with +15550000011");

    await send({ source: SECOND_WHATSAPP, fetched_ms: Date.now(), rows: unread, facts: added(SECOND_WHATSAPP) });
    await until("the second number names the user", () => imported() && quiet() && line(2) === "own note 2 with the user");
    const after = NAMED.map((_, index) => line(index));
    expect(after).toEqual(["own note 0 with the user", "own note 1 with the user", "own note 2 with the user"]);
    artifact(root, "day-labels-own", { before, after });
  });
});

describe("a render run and the labels it reads", () => {
  let root: string | undefined;
  afterAll(() => {
    if (root !== undefined) removeRoot(root);
  });

  it("a render reads the address book, or its cost grows with the address book", async () => {
    root = makeRoot("lifestream-render-run-labels-", { sources: { [NOTES]: "fake-rows", [CONTACTS]: "fake-rows" } });
    const settings = effective(root).settings;
    const registry = fakeRegistry(settings, homeOf(openHomeFolder(root)));
    const db = openHome(openHomeFolder(root), "migrate");
    const reader = openHome(openHomeFolder(root), "read");
    const blobs = openHomeFolder(root).blobs(join(root, "blobs"));
    const CARDS = 500;
    db.commit((tx) => {
      for (const id of [CONTACTS, NOTES]) if (tx.tables.sources.get(id) === undefined) tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector: "fake-rows", added_ms: Date.now() });
      for (const family of ["notes", "labels"]) rebuildExtracts(tx, family, Date.now());
      const run = tx.tables.runs.start({ kind: "import", subject: CONTACTS, started_ms: Date.now() });
      tx.records.land(run, { id: `${CONTACTS}/cards`, source: CONTACTS, stated_ms: Date.now() },
        Array.from({ length: CARDS }, (_, index) => ({ kind: "contact", key: `c${index}`, content: card(`Person ${index}`, `+1555000${String(index).padStart(4, "0")}`) })), fakeRows.kinds, { has: () => true });
      const days = Array.from({ length: 10 }, (_, index) => addDays("2026-09-01", index));
      tx.records.land(run, { id: `${NOTES}/notes`, source: NOTES, stated_ms: Date.now() }, days.map((each, index) => {
        const at = Date.parse(`${each}T12:00:00Z`);
        return { kind: "note", key: `n${index}`, content: { text: `synthetic note ${index}`, at, who: `+1555000${String(index).padStart(4, "0")}` }, time: { start_ms: at, precision: "ms" as const } };
      }), fakeRows.kinds, { has: () => true });
      tx.tables.runs.end(run, { ended_ms: Date.now(), outcome: "ok" });
    });
    const read: Record<string, number> = {};
    const counted = { view: () => new Proxy(reader.view(), {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") return value;
        if (property !== "records") return (value as (...args: unknown[]) => unknown).bind(target);
        return function* (source: string, kind: string, ...rest: unknown[]) {
          for (const row of (value as (...args: unknown[]) => Iterable<unknown>).call(target, source, kind, ...rest)) {
            read[kind] = (read[kind] ?? 0) + 1;
            yield row;
          }
        };
      },
    }) } as unknown as HomeDb;
    const main = { folder: openHomeFolder(root), settings, registry, families: new Map(registry.families.map((family) => [family.name, family])), now: () => Date.now() } as unknown as Main;
    const drive = async <D, C, R, S>(kind: Kind<D, C, R, S>, key: string, env: HelperEnv) => {
      const job = { id: 1, kind: kind === renderKind as unknown ? "render" : "extract", key, lane: LANE.backfill, not_before_ms: 0, started_ms: Date.now() } as JobRow;
      const begun = db.commit((tx) => kind.begin!(main, tx, job));
      if (begun === null) return;
      const running: Running<S> = { job, state: begun.state };
      const steps = kind.helper(env, { job: 1, kind: job.kind, key, lane: LANE.backfill, now_ms: Date.now(), data: begun.data });
      let next = await steps.next();
      for (; next.done !== true; next = await steps.next()) {
        for (const slice of kind.chunk?.(main, running, next.value) ?? []) {
          slice.settle?.();
          db.commit((tx) => slice.work(tx));
        }
      }
      db.commit((tx) => kind.done(main, tx, running, next.value as R));
    };
    try {
      const plain = { folder: openHomeFolder(root), settings, registry, db: reader, blobs, committed: async () => undefined } as unknown as HelperEnv;
      for (const family of ["notes", "labels"]) await drive(extractKind, family, plain);
      await drive(renderKind, "days", { folder: openHomeFolder(root), settings, registry, db: counted, blobs } as unknown as HelperEnv);
      const days = readHome(root, (home) => home.prepare("SELECT day, count(*) AS units FROM day_units WHERE family = 'labels' GROUP BY day ORDER BY day").all()) as { day: string; units: number }[];
      artifact(root, "render-run-labels", { cards: CARDS, read, days });
      expect(days.map((row) => row.units)).toEqual(Array(10).fill(1));
      expect(read.contact ?? 0).toBe(0);
      expect(readFileSync(join(root, "days", "2026-09-03.day.txt"), "utf8")).toContain("with Person 2");
    } finally {
      reader.close();
      db.close();
    }
  });
});

describe("a device renamed while its day renders", () => {
  let root: string | undefined;
  afterAll(() => {
    if (root !== undefined) removeRoot(root);
  });

  it("a day's first render that printed a device's old name settles with it, or a day that names a device with no name renders for ever", async () => {
    root = makeRoot("lifestream-render-device-name-", { sources: { [NOTES]: "fake-rows" } });
    const settings = effective(root).settings;
    const registry = fakeRegistry(settings, homeOf(openHomeFolder(root)));
    const db = openHome(openHomeFolder(root), "migrate");
    const reader = openHome(openHomeFolder(root), "read");
    const blobs = openHomeFolder(root).blobs(join(root, "blobs"));
    const MAC = "macbook-pro-0001";
    const NAMELESS = "device-zz99";
    const [named, nameless] = ["2026-09-01", "2026-09-02"] as const;
    db.commit((tx) => {
      if (tx.tables.sources.get(NOTES) === undefined) tx.tables.sources.add({ id: NOTES, vendor: vendorOf(declarations(), NOTES), connector: "fake-rows", added_ms: Date.now() });
      tx.tables.devices.add({ unit: MAC, model: "MacBook Pro", added_ms: Date.now() });
      rebuildExtracts(tx, "notes", Date.now());
      const run = tx.tables.runs.start({ kind: "import", subject: NOTES, started_ms: Date.now() });
      tx.records.land(run, { id: `${NOTES}/notes`, source: NOTES, stated_ms: Date.now() }, ([[named, MAC], [nameless, NAMELESS]] as const).map(([each, on], index) => {
        const at = Date.parse(`${each}T12:00:00Z`);
        return { kind: "note", key: `n${index}`, content: { text: `synthetic note ${index}`, at, on }, time: { start_ms: at, precision: "ms" as const } };
      }), fakeRows.kinds, { has: () => true });
      tx.tables.runs.end(run, { ended_ms: Date.now(), outcome: "ok" });
    });
    const main = { folder: openHomeFolder(root), settings, registry, families: new Map(registry.families.map((family) => [family.name, family])), now: () => Date.now() } as unknown as Main;
    const env = { folder: openHomeFolder(root), settings, registry, db: reader, blobs, committed: async () => undefined } as unknown as HelperEnv;
    const drive = async <D, C, R, S>(kind: Kind<D, C, R, S>, key: string, between: (outcome: C) => void = () => undefined) => {
      const job = { id: 1, kind: kind === renderKind as unknown ? "render" : "extract", key, lane: LANE.backfill, not_before_ms: 0, started_ms: Date.now() } as JobRow;
      const begun = db.commit((tx) => kind.begin!(main, tx, job));
      if (begun === null) return;
      const running: Running<S> = { job, state: begun.state };
      const steps = kind.helper(env, { job: 1, kind: job.kind, key, lane: LANE.backfill, now_ms: Date.now(), data: begun.data });
      let next = await steps.next();
      for (; next.done !== true; next = await steps.next()) {
        for (const slice of kind.chunk?.(main, running, next.value) ?? []) {
          slice.settle?.();
          between(next.value);
          db.commit((tx) => slice.work(tx));
        }
      }
      db.commit((tx) => kind.done(main, tx, running, next.value as R));
    };
    const owed = () => readHome(root!, (home) => home.prepare("SELECT day FROM dirty_days ORDER BY day").pluck().all()) as string[];
    const printed = (each: string) => readFileSync(join(root!, "days", `${each}.day.txt`), "utf8").split("\n").find((line) => line.includes("synthetic note")) ?? "";
    const rename = (name: string) => db.commit((tx) => nameDevice(tx, MAC, name, Date.now()));
    try {
      await drive(extractKind, "notes");
      expect(owed()).toEqual([named, nameless]);

      await drive(renderKind, "days", (outcome) => {
        if ((outcome as { day: string }).day === named) rename("Synthetic Mac");
      });
      const first = { owed: owed(), named: printed(named), nameless: printed(nameless) };
      expect(first).toEqual({ owed: [named], named: expect.stringContaining("on MacBook Pro"), nameless: expect.stringContaining(`on ${NAMELESS}`) });

      await drive(renderKind, "days");
      const second = { owed: owed(), named: printed(named) };
      expect(second).toEqual({ owed: [], named: expect.stringContaining("on Synthetic Mac") });

      rename("Synthetic Desk");
      expect(owed()).toEqual([named]);
      await drive(renderKind, "days");
      const third = { owed: owed(), named: printed(named) };
      expect(third).toEqual({ owed: [], named: expect.stringContaining("on Synthetic Desk") });
      artifact(root, "render-device-name", { first, second, third });
    } finally {
      reader.close();
      db.close();
    }
  });
});
