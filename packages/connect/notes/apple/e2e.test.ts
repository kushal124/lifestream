import { artifact, collect, counts, deliver, expectParity, macBundle, openTestHome, readGolden, temp } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { BlobStore, Delivery, JsonObject } from "@lifestreamprotocol/core";
import { appleNotes, MEDIA_INDEX_FILE, NOTES_FILE } from "./reader.js";
import {
  appendNotes, baseNotes, body, createNoteStore, cursor, editNote, T0, locator, mediaIndex, NOTES_SOURCE, PASTED, PASTED_BYTES, purgeNote, sealDelta,
} from "./test/fixture.js";

const GOLDEN = new URL("./test/parity.golden.json", import.meta.url);
const SNAPSHOT = { snapshot_taken_at: "2026-09-21T00:00:00.000Z" };

function shipped(blobs: BlobStore, path: string, facts: JsonObject = SNAPSHOT): Delivery {
  blobs.put(PASTED_BYTES);
  return deliver(blobs, NOTES_SOURCE, { [NOTES_FILE]: readFileSync(path), [MEDIA_INDEX_FILE]: mediaIndex({ [locator(PASTED)]: PASTED_BYTES }) }, facts);
}

describe("Apple Notes: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected, or an attachment's bytes are not named", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "store.sqlite");
      createNoteStore(path, baseNotes());
      const delivery = shipped(home.blobs, path);
      const rows = await collect(appleNotes.read(delivery, home.blobs));
      const landed = await home.land(appleNotes, delivery, rows);
      expect(landed).toMatchObject({ new: 4, refused: 0, duplicated: 0 });
      const heads = home.heads(NOTES_SOURCE);
      expect(heads.map((head) => [head.key, head.start_ms, head.end_ms])).toEqual([
        ["SYNTH-NOTE-0001", Date.parse("2026-09-20T08:00:00.250Z"), Date.parse("2026-09-20T08:10:00.500Z")],
        ["SYNTH-NOTE-0002", Date.parse("2026-09-20T09:00:00Z"), null],
        ["SYNTH-NOTE-0003", Date.parse("2026-09-19T08:00:00Z"), Date.parse("2026-09-20T07:00:00Z")],
        ["SYNTH-NOTE-0004", Date.parse("2026-09-20T10:00:00Z"), null],
      ]);
      const pasted = home.blobs.put(PASTED_BYTES);
      expect(rows[0]!.blobs).toEqual([pasted]);
      const media = ((heads[0]!.content as JsonObject).attachments as JsonObject[]).map((attachment) => attachment.media);
      expect(media.filter((item) => item !== null).map((item) => (item as JsonObject).hash)).toEqual(
        expect.arrayContaining([pasted.slice("sha256:".length), null]),
      );
      expect((heads[1]!.content as { body: { ZDATA: { $bytes64: string } } }).body.ZDATA.$bytes64).toBe(body("List\nfake item").toString("base64"));
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "store.sqlite");
      createNoteStore(path, baseNotes());
      const rows = await collect(appleNotes.read(shipped(home.blobs, path), home.blobs));
      expect(rows.every((row) => row.device === "macbook-pro-0001" && /^ICNote row \d+$/u.test(row.locator ?? ""))).toBe(true);
      artifact(home.dir, "parity.json", expectParity(rows, GOLDEN));
    } finally {
      home.close();
    }
  });

  it("a smaller snapshot lands a gone", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "store.sqlite");
      createNoteStore(path, baseNotes());
      await home.land(appleNotes, shipped(home.blobs, path));
      purgeNote(path, 102);
      const landed = await home.land(appleNotes, shipped(home.blobs, path, { snapshot_taken_at: "2026-09-22T00:00:00.000Z" }));
      expect(landed).toMatchObject({ restated: 3, gone: 0, new: 0 });
      expect(home.heads(NOTES_SOURCE).filter((head) => head.version === "gone")).toEqual([]);
      artifact(home.dir, "heads.json", home.heads(NOTES_SOURCE));
    } finally {
      home.close();
    }
  });

  it("a changes delivery is read as less than it holds, or an older Mac's delta is not read", async () => {
    const home = openTestHome();
    try {
      const changes = macBundle(home, NOTES_SOURCE, new URL("./test/changes-bundle.zip", import.meta.url));
      expect(changes.facts.kind).toBe("changes");
      const file = join(home.dir, "changes.sqlite");
      writeFileSync(file, home.blobs.bytes(changes.files.find((each) => each.path === NOTES_FILE)!.blob));
      const db = new Database(file, { readonly: true });
      const notes = Number((db.prepare("SELECT count(*) AS n FROM ZICCLOUDSYNCINGOBJECT WHERE Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote')").get() as { n: number }).n);
      db.close();
      const fromChanges = await home.land(appleNotes, changes);
      expect(fromChanges).toMatchObject({ new: notes, refused: 0 });

      const path = join(home.dir, "store.sqlite");
      createNoteStore(path, baseNotes());
      const after = cursor(path);
      editNote(path, 101, "UPDATE ZICCLOUDSYNCINGOBJECT SET ZSNIPPET = 'fake item 2', ZMODIFICATIONDATE1 = ? WHERE Z_PK = 101", T0 + 7200);
      appendNotes(path, [{ pk: 104, identifier: "SYNTH-NOTE-0005", title: "New", created: T0 + 9000, modified: T0 + 9000, body: body("New") }]);
      purgeNote(path, 102);
      const deltaPath = join(home.dir, "delta.sqlite");
      sealDelta(path, deltaPath, after);
      const facts = { snapshot_taken_at: "2026-09-21T03:00:00.000Z", kind: "delta", after, through: cursor(path) };
      const rows = await collect(appleNotes.read(shipped(home.blobs, deltaPath, facts), home.blobs));
      expect(rows.map((row) => row.key)).toEqual(["SYNTH-NOTE-0002", "SYNTH-NOTE-0005"]);
      expect(rows.some((row) => row.gone === true)).toBe(false);
      artifact(home.dir, "changes.json", { changes: counts(fromChanges), delta: rows.map((row) => row.key) });
    } finally {
      home.close();
    }
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "store.sqlite");
      createNoteStore(path, [...baseNotes(), { pk: 110, identifier: "SYNTH-NOTE-0001", title: "Twin", created: T0, modified: T0 }]);
      const landed = await home.land(appleNotes, shipped(home.blobs, path));
      expect(landed).toMatchObject({ new: 4, duplicated: 1 });
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });

  it("a note that states no date is dropped, or placed on a made-up time", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "store.sqlite");
      createNoteStore(path, [{ pk: 120, identifier: "SYNTH-NOTE-UNDATED", title: "Undated", created: null, modified: null, body: body("Undated") }]);
      const landed = await home.land(appleNotes, shipped(home.blobs, path));
      expect(landed).toMatchObject({ new: 1 });
      const [head] = home.heads(NOTES_SOURCE);
      expect([head!.key, head!.start_ms, head!.end_ms]).toEqual(["SYNTH-NOTE-UNDATED", null, null]);
    } finally {
      home.close();
    }
  });

  it("a note with one unset date (0 or NULL) is refused or not timed by the other, or a date that is text lands", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "store.sqlite");
      createNoteStore(path, [
        { pk: 120, identifier: "SYNTH-NOTE-A", title: "A", created: T0, modified: T0, body: body("A") },
        { pk: 121, identifier: "SYNTH-NOTE-ZERO", title: "Zero", created: 0, modified: T0 + 30, body: body("Zero") },
        { pk: 122, identifier: "SYNTH-NOTE-NULL", title: "Null", created: null, modified: T0 + 45, body: body("Null") },
        { pk: 123, identifier: "SYNTH-NOTE-TEXT", title: "Text", created: T0, modified: T0, body: body("Text") },
      ]);
      editNote(path, 123, "UPDATE ZICCLOUDSYNCINGOBJECT SET ZCREATIONDATE3 = 'yesterday' WHERE Z_PK = 123");
      const landed = await home.land(appleNotes, shipped(home.blobs, path));
      expect(landed).toMatchObject({ new: 3, refused: 1 });
      expect(landed.refusals).toEqual([{ kind: "file", key: "ZICCLOUDSYNCINGOBJECT Z_PK 123", violations: ["ICNote row 123 ZCREATIONDATE3 is not a number"] }]);
      const heads = home.heads(NOTES_SOURCE);
      expect(heads.map((head) => [head.key, head.start_ms, head.end_ms])).toEqual([
        ["SYNTH-NOTE-A", Date.parse("2026-09-20T08:00:00Z"), null],
        ["SYNTH-NOTE-NULL", Date.parse("2026-09-20T08:00:45Z"), null],
        ["SYNTH-NOTE-ZERO", Date.parse("2026-09-20T08:00:30Z"), null],
      ]);
      artifact(home.dir, "unset-date.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a store lacking a column this connector reads is read", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "store.sqlite");
      createNoteStore(path, baseNotes());
      const db = new Database(path);
      db.exec("ALTER TABLE ZICCLOUDSYNCINGOBJECT DROP COLUMN ZSNIPPET");
      db.close();
      await expect(collect(appleNotes.read(shipped(home.blobs, path), home.blobs))).rejects.toThrow(/lacks columns this connector reads: ZSNIPPET/u);
    } finally {
      home.close();
    }
  });
});
