import { attempt, each, isObject, readJson, refuse, Refused, span, spanOf, type DeliveryFile, type Instant, type Json, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { statesStress, stressPoints, stressUser, zoneOffset } from "./graph.js";
import { apiUrl, at, basic, count, covers, cycleWindow, date, everyUserId, integerText, object, SHA256, text, timestamp, UUID } from "./parts.js";

export const APP_FORMAT = "org.lifestreamprotocol.whoop-app-snapshot/0.1";

const OFFSET = /^[+-](?:[01]\d|2[0-3]):?[0-5]\d$/u;
const DURING = /^\['([^']+)',(?:'([^']+)')?\)$/u;

const HOUR_MS = 3_600_000;

type JsonParser = (file: DeliveryFile, where: string) => Json;
interface Listed {
  entry: JsonObject;
  name: string;
  where: string;
  file: DeliveryFile;
}

export function checkedApp(byPath: Map<string, DeliveryFile>, parse: JsonParser, account: string, textOf?: (file: DeliveryFile, where: string) => string): AsyncIterable<ReaderOutput> | Iterable<ReaderOutput> {
  const manifestFile = byPath.get("app/manifest.json");
  if (manifestFile === undefined) {
    if ([...byPath.keys()].some((path) => path.startsWith("app/"))) refuse("the app half holds no manifest.json");
    return [];
  }
  const where = "app/manifest.json";
  const manifest = object(parse(manifestFile, where), where);
  everyUserId(manifest, account, where);
  if (manifest.format !== APP_FORMAT) refuse(`${where} states format ${JSON.stringify(manifest.format)}, not ${APP_FORMAT}`);
  if (manifest.complete !== true) refuse(`${where}: the capture is not complete`);
  const snapshot = at(manifest.started_at, `${where}.started_at`).start_ms;
  timestamp(manifest.finished_at, `${where}.finished_at`);
  const range = object(manifest.date_range, `${where}.date_range`);
  const startDay = date(range.start, `${where}.date_range.start`);
  const endDay = date(range.end, `${where}.date_range.end`);
  if (endDay < startDay) refuse(`${where}.date_range ends before it starts`);
  const zone = text(range.timezone, `${where}.date_range.timezone`);
  zoneOffset(zone, 0);
  const step = manifest.hr_step_s;
  if (step !== 6 && step !== 60 && step !== 600) refuse(`${where}.hr_step_s must be 6, 60 or 600`);

  const listed = new Set<string>(["manifest.json"]);
  const member = (entry: JsonObject, at: string, kind: string): DeliveryFile => {
    const file = text(entry.file, `${at}.file`);
    if (file.includes("/") || !file.endsWith(".json")) refuse(`${at}.file must be a JSON file in app/`);
    if (listed.has(file)) refuse(`${where} lists ${file} twice`);
    listed.add(file);
    const sha256 = text(entry.sha256, `${at}.sha256`);
    if (!SHA256.test(sha256)) refuse(`${at}.sha256 must be 64 lower-case hex digits`);
    const found = byPath.get(`app/${file}`) ?? refuse(`${where} lists ${file}, which the capture does not hold`);
    if (found.blob !== `sha256:${sha256}`) refuse(`app/${file}: its SHA-256 is not the one its manifest states`);
    if (found.size !== count(entry.bytes, `${at}.bytes`)) refuse(`app/${file}: its manifest states ${String(entry.bytes)} bytes, the file holds ${found.size}`);
    requestUrl(kind, entry, text(entry.request_url, `${at}.request_url`), `${at}.request_url`, account, step);
    return found;
  };
  const group = (name: string): Listed[] => {
    const stated = manifest[name];
    if (!Array.isArray(stated)) refuse(`${where}.${name} must be an array`);
    return stated.map((raw, index) => {
      const entry = object(raw, `${where}.${name}[${index}]`);
      const file = member(entry, `${where}.${name}[${index}]`, name);
      const listed = text(entry.file, `${where}.${name}[${index}].file`);
      return { entry, name: listed, where: `app/${listed}`, file };
    });
  };
  const groups = { cycles: group("cycles"), sleepEvents: group("sleep_events"), heartRate: group("heart_rate"), stress: group("stress") };
  for (const path of byPath.keys()) {
    if (path.startsWith("app/") && !listed.has(path.slice(4))) refuse(`${path} is in the capture but not in its manifest`);
  }
  const cycles = groups.cycles.map((page) => ({ ...page, ...cyclePage(page) }));
  const sleeps = groups.sleepEvents.map((file) => ({ ...file, ...sleepPlace(file) }));
  for (const file of groups.heartRate) {
    if (file.entry.step !== step) refuse(`${file.where}: the manifest states step ${String(file.entry.step)}, the capture's step is ${step}`);
    count(file.entry.readings, `${file.where} manifest readings`);
  }
  for (const { entry, where } of groups.stress) date(entry.date, `${where} manifest date`);

  const cached = new Map<string, Json>();
  const stressSet = new Set(groups.stress);
  for (const file of [...groups.cycles, ...groups.sleepEvents, ...groups.heartRate, ...groups.stress]) {
    let raw: string | undefined;
    const value = attempt(() => {
      if (textOf !== undefined) {
        raw = textOf(file.file, file.where);
        return readJson(raw, file.where);
      }
      return parse(file.file, file.where);
    });
    if (value instanceof Refused) continue;
    cached.set(file.where, value);
    if (raw === undefined || raw.includes("user_id") || raw.includes("userId") || raw.includes("\\u")) {
      everyUserId(value, account, file.where);
    }
    if (stressSet.has(file) && isObject(value)) stressUser(value, file.where, account);
  }
  const parsed: JsonParser = (file, where) => (cached.has(where) ? cached.get(where)! : parse(file, where));
  return rowsOf(cycles, sleeps, groups.heartRate, groups.stress, parsed, snapshot, zone, step);
}

