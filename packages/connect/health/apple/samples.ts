import { createHash } from "node:crypto";
import { instant, instantMs, instantOf, refuse, rfc3339, spanOf, type Instant, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";
import { convert, unitValue } from "./units.js";

export type SamplePath = "bundle" | "export";

export interface Identity {
  sample_type: string;
  start: string;
  end: string;
  value: string;
  unit: string;
  source_name: string;
  source_version: string;
}

export interface Projected {
  identity: Identity;
  key: string;
  content: JsonObject;
  time: Instant;
}

interface UnitRule {
  canonical: string;
  export: Record<string, number>;
  bundle: string[];
  rescale?: Record<string, number>;
}

const COUNT: UnitRule = { canonical: "count", export: { count: 1 }, bundle: ["count"] };
const PER_MINUTE: UnitRule = { canonical: "count/min", export: { "count/min": 1 }, bundle: ["count/min"] };
const KCAL: UnitRule = { canonical: "kcal", export: { Cal: 1, kcal: 1 }, bundle: ["kcal", "Cal"] };
const PERCENT: UnitRule = { canonical: "percent", export: { "%": 100, percent: 1 }, bundle: ["%", "percent"] };

export const QUANTITY_UNITS: Record<string, UnitRule> = {
  HKQuantityTypeIdentifierStepCount: COUNT,
  HKQuantityTypeIdentifierHeartRate: { ...PER_MINUTE, rescale: { "count/s": 60 } },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: { canonical: "ms", export: { ms: 1 }, bundle: ["ms"] },
  HKQuantityTypeIdentifierActiveEnergyBurned: KCAL,
  HKQuantityTypeIdentifierBasalEnergyBurned: KCAL,
  HKQuantityTypeIdentifierDistanceWalkingRunning: { canonical: "mi", export: { mi: 1 }, bundle: ["mi"] },
  HKQuantityTypeIdentifierHeadphoneAudioExposure: { canonical: "dBASPL", export: { dBASPL: 1 }, bundle: ["dBASPL"] },
  HKQuantityTypeIdentifierFlightsClimbed: COUNT,
  HKQuantityTypeIdentifierAppleWalkingSteadiness: PERCENT,
  HKQuantityTypeIdentifierRestingHeartRate: { ...PER_MINUTE, rescale: { "count/s": 60 } },
  HKQuantityTypeIdentifierBodyMass: { canonical: "lb", export: { lb: 1 }, bundle: ["lb"] },
  HKQuantityTypeIdentifierHeight: { canonical: "ft", export: { ft: 1 }, bundle: ["ft"] },
  HKQuantityTypeIdentifierWalkingSpeed: { canonical: "m/s", export: { "m/s": 1, "mi/hr": 1609.344 / 3600 }, bundle: ["m/s"] },
  HKQuantityTypeIdentifierWalkingStepLength: { canonical: "m", export: { m: 1, in: 0.0254 }, bundle: ["m"] },
  HKQuantityTypeIdentifierWalkingAsymmetryPercentage: PERCENT,
  HKQuantityTypeIdentifierWalkingDoubleSupportPercentage: PERCENT,
  HKQuantityTypeIdentifierRespiratoryRate: PER_MINUTE,
  HKQuantityTypeIdentifierOxygenSaturation: PERCENT,
};

export const NATIVE_UNITS: Record<string, string> = Object.fromEntries(Object.entries({
  "%": "AppleWalkingSteadiness AtrialFibrillationBurden BloodAlcoholContent BodyFatPercentage OxygenSaturation PeripheralPerfusionIndex WalkingAsymmetryPercentage WalkingDoubleSupportPercentage",
  appleEffortScore: "EstimatedWorkoutEffortScore WorkoutEffortScore",
  cm: "RunningVerticalOscillation",
  count: "AppleSleepingBreathingDisturbances BodyMassIndex FlightsClimbed InhalerUsage NikeFuel NumberOfAlcoholicBeverages NumberOfTimesFallen PushCount StepCount SwimmingStrokeCount UVExposure",
  "count/min": "CyclingCadence HeartRateRecoveryOneMinute RestingHeartRate WalkingHeartRateAverage",
  "count/s": "HeartRate RespiratoryRate",
  dBASPL: "EnvironmentalAudioExposure EnvironmentalSoundReduction HeadphoneAudioExposure",
  degC: "AppleSleepingWristTemperature BasalBodyTemperature BodyTemperature WaterTemperature",
  g: "DietaryBiotin DietaryCaffeine DietaryCalcium DietaryCarbohydrates DietaryChloride DietaryCholesterol DietaryChromium DietaryCopper "
    + "DietaryFatMonounsaturated DietaryFatPolyunsaturated DietaryFatSaturated DietaryFatTotal DietaryFiber DietaryFolate DietaryIodine DietaryIron "
    + "DietaryMagnesium DietaryManganese DietaryMolybdenum DietaryNiacin DietaryPantothenicAcid DietaryPhosphorus DietaryPotassium DietaryProtein "
    + "DietaryRiboflavin DietarySelenium DietarySodium DietarySugar DietaryThiamin DietaryVitaminA DietaryVitaminB12 DietaryVitaminB6 DietaryVitaminC "
    + "DietaryVitaminD DietaryVitaminE DietaryVitaminK DietaryZinc",
  IU: "InsulinDelivery",
  kcal: "ActiveEnergyBurned BasalEnergyBurned DietaryEnergyConsumed",
  "kcal/hr·kg": "PhysicalEffort",
  kg: "BodyMass LeanBodyMass",
  L: "ForcedExpiratoryVolume1 ForcedVitalCapacity",
  "L/min": "PeakExpiratoryFlowRate",
  m: "DistanceCrossCountrySkiing DistanceCycling DistanceDownhillSnowSports DistancePaddleSports DistanceRowing DistanceSkatingSports "
    + "DistanceSwimming DistanceWalkingRunning DistanceWheelchair Height RunningStrideLength SixMinuteWalkTestDistance UnderwaterDepth "
    + "WaistCircumference WalkingStepLength",
  "m/s": "CrossCountrySkiingSpeed CyclingSpeed PaddleSportsSpeed RowingSpeed RunningSpeed StairAscentSpeed StairDescentSpeed WalkingSpeed",
  "mg/dL": "BloodGlucose",
  min: "AppleExerciseTime AppleMoveTime AppleStandTime TimeInDaylight",
  mL: "DietaryWater",
  "mL/min·kg": "VO2Max",
  mmHg: "BloodPressureDiastolic BloodPressureSystolic",
  ms: "HeartRateVariabilityRMSSD HeartRateVariabilitySDNN RunningGroundContactTime",
  S: "ElectrodermalActivity",
  W: "CyclingFunctionalThresholdPower CyclingPower RunningPower",
}).flatMap(([unit, types]) => types.split(" ").map((type) => [`HKQuantityTypeIdentifier${type}`, unit])));

export function keyedUnit(type: string): string | undefined {
  const native = NATIVE_UNITS[type];
  return QUANTITY_UNITS[type]?.canonical ?? (native === "%" ? "percent" : native);
}

function named(prefix: string, names: readonly string[], from = 1): Record<string, string> {
  return Object.fromEntries(names.map((name, index) => [String(index + from), `${prefix}${name}`]));
}

const NOT_APPLICABLE = { "0": "HKCategoryValueNotApplicable" };
const SEVERITY = named("HKCategoryValueSeverity", ["Unspecified", "NotPresent", "Mild", "Moderate", "Severe"], 0);
const PRESENCE = named("HKCategoryValuePresence", ["Present", "NotPresent"], 0);
const TEST_RESULT = (test: string) => named(`HKCategoryValue${test}TestResult`, ["Negative", "Positive", "Indeterminate"]);
const BLEEDING = named("HKCategoryValueVaginalBleeding", ["Unspecified", "Light", "Medium", "Heavy", "None"]);
const category = (names: readonly string[], values: Record<string, string>) =>
  Object.fromEntries(names.map((name) => [`HKCategoryTypeIdentifier${name}`, values]));

const CATEGORIES: Record<string, Record<string, string>> = {
  HKCategoryTypeIdentifierSleepAnalysis: named("HKCategoryValueSleepAnalysis", ["InBed", "AsleepUnspecified", "Awake", "AsleepCore", "AsleepDeep", "AsleepREM"], 0),
  HKCategoryTypeIdentifierAppleStandHour: named("HKCategoryValueAppleStandHour", ["Stood", "Idle"], 0),
  HKCategoryTypeIdentifierAppetiteChanges: named("HKCategoryValueAppetiteChanges", ["Unspecified", "NoChange", "Decreased", "Increased"], 0),
  HKCategoryTypeIdentifierCervicalMucusQuality: named("HKCategoryValueCervicalMucusQuality", ["Dry", "Sticky", "Creamy", "Watery", "EggWhite"]),
  HKCategoryTypeIdentifierMenstrualFlow: named("HKCategoryValueMenstrualFlow", ["Unspecified", "Light", "Medium", "Heavy", "None"]),
  HKCategoryTypeIdentifierOvulationTestResult: named("HKCategoryValueOvulationTestResult", ["Negative", "LuteinizingHormoneSurge", "Indeterminate", "EstrogenSurge"]),
  HKCategoryTypeIdentifierPregnancyTestResult: TEST_RESULT("Pregnancy"),
  HKCategoryTypeIdentifierProgesteroneTestResult: TEST_RESULT("Progesterone"),
  HKCategoryTypeIdentifierContraceptive: named("HKCategoryValueContraceptive", ["Unspecified", "Implant", "Injection", "IntrauterineDevice", "IntravaginalRing", "Oral", "Patch"]),
  HKCategoryTypeIdentifierLowCardioFitnessEvent: named("HKCategoryValueLowCardioFitnessEvent", ["LowFitness"]),
  HKCategoryTypeIdentifierAppleWalkingSteadinessEvent: named("HKCategoryValueAppleWalkingSteadinessEvent", ["InitialLow", "InitialVeryLow", "RepeatLow", "RepeatVeryLow"]),
  HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent: named("HKCategoryValueEnvironmentalAudioExposureEvent", ["MomentaryLimit"]),
  HKCategoryTypeIdentifierHeadphoneAudioExposureEvent: named("HKCategoryValueHeadphoneAudioExposureEvent", ["SevenDayLimit"]),
  HKCategoryTypeIdentifierMenopausalState: named("HKCategoryValueMenopausalState", ["Menopause", "Perimenopause", "None"]),
  ...category(["BleedingAfterMenopause", "BleedingAfterPregnancy", "BleedingDuringPregnancy"], BLEEDING),
  ...category(["MoodChanges", "SleepChanges"], PRESENCE),
  ...category([
    "MindfulSession", "HighHeartRateEvent", "LowHeartRateEvent", "IrregularHeartRhythmEvent", "ToothbrushingEvent", "HandwashingEvent",
    "SexualActivity", "IntermenstrualBleeding", "Lactation", "Pregnancy", "PersistentIntermenstrualBleeding", "ProlongedMenstrualPeriods",
    "IrregularMenstrualCycles", "InfrequentMenstrualCycles", "SleepApneaEvent", "HypertensionEvent",
  ], NOT_APPLICABLE),
  ...category([
    "AbdominalCramps", "Acne", "BladderIncontinence", "Bloating", "BreastPain", "ChestTightnessOrPain", "Chills", "Constipation", "Coughing",
    "Diarrhea", "Dizziness", "DrySkin", "Fainting", "Fatigue", "Fever", "GeneralizedBodyAche", "HairLoss", "Headache", "Heartburn", "HotFlashes",
    "LossOfSmell", "LossOfTaste", "LowerBackPain", "MemoryLapse", "Nausea", "NightSweats", "PelvicPain", "RapidPoundingOrFlutteringHeartbeat",
    "RunnyNose", "ShortnessOfBreath", "SinusCongestion", "SkippedHeartbeat", "SoreThroat", "VaginalDryness", "Vomiting", "Wheezing",
  ], SEVERITY),
};

const ALIASES: Record<string, string> = {
  HKCategoryValueSleepAnalysisAsleep: "HKCategoryValueSleepAnalysisAsleepUnspecified",
  HKCategoryValueOvulationTestResultPositive: "HKCategoryValueOvulationTestResultLuteinizingHormoneSurge",
  HKCategoryValueAudioExposureEventLoudEnvironment: "HKCategoryValueEnvironmentalAudioExposureEventMomentaryLimit",
};

export const WORKOUT_TYPE = "HKWorkoutTypeIdentifier";

const ACTIVITIES: Record<string, string> = {
  ...named("HKWorkoutActivityType", [
    "AmericanFootball", "Archery", "AustralianFootball", "Badminton", "Baseball", "Basketball", "Bowling", "Boxing", "Climbing", "Cricket",
    "CrossTraining", "Curling", "Cycling", "Dance", "DanceInspiredTraining", "Elliptical", "EquestrianSports", "Fencing", "Fishing",
    "FunctionalStrengthTraining", "Golf", "Gymnastics", "Handball", "Hiking", "Hockey", "Hunting", "Lacrosse", "MartialArts", "MindAndBody",
    "MixedMetabolicCardioTraining", "PaddleSports", "Play", "PreparationAndRecovery", "Racquetball", "Rowing", "Rugby", "Running", "Sailing",
    "SkatingSports", "SnowSports", "Soccer", "Softball", "Squash", "StairClimbing", "SurfingSports", "Swimming", "TableTennis", "Tennis",
    "TrackAndField", "TraditionalStrengthTraining", "Volleyball", "Walking", "WaterFitness", "WaterPolo", "WaterSports", "Wrestling", "Yoga",
    "Barre", "CoreTraining", "CrossCountrySkiing", "DownhillSkiing", "Flexibility", "HighIntensityIntervalTraining", "JumpRope", "Kickboxing",
    "Pilates", "Snowboarding", "Stairs", "StepTraining", "WheelchairWalkPace", "WheelchairRunPace", "TaiChi", "MixedCardio", "HandCycling",
    "DiscSports", "FitnessGaming", "CardioDance", "SocialDance", "Pickleball", "Cooldown",
  ]),
  ...named("HKWorkoutActivityType", ["SwimBikeRun", "Transition", "UnderwaterDiving"], 82),
  "3000": "HKWorkoutActivityTypeOther",
};

export const WORKOUT_EVENTS = named("HKWorkoutEventType", ["Pause", "Resume", "Lap", "Marker", "MotionPaused", "MotionResumed", "Segment", "PauseOrResumeRequest"]);

const METADATA_TYPES: Record<string, "boolean" | "number" | "date" | "string"> = {
  HKWasUserEntered: "boolean",
  HKMetadataKeyWasUserEntered: "boolean",
  HKMetadataKeySyncVersion: "number",
  HKMetadataKeyHeartRateMotionContext: "number",
  HKMetadataKeyDevicePlacementSide: "number",
  "WHOOP Recovery": "number",
  "WHOOP Strain": "number",
  HKMetadataKeyTimeZone: "string",
  HKMetadataKeySyncIdentifier: "string",
  HKAlgorithmVersion: "string",
};

export interface SampleInput {
  path: SamplePath;
  sample_type: string;
  start: string;
  end: string;
  value: string | number;
  unit?: string;
  described?: true;
  source_name: string;
  source_version?: string;
  device?: { hardware_model?: string; software_version?: string };
  metadata: JsonObject;
  detail?: JsonObject;
}

export function projectSample(input: SampleInput): Projected {
  const start = floorSecond(input.start, "sample start");
  const end = floorSecond(input.end, "sample end");
  const time = spanOf(instant(start, "rfc3339"), instant(end, "rfc3339"), "sample");
  const { value, unit } = sampleValue(input.path, input.sample_type, input.value, input.unit, input.described === true);
  const identity: Identity = {
    sample_type: input.sample_type,
    start,
    end,
    value,
    unit,
    source_name: input.source_name,
    source_version: input.source_version ?? "",
  };
  const device = stableDevice(input.device);
  const content: JsonObject = {
    type: input.sample_type === WORKOUT_TYPE ? "health.workout" : "health.sample",
    ...identity,
    ...(device === undefined ? {} : { device }),
    metadata: metadataOf(input.path, input.metadata),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
  return { identity, key: sampleKey(identity), content, time };
}

export interface WorkoutEvent { type: string | number; start: string; duration_s: number; metadata: JsonObject }

export interface Quantity { value: number; unit: string }

export interface WorkoutStatistic {
  type: string;
  start: string;
  end: string;
  sum: number | null;
  average: number | null;
  minimum: number | null;
  maximum: number | null;
  unit: string;
}

export function workoutDetail(path: SamplePath, facts: {
  duration_s: number | null; distance: Quantity | null; energy: Quantity | null; statistics: readonly WorkoutStatistic[];
  events: readonly WorkoutEvent[]; stated?: JsonObject;
}): JsonObject {
  const total = (types: (type: string) => boolean, stated: Quantity | null, unit: string): string | null => {
    const sums = facts.statistics.filter((each) => types(each.type) && each.sum !== null).map((each) => ({ value: each.sum!, unit: each.unit }));
    const parts = sums.length > 0 ? sums : stated === null ? [] : [stated];
    if (parts.length === 0) return null;
    const to = unitValue(unit)!;
    const converted = parts.map((part) => {
      const from = unitValue(part.unit);
      return from === undefined ? undefined : convert(part.value, from, to);
    });
    if (converted.some((value) => value === undefined)) return parts.length === 1 ? `${renderDecimal(parts[0]!.value)} ${parts[0]!.unit}` : null;
    return `${renderDecimal(converted.reduce((sum, value) => sum! + value!, 0)!)} ${unit}`;
  };
  return {
    duration_s: facts.duration_s === null ? null : renderDecimal(facts.duration_s),
    distance: total((type) => type.startsWith("HKQuantityTypeIdentifierDistance"), facts.distance, "m"),
    energy: total((type) => type === "HKQuantityTypeIdentifierActiveEnergyBurned", facts.energy, "kcal"),
    statistics: [...facts.statistics].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)).map((each) => {
      const figure = (value: number | null) => (value === null ? null : sampleValue(path, each.type, value, each.unit, false));
      const figures = { sum: figure(each.sum), average: figure(each.average), minimum: figure(each.minimum), maximum: figure(each.maximum) };
      const unit = Object.values(figures).find((value) => value !== null)?.unit ?? keyedUnit(each.type) ?? each.unit;
      return {
        type: each.type, start: floorSecond(each.start, "workout statistics start"), end: floorSecond(each.end, "workout statistics end"),
        ...Object.fromEntries(Object.entries(figures).map(([name, value]) => [name, value?.value ?? null])), unit,
      };
    }),
    events: facts.events.map((event) => ({
      type: WORKOUT_EVENTS[String(event.type)] ?? String(event.type),
      start: floorSecond(event.start, "workout event start"),
      duration_s: renderDecimal(event.duration_s),
      metadata: metadataOf(path, event.metadata),
    })),
    ...(facts.stated === undefined || Object.keys(facts.stated).length === 0 ? {} : { stated: facts.stated }),
  };
}

