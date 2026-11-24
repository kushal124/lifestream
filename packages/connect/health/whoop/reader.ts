import { carriesNothing, addDays, isObject, readJson, refuse, sourceName, span, utf8, type DeliveryFile, type Guard, type Instant, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { heartRatePoints, placesHeartRate, statesHeartRate, statesStress, stressPoints, stressUser, zoneOffset, type Point } from "./graph.js";
import { apiUrl, at, basic, count, date, everyUserId, integerText, object, SHA256, text, timestamp, userId, UUID } from "./parts.js";
import { checkedApp } from "./app.js";

export const WHOOP_CONNECTOR = "whoop-capture";
export const OFFICIAL_FORMAT = "org.lifestreamprotocol.whoop-official-snapshot/0.1";
export const PRIVATE_FORMAT = "org.lifestreamprotocol.whoop-private-snapshot/0.1";

const RESOURCES = [
  { name: "cycles", kind: "physio-day", type: "whoop.cycle" },
  { name: "recoveries", kind: "recovery", type: "whoop.recovery" },
  { name: "sleeps", kind: "sleep", type: "whoop.sleep" },
  { name: "workouts", kind: "workout", type: "whoop.workout" },
] as const;
type Resource = (typeof RESOURCES)[number];

const OFFSET = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/u;

export const whoopConnector: Reader = {
  name: WHOOP_CONNECTOR,
  kinds: {
    "physio-day": official("whoop.cycle"),
    recovery: official("whoop.recovery"),
    sleep: official("whoop.sleep"),
    workout: official("whoop.workout"),
    cycle: official("whoop.cycle-details"),
    "sleep-stages": sleepStages,
    sample,
  },
  async *read(delivery, files) {
    if (carriesNothing(delivery)) return;
    const account = sourceUser(delivery.source);
    const byPath = new Map(delivery.files.map((file) => [file.path, file]));
    const textOf = (file: DeliveryFile, where: string): string => utf8(files.bytes(file.blob), where);
    const read = (file: DeliveryFile, where: string): JsonObject => {
      const value = readJson(textOf(file, where), where);
      if (!isObject(value)) refuse(`${where} must hold a JSON object`);
      return value;
    };
    if (![...byPath.keys()].some((path) => path.startsWith("official/") || path.startsWith("private/") || path.startsWith("app/"))) {
      refuse(`delivery ${delivery.id} holds neither an official/, a private/ nor an app/ half`);
    }
    const official = officialRows(byPath, read, textOf, account);
    const hand = privateRows(byPath, read, account);
    const app = checkedApp(byPath, (file, where) => readJson(textOf(file, where), where), account, textOf);
    yield* official;
    yield* hand;
    yield* app;
  },
};

type JsonReader = (file: DeliveryFile, where: string) => JsonObject;


function officialRows(byPath: Map<string, DeliveryFile>, read: JsonReader, textOf: (file: DeliveryFile, where: string) => string, account: string): ReaderOutput[] {
  const official = new Map([...byPath].filter(([path]) => path.startsWith("official/")).map(([path, file]) => [path.slice(9), file]));
  if (official.size === 0) return [];
  const capture = official.has("manifest.json") ? manifestCapture(official, read) : handCapture(official, textOf);
  const profile = read(capture.member(capture.profile), `official/${capture.profile}`);
  const stated = userId(profile.user_id, `official/${capture.profile}.user_id`);
  if (stated !== account) refuse(`official/${capture.profile} states user ${stated}; the source's user is ${account}`);
  everyUserId(profile, account, `official/${capture.profile}`);
  const rows: ReaderOutput[] = [];
  for (const resource of RESOURCES) {
    const pages = [...official.keys()].filter((name) => pageNumber(capture.layout, resource, name) !== null).sort();
    if (pages.length === 0) refuse(`the official capture names no ${resource.name} page`);
    let total = 0;
    for (const [index, name] of pages.entries()) {
      if (pageNumber(capture.layout, resource, name) !== index + 1) refuse(`official/${name}: ${resource.name} pages must run from 1 without a gap`);
      const where = `official/${name}`;
      const page = read(capture.member(name), where);
      everyUserId(page, account, where);
      if (!Array.isArray(page.records)) refuse(`${where}.records must be an array`);
      const expected = capture.records.get(name);
      if (expected !== undefined && page.records.length !== expected) refuse(`${where}: the manifest counts ${expected} records, the page holds ${page.records.length}`);
      total += page.records.length;
      const next = page.next_token;
      if (index < pages.length - 1 && typeof next !== "string") refuse(`${where}: pagination stops before the next sealed page`);
      if (index === pages.length - 1 && next !== null && next !== undefined) refuse(`${where}: the last page still states next_token`);
      for (const [at, value] of page.records.entries()) {
        rows.push(officialRow(resource, object(value, `${where}.records[${at}]`), `${name}#records[${at}]`));
      }
    }
    const counted = capture.totals.get(resource.name);
    if (counted !== undefined && counted !== total) refuse(`official/manifest.json counts ${counted} ${resource.name}, the pages hold ${total}`);
  }
  return rows;
}

interface OfficialCapture {
  layout: "manifest" | "hand";
  profile: string;
  member(name: string): DeliveryFile;
  records: Map<string, number>;
  totals: Map<string, number>;
}

function manifestCapture(official: Map<string, DeliveryFile>, read: JsonReader): OfficialCapture {
  const where = "official/manifest.json";
  const manifest = read(official.get("manifest.json")!, where);
  if (manifest.format !== OFFICIAL_FORMAT) refuse(`${where} states format ${JSON.stringify(manifest.format)}, not ${OFFICIAL_FORMAT}`);
  if (manifest.complete !== true) refuse(`${where}: the capture is not complete`);
  if (at(manifest.finished_at, `${where}.finished_at`).start_ms < at(manifest.started_at, `${where}.started_at`).start_ms) refuse(`${where}.finished_at precedes started_at`);
  const filters = object(manifest.filters, `${where}.filters`);
  if ((filters.start === null) !== (filters.end === null)) refuse(`${where}.filters.start and end are both instants or both null`);
  if (filters.start !== null) {
    if (at(filters.end, `${where}.filters.end`).start_ms < at(filters.start, `${where}.filters.start`).start_ms) refuse(`${where}.filters.end precedes start`);
  }
  const resources = object(manifest.resources, `${where}.resources`);
  const names = ["profile", ...RESOURCES.map((resource) => resource.name)];
  const extra = Object.keys(resources).find((name) => !names.includes(name));
  if (extra !== undefined) refuse(`${where}.resources names ${JSON.stringify(extra)}, which this connector does not read`);
  const listed = new Map<string, { bytes: number; sha256: string }>();
  const records = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const name of names) {
    const entry = object(resources[name], `${where}.resources.${name}`);
    if (!Array.isArray(entry.pages) || entry.pages.length === 0) refuse(`${where}.resources.${name}.pages must be a non-empty array`);
    for (const [index, raw] of entry.pages.entries()) {
      const at = `${where}.resources.${name}.pages[${index}]`;
      const page = object(raw, at);
      const file = text(page.file, `${at}.file`);
      const fits = name === "profile" ? file === "profile.json" : new RegExp(`^${name}-\\d{5}\\.json$`, "u").test(file);
      if (!fits) refuse(`${at}.file ${JSON.stringify(file)} is not a ${name} page name`);
      if (listed.has(file)) refuse(`${where} lists ${file} twice`);
      const sha256 = text(page.sha256, `${at}.sha256`);
      if (!SHA256.test(sha256)) refuse(`${at}.sha256 must be 64 lower-case hex digits`);
      listed.set(file, { bytes: count(page.bytes, `${at}.bytes`), sha256 });
      if (name !== "profile") records.set(file, count(page.records, `${at}.records`));
    }
    if (name === "profile") {
      if (entry.pages.length !== 1) refuse(`${where}.resources.profile.pages must list profile.json alone`);
    } else {
      totals.set(name, count(entry.record_count, `${where}.resources.${name}.record_count`));
    }
  }
  for (const name of official.keys()) {
    if (name !== "manifest.json" && !listed.has(name)) refuse(`official/${name} is in the capture but not in its manifest`);
  }
  for (const [name, stated] of listed) {
    const file = official.get(name) ?? refuse(`official/manifest.json lists ${name}, which the capture does not hold`);
    matches(file, stated, `official/${name}`);
  }
  return { layout: "manifest", profile: "profile.json", member: (name) => official.get(name)!, records, totals };
}

