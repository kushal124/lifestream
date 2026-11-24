import { canonical, deliveredLines, isObject, lineText, parseLine, refuse, type Guard, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const ANSWERS_FILE = "google-places.ndjson";
export const ANSWER_KIND = "answer";
export const ANSWER_TYPE = "google-places.answer";

export const REQUESTS = ["nearby", "venues", "airport", "beach"] as const;
export type Request = (typeof REQUESTS)[number];

const KEY = /^(nearby|venues|airport|beach):(-?\d{1,2}\.\d{5}),(-?\d{1,3}\.\d{5}):([1-9]\d{0,5})$/u;

export function answerKey(request: Request, latitude: number, longitude: number, radius_m: number): string {
  return `${request}:${latitude.toFixed(5)},${longitude.toFixed(5)}:${radius_m}`;
}

export function readAnswerKey(key: string): { request: Request; latitude: number; longitude: number; radius_m: number } | undefined {
  const match = KEY.exec(key);
  if (match === null) return undefined;
  const [latitude, longitude] = [Number(match[2]), Number(match[3])];
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { request: match[1] as Request, latitude, longitude, radius_m: Number(match[4]) };
}

const answerGuard: Guard = (content) => {
  if (!isObject(content) || content.type !== ANSWER_TYPE) return [`content must be Google's answer beside type ${ANSWER_TYPE}`];
  const places = content.places;
  return places === undefined || (Array.isArray(places) && places.every((place) => isObject(place))) ? [] : ["places, when Google states them, must be a list of objects"];
};

export function answerLine(key: string, at_ms: number, answer: JsonObject): string {
  return canonical({ at_ms, content: { ...answer, type: ANSWER_TYPE }, key, kind: ANSWER_KIND });
}

export const googlePlacesConnector: Reader = {
  name: "google-places",
  kinds: { [ANSWER_KIND]: answerGuard },
  async *read(delivery, files): AsyncIterable<ReaderOutput> {
    const listing = delivery.files.find((file) => file.path === ANSWERS_FILE);
    if (listing === undefined) return;
    for (const yielding of [false, true]) {
      for await (const { bytes, line, where } of deliveredLines(files, listing)) {
        const one = row(lineText(bytes, where), line);
        if (yielding) yield one;
      }
    }
  },
};

function row(line: string, ordinal: number): ReaderOutput {
  const at = `${ANSWERS_FILE} line ${ordinal}`;
  const value = parseLine(line, at);
  if (Object.keys(value).sort().join(",") !== "at_ms,content,key,kind" || value.kind !== ANSWER_KIND) {
    return refuse(`${at} must hold exactly kind answer, key, at_ms and content`);
  }
  const { key, at_ms, content } = value;
  if (typeof key !== "string" || readAnswerKey(key) === undefined) return refuse(`${at} must state a key <request>:<lat5>,<lon5>:<radius>, the request one of ${REQUESTS.join(", ")}`);
  if (typeof at_ms !== "number" || !Number.isSafeInteger(at_ms) || at_ms < 0) return refuse(`${at} must state at_ms, the asking, in ms since the epoch`);
  const violations = answerGuard(content!);
  if (violations.length > 0) return refuse(`${at}: ${violations.join("; ")}`);
  return { kind: ANSWER_KIND, key, content: content!, time: { start_ms: at_ms, precision: "ms" } };
}
