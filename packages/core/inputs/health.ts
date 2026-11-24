import type { Adapter, InputRecord } from "./adapter.js";

/** One measurement of one metric by one instrument, over the record's time, which the day sums into 15-minute spans. */
export interface Sample {
  /** Marks the item a sample. */
  item: "sample";
  /** What it measures, in lower-case snake case, such as `steps`, `heart_rate` or `stress`, where steps, heart rate and stress are the ones the day compares with earlier days. */
  metric: string;
  /** The name of the instrument that measured it, which its row prints. */
  instrument: string;
  /** The value's unit, printed after it unless it is `count`, `count/min` or `score`. */
  unit: string;
  /** The measured value, in its unit. */
  value: number;
  /** Which of several series of the same metric it belongs to, counted from 0 for the finest, so that a span counts only its finest series. */
  series?: number;
}

/** One sleep stage an instrument wrote, which the day joins with that instrument's other stages into a night. */
export interface Stage {
  /** Marks the item a sleep stage. */
  item: "stage";
  /** The name of the instrument that wrote it, which its night prints. */
  instrument: string;
  /** The stage in words, one of `in bed`, `asleep`, `core`, `deep`, `REM` and `awake`, where `asleep`, `core`, `deep` and `REM` count as asleep. */
  stage: string;
  /** The recovery score the stage carries, where the night's last such stage gives the night's recovery. */
  recovery: number | null;
}

/** What a tracker scored of one sleep, each null where it has not. */
export interface SleepFacts {
  /** Whether the sleep is a nap, which prints on the day it happened rather than as the night before a wake. */
  nap: boolean;
  /** How long the sleep spent in each stage, which its line prints, or null where the tracker has not scored it. */
  stages: {
    /** Time in bed, in milliseconds. */
    in_bed: number | null;
    /** Time in light sleep, in milliseconds. */
    light: number | null;
    /** Time in deep sleep, in milliseconds. */
    deep: number | null;
    /** Time in REM sleep, in milliseconds. */
    rem: number | null;
    /** Time awake in bed, in milliseconds. */
    awake: number | null;
    /** How many sleep cycles it counted. */
    cycles: number | null;
    /** How many disturbances it counted. */
    disturbances: number | null;
  } | null;
  /** The share of time in bed spent asleep, in percent. */
  efficiency: number | null;
  /** How much of the sleep the tracker judged needed was had, in percent. */
  performance: number | null;
  /** Breaths per minute while asleep. */
  respiratory_rate: number | null;
}

/** A tracker's sleep, one record over the record's time. */
export interface Sleep extends SleepFacts {
  /** Marks the item a tracker's sleep. */
  item: "sleep";
  /** The key of the cycle record it belongs to, which prints it in its stead while that cycle states it. */
  cycle: string | null;
}

/** A tracker's own workout over the record's time, with what the tracker measured of it. */
export interface Workout {
  /** Marks the item a tracker's workout. */
  item: "workout";
  /** The sport in lower-case words, such as `running`, which begins its line and keys its fact. */
  sport: string | null;
  /** The strain it caused, on the tracker's own scale. */
  strain: number | null;
  /** Its average heart rate in beats per minute, as the tracker reckoned it. */
  average_heart_rate?: number | null;
  /** Its highest heart rate in beats per minute. */
  max_heart_rate?: number | null;
  /** The energy it spent, in kilojoules, which its line prints in kilocalories. */
  kilojoule?: number | null;
  /** The distance it covered, in metres, which its line prints in kilometres. */
  distance_m?: number | null;
}

/** A workout an instrument wrote into a provider that holds many instruments' data, over the record's time. */
export interface InstrumentWorkout {
  /** Marks the item an instrument's workout. */
  item: "instrument-workout";
  /** The name of the instrument that wrote it, which its line names. */
  instrument: string;
  /** The activity in the provider's words, which begins its line and keys its fact. */
  activity: string;
  /** How long it lasted in seconds, where the record's time gives it when null. */
  duration_s: number | null;
  /** The distance as a decimal, a space and its unit, such as `5010 m`, printed in kilometres where its unit is `m` and counted where it is `m` or `km`. */
  distance: string | null;
  /** The energy as a decimal, a space and its unit, such as `375 kcal`, printed as stated and counted in kilocalories where its unit is `kcal` or `kJ`. */
  energy?: string | null;
  /** Its average heart rate in beats per minute. */
  average_heart_rate?: number | null;
  /** Its highest heart rate in beats per minute. */
  max_heart_rate?: number | null;
  /** The strain it caused, on the instrument's own scale. */
  strain: number | null;
}

