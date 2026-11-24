import { artifact, collect, MiB, temp, writeZip } from "../test/drive.js";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlobError, canonical, instant, openHome, openHomeFolder, span, type BlobStore, type Delivery, type HomeDb, type Instant, type Json, type JsonObject, type Landed, type ReaderOutput } from "@lifestreamprotocol/core";
import type { Reader } from "../seams.js";
import { iosBundleSources } from "../index.js";
import { readIosBundle } from "../shared/ios-bundle.js";
import { openZip } from "../shared/zip.js";
import { readers } from "./index.js";
import { sampleKey } from "../health/apple/samples.js";
import { usage } from "../biome/usage.js";
import { contacts } from "../contacts/vcard/phone.js";
import { health } from "../health/apple/phone.js";
import { photos } from "../photos/apple/phone.js";
import { BOOT, bundle, CAMERA_STORED, CONTACT_IDS, CONTACT_PHOTO, contactCard, contactGone, deletion, entry, DOSE, DOSE_UUIDS, doseEvent, firstBundle, HEART, medicationList, HEALTH_ACCOUNT, HEALTH_UUIDS, MIND_UUIDS, mindAndDoseShipments, sample, secondBundle, sealedFiles, sha, shipments, STATE_OF_MIND, stateOfMind, STEPS, UNIT, type SyntheticBundle } from "./phone.test-support.js";

type Stated = { kind: string; key: string; gone?: true; content?: Json; time?: Instant | null };

const GOLDEN = JSON.parse(readFileSync(new URL("./test/parity.golden.json", import.meta.url), "utf8")) as { sources: Record<string, Record<string, Stated[]>> };

const CONNECTORS: Record<string, Reader> = Object.fromEntries([...readers, usage, contacts, health, photos].map((connector) => [connector.name.replace("-ios-bundle", ""), connector]));
const HEALTH_SOURCE = `apple-health:${HEALTH_ACCOUNT}:cloud`;

interface Sealed {
  bundle: SyntheticBundle;
  deliveries: { domain: string; delivery: Delivery }[];
  ignored: string[];
}

async function seal(dir: string, blobs: BlobStore, bundle: SyntheticBundle): Promise<Sealed> {
  const path = join(dir, `${bundle.name}.zip`);
  writeZip(path, bundle.members.map((member) => ({ name: member.name, bytes: member.bytes, method: "deflate" })));
  for (const bytes of Object.values(bundle.stored)) blobs.put(bytes);
  const files = sealedFiles(blobs, bundle);
  const zip = openZip(path);
  const sources = iosBundleSources(readIosBundle(zip), { unit: UNIT, apple_id: HEALTH_ACCOUNT });
  zip.close();
  const stated_ms = instant(bundle.created_at, "rfc3339").start_ms;
  const facts = { bundle_id: bundle.bundle_id, created_at: bundle.created_at, fetched_at: "2026-10-03T05:00:00Z" };
  return {
    bundle,
    deliveries: sources.flatMap(({ domain, source }) =>
      source === null ? [] : [{ domain, delivery: { id: `phone:${UNIT}/${bundle.bundle_id}`, source, sealed_ms: stated_ms, stated_ms, facts, files } }],
    ),
    ignored: sources.filter((source) => source.source === null).map((source) => source.domain),
  };
}

function deliveryOf(sealed: Sealed, domain: string): Delivery {
  return sealed.deliveries.find((entry) => entry.domain === domain)!.delivery;
}

async function importDelivery(db: HomeDb, blobs: BlobStore, domain: string, delivery: Delivery, reread = false): Promise<{ rows: ReaderOutput[]; landed: Landed }> {
  const connector = CONNECTORS[domain]!;
  const view = db.view();
  let rows: ReaderOutput[];
  try {
    rows = await collect(connector.read(delivery, blobs, view));
  } finally {
    view.close();
  }
  const landed = db.commit((tx) => {
    const run = tx.tables.runs.start({ kind: "import", subject: `${delivery.source} ${delivery.id}`, started_ms: delivery.stated_ms });
    const landed = tx.records.land(run, { ...delivery, reread }, rows, connector.kinds, blobs);
    tx.tables.runs.end(run, { ended_ms: delivery.stated_ms, outcome: "ok" });
    return landed;
  });
  return { rows, landed };
}

function home(dir: string): { db: HomeDb; blobs: BlobStore } {
  return { db: openHome(openHomeFolder(dir), "migrate"), blobs: openHomeFolder(dir).blobs(join(dir, "blobs")) };
}

