import { instant, isObject, type Adapters, type Fix, type InputRecord, type Json, type JsonObject, type Motion, type Report, type Trial, type Vigilance } from "@lifestreamprotocol/connect/sdk";

const FLAGS = ["stationary", "walking", "running", "automotive", "cycling", "unknown"] as const;

export const physicalAdapters: Readonly<Record<string, Pick<Adapters, "physical">>> = {
  location: {
    physical: {
      version: "1",
      kinds: ["fix"],
      name: "Phone",
      rank: 10,
      how: "observed",
      fix({ version }: InputRecord): Fix | null {
        const content = object(version.content);
        const entry = object(content?.content);
        const location = object(object(entry?.payload)?.location);
        if (content?.type !== "location.fix" || entry?.kind !== "fix" || location === null) return null;
        const at = time(location.timestamp_rfc3339_utc);
        const { latitude, longitude, horizontal_accuracy: accuracy, speed, altitude } = location;
        if (at === null || !finite(latitude) || !finite(longitude) || !finite(accuracy) || !finite(speed) || !finite(altitude)) return null;
        if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
        return { at_ms: at, latitude, longitude, accuracy_m: accuracy, altitude_m: altitude, speed_mps: speed < 0 ? null : speed };
      },
    },
  },
  motion: {
    physical: {
      version: "1",
      kinds: ["motion"],
      motion({ version }: InputRecord): Motion | null {
        const content = object(version.content);
        const payload = object(object(content?.content)?.payload);
        if (content?.type !== "motion.activity" || payload === null || payload.delivery !== "live_update") return null;
        const at = time(payload.start_date_rfc3339);
        if (at === null || !FLAGS.every((flag) => typeof payload[flag] === "boolean")) return null;
        const motion = { at_ms: at } as Motion;
        for (const flag of FLAGS) motion[flag] = payload[flag] as boolean;
        return motion;
      },
    },
  },
  checkin: {
    physical: {
      version: "1",
      kinds: ["report", "vigilance"],
      report({ version }: InputRecord): Report | null {
        const entry = stated(version.content, "checkin.report");
        const payload = object(entry?.payload);
        const at = time(entry?.observed_at);
        if (payload === null || at === null || typeof payload.form !== "string" || !Array.isArray(payload.items)) return null;
        const items = payload.items.flatMap((item) => {
          const value = object(item);
          return value !== null && typeof value.id === "string" && typeof value.scale === "number" &&
            (typeof value.value === "string" || typeof value.value === "number" || typeof value.value === "boolean")
            ? [{ id: value.id, value: value.value, scale: value.scale }] : [];
        });
        return { at_ms: at, form: payload.form, items, note: typeof payload.note === "string" && payload.note.trim().length > 0 ? payload.note : null };
      },
      vigilance({ version }: InputRecord): Vigilance | null {
        const entry = stated(version.content, "checkin.vigilance");
        const payload = object(entry?.payload);
        const at = time(entry?.observed_at);
        if (payload === null || at === null || !Array.isArray(payload.trials)) return null;
        const trials = payload.trials.flatMap((each): Trial[] => {
          const trial = object(each);
          if (trial?.class === "response") return finite(trial.rt_ms) ? [{ outcome: "response", rt_ms: trial.rt_ms }] : [];
          return trial?.class === "timeout" || trial?.class === "false_start" ? [{ outcome: trial.class }] : [];
        });
        return { at_ms: at, completed: payload.completed === true, trials };
      },
    },
  },
};

function stated(content: Json, type: string): JsonObject | null {
  const record = object(content);
  return record?.type === type ? object(record.content) : null;
}

function time(value: Json | undefined): number | null {
  if (typeof value !== "string") return null;
  try {
    return instant(value, "rfc3339").start_ms;
  } catch {
    return null;
  }
}

function object(value: Json | undefined): JsonObject | null {
  return isObject(value) ? value : null;
}

function finite(value: Json | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
