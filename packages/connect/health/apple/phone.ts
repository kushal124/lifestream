import { attempt, canonical, checks, each, fingerprint, isObject, refuse, Refused, type Json, type JsonObject, type Reader, type ReaderOutput, type ReaderView } from "@lifestreamprotocol/connect/sdk";
import * as phoneShipment from "../../shared/phone-shipment.js";
import {
  projectSample, sampleGuard, sampleKey, uuidContent, uuidIdentity, workoutDetail, workoutGuard, WORKOUT_TYPE,
  type Identity, type Projected, type Quantity, type WorkoutEvent, type WorkoutStatistic,
} from "./samples.js";
import { characteristicGuard, characteristicRow } from "./characteristics.js";

const { exact, finite, first, guard, positive, rfc3339, text, UUID } = checks;
const { at, between, capture, readShipment } = phoneShipment;
type Shipment = phoneShipment.Shipment;

const FILE = "health.jsonl";

const BY_UUID: Record<string, { kind: "state-of-mind" | "dose"; member: string }> = {
  HKDataTypeStateOfMind: { kind: "state-of-mind", member: "state_of_mind" },
  HKMedicationDoseEventTypeIdentifierMedicationDoseEvent: { kind: "dose", member: "medication_dose_event" },
};

const UUID_KEYED = ["type", "uuid", "sample_type", "start_date_rfc3339", "start_date_unix_seconds", "end_date_rfc3339", "end_date_unix_seconds", "source_revision", "device", "metadata"];

export const health: Reader = {
  name: "health-ios-bundle",
  kinds: {
    sample: sampleGuard,
    workout: workoutGuard,
    characteristic: characteristicGuard,
    "sample-uuid": guard((content) =>
      first([
        ["content must be a health.sample-uuid", () => exact(content, ["type", "uuid", "sample_type", "start", "end", "value", "unit", "source_name", "source_version"]) && (content as JsonObject).type === "health.sample-uuid"],
        ["content.uuid must be a lowercase UUID", () => { const uuid = (content as JsonObject).uuid; return typeof uuid === "string" && UUID.test(uuid) && uuid === uuid.toLowerCase(); }],
        ["the identity members must be strings", () => uuidIdentity(content) !== undefined],
      ]),
    ),
    "state-of-mind": guard((content) =>
      uuidKeyed(content, "state-of-mind") ??
      first([
        ["content.state_of_mind states kind, valence, valence_classification, labels and associations", () => exact((content as JsonObject).state_of_mind, ["kind", "valence", "valence_classification", "labels", "associations"])],
        ["kind and valence_classification must be integers, valence a number, labels and associations integer lists", () => {
          const mind = (content as JsonObject).state_of_mind as JsonObject;
          return integer(mind.kind) && finite(mind.valence) && integer(mind.valence_classification) && integers(mind.labels) && integers(mind.associations);
        }],
      ]),
    ),
    dose: guard((content) =>
      uuidKeyed(content, "dose") ??
      first([
        ["content.medication_dose_event states its log status, schedule, quantities, unit and medication", () => exact((content as JsonObject).medication_dose_event, ["log_status", "schedule_type", "scheduled_date_rfc3339", "scheduled_dose_quantity", "dose_quantity", "unit", "medication_concept_identifier", "medication"])],
        ["log_status and schedule_type must be integers, the quantities numbers or null, the unit text", () => {
          const dose = (content as JsonObject).medication_dose_event as JsonObject;
          return integer(dose.log_status) && integer(dose.schedule_type) && (dose.scheduled_date_rfc3339 === null || rfc3339(dose.scheduled_date_rfc3339)) && orNull(dose.scheduled_dose_quantity, finite) && orNull(dose.dose_quantity, finite) && text(dose.unit);
        }],
        ["medication_concept_identifier states its domain and archive", () => conceptIdentifier(((content as JsonObject).medication_dose_event as JsonObject).medication_concept_identifier)],
        ["medication must be null or a concept: display_text, general_form, related_codings", () => orNull(((content as JsonObject).medication_dose_event as JsonObject).medication, concept)],
      ]),
    ),
    medication: guard((content) =>
      first([
        ["content must be a health.medication: nickname, is_archived, has_schedule, concept, concept_identifier", () => exact(content, ["type", "nickname", "is_archived", "has_schedule", "concept", "concept_identifier"]) && content.type === "health.medication"],
        ["nickname must be text or null, is_archived and has_schedule booleans", () => {
          const { nickname, is_archived, has_schedule } = content as JsonObject;
          return orNull(nickname, (value) => typeof value === "string") && typeof is_archived === "boolean" && typeof has_schedule === "boolean";
        }],
        ["concept must state display_text, general_form, related_codings", () => concept((content as JsonObject).concept)],
        ["concept_identifier states its domain and archive", () => conceptIdentifier((content as JsonObject).concept_identifier)],
      ]),
    ),
    recorder: guard((content) => {
      if (!exact(content, ["type", "content"]) || content.type !== "health.recorder" || !isObject(content.content)) return "content must be {type: health.recorder, content}";
      const line = content.content;
      return first([
        ["content.domain and kind must be health and recorder_event", () => line.domain === "health" && line.kind === "recorder_event"],
        ["content.sequence must be a positive integer", () => positive(line.sequence)],
        ["content.captured.wall_rfc3339 must be an RFC 3339 instant", () => isObject(line.captured) && rfc3339(line.captured.wall_rfc3339)],
        ["content.payload must be an object", () => isObject(line.payload)],
      ]);
    }),
  },
  read: (delivery, files, view) =>
    readShipment(delivery, files, async function* (shipment) {
      const deleted = await deletedUuids(shipment, delivery.source, view);
      const named = deleted.size === 0 ? new Map<string, Named>() : await deletions(shipment, deleted, delivery.source, view);
      yield* emit(shipment, named);
    }),
};

