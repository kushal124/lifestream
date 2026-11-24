import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { addDays, civilDay, dayBounds, type DaySettings, type ExtractRow } from "@lifestreamprotocol/core";
import {
  areaOf, CAMERA_UNIT, dayPieces, distanceMeters, labelsFrom, namesOf, nightAt, PLACES_UNIT, REACH_DAYS, stitchLaid, summarise, where,
  type Labels, type LabelRow, type Piece, type Point, type Where,
} from "@lifestreamprotocol/families";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Span { start_ms: number; end_ms: number }
interface Served { unit: string; code: string; content: { kind: string; how?: string; by?: string; rank?: number } & Record<string, unknown>; start_ms: number | null; end_ms: number | null; days: string[] }
interface Stay extends Span { unit: string; by: string; centre: Where }
interface Trip extends Span { unit: string; by: string }
interface Sighting extends Span { centre: Point }
interface Photo { source: string; at_ms: number; point: Point; camera: string | null; mine: boolean }

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SAME_PLACE_M = 150;
const VOUCH_MINUTES = [0, 15, 30, 60, 120];
const BRIDGE_DAYS = [1, 3, 7, 30];
const PAIR_BANDS: [string, number, number][] = [["under 1 h", 0, HOUR], ["1-3 h", HOUR, 3 * HOUR], ["3-8 h", 3 * HOUR, 8 * HOUR]];
const EVIDENCE = new Set(["observed", "seen", "stated"]);
const PHONE = "Phone";
const TIMELINE = "Timeline";
const PHOTO_SOURCES = ["google-photos", "apple-photos", "camera"];
const ALL_TIME = "from_ms=-9999999999999&to_ms=9999999999999";


