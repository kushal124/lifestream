import { statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { addDays, canonical, civilDay, dayBounds, digest, openMemo, sourceName, type DaySettings, type HomeFolder, type Json, type JsonObject, type Memo, type OpenView, type SourceRow, type SourceSelector } from "@lifestreamprotocol/core";
import { googlePlaces } from "@lifestreamprotocol/connect";
import {
  areaOf, askOrder, asksHome, BURST_UNIT, CAMERA_UNIT, cameraSources, circlesOf, dayPieces, finishPieces, GEOGRAPHY_VERSION, hiddenAt, hiddenRows, labelsFrom, nightsIn, partOf, photographsOf, PHOTOS_FAMILY,
  homeAsk, PHYSICAL, placedById, placedDays, placeOf, placeSources, placesContent, PLACES_UNIT, placesInside, placeTable, presence, REACH_DAYS, reachOf, readCameras, rhythm, seenWords, spots, stitchDays, stitchLaid, summarise, visitsByPlace,
  unitFocus, visitsOf, WHERE_VERSION, witnessSourcesOf, type DayLay, type Family, type HiddenSpot, type LabelRow, type LaidStay, type Piece, type Place, type PlaceTable, type PresenceArea,
  type HomeAsk, type PresencePiece, type Stayed, type StayPoint, type Summary, type TakenPhoto, type Visits,
} from "@lifestreamprotocol/families";
import { jobPaused, type Kind } from "./jobs.js";
import { damaged, discardPrepared, JOB_WAIT_MS, PEOPLE, PLACES, preparedDirOf, preparedFileOf, readPrepared, writePrepared, type PreparedRead } from "./prepared.js";
import { PRESENCE_META, type PresenceTables as PresenceRead } from "./presence.js";


const PLACES_MEMO = "4";
const PLACES_ROWS = "1";
const PRESENCE_ACCOUNTS = "1";
const ANNOUNCED = "places:announced";
export const PLACES_FAMILIES: readonly string[] = [PHYSICAL, PHOTOS_FAMILY];
const PLACES_EVENT = googlePlaces.PLACES_EVENT;
const CIRCLES = "circles";
const POINTS = "points";
const PLACE_PHOTOS = 4;
const SPOT_PHOTOS = 6;
const SPOT_SPANS = 5;
const TRIP_DAY_PLACES = 3;
const SEEN_UNIT = "seen/";
const STAY_UNIT = "stay/";

interface UnitValue {
  days: string[];
}

interface PlacesData {
  day: DaySettings;
  unit: string | null;
  due_ms: number;
}

type Phase = "inputs" | "memo" | "lay" | "years" | "stitch" | "write";

interface PlacesResult {
  changed: string;
  counts: {
    gate: "unchanged" | "changed";
    units_read: number;
    days_laid: number;
    bursts_read: number;
    years_made: number;
    memo_parsed: number;
    visits: number;
    people_looked_up: number;
    rows: number;
    written: number;
    removed: number;
    bytes_written: number;
    file_bytes: number;
    memo_bytes: number;
    wal_bytes: number;
    wait_ms: number;
    inputs_ms: number;
    memo_ms: number;
    lay_ms: number;
    years_ms: number;
    stitch_ms: number;
    write_ms: number;
  };
}

export const placesKind: Kind<PlacesData, never, PlacesResult, null> = {
  dies: true,
  begin(main, _tx, job) {
    return { data: { day: main.settings.day, unit: main.settings.unit, due_ms: job.not_before_ms }, state: null };
  },
  async *helper(env, task) {
    const { day, unit, due_ms } = task.data;
    const phases = new Phases(Math.max(0, task.now_ms - due_ms));
    const families = env.registry.families;
    const dirs = { places: preparedDirOf(env.folder.root, env.machine, "places"), people: preparedDirOf(env.folder.root, env.machine, "people") };
    const memo = openMemo(env.folder, join(dirs.places, "memo.db"), digest({ memo: PLACES_MEMO, lay: WHERE_VERSION, geography: GEOGRAPHY_VERSION, zone: day.zone, day_start_hour: day.day_start_hour }));
    try {
      const view = env.db.view();
      try {
        return prepare(env.folder, view, memo, dirs, day, unit, task.now_ms, restsOnIn(families, view.sources()), phases);
      } finally {
        view.close();
      }
    } finally {
      memo.close();
    }
  },
  done(main, tx, running, result) {
    const now = main.now();
    const run = tx.tables.runs.start({ kind: "places", subject: "places", started_ms: running.job.started_ms ?? now });
    tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts: result.counts });
    if (result.counts.gate === "unchanged" && tx.tables.meta.get(ANNOUNCED) === result.changed) return;
    tx.tables.events.append({ at_ms: now, kind: PLACES_EVENT, key: "places", detail: { position: result.changed } });
    tx.tables.meta.set(ANNOUNCED, result.changed);
  },
};

export function placesFileOf(root: string, machine: string): string {
  return preparedFileOf(preparedDirOf(root, machine, "places"), "places");
}

export function placesReads(unit: string | null): { sources: SourceSelector; kinds: readonly string[] }[] {
  const places = placeSources(unit), cameras = cameraSources(unit);
  return [
    { sources: places.owner, kinds: ["place", "hidden"] }, { sources: places.google, kinds: ["place"] }, { sources: cameras.counts, kinds: ["camera"] }, { sources: cameras.words, kinds: ["camera"] },
  ];
}