function finalState(rows: readonly Stated[]): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const row of rows) {
    out[`${row.kind}:${row.key}`] = row.gone ? "gone" : { content: row.content ?? null, time: row.time === undefined || row.time === null ? null : ({ ...row.time } as JsonObject) };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function heads(db: HomeDb, source: string, records: string[]): Record<string, Json> {
  const view = db.view();
  try {
    const out: Record<string, Json> = {};
    for (const record of [...records].sort()) {
      const colon = record.indexOf(":");
      const head = view.head({ source, kind: record.slice(0, colon), key: record.slice(colon + 1) });
      if (head === undefined) continue;
      out[record] = head.version === "gone" ? "gone" : view.version(head.version).content;
    }
    return out;
  } finally {
    view.close();
  }
}

function wanting(dir: string, blob: string): { linked: string[]; wanted: string[] } {
  const reader = new Database(join(dir, "home.db"), { readonly: true });
  try {
    return {
      linked: reader.prepare("SELECT blob FROM version_blobs WHERE blob = ?").pluck().all(blob) as string[],
      wanted: reader.prepare("SELECT source || ' ' || kind || ' ' || key FROM wanted_blobs WHERE blob = ? ORDER BY 1").pluck().all(blob) as string[],
    };
  } finally {
    reader.close();
  }
}

const counts = (landed: Landed) => ({ new: landed.new, restated: landed.restated, changed: landed.changed, late: landed.late, gone: landed.gone, refused: landed.refused, duplicated: landed.duplicated, replayed: landed.replayed, refusals: landed.refusals });

async function landBoth(dir: string) {
  const { db, blobs } = home(dir);
  const shipments = [await seal(dir, blobs, firstBundle()), await seal(dir, blobs, secondBundle())];
  const imports: { shipment: string; domain: string; delivery: Delivery; rows: ReaderOutput[]; landed: Landed }[] = [];
  for (const sealed of shipments) {
    for (const { domain, delivery } of sealed.deliveries) {
      imports.push({ shipment: sealed.bundle.name, domain, delivery, ...(await importDelivery(db, blobs, domain, delivery)) });
    }
  }
  return { db, blobs, shipments, imports };
}

describe("the phone shipment's connectors: each of these is impossible", () => {
  it("the parity golden differs", async () => {
    const dir = temp();
    const { db, imports } = await landBoth(dir);
    try {
      const compared: Record<string, Json> = {};
      for (const { shipment, delivery, rows: read } of imports) {
        const rows = read.filter((row) => row.refused === undefined);
        const golden = finalState(GOLDEN.sources[delivery.source]?.[shipment] ?? []);
        expect(canonical(finalState(rows)), `${delivery.source} ${shipment}`).toBe(canonical(golden));
        compared[`${delivery.source} ${shipment}`] = Object.keys(golden).length;
      }
      expect(Object.keys(compared).sort()).toEqual(Object.entries(GOLDEN.sources).flatMap(([source, bundles]) => Object.keys(bundles).map((bundle) => `${source} ${bundle}`)).sort());
      artifact(dir, "parity.json", { compared });
    } finally {
      db.close();
    }
  });

  it("a synthetic delivery lands different heads than expected", async () => {
    const dir = temp();
    const { db, imports } = await landBoth(dir);
    try {
      const report: Record<string, Json> = {};
      for (const [source, bundles] of Object.entries(GOLDEN.sources)) {
        const expected = finalState(Object.values(bundles).flat());
        const landed = heads(db, source, Object.keys(expected));
        expect(landed, source).toEqual(Object.fromEntries(Object.entries(expected).map(([record, state]) => [record, state === "gone" ? "gone" : (state as JsonObject).content!])));
        report[source] = landed;
      }
      const landedCounts = imports.map(({ shipment, delivery, landed }) => ({ shipment, source: delivery.source, ...counts(landed) }));
      expect(landedCounts.every((entry) => entry.late === 0)).toBe(true);
      expect(landedCounts.filter((entry) => entry.refused > 0)).toEqual([]);
      const camera = imports.find((entry) => entry.domain === "camera" && entry.shipment === "second")!;
      expect(camera.rows[0]!.blobs).toEqual([sha(CAMERA_STORED)]);
      artifact(dir, "heads.json", { heads: report, landed: landedCounts });
    } finally {
      db.close();
    }
  });

  it("a derived source is landed while its sibling domain is ignored", async () => {
    const dir = temp();
    const { db, shipments, imports } = await landBoth(dir);
    try {
      const first = shipments[0]!;
      const domains = first.bundle.members.filter((member) => member.name.endsWith(".jsonl")).map((member) => member.name.slice(0, -6)).sort();
      expect([...first.deliveries.map((entry) => entry.domain), ...first.ignored].sort()).toEqual(domains);
      expect(first.ignored).toEqual(["orbit", "places"]);
      const perSource: Record<string, Json> = {};
      for (const { shipment, domain, delivery, rows, landed } of imports) {
        expect(rows.every((row) => row.gone === true || row.locator!.startsWith(`${domain}.jsonl line `)), `${delivery.source} ${shipment}`).toBe(true);
        expect(landed.new + landed.changed + landed.gone + landed.restated, `${delivery.source} ${shipment}`).toBeGreaterThan(0);
        perSource[`${delivery.source} ${shipment}`] = rows.length;
      }
      const second = shipments[1]!;
      const motion = CONNECTORS.motion!;
      const { blobs } = home(dir);
      expect(await collect(motion.read({ ...second.deliveries[0]!.delivery, source: `motion:${UNIT}` }, blobs))).toEqual([]);
      artifact(dir, "derived.json", { ignored: first.ignored, rows: perSource });
    } finally {
      db.close();
    }
  });

  it("a HealthKit delete/insert within one bundle is double counted", async () => {
    const dir = temp();
    const { db, imports } = await landBoth(dir);
    try {
      const health = imports.find((entry) => entry.domain === "health" && entry.shipment === "first")!;
      const samples = health.rows.filter((row) => row.kind === "sample");
      const byKey = new Map<string, ReaderOutput[]>();
      for (const row of samples) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
      const uuidRow = (uuid: string) => health.rows.find((row) => row.kind === "sample-uuid" && row.key === uuid)!;
      const rewriteKey = (uuidRow(HEALTH_UUIDS.rewrite305).content as JsonObject) as unknown as Record<string, string>;
      const rewritten = samples.filter((row) => (row.content as JsonObject | null)?.start === rewriteKey.start && (row.content as JsonObject).sample_type === rewriteKey.sample_type);
      expect(rewritten).toHaveLength(1);
      expect((rewritten[0]!.content as JsonObject).metadata).toEqual({ HKMetadataKeySyncVersion: 2 });
      const doomed = [...byKey.values()].filter((rows) => rows.some((row) => row.gone));
      expect(doomed).toHaveLength(1);
      expect(doomed[0]).toHaveLength(1);
      expect([...byKey.values()].filter((rows) => rows.length > 1)).toHaveLength(1);
      const tombstoned = health.rows.filter((row) => row.kind === "sample-uuid" && row.gone).map((row) => row.key);
      expect(tombstoned).toEqual([HEALTH_UUIDS.rewrite303, HEALTH_UUIDS.doomed, HEALTH_UUIDS.unknown]);
      expect(counts(health.landed)).toMatchObject({ gone: 4, duplicated: 3, refused: 0 });
      const later = imports.find((entry) => entry.domain === "health" && entry.shipment === "second")!;
      expect(later.rows.filter((row) => row.gone)).toEqual([
        { kind: "sample", key: (uuidSample(health.rows, HEALTH_UUIDS.steps)), content: null, gone: true, device: UNIT },
        { kind: "sample-uuid", key: HEALTH_UUIDS.steps, content: null, gone: true, device: UNIT },
      ]);
      expect(counts(later.landed)).toMatchObject({ gone: 2, restated: 2, new: 2, duplicated: 0 });
      artifact(dir, "health.json", { first: counts(health.landed), second: counts(later.landed), rows: health.rows.map((row) => ({ kind: row.kind, key: row.key, gone: row.gone ?? false })) });
    } finally {
      db.close();
    }
  });

  it("a workout lands as anything but one workout, a rewritten one twice, a deleted one live, or a sample of a type this connector has not seen is refused", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const WORKOUT = "HKWorkoutTypeIdentifier";
      const [W1, W2] = ["10000000-0000-4000-8000-000000000771", "10000000-0000-4000-8000-000000000772"];
      const span = { start: "2026-10-03T02:00:00.5Z", end: "2026-10-03T02:30:00.5Z" };
      const workout = (sequence: number, uuid: string, strain: number) => sample(sequence, uuid, { type: WORKOUT, ...span, metadata: { HKIndoorWorkout: false, "WHOOP Strain": strain },
        extra: { workout_activity_type: 37, duration_seconds: 1800, total_distance: { value: 4.0125, unit: "km" }, total_energy: null,
          workout_events: [{ type: 1, date_interval_start: "2026-10-03T02:10:00.25Z", date_interval_end: "2026-10-03T02:11:30.25Z", metadata: null }] } });
      const at = { start: "2026-10-03T03:00:00Z", end: "2026-10-03T03:00:30Z" };
      const voltages = Buffer.from("[0,12.5]\n[0.001953125,-3.25]\n");
      const beats = Buffer.from("[0,false]\n[0.84375,false]\n[2.5,true]\n");
      const ref = (bytes: Buffer) => ({ hash: sha(bytes), bytes: bytes.length, type: "application/x-ndjson" });
      const ecg = { classification: 1, symptoms_status: 1, average_heart_rate_description: "61 count/min", sampling_frequency_description: "512 Hz",
        number_of_voltage_measurements: 2, voltages: ref(voltages) };
      const heartbeat = { count: 3, voltages_absent: true, beats: ref(beats) };
      const systolic = { uuid: "10000000-0000-4000-8000-0000000007b1", sample_type: "HKQuantityTypeIdentifierBloodPressureSystolic", quantity_description: "118 mmHg" };
      const unseen = [
        sample(2, "10000000-0000-4000-8000-0000000007a1", { type: "HKQuantityTypeIdentifierSyntheticFuture", ...at, quantity: "3.25 widget" }),
        sample(3, "10000000-0000-4000-8000-0000000007a2", { type: "HKCategoryTypeIdentifierSyntheticFuture", ...at, category: 2 }),
        sample(4, "10000000-0000-4000-8000-0000000007a3", { type: "HKCategoryTypeIdentifierHeadache", ...at, category: 3, metadata: { HKSyntheticKeyNoTable: { class: "HKQuantity", description: "1 count" }, HKAlgorithmVersion: 2 } }),
        sample(5, "10000000-0000-4000-8000-0000000007a4", { type: "HKDataTypeIdentifierElectrocardiogram", ...at, extra: { electrocardiogram: ecg } }),
        sample(6, "10000000-0000-4000-8000-0000000007a5", { type: "HKCorrelationTypeIdentifierBloodPressure", ...at, extra: { correlation_objects: [systolic] } }),
        sample(7, "10000000-0000-4000-8000-0000000007a6", { type: "HKDataTypeIdentifierHeartbeatSeries", ...at, extra: { heartbeat_series: heartbeat } }),
        sample(8, "10000000-0000-4000-8000-0000000007a7", { type: "HKQuantityTypeIdentifierDistanceCycling", ...at, extra: { quantity_value: 0.5, quantity_unit: "km" } }),
      ];
      const land = async (name: string, created_at: string, lines: object[], carried: Buffer[] = []) =>
        importDelivery(db, blobs, "health", deliveryOf(await seal(dir, blobs, bundle(name, created_at, { health: lines }, carried)), "health"));
      const identity = (type: string, value: string, unit = "", span_ = { start: "2026-10-03T03:00:00Z", end: "2026-10-03T03:00:30Z" }) =>
        ({ sample_type: type, ...span_, value, unit, source_name: "Synthetic Health Source", source_version: "9.1" });

      const first = await land("workouts-a", "2026-10-03T09:00:00+05:30", [workout(1, W1, 9.4), ...unseen], [voltages, beats]);
      expect(first.landed).toMatchObject({ refused: 0, new: 16 });
      const key = sampleKey(identity(WORKOUT, "HKWorkoutActivityTypeRunning", "", { start: "2026-10-03T02:00:00Z", end: "2026-10-03T02:30:00Z" }));
      const stated = first.rows.find((row) => row.kind === "workout")!;
      expect([stated.key, (stated.content as JsonObject).detail, ((stated.content as JsonObject).metadata as JsonObject)["WHOOP Strain"]]).toEqual([key,
        { duration_s: "1800", distance: "4012.5 m", energy: null, statistics: [], events: [{ type: "HKWorkoutEventTypePause", start: "2026-10-03T02:10:00Z", duration_s: "90", metadata: {} }] }, 9.4]);
      const samples = first.rows.filter((row) => row.kind === "sample");
      expect(samples.map((row) => row.key)).toEqual([
        sampleKey(identity("HKQuantityTypeIdentifierSyntheticFuture", "3.25", "widget")),
        sampleKey(identity("HKCategoryTypeIdentifierSyntheticFuture", "2")),
        sampleKey(identity("HKCategoryTypeIdentifierHeadache", "HKCategoryValueSeverityModerate")),
        sampleKey(identity("HKDataTypeIdentifierElectrocardiogram", "")),
        sampleKey(identity("HKCorrelationTypeIdentifierBloodPressure", "")),
        sampleKey(identity("HKDataTypeIdentifierHeartbeatSeries", "")),
        sampleKey(identity("HKQuantityTypeIdentifierDistanceCycling", "500", "m")),
      ]);
      expect(samples.map((row) => (row.content as JsonObject).detail ?? null))
        .toEqual([null, null, null, { electrocardiogram: ecg }, { correlation_objects: [systolic] }, { heartbeat_series: heartbeat }, null]);
      expect([samples[3]!.blobs, samples[3]!.media, samples[5]!.blobs]).toEqual([[sha(voltages)], { [sha(voltages)]: "application/x-ndjson" }, [sha(beats)]]);
      expect([wanting(dir, sha(voltages)).linked, wanting(dir, sha(beats)).linked]).toEqual([[sha(voltages)], [sha(beats)]]);
      expect(JSON.stringify(samples[3]!.content)).not.toContain("12.5");
      expect((samples[2]!.content as JsonObject).metadata).toMatchObject({ HKSyntheticKeyNoTable: { class: "HKQuantity", description: "1 count" }, HKAlgorithmVersion: "2" });

      const second = await land("workouts-b", "2026-10-03T10:00:00+05:30", [workout(1, W2, 10.1), deletion(2, W1, WORKOUT)]);
      expect(second.rows.filter((row) => row.kind === "workout").map((row) => row.gone ?? false)).toEqual([false]);
      const rewritten = heads(db, HEALTH_SOURCE, [`workout:${key}`, `sample-uuid:${W1}`, `sample-uuid:${W2}`]);
      expect([((rewritten[`workout:${key}`] as JsonObject).metadata as JsonObject)["WHOOP Strain"], rewritten[`sample-uuid:${W1}`], (rewritten[`sample-uuid:${W2}`] as JsonObject).value])
        .toEqual([10.1, "gone", "HKWorkoutActivityTypeRunning"]);
      const third = await land("workouts-c", "2026-10-03T11:00:00+05:30", [deletion(1, W2, WORKOUT)]);
      expect([third.landed.gone, heads(db, HEALTH_SOURCE, [`workout:${key}`, `sample-uuid:${W2}`])]).toEqual([2, { [`workout:${key}`]: "gone", [`sample-uuid:${W2}`]: "gone" }]);
      artifact(dir, "workouts.json", { first: counts(first.landed), second: counts(second.landed), third: counts(third.landed), key });
    } finally {
      db.close();
    }
  });

  it("a deletion of a record the home lacks is lost, refused or held unread, or a sample a re-read recovers after its deletion lands live", async () => {
    const EARLY = "2026-10-03T09:00:00.250+05:30";
    const LATE = "2026-10-03T10:00:00.250+05:30";
    const UNREADABLE = "seventy-two count/min";
    const pulse = { type: HEART, start: "2026-10-03T03:00:00.875Z", end: "2026-10-03T03:00:00.875Z", quantity: "72 count/min" };
    const homes: HomeDb[] = [];
    const fresh = () => {
      const dir = temp();
      const opened = home(dir);
      homes.push(opened.db);
      return { dir, ...opened };
    };
    const land = async (at: ReturnType<typeof fresh>, shipment: SyntheticBundle, as?: SyntheticBundle) => {
      const delivery = deliveryOf(await seal(at.dir, at.blobs, shipment), "health");
      const { rows, landed } = await importDelivery(at.db, at.blobs, "health", as === undefined ? delivery : { ...delivery, id: `phone:${UNIT}/${as.bundle_id}` }, as !== undefined);
      return { rows, shape: rows.map((row) => (row.refused !== undefined ? `${row.key}: ${row.refused}` : row.gone ? `gone ${row.kind}` : `${row.kind} ${row.locator}`)), landed: counts(landed) };
    };
    const liveHeads = (at: ReturnType<typeof fresh>) => {
      const reader = new Database(join(at.dir, "home.db"), { readonly: true });
      try {
        return reader.prepare("SELECT kind || ':' || key FROM heads WHERE source = ? AND version <> 'gone' ORDER BY 1").pluck().all(HEALTH_SOURCE) as string[];
      } finally {
        reader.close();
      }
    };
    const report: Record<string, Json> = {};
    try {
      const nothing = fresh();
      const deletesNothing = await land(nothing, bundle("deletes-nothing", EARLY, { health: [deletion(1, HEALTH_UUIDS.unknown, STEPS), sample(2, HEALTH_UUIDS.heart, pulse)] }));
      expect(deletesNothing.shape).toEqual(["sample-uuid health.jsonl line 2", "sample health.jsonl line 2", "gone sample-uuid"]);
      expect(deletesNothing.landed).toMatchObject({ gone: 1, refused: 0 });
      expect(heads(nothing.db, HEALTH_SOURCE, [`sample-uuid:${HEALTH_UUIDS.unknown}`])).toEqual({ [`sample-uuid:${HEALTH_UUIDS.unknown}`]: "gone" });
      report.nothing = { landed: deletesNothing.landed, heads: heads(nothing.db, HEALTH_SOURCE, [`sample-uuid:${HEALTH_UUIDS.unknown}`]) };

      const mind = fresh();
      const deletesMind = await land(mind, bundle("deletes-no-mind", EARLY, { health: [deletion(1, MIND_UUIDS.unknown, STATE_OF_MIND)] }));
      expect([deletesMind.shape, deletesMind.landed.refused]).toEqual([["gone state-of-mind"], 0]);
      expect(heads(mind.db, HEALTH_SOURCE, [`state-of-mind:${MIND_UUIDS.unknown}`])).toEqual({ [`state-of-mind:${MIND_UUIDS.unknown}`]: "gone" });
      report.mind = { landed: deletesMind.landed };

      const recovered = fresh();
      const unread = "10000000-0000-4000-8000-000000000a01";
      const count = { start: "2026-10-03T03:00:00Z", end: "2026-10-03T03:01:00Z", quantity: "1 count" };
      const refusedA = bundle("recovered-a", EARLY, { health: [sample(1, unread, { type: STEPS, ...count, quantity: UNREADABLE })] });
      const a = await land(recovered, refusedA);
      expect(a.shape).toEqual([expect.stringMatching(/^health\.jsonl line 1: health\.jsonl line 1\.payload\.quantity_description is not '<decimal> <unit>'$/u)]);
      const b = await land(recovered, bundle("recovered-b", LATE, { health: [deletion(1, unread, STEPS)] }));
      expect([b.shape, b.landed.refused]).toEqual([["gone sample-uuid"], 0]);
      const again = await land(recovered, bundle("recovered-a-read", EARLY, { health: [sample(1, unread, { type: STEPS, ...count })] }), refusedA);
      expect(again.shape).toEqual(["sample-uuid health.jsonl line 1", "gone sample", "gone sample-uuid"]);
      expect(again.landed).toMatchObject({ duplicated: 1, restated: 1, gone: 1, late: 0, new: 0, refused: 0 });
      const key = again.rows.find((row) => row.kind === "sample")!.key;
      expect(heads(recovered.db, HEALTH_SOURCE, [`sample-uuid:${unread}`, `sample:${key}`])).toEqual({ [`sample-uuid:${unread}`]: "gone", [`sample:${key}`]: "gone" });
      expect(liveHeads(recovered)).toEqual([]);
      report.recovered = { a: a.landed, b: b.landed, again: again.landed, heads: heads(recovered.db, HEALTH_SOURCE, [`sample-uuid:${unread}`, `sample:${key}`]) };

      for (const order of ["303 first", "305 first"] as const) {
        const rewrite = fresh();
        const lines = (quantity: string) => {
          const old = (sequence: number) => sample(sequence, HEALTH_UUIDS.rewrite303, { ...pulse, quantity, metadata: { HKMetadataKeySyncVersion: 1 } });
          const kept = (sequence: number) => sample(sequence, HEALTH_UUIDS.rewrite305, { ...pulse, metadata: { HKMetadataKeySyncVersion: 2 } });
          return order === "303 first" ? [old(1), kept(2)] : [kept(1), old(2)];
        };
        const refused = bundle(`rewrite-a-${order}`, EARLY, { health: lines(UNREADABLE) });
        const first = await land(rewrite, refused);
        expect(first.landed).toMatchObject({ new: 2, refused: 1 });
        const deleted = await land(rewrite, bundle(`rewrite-b-${order}`, LATE, { health: [deletion(1, HEALTH_UUIDS.rewrite303, HEART)] }));
        expect(deleted.shape).toEqual(["gone sample-uuid"]);
        const reread = await land(rewrite, bundle(`rewrite-a-read-${order}`, EARLY, { health: lines(pulse.quantity) }), refused);
        expect(reread.shape.filter((line) => line.startsWith("gone"))).toEqual(["gone sample-uuid"]);
        const key = reread.rows.find((row) => row.kind === "sample")!.key;
        const stood = heads(rewrite.db, HEALTH_SOURCE, [`sample:${key}`, `sample-uuid:${HEALTH_UUIDS.rewrite303}`, `sample-uuid:${HEALTH_UUIDS.rewrite305}`]);
        expect((stood[`sample:${key}`] as JsonObject).metadata, order).toEqual({ HKMetadataKeySyncVersion: 2 });
        expect([stood[`sample-uuid:${HEALTH_UUIDS.rewrite303}`], liveHeads(rewrite)], order).toEqual(["gone", [`sample-uuid:${HEALTH_UUIDS.rewrite305}`, `sample:${key}`].sort()]);
        report[`rewrite, ${order}`] = { first: first.landed, deleted: deleted.landed, reread: reread.landed, live: liveHeads(rewrite) };
      }

      const mismatched = await land(fresh(), bundle("deletes-other-type", EARLY, { health: [sample(1, HEALTH_UUIDS.heart, pulse), deletion(2, HEALTH_UUIDS.heart, STEPS)] }));
      expect(mismatched.shape).toEqual([
        "sample-uuid health.jsonl line 1",
        "sample health.jsonl line 1",
        expect.stringMatching(new RegExp(`^health\\.jsonl line 2: the deletion of ${HEALTH_UUIDS.heart} states ${STEPS}; its sample is ${HEART}$`, "u")),
      ]);
      report.mismatched = mismatched.landed;
      artifact(nothing.dir, "health-deletions.json", report);
    } finally {
      for (const db of homes) db.close();
    }
  });

  it("a phone line that does not read takes the lines after it with it, or throws out of the read", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const heart = sample(1, HEALTH_UUIDS.heart, { type: HEART, start: "2026-10-03T03:00:00.875Z", end: "2026-10-03T03:00:00.875Z", quantity: "72 count/min" });
      const steps = sample(2, HEALTH_UUIDS.steps, { type: STEPS, start: "2026-10-03T03:00:00Z", end: "2026-10-03T03:09:59.5Z", quantity: "120 count", device: null });
      const sleep = sample(6, HEALTH_UUIDS.sleep, { type: "HKCategoryTypeIdentifierSleepAnalysis", start: "2026-10-02T20:00:00Z", end: "2026-10-02T21:30:00Z", category: 3, metadata: {} });
      const health = [heart, steps, "not json", '{"domain":"health","kind":"deleted_sample","sequence":4,', deletion(5, HEALTH_UUIDS.steps, STEPS), sleep];
      const location = [entry("location", "recorder_event", 1, "2026-10-03T03:00:00Z", { event: "launch" }), "not json", entry("location", "recorder_event", 3, "2026-10-03T03:02:00Z", { event: "launch" })];
      const sealed = await seal(dir, blobs, bundle("bad-lines", "2026-10-03T09:00:00.250+05:30", { health, location }));
      const shape = (rows: ReaderOutput[]) => rows.map((row) => (row.refused !== undefined ? `${row.key}: ${row.refused}` : row.gone ? `gone ${row.kind}` : `${row.kind} ${row.locator}`));
      const read = { health: shape((await importDelivery(db, blobs, "health", deliveryOf(sealed, "health"))).rows), location: shape((await importDelivery(db, blobs, "location", deliveryOf(sealed, "location"))).rows) };
      expect(read.health).toEqual([
        "sample-uuid health.jsonl line 1", "sample health.jsonl line 1",
        "sample-uuid health.jsonl line 2",
        expect.stringMatching(/^health\.jsonl line 3: health\.jsonl line 3 is not one JSON object: /u),
        expect.stringMatching(/^health\.jsonl line 4: health\.jsonl line 4 is not one JSON object: /u),
        "sample-uuid health.jsonl line 6", "sample health.jsonl line 6",
        "gone sample", "gone sample-uuid",
      ]);
      expect(read.location).toEqual(["recorder location.jsonl line 1", expect.stringMatching(/^location\.jsonl line 2: location\.jsonl line 2 is not one JSON object: /u), "recorder location.jsonl line 3"]);
      artifact(dir, "bad-lines.json", read);
    } finally {
      db.close();
    }
  });

  it("a gone lands that no line states, or a contact's edit lands as a new record or carries its photo again", async () => {
    const dir = temp();
    const { db, imports, shipments: sealed } = await landBoth(dir);
    try {
      const view = db.view();
      const goneStatements = [...view.statements(0)].filter((statement) => statement.version === "gone").map((statement) => `${statement.source} ${statement.kind}:${statement.key}`);
      const book = `apple-contacts:${HEALTH_ACCOUNT}:${UNIT}`;
      expect(goneStatements).toHaveLength(7);
      expect(goneStatements.filter((statement) => !/^apple-health:[^ ]+:cloud sample(?:-uuid)?:/u.test(statement))).toEqual([`${book} contact:${CONTACT_IDS.c}`]);
      const a = { source: book, kind: "contact", key: CONTACT_IDS.a };
      const versions = [...new Set(view.history(a).map((statement) => statement.version))];
      expect(versions).toHaveLength(2);
      expect([...view.heads(book, "contact")]).toHaveLength(2);
      view.close();
      const contacts = imports.filter((entry) => entry.domain === "contacts");
      expect(contacts.map(({ landed }) => [landed.new, landed.changed, landed.gone])).toEqual([[3, 0, 0], [0, 1, 1]]);
      expect(contacts.map(({ shipment }) => sealed.find((each) => each.bundle.name === shipment)!.bundle.members.some((member) => member.name === `blobs/${sha(CONTACT_PHOTO).slice(7)}`))).toEqual([true, false]);
      expect(wanting(dir, sha(CONTACT_PHOTO))).toEqual({ linked: [sha(CONTACT_PHOTO), sha(CONTACT_PHOTO)], wanted: [] });
      expect(heads(db, book, Object.values(CONTACT_IDS).map((id) => `contact:${id}`))).toMatchObject({ [`contact:${CONTACT_IDS.b}`]: { type: "contacts.card" }, [`contact:${CONTACT_IDS.c}`]: "gone" });
      artifact(dir, "gone.json", { gone: goneStatements, contacts: contacts.map(({ shipment, landed }) => ({ shipment, landed: counts(landed) })) as unknown as Json });
    } finally {
      db.close();
    }
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const dir = temp();
    const { db, imports } = await landBoth(dir);
    try {
      const report = imports.map(({ shipment, delivery, rows, landed }) => {
        const keys = rows.map((row) => `${row.kind}:${row.key}`);
        return { shipment, source: delivery.source, rows: rows.length, repeated: keys.length - new Set(keys).size, duplicated: landed.duplicated };
      });
      for (const entry of report) expect(entry.duplicated, `${entry.source} ${entry.shipment}`).toBe(entry.repeated);
      expect(report.filter((entry) => entry.repeated > 0).map((entry) => entry.source)).toEqual([`apple-health:${HEALTH_ACCOUNT}:cloud`]);
      artifact(dir, "duplicated.json", report);
    } finally {
      db.close();
    }
  });

  it("a replayed shipment writes anything", async () => {
    const dir = temp();
    const { db, blobs, shipments } = await landBoth(dir);
    try {
      const statements = (): number => {
        const view = db.view();
        try {
          return [...view.statements(0)].length;
        } finally {
          view.close();
        }
      };
      const before = statements();
      const replay: ReturnType<typeof counts>[] = [];
      for (const sealed of shipments) {
        for (const { domain, delivery } of sealed.deliveries) replay.push(counts((await importDelivery(db, blobs, domain, delivery)).landed));
      }
      expect(statements()).toBe(before);
      expect(replay.every((entry) => entry.new === 0 && entry.changed === 0 && entry.gone === 0 && entry.late === 0)).toBe(true);
      artifact(dir, "replay.json", { statements: before, replay });
    } finally {
      db.close();
    }
  });

  it("an import interrupted after any row and read again from its first row, in its run, lands other heads than one uninterrupted import", async () => {
    const report: Record<string, Json> = {};
    for (const domain of ["health", "photos"]) {
      const connector = CONNECTORS[domain]!;
      for (const [index, bundle] of shipments().entries()) {
        const prepare = async () => {
          const dir = temp();
          const { db, blobs } = home(dir);
          for (const each of shipments().slice(0, index)) await importDelivery(db, blobs, domain, deliveryOf(await seal(dir, blobs, each), domain));
          return { db, blobs, delivery: deliveryOf(await seal(dir, blobs, bundle), domain) };
        };
        const calm = await prepare();
        const { rows } = await importDelivery(calm.db, calm.blobs, domain, calm.delivery);
        const records = [...new Set(rows.map((row) => `${row.kind}:${row.key}`))];
        const expected = heads(calm.db, calm.delivery.source, records);
        calm.db.close();
        for (let at = 1; at < rows.length; at++) {
          const { db, blobs, delivery } = await prepare();
          try {
            const read = async () => {
              const view = db.view();
              try {
                return await collect(connector.read(delivery, blobs, view));
              } finally {
                view.close();
              }
            };
            const run = db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: delivery.source, started_ms: delivery.stated_ms }));
            const first = await read();
            db.commit((tx) => tx.records.land(run, delivery, first.slice(0, at), connector.kinds, { has: () => true }));
            const again = await read();
            expect(again, `${domain} ${bundle.name}: the replay after ${at} rows read other rows`).toEqual(first);
            db.commit((tx) => tx.records.land(run, delivery, again, connector.kinds, { has: () => true }));
            expect(heads(db, delivery.source, records), `${domain} ${bundle.name}: interrupted after ${at} rows`).toEqual(expected);
          } finally {
            db.close();
          }
        }
        report[`${domain} ${bundle.name}`] = { rows: rows.length, interruptions: rows.length - 1, heads: Object.keys(expected).length };
      }
    }
    expect(Object.fromEntries(Object.entries(report).map(([name, entry]) => [name, (entry as { interruptions: number }).interruptions > 0]))).toEqual({
      "health first": true, "health second": true, "photos first": true, "photos second": false,
    });
    artifact(temp(), "replay-interrupted.json", report);
  });

  it("a shipment that arrives before the one it builds on lands a wrong state", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const first = await seal(dir, blobs, firstBundle());
      const second = await seal(dir, blobs, secondBundle());
      const run = (sealed: Sealed, domain: string) => importDelivery(db, blobs, domain, sealed.deliveries.find((entry) => entry.domain === domain)!.delivery);
      const early = await run(second, "health");
      expect(early.rows.filter((row) => row.gone).map((row) => `${row.kind}:${row.key}`)).toEqual([`sample-uuid:${HEALTH_UUIDS.steps}`]);
      expect(early.landed.refusals).toEqual([]);
      const earlyPhotos = await run(second, "photos");
      expect(earlyPhotos.landed.new).toBe(1);
      const late = await run(first, "health");
      const steps = uuidSample(await collect(CONNECTORS.health!.read(deliveryOf(first, "health"), blobs)), HEALTH_UUIDS.steps);
      expect(late.rows.filter((row) => row.gone).map((row) => `${row.kind}:${row.key}`)).toContain(`sample:${steps}`);
      expect(heads(db, HEALTH_SOURCE, [`sample-uuid:${HEALTH_UUIDS.steps}`, `sample:${steps}`])).toEqual({ [`sample-uuid:${HEALTH_UUIDS.steps}`]: "gone", [`sample:${steps}`]: "gone" });
      await run(first, "photos");
      const retried = await run(second, "photos");
      expect(retried.landed.new).toBe(0);
      const again = await run(second, "health");
      expect([again.landed.new, again.landed.changed, again.landed.gone]).toEqual([0, 0, 0]);
      artifact(dir, "out-of-order.json", { early: counts(early.landed), late: counts(late.landed), again: counts(again.landed), early_photos: counts(earlyPhotos.landed), retried: counts(retried.landed) });
    } finally {
      db.close();
    }
  });

  it("a library photo lands with no device, so the photos family never asks about it", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const first = await seal(dir, blobs, firstBundle());
      const { rows } = await importDelivery(db, blobs, "photos", first.deliveries.find((entry) => entry.domain === "photos")!.delivery);
      const images = rows.filter((row) => row.kind === "img");
      expect(images.length).toBeGreaterThan(0);
      expect(images.every((row) => row.device === UNIT)).toBe(true);
      artifact(dir, "photo-device.json", { images: images.map((row) => ({ key: row.key, device: row.device })) });
    } finally {
      db.close();
    }
  });

  it("a camera row whose blob the home does not hold is refused, or lands without wanting its file", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const second = secondBundle();
      second.stored = {};
      const sealed = await seal(dir, blobs, second);
      const camera = sealed.deliveries.find((entry) => entry.domain === "camera")!;
      const { rows, landed } = await importDelivery(db, blobs, "camera", camera.delivery);
      const named = rows.flatMap((row) => row.blobs ?? []).filter((hash) => !blobs.has(hash));
      expect(named).toEqual([sha(CAMERA_STORED)]);
      expect(landed.refused).toBe(0);
      const missing = wanting(dir, named[0]!);
      expect(missing).toEqual({ linked: named, wanted: [`camera:local:${UNIT} img ${rows.find((row) => row.blobs?.includes(named[0]!))!.key}`] });
      blobs.put(CAMERA_STORED);
      expect(db.commit((tx) => tx.records.blobsArrived(named, {}))).toBe(1);
      expect(wanting(dir, named[0]!).wanted).toEqual([]);
      artifact(dir, "missing-blob.json", { named, ...missing, landed: { new: landed.new, refused: landed.refused } });
    } finally {
      db.close();
    }
  });

  it("a location gap lands without the span it states, or among the recorder's events", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const gap = (sequence: number, payload: object) => ({
        schema_version: 1, domain: "location", kind: "gap", sequence, observed_at: "2026-10-03T02:02:07.125Z",
        captured: { wall_rfc3339: "2026-10-03T08:40:00.125+05:30", wall_unix_seconds: 1791002400.125, elapsed_seconds: 1000.5 },
        process_instance_id: "00000000-0000-4000-8000-0000000000c1", payload,
      });
      const read = async (name: string, line: object) => {
        const sealed = await seal(dir, blobs, bundle(name, "2026-10-03T09:00:00.250+05:30", { location: [line] }));
        const view = db.view();
        try {
          const rows = await collect(CONNECTORS.location!.read(sealed.deliveries.find((entry) => entry.domain === "location")!.delivery, blobs, view));
          return { rows, why: rows[0]?.refused };
        } finally {
          view.close();
        }
      };
      const stated = await read("whole", gap(70, { start: "2026-10-03T02:02:07.125Z", end: "2026-10-03T02:03:01.5Z", reason: "unknown_process_absence" }));
      expect(stated.rows?.map((row) => ({ kind: row.kind, type: (row.content as JsonObject).type, time: row.time }))).toEqual([
        { kind: "gap", type: "location.gap", time: span(instant("2026-10-03T02:02:07.125Z", "rfc3339"), instant("2026-10-03T02:03:01.5Z", "rfc3339")) },
      ]);
      const unended = await read("unended", gap(71, { start: "2026-10-03T02:02:07.125Z", reason: "unknown_process_absence" }));
      const backwards = await read("backwards", gap(72, { start: "2026-10-03T02:03:01.5Z", end: "2026-10-03T02:02:07.125Z", reason: "unknown_process_absence" }));
      expect([unended.why, backwards.why]).toEqual([
        expect.stringMatching(/\.payload\.end must be an RFC 3339 instant$/u),
        expect.stringMatching(/\.payload: a span must not end before it starts$/u),
      ]);
      artifact(dir, "gap-kind.json", { stated: stated.rows!.map((row) => ({ kind: row.kind, key: row.key, time: row.time as unknown as Json })), unended: unended.why!, backwards: backwards.why! });
    } finally {
      db.close();
    }
  });

  it("a line the phone writes now is refused, or a line naming a boot or a delivery sealed as one ZIP is read", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const NOW = `{"captured":{"elapsed_seconds":42.5,"wall_rfc3339":"2026-10-03T05:00:00.125000000Z","wall_unix_seconds":1791003600.125},"domain":"checkin","kind":"prompt","observed_at":"2026-10-03T03:30:00.125Z","payload":{"event":"delivered","form":"moment","prompt_id":"20000000-0000-4000-8000-000000000001","scheduled_for":"2026-10-03T03:30:00Z","trigger":"random","window_end":"2026-10-03T04:00:00Z","window_start":"2026-10-03T03:00:00Z"},"process_instance_id":"00000000-0000-4000-8000-0000000000C1","schema_version":1,"sequence":1}`;
      const now = JSON.parse(NOW) as JsonObject;
      const shipment = bundle("clock", "2026-10-03T10:40:00+05:30", { checkin: [now] });
      expect(shipment.members.find((member) => member.name === "checkin.jsonl")!.bytes.toString("utf8")).toBe(`${NOW}\n`);
      const delivery = deliveryOf(await seal(dir, blobs, shipment), "checkin");
      const { rows, landed } = await importDelivery(db, blobs, "checkin", delivery);
      expect(counts(landed)).toMatchObject({ new: 1, refused: 0 });
      expect((rows[0]!.content as JsonObject).content).toEqual(now);

      const { elapsed_seconds: _, ...wall } = now.captured as JsonObject;
      const uptime = { ...wall, monotonic_seconds: 1000.5 };
      const recorder = entry("location", "recorder_event", 1, "2026-10-03T03:30:00.125Z", { event: "launch" }) as JsonObject;
      const refused: Record<string, string> = {};
      const read: Record<string, number> = {};
      for (const line of [now, recorder]) {
        const domain = line.domain as string;
        const before = { ...line, boot_id: BOOT, captured: uptime };
        const sealed = deliveryOf(await seal(dir, blobs, bundle(`${domain}-boot`, "2026-10-03T10:40:00+05:30", { [domain]: [before] })), domain);
        const imported = await importDelivery(db, blobs, domain, sealed);
        expect(counts(imported.landed)).toMatchObject({ refused: 0 });
        expect(imported.rows.map((row) => (row.content as JsonObject).content ?? row.content)).toContainEqual(before);
        read[domain] = imported.rows.length;
        for (const [name, mixed] of Object.entries({ boot_only: { ...line, boot_id: BOOT }, uptime_only: { ...line, captured: uptime }, both: { ...line, boot_id: BOOT, captured: { ...uptime, elapsed_seconds: 42.5 } } })) {
          const bad = deliveryOf(await seal(dir, blobs, bundle(`${domain}-${name}`, "2026-10-03T10:40:00+05:30", { [domain]: [mixed] })), domain);
          const { rows: lines } = await importDelivery(db, blobs, domain, bad);
          expect(lines.map((row) => `${row.key}: ${row.refused}`)).toEqual([`${domain}.jsonl line 1: ${domain}.jsonl line 1 mixes its clocks; a line states captured.elapsed_seconds and no boot, or boot_id with captured.monotonic_seconds`]);
          refused[`${domain} ${name}`] = lines[0]!.refused!;
        }
      }
      const folder = { ...now, domain: "notes", kind: "folder", payload: { id: "00000000-0000-4000-8000-00000000f001", name: "Synthetic folder", parent: null, sort_index: 1, default: false, created: "2026-10-03T03:00:00Z", modified: "2026-10-03T03:00:00Z", deleted: false } };
      expect([
        CONNECTORS.checkin!.kinds.prompt!({ type: "checkin.prompt", content: now }),
        CONNECTORS.notes!.kinds.folder!({ type: "notes.folder", content: folder }),
        CONNECTORS.checkin!.kinds.prompt!({ type: "checkin.prompt", content: { ...now, boot_id: BOOT, captured: uptime } }),
        CONNECTORS.notes!.kinds.folder!({ type: "notes.folder", content: { ...folder, boot_id: BOOT, captured: uptime } }),
        CONNECTORS.checkin!.kinds.prompt!({ type: "checkin.prompt", content: { ...now, boot_id: BOOT } }),
        CONNECTORS.notes!.kinds.folder!({ type: "notes.folder", content: { ...folder, captured: uptime } }),
      ]).toEqual([[], [], [], [], ["content.content must be the app's checkin line, every member"], ["content.content must be the app's notes line, every member"]]);

      const zip = readFileSync(join(dir, "clock.zip"));
      const whole = { path: "bundle.zip", blob: blobs.put(zip), size: zip.length };
      for (const files of [[whole], [...delivery.files, whole]]) {
        await expect(importDelivery(db, blobs, "checkin", { ...delivery, files })).rejects.toMatchObject({ name: "Refused", message: expect.stringContaining("holds its members under bundle/") });
      }
      artifact(dir, "phone-clock.json", { landed: counts(landed) as unknown as Json, read, refused });
    } finally {
      db.close();
    }
  });

  it("a check-in of a kind this connector does not know, or one whose instant core cannot read, takes the check-ins after it with it, or lands", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const prompt = { event: "delivered", form: "moment", prompt_id: "20000000-0000-4000-8000-000000000001", scheduled_for: "2026-10-03T03:30:00Z", trigger: "random", window_end: "2026-10-03T04:00:00Z", window_start: "2026-10-03T03:00:00Z" };
      const line = (sequence: number, kind: string, observed_at: string, payload: object) => ({
        captured: { elapsed_seconds: 42.5, wall_rfc3339: "2026-10-03T05:00:00.125Z", wall_unix_seconds: 1791003600.125 },
        domain: "checkin", kind, observed_at, payload, process_instance_id: "00000000-0000-4000-8000-0000000000c1", schema_version: 1, sequence,
      });
      const lines = [
        line(1, "mood_ring", "2026-10-03T03:30:00.125Z", { colour: "synthetic" }),
        line(2, "prompt", "2026-10-03T25:30:00.125Z", prompt),
        line(3, "prompt", "2026-10-03T03:31:00.125Z", prompt),
      ];
      const { rows, landed } = await importDelivery(db, blobs, "checkin", deliveryOf(await seal(dir, blobs, bundle("checkin-kinds", "2026-10-03T10:40:00+05:30", { checkin: lines })), "checkin"));
      expect(counts(landed)).toMatchObject({ new: 1, refused: 2 });
      expect(rows.filter((row) => row.refused !== undefined).map((row) => `${row.key}: ${row.refused}`)).toEqual([
        expect.stringMatching(/^checkin\.jsonl line 1: .*a checkin entry kind this connector does not know: "mood_ring"$/u),
        expect.stringMatching(/^checkin\.jsonl line 2: checkin\.jsonl line 2\.observed_at "2026-10-03T25:30:00\.125Z"/u),
      ]);
      expect(rows.filter((row) => row.refused === undefined).map((row) => row.locator)).toEqual(["checkin.jsonl line 3"]);
      artifact(dir, "checkin-lines.json", counts(landed) as unknown as Json);
    } finally {
      db.close();
    }
  });

  it("a contacts line reads a blob's bytes, a line of a kind it does not know is read, or a line that does not read takes another with it", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const photo = Buffer.from("synthetic heic bytes of a photo the home holds already");
      const carried = Buffer.from("synthetic heic bytes of a photo this bundle carries");
      blobs.put(photo);
      const card = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Person D\r\nTEL:+15550000004\r\nEND:VCARD\r\n";
      const at = "2026-10-03T03:00:00Z";
      const ref = (bytes: Buffer, size = bytes.length) => ({ hash: sha(bytes), bytes: size, media_type: "image/heic" });
      const lines = [
        contactCard(1, at, "D", card, photo),
        entry("contacts", "group", 2, at, { id: "D" }),
        entry("contacts", "card", 3, at, { id: "E", card, serializer: "SomeOtherSerializer" }),
        entry("contacts", "card", 4, at, { id: "F", card: card + card, serializer: "CNContactVCardSerialization" }),
        entry("contacts", "card", 5, at, { id: "G", card, serializer: "CNContactVCardSerialization", photo: ref(carried, carried.length + 1) }),
        entry("contacts", "card", 6, at, { id: "", card, serializer: "CNContactVCardSerialization" }),
        entry("contacts", "gone", 7, at, { id: "D", card }),
        contactCard(8, at, "H", card, carried),
        contactGone(9, at, "D"),
      ];
      const shipment = bundle("contact-lines", "2026-10-03T05:00:00Z", { contacts: lines }, [carried]);
      const loose = deliveryOf(await seal(dir, blobs, shipment), "contacts");
      const members = new Set(loose.files.map((file) => file.blob));
      const reads: string[] = [];
      const watched = { has: blobs.has.bind(blobs), prefix: blobs.prefix.bind(blobs), text: blobs.text.bind(blobs), materialise: blobs.materialise.bind(blobs),
        bytes: (blob: string) => { reads.push(blob); return blobs.bytes(blob); } };
      const rows = await collect(CONNECTORS.contacts!.read(loose, watched));
      expect(rows.map((row) => (row.refused === undefined ? `${row.gone === true ? "gone" : row.kind} ${row.key} ${row.locator} ${(row.blobs ?? []).join(",")}` : `${row.key}: ${row.refused}`))).toEqual([
        `contact D contacts.jsonl line 1 ${sha(photo)}`,
        expect.stringMatching(/^contacts\.jsonl line 2: .* kind this connector does not know: "group"$/u),
        expect.stringMatching(/^contacts\.jsonl line 3: .*serializer must be CNContactVCardSerialization$/u),
        expect.stringMatching(/^contacts\.jsonl line 4: .*card must be one vCard$/u),
        expect.stringMatching(/^contacts\.jsonl line 5: .* states \d+ bytes for a photo of \d+$/u),
        expect.stringMatching(/^contacts\.jsonl line 6: .* is not a contact card/u),
        expect.stringMatching(/^contacts\.jsonl line 7: .* is not a contact gone/u),
        `contact H contacts.jsonl line 8 ${sha(carried)}`,
        "gone D contacts.jsonl line 9 ",
      ]);
      expect(rows.find((row) => row.key === "H")!.media).toEqual({ [sha(carried)]: "image/heic" });
      expect(reads.filter((blob) => !members.has(blob))).toEqual([]);
      const manifest = Buffer.alloc(16 * MiB + 1, 0x20);
      const files = [{ path: "bundle/manifest.json", blob: blobs.put(manifest, { mediaType: "application/json" }), size: manifest.length }];
      await expect(collect(CONNECTORS.contacts!.read({ ...loose, files }, blobs))).rejects.toMatchObject({ name: "Refused", message: expect.stringContaining("bundle/manifest.json holds") });
      const stored = loose.files.find((file) => file.path === "bundle/manifest.json")!.blob;
      const damaged = { ...watched, bytes: (blob: string) => (blob === stored ? (() => { throw new BlobError("BLOB_CORRUPT", `${blob} is damaged`); })() : blobs.bytes(blob)) };
      await expect(collect(CONNECTORS.contacts!.read(loose, damaged))).rejects.toMatchObject({ name: "BlobError", code: "BLOB_CORRUPT" });
      artifact(dir, "contact-lines.json", { rows: rows.map((row) => ({ key: row.key, refused: row.refused ?? null, gone: row.gone ?? false })) as unknown as Json, blob_reads: reads.filter((blob) => !members.has(blob)).length });
    } finally { db.close(); }
  });

  it("a contacts line the phone writes (its ContactsLogTests' own, test/phone-contacts.json) is refused, or its record's head is not its last line", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      type PhoneLine = { kind: string; sequence: number; payload: { id?: string; card?: string; photo?: { hash: string; bytes: number; media_type: string } } };
      const phone = JSON.parse(readFileSync(new URL("./test/phone-contacts.json", import.meta.url), "utf8")) as { lines: string[]; photos: string[] };
      const lines = phone.lines.map((line) => JSON.parse(line) as PhoneLine);
      const photos = new Map(phone.photos.map((photo) => Buffer.from(photo, "base64")).map((bytes) => [sha(bytes), bytes]));
      expect(new Set(lines.map((line) => (line.kind === "card" && line.payload.photo !== undefined ? "card with a photo" : line.kind)))).toEqual(new Set(["access", "card with a photo", "card", "gone"]));
      const shipments: PhoneLine[][] = [[]];
      for (const line of lines) {
        if (line.payload.id !== undefined && shipments.at(-1)!.some((each) => each.payload.id === line.payload.id)) shipments.push([]);
        shipments.at(-1)!.push(line);
      }
      const carried = new Set<string>();
      const landed: Json[] = [];
      for (const [index, shipment] of shipments.entries()) {
        const named = [...new Set(shipment.flatMap((line) => (line.payload.photo === undefined ? [] : [line.payload.photo.hash])))].filter((hash) => !carried.has(hash));
        for (const hash of named) carried.add(hash);
        const sealed = await seal(dir, blobs, bundle(`phone-contacts-${index}`, `2027-01-15T09:0${index}:00Z`, { contacts: shipment }, named.map((hash) => photos.get(hash)!)));
        const { rows, landed: each } = await importDelivery(db, blobs, "contacts", deliveryOf(sealed, "contacts"));
        expect(rows.filter((row) => row.refused !== undefined)).toEqual([]);
        expect(rows.map((row) => `${row.gone === true ? "gone" : "card"} ${row.key}`)).toEqual(shipment.filter((line) => line.kind !== "access").map((line) => `${line.kind} ${line.payload.id}`));
        landed.push(counts(each) as unknown as Json);
      }
      expect(carried).toEqual(new Set(photos.keys()));
      const last = new Map(lines.filter((line) => line.kind !== "access").map((line) => [`contact:${line.payload.id}`, line]));
      expect(heads(db, `apple-contacts:${HEALTH_ACCOUNT}:${UNIT}`, [...last.keys()])).toEqual(Object.fromEntries([...last].map(([record, line]) => [record,
        line.kind === "gone" ? "gone" : { type: "contacts.card", card: line.payload.card!, ...(line.payload.photo === undefined ? {} : { photo: line.payload.photo }) }])));
      for (const hash of carried) expect(wanting(dir, hash).wanted).toEqual([]);
      artifact(dir, "phone-contacts.json", { shipments: shipments.length, landed });
    } finally {
      db.close();
    }
  });
});

