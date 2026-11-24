import { artifact, collect, MiB, readGolden, temp, writeZip } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, instant, openHome, openHomeFolder, type BlobStore, type Delivery, type HomeDb, type Instant, type Json, type JsonObject, type Landed, type ReaderOutput } from "@lifestreamprotocol/core";
import { readers as healthReaders } from "./index.js";
import { bundle, sealedFiles } from "../../ios-app/phone.test-support.js";
import { NATIVE_UNITS } from "./samples.js";
import { healthExport } from "./export.js";
import { EXPORT_AT, exportRecords, exportXml, SOURCE } from "./health.test-support.js";

const GOLDEN = readGolden(new URL("./test/parity.golden.json", import.meta.url));

function home(dir: string): { db: HomeDb; blobs: BlobStore } {
  return { db: openHome(openHomeFolder(dir), "migrate"), blobs: openHomeFolder(dir).blobs(join(dir, "blobs")) };
}

async function deliver(dir: string, blobs: BlobStore, name: string, xml: string | (() => Iterable<Buffer>), form: "xml" | "zip", exported_at = EXPORT_AT): Promise<Delivery> {
  const chunks = typeof xml === "string" ? () => [Buffer.from(xml)] : xml;
  let path: string;
  let file: string;
  if (form === "xml") {
    path = join(dir, `${name}.xml`);
    writeFileSync(path, Buffer.concat([...chunks()]));
    file = "export.xml";
  } else {
    path = join(dir, `${name}.zip`);
    writeZip(path, [
      { name: "apple_health_export/export.xml", bytes: chunks, method: "deflate" },
      { name: "apple_health_export/export_cda.xml", bytes: Buffer.from("<ClinicalDocument/>\n"), method: "deflate" },
      { name: "apple_health_export/workout-routes/route_2026-10-03_7.00am.gpx", bytes: Buffer.from("<gpx/>\n") },
    ]);
    file = "export.zip";
  }
  const blob = await blobs.putFile(path);
  const stated_ms = instant(exported_at, "rfc3339").start_ms;
  return { id: `${SOURCE}/${name}`, source: SOURCE, sealed_ms: stated_ms, stated_ms, facts: { exported_at }, files: [{ path: file, blob, size: 0 }] };
}

function land(db: HomeDb, delivery: Delivery, rows: ReaderOutput[], kinds = healthExport.kinds): Landed {
  return db.commit((tx) => {
    const run = tx.tables.runs.start({ kind: "import", subject: delivery.source, started_ms: delivery.stated_ms });
    const landed = tx.records.land(run, delivery, rows, kinds, { has: () => true });
    tx.tables.runs.end(run, { ended_ms: delivery.stated_ms, outcome: "ok" });
    return landed;
  });
}

function state(rows: readonly { kind: string; key: string; content?: Json; time?: Instant | null }[]): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const row of rows) out[`${row.kind}:${row.key}`] = { content: row.content ?? null, time: row.time === undefined || row.time === null ? null : ({ ...row.time } as JsonObject) };
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function golden(): Record<string, Json> {
  return state(GOLDEN);
}

const counts = (landed: Landed) => ({ new: landed.new, restated: landed.restated, changed: landed.changed, late: landed.late, gone: landed.gone, refused: landed.refused, duplicated: landed.duplicated });

async function refusal(read: () => Promise<ReaderOutput[]>): Promise<{ words: string; unit: string; landed: number }> {
  const rows = await read();
  const refused = rows.filter((row) => row.refused !== undefined);
  expect(refused).toHaveLength(1);
  const [row] = refused as [ReaderOutput];
  return { words: row.refused!, unit: row.key === "export.xml" ? "file" : row.key.split(" ")[1]!, landed: rows.length - 1 };
}