export function readOwed(folder: HomeFolder, file: string): googlePlaces.Owed {
  try {
    return readPrepared(folder, file, PLACES.format, (read) => read.value<googlePlaces.Owed>("owed", "owed"))?.value ?? { spots: [], ids: [] };
  } catch (error) {
    if (damaged(error)) return { spots: [], ids: [] };
    throw error;
  }
}

export type RestsOn = (unit: string) => readonly string[];

export function restsOnIn(families: readonly Pick<Family, "name" | "adapters">[], sources: readonly SourceRow[]): RestsOn {
  const rule = witnessSourcesOf(families.find((family) => family.name === PHYSICAL)?.adapters ?? []);
  const rows = new Map(sources.map((row) => [row.id, row]));
  return (unit) => rule(unit, rows);
}

function prepare(folder: HomeFolder, view: OpenView, memo: Memo, dirs: { places: string; people: string }, day: DaySettings, unit: string | null, now: number, restsOn: RestsOn, phases: Phases): PlacesResult {
  const position = view.position();
  const file = preparedFileOf(dirs.places, "places");
  const counts: Omit<PlacesResult["counts"], `${Phase}_ms` | "wait_ms"> = {
    gate: "unchanged", units_read: 0, days_laid: 0, bursts_read: 0, years_made: 0, memo_parsed: 0, visits: 0, people_looked_up: 0, rows: 0, written: 0, removed: 0,
    bytes_written: 0, file_bytes: 0, memo_bytes: 0, wal_bytes: 0,
  };
  const today = civilDay(now, day);

  const units = [...view.extractReadings(PHYSICAL)];
  const bursts = [...view.extractReadings(PHOTOS_FAMILY, BURST_UNIT)];
  const table = placeTable(view, unit);
  const cameras = readCameras(view, unit).map(({ camera, label }) => [camera, label] as const);
  const placesKey = digest(placesContent(table) ?? null);
  const camerasKey = digest(cameras.map(([camera, label]) => [camera, label as unknown as Json]));
  const peopleFile = preparedFileOf(dirs.people, "people");
  const peopleMarks = peopleRead(() => readPrepared(folder, peopleFile, PEOPLE.format, (read) => [read.meta("changed:image") ?? "", read.meta("changed:named") ?? ""], JOB_WAIT_MS)?.value ?? null, null);
  let kept: { inputs: string | undefined; changed: string } | undefined;
  try {
    kept = readPrepared(folder, file, PLACES.format, (read) => ({ inputs: read.meta("inputs"), changed: read.meta("changed")! }))?.value;
  } catch (error) {
    if (!damaged(error)) throw error;
    discardPrepared(file);
  }
  const gate = digest({
    format: PLACES.format, rows: PLACES_ROWS, memo: [PLACES_MEMO, WHERE_VERSION, GEOGRAPHY_VERSION, day.zone, day.day_start_hour], accounts: PRESENCE_ACCOUNTS,
    units: digest(units.map(({ unit, reading, code }) => [unit, reading, code])), bursts: digest(bursts.map(({ unit, reading, code }) => [unit, reading, code])),
    places: placesKey, cameras: camerasKey, people: peopleMarks, day: today,
  });
  if (kept?.inputs === gate) return { changed: kept.changed, counts: { ...counts, ...sizes(dirs.places), ...phases.end() } };
  counts.gate = "changed";

  const labelRows = new Map<string, LabelRow>(cameras.map(([camera, label]) => [`${CAMERA_UNIT}${camera}`, { content: label as unknown as Json }]));
  const listed = placesContent(table);
  if (listed !== undefined) labelRows.set(PLACES_UNIT, { content: listed });
  const labels = labelsFrom((unit) => labelRows.get(unit), day);
  const layKey = digest(laidBy(table));
  const ownerAt = (point: { latitude: number; longitude: number; id?: string }): string | null => {
    const label = labels.place(point.latitude, point.longitude, point.id);
    return label === undefined || label.radius_m === 0 ? null : label.slug;
  };

  const unitKeys = new Map<string, string>();
  for (const { unit, reading, code } of units) unitKeys.set(`${unit}\0${reading}\0${code}`, unit);
  const unitValues = phases.in("memo", () => values<UnitValue>(memo, "units", [...unitKeys.keys()], (key) => phases.in("inputs", () => {
    const row = view.extract(PHYSICAL, unitKeys.get(key)!);
    if (row === undefined) return undefined;
    counts.units_read++;
    return { days: row.days };
  }), counts));

  const onDay = new Map<string, { unit: string; reading: string; code: string }[]>();
  const byUnit = new Map(units.map((row) => [row.unit, row]));
  for (const [key, value] of unitValues) {
    const row = byUnit.get(unitKeys.get(key)!)!;
    for (const each of value.days) {
      const list = onDay.get(each);
      if (list === undefined) onDay.set(each, [row]);
      else list.push(row);
    }
  }
  const dayKeys = new Map<string, string>();
  for (const [each, rows] of onDay) {
    const sorted = [...rows].sort((left, right) => compare(left.unit, right.unit));
    const seen = sorted.some((row) => row.unit.startsWith(SEEN_UNIT));
    dayKeys.set(each, `${each}\0${digest(sorted.map(({ unit, reading, code }) => [unit, reading, code]))}\0${layKey}${seen ? `\0${camerasKey}` : ""}`);
  }
  const lays = new Map<string, DayLay>();
  const layOf = (key: string): DayLay => {
    let found = lays.get(key);
    if (found === undefined) {
      const each = key.slice(0, key.indexOf("\0"));
      counts.days_laid++;
      lays.set(key, found = phases.in("lay", () => dayPieces(view.extractsOn(PHYSICAL, each), each, labels, day)));
    }
    return found;
  };
  const laidValues = phases.in("memo", () => values<Piece[]>(memo, "laid", [...dayKeys.values()], (key) => layOf(key).pieces, counts));
  const stayValues = phases.in("memo", () => values<LaidStay[]>(memo, "stays", [...dayKeys.values()], (key) => layOf(key).laid, counts));
  phases.to("stitch");
  const days = [...dayKeys.keys()].sort(compare);
  const laid = new Map(days.map((each) => [each, laidValues.get(dayKeys.get(each)!)!]));

  const line = stitchDays(days.map((each) => laid.get(each)!));
  const visits = visitsByPlace(line, labels);
  const presenceTables = presenceOf(line, days, labels, new Map(units.map((row) => [row.unit, row.reading])), day, now, restsOn);
  const ordered = [...visits].flatMap(([slug, list]) => list.map((visit) => ({ slug, visit }))).sort((left, right) => left.visit.start_ms - right.visit.start_ms);
  counts.visits = ordered.length;

  const burstKeys = new Map(bursts.map(({ unit, reading, code }) => [`${unit}\0${reading}\0${code}`, unit]));
  const burstValues = phases.in("memo", () => values<TakenPhoto[]>(memo, "bursts", [...burstKeys.keys()], (key) => phases.in("inputs", () => {
    const row = view.extract(PHOTOS_FAMILY, burstKeys.get(key)!);
    if (row === undefined) return undefined;
    counts.bursts_read++;
    return photographsOf(row);
  }), counts));
  const photos = new Map<string, Map<string, number>>();
  for (const photo of [...burstValues.values()].flat().sort((left, right) => left.at_ms - right.at_ms || compare(left.image, right.image))) {
    const at = within(ordered, photo.at_ms);
    if (at === undefined) continue;
    const held = photos.get(at.slug) ?? new Map<string, number>();
    photos.set(at.slug, held);
    if (!held.has(photo.image)) held.set(photo.image, photo.at_ms);
  }
  const photosOf = (slug: string): TakenPhoto[] => [...photos.get(slug) ?? []].map(([image, at_ms]) => ({ image, at_ms }))
    .sort((left, right) => right.at_ms - left.at_ms || compare(left.image, right.image));

  const images = [...new Set([...photos.values()].flatMap((held) => [...held.keys()]))];
  const named = peopleRead(() => readPrepared(folder, peopleFile, PEOPLE.format, (read) => {
    const people = new Map<string, NamedPerson>();
    const out = new Map<string, NamedPerson[]>();
    for (const image of images) {
      const ids = read.value<{ people: { id: string }[] }>("image", image)?.people.map((person) => person.id) ?? [];
      for (const id of ids) {
        if (people.has(id)) continue;
        counts.people_looked_up++;
        const person = read.value<NamedPerson>("named", id);
        if (person !== undefined) people.set(id, person);
      }
      const on = ids.flatMap((id) => {
        const person = people.get(id);
        return person === undefined || person.me ? [] : [person];
      });
      if (on.length > 0) out.set(image, on);
    }
    return out;
  }, JOB_WAIT_MS)?.value, undefined) ?? new Map<string, NamedPerson[]>();

  let open: Piece | null = null;
  for (const piece of line) if (piece.open === true && piece.point !== null && (open === null || piece.start_ms > open.start_ms)) open = piece;
  const here = open === null ? null : { latitude: open.point!.latitude, longitude: open.point!.longitude, start_ms: open.start_ms, end_ms: open.end_ms, slug: ownerAt(open.point!) };
  const stays: LaidStay[] = stitchLaid(days.map((each) => stayValues.get(dayKeys.get(each)!)!));
  const found = spots(stays, table, day, { now_ms: now });
  const { held, points } = heldAndLoose(stays, table);
  const toName = askOrder(found.spots, now);
  const spotPhotos = photosWithin(found.stays, [...burstValues.values()].flat());
  const todaySpan = dayBounds(today, day);
  const rows = new Map<string, Map<string, JsonObject>>(PLACES.tables.map((name) => [name, new Map()]));
  const json = (value: unknown) => value as JsonObject;

  rows.get("answer")!.set("list", json({
    day: today, day_until_ms: todaySpan.end_ms, here,
    places: byName(table.places).map((place) => {
      const at = visits.get(place.slug) ?? [];
      const clipped = at.flatMap((visit) => {
        const span = { start_ms: Math.max(visit.start_ms, todaySpan.start_ms), end_ms: Math.min(visit.end_ms, todaySpan.end_ms) };
        return span.end_ms > span.start_ms ? [span] : [];
      });
      return listEntry(place, { ...found.places.get(place.slug)!, ask_home: asksHome(place, at, now, day), today_hours: visitsOf(clipped, day).visits.hours });
    }),
    spots: [
      ...toName.map((spot) => {
        const taken = spotPhotos.get(spot.key) ?? [];
        return { ...spot, ...seenWords(found.stays.get(spot.key)!, taken.length, day), area: area(spot), photos: taken.slice(0, SPOT_PHOTOS), photos_count: taken.length };
      }),
      ...found.spots.filter((spot) => !spot.worth).map(({ key: _key, ...spot }) => spot),
    ],
    hidden: found.hidden,
  }));
  rows.get("answer")!.set(POINTS, json({ points: points.map(({ latitude, longitude, count }) => [latitude, longitude, count]) }));
  for (const spot of toName) {
    const held = found.stays.get(spot.key)!;
    rows.get("spans")!.set(spot.key, json({
      latitude: spot.latitude, longitude: spot.longitude, photos: held.every((stay) => stay.by === PHOTOS_WITNESS),
      spans: held.slice(-SPOT_SPANS).reverse().map(({ start_ms, end_ms, by }) => ({ start_ms, end_ms, by })),
    }));
  }
  const spotted: Spotted[] = toName.flatMap((spot) => (found.stays.get(spot.key)! as LaidStay[]).map(({ unit, start_ms, end_ms, centre }) => ({
    unit, start_ms, end_ms, latitude: centre.latitude, longitude: centre.longitude, key: spot.key,
  })));

  const placeRows = rows.get("place")!;
  const headRows = rows.get("head")!;
  const photoRows: [string, number, string][] = [];
  const photoLists = new Map<string, string>();
  for (const place of table.places) {
    const at = visits.get(place.slug) ?? [];
    const taken = photosOf(place.slug);
    for (const photo of taken) photoRows.push([place.slug, photo.at_ms, photo.image]);
    photoLists.set(place.slug, `"${digest(taken.map(({ image, at_ms }) => [image, at_ms])).slice("sha256:".length)}"`);
    const { days: onDays, hours, first_ms, last_ms } = visitsOf(at, day).visits;
    const nights = nightsIn(at, day);
    const people = new Map<string, { id: string; name: string; photo: NamedPerson["photo"]; days: Set<string> }>();
    let next = taken.length - 1;
    const answered = at.map((visit) => {
      const ids = new Set<string>();
      for (; next >= 0 && taken[next]!.at_ms < visit.end_ms; next--) {
        const photo = taken[next]!;
        if (photo.at_ms < visit.start_ms) continue;
        for (const person of named.get(photo.image) ?? []) {
          ids.add(person.id);
          const seen = people.get(person.id) ?? { id: person.id, name: person.name, photo: person.photo, days: new Set<string>() };
          seen.days.add(civilDay(photo.at_ms, day));
          people.set(person.id, seen);
        }
      }
      const centre = { latitude: visit.point!.latitude, longitude: visit.point!.longitude };
      const unit = visit.units[0]!;
      return {
        unit, start_ms: visit.start_ms, end_ms: visit.end_ms, day: civilDay(visit.start_ms, day), focus: unitFocus(unit, { from_ms: visit.start_ms, to_ms: visit.end_ms }), centre,
        people: [...ids].sort(compare),
      };
    }).reverse();
    headRows.set(place.slug, json({ name: place.name, latitude: place.latitude, longitude: place.longitude, radius_m: place.radius_m, area: area(place) }));
    placeRows.set(place.slug, json({ place: placeEntry(place, table, {
      days: onDays, hours, first_ms, last_ms, visits_count: at.length, nights: nights.length, here: here?.slug === place.slug, ask_home: asksHome(place, at, now, day),
      rhythm: rhythm(at, nights, place.home, day), visits: answered, photos: taken.slice(0, PLACE_PHOTOS), photos_count: taken.length,
      people: [...people.values()].map(({ id, name, photo, days: on }) => ({ id, name, days: on.size, ...(photo === null ? {} : { photo }) }))
        .sort((left, right) => right.days - left.days || compare(left.name, right.name) || compare(left.id, right.id)),
    }), counts: { stays: found.places.get(place.slug)!.stays, held: held.get(place.slug) ?? 0, home_ask: homeAsk(place, at, now, day) } satisfies PageCounts }));
  }

  const yearKeys = new Map<string, { year: string; span: { start_ms: number; end_ms: number }; days: string[]; window: { start_ms: number; end_ms: number } }>();
  for (let year = Number((days[0] ?? today).slice(0, 4)); year <= Number(today.slice(0, 4)); year++) {
    const first = `${year}-01-01`;
    const span = { start_ms: dayBounds(first, day).start_ms, end_ms: Math.min(dayBounds(`${year}-12-31`, day).end_ms, now) };
    if (span.end_ms <= span.start_ms) continue;
    const reached = reachOf(span, REACH_DAYS, day);
    const current = String(year) === today.slice(0, 4);
    const key = `${year}\0${digest(reached.days.flatMap((each) => dayKeys.get(each) ?? []))}\0${placesKey}\0${current ? span.end_ms : ""}`;
    yearKeys.set(key, { year: String(year), span, ...reached });
  }
  const yearValues = phases.in("memo", () => values<JsonObject>(memo, "years", [...yearKeys.keys()], (key) => phases.in("years", () => {
    const { span, days: reached, window } = yearKeys.get(key)!;
    counts.years_made++;
    const pieces = finishPieces(stitchDays(reached.map((each) => laid.get(each) ?? [])), window, span);
    const summaries: Summary[] = summarise(pieces, span, "year", day, labels);
    const trips = summaries.flatMap((summary) => summary.trips).map((trip) => {
      const within = { start_ms: dayBounds(trip.first, day).start_ms, end_ms: Math.min(dayBounds(trip.last, day).end_ms, span.end_ms) };
      const touching = pieces.filter((piece) => piece.end_ms > within.start_ms && piece.start_ms < within.end_ms);
      return { first: trip.first, days: summarise(touching, within, "day", day, labels).map((each) => ({ day: each.period, line: dayLine(each) })) };
    });
    return json({ where: json({ from_ms: span.start_ms, to_ms: span.end_ms, grain: "year", summaries }), trips: json({ trips }) });
  }), counts));
  for (const [key, value] of yearValues) {
    const { year } = yearKeys.get(key)!;
    rows.get("year")!.set(year, value.where as JsonObject);
    rows.get("trips")!.set(year, value.trips as JsonObject);
  }

  const nameless = new Set([...table.google.map((name) => name.id), ...table.places.flatMap((place) => place.ids)]);
  const ids = new Map<string, string>();
  for (const stay of stays) {
    const id = stay.centre.id;
    if (id === undefined || !id.startsWith("google:") || !stay.unit.startsWith(STAY_UNIT) || nameless.has(id) || ids.has(id)) continue;
    ids.set(id, sourceName(stay.unit.split("/")[1]!).account);
  }
  rows.get("owed")!.set("owed", json({
    spots: toName.map(({ latitude, longitude }) => ({ latitude, longitude })),
    ids: [...ids].sort(([left], [right]) => compare(left, right)).map(([id, account]) => ({ id, account })),
  }));

  counts.rows = [...rows.values()].reduce((sum, table) => sum + table.size, 0) + photoRows.length + spotted.length + presenceTables.pieces.length;
  const own = (db: Database.Database) => {
    const [photosMoved, spottedMoved, presenceMoved] = [writePhotos(db, photoRows, photoLists), writeSpotted(db, spotted), writePresence(db, presenceTables)];
    return { written: photosMoved.written + spottedMoved.written + presenceMoved.written, removed: photosMoved.removed + spottedMoved.removed + presenceMoved.removed };
  };
  phases.to("write");
  const { written, removed, bytes, changed } = writePrepared(folder, file, PLACES, { rows, position, own, meta: { inputs: gate, [CIRCLES]: circlesKey(table), [PRESENCE_META]: presenceTables.version } });
  return { changed, counts: { ...counts, written, removed, bytes_written: bytes, ...sizes(dirs.places), ...phases.end() } };
}