function handCapture(official: Map<string, DeliveryFile>, textOf: (file: DeliveryFile, where: string) => string): OfficialCapture {
  const manifest = official.get("MANIFEST.md");
  const sums = official.get("SHA256SUMS");
  if (manifest === undefined || sums === undefined) {
    refuse("the official half is neither the manifest layout (manifest.json) nor the hand layout (MANIFEST.md and SHA256SUMS)");
  }
  if (manifest.size === 0) refuse("official/MANIFEST.md is empty");
  const listed = new Set<string>();
  for (const [index, line] of textOf(sums, "official/SHA256SUMS").split(/\r?\n/u).entries()) {
    if (line.length === 0) continue;
    const m = /^([0-9a-f]{64}) {2}\.\/(.+)$/u.exec(line) ?? refuse(`official/SHA256SUMS line ${index + 1} is not '<sha256>  ./<path>'`);
    const name = m[2]!;
    if (name === "MANIFEST.md" || name === "SHA256SUMS") refuse(`official/SHA256SUMS must not list ${name}`);
    if (listed.has(name)) refuse(`official/SHA256SUMS lists ${name} twice`);
    listed.add(name);
    const file = official.get(name) ?? refuse(`official/SHA256SUMS lists ${name}, which the capture does not hold`);
    if (file.blob !== `sha256:${m[1]}`) refuse(`official/${name}: its SHA-256 is not the one SHA256SUMS states`);
  }
  if (listed.size === 0) refuse("official/SHA256SUMS is empty");
  if (!listed.has("profile.raw.json")) refuse("official/SHA256SUMS does not list profile.raw.json");
  const member = (name: string): DeliveryFile => {
    if (!listed.has(name)) refuse(`official/${name} is not listed in SHA256SUMS`);
    return official.get(name)!;
  };
  return { layout: "hand", profile: "profile.raw.json", member, records: new Map(), totals: new Map() };
}

