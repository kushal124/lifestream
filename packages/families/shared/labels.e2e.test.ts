import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ReaderOutput } from "@lifestreamprotocol/core";
import { TestHome } from "../test/drive.js";
import { labelsFrom, labelTable, placesUnit, readLabels, resolvedName } from "./labels.js";
import { distanceMeters, nearestPlace, newCircle, partOf, placeOf, placesInside, PLACE_REACH_M, takesIn, type NamedCircle, type Place, type Point, type StayPoint } from "./places.js";
import { NETWORKED } from "../test/fed.js";
import { networksOf } from "../messages/networks.js";

const NETWORKS = networksOf(NETWORKED.messages);
const BOOK = "apple-contacts:person-a@example.com:iphone-aa01";
const REGISTRY = "people:local:macbook-pro-0001";
const HOME = "macbook-pro-0001";
const PLACES = `places:local:${HOME}`;
const T0 = Date.UTC(2026, 9, 6, 12);

function card(name: string, extra = ""): ReaderOutput {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nTEL;TYPE=CELL:+1 555 000 0002\r\nEMAIL:person-b@example.com\r\n${extra}END:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
}

function person(name: string, slug = "person-c", handles: [kind: string, value: string, by: string][] = [
  ["email", "person-c@example.com", "subject"], ["email", "person-b@example.com", "agent"],
], merged_into: string | null = null): ReaderOutput {
  return {
    kind: "person", key: slug,
    content: {
      type: "people.person", slug, name, merged_into, excluded: [],
      handles: [["name", name, "subject"] as const, ...handles].sort(([kind, value], [otherKind, other]) => kind < otherKind ? -1 : kind > otherKind ? 1 : value < other ? -1 : 1)
        .map(([kind, value, by]) => ({ kind, value, by, since: "2026-10-01T00:00:00Z" })),
    },
  };
}

const homes: TestHome[] = [];
function home(prefix: string): TestHome {
  const opened = new TestHome(`families-labels-${prefix}-`);
  homes.push(opened);
  return opened;
}
afterEach(() => {
  for (const opened of homes.splice(0)) opened.close();
});

const labels = (h: TestHome) => h.read((view) => {
  const read = readLabels(view, null, NETWORKED);
  return { version: read.version, b: read.person("person-b@example.com")?.name, c: read.person("person-c@example.com")?.name, phone: read.person("+15550000002")?.name };
});

describe("labels", () => {
  it("a contact edit that changes no name changes the labels", () => {
    const h = home("edit");
    const first = card("Person B");
    h.land(BOOK, T0, [first]);
    const before = labels(h);
    h.land(BOOK, T0 + 1, [{ ...first, content: null, gone: true }, card("Person B", "BDAY:2000-01-01\r\n")]);
    expect(labels(h)).toEqual(before);
  });

  it("a renamed contact names anyone by the old name, or asks anything", () => {
    const h = home("rename");
    const first = card("Person B");
    h.land(BOOK, T0, [first]);
    const before = labels(h);
    expect(before.b).toBe("Person B");
    expect(before.phone).toBe("Person B");
    h.land(BOOK, T0 + 1, [{ ...first, content: null, gone: true }, card("Person B Renamed")]);
    const after = labels(h);
    expect(after).toMatchObject({ b: "Person B Renamed", phone: "Person B Renamed" });
    expect(after.version).not.toBe(before.version);
    h.artifact("labels.json", { before, after });
  });

  it("a card outranks a person record, or a card outside the address books names anyone", () => {
    const h = home("ladder");
    h.land(BOOK, T0, [card("Person B")]);
    h.land(REGISTRY, T0, [person("Person C")]);
    h.land("apple-notes:person-a@example.com:macbook-pro-0001", T0, [{ ...card("Person D"), kind: "note", content: { type: "contacts.card", card: "BEGIN:VCARD\r\nFN:Person D\r\nEMAIL:person-d@example.com\r\nEND:VCARD\r\n" } }]);
    expect(labels(h)).toMatchObject({ b: "Person C", c: "Person C", phone: "Person C" });
    expect(readNamed(h, "person-d@example.com")).toBeUndefined();
  });

  it("two people who share a name are served as one, an id a record holds is served as a card's, or a merged slug's id as its own person", () => {
    const h = home("people");
    h.land(BOOK, T0, [card("Person B")]);
    h.land(REGISTRY, T0, [
      person("Person C", "person-c", [["email", "person-c@example.com", "subject"]]),
      person("Person C", "person-c-2", [["phone", "+15550000003", "subject"]]),
      person("Person C Old", "person-c-old", [["phone", "+15550000005", "subject"]], "person-c"),
    ]);
    const ids = ["+15550000002", "+15550000003", "+15550000005", "person-b@example.com", "person-c@example.com"];
    const served = h.read((view) => {
      const labels = readLabels(view, null, NETWORKED);
      expect(labels.table.people.map(([, handle]) => handle).sort()).toEqual(ids);
      return ids.map((id) => resolvedName(id, labels, NETWORKS));
    });
    expect(served).toEqual([
      ["+15550000002", "Person B", "contact", null],
      ["+15550000003", "Person C", "registry", "person-c-2"],
      ["+15550000005", "Person C", "registry", "person-c"],
      ["person-b@example.com", "Person B", "contact", null],
      ["person-c@example.com", "Person C", "registry", "person-c"],
    ]);
    const people = new Map<string, string[]>();
    for (const [id, , , slug] of served) if (slug !== null) people.set(slug, [...(people.get(slug) ?? []), id]);
    expect(Object.fromEntries(people)).toEqual({ "person-c": ["+15550000005", "person-c@example.com"], "person-c-2": ["+15550000003"] });
    const before = h.read((view) => readLabels(view, null, NETWORKED).version);
    h.land(REGISTRY, T0 + 1, [person("Person C", "person-c-2", [["phone", "+15550000003", "subject"], ["email", "person-c@example.com", "subject"]]),
      person("Person C", "person-c", [])]);
    const after = h.read((view) => readLabels(view, null, NETWORKED));
    expect(after.person("person-c@example.com")).toEqual({ id: "person:person-c-2", name: "Person C", by: "registry", slug: "person-c-2", me: false });
    expect(after.version).not.toBe(before);
    h.artifact("people.json", { served, people: Object.fromEntries(people), moved: ids.map((id) => resolvedName(id, after, NETWORKS)) });
  });
});