interface NamedPerson {
  id: string;
  name: string;
  photo: JsonObject | null;
  me: boolean;
}

function writePhotos(db: Database.Database, photos: readonly [string, number, string][], lists: ReadonlyMap<string, string>): { written: number; removed: number } {
  const key = (slug: string, at_ms: number, image: string) => `${slug}\0${at_ms}\0${image}`;
  const held = new Set((db.prepare("SELECT slug, at_ms, image FROM photo").raw().all() as [string, number, string][]).map(([slug, at_ms, image]) => key(slug, at_ms, image)));
  const made = new Set<string>();
  let written = 0, removed = 0;
  const put = db.prepare("INSERT INTO photo (slug, at_ms, image) VALUES (?, ?, ?)");
  for (const [slug, at_ms, image] of photos) {
    const name = key(slug, at_ms, image);
    made.add(name);
    if (held.has(name)) continue;
    put.run(slug, at_ms, image);
    written++;
  }
  const drop = db.prepare("DELETE FROM photo WHERE slug = ? AND at_ms = ? AND image = ?");
  for (const name of held) {
    if (made.has(name)) continue;
    const [slug, at_ms, image] = name.split("\0");
    drop.run(slug, Number(at_ms), image);
    removed++;
  }
  const listed = new Map(db.prepare("SELECT slug, etag FROM photo_list").raw().all() as [string, string][]);
  const putList = db.prepare("INSERT INTO photo_list (slug, etag) VALUES (?, ?) ON CONFLICT (slug) DO UPDATE SET etag = excluded.etag");
  for (const [slug, etag] of lists) {
    if (listed.get(slug) === etag) continue;
    putList.run(slug, etag);
    written++;
  }
  const dropList = db.prepare("DELETE FROM photo_list WHERE slug = ?");
  for (const slug of listed.keys()) {
    if (lists.has(slug)) continue;
    dropList.run(slug);
    removed++;
  }
  return { written, removed };
}

