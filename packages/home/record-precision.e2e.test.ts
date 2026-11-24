import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder, type Json, type ReaderOutput } from "@lifestreamprotocol/core";
import { HomeFile } from "./home-file.js";
import { openReads, type Reply } from "./reads.js";
import { lastGood } from "./settings.js";
import { makeRoot, removeRoot } from "./test/harness-root.js";

const SOURCE = "films:person-a@example.com:cloud";
const DAY_MS = 86_400_000;
const OCT_5 = Date.UTC(2026, 9, 5);
const roots: string[] = [];
afterAll(() => roots.forEach(removeRoot));

const WATCHES: ReaderOutput[] = [
  { kind: "watch", key: "a-date", content: { title: "Example Film" }, time: { start_ms: OCT_5, end_ms: OCT_5 + DAY_MS, precision: "day" } },
  { kind: "watch", key: "b-month", content: { title: "Example Series" }, time: { start_ms: Date.UTC(2026, 9, 1), end_ms: Date.UTC(2026, 10, 1), precision: "month" } },
  { kind: "watch", key: "c-year", content: { title: "Example Show" }, time: { start_ms: Date.UTC(2026, 0, 1), end_ms: Date.UTC(2027, 0, 1), precision: "year" } },
  { kind: "watch", key: "d-instant", content: { title: "Example Short" }, time: { start_ms: OCT_5 + 4 * 3_600_000, precision: "ms" } },
  { kind: "watch", key: "e-gone", content: { title: "Example Trailer" }, time: { start_ms: OCT_5, precision: "day" } },
];

function scratch(): (path: string) => Record<string, any> {
  const root = makeRoot("lifestream-precision-", { sources: {} });
  roots.push(root);
  const db = openHome(openHomeFolder(root), "migrate");
  const object = (content: Json) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
  db.commit((tx) => {
    tx.tables.sources.add({ id: SOURCE, vendor: "films", connector: "films-cloud", added_ms: 0 });
    const land = (stated_ms: number, rows: ReaderOutput[]) => {
      const run = tx.tables.runs.start({ kind: "import", subject: SOURCE, started_ms: stated_ms });
      tx.records.land(run, { id: `${SOURCE}/${stated_ms}`, source: SOURCE, stated_ms }, rows, { watch: object }, { has: () => true });
    };
    land(1, WATCHES);
    land(2, [{ kind: "watch", key: "e-gone", content: null, gone: true }]);
  });
  db.close();
  const reads = openReads({ folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: openHomeFolder(root).blobs(join(root, "blobs"), { reading: true }), settings: lastGood(root) });
  return (path) => {
    const reply = reads.reply(new URL(path, "http://door").pathname)!({ url: path, now_ms: Date.now(), held: { machine: process.env.LIFESTREAM_MACHINE_DIR!, sites: [], present: [], refused: [], stated: {} } }) as Reply;
    expect(reply.status).toBe(200);
    return JSON.parse(typeof reply.body === "string" ? reply.body : Buffer.from(reply.body).toString("utf8")) as Record<string, any>;
  };
}

describe("a record's head", () => {
  it("states the precision its time was stated by, a date, a month, a year and an instant, on both routes; a gone record's none", () => {
    const get = scratch();
    const source = encodeURIComponent(SOURCE);
    const listed = get(`/v1/records?source=${source}&kind=watch`).records as { key: string; head: Record<string, unknown> }[];
    expect(listed.map(({ key, head }) => [key, head.start_ms, head.end_ms, head.precision])).toEqual(
      WATCHES.slice(0, 4).map(({ key, time }) => [key, time!.start_ms, time!.end_ms ?? null, time!.precision]));
    const ranged = get(`/v1/records?source=${source}&kind=watch&from_ms=0&to_ms=${OCT_5 + 2 * DAY_MS}`).records as { key: string; head: Record<string, unknown> }[];
    expect(ranged.map(({ key, head }) => [key, head.precision])).toEqual([["c-year", "year"], ["b-month", "month"], ["a-date", "day"], ["d-instant", "ms"]]);
    for (const { key, head } of listed) {
      expect(get(`/v1/record?source=${source}&kind=watch&key=${key}`).head).toEqual(head);
    }
    const gone = get(`/v1/record?source=${source}&kind=watch&key=e-gone`);
    expect([gone.version, gone.head.version, gone.head.precision]).toEqual([null, "gone", null]);
  });
});
