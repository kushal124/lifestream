import { addDays, isObject, type HealthAdapter, type HealthItem, type InputRecord, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";

const METRICS: Readonly<Record<string, string>> = {
  HKQuantityTypeIdentifierStepCount: "steps",
  HKQuantityTypeIdentifierActiveEnergyBurned: "active_energy",
  HKQuantityTypeIdentifierBasalEnergyBurned: "basal_energy",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "distance",
  HKQuantityTypeIdentifierFlightsClimbed: "flights",
  HKQuantityTypeIdentifierWalkingSpeed: "walking_speed",
  HKQuantityTypeIdentifierWalkingStepLength: "step_length",
  HKQuantityTypeIdentifierWalkingAsymmetryPercentage: "asymmetry",
  HKQuantityTypeIdentifierWalkingDoubleSupportPercentage: "double_support",
  HKQuantityTypeIdentifierAppleWalkingSteadiness: "steadiness",
  HKQuantityTypeIdentifierHeadphoneAudioExposure: "audio_exposure",
  HKQuantityTypeIdentifierHeartRate: "heart_rate",
  HKQuantityTypeIdentifierRestingHeartRate: "resting_heart_rate",
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "hrv",
  HKQuantityTypeIdentifierRespiratoryRate: "respiratory_rate",
  HKQuantityTypeIdentifierOxygenSaturation: "spo2",
};
const SLEEP = "HKCategoryTypeIdentifierSleepAnalysis";
const STAGES: Readonly<Record<string, string>> = {
  HKCategoryValueSleepAnalysisInBed: "in bed",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "asleep",
  HKCategoryValueSleepAnalysisAsleepCore: "core",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep",
  HKCategoryValueSleepAnalysisAsleepREM: "REM",
  HKCategoryValueSleepAnalysisAwake: "awake",
};
const ACTIVITY = "HKWorkoutActivityType";
const HEART_RATE = "HKQuantityTypeIdentifierHeartRate";

export const appleHealthHealth: HealthAdapter = {
  version: "2",
  kinds: ["sample", "workout", "day-summary"],
  item({ version }: InputRecord): HealthItem | null {
    const content = object(version.content);
    if (content === null) return null;
    if (version.kind === "sample" && content.type === "health.sample") {
      const instrument = text(content.source_name);
      if (content.sample_type === SLEEP) {
        const stage = typeof content.value === "string" ? STAGES[content.value] : undefined;
        return stage === undefined || instrument === null ? null : { item: "stage", instrument, stage, recovery: number(object(content.metadata)?.["WHOOP Recovery"]) };
      }
      const metric = typeof content.sample_type === "string" ? METRICS[content.sample_type] : undefined;
      const value = decimal(content.value);
      if (metric === undefined || instrument === null || value === null || typeof content.unit !== "string") return null;
      return { item: "sample", metric, instrument, unit: content.unit, value };
    }
    if (version.kind === "workout" && content.type === "health.workout") {
      const instrument = text(content.source_name);
      const value = text(content.value);
      if (instrument === null || value === null) return null;
      const detail = object(content.detail);
      const heart = heartRateOf(detail);
      return {
        item: "instrument-workout", instrument,
        activity: value.startsWith(ACTIVITY) ? value.slice(ACTIVITY.length).replace(/(?<=[a-z0-9])(?=[A-Z])/gu, " ").toLowerCase() : value,
        duration_s: decimal(detail?.duration_s), distance: text(detail?.distance), energy: text(detail?.energy),
        average_heart_rate: decimal(heart?.average), max_heart_rate: decimal(heart?.maximum),
        strain: number(object(content.metadata)?.["WHOOP Strain"]),
      };
    }
    if (version.kind === "day-summary" && content.type === "health.day-summary") {
      const date = text(content.date);
      if (date === null || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || addDays(date, 0) !== date) return null;
      const field = (name: string) => text(content[name]) ?? "";
      return {
        item: "day-summary", date,
        move: [field("active_energy_burned"), field("active_energy_burned_goal"), field("active_energy_unit")],
        exercise: [field("exercise_time"), field("exercise_time_goal")],
        stand: [field("stand_hours"), field("stand_hours_goal")],
      };
    }
    return null;
  },
};

function heartRateOf(detail: JsonObject | null): JsonObject | null {
  const statistics = Array.isArray(detail?.statistics) ? detail.statistics : [];
  return statistics.map(object).find((each) => each?.type === HEART_RATE && each.unit === "count/min") ?? null;
}

function object(value: Json | undefined): JsonObject | null {
  return isObject(value) ? value : null;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decimal(value: Json | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return null;
  return Number(value);
}
