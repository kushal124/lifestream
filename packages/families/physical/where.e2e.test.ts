import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addDays, civilDay, dayBounds, instant,
  type DaySettings, type ExtractRow, type Json, type JsonObject, type OpenView, type ReaderOutput, type Witness as WitnessAdapter,
} from "@lifestreamprotocol/core";
import { renderDay, type DayDocument, type LabelUnits, type RenderedDay } from "../days.js";
import type { Given } from "../family.js";
import { labelsFamily } from "../labels/family.js";
import { buildLabels, labelsFrom, placeWords } from "../shared/labels.js";
import { seenWords, spots, type Point, type Stayed } from "../shared/places.js";
import { dayReader, TestHome } from "../test/drive.js";
import { unitName, type SeenContent, type StayContent } from "./evidence.js";
import { physicalFamily } from "./family.js";
import { FED } from "../test/fed.js";
import { dayPieces, finishPieces, REACH_DAYS, reachOf, stitchDays, stitchLaid, summarise, visitsByPlace, where, type LaidStay, type Piece } from "./where.js";
import { conforming } from "../test/units.js";

const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";
const ARTIFACT_DIR = mkdtempSync(join(tmpdir(), "lifestream-where-"));
const ARTIFACT: Record<string, Json> = {};
afterAll(() => {
  writeFileSync(join(ARTIFACT_DIR, "where.json"), `${JSON.stringify(ARTIFACT, null, 1)}\n`);
  if (KEEP) console.log(`where artifact kept: ${join(ARTIFACT_DIR, "where.json")}`);
  else rmSync(ARTIFACT_DIR, { recursive: true, force: true });
});

const SETTINGS: DaySettings = { zone: "Europe/Paris", day_start_hour: 4 };
const HOME_UNIT = "macbook-pro-0001";
const PHONE_UNIT = "iphone-aa01";
const LOCATION = `location:local:${PHONE_UNIT}`;
const GOOGLE = "google-photos:person-a@example.com:export";
const LIBRARY = `apple-photos:person-a@example.com:${PHONE_UNIT}`;
const REINSTALLED = "apple-photos:person-a@example.com:iphone-bb02";
const IN_APP = `camera:local:${PHONE_UNIT}`;
const GOOGLE_TWO = "google-photos:person-a@example.com:export-two";
const CAMERAS = `cameras:local:${HOME_UNIT}`;
const DEVICES = `devices:local:${HOME_UNIT}`;
const PLACES = `places:local:${HOME_UNIT}`;
const TIMELINE = "google-timeline:person-a@example.com:export";
const OWN = "synthetic-make/own-camera";
const STRANGER = "synthetic-make/stranger-camera";
const INSTALL = "11111111-1111-4111-8111-111111111111";
const MINUTE = 60_000;

const NOTRE_DAME: Point = { latitude: 48.853, longitude: 2.3499 };
const BASTILLE: Point = { latitude: 48.8532, longitude: 2.3692 };
const CONCORDE: Point = { latitude: 48.8656, longitude: 2.3212 };
const VERSAILLES: Point = { latitude: 48.8049, longitude: 2.1204 };
const LYON: Point = { latitude: 45.764, longitude: 4.8357 };
const SEA: Point = { latitude: 0, longitude: -25 };
const SEA_TOO: Point = { latitude: 1, longitude: -26 };


const physical = physicalFamily({ photos: FED.photos })(FED.physical);
const newHome = (family = physical) => {
  const home = new TestHome("lifestream-where-", { families: [labelsFamily({ home: HOME_UNIT, messages: [], mail: [] })(FED.labels), family], settings: SETTINGS });
  for (const library of [LIBRARY, REINSTALLED]) home.addSource(library, "photos-ios-bundle");
  home.addSource(IN_APP, "camera-ios-bundle");
  return home;
};

const stored = (view: OpenView): LabelUnits => (unit) => {
  const row = view.extract("labels", unit);
  return row === undefined ? undefined : { reading: row.reading, code: row.code, content: row.content };
};

const at = (day: string, clock: string): number => instant(`${day}T${clock}:00`, "local", { zone: SETTINGS.zone }).start_ms;
const iso = (ms: number) => new Date(ms).toISOString();

function route(home: TestHome, from: string, to: string, reach = REACH_DAYS, family = physical): Piece[] {
  return home.read((view) => where(evidenceOf(view, addDays(from, -reach), addDays(to, reach), family.name),
    { start_ms: dayBounds(from, SETTINGS).start_ms, end_ms: dayBounds(to, SETTINGS).end_ms },
    labelsFrom((unit) => view.extract("labels", unit), SETTINGS), reach, SETTINGS));
}

function evidenceOf(view: OpenView, from: string, to: string, family = "physical"): ExtractRow[] {
  const rows = new Map<string, ExtractRow>();
  for (let day = from; day <= to; day = addDays(day, 1)) for (const row of view.extractsOn(family, day)) rows.set(row.unit, row);
  return [...rows.values()];
}

function laidStays(home: TestHome, from: string, to: string): LaidStay[] {
  return home.read((view) => {
    const labels = labelsFrom((unit) => view.extract("labels", unit), SETTINGS);
    const days: LaidStay[][] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) days.push(dayPieces(view.extractsOn("physical", day), day, labels, SETTINGS).laid);
    return stitchLaid(days);
  });
}

const render = (home: TestHome, day: string, family = physical): RenderedDay =>
  home.read((view) => conforming(renderDay(day, [family], dayReader(view), SETTINGS, stored(view))));

const lines = (day: RenderedDay): string[] => day.txt.split("\n").filter((line) => /^\d\d:\d\d/u.test(line));

const shown = (piece: Piece) => ({
  kind: piece.kind, from: iso(piece.start_ms), to: iso(piece.end_ms), level: piece.level, how: piece.how,
  ...(piece.guess === undefined ? {} : { guess: piece.guess.city }), units: piece.units.length,
});


const hexOf = (text: string) => createHash("sha256").update(text).digest("hex");

function googlePhoto(name: string, taken: number, sidecar: JsonObject): { row: ReaderOutput; hex: string } {
  const hex = hexOf(`synthetic image ${name}`);
  return {
    hex,
    row: {
      kind: "img", key: hex, time: { start_ms: taken, precision: "s" }, blobs: [`sha256:${hex}`],
      content: { type: "photos.asset", title: `${name}.JPG`, photoTakenTime: { timestamp: String(Math.floor(taken / 1000)) }, ...sidecar,
        blobs: [{ hash: `sha256:${hex}`, bytes: 24, media_type: "image/jpeg", role: "original" }] },
    },
  };
}

const exifAt = (point: Point) => ({ geoDataExif: { latitude: point.latitude, longitude: point.longitude, altitude: 35, latitudeSpan: 0, longitudeSpan: 0 } });

const cameraOf = (hex: string, camera: string, gps?: Point): ReaderOutput =>
  ({ kind: "photo", key: hex, content: { type: "cameras.photo", camera, ...(gps === undefined ? {} : { gps: { latitude: gps.latitude, longitude: gps.longitude } }) } });

const counted = (camera: string, photos: number, phones: string[] = []): ReaderOutput => ({
  kind: "camera", key: camera,
  content: { type: "cameras.camera", make: camera.startsWith("phone/") ? null : "Synthetic Make", model: camera.startsWith("phone/") ? null : camera.split("/")[1]!,
    photos, first_ms: null, last_ms: null, sample: null, phones },
});

const word = (camera: string, mine: boolean, from?: string): ReaderOutput =>
  ({ kind: "camera", key: camera, content: { type: "devices.camera", mine, ...(from === undefined ? {} : { from }) } });

function shoot(home: TestHome, name: string, start: number, point: Point, count = 1, camera = OWN): string[] {
  const photos = Array.from({ length: count }, (_, index) => googlePhoto(`${name}-${index}`, start + index * MINUTE, exifAt(point)));
  home.deliver(GOOGLE, start + count * MINUTE, photos.map((photo) => photo.row));
  home.deliver(CAMERAS, start + count * MINUTE + 1, photos.map((photo) => cameraOf(photo.hex, camera)));
  return photos.map((photo) => photo.hex);
}

function libraryAsset(local: string, taken: number, hex: string | null, location: Point | null, modified: string | null = null): ReaderOutput {
  return {
    kind: "img", key: `${local}:${modified ?? "null"}`, time: { start_ms: taken, precision: "s" }, ...(hex === null ? {} : { blobs: [`sha256:${hex}`] }),
    content: { type: "photos.apple.asset", content: {
      local_identifier: local, media_type: "image", modification_date: modified, creation_date: iso(taken),
      location: location === null ? null : { latitude: location.latitude, longitude: location.longitude },
      resources: [hex === null
        ? { type: "photo", type_raw: 1, uti: "public.heic", original_filename: "IMG_0001.HEIC", blob: null, not_local: true }
        : { type: "photo", type_raw: 1, uti: "public.heic", original_filename: "IMG_0001.HEIC", blob: { hash: `sha256:${hex}`, bytes: 24, type: "image/heic", role: "original" } }],
    } },
  };
}

function inAppPhoto(key: string, taken: number, hex: string, location: Point | null, accuracy = 12): ReaderOutput {
  return {
    kind: "img", key, time: { start_ms: taken, precision: "ms" }, blobs: [`sha256:${hex}`],
    content: { type: "camera.photo", content: { observed_at: iso(taken), payload: {
      blob: { hash: `sha256:${hex}`, type: "image/heic", bytes: 24, role: "photo" },
      location: location === null ? null : { latitude: location.latitude, longitude: location.longitude, horizontal_accuracy: accuracy, timestamp: iso(taken) },
    } } },
  };
}