describe("You in the labels", () => {
  const OWN = "imessage:+15550000010:macbook-pro-0001";
  const you = (me: boolean): ReaderOutput => ({
    kind: "person", key: "sam",
    content: {
      type: "people.person", slug: "sam", name: "Sam", full_name: "Sam Example", show: "name", entity: "person", relationship: null, hidden: false, me,
      anchor: { kind: "phone", value: "+15550000010" }, handles: [{ kind: "phone", value: "+15550000011" }],
      excluded: [], dismissed: [], merged_into: null,
    },
  });

  it("a handle of You's reads as anyone but You, or the mark moves no unit", () => {
    const h = home("you");
    h.land(REGISTRY, T0, [you(false)]);
    h.land(BOOK, T0, [card("Person B")]);
    const before = h.read((view) => readLabels(view, null, NETWORKED));
    h.land(REGISTRY, T0 + 1, [you(true)]);
    const after = h.read((view) => readLabels(view, null, NETWORKED));
    const sam = { id: "person:sam", name: "Sam", by: "registry", slug: "sam" };
    expect(["+15550000010", "+15550000011"].map((id) => before.person(id))).toEqual([{ ...sam, me: false }, { ...sam, me: false }]);
    expect(["+15550000010", "+15550000011"].map((id) => after.person(id))).toEqual([{ ...sam, me: true }, { ...sam, me: true }]);
    expect(after.contents.get("phone:+15550000010")).toEqual({ person: { ...sam, me: true } });
    expect(after.table.people.filter(([, , id]) => id === "person:sam")).toEqual([
      ["phone", "+15550000010", "person:sam", "Sam", "registry", "sam", true], ["phone", "+15550000011", "person:sam", "Sam", "registry", "sam", true],
    ]);
    expect(after.person("person-b@example.com")?.me).toBe(false);
    expect(labelTable([...after.contents].map(([unit, content]) => ({ unit, content })))).toEqual(after.table);
    expect(after.version).not.toBe(before.version);
    h.artifact("you.json", { before: before.table.people, after: after.table.people });
  });

  it("a record that claims the home's own account is You with no mark, or an own account no record claims is anyone's", () => {
    const h = home("own");
    h.land(REGISTRY, T0, [you(false)]);
    h.land(OWN, T0, []);
    const claimed = h.read((view) => readLabels(view, null, NETWORKED));
    const sam = { id: "person:sam", name: "Sam", by: "registry", slug: "sam", me: true };
    expect(["+15550000010", "+15550000011"].map((id) => claimed.person(id))).toEqual([sam, sam]);
    const alone = home("own-alone");
    alone.land(OWN, T0, []);
    const holder = alone.read((view) => readLabels(view, null, NETWORKED));
    expect(holder.person("+15550000010")?.me).toBe(true);
    expect(holder.contents.has("phone:+15550000010")).toBe(true);
  });

  it("a unit stored under code 8, which holds no `me`, reads as You or fails to read", () => {
    const stored = { person: { id: "person:sam", name: "Sam", by: "registry", slug: "sam" } };
    const labels = labelsFrom((unit) => (unit === "phone:+15550000010" ? { content: stored } : undefined), { zone: "UTC", day_start_hour: 0 });
    expect(labels.person("+15550000010")).toEqual({ id: "person:sam", name: "Sam", by: "registry", slug: "sam", me: false });
    expect(labelTable([{ unit: "phone:+15550000010", content: stored }]).people).toEqual([["phone", "+15550000010", "person:sam", "Sam", "registry", "sam", false]]);
  });
});