describe("the Apple Health export connector: each of these is impossible", () => {
  it("the parity golden differs", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const expected = golden();
      const forms: Record<string, Json> = {};
      for (const form of ["xml", "zip"] as const) {
        const rows = await collect(healthExport.read(await deliver(dir, blobs, `export-${form}`, exportXml(), form), blobs));
        expect(canonical(state(rows)), form).toBe(canonical(expected));
        forms[form] = rows.length;
      }
      artifact(dir, "parity.json", { forms, records: Object.keys(expected) });
    } finally {
      db.close();
    }
  });

  it("a synthetic delivery lands different heads than expected", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const delivery = await deliver(dir, blobs, "export", exportXml(), "zip");
      const landed = land(db, delivery, await collect(healthExport.read(delivery, blobs)));
      expect(counts(landed)).toMatchObject({ new: 18, refused: 0, duplicated: 0 });
      const view = db.view();
      const heads: Record<string, Json> = {};
      for (const kind of ["sample", "workout", "day-summary", "characteristic"]) for (const { head, version } of view.records(SOURCE, kind)) heads[`${kind}:${head.key}`] = version.content;
      view.close();
      expect(canonical(heads)).toBe(canonical(Object.fromEntries(Object.entries(golden()).map(([record, value]) => [record, (value as JsonObject).content!]))));
      artifact(dir, "heads.json", { landed: counts(landed), heads });
    } finally {
      db.close();
    }
  });

  it("a character split across two chunks reads differently", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const plain = exportXml();
      const marker = Buffer.byteLength(plain.slice(0, plain.indexOf("✓")));
      const insertAt = plain.indexOf("<HealthData");
      const fixed = Buffer.byteLength("<!--") + Buffer.byteLength("-->\n");
      const padding = MiB - 1 - marker - fixed;
      const padded = `${plain.slice(0, insertAt)}<!--${"x".repeat(padding)}-->\n${plain.slice(insertAt)}`;
      expect(Buffer.from(padded).subarray(MiB - 1, MiB + 2).toString()).toBe("✓");
      const rows = await collect(healthExport.read(await deliver(dir, blobs, "padded", padded, "xml"), blobs));
      expect(canonical(state(rows))).toBe(canonical(golden()));
      artifact(dir, "boundary.json", { at: MiB - 1, rows: rows.length });
    } finally {
      db.close();
    }
  });

  it("a smaller export lands a gone", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const full = await deliver(dir, blobs, "full", exportXml(), "xml");
      land(db, full, await collect(healthExport.read(full, blobs)));
      const smaller = await deliver(dir, blobs, "smaller", exportXml(exportRecords().split("\n").slice(0, 3).join("\n") + "\n"), "xml", "2026-10-04T12:00:00+05:30");
      const landed = land(db, smaller, await collect(healthExport.read(smaller, blobs)));
      expect(counts(landed)).toMatchObject({ gone: 0, new: 0, changed: 0 });
      const view = db.view();
      const live = [...view.records(SOURCE, "sample")].length + [...view.records(SOURCE, "workout")].length + [...view.records(SOURCE, "day-summary")].length;
      const gone = [...view.statements(0)].filter((statement) => statement.version === "gone").length;
      view.close();
      expect({ live, gone }).toEqual({ live: 13, gone: 0 });
      artifact(dir, "smaller.json", { landed: counts(landed), live, gone });
    } finally {
      db.close();
    }
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const records = exportRecords();
      const steps = records.split("\n").find((line) => line.includes("StepCount"))!;
      const xml = exportXml(`${records}${steps}\n`).replace(
        "</HealthData>",
        ` <ActivitySummary dateComponents="2026-10-03" activeEnergyBurned="222" activeEnergyBurnedGoal="600" activeEnergyBurnedUnit="kcal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="9" appleExerciseTimeGoal="30" appleStandHours="3" appleStandHoursGoal="12"/>\n</HealthData>`,
      );
      const delivery = await deliver(dir, blobs, "repeats", xml, "xml");
      const landed = land(db, delivery, await collect(healthExport.read(delivery, blobs)));
      expect(counts(landed)).toMatchObject({ duplicated: 2, new: 18 });
      const view = db.view();
      const day = view.head({ source: SOURCE, kind: "day-summary", key: "20261003" })!;
      expect((view.version(day.version).content as JsonObject).active_energy_burned).toBe("222");
      view.close();
      artifact(dir, "duplicated.json", counts(landed));
    } finally {
      db.close();
    }
  });

  it("the same sample from the bundle and the export lands as two records", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const shipment = bundle("overlap", "2026-10-03T12:30:00+05:30", {
        health: [
          {
            domain: "health",
            kind: "sample",
            sequence: 1,
            captured: { wall_rfc3339: "2026-10-03T03:20:00.125Z" },
            payload: {
              uuid: "40000000-0000-4000-8000-000000000001",
              sample_type: "HKQuantityTypeIdentifierHeartRate",
              start_date_rfc3339: "2026-10-03T03:00:00.875Z",
              end_date_rfc3339: "2026-10-03T03:00:00.875Z",
              source_revision: { source_name: "Synthetic Wätch ✓", version: "9.1" },
              device: { name: "Synthetic Watch", hardware_version: "SyntheticWatch1,1", software_version: "9.1" },
              metadata: { HKMetadataKeyHeartRateMotionContext: false },
              quantity_description: "72 count/min",
            },
          },
        ],
      });
      const phoneHealth = healthReaders.find((connector) => connector.name === "health-ios-bundle")!;
      const stated_ms = instant(shipment.created_at, "rfc3339").start_ms;
      const fromBundle = (await collect(phoneHealth.read({ id: `phone:iphone-aa01/${shipment.bundle_id}`, source: SOURCE, sealed_ms: stated_ms, stated_ms, facts: {}, files: sealedFiles(blobs, shipment) }, blobs, db.view()))).find((row) => row.kind === "sample")!;
      const fromExport = (await collect(healthExport.read(await deliver(dir, blobs, "export", exportXml(), "xml"), blobs))).find((row) => row.kind === "sample")!;
      expect({ key: fromBundle.key, content: fromBundle.content, time: fromBundle.time }).toEqual({ key: fromExport.key, content: fromExport.content, time: fromExport.time });
      artifact(dir, "overlap.json", { key: fromExport.key, content: fromExport.content });
    } finally {
      db.close();
    }
  });

  it("a workout, correlation, audiogram or prescription lands nothing, or the phone and the export key one workout apart by a byte", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const xml = exportXml().replace("</HealthData>", [
        ` <Audiogram type="HKDataTypeIdentifierAudiogram" sourceName="Synthetic Hearing" sourceVersion="2.0" creationDate="2026-10-03 10:00:00 +0530" startDate="2026-10-03 10:00:00 +0530" endDate="2026-10-03 10:05:00 +0530">`,
        `  <SensitivityPoint frequencyValue="1000" frequencyUnit="Hz" leftEarValue="15" leftEarUnit="dBHL" rightEarValue="20" rightEarUnit="dBHL"/>`,
        ` </Audiogram>`,
        ` <VisionPrescription type="HKVisionPrescriptionTypeGlasses" dateIssued="2026-09-01 00:00:00 +0530" expirationDate="2027-09-01 00:00:00 +0530">`,
        `  <RightEye sphere="-1.25" sphereUnit="D"/>`,
        ` </VisionPrescription>`,
        `</HealthData>`,
      ].join("\n"))
        .replace(`durationUnit="min" sourceName`, `durationUnit="min" totalDistance="2.5" totalDistanceUnit="mi" totalEnergyBurned="150" totalEnergyBurnedUnit="Cal" sourceName`)
        .replace("  <WorkoutRoute", [
          ["DistanceWalkingRunning", `sum="2.5" unit="mi"`], ["ActiveEnergyBurned", `sum="150" unit="Cal"`], ["HeartRate", `average="120" minimum="90" maximum="150" unit="count/min"`],
        ].map(([type, figures]) => `  <WorkoutStatistics type="HKQuantityTypeIdentifier${type}" startDate="2026-10-03 07:00:00 +0530" endDate="2026-10-03 07:30:00 +0530" ${figures}/>\n`).join("") + "  <WorkoutRoute");
      const delivery = await deliver(dir, blobs, "compounds", xml, "xml");
      const rows = await collect(healthExport.read(delivery, blobs));
      expect(rows.filter((row) => row.refused !== undefined)).toEqual([]);
      const of = (type: string) => rows.find((row) => (row.content as JsonObject | null)?.sample_type === type)!;
      expect([of("HKWorkoutTypeIdentifier").kind, of("HKCorrelationTypeIdentifierBloodPressure").kind, of("HKDataTypeIdentifierAudiogram").kind, of("HKVisionPrescriptionTypeIdentifier").kind])
        .toEqual(["workout", "sample", "sample", "sample"]);
      expect(((of("HKCorrelationTypeIdentifierBloodPressure").content as JsonObject).detail as JsonObject).objects).toMatchObject([{ sample_type: "HKQuantityTypeIdentifierBloodPressureSystolic", value: "118", unit: "mmHg" }]);
      expect((of("HKDataTypeIdentifierAudiogram").content as JsonObject).detail).toEqual({ sensitivity_points: [{ frequencyValue: "1000", frequencyUnit: "Hz", leftEarValue: "15", leftEarUnit: "dBHL", rightEarValue: "20", rightEarUnit: "dBHL" }] });
      expect(of("HKVisionPrescriptionTypeIdentifier").content).toMatchObject({ value: "HKVisionPrescriptionTypeGlasses", start: "2026-08-31T18:30:00Z",
        detail: { expirationDate: "2027-09-01 00:00:00 +0530", parts: [{ element: "RightEye", sphere: "-1.25", sphereUnit: "D" }] } });

      const shipment = bundle("workout", "2026-10-03T12:30:00+05:30", { health: [{
        domain: "health", kind: "sample", sequence: 1, captured: { wall_rfc3339: "2026-10-03T03:20:00.125Z" },
        payload: {
          uuid: "40000000-0000-4000-8000-000000000077", sample_type: "HKWorkoutTypeIdentifier",
          start_date_rfc3339: "2026-10-03T01:30:00.250Z", end_date_rfc3339: "2026-10-03T02:00:00.750Z",
          source_revision: { source_name: "Synthetic Wätch ✓", version: null }, device: null, metadata: {},
          workout_activity_type: 52, duration_seconds: 1800, total_distance: { value: 4023.36, unit: "m" }, total_energy: { value: 150, unit: "kcal" },
          workout_statistics: [
            { type: "HKQuantityTypeIdentifierActiveEnergyBurned", start: "2026-10-03T01:30:00Z", end: "2026-10-03T02:00:00Z", sum: 150, average: null, minimum: null, maximum: null, unit: "kcal" },
            { type: "HKQuantityTypeIdentifierDistanceWalkingRunning", start: "2026-10-03T01:30:00Z", end: "2026-10-03T02:00:00Z", sum: 4023.36, average: null, minimum: null, maximum: null, unit: "m" },
            { type: "HKQuantityTypeIdentifierHeartRate", start: "2026-10-03T01:30:00Z", end: "2026-10-03T02:00:00Z", sum: null, average: 2, minimum: 1.5, maximum: 2.5, unit: "count/s" },
          ],
          workout_events: [{ type: 7, date_interval_start: "2026-10-03T01:30:00Z", date_interval_end: "2026-10-03T01:30:00Z", metadata: null }],
        },
      }] });
      const phoneHealth = healthReaders.find((connector) => connector.name === "health-ios-bundle")!;
      const stated_ms = instant(shipment.created_at, "rfc3339").start_ms;
      const phoneDelivery = { id: `phone:iphone-aa01/${shipment.bundle_id}`, source: SOURCE, sealed_ms: stated_ms, stated_ms, facts: {}, files: sealedFiles(blobs, shipment) };
      const read = db.view();
      const fromPhone = await collect(phoneHealth.read(phoneDelivery, blobs, read));
      read.close();
      const phoneIdentity = fromPhone.find((row) => row.kind === "sample-uuid")!.content as JsonObject;
      const fromExport = of("HKWorkoutTypeIdentifier");
      const fields = ["sample_type", "start", "end", "value", "unit", "source_name", "source_version"] as const;
      expect(fields.map((field) => Buffer.from(phoneIdentity[field] as string).toString("hex"))).toEqual(fields.map((field) => Buffer.from((fromExport.content as JsonObject)[field] as string).toString("hex")));
      const phoneWorkout = fromPhone.find((row) => row.kind === "workout")!;
      expect({ key: phoneWorkout.key, content: phoneWorkout.content, time: phoneWorkout.time }).toEqual({ key: fromExport.key, content: fromExport.content, time: fromExport.time });
      expect(Buffer.from(canonical(phoneWorkout.content)).toString("hex")).toBe(Buffer.from(canonical(fromExport.content)).toString("hex"));
      expect((fromExport.content as JsonObject).detail).toMatchObject({ distance: "4023.36 m", energy: "150 kcal", statistics: [
        { type: "HKQuantityTypeIdentifierActiveEnergyBurned", sum: "150", unit: "kcal" },
        { type: "HKQuantityTypeIdentifierDistanceWalkingRunning", sum: "2.5", unit: "mi" },
        { type: "HKQuantityTypeIdentifierHeartRate", sum: null, average: "120", minimum: "90", maximum: "150", unit: "count/min" },
      ] });
      land(db, delivery, rows);
      const again = land(db, phoneDelivery, fromPhone, phoneHealth.kinds);
      expect([again.changed, again.restated]).toEqual([0, 1]);
      const view = db.view();
      const workouts = [...view.records(SOURCE, "workout")].map(({ head }) => head.key);
      view.close();
      expect(workouts).toEqual([fromExport.key]);
      artifact(dir, "compounds.json", { workout: fromExport.key, identity: Object.fromEntries(fields.map((field) => [field, phoneIdentity[field]!])) });
    } finally {
      db.close();
    }
  });

  it("the same sample in the export's display unit and the phone's number in the type's own unit keys two records, or the phone's units are not the home's", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const cases = [
        { type: "HKQuantityTypeIdentifierRunningSpeed", exported: ["10", "mi/hr"], phone: [4.4704, "m/s"] },
        { type: "HKQuantityTypeIdentifierDistanceCycling", exported: ["2.5", "mi"], phone: [4023.36, "m"] },
        { type: "HKQuantityTypeIdentifierBodyTemperature", exported: ["98.6", "degF"], phone: [37.00000000000006, "degC"] },
        { type: "HKQuantityTypeIdentifierLeanBodyMass", exported: ["150", "lb"], phone: [68.0388555, "kg"] },
        { type: "HKQuantityTypeIdentifierOxygenSaturation", exported: ["0.97", "%"], phone: [0.97, "%"] },
        { type: "HKCategoryTypeIdentifierSleepAnalysis", exported: ["HKCategoryValueSleepAnalysisAsleep", ""], phone: [1, ""] },
      ] as const;
      const xml = exportXml(cases.map(({ type, exported: [value, unit] }) =>
        ` <Record type="${type}" sourceName="Synthetic Phone" sourceVersion="26.0"${unit === "" ? "" : ` unit="${unit}"`} creationDate="2026-10-03 09:00:00 +0530" startDate="2026-10-03 09:00:00 +0530" endDate="2026-10-03 09:30:00 +0530" value="${value}"/>\n`).join(""));
      const delivery = await deliver(dir, blobs, "units", xml, "xml");
      const exported = await collect(healthExport.read(delivery, blobs));
      expect(exported.filter((row) => row.refused !== undefined)).toEqual([]);
      const shipment = bundle("units", "2026-10-03T12:30:00+05:30", { health: cases.map(({ type, phone: [value, unit] }, index) => ({
        domain: "health", kind: "sample", sequence: index + 1, captured: { wall_rfc3339: "2026-10-03T04:00:00Z" },
        payload: {
          uuid: `40000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`, sample_type: type,
          start_date_rfc3339: "2026-10-03T03:30:00Z", end_date_rfc3339: "2026-10-03T04:00:00Z",
          source_revision: { source_name: "Synthetic Phone", version: "26.0" }, device: null, metadata: {},
          ...(unit === "" ? { category_value: value } : { quantity_value: value, quantity_unit: unit }),
        },
      })) });
      const phoneHealth = healthReaders.find((connector) => connector.name === "health-ios-bundle")!;
      const stated_ms = instant(shipment.created_at, "rfc3339").start_ms;
      const phoneDelivery = { id: `phone:iphone-aa01/${shipment.bundle_id}`, source: SOURCE, sealed_ms: stated_ms, stated_ms, facts: {}, files: sealedFiles(blobs, shipment) };
      const read = db.view();
      const fromPhone = (await collect(phoneHealth.read(phoneDelivery, blobs, read))).filter((row) => row.kind === "sample");
      read.close();
      const of = (rows: ReaderOutput[], type: string) => rows.find((row) => (row.content as JsonObject).sample_type === type)!;
      const keyed = cases.map(({ type }) => {
        const [phone, fromExport] = [of(fromPhone, type), of(exported.filter((row) => row.kind === "sample"), type)];
        expect({ key: phone.key, content: phone.content }, type).toEqual({ key: fromExport.key, content: fromExport.content });
        const { value, unit } = phone.content as JsonObject;
        return [type, { key: phone.key, value, unit }] as const;
      });
      expect(Object.fromEntries(keyed.map(([type, { value, unit }]) => [type, `${value} ${unit}`.trim()]))).toEqual({
        HKQuantityTypeIdentifierRunningSpeed: "4.4704 m/s", HKQuantityTypeIdentifierDistanceCycling: "4023.36 m",
        HKQuantityTypeIdentifierBodyTemperature: "37 degC", HKQuantityTypeIdentifierLeanBodyMass: "68.0389 kg",
        HKQuantityTypeIdentifierOxygenSaturation: "97 percent", HKCategoryTypeIdentifierSleepAnalysis: "HKCategoryValueSleepAnalysisAsleepUnspecified",
      });
      land(db, delivery, exported);
      land(db, phoneDelivery, fromPhone, phoneHealth.kinds);
      const view = db.view();
      const samples = [...view.records(SOURCE, "sample")].map(({ head }) => head.key);
      view.close();
      expect(samples.filter((key) => keyed.some(([, row]) => row.key === key))).toHaveLength(cases.length);
      expect(samples.filter((key) => !keyed.some(([, row]) => row.key === key))).toHaveLength(exported.filter((row) => row.kind === "sample").length - cases.length);
      const swift = readFileSync(new URL("../../../../ios-app/LifestreamCapture/Health/HealthRecorder.swift", import.meta.url), "utf8");
      const table = /enum HealthUnits \{\n {4}static let byUnit: \[String: String\] = \[\n([\s\S]*?)\n {4}\]/u.exec(swift)![1]!;
      const phoneUnits = Object.fromEntries([...table.matchAll(/"([^"]+)": "([^"]+)",/gu)].flatMap(([, unit, types]) => types!.split(" ").map((type) => [`HKQuantityTypeIdentifier${type}`, unit!])));
      expect(phoneUnits).toEqual(NATIVE_UNITS);
      artifact(dir, "units.json", Object.fromEntries(keyed));
    } finally {
      db.close();
    }
  });

  it("a characteristic from the phone and from the export's Me differs by a byte, a not-set fact states a value, or a fact a later set leaves out is gone", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const id = (name: string) => `HKCharacteristicTypeIdentifier${name}`;
      const me = [["DateOfBirth", "1990-01-01"], ["BiologicalSex", "HKBiologicalSexFemale"], ["BloodType", "HKBloodTypeABNegative"],
        ["FitzpatrickSkinType", "HKFitzpatrickSkinTypeIII"], ["WheelchairUse", "HKWheelchairUseNo"], ["ActivityMoveMode", "HKActivityMoveModeActiveEnergy"]] as const;
      const xml = exportXml().replace(/ <Me [^>]*\/>\n/u, ` <Me ${me.map(([name, value]) => `${id(name)}="${value}"`).join(" ")}/>\n`);
      const delivery = await deliver(dir, blobs, "me", xml, "xml");
      const exported = (await collect(healthExport.read(delivery, blobs))).filter((row) => row.kind === "characteristic");
      const line = (sequence: number, facts: [string, string | number | null][]) => ({
        domain: "health", kind: "characteristics", sequence, captured: { wall_rfc3339: "2026-10-03T04:00:00Z" },
        payload: { characteristics: facts.map(([name, value]) => ({ identifier: id(name), value })) },
      });
      const phoneHealth = healthReaders.find((connector) => connector.name === "health-ios-bundle")!;
      const read = async (name: string, created_at: string, lines: object[]) => {
        const shipment = bundle(name, created_at, { health: lines });
        const stated_ms = instant(shipment.created_at, "rfc3339").start_ms;
        const phoneDelivery = { id: `phone:iphone-aa01/${shipment.bundle_id}`, source: SOURCE, sealed_ms: stated_ms, stated_ms, facts: {}, files: sealedFiles(blobs, shipment) };
        const view = db.view();
        const rows = await collect(phoneHealth.read(phoneDelivery, blobs, view));
        view.close();
        return { phoneDelivery, rows };
      };
      const first = await read("me-a", "2026-10-03T12:30:00+05:30", [line(1, [["DateOfBirth", "1990-01-01"], ["BiologicalSex", 1], ["BloodType", 6], ["FitzpatrickSkinType", 3], ["WheelchairUse", 1], ["ActivityMoveMode", 1]])]);
      expect(first.rows.map((row) => row.kind)).toEqual(Array(6).fill("characteristic"));
      const hex = (rows: ReaderOutput[]) => Object.fromEntries(rows.map((row) => [row.key, Buffer.from(canonical(row.content)).toString("hex")]));
      expect(hex(first.rows)).toEqual(hex(exported));
      expect(first.rows.map((row) => [row.key, (row.content as JsonObject).value, row.time ?? null])).toEqual(me.map(([name, value]) => [id(name), value, null]));
      land(db, delivery, exported);
      land(db, first.phoneDelivery, first.rows, phoneHealth.kinds);
      const later = await read("me-b", "2026-10-04T12:30:00+05:30", [line(1, [["DateOfBirth", "1990-01-01"], ["BiologicalSex", 0], ["FitzpatrickSkinType", 3], ["WheelchairUse", 1], ["ActivityMoveMode", 1]])]);
      const landed = land(db, later.phoneDelivery, later.rows, phoneHealth.kinds);
      expect([landed.changed, landed.restated, landed.gone]).toEqual([1, 4, 0]);
      const view = db.view();
      const facts = Object.fromEntries([...view.records(SOURCE, "characteristic")].map(({ head, version }) => [head.key, (version.content as JsonObject).value]));
      view.close();
      expect(facts).toEqual({ ...Object.fromEntries(me.map(([name, value]) => [id(name), value])), [id("BiologicalSex")]: null });
      artifact(dir, "characteristics.json", { phone: first.rows.map((row) => row.content), later: facts });
    } finally {
      db.close();
    }
  });

  it("an element or construct the export does not write reads as data, or an element refuses the elements beside it", async () => {
    const dir = temp();
    const { db, blobs } = home(dir);
    try {
      const read = (name: string, xml: string) => refusal(async () => collect(healthExport.read(await deliver(dir, blobs, name, xml, "xml"), blobs)));
      const codes = {
        unknown: await read("unknown", exportXml().replace("<ExportDate", "<Orbit/>\n <ExportDate")),
        cdata: await read("cdata", exportXml().replace("<ExportDate", "<![CDATA[x]]>\n <ExportDate")),
        text: await read("text", exportXml().replace("<ExportDate", "stray text <ExportDate")),
        unclosed: await read("unclosed", exportXml().replace("</HealthData>\n", "")),
        mismatched: await read("mismatched", exportXml().replace(" </Correlation>", " </Workout>")),
        attribute: await read("attribute", exportXml().replace('value="72"', 'value="72" heartbeat="1"')),
        entity: await read("entity", exportXml().replace("Synthetic &amp; Co", "Synthetic &copy; Co")),
        utf8: await refusal(async () => {
          const bytes = Buffer.from(exportXml());
          bytes[bytes.indexOf("✓")] = 0xff;
          const path = join(dir, "utf8.xml");
          writeFileSync(path, bytes);
          return await collect(healthExport.read({ id: "x", source: SOURCE, sealed_ms: 0, stated_ms: 0, facts: {}, files: [{ path: "export.xml", blob: await blobs.putFile(path), size: 0 }] }, blobs));
        }),
      };
      const element = (words: RegExp, unit: string) => ({ words: expect.stringMatching(words), unit, landed: expect.any(Number) });
      expect(codes).toMatchObject({
        unknown: element(/^<Orbit> is a HealthData element this connector does not read$/u, "Orbit"),
        attribute: element(/^Record \d+ states an attribute this connector does not know: heartbeat$/u, "Record"),
      });
      for (const name of ["unknown", "attribute"] as const) expect(codes[name].landed, name).toBeGreaterThanOrEqual(10);
      const unseen = (await collect(healthExport.read(await deliver(dir, blobs, "type", exportXml().replace("HKQuantityTypeIdentifierFlightsClimbed", "HKQuantityTypeIdentifierSyntheticNoise"), "xml"), blobs)))
        .filter((row) => row.refused !== undefined || (row.content as JsonObject | null)?.sample_type === "HKQuantityTypeIdentifierSyntheticNoise");
      expect(unseen.map((row) => [row.refused ?? null, (row.content as JsonObject).value, (row.content as JsonObject).unit])).toEqual([[null, "2", "count"]]);
      const file = (words: RegExp) => ({ words: expect.stringMatching(words), unit: "file" });
      expect(codes).toMatchObject({
        cdata: file(/^an XML construct the export does not write: <!\[CDATA\[/u),
        text: file(/^character data inside <HealthData>$/u),
        unclosed: file(/^export\.xml ended before <HealthData> closed$/u),
        mismatched: file(/^<\/Workout> closes <Correlation>$/u),
        entity: file(/^an entity the export does not write: &copy;$/u),
        utf8: file(/^export\.xml is not UTF-8$/u),
      });
      artifact(dir, "refusals.json", codes);
    } finally {
      db.close();
    }
  });
});