export function uuidContent(uuid: string, identity: Identity): JsonObject {
  return { type: "health.sample-uuid", uuid, ...identity };
}

export function uuidIdentity(content: Json): Identity | undefined {
  if (content === null || typeof content !== "object" || Array.isArray(content) || content.type !== "health.sample-uuid") return undefined;
  const { sample_type, start, end, value, unit, source_name, source_version } = content;
  const fields = [sample_type, start, end, value, unit, source_name, source_version];
  if (!fields.every((field) => typeof field === "string")) return undefined;
  return { sample_type, start, end, value, unit, source_name, source_version } as Identity;
}

export function sampleKey(identity: Identity): string {
  const parts = [identity.sample_type, identity.start, identity.end, identity.value, identity.unit, identity.source_name, identity.source_version];
  const framed = parts
    .map((part) => {
      const escaped = part.normalize("NFC").replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|");
      return `${Buffer.byteLength(escaped, "utf8")}:${escaped}`;
    })
    .join("|");
  return createHash("sha256").update(framed, "utf8").digest("hex").slice(0, 12);
}

export function renderDecimal(value: number): string {
  if (!Number.isFinite(value)) refuse("sample value must be finite");
  if (value === 0) return "0";
  const text = String(Number(value.toPrecision(6)));
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(text);
  if (match === null) return text;
  const [, sign, whole, fraction = "", exponent] = match;
  const digits = `${whole}${fraction}`;
  const point = whole!.length + Number(exponent);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function floorSecond(value: string, where: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) refuse(`${where} is a bare date; a health instant needs its zone`);
  return rfc3339(instantOf(value, "rfc3339", where).start_ms, "s");
}