/** What a tracker scored of one night's recovery, each null where it has not. */
export interface RecoveryFacts {
  /** The recovery score, on the tracker's own scale. */
  score: number | null;
  /** Heart rate variability, in milliseconds. */
  hrv: number | null;
  /** Resting heart rate, in beats per minute. */
  resting_heart_rate: number | null;
}

/** A tracker's recovery, one record keyed as its physiological day is, printed at the wake of the sleep it names. */
export interface Recovery extends RecoveryFacts {
  /** Marks the item a tracker's recovery. */
  item: "recovery";
  /** The key of the sleep record it scores, whose end is the wake it prints at. */
  sleep: string | null;
}

/** A physiological day's effort as it closed, each null where the tracker has not scored it. */
export interface Strain {
  /** The day's strain, on the tracker's own scale. */
  strain: number | null;
  /** The day's average heart rate, in beats per minute. */
  average_heart_rate: number | null;
  /** The day's highest heart rate, in beats per minute. */
  max_heart_rate: number | null;
  /** The energy the day spent, in kilojoules. */
  kilojoule: number | null;
}

/** A tracker's physiological day, one record over the record's time, whose strain prints beside its recovery once it closes. */
export interface PhysioDay extends Strain {
  /** Marks the item a physiological day. */
  item: "physio-day";
  /** Whether the day has ended, before which its strain is not read. */
  closed: boolean;
}

/** A tracker's physiological day with its sleeps, workouts and recovery inside it, each timed, printed as their separate items would be. */
export interface Cycle {
  /** Marks the item a cycle. */
  item: "cycle";
  /** The sleeps in the cycle, each with its span. */
  sleeps: (SleepFacts & {
    /** When the sleep began, in milliseconds since the epoch. */
    start_ms: number;
    /** When the sleep ended, in milliseconds since the epoch. */
    end_ms: number;
  })[];
  /** The workouts in the cycle, each with its span. */
  workouts: (Omit<Workout, "item"> & {
    /** When the workout began, in milliseconds since the epoch. */
    start_ms: number;
    /** When the workout ended, in milliseconds since the epoch. */
    end_ms: number;
  })[];
  /** The cycle's recovery, or null where it scored none. */
  recovery: (RecoveryFacts & {
    /** The wake it scores, in milliseconds since the epoch, where it prints. */
    wake_ms: number;
    /** The day's strain once the day has closed, or null before. */
    strain: (Strain & {
      /** When the day closed, in milliseconds since the epoch. */
      end_ms: number;
    }) | null;
  }) | null;
  /** The separate items of the same source the cycle also holds, which print only through the cycle while it is live. */
  states: {
    /** The keys of the sleep records it holds. */
    sleeps: string[];
    /** The keys of the workout records it holds. */
    workouts: string[];
    /** Whether it holds the recovery record keyed as it is. */
    recovery: boolean;
  };
}

/** One date's activity rings, each as the value reached and its goal in the provider's words. */
export interface DaySummary {
  /** Marks the item an activity summary. */
  item: "day-summary";
  /** The calendar date it summarises, as `YYYY-MM-DD`. */
  date: string;
  /** The energy burned, its goal and their unit, such as `kcal`. */
  move: [string, string, string];
  /** The minutes of exercise and their goal. */
  exercise: [string, string];
  /** The hours stood in and their goal. */
  stand: [string, string];
}

/** One snapshot of one hour of a device's use, over the record's hour, where the snapshot captured last is the hour's. */
export interface Usage {
  /** Marks the item an hour of use. */
  item: "usage";
  /** When the device captured the snapshot, in milliseconds since the epoch, or null where it states none and the snapshot is not read. */
  captured_ms: number | null;
  /** The device's own total for the hour, in seconds, which its line prints first. */
  seconds: number | null;
  /** The time each category of apps was used in the hour, which its line prints most first. */
  categories: {
    /** The category's name. */
    name: string;
    /** Its use, in seconds. */
    seconds: number;
  }[];
}

/** One record read as what the health family makes of it. */
export type HealthItem = Sample | Stage | Sleep | Workout | InstrumentWorkout | Recovery | PhysioDay | Cycle | DaySummary | Usage;

/** How a health provider's or a tracker's records become samples, nights, workouts, recoveries, rings and hours of use. */
export interface HealthAdapter extends Adapter {
  /** The instrument names its own data carries when its app writes it into another provider, such as `WHOOP`, so that its own data wins over that copy and the copy prints under its connector's name. */
  instrument?: readonly string[];
  /** One record read as its item, or null for a record the family does not read. */
  item(record: InputRecord): HealthItem | null;
}