const whereOf = (file: Listed): string => file.where;

async function* rowsOf(cycles: CyclePage[], sleeps: SleepFile[], heartRate: Listed[], stress: Listed[], parse: JsonParser, snapshot: number, zone: string, step: number): AsyncGenerator<ReaderOutput> {
  const stated = new Map<string, ReaderOutput>();
  yield* each(cycles, whereOf, (page) => {
    for (const row of cycleRows(page, parse(page.file, page.where), snapshot)) stated.set(row.key, row);
    return [];
  });
  yield* stated.values();
  yield* each(sleeps, whereOf, (file) => sleepStageRows(file, parse(file.file, file.where)));
  const series = heartRateSeries(zone, step);
  yield* each(heartRate, whereOf, (file) => series(file, parse(file.file, file.where)));
  const chosen = new Map<string, ReaderOutput>();
  yield* each(stress, whereOf, (file) => {
    for (const row of stressRows(file, parse(file.file, file.where), zone)) {
      const before = chosen.get(row.key);
      if (before === undefined || JSON.stringify(before.content) !== JSON.stringify(row.content)) chosen.set(row.key, row);
    }
    return [];
  });
  yield* chosen.values();
}

interface CyclePage extends Listed {
  expected: number;
  window: { start: number; end: number };
}

function cyclePage(page: Listed): Pick<CyclePage, "expected" | "window"> {
  const url = `${page.where} manifest request_url`;
  return { expected: count(page.entry.records, `${page.where} manifest records`), window: cycleWindow(new URL(text(page.entry.request_url, url)), url) };
}