interface Spotted {
  unit: string;
  start_ms: number;
  end_ms: number;
  latitude: number;
  longitude: number;
  key: string;
}

function writeSpotted(db: Database.Database, made: readonly Spotted[]): { written: number; removed: number } {
  const identity = ({ unit, start_ms, end_ms, latitude, longitude }: Omit<Spotted, "key">) => `${unit}\0${start_ms}\0${end_ms}\0${latitude}\0${longitude}`;
  const held = new Map((db.prepare("SELECT unit, start_ms, end_ms, latitude, longitude, key FROM spotted").all() as Spotted[]).map((row) => [identity(row), row]));
  const wanted = new Map(made.map((row) => [identity(row), row]));
  let written = 0, removed = 0;
  const put = db.prepare("INSERT INTO spotted (unit, start_ms, end_ms, latitude, longitude, key) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET key = excluded.key");
  for (const [name, row] of wanted) {
    if (held.get(name)?.key === row.key) continue;
    put.run(row.unit, row.start_ms, row.end_ms, row.latitude, row.longitude, row.key);
    written++;
  }
  const drop = db.prepare("DELETE FROM spotted WHERE unit = ? AND start_ms = ? AND end_ms = ? AND latitude = ? AND longitude = ?");
  for (const [name, row] of held) {
    if (wanted.has(name)) continue;
    drop.run(row.unit, row.start_ms, row.end_ms, row.latitude, row.longitude);
    removed++;
  }
  return { written, removed };
}