export function exportInstant(value: string, where: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/u.exec(value);
  if (match === null) refuse(`${where} is not Apple's export spelling of an instant`);
  return `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`;
}

function sampleValue(path: SamplePath, type: string, raw: string | number, rawUnit: string | undefined, described: boolean): { value: string; unit: string } {
  const names = type === WORKOUT_TYPE ? ACTIVITIES : CATEGORIES[type];
  if (rawUnit === undefined || rawUnit.length === 0) {
    const spelling = String(raw);
    const whole = /^-?\d+$/u.test(spelling) ? String(Number(spelling)) : undefined;
    const value = (whole === undefined ? undefined : names?.[whole]) ?? whole ?? spelling;
    return { value: ALIASES[value] ?? value, unit: "" };
  }
  if (names !== undefined) refuse(`${type} states a unit, ${JSON.stringify(rawUnit)}; its value is a name`);
  const number = Number(raw);
  if (!Number.isFinite(number)) refuse(`${type} value is not a finite decimal`);
  const rule = QUANTITY_UNITS[type];
  if (path === "export") {
    const multiplier = rule?.export[rawUnit];
    if (multiplier !== undefined) return { value: renderDecimal(number * multiplier), unit: rule!.canonical };
  } else if (described) {
    if (rule?.bundle.includes(rawUnit)) return { value: renderDecimal(number), unit: rule.canonical };
    const rescale = rule?.rescale?.[rawUnit];
    if (rescale !== undefined) return { value: renderDecimal(snap(number * rescale)), unit: rule!.canonical };
  }
  const keyed = keyedUnit(type);
  const from = described && rawUnit === "%" ? HUNDREDTH : unitValue(rawUnit);
  const to = keyed === undefined ? undefined : keyed === "percent" ? HUNDREDTH : unitValue(keyed);
  const converted = from === undefined || to === undefined ? undefined : convert(number, from, to);
  if (converted === undefined) return shared(number, rawUnit, !described);
  return { value: renderDecimal(rawUnit === "count/s" && keyed === "count/min" ? snap(converted) : converted), unit: keyed! };
}