describe("State of Mind and medication doses from the phone: each of these is impossible", () => {
  const SOURCE = `apple-health:${HEALTH_ACCOUNT}:cloud`;
  const RECORDS = [`state-of-mind:${MIND_UUIDS.momentary}`, `state-of-mind:${MIND_UUIDS.daily}`, `state-of-mind:${MIND_UUIDS.unknown}`, `dose:${DOSE_UUIDS.taken}`, `dose:${DOSE_UUIDS.doomed}`];

  async function landInOrder(dir: string, bundles: SyntheticBundle[]) {
    const { db, blobs } = home(dir);
    const imports: { shipment: string; rows: ReaderOutput[]; landed: Landed }[] = [];
    for (const synthetic of bundles) {
      const sealed = await seal(dir, blobs, synthetic);
      imports.push({ shipment: synthetic.name, ...(await importDelivery(db, blobs, "health", deliveryOf(sealed, "health"))) });
    }
    return { db, blobs, imports };
  }

  it("a State of Mind or a dose lands under any key but its UUID, or loses a field the phone stated", async () => {
    const dir = temp();
    const { db, imports } = await landInOrder(dir, mindAndDoseShipments().slice(0, 1));
    try {
      const [first] = imports;
      const landed = heads(db, SOURCE, RECORDS);
      const [momentary] = mindAndDoseShipments()[0]!.members.filter((member) => member.name === "health.jsonl").map((member) => member.bytes.toString("utf8").split("\n")[0]!);
      const { secure_archive_base64: _archive, ...stated } = (JSON.parse(momentary!) as { payload: JsonObject }).payload;
      expect(landed[`state-of-mind:${MIND_UUIDS.momentary}`]).toEqual({ type: "health.state-of-mind", ...stated });
      expect((landed[`state-of-mind:${MIND_UUIDS.momentary}`] as JsonObject).state_of_mind).toEqual({ kind: 1, valence: -0.4, valence_classification: 3, labels: [4, 29, 99], associations: [17, 6] });
      const dose = landed[`dose:${DOSE_UUIDS.taken}`] as JsonObject;
      expect(dose).toMatchObject({ type: "health.dose", uuid: DOSE_UUIDS.taken, sample_type: DOSE, medication_dose_event: { log_status: 4, schedule_type: 2, dose_quantity: 1.5, unit: "count", medication: { display_text: "Synthetic Medication A 10 mg Tablet", general_form: "tablet" } } });
      expect(dose.secure_archive_base64).toBeUndefined();
      expect(landed[`dose:${DOSE_UUIDS.doomed}`]).toBe("gone");
      expect(landed[`state-of-mind:${MIND_UUIDS.unknown}`]).toBe("gone");
      expect(first!.landed.refusals).toEqual([]);
      const momentaryRow = first!.rows.find((row) => row.key === MIND_UUIDS.momentary)!;
      expect(momentaryRow.time).toEqual(span(instant("2026-10-03T03:15:00.123456789Z", "rfc3339"), instant("2026-10-03T03:15:00.123456789Z", "rfc3339")));
      expect(momentaryRow).toMatchObject({ device: UNIT, locator: "health.jsonl line 1" });
      expect(first!.rows.map((row) => row.kind).sort()).toEqual(["dose", "dose", "medication", "medication", "state-of-mind", "state-of-mind", "state-of-mind"]);
      expect(counts(first!.landed)).toMatchObject({ new: 5, gone: 2, refused: 0, duplicated: 0 });
      artifact(dir, "mind-and-dose.json", { heads: landed, landed: counts(first!.landed) });
    } finally {
      db.close();
    }
  });

  it("a later shipment's deletion leaves its State of Mind live, or a restated dose writes anything", async () => {
    const dir = temp();
    const { db, imports } = await landInOrder(dir, mindAndDoseShipments());
    try {
      const second = imports[1]!;
      expect(second.rows.filter((row) => row.gone)).toEqual([{ kind: "state-of-mind", key: MIND_UUIDS.daily, content: null, gone: true, device: UNIT }]);
      expect(counts(second.landed)).toMatchObject({ new: 0, changed: 1, gone: 1, restated: 1, refused: 0 });
      const landed = heads(db, SOURCE, RECORDS);
      expect(landed[`state-of-mind:${MIND_UUIDS.daily}`]).toBe("gone");
      expect(landed[`state-of-mind:${MIND_UUIDS.momentary}`]).not.toBe("gone");
      const before = (() => { const view = db.view(); try { return [...view.statements(0)].length; } finally { view.close(); } })();
      const { blobs } = home(dir);
      const replay = [];
      for (const synthetic of mindAndDoseShipments()) replay.push(counts((await importDelivery(db, blobs, "health", deliveryOf(await seal(dir, blobs, synthetic), "health"))).landed));
      const after = (() => { const view = db.view(); try { return [...view.statements(0)].length; } finally { view.close(); } })();
      expect(after).toBe(before);
      expect(replay.every((entry) => entry.new === 0 && entry.changed === 0 && entry.gone === 0)).toBe(true);
      artifact(dir, "mind-and-dose-later.json", { heads: landed, second: counts(second.landed), replay });
    } finally {
      db.close();
    }
  });

  it("a medication's key moves when the person renames it or its codes come in another order, or a list without it states it gone", async () => {
    const dir = temp();
    const { db, imports } = await landInOrder(dir, mindAndDoseShipments());
    try {
      const [first, second] = imports;
      const medications = (rows: ReaderOutput[]) => rows.filter((row) => row.kind === "medication");
      const [a, b] = medications(first!.rows);
      expect(medications(second!.rows).map((row) => row.key)).toEqual([a!.key]);
      expect(a!.key).not.toBe(b!.key);
      expect(a).toMatchObject({ device: UNIT, locator: "health.jsonl line 7" });
      expect(a!.time).toBeUndefined();
      const landed = heads(db, SOURCE, [`medication:${a!.key}`, `medication:${b!.key}`]);
      expect(landed[`medication:${a!.key}`]).toMatchObject({ type: "health.medication", nickname: "Evening pill", is_archived: true, has_schedule: true });
      expect(landed[`medication:${b!.key}`]).toEqual({ type: "health.medication", ...(medications(first!.rows)[1]!.content as JsonObject) });
      const { blobs } = home(dir);
      const kept = { nickname: null, is_archived: false, has_schedule: false, concept: { display_text: "Synthetic Medication C", general_form: "tablet", related_codings: [] }, concept_identifier: { domain: "HKHealthConceptDomainMedication", archive_base64: null } };
      const sealed = await seal(dir, blobs, bundle("list-shapeless", "2026-10-03T11:00:00.250+05:30", { health: [medicationList(401, [{ nickname: null, is_archived: false, has_schedule: false, concept: null, concept_identifier: null }, kept])] }));
      const rows = await collect(CONNECTORS.health!.read(deliveryOf(sealed, "health"), blobs, db.view()));
      expect(rows.map((row) => `${row.kind} ${row.key}`)).toEqual(["file health.jsonl line 1.payload.medications[0]", expect.stringMatching(/^medication sha256:[0-9a-f]{64}$/u)]);
      const refusal = rows[0]!.refused!;
      expect(refusal).toMatch(/^health\.jsonl line 1\.payload\.medications\[0\]\.concept/u);
      artifact(dir, "medications.json", { heads: landed, first: counts(first!.landed), second: counts(second!.landed), refusal });
    } finally {
      db.close();
    }
  });

  it("a State of Mind without its members lands, or takes its shipment's other records down with it", async () => {
    const dir = temp();
    const shapeless = stateOfMind(201, MIND_UUIDS.malformed, "2026-10-03T03:40:00Z", { kind: 1, valence: "pleasant", valence_classification: 3, labels: [], associations: [] });
    const typed = stateOfMind(202, MIND_UUIDS.unknown, "2026-10-03T03:41:00Z", { kind: 1, valence: 0, valence_classification: 4, labels: [], associations: [] });
    (typed as { payload: JsonObject }).payload.type = "a source member named type";
    const { db, imports } = await landInOrder(dir, [bundle("mind-shapeless", "2026-10-03T09:00:00.250+05:30", { health: [shapeless, typed, doseEvent(203, DOSE_UUIDS.taken, "2026-10-03T03:05:00.5Z", {})] })]);
    try {
      const [only] = imports;
      expect(counts(only!.landed)).toMatchObject({ new: 1, refused: 2 });
      expect(heads(db, SOURCE, [`dose:${DOSE_UUIDS.taken}`, `state-of-mind:${MIND_UUIDS.malformed}`, `state-of-mind:${MIND_UUIDS.unknown}`])).toEqual({ [`dose:${DOSE_UUIDS.taken}`]: expect.anything() });
      artifact(dir, "mind-refused.json", counts(only!.landed));
    } finally {
      db.close();
    }
  });

  it("a State of Mind with no instant, or a deletion naming another type than its sample, lands, or takes the lines beside it with it", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const refusals = async (name: string, health: object[]) => {
        const sealed = await seal(dir, blobs, bundle(name, "2026-10-03T09:00:00.250+05:30", { health }));
        const view = db.view();
        try {
          const rows = await collect(CONNECTORS.health!.read(deliveryOf(sealed, "health"), blobs, view));
          return rows.map((row) => (row.refused === undefined ? `${row.kind} ${row.key}` : `${row.key}: ${row.refused}`));
        } finally {
          view.close();
        }
      };
      const timeless = stateOfMind(301, MIND_UUIDS.malformed, "2026-10-03T03:40:00Z", { kind: 1, valence: 0, valence_classification: 4, labels: [], associations: [] });
      (timeless as { payload: JsonObject }).payload.start_date_rfc3339 = "yesterday";
      const beside = doseEvent(302, DOSE_UUIDS.taken, "2026-10-03T03:05:00.5Z", {});
      const deletedAsDose = [stateOfMind(303, MIND_UUIDS.malformed, "2026-10-03T03:40:00Z", { kind: 1, valence: 0, valence_classification: 4, labels: [], associations: [] }), { domain: "health", kind: "deleted_sample", sequence: 304, captured: { wall_rfc3339: "2026-10-03T03:45:00Z" }, payload: { uuid: MIND_UUIDS.malformed, sample_type: DOSE, deletion_reported_at: "2026-10-03T03:45:00Z" } }];
      const lines = { timeless: await refusals("mind-timeless", [timeless, beside]), mismatched: await refusals("mind-mismatched", deletedAsDose) };
      expect(lines.timeless).toEqual([expect.stringMatching(/^health\.jsonl line 1: health\.jsonl line 1\.payload\.start "yesterday"/u), `dose ${DOSE_UUIDS.taken}`]);
      expect(lines.mismatched).toEqual([`state-of-mind ${MIND_UUIDS.malformed}`, expect.stringMatching(new RegExp(`^health\\.jsonl line 2: the deletion of .*${DOSE}; its sample is ${STATE_OF_MIND}`, "u"))]);
      artifact(dir, "mind-refusals.json", lines);
    } finally {
      db.close();
    }
  });
});