class Phases {
  readonly #ms: Record<Phase, number> = { inputs: 0, memo: 0, lay: 0, years: 0, stitch: 0, write: 0 };
  #phase: Phase = "inputs";
  #at = performance.now();

  constructor(readonly wait_ms: number) {}

  to(phase: Phase): void {
    const now = performance.now();
    this.#ms[this.#phase] += now - this.#at;
    this.#at = now;
    this.#phase = phase;
  }

  in<T>(phase: Phase, work: () => T): T {
    const was = this.#phase;
    this.to(phase);
    try {
      return work();
    } finally {
      this.to(was);
    }
  }

  end(): { [P in Phase as `${P}_ms`]: number } & { wait_ms: number } {
    this.to(this.#phase);
    const ms = this.#ms;
    const round = (value: number) => Math.round(value);
    return {
      wait_ms: round(this.wait_ms), inputs_ms: round(ms.inputs), memo_ms: round(ms.memo), lay_ms: round(ms.lay), years_ms: round(ms.years), stitch_ms: round(ms.stitch), write_ms: round(ms.write),
    };
  }
}

function values<T>(memo: Memo, space: string, keys: readonly string[], make: (key: string) => T | undefined, counts: { memo_parsed: number }): Map<string, T> {
  let made = 0;
  const answer = memo.values<T>(space, keys, (key) => {
    const value = make(key);
    if (value !== undefined) made++;
    return value;
  });
  counts.memo_parsed += answer.size - made;
  return answer;
}

const PHOTOS_WITNESS = "Photos";

function photosWithin(held: ReadonlyMap<string, readonly Stayed[]>, taken: readonly TakenPhoto[]): Map<string, TakenPhoto[]> {
  const sorted = [...taken].sort((left, right) => left.at_ms - right.at_ms || compare(left.image, right.image));
  const out = new Map<string, TakenPhoto[]>();
  for (const [key, stays] of held) {
    const images = new Map<string, number>();
    for (const stay of stays) {
      let [low, high] = [0, sorted.length];
      while (low < high) {
        const middle = (low + high) >> 1;
        if (sorted[middle]!.at_ms < stay.start_ms) low = middle + 1;
        else high = middle;
      }
      for (let at = low; at < sorted.length && sorted[at]!.at_ms <= stay.end_ms; at++) {
        const photo = sorted[at]!;
        if ((images.get(photo.image) ?? -Infinity) < photo.at_ms) images.set(photo.image, photo.at_ms);
      }
    }
    if (images.size > 0) out.set(key, [...images].map(([image, at_ms]) => ({ image, at_ms })).sort((left, right) => right.at_ms - left.at_ms || compare(left.image, right.image)));
  }
  return out;
}

function within<T extends { visit: Piece }>(ordered: readonly T[], at: number): T | undefined {
  let [low, high] = [0, ordered.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ordered[middle]!.visit.start_ms <= at) low = middle + 1;
    else high = middle;
  }
  const found = ordered[low - 1];
  return found !== undefined && at < found.visit.end_ms ? found : undefined;
}