function readNamed(h: TestHome, id: string): string | undefined {
  return h.read((view) => readLabels(view, null, NETWORKED).person(id)?.name);
}

describe("a place of several circles", () => {
  const at = (east: number, north = 0) => ({ latitude: Math.round((north / 111_320) * 1e6) / 1e6, longitude: Math.round((east / 111_320) * 1e6) / 1e6 });
  const place = (name: string, centre: { latitude: number; longitude: number }, radius_m: number, also?: { centre: { latitude: number; longitude: number }; radius_m: number }[]) =>
    ({ type: "places.place", name, centre, radius_m, ids: [], ...(also === undefined ? {} : { also }) });

  it("a place without `also` reads and stores as before; one with it names a point in any circle by the smallest holding one; part of and inside by the first circle alone", () => {
    const h = home("circles");
    h.land(PLACES, T0, [
      { kind: "place", key: "harbour", content: place("Harbour Home", at(0), 100, [{ centre: at(1_000), radius_m: 60 }]) },
      { kind: "place", key: "park", content: place("Big Park", at(1_000, 100), 500) },
      { kind: "place", key: "cafe", content: place("Kiln Coffee", at(-3_000), 80) },
    ]);
    const read = h.read((view) => readLabels(view, HOME, NETWORKED));
    const table = read.table;
    expect(table.places.map(({ slug, also }) => [slug, also])).toEqual([["cafe", []], ["harbour", [{ ...at(1_000), radius_m: 60 }]], ["park", []]]);
    const stored = read.contents.get("places") as { places: Record<string, unknown>[] };
    expect(stored.places.map((each) => [each.slug, "also" in each])).toEqual([["cafe", false], ["harbour", true], ["park", false]]);
    expect(placesUnit({ content: stored as never })).toEqual({ places: table.places, google: [], hidden: [] });
    expect(placeOf(at(1_010), table)).toEqual({ slug: "harbour", name: "Harbour Home", ...at(1_000), radius_m: 60 });
    expect(read.place(at(1_010).latitude, at(1_010).longitude)).toMatchObject({ slug: "harbour", radius_m: 60 });
    expect(placeOf(at(20), table)).toEqual({ slug: "harbour", name: "Harbour Home", ...at(0), radius_m: 100 });
    expect(placeOf(at(1_300, 100), table)).toMatchObject({ slug: "park", radius_m: 500 });
    expect(placeOf(at(-1_500), table)).toBeNull();
    const near = nearestPlace(at(1_030), table)!;
    expect([near.place.slug, Math.round(near.distance_m)]).toEqual(["harbour", Math.round(distanceMeters(at(1_030), at(1_000)))]);
    const harbour = table.places.find((each) => each.slug === "harbour")!;
    const park = table.places.find((each) => each.slug === "park")!;
    expect(partOf(harbour, table)).toBeNull();
    expect(placesInside(park, table)).toEqual([]);
    h.artifact("circles.json", { table, stored });
  });
});

const TAKES_IN = join(fileURLToPath(new URL("../../../", import.meta.url)), "homelink", "Tests", "Fixtures", "rules", "takes-in.json");

interface TakesInCase {
  about: string;
  circle: NamedCircle;
  others: NamedCircle[];
  points: StayPoint[];
  stated: number;
}

function below(value: number): number {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) - 1n);
  return bits.getFloat64(0);
}