function cycleRows({ name, where, expected, window }: CyclePage, value: Json, snapshot: number): ReaderOutput[] {
  const stated = object(value, where);
  if (!Array.isArray(stated.records)) refuse(`${where}.records must be an array`);
  if (stated.records.length !== expected) refuse(`${where}: the manifest counts ${expected} records, the page holds ${stated.records.length}`);
  return stated.records.flatMap((raw, index): ReaderOutput[] => {
    const answer = object(raw, `${where}.records[${index}]`);
    const cycle = object(answer.cycle, `${where}.records[${index}].cycle`);
    const key = integerText(cycle.id, `${where}.records[${index}].cycle.id`);
    const offset = offsetText(cycle.timezone_offset, `${where}.records[${index}].cycle.timezone_offset`);
    const time = duringTime(cycle.during, `${where}.records[${index}].cycle.during`, offset, true);
    if (!covers(window, { start: time.start_ms, end: time.end_ms ?? snapshot })) return [];
    return [{ kind: "cycle", key, content: { type: "whoop.cycle-details", content: answer }, time, locator: `${name}#records[${index}]` }];
  });
}

interface SleepFile extends Listed {
  key: string;
  offset: string;
}

function sleepPlace(file: Listed): Pick<SleepFile, "key" | "offset"> {
  const key = file.entry.activity_id;
  if (typeof key !== "string" || !UUID.test(key)) refuse(`${file.where}: the manifest's activity_id must be a provider UUID`);
  return { key: key as string, offset: offsetText(file.entry.timezone_offset, `${file.where} manifest timezone_offset`) };
}

function sleepStageRows({ name, where, key, offset }: SleepFile, events: Json): ReaderOutput[] {
  if (!Array.isArray(events)) refuse(`${where} must hold a JSON array`);
  if (events.length === 0) return [];
  let first: Instant | undefined;
  let last: Instant | undefined;
  for (const [index, raw] of events.entries()) {
    const event = object(raw, `${where}[${index}]`);
    text(event.type, `${where}[${index}].type`);
    const time = duringTime(event.during, `${where}[${index}].during`, offset, false);
    if (first === undefined || time.start_ms < first.start_ms) first = time;
    if (last === undefined || time.end_ms! > last.end_ms!) last = time;
  }
  return [{ kind: "sleep-stages", key, content: { type: "whoop.sleep-events", content: events }, time: span(first!, last!), locator: name }];
}

interface Readings {
  times: Float64Array;
  bpms: Float64Array;
}

function readingAt({ times, bpms }: Readings, ms: number): number | undefined {
  let low = 0;
  let high = times.length - 1;
  if (high < 0 || ms < times[0]! || ms > times[high]!) return undefined;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const at = times[middle]!;
    if (at === ms) return bpms[middle];
    if (at < ms) low = middle + 1;
    else high = middle - 1;
  }
  return undefined;
}

function heartRateSeries(zone: string, step: number): (file: Listed, value: Json) => Iterable<ReaderOutput> {
  const earlier: Readings[] = [];
  const offsetAt = hourlyOffset(zone);
  return ({ entry, name, where }, value) => {
    const answer = object(value, where);
    if (answer.name !== "heart_rate") refuse(`${where}.name must be heart_rate`);
    if (!Array.isArray(answer.values)) refuse(`${where}.values must be an array`);
    const expected = count(entry.readings, `${where} manifest readings`);
    if (answer.values.length !== expected) refuse(`${where}: the manifest counts ${expected} readings, the file holds ${answer.values.length}`);
    const times = new Float64Array(expected);
    const bpms = new Float64Array(expected);
    let previous = -Infinity;
    for (const [index, raw] of answer.values.entries()) {
      const point = object(raw, `${where}.values[${index}]`);
      const ms = point.time;
      if (typeof ms !== "number" || !Number.isSafeInteger(ms)) refuse(`${where}.values[${index}].time must be epoch milliseconds`);
      if (ms <= previous) refuse(`${where}: heart-rate times must strictly increase`);
      previous = ms;
      const bpm = point.data;
      if (typeof bpm !== "number" || !Number.isFinite(bpm)) refuse(`${where}.values[${index}].data must be a number (bpm)`);
      for (const file of earlier) {
        const stated = readingAt(file, ms);
        if (stated !== undefined && stated !== bpm) refuse(`${where}: two different readings at ${basic(ms)} in one delivery`);
      }
      times[index] = ms;
      bpms[index] = bpm;
    }
    const before = [...earlier];
    earlier.push({ times, bpms });
    return (function* (): Iterable<ReaderOutput> {
      for (let index = 0; index < times.length; index++) {
        const ms = times[index]!;
        if (before.some((file) => readingAt(file, ms) !== undefined)) continue;
        yield { kind: "sample", key: `hr${step}:${basic(ms)}`, content: { type: "whoop.heart-rate", content: { bpm: bpms[index]! } }, time: { start_ms: ms, offset_min: offsetAt(ms), precision: "ms" }, locator: `${name}#values[${index}]` };
      }
    })();
  };
}

