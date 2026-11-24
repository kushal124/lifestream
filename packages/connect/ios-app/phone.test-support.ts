import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../test/drive.js";

export const UNIT = "iphone-aa01";
export const HEALTH_ACCOUNT = "synthetic-account";
export const INSTALL = "00000000-0000-4000-8000-0000000000a1";
export const BOOT = "00000000-0000-4000-8000-0000000000b1";
export const PROCESS = "00000000-0000-4000-8000-0000000000c1";

export interface BundleMember {
  name: string;
  bytes: Buffer;
}

export interface SyntheticBundle {
  name: string;
  bundle_id: string;
  created_at: string;
  members: BundleMember[];
  stored: Record<string, Buffer>;
}

export const sha = (bytes: Buffer | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function sorted(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sorted).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${sorted(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function bundle(name: string, created_at: string, domains: Record<string, (object | string)[]>, carried: Buffer[] = [], stored: Buffer[] = [], install = INSTALL): SyntheticBundle {
  const members: BundleMember[] = [];
  const files: Record<string, unknown> = {};
  for (const [domain, entries] of Object.entries(domains)) {
    const bytes = Buffer.from(entries.map((entry) => `${typeof entry === "string" ? entry : JSON.stringify(entry)}\n`).join(""));
    const sequences = entries.map((entry) => (entry as { sequence: number }).sequence);
    files[`${domain}.jsonl`] = {
      sha256: sha(bytes),
      bytes: bytes.length,
      observations: entries.length,
      ...(entries.length === 0 ? {} : { first_sequence: sequences[0], last_sequence: sequences.at(-1) }),
    };
    members.push({ name: `${domain}.jsonl`, bytes });
  }
  for (const blob of carried) {
    const member = `blobs/${sha(blob).slice(7)}`;
    files[member] = { sha256: sha(blob), bytes: blob.length, observations: 0 };
    members.push({ name: member, bytes: blob });
  }
  const manifest: Record<string, unknown> = {
    schema_version: 3,
    device: {
      machine_model: "iPhoneSynthetic,1",
      marketing_name: "Synthetic iPhone",
      os_version: "SyntheticOS 1.0",
      install_id: install,
      enrolled_at: "2026-08-31T09:00:00+05:30",
    },
    app_version: "1.0 (1)",
    created_at,
    time_range_covered: { start: "2026-10-03T08:00:00+05:30", end: created_at },
    files,
  };
  const bundle_id = sha(sorted(manifest));
  manifest.bundle_id = bundle_id;
  return {
    name,
    bundle_id,
    created_at,
    members: [{ name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) }, ...members],
    stored: Object.fromEntries(stored.map((blob) => [sha(blob), blob])),
  };
}

export function sealedFiles(blobs: { put(bytes: Buffer): string }, shipment: SyntheticBundle): { path: string; blob: string; size: number }[] {
  return shipment.members.flatMap((member) => {
    const blob = blobs.put(member.bytes);
    return member.name.startsWith("blobs/") ? [] : [{ path: `bundle/${member.name}`, blob, size: member.bytes.length }];
  });
}


const wall = (at: string, unix: number) => ({ wall_rfc3339: at, wall_unix_seconds: unix, elapsed_seconds: 1000.5 });

function sensor(domain: string, kind: string, sequence: number, minute: number, payload: object): object {
  const at = `2026-10-03T08:${String(minute).padStart(2, "0")}:07.125+05:30`;
  return {
    schema_version: 1,
    domain,
    kind,
    sequence,
    observed_at: `2026-10-03T02:${String(minute).padStart(2, "0")}:07.125Z`,
    captured: wall(at, 1791001807.125 + minute * 60),
    process_instance_id: PROCESS,
    payload,
  };
}

export function entry(domain: string, kind: string, sequence: number, observed_at: string, payload: object, replay?: string): object {
  return {
    schema_version: 1,
    domain,
    kind,
    sequence,
    observed_at,
    captured: wall("2026-10-03T08:30:00.125+05:30", 1791003600.125),
    process_instance_id: PROCESS,
    ...(replay === undefined ? {} : { capture_replay_key: replay }),
    payload,
  };
}

const fix = (sequence: number, minute: number, latitude: number) =>
  sensor("location", "fix", sequence, minute, {
    latitude,
    longitude: -0.25,
    altitude: 3.5,
    horizontal_accuracy: 12.25,
    vertical_accuracy: 4,
    speed: -1,
    course: -1,
    timestamp_unix_seconds: 1791001807.125 + minute * 60,
  });

export const VOICE_BLOB = Buffer.from("fake m4a bytes of a synthetic voice note");
export const CAMERA_BLOB = Buffer.from("fake heic bytes of a synthetic camera photo");
export const CAMERA_STORED = Buffer.from("fake heic bytes a previous shipment carried");
export const PHOTO_ORIGINAL = Buffer.from("fake jpeg bytes of synthetic photo one");
export const PHOTO_FIVE = Buffer.from("fake jpeg bytes of synthetic photo five, now local");
export const PHOTO_EDIT = Buffer.from("fake jpeg bytes of the edited render of photo one");

const blobRef = (bytes: Buffer, type: string, role: string) => ({ hash: sha(bytes), bytes: bytes.length, type, role });

const UUIDS = {
  heart: "10000000-0000-4000-8000-000000000001",
  steps: "10000000-0000-4000-8000-000000000002",
  sleep: "10000000-0000-4000-8000-000000000003",
  rescaled: "10000000-0000-4000-8000-000000000004",
  rewrite303: "10000000-0000-4000-8000-000000000303",
  rewrite305: "10000000-0000-4000-8000-000000000305",
  doomed: "10000000-0000-4000-8000-000000000404",
  unknown: "10000000-0000-4000-8000-000000000999",
  workout: "10000000-0000-4000-8000-000000000777",
  twinA: "10000000-0000-4000-8000-000000000601",
  twinB: "10000000-0000-4000-8000-000000000602",
  variability: "10000000-0000-4000-8000-000000000005",
} as const;
export const HEALTH_UUIDS = UUIDS;

export function sample(sequence: number, uuid: string, options: {
  type: string;
  start: string;
  end: string;
  quantity?: string;
  category?: number;
  metadata?: object;
  device?: object | null;
  extra?: object;
}): object {
  return {
    domain: "health",
    kind: "sample",
    sequence,
    captured: { wall_rfc3339: "2026-10-03T03:20:00.125Z" },
    payload: {
      uuid: uuid.toUpperCase(),
      sample_type: options.type,
      start_date_rfc3339: options.start,
      start_date_unix_seconds: Date.parse(options.start) / 1000,
      end_date_rfc3339: options.end,
      end_date_unix_seconds: Date.parse(options.end) / 1000,
      source_revision: {
        source_name: "Synthetic Health Source",
        bundle_identifier: "org.example.synthetic-health",
        version: "9.1",
        product_type: "SyntheticPhone9,9",
        operating_system_version: { major: 9, minor: 1, patch: 0 },
      },
      device:
        options.device === undefined
          ? { name: "Synthetic Watch", manufacturer: "Synthetic Maker", model: "Watch", hardware_version: "SyntheticWatch1,1", software_version: "9.1", local_identifier: "synthetic-local-device" }
          : options.device,
      metadata: options.metadata ?? { HKWasUserEntered: false, HKMetadataKeyTimeZone: "Etc/GMT-3" },
      secure_archive_base64: "c3ludGhldGlj",
      ...(options.quantity === undefined ? {} : { quantity_description: options.quantity }),
      ...(options.category === undefined ? {} : { category_value: options.category }),
      ...options.extra,
    },
  };
}

export const deletion = (sequence: number, uuid: string, type: string) => ({
  domain: "health",
  kind: "deleted_sample",
  sequence,
  captured: { wall_rfc3339: "2026-10-03T03:25:00.875Z" },
  payload: { uuid, sample_type: type, deletion_reported_at: "2026-10-03T03:25:00.750Z" },
});

const SPEED = "HKQuantityTypeIdentifierWalkingSpeed";
export const STEPS = "HKQuantityTypeIdentifierStepCount";
export const HEART = "HKQuantityTypeIdentifierHeartRate";

function healthFirst(): object[] {
  const speedSpan = { type: SPEED, start: "2026-10-03T03:01:00.875Z", end: "2026-10-03T03:01:09.999Z", quantity: "1.1176 m/s" };
  return [
    sample(1, UUIDS.heart, { type: HEART, start: "2026-10-03T03:00:00.875Z", end: "2026-10-03T03:00:00.875Z", quantity: "72 count/min" }),
    sample(2, UUIDS.steps, { type: STEPS, start: "2026-10-03T03:00:00Z", end: "2026-10-03T03:09:59.5Z", quantity: "120 count", device: null }),
    sample(3, UUIDS.sleep, { type: "HKCategoryTypeIdentifierSleepAnalysis", start: "2026-10-02T20:00:00Z", end: "2026-10-02T21:30:00Z", category: 3, metadata: {} }),
    sample(4, UUIDS.rescaled, { type: HEART, start: "2026-10-03T03:02:00Z", end: "2026-10-03T03:02:00Z", quantity: "1.31667 count/s", metadata: { HKMetadataKeyHeartRateMotionContext: false } }),
    sample(5, UUIDS.rewrite303, { ...speedSpan, metadata: { HKMetadataKeySyncVersion: 1 } }),
    sample(6, UUIDS.rewrite305, { ...speedSpan, metadata: { HKMetadataKeySyncVersion: 2 } }),
    deletion(7, UUIDS.rewrite303, SPEED),
    sample(8, UUIDS.doomed, { type: STEPS, start: "2026-10-03T03:05:00Z", end: "2026-10-03T03:06:00Z", quantity: "33 count" }),
    deletion(9, UUIDS.doomed, STEPS),
    deletion(10, UUIDS.unknown, STEPS),
    sample(11, UUIDS.workout, { type: "HKWorkoutTypeIdentifier", start: "2026-10-03T02:00:00Z", end: "2026-10-03T02:30:00Z", extra: {
      workout_activity_type: 37, duration_seconds: 1795.5, total_distance: { value: 4012.5, unit: "m" }, total_energy: { value: 251.25, unit: "kcal" },
      workout_statistics: [{ type: "HKQuantityTypeIdentifierHeartRate", start: "2026-10-03T02:00:00Z", end: "2026-10-03T02:30:00Z", sum: null, average: 2.4, minimum: 1.5, maximum: 2.85, unit: "count/s" }],
      workout_events: [{ type: 1, date_interval_start: "2026-10-03T02:10:00.250Z", date_interval_end: "2026-10-03T02:10:00.250Z", metadata: null },
        { type: 7, date_interval_start: "2026-10-03T02:00:00Z", date_interval_end: "2026-10-03T02:15:00Z", metadata: { HKMetadataKeySyncVersion: 1 } }],
    } }),
    { domain: "health", kind: "workout_route", sequence: 12, captured: { wall_rfc3339: "2026-10-03T03:26:00.125Z" }, payload: { workout_uuid: UUIDS.workout, points: 2 } },
    { domain: "health", kind: "recorder_event", sequence: 13, captured: { wall_rfc3339: "2026-10-03T03:27:00.125Z" }, payload: { event: "synthetic_sweep_completed", detail: { samples: 9, deletions: 3 } } },
    sample(14, UUIDS.twinA, { type: STEPS, start: "2026-10-03T03:10:00Z", end: "2026-10-03T03:11:00Z", quantity: "40 count" }),
    sample(15, UUIDS.twinB, { type: STEPS, start: "2026-10-03T03:10:00Z", end: "2026-10-03T03:11:00Z", quantity: "40 count" }),
  ];
}

function healthSecond(): object[] {
  return [
    deletion(16, UUIDS.steps, STEPS),
    sample(17, UUIDS.heart, { type: HEART, start: "2026-10-03T03:00:00.875Z", end: "2026-10-03T03:00:00.875Z", quantity: "72 count/min" }),
    sample(18, UUIDS.variability, { type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", start: "2026-10-03T03:03:00.5+05:30", end: "2026-10-03T03:04:00.25+05:30", quantity: "41.23456789 ms" }),
  ];
}

const VCARD_ONE = "BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Synthetic Inc.//Synthetic OS 1.0//EN\r\nN:A;Person;;;\r\nFN:Person A\r\nTEL;type=CELL:+15550000001\r\nEMAIL;type=INTERNET:person-a@example.com\r\nEND:VCARD\r\n";
const VCARD_ONE_EDITED = VCARD_ONE.replace("FN:Person A\r\n", "FN:Person A Edited\r\n");
const VCARD_TWO = "BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Synthetic Inc.//Synthetic OS 1.0//EN\r\nN:B;Person;;;\r\nFN:Person B\r\nTEL;type=CELL:+15550000002\r\nEND:VCARD\r\n";
const VCARD_THREE = "BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Synthetic Inc.//Synthetic OS 1.0//EN\r\nN:C;Person;;;\r\nFN:Person C\r\nTEL;type=CELL:+15550000003\r\nEND:VCARD\r\n";
export const CONTACT_IDS = { a: "C0000000-0000-4000-8000-00000000000A:ABPerson", b: "C0000000-0000-4000-8000-00000000000B:ABPerson", c: "C0000000-0000-4000-8000-00000000000C:ABPerson" };
export const CONTACT_PHOTO = Buffer.from("synthetic heic bytes of a contact's photo");

export const contactCard = (sequence: number, observed_at: string, id: string, card: string, photo?: Buffer) =>
  entry("contacts", "card", sequence, observed_at, {
    id, card, serializer: "CNContactVCardSerialization", ...(photo === undefined ? {} : { photo: { hash: sha(photo), bytes: photo.length, media_type: "image/heic" } }),
  });
export const contactGone = (sequence: number, observed_at: string, id: string) => entry("contacts", "gone", sequence, observed_at, { id });

const resource = (type: string, typeRaw: number, uti: string, filename: string, blob: Buffer | null) => ({
  type,
  type_raw: typeRaw,
  uti,
  original_filename: filename,
  ...(blob === null ? { blob: null, not_local: true } : { blob: blobRef(blob, "image/jpeg", "original") }),
});

const LOCAL = (n: number) => `AAAAAAAA-0000-4000-8000-00000000000${n}/L0/001`;
const MODIFIED = (n: number) => `2026-10-03T08:4${n}:05.12345${n}0+05:30`;

function asset(n: number, media_type: string, creation_date: string | null, resources: object[]): object {
  return {
    local_identifier: LOCAL(n),
    modification_date: MODIFIED(n),
    creation_date,
    media_type,
    media_subtypes: 0,
    pixel_width: 4032,
    pixel_height: 3024,
    location: null,
    favorite: false,
    hidden: false,
    resources,
  };
}

function availability(n: number, sequence: number, resources: { type_raw: number; uti: string; original_filename: string; blob: { hash: string } | null }[]): object {
  const snapshotKey = `photos:${LOCAL(n)}:${MODIFIED(n)}`;
  const tuples = [...new Set(resources.filter((r) => r.blob !== null).map((r) => JSON.stringify([r.type_raw, r.uti, r.original_filename, r.blob!.hash])))]
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const digest = sha(`[${tuples.join(",")}]`);
  return {
    domain: "photos",
    kind: "resource_availability",
    sequence,
    captured: { wall_rfc3339: "2026-10-03T09:40:00.5+05:30" },
    capture_replay_key: `${snapshotKey}:availability:${digest}`,
    payload: { local_identifier: LOCAL(n), modification_date: MODIFIED(n), snapshot_replay_key: snapshotKey, resources },
  };
}

const photo = (sequence: number, payload: object) => ({ domain: "photos", kind: "asset", sequence, captured: { wall_rfc3339: "2026-10-03T09:30:00.5+05:30" }, payload });

const place = (sequence: number, payload: object) => ({
  schema_version: 1,
  domain: "places",
  kind: "place",
  sequence,
  observed_at: `2026-10-03T03:0${sequence}:00Z`,
  captured: wall(`2026-10-03T08:3${sequence}:00+05:30`, Date.parse(`2026-10-03T08:3${sequence}:00+05:30`) / 1000),
  process_instance_id: PROCESS,
  payload,
});

const checkin = (sequence: number, kind: string, observed_at: string, payload: object) => ({
  schema_version: 1,
  domain: "checkin",
  kind,
  sequence,
  observed_at,
  captured: wall("2026-10-03T09:00:00.5+05:30", Date.parse("2026-10-03T09:00:00.5+05:30") / 1000),
  process_instance_id: PROCESS,
  payload,
});

const PROMPT = "20000000-0000-4000-8000-000000000001";

export const MIND_UUIDS = {
  momentary: "20000000-0000-4000-8000-000000000001",
  daily: "20000000-0000-4000-8000-000000000002",
  unknown: "20000000-0000-4000-8000-000000000999",
  malformed: "20000000-0000-4000-8000-000000000003",
} as const;
export const DOSE_UUIDS = {
  taken: "30000000-0000-4000-8000-000000000001",
  doomed: "30000000-0000-4000-8000-000000000002",
} as const;
export const STATE_OF_MIND = "HKDataTypeStateOfMind";
export const DOSE = "HKMedicationDoseEventTypeIdentifierMedicationDoseEvent";

export function stateOfMind(sequence: number, uuid: string, at: string, state: object): object {
  return {
    domain: "health",
    kind: "sample",
    sequence,
    captured: { wall_rfc3339: "2026-10-03T03:20:00.125Z" },
    payload: {
      uuid,
      sample_type: STATE_OF_MIND,
      start_date_rfc3339: at,
      start_date_unix_seconds: Date.parse(at) / 1000,
      end_date_rfc3339: at,
      end_date_unix_seconds: Date.parse(at) / 1000,
      source_revision: {
        source_name: "Synthetic Mind Logger",
        bundle_identifier: "org.example.synthetic-mind",
        version: "2.0",
        product_type: "SyntheticPhone9,9",
        operating_system_version: { major: 26, minor: 0, patch: 0 },
      },
      device: null,
      metadata: { HKMetadataKeyTimeZone: "Etc/GMT-3" },
      secure_archive_base64: "c3ludGhldGlj",
      state_of_mind: state,
    },
  };
}

export function doseEvent(sequence: number, uuid: string, at: string, dose: object): object {
  return {
    domain: "health",
    kind: "sample",
    sequence,
    captured: { wall_rfc3339: "2026-10-03T03:21:00.125Z" },
    payload: {
      uuid: uuid.toUpperCase(),
      sample_type: DOSE,
      start_date_rfc3339: at,
      start_date_unix_seconds: Date.parse(at) / 1000,
      end_date_rfc3339: at,
      end_date_unix_seconds: Date.parse(at) / 1000,
      source_revision: {
        source_name: "Health",
        bundle_identifier: "org.example.synthetic-health",
        version: "26.0",
        product_type: "SyntheticPhone9,9",
        operating_system_version: { major: 26, minor: 0, patch: 0 },
      },
      device: { name: "Synthetic iPhone", manufacturer: "Synthetic Maker", model: "iPhone", hardware_version: "SyntheticPhone9,9", software_version: "26.0", local_identifier: null, udi_device_identifier: null, firmware_version: null },
      metadata: null,
      secure_archive_base64: "c3ludGhldGlj",
      medication_dose_event: {
        log_status: 4,
        schedule_type: 2,
        scheduled_date_rfc3339: "2026-10-03T03:00:00Z",
        scheduled_dose_quantity: 1,
        dose_quantity: 1.5,
        unit: "count",
        medication_concept_identifier: { domain: "HKHealthConceptDomainMedication", archive_base64: "c3ludGhldGljLWNvbmNlcHQ=" },
        medication: {
          display_text: "Synthetic Medication A 10 mg Tablet",
          general_form: "tablet",
          related_codings: [{ system: "http://example.org/synthetic-codes", version: null, code: "0000001" }],
        },
        ...dose,
      },
    },
  };
}

const CODING_A = { system: "http://example.org/synthetic-codes", version: null, code: "0000001" };
const CODING_A2 = { system: "http://example.org/other-synthetic-codes", version: "2026-01", code: "A-1" };
const medicationA = (nickname: string | null, is_archived: boolean, codings: object[]) => ({
  nickname,
  is_archived,
  has_schedule: true,
  concept: { display_text: "Synthetic Medication A 10 mg Tablet", general_form: "tablet", related_codings: codings },
  concept_identifier: { domain: "HKHealthConceptDomainMedication", archive_base64: "c3ludGhldGljLWNvbmNlcHQ=" },
});
const MEDICATION_B = {
  nickname: null,
  is_archived: false,
  has_schedule: false,
  concept: { display_text: "Synthetic Medication B Drops", general_form: "drops", related_codings: [] },
  concept_identifier: { domain: "HKHealthConceptDomainMedication", archive_base64: null },
};

export const medicationList = (sequence: number, medications: object[]) => ({
  domain: "health",
  kind: "medication_list",
  sequence,
  captured: { wall_rfc3339: "2026-10-03T03:22:00.125Z" },
  payload: { medications },
});

export function mindAndDoseShipments(): SyntheticBundle[] {
  const first = bundle("mind-first", "2026-10-03T09:00:00.250+05:30", {
    health: [
      stateOfMind(101, MIND_UUIDS.momentary, "2026-10-03T03:15:00.123456789Z", { kind: 1, valence: -0.4, valence_classification: 3, labels: [4, 29, 99], associations: [17, 6] }),
      stateOfMind(102, MIND_UUIDS.daily, "2026-10-02T18:00:00Z", { kind: 2, valence: 0.75, valence_classification: 6, labels: [], associations: [] }),
      doseEvent(103, DOSE_UUIDS.taken, "2026-10-03T03:05:00.5Z", {}),
      doseEvent(104, DOSE_UUIDS.doomed, "2026-10-03T03:30:00Z", { log_status: 5, schedule_type: 1, scheduled_date_rfc3339: null, scheduled_dose_quantity: null, dose_quantity: null, medication: null }),
      deletion(105, DOSE_UUIDS.doomed, DOSE),
      deletion(106, MIND_UUIDS.unknown, STATE_OF_MIND),
      medicationList(107, [medicationA("Morning pill", false, [CODING_A, CODING_A2]), MEDICATION_B]),
    ],
  });
  const second = bundle("mind-second", "2026-10-03T10:00:00.250+05:30", {
    health: [
      deletion(108, MIND_UUIDS.daily, STATE_OF_MIND),
      doseEvent(109, DOSE_UUIDS.taken, "2026-10-03T03:05:00.5Z", {}),
      medicationList(110, [medicationA("Evening pill", true, [CODING_A2, CODING_A])]),
    ],
  });
  return [first, second];
}

export function firstBundle(): SyntheticBundle {
  const p5Resources = [resource("photo", 1, "public.jpeg", "IMG_0005.JPG", PHOTO_FIVE)];
  return bundle("first", "2026-10-03T09:00:00.250+05:30", {
    location: [
      fix(41, 1, 0.5),
      fix(42, 2, 0.5001),
      sensor("location", "gap", 43, 3, { start: "2026-10-03T02:02:07.125Z", end: "2026-10-03T02:03:01.5Z", reason: "unknown_process_absence", reason_evidence: "inferred", expected_coverage: "process_absence" }),
      sensor("location", "recorder_event", 44, 4, { event: "significant_change_started" }),
      sensor("location", "lifecycle", 45, 5, { event: "app_backgrounded" }),
      fix(46, 6, 0.5002),
    ],
    motion: [
      sensor("motion", "activity", 7, 1, { start: "2026-10-03T02:00:00Z", activity: "walking", confidence: "high" }),
      sensor("motion", "pedometer_day", 8, 2, { day: "2026-10-02", steps: 5012, distance_m: 3810.5, floors_ascended: 3 }),
      sensor("motion", "recorder_event", 9, 3, { event: "history_backfilled", count: 2 }),
    ],
    usage: [
      entry("usage", "activity_segment", 1, "2026-10-03T03:00:00.125Z", {
        data: {
          dateInterval: { start: { rfc3339: "2026-10-03T02:00:00Z", unix_seconds: 1790992800 }, end: { rfc3339: "2026-10-03T02:15:00.5Z", unix_seconds: 1790993700.5 } },
          category: "synthetic.productivity",
        },
        segmentInterval: { during: { start: "2026-10-03T00:00:00Z", end: "2026-10-04T00:00:00Z" } },
      }),
      entry("usage", "activity_catalog", 2, "2026-10-03T03:00:01.125Z", { day: "2026-10-02", tokens: ["token-a", "token-b"] }),
      entry("usage", "shortcut_marker", 3, "2026-10-03T03:00:02.125Z", { marker: "focus_on" }, "shortcut:1"),
      entry("usage", "monitor_callback", 4, "2026-10-03T03:00:03.125Z", { activity: "synthetic.daily", event: "intervalDidStart" }),
      entry("usage", "usage_acquisition", 5, "2026-10-03T03:00:04.125Z", { started: true }),
    ],
    voice: [entry("voice", "voice_note", 1, "2026-10-03T03:05:00.5Z", { duration_s: 4.5, blob: blobRef(VOICE_BLOB, "audio/mp4", "voice_note") })],
    camera: [entry("camera", "photo", 1, "2026-10-03T03:06:00.5Z", { blob: blobRef(CAMERA_BLOB, "image/heic", "photo"), orientation: 1 })],
    health: healthFirst(),
    contacts: [
      { domain: "contacts", kind: "access", sequence: 1, observed_at: "2026-10-03T03:00:00Z", payload: { authorization: "authorized" } },
      contactCard(2, "2026-10-03T03:00:01.5Z", CONTACT_IDS.a, VCARD_ONE, CONTACT_PHOTO),
      contactCard(3, "2026-10-03T03:00:01.5Z", CONTACT_IDS.b, VCARD_TWO),
      contactCard(4, "2026-10-03T03:00:01.5Z", CONTACT_IDS.c, VCARD_THREE),
    ],
    photos: [
      photo(1, asset(1, "image", "2026-10-03T03:10:00.5Z", [resource("photo", 1, "public.jpeg", "IMG_0001.JPG", PHOTO_ORIGINAL)])),
      photo(2, asset(2, "video", "2026-10-03T03:11:00Z", [resource("video", 2, "com.apple.quicktime-movie", "IMG_0002.MOV", null)])),
      photo(3, asset(3, "image", "2026-08-01T03:00:00Z", [resource("photo", 1, "public.jpeg", "IMG_0003.JPG", null)])),
      photo(4, asset(4, "image", null, [resource("photo", 1, "public.jpeg", "IMG_0004.JPG", null)])),
      { domain: "photos", kind: "sweep", sequence: 5, captured: { wall_rfc3339: "2026-10-03T09:35:00.5+05:30" }, payload: { assets_seen: 5, complete: true } },
      photo(6, asset(5, "image", "2026-10-03T03:15:00Z", [resource("photo", 1, "public.jpeg", "IMG_0005.JPG", null)])),
      availability(5, 7, p5Resources),
    ],
    places: [
      place(1, { slug: "place-a", name: "Place A", centre: { latitude: 0.5, longitude: -0.25 }, radius_m: 150, retired: false }),
      place(2, { slug: "place-b", name: "Place B", centre: { latitude: -0.5, longitude: 0.25 }, radius_m: 80, retired: false }),
      place(3, { slug: "place-a", name: "Place A", centre: { latitude: 0.5001, longitude: -0.25 }, radius_m: 200, retired: false }),
    ],
    checkin: [
      checkin(1, "access", "2026-10-03T03:30:00Z", { notifications: "authorized" }),
      checkin(2, "report", "2026-10-03T03:31:10Z", {
        form: "moment", form_version: 1, prompt_id: PROMPT, trigger: "random",
        opened_at: "2026-10-03T03:31:00Z", answered_at: "2026-10-03T03:31:10Z", local_zone: "Etc/GMT-3",
        response_ms: 10000, changes: 1, awake_for_s: 3600, wake_source: "default", block_id: null,
        items: [
          { id: "energy", question: "How much energy?", scale: 5, anchors: ["none", "plenty"], value: 3 },
          { id: "satisfaction", question: "How satisfied?", scale: 10, anchors: ["not", "very"], value: 0 },
        ],
        note: "a synthetic note",
      }),
      checkin(3, "vigilance", "2026-10-03T03:35:00Z", {
        protocol: "pvt-b-3min-v1", duration_ms: 180000, isi_ms: [2000, 10000], lapse_threshold_ms: 500,
        false_start_under_ms: 100, timeout_ms: 30000, prompt_id: null, trigger: "manual",
        started_at: "2026-10-03T03:35:00Z", ended_at: "2026-10-03T03:38:00Z", completed: true, session_number: 1,
        awake_for_s: null, wake_source: null, device: { model: "iPhoneSynthetic,1", os: "SyntheticOS 1.0", refresh_hz: 120, low_power: false },
        trials: [
          { n: 1, isi_ms: 3500, stimulus_ms: 3500, response_ms: 3790.25, rt_ms: 290.25, class: "response" },
          { n: 2, isi_ms: 2100, stimulus_ms: null, response_ms: null, rt_ms: null, class: null },
        ],
        interruptions: [{ at_ms: 1200, reason: "background" }],
      }),
      checkin(4, "prompt", "2026-10-03T03:40:00Z", {
        prompt_id: PROMPT, form: "moment", trigger: "random", scheduled_for: "2026-10-03T03:40:00Z",
        window_start: "2026-10-03T03:40:00Z", window_end: "2026-10-03T04:10:00Z", event: "delivered",
      }),
    ],
    orbit: [{ domain: "orbit", kind: "ping", sequence: 1, payload: {} }],
  }, [VOICE_BLOB, CAMERA_BLOB, PHOTO_ORIGINAL, PHOTO_FIVE, CONTACT_PHOTO]);
}

export function secondBundle(): SyntheticBundle {
  const p1Resources = [
    resource("photo", 1, "public.jpeg", "IMG_0001.JPG", PHOTO_ORIGINAL),
    { ...resource("full_size_photo", 5, "public.jpeg", "FullSizeRender.jpg", PHOTO_EDIT), blob: blobRef(PHOTO_EDIT, "image/jpeg", "full_size_photo") },
  ];
  return bundle("second", "2026-10-03T10:00:00.250+05:30", {
    location: [fix(47, 7, 0.5003), fix(48, 8, 0.5004)],
    camera: [entry("camera", "photo", 2, "2026-10-03T04:06:00.5Z", { blob: blobRef(CAMERA_STORED, "image/heic", "photo"), orientation: 6 })],
    health: healthSecond(),
    contacts: [contactCard(5, "2026-10-03T04:00:01.5Z", CONTACT_IDS.a, VCARD_ONE_EDITED, CONTACT_PHOTO), contactGone(6, "2026-10-03T04:00:01.5Z", CONTACT_IDS.c)],
    photos: [availability(1, 8, p1Resources)],
    places: [place(4, { slug: "place-b", name: "Place B", centre: { latitude: -0.5, longitude: 0.25 }, radius_m: 80, retired: true })],
  }, [PHOTO_EDIT], [CAMERA_STORED]);
}

export const shipments = (): SyntheticBundle[] => [firstBundle(), secondBundle()];

export function largeShipment(bytes: number): { created_at: string; members: { name: string; bytes: () => Iterable<Buffer>; method: "deflate" | "stored" }[] } {
  const created_at = "2026-10-03T11:00:00.250+05:30";
  const domains: Record<string, (sequence: number) => object> = {
    location: (sequence) => fix(sequence, sequence % 60, 0.5 + (sequence % 1000) / 1e6),
    health: (sequence) =>
      sequence % 1000 === 0
        ? deletion(sequence, `30000000-0000-4000-8000-${String(sequence - 1).padStart(12, "0")}`, STEPS)
        : sample(sequence, `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, {
            type: STEPS,
            start: new Date(Date.UTC(2026, 9, 3) + sequence * 1000).toISOString(),
            end: new Date(Date.UTC(2026, 9, 3) + sequence * 1000 + 999).toISOString(),
            quantity: `${sequence % 97} count`,
          }),
  };
  const chunks = (domain: string) =>
    function* (): Generator<Buffer> {
      let written = 0;
      for (let sequence = 1; written < bytes; ) {
        const lines: string[] = [];
        for (let i = 0; i < 256; i++, sequence++) lines.push(`${JSON.stringify(domains[domain]!(sequence))}\n`);
        const chunk = Buffer.from(lines.join(""));
        written += chunk.length;
        yield chunk;
      }
    };
  const files: Record<string, unknown> = {};
  const members: { name: string; bytes: () => Iterable<Buffer>; method: "deflate" | "stored" }[] = [];
  for (const domain of Object.keys(domains)) {
    const hash = createHash("sha256");
    let size = 0;
    let observations = 0;
    for (const chunk of chunks(domain)()) {
      hash.update(chunk);
      size += chunk.length;
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) observations++;
    }
    files[`${domain}.jsonl`] = { sha256: `sha256:${hash.digest("hex")}`, bytes: size, observations, first_sequence: 1, last_sequence: observations };
    members.push({ name: `${domain}.jsonl`, bytes: chunks(domain), method: "deflate" });
  }
  const manifest: Record<string, unknown> = {
    schema_version: 3,
    device: { machine_model: "iPhoneSynthetic,1", marketing_name: "Synthetic iPhone", os_version: "SyntheticOS 1.0", install_id: INSTALL, enrolled_at: "2026-08-31T09:00:00+05:30" },
    app_version: "1.0 (1)",
    created_at,
    time_range_covered: { start: "2026-10-03T08:00:00+05:30", end: created_at },
    files,
  };
  manifest.bundle_id = sha(sorted(manifest));
  const text = Buffer.from(JSON.stringify(manifest));
  return { created_at, members: [{ name: "manifest.json", bytes: () => [text], method: "stored" }, ...members] };
}


function domainFixture(domain: string, source: string, heads: readonly string[], entries: () => object[], carried: () => Buffer[] = () => []): Fixture {
  return (folder) => {
    const shipment = bundle(`${domain}-fixture`, "2026-10-03T09:00:00.250+05:30", { [domain]: entries() }, carried());
    mkdirSync(join(folder, "bundle"), { recursive: true });
    mkdirSync(join(folder, "blobs"), { recursive: true });
    const members = shipment.members.filter((member) => !member.name.startsWith("blobs/"));
    for (const member of shipment.members) writeFileSync(join(folder, member.name.startsWith("blobs/") ? member.name : `bundle/${member.name}`), member.bytes);
    return {
      source,
      lane: `phone:${UNIT}`,
      facts: { bundle_id: shipment.bundle_id, created_at: shipment.created_at },
      files: Object.fromEntries(members.map((member) => [`bundle/${member.name}`, "trust" as const])),
      heads,
    };
  };
}

const firstLines = (domain: string) => (): object[] =>
  firstBundle().members.find((member) => member.name === `${domain}.jsonl`)!.bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as object);

export const locationFixture = domainFixture("location", `location:local:${UNIT}`, [`fix ${INSTALL}:41`, `fix ${INSTALL}:42`, `fix ${INSTALL}:46`, `gap ${INSTALL}:43`, `recorder ${INSTALL}:44`, `recorder ${INSTALL}:45`],
  firstLines("location"));
export const motionFixture = domainFixture("motion", `motion:local:${UNIT}`, [`motion ${INSTALL}:7`, `recorder ${INSTALL}:9`, `sample ${INSTALL}:8`], firstLines("motion"));
export const usageFixture = domainFixture("usage", `screen-time:local:${UNIT}`, [`catalog ${INSTALL}:2`, `recorder ${INSTALL}:5`, `usage ${INSTALL}:1`, `usage-event ${INSTALL}:3`, `usage-event ${INSTALL}:4`],
  firstLines("usage"));
export const voiceFixture = domainFixture("voice", `voice-notes:local:${UNIT}`, [`voice ${INSTALL}:1`], firstLines("voice"));
export const cameraFixture = domainFixture("camera", `camera:local:${UNIT}`, [`img ${INSTALL}:1`], firstLines("camera"));
export const checkinFixture = domainFixture("checkin", `checkin:local:${UNIT}`, [`prompt ${INSTALL}:4`, `report ${INSTALL}:2`, `vigilance ${INSTALL}:3`], firstLines("checkin"));
export const photosFixture = domainFixture("photos", `apple-photos:${HEALTH_ACCOUNT}:${UNIT}`, ["img AAAAAAAA-0000-4000-8000-000000000001/L0/001:20261003T031105.123451Z", "img AAAAAAAA-0000-4000-8000-000000000002/L0/001:20261003T031205.123452Z", "img AAAAAAAA-0000-4000-8000-000000000003/L0/001:20261003T031305.123453Z", "img AAAAAAAA-0000-4000-8000-000000000004/L0/001:20261003T031405.123454Z", "img AAAAAAAA-0000-4000-8000-000000000005/L0/001:20261003T031505.123455Z", "img-file AAAAAAAA-0000-4000-8000-000000000005/L0/001:20261003T031505.123455Z:sha256:97e96977c9abd68487960138c62b265538c58f548b748f8cbd32afa38d11e073", `recorder ${INSTALL}:5`],
  firstLines("photos"));
export const healthFixture = domainFixture("health", `apple-health:${HEALTH_ACCOUNT}:cloud`, ["sample 3baa65df1d13", "sample 416268519e4c", "sample 9b3e5d0ed945", "sample bd813c80f44c", "sample e60860f5bab9", "sample-uuid 10000000-0000-4000-8000-000000000001", "sample-uuid 10000000-0000-4000-8000-000000000002", "sample-uuid 10000000-0000-4000-8000-000000000003", "sample-uuid 10000000-0000-4000-8000-000000000004", "sample-uuid 10000000-0000-4000-8000-000000000305"],
  () => healthFirst().slice(0, 9));
export const contactsFixture = domainFixture("contacts", `apple-contacts:${HEALTH_ACCOUNT}:${UNIT}`, Object.values(CONTACT_IDS).map((id) => `contact ${id}`),
  firstLines("contacts"), () => [CONTACT_PHOTO]);
const RICH = Buffer.from("synthetic rich text archive");
export const notesFixture = domainFixture("notes", `notes:local:${UNIT}`, ["folder 00000000-0000-4000-8000-00000000f001", "folder 00000000-0000-4000-8000-00000000f002", "note 00000000-0000-4000-8000-00000000a001"],
  () => [
    ...[1, 2].map((sequence) =>
      entry("notes", "folder", sequence, "2026-10-03T03:00:00Z", {
        id: `00000000-0000-4000-8000-00000000f00${sequence}`, name: `Synthetic folder ${sequence}`, parent: null, sort_index: sequence, default: sequence === 1,
        created: "2026-10-03T03:00:00Z", modified: "2026-10-03T03:00:00Z", deleted: false,
      })),
    entry("notes", "note", 3, "2026-10-03T03:10:00Z", {
      id: "00000000-0000-4000-8000-00000000a001", folder: "00000000-0000-4000-8000-00000000f001", title: "Synthetic note", text: "Synthetic text.",
      created: "2026-10-03T03:05:00Z", modified: "2026-10-03T03:10:00Z", pinned: false, pin_order: 0, deleted_at: null, purged: false,
      rich: { hash: sha(RICH), bytes: RICH.length }, attachments: [],
    }),
  ], () => [RICH]);
const SHARED = Buffer.from("synthetic shared file");
export const uploadFixture = domainFixture("upload", `upload:local:${UNIT}`, [`file ${sha(SHARED).slice(7)}`], () => [
  entry("upload", "file", 1, "2026-10-03T03:07:00.5Z", { name: "synthetic.txt", blob: { hash: sha(SHARED), bytes: SHARED.length, type: "text/plain", role: "original" } }),
], () => [SHARED]);
export const energyFixture = domainFixture("energy", `energy:local:${UNIT}`, [`energy ${INSTALL}:1`, `energy ${INSTALL}:2`], () => [
  entry("energy", "power_state", 1, "2026-10-03T03:00:00.125Z", { reason: "level_changed", battery_level: 0.5, low_power_mode: false, thermal_state: "nominal" }),
  entry("energy", "power_state", 2, "2026-10-03T03:20:00.125Z", { reason: "level_changed", battery_level: 0.45, low_power_mode: false, thermal_state: "nominal" }),
]);
export const machineFixture = domainFixture("machine", `machine:local:${UNIT}`, [`machine-event ${INSTALL}:1`, `machine-event ${INSTALL}:2`], () => [
  entry("machine", "machine-event", 1, "2026-10-03T02:00:00.125Z", { event: "state", detail: { access_location: "on", access_motion: "on" } }),
  entry("machine", "machine-event", 2, "2026-10-03T02:01:30Z", { event: "access", detail: { grant: "location", state: "limited" } }),
]);