function officialRow(resource: Resource, record: JsonObject, locator: string): ReaderOutput {
  const where = `official/${locator}`;
  let key: string;
  let time: Instant;
  if (resource.kind === "recovery") {
    key = integerText(record.cycle_id, `${where}.cycle_id`);
    const created = record.created_at === null || record.created_at === undefined ? undefined : at(record.created_at, `${where}.created_at`);
    const updated = record.updated_at === null || record.updated_at === undefined ? undefined : at(record.updated_at, `${where}.updated_at`);
    time = updated === undefined ? (created ?? at(record.created_at, `${where}.created_at`)) : created !== undefined && updated.start_ms < created.start_ms ? created : updated;
  } else {
    key = resource.kind === "physio-day" ? integerText(record.id, `${where}.id`) : uuid(record.id, `${where}.id`);
    const offset = record.timezone_offset;
    if (typeof offset !== "string" || !OFFSET.test(offset) || offset === "-00:00") refuse(`${where}.timezone_offset must be a numeric offset`);
    const start = at(record.start, `${where}.start`, offset);
    if (record.end === null && resource.kind === "physio-day") time = start;
    else time = span(start, at(record.end, `${where}.end`, offset));
  }
  return { kind: resource.kind, key, content: { type: resource.type, content: record }, time, locator };
}


interface PrivateDay {
  date: string;
  graph: string;
  stress: string;
}