function uuidKeyed(content: Json, kind: "state-of-mind" | "dose"): string | undefined {
  const [type, entry] = Object.entries(BY_UUID).find(([, entry]) => entry.kind === kind)!;
  return first([
    [`content must be a health.${kind}`, () => exact(content, [...UUID_KEYED, entry.member]) && content.type === `health.${kind}` && content.sample_type === type],
    ["content.uuid must be a lowercase UUID", () => { const id = (content as JsonObject).uuid; return typeof id === "string" && UUID.test(id) && id === id.toLowerCase(); }],
    ["content.start_date_rfc3339 and end_date_rfc3339 must be RFC 3339 instants", () => rfc3339((content as JsonObject).start_date_rfc3339) && rfc3339((content as JsonObject).end_date_rfc3339)],
    ["content.source_revision must be an object; device and metadata objects or null", () => {
      const { source_revision, device, metadata } = content as JsonObject;
      return isObject(source_revision) && (device === null || isObject(device)) && (metadata === null || isObject(metadata));
    }],
  ]);
}

function concept(value: Json | undefined): boolean {
  if (!exact(value, ["display_text", "general_form", "related_codings"]) || typeof value.display_text !== "string" || !text(value.general_form) || !Array.isArray(value.related_codings)) return false;
  return value.related_codings.every((coding) => exact(coding, ["system", "version", "code"]) && text(coding.system) && text(coding.code) && orNull(coding.version, (version) => typeof version === "string"));
}

function conceptIdentifier(value: Json | undefined): boolean {
  return exact(value, ["domain", "archive_base64"]) && text(value.domain) && orNull(value.archive_base64, (archive) => typeof archive === "string");
}

const integer = (value: Json | undefined): value is number => typeof value === "number" && Number.isSafeInteger(value);
const integers = (value: Json | undefined): boolean => Array.isArray(value) && value.every(integer);
const orNull = (value: Json | undefined, check: (value: Json | undefined) => boolean): boolean => value === null || check(value);

async function deletedUuids(shipment: Shipment, source: string, view: ReaderView | undefined): Promise<Map<string, string>> {
  const deleted = new Map<string, string>();
  for await (const part of shipment.entries("health")) {
    const read = attempt(part.read);
    const entry = read instanceof Refused ? undefined : read.entry;
    const payload = entry?.payload;
    if (!isObject(payload) || typeof payload.uuid !== "string" || typeof payload.sample_type !== "string") continue;
    const id = payload.uuid.toLowerCase();
    if (entry?.kind === "deleted_sample") deleted.set(id, payload.sample_type);
    else if (entry?.kind === "sample" && !deleted.has(id) && BY_UUID[payload.sample_type] === undefined) {
      if (view?.head({ source, kind: "sample-uuid", key: id })?.version === "gone") deleted.set(id, payload.sample_type);
    }
  }
  return deleted;
}

type Named = string[] | Refused;