function uuidSample(rows: ReaderOutput[], uuid: string): string {
  const locator = rows.find((row) => row.kind === "sample-uuid" && row.key === uuid)!.locator;
  return rows.find((row) => row.kind === "sample" && row.locator === locator)!.key;
}

describe("the phone's notes", () => {
  const SOURCE = `notes:local:${UNIT}`;
  const NOTE = "00000000-0000-4000-8000-00000000e001";
  const FOLDER = "00000000-0000-4000-8000-00000000f001";
  const ATTACHED = "00000000-0000-4000-8000-00000000a001";
  const RICH_ONE = Buffer.from("a synthetic rich-text archive, first edit");
  const RICH_TWO = Buffer.from("a synthetic rich-text archive, second edit");
  const PICTURE = Buffer.from("fake png bytes of a synthetic note attachment");
  const folder = (sequence: number, deleted = false) => entry("notes", "folder", sequence, "2026-10-03T03:00:00Z",
    { id: FOLDER, name: "Synthetic folder", parent: null, sort_index: 1, default: false, created: "2026-10-03T03:00:00Z", modified: "2026-10-03T03:00:00Z", deleted });
  const note = (sequence: number, rich: Buffer, changes: object = {}) => entry("notes", "note", sequence, "2026-10-03T03:10:00Z", {
    id: NOTE, folder: FOLDER, title: "A synthetic note", text: "A synthetic note\nits body", created: "2026-10-03T03:05:00Z", modified: "2026-10-03T03:10:00Z",
    pinned: false, pin_order: 0, deleted_at: null, purged: false, rich: { hash: sha(rich), bytes: rich.length }, attachments: [], ...changes,
  });

  it("a note lands with its blobs, an edit and a move restate it, Recently Deleted keeps it, a purge states it gone", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const land = async (name: string, lines: object[], carried: Buffer[]) => {
        const sealed = await seal(dir, blobs, bundle(name, "2026-10-03T09:00:00.250+05:30", { notes: lines }, carried));
        return importDelivery(db, blobs, "notes", deliveryOf(sealed, "notes"));
      };
      const attachment = { id: ATTACHED, filename: "picture.png", uti: "public.png", blob: { hash: sha(PICTURE), bytes: PICTURE.length } };
      const first = await land("notes-first", [folder(1), note(2, RICH_ONE), note(3, RICH_ONE, { attachments: [attachment], modified: "2026-10-03T03:12:00Z" })], [RICH_ONE, PICTURE]);
      expect(counts(first.landed)).toMatchObject({ new: 2, refused: 0, duplicated: 0 });
      const landed = first.rows.find((row) => row.kind === "note")!;
      expect(landed.blobs).toEqual([sha(RICH_ONE), sha(PICTURE)]);
      expect(landed.time).toMatchObject({ start_ms: Date.parse("2026-10-03T03:05:00Z"), end_ms: Date.parse("2026-10-03T03:12:00Z") });
      const edited = await land("notes-edit", [note(4, RICH_TWO, { attachments: [attachment], modified: "2026-10-03T03:20:00Z", folder: null })], [RICH_TWO]);
      expect(counts(edited.landed)).toMatchObject({ changed: 1, refused: 0 });
      const binned = await land("notes-binned", [note(5, RICH_TWO, { attachments: [attachment], deleted_at: "2026-10-03T03:30:00Z", folder: null })], []);
      expect(counts(binned.landed)).toMatchObject({ changed: 1 });
      expect(heads(db, SOURCE, [`note:${NOTE}`])[`note:${NOTE}`]).toMatchObject({ type: "notes.note" });
      const purged = await land("notes-purged", [note(6, RICH_TWO, { purged: true }), folder(7, true)], []);
      expect(counts(purged.landed)).toMatchObject({ gone: 2, refused: 0 });
      expect(heads(db, SOURCE, [`note:${NOTE}`, `folder:${FOLDER}`])).toEqual({ [`note:${NOTE}`]: "gone", [`folder:${FOLDER}`]: "gone" });
      const lost = Buffer.from("an archive no one carried");
      const missing = await land("notes-missing", [note(8, lost), folder(9)], []);
      expect(missing.rows.map((row) => row.kind)).toEqual(["note", "folder"]);
      expect(counts(missing.landed)).toMatchObject({ changed: 2, refused: 0 });
      const wanted = wanting(dir, sha(lost));
      expect(wanted).toEqual({ linked: [sha(lost)], wanted: [`${SOURCE} note ${NOTE}`] });
      blobs.put(lost);
      expect(db.commit((tx) => tx.records.blobsArrived([sha(lost)], {}))).toBe(1);
      expect(wanting(dir, sha(lost)).wanted).toEqual([]);
      artifact(dir, "notes.json", { first: counts(first.landed), edited: counts(edited.landed), binned: counts(binned.landed), purged: counts(purged.landed), missing: counts(missing.landed), wanted });
    } finally {
      db.close();
    }
  });
});
