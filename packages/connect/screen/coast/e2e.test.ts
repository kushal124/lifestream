import { artifact, collect, counts, deliver, expectParity, openTestHome, readGolden } from "../../test/drive.js";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { BlobStore, Delivery, JsonObject } from "@lifestreamprotocol/core";
import { coast, COAST_AX, COAST_FRAME, COAST_SESSION } from "./reader.js";
import { COAST_FILE, CoastShapeUnknown } from "./shape.js";
import { axNode, BASE, COAST_SOURCE, FakeCoast, parityStore, VIDEOS } from "./test/fixture.js";

const GOLDEN = new URL("./test/coast.golden.json", import.meta.url);
const SNAPSHOT = { snapshot_taken_at: "2026-09-21T14:00:00.000Z" };

function snapshot(blobs: BlobStore, path: string, facts: JsonObject = SNAPSHOT, videos = true): Delivery {
  const files: Record<string, Buffer> = { [COAST_FILE]: readFileSync(path) };
  if (videos) for (const [name, bytes] of Object.entries(VIDEOS)) files[`videos/${name}`] = bytes;
  return deliver(blobs, COAST_SOURCE, files, facts);
}

describe("Coast connector: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected, or a frame loses its video", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "rem.db");
      parityStore(path, "id").close();
      const delivery = snapshot(home.blobs, path);
      const rows = await collect(coast.read(delivery, home.blobs));
      const landed = await home.land(coast, delivery, rows);
      expect(landed).toMatchObject({ new: 16, refused: 0, duplicated: 0 });
      const heads = home.heads(COAST_SOURCE);
      expect(heads.filter((head) => head.kind === COAST_FRAME)).toHaveLength(10);
      expect(heads.filter((head) => head.kind === COAST_SESSION).map((head) => [head.key, head.start_ms, head.end_ms])).toEqual([
        [String(BASE), BASE, BASE + 6_000],
        [String(BASE + 3_000), BASE + 3_000, BASE + 4_000],
        [String(BASE + 8_000), BASE + 8_000, BASE + 9_000],
      ]);
      expect(heads.filter((head) => head.kind === COAST_AX).map((head) => head.key)).toEqual([`${BASE + 1_000}:1`, String(BASE + 3_000), String(BASE + 6_000)]);
      const byKey = new Map(rows.filter((row) => row.kind === COAST_FRAME).map((row) => [row.key, row]));
      const videoBlob = delivery.files.find((file) => file.path === `videos/${"b".repeat(64)}`)!.blob;
      expect(byKey.get(String(BASE + 6_000))!.blobs).toEqual([videoBlob]);
      expect(byKey.get(String(BASE + 2_000))!.blobs).toBeUndefined();
      artifact(home.dir, "heads.json", { landed, heads: heads.map(({ content: _content, ...head }) => head) });
    } finally {
      home.close();
    }
  });

  it("the parity golden differs, in either schema shape", async () => {
    const home = openTestHome();
    try {
      const parity: Record<string, unknown> = {};
      for (const shape of ["hash", "id"] as const) {
        const path = join(home.dir, `${shape}.db`);
        parityStore(path, shape).close();
        const delivery = snapshot(home.blobs, path);
        const rows = await collect(coast.read(delivery, home.blobs));
        expect(rows.every((row) => row.device === "macbook-pro-0001" && (row.locator ?? "") !== "")).toBe(true);
        parity[shape] = expectParity(rows, GOLDEN);
      }
      artifact(home.dir, "parity.json", parity);
    } finally {
      home.close();
    }
  });

  it("an unknown Coast schema shape is read anyway", async () => {
    const home = openTestHome();
    try {
      const shapes: string[] = [];
      for (const change of [
        "ALTER TABLE ax_snapshot RENAME COLUMN root_id TO root_ref",
        "ALTER TABLE frame DROP COLUMN capture_display_x",
        "DROP TABLE ax_node_hash",
      ]) {
        const path = join(home.dir, `changed-${shapes.length}.db`);
        parityStore(path, "id").close();
        const db = new Database(path);
        db.exec(change);
        db.close();
        let refusal: unknown;
        const rows: unknown[] = [];
        try {
          for await (const row of coast.read(snapshot(home.blobs, path), home.blobs)) rows.push(row);
        } catch (error) {
          refusal = error;
        }
        expect(rows).toEqual([]);
        expect(refusal).toBeInstanceOf(CoastShapeUnknown);
        expect((refusal as CoastShapeUnknown).message).toMatch(/^Coast's schema is a shape this connector does not read: /u);
        shapes.push((refusal as CoastShapeUnknown).shape);
      }
      expect(shapes[0]).toMatch(/ax_snapshot root root_ref/u);
      expect(shapes[1]).toMatch(/missing frame\.capture_display_x/u);
      expect(shapes[2]).toMatch(/ax_node_hash\(\)/u);
      artifact(home.dir, "shapes.json", shapes);
    } finally {
      home.close();
    }
  });

  it("a frame whose video a later delivery carries never links it", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "rem.db");
      parityStore(path, "hash").close();
      await home.land(coast, snapshot(home.blobs, path, SNAPSHOT, false));
      const later = snapshot(home.blobs, path, { snapshot_taken_at: "2026-09-21T15:00:00.000Z" });
      const landed = await home.land(coast, later);
      expect(landed).toMatchObject({ new: 0, changed: 0, restated: 16 });
      const videoBlob = later.files.find((file) => file.path === `videos/${"b".repeat(64)}`)!.blob;
      const frame = home.heads(COAST_SOURCE, [COAST_FRAME]).find((head) => head.key === String(BASE + 6_000))!;
      const view = home.db.view();
      try {
        expect(view.blobsOf(frame.version)).toEqual([videoBlob]);
        expect(view.rereads(0, 100).map((reread) => "record" in reread && reread.record.key)).toContain(String(BASE + 6_000));
      } finally {
        view.close();
      }
      artifact(home.dir, "late-video.json", { landed, frame: frame.key, video: videoBlob });
    } finally {
      home.close();
    }
  });

  it("a smaller snapshot lands a gone", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "rem.db");
      parityStore(path, "hash").close();
      await home.land(coast, snapshot(home.blobs, path));
      const smaller = join(home.dir, "smaller.db");
      const store = parityStore(smaller, "hash");
      store.db.exec("DELETE FROM window_bound WHERE frame = 8; DELETE FROM frame WHERE id = 8");
      store.close();
      const landed = await home.land(coast, snapshot(home.blobs, smaller, { snapshot_taken_at: "2026-09-21T15:00:00.000Z" }));
      expect(landed).toMatchObject({ gone: 0, new: 0, restated: 15 });
      expect(home.heads(COAST_SOURCE).filter((head) => head.version === "gone")).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("a delta reads the whole database, or states a frame outside it", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "rem.db");
      const store = new FakeCoast(path, "hash");
      store.video(1, "a".repeat(64));
      const old = 6_000;
      store.db.exec("BEGIN");
      for (let id = 1; id <= old; id++) {
        if (id % 100 === 1) store.segment(id, id, 1);
        store.frame(id, BASE + id * 2_000, id - ((id - 1) % 100), [1, id], `synthetic old text ${"o".repeat(400)}`);
      }
      store.segment(old + 1, old + 1, 2);
      for (let id = old + 1; id <= old + 20; id++) store.frame(id, BASE + id * 2_000, old + 1, [1, id]);
      store.tree(old + 5, BASE + (old + 5) * 2_000 + 7);
      store.db.exec("COMMIT");
      store.close();
      const probe = new Database(path, { readonly: true });
      const pageSize = Number(probe.pragma("page_size", { simple: true }));
      const leaves = probe.prepare("SELECT pageno, ncell FROM dbstat WHERE name = 'frame' AND pagetype = 'leaf' ORDER BY path").all() as { pageno: number; ncell: number }[];
      probe.close();
      let seen = 0;
      let zeroed = 0;
      const fd = openSync(path, "r+");
      for (const leaf of leaves) {
        seen += leaf.ncell;
        if (seen >= old - 50) break;
        writeSync(fd, Buffer.alloc(pageSize), 0, pageSize, (leaf.pageno - 1) * pageSize);
        zeroed++;
      }
      closeSync(fd);
      expect(zeroed).toBeGreaterThan(leaves.length * 0.8);
      const window = { ...SNAPSHOT, kind: "delta", after: old, through: old + 20 };
      const rows = await collect(coast.read(snapshot(home.blobs, path, window), home.blobs));
      expect(rows.map((row) => row.kind)).toEqual([...Array(20).fill(COAST_FRAME), COAST_SESSION, COAST_AX]);
      await expect(collect(coast.read(snapshot(home.blobs, path), home.blobs))).rejects.toThrow(/malformed/u);
      await expect(collect(coast.read(snapshot(home.blobs, path, { ...window, through: old + 10 }), home.blobs))).rejects.toThrow(/holds frame\.id/u);
      artifact(home.dir, "delta.json", { leaves: leaves.length, zeroed, rows: rows.length });
    } finally {
      home.close();
    }
  });

  it("two frames of one millisecond state one key, or an AX snapshot keys apart from its frame", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "rem.db");
      parityStore(path, "hash").close();
      const rows = await collect(coast.read(snapshot(home.blobs, path), home.blobs));
      const keys = rows.map((row) => `${row.kind} ${row.key}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toContain(`${COAST_FRAME} ${BASE + 1_000}`);
      expect(keys).toContain(`${COAST_FRAME} ${BASE + 1_000}:1`);
      const ax = rows.find((row) => row.kind === COAST_AX && row.key === `${BASE + 1_000}:1`)!;
      expect((ax.content as JsonObject).frame_identity).toBe(`${BASE + 1_000}:1`);
      artifact(home.dir, "keys.json", keys);
    } finally {
      home.close();
    }
  });

  it("a sealed snapshot whose tree names a node it never held lands, one snapshot of an AXN2 version it does not read or one segment that cannot be stated takes the rest with it, or NaN geometry reaches a record", async () => {
    const home = openTestHome();
    try {
      const path = join(home.dir, "rem.db");
      const store = parityStore(path, "id");
      store.frame(11, BASE + 10_000, null);
      store.tree(11, BASE + 10_000, { missing: true });
      store.segment(4, 13, 1);
      store.frame(12, BASE + 11_000, 4, null);
      store.frame(13, BASE + 12_000, 4, null);
      store.frame(14, BASE + 13_000, null);
      const later = axNode("AXWindow", { title: "Synthetic Window" });
      later[4] = 3;
      store.snapshot(14, later, BASE + 13_000);
      store.close();
      const rows = await collect(coast.read(snapshot(home.blobs, path), home.blobs));
      expect(rows.filter((row) => row.refused !== undefined).map((row) => `${row.key}: ${row.refused}`)).toEqual([
        expect.stringMatching(/^segment id 4: segment 4 start_frame_id 13 is not its earliest frame$/u),
        expect.stringMatching(/^ax_snapshot frame_id 11: .*is absent/u),
        expect.stringMatching(/^ax_snapshot frame_id 14: .*AXN2 version 3 is not one this connector reads$/u),
      ]);
      expect(rows.filter((row) => row.kind === COAST_FRAME)).toHaveLength(14);
      expect(rows.filter((row) => row.kind === COAST_SESSION)).toHaveLength(3);
      expect(rows.filter((row) => row.kind === COAST_AX)).toHaveLength(3);
      const clean = join(home.dir, "clean.db");
      parityStore(clean, "id").close();
      const ax = (await collect(coast.read(snapshot(home.blobs, clean), home.blobs))).find((row) => row.kind === COAST_AX && row.key === String(BASE + 6_000))!;
      const button = ((ax.content as { tree: { children: JsonObject[] } }).tree.children[1]!.node as JsonObject);
      expect(button).not.toHaveProperty("size");
      expect(button.role).toBe("AXButton");
    } finally {
      home.close();
    }
  });

  it("a delivery of facts alone lands a row", async () => {
    const home = openTestHome();
    try {
      const empty = deliver(home, COAST_SOURCE, {}, { snapshot_taken_at: "2026-09-21T14:05:00.000Z" });
      expect(await collect(coast.read(empty, home.blobs))).toEqual([]);
      const landed = await home.land(coast, empty);
      expect(landed).toMatchObject({ new: 0, restated: 0, changed: 0, gone: 0 });
      artifact(home.dir, "empty.json", { landed });
    } finally {
      home.close();
    }
  });
});
