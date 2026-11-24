import { instant, isObject, type HealthAdapter, type HealthItem, type InputRecord, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";

const SERIES: Readonly<Record<string, number>> = { hr6: 0, hr60: 1, hr600: 2 };
const GRAPH_SERIES = 3;

const SPORTS: Readonly<Record<number, string>> = {
  [-1]: "activity", 0: "running", 1: "cycling", 16: "baseball", 17: "basketball", 18: "rowing", 19: "fencing",
  20: "field hockey", 21: "football", 22: "golf", 24: "ice hockey", 25: "lacrosse", 27: "rugby", 28: "sailing",
  29: "skiing", 30: "soccer", 31: "softball", 32: "squash", 33: "swimming", 34: "tennis", 35: "track & field",
  36: "volleyball", 37: "water polo", 38: "wrestling", 39: "boxing", 42: "dance", 43: "pilates", 44: "yoga",
  45: "weightlifting", 47: "cross country skiing", 48: "functional fitness", 49: "duathlon", 51: "gymnastics",
  52: "hiking/rucking", 53: "horseback riding", 55: "kayaking", 56: "martial arts", 57: "mountain biking",
  59: "powerlifting", 60: "rock climbing", 61: "paddleboarding", 62: "triathlon", 63: "walking", 64: "surfing",
  65: "elliptical", 66: "stairmaster", 70: "meditation", 71: "other", 73: "diving", 74: "operations - tactical",
  75: "operations - medical", 76: "operations - flying", 77: "operations - water", 82: "ultimate", 83: "climber",
  84: "jumping rope", 85: "australian football", 86: "skateboarding", 87: "coaching", 88: "ice bath", 89: "commuting",
  90: "gaming", 91: "snowboarding", 92: "motocross", 93: "caddying", 94: "obstacle course racing", 95: "motor racing",
  96: "hiit", 97: "spin", 98: "jiu jitsu", 99: "manual labor", 100: "cricket", 101: "pickleball", 102: "inline skating",
  103: "box fitness", 104: "spikeball", 105: "wheelchair pushing", 106: "paddle tennis", 107: "barre",
  108: "stage performance", 109: "high stress work", 110: "parkour", 111: "gaelic football", 112: "hurling/camogie",
  113: "circus arts", 121: "massage therapy", 123: "strength trainer", 125: "watching sports", 126: "assault bike",
  127: "kickboxing", 128: "stretching", 230: "table tennis", 231: "badminton", 232: "netball", 233: "sauna",
  234: "disc golf", 235: "yard work", 236: "air compression", 237: "percussive massage", 238: "paintball",
  239: "ice skating", 240: "handball", 248: "f45 training", 249: "padel", 250: "barry's", 251: "dedicated parenting",
  252: "stroller walking", 253: "stroller jogging", 254: "toddlerwearing", 255: "babywearing", 258: "barre3",
  259: "hot yoga", 261: "stadium steps", 262: "polo", 263: "musical performance", 264: "kite boarding", 266: "dog walking",
  267: "water skiing", 268: "wakeboarding", 269: "cooking", 270: "cleaning", 272: "public speaking",
};

export const whoopHealth: HealthAdapter = {
  version: "2",
  kinds: ["sample", "sleep", "workout", "recovery", "physio-day", "cycle"],
  instrument: ["WHOOP"],
  item({ version }: InputRecord): HealthItem | null {
    const content = object(version.content);
    const stated = object(content?.content);
    if (content === null || stated === null) return null;
    switch (version.kind) {
      case "sample":
        if (content.type === "whoop.heart-rate") {
          const bpm = decimal(stated.bpm);
          const series = SERIES[version.key.slice(0, version.key.indexOf(":"))];
          return bpm === null || series === undefined ? null : { item: "sample", metric: "heart_rate", instrument: "WHOOP", unit: "count/min", value: bpm, series };
        }
        if (content.type === "whoop.hr") {
          const bpm = decimal(stated.bpm);
          return bpm === null ? null : { item: "sample", metric: "heart_rate", instrument: "WHOOP", unit: "count/min", value: bpm, series: GRAPH_SERIES };
        }
        if (content.type === "whoop.stress") {
          const display = decimal(stated.display);
          return display === null ? null : { item: "sample", metric: "stress", instrument: "WHOOP", unit: "score", value: display };
        }
        return null;
      case "sleep": {
        const score = scored(stated);
        const stages = object(score?.stage_summary);
        return {
          item: "sleep", cycle: scalarId(stated.cycle_id), nap: stated.nap === true,
          stages: stages === null ? null : {
            in_bed: number(stages.total_in_bed_time_milli),
            light: number(stages.total_light_sleep_time_milli),
            deep: number(stages.total_slow_wave_sleep_time_milli),
            rem: number(stages.total_rem_sleep_time_milli),
            awake: number(stages.total_awake_time_milli),
            cycles: number(stages.sleep_cycle_count),
            disturbances: number(stages.disturbance_count),
          },
          efficiency: number(score?.sleep_efficiency_percentage),
          performance: number(score?.sleep_performance_percentage),
          respiratory_rate: number(score?.respiratory_rate),
        };
      }
      case "workout": {
        const score = scored(stated);
        return {
          item: "workout", sport: text(stated.sport_name) ?? sportOf(stated.sport_id), strain: number(score?.strain),
          average_heart_rate: number(score?.average_heart_rate), max_heart_rate: number(score?.max_heart_rate),
          kilojoule: number(score?.kilojoule), distance_m: number(score?.distance_meter),
        };
      }
      case "recovery": {
        const score = scored(stated);
        return {
          item: "recovery", sleep: scalarId(stated.sleep_id),
          score: number(score?.recovery_score), hrv: number(score?.hrv_rmssd_milli), resting_heart_rate: number(score?.resting_heart_rate),
        };
      }
      case "physio-day": {
        const score = scored(stated);
        return {
          item: "physio-day", closed: stated.end !== null && stated.end !== undefined,
          strain: number(score?.strain), average_heart_rate: number(score?.average_heart_rate), max_heart_rate: number(score?.max_heart_rate), kilojoule: number(score?.kilojoule),
        };
      }
      case "cycle":
        return cycleOf(stated);
      default:
        return null;
    }
  },
};

function cycleOf(answer: JsonObject): HealthItem {
  const cycle = object(answer.cycle);
  const cycleDuring = cycle === null ? null : duringOf(cycle);
  const sleeps: Extract<HealthItem, { item: "cycle" }>["sleeps"] = [];
  const sleepEnds = new Map<string, number>();
  for (const raw of Array.isArray(answer.sleeps) ? answer.sleeps : []) {
    const sleep = object(raw);
    if (sleep === null) continue;
    const during = duringOf(sleep);
    const id = scalarId(sleep.activity_id);
    if (during === null || during.end_ms === null || id === null) continue;
    sleepEnds.set(id, during.end_ms);
    const score = number(sleep.score);
    const efficiency = number(sleep.in_sleep_efficiency);
    sleeps.push({
      start_ms: during.start_ms,
      end_ms: during.end_ms,
      nap: sleep.is_nap === true,
      stages: score === null ? null : {
        in_bed: number(sleep.time_in_bed),
        light: number(sleep.light_sleep_duration),
        deep: number(sleep.slow_wave_sleep_duration),
        rem: number(sleep.rem_sleep_duration),
        awake: number(sleep.wake_duration),
        cycles: number(sleep.cycles_count),
        disturbances: number(sleep.disturbances),
      },
      efficiency: efficiency === null ? null : efficiency * 100,
      performance: score,
      respiratory_rate: number(sleep.respiratory_rate),
    });
  }
  sleeps.sort((a, b) => a.start_ms - b.start_ms);
  const workouts: Extract<HealthItem, { item: "cycle" }>["workouts"] = [];
  for (const raw of Array.isArray(answer.workouts) ? answer.workouts : []) {
    const workout = object(raw);
    if (workout === null) continue;
    const during = duringOf(workout);
    if (during === null || during.end_ms === null) continue;
    workouts.push({
      start_ms: during.start_ms, end_ms: during.end_ms, sport: sportOf(workout.sport_id), strain: number(workout.score),
      average_heart_rate: number(workout.average_heart_rate), max_heart_rate: number(workout.max_heart_rate),
      kilojoule: number(workout.kilojoules), distance_m: null,
    });
  }
  workouts.sort((a, b) => a.start_ms - b.start_ms);
  let recovery: Extract<HealthItem, { item: "cycle" }>["recovery"] = null;
  const stated = object(answer.recovery);
  if (stated !== null) {
    const sleepId = scalarId(stated.activity_id);
    const closedAt = cycleDuring?.end_ms ?? null;
    const wake = (sleepId === null ? undefined : sleepEnds.get(sleepId)) ?? closedAt;
    if (wake !== null) {
      const hrv = number(stated.hrv_rmssd);
      recovery = {
        wake_ms: wake,
        score: number(stated.recovery_score),
        hrv: hrv === null ? null : hrv * 1000,
        resting_heart_rate: number(stated.resting_heart_rate),
        strain: closedAt !== null && cycle !== null ? {
          end_ms: closedAt,
          strain: number(cycle.scaled_strain),
          average_heart_rate: number(cycle.day_avg_heart_rate),
          max_heart_rate: number(cycle.day_max_heart_rate),
          kilojoule: number(cycle.day_kilojoules),
        } : null,
      };
    }
  }
  return {
    item: "cycle", sleeps, workouts, recovery,
    states: { sleeps: statedIds(answer, "sleeps"), workouts: statedIds(answer, "workouts"), recovery: stated !== null },
  };
}

function statedIds(answer: JsonObject, list: "sleeps" | "workouts"): string[] {
  const stated = answer[list];
  return Array.isArray(stated) ? stated.flatMap((nested) => scalarId(object(nested)?.activity_id) ?? []) : [];
}

function duringOf(value: JsonObject): { start_ms: number; end_ms: number | null } | null {
  const stated = text(value.during);
  const m = stated === null ? null : /^\['([^']+)',(?:'([^']+)')?\)$/u.exec(stated);
  if (m === null) return null;
  try {
    const start_ms = instant(m[1]!, "rfc3339").start_ms;
    return { start_ms, end_ms: m[2] === undefined ? null : instant(m[2], "rfc3339").start_ms };
  } catch {
    return null;
  }
}

function sportOf(value: Json | undefined): string | null {
  return typeof value === "number" && Number.isInteger(value) ? SPORTS[value] ?? null : null;
}

function scored(value: JsonObject): JsonObject | null {
  return value.score_state === "SCORED" ? object(value.score) : null;
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

function scalarId(value: Json | undefined): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}