function visit(start: number, end: number, point: Point, place: string): ReaderOutput {
  return {
    kind: "place-visit", key: `visit-${start}`, time: { start_ms: start, end_ms: end, precision: "ms" },
    content: { type: "timeline.visit", content: { startTime: iso(start), endTime: iso(end),
      visit: { hierarchyLevel: "0", probability: "0.8", topCandidate: { placeID: place, placeLocation: `geo:${point.latitude},${point.longitude}`, probability: "0.9", semanticType: "UNKNOWN" } } } },
  };
}

function activity(start: number, end: number, from: Point, to: Point, type: string, distance: number): ReaderOutput {
  return {
    kind: "trip", key: `trip-${start}`, time: { start_ms: start, end_ms: end, precision: "ms" },
    content: { type: "timeline.trip", content: { startTime: iso(start), endTime: iso(end), activity: {
      start: `geo:${from.latitude},${from.longitude}`, end: `geo:${to.latitude},${to.longitude}`, distanceMeters: distance.toFixed(2), probability: "0.7",
      topCandidate: { type, probability: "0.8" },
    } } },
  };
}

const ownerPlace = (id: string, name: string, centre: Point, radius_m = 100, ids: string[] = []): ReaderOutput =>
  ({ kind: "place", key: id, content: { type: "places.place", name, centre: { latitude: centre.latitude, longitude: centre.longitude }, radius_m, ids } });

function fix(sequence: number, ms: number, point: Point, speed: number): ReaderOutput {
  return {
    kind: "fix", key: `${INSTALL}:${sequence}`, time: { start_ms: ms + 1_500, precision: "ms" },
    content: { type: "location.fix", content: { schema_version: 1, domain: "location", kind: "fix", sequence,
      captured: { wall_rfc3339: iso(ms + 1_500), wall_unix_seconds: (ms + 1_500) / 1_000, elapsed_seconds: sequence },
      payload: { location: { timestamp_rfc3339_utc: iso(ms), timestamp_unix_seconds: ms / 1_000, latitude: point.latitude, longitude: point.longitude,
        horizontal_accuracy: 5, vertical_accuracy: 3, altitude: 35, speed, course: 90 } } } },
  };
}

function track(steps: ({ stay: Point; from: number; to: number } | { drive: [Point, Point]; from: number; to: number })[]): ReaderOutput[] {
  const rows: ReaderOutput[] = [];
  let sequence = 0;
  for (const step of steps) {
    if ("stay" in step) {
      for (let ms = step.from; ms < step.to; ms += MINUTE) rows.push(fix(++sequence, ms, step.stay, 0));
      continue;
    }
    const [from, to] = step.drive;
    const count = Math.round((step.to - step.from) / 20_000);
    for (let index = 0; index < count; index++) {
      const share = index / count;
      rows.push(fix(++sequence, step.from + index * 20_000, { latitude: from.latitude + (to.latitude - from.latitude) * share, longitude: from.longitude + (to.longitude - from.longitude) * share }, 9));
    }
  }
  return rows;
}