function privateRows(byPath: Map<string, DeliveryFile>, read: JsonReader, account: string): ReaderOutput[] {
  const manifestFile = byPath.get("private/manifest.json");
  if (manifestFile === undefined) {
    if ([...byPath.keys()].some((path) => path.startsWith("private/"))) refuse("the private half holds no manifest.json");
    return [];
  }
  const where = "private/manifest.json";
  const manifest = read(manifestFile, where);
  everyUserId(manifest, account, where);
  if (manifest.format !== PRIVATE_FORMAT) refuse(`${where} states format ${JSON.stringify(manifest.format)}, not ${PRIVATE_FORMAT}`);
  if (manifest.complete !== true) refuse(`${where}: the capture is not complete`);
  timestamp(manifest.started_at, `${where}.started_at`);
  const range = object(manifest.date_range, `${where}.date_range`);
  const start = date(range.start, `${where}.date_range.start`);
  const end = date(range.end, `${where}.date_range.end`);
  if (end < start) refuse(`${where}.date_range ends before it starts`);
  const zone = text(range.timezone, `${where}.date_range.timezone`);
  zoneOffset(zone, 0);
  if (!Array.isArray(manifest.days) || manifest.days.length === 0) refuse(`${where}.days must be a non-empty array`);
  const days: PrivateDay[] = [];
  let expected = start;
  const seen = new Set<string>();
  for (const [index, raw] of manifest.days.entries()) {
    const at = `${where}.days[${index}]`;
    const day = object(raw, at);
    const stated = date(day.date, `${at}.date`);
    if (stated !== expected) refuse(`${at} states ${stated}; the range needs ${expected} here`);
    const member = (name: "stress" | "daily_graph"): string => {
      const entry = object(day[name], `${at}.${name}`);
      const file = text(entry.file, `${at}.${name}.file`);
      if (file.includes("/") || !file.endsWith(`-${stated}.json`)) refuse(`${at}.${name}.file must be a file named for ${stated}`);
      if (seen.has(file)) refuse(`${where} lists ${file} twice`);
      seen.add(file);
      const sha256 = text(entry.sha256, `${at}.${name}.sha256`);
      if (!SHA256.test(sha256)) refuse(`${at}.${name}.sha256 must be 64 lower-case hex digits`);
      requestUrl(name, stated, text(entry.request_url, `${at}.${name}.request_url`), `${at}.${name}.request_url`);
      if (Object.hasOwn(entry, "plot_points") === Object.hasOwn(entry, "series_points")) refuse(`${at}.${name} must state exactly one of plot_points or series_points`);
      count(entry.plot_points ?? entry.series_points, `${at}.${name} point count`);
      const file_ = byPath.get(`private/${file}`) ?? refuse(`${where} lists ${file}, which the capture does not hold`);
      matches(file_, { bytes: count(entry.bytes, `${at}.${name}.bytes`), sha256 }, `private/${file}`);
      return file;
    };
    days.push({ date: stated, stress: member("stress"), graph: member("daily_graph") });
    expected = nextDay(expected);
  }
  if (days.at(-1)!.date !== end) refuse(`${where}.days do not cover ${start} through ${end}`);

  const chosen = new Map<string, { point: Point; text: string }>();
  for (const day of days) {
    const graph = read(byPath.get(`private/${day.graph}`)!, `private/${day.graph}`);
    const stress = read(byPath.get(`private/${day.stress}`)!, `private/${day.stress}`);
    everyUserId(graph, account, `private/${day.graph}`);
    everyUserId(stress, account, `private/${day.stress}`);
    stressUser(stress, `private/${day.stress}`, account);
    const hasRate = statesHeartRate(graph, day.graph);
    const hasStress = statesStress(stress, day.stress);
    if (!hasRate && !hasStress) continue;
    if (!hasRate || !hasStress) {
      refuse(`${day.date}: one graph states readings and the other states none; a half-empty day is not read`);
    }
    const points = [
      ...(placesHeartRate(graph, day.graph) ? heartRatePoints(graph, day.graph) : []),
      ...stressPoints(stress, day.stress, zone),
    ];
    for (const point of points) {
      const key = `${point.family}:${basic(point.ms)}`;
      const text = JSON.stringify(point.content);
      const before = chosen.get(key);
      if (before === undefined || before.text !== text) chosen.set(key, { point, text });
    }
  }
  return [...chosen.entries()]
    .sort(([, a], [, b]) => (a.point.family === b.point.family ? a.point.ms - b.point.ms : a.point.family < b.point.family ? -1 : 1))
    .map(([key, { point }]) => ({
      kind: "sample",
      key,
      content: { type: point.family === "hr" ? "whoop.hr" : "whoop.stress", content: point.content },
      time: { start_ms: point.ms, offset_min: point.offset_min, precision: "s" },
      locator: point.locator,
    }));
}