function peopleRead<T, N>(read: () => T, none: N): T | N {
  try {
    return read();
  } catch (error) {
    if (damaged(error)) return none;
    throw error;
  }
}

function sizes(dir: string): { file_bytes: number; memo_bytes: number; wal_bytes: number } {
  const size = (name: string) => {
    try {
      return statSync(join(dir, name)).size;
    } catch {
      return 0;
    }
  };
  return { file_bytes: size("places.db"), memo_bytes: size("memo.db"), wal_bytes: size("places.db-wal") + size("memo.db-wal") };
}

function placeFields({ slug, name, latitude, longitude, radius_m, also, ids, home }: Place) {
  return { slug, name, latitude, longitude, radius_m, also: also.map((circle) => ({ ...circle })), ids, ...(home === undefined ? {} : { home }) };
}

interface ListCounts extends Visits {
  ask_home: string | null;
  today_hours: number;
}

interface PageCounts {
  stays: number;
  held: number;
  home_ask: HomeAsk | null;
}

interface PlaceCounts {
  days: number;
  hours: number;
  first_ms: number | null;
  last_ms: number | null;
  visits_count: number;
  nights: number;
  here: boolean;
  ask_home: string | null;
  rhythm: string | null;
  visits: JsonObject[];
  photos: TakenPhoto[];
  photos_count: number;
  people: JsonObject[];
}

const COUNTING = { counting: true } as const;

type Area = ReturnType<typeof area>;
type Kept = Partial<Pick<Place, "latitude" | "longitude"> & { area: Area }>;

function areaFor(place: Place, kept: Kept | undefined): Area {
  return kept?.area !== undefined && kept.latitude === place.latitude && kept.longitude === place.longitude ? kept.area : area(place);
}

function listEntry(place: Place, counted: (ListCounts & Kept) | undefined, counting = false) {
  return {
    ...placeFields(place), stays: counted?.stays ?? 0, days: counted?.days ?? 0, hours: counted?.hours ?? 0, longest_day_hours: counted?.longest_day_hours ?? 0,
    first_ms: counted?.first_ms ?? null, last_ms: counted?.last_ms ?? null, area: areaFor(place, counted), ask_home: counted?.ask_home ?? null, today_hours: counted?.today_hours ?? 0,
    ...(counting ? COUNTING : {}),
  };
}