async function deletions(shipment: Shipment, deleted: Map<string, string>, source: string, view: ReaderView | undefined): Promise<Map<string, Named>> {
  const identities = new Map<string, Identity>();
  const stated = new Map<string, string>();
  for await (const part of shipment.entries("health")) {
    const read = attempt(part.read);
    if (read instanceof Refused) continue;
    const payload = read.entry.payload;
    if (read.entry.kind !== "sample" || !isObject(payload) || typeof payload.uuid !== "string" || typeof payload.sample_type !== "string") continue;
    const id = payload.uuid.toLowerCase();
    if (!deleted.has(id)) continue;
    stated.set(id, payload.sample_type);
    if (BY_UUID[payload.sample_type] !== undefined) continue;
    const identity = attempt(() => project(payload, read.line).identity);
    if (!(identity instanceof Refused)) identities.set(id, identity);
  }
  const named = new Map<string, Named>();
  for (const [id, type] of deleted) {
    const statedType = stated.get(id);
    const mismatch = (other: string) => new Refused(`the deletion of ${id} states ${type}; its sample is ${other}`);
    if (statedType !== undefined && statedType !== type) {
      named.set(id, mismatch(statedType));
      continue;
    }
    const byUuid = BY_UUID[type];
    if (byUuid !== undefined) {
      named.set(id, [`${byUuid.kind}:${id}`]);
      continue;
    }
    const head = identities.has(id) ? undefined : view?.head({ source, kind: "sample-uuid", key: id });
    const identity = identities.get(id) ?? (head === undefined || head.version === "gone" ? undefined : uuidIdentity(view!.version(head.version).content));
    if (identity !== undefined && identity.sample_type !== type) named.set(id, mismatch(identity.sample_type));
    else named.set(id, [...(identity === undefined ? [] : [`${kindOf(identity)}:${sampleKey(identity)}`]), `sample-uuid:${id}`]);
  }
  return named;
}

async function* emit(shipment: Shipment, named: Map<string, Named>): AsyncGenerator<ReaderOutput> {
  const gone = new Set([...named.values()].flatMap((records) => (records instanceof Refused ? [] : records)));
  const deleted = (id: string): boolean => Array.isArray(named.get(id));
  const restated = new Set<string>();
  yield* each(shipment.entries("health"), (part) => part.where, async function* ({ where, read }) {
    const { line, sequence, entry } = read();
    const kind = entry.kind;
    if (kind === "sample") {
      const payload = object(entry.payload, `${where}.payload`);
      const id = uuid(payload.uuid, `${where}.payload.uuid`);
      const row = capture(shipment, "health", line);
      const byUuid = BY_UUID[string(payload.sample_type, `${where}.payload.sample_type`)];
      if (byUuid !== undefined) {
        if (deleted(id)) return;
        const { secure_archive_base64: _archive, ...stated } = payload;
        const time = between(payload.start_date_rfc3339, payload.end_date_rfc3339, `${where}.payload`);
        yield { kind: byUuid.kind, key: id, content: { type: `health.${byUuid.kind}`, ...stated, uuid: id }, time, ...row };
        return;
      }
      const sample = project(payload, line);
      const kind = kindOf(sample.identity);
      const record = `${kind}:${sample.key}`;
      yield { kind: "sample-uuid", key: id, content: uuidContent(id, sample.identity), time: sample.time, ...row };
      if (deleted(id)) return;
      if (gone.has(record)) restated.add(record);
      yield { kind, key: sample.key, content: sample.content, time: sample.time, ...seriesBlobs(sample.content, where), ...row };
    } else if (kind === "deleted_sample") {
      const payload = object(entry.payload, `${where}.payload`);
      const id = uuid(payload.uuid, `${where}.payload.uuid`);
      string(payload.sample_type, `${where}.payload.sample_type`);
      const record = named.get(id);
      if (record instanceof Refused) throw record;
    } else if (kind === "medication_list") {
      const medications = object(entry.payload, `${where}.payload`).medications;
      if (!Array.isArray(medications)) refuse(`${where}.payload.medications must be a list`);
      const place = (index: number) => `${where}.payload.medications[${index}]`;
      yield* each(medications.entries(), ([index]) => place(index), ([index, medication]): ReaderOutput[] => {
        const stated = object(medication, place(index));
        return [{ kind: "medication", key: medicationKey(stated.concept, `${place(index)}.concept`), content: { type: "health.medication", ...stated }, ...capture(shipment, "health", line) }];
      });
    } else if (kind === "characteristics") {
      const facts = object(entry.payload, `${where}.payload`).characteristics;
      if (!Array.isArray(facts)) refuse(`${where}.payload.characteristics must be a list`);
      const place = (index: number) => `${where}.payload.characteristics[${index}]`;
      yield* each(facts.entries(), ([index]) => place(index), ([index, fact]): ReaderOutput[] => {
        const stated = object(fact, place(index));
        if (!exact(stated, ["identifier", "value"])) refuse(`${place(index)} must state identifier and value`);
        return [{ ...characteristicRow(stated.identifier, stated.value, place(index)), ...capture(shipment, "health", line) }];
      });
    } else if (kind === "recorder_event") {
      const wall = object(entry.captured, `${where}.captured`).wall_rfc3339;
      yield { kind: "recorder", key: `${shipment.install}:${sequence}`, content: { type: "health.recorder", content: entry }, time: at(wall, `${where}.captured.wall_rfc3339`), ...capture(shipment, "health", line) };
    } else if (kind !== "workout_route") {
      refuse(`${where} is a health entry kind this connector does not know: ${JSON.stringify(kind)}`);
    }
  });
  for (const record of gone) {
    if (restated.has(record)) continue;
    const colon = record.indexOf(":");
    yield { kind: record.slice(0, colon), key: record.slice(colon + 1), content: null, gone: true, ...(shipment.unit === undefined ? {} : { device: shipment.unit }) };
  }
}

