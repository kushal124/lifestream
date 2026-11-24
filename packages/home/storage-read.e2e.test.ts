import { join } from "node:path";
import Database from "better-sqlite3";
import { addDays, BLOCKS, civilDay, KEEP_BYTES, openHomeFolder, STORED_MARK } from "@lifestreamprotocol/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAGES } from "./pages.js";
import { mintPrincipal } from "./principals.js";
import { connectors } from "./registry-home.js";
import { effective } from "./settings.js";
import { FREE_BYTES, readDisk, type FreeDay } from "./status.js";
import { doneOf, readStorage, type StorageRead } from "./storage-read.js";
import { ownFiles, ownNow, STORED_AT, STORED_REST } from "./stored.js";
import { artifact, makeRoot, readHome, removeRoot } from "./test/harness-root.js";
import { openDoor } from "./test/harness-door.js";

const REGISTRY = new URL("./test/dashboard-registry.ts", import.meta.url);
const NOW = Date.parse("2026-11-13T12:00:00Z");
const DAY_MS = 86_400_000;
const TOKEN = "synthetic-storage-reader".padEnd(43, "r");
const HOME_UNIT = "macbook-pro-0001";
const PHONE = "iphone-aa01";
const STREAMS = {
  whatsapp: `whatsapp:+15550000009:${PHONE}`, gmail: "gmail:person-a@example.com:cloud", "google-photos": "google-photos:person-a@example.com:export",
  location: `location:local:${PHONE}`, "claude-code": `claude-code:local:${HOME_UNIT}`, coast: `coast:local:${HOME_UNIT}`, screen: `screen:local:${HOME_UNIT}`,
} as const;
const FACES = `faces:local:${HOME_UNIT}`;
const PEOPLE = `people:local:${HOME_UNIT}`;
const REST = 50_000_000;

