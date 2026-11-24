import { instant, isObject, type Activity, type InputRecord, type Json, type JsonObject, type Visit, type Witness } from "@lifestreamprotocol/connect/sdk";

export const timelinePhysical: Witness = {
  version: "1",
  kinds: ["place-visit", "trip"],
  name: "Timeline",
  rank: 40,
  how: "stated",

  visit({ version }: InputRecord): Visit | null {
    const segment = stated(version.content, "timeline.visit");
    const visit = object(segment?.visit);
    const candidate = object(visit?.topCandidate);
    const centre = geo(candidate?.placeLocation);
    const span = interval(segment);
    if (visit === null || visit.hierarchyLevel !== "0" || centre === null || span === null) return null;
    const id = candidate?.placeID;
    return { ...span, centre, place: typeof id === "string" && id.length > 0 ? `google:${id}` : null };
  },

  activity({ version }: InputRecord): Activity | null {
    const segment = stated(version.content, "timeline.trip");
    const activity = object(segment?.activity);
    const span = interval(segment);
    const type = object(activity?.topCandidate)?.type;
    const distance = typeof activity?.distanceMeters === "string" && /^\d+(?:\.\d+)?$/u.test(activity.distanceMeters) ? Number(activity.distanceMeters) : null;
    if (activity === null || span === null || typeof type !== "string" || type.length === 0 || distance === null) return null;
    const mode = type === "walking" ? "walk" : type === "cycling" ? "cycle" : type === "flying" ? "flight" : "road_vehicle";
    return { ...span, stated: type, mode, distance_m: distance, from: geo(activity.start), to: geo(activity.end) };
  },
};

function stated(content: Json, type: string): JsonObject | null {
  const record = object(content);
  return record?.type === type ? object(record.content) : null;
}

function interval(segment: JsonObject | null): { start_ms: number; end_ms: number } | null {
  const start = time(segment?.startTime);
  const end = time(segment?.endTime);
  return start === null || end === null || end <= start ? null : { start_ms: start, end_ms: end };
}

function geo(value: Json | undefined): { latitude: number; longitude: number } | null {
  const match = typeof value === "string" ? /^geo:([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)$/u.exec(value) : null;
  if (match === null) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
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
