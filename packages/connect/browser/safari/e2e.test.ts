import { artifact, collect, deliver, macBundle, openTestHome, type TestHome } from "../../test/drive.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Delivery, JsonObject, Landed } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { HISTORY_FILE, PAGE_VISIT, safariHistory, TAB, TABS_FILE, TOMBSTONE } from "./reader.js";
import { appendHistory, baseHistory, BEGINNING, createHistory, createTabs, SAFARI_SOURCE, sealDelta, T0, type History } from "./test/fixture.js";

const NIGHT = "2026-09-21T04:00:00.000Z";
const at = (text: string): number => Date.parse(text);
const visit = (id: number, time = baseHistory().visits.find((stated) => stated.id === id)!.at): string => `${id}:${time}`;

async function land(home: TestHome, delivery: Delivery): Promise<Landed> {
  const view = home.db.view();
  let rows;
  try {
    rows = await collect(safariHistory.read(delivery, home.blobs, view));
  } finally {
    view.close();
  }
  return home.land(safariHistory, delivery, rows);
}

function files(home: TestHome, name: string, history: History = baseHistory(), tabs = true): Record<string, Buffer> {
  const historyPath = join(home.dir, `${name}-history.sqlite`);
  createHistory(historyPath, history);
  const out: Record<string, Buffer> = { [HISTORY_FILE]: readFileSync(historyPath) };
  if (tabs) {
    const tabsPath = join(home.dir, `${name}-tabs.sqlite`);
    createTabs(tabsPath);
    out[TABS_FILE] = readFileSync(tabsPath);
  }
  return out;
}

const snapshot = (taken: string, through = 4): JsonObject => ({ snapshot_taken_at: taken, kind: "snapshot", through });