describe("where the person was, end to end", () => {
  it("W1 W2 W3: whose camera places the owner is the count until the owner's word, dated or not, and a word renders only the days of its photos", () => {
    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-14", "08:00"), [counted(OWN, 49)]);
      shoot(home, "a", at("2026-09-14", "12:00"), NOTRE_DAME);
      shoot(home, "b", at("2026-09-16", "12:00"), LYON);
      home.deliver(LOCATION, at("2026-09-18", "20:00"), track([{ stay: BASTILLE, from: at("2026-09-18", "09:00"), to: at("2026-09-18", "18:00") }]));
      const seen = (pieces: Piece[]) => pieces.filter((piece) => piece.how === "seen").map((piece) => piece.units[0]!.split("/")[2]!);
      expect(seen(route(home, "2026-09-14", "2026-09-18"))).toEqual([]);
      home.deliver(CAMERAS, at("2026-09-17", "08:00"), [counted(OWN, 50)]);
      expect(seen(route(home, "2026-09-14", "2026-09-18"))).toEqual(["2026-09-14", "2026-09-16"]);
      const days = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"];
      const before = new Map(days.map((day) => [day, render(home, day).inputs]));
      home.deliver(DEVICES, at("2026-09-19", "08:00"), [word(OWN, false)]);
      expect(seen(route(home, "2026-09-14", "2026-09-18"))).toEqual([]);
      expect(days.filter((day) => render(home, day).inputs !== before.get(day))).toEqual(["2026-09-14", "2026-09-16"]);
      home.deliver(DEVICES, at("2026-09-19", "09:00"), [word(OWN, false, "2026-09-15")]);
      expect(seen(route(home, "2026-09-14", "2026-09-18"))).toEqual(["2026-09-14"]);
      const seenUnit = home.extracts("physical").find((row) => row.unit.startsWith(`seen/${GOOGLE}/2026-09-14`))!;
      expect((seenUnit.content as unknown as SeenContent).photos.map((sighting) => sighting.camera)).toEqual([OWN]);
      ARTIFACT.ownership = route(home, "2026-09-14", "2026-09-18").map(shown);
    } finally {
      home.close();
    }
  });

  it("W36: ownership is decided for each photo before grouping, at both ends of a dated word", () => {
    const home = newHome();
    try {
      const early = at("2026-09-15", "03:55"), late = at("2026-09-15", "04:05");
      shoot(home, "before-word", early, NOTRE_DAME);
      shoot(home, "after-word", late, { ...NOTRE_DAME, longitude: 2.3509 });
      const extracts = home.extracts("physical");
      const cases = [
        { mine: false, from: "2026-09-15", count: 60, owned: early, point: NOTRE_DAME },
        { mine: false, to: "2026-09-14", count: 60, owned: late, point: { ...NOTRE_DAME, longitude: 2.3509 } },
        { mine: true, from: "2026-09-15", count: 1, owned: late, point: { ...NOTRE_DAME, longitude: 2.3509 } },
        { mine: true, to: "2026-09-14", count: 1, owned: early, point: NOTRE_DAME },
      ];
      ARTIFACT.dated_photos = cases.map(({ mine, from, to, count, owned: taken, point }, index) => {
        const stated = at("2026-09-20", "08:00") + index;
        home.deliver(CAMERAS, stated, [counted(OWN, count)]);
        home.deliver(DEVICES, stated, [{ kind: "camera", key: OWN,
          content: { type: "devices.camera", mine, ...(from === undefined ? { to: to! } : { from }) } }]);
        expect(home.extracts("physical")).toEqual(extracts);
        const pieces = route(home, "2026-09-14", "2026-09-15").filter((piece) => piece.how === "seen");
        expect(pieces.map((piece) => [piece.start_ms, piece.end_ms, piece.point]))
          .toEqual([[taken - 15 * MINUTE, taken + 15 * MINUTE, point]]);
        const spots = laidStays(home, "2026-09-14", "2026-09-15").map(({ start_ms, end_ms, centre, by }): Stayed => ({ start_ms, end_ms, centre, by }));
        expect(spots).toEqual([{ start_ms: taken, end_ms: taken, centre: point, by: "Photos" }]);
        const days = ["2026-09-14", "2026-09-15"].map((day) => {
          const local = route(home, day, day, 0).filter((piece) => piece.how === "seen");
          const bounds = dayBounds(day, SETTINGS);
          expect(local.map((piece) => [piece.start_ms, piece.end_ms, piece.point])).toEqual([
            [Math.max(bounds.start_ms, taken - 15 * MINUTE), Math.min(bounds.end_ms, taken + 15 * MINUTE), point],
          ]);
          const rendered = render(home, day);
          expect((JSON.parse(rendered.json) as { atoms: { family: string; start_ms: number; end_ms: number }[] }).atoms.filter((atom) => atom.family === "physical").map((atom) => [atom.start_ms, atom.end_ms]))
            .toEqual(local.map((piece) => [piece.start_ms, piece.end_ms]));
          return lines(rendered);
        });
        return { mine, from: from ?? null, to: to ?? null, pieces: pieces.map(shown), spots, days } as unknown as Json;
      });
    } finally {
      home.close();
    }
  });

  it("W37: joining stays around a trip stays within a civil day, while the trip stitches across 04:00", () => {
    const home = newHome();
    try {
      const other = { ...NOTRE_DAME, longitude: NOTRE_DAME.longitude + 0.020 };
      home.deliver(PLACES, at("2026-09-13", "08:00"), [ownerPlace("grounds", "Synthetic Grounds", NOTRE_DAME, 2000)]);
      home.deliver(LOCATION, at("2026-09-15", "08:00"), track([
        { stay: NOTRE_DAME, from: at("2026-09-15", "03:00"), to: at("2026-09-15", "03:51") },
        { drive: [{ ...NOTRE_DAME, longitude: 2.3519 }, { ...NOTRE_DAME, longitude: 2.3679 }], from: at("2026-09-15", "03:51"), to: at("2026-09-15", "04:10") },
        { stay: other, from: at("2026-09-15", "04:10"), to: at("2026-09-15", "05:00") },
      ]));
      const trip = home.extracts("physical").find((row) => row.unit.startsWith("trip/"))!;
      expect(trip).toBeDefined();
      const pieces = route(home, "2026-09-14", "2026-09-15").filter((piece) => piece.how === "observed");
      expect(pieces.map((piece) => piece.kind)).toEqual(["stay", "move", "stay"]);
      expect(pieces[1]!.units).toEqual([trip.unit]);
      expect([pieces[1]!.start_ms, pieces[1]!.end_ms]).toEqual([at("2026-09-15", "03:50"), at("2026-09-15", "04:10")]);
      const days = ["2026-09-14", "2026-09-15"].map((day) => {
        const bounds = dayBounds(day, SETTINGS);
        const local = route(home, day, day, 0).filter((piece) => piece.how === "observed");
        const clipped = pieces.filter((piece) => piece.end_ms > bounds.start_ms && piece.start_ms < bounds.end_ms)
          .map((piece) => ({ ...piece, start_ms: Math.max(piece.start_ms, bounds.start_ms), end_ms: Math.min(piece.end_ms, bounds.end_ms) }));
        expect(local).toEqual(clipped);
        const rendered = render(home, day);
        const atoms = (JSON.parse(rendered.json) as { atoms: { start_ms: number; end_ms: number; text: string }[] }).atoms;
        expect(atoms.map((atom) => [Math.max(atom.start_ms, bounds.start_ms), Math.min(atom.end_ms, bounds.end_ms)]))
          .toEqual(local.map((piece) => [piece.start_ms, piece.end_ms]));
        return atoms;
      });
      home.deliver(TIMELINE, at("2026-09-25", "08:00"), [
        visit(at("2026-09-17", "22:00"), at("2026-09-18", "06:00"), NOTRE_DAME, "synthetic-place-r"),
        visit(at("2026-09-19", "20:00"), at("2026-09-19", "22:00"), NOTRE_DAME, "synthetic-place-r"),
        visit(at("2026-09-19", "22:00"), at("2026-09-20", "06:00"), NOTRE_DAME, "synthetic-place-r"),
        visit(at("2026-09-21", "22:00"), at("2026-09-22", "04:00"), NOTRE_DAME, "synthetic-place-r"),
        visit(at("2026-09-22", "04:00"), at("2026-09-22", "06:00"), NOTRE_DAME, "synthetic-place-r"),
      ]);
      const stated = (day: string) => route(home, day, addDays(day, 1)).filter((piece) => piece.how === "stated");
      expect([stated("2026-09-17"), stated("2026-09-19"), stated("2026-09-21")].map((each) => each.map((piece) => [iso(piece.start_ms), iso(piece.end_ms)]))).toEqual([
        [[iso(at("2026-09-17", "22:00")), iso(at("2026-09-18", "06:00"))]],
        [[iso(at("2026-09-19", "20:00")), iso(at("2026-09-20", "06:00"))]],
        [[iso(at("2026-09-21", "22:00")), iso(at("2026-09-22", "04:00"))], [iso(at("2026-09-22", "04:00")), iso(at("2026-09-22", "06:00"))]],
      ]);
      const north = { ...NOTRE_DAME, latitude: NOTRE_DAME.latitude + 0.0009 };
      home.deliver(TIMELINE, at("2026-10-05", "08:00"), [
        visit(at("2026-09-23", "20:00"), at("2026-09-23", "22:00"), NOTRE_DAME, "synthetic-place-r"),
        visit(at("2026-09-23", "22:00"), at("2026-09-24", "06:00"), north, "synthetic-place-s"),
        visit(at("2026-09-29", "18:00"), at("2026-10-01", "12:00"), NOTRE_DAME, "synthetic-place-r"),
      ]);
      shoot(home, "a-first", at("2026-09-27", "03:30"), NOTRE_DAME);
      shoot(home, "a-second", at("2026-09-27", "03:45"), NOTRE_DAME);
      shoot(home, "b", at("2026-09-27", "04:00"), north, 2);
      shoot(home, "doubt-first", at("2026-09-29", "20:00"), BASTILLE);
      shoot(home, "doubt-second", at("2026-09-30", "13:00"), CONCORDE);
      home.deliver(CAMERAS, at("2026-10-05", "09:00"), [counted(OWN, 60)]);
      const facts = (list: Piece[], day: string) => {
        const bounds = dayBounds(day, SETTINGS);
        return list.filter((piece) => piece.how !== null && piece.kind !== "gap" && piece.how !== "bridged" && piece.how !== "guessed" && piece.end_ms > bounds.start_ms && piece.start_ms < bounds.end_ms)
          .map((piece) => [iso(Math.max(piece.start_ms, bounds.start_ms)), iso(Math.min(piece.end_ms, bounds.end_ms)), piece.kind, piece.how, piece.level, piece.point, piece.doubted ?? null]);
      };
      const cuts = ["2026-09-23", "2026-09-26", "2026-09-29"].map((day) => {
        const both = route(home, day, addDays(day, 1));
        for (const each of [day, addDays(day, 1)]) expect(facts(both, each), each).toEqual(facts(route(home, each, each, 0), each));
        return both.filter((piece) => piece.how === "stated" || piece.how === "seen").map((piece) => [iso(piece.start_ms), iso(piece.end_ms), piece.how, piece.doubted?.at_ms ?? null]);
      });
      expect(cuts).toEqual([
        [[iso(at("2026-09-23", "20:00")), iso(at("2026-09-24", "04:00")), "stated", null], [iso(at("2026-09-24", "04:00")), iso(at("2026-09-24", "06:00")), "stated", null]],
        [[iso(at("2026-09-27", "03:15")), iso(at("2026-09-27", "04:00")), "seen", null], [iso(at("2026-09-27", "04:00")), iso(at("2026-09-27", "04:16")), "seen", null]],
        [
          [iso(at("2026-09-29", "18:00")), iso(at("2026-09-29", "19:45")), "stated", at("2026-09-29", "20:00")], [iso(at("2026-09-29", "19:45")), iso(at("2026-09-29", "20:15")), "seen", null],
          [iso(at("2026-09-29", "20:15")), iso(at("2026-09-30", "04:00")), "stated", at("2026-09-29", "20:00")],
          [iso(at("2026-09-30", "04:00")), iso(at("2026-09-30", "12:45")), "stated", at("2026-09-30", "13:00")], [iso(at("2026-09-30", "12:45")), iso(at("2026-09-30", "13:15")), "seen", null],
          [iso(at("2026-09-30", "13:15")), iso(at("2026-10-01", "04:00")), "stated", at("2026-09-30", "13:00")],
        ],
      ]);
      ARTIFACT.day_join = { pieces: pieces.map(shown), days, stated: ["2026-09-17", "2026-09-19", "2026-09-21"].map((day) => stated(day).map(shown)), cuts } as unknown as Json;
    } finally {
      home.close();
    }
  });

  it("W38: a seen unit code 11 stored, its photos as sightings, is read as the photos it grouped: where, the spots and the day read it as this code's", () => {
    const [older] = JSON.parse(readFileSync(new URL("./test/seen.code-11.json", import.meta.url), "utf8")) as ExtractRow[];
    const home = newHome();
    try {
      shoot(home, "notre-dame", at("2026-09-15", "12:00"), NOTRE_DAME, 3);
      home.deliver(DEVICES, at("2026-09-14", "08:00"), [word(OWN, true)]);
      const extracts = home.extracts("physical");
      const current = extracts.find((row) => row.unit === older!.unit)!;
      expect((current.content as unknown as SeenContent).photos.length).toBe(3);
      const served = extracts.map((row) => row === current ? { ...older!, seq: row.seq } : row);
      const span = { start_ms: dayBounds("2026-09-15", SETTINGS).start_ms, end_ms: dayBounds("2026-09-15", SETTINGS).end_ms };
      home.read((view) => {
        const labels = labelsFrom((unit) => view.extract("labels", unit), SETTINGS);
        expect(physical.days(older!, SETTINGS)).toEqual(current.days);
        const laid = where(extracts, span, labels, 0, SETTINGS).map(shown);
        expect(laid.filter((piece) => piece.how === "seen")).not.toEqual([]);
        expect(where(served, span, labels, 0, SETTINGS).map(shown)).toEqual(laid);
        const onDay = (rows: ExtractRow[]) => dayPieces(rows.filter((row) => row.days.includes("2026-09-15")), "2026-09-15", labels, SETTINGS).laid;
        expect(onDay(extracts)).not.toEqual([]);
        expect(onDay(served)).toEqual(onDay(extracts));
        const reader = dayReader(view);
        const behind = { ...reader, extractsOn: (family: string, day: string) => reader.extractsOn(family, day).map((row) => row.unit === older!.unit ? { ...older!, seq: row.seq } : row) };
        const day = renderDay("2026-09-15", [physical], behind, SETTINGS, stored(view));
        expect(day.txt).toBe(renderDay("2026-09-15", [physical], reader, SETTINGS, stored(view)).txt);
        expect(day.units.map((unit) => unit.unit)).toContain(older!.unit);
        const first = (older!.content as unknown as { sightings: { start_ms: number }[] }).sightings[0]!.start_ms;
        const long = structuredClone(older!) as ExtractRow;
        const content = long.content as unknown as { end_ms: number; sightings: { end_ms: number; photos: number }[] };
        content.end_ms = content.sightings[0]!.end_ms = first + 3 * 60 * MINUTE;
        content.sightings[0]!.photos = 37;
        const stretched = extracts.map((row) => row === current ? { ...long, end_ms: content.end_ms, seq: row.seq } : row);
        const pieces = where(stretched, span, labels, 0, SETTINGS).map(shown);
        expect(pieces.filter((piece) => piece.kind === "stay" && piece.how === "seen")).toEqual([expect.objectContaining({ from: iso(first - 15 * MINUTE), to: iso(first + 3 * 60 * MINUTE + 15 * MINUTE) })]);
        ARTIFACT.w38 = { older: older!.content, lines: lines(day), three_hours: pieces };
      });
    } finally {
      home.close();
    }
  });

  it("W4 W6 W11: a stranger's photo leaves a stated visit whole; the owner's 1.4 km away doubts it on its day; the day prints `where`'s evidence for it", () => {
    const home = newHome();
    try {
      home.deliver(PLACES, at("2026-09-13", "08:00"), [ownerPlace("restaurant", "Synthetic Restaurant", NOTRE_DAME, 60, ["google:synthetic-place-r"])]);
      home.deliver(CAMERAS, at("2026-09-13", "08:00"), [counted(OWN, 60), counted(STRANGER, 3)]);
      home.deliver(TIMELINE, at("2026-09-17", "08:00"), [visit(at("2026-09-14", "18:00"), at("2026-09-16", "12:00"), NOTRE_DAME, "synthetic-place-r")]);
      shoot(home, "stranger", at("2026-09-14", "21:00"), BASTILLE, 1, STRANGER);
      shoot(home, "own", at("2026-09-15", "13:38"), BASTILLE);
      const first = lines(render(home, "2026-09-14"));
      expect(first).toEqual(["18:00–2026-09-15 04:00 At Synthetic Restaurant (stated by Timeline) (continues into 15 Sep)"]);
      const second = lines(render(home, "2026-09-15"));
      expect(second).toEqual([
        "04:00–13:23 In Paris (Timeline said Synthetic Restaurant; a photo at 13:38 was 1.4 km away) (continues from 14 Sep)",
        "13:23–13:53 At an unnamed place 1.4 km from Synthetic Restaurant (from photos)",
        "13:53–2026-09-16 04:00 In Paris (Timeline said Synthetic Restaurant; a photo at 13:38 was 1.4 km away) (continues into 16 Sep)",
      ]);
      const doubted = (JSON.parse(render(home, "2026-09-15").json) as { atoms: { text: string; unit: string; units: string[] }[] }).atoms.filter((atom) => atom.text.startsWith("In Paris"));
      expect(doubted).toHaveLength(2);
      for (const atom of doubted) {
        expect(atom.unit).toMatch(new RegExp(`^stay/${TIMELINE}/`, "u"));
        expect(atom.units.filter((unit) => unit.startsWith("seen/"))).toHaveLength(1);
      }
      for (const day of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
        const window = dayBounds(day, SETTINGS);
        const atoms = (JSON.parse(render(home, day).json) as { atoms: { start_ms: number; end_ms: number }[] }).atoms.map((atom) => [atom.start_ms, atom.end_ms]);
        const evidence = (pieces: Piece[]) => pieces.filter((piece) => piece.kind !== "gap" && piece.start_ms < window.end_ms && piece.end_ms > window.start_ms)
          .map((piece) => [Math.max(piece.start_ms, window.start_ms), Math.min(piece.end_ms, window.end_ms)]);
        expect(evidence(route(home, day, day, 0)), day).toEqual(atoms);
        expect(evidence(route(home, day, day)), day).toEqual(atoms);
      }
      ARTIFACT.doubt = { "2026-09-14": first, "2026-09-15": second, pieces: route(home, "2026-09-15", "2026-09-15").map(shown) };
      shoot(home, "back-at-restaurant", at("2026-09-15", "16:00"), NOTRE_DAME, 61);
      const returned = route(home, "2026-09-15", "2026-09-15").filter((piece) => piece.start_ms <= at("2026-09-15", "16:30") && piece.end_ms > at("2026-09-15", "16:30"));
      expect(returned.map((piece) => [piece.how, piece.level, piece.point])).toEqual([["seen", "place", NOTRE_DAME]]);
      expect(lines(render(home, "2026-09-15"))).toContain("15:45–17:15 At Synthetic Restaurant (from photos)");
      ARTIFACT.returned_to_doubted_place = returned.map(shown);
    } finally {
      home.close();
    }
  });

  it("W25: a photo agreeing with a stay confirms it and joins its units; one 200 or 400 m off cuts it for its span", () => {
    const home = newHome();
    try {
      const day = "2026-09-14";
      const east = (meters: number): Point => ({ latitude: NOTRE_DAME.latitude, longitude: NOTRE_DAME.longitude + meters / 73_150 });
      home.deliver(PLACES, at(day, "06:00"), [ownerPlace("restaurant", "Synthetic Restaurant", NOTRE_DAME, 60, ["google:synthetic-place-r"])]);
      home.deliver(CAMERAS, at(day, "06:00"), [counted(OWN, 60)]);
      home.deliver(TIMELINE, at(day, "23:00"), [
        visit(at(day, "10:00"), at(day, "14:00"), NOTRE_DAME, "synthetic-place-r"),
        visit(at(day, "15:30"), at(day, "17:00"), NOTRE_DAME, "synthetic-place-r"),
        visit(at(day, "18:00"), at(day, "20:00"), NOTRE_DAME, "synthetic-place-r"),
      ]);
      shoot(home, "agrees", at(day, "12:00"), east(50));
      shoot(home, "near", at(day, "16:00"), east(200));
      shoot(home, "far", at(day, "19:00"), east(400));
      const printed = lines(render(home, day));
      expect(printed).toEqual([
        "10:00–14:00 At Synthetic Restaurant (stated by Timeline)",
        "15:30–15:45 At Synthetic Restaurant (stated by Timeline)",
        "15:45–16:15 At an unnamed place 0.2 km from Synthetic Restaurant (from photos)",
        "16:15–17:00 At Synthetic Restaurant (stated by Timeline)",
        "18:00–18:45 In Paris (Timeline said Synthetic Restaurant; a photo at 19:00 was 0.4 km away)",
        "18:45–19:15 At an unnamed place 0.4 km from Synthetic Restaurant (from photos)",
        "19:15–20:00 In Paris (Timeline said Synthetic Restaurant; a photo at 19:00 was 0.4 km away)",
      ]);
      const confirmed = route(home, day, day, 0).find((piece) => piece.kind === "stay" && piece.start_ms === at(day, "10:00"))!;
      expect(confirmed.units).toEqual([`stay/${TIMELINE}/visit-${at(day, "10:00")}`, unitName("seen", GOOGLE, day)]);
      ARTIFACT.agree = printed;
    } finally {
      home.close();
    }
  });

  it("a stay a photo confirms or doubts states one of its two witnesses' accounts and not the other's", () => {
    const home = newHome();
    try {
      const day = "2026-09-14";
      const east = (meters: number): Point => ({ latitude: NOTRE_DAME.latitude, longitude: NOTRE_DAME.longitude + meters / 73_150 });
      home.deliver(PLACES, at(day, "06:00"), [ownerPlace("restaurant", "Synthetic Restaurant", NOTRE_DAME, 60, ["google:synthetic-place-r"])]);
      home.deliver(CAMERAS, at(day, "06:00"), [counted(OWN, 60)]);
      home.deliver(TIMELINE, at(day, "23:00"), [
        visit(at(day, "10:00"), at(day, "14:00"), NOTRE_DAME, "synthetic-place-r"),
        visit(at(day, "18:00"), at(day, "20:00"), NOTRE_DAME, "synthetic-place-r"),
      ]);
      shoot(home, "agrees", at(day, "12:00"), east(50));
      shoot(home, "far", at(day, "19:00"), east(400));
      const atoms = (JSON.parse(render(home, day).json) as DayDocument).atoms;
      const both = ["google-photos:person-a@example.com", "google-timeline:person-a@example.com"];
      expect(atoms.map((atom) => [atom.text, atom.accounts])).toEqual([
        ["At Synthetic Restaurant (stated by Timeline)", both],
        ["In Paris (Timeline said Synthetic Restaurant; a photo at 19:00 was 0.4 km away)", both],
        ["At an unnamed place 0.4 km from Synthetic Restaurant (from photos)", ["google-photos:person-a@example.com"]],
        ["In Paris (Timeline said Synthetic Restaurant; a photo at 19:00 was 0.4 km away)", both],
      ]);
    } finally {
      home.close();
    }
  });

  it("W5 W12 W17: a photo never outranks the phone: neither a stay 2.4 km off nor a drive is cut", () => {
    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-14", "08:00"), [counted(OWN, 60)]);
      home.deliver(LOCATION, at("2026-09-14", "20:00"), track([
        { stay: NOTRE_DAME, from: at("2026-09-14", "09:00"), to: at("2026-09-14", "12:00") },
        { drive: [NOTRE_DAME, LYON], from: at("2026-09-14", "12:00"), to: at("2026-09-14", "12:30") },
        { stay: LYON, from: at("2026-09-14", "12:30"), to: at("2026-09-14", "18:00") },
      ]));
      shoot(home, "off", at("2026-09-14", "10:30"), CONCORDE);
      shoot(home, "car", at("2026-09-14", "12:15"), { latitude: 47.3, longitude: 3.6 });
      const pieces = route(home, "2026-09-14", "2026-09-14", 0).filter((piece) => piece.kind !== "gap");
      expect(pieces.map((piece) => [piece.kind, piece.how])).toEqual([["stay", "observed"], ["move", "observed"], ["stay", "observed"]]);
      const seen = home.extracts("physical").filter((row) => row.unit.startsWith("seen/")).flatMap((row) => (row.content as unknown as SeenContent).photos);
      expect(seen).toHaveLength(2);
      ARTIFACT.phone = { pieces: pieces.map(shown), lines: lines(render(home, "2026-09-14")) };
    } finally {
      home.close();
    }
  });

  it("W40: a day's laid stays are what its lay put at place level, each by its own unit and span", () => {
    const home = newHome();
    try {
      const day = "2026-09-14";
      const east = (meters: number): Point => ({ latitude: NOTRE_DAME.latitude, longitude: NOTRE_DAME.longitude + meters / 73_150 });
      home.deliver(PLACES, at(day, "04:30"), [ownerPlace("restaurant", "Synthetic Restaurant", NOTRE_DAME, 60, ["google:synthetic-place-r"])]);
      home.deliver(CAMERAS, at(day, "04:30"), [counted(OWN, 60)]);
      home.deliver(LOCATION, at(day, "23:00"), track([
        { stay: BASTILLE, from: at(day, "05:00"), to: at(day, "07:00") },
        { drive: [BASTILLE, CONCORDE], from: at(day, "07:00"), to: at(day, "07:30") },
        { stay: CONCORDE, from: at(day, "07:30"), to: at(day, "09:30") },
      ]));
      home.deliver(TIMELINE, at(day, "23:00"), [visit(at(day, "10:00"), at(day, "14:00"), NOTRE_DAME, "synthetic-place-r"), visit(at(day, "18:00"), at(day, "20:00"), NOTRE_DAME, "synthetic-place-r")]);
      const under = at(day, "06:00"), car = at(day, "07:15"), agrees = at(day, "12:00"), far = at(day, "19:00");
      shoot(home, "under-phone", under, VERSAILLES);
      shoot(home, "car", car, { latitude: 48.86, longitude: 2.345 });
      shoot(home, "agrees", agrees, east(50));
      shoot(home, "far", far, east(400));
      const extracts = home.extracts("physical");
      const stayOf = (prefix: string, start: number) => {
        const row = extracts.find((each) => each.unit.startsWith(prefix) && Math.abs((each.content as unknown as StayContent).start_ms - start) < 2 * MINUTE)!;
        const content = row.content as unknown as StayContent;
        return { unit: row.unit, start_ms: content.start_ms, end_ms: content.end_ms };
      };
      const square = stayOf(`stay/${LOCATION}/`, at(day, "05:00")), plaza = stayOf(`stay/${LOCATION}/`, at(day, "07:30")), first = stayOf(`stay/${TIMELINE}/`, at(day, "10:00"));
      const seen = unitName("seen", GOOGLE, day);
      const laid = home.read((view) => dayPieces(view.extractsOn("physical", day), day, labelsFrom((unit) => view.extract("labels", unit), SETTINGS), SETTINGS).laid);
      expect(laid.map(({ unit, by, start_ms, end_ms }) => ({ unit, by, from: iso(start_ms), to: iso(end_ms) }))).toEqual([
        { unit: square.unit, by: "Phone", from: iso(square.start_ms), to: iso(square.end_ms) },
        { unit: plaza.unit, by: "Phone", from: iso(plaza.start_ms), to: iso(plaza.end_ms) },
        { unit: first.unit, by: "Timeline", from: iso(at(day, "10:00")), to: iso(at(day, "14:00")) },
        { unit: seen, by: "Photos", from: iso(agrees), to: iso(agrees) },
        { unit: seen, by: "Photos", from: iso(far), to: iso(far) },
      ]);
      expect(laid.find((stay) => stay.start_ms === far)!.centre).toEqual({ latitude: NOTRE_DAME.latitude, longitude: Math.round(east(400).longitude * 1e6) / 1e6 });
      expect(laid.some((stay) => stay.start_ms === under || stay.start_ms === car || stay.start_ms === at(day, "18:00"))).toBe(false);
      const photosOnly = home.read((view) => dayPieces(view.extractsOn("physical", day).filter((row) => row.unit.startsWith("seen/")), day,
        labelsFrom((unit) => view.extract("labels", unit), SETTINGS), SETTINGS).laid);
      expect(photosOnly.map((stay) => stay.start_ms)).toEqual([under, car, agrees, far]);
      ARTIFACT.laid = laid as unknown as Json;
    } finally {
      home.close();
    }
  });

  it("W41: a sighting with its last photo at the day's start is on both days, and holds only its own minutes", () => {
    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-19", "08:00"), [counted(OWN, 60)]);
      shoot(home, "late", at("2026-09-20", "03:55"), VERSAILLES);
      shoot(home, "start", at("2026-09-20", "04:00"), VERSAILLES);
      const laid = laidStays(home, "2026-09-19", "2026-09-20");
      expect(laid.map(({ start_ms, end_ms, closed }) => [start_ms, end_ms, closed])).toEqual([[at("2026-09-20", "03:55"), at("2026-09-20", "04:00"), true]]);
      const [spot] = spots(laid, { places: [], google: [], hidden: [] }, SETTINGS).spots;
      expect(spot).toMatchObject({ days: 2, hours: Math.round(5 / 60 * 100) / 100, longest_day_hours: Math.round(5 / 60 * 100) / 100, worth: false });
      const more = [...laid, { ...laid[0]!, start_ms: at("2026-09-21", "10:00"), end_ms: at("2026-09-21", "10:00") }];
      expect(spots(more, { places: [], google: [], hidden: [] }, SETTINGS).spots[0]!.days).toBe(3);
      expect(seenWords(more, 3, SETTINGS)).toEqual({ witnessed: "You took 3 photos here on 3 days in Sep 2026.", last: "Last time Mon 21 Sep 2026 at 10:00" });
      ARTIFACT.closed = laid as unknown as Json;
    } finally {
      home.close();
    }
  });

  it("W13 W20: a photo from a moving car cuts no stated drive, a 20-minute sighting cuts it for its own span, and a vouch never reaches into a move", () => {
    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-14", "08:00"), [counted(OWN, 60)]);
      home.deliver(TIMELINE, at("2026-09-15", "08:00"), [
        activity(at("2026-09-14", "10:00"), at("2026-09-14", "11:00"), NOTRE_DAME, LYON, "IN_PASSENGER_VEHICLE", 390_000),
        activity(at("2026-09-14", "15:00"), at("2026-09-14", "15:20"), LYON, { latitude: 45.77, longitude: 4.84 }, "WALKING", 1_000),
      ]);
      shoot(home, "car", at("2026-09-14", "10:10"), { latitude: 47.9, longitude: 3.1 });
      shoot(home, "stop", at("2026-09-14", "10:30"), { latitude: 47.5, longitude: 3.4 }, 1);
      shoot(home, "stop-2", at("2026-09-14", "10:40"), { latitude: 47.5, longitude: 3.4 }, 1);
      shoot(home, "stop-3", at("2026-09-14", "10:50"), { latitude: 47.5, longitude: 3.4 }, 1);
      shoot(home, "after", at("2026-09-14", "15:28"), { latitude: 45.77, longitude: 4.84 });
      const pieces = route(home, "2026-09-14", "2026-09-14", 0).filter((piece) => piece.kind !== "gap");
      const times = pieces.map((piece) => [piece.kind, iso(piece.start_ms).slice(11, 16), iso(piece.end_ms).slice(11, 16)]);
      expect(times).toEqual([
        ["move", "08:00", "08:30"], ["stay", "08:30", "08:50"], ["move", "08:50", "09:00"],
        ["move", "13:00", "13:20"], ["stay", "13:20", "13:43"],
      ]);
      ARTIFACT.drives = { pieces: pieces.map(shown), lines: lines(render(home, "2026-09-14")) };
    } finally {
      home.close();
    }
  });

  it("W7 W8 W9 W10: a gap is bridged only where its sides agree within the level's limit, guessed from the nearer side past it, and the day prints neither", () => {
    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-01", "08:00"), [counted(OWN, 60)]);
      shoot(home, "paris", at("2026-09-01", "12:00"), NOTRE_DAME);
      shoot(home, "lyon", at("2026-09-03", "12:00"), LYON);
      shoot(home, "lyon-2", at("2026-09-04", "12:00"), LYON);
      shoot(home, "lyon-3", at("2026-09-12", "12:00"), LYON);
      shoot(home, "sea", at("2026-09-20", "12:00"), SEA);
      shoot(home, "sea-2", at("2026-09-22", "12:00"), SEA_TOO);
      shoot(home, "spot", at("2026-09-01", "15:00"), NOTRE_DAME);
      shoot(home, "spot-2", at("2026-09-01", "15:40"), NOTRE_DAME);
      const pieces = route(home, "2026-09-01", "2026-09-22");
      const gapsOn = (from: string, to: string, after = "12:00") => pieces.filter((piece) => piece.kind === "gap" && piece.start_ms >= at(from, after) && piece.end_ms <= at(to, "12:16"));
      const between = gapsOn("2026-09-01", "2026-09-03", "15:50");
      expect(between.map((piece) => [piece.level, piece.how, piece.guess?.city])).toEqual([["country", "bridged", "Paris"], ["country", "bridged", "Lyon"]]);
      expect(gapsOn("2026-09-03", "2026-09-04").map((piece) => [piece.level, piece.how])).toEqual([["city", "bridged"]]);
      expect(gapsOn("2026-09-04", "2026-09-12").every((piece) => piece.level === "country" && piece.guess?.city === "Lyon")).toBe(true);
      expect(gapsOn("2026-09-20", "2026-09-22").map((piece) => [piece.level, piece.how])).toEqual([[null, null], [null, null]]);
      expect(lines(render(home, "2026-09-02"))).toEqual([]);
      expect(lines(render(home, "2026-09-01"))).toEqual([
        "11:45–12:15 At an unnamed place in Paris (from photos)",
        "14:45–15:55 At an unnamed place in Paris (from photos)",
      ]);
      ARTIFACT.bridges = pieces.map(shown);
    } finally {
      home.close();
    }
  });

  it("W22: a month's summary counts known and guessed nights apart, takes the base, and finds the trip", () => {
    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-01", "08:00"), [counted(OWN, 60)]);
      for (const day of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-05", "2026-09-06", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"]) {
        shoot(home, `paris-${day}`, at(day, "12:00"), NOTRE_DAME);
      }
      for (const day of ["2026-09-08", "2026-09-09"]) shoot(home, `lyon-${day}`, at(day, "12:00"), LYON);
      const span = { start_ms: dayBounds("2026-09-01", SETTINGS).start_ms, end_ms: dayBounds("2026-09-15", SETTINGS).end_ms };
      const pieces = route(home, "2026-09-01", "2026-09-15");
      const [month] = home.read((view) => summarise(pieces, span, "month", SETTINGS, labelsFrom((unit) => view.extract("labels", unit), SETTINGS)));
      expect(month!.base).toEqual({ city: "Paris", city_id: "48.85341,2.3488 Paris", nights: 12 });
      expect(month!.cities.map(({ name, nights, guessed_nights }) => [name, nights, guessed_nights])).toEqual([["Paris", 9, 3], ["Lyon", 1, 2]]);
      expect(month!.trips).toEqual([{ first: "2026-09-07", last: "2026-09-09", cities: ["Lyon"], guessed: true }]);
      expect(month!.countries.map(({ name, nights, guessed_nights }) => [name, nights, guessed_nights])).toEqual([["France", 14, 1]]);
      expect(month!.coverage.nights_unknown).toEqual([]);
      const total = Object.entries(month!.coverage).filter(([name]) => !name.endsWith("unknown") || name === "unknown").reduce((sum, [, value]) => sum + (value as number), 0);
      expect(Math.abs(total - 1)).toBeLessThan(0.01);
      const days = home.read((view) => summarise(pieces, span, "day", SETTINGS, labelsFrom((unit) => view.extract("labels", unit), SETTINGS)));
      expect(days).toHaveLength(15);
      ARTIFACT.summary = { month: month as unknown as Json, days: days.map((day) => ({ period: day.period, base: day.base?.city ?? null })) };
    } finally {
      home.close();
    }
  });

  it("W14 W17 W15 W16: positions in order, never Google's estimate; a new home places a counted camera and a paired phone at once, and a reinstalled phone is the same camera", () => {
    const home = newHome();
    try {
      const day = "2026-09-14";
      const estimate = googlePhoto("estimate", at(day, "09:00"), { geoData: { latitude: LYON.latitude, longitude: LYON.longitude } });
      const sidecar = googlePhoto("sidecar", at(day, "10:00"), { ...exifAt(NOTRE_DAME), geoData: { latitude: LYON.latitude, longitude: LYON.longitude } });
      const exif = googlePhoto("exif", at(day, "11:00"), { geoDataExif: { latitude: 0, longitude: 0 } });
      const nowhere = googlePhoto("nowhere", at(day, "12:00"), {});
      home.deliver(GOOGLE, at(day, "20:00"), [estimate.row, sidecar.row, exif.row, nowhere.row]);
      home.deliver(CAMERAS, at(day, "20:01"), [
        ...[estimate, sidecar, nowhere].map((photo) => cameraOf(photo.hex, OWN)), cameraOf(exif.hex, OWN, BASTILLE), counted(OWN, 60),
      ]);
      const held = home.blobs.put(Buffer.from("synthetic heic original")).slice("sha256:".length);
      const camera = home.blobs.put(Buffer.from("synthetic in-app photo")).slice("sha256:".length);
      home.deliver(LIBRARY, at(day, "20:02"), [libraryAsset("AAAA-0001", at(day, "13:00"), null, CONCORDE), libraryAsset("AAAA-0002", at(day, "14:00"), held, VERSAILLES)]);
      home.deliver(IN_APP, at(day, "20:03"), [inAppPhoto("in-app-1", at(day, "15:00"), camera, BASTILLE, 12)]);
      const { row: strangers, hex: stranger } = googlePhoto("stranger", at(day, "16:00"), {});
      home.deliver(GOOGLE_TWO, at(day, "20:04"), [strangers]);
      const again = home.blobs.put(Buffer.from("synthetic reinstalled original")).slice("sha256:".length);
      home.deliver(REINSTALLED, at(day, "20:05"), [libraryAsset("BBBB-0001", at(day, "17:00"), again, null)]);
      home.deliver(CAMERAS, at(day, "20:06"), [
        cameraOf(held, "apple/iphone-17-pro", LYON), cameraOf(camera, "apple/iphone-17-pro"), cameraOf(stranger, STRANGER, NOTRE_DAME),
        cameraOf(again, "apple/iphone-17-pro", CONCORDE), counted("apple/iphone-17-pro", 3, [PHONE_UNIT]), counted(`phone/${PHONE_UNIT}`, 1), counted(STRANGER, 1),
      ]);
      const photos = home.extracts("physical").filter((row) => row.unit.startsWith("seen/"))
        .flatMap((row) => (row.content as unknown as SeenContent).photos.map((sighting) => ({ source: row.unit.split("/")[1]!, ...sighting })));
      const where = (source: string) => photos.filter((sighting) => sighting.source === source).map(({ point, camera: by, accuracy_m }) => [point.latitude, point.longitude, by, accuracy_m]);
      expect(where(GOOGLE)).toEqual([[NOTRE_DAME.latitude, NOTRE_DAME.longitude, OWN, null], [BASTILLE.latitude, BASTILLE.longitude, OWN, null]]);
      expect(where(LIBRARY)).toEqual([[CONCORDE.latitude, CONCORDE.longitude, `phone/${PHONE_UNIT}`, null], [VERSAILLES.latitude, VERSAILLES.longitude, "apple/iphone-17-pro", null]]);
      expect(where(IN_APP)).toEqual([[BASTILLE.latitude, BASTILLE.longitude, "apple/iphone-17-pro", 12]]);
      expect(where(GOOGLE_TWO)).toEqual([[NOTRE_DAME.latitude, NOTRE_DAME.longitude, STRANGER, null]]);
      expect(where(REINSTALLED)).toEqual([[CONCORDE.latitude, CONCORDE.longitude, "apple/iphone-17-pro", null]]);
      const seen = route(home, day, day, 0).filter((piece) => piece.how === "seen").map((piece) => iso(piece.start_ms + 15 * MINUTE).slice(11, 16));
      expect(seen).toEqual(["08:00", "09:00", "11:00", "12:00", "13:00", "15:00"]);
      ARTIFACT.positions = { photos: photos as unknown as Json, lines: lines(render(home, day)) };
    } finally {
      home.close();
    }
  });

  it("W18 W19: a seen unit reads only its own date's photos, a camera's record touches only its photos' dates, and a delivery renders only its own days", () => {
    const home = newHome();
    try {
      const dates = Array.from({ length: 20 }, (_, index) => addDays("2026-09-01", index));
      const hexes = new Map<string, string[]>();
      for (const date of dates) hexes.set(date, shoot(home, date, at(date, "12:00"), NOTRE_DAME, 5));
      const late = googlePhoto("late", at("2026-09-10", "16:00"), exifAt(BASTILLE));
      expect(home.deliver(GOOGLE, at("2026-09-21", "08:00"), [late.row]).days).toEqual(["2026-09-10"]);
      const record = { source: CAMERAS, kind: "photo", key: hexes.get("2026-09-05")![0]! };
      const touched = home.read((view) => physical.touched([{ record, after: view.version(view.head(record)!.version) }], view)).map((each) => each.unit);
      expect(touched).toEqual([unitName("seen", GOOGLE, "2026-09-05")]);
      const read: string[] = [];
      home.read((open) => {
        const view = new Proxy(open, { get(target, name) {
          const member = Reflect.get(target, name, target) as unknown;
          if (name !== "records" || typeof member !== "function") return typeof member === "function" ? (member as (...args: unknown[]) => unknown).bind(target) : member;
          return function* (...args: unknown[]) {
            for (const row of (member as (...args: unknown[]) => Iterable<{ head: { key: string; kind: string } }>).apply(target, args)) {
              if (row.head.kind === "img") read.push(row.head.key);
              yield row;
            }
          };
        } });
        expect(physical.extract(unitName("seen", GOOGLE, "2026-09-05"), view, home.blobs)).not.toBeNull();
      });
      expect(read.sort()).toEqual([...hexes.get("2026-09-05")!].sort());
      ARTIFACT.cost = { photos: 101, read: read.length };
    } finally {
      home.close();
    }
  });

  it("W21: a fourth witness is one adapter: it fills a gap, loses to the phone, and prints, with nothing else changed", () => {
    const pins: Given<WitnessAdapter> = {
      product: "whatsapp", name: "Pins", vendor: "meta", type: null,
      adapter: {
        version: "1", kinds: ["place-visit"], name: "Pins", rank: 30, how: "stated",
        visit({ version }) {
          const content = version.content as { latitude: number; longitude: number; at_ms: number };
          return { start_ms: content.at_ms, end_ms: content.at_ms + 30 * MINUTE, centre: { latitude: content.latitude, longitude: content.longitude }, place: null };
        },
      },
    };
    const family = physicalFamily({ photos: FED.photos })([...FED.physical, pins]);
    const home = newHome(family);
    try {
      const day = "2026-09-14";
      home.deliver(PLACES, at(day, "06:00"), [ownerPlace("home", "Synthetic Home", NOTRE_DAME)]);
      home.deliver(LOCATION, at(day, "20:00"), track([
        { stay: NOTRE_DAME, from: at(day, "08:00"), to: at(day, "10:00") },
        { drive: [NOTRE_DAME, CONCORDE], from: at(day, "10:00"), to: at(day, "10:05") },
        { stay: CONCORDE, from: at(day, "10:05"), to: at(day, "11:00") },
      ]));
      const pin = (key: string, point: Point, ms: number): ReaderOutput => ({ kind: "place-visit", key, time: { start_ms: ms, precision: "ms" }, content: { latitude: point.latitude, longitude: point.longitude, at_ms: ms } });
      home.deliver("whatsapp:15550000000:pins", at(day, "21:00"), [pin("in-gap", BASTILLE, at(day, "14:00")), pin("under-phone", LYON, at(day, "09:00"))]);
      const pieces = route(home, day, day, 0, family).filter((piece) => piece.kind !== "gap");
      expect(pieces.map((piece) => [piece.kind, piece.how, piece.by, iso(piece.start_ms).slice(11, 16)])).toEqual([
        ["stay", "observed", "Phone", "06:00"], ["move", "observed", "Phone", "08:00"], ["stay", "observed", "Phone", "08:05"], ["stay", "stated", "Pins", "12:00"],
      ]);
      const printed = lines(render(home, day, family));
      expect(printed.at(-1)).toBe("14:00–14:30 At an unnamed place 1.4 km from Synthetic Home (stated by Pins)");
      ARTIFACT.fourth = printed;
    } finally {
      home.close();
    }
  });

  it("W23 W24: a far unnamed place is told by its city; the owner's photos make a spot, a stranger's do not", () => {
    const labels = buildLabels({ people: [], contacts: [], places: [{ slug: "home", name: "Synthetic Home", ...NOTRE_DAME, radius_m: 100, ids: [], also: [] }] });
    expect(placeWords(BASTILLE, labels)).toBe("an unnamed place 1.4 km from Synthetic Home");
    expect(placeWords(VERSAILLES, labels)).toBe("an unnamed place in Paris");
    expect(placeWords(LYON, labels)).toBe("an unnamed place in Lyon");
    expect(placeWords(SEA, labels)).toMatch(/^an unnamed place \d+ km from Synthetic Home$/u);

    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-01", "08:00"), [counted(OWN, 60), counted(STRANGER, 3)]);
      for (const day of ["2026-09-01", "2026-09-05", "2026-09-09"]) {
        shoot(home, `own-${day}`, at(day, "12:00"), LYON, 2);
        shoot(home, `stranger-${day}`, at(day, "12:00"), VERSAILLES, 2, STRANGER);
      }
      const found = spots(laidStays(home, "2026-09-01", "2026-09-09"), { places: [], google: [], hidden: [] }, SETTINGS);
      expect(found.spots.map((spot) => [spot.latitude, spot.longitude, spot.days, spot.worth])).toEqual([[LYON.latitude, LYON.longitude, 3, true]]);
      ARTIFACT.spots = found.spots as unknown as Json;
    } finally {
      home.close();
    }
  });

  it("W26 W27: two unnamed places in one city are two stays, and a photo's vouch stops where another photo was taken", () => {
    const home = newHome();
    try {
      const day = "2026-09-14";
      home.deliver(CAMERAS, at(day, "06:00"), [counted(OWN, 60)]);
      shoot(home, "cathedral", at(day, "10:00"), NOTRE_DAME);
      shoot(home, "palace", at(day, "10:20"), VERSAILLES);
      const seen = (from: string, to: string) => route(home, from, to, 0).filter((piece) => piece.how === "seen")
        .map((piece) => [iso(piece.start_ms).slice(11, 16), iso(piece.end_ms).slice(11, 16), piece.point!.latitude]);
      expect(seen(day, day)).toEqual([["07:45", "08:15", NOTRE_DAME.latitude], ["08:15", "08:35", VERSAILLES.latitude]]);
      expect(lines(render(home, day))).toEqual([
        "09:45–10:15 At an unnamed place in Paris (from photos)",
        "10:15–10:35 At an unnamed place in Paris (from photos)",
      ]);
      const next = "2026-09-15";
      home.deliver(PLACES, at(next, "06:00"), [ownerPlace("home", "Synthetic Home", NOTRE_DAME), ownerPlace("square", "Synthetic Square", BASTILLE)]);
      shoot(home, "home", at(next, "10:00"), NOTRE_DAME);
      shoot(home, "square", at(next, "10:10"), BASTILLE);
      expect(lines(render(home, next))).toEqual([
        "09:45–10:10 At Synthetic Home (from photos)",
        "10:10–10:25 At Synthetic Square (from photos)",
      ]);
      ARTIFACT.identity = { [day]: lines(render(home, day)), [next]: lines(render(home, next)) };
    } finally {
      home.close();
    }
  });

  it("W28: a short stay that agrees with a sighting confirms it only where it covers it", () => {
    const home = newHome();
    try {
      const day = "2026-09-14";
      home.deliver(PLACES, at(day, "06:00"), [ownerPlace("restaurant", "Synthetic Restaurant", NOTRE_DAME, 60, ["google:synthetic-place-r"])]);
      home.deliver(CAMERAS, at(day, "06:00"), [counted(OWN, 60)]);
      home.deliver(TIMELINE, at(day, "23:00"), [visit(at(day, "12:00"), at(day, "12:05"), NOTRE_DAME, "synthetic-place-r")]);
      shoot(home, "first", at(day, "12:04"), NOTRE_DAME);
      shoot(home, "second", at(day, "12:14"), NOTRE_DAME);
      const pieces = route(home, day, day, 0).filter((piece) => piece.kind !== "gap");
      expect(pieces.map((piece) => [piece.how, iso(piece.start_ms).slice(11, 16), iso(piece.end_ms).slice(11, 16), piece.units.length])).toEqual([
        ["seen", "09:49", "10:00", 1], ["stated", "10:00", "10:05", 2], ["seen", "10:05", "10:29", 1],
      ]);
      const printed = lines(render(home, day));
      expect(printed).toEqual([
        "11:49–12:00 At Synthetic Restaurant (from photos)",
        "12:00–12:05 At Synthetic Restaurant (stated by Timeline)",
        "12:05–12:29 At Synthetic Restaurant (from photos)",
      ]);
      ARTIFACT.confirms = printed;
    } finally {
      home.close();
    }
  });

  it("W29: a photo just before the day's start vouches into the next day, whatever else its unit holds", () => {
    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-14", "06:00"), [counted(OWN, 60)]);
      shoot(home, "late", at("2026-09-15", "03:55"), NOTRE_DAME);
      const atFive = () => route(home, "2026-09-15", "2026-09-15").find((piece) => piece.start_ms <= at("2026-09-15", "04:05") && at("2026-09-15", "04:05") < piece.end_ms)!;
      expect([atFive().how, atFive().level]).toEqual(["seen", "place"]);
      expect(lines(render(home, "2026-09-15"))).toEqual(["04:00–04:10 At an unnamed place in Paris (from photos)"]);
      shoot(home, "noon", at("2026-09-15", "12:00"), LYON);
      expect([atFive().how, atFive().level]).toEqual(["seen", "place"]);
      ARTIFACT.vouch = lines(render(home, "2026-09-15"));
    } finally {
      home.close();
    }
  });

  it("W30: an overnight flight is one move, places its night in no city, only in the country both ends are in", () => {
    const home = newHome();
    try {
      home.deliver(TIMELINE, at("2026-09-16", "08:00"), [activity(at("2026-09-14", "22:00"), at("2026-09-15", "06:00"), NOTRE_DAME, LYON, "FLYING", 400_000)]);
      const pieces = route(home, "2026-09-14", "2026-09-15").filter((piece) => piece.kind === "move");
      expect(pieces.map((piece) => [iso(piece.start_ms), iso(piece.end_ms), piece.distance_m])).toEqual([[iso(at("2026-09-14", "22:00")), iso(at("2026-09-15", "06:00")), 400_000]]);
      const span = { start_ms: dayBounds("2026-09-14", SETTINGS).start_ms, end_ms: dayBounds("2026-09-14", SETTINGS).end_ms };
      const day = route(home, "2026-09-14", "2026-09-14");
      const [night] = home.read((view) => summarise(day, span, "day", SETTINGS, labelsFrom((unit) => view.extract("labels", unit), SETTINGS)));
      expect(night!.cities.map((city) => [city.name, city.days, city.nights, city.guessed_days, city.guessed_nights])).toEqual([["Paris", 0, 0, 1, 0]]);
      expect(night!.countries.map((country) => [country.name, country.days, country.nights])).toEqual([["France", 1, 1]]);
      expect([night!.base, night!.coverage.nights_unknown]).toEqual([null, []]);
      expect(night!.coverage.moving).toBeGreaterThan(0);
      ARTIFACT.flight = { pieces: pieces.map(shown), night: night as unknown as Json };
    } finally {
      home.close();
    }
  });

  it("W34: a move across one city places its night in the city, and the day still prints it", () => {
    const home = newHome();
    try {
      home.deliver(TIMELINE, at("2026-09-16", "08:00"), [
        visit(at("2026-09-14", "10:00"), at("2026-09-14", "12:00"), NOTRE_DAME, "synthetic-place-r"),
        activity(at("2026-09-14", "12:00"), at("2026-09-15", "06:00"), NOTRE_DAME, BASTILLE, "IN_PASSENGER_VEHICLE", 200),
        visit(at("2026-09-15", "06:00"), at("2026-09-15", "09:00"), BASTILLE, "synthetic-place-b"),
      ]);
      const pieces = route(home, "2026-09-14", "2026-09-15");
      const span = { start_ms: dayBounds("2026-09-14", SETTINGS).start_ms, end_ms: dayBounds("2026-09-14", SETTINGS).end_ms };
      const [night] = home.read((view) => summarise(pieces, span, "day", SETTINGS, labelsFrom((unit) => view.extract("labels", unit), SETTINGS)));
      expect([night!.cities.map((city) => [city.name, city.days, city.nights, city.guessed_nights]), night!.base, night!.coverage.nights_unknown])
        .toEqual([[["Paris", 1, 1, 0]], { city: "Paris", city_id: "48.85341,2.3488 Paris", nights: 1 }, []]);
      expect(lines(render(home, "2026-09-14")).filter((line) => line.startsWith("12:00"))).toEqual([
        "12:00–2026-09-15 04:00 Not recorded, an unnamed place in Paris → an unnamed place in Paris, 1.4 km (continues into 15 Sep)",
      ]);
      ARTIFACT.across_a_city = { pieces: pieces.map(shown), night: night as unknown as Json };
    } finally {
      home.close();
    }
  });

  it("W35: a span that ends before a day's night leaves it not yet, and its shares are of the hours up to the end", () => {
    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-01", "08:00"), [counted(OWN, 60)]);
      shoot(home, "paris", at("2026-09-14", "12:00"), NOTRE_DAME);
      const span = { start_ms: dayBounds("2026-09-14", SETTINGS).start_ms, end_ms: at("2026-09-14", "18:00") };
      const [pieces, day] = home.read((view) => {
        const labels = labelsFrom((unit) => view.extract("labels", unit), SETTINGS);
        const laid = where(evidenceOf(view, "2026-08-15", "2026-10-14"), span, labels, REACH_DAYS, SETTINGS);
        return [laid, summarise(laid, span, "day", SETTINGS, labels)[0]] as const;
      });
      expect([pieces[0]!.start_ms, pieces.at(-1)!.end_ms]).toEqual([span.start_ms, span.end_ms]);
      expect([day!.coverage.nights_unknown, day!.cities.map((city) => [city.name, city.days, city.nights, city.guessed_nights])]).toEqual([[], [["Paris", 1, 0, 0]]]);
      const total = Object.entries(day!.coverage).filter(([name]) => !name.endsWith("unknown") || name === "unknown").reduce((sum, [, value]) => sum + (value as number), 0);
      expect(Math.abs(total - 1)).toBeLessThan(0.01);
      ARTIFACT.not_yet = day as unknown as Json;
    } finally {
      home.close();
    }
  });

  it("W31: two cities of one name are two cities", () => {
    const home = newHome();
    try {
      const oregon: Point = { latitude: 45.5152, longitude: -122.6784 };
      const maine: Point = { latitude: 43.6591, longitude: -70.2568 };
      home.deliver(CAMERAS, at("2026-09-01", "06:00"), [counted(OWN, 60)]);
      shoot(home, "oregon", at("2026-09-01", "12:00"), oregon);
      shoot(home, "maine", at("2026-09-02", "12:00"), maine);
      const pieces = route(home, "2026-09-01", "2026-09-02");
      const between = pieces.filter((piece) => piece.kind === "gap" && piece.start_ms >= at("2026-09-01", "12:15") && piece.end_ms <= at("2026-09-02", "11:45"));
      expect(between.map((piece) => [piece.level, piece.how, piece.guess?.city])).toEqual([["country", "bridged", "Portland"], ["country", "bridged", "Portland"]]);
      const span = { start_ms: dayBounds("2026-09-01", SETTINGS).start_ms, end_ms: dayBounds("2026-09-02", SETTINGS).end_ms };
      const [month] = home.read((view) => summarise(pieces, span, "month", SETTINGS, labelsFrom((unit) => view.extract("labels", unit), SETTINGS)));
      expect(month!.cities.map((city) => [city.name, city.days])).toEqual([["Portland", 1], ["Portland", 1]]);
      for (const grain of ["month", "year"] as const) {
        const [summary] = home.read((view) => summarise(pieces, span, grain, SETTINGS, labelsFrom((unit) => view.extract("labels", unit), SETTINGS)));
        expect(new Set(summary!.cities.map((city) => city.city_id)).size).toBe(2);
        expect(summary!.cities.every((city) => typeof city.city_id === "string")).toBe(true);
        const base = summary!.cities.find((city) => city.city_id === summary!.base!.city_id)!;
        expect(base.name).toBe(summary!.base!.city);
        expect(base.nights + base.guessed_nights).toBe(summary!.base!.nights);
      }
      ARTIFACT.portlands = { gap: between.map(shown), summary: month as unknown as Json };
    } finally {
      home.close();
    }
  });

  it("W32: a library photo edited to another date leaves its old date, and its edit renders both", () => {
    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-14", "06:00"), [counted(`phone/${PHONE_UNIT}`, 1)]);
      home.deliver(LIBRARY, at("2026-09-14", "20:00"), [libraryAsset("AAAA-0001", at("2026-09-14", "12:00"), null, NOTRE_DAME)]);
      const seen = () => route(home, "2026-09-14", "2026-09-15", 0).filter((piece) => piece.how === "seen").map((piece) => [civilDay(piece.start_ms, SETTINGS), piece.point!.latitude]);
      expect(seen()).toEqual([["2026-09-14", NOTRE_DAME.latitude]]);
      const edit = home.deliver(LIBRARY, at("2026-09-20", "08:00"), [libraryAsset("AAAA-0001", at("2026-09-15", "12:00"), null, LYON, "2026-09-20T06:00:00Z")]);
      expect(edit.days).toEqual(["2026-09-14", "2026-09-15"]);
      expect(seen()).toEqual([["2026-09-15", LYON.latitude]]);
      home.deliver(LIBRARY, at("2026-09-20", "09:00"), [
        libraryAsset("AAAA-0001", at("2026-09-14", "12:00"), null, NOTRE_DAME, "2026-09-20T07:00:00+02:00"),
        libraryAsset("AAAA-0001", at("2026-09-14", "12:00"), null, NOTRE_DAME, "2026-09-20T02:00:00-04:00"),
      ]);
      expect(seen()).toEqual([["2026-09-15", LYON.latitude]]);
      ARTIFACT.edit = { days: edit.days, seen: seen() as unknown as Json };
    } finally {
      home.close();
    }
  });

  it("W33: photos across the antimeridian form one sighting centred beside them", () => {
    const home = newHome();
    try {
      home.deliver(CAMERAS, at("2026-09-14", "06:00"), [counted(`phone/${PHONE_UNIT}`, 3)]);
      home.deliver(LIBRARY, at("2026-09-14", "14:00"), [179.9995, -179.9995, 179.9997].map((longitude, index) =>
        libraryAsset(`DATE-LINE-000${index}`, at("2026-09-14", "12:00") + index * MINUTE, null, { latitude: 0, longitude })));
      const pieces = route(home, "2026-09-14", "2026-09-14", 0).filter((piece) => piece.how === "seen");
      expect(pieces.map((piece) => piece.point)).toEqual([{ latitude: 0, longitude: 179.9999 }]);
      const photos = (home.extracts("physical")[0]!.content as unknown as SeenContent).photos;
      expect(photos).toHaveLength(3);
      ARTIFACT.antimeridian = { pieces: pieces.map(shown), photos: photos as unknown as Json };
    } finally {
      home.close();
    }
  });
  it("W39: the places job's visits, each day laid alone and kept, then stitched, are the visits `visitsAt` laid", () => {
    const home = newHome();
    try {
      home.deliver(PLACES, at("2026-09-13", "08:00"), [
        ownerPlace("cathedral", "Synthetic Cathedral", NOTRE_DAME, 100, ["google:synthetic-place-r"]), ownerPlace("square", "Synthetic Square", BASTILLE, 100),
        ownerPlace("palace", "Synthetic Palace", VERSAILLES, 300),
      ]);
      home.deliver(CAMERAS, at("2026-09-13", "08:00"), [counted(OWN, 60)]);
      const unnamed = { latitude: CONCORDE.latitude, longitude: CONCORDE.longitude };
      home.deliver(LOCATION, at("2026-09-21", "08:00"), track([
        { stay: NOTRE_DAME, from: at("2026-09-15", "20:00"), to: at("2026-09-16", "07:00") },
        { drive: [NOTRE_DAME, BASTILLE], from: at("2026-09-16", "07:00"), to: at("2026-09-16", "07:20") },
        { stay: BASTILLE, from: at("2026-09-16", "07:20"), to: at("2026-09-16", "10:00") },
        { drive: [BASTILLE, NOTRE_DAME], from: at("2026-09-16", "10:00"), to: at("2026-09-16", "10:20") },
        { stay: NOTRE_DAME, from: at("2026-09-16", "10:20"), to: at("2026-09-17", "03:50") },
        { drive: [{ ...NOTRE_DAME, longitude: 2.3519 }, { ...NOTRE_DAME, longitude: 2.3529 }], from: at("2026-09-17", "03:50"), to: at("2026-09-17", "04:10") },
        { stay: NOTRE_DAME, from: at("2026-09-17", "04:10"), to: at("2026-09-17", "09:00") },
        { drive: [NOTRE_DAME, unnamed], from: at("2026-09-17", "09:00"), to: at("2026-09-17", "09:20") },
        { stay: unnamed, from: at("2026-09-17", "09:20"), to: at("2026-09-18", "04:00") },
        { drive: [unnamed, BASTILLE], from: at("2026-09-18", "04:00"), to: at("2026-09-18", "04:20") },
        { stay: BASTILLE, from: at("2026-09-18", "04:20"), to: at("2026-09-18", "12:00") },
      ]));
      home.deliver(TIMELINE, at("2026-09-25", "08:00"), [visit(at("2026-09-20", "18:00"), at("2026-09-22", "12:00"), NOTRE_DAME, "synthetic-place-r")]);
      shoot(home, "doubt", at("2026-09-21", "13:38"), BASTILLE);
      shoot(home, "palace-a", at("2026-09-24", "03:40"), VERSAILLES, 3);
      shoot(home, "palace-b", at("2026-09-24", "04:02"), VERSAILLES, 3);
      const days = [...new Set(home.extracts("physical").flatMap((row) => row.days))].sort();
      const visits = home.read((view) => {
        const labels = labelsFrom((unit) => view.extract("labels", unit), SETTINGS);
        const laid = days.map((day) => JSON.parse(JSON.stringify(dayPieces(view.extractsOn("physical", day), day, labels, SETTINGS).pieces)) as Piece[]);
        const byPlace = visitsByPlace(stitchDays(laid), labels);
        const span = { start_ms: dayBounds(days[0]!, SETTINGS).start_ms, end_ms: dayBounds(days.at(-1)!, SETTINGS).end_ms };
        expect(finishPieces(stitchDays(laid), reachOf(span, REACH_DAYS, SETTINGS).window, span))
          .toEqual(where(evidenceOf(view, addDays(days[0]!, -REACH_DAYS), addDays(days.at(-1)!, REACH_DAYS)), span, labels, REACH_DAYS, SETTINGS));
        const kept = JSON.parse(readFileSync(new URL("./test/visits.json", import.meta.url), "utf8")) as Record<string, Piece[]>;
        expect(Object.fromEntries(Object.keys(kept).map((slug) => [slug, byPlace.get(slug) ?? []]))).toEqual(kept);
        return kept;
      });
      expect(visits.cathedral!.some((piece) => piece.start_ms === at("2026-09-15", "20:00") && piece.end_ms >= at("2026-09-16", "06:59"))).toBe(true);
      expect(visits.palace).toHaveLength(1);
      const night = home.extracts("physical").find((row) => row.unit.startsWith(`stay/${LOCATION}/`) && (row.content as unknown as StayContent).start_ms === at("2026-09-15", "20:00"))!;
      const nights = laidStays(home, days[0]!, days.at(-1)!).filter((stay) => stay.unit === night.unit);
      expect(nights.map(({ start_ms, end_ms }) => [start_ms, end_ms])).toEqual([[at("2026-09-15", "20:00"), (night.content as unknown as StayContent).end_ms]]);
      ARTIFACT.visits = Object.fromEntries(Object.entries(visits).map(([slug, list]) => [slug, list.map(shown)])) as unknown as Json;
    } finally {
      home.close();
    }
  });
});
