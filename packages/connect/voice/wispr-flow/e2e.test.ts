import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Delivery, JsonObject, ReaderOutput } from "@lifestreamprotocol/core";
import { artifact, collect, deliver, macBundle, openTestHome, type TestHome } from "../../test/drive.js";
import { DICTATION, HISTORY, WISPR_FILE, wisprFlow } from "./reader.js";
import {
  appendDictations, baseDictations, createFlowStore, cursor, hashOf, OPUS, seal, SHOT, SNAPSHOT, T, WAV, WISPR_SOURCE, type Dictation,
} from "./test/fixture.js";

function shipped(home: TestHome, path: string, facts: JsonObject = SNAPSHOT): Delivery {
  return deliver(home, WISPR_SOURCE, { [WISPR_FILE]: readFileSync(path) }, facts);
}

async function read(home: TestHome, delivery: Delivery): Promise<ReaderOutput[]> {
  const rows = await collect(wisprFlow.read(delivery, home.blobs));
  for (const row of rows) for (const bytes of row.bytes ?? []) home.blobs.put(Buffer.from(bytes));
  return rows;
}

function store(home: TestHome, dictations: Dictation[] = baseDictations()): string {
  const path = join(home.dir, "flow.sqlite");
  createFlowStore(path, dictations);
  return path;
}

function sealed(home: TestHome, path: string, after?: number): string {
  const out = join(home.dir, `sealed-${after ?? "snapshot"}-${Math.random().toString(36).slice(2)}.sqlite`);
  seal(path, out, after);
  return out;
}

