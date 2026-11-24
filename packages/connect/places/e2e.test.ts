import { describe, expect, it } from "vitest";
import { artifact, collect, deliver, openTestHome } from "../test/drive.js";
import { STATEMENTS_FILE } from "../shared/statements.js";
import { googlePlaceNames, placesHome } from "./reader.js";

const PLACES = "places:local:macbook-pro-0001";
const GOOGLE = "google-maps:person-a@example.com:lookup";
const DEVICE = "iphone-17-pro-aa01";
const statements = (lines: unknown[]) => Buffer.from(lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""));
const place = (name: string, radius_m = 150, ids: string[] = []) => ({ type: "places.place", name, centre: { latitude: 0.5, longitude: -0.25 }, radius_m, ids });
const facts = (fetched_at: string) => ({ fetched_at, device: DEVICE });

describe("the owner's places and Google's names: each of these is impossible", () => {
  it("P1 P2: a place or a name of another shape lands, refuses its neighbours, or is not named by its line", async () => {
    const home = openTestHome();
    const good = { kind: "place", key: "krux-gym-3f9a2c", content: { ...place("Krux Gym"), home: false } };
    const circle = (radius_m = 80, centre = { latitude: 0.51, longitude: -0.25 }) => ({ centre, radius_m });
    const bad: [string, unknown][] = [
      ["a radius too small", { kind: "place", key: "pond", content: place("Pond", 5) }],
      ["a radius too large", { kind: "place", key: "pond", content: place("Pond", 2_500) }],
      ["a name untrimmed", { kind: "place", key: "pond", content: place(" Pond") }],
      ["a name empty", { kind: "place", key: "pond", content: place("") }],
      ["a centre out of range", { kind: "place", key: "pond", content: { ...place("Pond"), centre: { latitude: 91, longitude: 0 } } }],
      ["ids unsorted", { kind: "place", key: "pond", content: place("Pond", 150, ["google:b", "google:a"]) }],
      ["ids repeated", { kind: "place", key: "pond", content: place("Pond", 150, ["google:a", "google:a"]) }],
      ["an id no provider's", { kind: "place", key: "pond", content: place("Pond", 150, ["not an id"]) }],
      ["a member more", { kind: "place", key: "pond", content: { ...place("Pond"), slug: "pond" } }],
      ["a home not true or false", { kind: "place", key: "pond", content: { ...place("Pond"), home: "yes" } }],
      ["a member less", { kind: "place", key: "pond", content: { type: "places.place", name: "Pond", centre: { latitude: 0, longitude: 0 }, radius_m: 150 } }],
      ["an id that is no id", { kind: "place", key: "Krux Gym", content: place("Krux Gym") }],
      ["another kind", { kind: "person", key: "pond", content: place("Pond") }],
      ["content and gone", { kind: "place", key: "pond", content: place("Pond"), gone: true }],
      ["content null", { kind: "place", key: "pond", content: null }],
      ["no other circle in also", { kind: "place", key: "pond", content: { ...place("Pond"), also: [] } }],
      ["20 other circles", { kind: "place", key: "pond", content: { ...place("Pond"), also: Array.from({ length: 20 }, () => circle()) } }],
      ["another circle too small", { kind: "place", key: "pond", content: { ...place("Pond"), also: [circle(5)] } }],
      ["another circle too large", { kind: "place", key: "pond", content: { ...place("Pond"), also: [circle(2_500)] } }],
      ["another circle out of range", { kind: "place", key: "pond", content: { ...place("Pond"), also: [circle(80, { latitude: 0, longitude: 181 })] } }],
      ["another circle a member more", { kind: "place", key: "pond", content: { ...place("Pond"), also: [{ ...circle(), name: "Pond" }] } }],
      ["also no list", { kind: "place", key: "pond", content: { ...place("Pond"), also: circle() } }],
      ["a hidden circle of another radius", { kind: "hidden", key: "hidden-1a2b3c", content: { type: "places.hidden", centre: { latitude: 0.5, longitude: -0.25 }, radius_m: 200 } }],
      ["not JSON", "{not json"],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, PLACES, { [STATEMENTS_FILE]: statements([good, line, good]) }, facts("2026-10-14T08:00:00.123Z"));
      const rows = await collect(placesHome.read(delivery, home.blobs));
      expect(rows.map((row) => [row.locator, row.refused === undefined]), name).toEqual([[`${STATEMENTS_FILE}:1`, true], [`${STATEMENTS_FILE}:2`, false], [`${STATEMENTS_FILE}:3`, true]]);
      expect(rows[1]!.refused, name).toContain(`${STATEMENTS_FILE} line 2`);
      refusals[name] = rows[1]!.refused!;
    }
    const google = { kind: "place", key: "google:synthetic-place-c", content: { type: "google.place", id: "synthetic-place-c", name: "Synthetic Cafe", centre: { latitude: 1, longitude: 1 } } };
    const elsewhere = { ...google, key: "google:synthetic-place-d" };
    const named = deliver(home, GOOGLE, { [STATEMENTS_FILE]: statements([google, elsewhere]) }, facts("2026-10-14T08:00:00.123Z"));
    const names = await collect(googlePlaceNames.read(named, home.blobs));
    expect(names.map((row) => [row.locator, row.refused])).toEqual([[`${STATEMENTS_FILE}:1`, undefined], [`${STATEMENTS_FILE}:2`, expect.stringMatching(/line 2: its key must be google:<its id>/u)]]);
    expect(home.heads(PLACES)).toEqual([]);
    const many = { kind: "place", key: "harbour-4a4a4a", content: { ...place("Harbour"), also: Array.from({ length: 19 }, (_, index) => circle(20 + index)) } };
    const landed = deliver(home, PLACES, { [STATEMENTS_FILE]: statements([good, many]) }, facts("2026-10-14T08:00:01.123Z"));
    expect((await collect(placesHome.read(landed, home.blobs))).map((row) => [row.key, (row.content as { also?: unknown[] } | null)?.also?.length ?? 0])).toEqual([["krux-gym-3f9a2c", 0], ["harbour-4a4a4a", 19]]);
    artifact(home.dir, "refusals.json", refusals);
  });

  it("P3 P4: a statement lands without its device, at another time than its making, an older edit moves the head, or a removal loses the history", async () => {
    const home = openTestHome();
    const key = "krux-gym-3f9a2c";
    const made = (at: string, line: unknown) => deliver(home, PLACES, { [STATEMENTS_FILE]: statements([line]) }, facts(at));
    const named = await home.land(placesHome, made("2026-10-14T08:00:00.123Z", { kind: "place", key, content: place("Krux Gym") }));
    expect(named).toMatchObject({ new: 1, refused: 0 });
    const offline = await home.land(placesHome, made("2026-10-13T08:00:00.000Z", { kind: "place", key, content: place("Krux Gym Old", 60) }));
    expect(offline).toMatchObject({ late: 1 });
    expect(home.heads(PLACES)[0]).toMatchObject({ content: place("Krux Gym"), stated_ms: Date.parse("2026-10-14T08:00:00.123Z"), time: null });
    const removed = await home.land(placesHome, made("2026-10-14T09:00:00.000Z", { kind: "place", key, gone: true }));
    expect(removed).toMatchObject({ gone: 1 });
    expect(home.heads(PLACES).filter((head) => !head.gone)).toEqual([]);
    const rows = await collect(placesHome.read(made("2026-10-14T10:00:00.000Z", { kind: "place", key, content: place("Krux Gym") }), home.blobs));
    expect(rows.map((row) => [row.device, row.locator])).toEqual([[DEVICE, `${STATEMENTS_FILE}:1`]]);
    const without = deliver(home, PLACES, { [STATEMENTS_FILE]: statements([{ kind: "place", key, content: place("Krux Gym") }]) }, { fetched_at: "2026-10-14T10:00:00.000Z" });
    expect((await collect(placesHome.read(without, home.blobs))).map((row) => row.device)).toEqual(["macbook-pro-0001"]);
    for (const fact of ["snapshot_taken_at", "exported_at", "created_at"]) {
      const moved = deliver(home, PLACES, { [STATEMENTS_FILE]: statements([{ kind: "place", key, content: place("Krux Gym") }]) }, { ...facts("2026-10-14T10:00:00.000Z"), [fact]: "2026-10-14T09:00:00.000Z" });
      await expect(collect(placesHome.read(moved, home.blobs)), fact).rejects.toThrow(new RegExp(`stated at its delivery's fetched_at; its facts state ${fact}`, "u"));
    }
    artifact(home.dir, "places.json", { named, offline, removed, heads: home.heads(PLACES) });
  });
});