function hourlyOffset(zone: string): (ms: number) => number {
  let hour = Number.NaN;
  let offset = 0;
  return (ms) => {
    const at = Math.floor(ms / HOUR_MS);
    if (at === hour) return offset;
    const [start, end] = [zoneOffset(zone, at * HOUR_MS), zoneOffset(zone, (at + 1) * HOUR_MS)];
    if (start !== end) return zoneOffset(zone, ms);
    hour = at;
    offset = start;
    return offset;
  };
}

function stressRows({ name, where }: Listed, value: Json, zone: string): ReaderOutput[] {
  const root = object(value, where);
  const extended = root.extended24_hour_graph;
  if (!isObject(extended) || !isObject(extended.graph) || !statesStress(root, name)) return [];
  return stressPoints(root, name, zone).map((point): ReaderOutput => ({
    kind: "sample",
    key: `stress:${basic(point.ms)}`,
    content: { type: "whoop.stress", content: point.content },
    time: { start_ms: point.ms, offset_min: point.offset_min, precision: "s" },
    locator: point.locator,
  }));
}

function duringTime(value: Json | undefined, where: string, offset: string, open: boolean): Instant {
  const stated = text(value, where);
  const m = DURING.exec(stated) ?? refuse(`${where} ${JSON.stringify(stated)} is not a '['start','end')' range`);
  const start = at(m[1]!, `${where} start`, offset);
  if (m[2] === undefined) {
    if (!open) refuse(`${where} states an open span where a closed one is read`);
    return start;
  }
  return spanOf(start, at(m[2], `${where} end`, offset), where);
}

function requestUrl(kind: string, entry: JsonObject, raw: string, where: string, account: string, step: number): void {
  const url = apiUrl(raw, where);
  if (url.searchParams.get("apiVersion") !== "7") refuse(`${where} does not state apiVersion=7`);
  if (kind === "cycles") {
    if (url.pathname !== "/core-details-bff/v0/cycles/details") refuse(`${where} names another resource`);
    if (url.searchParams.get("id") !== account) refuse(`${where} asks for another user`);
  } else if (kind === "sleep_events") {
    if (url.pathname !== "/sleep-service/v1/sleep-events") refuse(`${where} names another resource`);
    if (url.searchParams.get("activityId") !== entry.activity_id) refuse(`${where} asks for another sleep`);
  } else if (kind === "heart_rate") {
    if (url.pathname !== `/metrics-service/v1/metrics/user/${account}`) refuse(`${where} names another resource or user`);
    if (url.searchParams.get("name") !== "heart_rate" || url.searchParams.get("step") !== String(step)) refuse(`${where} asks for another series or step`);
  } else if (kind === "stress") {
    if (url.pathname !== `/health-service/v2/stress-bff/${String(entry.date)}`) refuse(`${where} names another resource or day`);
  } else {
    refuse(`${where}: the manifest names a ${kind} group this connector does not read`);
  }
}


function offsetText(value: Json | undefined, where: string): string {
  if (typeof value !== "string" || !OFFSET.test(value) || /^-00:?00$/u.test(value)) refuse(`${where} must be a numeric offset`);
  return value as string;
}