describe("Wispr Flow: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected, or a dictation loses a text form, its audio or its screenshot", async () => {
    const home = openTestHome();
    try {
      const path = store(home);
      const delivery = shipped(home, sealed(home, path));
      const rows = await read(home, delivery);
      const landed = await home.land(wisprFlow, delivery, rows);
      expect(landed).toMatchObject({ new: 3, refused: 0, duplicated: 0 });
      const heads = home.heads(WISPR_SOURCE);
      expect(heads.map((head) => [head.kind, head.key, head.start_ms, head.time?.offset_min ?? null])).toEqual([
        [DICTATION, "00000000-0000-4000-8000-000000000001", Date.parse(`${T}T08:00:00.250Z`), 330],
        [DICTATION, "00000000-0000-4000-8000-000000000002", Date.parse(`${T}T09:00:00Z`), -420],
        [DICTATION, "00000000-0000-4000-8000-000000000003", Date.parse(`${T}T10:00:00.500Z`), null],
      ]);
      const [first, second, third] = heads.map((head) => (head.content as JsonObject)[HISTORY] as JsonObject);
      expect([first!.asrText, first!.formattedText, first!.editedText, first!.pastedText]).toEqual(
        ["um synthetic dictation one", "Synthetic dictation one.", null, "Synthetic dictation one."],
      );
      expect([second!.formattedText, second!.editedText, second!.app, second!.url]).toEqual(
        ["Synthetic two.", "Synthetic two, edited.", "com.example.browser", "https://example.com/compose"],
      );
      expect([third!.asrText, third!.formattedText, third!.status]).toEqual([null, null, "dismissed"]);
      const db = new Database(path, { readonly: true });
      const declared = (db.prepare("SELECT name FROM pragma_table_info('History')").all() as { name: string }[]).map((column) => column.name);
      db.close();
      expect(Object.keys(first!).sort()).toEqual(declared.sort());
      expect(first!.timestamp).toBe(`${T} 08:00:00.250 +00:00`);
      expect(first!.audio).toEqual({ hash: hashOf(WAV), bytes: WAV.length });
      expect(first!.opusChunks).toEqual({ hash: hashOf(OPUS), bytes: Buffer.byteLength(OPUS) });
      expect(second!.screenshot).toEqual({ hash: hashOf(SHOT), bytes: SHOT.length });
      expect(rows.map((row) => row.blobs ?? [])).toEqual([[hashOf(WAV), hashOf(OPUS)], [hashOf(SHOT)], []]);
      for (const blob of rows.flatMap((row) => row.blobs ?? [])) expect(home.blobs.has(blob)).toBe(true);
      expect(home.blobs.bytes(hashOf(WAV)).equals(WAV)).toBe(true);
      expect(rows.every((row) => row.device === "macbook-pro-0001" && /^History row \d+$/u.test(row.locator ?? ""))).toBe(true);
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a meeting, a note or any other table's row becomes a record", async () => {
    const home = openTestHome();
    try {
      const rows = await read(home, shipped(home, store(home)));
      expect(rows.map((row) => row.key)).toEqual(baseDictations().map((dictation) => dictation.id));
    } finally {
      home.close();
    }
  });

  it("the same delivery again writes something new", async () => {
    const home = openTestHome();
    try {
      const path = sealed(home, store(home));
      await home.land(wisprFlow, shipped(home, path));
      const again = await home.land(wisprFlow, shipped(home, path, { ...SNAPSHOT, snapshot_taken_at: "2026-09-22T04:00:00.000Z" }));
      expect(again).toMatchObject({ new: 0, changed: 0, restated: 3, gone: 0 });
    } finally {
      home.close();
    }
  });

  it("a delivery holding fewer dictations lands a gone, or a changes delivery is read as less than it holds", async () => {
    const home = openTestHome();
    try {
      const path = store(home);
      await home.land(wisprFlow, shipped(home, sealed(home, path)));
      const after = cursor(path);
      appendDictations(path, [{ id: "00000000-0000-4000-8000-000000000004", asr: "synthetic four", formatted: "Synthetic four.", timestamp: `${T} 11:00:00.000 +00:00`, west: -330 }]);
      const db = new Database(path);
      db.exec("UPDATE History SET editedText = 'Synthetic dictation one, edited.' WHERE transcriptEntityId = '00000000-0000-4000-8000-000000000001'");
      db.exec("DELETE FROM History WHERE transcriptEntityId = '00000000-0000-4000-8000-000000000003'");
      db.close();
      const facts = { snapshot_taken_at: "2026-09-21T11:05:00.000Z", kind: "delta", after, through: cursor(path) };
      const delta = shipped(home, sealed(home, path, after), facts);
      const rows = await read(home, delta);
      expect(rows.map((row) => row.key)).toEqual(["00000000-0000-4000-8000-000000000004"]);
      expect(await home.land(wisprFlow, delta, rows)).toMatchObject({ new: 1, changed: 0, gone: 0 });

      const nightly = await home.land(wisprFlow, shipped(home, sealed(home, path), { ...SNAPSHOT, snapshot_taken_at: "2026-09-22T04:00:00.000Z" }));
      expect(nightly).toMatchObject({ changed: 1, restated: 2, gone: 0, new: 0 });
      expect(nightly.changedPaths).toEqual({ [`${HISTORY}.editedText`]: 1 });
      const heads = home.heads(WISPR_SOURCE);
      expect(heads.filter((head) => head.gone)).toEqual([]);
      expect(heads.map((head) => head.key)).toContain("00000000-0000-4000-8000-000000000003");

      const changes = macBundle(home, WISPR_SOURCE, new URL("./test/changes-bundle.zip", import.meta.url));
      expect(changes.facts.kind).toBe("changes");
      const file = join(home.dir, "changes.sqlite");
      writeFileSync(file, home.blobs.bytes(changes.files.find((each) => each.path === WISPR_FILE)!.blob));
      const db2 = new Database(file, { readonly: true });
      const held = Number((db2.prepare("SELECT count(*) AS n FROM History").get() as { n: number }).n);
      db2.close();
      expect((await read(home, changes)).length).toBe(held);
      artifact(home.dir, "heads.json", heads);
    } finally {
      home.close();
    }
  });

  it("a malformed file is read, or its refusal does not name it", async () => {
    const home = openTestHome();
    try {
      await expect(read(home, deliver(home, WISPR_SOURCE, { [WISPR_FILE]: Buffer.from("not a database") }, SNAPSHOT))).rejects.toThrow(/does not open as a SQLite database/u);
      await expect(read(home, deliver(home, WISPR_SOURCE, { "other.sqlite": Buffer.from("x") }, SNAPSHOT))).rejects.toThrow(/carries no flow\.sqlite/u);
      const path = join(home.dir, "bare.sqlite");
      const bare = new Database(path);
      bare.exec("CREATE TABLE Notes (id TEXT PRIMARY KEY)");
      bare.close();
      await expect(read(home, shipped(home, path))).rejects.toThrow(/has no History table/u);
      const lacking = store(home);
      const db = new Database(lacking);
      db.exec("DROP INDEX idx_timestamp_archived; ALTER TABLE History DROP COLUMN timestamp");
      db.close();
      await expect(read(home, shipped(home, lacking))).rejects.toThrow(/lacks columns this connector reads: timestamp/u);
    } finally {
      home.close();
    }
  });

  it("the row Wispr holds with an empty id is refused, keyed anything but its one key, loses its words, or takes a second record when it changes", async () => {
    const home = openTestHome();
    try {
      const path = store(home, [
        ...baseDictations(),
        { id: "", asr: "...", formatted: "...", edited: "Synthetic words the paste kept.", pasted: "Synthetic words pasted.", timestamp: null, status: "extension_paste", app: null, url: "" },
      ]);
      const delivery = shipped(home, sealed(home, path));
      const blank = (await read(home, delivery)).find((row) => row.key === "no-transcript-id");
      expect(blank?.time).toBeUndefined();
      expect(blank?.content).toMatchObject({ [HISTORY]: { transcriptEntityId: "", editedText: "Synthetic words the paste kept.", pastedText: "Synthetic words pasted.", status: "extension_paste" } });
      expect(await home.land(wisprFlow, delivery)).toMatchObject({ new: baseDictations().length + 1, refused: 0 });

      const db = new Database(path);
      db.exec("UPDATE History SET editedText = 'Synthetic words edited later.' WHERE transcriptEntityId = ''");
      db.close();
      expect(await home.land(wisprFlow, shipped(home, sealed(home, path)))).toMatchObject({ new: 0, changed: 1, refused: 0 });
      const heads = home.heads(WISPR_SOURCE);
      expect(heads.filter((head) => head.key === "no-transcript-id")).toHaveLength(1);
      expect(heads).toHaveLength(baseDictations().length + 1);
      artifact(home.dir, "heads.json", heads);
    } finally {
      home.close();
    }
  });

  it("a row whose id is not text, or a time in another spelling, refuses more than itself or lands", async () => {
    const home = openTestHome();
    try {
      const path = store(home, [
        ...baseDictations(),
        { id: "00000000-0000-4000-8000-000000000004", asr: "b", formatted: "B.", timestamp: `${T} 12:00:00.000 +00:00` },
        { id: "00000000-0000-4000-8000-000000000005", asr: "x", formatted: "X.", timestamp: "2026-09-20T12:00:00Z" },
        { id: "00000000-0000-4000-8000-000000000006", asr: "y", formatted: "Y.", timestamp: `${T} 12:00:00.000 +00:00`, west: 100_000 },
      ]);
      const db = new Database(path);
      db.prepare("UPDATE History SET transcriptEntityId = ? WHERE transcriptEntityId = ?").run(Buffer.from("not text"), "00000000-0000-4000-8000-000000000004");
      db.close();
      const landed = await home.land(wisprFlow, shipped(home, sealed(home, path)));
      expect(landed).toMatchObject({ new: 3, refused: 3 });
      expect(landed.refusals.map((refusal) => [refusal.key, refusal.violations.join("; ")])).toEqual([
        ["", "the key is empty"],
        ["00000000-0000-4000-8000-000000000005", expect.stringMatching(/is not Sequelize's/u)],
        ["00000000-0000-4000-8000-000000000006", expect.stringMatching(/timezoneOffsetMinutes 100000/u)],
      ]);
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });

  it("a dictation that states no time is dropped, or placed on a made-up time", async () => {
    const home = openTestHome();
    try {
      const path = store(home, [{ id: "00000000-0000-4000-8000-000000000007", asr: "z", formatted: "Z.", timestamp: null, status: "processing" }]);
      expect(await home.land(wisprFlow, shipped(home, sealed(home, path)))).toMatchObject({ new: 1 });
      const [head] = home.heads(WISPR_SOURCE);
      expect([head!.key, head!.start_ms, head!.end_ms]).toEqual(["00000000-0000-4000-8000-000000000007", null, null]);
    } finally {
      home.close();
    }
  });
});