const HUNDREDTH = { factor: 0.01, dimension: "" };

function shared(number: number, unit: string, fraction: boolean): { value: string; unit: string } {
  if (unit === "Cal") return { value: renderDecimal(number), unit: "kcal" };
  if (unit === "%" || unit === "percent") return { value: renderDecimal(fraction && unit === "%" ? number * 100 : number), unit: "percent" };
  if (unit === "count/s") return { value: renderDecimal(snap(number * 60)), unit: "count/min" };
  return { value: renderDecimal(number), unit };
}

function snap(value: number): number {
  const whole = Math.round(value);
  return Math.abs(value - whole) <= 0.001 ? whole : value;
}

function stableDevice(device: SampleInput["device"]): JsonObject | undefined {
  if (device === undefined) return undefined;
  const out: JsonObject = {};
  for (const name of ["hardware_model", "software_version"] as const) {
    const value = device[name];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) refuse(`device.${name} must be a non-empty string`);
    out[name] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function metadataOf(path: SamplePath, metadata: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(metadata)) {
    const type = METADATA_TYPES[key];
    out[key] = type === undefined ? value : path === "export" ? exportMetadata(key, value, type) : bundleMetadata(key, value, type);
  }
  return out;
}

function exportMetadata(key: string, value: Json, type: (typeof METADATA_TYPES)[string]): Json {
  if (typeof value !== "string") refuse(`export metadata ${key} is not a string`);
  if (type === "string") return value;
  if (type === "boolean") {
    if (value === "1" || value.toLowerCase() === "true") return true;
    if (value === "0" || value.toLowerCase() === "false") return false;
    refuse(`export metadata ${key} is not a boolean`);
  }
  if (type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) refuse(`export metadata ${key} is not a number`);
    return number;
  }
  const stated = exportInstant(value, `metadata ${key}`);
  return { rfc3339: stated, unix_seconds: instantMs(stated)! / 1000 };
}