function placeEntry(place: Place, table: PlaceTable, counted: (PlaceCounts & Kept) | undefined, counting = false) {
  const outer = partOf(place, table);
  return {
    ...placeFields(place), area: areaFor(place, counted), days: counted?.days ?? 0, hours: counted?.hours ?? 0, first_ms: counted?.first_ms ?? null, last_ms: counted?.last_ms ?? null,
    visits_count: counted?.visits_count ?? 0, nights: counted?.nights ?? 0, here: counted?.here ?? false,
    part_of: outer === null ? null : { slug: outer.slug, name: outer.name }, inside: placesInside(place, table).map(({ slug, name }) => ({ slug, name })),
    ask_home: counted?.ask_home ?? null, rhythm: counted?.rhythm ?? null, visits: counted?.visits ?? [], photos: counted?.photos ?? [], photos_count: counted?.photos_count ?? 0,
    people: counted?.people ?? [], ...(counting ? COUNTING : {}),
  };
}

function hiddenEntries(table: PlaceTable, kept: readonly HiddenSpot[], paused: boolean) {
  const counted = new Map(kept.map((row) => [row.key, row]));
  return hiddenRows(table, (record) => counted.get(record.key)?.days ?? 0).map((row) => {
    const was = counted.get(row.key);
    const served = was !== undefined && was.latitude === row.latitude && was.longitude === row.longitude && was.hidden_ms === row.hidden_ms;
    return paused || served ? row : { ...row, ...COUNTING };
  });
}

function byName(places: readonly Place[]): Place[] {
  return [...places].sort((left, right) => compare(left.name, right.name) || compare(left.slug, right.slug));
}

function circleRows(place: Place): Json {
  return circlesOf(place).map(({ latitude, longitude, radius_m }) => [latitude, longitude, radius_m]);
}

function laidBy(table: PlaceTable) {
  return {
    places: table.places.map((place) => [place.slug, circleRows(place), place.ids]),
    google: table.google.map(({ id, latitude, longitude }) => [id, latitude, longitude]),
  };
}

function circlesKey(table: PlaceTable): string {
  return digest({ ...laidBy(table), hidden: table.hidden.map(({ key, latitude, longitude, radius_m }) => [key, latitude, longitude, radius_m]) });
}

function countedBy(place: Place): Json {
  return [circleRows(place), place.ids, place.home ?? null];
}

export function countsServed(place: Place, row: Place | undefined): boolean {
  return row !== undefined && canonical(countedBy(row)) === canonical(countedBy(place));
}

export interface PlacesClock {
  readonly now_ms: number;
  readonly day: DaySettings;
}

interface KeptList {
  day: string;
  day_until_ms: number;
  here: JsonObject | null;
  places: (Place & ListCounts)[];
  spots: (JsonObject & { latitude: number; longitude: number })[];
  hidden: HiddenSpot[];
}

export type PlaceEntry = ReturnType<typeof placeEntry>;

export interface PlaceCounted {
  readonly entry: PlaceEntry;
  readonly counts: PageCounts | null;
}

function heldAndLoose(stays: readonly Stayed[], table: PlaceTable): { held: Map<string, number>; points: StayPoint[] } {
  const held = new Map<string, number>();
  const loose = new Map<string, StayPoint>();
  for (const stay of stays) {
    const byId = placedById(stay.centre, table);
    if (byId !== null) {
      held.set(byId.slug, (held.get(byId.slug) ?? 0) + 1);
      continue;
    }
    const key = `${stay.centre.latitude},${stay.centre.longitude}`;
    const point = loose.get(key);
    if (point === undefined) loose.set(key, { latitude: stay.centre.latitude, longitude: stay.centre.longitude, count: 1 });
    else point.count++;
  }
  const points = [...loose.values()].sort((left, right) => left.latitude - right.latitude || left.longitude - right.longitude);
  return { held, points };
}

export function placesJoined(view: OpenView, unit: string | null, file: PreparedRead | null, clock: PlacesClock) {
  const table = placeTable(view, unit);
  const heads = new Map(table.places.map((place) => [place.slug, place]));
  const paused = jobPaused(view, "places");
  const counting = (place: Place, row: Place | undefined): boolean => !paused && !countsServed(place, row);
  const counted = (slug: string): PlaceCounted | undefined => {
    const head = heads.get(slug);
    if (head === undefined) return undefined;
    const kept = file?.value<{ place: Place & PlaceCounts; counts: PageCounts }>("place", slug);
    return { entry: placeEntry(head, table, kept?.place, counting(head, kept?.place)), counts: kept?.counts ?? null };
  };
  return {
    list() {
      const kept = file?.value<KeptList>("answer", "list");
      const rows = new Map((kept?.places ?? []).map((row) => [row.slug, row]));
      const today = civilDay(clock.now_ms, clock.day);
      const served = paused || (kept !== undefined && file!.meta(CIRCLES) === circlesKey(table));
      return {
        day: kept?.day ?? today, day_until_ms: kept?.day_until_ms ?? dayBounds(today, clock.day).end_ms, here: kept?.here ?? null,
        places: byName(table.places).map((place) => {
          const row = rows.get(place.slug);
          return listEntry(place, row, counting(place, row));
        }),
        spots: (kept?.spots ?? []).filter((spot) => placeOf(spot, table) === null && hiddenAt(spot, table.hidden) === undefined),
        hidden: hiddenEntries(table, kept?.hidden ?? [], paused),
        ...(served ? {} : COUNTING),
      };
    },
    place: (slug: string): PlaceEntry | undefined => counted(slug)?.entry,
    counted,
    points(): { readonly etag: string; read(): StayPoint[] } | null {
      const etag = file?.etag("answer", POINTS);
      return etag === undefined ? null : {
        etag,
        read: () => (file!.value<{ points: [number, number, number][] }>("answer", POINTS)?.points ?? []).map(([latitude, longitude, count]) => ({ latitude, longitude, count })),
      };
    },
    table,
    paused,
  };
}

