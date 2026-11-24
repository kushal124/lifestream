import { createHash } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { instant, type BlobStore, type Delivery, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import type { Reader } from "../seams.js";
import { blobChunks } from "../shared/chunks.js";
import { lines } from "../shared/lines.js";
import { Refused } from "../shared/refused.js";
import { artifact, collect, counts, deliver, openTestHome, type TestHome } from "../test/drive.js";
import { bundle, INSTALL, PROCESS, sealedFiles, sha, UNIT } from "../ios-app/phone.test-support.js";
import { UPLOAD_INDEX, UPLOAD_INDEX_FORMAT, uploadConnector, uploadedFiles } from "./index.js";

const MAC = "macbook-pro-0001";
const SOURCE = `upload:local:${MAC}`;
const PHONE_SOURCE = `upload:local:${UNIT}`;

const PDF = Buffer.from("%PDF-1.7 synthetic lab report for person-a@example.com\n");
const NOTES = Buffer.from("synthetic notes, first draft\n");
const NOTES_EDITED = Buffer.from("synthetic notes, second draft\n");
const TOY_EXPORT = Buffer.from(`${JSON.stringify({ at: "2026-10-01T09:00:00Z", verb: "searched", text: "synthetic query one" })}\n${JSON.stringify({ at: "2026-10-01T09:05:00Z", verb: "watched", text: "synthetic video two" })}\n`);

const hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

interface Dropped {
  path: string;
  bytes: Buffer;
  media_type?: string;
  created_at?: string;
  modified_at?: string;
}

function dropDelivery(home: TestHome | BlobStore, dropped: Dropped[], taken: string, index?: JsonObject): Delivery {
  const stated = index ?? {
    format: UPLOAD_INDEX_FORMAT,
    files: dropped.map(({ path, media_type, created_at, modified_at }) => ({
      path, ...(media_type === undefined ? {} : { media_type }), ...(created_at === undefined ? {} : { created_at }), ...(modified_at === undefined ? {} : { modified_at }),
    })),
  };
  return deliver(home, SOURCE, {
    [UPLOAD_INDEX]: Buffer.from(JSON.stringify(stated)),
    ...Object.fromEntries(dropped.map((file) => [`files/${file.path}`, file.bytes])),
  }, { files: dropped.length, snapshot_taken_at: taken });
}

const REPORT: Dropped = { path: "lab/report-a.pdf", bytes: PDF, media_type: "application/pdf", created_at: "2026-09-30T08:00:00.000Z", modified_at: "2026-09-30T08:10:00.500Z" };
const NOTE: Dropped = { path: "notes.txt", bytes: NOTES, media_type: "text/plain", created_at: "2026-10-01T10:00:00.000Z", modified_at: "2026-10-01T10:00:00.000Z" };
const TOY: Dropped = { path: "exports/toy-export-001.jsonl", bytes: TOY_EXPORT, modified_at: "2026-10-02T07:00:00.000Z" };

function phoneDelivery(home: TestHome, shared: { name: string; bytes: Buffer; type: string; at: string }[], source = PHONE_SOURCE): Delivery {
  const entries = shared.map((file, index) => ({
    schema_version: 1, domain: "upload", kind: "file", sequence: index + 1, observed_at: file.at,
    captured: { wall_rfc3339: file.at, wall_unix_seconds: Date.parse(file.at) / 1000, elapsed_seconds: 10.5 },
    process_instance_id: PROCESS,
    payload: { name: file.name, blob: { hash: sha(file.bytes), bytes: file.bytes.length, type: file.type, role: "original" } },
  }));
  const carried = [...new Map(shared.map((file) => [sha(file.bytes), file.bytes])).values()];
  const shipment = bundle("shared", "2026-10-03T09:00:00.250Z", { upload: entries }, carried);
  const stated_ms = instant(shipment.created_at, "rfc3339").start_ms;
  return { id: `phone:${UNIT}/${shipment.bundle_id}`, source, sealed_ms: stated_ms, stated_ms, facts: { bundle_id: shipment.bundle_id, created_at: shipment.created_at }, files: sealedFiles(home.blobs, shipment) };
}

const TOY_NAME = /(?:^|\/)toy-export-\d{3}\.jsonl$/u;
const toyDownload: Reader = {
  name: "toy-download",
  kinds: { activity: () => [] },
  async *read(delivery, files) {
    for await (const file of uploadedFiles(delivery, files)) {
      if (!TOY_NAME.test(file.path)) continue;
      let line = 0;
      for await (const bytes of lines(blobChunks(files, file.blob))) {
        line++;
        const entry = JSON.parse(bytes.toString("utf8")) as { at: string; verb: string; text: string };
        yield { kind: "activity", key: `${entry.at}:${entry.verb}`, content: { type: "toy.activity", ...entry }, time: instant(entry.at, "rfc3339"), locator: `${file.locator}:line ${line}` } satisfies ReaderOutput;
      }
    }
  },
};

describe("uploads: each of these is impossible", () => {
  it("a drop-folder delivery lands other heads than one file record per file, keyed by its bytes", async () => {
    const home = openTestHome();
    try {
      const delivery = dropDelivery(home, [REPORT, NOTE], "2026-10-03T09:00:00.000Z");
      const landed = await home.land(uploadConnector, delivery);
      expect(landed).toMatchObject({ new: 2, refused: 0, duplicated: 0, gone: 0 });
      const heads = home.heads(SOURCE);
      expect(heads.map((head) => [head.kind, head.key])).toEqual([hex(PDF), hex(NOTES)].sort().map((key) => ["file", key]));
      const report = heads.find((head) => head.key === hex(PDF))!;
      expect(report.content).toEqual({
        type: "upload.file", path: "lab/report-a.pdf", name: "report-a.pdf", bytes: PDF.length, media_type: "application/pdf",
        created_at: "2026-09-30T08:00:00.000Z", modified_at: "2026-09-30T08:10:00.500Z",
        blobs: [{ hash: `sha256:${hex(PDF)}`, bytes: PDF.length, role: "original" }],
      });
      expect(report.start_ms).toBe(Date.parse("2026-09-30T08:10:00.500Z"));
      const rows = await collect(uploadConnector.read(delivery, home.blobs));
      expect(rows.every((row) => row.device === MAC)).toBe(true);
      expect(rows.map((row) => row.locator)).toEqual(["files/lab/report-a.pdf", "files/notes.txt"]);
      expect(home.blobs.bytes(`sha256:${hex(PDF)}`).equals(PDF)).toBe(true);
      artifact(home.dir, "heads.json", { landed: counts(landed), heads });
    } finally {
      home.close();
    }
  });

  it("the same delivery again writes anything new", async () => {
    const home = openTestHome();
    try {
      await home.land(uploadConnector, dropDelivery(home, [REPORT, NOTE], "2026-10-03T09:00:00.000Z"));
      const again = await home.land(uploadConnector, dropDelivery(home, [REPORT, NOTE], "2026-10-03T09:05:00.000Z"));
      expect(again).toMatchObject({ new: 0, changed: 0, restated: 2, gone: 0 });
      artifact(home.dir, "again.json", counts(again));
    } finally {
      home.close();
    }
  });

  it("a file changed in place loses its earlier bytes, or a later delivery without a file lands a gone", async () => {
    const home = openTestHome();
    try {
      await home.land(uploadConnector, dropDelivery(home, [REPORT, NOTE], "2026-10-03T09:00:00.000Z"));
      const edited: Dropped = { ...NOTE, bytes: NOTES_EDITED, modified_at: "2026-10-03T11:00:00.000Z" };
      const landed = await home.land(uploadConnector, dropDelivery(home, [edited], "2026-10-03T11:05:00.000Z"));
      expect(landed).toMatchObject({ new: 1, changed: 0, gone: 0 });
      const heads = home.heads(SOURCE);
      expect(heads.map((head) => head.key).sort()).toEqual([hex(PDF), hex(NOTES), hex(NOTES_EDITED)].sort());
      expect(heads.every((head) => !head.gone)).toBe(true);
      expect(heads.filter((head) => (head.content as JsonObject).path === "notes.txt")).toHaveLength(2);
      artifact(home.dir, "edited.json", { landed: counts(landed), heads });
    } finally {
      home.close();
    }
  });

  it("an index that disagrees with the delivery's files lands any of it, or is refused without naming why", async () => {
    const home = openTestHome();
    try {
      const cases: [string, Delivery, RegExp][] = [
        ["a file the index does not name", dropDelivery(home, [REPORT, NOTE], "2026-10-03T09:00:00.000Z", { format: UPLOAD_INDEX_FORMAT, files: [{ path: REPORT.path }] }), /names no entry for 1 file\(s\).*notes\.txt/u],
        ["an entry the delivery does not hold", dropDelivery(home, [REPORT], "2026-10-03T09:00:00.000Z", { format: UPLOAD_INDEX_FORMAT, files: [{ path: REPORT.path }, { path: "missing.pdf" }] }), /files\[1\] names "missing\.pdf", which the delivery does not hold/u],
        ["a path named twice", dropDelivery(home, [REPORT], "2026-10-03T09:00:00.000Z", { format: UPLOAD_INDEX_FORMAT, files: [{ path: REPORT.path }, { path: REPORT.path }] }), /files\[1\] names "lab\/report-a\.pdf" a second time/u],
        ["another format", dropDelivery(home, [REPORT], "2026-10-03T09:00:00.000Z", { format: "org.example.other/9", files: [] }), /upload\.json must be/u],
        ["a time that is not one", dropDelivery(home, [REPORT], "2026-10-03T09:00:00.000Z", { format: UPLOAD_INDEX_FORMAT, files: [{ path: REPORT.path, modified_at: "yesterday" }] }), /files\[0\]\.modified_at must be an RFC 3339 instant/u],
        ["a member the index does not know", dropDelivery(home, [REPORT], "2026-10-03T09:00:00.000Z", { format: UPLOAD_INDEX_FORMAT, files: [{ path: REPORT.path, owner: "person-a" }] }), /files\[0\] must state path/u],
      ];
      const refusals: Record<string, string> = {};
      for (const [name, delivery, reason] of cases) {
        const error = await collect(uploadConnector.read(delivery, home.blobs)).then(() => undefined, (caught: unknown) => caught);
        expect(error, name).toBeInstanceOf(Refused);
        expect((error as Refused).message, name).toMatch(reason);
        refusals[name] = (error as Refused).message;
      }
      expect(home.heads(SOURCE)).toEqual([]);
      artifact(home.dir, "refusals.json", refusals);
    } finally {
      home.close();
    }
  });

  it("a delivery that holds no upload yields a row or is refused", async () => {
    const home = openTestHome();
    try {
      const other = deliver(home, SOURCE, { "rows.ndjson": Buffer.from("{}\n") }, { snapshot_taken_at: "2026-10-03T09:00:00.000Z" });
      expect(await collect(uploadConnector.read(other, home.blobs))).toEqual([]);
      const quiet = phoneDelivery(home, []);
      expect(await collect(uploadConnector.read(quiet, home.blobs))).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("a file shared on the phone lands under another key than its bytes', or twice for one share repeated", async () => {
    const home = openTestHome();
    try {
      const scan = Buffer.from("synthetic scanned statement bytes, page one");
      const delivery = phoneDelivery(home, [
        { name: "statement-synthetic.pdf", bytes: scan, type: "application/pdf", at: "2026-10-03T08:00:00.125Z" },
        { name: "statement-synthetic.pdf", bytes: scan, type: "application/pdf", at: "2026-10-03T08:30:00.125Z" },
      ]);
      const rows = await collect(uploadConnector.read(delivery, home.blobs));
      expect(rows.map((row) => row.key)).toEqual([hex(scan), hex(scan)]);
      expect(rows.every((row) => row.device === UNIT && row.locator!.startsWith("upload.jsonl line "))).toBe(true);
      const landed = await home.land(uploadConnector, delivery, rows);
      expect(landed).toMatchObject({ new: 1, duplicated: 1, refused: 0 });
      const [head] = home.heads(PHONE_SOURCE);
      expect(head!.content).toEqual({
        type: "upload.file", path: "statement-synthetic.pdf", name: "statement-synthetic.pdf", bytes: scan.length, media_type: "application/pdf",
        shared_at: "2026-10-03T08:30:00.125Z", blobs: [{ hash: sha(scan), bytes: scan.length, role: "original" }],
      });
      expect(JSON.stringify(head!.content)).not.toContain(INSTALL);
      expect(head!.start_ms).toBe(Date.parse("2026-10-03T08:30:00.125Z"));
      artifact(home.dir, "phone.json", { landed: counts(landed), heads: home.heads(PHONE_SOURCE) });
    } finally {
      home.close();
    }
  });

  it("a phone line naming a blob the home does not hold is refused, or lands without wanting it", async () => {
    const home = openTestHome();
    try {
      const delivery = phoneDelivery(home, [{ name: "a.pdf", bytes: PDF, type: "application/pdf", at: "2026-10-03T08:00:00.125Z" }]);
      const absent = Buffer.from("bytes no shipment carried");
      const entry = { schema_version: 1, domain: "upload", kind: "file", sequence: 1, observed_at: "2026-10-03T08:00:00.125Z", captured: { wall_rfc3339: "2026-10-03T08:00:00.125Z" }, payload: { name: "b.pdf", blob: { hash: sha(absent), bytes: absent.length, type: "application/pdf", role: "original" } } };
      const shipment = bundle("orphan", "2026-10-03T09:00:00.250Z", { upload: [entry] });
      const orphan = { ...delivery, id: `phone:${UNIT}/${shipment.bundle_id}`, files: sealedFiles(home.blobs, shipment) };
      const landed = await home.land(uploadConnector, orphan);
      expect(landed).toMatchObject({ new: 1, refused: 0 });
      const wanted = () => {
        const reader = new Database(join(home.dir, "home.db"), { readonly: true });
        try {
          return reader.prepare("SELECT source || ' ' || kind || ' ' || key FROM wanted_blobs WHERE blob = ?").pluck().all(sha(absent)) as string[];
        } finally {
          reader.close();
        }
      };
      const [head] = home.heads(PHONE_SOURCE);
      expect([head!.key, (head!.content as JsonObject).blobs]).toEqual([hex(absent), [{ hash: sha(absent), bytes: absent.length, role: "original" }]]);
      expect(wanted()).toEqual([`${PHONE_SOURCE} file ${hex(absent)}`]);
      home.blobs.put(absent);
      expect(home.db.commit((tx) => tx.records.blobsArrived([sha(absent)], {}))).toBe(1);
      expect(wanted()).toEqual([]);
      artifact(home.dir, "lost-blob.json", { landed: counts(landed), heads: home.heads(PHONE_SOURCE) });
    } finally {
      home.close();
    }
  });

  it("a phone line that does not read takes the files shared after it with it", async () => {
    const home = openTestHome();
    try {
      const first = Buffer.from("synthetic shared file one");
      const third = Buffer.from("synthetic shared file three");
      const shared = (sequence: number, name: string, bytes: Buffer) => ({
        schema_version: 1, domain: "upload", kind: "file", sequence, observed_at: "2026-10-03T08:00:00.125Z",
        captured: { wall_rfc3339: "2026-10-03T08:00:00.125Z", wall_unix_seconds: Date.parse("2026-10-03T08:00:00.125Z") / 1000, elapsed_seconds: 10.5 },
        process_instance_id: PROCESS, payload: { name, blob: { hash: sha(bytes), bytes: bytes.length, type: "text/plain", role: "original" } },
      });
      const shipment = bundle("bad-line", "2026-10-03T09:00:00.250Z", { upload: [shared(1, "one.txt", first), "not json", shared(3, "three.txt", third)] }, [first, third]);
      const stated_ms = instant(shipment.created_at, "rfc3339").start_ms;
      const delivery = { id: `phone:${UNIT}/${shipment.bundle_id}`, source: PHONE_SOURCE, sealed_ms: stated_ms, stated_ms, facts: {}, files: sealedFiles(home.blobs, shipment) };
      const landed = await home.land(uploadConnector, delivery);
      expect(landed).toMatchObject({ new: 2, refused: 1 });
      expect(landed.refusals.map((refusal) => `${refusal.key} ${refusal.violations.join()}`)).toEqual([expect.stringMatching(/^upload\.jsonl line 2 upload\.jsonl line 2 is not one JSON object: /u)]);
      expect(home.heads(PHONE_SOURCE).map((head) => head.key).sort()).toEqual([hex(first), hex(third)].sort());
      artifact(home.dir, "bad-line.json", counts(landed));
    } finally {
      home.close();
    }
  });

  it("a download fed the upload lane reads a file it does not recognise, or misses one it does", async () => {
    const home = openTestHome();
    try {
      const delivery = dropDelivery(home, [REPORT, NOTE, TOY], "2026-10-03T09:00:00.000Z");
      const download = { ...delivery, source: "google-search:person-a@example.com:export" };
      const files = await home.land(uploadConnector, delivery);
      const activity = await home.land(toyDownload, download);
      expect(files).toMatchObject({ new: 3 });
      expect(activity).toMatchObject({ new: 2, refused: 0 });
      const heads = home.heads(download.source);
      expect(heads.map((head) => head.key)).toEqual(["2026-10-01T09:00:00Z:searched", "2026-10-01T09:05:00Z:watched"]);
      const phone = phoneDelivery(home, [{ name: "toy-export-002.jsonl", bytes: TOY_EXPORT, type: "application/x-ndjson", at: "2026-10-03T08:00:00.125Z" }], "google-search:person-a@example.com:export");
      const fromPhone = await collect(toyDownload.read(phone, home.blobs));
      expect(fromPhone.map((row) => row.locator)).toEqual(["upload.jsonl line 1:line 1", "upload.jsonl line 1:line 2"]);
      const pdfOnly = await collect(toyDownload.read(dropDelivery(home, [REPORT], "2026-10-03T10:00:00.000Z"), home.blobs));
      expect(pdfOnly).toEqual([]);
      artifact(home.dir, "download.json", { files: counts(files), activity: counts(activity), heads });
    } finally {
      home.close();
    }
  });
});