function bundleMetadata(key: string, value: Json, type: (typeof METADATA_TYPES)[string]): Json {
  if (type === "boolean") {
    if (typeof value !== "boolean") refuse(`bundle metadata ${key} is not a boolean`);
    return value;
  }
  if (type === "number") {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value !== "number") refuse(`bundle metadata ${key} is not a number`);
    return value;
  }
  if (type === "string") {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value !== "string") refuse(`bundle metadata ${key} is not a string`);
    return value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.rfc3339 !== "string" || typeof value.unix_seconds !== "number") {
    return refuse(`bundle metadata ${key} is not a date`);
  }
  return { rfc3339: value.rfc3339, unix_seconds: value.unix_seconds };
}

const DEVICE_MEMBERS = ["hardware_model", "software_version"];
const SAMPLE_MEMBERS = ["type", "sample_type", "start", "end", "value", "unit", "source_name", "source_version", "metadata"];

export const sampleGuard = (content: Json): string[] => contentGuard(content, "health.sample");
export const workoutGuard = (content: Json): string[] => contentGuard(content, "health.workout");

function contentGuard(content: Json, type: string): string[] {
  if (content === null || typeof content !== "object" || Array.isArray(content)) return ["content must be an object"];
  const names = Object.keys(content);
  if (content.type !== type) return [`content.type must be ${type}`];
  if (!SAMPLE_MEMBERS.every((name) => content[name] !== undefined) || !names.every((name) => SAMPLE_MEMBERS.includes(name) || name === "device" || name === "detail")) {
    return [`content members must be ${SAMPLE_MEMBERS.join(", ")}, an optional device and an optional detail`];
  }
  if ((type === "health.workout") !== (content.sample_type === WORKOUT_TYPE)) return [`content.sample_type ${type === "health.workout" ? "must" : "must not"} be ${WORKOUT_TYPE}`];
  const detail = content.detail;
  if (detail !== undefined && (detail === null || typeof detail !== "object" || Array.isArray(detail))) return ["content.detail must be an object"];
  if (!SAMPLE_MEMBERS.slice(1, 8).every((name) => typeof content[name] === "string")) return ["the identity members must be strings"];
  const metadata = content.metadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return ["content.metadata must be an object"];
  const device = content.device;
  if (device !== undefined) {
    if (device === null || typeof device !== "object" || Array.isArray(device)) return ["content.device must be an object"];
    const members = Object.keys(device);
    if (members.length === 0 || !members.every((name) => DEVICE_MEMBERS.includes(name) && typeof device[name] === "string")) {
      return ["content.device states hardware_model or software_version, as strings"];
    }
  }
  return [];
}