const SERIES = [["electrocardiogram", "voltages"], ["heartbeat_series", "beats"]] as const;

function seriesBlobs(content: JsonObject, where: string): Pick<ReaderOutput, "blobs" | "media"> {
  const detail = isObject(content.detail) ? content.detail : {};
  const named = SERIES.flatMap(([member, series]) => {
    const stated = detail[member];
    if (!isObject(stated) || stated[series] === undefined) return [];
    const ref = stated[series];
    if (!exact(ref, ["hash", "bytes", "type"]) || typeof ref.hash !== "string" || !SHA256.test(ref.hash) || !positiveOrZero(ref.bytes) || !text(ref.type)) {
      refuse(`${where}.payload.${member}.${series} must name a blob: hash, bytes, type`);
    }
    return [{ hash: ref.hash, type: ref.type as string }];
  });
  return named.length === 0 ? {} : { blobs: named.map(({ hash }) => hash), media: Object.fromEntries(named.map(({ hash, type }) => [hash, type])) };
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const positiveOrZero = (value: Json | undefined): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function kindOf(identity: Identity): "sample" | "workout" {
  return identity.sample_type === WORKOUT_TYPE ? "workout" : "sample";
}

const SAMPLE_LINE = new Set([
  "uuid", "sample_type", "start_date_rfc3339", "start_date_unix_seconds", "end_date_rfc3339", "end_date_unix_seconds",
  "source_revision", "device", "metadata", "secure_archive_base64", "quantity_value", "quantity_unit", "quantity_description", "category_value",
]);

function project(payload: JsonObject, line: number): Projected {
  const where = `${FILE} line ${line}.payload`;
  const revision = object(payload.source_revision, `${where}.source_revision`);
  const version = optional(revision.version, `${where}.source_revision.version`);
  const device = payload.device === null || payload.device === undefined ? undefined : object(payload.device, `${where}.device`);
  const hardware = optional(device?.hardware_version, `${where}.device.hardware_version`);
  const software = optional(device?.software_version, `${where}.device.software_version`);
  const metadata = payload.metadata === null || payload.metadata === undefined ? {} : object(payload.metadata, `${where}.metadata`);
  const common = {
    path: "bundle" as const,
    sample_type: string(payload.sample_type, `${where}.sample_type`),
    start: string(payload.start_date_rfc3339, `${where}.start_date_rfc3339`),
    end: string(payload.end_date_rfc3339, `${where}.end_date_rfc3339`),
    source_name: string(revision.source_name, `${where}.source_revision.source_name`),
    ...(version === undefined ? {} : { source_version: version }),
    ...(hardware === undefined && software === undefined
      ? {}
      : { device: { ...(hardware === undefined ? {} : { hardware_model: hardware }), ...(software === undefined ? {} : { software_version: software }) } }),
    metadata,
  };
  const rest = Object.fromEntries(Object.entries(payload).filter(([name]) => !SAMPLE_LINE.has(name)));
  if (common.sample_type === WORKOUT_TYPE) return projectSample({ ...common, ...workoutFacts(rest, where) });
  const detail = Object.keys(rest).length === 0 ? {} : { detail: rest };
  if (payload.category_value !== undefined) {
    if (typeof payload.category_value !== "number") refuse(`${where}.category_value must be a number`);
    return projectSample({ ...common, value: payload.category_value, ...detail });
  }
  if (payload.quantity_value !== undefined) {
    if (typeof payload.quantity_value !== "number" || !Number.isFinite(payload.quantity_value)) refuse(`${where}.quantity_value must be a finite number`);
    return projectSample({ ...common, value: payload.quantity_value, unit: string(payload.quantity_unit, `${where}.quantity_unit`), ...detail });
  }
  if (payload.quantity_description === undefined) return projectSample({ ...common, value: "", ...detail });
  const quantity = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+(.+)$/u.exec(string(payload.quantity_description, `${where}.quantity_description`));
  if (quantity === null) refuse(`${where}.quantity_description is not '<decimal> <unit>'`);
  return projectSample({ ...common, value: quantity[1]!, unit: quantity[2]!, described: true, ...detail });
}

function workoutFacts(rest: JsonObject, where: string): { value: number; detail: JsonObject } {
  const {
    workout_activity_type: activity, duration_seconds: duration, total_distance: distance, total_energy: energy,
    total_distance_description: described, workout_statistics: statistics, workout_events: events, ...stated
  } = rest;
  if (typeof activity !== "number") refuse(`${where}.workout_activity_type must be a number`);
  if (duration !== undefined && duration !== null && typeof duration !== "number") refuse(`${where}.duration_seconds must be a number`);
  if (described !== undefined && described !== null && typeof described !== "string") refuse(`${where}.total_distance_description must be text`);
  const description = typeof described === "string" ? /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+(.+)$/u.exec(described) : null;
  if (typeof described === "string" && description === null) refuse(`${where}.total_distance_description is not '<decimal> <unit>'`);
  const list = events === undefined || events === null ? [] : events;
  if (!Array.isArray(list)) refuse(`${where}.workout_events must be a list`);
  const stats = statistics === undefined || statistics === null ? [] : statistics;
  if (!Array.isArray(stats)) refuse(`${where}.workout_statistics must be a list`);
  return {
    value: activity,
    detail: workoutDetail("bundle", {
      duration_s: typeof duration === "number" ? duration : null,
      distance: quantityOf(distance, `${where}.total_distance`) ?? (description === null ? null : { value: Number(description[1]), unit: description[2]! }),
      energy: quantityOf(energy, `${where}.total_energy`),
      statistics: stats.map((raw, index): WorkoutStatistic => {
        const at = `${where}.workout_statistics[${index}]`;
        const stat = object(raw, at);
        const figure = (name: string): number | null => {
          const value = stat[name];
          if (value === null || value === undefined) return null;
          if (typeof value !== "number" || !Number.isFinite(value)) refuse(`${at}.${name} must be a number or null`);
          return value;
        };
        return { type: string(stat.type, `${at}.type`), start: string(stat.start, `${at}.start`), end: string(stat.end, `${at}.end`),
          sum: figure("sum"), average: figure("average"), minimum: figure("minimum"), maximum: figure("maximum"), unit: string(stat.unit, `${at}.unit`) };
      }),
      events: list.map((raw, index): WorkoutEvent => {
        const event = object(raw, `${where}.workout_events[${index}]`);
        const start = string(event.date_interval_start, `${where}.workout_events[${index}].date_interval_start`);
        const end = string(event.date_interval_end, `${where}.workout_events[${index}].date_interval_end`);
        if (typeof event.type !== "number") refuse(`${where}.workout_events[${index}].type must be a number`);
        return { type: event.type, start, duration_s: (Date.parse(end) - Date.parse(start)) / 1000,
          metadata: event.metadata === null || event.metadata === undefined ? {} : object(event.metadata, `${where}.workout_events[${index}].metadata`) };
      }),
      stated,
    }),
  };
}

function quantityOf(value: Json | undefined, where: string): Quantity | null {
  if (value === undefined || value === null) return null;
  const stated = object(value, where);
  if (typeof stated.value !== "number" || !Number.isFinite(stated.value)) refuse(`${where}.value must be a finite number`);
  return { value: stated.value, unit: string(stated.unit, `${where}.unit`) };
}

function medicationKey(value: Json | undefined, where: string): string {
  if (!concept(value)) refuse(`${where} must state display_text, general_form and related_codings`);
  const { display_text, general_form, related_codings } = value as JsonObject;
  const codings = (related_codings as Json[]).map((coding) => [canonical(coding), coding] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, coding]) => coding);
  return fingerprint({ display_text: display_text!, general_form: general_form!, related_codings: codings });
}

function object(value: Json | undefined, where: string): JsonObject {
  if (!isObject(value)) refuse(`${where} must be an object`);
  return value;
}

function string(value: Json | undefined, where: string): string {
  if (typeof value !== "string" || value.length === 0) refuse(`${where} must be a non-empty string`);
  return value;
}

function optional(value: Json | undefined, where: string): string | undefined {
  return value === undefined || value === null ? undefined : string(value, where);
}

function uuid(value: Json | undefined, where: string): string {
  const id = string(value, where).toLowerCase();
  if (!UUID.test(id)) refuse(`${where} is not a UUID`);
  return id;
}