function requestUrl(name: "stress" | "daily_graph", day: string, raw: string, where: string): void {
  const url = apiUrl(raw, where);
  const path = name === "stress" ? `/health-service/v2/stress-bff/${day}` : "/home-service/v1/tilt-view";
  if (url.pathname !== path) refuse(`${where} names another resource`);
  if (name === "daily_graph" && url.searchParams.get("date") !== day) refuse(`${where} asks for another day`);
}


function official(type: string): Guard {
  return (content) => {
    if (!isObject(content)) return ["content is not an object"];
    const violations = exact(content, ["content", "type"]);
    if (content.type !== type) violations.push(`type is not ${type}`);
    if (!isObject(content.content)) violations.push("content.content is not an object");
    return violations;
  };
}

function sleepStages(content: Json): string[] {
  if (!isObject(content)) return ["content is not an object"];
  const violations = exact(content, ["content", "type"]);
  if (content.type !== "whoop.sleep-events") violations.push("type is not whoop.sleep-events");
  if (!Array.isArray(content.content)) violations.push("content.content is not an array");
  return violations;
}

function sample(content: Json): string[] {
  if (!isObject(content)) return ["content is not an object"];
  const violations = exact(content, ["content", "type"]);
  const reading = content.content;
  if (!isObject(reading)) return [...violations, "content.content is not an object"];
  if (content.type === "whoop.heart-rate") {
    violations.push(...exact(reading, ["bpm"]));
    if (typeof reading.bpm !== "number" && typeof reading.bpm !== "string") violations.push("bpm is not a number");
    return violations;
  }
  if (content.type === "whoop.hr") {
    violations.push(...exact(reading, ["bpm", "segment_styles"]));
    if (typeof reading.bpm !== "number" && typeof reading.bpm !== "string") violations.push("bpm is not a number");
  } else if (content.type === "whoop.stress") {
    violations.push(...exact(reading, ["display", "level", "segment_styles", "value"]));
    if (typeof reading.value !== "number" && typeof reading.value !== "string") violations.push("value is not a number");
    for (const name of ["display", "level"]) {
      if (typeof reading[name] !== "string" || reading[name] === "") violations.push(`${name} is not non-empty text`);
    }
  } else {
    violations.push("type is neither whoop.hr nor whoop.stress");
  }
  const styles = reading.segment_styles;
  if (!Array.isArray(styles) || !styles.every((style) => typeof style === "string" && style !== "")) violations.push("segment_styles is not a list of non-empty text");
  return violations;
}

function exact(value: JsonObject, members: string[]): string[] {
  const names = Object.keys(value).sort();
  return names.join(",") === members.join(",") ? [] : [`members are ${names.join(", ")}, not ${members.join(", ")}`];
}


function sourceUser(source: string): string {
  const user = sourceName(source).account;
  if (!/^[1-9]\d*$/u.test(user) || !Number.isSafeInteger(Number(user))) refuse(`${JSON.stringify(source)} is not a whoop:<user id>:<copy> source`);
  return user;
}

function uuid(value: Json | undefined, where: string): string {
  if (typeof value !== "string" || !UUID.test(value)) refuse(`${where} must be a provider UUID`);
  return value;
}

function nextDay(day: string): string {
  return addDays(day, 1);
}

function matches(file: DeliveryFile, stated: { bytes: number; sha256: string }, where: string): void {
  if (file.blob !== `sha256:${stated.sha256}`) refuse(`${where}: its SHA-256 is not the one its manifest states`);
  if (file.size !== stated.bytes) refuse(`${where}: its manifest states ${stated.bytes} bytes, the file holds ${file.size}`);
}

function pageNumber(layout: "manifest" | "hand", resource: Resource, name: string): number | null {
  const m = layout === "hand"
    ? new RegExp(`^${resource.name}/page-(\\d{5})\\.raw\\.json$`, "u").exec(name)
    : new RegExp(`^${resource.name}-(\\d{5})\\.json$`, "u").exec(name);
  return m === null ? null : Number(m[1]);
}