async function door(route: string): Promise<Record<string, unknown>> {
  const machine = process.env.LIFESTREAM_MACHINE_DIR ?? join(homedir(), "Library/Application Support/Lifestream");
  const token = process.env.LIFESTREAM_DOOR_TOKEN ?? readFileSync(join(machine, "reader-token"), "utf8").trim();
  const response = await fetch(`${process.env.LIFESTREAM_DOOR ?? "http://127.0.0.1:4680"}${route}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

async function all<T>(route: string, member: string): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  do {
    const page = await door(`${route}${route.includes("?") ? "&" : "?"}limit=1024${after === undefined ? "" : `&after=${after}`}`);
    items.push(...(page[member] as T[] ?? []));
    after = typeof page.next === "string" ? page.next : undefined;
  } while (after !== undefined);
  return items;
}


interface Home {
  settings: DaySettings;
  rows: Served[];
  labels: Labels;
  cameras: Record<string, Json>[];
  counts: { source: string; kind: string; count: number }[];
}

async function readHome(): Promise<Home> {
  const days = await all<{ day: string }>("/v1/days", "days");
  const newest = days.at(-1)?.day ?? null;
  if (newest === null) throw new Error("the home has no day files yet");
  const head = await door(`/v1/days/${newest}?file=json`);
  const settings = { zone: String(head.zone), day_start_hour: Number(head.day_start_hour) };
  const rows = await all<Served>(`/v1/extracts?family=physical&${ALL_TIME}`, "extracts");
  if (!rows.some((row) => typeof row.content.rank === "number")) throw new Error("the home's physical extracts state no rank: it runs no `where` yet (deploy, then run this again)");
  const cameras = ((await door("/v1/devices")).cameras ?? []) as Record<string, Json>[];
  const named = new Set([...cameras.map((camera) => String(camera.camera)), ...rows.flatMap((row) => row.content.kind === "seen"
    ? (row.content.photos as { camera: string | null }[]).flatMap((photo) => photo.camera ?? []) : [])]);
  const units = new Map<string, LabelRow>();
  for (const unit of [PLACES_UNIT, ...[...named].map((camera) => `${CAMERA_UNIT}${camera}`)]) {
    const [row] = ((await door(`/v1/extracts?family=labels&unit=${encodeURIComponent(unit)}`)).extracts ?? []) as { content: Json }[];
    if (row !== undefined) units.set(unit, { content: row.content as LabelRow["content"] });
  }
  const counts: Home["counts"] = [];
  for (const [product, kinds] of [["location", ["fix"]], ["google-timeline", ["place-visit", "trip", "path"]], ...PHOTO_SOURCES.map((each) => [each, ["img"]] as const)] as const) {
    for (const source of await all<{ id: string }>(`/v1/sources?product=${product}`, "sources")) {
      const read = (await door(`/v1/counts?source=${encodeURIComponent(source.id)}&${kinds.map((kind) => `kind=${kind}`).join("&")}`)).counts as Record<string, number>;
      for (const kind of kinds) counts.push({ source: source.id, kind, count: read[kind] ?? 0 });
    }
  }
  return { settings, rows, labels: labelsFrom((unit) => units.get(unit), settings), cameras, counts };
}


const least = (values: readonly number[]): number => values.reduce((low, value) => Math.min(low, value), Infinity);
const most = (values: readonly number[]): number => values.reduce((high, value) => Math.max(high, value), -Infinity);

function measure(home: Home, now_ms: number): Record<string, Json> {
  const { settings, rows, labels } = home;
  const stays: Stay[] = [], trips: Trip[] = [], photos: Photo[] = [];
  for (const row of rows) {
    const content = row.content as Record<string, unknown> & { kind: string; by: string };
    if (content.kind === "stay") stays.push({ unit: row.unit, by: content.by, start_ms: content.start_ms as number, end_ms: content.end_ms as number, centre: content.centre as Where });
    if (content.kind === "trip") trips.push({ unit: row.unit, by: content.by, start_ms: content.start_ms as number, end_ms: content.end_ms as number });
    if (content.kind !== "seen") continue;
    for (const photo of content.photos as Omit<Photo, "source" | "mine">[]) {
      photos.push({ ...photo, source: String(content.source), mine: photo.camera !== null && labels.mine(photo.camera, photo.at_ms) });
    }
  }
  const byStart = <T extends Span>(list: T[]) => list.sort((left, right) => left.start_ms - right.start_ms);
  const phoneStays = byStart(stays.filter((stay) => stay.by === PHONE));
  const phone = byStart([...phoneStays.map((stay) => ({ ...stay, kind: "stay" as const })), ...trips.filter((trip) => trip.by === PHONE).map((trip) => ({ ...trip, kind: "trip" as const }))]);
  const visits = byStart(stays.filter((stay) => stay.by === TIMELINE));
  const own = photos.filter((photo) => photo.mine);
  const sightings: Sighting[] = byStart(sightingsOf(rows.filter((row) => row.content.kind === "seen"), labels, settings));
  const era = phone.length === 0 ? null : { start_ms: phone[0]!.start_ms, end_ms: most(phone.map((each) => each.end_ms)) };
  const inEra = (ms: number) => era !== null && era.start_ms <= ms && ms < era.end_ms;
  const phoneAt = (ms: number) => covering(phone, ms);

  const witnesses = {
    records: home.counts as unknown as Json,
    phone: { stays: phoneStays.length, hours: round(sum(phoneStays.map((stay) => stay.end_ms - stay.start_ms)) / HOUR), trips: phone.length - phoneStays.length,
      from: era === null ? null : civilDay(era.start_ms, settings), to: era === null ? null : civilDay(era.end_ms - 1, settings) },
    photos: groups(photos, (photo) => photo.source).map(([source, list]) => ({
      source, located_photos: list.length,
      days: new Set(list.map((each) => civilDay(each.at_ms, settings))).size,
      years: `${new Date(least(list.map((each) => each.at_ms))).getUTCFullYear()}-${new Date(most(list.map((each) => each.at_ms))).getUTCFullYear()}`,
    })),
    timeline: { visits: visits.length, activities: trips.filter((trip) => trip.by === TIMELINE).length, visit_hours: round(sum(visits.map((visit) => visit.end_ms - visit.start_ms)) / HOUR) },
  };

  const located = new Map(groups(photos, (photo) => photo.camera ?? "(none)").map(([camera, list]) => [camera, list.length]));
  const cameras = home.cameras.map((camera) => ({
    camera: camera.camera, photos: camera.photos, located: located.get(String(camera.camera)) ?? 0,
    years: typeof camera.first_ms === "number" && typeof camera.last_ms === "number" ? `${new Date(camera.first_ms).getUTCFullYear()}-${new Date(camera.last_ms).getUTCFullYear()}` : null,
    mine: camera.mine, why: camera.why, word: camera.word,
  })).sort((left, right) => Number(right.photos) - Number(left.photos));

  const during = own.flatMap((photo) => {
    const stay = phoneStays.find((each) => each.start_ms <= photo.at_ms && photo.at_ms < each.end_ms);
    return stay === undefined ? [] : [{ photo, stay, distance: distanceMeters(photo.point, stay.centre) }];
  });
  const placed = during.filter(({ stay }) => labels.place(stay.centre.latitude, stay.centre.longitude) !== undefined);
  const photosVsPhone = {
    photos: during.length, median_m: round(quantile(during.map((each) => each.distance), 0.5)), p90_m: round(quantile(during.map((each) => each.distance), 0.9)),
    max_m: round(most([0, ...during.map((each) => each.distance)])),
    same_place: placed.filter(({ stay, photo }) => labels.place(photo.point.latitude, photo.point.longitude)?.slug === labels.place(stay.centre.latitude, stay.centre.longitude)?.slug).length,
    in_a_place: placed.length,
  };
  const within = (sighting: Sighting, ms: number): boolean | null => {
    const at = phoneAt(ms);
    return at === null ? null : at.kind === "stay" && distanceMeters(at.centre, sighting.centre) <= SAME_PLACE_M;
  };
  const vouch = VOUCH_MINUTES.map((minutes) => {
    const share = (instantOf: (sighting: Sighting) => number) => {
      const said = sightings.filter((sighting) => inEra(instantOf(sighting))).map((sighting) => within(sighting, instantOf(sighting))).filter((each) => each !== null);
      return { share: said.length === 0 ? null : round(said.filter(Boolean).length / said.length, 3), of: said.length };
    };
    return { minutes, after: share((sighting) => sighting.end_ms + minutes * MINUTE), before: share((sighting) => sighting.start_ms - minutes * MINUTE) };
  });
  const pairs = PAIR_BANDS.map(([band, low, high]) => {
    const covers = sightings.slice(1).flatMap((next, index) => {
      const last = sightings[index]!;
      const gap = { start_ms: last.end_ms, end_ms: next.start_ms };
      const length = gap.end_ms - gap.start_ms;
      if (length <= low || length > high || !inEra(gap.start_ms) || !inEra(gap.end_ms) || distanceMeters(last.centre, next.centre) > SAME_PLACE_M) return [];
      const sat = sum(phoneStays.filter((stay) => distanceMeters(stay.centre, last.centre) <= SAME_PLACE_M)
        .map((stay) => Math.max(0, Math.min(stay.end_ms, gap.end_ms) - Math.max(stay.start_ms, gap.start_ms))));
      return [sat / length];
    });
    return { band, pairs: covers.length, whole: covers.filter((cover) => cover >= 0.999).length, mean_share: covers.length === 0 ? null : round(sum(covers) / covers.length, 3) };
  });

  const truthRows = rows.filter((row) => row.content.by === PHONE || row.content.by === TIMELINE);
  const photoRows = rows.filter((row) => row.content.kind === "seen");
  const truthDays = daysOf(truthRows.filter((row) => row.content.kind === "stay" || row.content.kind === "trip"));
  let nights: Json = null, days: Json = null, places: Json = null;
  if (truthDays !== null) {
    const span = { start_ms: dayBounds(truthDays[0], settings).start_ms, end_ms: dayBounds(truthDays[1], settings).end_ms };
    const truth = where(rowsOf(truthRows), span, labels, REACH_DAYS, settings);
    const photos = where(rowsOf(photoRows), span, labels, REACH_DAYS, settings);
    const names = namesOf(photos, labels);
    const named = new Map(photos.map((piece, index) => [piece, names[index]!] as const));
    const knownNights = summarise(truth.filter((piece) => EVIDENCE.has(String(piece.how)) || piece.how === "bridged" && piece.level === "place"), span, "day", settings, labels);
    const rowsByBridge = new Map(BRIDGE_DAYS.map((bridge) => [bridge, { right: 0, wrong: 0, unknown: 0 }]));
    const guessed = { right: 0, wrong: 0, unknown: 0 };
    const countries = { right: 0, wrong: 0, unknown: 0 };
    for (const summary of knownNights) {
      const night = nightAt(summary.period, settings);
      const known = pieceAt(truth, night);
      if (known === null) continue;
      const [truthNames] = namesOf([known], labels);
      const truthArea = (truthNames!.point ?? truthNames!.from)?.area;
      if (truthArea === undefined) continue;
      const piece = pieceAt(photos, night);
      if (summary.cities.some((city) => city.nights > 0) && truthArea.city_id !== null) {
        for (const bridge of BRIDGE_DAYS) tally(rowsByBridge.get(bridge)!, bridgedCity(photos, piece, bridge), truthArea.city_id);
        tally(guessed, piece === null ? null : named.get(piece)!.point?.area.city_id ?? piece.guess?.city_id ?? null, truthArea.city_id);
      }
      if (summary.countries.some((country) => country.nights > 0) && truthArea.country !== null) tally(countries, piece === null ? null : named.get(piece)!.point?.area.country ?? piece.guess?.country ?? null, truthArea.country);
    }
    nights = {
      from: truthDays[0], to: truthDays[1],
      by_bridge: BRIDGE_DAYS.map((bridge) => ({ days: bridge, ...rowsByBridge.get(bridge)! })),
      with_the_guess: guessed, countries,
    };
    const byDay = groups(own.filter((photo) => photo.at_ms >= span.start_ms && photo.at_ms < span.end_ms), (photo) => civilDay(photo.at_ms, settings));
    const matched = { right: 0, wrong: 0, unknown: 0 };
    for (const [day, seen] of byDay) {
      const photoCity = mainOf(seen.map((photo) => [areaOf(photo.point).city_id, 1]));
      const bounds = dayBounds(day, settings);
      const truthCity = mainOf(truth.filter((piece) => EVIDENCE.has(String(piece.how)) && piece.point !== null && piece.end_ms > bounds.start_ms && piece.start_ms < bounds.end_ms)
        .map((piece) => [areaOf(piece.point!).city_id, Math.min(piece.end_ms, bounds.end_ms) - Math.max(piece.start_ms, bounds.start_ms)]));
      if (truthCity !== null) tally(matched, photoCity, truthCity);
    }
    days = matched;
    const long = phoneStays.filter((stay) => stay.end_ms - stay.start_ms >= 30 * MINUTE);
    places = { stays: long.length, with_a_photo: long.filter((stay) => own.some((photo) => photo.at_ms >= stay.start_ms && photo.at_ms < stay.end_ms)).length };
  }

  const inVisits = own.flatMap((photo) => {
    const visit = visits.find((each) => each.start_ms <= photo.at_ms && photo.at_ms < each.end_ms);
    return visit === undefined ? [] : [{ photo, visit, distance: distanceMeters(photo.point, visit.centre) }];
  });
  const visitHours = sum(visits.map((visit) => visit.end_ms - visit.start_ms)) / HOUR;
  const longVisits = visits.filter((visit) => visit.end_ms - visit.start_ms > DAY);
  let doubts: Json = null;
  const visitDays = daysOf(rows.filter((row) => row.content.kind === "stay" && row.content.by === TIMELINE));
  if (visitDays !== null) {
    const span = { start_ms: dayBounds(visitDays[0], settings).start_ms, end_ms: dayBounds(visitDays[1], settings).end_ms };
    const pieces = where(rowsOf(rows), span, labels, REACH_DAYS, settings);
    const held = new Set(inVisits.map((each) => each.visit.unit));
    const levels = new Map<string, Set<string>>();
    for (const piece of pieces) if (piece.doubted !== undefined) levels.set(piece.units[0]!, (levels.get(piece.units[0]!) ?? new Set()).add(String(piece.level)));
    const laid = new Set(pieces.flatMap((piece) => piece.units));
    const classes = { agree: 0, same_city: 0, elsewhere: 0 };
    let doubtedHours = 0;
    for (const visit of visits.filter((each) => held.has(each.unit))) {
      const said = levels.get(visit.unit);
      const out = !laid.has(visit.unit);
      if (said === undefined && !out) classes.agree++;
      else if (!out && [...said ?? []].every((level) => level === "city")) classes.same_city++;
      else classes.elsewhere++;
      if (said !== undefined || out) doubtedHours += (visit.end_ms - visit.start_ms) / HOUR;
    }
    doubts = { visits_with_a_photo: held.size, ...classes, doubted_hours: round(doubtedHours) };
  }
  const timeline = {
    photos_in_visits: inVisits.length, farther_than_150_m: inVisits.filter((each) => each.distance > SAME_PLACE_M).length,
    visits_over_24_h: longVisits.length, their_hours: round(sum(longVisits.map((visit) => visit.end_ms - visit.start_ms)) / HOUR), visit_hours: round(visitHours),
    doubts,
  };

  const allDays = daysOf(rows.filter((row) => ["stay", "trip", "seen"].includes(row.content.kind)));
  const coverage: Json[] = [];
  const timing: { year: string; units: number; where_ms: number; summarise_ms: number }[] = [];
  let moment: Json = null;
  if (allDays !== null) {
    for (let year = Number(allDays[0].slice(0, 4)); year <= Number(allDays[1].slice(0, 4)); year++) {
      const span = { start_ms: dayBounds(`${year}-01-01`, settings).start_ms, end_ms: Math.min(dayBounds(`${year}-12-31`, settings).end_ms, now_ms) };
      const reached = rows.filter((row) => row.days.some((day) => day >= addDays(`${year}-01-01`, -REACH_DAYS) && day <= addDays(`${year}-12-31`, REACH_DAYS)));
      const started = performance.now();
      const pieces = where(rowsOf(reached), span, labels, REACH_DAYS, settings);
      const laid = performance.now();
      const [summary] = summarise(pieces, span, "year", settings, labels);
      timing.push({ year: String(year), units: reached.length, where_ms: Math.round(laid - started), summarise_ms: Math.round(performance.now() - laid) });
      const { days_unknown, nights_unknown, ...shares } = summary!.coverage;
      coverage.push({ year: String(year), ...shares, days_unknown: days_unknown.length, nights_unknown: nights_unknown.length, base: summary!.base?.city ?? null });
    }
    const busiest = [...timing].sort((left, right) => right.units - left.units)[0]!;
    const at = dayBounds(`${busiest.year}-07-01`, settings).start_ms + 12 * HOUR;
    const started = performance.now();
    where(rowsOf(rows), { start_ms: at, end_ms: at + 1 }, labels, REACH_DAYS, settings);
    moment = { at_ms: at, ms: Math.round(performance.now() - started) };
  }

  return {
    witnesses: witnesses as unknown as Json, cameras: cameras as unknown as Json, photos_vs_phone: photosVsPhone, vouch: vouch as unknown as Json, pairs: pairs as unknown as Json,
    nights, days, places, timeline, coverage, timing: { years: timing as unknown as Json, moment },
  };
}


function rowsOf(list: Served[]): ExtractRow[] {
  return list as unknown as ExtractRow[];
}

function sightingsOf(seen: Served[], labels: Labels, settings: DaySettings): Sighting[] {
  const byDay = new Map<string, Served[]>();
  for (const row of seen) for (const day of row.days) byDay.set(day, [...byDay.get(day) ?? [], row]);
  const days = [...byDay].sort(([left], [right]) => (left < right ? -1 : 1));
  return stitchLaid(days.map(([day, list]) => dayPieces(rowsOf(list), day, labels, settings).laid)).map(({ start_ms, end_ms, centre }) => ({ start_ms, end_ms, centre }));
}

function daysOf(list: Served[]): [string, string] | null {
  const days = list.flatMap((row) => row.days).sort();
  return days.length === 0 ? null : [days[0]!, days.at(-1)!];
}

function covering<T extends Span>(list: readonly T[], ms: number): T | null {
  let [low, high] = [0, list.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    if (list[middle]!.start_ms <= ms) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0 && index >= low - 4; index--) if (list[index]!.end_ms > ms) return list[index]!;
  return null;
}

function pieceAt(pieces: readonly Piece[], ms: number): Piece | null {
  return covering(pieces, ms);
}

function bridgedCity(pieces: readonly Piece[], piece: Piece | null, bridge: number): string | null {
  if (piece === null) return null;
  if (piece.kind !== "gap") return piece.point === null ? null : areaOf(piece.point).city_id;
  const index = pieces.indexOf(piece);
  let before: Piece | undefined, after: Piece | undefined;
  for (let each = index - 1; each >= 0 && before === undefined; each--) if (pieces[each]!.kind !== "gap") before = pieces[each];
  for (let each = index + 1; each < pieces.length && after === undefined; each++) if (pieces[each]!.kind !== "gap") after = pieces[each];
  if (before === undefined || after === undefined || after.start_ms - before.end_ms > bridge * DAY) return null;
  const [left, right] = [before.point ?? before.to, after.point ?? after.from];
  if (left === null || right === null) return null;
  const city = areaOf(left).city_id;
  return city !== null && city === areaOf(right).city_id ? city : null;
}

function tally(counts: { right: number; wrong: number; unknown: number }, said: string | null, truth: string): void {
  if (said === null) counts.unknown++;
  else if (said === truth) counts.right++;
  else counts.wrong++;
}

function mainOf(weighted: [string | null, number][]): string | null {
  const totals = new Map<string, number>();
  for (const [name, weight] of weighted) if (name !== null) totals.set(name, (totals.get(name) ?? 0) + weight);
  return [...totals].sort(([leftName, left], [rightName, right]) => right - left || (leftName < rightName ? -1 : 1))[0]?.[0] ?? null;
}

function groups<T>(list: readonly T[], key: (item: T) => string): [string, T[]][] {
  const out = new Map<string, T[]>();
  for (const item of list) out.set(key(item), [...out.get(key(item)) ?? [], item]);
  return [...out].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}


function render(report: Record<string, Json>): string {
  const out: string[] = [];
  const line = (value: Json): string => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).map(([key, inner]) => `${key} ${inner !== null && typeof inner === "object" ? JSON.stringify(inner) : String(inner)}`).join("  ")
    : JSON.stringify(value);
  for (const [section, value] of Object.entries(report)) {
    out.push(section);
    if (Array.isArray(value)) for (const row of value) out.push(`  ${line(row)}`);
    else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (Array.isArray(inner)) {
          out.push(`  ${key}`);
          for (const row of inner) out.push(`    ${line(row)}`);
        } else out.push(`  ${key}: ${line(inner)}`);
      }
    } else out.push(`  ${String(value)}`);
    out.push("");
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const index = args.indexOf("--out");
  const out = index >= 0 ? args[index + 1] : undefined;
  if (out === undefined || args.length !== 2) throw new Error("usage: npx tsx tools/where-backtest.ts --out <file.json>, a path outside the checkout");
  const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const target = resolve(out);
  let parent = dirname(target);
  try {
    parent = realpathSync(parent);
  } catch {
    throw new Error(`${dirname(target)} does not exist`);
  }
  if (parent === checkout || parent.startsWith(`${checkout}${sep}`)) throw new Error(`the artifact holds the person's places: write it outside ${checkout}`);
  const started = Date.now();
  const home = await readHome();
  const report = { home: { ...home.settings, units: home.rows.length, measured_ms: started }, ...measure(home, started) } as Record<string, Json>;
  writeFileSync(target, `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${render(report)}artifact: ${target}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
