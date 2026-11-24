import { archive, basicInstant, consuming, each, instantOf, isObject, jsonAt, readJson, refuse, Refused, spanOf, tryInstant, utf8, wholeFiles, type Guard, type ImportStated, type Instant, type Json, type JsonObject, type Member, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

const JSON_FILE = /\.json$/iu;
const WHOLE = Number.MAX_SAFE_INTEGER;

const FAMILIES = { visit: ["place-visit", "timeline.visit"], activity: ["trip", "timeline.trip"], timelinePath: ["path", "timeline.path"] } as const;

function segmentGuard(type: string): Guard {
  return (content) => {
    if (!isObject(content) || Object.keys(content).sort().join(",") !== "content,type") return ["content must hold exactly type and content"];
    const out: string[] = [];
    if (content.type !== type) out.push(`type must be ${type}`);
    if (!isObject(content.content)) out.push("content.content must be the segment object");
    return out;
  };
}

export const googleTimeline: Reader = {
  name: "google-timeline",
  kinds: { "place-visit": segmentGuard("timeline.visit"), trip: segmentGuard("timeline.trip"), path: segmentGuard("timeline.path") },
  states: timelineStated,
  async *read(delivery, files) {
    const device = typeof delivery.facts.device === "string" && delivery.facts.device.length > 0 ? delivery.facts.device : undefined;
    let whole: Member[] = [];
    yield* consuming(delivery, archive(delivery, files, (members) => {
      const exports = histories(members);
      if (exports.length === 0) refuse("the delivery holds no .json location history");
      whole = wholeFiles(members, (member) => JSON_FILE.test(member.name));
      return each(exports, (member) => member.where, (member) => {
        const segments = topLevel(readJson(utf8(member.bytes(WHOLE), member.where), member.where), member.where);
        const where = (index: number) => `${member.where}:semanticSegments[${index}]`;
        return each(segments.entries(), ([index]) => where(index), ([index, segment]) => {
          const row = segmentRow(segment, where(index));
          return [device === undefined ? row : { ...row, device }];
        });
      });
    }), () => whole);
  },
};

function histories(members: readonly Member[]): Member[] {
  return members.filter((member) => JSON_FILE.test(member.name)).sort((left, right) => (left.where < right.where ? -1 : 1));
}

async function timelineStated(members: readonly Member[]): Promise<ImportStated> {
  let newest: number | undefined;
  let read = 0;
  let shaped = 0;
  for (const member of histories(members)) {
    let segments = 0;
    try {
      for await (const part of jsonAt(member.chunks(), member.where, ["[*]", "semanticSegments[*]"])) {
        let segment: Json;
        try {
          segment = readJson(utf8(part.read(), part.where), part.where);
        } catch (error) {
          if (error instanceof Refused) continue;
          throw error;
        }
        if (isObject(segment) && typeof segment.startTime === "string") segments++;
        const end = isObject(segment) && typeof segment.endTime === "string" ? tryInstant(segment.endTime, "rfc3339")?.start_ms : undefined;
        if (end !== undefined) newest = Math.max(newest ?? end, end);
      }
    } catch (error) {
      if (error instanceof Refused) continue;
      throw error;
    }
    read++;
    if (segments > 0) shaped++;
  }
  if (read > 0 && shaped === 0) refuse("This isn't a Timeline export: none of its files holds a location history");
  return newest === undefined ? {} : { time_ms: newest };
}

function topLevel(value: Json, where: string): Json[] {
  const segments = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.semanticSegments) ? value.semanticSegments : refuse(`${where}: holds neither a segment array nor semanticSegments`);
  if (segments.length === 0) refuse(`${where}: the segment array is empty`);
  return segments;
}

function segmentRow(segment: Json, where: string): ReaderOutput {
  if (!isObject(segment)) refuse(`${where}: a segment must be an object`);
  const families = (Object.keys(FAMILIES) as (keyof typeof FAMILIES)[]).filter((family) => Object.hasOwn(segment, family));
  if (families.length !== 1) refuse(`${where}: holds ${families.length === 0 ? "none" : families.join(" and ")} of visit, activity and timelinePath`);
  const family = families[0]!;
  const [kind, type] = FAMILIES[family];
  const start = stamp(segment.startTime, `${where}.startTime`);
  const end = stamp(segment.endTime, `${where}.endTime`);
  const time = spanOf(start, end, where);
  const second = basicInstant(Math.floor(start.start_ms / 1000) * 1000);
  let key = second;
  if (family === "visit" && isObject(segment.visit) && isObject(segment.visit.topCandidate) && Object.hasOwn(segment.visit.topCandidate, "placeID")) {
    const place = segment.visit.topCandidate.placeID;
    if (typeof place !== "string" || place.length === 0) refuse(`${where}.visit.topCandidate.placeID: a stated place id must be non-empty text`);
    key = `${second}:${place}`;
  }
  return { kind, key, content: { type, content: segment }, time, locator: where };
}

function stamp(value: Json | undefined, where: string): Instant {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(value)) {
    refuse(`${where}: must be a full RFC 3339 time`);
  }
  return instantOf(value, "rfc3339", where);
}

