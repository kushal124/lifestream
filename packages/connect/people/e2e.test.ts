import { createHash } from "node:crypto";
import { artifact, collect, CONNECT_ROOT, deliver, openTestHome, parityOf, readGolden } from "../test/drive.js";
import { calledName, foldName, MOST_CALLED, notASlug, readPersonRecord } from "@lifestreamprotocol/core";
import { Refused } from "../shared/refused.js";
import { join } from "node:path";
import type { Landed } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { readStatements, STATEMENTS_FILE } from "../shared/statements.js";
import { peopleHome } from "./reader.js";
import { PEOPLE, PEOPLE_SOURCE, peopleBytes, UNIT } from "./test/fixtures.js";

const TEST = join(CONNECT_ROOT, "people", "test");
const FETCHED = { fetched_at: "2026-09-07T04:00:00Z" };

describe("people-file connector: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected", async () => {
    const home = openTestHome();
    const people = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { "people.json": peopleBytes() }, FETCHED));
    expect(people).toMatchObject({ new: 2, refused: 0 });
    expect(home.heads(PEOPLE_SOURCE).map((head) => head.key)).toEqual(["person-b", "person-c"]);
    artifact(home.dir, "heads.json", { people, heads: home.heads(PEOPLE_SOURCE) });
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    const people = await collect(peopleHome.read(deliver(home, PEOPLE_SOURCE, { "people.json": peopleBytes() }, FETCHED), home.blobs));
    const ours = parityOf(people);
    const golden = parityOf(readGolden(join(TEST, "golden-people.json")));
    artifact(home.dir, "parity.json", { golden, ours });
    expect(ours).toEqual(golden);
    expect(people.every((row) => row.device === UNIT)).toBe(true);
  });

  it("a smaller snapshot lands a gone", async () => {
    const home = openTestHome();
    await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { "people.json": peopleBytes() }, FETCHED));
    const fewer = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { "people.json": peopleBytes(PEOPLE.slice(0, 1)) }, { fetched_at: "2026-09-20T00:00:00Z" }));
    expect(fewer).toMatchObject({ gone: 0, restated: 1 });
    expect(home.heads(PEOPLE_SOURCE).filter((head) => head.gone)).toEqual([]);
    artifact(home.dir, "heads.json", { fewer, heads: home.heads(PEOPLE_SOURCE) });
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const home = openTestHome();
    const people = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { "people.json": peopleBytes([...PEOPLE, { ...PEOPLE[0]!, name: "Person B" }]) }, FETCHED));
    expect(people.duplicated).toBe(1);
    artifact(home.dir, "landed.json", { people });
  });

  it("a person that does not read lands", async () => {
    const home = openTestHome();
    const broken = { ...PEOPLE[1]!, handles: [] };
    const landed = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { "people.json": peopleBytes([PEOPLE[0]!, broken]) }, FETCHED));
    expect(landed).toMatchObject({ new: 1, refused: 1 });
    artifact(home.dir, "landed.json", landed);
  });
});