describe("Safari: each of these is impossible", () => {
  it("a synthetic snapshot lands other heads than expected", async () => {
    const home = openTestHome();
    try {
      const landed = await land(home, deliver(home, SAFARI_SOURCE, files(home, "first"), snapshot(NIGHT)));
      expect(landed).toMatchObject({ new: 6, refused: 0, duplicated: 0, gone: 0 });
      const heads = home.heads(SAFARI_SOURCE);
      expect(heads.map((head) => [head.kind, head.key, head.start_ms, head.end_ms])).toEqual([
        [PAGE_VISIT, visit(1), at("2026-09-20T08:00:00.250Z"), null],
        [PAGE_VISIT, visit(2), at("2026-09-20T08:01:00.500Z"), null],
        [PAGE_VISIT, visit(3), at("2026-09-20T08:02:00Z"), null],
        [PAGE_VISIT, visit(4), at("2026-09-20T08:03:00.125Z"), null],
        [TAB, "SYNTH-TAB-0001", at("2026-09-20T08:01:40Z"), null],
        [TAB, "SYNTH-TAB-0002", null, null],
      ]);
      const synced = heads.find((head) => head.kind === PAGE_VISIT && head.key === visit(2))!.content as { visit: Record<string, unknown>; item: unknown };
      expect(synced.visit).toMatchObject({ id: 2, history_item: 2, visit_time: T0 + 60.5, title: "Page B", origin: 1 });
      expect(synced.item).toEqual({ id: 2, url: "https://example.com/b", domain_expansion: "example" });
      const tab = heads.find((head) => head.key === "SYNTH-TAB-0001")!.content as { tab: Record<string, unknown>; device: Record<string, unknown>; close_requests: unknown[] };
      expect(tab.tab).toMatchObject({ url: "https://example.com/one", system_fields: { $bytes64: "Ag==" }, last_viewed_time: T0 + 100 });
      expect(tab.device).toMatchObject({ device_uuid: "SYNTH-DEVICE-0001", device_name: "Synthetic Phone" });
      expect(tab.close_requests).toEqual([{ close_request_uuid: "SYNTH-CLOSE-0001", system_fields: { $bytes64: "BA==" }, destination_device_uuid: "SYNTH-DEVICE-0001", url: "https://example.com/one", tab_uuid: "SYNTH-TAB-0001" }]);
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a visit whose time is unset (0 or NULL) is refused or placed on a made-up time", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "unset-history.sqlite");
      createHistory(path, baseHistory());
      const db = new Database(path);
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'history_visits'").get() as { sql: string };
      db.exec(`ALTER TABLE history_visits RENAME TO stated; ${sql.replace("visit_time REAL NOT NULL", "visit_time REAL")};
        INSERT INTO history_visits SELECT * FROM stated; DROP TABLE stated;
        UPDATE history_visits SET visit_time = NULL WHERE id = 2; UPDATE history_visits SET visit_time = 0 WHERE id = 3`);
      db.close();
      const landed = await land(home, deliver(home, SAFARI_SOURCE, { [HISTORY_FILE]: readFileSync(path) }, snapshot(NIGHT)));
      expect(landed).toMatchObject({ new: 4, refused: 0 });
      const heads = home.heads(SAFARI_SOURCE, [PAGE_VISIT]);
      expect(heads.map((head) => [head.key, head.start_ms])).toEqual([
        [visit(1), at("2026-09-20T08:00:00.250Z")],
        ["2:null", null],
        ["3:0", null],
        [visit(4), at("2026-09-20T08:03:00.125Z")],
      ]);
      artifact(home.dir, "unset.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the same snapshot again writes a new version", async () => {
    const home = openTestHome();
    try {
      const bytes = files(home, "first");
      await land(home, deliver(home, SAFARI_SOURCE, bytes, snapshot(NIGHT)));
      const again = await land(home, deliver(home, SAFARI_SOURCE, bytes, snapshot("2026-09-22T04:00:00.000Z")));
      expect(again).toMatchObject({ new: 0, restated: 6, changed: 0, gone: 0 });
      artifact(home.dir, "again.json", again);
    } finally {
      home.close();
    }
  });

  it("a visit merely missing lands a gone, a stated deletion leaves its visit live, an encrypted tombstone deletes a visit, or a tombstone deletes one Safari still holds", async () => {
    const home = openTestHome();
    try {
      await land(home, deliver(home, SAFARI_SOURCE, files(home, "first"), snapshot(NIGHT)));
      const later = baseHistory();
      later.visits = later.visits.filter((visit) => visit.id === 1 || visit.id === 4);
      later.items = later.items.filter((item) => item.id !== 2);
      later.tombstones = [
        { id: 1, start: BEGINNING, end: T0 + 3600, url: "https://example.com/b" },
        { id: 2, start: T0 + 170, end: T0 + 190, url: null },
        { id: 3, start: BEGINNING, end: T0 + 3600, url: Buffer.from("synthetic encrypted url bytes") },
      ];
      const landed = await land(home, deliver(home, SAFARI_SOURCE, files(home, "later", later), snapshot("2026-09-22T04:00:00.000Z")));
      expect(landed).toMatchObject({ new: 3, gone: 1, refused: 0 });
      const heads = home.heads(SAFARI_SOURCE, [PAGE_VISIT]);
      expect(heads.map((head) => [head.key, head.gone])).toEqual([[visit(1), false], [visit(2), true], [visit(3), false], [visit(4), false]]);
      const again = await land(home, deliver(home, SAFARI_SOURCE, files(home, "again", later), snapshot("2026-09-23T04:00:00.000Z")));
      expect(again).toMatchObject({ new: 0, gone: 0, changed: 0 });
      artifact(home.dir, "heads.json", { landed, again, heads });
    } finally {
      home.close();
    }
  });

  it("a tombstone lands as no record, or with a time other than its span, or a first read's own tombstone deletes a visit it still holds", async () => {
    const home = openTestHome();
    try {
      const history = baseHistory();
      history.tombstones = [
        { id: 1, start: T0 + 30, end: T0 + 90, url: "https://example.com/b" },
        { id: 2, start: BEGINNING, end: T0 + 3600, url: null },
        { id: 3, start: T0 + 100, end: T0 + 130, url: Buffer.from("synthetic encrypted url bytes") },
      ];
      const landed = await land(home, deliver(home, SAFARI_SOURCE, files(home, "first", history, false), snapshot(NIGHT)));
      expect(landed).toMatchObject({ new: 7, gone: 0, refused: 0 });
      const tombstones = home.heads(SAFARI_SOURCE, [TOMBSTONE]);
      expect(tombstones.map((head) => [head.key, head.start_ms, head.end_ms, (head.content as { tombstone: JsonObject }).tombstone.url])).toEqual([
        [`1:${T0 + 30}`, at("2026-09-20T08:00:30Z"), at("2026-09-20T08:01:30Z"), "https://example.com/b"],
        [`2:${BEGINNING}`, null, null, null],
        [`3:${T0 + 100}`, at("2026-09-20T08:01:40Z"), at("2026-09-20T08:02:10Z"), { $bytes64: Buffer.from("synthetic encrypted url bytes").toString("base64") }],
      ]);
      expect(tombstones[0]!.content).toEqual({
        type: "safari.tombstone",
        tombstone: { id: 1, start_time: T0 + 30, end_time: T0 + 90, url: "https://example.com/b", generation: 2, udid: "SYNTH-DEVICE-0001", attributes: 0 },
      });
      expect(home.heads(SAFARI_SOURCE, [PAGE_VISIT]).map((head) => [head.key, head.gone])).toEqual([[visit(1), false], [visit(2), false], [visit(3), false], [visit(4), false]]);
      artifact(home.dir, "tombstones.json", { landed, tombstones });
    } finally {
      home.close();
    }
  });

  it("an older delivery read again brings back a visit a later delivery's tombstone removed, or an encrypted tombstone removes one, or its own tombstone a later delivery restated removes a visit it holds", async () => {
    const home = openTestHome();
    try {
      const own = { id: 9, start: T0 + 170, end: T0 + 190, url: null };
      const unread = join(home.dir, "a-history.sqlite");
      createHistory(unread, { ...baseHistory(), tombstones: [own] });
      const db = new Database(unread);
      db.exec("UPDATE history_visits SET visit_time = 'synthetic text' WHERE id IN (2, 3)");
      db.close();
      const a = deliver(home, SAFARI_SOURCE, { [HISTORY_FILE]: readFileSync(unread) }, snapshot(NIGHT));
      expect(await land(home, a)).toMatchObject({ new: 3, refused: 2 });
      const later = baseHistory();
      later.visits = later.visits.filter((visit) => visit.id === 1 || visit.id === 4);
      later.tombstones = [
        { id: 1, start: BEGINNING, end: T0 + 3600, url: "https://example.com/b" },
        { id: 2, start: BEGINNING, end: T0 + 3600, url: Buffer.from("synthetic encrypted url bytes") },
        own,
      ];
      const b = await land(home, deliver(home, SAFARI_SOURCE, files(home, "b", later, false), snapshot("2026-09-22T04:00:00.000Z")));
      expect(b).toMatchObject({ new: 2, restated: 3, gone: 0, refused: 0 });
      const again = { ...deliver(home, SAFARI_SOURCE, files(home, "a-again", { ...baseHistory(), tombstones: [own] }, false), snapshot(NIGHT)), id: a.id, reread: true } as Delivery;
      const view = home.db.view();
      const rows = await collect(safariHistory.read(again, home.blobs, view)).finally(() => view.close());
      expect(rows.filter((row) => row.gone === true).map((row) => row.key)).toEqual([visit(2)]);
      const reread = await home.land(safariHistory, again, rows);
      expect(reread).toMatchObject({ new: 1, gone: 1, refused: 0 });
      const heads = home.heads(SAFARI_SOURCE, [PAGE_VISIT]);
      expect(heads.map((head) => [head.key, head.gone])).toEqual([[visit(1), false], [visit(2), true], [visit(3), false], [visit(4), false]]);
      artifact(home.dir, "reread.json", { b, reread, rows: rows.map((row) => [row.kind, row.key, row.gone === true]), heads, tombstones: home.heads(SAFARI_SOURCE, [TOMBSTONE]) });
    } finally {
      home.close();
    }
  });

  it("a visit after a clear of history takes the key of the old visit its id once named", async () => {
    const home = openTestHome();
    try {
      await land(home, deliver(home, SAFARI_SOURCE, files(home, "first"), snapshot(NIGHT)));
      const before = home.heads(SAFARI_SOURCE, [PAGE_VISIT]);
      const cleared: History = { items: [{ id: 1, url: "https://example.com/a" }], visits: [{ id: 1, item: 1, at: T0 + 172_800.5 }, { id: 2, item: 1, at: T0 + 172_860 }] };
      const landed = await land(home, deliver(home, SAFARI_SOURCE, files(home, "cleared", cleared), snapshot("2026-09-23T04:00:00.000Z", 2)));
      expect(landed).toMatchObject({ new: 2, gone: 0, refused: 0 });
      const after = home.heads(SAFARI_SOURCE, [PAGE_VISIT]);
      expect(after.map((head) => head.key)).toEqual([...before.map((head) => head.key), visit(1, T0 + 172_800.5), visit(2, T0 + 172_860)].sort());
      for (const head of before) expect(after.find((now) => now.key === head.key)).toMatchObject({ version: head.version, gone: false });
      artifact(home.dir, "cleared.json", { landed, after });
    } finally {
      home.close();
    }
  });

  it("an older Mac's delta states a visit at or below its cursor, or its tabs go missing", async () => {
    const home = openTestHome();
    try {
      const live = join(home.dir, "live.sqlite");
      createHistory(live, baseHistory());
      const tabs = join(home.dir, "tabs.sqlite");
      createTabs(tabs);
      await land(home, deliver(home, SAFARI_SOURCE, { [HISTORY_FILE]: readFileSync(live), [TABS_FILE]: readFileSync(tabs) }, snapshot(NIGHT)));
      const before = home.heads(SAFARI_SOURCE);
      appendHistory(live, { items: [{ id: 1, url: "https://example.com/a", visitCount: 3 }], visits: [{ id: 5, item: 1, at: T0 + 600, title: "Page A" }] });
      const delta = join(home.dir, "delta.sqlite");
      sealDelta(live, delta, 4);
      const facts = { snapshot_taken_at: "2026-09-21T04:05:00.000Z", kind: "delta", after: 4, through: 5 };
      const landed = await land(home, deliver(home, SAFARI_SOURCE, { [HISTORY_FILE]: readFileSync(delta), [TABS_FILE]: readFileSync(tabs) }, facts));
      expect(landed).toMatchObject({ new: 1, restated: 2, changed: 0, gone: 0 });
      const after = home.heads(SAFARI_SOURCE);
      for (const head of before) expect(after.find((now) => now.kind === head.kind && now.key === head.key)!.version).toBe(head.version);
      expect(after.find((head) => head.key === visit(5, T0 + 600))!.start_ms).toBe(at("2026-09-20T08:10:00Z"));
      artifact(home.dir, "delta.json", { landed, after });
    } finally {
      home.close();
    }
  });

  it("a delivery Safari did not write is read, or a tombstone is applied without the home's records", async () => {
    const home = openTestHome();
    try {
      const read = (bytes: Record<string, Buffer>, facts = snapshot(NIGHT)) =>
        collect(safariHistory.read(deliver(home, SAFARI_SOURCE, bytes, facts), home.blobs));
      const unopened = await read({ [HISTORY_FILE]: Buffer.from("synthetic bytes, no database"), [TABS_FILE]: files(home, "tabs")[TABS_FILE]! });
      expect(unopened.filter((row) => row.refused !== undefined).map((row) => [row.key, row.refused])).toEqual([[HISTORY_FILE, expect.stringMatching(/^history\.sqlite does not open as a SQLite database/u)]]);
      expect(unopened.filter((row) => row.kind === TAB).length).toBe(2);
      expect(await read({ "other.sqlite": files(home, "other")[HISTORY_FILE]! })).toEqual([]);
      const drifted = join(home.dir, "drifted.sqlite");
      createHistory(drifted, baseHistory());
      const db = new Database(drifted);
      db.exec("DROP TABLE history_tombstones");
      db.close();
      const lacking = await read({ [HISTORY_FILE]: readFileSync(drifted), [TABS_FILE]: files(home, "lacking")[TABS_FILE]! });
      expect(lacking.filter((row) => row.refused !== undefined).map((row) => [row.key, row.refused])).toEqual([[HISTORY_FILE, expect.stringMatching(/no history_tombstones table/u)]]);
      expect(lacking.filter((row) => row.kind === TAB).length).toBe(2);
      const deleted = baseHistory();
      deleted.tombstones = [{ id: 1, start: BEGINNING, end: T0, url: null }];
      const unviewed = await read(files(home, "deleted", deleted));
      expect(unviewed.filter((row) => row.refused !== undefined).map((row) => [row.key, row.refused])).toEqual([[HISTORY_FILE, expect.stringMatching(/^a tombstone names visits by URL and time/u)]]);
      const alone = await read(files(home, "alone", baseHistory(), false));
      expect(alone.map((row) => row.kind)).toEqual([PAGE_VISIT, PAGE_VISIT, PAGE_VISIT, PAGE_VISIT]);
    } finally {
      home.close();
    }
  });

  it("a changes delivery is read as less than it holds", async () => {
    const home = openTestHome();
    try {
      const changes = macBundle(home, SAFARI_SOURCE, new URL("./test/changes-bundle.zip", import.meta.url));
      expect(changes.facts.kind).toBe("changes");
      const held = (member: string, table: string): number => {
        const file = join(home.dir, member);
        writeFileSync(file, home.blobs.bytes(changes.files.find((each) => each.path === member)!.blob));
        const db = new Database(file, { readonly: true });
        try {
          return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
        } finally {
          db.close();
        }
      };
      const expected = { [PAGE_VISIT]: held(HISTORY_FILE, "history_visits"), [TAB]: held(TABS_FILE, "cloud_tabs") };
      const rows = await collect(safariHistory.read(changes, home.blobs));
      const stated = Object.fromEntries(Object.keys(expected).map((kind) => [kind, rows.filter((row) => row.kind === kind).length]));
      expect(stated).toEqual(expected);
      expect(await home.land(safariHistory, changes, rows)).toMatchObject({ refused: 0 });
      artifact(home.dir, "changes.json", stated);
    } finally {
      home.close();
    }
  });
});