describe("Storage's read of a counted home", () => {
  let root: string;
  let today: string;
  const rows: [number, string, number, number][] = [
    [9, STREAMS.whatsapp, 1_000, 9_000], [2, STREAMS.whatsapp, 500, 4_500], [1, STREAMS.whatsapp, 0, -1_000],
    [9, STREAMS.gmail, 12_000, 0],
    [8, STREAMS["google-photos"], 2_000, 28_000], [0, STREAMS["google-photos"], 1_000, 19_000],
    [7, STREAMS.location, 8_000, 0],
    [6, STREAMS["claude-code"], 7_000, 0],
    [1, STREAMS.coast, 40_000, 0],
    [3, STREAMS.screen, 6_000, 1_000],
    [4, FACES, 3_000, 2_000],
    [8, PEOPLE, 600, 0],
  ];
  const ownDay = (back: number) => 100_000 + (9 - back) * 10_000;

  const write = (work: (db: Database.Database) => void) => {
    const db = new Database(join(root, "home.db"));
    try {
      db.transaction(() => work(db))();
    } finally {
      db.close();
    }
  };
  const setMeta = (key: string, value: string | null) => write((db) => {
    if (value === null) db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    else db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  });
  const read = (now_ms = NOW): Omit<StorageRead, "position"> =>
    readHome(root, (db) => db.transaction(() => readStorage(db, { root, now_ms, settings: effective(root).settings, connectors: connectors() }))());

  beforeAll(() => {
    root = makeRoot("lifestream-storage-read-", { sources: Object.fromEntries([...Object.values(STREAMS), FACES, PEOPLE].map((id) => [id, "dashboard-rows"])) });
    today = civilDay(NOW, effective(root).settings.day);
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], sources: [], token: TOKEN, now_ms: 0 });
    const disk = readDisk(root, NOW).disk;
    const readings: FreeDay[] = [
      { day: addDays(today, -4), disk: "another-disk 1", at_ms: NOW - 4 * DAY_MS, bytes: 9e12, catch_up: 0 },
      ...[3, 2, 1].map((back) => ({ day: addDays(today, -back), disk, at_ms: NOW - back * DAY_MS, bytes: 1e12 + back * 1e9, catch_up: 0 })),
    ];
    write((db) => {
      for (const [back, source, text, files] of rows) {
        db.prepare("INSERT INTO stored_days (day, source, text, files) VALUES (?, ?, ?, ?)").run(addDays(today, -back), source, text, files);
      }
      for (let back = 9; back >= 1; back--) db.prepare("INSERT INTO own_days (day, bytes) VALUES (?, ?)").run(addDays(today, -back), ownDay(back));
      const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
      meta.run(STORED_REST, JSON.stringify({ bytes: REST, entries: 40, capped: false, at_ms: NOW - DAY_MS }));
      meta.run(FREE_BYTES, JSON.stringify(readings));
    });
  });
  afterAll(() => {
    if (root !== undefined) removeRoot(root);
  });

  it("folds seven streams into five, other and own, each series ending at its part's size, and agrees with status's disk", async () => {
    const { url } = await openDoor(root, { registry: REGISTRY, clock: () => NOW });
    const get = async (path: string) => {
      const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      return JSON.parse(text) as Record<string, any>;
    };
    const storage = await get("/v1/storage") as StorageRead;
    const status = await get("/v1/status");
    artifact(root, "storage-counted", { storage, disk: status.disk });

    expect(storage.counting).toBeNull();
    expect(storage.position).toMatch(/^\d+:\d+$/u);
    expect(storage.home.streams).toEqual([
      { connector: "google-photos", bytes: 50_000, week_bytes: 20_000 },
      { connector: "coast", bytes: 40_000, week_bytes: 40_000 },
      { connector: "whatsapp", bytes: 14_000, week_bytes: 4_000 },
      { connector: "gmail", bytes: 12_000, week_bytes: 0 },
      { connector: "location", bytes: 8_000, week_bytes: 0 },
      { connector: "claude-code", bytes: 7_000, week_bytes: 7_000 },
      { connector: "screen", bytes: 7_000, week_bytes: 7_000 },
    ]);
    const text = rows.reduce((sum, [, , bytes]) => sum + bytes, 0);
    const unstreamed = 5_000 + 600;
    const own = ownNow(ownFiles(root), REST, text) + unstreamed;
    expect(storage.home.own.bytes).toBe(own);
    expect(storage.home.own.week_bytes).toBe(own - (ownDay(7) + 600));
    expect(storage.home.bytes).toBe(138_000 + own);

    const series = storage.series!;
    expect(series.first_day).toBe(addDays(today, -9));
    expect(series.parts.map((part) => part.part)).toEqual(["google-photos", "coast", "whatsapp", "gmail", "location", "other", "own"]);
    for (const part of series.parts) expect(part.bytes).toHaveLength(10);
    const last = Object.fromEntries(series.parts.map((part) => [part.part, part.bytes.at(-1)]));
    expect(last).toEqual({ "google-photos": 50_000, coast: 40_000, whatsapp: 14_000, gmail: 12_000, location: 8_000, other: 14_000, own });
    const at = (part: string, back: number) => series.parts.find((each) => each.part === part)!.bytes[9 - back];
    expect([9, 3, 2, 1].map((back) => at("whatsapp", back))).toEqual([10_000, 10_000, 15_000, 14_000]);
    expect([7, 6, 3].map((back) => at("other", back))).toEqual([0, 7_000, 14_000]);
    expect(at("own", 4)).toBe(ownDay(4) + 600 + 5_000);

    expect(storage.disk).toEqual({ name: null, total_bytes: expect.any(Number), free_bytes: status.disk.free_bytes, keep_bytes: KEEP_BYTES, coming_bytes: status.disk.coming });
    expect(storage.disk.total_bytes).toBeGreaterThan(0);
    expect(storage.growth).toEqual({ readings: 3, bytes_a_day: status.disk.steady_bytes_a_day, days_left: status.disk.days_left });
    expect(storage.growth.bytes_a_day).toBe(1e9);
  });

  it("serves Storage's page through the door: the uses as counted, Counting… while the count maps, counted again once it ends", async () => {
    const { url } = await openDoor(root, { registry: REGISTRY, clock: () => NOW });
    const page = async () => {
      const response = await fetch(`${url}${PAGES.storage.route}`, { headers: { authorization: `Bearer ${TOKEN}`, "lifestream-device": "phone/99.0.0" } });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      return PAGES.storage.shape.parse(JSON.parse(text));
    };
    const plain = (text: string) => text.replace(/\s/gu, " ");
    const counted = await page();
    expect(counted.counted).toBe(true);
    expect(plain(counted.figure)).toMatch(/^[0-9.]+ [KMGT]B$/u);
    expect(plain(counted.disk)).toMatch(/^[0-9.]+ [KMGT]B free of [0-9.]+ [KMGT]B on .+$/u);
    expect(counted.uses.map((use) => [use.id, plain(use.size), use.folded])).toEqual([
      ["google-photos", "50 KB", false], ["coast", "40 KB", false], ["whatsapp", "14 KB", false], ["gmail", "12 KB", false], ["location", "8 KB", false],
      ["claude-code", "7 KB", true], ["screen", "7 KB", true], ["own", expect.any(String), false],
    ]);
    expect(plain(counted.more ?? "")).toBe("Show 2 more connectors");
    expect(counted.chart?.parts.map((part) => part.id)).toEqual(["google-photos", "coast", "whatsapp", "gmail", "location", "other", "own"]);
    artifact(root, "storage-page", counted);

    const complete = readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(STORED_MARK) as string);
    try {
      setMeta(STORED_MARK, JSON.stringify({ M: 40, blocks: 0, after: null, erasures: 0, slab_ms: 0 }));
      const mapping = await page();
      expect([mapping.counted, mapping.figure, mapping.uses, mapping.chart]).toEqual([false, "Counting…", [], null]);
    } finally {
      setMeta(STORED_MARK, complete);
    }
    expect((await page()).counted).toBe(true);
  });

  it("says the count under way: the map before a slab, the time left at the fill's rate, none once it has stopped", () => {
    const filling = (blocks: number, after: string | null, slab_ms: number) => JSON.stringify({ M: 40, blocks, after, erasures: 0, slab_ms });
    const complete = readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(STORED_MARK) as string);
    try {
      setMeta(STORED_MARK, filling(0, null, 0));
      const map = read();
      expect(map.counting).toEqual({ map: true, left_ms: null });
      expect(map.series).toBeNull();
      expect(map.home.streams.map((stream) => stream.week_bytes)).toEqual(Array(7).fill(null));
      expect(map.home.own.week_bytes).toBeNull();
      expect(map.home.streams[0]).toEqual({ connector: "google-photos", bytes: 50_000, week_bytes: null });

      const half = `sha256:7fffffff${"f".repeat(56)}`;
      expect(doneOf(BLOCKS / 2, half)).toBe(0.5);
      setMeta(STORED_MARK, filling(BLOCKS / 2, half, 90_000));
      setMeta(STORED_AT, String(NOW - 1_000));
      const going = read();
      expect(going.counting).toEqual({ map: false, left_ms: 90_000 });
      setMeta(STORED_MARK, filling(BLOCKS / 4, `sha256:3fffffff${"f".repeat(56)}`, 90_000));
      expect(read().counting).toEqual({ map: false, left_ms: 270_000 });

      setMeta(STORED_AT, String(NOW - 120_000));
      expect(read().counting).toEqual({ map: false, left_ms: 270_000 });
      setMeta(STORED_AT, String(NOW - 301_000));
      expect(read().counting).toEqual({ map: false, left_ms: null });
      setMeta(STORED_AT, null);
      expect(read().counting).toEqual({ map: false, left_ms: null });
      artifact(root, "storage-counting", { map, going });
    } finally {
      setMeta(STORED_MARK, complete);
    }
    expect(read().counting).toBeNull();
  });
});