describe("the dashboard's statements: each of these is impossible", () => {
  const DASHBOARD = "dashboard-0001";
  const FACE = `${"a".repeat(64)}:100,100,300,300`;
  const statements = (lines: unknown[]) => Buffer.from(lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""));
  const named = { ...PEOPLE[0]!, name: "Person B Renamed", handles: [{ kind: "name", value: "Person B Renamed", by: "subject", since: "2026-09-10T00:00:00Z" }], excluded: [] };

  it("S5 S4: the file and the statements do not share one source, newest winning, each at its fetched_at", async () => {
    const home = openTestHome();
    await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { "people.json": peopleBytes() }, FETCHED));
    const landed = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, {
      [STATEMENTS_FILE]: statements([
        { kind: "person", key: "person-b", content: named },
        { kind: "face", key: FACE, content: { is: "person-b" } },
        { kind: "face", key: `${"b".repeat(64)}:0,0,10,10`, content: { is_not: ["person-b", "person-c"] } },
        { kind: "face", key: `${"c".repeat(64)}:0,0,10,10`, content: { ignore: true } },
      ]),
    }, { fetched_at: "2026-09-10T08:00:00Z", device: DASHBOARD }));
    expect(landed).toMatchObject({ new: 3, changed: 1, refused: 0 });
    const heads = home.heads(PEOPLE_SOURCE);
    expect(heads.find((head) => head.key === "person-b")!.content).toEqual(named);
    expect(heads.find((head) => head.key === FACE)).toMatchObject({ kind: "face", content: { is: "person-b" }, stated_ms: Date.parse("2026-09-10T08:00:00Z"), time: null });
    const withdrawn = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([{ kind: "face", key: FACE, gone: true }]) }, { fetched_at: "2026-09-11T08:00:00Z", device: DASHBOARD }));
    expect(withdrawn).toMatchObject({ gone: 1 });
    const late = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { "people.json": peopleBytes() }, { fetched_at: "2026-09-08T00:00:00Z" }));
    expect(late).toMatchObject({ late: 1 });
    expect(home.heads(PEOPLE_SOURCE).find((head) => head.key === "person-b")!.content).toEqual(named);
    const merged = { ...PEOPLE[0]!, merged_into: "person-c" };
    const merging = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([{ kind: "person", key: "person-b", content: merged }]) }, { fetched_at: "2026-09-13T08:00:00Z", device: DASHBOARD }));
    expect(merging).toMatchObject({ changed: 1, late: 0 });
    expect(home.heads(PEOPLE_SOURCE).find((head) => head.key === "person-b")).toMatchObject({ content: merged, stated_ms: Date.parse("2026-09-13T08:00:00Z") });
    const moved = deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([{ kind: "face", key: FACE, content: { ignore: true } }]) }, { fetched_at: "2026-09-12T08:00:00Z", exported_at: "2026-09-12T07:00:00Z", device: DASHBOARD });
    await expect(collect(peopleHome.read(moved, home.blobs))).rejects.toThrow(/stated at its delivery's fetched_at; its facts state exported_at/u);
    artifact(home.dir, "statements.json", { landed, withdrawn, late, heads: home.heads(PEOPLE_SOURCE) });
  });

  it("S7: a statements delivery the dashboard sealed before the door named its device lands nothing", async () => {
    const home = openTestHome();
    const old = deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([{ kind: "face", key: FACE, content: { is: "person-b" } }]) }, { ...FETCHED, statements: 1, blobs_carried: 0 });
    const rows = await collect(peopleHome.read(old, home.blobs));
    expect(rows.map((row) => row.device)).toEqual([UNIT]);
    const landed = await home.land(peopleHome, old, rows);
    expect(landed).toMatchObject({ new: 1, refused: 0 });
    artifact(home.dir, "old.json", { landed, heads: home.heads(PEOPLE_SOURCE) });
  });

  it("S1 S2 S3 S6 S8: a statement of another shape, or a person that does not read, lands, refuses its neighbours, or is not named by its line", async () => {
    const home = openTestHome();
    const record = (slug: string, more: Record<string, unknown>) => ({
      type: "people.person", slug, name: null, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
      anchor: null, handles: [], excluded: [], dismissed: [], merged_into: null, ...more,
    });
    const good = { kind: "face", key: FACE, content: { is: "person-b" } };
    const bad: [string, unknown][] = [
      ["two kinds", { kind: "face", key: FACE, content: { is: "person-b", ignore: true } }],
      ["is_not unsorted", { kind: "face", key: FACE, content: { is_not: ["person-c", "person-b"] } }],
      ["is_not repeating", { kind: "face", key: FACE, content: { is_not: ["person-b", "person-b"] } }],
      ["is_not empty", { kind: "face", key: FACE, content: { is_not: [] } }],
      ["no slug", { kind: "face", key: FACE, content: { is: "Person B" } }],
      ["ignore false", { kind: "face", key: FACE, content: { ignore: false } }],
      ["no face key", { kind: "face", key: "a".repeat(64), content: { is: "person-b" } }],
      ["a box not whole", { kind: "face", key: `${"a".repeat(64)}:1.5,2,3,4`, content: { is: "person-b" } }],
      ["a gone person", { kind: "person", key: "person-b", gone: true }],
      ["content null", { kind: "face", key: FACE, content: null }],
      ["a face handle", { kind: "person", key: "person-b", content: { ...PEOPLE[0]!, handles: [...(PEOPLE[0]!.handles as unknown[]), { kind: "face", value: "cluster-1", by: "subject", since: "2026-09-02T00:00:00Z" }] } }],
      ["a slug that is not the key", { kind: "person", key: "person-x", content: PEOPLE[0]! }],
      ["a record naming no one", { kind: "person", key: "person-n", content: record("person-n", {}) }],
      ["a photo that is no face key", { kind: "person", key: "person-n", content: record("person-n", { name: "Person N", photo: "sha256:abc" }) }],
      ["an entity of no kind", { kind: "person", key: "person-n", content: record("person-n", { name: "Person N", entity: "robot" }) }],
      ["handles out of core's order", { kind: "person", key: "person-n", content: record("person-n", {
        name: "Person N", handles: [{ kind: "email", value: "person-n@example.com" }, { kind: "phone", value: "+15550000014" }] }) }],
      ["not JSON", "{not json"],
      ["another kind", { kind: "contact", key: "x", content: {} }],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([good, line, good]) }, { ...FETCHED, device: DASHBOARD });
      const rows = await collect(peopleHome.read(delivery, home.blobs));
      expect(rows.map((row) => [row.locator, row.refused === undefined]), name).toEqual([[`${STATEMENTS_FILE}:1`, true], [`${STATEMENTS_FILE}:2`, false], [`${STATEMENTS_FILE}:3`, true]]);
      expect(rows[1]!.refused, name).toContain(`${STATEMENTS_FILE} line 2`);
      expect(readStatements(delivery, (file) => home.blobs.bytes(file.blob), peopleHome.statements), name).toEqual(rows);
      refusals[name] = rows[1]!.refused!;
    }
    for (const files of [{}, { "people.json": peopleBytes(), [STATEMENTS_FILE]: statements([good]) }, { "other.json": Buffer.from("{}") }]) {
      const delivery = deliver(home, PEOPLE_SOURCE, files, { ...FETCHED, device: DASHBOARD });
      await expect(collect(peopleHome.read(delivery, home.blobs))).rejects.toThrow(Refused);
      expect(() => readStatements(delivery, (file) => home.blobs.bytes(file.blob), peopleHome.statements)).toThrow(Refused);
    }
    expect(home.heads(PEOPLE_SOURCE)).toEqual([]);
    artifact(home.dir, "refusals.json", refusals);
  });

  it("S9 S10 S11: a photo keyed or shaped otherwise lands, an upload's row does not name its picture, a face picked's does, or a record of the shape before reads with its photo", async () => {
    const home = openTestHome();
    const IMAGE = `sha256:${"d".repeat(64)}`;
    const upload = { type: "people.photo", image: IMAGE };
    const picked = { type: "people.photo", image: `sha256:${"e".repeat(64)}`, face: FACE };
    const keys = ["person:person-b", "phone:+15550000001", "email:person-a@example.com", "jid:900000000031@lid", `contact:${"0123456789abcdef"}`];
    const landed = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, {
      [STATEMENTS_FILE]: statements([...keys.map((key) => ({ kind: "photo", key, content: upload })), { kind: "photo", key: "person:person-c", content: picked }]),
    }, { fetched_at: "2026-09-10T08:00:00Z", device: DASHBOARD }));
    expect(landed).toMatchObject({ new: 6, refused: 0 });
    const rows = await collect(peopleHome.read(deliver(home, PEOPLE_SOURCE, {
      [STATEMENTS_FILE]: statements([{ kind: "photo", key: "person:person-b", content: upload }, { kind: "photo", key: "person:person-c", content: picked }, { kind: "photo", key: "person:person-c", gone: true }]),
    }, { fetched_at: "2026-09-11T08:00:00Z", device: DASHBOARD }), home.blobs));
    expect(rows.map((row) => [row.blobs, row.media])).toEqual([[[IMAGE], { [IMAGE]: "image/jpeg" }], [[], undefined], [undefined, undefined]]);

    const bad: [string, unknown][] = [
      ["a person: that is no slug", { kind: "photo", key: "person:Person B", content: upload }],
      ["a bare slug", { kind: "photo", key: "person-b", content: upload }],
      ["a phone not E.164", { kind: "photo", key: "phone:5550000001", content: upload }],
      ["a phone JID as a jid", { kind: "photo", key: "jid:15550000001@s.whatsapp.net", content: upload }],
      ["an address not as core spells it", { kind: "photo", key: "email:Person-A@Example.com", content: upload }],
      ["a contact id not 16 hex", { kind: "photo", key: "contact:0123", content: upload }],
      ["another kind of id", { kind: "photo", key: "name:Person B", content: upload }],
      ["another member", { kind: "photo", key: "person:person-b", content: { ...upload, crop: IMAGE } }],
      ["another type", { kind: "photo", key: "person:person-b", content: { ...upload, type: "people.person" } }],
      ["an image that is no hash", { kind: "photo", key: "person:person-b", content: { ...upload, image: "d".repeat(64) } }],
      ["an image in capitals", { kind: "photo", key: "person:person-b", content: { ...upload, image: `sha256:${"D".repeat(64)}` } }],
      ["a face that is no face key", { kind: "photo", key: "person:person-b", content: { ...picked, face: "e".repeat(64) } }],
      ["no image", { kind: "photo", key: "person:person-b", content: { type: "people.photo" } }],
      ["a key gone that names no one", { kind: "photo", key: "person-b", gone: true }],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([{ kind: "photo", key: "person:person-b", content: upload }, line]) }, { ...FETCHED, device: DASHBOARD });
      const refused = await collect(peopleHome.read(delivery, home.blobs));
      expect(refused.map((row) => [row.locator, row.refused === undefined]), name).toEqual([[`${STATEMENTS_FILE}:1`, true], [`${STATEMENTS_FILE}:2`, false]]);
      expect(refused[1]!.refused, name).toMatch(/statements\.ndjson line 2/u);
      refusals[name] = refused[1]!.refused!;
    }

    const before = { type: "people.person", slug: "person-before", name: "Person Before", full_name: null, show: "name", entity: "person", relationship: null, photo: FACE,
      hidden: false, me: false, anchor: { kind: "phone", value: "+15550000002" }, handles: [], excluded: [], dismissed: [], merged_into: null };
    const old = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([{ kind: "person", key: "person-before", content: before }]) }, { fetched_at: "2026-09-12T08:00:00Z", device: DASHBOARD }));
    expect(old).toMatchObject({ new: 1, refused: 0 });
    const read = readPersonRecord(before);
    expect(read).not.toBeNull();
    expect(Object.hasOwn(read!, "photo")).toBe(false);
    const { photo: _photo, type: _type, ...record } = before;
    expect(read).toEqual({ ...record, also_called: [] });
    expect(readPersonRecord({ ...before, entity: null })?.entity).toBeNull();
    expect(readPersonRecord({ type: "people.person", slug: "person-older", name: "Person Older", handles: [{ kind: "name", value: "Person Older", by: "subject", since: "2026-09-01T00:00:00Z" }], excluded: [], merged_into: null })?.entity).toBeNull();
    const badBefore = deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([{ kind: "person", key: "person-before", content: { ...before, photo: IMAGE } }]) }, { ...FETCHED, device: DASHBOARD });
    const badRows = await collect(peopleHome.read(badBefore, home.blobs));
    expect(badRows.map((row) => [row.locator, row.refused])).toEqual([[`${STATEMENTS_FILE}:1`, expect.stringMatching(/statements\.ndjson line 1: .*photo must be null or a face key/u)]]);
    artifact(home.dir, "photos.json", { landed, rows, refusals, before: { landed: old, read }, heads: home.heads(PEOPLE_SOURCE, ["photo"]) });
  });

  it("S13 S14: details of another shape land, details of the right shape are refused, or a detail moves the person record", async () => {
    const home = openTestHome();
    const details = (more: Record<string, unknown> = {}) => ({ type: "people.details", work: "Product designer, Synthetic Labs", birthday: { month: 8, day: 14, year: null },
      profiles: [{ network: "instagram", value: "person.b" }, { network: "site", value: "person-b.example.com/about" }], ...more });
    const keys = ["person:person-b", "phone:+15550000001", "email:person-a@example.com", "jid:900000000031@lid", `contact:${"0123456789abcdef"}`];
    const good = [
      ...keys.map((key) => ({ kind: "details", key, content: details() })),
      { kind: "details", key: "person:person-c", content: details({ work: null, birthday: { month: 2, day: 29, year: null }, profiles: [] }) },
      { kind: "details", key: "person:person-d", content: details({ work: null, birthday: null, profiles: [] }) },
      { kind: "details", key: "person:person-e", content: details({ birthday: { month: 2, day: 29, year: 2000 }, profiles: [
        { network: "x", value: "person_e" }, { network: "linkedin", value: "Person-E-Synthetic" }, { network: "facebook", value: "person.e" }, { network: "github", value: "person-e" },
        { network: "linkedin", value: "jörg-synthetic" }, { network: "site", value: "person-e.example.com/About/Me" },
        { network: "site", value: "person-e.example.org/go/https://elsewhere.example.com" }] }) },
    ];
    await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { "people.json": peopleBytes() }, FETCHED));
    const landed = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements(good) }, { fetched_at: "2026-09-10T08:00:00Z", device: DASHBOARD }));
    expect(landed).toMatchObject({ new: good.length, refused: 0 });
    const heads = home.heads(PEOPLE_SOURCE);
    expect(heads.find((head) => head.key === "person-b")!.content).toEqual(PEOPLE[0]);
    expect(heads.filter((head) => head.kind === "details").map((head) => [head.key, head.time])).toEqual(expect.arrayContaining(keys.map((key) => [key, null])));
    const withdrawn = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([{ kind: "details", key: "person:person-d", gone: true }]) },
      { fetched_at: "2026-09-11T08:00:00Z", device: DASHBOARD }));
    expect(withdrawn).toMatchObject({ gone: 1 });

    const thisYear = new Date().getUTCFullYear();
    const bad: [string, unknown][] = [
      ["another member", { kind: "details", key: "person:person-b", content: { ...details(), photo: null } }],
      ["a member missing", { kind: "details", key: "person:person-b", content: { type: "people.details", work: null, birthday: null } }],
      ["another type", { kind: "details", key: "person:person-b", content: details({ type: "people.person" }) }],
      ["work empty once trimmed", { kind: "details", key: "person:person-b", content: details({ work: "   " }) }],
      ["work over 120 characters", { kind: "details", key: "person:person-b", content: details({ work: "w".repeat(121) }) }],
      ["31 April", { kind: "details", key: "person:person-b", content: details({ birthday: { month: 4, day: 31, year: null } }) }],
      ["29 February of a year not leap", { kind: "details", key: "person:person-b", content: details({ birthday: { month: 2, day: 29, year: 1993 } }) }],
      ["month 13", { kind: "details", key: "person:person-b", content: details({ birthday: { month: 13, day: 1, year: null } }) }],
      ["a year before 1900", { kind: "details", key: "person:person-b", content: details({ birthday: { month: 8, day: 14, year: 1604 } }) }],
      ["a year after this one", { kind: "details", key: "person:person-b", content: details({ birthday: { month: 8, day: 14, year: thisYear + 1 } }) }],
      ["a birthday without its year", { kind: "details", key: "person:person-b", content: details({ birthday: { month: 8, day: 14 } }) }],
      ["a 13th profile", { kind: "details", key: "person:person-b", content: details({ profiles: Array.from({ length: 13 }, (_, n) => ({ network: "github", value: `person-${n}` })) }) }],
      ["a profile repeated", { kind: "details", key: "person:person-b", content: details({ profiles: [{ network: "x", value: "person_b" }, { network: "x", value: "person_b" }] }) }],
      ["a network none of the six", { kind: "details", key: "person:person-b", content: details({ profiles: [{ network: "myspace", value: "person-b" }] }) }],
      ["a handle in capitals", { kind: "details", key: "person:person-b", content: details({ profiles: [{ network: "instagram", value: "Person.B" }] }) }],
      ["a link where a handle goes", { kind: "details", key: "person:person-b", content: details({ profiles: [{ network: "github", value: "github.com/person-b" }] }) }],
      ["a site with its scheme", { kind: "details", key: "person:person-b", content: details({ profiles: [{ network: "site", value: "https://person-b.example.com" }] }) }],
      ["a site with its query", { kind: "details", key: "person:person-b", content: details({ profiles: [{ network: "site", value: "person-b.example.com/?ref=card" }] }) }],
      ["a site with its port", { kind: "details", key: "person:person-b", content: details({ profiles: [{ network: "site", value: "person-b.example.com:8080/about" }] }) }],
      ["a site's host in capitals", { kind: "details", key: "person:person-b", content: details({ profiles: [{ network: "site", value: "Person-B.Example.com/about" }] }) }],
      ["a value over 200 characters", { kind: "details", key: "person:person-b", content: details({ profiles: [{ network: "site", value: `person-b.example.com/${"a".repeat(180)}` }] }) }],
      ["a key that names no person", { kind: "details", key: "person-b", content: details() }],
      ["a person's slug of 65 characters", { kind: "details", key: `person:${"a".repeat(65)}`, content: details() }],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([good[0], line, good[0]]) }, { ...FETCHED, device: DASHBOARD });
      const rows = await collect(peopleHome.read(delivery, home.blobs));
      expect(rows.map((row) => [row.locator, row.refused === undefined]), name).toEqual([[`${STATEMENTS_FILE}:1`, true], [`${STATEMENTS_FILE}:2`, false], [`${STATEMENTS_FILE}:3`, true]]);
      expect(rows[1]!.refused, name).toMatch(/statements\.ndjson line 2/u);
      refusals[name] = rows[1]!.refused!;
    }
    expect(refusals["a person's slug of 65 characters"]).toContain(notASlug(`"person:${"a".repeat(65)}"'s person`));
    artifact(home.dir, "details.json", { landed, withdrawn, refusals, heads: home.heads(PEOPLE_SOURCE, ["details"]) });
  });

  it("S15 S16: a record with Also called or a details statement with cleared refused, or one of another shape landing", async () => {
    const home = openTestHome();
    const recordOf = (slug: string, more: Record<string, unknown> = {}) => ({
      type: "people.person", slug, name: "Person N", full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
      anchor: null, handles: [], excluded: [], dismissed: [], also_called: ["Bear", "Nico"], merged_into: null, ...more,
    });
    const { also_called: _called, ...withoutList } = recordOf("person-old");
    const older = (more: Record<string, unknown> = {}) => ({
      type: "people.person", slug: "person-o", name: "Person O", excluded: [], merged_into: null,
      handles: [{ kind: "name", value: "Person O", by: "subject", since: "2025-01-01T00:00:00Z" }, { kind: "phone", value: "+1 555 000 0181", by: "subject", since: "2025-01-01T00:00:00Z" }], ...more,
    });
    const detailsOf = (more: Record<string, unknown> = {}) => ({ type: "people.details", work: "Product designer", birthday: null, profiles: [], cleared: ["birthday", "profiles"], ...more });
    const good = [
      { kind: "person", key: "person-n", content: recordOf("person-n") },
      { kind: "person", key: "person-empty", content: recordOf("person-empty", { also_called: [] }) },
      { kind: "person", key: "person-old", content: withoutList },
      { kind: "person", key: "person-o", content: older() },
      { kind: "person", key: "person-twelve", content: recordOf("person-twelve", { also_called: Array.from({ length: MOST_CALLED }, (_, n) => `Nick ${String.fromCharCode(65 + n)}`) }) },
      { kind: "details", key: "person:person-n", content: detailsOf() },
      { kind: "details", key: "person:person-c", content: detailsOf({ work: null, cleared: ["work"] }) },
      { kind: "details", key: "person:person-d", content: detailsOf({ cleared: undefined }) },
    ];
    const landed = await home.land(peopleHome, deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements(good) }, { fetched_at: "2026-09-10T08:00:00Z", device: DASHBOARD }));
    expect(landed).toMatchObject({ new: good.length, refused: 0 });
    const heads = home.heads(PEOPLE_SOURCE);
    const read = (key: string) => readPersonRecord(heads.find((head) => head.key === key)!.content)!.also_called;
    expect([read("person-n"), read("person-empty"), read("person-old"), read("person-o")]).toEqual([["Bear", "Nico"], [], [], []]);
    expect([calledName("  Big \t Bear "), calledName(""), calledName("x".repeat(61)), calledName("Bear\u0007"), calledName("Ñ".repeat(60))]).toEqual(["Big Bear", null, null, null, "Ñ".repeat(60)]);
    expect(foldName("Zoë  Example")).toBe("zoe example");

    const bad: [string, unknown][] = [
      ["an unsorted list", { kind: "person", key: "person-n", content: recordOf("person-n", { also_called: ["Nico", "Bear"] }) }],
      ["a repeat", { kind: "person", key: "person-n", content: recordOf("person-n", { also_called: ["Bear", "Bear"] }) }],
      ["two that fold alike", { kind: "person", key: "person-n", content: recordOf("person-n", { also_called: ["Zoë", "zoe"] }) }],
      ["a 61-character name", { kind: "person", key: "person-n", content: recordOf("person-n", { also_called: ["n".repeat(61)] }) }],
      ["a name not made one way", { kind: "person", key: "person-n", content: recordOf("person-n", { also_called: ["Big  Bear"] }) }],
      ["an empty name", { kind: "person", key: "person-n", content: recordOf("person-n", { also_called: [""] }) }],
      ["13 names", { kind: "person", key: "person-n", content: recordOf("person-n", { also_called: Array.from({ length: MOST_CALLED + 1 }, (_, n) => `Nick ${String.fromCharCode(65 + n)}`) }) }],
      ["no list", { kind: "person", key: "person-n", content: recordOf("person-n", { also_called: "Bear" }) }],
      ["photo with the list", { kind: "person", key: "person-n", content: recordOf("person-n", { photo: null }) }],
      ...[["Bear"], "Bear"].map((also_called): [string, unknown] => [`the older shape with ${JSON.stringify(also_called)}`, { kind: "person", key: "person-o", content: older({ also_called }) }]),
      ["cleared unsorted", { kind: "details", key: "person:person-n", content: detailsOf({ cleared: ["profiles", "birthday"] }) }],
      ["cleared repeated", { kind: "details", key: "person:person-n", content: detailsOf({ cleared: ["birthday", "birthday"] }) }],
      ["cleared naming another field", { kind: "details", key: "person:person-n", content: detailsOf({ cleared: ["photo"] }) }],
      ["cleared naming a field that holds a value", { kind: "details", key: "person:person-n", content: detailsOf({ cleared: ["work"] }) }],
      ["cleared naming profiles that hold one", { kind: "details", key: "person:person-n", content: detailsOf({ profiles: [{ network: "github", value: "person-n" }], cleared: ["profiles"] }) }],
      ["cleared empty", { kind: "details", key: "person:person-n", content: detailsOf({ cleared: [] }) }],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, PEOPLE_SOURCE, { [STATEMENTS_FILE]: statements([good[0], line]) }, { ...FETCHED, device: DASHBOARD });
      const rows = await collect(peopleHome.read(delivery, home.blobs));
      expect(rows.map((row) => [row.locator, row.refused === undefined]), name).toEqual([[`${STATEMENTS_FILE}:1`, true], [`${STATEMENTS_FILE}:2`, false]]);
      expect(rows[1]!.refused, name).toMatch(/statements\.ndjson line 2/u);
      refusals[name] = rows[1]!.refused!;
    }
    expect(refusals["two that fold alike"]).toContain("fold alike");
    expect(refusals['the older shape with ["Bear"]']).toContain("content must hold exactly");
    expect(refusals["cleared naming a field that holds a value"]).toContain("cleared names work, which holds a value");
    artifact(home.dir, "also-called.json", { landed, refusals, heads: home.heads(PEOPLE_SOURCE) });
  });

  it("S12: the door's picture rule takes an upload that will not land, or refuses a square that does", () => {
    const rule = peopleHome.statements.photo!.picture!;
    const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const jpeg = (...segments: string[]) => Buffer.from(`ffd8${segments.join("")}ffda`, "hex");
    const frame = (marker: string, side: number) => `ff${marker}0011080${side.toString(16).padStart(3, "0")}0${side.toString(16).padStart(3, "0")}03012200021101031101`;
    const APP1 = "ffe1000a4578696600004d4d";
    const judged = (bytes: Buffer, image = sha(bytes)) => rule({ type: "people.photo", image }, {
      carried: (hash) => hash === image ? { size: bytes.length, bytes: () => bytes } : undefined,
      held: () => false,
    });
    const answers = {
      baseline: judged(jpeg(frame("c0", 160))),
      progressive: judged(jpeg(frame("c2", 1024))),
      "APP1 before the frame": judged(jpeg(APP1, frame("c0", 512))),
      "bytes not their hash": judged(jpeg(frame("c0", 160)), `sha256:${"a".repeat(64)}`),
      "a frame header of length 2": judged(Buffer.from("ffd8ffc000020800010001", "hex")),
      "a frame header under its components": judged(jpeg("ffc0000b0800a000a003012200")),
      "a frame header past the bytes": judged(Buffer.from(`ffd8${frame("c0", 160).slice(0, 24)}`, "hex")),
    };
    expect(answers).toEqual({
      baseline: undefined, progressive: undefined, "APP1 before the frame": undefined,
      "bytes not their hash": `its picture's bytes are not sha256:${"a".repeat(64)}`,
      "a frame header of length 2": "its picture is no JPEG",
      "a frame header under its components": "its picture is no JPEG",
      "a frame header past the bytes": "its picture is no JPEG",
    });
  });
});