export type PlacesJoin = ReturnType<typeof placesJoined>;

function area(point: { latitude: number; longitude: number }) {
  const { city, region, country } = areaOf(point);
  return { city, region, country };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function dayLine(summary: Summary): string {
  const slept = [summary.cities, summary.regions, summary.countries].map((level) => level.find((each) => each.nights > 0)?.name).find((name) => name !== undefined);
  const guessed = summary.cities.find((city) => city.guessed_nights > 0)?.name;
  const where = slept ?? (guessed === undefined ? "Not known" : `${guessed}?`);
  const places = summary.places.slice(0, TRIP_DAY_PLACES).map((place) => place.name).join(", ");
  return places === "" ? where : `${where} · ${places}`;
}

interface PresenceTables {
  version: string;
  areas: PresenceArea[];
  pieces: { piece: PresencePiece; known: number | null; guessed: number | null }[];
  placed: [day: string, area: number, guessed: boolean][];
}

function presenceOf(line: readonly Piece[], days: readonly string[], labels: ReturnType<typeof labelsFrom>, readings: ReadonlyMap<string, string>, settings: DaySettings, now: number, restsOn: RestsOn): PresenceTables {
  if (days.length === 0) return { version: digest({ presence: [] }), areas: [], pieces: [], placed: [] };
  const span = { start_ms: dayBounds(days[0]!, settings).start_ms, end_ms: Math.max(now, dayBounds(days.at(-1)!, settings).end_ms) };
  const whole = finishPieces(line, span, span);
  const told = presence(whole, labels, restsOn, readings);
  const areas: PresenceArea[] = [];
  const ids = new Map<string, number>();
  const idOf = (area: PresenceArea | null): number | null => {
    if (area === null) return null;
    const { place, city, city_id, region, country, country_code, zone } = area;
    const key = JSON.stringify([place, city, city_id, region, country, country_code, zone]);
    let id = ids.get(key);
    if (id === undefined) {
      ids.set(key, id = areas.length);
      areas.push({ place, city, city_id, region, country, country_code, zone });
    }
    return id;
  };
  const pieces = told.map((piece) => ({ piece, known: idOf(piece.known), guessed: idOf(piece.guessed) }));
  const placed = new Map<string, [string, number, boolean]>();
  const put = (day: string, area: number | null, guessed: boolean) => {
    if (area === null) return;
    const key = `${day}\0${area}`;
    const had = placed.get(key);
    if (had === undefined || (had[2] && !guessed)) placed.set(key, [day, area, guessed]);
  };
  const byDay = placedDays(whole, span, settings);
  for (const each of byDay.days) {
    for (const [list, guessed] of [[each.known, false], [each.guessed, true]] as const) {
      for (const at of list) put(each.day, idOf({ ...byDay.areas[at]!, place: null }), guessed);
    }
  }
  for (const { piece, known } of pieces) {
    if (piece.known?.place == null) continue;
    for (let each = civilDay(piece.start_ms, settings), last = civilDay(piece.end_ms - 1, settings); each <= last; each = addDays(each, 1)) put(each, known, false);
  }
  const rows = [...placed.values()].sort(([leftDay, left], [rightDay, right]) => compare(leftDay, rightDay) || left - right);
  const held = pieces.map(({ piece, known, guessed }) => [piece.start_ms, piece.end_ms, known, guessed, piece.zone, piece.accounts]);
  return { version: digest({ areas, pieces: held, placed: rows } as unknown as JsonObject), areas, pieces, placed: rows };
}

function writePresence(db: Database.Database, tables: PresenceTables): { written: number; removed: number } {
  if (db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(PRESENCE_META) === tables.version) return { written: 0, removed: 0 };
  const removed = ["area", "presence", "placed"].reduce((sum, table) => sum + db.prepare(`DELETE FROM ${table}`).run().changes, 0);
  const area = db.prepare("INSERT INTO area (id, place, city, city_id, region, country, country_code, zone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  tables.areas.forEach((each, id) => area.run(id, each.place, each.city, each.city_id, each.region, each.country, each.country_code, each.zone));
  const piece = db.prepare("INSERT INTO presence (start_ms, end_ms, known, guessed, zone, accounts) VALUES (?, ?, ?, ?, ?, ?)");
  for (const each of tables.pieces) piece.run(each.piece.start_ms, each.piece.end_ms, each.known, each.guessed, each.piece.zone, each.piece.accounts.join("\x1e"));
  const placed = db.prepare("INSERT INTO placed (day, area, guessed) VALUES (?, ?, ?)");
  for (const [day, at, guessed] of tables.placed) placed.run(day, at, guessed ? 1 : 0);
  return { written: tables.areas.length + tables.pieces.length + tables.placed.length, removed };
}

export function presenceTablesOf(line: readonly Piece[], days: readonly string[], labels: ReturnType<typeof labelsFrom>, readings: ReadonlyMap<string, string>, settings: DaySettings, now: number, restsOn: RestsOn): PresenceRead {
  const made = presenceOf(line, days, labels, readings, settings, now, restsOn);
  return {
    version: made.version, areas: made.areas.map((area, id) => ({ id, ...area })),
    pieces: made.pieces.map(({ piece, known, guessed }) => [piece.start_ms, piece.end_ms, known, guessed, piece.zone, [...piece.accounts]]), placed: made.placed,
  };
}