function takesInCases(): TakesInCase[] {
  const at = (east: number, north = 0): Point => ({ latitude: Math.round((north / 111_320) * 1e6) / 1e6, longitude: Math.round((east / 111_320) * 1e6) / 1e6 });
  const circle = (slug: string, centre: Point, radius_m: number): NamedCircle => ({ slug, ...centre, radius_m });
  const stays = (where: Point, count: number): StayPoint => ({ ...where, count });
  const edge = distanceMeters(at(70, 30), at(0));
  return [
    { about: "No points: nothing is taken in.", circle: circle("harbour", at(0), 100), others: [], points: [], stated: 0 },
    { about: "A point in no circle is taken in by none.", circle: circle("harbour", at(0), 100), others: [circle("park", at(1_000), 200)], points: [stays(at(500), 3)], stated: 0 },
    {
      about: "Every point the circle alone holds counts with its count of stays, a spot worth naming or not (the Mac today counts only the spots worth naming).",
      circle: circle("harbour", at(0), 100), others: [], points: [stays(at(10), 2), stays(at(-50, 20), 1), stays(at(300), 4)], stated: 3,
    },
    {
      about: "A point exactly on the edge is inside: inside is a haversine distance on a 6371008.8 m earth at most the radius, with no tolerance beside it.",
      circle: circle("harbour", at(0), edge), others: [], points: [stays(at(70, 30), 5)], stated: 5,
    },
    {
      about: "The same point with the radius one floating-point step shorter is outside.",
      circle: circle("harbour", at(0), below(edge)), others: [], points: [stays(at(70, 30), 5)], stated: 0,
    },
    {
      about: "Nested circles: a point both hold goes to the smaller, so the larger takes in only what the smaller leaves (both apps today count every point inside the circle).",
      circle: circle("park", at(0), 500), others: [circle("harbour", at(0), 100)], points: [stays(at(20), 5), stays(at(300), 2)], stated: 2,
    },
    {
      about: "Nested circles, the smaller edited: it takes in every point it holds, the larger's too.",
      circle: circle("harbour", at(0), 100), others: [circle("park", at(0), 500)], points: [stays(at(20), 5), stays(at(300), 2)], stated: 5,
    },
    {
      about: "Equal radii: a point both hold goes to the nearer centre.",
      circle: circle("cafe", at(0), 100), others: [circle("harbour", at(120), 100)], points: [stays(at(50), 3), stays(at(70), 4)], stated: 3,
    },
    {
      about: "Equal radii and equal distance: the lower slug wins, here the edited circle.",
      circle: circle("cafe", at(-60), 100), others: [circle("harbour", at(60), 100)], points: [stays(at(0), 2)], stated: 2,
    },
    {
      about: "Equal radii and equal distance: the lower slug wins, here the other circle.",
      circle: circle("park", at(-60), 100), others: [circle("harbour", at(60), 100)], points: [stays(at(0), 2)], stated: 0,
    },
    {
      about: "A circle among others of the same slug stands for its place: a point the place's other circle wins counts for it.",
      circle: circle("harbour", at(0), 100), others: [circle("harbour", at(1_000), 60), circle("park", at(1_000, 100), 500)],
      points: [stays(at(1_010), 2), stays(at(1_300, 100), 6), stays(at(20), 1)], stated: 3,
    },
    {
      about: "A new circle sits on the spot to name, as wide as a stay's reach, and takes in that spot.",
      circle: { slug: "new", ...newCircle(at(400)) }, others: [circle("harbour", at(0), 100)], points: [stays(at(400), 7), stays(at(400 + PLACE_REACH_M + 5), 1)], stated: 7,
    },
  ];
}

function tableOf(circles: readonly NamedCircle[]): { places: Place[]; google: []; hidden: [] } {
  const places = new Map<string, Place>();
  for (const { slug, latitude, longitude, radius_m } of circles) {
    const place = places.get(slug);
    if (place === undefined) places.set(slug, { slug, name: slug, latitude, longitude, radius_m, also: [], ids: [] });
    else place.also.push({ latitude, longitude, radius_m });
  }
  return { places: [...places.values()], google: [], hidden: [] };
}

describe("what a circle takes in", () => {
  it("counts the stays whose winning circle is the edited one, by the rule placeOf places them, and writes takes-in.json from it", () => {
    const cases = takesInCases();
    for (const each of cases) {
      const taken = takesIn(each.circle, each.others, each.points);
      expect(taken, each.about).toBe(each.stated);
      const table = tableOf([each.circle, ...each.others]);
      const placed = each.points.reduce((sum, point) => sum + (placeOf(point, table)?.slug === each.circle.slug ? point.count : 0), 0);
      expect(placed, each.about).toBe(taken);
    }
    const fixture = {
      about: "What a place's circle takes in while it is dragged (packages/families/shared/places.ts, takesIn): the stays of every point whose winning circle, among `others` and `circle`, has the circle's slug. A circle holds a point when the haversine distance to its centre (earth radius 6371008.8 m) is at most its radius; of the circles holding a point the smallest wins, then the nearest centre, then the lowest slug. Written by packages/families/shared/labels.e2e.test.ts from takesIn itself; both apps' drag tests read it case by case.",
      cases: cases.map(({ about, circle, others, points }) => ({ about, circle, others, points, takes_in: takesIn(circle, others, points) })),
    };
    const written = `${JSON.stringify(fixture, null, 2)}\n`;
    if (process.env.LIFESTREAM_FIXTURES === "write") {
      mkdirSync(dirname(TAKES_IN), { recursive: true });
      writeFileSync(TAKES_IN, written);
    }
    const held = existsSync(TAKES_IN) ? readFileSync(TAKES_IN, "utf8") : "";
    expect(held, "homelink/Tests/Fixtures/rules/takes-in.json is this rule: LIFESTREAM_FIXTURES=write writes it").toBe(written);
    expect(JSON.parse(held)).toEqual(fixture);
  });
});
