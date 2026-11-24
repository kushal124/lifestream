import { each, fileMember, instant, refuse, tryInstant, zipped, type Json, type JsonObject, type Member, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import {
  exportInstant, projectSample, QUANTITY_UNITS, renderDecimal, sampleGuard, workoutDetail, workoutGuard, WORKOUT_TYPE,
  type Quantity, type WorkoutEvent, type WorkoutStatistic,
} from "./samples.js";
import { rootChildren, type XmlElement } from "./xml.js";
import { CHARACTERISTIC_PREFIX, characteristicGuard, characteristicRow } from "./characteristics.js";

const RECORD_ATTRIBUTES = new Set(["type", "unit", "value", "sourceName", "sourceVersion", "device", "creationDate", "startDate", "endDate"]);
const RECORD_REQUIRED = ["type", "value", "sourceName", "startDate", "endDate"];
const SUMMARY_ATTRIBUTES = [
  "dateComponents",
  "activeEnergyBurned",
  "activeEnergyBurnedGoal",
  "activeEnergyBurnedUnit",
  "appleMoveTime",
  "appleMoveTimeGoal",
  "appleExerciseTime",
  "appleExerciseTimeGoal",
  "appleStandHours",
  "appleStandHoursGoal",
];
const LANDS_NOTHING = new Set(["ExportDate", "ClinicalRecord"]);
const IDENTITY_ATTRIBUTES = new Set(["type", "sourceName", "sourceVersion", "device", "creationDate", "startDate", "endDate"]);
const SECONDS: Readonly<Record<string, number>> = { s: 1, min: 60, hr: 3600, ms: 0.001 };
const VISION_PRESCRIPTION = "HKVisionPrescriptionTypeIdentifier";
const SUMMARY_MEMBERS = ["type", "date", "active_energy_burned", "active_energy_burned_goal", "active_energy_unit", "move_time", "move_time_goal", "exercise_time", "exercise_time_goal", "stand_hours", "stand_hours_goal"];

export const healthExport: Reader = {
  name: "health-export",
  kinds: {
    sample: sampleGuard,
    workout: workoutGuard,
    characteristic: characteristicGuard,
    "day-summary": (content: Json) => {
      if (content === null || typeof content !== "object" || Array.isArray(content) || content.type !== "health.day-summary") return ["content.type must be health.day-summary"];
      const names = Object.keys(content);
      if (names.length !== SUMMARY_MEMBERS.length || !SUMMARY_MEMBERS.every((name) => typeof content[name] === "string")) return [`content members must be ${SUMMARY_MEMBERS.join(", ")}, as strings`];
      if (!calendarDate(content.date as string)) return ["content.date must be a calendar date, YYYY-MM-DD"];
      if (content.active_energy_unit !== QUANTITY_UNITS.HKQuantityTypeIdentifierActiveEnergyBurned!.canonical) return ["content.active_energy_unit must be kcal"];
      return [];
    },
  },
  async *read(delivery, files) {
    const xml = delivery.files.filter((file) => file.path === "export.xml" || file.path.endsWith("/export.xml"));
    const zips = delivery.files.filter((file) => file.path.endsWith(".zip"));
    if (xml.length + zips.length !== 1) refuse(`a health export delivery holds one export.xml or one ZIP; ${delivery.id} holds ${xml.length + zips.length}`);
    yield* zipped(delivery, files, async function* (members) {
      const exports: Member[] = [...xml.map((file) => fileMember(files, file)), ...members.filter((member) => member.name === "export.xml" || member.name.endsWith("/export.xml"))];
      if (exports.length !== 1) refuse(`the export ZIP holds ${exports.length} export.xml members`);
      yield* each(exports, (source) => source.where, (source) => each(numbered(rootChildren(source.chunks(), "HealthData")), ({ element, index }) => `export.xml ${element.name} ${index}`, ({ element, index }) => {
        if (element.name === "Record") return [record(element, index)];
        if (element.name === "ActivitySummary") return [summary(element, index)];
        if (element.name === "Workout") return [workout(element, index)];
        if (element.name === "Correlation" || element.name === "Audiogram") return [compound(element, index)];
        if (element.name === "VisionPrescription") return [prescription(element, index)];
        if (element.name === "Me") return characteristics(element, index);
        if (!LANDS_NOTHING.has(element.name)) refuse(`<${element.name}> is a HealthData element this connector does not read`);
        return [];
      }));
    });
  },
};

async function* numbered(elements: AsyncIterable<XmlElement>): AsyncGenerator<{ element: XmlElement; index: number }> {
  const counts = new Map<string, number>();
  for await (const element of elements) {
    const index = (counts.get(element.name) ?? 0) + 1;
    counts.set(element.name, index);
    yield { element, index };
  }
}

function record(element: XmlElement, index: number, label = `Record ${index}`): ReaderOutput {
  for (const name of element.attributes.keys()) if (!RECORD_ATTRIBUTES.has(name)) refuse(`${label} states an attribute this connector does not know: ${name}`);
  for (const name of RECORD_REQUIRED) if (!element.attributes.has(name)) refuse(`${label} states no ${name}`);
  const unit = element.attributes.get("unit");
  const sample = projectSample({
    ...identityOf(element, label),
    value: element.attributes.get("value")!,
    ...(unit === undefined ? {} : { unit }),
  });
  return { kind: "sample", key: sample.key, content: sample.content, time: sample.time, locator: `export.xml ${label}` };
}

function identityOf(element: XmlElement, label: string, type = element.attributes.get("type")) {
  const attribute = (name: string): string | undefined => element.attributes.get(name);
  for (const name of ["sourceName", "startDate", "endDate"]) if (attribute(name) === undefined) refuse(`${label} states no ${name}`);
  if (type === undefined) refuse(`${label} states no type`);
  const version = attribute("sourceVersion");
  const device = stableDevice(attribute("device"));
  return {
    path: "export" as const,
    sample_type: type,
    start: exportInstant(attribute("startDate")!, `${label} startDate`),
    end: exportInstant(attribute("endDate")!, `${label} endDate`),
    source_name: attribute("sourceName")!,
    ...(version === undefined ? {} : { source_version: version }),
    ...(device === undefined ? {} : { device }),
    metadata: metadataOf(element, label),
  };
}

function metadataOf(element: XmlElement, label: string): JsonObject {
  const metadata: JsonObject = {};
  for (const child of element.children) {
    if (child.name !== "MetadataEntry") continue;
    const key = child.attributes.get("key");
    const value = child.attributes.get("value");
    if (key === undefined || value === undefined) refuse(`${label} has a MetadataEntry without key or value`);
    if (metadata[key] !== undefined) refuse(`${label} repeats metadata key ${JSON.stringify(key)}`);
    metadata[key] = value;
  }
  return metadata;
}

function attributesOf(element: XmlElement, skip: ReadonlySet<string> = new Set()): JsonObject {
  return Object.fromEntries([...element.attributes].filter(([name]) => !skip.has(name)));
}

function workout(element: XmlElement, index: number): ReaderOutput {
  const label = `Workout ${index}`;
  const attribute = (name: string): string | undefined => element.attributes.get(name);
  const activity = attribute("workoutActivityType");
  if (activity === undefined) refuse(`${label} states no workoutActivityType`);
  const seconds = (value: string | undefined, unit: string | undefined): number | null =>
    value === undefined || Number.isNaN(Number(value)) || SECONDS[unit ?? "min"] === undefined ? null : Number(value) * SECONDS[unit ?? "min"]!;
  const used = new Set([...IDENTITY_ATTRIBUTES, "workoutActivityType", "duration", "durationUnit", "totalDistance", "totalDistanceUnit", "totalEnergyBurned", "totalEnergyBurnedUnit"]);
  const stated: JsonObject = attributesOf(element, used);
  const duration = seconds(attribute("duration"), attribute("durationUnit"));
  if (duration === null && attribute("duration") !== undefined) Object.assign(stated, { duration: attribute("duration")!, durationUnit: attribute("durationUnit") ?? null });
  const others = element.children.filter((child) => !["MetadataEntry", "WorkoutEvent", "WorkoutRoute", "WorkoutStatistics"].includes(child.name));
  if (others.length > 0) stated.children = others.map((child) => ({ element: child.name, ...attributesOf(child) }));
  const events = element.children.filter((child) => child.name === "WorkoutEvent").map((child, at): WorkoutEvent => {
    const type = child.attributes.get("type");
    const date = child.attributes.get("date");
    if (type === undefined || date === undefined) refuse(`${label} has a WorkoutEvent without type or date`);
    return { type, start: exportInstant(date, `${label} WorkoutEvent ${at + 1} date`),
      duration_s: seconds(child.attributes.get("duration"), child.attributes.get("durationUnit")) ?? 0, metadata: metadataOf(child, `${label} WorkoutEvent ${at + 1}`) };
  });
  const total = (value: string, unit: string): Quantity | null => {
    const number = attribute(value) === undefined ? NaN : Number(attribute(value));
    if (Number.isFinite(number) && attribute(unit) !== undefined) return { value: number, unit: attribute(unit)! };
    if (attribute(value) !== undefined) Object.assign(stated, { [value]: attribute(value)!, [unit]: attribute(unit) ?? null });
    return null;
  };
  const statistics = element.children.filter((child) => child.name === "WorkoutStatistics").map((child, at): WorkoutStatistic => {
    const where = `${label} WorkoutStatistics ${at + 1}`;
    const get = (name: string) => child.attributes.get(name);
    const type = get("type");
    const [start, end, unit] = [get("startDate"), get("endDate"), get("unit")];
    if (type === undefined || start === undefined || end === undefined || unit === undefined) refuse(`${where} states no type, startDate, endDate or unit`);
    const figure = (name: string): number | null => {
      const stated = get(name);
      if (stated === undefined) return null;
      if (!Number.isFinite(Number(stated))) refuse(`${where} ${name} is not a decimal`);
      return Number(stated);
    };
    return { type, start: exportInstant(start, `${where} startDate`), end: exportInstant(end, `${where} endDate`),
      sum: figure("sum"), average: figure("average"), minimum: figure("minimum"), maximum: figure("maximum"), unit };
  });
  const sample = projectSample({
    ...identityOf(element, label, WORKOUT_TYPE),
    value: activity,
    detail: workoutDetail("export", {
      duration_s: duration,
      distance: total("totalDistance", "totalDistanceUnit"),
      energy: total("totalEnergyBurned", "totalEnergyBurnedUnit"),
      statistics,
      events,
      stated,
    }),
  });
  return { kind: "workout", key: sample.key, content: sample.content, time: sample.time, locator: `export.xml ${label}` };
}

function compound(element: XmlElement, index: number): ReaderOutput {
  const label = `${element.name} ${index}`;
  for (const name of element.attributes.keys()) if (!IDENTITY_ATTRIBUTES.has(name)) refuse(`${label} states an attribute this connector does not know: ${name}`);
  const detail: JsonObject = element.name === "Correlation"
    ? { objects: element.children.filter((child) => child.name === "Record").map((child, at) => {
      const member = record(child, index, `${label} Record ${at + 1}`);
      return { key: member.key, ...(member.content as JsonObject) };
    }) }
    : { sensitivity_points: element.children.filter((child) => child.name === "SensitivityPoint").map((child) => attributesOf(child)) };
  const sample = projectSample({ ...identityOf(element, label), value: "", detail });
  return { kind: "sample", key: sample.key, content: sample.content, time: sample.time, locator: `export.xml ${label}` };
}

function prescription(element: XmlElement, index: number): ReaderOutput {
  const label = `VisionPrescription ${index}`;
  const attribute = (name: string): string | undefined => element.attributes.get(name);
  const issued = attribute("dateIssued");
  const type = attribute("type");
  if (issued === undefined || type === undefined) refuse(`${label} states no type or dateIssued`);
  const at = exportInstant(issued, `${label} dateIssued`);
  const sample = projectSample({
    path: "export", sample_type: VISION_PRESCRIPTION, start: at, end: at, value: type,
    source_name: attribute("sourceName") ?? "",
    ...(attribute("sourceVersion") === undefined ? {} : { source_version: attribute("sourceVersion")! }),
    metadata: metadataOf(element, label),
    detail: {
      ...attributesOf(element, new Set(["type", "dateIssued", "sourceName", "sourceVersion"])),
      parts: element.children.filter((child) => child.name !== "MetadataEntry").map((child) => ({ element: child.name, ...attributesOf(child) })),
    },
  });
  return { kind: "sample", key: sample.key, content: sample.content, time: sample.time, locator: `export.xml ${label}` };
}

function characteristics(element: XmlElement, index: number): ReaderOutput[] {
  return [...element.attributes].filter(([name]) => name.startsWith(CHARACTERISTIC_PREFIX))
    .map(([identifier, value]) => ({ ...characteristicRow(identifier, value, `Me ${index}`), locator: `export.xml Me ${index}` }));
}

function summary(element: XmlElement, index: number): ReaderOutput {
  const names = [...element.attributes.keys()];
  if (names.length !== SUMMARY_ATTRIBUTES.length || !SUMMARY_ATTRIBUTES.every((name) => element.attributes.has(name)) || element.children.length > 0) {
    refuse(`ActivitySummary ${index} must state exactly ${SUMMARY_ATTRIBUTES.join(", ")}`);
  }
  const attribute = (name: string): string => element.attributes.get(name)!;
  const date = attribute("dateComponents");
  if (!calendarDate(date)) refuse(`ActivitySummary ${index} dateComponents is not a calendar date`);
  const energy = QUANTITY_UNITS.HKQuantityTypeIdentifierActiveEnergyBurned!;
  const multiplier = energy.export[attribute("activeEnergyBurnedUnit")];
  if (multiplier === undefined) refuse(`ActivitySummary ${index} energy unit ${JSON.stringify(attribute("activeEnergyBurnedUnit"))} is outside the conversion table`);
  const decimal = (name: string, by = 1): string => {
    const spelling = attribute(name);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(spelling)) refuse(`ActivitySummary ${index} ${name} is not a decimal`);
    return renderDecimal(Number(spelling) * by);
  };
  return {
    kind: "day-summary",
    key: date.replaceAll("-", ""),
    content: {
      type: "health.day-summary",
      date,
      active_energy_burned: decimal("activeEnergyBurned", multiplier),
      active_energy_burned_goal: decimal("activeEnergyBurnedGoal", multiplier),
      active_energy_unit: energy.canonical,
      move_time: decimal("appleMoveTime"),
      move_time_goal: decimal("appleMoveTimeGoal"),
      exercise_time: decimal("appleExerciseTime"),
      exercise_time_goal: decimal("appleExerciseTimeGoal"),
      stand_hours: decimal("appleStandHours"),
      stand_hours_goal: decimal("appleStandHoursGoal"),
    },
    time: instant(date, "date"),
    locator: `export.xml ActivitySummary ${index}`,
  };
}

export function stableDevice(value: string | undefined): { hardware_model?: string; software_version?: string } | undefined {
  if (value === undefined) return undefined;
  const field = (name: string): string | undefined => new RegExp(`(?:^|,\\s*)${name}:(.*?)(?=,\\s*[A-Za-z][A-Za-z ]*:|>+$)`, "u").exec(value)?.[1]?.trim();
  const hardware = field("hardware");
  const software = field("software");
  if (!hardware && !software) return undefined;
  return { ...(hardware ? { hardware_model: hardware } : {}), ...(software ? { software_version: software } : {}) };
}

function calendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && tryInstant(value, "date") !== undefined;
}
