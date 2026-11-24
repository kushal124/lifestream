import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { calledId, contactId, contactPersonId, sameIdOf } from "@lifestreamprotocol/families";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { readSealed } from "./inbox.js";
import { forgetRequests, KEPT_MS, OwnerWriter, type Drafter, type WriterHost } from "./owner-act.js";
import { oneYou } from "./people-draft.js";
import { NOT_BEGUN, NOT_NOW } from "./refusal.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { editSettings, testSocket } from "./test/folder.js";
import { ChildHome, freeSpace, LOOK_MS, makeRoot, readHome, removeRoot, REPO, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { acquisitionBundle, DEVICE } from "./test/support.js";
import { openHome as openHomeDb, openHomeFolder, OWNER_REQUEST } from "@lifestreamprotocol/core";


const UNIT = "macbook-pro-0001";
const PEOPLE = `people:local:${UNIT}`;
const PLACES = `places:local:${UNIT}`;
const DEVICES = `devices:local:${UNIT}`;
const FACES = `faces:local:${UNIT}`;
const BOOK = `apple-contacts:local:${UNIT}`;
const WHATSAPP = `whatsapp:15550000100:${UNIT}`;
const REGISTRY = join(REPO, "packages", "home", "test", "people-registry.ts");
const READER = "synthetic-act-reader".padEnd(43, "r");
const DASHBOARD = "synthetic-act-dashboard".padEnd(43, "d");
const PHONE = "synthetic-act-phone".padEnd(43, "p");
const DASHBOARD_UNIT = `dashboard-${UNIT}`;
const PHONE_UNIT = "iphone-act-aa07";
const T = Date.parse("2026-10-01T10:00:00Z");
const MINUTE = 60_000;

type Body = Record<string, any>;

const card = (...lines: string[]) => {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.map((line) => `${line}\r\n`).join("")}END:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
};
const record = (slug: string, phone: string, name: string) => ({
  type: "people.person", slug, name, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
  anchor: { kind: "phone", value: phone }, handles: [], excluded: [], dismissed: [], merged_into: null,
});
const statements = (lines: object[]) => ({ "statements.ndjson": Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) });
const BOX = [10, 10, 50, 50];
const faceOf = (name: string) => `${createHash("sha256").update(`synthetic photo ${name}`).digest("hex")}:${BOX.join(",")}`;
const crop = (name: string) => `sha256:${createHash("sha256").update(`synthetic crop ${name}`).digest("hex")}`;
const cluster = (key: string, members: string[]) => ({
  kind: "cluster", key, content: { size: members.length, photos: members.length, years: [2026, 2026], year_count: 1,
    faces: members.map((name) => ({ face: faceOf(name), at_ms: T, crop: crop(name) })), outliers: [], chat_share: 0, suggested: [], evidence: { senders: [], labels: [] }, rule: "0".repeat(64) },
});
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const segment = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
const jpeg = (name: string, width: number, height = width, pad = 0) => Buffer.concat([
  Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")), segment(0xfe, Buffer.from(`synthetic picture ${name}`)),
  segment(0xc0, Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0])), segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  Buffer.alloc(pad), Buffer.from([0xff, 0xd9]),
]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("synthetic png bytes")]);
const seq = (position: string) => Number(position.split(":")[0]);
const APPLE_EPOCH_S = 978_307_200;
const wa = (stanza: string, chat: string, when: number) => {
  const date = when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: stanza, ZTEXT: `synthetic line ${stanza}`, ZFROMJID: chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: 0, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: 0, ZSTARRED: 0,
  };
  return { kind: "msg", key: `${chat}:${stanza}`, at: when, content: { type: "whatsapp.msg", message, session_jid: chat, parent_stanza_id: null, media_item: null, group_member_jid: null, blobs: [] } };
};

function homeRoot(prefix: string): string {
  const root = makeRoot(prefix, { sources: { [BOOK]: "people-rows", [FACES]: "faces", [PEOPLE]: "people-home" }, settings: { unit: UNIT } });
  const principals = openHomeFolder(root);
  mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
  mintPrincipal(principals, { unit: DASHBOARD_UNIT, scopes: ["read", "deliver"], sources: [PEOPLE, PLACES, DEVICES], token: DASHBOARD, now_ms: 0 });
  mintPrincipal(principals, { unit: PHONE_UNIT, kind: "phone", scopes: ["deliver", "read"], sources: [PEOPLE, PLACES, DEVICES], token: PHONE, now_ms: 0 });
  return root;
}

function through(root: string, url: () => string) {
  const passHeaders = (token: string) => ({ authorization: `Bearer ${token}`, ...(token === PHONE ? DEVICE.phone : {}) });
  const act = async (action: unknown, token = DASHBOARD): Promise<{ status: number; body: Body }> => {
    const response = await fetch(`${url()}/v1/owner/act`, {
      method: "POST", headers: { ...passHeaders(token), "content-type": "application/json" }, body: typeof action === "string" ? action : JSON.stringify({ of: "people", ...action as Body }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? {} : JSON.parse(text) as Body };
  };
  const get = async (path: string): Promise<{ status: number; body: Body }> => {
    const response = await fetch(`${url()}${path}`, { headers: passHeaders(READER) });
    const text = await response.text();
    return { status: response.status, body: text === "" ? {} : JSON.parse(text) as Body };
  };
  const deliveries = (source = PEOPLE) => readHome(root, (db) => (db.prepare("SELECT id, state, sealed_ms, facts FROM deliveries WHERE source = ? ORDER BY sealed_ms, id").all(source) as { id: string; state: string; sealed_ms: number; facts: string }[])
    .map((row) => ({ id: row.id, state: row.state, sealed_ms: row.sealed_ms, facts: JSON.parse(row.facts) as Body })));
  const owned = () => [PEOPLE, PLACES, DEVICES].reduce((sum, source) => sum + deliveries(source).length, 0);
  return {
    act, get,
    async ok(action: Body, token = DASHBOARD): Promise<{ act: string | null; id: string | null; position: string }> {
      const answer = await act(action, token);
      expect(answer, `${action.kind} ${action.request}`).toMatchObject({ status: 200, body: { position: expect.stringMatching(/^\d+:\d+$/u) } });
      expect(Object.keys(answer.body).sort()).toEqual(["act", "id", "position"]);
      return answer.body as never;
    },
    async refused(action: unknown, status: number, code: string, token = DASHBOARD): Promise<Body> {
      const before = owned();
      const answer = await act(action, token);
      expect({ status: answer.status, code: answer.body.code, message: answer.body.message }, JSON.stringify(action).slice(0, 160)).toMatchObject({ status, code });
      expect(owned()).toBe(before);
      return answer.body;
    },
    deliveries, owned,
    person: async (id: string) => {
      const answer = await get(`/v1/people?id=${encodeURIComponent(id)}`);
      expect(answer.status, id).toBe(200);
      return answer.body as { position: string; person: Body };
    },
    stated: async (kind: string, key: string, source = PEOPLE): Promise<Body | null> => {
      const answer = await get(`/v1/record?${new URLSearchParams({ source, kind, key })}`);
      return answer.status === 200 ? answer.body.version?.content ?? null : null;
    },
    manifest: (act: string) => readSealed(openHomeFolder(root), join(root, "inbox", act))!,
    settled: () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state IN ('sealed', 'importing')").pluck().get() === 0
      && db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get() === 0),
    heard: (position: string) => readHome(root, (db) => (db.prepare("SELECT detail FROM events WHERE kind = 'people'").pluck().all() as string[])
      .some((detail) => seq((JSON.parse(detail) as { position: string }).position) >= seq(position))),
    meta: (key: string) => readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string | undefined),
  };
}

describe("People's one writer, through the door", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  let at: ReturnType<typeof through>;
  const report: Record<string, unknown> = {};
  const cases: Body[] = [];
  const logged: Body[] = [];
  const start = async () => {
    home = await startHome(root, { registry: REGISTRY, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: (line) => logged.push(JSON.parse(line) as Body) });
  };
  const bounds = new Set<() => void>();
  const shownAfter = async (id: string) => {
    const answer = await at.get(`/v1/people?${new URLSearchParams({ id, settled: "1" })}`);
    expect([answer.status, answer.body.person?.counting], `${id}, read settled: nothing counting`).toEqual([200, undefined]);
    return answer.body.person as Body;
  };
  const acted = async (what: string, action: Body, id: string | null, token = DASHBOARD) => {
    const before = id === null ? null : (await at.get(`/v1/people?id=${encodeURIComponent(id)}`)).body;
    const answer = await at.ok(action, token);
    const right = id === null ? null : (await at.get(`/v1/people?id=${encodeURIComponent(id)}`)).body;
    const manifest = answer.act === null ? null : at.manifest(answer.act);
    cases.push({ case: what, action: { ...action, ...(typeof action.upload === "string" ? { upload: `${action.upload.length} base64` } : {}) }, answer, facts: manifest?.facts ?? null, before, right_after: right });
    return { answer, manifest };
  };

  beforeAll(async () => {
    root = homeRoot("lifestream-owner-act-");
    at = through(root, () => url);
    await start();
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, {
      log: () => undefined, registry: REGISTRY, beats: { settled: (end) => { bounds.add(end); return () => { bounds.delete(end); }; } },
    });
    url = `http://127.0.0.1:${door.port}`;
    await ship(root, {
      source: BOOK, fetched_ms: T, rows: [
        card("FN:Person R", "TEL;TYPE=CELL:+15550000121", "EMAIL:person-r@example.com"), card("FN:Person S", "TEL;TYPE=CELL:+15550000131"),
        card("ORG:Synthetic Bakery", "TEL:+15550000141"), card("FN:Person Q", "TEL;TYPE=CELL:+15550000161"), card("FN:Person X", "TEL;TYPE=CELL:+15550000171"),
        card("FN:Person Card Only"), card("FN:Synthetic Gym", "TEL:+15550000151"),
      ] as never,
    });
    await ship(root, {
      source: WHATSAPP, fetched_ms: T, rows: [{
        kind: "business", key: "90000000000151@lid",
        content: { type: "whatsapp.business", ZJID: "90000000000151@lid", ZPHONENUMBERJID: "15550000151@s.whatsapp.net", ZNAME: "Synthetic Gym", ZVERIFICATIONLEVEL: 3 },
      }] as never,
      facts: { sources: [{ id: WHATSAPP, connector: "people-rows" }] },
    });
    await shipFiles(root, PEOPLE, T + MINUTE, statements([{ kind: "person", key: "person-p", content: record("person-p", "+15550000112", "Person P") }]));
    await ship(root, { source: FACES, fetched_ms: T + 2 * MINUTE, rows: [cluster("c1", ["f1", "f2", "f3"]), cluster("c2", ["f4", "f5"]), cluster("c3", ["f6", "f7"])] as never });
    await until("the cast landed and People prepared it", async () => at.settled()
      && (await at.get(`/v1/people?id=${encodeURIComponent("phone:+15550000171")}`)).status === 200
      && (await at.get(`/v1/people?id=${encodeURIComponent("phone:+15550000112")}`)).body.person?.id === "person:person-p"
      && (await at.get(`/v1/people?id=${encodeURIComponent("phone:+15550000151")}`)).body.person?.entity === "business");
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    report.cases = cases;
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "owner-act.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("A1-A6: a card's answer lands whole, once, in order, by the person's id, read on the next read, in one turn whose request line names its parts, and every refusal says its code and seals nothing", async () => {
    const R = "phone:+15550000121";
    const S = "phone:+15550000131";
    const first = { kind: "confirm", request: randomUUID(), id: R, name: "Ree", relationship: "friend", add: [S], unlink: ["email:person-r@example.com"], groups: ["c1"],
      details: { work: "  Example   Co ", birthday: { month: 8, day: 14 } } };
    const { answer, manifest } = await acted("a confirm with every member", first, R);
    expect(logged.filter((line) => line.request === "owner-act").at(-1)).toEqual({
      at: expect.any(String), request: "owner-act", queued_ms: expect.any(Number), ran_ms: expect.any(Number), cpu_ms: expect.any(Number),
      draft_ms: expect.any(Number), seal_ms: expect.any(Number), land_ms: expect.any(Number), work_ms: expect.any(Number), due_ms: expect.any(Number), commit_ms: expect.any(Number), answer: "ok",
    });
    expect(answer.id).toBe("person:person-r");
    expect(answer.act).toMatch(new RegExp(`^${PEOPLE}/\\d{8}T\\d{6}(?:\\.\\d+)?Z\\.[0-9a-f]{12}$`, "u"));
    expect([manifest!.feeder, manifest!.facts]).toEqual(["owner-statements", { action: "confirm", request: first.request, id: "person:person-r", device: DASHBOARD_UNIT, statements: 6, blobs_carried: 0 }]);
    const landed = at.deliveries().filter((each) => each.facts.request === first.request);
    expect(landed.map((each) => [each.id, each.state])).toEqual([[answer.act, "imported"]]);
    expect(await at.stated("person", "person-r")).toMatchObject({
      slug: "person-r", name: "Ree", relationship: "friend", anchor: { kind: "phone", value: "+15550000121" },
      handles: [], excluded: [{ kind: "email", value: "person-r@example.com" }], merged_into: null,
    });
    expect(await at.stated("person", "person-s")).toMatchObject({ anchor: { kind: "phone", value: "+15550000131" }, merged_into: "person-r", me: false });
    for (const face of ["f1", "f2", "f3"]) expect(await at.stated("face", faceOf(face))).toEqual({ is: "person-r" });
    expect(await at.stated("details", "person:person-r")).toEqual({ type: "people.details", work: "Example Co", birthday: { month: 8, day: 14, year: null }, profiles: [] });
    const imported = readHome(root, (db) => db.prepare("SELECT seq FROM events WHERE kind = 'import' AND key = ?").pluck().get(answer.act) as number);
    expect(imported).toBeLessThanOrEqual(seq(answer.position));
    const right = (cases.at(-1)!.right_after as Body).person;
    expect([right.id, right.name, right.relationship, right.details], "the read right after the answer joins the owner's heads, whatever its position")
      .toEqual(["person:person-r", "Ree", "friend", { work: "Example Co", birthday: { month: 8, day: 14, year: null }, profiles: [] }]);
    expect((await at.person(S)).person.id).toBe("person:person-r");

    const again = await at.ok(first);
    expect(again, "a resend is answered as the first was, the land's own position with it").toEqual(answer);
    expect(JSON.parse(at.meta(`${OWNER_REQUEST}${first.request}`)!)).toMatchObject({ act: answer.act, position: answer.position });
    expect(at.deliveries().filter((each) => each.facts.request === first.request)).toHaveLength(1);

    const [mac, phone] = await Promise.all([
      at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-r", details: { work: "Example Studio" } }),
      at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-r", details: { birthday: { month: 3, day: 5, year: 1990 } } }, PHONE),
    ]);
    expect(new Set([mac.act, phone.act]).size).toBe(2);
    expect([at.manifest(mac.act!).facts.device, at.manifest(phone.act!).facts.device]).toEqual([DASHBOARD_UNIT, PHONE_UNIT]);
    expect(await at.stated("details", "person:person-r")).toEqual({ type: "people.details", work: "Example Studio", birthday: { month: 3, day: 5, year: 1990 }, profiles: [] });
    const order = at.deliveries().map((each) => each.id);
    expect(Math.abs(order.indexOf(mac.act!) - order.indexOf(phone.act!))).toBe(1);

    const bakery = (await at.person("phone:+15550000141")).person;
    const business = (bakery.suggestions as Body[]).find((each) => each.kind === "entity" && each.value === "business")!;
    expect(business).toBeDefined();
    const accepted = await at.ok({ kind: "confirm", request: randomUUID(), id: bakery.id, accept: [business.id] }, PHONE);
    expect(accepted.id).toMatch(/^person:/u);
    expect(await at.stated("person", accepted.id!.slice("person:".length))).toMatchObject({ entity: "business", anchor: { kind: "phone", value: "+15550000141" } });
    await at.refused({ kind: "confirm", request: randomUUID(), id: bakery.id, accept: ["9999999999999999"] }, 409, "NOT_OFFERED");
    expect(business.ticked).toBe(false);
    const gym = (await at.person("phone:+15550000151")).person;
    expect([gym.entity, gym.entity_by, (gym.suggestions as Body[]).filter((each) => each.kind === "entity")]).toEqual(["business", "home", []]);
    const kept = await at.ok({ kind: "confirm", request: randomUUID(), id: gym.id, relationship: "where I train" });
    const slug = kept.id!.slice("person:".length);
    expect(await at.stated("person", slug)).toMatchObject({ entity: null, relationship: "where I train" });
    expect(await shownAfter(kept.id!), "the gym once People counted its act").toMatchObject({ person: slug, entity: "business", entity_by: "home" });
    await at.ok({ kind: "confirm", request: randomUUID(), id: kept.id, entity: "person" });
    expect(await at.stated("person", slug)).toMatchObject({ entity: "person" });
    expect(await shownAfter(kept.id!), "the owner's word once People counted it").toMatchObject({ entity: "person", entity_by: "you" });

    await at.refused({ kind: "confirm", request: randomUUID(), id: "person:person-r", add: ["phone:+15550000112"] }, 409, "HANDLE_TAKEN");
    await at.refused({ kind: "confirm", request: randomUUID(), id: "person:person-r", add: ["phone:+15550009999"] }, 404, "PERSON_UNKNOWN");
    await at.refused({ kind: "confirm", request: randomUUID(), id: "person:person-nobody" }, 404, "PERSON_UNKNOWN");
    const cardOnly = ((await at.get(`/v1/people?q=${encodeURIComponent("Person Card Only")}`)).body.people as Body[]).filter((each) => each.name === "Person Card Only");
    expect(cardOnly.map((each) => each.id)).toEqual([expect.stringMatching(/^contact:/u)]);
    await at.refused({ kind: "confirm", request: randomUUID(), id: cardOnly[0]!.id, relationship: "friend" }, 409, "NO_HANDLE");
    await at.refused({ kind: "confirm", request: randomUUID(), id: "person:person-r", groups: ["no-such-group"] }, 409, "NO_FACES");
    await at.refused({ kind: "name", request: randomUUID(), cluster: "c1", target: { kind: "new", name: "Person C" } }, 409, "NO_FACES");
    for (const kind of ["edit", "unlink", "merge", "accept"]) {
      await at.refused({ kind, request: randomUUID(), id: "person:person-r", relationship: "friend", accept: [], handle: "phone:+15550000112", into: "person:person-p" }, 400, "BAD_ACTION");
    }
    await at.refused({ kind: "confirm", request: randomUUID(), id: "person:person-r", details: { birthday: { month: 2, day: 30 } } }, 400, "BAD_ACTION");
    const joined = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-r", add: ["person:person-p"] });
    expect(await at.stated("person", "person-p")).toMatchObject({ merged_into: "person-r" });
    for (const id of ["person:person-p", "phone:+15550000112"]) {
      const refusal = await at.refused({ kind: "confirm", request: randomUUID(), id, relationship: "friend" }, 409, "JOINED");
      expect(refusal.message, id).toBe("They were joined into Ree.");
    }
    report.confirm = { first: answer, again, mac, phone, accepted, joined };
  });

  it("A7, A8: a photo lands with its square, the first record made for it, once; a square the rule refuses is refused; an undone upload shows the one before", async () => {
    const Q = "phone:+15550000161";
    const Q1 = jpeg("q1", 1024);
    const upload = (bytes: Buffer, id = Q) => ({ kind: "photo", request: randomUUID(), id, upload: bytes.toString("base64") });
    const { answer: q1, manifest } = await acted("a photo for someone with no record", upload(Q1), Q, PHONE);
    expect(q1.id).toBe("person:person-q");
    expect(manifest!.facts).toEqual({ action: "photo", request: manifest!.facts.request, id: "person:person-q", device: PHONE_UNIT, statements: 2, blobs_carried: 1 });
    expect(await at.stated("person", "person-q")).toMatchObject({ slug: "person-q", anchor: { kind: "phone", value: "+15550000161" } });
    expect(await at.stated("photo", "person:person-q")).toEqual({ type: "people.photo", image: sha(Q1) });
    const served = await fetch(`${url}/v1/blobs/${sha(Q1)}`, { headers: { authorization: `Bearer ${READER}` } });
    expect([served.status, sha(Buffer.from(await served.arrayBuffer()))]).toEqual([200, sha(Q1)]);
    expect((await shownAfter(Q)).photo).toEqual({ crop: sha(Q1) });
    expect(((await at.get(`/v1/people?q=${encodeURIComponent("Person Q")}`)).body.people as Body[]).find((each) => each.id === "person:person-q")?.photo).toEqual({ crop: sha(Q1) });

    expect((await at.ok(upload(Q1, "person:person-q"))).act).toBeNull();

    const Q2 = jpeg("q2", 800);
    const q2 = await at.ok(upload(Q2, "person:person-q"));
    expect(await at.stated("photo", "person:person-q")).toEqual({ type: "people.photo", image: sha(Q2) });
    const undone = await at.ok({ kind: "undo", request: randomUUID(), act: q2.act });
    expect([undone.act, undone.id]).toEqual([null, null]);
    const undo = at.deliveries().at(-1)!;
    expect(undo.facts).toMatchObject({ action: "undo", statements: 1, blobs_carried: 1 });
    expect(await at.stated("photo", "person:person-q")).toEqual({ type: "people.photo", image: sha(Q1) });
    expect((await at.person("person:person-q")).person.photo).toEqual({ crop: sha(Q1) });
    await at.refused({ kind: "undo", request: randomUUID(), act: q2.act }, 409, "UNDONE");

    const refusals: Body[] = [];
    for (const [what, bytes] of [["wide", jpeg("wide", 1024, 512)], ["tall", jpeg("tall", 512, 1024)], ["over 1,024", jpeg("over", 1100)], ["a PNG", PNG]] as const) {
      const refusal = await at.refused(upload(bytes, "person:person-q"), 422, "STATEMENTS_BAD");
      expect(refusal.message, what).toMatch(/statements\.ndjson line \d+: its picture/u);
      refusals.push({ what, ...refusal });
    }
    const empty = jpeg("full", 1024).length;
    const full = jpeg("full", 1024, 1024, 1024 * 1024 - empty);
    expect(full.length).toBe(1024 * 1024);
    await at.ok(upload(full, "person:person-q"));
    const heavy = await at.refused(upload(jpeg("heavy", 1024, 1024, 1024 * 1024), "person:person-q"), 400, "BAD_ACTION");
    expect(heavy.message).toBe("That picture is too large.");
    await at.refused({ kind: "photo", request: randomUUID(), id: "person:person-q", upload: "not base64!" }, 400, "BAD_ACTION");
    await at.refused({ kind: "photo", request: randomUUID(), id: "person:person-q" }, 400, "BAD_ACTION");
    await at.refused({ kind: "confirm", request: randomUUID(), id: "person:person-q", upload: Q2.toString("base64") }, 400, "BAD_ACTION");
    await at.refused({ kind: "confirm", request: randomUUID(), id: "person:person-q", photo: faceOf("f1") }, 400, "BAD_ACTION");

    const x = await at.ok({ kind: "confirm", request: randomUUID(), id: "phone:+15550000171" });
    expect(x.id).toBe("person:person-x");
    await at.refused({ kind: "undo", request: randomUUID(), act: x.act }, 409, "NOTHING_TO_UNDO");
    report.photo = { q1, q2, undone, refusals, heavy };
  });

  it("A9-A11: faces named, set aside and answered by a Maybe screen; an undo only of the newest, across a restart; the spent group; every run heard", async () => {
    const named = await at.ok({ kind: "name", request: randomUUID(), cluster: "c2", target: { kind: "new", name: "Person N" } });
    expect(named.id).toBe("person:person-n");
    for (const face of ["f4", "f5"]) expect(await at.stated("face", faceOf(face))).toEqual({ is: "person-n" });
    await ship(root, { source: FACES, fetched_ms: T + 10 * MINUTE, rows: [{ kind: "cluster", key: "c2", gone: true }] as never });
    await until("the labeler's group gone", () => at.settled() && readHome(root, (db) => db.prepare("SELECT version FROM heads WHERE source = ? AND kind = 'cluster' AND key = 'c2'").pluck().get(FACES)) === "gone");
    const undone = await at.ok({ kind: "undo", request: randomUUID(), act: named.act });
    for (const face of ["f4", "f5"]) expect(await at.stated("face", faceOf(face))).toBeNull();
    expect(JSON.parse(at.meta("people:undone")!)).toEqual({ c2: [faceOf("f4"), faceOf("f5")] });
    await until(`People at or past ${undone.position}`, () => at.heard(undone.position));
    await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-r", relationship: "sibling" });
    expect(JSON.parse(at.meta("people:undone")!)).toEqual({ c2: [faceOf("f4"), faceOf("f5")] });
    const again = await at.ok({ kind: "name", request: randomUUID(), cluster: "c2", target: { kind: "person", id: "person:person-n" } });
    expect(again.id).toBe("person:person-n");
    for (const face of ["f4", "f5"]) expect(await at.stated("face", faceOf(face))).toEqual({ is: "person-n" });
    await at.refused({ kind: "name", request: randomUUID(), cluster: "c2", target: { kind: "person", id: "person:person-n" } }, 409, "NO_FACES");
    await at.ok({ kind: "undo", request: randomUUID(), act: again.act });
    expect(JSON.parse(at.meta("people:undone")!)).toEqual({ c2: [faceOf("f4"), faceOf("f5")] });
    await ship(root, { source: FACES, fetched_ms: T + 11 * MINUTE, rows: [{ kind: "cluster", key: "c2", gone: true }, cluster("c9", ["f9a"])] as never });
    await until("the labeler's delivery landed", () => at.settled() && readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = 'cluster' AND key = 'c9'").pluck().get(FACES)) === 1);
    expect(JSON.parse(at.meta("people:undone")!)).toEqual({ c2: [faceOf("f4"), faceOf("f5")] });
    const third = await at.ok({ kind: "name", request: randomUUID(), cluster: "c2", target: { kind: "person", id: "person:person-n" } });
    for (const face of ["f4", "f5"]) expect(await at.stated("face", faceOf(face))).toEqual({ is: "person-n" });
    expect(at.meta("people:undone")).toBeUndefined();
    await at.ok({ kind: "undo", request: randomUUID(), act: third.act });
    expect(at.meta("people:undone")).toBeDefined();
    await ship(root, { source: FACES, fetched_ms: T + 12 * MINUTE, rows: [cluster("c2", ["f4", "f5"])] as never });
    await until("the labeler's group back", () => at.settled() && readHome(root, (db) => db.prepare("SELECT version FROM heads WHERE source = ? AND kind = 'cluster' AND key = 'c2'").pluck().get(FACES)) !== "gone");
    await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-r", relationship: "friend" });
    expect(at.meta("people:undone")).toBeUndefined();

    const ignored = await at.ok({ kind: "ignore", request: randomUUID(), cluster: "c3" }, PHONE);
    expect(ignored.id).toBeNull();
    for (const face of ["f6", "f7"]) expect(await at.stated("face", faceOf(face))).toEqual({ ignore: true });
    await until(`People at or past ${ignored.position}`, () => at.heard(ignored.position));

    const maybe = await at.ok({ kind: "maybe", request: randomUUID(), id: "person:person-r", yes: [faceOf("m1"), faceOf("m2")], no: [faceOf("m3")] });
    expect(at.manifest(maybe.act!).facts).toMatchObject({ action: "maybe", statements: 3 });
    expect([await at.stated("face", faceOf("m1")), await at.stated("face", faceOf("m3"))]).toEqual([{ is: "person-r" }, { is_not: ["person-r"] }]);
    await at.refused({ kind: "maybe", request: randomUUID(), id: "person:person-r", yes: [faceOf("m1")], no: [faceOf("m1")] }, 400, "BAD_ACTION");

    await home.stop();
    await start();
    const back = await at.ok({ kind: "undo", request: randomUUID(), act: maybe.act });
    expect([await at.stated("face", faceOf("m1")), await at.stated("face", faceOf("m3"))]).toEqual([null, null]);
    await until(`People at or past ${back.position}`, () => at.heard(back.position));

    const first = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-r", relationship: "colleague" });
    const hidden = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-x", hidden: true }, PHONE);
    expect(await at.stated("person", "person-x")).toMatchObject({ hidden: true });
    await at.refused({ kind: "undo", request: randomUUID(), act: first.act }, 409, "NOT_LAST");
    await at.ok({ kind: "undo", request: randomUUID(), act: hidden.act }, PHONE);
    expect(await at.stated("person", "person-x")).toMatchObject({ hidden: false });
    await at.refused({ kind: "undo", request: randomUUID(), act: hidden.act }, 409, "UNDONE");

    const last = await at.ok({ kind: "name", request: randomUUID(), cluster: "c9", target: { kind: "person", id: "person:person-r" } });
    expect(JSON.parse(at.meta("people:undo")!)).toMatchObject({ act: last.act });
    await askHome(testSocket(root), "faces", ["forget"]);
    expect([at.meta("people:undo"), at.meta("people:undone")]).toEqual([undefined, undefined]);
    await at.refused({ kind: "undo", request: randomUUID(), act: last.act }, 409, "NOTHING_TO_UNDO");
    report.faces = { named, undone, again, ignored, maybe, back, first, hidden, last };
  });

  it("W3, W5, W13, W15: a record of another shape restated in the home's, the shown name kept, one record for one person, details answered member by member and undone; a repair or an operator's undo takes the Undo", async () => {
    const since = "2025-01-01T00:00:00Z";
    await shipFiles(root, PEOPLE, T + 20 * MINUTE, statements([
      { kind: "person", key: "person-o", content: { type: "people.person", slug: "person-o", name: "Person O", excluded: [], merged_into: null,
        handles: [{ kind: "name", value: "Person O", by: "subject", since }, { kind: "phone", value: "+1 555 000 0181", by: "subject", since }] } },
      { kind: "person", key: "person-f", content: { ...record("person-f", "+15550000182", "Person F"), full_name: "Person F Example", show: "full_name" } },
    ]));
    await until("the records landed", async () => at.settled() && (await at.stated("person", "person-f")) !== null);

    await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-o", relationship: "friend" });
    const o = await at.stated("person", "person-o");
    expect(o).toMatchObject({ type: "people.person", slug: "person-o", name: "Person O", show: "name", relationship: "friend", anchor: { kind: "phone", value: "+15550000181" }, handles: [] });
    expect(JSON.stringify(o)).not.toContain('"by"');
    await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-f", relationship: "friend" });
    expect(await at.stated("person", "person-f")).toMatchObject({ name: "Person F Example", full_name: "Person F Example", show: "name", relationship: "friend" });

    await ship(root, { source: BOOK, fetched_ms: T + 21 * MINUTE, rows: [card("FN:Person Y", "TEL;TYPE=CELL:+15550000183")] as never });
    await until("Person Y's card served", async () => at.settled() && (await at.get(`/v1/people?id=${encodeURIComponent("phone:+15550000183")}`)).status === 200);
    const made = await at.ok({ kind: "confirm", request: randomUUID(), id: "phone:+15550000183", relationship: "friend" });
    const again = await at.ok({ kind: "confirm", request: randomUUID(), id: "phone:+15550000183", name: "Why" });
    expect([made.id, again.id]).toEqual(["person:person-y", "person:person-y"]);
    expect(await at.stated("person", "person-y")).toMatchObject({ name: "Why", relationship: "friend" });
    expect(await at.stated("person", "person-y-2")).toBeNull();
    await ship(root, { source: BOOK, fetched_ms: T + 21 * MINUTE + 2, rows: [card("FN:Person YB", "TEL;TYPE=CELL:+15550000188", "TEL;TYPE=CELL:+15550000189")] as never });
    await until("Person YB's card served", async () => at.settled() && (await at.get(`/v1/people?id=${encodeURIComponent("phone:+15550000189")}`)).status === 200);
    await askHome(testSocket(root), "pause", ["kind:people", "--reason", "a test holds People's publish"]);
    const other = await at.ok({ kind: "confirm", request: randomUUID(), id: "phone:+15550000189", relationship: "friend" });
    const otherAgain = await at.ok({ kind: "confirm", request: randomUUID(), id: "phone:+15550000189", name: "Why B" });
    await askHome(testSocket(root), "resume", ["kind:people"]);
    expect([other.id, otherAgain.id]).toEqual(["person:person-yb", "person:person-yb"]);
    expect(await at.stated("person", "person-yb")).toMatchObject({ anchor: { kind: "phone", value: "+15550000188" }, name: "Why B", relationship: "friend" });
    expect(await at.stated("person", "person-yb-2")).toBeNull();
    await ship(root, { source: BOOK, fetched_ms: T + 21 * MINUTE + 1, rows: [
      card("FN:Person Z", "TEL;TYPE=CELL:+15550000231", "TEL;TYPE=CELL:+15550000232"), card("FN:Person ZA", "TEL;TYPE=CELL:+15550000233"),
    ] as never });
    await until("Person Z and Person ZA served", async () => at.settled()
      && (await at.get(`/v1/people?id=${encodeURIComponent("phone:+15550000232")}`)).status === 200
      && (await at.get(`/v1/people?id=${encodeURIComponent("phone:+15550000233")}`)).status === 200);
    const both = await at.ok({ kind: "confirm", request: randomUUID(), id: "phone:+15550000233", add: ["phone:+15550000231", "phone:+15550000232"] });
    expect(both.id).toBe("person:person-za");
    expect((await at.stated("person", "person-za"))?.handles).toEqual([]);
    expect(await at.stated("person", "person-z")).toMatchObject({ anchor: { kind: "phone", value: "+15550000231" }, merged_into: "person-za" });
    expect([await at.stated("person", "person-z-2"), await at.stated("person", "person-za-2")]).toEqual([null, null]);
    const unchanged = { kind: "confirm", request: randomUUID(), id: "person:person-y", name: "Why" };
    expect((await at.ok(unchanged)).act).toBeNull();
    expect(JSON.parse(at.meta(`${OWNER_REQUEST}${unchanged.request}`)!)).toEqual({ of: "people", act: null, kind: "confirm", id: "person:person-y", undoable: false, position: expect.stringMatching(/^\d+:\d+$/), at_ms: expect.any(Number) });
    await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-y", name: "Wye" });
    expect(await at.ok(unchanged)).toMatchObject({ act: null, id: "person:person-y" });
    expect(await at.stated("person", "person-y")).toMatchObject({ name: "Wye" });

    await shipFiles(root, PEOPLE, T + 22 * MINUTE, statements([
      { kind: "person", key: "person-ma", content: record("person-ma", "+15550000184", "Person MA") },
      { kind: "person", key: "person-mb", content: record("person-mb", "+15550000185", "Person MB") },
      { kind: "person", key: "person-mc", content: record("person-mc", "+15550000186", "Person MC") },
      { kind: "person", key: "person-md", content: record("person-md", "+15550000187", "Person MD") },
      { kind: "details", key: "phone:+15550000185", content: { type: "people.details", work: "Example Lab", birthday: null, profiles: [] } },
      { kind: "details", key: "phone:+15550000187", content: { type: "people.details", work: "Example Yard", birthday: null, profiles: [] } },
    ]));
    await until("the joined people landed", async () => at.settled() && (await at.stated("details", "phone:+15550000187")) !== null);
    await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-ma", add: ["person:person-mb"] });
    await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-ma", details: { birthday: { month: 1, day: 2 } } });
    expect(await at.stated("details", "person:person-ma")).toEqual({ type: "people.details", work: null, birthday: { month: 1, day: 2, year: null }, profiles: [] });
    const mc = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-mc", add: ["person:person-md"], details: { birthday: { month: 3, day: 4 } } });
    expect(await at.stated("details", "person:person-mc")).toEqual({ type: "people.details", work: null, birthday: { month: 3, day: 4, year: null }, profiles: [] });
    expect((await at.person("person:person-ma")).person.details).toEqual({ work: "Example Lab", birthday: { month: 1, day: 2, year: null }, profiles: [] });
    expect((await at.person("person:person-mc")).person.details).toEqual({ work: "Example Yard", birthday: { month: 3, day: 4, year: null }, profiles: [] });
    expect((await shownAfter("person:person-ma")).details, "a merged person's details after People's run").toEqual({ work: "Example Lab", birthday: { month: 1, day: 2, year: null }, profiles: [] });

    const standing = await at.stated("details", "person:person-r");
    expect((await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-r", details: { work: standing!.work } })).act).toBeNull();
    const profiled = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-r", details: { profiles: [{ network: "instagram", value: "person.r" }, { network: "instagram", value: "person.r" }] } });
    expect(await at.stated("details", "person:person-r")).toEqual({ ...standing, profiles: [{ network: "instagram", value: "person.r" }] });
    await at.ok({ kind: "undo", request: randomUUID(), act: profiled.act });
    expect(await at.stated("details", "person:person-r")).toEqual(standing);
    const first = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-q", details: { work: "Example Kitchen" } });
    await at.ok({ kind: "undo", request: randomUUID(), act: first.act });
    expect(await at.stated("details", "person:person-q")).toBeNull();
    expect((await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-q", details: { work: " ", birthday: null, profiles: [] } })).act).toBeNull();

    const sock = testSocket(root);
    const fix = join(root, "repair-fix.mjs");
    writeFileSync(fix, "export function fix(head) { return head.content?.slug === \"person-o\" ? { content: { ...head.content, relationship: \"repaired\" } } : \"keep\"; }\n");
    const repaired = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-o", relationship: "neighbour" });
    await askHome(sock, "pause", ["kind:repair", "--reason", "a test"]);
    await askHome(sock, "repair", ["--source", PEOPLE, "--kinds", "person", "--reason", "a synthetic repair", "--fix", fix, "--apply"]);
    expect(JSON.parse(at.meta("people:undo")!)).toMatchObject({ act: repaired.act });
    const between = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-o", relationship: "friend" });
    expect(JSON.parse(at.meta("people:undo")!)).toMatchObject({ act: between.act });
    await askHome(sock, "resume", ["kind:repair"]);
    await until("the repair applied", () => at.settled() && at.meta("people:undo") === undefined);
    await at.refused({ kind: "undo", request: randomUUID(), act: between.act }, 409, "NOTHING_TO_UNDO");
    expect(await at.stated("person", "person-o")).toMatchObject({ relationship: "repaired" });
    const operated = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-o", relationship: "colleague" });
    expect(JSON.parse(at.meta("people:undo")!)).toMatchObject({ act: operated.act });
    const run = readHome(root, (db) => db.prepare("SELECT run FROM deliveries WHERE id = ? AND source = ?").pluck().get(operated.act, PEOPLE) as number);
    await askHome(sock, "undo", [String(run), "--apply"]);
    await until("the operator's undo applied", () => at.settled() && at.meta("people:undo") === undefined);
    await at.refused({ kind: "undo", request: randomUUID(), act: operated.act }, 409, "NOTHING_TO_UNDO");
    expect(await at.stated("person", "person-o")).toMatchObject({ relationship: "repaired" });
    report.rows = { o, made, again, profiled, repaired, between, operated };
  });

  it("A12-A15: who may act, what the door refuses before relaying, the home down, an erasure's hold, and the profiles a search reads", async () => {
    const sealed = at.deliveries().length;
    await at.refused({ kind: "confirm", request: randomUUID(), id: "person:person-r", relationship: "friend" }, 403, "PRINCIPAL_SCOPE", READER);
    expect(at.deliveries().length).toBe(sealed);
    await at.refused(JSON.stringify({ kind: "photo", request: randomUUID(), id: "person:person-r", upload: "A".repeat(2 * 1024 * 1024) }), 413, "BODY_TOO_LARGE");
    await at.refused("{ not json", 400, "BAD_ACTION");
    await at.refused("[]", 400, "BAD_ACTION");
    await at.refused({ kind: "confirm", id: "person:person-r" }, 400, "BAD_ACTION");
    await at.refused({ kind: "confirm", request: "has spaces", id: "person:person-r" }, 400, "BAD_ACTION");

    const kept = at.deliveries().length;
    await home.stop();
    const down = await at.act({ kind: "confirm", request: randomUUID(), id: "person:person-r", relationship: "neighbour" });
    expect([down.status, down.body.code]).toEqual([503, "NOT_NOW"]);
    await start();
    expect(at.deliveries().length).toBe(kept);
    expect(await at.stated("person", "person-r")).not.toMatchObject({ relationship: "neighbour" });

    const request = randomUUID();
    const [erased, acted] = await Promise.allSettled([
      askHome(testSocket(root), "erase", ["messages", "whatsapp:+15550000001:no-such-message"]),
      at.ok({ kind: "confirm", request, id: "person:person-r", relationship: "cousin" }),
    ]);
    expect(acted.status).toBe("fulfilled");
    expect(at.deliveries().filter((each) => each.facts.request === request).map((each) => each.state)).toEqual(["imported"]);
    expect(await at.stated("person", "person-r")).toMatchObject({ relationship: "cousin" });

    const profiles = async (q: string) => (await at.get(`/v1/people?q=${encodeURIComponent(q)}`)).body.profiles as Body[];
    expect(await profiles("@person.r")).toEqual([{ network: "instagram", value: "person.r" }, { network: "x", value: "person.r" }]);
    expect(await profiles("https://instagram.com/person.r")).toEqual([{ network: "instagram", value: "person.r" }]);
    expect(await profiles("person-r@example.com")).toEqual([]);
    expect(await profiles("Ree")).toEqual([]);
    expect(Object.hasOwn((await at.get("/v1/people")).body, "landed")).toBe(false);
    report.door = { down: down.body, erased: erased.status, acted: acted.status === "fulfilled" ? acted.value : null };
  });

  it("A17: a failure before the seal or between it and the commit is 500 WRITER_FAILED, a disk with no room for the square 503 DISK_LOW, each leaves nothing sealed, and the same request again lands once, its Undo standing across a restart", async () => {
    const lane = join(root, "inbox", PEOPLE);
    const sealedFor = (request: string) => readdirSync(lane).filter((name) => readSealed(openHomeFolder(dirname(dirname(lane))), join(lane, name))?.facts.request === request);
    const refusing = async (folder: string, action: Body) => {
      const mode = statSync(folder).mode & 0o777;
      chmodSync(folder, 0o555);
      try {
        return await at.act(action);
      } finally {
        chmodSync(folder, mode);
      }
    };
    const failures: Body[] = [];
    for (const [what, folder, action] of [
      ["before the seal", lane, { kind: "confirm", request: randomUUID(), id: "person:person-x", relationship: "neighbour" }],
      ["between the seal and the commit", join(root, "blobs"), { kind: "photo", request: randomUUID(), id: "person:person-x", upload: jpeg("x1", 640).toString("base64") }],
    ] as const) {
      const before = at.deliveries().length;
      const failed = await refusing(folder, action);
      expect([failed.status, failed.body.code], what).toEqual([500, "WRITER_FAILED"]);
      expect(at.deliveries().length, what).toBe(before);
      expect(sealedFor(action.request), what).toEqual([]);
      expect(at.meta(`${OWNER_REQUEST}${action.request}`), what).toBeUndefined();
      const retried = await at.ok(action);
      expect(retried.act, what).toMatch(/^people:local:/u);
      expect(sealedFor(action.request), what).toHaveLength(1);
      failures.push({ what, request: action.request, failed: failed.body, retried });
    }
    await home.stop();
    await start();
    for (const { what, request } of failures) {
      expect(at.deliveries().filter((each) => each.facts.request === request), what).toHaveLength(1);
      expect(sealedFor(request), what).toHaveLength(1);
    }
    await at.ok({ kind: "undo", request: randomUUID(), act: (failures[1]!.retried as Body).act });
    expect(await at.stated("photo", "person:person-x")).toBeNull();
    const free = freeSpace(1e9 + 1);
    const roomless = { kind: "photo", request: randomUUID(), id: "person:person-x", upload: jpeg("x2", 640).toString("base64") };
    const before = at.deliveries().length;
    const full = await at.act(roomless);
    expect([full.status, full.body.code]).toEqual([503, "DISK_LOW"]);
    expect([at.deliveries().length, sealedFor(roomless.request)]).toEqual([before, []]);
    free.set(1e12);
    expect((await at.ok(roomless)).act).toMatch(/^people:local:/u);
    expect(sealedFor(roomless.request)).toHaveLength(1);
    report.failures = [...failures, { what: "no room for the square", request: roomless.request, failed: full.body }];
  });

  it("A18: Accept all businesses makes the ticked ones businesses in one delivery and one Undo, the rest still offered; one the owner said or declined is never swept in, and a refusal names each one", async () => {
    const [florist, tailor, cafe, garage, studio, shop, shopToo] = ["221", "222", "223", "224", "225", "226", "227"].map((n) => `phone:+15550000${n}`) as
      [string, string, string, string, string, string, string];
    await ship(root, {
      source: BOOK, fetched_ms: T + 30 * MINUTE,
      rows: [
        ...[["Florist", "221"], ["Tailor", "222"], ["Cafe", "223"], ["Garage", "224"], ["Studio", "225"]].map(([name, n]) => card(`ORG:Synthetic ${name}`, `TEL:+15550000${n}`)),
        card("ORG:Synthetic Shop", "TEL:+15550000226", "TEL:+15550000227"),
      ] as never,
    });
    const slugs: Record<string, string> = {
      [florist]: "synthetic-florist", [tailor]: "synthetic-tailor", [cafe]: "synthetic-cafe", [garage]: "synthetic-garage", [studio]: "synthetic-studio", [shop]: "synthetic-shop",
    };
    const offered = async (): Promise<string[]> => {
      const ids = new Set(((await at.get("/v1/people")).body.organise?.businesses as Body[] | undefined ?? []).map((each) => each.id as string));
      return Object.keys(slugs).filter((id) => ids.has(id) || ids.has(`person:${slugs[id]}`));
    };
    await until("the six cards offered as businesses", async () => (await offered()).length === 6);
    expect(((await at.get("/v1/people")).body.organise.businesses as Body[]).find((each) => each.id === florist)).toEqual({ id: florist, reasons: { cards: 1 } });
    const said = await at.ok({ kind: "confirm", request: randomUUID(), id: garage, entity: "person" });
    const garageShown = await shownAfter(said.id!);
    expect([garageShown.entity, garageShown.entity_by, (garageShown.suggestions as Body[]).filter((each) => each.kind === "entity")]).toEqual(["person", "you", []]);
    expect(said.id).toBe("person:synthetic-garage");
    expect(await offered()).toEqual([florist, tailor, cafe, studio, shop]);

    for (const body of [{}, { ids: [] }, { ids: florist }, { ids: [5] }, { ids: [""] }, { ids: [florist], entity: "ai" }]) {
      await at.refused({ kind: "businesses", request: randomUUID(), ...body }, 400, "BAD_ACTION");
    }
    await at.refused({ kind: "businesses", ids: [florist] }, 400, "BAD_ACTION");

    const sock = testSocket(root);
    await askHome(sock, "pause", ["people:people", "--reason", "held by the test"]);
    try {
      const studioOffer = ((await at.person(studio)).person.suggestions as Body[]).find((each) => each.kind === "entity" && each.value === "business")!.id as string;
      await at.ok({ kind: "confirm", request: randomUUID(), id: studio, decline: [studioOffer] }, PHONE);
      expect(await at.stated("person", "synthetic-studio")).toMatchObject({ entity: null, dismissed: [studioOffer] });
      await at.ok({ kind: "confirm", request: randomUUID(), id: tailor, entity: "person" }, PHONE);
      const declined = (await at.person(studio)).person;
      expect([(declined.suggestions as Body[]).some((each) => each.id === studioOffer), declined.counting]).toEqual([false, undefined]);
      await at.refused({ kind: "confirm", request: randomUUID(), id: studio, accept: [studioOffer] }, 409, "NOT_OFFERED");
      const refusal = await at.refused({ kind: "businesses", request: randomUUID(), ids: [florist, studio, tailor, said.id, "phone:+15550009999"] }, 409, "NOT_OFFERED");
      expect(refusal.refused).toEqual([
        { id: studio, code: "NOT_OFFERED", message: "You said they are not a business." },
        { id: tailor, code: "NOT_OFFERED", message: "You said what they are." },
        { id: said.id, code: "NOT_OFFERED", message: "You said what they are." },
        { id: "phone:+15550009999", code: "PERSON_UNKNOWN", message: "There is no such person." },
      ]);
      expect(refusal.message).toBe("4 of them can’t be marked: they changed since you looked.");
    } finally {
      await askHome(sock, "resume", ["people:people"]);
    }
    await until("the studio and the tailor offered no more", async () => (await offered()).join() === [florist, cafe, shop].join());

    const batch = { kind: "businesses", request: randomUUID(), ids: [florist, shop, shopToo] };
    const { answer, manifest } = await acted("accept all businesses, the cafe unticked", batch, null);
    expect([answer.id, manifest!.facts]).toEqual([null, { action: "businesses", request: batch.request, id: null, device: DASHBOARD_UNIT, statements: 2, blobs_carried: 0 }]);
    expect(await at.stated("person", "synthetic-florist")).toMatchObject({ entity: "business", anchor: { kind: "phone", value: "+15550000221" }, dismissed: [] });
    expect(await at.stated("person", "synthetic-shop")).toMatchObject({ entity: "business", anchor: { kind: "phone", value: "+15550000226" } });
    expect([await at.stated("person", "synthetic-shop-2"), await at.stated("person", "synthetic-cafe")]).toEqual([null, null]);
    expect((await at.ok(batch)).act).toBe(answer.act);
    expect(at.deliveries().filter((each) => each.facts.request === batch.request)).toHaveLength(1);
    const shown = await shownAfter(florist);
    expect([shown.entity, shown.entity_by]).toEqual(["business", "you"]);
    expect([(await at.person(shopToo)).person.entity_by, (await at.person(cafe)).person.entity_by]).toEqual(["you", "home"]);
    expect(await offered()).toEqual([cafe]);

    const undone = await at.ok({ kind: "undo", request: randomUUID(), act: answer.act });
    for (const slug of ["synthetic-florist", "synthetic-shop"]) expect(await at.stated("person", slug), slug).toMatchObject({ entity: null });
    const back = await shownAfter(florist);
    expect([back.entity_by, (await at.person(shop)).person.entity_by]).toEqual(["home", "home"]);
    const again = await offered();
    expect(again).toEqual([florist, cafe, shop]);
    await at.refused({ kind: "undo", request: randomUUID(), act: answer.act }, 409, "UNDONE");
    report.businesses = { said, answer, undone, offered: again };
  });

  it("R1-R3: a settled read is held off the read threads while it counts, holding no other read; it answers at once while People is paused, still counting at its bound, settled at People's event, and refuses a settled in another shape", async () => {
    for (const path of ["/v1/people?settled=0", "/v1/places?settled=", "/v1/people/photos?id=person:person-r&settled=1&settled=1", "/v1/places/photos?slug=synthetic-a&settled=yes"]) {
      expect(await at.get(path), path).toMatchObject({ status: 422, body: { code: "BAD_PARAMETER" } });
    }
    expect(bounds.size).toBe(0);

    const A = "person:person-ha", B = "person:person-hb";
    await shipFiles(root, PEOPLE, Date.now(), statements([
      { kind: "person", key: "person-ha", content: record("person-ha", "+15550000451", "Person Ha") },
      { kind: "person", key: "person-hb", content: record("person-hb", "+15550000452", "Person Hb") },
    ]));
    await until("the two people prepared", async () => at.settled() && (await at.get(`/v1/people?id=${encodeURIComponent(B)}`)).body.person?.id === B);

    const sock = testSocket(root);
    await askHome(sock, "pause", ["kind:people", "--reason", "a test holds People's run"]);
    const paused = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-r", relationship: "neighbour" });
    expect(paused.id).toBe("person:person-r");
    const answer = await at.get(`/v1/people?${new URLSearchParams({ id: "person:person-r", settled: "1" })}`);
    expect([answer.status, answer.body.person.relationship, answer.body.person.counting, bounds.size],
      "a settled read while People is paused answers at once, the act joined, nothing counting").toEqual([200, "neighbour", undefined, 0]);
    await at.ok({ kind: "confirm", request: randomUUID(), id: A, add: [B] });
    expect((await at.get(`/v1/people?${new URLSearchParams({ id: A, settled: "1" })}`)).body.person.counting, "the merge, paused: nothing counting").toBeUndefined();

    await home.stop();
    const db = openHomeDb(openHomeFolder(root), "migrate");
    try {
      db.commit((tx) => {
        for (const control of tx.tables.controls.list()) tx.tables.controls.clear(control.target);
      });
    } finally {
      db.close();
    }
    const plain = await at.get(`/v1/people?id=${encodeURIComponent(A)}`);
    expect([plain.status, plain.body.person.counting], "People not paused, its run not yet made: the merge counts").toEqual([200, true]);

    const reads = [`/v1/people?id=${encodeURIComponent(A)}`, "/v1/people", `/v1/people/photos?id=${encodeURIComponent(A)}`, `/v1/people/photos?id=${encodeURIComponent(A)}&limit=10`];
    const settledRead = (path: string) => at.get(`${path}${path.includes("?") ? "&" : "?"}settled=1`);
    const firstHeld = settledRead(reads[0]!);
    await until("the first settled read held", () => bounds.size === 1);
    const [early] = [...bounds];
    const held = [firstHeld, ...reads.slice(1).map(settledRead)];
    await until("four settled reads held at once, more than the door has read threads", () => bounds.size === 4);
    for (const path of [`/v1/people?id=${encodeURIComponent(A)}`, `/v1/people/photos?id=${encodeURIComponent(A)}`, "/v1/people", "/v1/places"]) {
      expect((await at.get(path)).status, `${path} answers beside the held reads`).toBe(200);
    }
    early!();
    const first = await held[0]!;
    expect([first.status, first.body.person.counting], "a hold its bound ended answers what it has, still counting").toEqual([200, true]);
    expect(bounds.size).toBe(3);

    await start();
    const answers = await Promise.all(held.slice(1));
    expect(answers.map((each) => each.status), "the rest answered at People's event").toEqual([200, 200, 200]);
    expect([answers[0]!.body.counting, (answers[0]!.body.people as Body[]).some((each) => each.counting === true)], "the list, settled").toEqual([undefined, false]);
    const settled = await at.get(`/v1/people?${new URLSearchParams({ id: A, settled: "1" })}`);
    expect([settled.body.person.counting, (settled.body.person.handles as Body[]).map((each) => each.id)], "the merge counted").toEqual([undefined, expect.arrayContaining(["phone:+15550000452"])]);
    expect(bounds.size).toBe(0);
  });
});

async function openHome(prefix: string, roots: string[]) {
  const root = homeRoot(prefix);
  roots.push(root);
  const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY });
  editSettings(root, { "door.port": door.port });
  const home = await startHome(root, { registry: REGISTRY, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
  const at = through(root, () => `http://127.0.0.1:${door.port}`);
  const sock = testSocket(root);
  let clock = Date.now();
  const imported = (id: string) => at.deliveries().some((each) => each.id === id && each.state === "imported");
  return {
    root, at, sock,
    say: async (lines: object[]) => {
      clock = Math.max(clock + 1000, Date.now());
      const id = await shipFiles(root, PEOPLE, clock, statements(lines));
      await until(`${id} imported`, () => imported(id));
    },
    send: async (source: string, rows: object[], made = false) => {
      const id = await ship(root, { source, fetched_ms: T, rows: rows as never, ...(made ? { facts: { sources: [{ id: source, connector: "people-rows" }] } } : {}) });
      await until(`${id} imported`, () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported");
    },
    list: async (what: string) => {
      await until(what, () => at.settled());
      return (await at.get("/v1/people")).body;
    },
    setupYou: async () => ((await askHome(sock, "connectors", ["--unit", UNIT])) as { setup: { you: boolean } | null }).setup?.you,
    close: async () => {
      await door.close();
      await home.stop().catch(() => undefined);
    },
  };
}

describe("Places, hidden spots and cameras through the one writer", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  let at: ReturnType<typeof through>;
  const report: Record<string, unknown> = {};
  const CAMERA = "synthetic-make/synthetic-camera";
  const place = (slug: string) => at.stated("place", slug, PLACES);

  beforeAll(async () => {
    root = homeRoot("lifestream-owner-act-places-");
    at = through(root, () => url);
    home = await startHome(root, { registry: REGISTRY, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY });
    url = `http://127.0.0.1:${door.port}`;
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "owner-act-places.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("O1-O6: a place made, edited from two devices, its circles bounded, its home said, then removed: each answered once it is in the records, a resend answered from the kept row, a late edit refused", async () => {
    const create = { of: "places", kind: "create", request: randomUUID(), name: "  Synthetic Harbour ", latitude: 10, longitude: 20, radius_m: 120, ids: ["google:synthetic-b", "google:synthetic-a", "google:synthetic-b"] };
    const made = await at.ok(create);
    expect(made.act).toBeNull();
    expect(made.id).toMatch(/^place:synthetic-harbour-[0-9a-f]{6}$/u);
    const slug = made.id!.slice("place:".length);
    const madeShown = await at.get(`/v1/places?${new URLSearchParams({ slug, settled: "1" })}`);
    expect([madeShown.status, madeShown.body.place.name, madeShown.body.place.counting], "a new place, read settled: Places counted it").toEqual([200, "Synthetic Harbour", undefined]);
    const harbour = { type: "places.place", name: "Synthetic Harbour", centre: { latitude: 10, longitude: 20 }, radius_m: 120, ids: ["google:synthetic-a", "google:synthetic-b"] };
    expect(await place(slug)).toEqual(harbour);
    const sealed = at.deliveries(PLACES).filter((each) => each.facts.request === create.request);
    expect(sealed.map((each) => [each.state, each.facts])).toEqual([["imported", { action: "create", request: create.request, id: made.id, device: DASHBOARD_UNIT, statements: 1, blobs_carried: 0 }]]);
    expect(JSON.parse(at.meta(`${OWNER_REQUEST}${create.request}`)!)).toEqual({
      of: "places", act: sealed[0]!.id, kind: "create", id: made.id, undoable: false, position: made.position, at_ms: expect.any(Number),
    });
    expect(await at.ok(create), "a resend is answered from the kept row").toEqual(made);
    expect(at.deliveries(PLACES).filter((each) => each.facts.request === create.request)).toHaveLength(1);

    const [renamed, circled] = await Promise.all([
      at.ok({ of: "places", kind: "edit", request: randomUUID(), slug, name: "Synthetic Port", was: { name: "Synthetic Harbour" } }),
      at.ok({ of: "places", kind: "add-circle", request: randomUUID(), slug, latitude: 10.01, longitude: 20.01, radius_m: 60 }, PHONE),
    ]);
    const circle = { centre: { latitude: 10.01, longitude: 20.01 }, radius_m: 60 };
    expect(await place(slug)).toEqual({ ...harbour, name: "Synthetic Port", also: [circle] });
    const listed = await at.get("/v1/places?settled=1");
    const port = (listed.body.places as Body[]).find((each) => each.slug === slug);
    expect([listed.status, listed.body.counting, port?.name, port?.also, port?.counting], "the list after both edits, read settled: Places counted them").toEqual([
      200, undefined, "Synthetic Port", [{ latitude: 10.01, longitude: 20.01, radius_m: 60 }], undefined,
    ]);
    const one = await at.get(`/v1/places?${new URLSearchParams({ slug, settled: "1" })}`);
    expect([one.status, one.body.place.name, one.body.place.counting], "the place after both edits, read settled").toEqual([200, "Synthetic Port", undefined]);
    const photos = await at.get(`/v1/places/photos?${new URLSearchParams({ slug, settled: "1" })}`);
    expect([photos.status, photos.body.total, photos.body.counting], "its photos after both edits, read settled").toEqual([200, 0, undefined]);
    const times = at.deliveries(PLACES).map((each) => each.sealed_ms);
    expect(new Set(times).size, "every edit is stated at its own instant").toBe(times.length);

    const before = at.owned();
    expect((await at.ok({ of: "places", kind: "edit", request: randomUUID(), slug, name: "Synthetic Port", was: { name: "Synthetic Port" } })).act).toBeNull();
    expect(at.owned(), "an edit that changes nothing seals nothing").toBe(before);
    await at.ok({ of: "places", kind: "edit", request: randomUUID(), slug, home: true, latitude: 10.5, longitude: 20.5, was: { home: null, latitude: 10, longitude: 20 } });
    expect(await place(slug)).toEqual({ ...harbour, name: "Synthetic Port", centre: { latitude: 10.5, longitude: 20.5 }, also: [circle], home: true });
    await at.ok({ of: "places", kind: "edit", request: randomUUID(), slug, home: null, also: [], was: { home: true, also: [{ latitude: 10.01, longitude: 20.01, radius_m: 60 }] } });
    expect(await place(slug)).toEqual({ ...harbour, name: "Synthetic Port", centre: { latitude: 10.5, longitude: 20.5 } });
    await at.ok({ of: "places", kind: "edit", request: randomUUID(), slug, ids: ["google:synthetic-c"], was: { ids: ["google:synthetic-a", "google:synthetic-b"] } });
    expect(await place(slug), "an edit's ids replace the place's").toEqual({ ...harbour, name: "Synthetic Port", centre: { latitude: 10.5, longitude: 20.5 }, ids: ["google:synthetic-c"] });
    const homed = await at.ok({ of: "places", kind: "create", request: randomUUID(), name: "Synthetic Cottage", latitude: 30, longitude: 40, radius_m: 90, home: true });
    expect(await place(homed.id!.slice("place:".length)), "a place named as home is one act").toMatchObject({ name: "Synthetic Cottage", home: true });

    const many = Array.from({ length: 20 }, (_, n) => ({ latitude: 10 + n / 1000, longitude: 20, radius_m: 40 }));
    await at.refused({ of: "places", kind: "edit", request: randomUUID(), slug, also: many, was: { also: [] } }, 409, "CIRCLES_FULL");
    await at.ok({ of: "places", kind: "edit", request: randomUUID(), slug, also: many.slice(0, 19), was: { also: [] } });
    await at.refused({ of: "places", kind: "add-circle", request: randomUUID(), slug, latitude: 11, longitude: 21, radius_m: 40 }, 409, "CIRCLES_FULL");

    await at.refused({ of: "places", kind: "move", request: randomUUID(), slug }, 400, "BAD_ACTION");
    await at.refused({ of: "places", kind: "edit", request: randomUUID(), slug, colour: "red" }, 400, "BAD_ACTION");
    await at.refused({ of: "weather", kind: "edit", request: randomUUID(), slug }, 400, "BAD_ACTION");
    await at.refused(JSON.stringify({ kind: "edit", request: randomUUID(), slug }), 400, "BAD_ACTION");
    await at.refused({ of: "places", kind: "edit", request: randomUUID(), slug, radius_m: 5, was: { radius_m: 120 } }, 422, "STATEMENTS_BAD");
    await at.refused({ of: "places", kind: "edit", request: randomUUID(), slug: "no-such-place-000000", name: "Synthetic Nowhere" }, 404, "PLACE_UNKNOWN");

    const removed = await at.ok({ of: "places", kind: "remove", request: randomUUID(), slug });
    expect(removed).toMatchObject({ act: null, id: made.id });
    expect(await place(slug)).toBeNull();
    await at.refused({ of: "places", kind: "edit", request: randomUUID(), slug, name: "Synthetic Late" }, 404, "PLACE_UNKNOWN");
    await at.refused({ of: "places", kind: "remove", request: randomUUID(), slug }, 404, "PLACE_UNKNOWN");
    expect(await place(slug)).toBeNull();
    report.places = { made, renamed, circled, removed };
  });

  it("O9: an edit names what it was edited from: one from a stale read is 409 CHANGED, sealing nothing; a member no one else touched, or one changed alike elsewhere, lands; an edit whose was is missing or stray is refused", async () => {
    const made = await at.ok({ of: "places", kind: "create", request: randomUUID(), name: "Synthetic Pier", latitude: 12, longitude: 22, radius_m: 100 });
    const slug = made.id!.slice("place:".length);
    const edit = (members: Body) => ({ of: "places", kind: "edit", request: randomUUID(), slug, ...members });
    await at.refused(edit({ name: "Synthetic Jetty" }), 400, "BAD_ACTION");
    await at.refused(edit({ name: "Synthetic Jetty", was: { radius_m: 100 } }), 400, "BAD_ACTION");
    await at.refused(edit({ name: "Synthetic Jetty", was: { name: "Synthetic Pier", radius_m: 100 } }), 400, "BAD_ACTION");
    await at.refused(edit({ latitude: 12.5, longitude: 22.5, was: { latitude: 12 } }), 400, "BAD_ACTION");

    await at.ok(edit({ name: "Synthetic Jetty", was: { name: "Synthetic Pier" } }), PHONE);
    const mine = { latitude: 12.01, longitude: 22.01, radius_m: 50 };
    const phones = { latitude: 12.02, longitude: 22.02, radius_m: 50 };
    await at.ok({ of: "places", kind: "add-circle", request: randomUUID(), slug, ...mine });
    await at.ok({ of: "places", kind: "add-circle", request: randomUUID(), slug, ...phones }, PHONE);
    expect((await at.ok(edit({ radius_m: 140, was: { radius_m: 100 } }))).act, "a member the other device did not touch lands").toBeNull();
    const circles = [mine, phones].map(({ latitude, longitude, radius_m }) => ({ centre: { latitude, longitude }, radius_m }));
    const standing = { type: "places.place", name: "Synthetic Jetty", centre: { latitude: 12, longitude: 22 }, radius_m: 140, ids: [], also: circles };
    expect(await place(slug)).toEqual(standing);

    const renamed = await at.refused(edit({ name: "Synthetic Wharf", was: { name: "Synthetic Pier" } }), 409, "CHANGED");
    const undone = await at.refused(edit({ also: [], was: { also: [mine] } }), 409, "CHANGED");
    expect(await place(slug), "an Undo of an added circle from a list older than the phone's circle drops nothing").toEqual(standing);

    expect((await at.ok(edit({ name: "Synthetic Jetty", was: { name: "Synthetic Pier" } }))).act, "the same change made elsewhere already is no conflict").toBeNull();
    await at.ok(edit({ also: [mine], home: true, was: { also: [mine, phones], home: null } }));
    expect(await place(slug)).toEqual({ ...standing, also: circles.slice(0, 1), home: true });
    report.changed = { renamed, undone };
  });

  it("O10: a start reads no manifest of a delivery already in home.db: one whose manifest went missing stays as it was, and the writer still lands", async () => {
    const indexed = at.deliveries(PLACES).at(-1)!;
    const directory = join(root, "inbox", indexed.id);
    rmSync(join(directory, "manifest.json"));
    await home.stop();
    home = await startHome(root, { registry: REGISTRY, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    expect([existsSync(directory), at.deliveries(PLACES).find((each) => each.id === indexed.id)?.state]).toEqual([true, "imported"]);
    expect((await at.ok({ of: "places", kind: "hide", request: randomUUID(), latitude: -0.06, longitude: -0.06 })).id).toMatch(/^hidden:/u);
  });

  it("O7, O8: a spot hidden and unhidden, a camera's word said and forgotten, each in the records when answered; the bundle road refused for people, places and devices", async () => {
    const hidden = await at.ok({ of: "places", kind: "hide", request: randomUUID(), latitude: -0.05, longitude: -0.05 });
    expect(hidden.id).toMatch(/^hidden:hidden-[0-9a-f]{6}$/u);
    const key = hidden.id!.slice("hidden:".length);
    expect(await at.stated("hidden", key, PLACES)).toEqual({ type: "places.hidden", centre: { latitude: -0.05, longitude: -0.05 }, radius_m: 80 });
    expect(await at.ok({ of: "places", kind: "unhide", request: randomUUID(), key })).toMatchObject({ act: null, id: hidden.id });
    expect(await at.stated("hidden", key, PLACES)).toBeNull();
    await at.refused({ of: "places", kind: "unhide", request: randomUUID(), key }, 404, "PLACE_UNKNOWN");

    const word = { of: "devices", kind: "camera", request: randomUUID(), camera: CAMERA, mine: false, from: "2026-10-01" };
    const said = await at.ok(word, PHONE);
    expect(said).toMatchObject({ act: null, id: `camera:${CAMERA}` });
    expect(await at.stated("camera", CAMERA, DEVICES)).toEqual({ type: "devices.camera", mine: false, from: "2026-10-01" });
    expect((await at.ok({ ...word, request: randomUUID() })).act).toBeNull();
    expect(at.deliveries(DEVICES)).toHaveLength(1);
    await at.refused({ of: "devices", kind: "camera", request: randomUUID(), camera: CAMERA, mine: true, from: "2026-10-02", to: "2026-10-01" }, 422, "STATEMENTS_BAD");
    await at.refused({ of: "devices", kind: "camera", request: randomUUID(), camera: "Not A Camera", mine: true }, 422, "STATEMENTS_BAD");
    await at.ok({ of: "devices", kind: "forget", request: randomUUID(), camera: CAMERA });
    expect(await at.stated("camera", CAMERA, DEVICES)).toBeNull();
    await at.refused({ of: "devices", kind: "forget", request: randomUUID(), camera: CAMERA }, 404, "CAMERA_UNKNOWN");

    const refusals: Body[] = [];
    for (const [source, product, line] of [
      [PEOPLE, "people", { kind: "person", key: "person-z", content: record("person-z", "+15550000191", "Person Z") }],
      [PLACES, "places", { kind: "place", key: "synthetic-bundle-0a0a0a", content: { type: "places.place", name: "Synthetic Bundle", centre: { latitude: 0, longitude: 0 }, radius_m: 100, ids: [] } }],
      [DEVICES, "devices", { kind: "camera", key: CAMERA, content: { type: "devices.camera", mine: true } }],
    ] as const) {
      for (const token of [DASHBOARD, PHONE]) {
        const bundle = acquisitionBundle({ source, feeder: "owner-statements", fetched_ms: Date.now(), files: [["statements.ndjson", statements([line])["statements.ndjson"]]] });
        const response = await fetch(`${url}${bundle.path}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, ...(token === PHONE ? DEVICE.phone : {}) }, body: bundle.bytes });
        const body = await response.json() as Body;
        expect([response.status, body.code, body.message]).toEqual([403, "PRINCIPAL_SCOPE", `the owner's ${product} are changed through POST /v1/owner/act`]);
        expect(existsSync(join(root, "inbox", source, bundle.path.slice(bundle.path.lastIndexOf("/") + 1))), "a refused upload leaves no file").toBe(false);
        refusals.push(body);
      }
    }
    report.hidden = { hidden, said, refusals };
  });
});

describe("Kept requests", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("a request kept longer than seven days stays, or one kept less is let go", () => {
    const root = makeRoot("lifestream-owner-kept-", { sources: {} });
    roots.push(root);
    const db = openHomeDb(openHomeFolder(root), "migrate");
    const now = Date.UTC(2026, 10, 20);
    const kept = (at_ms: number | null) => JSON.stringify({ of: "places", act: null, kind: "edit", id: "place:synthetic-a", undoable: false, position: "1:1", ...(at_ms === null ? {} : { at_ms }) });
    try {
      db.commit((tx) => {
        tx.tables.meta.set(`${OWNER_REQUEST}old`, kept(now - KEPT_MS - 1));
        tx.tables.meta.set(`${OWNER_REQUEST}edge`, kept(now - KEPT_MS));
        tx.tables.meta.set(`${OWNER_REQUEST}new`, kept(now - 1));
        tx.tables.meta.set(`${OWNER_REQUEST}undated`, kept(null));
        tx.tables.meta.set("people:undo", "{}");
      });
      db.commit((tx) => forgetRequests(tx, now - KEPT_MS));
      const view = db.view();
      try {
        expect(view.tables.meta.under(OWNER_REQUEST)).toEqual(["edge", "new"]);
        expect(view.tables.meta.get("people:undo")).toBe("{}");
      } finally {
        view.close();
      }
    } finally {
      db.close();
    }
  });

  it("an erasure keeps each kept request, naming nothing, so a resend after it states nothing again; seven days still let it go", () => {
    const root = makeRoot("lifestream-owner-erased-", { sources: {} });
    roots.push(root);
    const db = openHomeDb(openHomeFolder(root), "migrate");
    const now = Date.UTC(2026, 10, 20);
    try {
      db.commit((tx) => {
        tx.tables.meta.set(`${OWNER_REQUEST}made`, JSON.stringify({ of: "places", act: "places:local:unit-a/20261120T000000Z.0123456789ab", kind: "create", id: "place:synthetic-a-0a0a0a", undoable: true, position: "4:1", at_ms: now }));
        tx.tables.meta.set(`${OWNER_REQUEST}torn`, "{");
      });
      db.commit((tx) => tx.records.erase({ records: [], reason: "the owner's", at_ms: now }));
      const read = <T>(work: (view: ReturnType<typeof db.view>) => T): T => {
        const view = db.view();
        try {
          return work(view);
        } finally {
          view.close();
        }
      };
      expect(read((view) => [view.tables.meta.under(OWNER_REQUEST), JSON.parse(view.tables.meta.get(`${OWNER_REQUEST}made`)!)])).toEqual([
        ["made"], { of: "places", act: null, kind: "create", id: null, undoable: false, position: "4:1", at_ms: now },
      ]);
      db.commit((tx) => forgetRequests(tx, now + 1));
      expect(read((view) => view.tables.meta.under(OWNER_REQUEST))).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("An act waiting for the writer", () => {
  it("is dropped at once when its caller leaves, refused NOT_BEGUN, and never begun after: also when it left before it queued", async () => {
    let held = true;
    const writer = new OwnerWriter({} as WriterHost, {} as Record<"people" | "places" | "devices", Drafter>, () => held);
    const begun: string[] = [];
    const callOf = (name: string, left: AbortController) => ({ left: left.signal, sent_ms: null, began: () => { begun.push(name); } });
    const leaving = new AbortController();
    const acting = writer.act("device-a", { of: "people", kind: "confirm", request: "request-left" }, callOf("left", leaving)).then(() => null, (error: unknown) => error);
    leaving.abort();
    expect(await acting).toMatchObject({ code: NOT_NOW, words: NOT_BEGUN });
    const gone = new AbortController();
    gone.abort();
    expect(await writer.act("device-a", { of: "people", kind: "confirm", request: "request-gone" }, callOf("gone", gone)).then(() => null, (error: unknown) => error))
      .toMatchObject({ code: NOT_NOW, words: NOT_BEGUN });
    held = false;
    writer.drain();
    expect(begun).toEqual([]);
  });
});

describe("You through the writer", () => {
  const roots: string[] = [];
  const report: Record<string, unknown> = {};
  afterAll(() => {
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "owner-act-you.json"), `${JSON.stringify(report, null, 2)}\n`);
    for (const root of roots) removeRoot(root);
  });

  const open = (prefix: string) => openHome(prefix, roots);

  it("Y1, Y2, Y4-Y8: `you` makes one You however often it is asked, People held or not; You's rules; a person added is merged; Also called and details on the root; an old mark never revives", async () => {
    const home = await open("lifestream-owner-act-you-");
    const { at } = home;
    try {
      const OWN_WA = `whatsapp:15550000300:${UNIT}`;
      await home.send(BOOK, [
        card("FN:Person Friend", "TEL;TYPE=CELL:+15550000321"), card("FN:Person Bear", "NICKNAME:Bear", "TEL;TYPE=CELL:+15550000341"),
        card("FN:Person Twin", "TEL;TYPE=CELL:+15550000331"), card("FN:Person Other", "TEL;TYPE=CELL:+15550000351"),
      ]);
      await home.say([
        { kind: "person", key: "person-rec", content: record("person-rec", "+15550000322", "Person Rec") },
        { kind: "person", key: "person-bday", content: record("person-bday", "+15550000324", "Person Bday") },
        { kind: "details", key: "person:person-bday", content: { type: "people.details", work: null, birthday: { month: 5, day: 6, year: null }, profiles: [] } },
        { kind: "person", key: "person-rocky", content: { ...record("person-rocky", "+15550000342", "Person Rocky"), also_called: ["Rocky"] } },
        { kind: "person", key: "person-twin", content: { ...record("person-twin", "+15550000332", "Person Twin"), full_name: "Person Twin" } },
      ]);
      expect((await home.list("People prepared over the cast")).you).toBeNull();
      expect(await home.setupYou()).toBe(false);

      await askHome(home.sock, "pause", ["kind:people", "--reason", "a test holds People's publish"]);
      await at.refused({ kind: "you", request: randomUUID(), name: "  " }, 400, "BAD_ACTION");
      await at.refused({ kind: "you", request: randomUUID(), full_name: "Sam Example" }, 400, "BAD_ACTION");
      const named = { kind: "you", request: randomUUID(), name: "Sam", full_name: "Sam Example" };
      const first = await at.ok(named);
      expect(first.id).toBe("person:sam");
      expect(await at.stated("person", "sam")).toMatchObject({ name: "Sam", full_name: "Sam Example", show: "name", me: true, anchor: null, handles: [], merged_into: null });
      const relaunched = await at.ok({ ...named, request: randomUUID() });
      expect([relaunched.act, relaunched.id]).toEqual([null, "person:sam"]);
      expect(await at.ok(named)).toMatchObject({ act: first.act, id: "person:sam" });
      await at.refused({ kind: "undo", request: randomUUID(), act: first.act }, 409, "NOTHING_TO_UNDO");
      const nicknamed = await at.ok({ kind: "confirm", request: randomUUID(), id: first.id, add_names: ["Sammy"] });
      expect(await at.stated("person", "sam")).toMatchObject({ me: true, also_called: ["Sammy"] });
      const heldYou = (await at.get("/v1/people")).body.you;
      expect([heldYou, heldYou.counting]).toEqual([expect.objectContaining({ id: "person:sam", me: true, name: "Sam", also_called: [{ name: "Sammy", from: "You added" }] }), undefined]);
      expect(await home.setupYou()).toBe(true);
      expect(readHome(home.root, (db) => db.prepare("SELECT key FROM heads WHERE source = ? AND kind = 'person' ORDER BY key").pluck().all(PEOPLE))).toEqual(["person-bday", "person-rec", "person-rocky", "person-twin", "sam"]);
      await askHome(home.sock, "resume", ["kind:people"]);
      await until("People past the confirm", () => at.heard(nicknamed.position));
      expect((await home.list("People served You")).you).toMatchObject({ id: "person:sam", me: true, also_called: [{ name: "Sammy", from: "You added" }] });
      const renamed = await at.ok({ kind: "you", request: randomUUID(), name: "Sam B" });
      expect(renamed.id).toBe("person:sam");
      expect(await at.stated("person", "sam")).toMatchObject({ name: "Sam B", full_name: "Sam Example", me: true });
      await at.ok({ kind: "undo", request: randomUUID(), act: renamed.act });
      expect(await at.stated("person", "sam")).toMatchObject({ name: "Sam", full_name: "Sam Example", me: true });
      report.you = { first, relaunched, nicknamed, renamed };

      await home.send(OWN_WA, [wa("L1", "15550000323@s.whatsapp.net", T)], true);
      const you = (await home.list("People over the own account")).you as Body;
      expect(you.id).toBe("person:sam");
      expect((you.handles as Body[]).map((each) => [each.id, each.from, each.own])).toEqual([["phone:+15550000300", "Your WhatsApp", true]]);

      for (const field of [{ relationship: "self" }, { entity: "person" }, { hidden: true }]) {
        const refusal = await at.refused({ kind: "confirm", request: randomUUID(), id: you.id, ...field }, 400, "BAD_ACTION");
        expect(refusal.message).toBe("You are always you: no relationship, type or Hide.");
      }
      const own = await at.refused({ kind: "confirm", request: randomUUID(), id: you.id, unlink: ["phone:+15550000300"] }, 409, "OWN_ACCOUNT");
      expect(own.message).toBe("Lifestream reads your WhatsApp from this account: it stays yours.");
      for (const added of [you.id, "phone:+15550000300"]) {
        const refusal = await at.refused({ kind: "confirm", request: randomUUID(), id: "phone:+15550000351", add: [added] }, 409, "IS_YOU");
        expect(refusal.message).toBe("You can't be joined into someone else. Add them from your own page.");
      }
      await ship(home.root, { source: FACES, fetched_ms: T, rows: [cluster("c1", ["y1", "y2"])] as never });
      await until("the faces landed", () => at.settled());
      await at.refused({ kind: "name", request: randomUUID(), cluster: "c1", target: { kind: "person", id: you.id }, me: true }, 400, "BAD_ACTION");
      await at.refused({ kind: "name", request: randomUUID(), cluster: "c1", target: { kind: "new", name: "Person N" }, merge: "sam" }, 400, "BAD_ACTION");
      await at.refused({ kind: "confirm", request: randomUUID(), id: "me", add_names: ["Sammy B"] }, 400, "BAD_ACTION");
      await at.refused({ kind: "photo", request: randomUUID(), id: "me", upload: jpeg("me", 1024).toString("base64") }, 400, "BAD_ACTION");
      await at.refused({ kind: "confirm", request: randomUUID(), id: you.id, add: ["me"] }, 400, "BAD_ACTION");
      const faced = await at.ok({ kind: "name", request: randomUUID(), cluster: "c1", target: { kind: "person", id: you.id } });
      expect([faced.id, await at.stated("face", faceOf("y1"))]).toEqual(["person:sam", { is: "sam" }]);

      const lone = (await at.person("phone:+15550000323")).person;
      expect([lone.by, lone.card, lone.handles.length, lone.person]).toEqual(["none", false, 1, null]);
      const added = await at.ok({ kind: "confirm", request: randomUUID(), id: you.id, add: ["person:person-rec", "phone:+15550000321", "phone:+15550000323"] });
      expect(await at.stated("person", "person-rec")).toMatchObject({ merged_into: "sam" });
      expect(await at.stated("person", "person-friend")).toMatchObject({ anchor: { kind: "phone", value: "+15550000321" }, merged_into: "sam", me: false });
      expect(await at.stated("person", "sam")).toMatchObject({ me: true, handles: [{ kind: "phone", value: "+15550000323" }] });
      await until("People past the merge", () => at.heard(added.position));
      expect(((await at.person("me")).person.joined as Body[]).map((each) => each.id).sort()).toEqual(["person:person-friend", "person:person-rec"]);
      await at.ok({ kind: "undo", request: randomUUID(), act: added.act });
      expect(await at.stated("person", "person-friend")).toMatchObject({ merged_into: null });
      expect(await at.stated("person", "person-rec")).toMatchObject({ merged_into: null });
      expect((await at.stated("person", "sam"))?.handles).toEqual([]);
      await until("People past the undo", () => at.settled());
      expect((await at.person("phone:+15550000321")).person.id).toBe("person:person-friend");
      report.merged = { added };

      await at.ok({ kind: "confirm", request: randomUUID(), id: you.id, add: ["person:person-bday"] });
      const worked = await at.ok({ kind: "confirm", request: randomUUID(), id: you.id, details: { work: "Example Studio" } });
      expect(await at.stated("details", "person:sam")).toEqual({ type: "people.details", work: "Example Studio", birthday: null, profiles: [] });
      await until("People past the work", () => at.heard(worked.position));
      expect((await at.person("me")).person.details).toEqual({ work: "Example Studio", birthday: { month: 5, day: 6, year: null }, profiles: [] });
      const cleared = await at.ok({ kind: "confirm", request: randomUUID(), id: you.id, details: { birthday: null } });
      expect(await at.stated("details", "person:sam")).toEqual({ type: "people.details", work: "Example Studio", birthday: null, profiles: [], cleared: ["birthday"] });
      expect(await at.stated("details", "person:person-bday")).toMatchObject({ birthday: { month: 5, day: 6, year: null } });
      await until("People past the clearing", () => at.heard(cleared.position));
      expect((await at.person("me")).person.details).toEqual({ work: "Example Studio", birthday: null, profiles: [] });
      const given = await at.ok({ kind: "confirm", request: randomUUID(), id: you.id, details: { birthday: { month: 1, day: 2 } } });
      expect(await at.stated("details", "person:sam")).toEqual({ type: "people.details", work: "Example Studio", birthday: { month: 1, day: 2, year: null }, profiles: [] });
      await at.ok({ kind: "undo", request: randomUUID(), act: given.act });
      expect(await at.stated("details", "person:sam")).toEqual({ type: "people.details", work: "Example Studio", birthday: null, profiles: [], cleared: ["birthday"] });
      report.details = { worked, cleared, given };

      await at.ok({ kind: "confirm", request: randomUUID(), id: "phone:+15550000341", add: ["person:person-rocky"] });
      const bear = (await at.stated("person", "person-bear"))!;
      expect(bear).toMatchObject({ merged_into: null, also_called: [] });
      const bearId = "person:person-bear";
      await until("People past Bear's merge", () => at.settled());
      expect((await at.person(bearId)).person.also_called).toEqual([{ name: "Rocky", from: "You added" }, { name: "Bear", from: "Contacts" }]);
      const off = await at.ok({ kind: "confirm", request: randomUUID(), id: bearId, remove_names: ["Bear", "rocky"] });
      expect(await at.stated("person", "person-bear")).toMatchObject({ also_called: [], dismissed: [calledId("Bear"), calledId("rocky")].sort() });
      expect(await at.stated("person", "person-rocky")).toMatchObject({ also_called: ["Rocky"], merged_into: "person-bear" });
      await until("People past the removal", () => at.heard(off.position));
      expect((await at.person(bearId)).person.also_called).toEqual([]);
      await at.ok({ kind: "confirm", request: randomUUID(), id: bearId, add_names: [" Teddy  Bear "] });
      expect(await at.stated("person", "person-bear")).toMatchObject({ also_called: ["Teddy Bear"] });
      await at.ok({ kind: "confirm", request: randomUUID(), id: bearId, remove_names: ["teddy bear"] });
      expect(await at.stated("person", "person-bear")).toMatchObject({ also_called: [], dismissed: [calledId("Bear"), calledId("rocky"), calledId("Teddy Bear")].sort() });
      const back = await at.ok({ kind: "confirm", request: randomUUID(), id: bearId, add_names: ["Bear"] });
      expect(await at.stated("person", "person-bear")).toMatchObject({ also_called: ["Bear"], dismissed: [calledId("rocky"), calledId("Teddy Bear")].sort() });
      await until("People past the name given back", () => at.heard(back.position));
      expect((await at.person(bearId)).person.also_called).toEqual([{ name: "Bear", from: "You added" }]);
      const more = Array.from({ length: 11 }, (_, index) => `Name ${String.fromCharCode(97 + index)}`);
      await at.ok({ kind: "confirm", request: randomUUID(), id: bearId, add_names: more });
      expect((await at.stated("person", "person-bear"))?.also_called).toHaveLength(12);
      const full = await at.refused({ kind: "confirm", request: randomUUID(), id: bearId, add_names: ["Name z"] }, 409, "NAMES_FULL");
      expect(full.message).toBe("A person has at most 12 other names.");
      await at.refused({ kind: "confirm", request: randomUUID(), id: bearId, add_names: ["x".repeat(61)] }, 400, "BAD_ACTION");
      await at.refused({ kind: "confirm", request: randomUUID(), id: bearId, add_names: ["Bear B"], remove_names: ["bear b"] }, 400, "BAD_ACTION");
      const removal = await at.ok({ kind: "confirm", request: randomUUID(), id: bearId, remove_names: ["Name a", "Never Added"] });
      expect((await at.stated("person", "person-bear"))?.also_called).toHaveLength(11);
      await at.ok({ kind: "undo", request: randomUUID(), act: removal.act });
      expect((await at.stated("person", "person-bear"))?.also_called).toHaveLength(12);

      await until("People past the names given back", () => at.settled());
      const twin = (await at.person("phone:+15550000331")).person;
      const same = (twin.suggestions as Body[]).find((each) => each.kind === "same" && each.value === "person-twin");
      expect(same, JSON.stringify(twin.suggestions)).toBeDefined();
      await askHome(home.sock, "pause", ["kind:people", "--reason", "a test holds People's publish"]);
      await home.say([{ kind: "person", key: "person-twin", content: { ...record("person-twin", "+15550000332", "Person Twin"), full_name: "Person Twin", me: true } }]);
      await at.refused({ kind: "confirm", request: randomUUID(), id: twin.id, accept: [same!.id] }, 409, "IS_YOU");
      const before = await at.stated("person", "sam");
      const edited = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:sam", add_names: ["Old Sam"] });
      expect(await at.stated("person", "sam")).toEqual({ ...before, also_called: ["Old Sam", "Sammy"] });
      await at.ok({ kind: "undo", request: randomUUID(), act: edited.act });
      expect(await at.stated("person", "sam")).toEqual(before);
      expect(await at.stated("person", "person-twin")).toMatchObject({ me: true });
      await askHome(home.sock, "resume", ["kind:people"]);
      expect((await home.list("People over the twin's mark")).you).toMatchObject({ id: "person:person-twin" });
      report.marks = { same, edited };
    } finally {
      await home.close();
    }
  });

  it("Y3: a holder home's You gets their first record, marked, by whatever edit comes first; `you` there and on a root no record marks", async () => {
    const home = await open("lifestream-owner-act-holder-");
    const { at } = home;
    try {
      const OWN_WA = `whatsapp:15550000400:${UNIT}`;
      await home.send(OWN_WA, [wa("H1", "15550000411@s.whatsapp.net", T)], true);
      await ship(home.root, { source: FACES, fetched_ms: T, rows: [cluster("h1", ["h1a", "h1b"])] as never });
      const holder = async () => {
        const you = (await home.list("People served the holder")).you as Body;
        expect([you.person, you.me, you.id]).toEqual([null, true, "phone:+15550000400"]);
        return you.id as string;
      };
      const firsts: Body[] = [];
      const aside = (slug: string, index: number) => home.say([{ kind: "person", key: slug, content: record(slug, `+1555000049${index}`, `Set Aside ${index}`) }]);
      for (const [index, kind] of (["confirm", "photo", "maybe", "name"] as const).entries()) {
        const id = await holder();
        const action = kind === "confirm" ? { id, add_names: ["Me Too"] }
          : kind === "photo" ? { id, upload: jpeg("holder", 1024).toString("base64") }
            : kind === "maybe" ? { id, yes: [faceOf(`maybe-${kind}`)] }
              : { cluster: "h1", target: { kind: "person", id } };
        const answer = await at.ok({ kind, request: randomUUID(), ...action });
        const slug = answer.id!.slice("person:".length);
        expect(await at.stated("person", slug), kind).toMatchObject({ me: true, anchor: { kind: "phone", value: "+15550000400" }, merged_into: null });
        expect((await home.list(`People over ${kind}`)).you, kind).toMatchObject({ id: answer.id, me: true });
        if (kind === "confirm") {
          await at.ok({ kind: "undo", request: randomUUID(), act: answer.act });
          expect(await at.stated("person", slug)).toMatchObject({ me: true, also_called: [] });
        }
        firsts.push({ kind, answer });
        await aside(slug, index);
      }
      report.holder = firsts;

      const held = await holder();
      await askHome(home.sock, "pause", ["kind:people", "--reason", "a test holds People's publish"]);
      const named = await at.ok({ kind: "you", request: randomUUID(), name: "Riley" });
      expect(await at.stated("person", "riley")).toMatchObject({ me: true, anchor: null, handles: [] });
      const nicknamed = await at.ok({ kind: "confirm", request: randomUUID(), id: held, add_names: ["Ri Ri"] });
      expect(nicknamed.id).toBe(named.id);
      expect(await at.stated("person", "riley")).toMatchObject({ me: true, also_called: ["Ri Ri"] });
      expect(readHome(home.root, (db) => db.prepare("SELECT key FROM heads WHERE source = ? AND kind = 'person' ORDER BY key").pluck().all(PEOPLE))).toEqual([...firsts.map((each) => each.answer.id.slice("person:".length)), "riley"].sort());
      await askHome(home.sock, "resume", ["kind:people"]);
      const you = (await home.list("People over Riley")).you as Body;
      expect([you.id, (you.handles as Body[]).map((each) => each.id)]).toEqual([named.id, ["phone:+15550000400"]]);
      await aside("riley", 5);

      const claim = { kind: "person", key: "person-claim", content: record("person-claim", "+15550000400", "Person Claim") };
      await home.say([claim]);
      expect((await home.list("People over the claim")).you).toMatchObject({ id: "person:person-claim", me: true });
      const marked = await at.ok({ kind: "you", request: randomUUID(), name: "Riley", full_name: "Riley Example" });
      expect(marked.id).toBe("person:person-claim");
      expect(await at.stated("person", "person-claim")).toMatchObject({ name: "Riley", full_name: "Riley Example", me: true });
      await at.ok({ kind: "undo", request: randomUUID(), act: marked.act });
      expect(await at.stated("person", "person-claim")).toMatchObject({ name: "Person Claim", me: false });
      const restated = await at.ok({ kind: "confirm", request: randomUUID(), id: "person:person-claim", add_names: ["Ri"] });
      expect(await at.stated("person", "person-claim")).toMatchObject({ me: true, also_called: ["Ri"] });
      report.claim = { named, marked, restated };
    } finally {
      await home.close();
    }
  });

  it("Y9: a holder served by a number that is no own account: a confirm, then a photo by that id before People publishes, both on You's one first record", async () => {
    const home = await open("lifestream-owner-act-holder-card-");
    const { at } = home;
    try {
      const OWN_WA = `whatsapp:15550000500:${UNIT}`;
      await home.send(BOOK, [card("FN:Owner Card", "TEL;TYPE=CELL:+15550000499", "TEL;TYPE=CELL:+15550000500")]);
      await home.send(OWN_WA, [wa("C1", "15550000511@s.whatsapp.net", T)], true);
      const held = (await home.list("People served the holder")).you as Body;
      expect([held.id, held.person, held.me]).toEqual(["phone:+15550000499", null, true]);
      await askHome(home.sock, "pause", ["kind:people", "--reason", "a test holds People's publish"]);
      const confirmed = await at.ok({ kind: "confirm", request: randomUUID(), id: held.id, add_names: ["Owner Nick"] });
      const slug = confirmed.id!.slice("person:".length);
      expect(await at.stated("person", slug)).toMatchObject({ me: true, anchor: { kind: "phone", value: "+15550000500" }, also_called: ["Owner Nick"] });
      const pictured = await at.ok({ kind: "photo", request: randomUUID(), id: held.id, upload: jpeg("owner card", 1024).toString("base64") });
      expect(pictured.id).toBe(confirmed.id);
      expect(readHome(home.root, (db) => db.prepare("SELECT key FROM heads WHERE source = ? AND kind = 'person'").pluck().all(PEOPLE))).toEqual([slug]);
      expect(await at.stated("photo", confirmed.id!)).toEqual({ type: "people.photo", image: sha(jpeg("owner card", 1024)) });
      await askHome(home.sock, "resume", ["kind:people"]);
      await until("People past the photo", () => at.heard(pictured.position));
      expect((await at.get("/v1/people")).body.you).toMatchObject({ id: confirmed.id, me: true, photo: { crop: sha(jpeg("owner card", 1024)) } });
      report.holderCard = { confirmed, pictured };
    } finally {
      await home.close();
    }
  });
});

describe("The one-You rule", () => {
  const OWN = { kind: "phone" as const, value: "+15550000400" };
  const OTHER = { kind: "phone" as const, value: "+15550000401" };
  it("allows the root, the holder's one first record of an own account, or the `you` action's record, and throws for anything else", () => {
    expect(() => oneYou({ root: "sam", marked: true }, [{ slug: "sam", anchor: null, first: false }], [OWN], null)).not.toThrow();
    expect(() => oneYou({ root: "sam", marked: false }, [{ slug: "riley", anchor: null, first: false }], [OWN], null)).toThrow(/riley/u);
    expect(() => oneYou({ holder: true }, [{ slug: "own", anchor: OWN, first: true }], [OWN], null)).not.toThrow();
    expect(() => oneYou({ holder: true }, [{ slug: "own", anchor: OWN, first: false }], [OWN], null)).toThrow();
    expect(() => oneYou({ holder: true }, [{ slug: "other", anchor: OTHER, first: true }], [OWN], null)).toThrow();
    expect(() => oneYou({ holder: true }, [{ slug: "own", anchor: OWN, first: true }, { slug: "own-2", anchor: OWN, first: true }], [OWN], null)).toThrow(/own-2/u);
    expect(() => oneYou({ holder: true }, [{ slug: "sam", anchor: null, first: true }], [OWN], "sam")).not.toThrow();
    expect(() => oneYou(null, [{ slug: "sam", anchor: null, first: true }], [], "sam")).not.toThrow();
    expect(() => oneYou(null, [{ slug: "sam", anchor: null, first: true }], [], null)).toThrow();
  });
});

describe("Split off through the writer", () => {
  const roots: string[] = [];
  const report: Record<string, unknown> = {};
  afterAll(() => {
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "owner-act-split.json"), `${JSON.stringify(report, null, 2)}\n`);
    for (const root of roots) removeRoot(root);
  });
  const phone = (value: string) => ({ kind: "phone", value });
  const ids = (person: Body) => (person.handles as Body[]).map((each) => each.id as string).sort();
  const offersSame = (person: Body, slug: string) => (person.suggestions as Body[]).some((each) => each.kind === "same" && each.value === slug);
  const settledAfter = async (at: ReturnType<typeof through>, action: Body) => {
    const answer = await at.ok({ request: randomUUID(), kind: "confirm", ...action });
    await until(`People past ${action.id}'s confirm`, () => at.heard(answer.position));
    return answer;
  };

  it("S1, S5, S6, S8-S10, S12: a split long after the merge gives back the person as they were, takes their whole branch, keeps R's, is refused when not joined, and its Undo is whole", async () => {
    const home = await openHome("lifestream-people-split-", roots);
    const { at } = home;
    try {
      const R = "person:person-ar";
      const X = "person:person-ex";
      const SHARED = "person-shared@example.com";
      await home.send(BOOK, [
        card("FN:Person Ar", "TEL;TYPE=CELL:+15550000601", `EMAIL:${SHARED}`),
        card("FN:Person Ex", "TEL;TYPE=CELL:+15550000611", "TEL;TYPE=CELL:+15550000612", `EMAIL:${SHARED}`),
        card("FN:Person Nx", "TEL;TYPE=CELL:+15550000631", "TEL;TYPE=CELL:+15550000632"),
      ]);
      await home.say([
        { kind: "person", key: "person-ar", content: { ...record("person-ar", "+15550000601", "Person Ar"), full_name: "Person Same Name" } },
        { kind: "person", key: "person-ex", content: { ...record("person-ex", "+15550000611", "Person Ex"), full_name: "Person Same Name", also_called: ["Exy"] } },
        { kind: "details", key: "person:person-ex", content: { type: "people.details", work: null, birthday: { month: 3, day: 4, year: null }, profiles: [] } },
        { kind: "person", key: "person-ca", content: record("person-ca", "+15550000621", "Person Ca") },
        { kind: "person", key: "person-cb", content: record("person-cb", "+15550000622", "Person Cb") },
        { kind: "person", key: "person-cc", content: record("person-cc", "+15550000623", "Person Cc") },
        { kind: "person", key: "person-na", content: record("person-na", "+15550000641", "Person Na") },
        { kind: "person", key: "person-nb", content: record("person-nb", "+15550000642", "Person Nb") },
        { kind: "person", key: "person-nx", content: record("person-nx", "+15550000631", "Person Nx") },
        { kind: "person", key: "person-y", content: record("person-y", "+15550000651", "Person Y") },
      ]);
      await ship(home.root, { source: FACES, fetched_ms: T, rows: [cluster("s1", ["sx1", "sx2"]), cluster("s2", ["sr1", "sr2"])] as never });
      await home.list("People over the cast");

      const alone = async () => Promise.all([X, R, "phone:+15550000612", `email:${SHARED}`].map(async (id) => [ids((await at.person(id)).person), (await at.person(id)).person.id]));
      const apartBefore = await alone();
      expect(apartBefore.slice(0, 2)).toEqual([[["phone:+15550000611"], X], [["phone:+15550000601"], R]]);
      const offer = ((await at.person(R)).person.suggestions as Body[]).find((each) => each.kind === "same" && each.value === "person-ex");
      expect(offer?.reasons).toMatchObject({ linked: 1, named: 1 });
      await at.ok({ kind: "name", request: randomUUID(), cluster: "s1", target: { kind: "person", id: X } });
      const picture = jpeg("person ex", 1024);
      await at.ok({ kind: "photo", request: randomUUID(), id: X, upload: picture.toString("base64") });
      const merged = await settledAfter(at, { id: R, accept: [offer!.id] });
      expect(await at.stated("person", "person-ex")).toMatchObject({ merged_into: "person-ar" });
      await settledAfter(at, { id: R, add_names: ["Arr"], details: { work: "Example Works" }, unlink: ["phone:+15550000612"], groups: ["s2"] });
      const later = await settledAfter(at, { id: R, relationship: "friend" });
      const joinedR = (await at.person(R)).person;
      expect(joinedR.details).toEqual({ work: "Example Works", birthday: { month: 3, day: 4, year: null }, profiles: [] });
      expect((joinedR.joined as Body[]).map((each) => [each.id, each.handles])).toEqual([[X, ["phone:+15550000611", "phone:+15550000612"]]]);
      const rBefore = (await at.stated("person", "person-ar"))!;
      const xBefore = (await at.stated("person", "person-ex"))!;
      expect(rBefore.excluded).toEqual([phone("+15550000612")]);

      const split = await settledAfter(at, { id: R, split: [X] });
      expect(split.id).toBe(R);
      expect(at.manifest(split.act!).facts).toMatchObject({ action: "confirm", id: R, statements: 2 });
      expect(await at.stated("person", "person-ex")).toEqual({ ...xBefore, merged_into: null });
      expect(await at.stated("person", "person-ar")).toEqual({ ...rBefore, excluded: [], dismissed: [...rBefore.dismissed, sameIdOf(R, X)].sort() });
      const x = (await at.person(X)).person;
      const r = (await at.person(R)).person;
      expect(await alone()).toEqual(apartBefore);
      expect([x.photo, x.details, x.also_called, x.joined]).toEqual([
        { crop: sha(picture) }, { work: null, birthday: { month: 3, day: 4, year: null }, profiles: [] }, [{ name: "Exy", from: "You added" }], [],
      ]);
      expect([r.photo, r.details, r.also_called, r.relationship, r.joined]).toEqual([
        null, { work: "Example Works", birthday: null, profiles: [] }, [{ name: "Arr", from: "You added" }], "friend", [],
      ]);
      expect([await at.stated("face", faceOf("sx1")), await at.stated("face", faceOf("sr1"))]).toEqual([{ is: "person-ex" }, { is: "person-ar" }]);
      expect([offersSame(r, "person-ex"), offersSame(x, "person-ar")]).toEqual([false, false]);

      const undone = await at.ok({ kind: "undo", request: randomUUID(), act: split.act });
      expect([await at.stated("person", "person-ex"), await at.stated("person", "person-ar")]).toEqual([xBefore, rBefore]);
      await until("People past the split's undo", () => at.heard(undone.position));
      expect(((await at.person(R)).person.joined as Body[]).map((each) => each.id)).toEqual([X]);
      report.split = { merged, later, split, undone, x, r };

      for (const id of [R, "person:person-ca", "person:no-such-person"]) {
        const refusal = await at.refused({ kind: "confirm", request: randomUUID(), id: R, split: [id] }, 409, "NOT_JOINED");
        expect(refusal.message).toBe("They are not joined into this person any more: open the person again.");
      }
      await at.refused({ kind: "confirm", request: randomUUID(), id: R, split: [X], add: [X] }, 400, "BAD_ACTION");
      await at.refused({ kind: "confirm", request: randomUUID(), id: R, split: ["phone:+15550000611"] }, 400, "BAD_ACTION");
      await at.refused({ kind: "confirm", request: randomUUID(), id: R, split: "person-ex" }, 400, "BAD_ACTION");
      await settledAfter(at, { id: R, split: [X] });
      await at.refused({ kind: "confirm", request: randomUUID(), id: R, split: [X] }, 409, "NOT_JOINED");
      await askHome(home.sock, "pause", ["kind:people", "--reason", "a test holds People's publish"]);
      await at.ok({ kind: "confirm", request: randomUUID(), id: R, add: ["person:person-y"] });
      const withY = (await at.person("person:person-y")).person;
      expect([withY.id, (withY.joined as Body[]).map((each) => [each.id, each.handles]), withY.counting]).toEqual([R, [["person:person-y", ["phone:+15550000651"]]], undefined]);
      const splitY = await at.ok({ kind: "confirm", request: randomUUID(), id: R, split: ["person:person-y"] });
      expect(await at.stated("person", "person-y")).toMatchObject({ merged_into: null });
      expect([(await at.person("person:person-y")).person.id, (await at.person(R)).person.joined]).toEqual(["person:person-y", []]);
      await askHome(home.sock, "resume", ["kind:people"]);
      await until("People past Y's split", () => at.heard(splitY.position));
      expect((await at.person("person:person-y")).person).toMatchObject({ id: "person:person-y", handles: [{ id: "phone:+15550000651" }] });

      await settledAfter(at, { id: "person:person-cb", add: ["person:person-cc"] });
      await settledAfter(at, { id: "person:person-ca", add: ["person:person-cb"] });
      expect(((await at.person("person:person-ca")).person.joined as Body[]).map((each) => [each.id, each.handles, each.with])).toEqual([
        ["person:person-cc", ["phone:+15550000623"], []], ["person:person-cb", ["phone:+15550000622", "phone:+15550000623"], ["Person Cc"]],
      ]);
      const chain = await settledAfter(at, { id: "person:person-ca", split: ["person:person-cb"] });
      expect([(await at.stated("person", "person-cb"))?.merged_into, (await at.stated("person", "person-cc"))?.merged_into]).toEqual([null, "person-cb"]);
      expect([ids((await at.person("person:person-ca")).person), ids((await at.person("person:person-cb")).person)]).toEqual([
        ["phone:+15550000621"], ["phone:+15550000622", "phone:+15550000623"],
      ]);
      const chainUndone = await at.ok({ kind: "undo", request: randomUUID(), act: chain.act });
      await until("People past the chain's undo", () => at.heard(chainUndone.position));
      await settledAfter(at, { id: "person:person-ca", split: ["person:person-cc"] });
      expect([(await at.stated("person", "person-cb"))?.merged_into, (await at.stated("person", "person-cc"))?.merged_into]).toEqual(["person-ca", null]);
      expect([ids((await at.person("person:person-ca")).person), ids((await at.person("person:person-cc")).person)]).toEqual([
        ["phone:+15550000621", "phone:+15550000622"], ["phone:+15550000623"],
      ]);

      await settledAfter(at, { id: "person:person-nb", add: ["person:person-nx"] });
      await settledAfter(at, { id: "person:person-nb", unlink: ["phone:+15550000632"] });
      await home.say([{ kind: "person", key: "person-na", content: { ...(await at.stated("person", "person-na"))!, excluded: [phone("+15550000632")] } }]);
      await settledAfter(at, { id: "person:person-na", add: ["person:person-nb"] });
      const nest = (await at.person("person:person-na")).person;
      expect(ids(nest)).not.toContain("phone:+15550000632");
      expect((nest.joined as Body[]).find((each) => each.id === "person:person-nx")?.handles).toEqual(["phone:+15550000631", "phone:+15550000632"]);
      const [naBefore, nbBefore] = [(await at.stated("person", "person-na"))!, (await at.stated("person", "person-nb"))!];
      expect([naBefore.excluded, nbBefore.excluded]).toEqual([[phone("+15550000632")], [phone("+15550000632")]]);
      const nested = await settledAfter(at, { id: "person:person-na", split: ["person:person-nx"] });
      expect([(await at.stated("person", "person-na"))?.excluded, (await at.stated("person", "person-nb"))?.excluded]).toEqual([[], []]);
      expect((await at.person("phone:+15550000632")).person.id).toBe("person:person-nx");
      const nestUndone = await at.ok({ kind: "undo", request: randomUUID(), act: nested.act });
      expect([await at.stated("person", "person-na"), await at.stated("person", "person-nb")]).toEqual([naBefore, nbBefore]);
      await until("People past the nest's undo", () => at.heard(nestUndone.position));
      expect(ids((await at.person("person:person-na")).person)).not.toContain("phone:+15550000632");
      report.nest = { nested, nestUndone };
    } finally {
      await home.close();
    }
  });

  it("S2: the membership read while People is held: a split and R's details in one Save, then R's edits see X's statements as X's, and X's own edits land on X at once", async () => {
    const home = await openHome("lifestream-people-split-stale-", roots);
    const { at } = home;
    try {
      const R = "person:person-sr";
      const X = "person:person-sx";
      await home.send(BOOK, [card("FN:Person Sr", "TEL;TYPE=CELL:+15550000701"), card("FN:Person Sx", "TEL;TYPE=CELL:+15550000711"), card("FN:Person Sz", "TEL;TYPE=CELL:+15550000721")]);
      await home.say([
        { kind: "person", key: "person-sr", content: record("person-sr", "+15550000701", "Person Sr") },
        { kind: "person", key: "person-sx", content: record("person-sx", "+15550000711", "Person Sx") },
      ]);
      await home.list("People over the cast");
      const older = jpeg("person sr", 1024);
      const newer = jpeg("person sx", 1024);
      await at.ok({ kind: "photo", request: randomUUID(), id: R, upload: older.toString("base64") });
      await at.ok({ kind: "confirm", request: randomUUID(), id: R, details: { work: "Example Works" } });
      await at.ok({ kind: "photo", request: randomUUID(), id: "phone:+15550000721", upload: newer.toString("base64") });
      await home.say([
        { kind: "photo", key: "phone:+15550000711", content: { type: "people.photo", image: sha(newer) } },
        { kind: "details", key: "phone:+15550000711", content: { type: "people.details", work: null, birthday: { month: 7, day: 8, year: null }, profiles: [] } },
      ]);
      await settledAfter(at, { id: R, add: [X] });
      const joined = (await at.person(R)).person;
      expect([joined.photo, joined.details]).toEqual([{ crop: sha(newer) }, { work: "Example Works", birthday: { month: 7, day: 8, year: null }, profiles: [] }]);

      await askHome(home.sock, "pause", ["kind:people", "--reason", "a test holds People's publish"]);
      const saved = await at.ok({ kind: "confirm", request: randomUUID(), id: R, split: [X], details: { work: "Example Studio" } });
      expect(await at.stated("details", "person:person-sr")).toEqual({ type: "people.details", work: "Example Studio", birthday: null, profiles: [] });
      expect((await at.ok({ kind: "confirm", request: randomUUID(), id: R, details: { birthday: null } })).act).toBeNull();
      const another = await at.ok({ kind: "photo", request: randomUUID(), id: R, upload: jpeg("person sr again", 1024).toString("base64") });
      const back = await at.ok({ kind: "undo", request: randomUUID(), act: another.act });
      expect(await at.stated("photo", "person:person-sr")).toEqual({ type: "people.photo", image: sha(older) });
      const early = await at.ok({ kind: "confirm", request: randomUUID(), id: X, details: { work: "Example Shop" } });
      const byNumber = await at.ok({ kind: "confirm", request: randomUUID(), id: "phone:+15550000711", name: "Person Sx B" });
      expect([early.id, byNumber.id]).toEqual([X, X]);
      expect(await at.stated("person", "person-sr")).toMatchObject({ name: "Person Sr" });
      const heldX = (await at.person("phone:+15550000711")).person;
      expect([heldX.id, heldX.name, heldX.details, heldX.photo, heldX.counting]).toEqual([
        X, "Person Sx B", { work: "Example Shop", birthday: { month: 7, day: 8, year: null }, profiles: [] }, { crop: sha(newer) }, undefined,
      ]);
      await askHome(home.sock, "resume", ["kind:people"]);
      await until("People past the split and every edit", () => at.heard(byNumber.position));
      const again = await at.ok({ kind: "confirm", request: randomUUID(), id: X, details: { work: "Example Shop" } });
      expect([again.id, again.act]).toEqual([X, null]);
      expect(await at.stated("details", "person:person-sx")).toEqual({ type: "people.details", work: "Example Shop", birthday: { month: 7, day: 8, year: null }, profiles: [] });
      const [r, x] = [(await at.person(R)).person, (await at.person(X)).person];
      expect([r.photo, r.details, r.counting, x.photo, x.details, x.counting]).toEqual([
        { crop: sha(older) }, { work: "Example Studio", birthday: null, profiles: [] }, undefined,
        { crop: sha(newer) }, { work: "Example Shop", birthday: { month: 7, day: 8, year: null }, profiles: [] }, undefined,
      ]);
      report.stale = { saved, early, byNumber, r, x };
    } finally {
      await home.close();
    }
  });

  it("S17: a member's address on their card alone, which no record holds: after a split from You while People is held, an edit by it lands on the member at once, never on You", async () => {
    const home = await openHome("lifestream-people-split-card-", roots);
    const { at } = home;
    try {
      const YOU = "person:person-cy";
      const R = "person:person-cr";
      const E = "email:person-cr@example.com";
      await home.send(BOOK, [card("FN:Person Cr", "TEL;TYPE=CELL:+15550000901", "EMAIL:person-cr@example.com")]);
      await home.say([
        { kind: "person", key: "person-cy", content: { ...record("person-cy", "+15550000900", "Person Cy"), me: true } },
        { kind: "person", key: "person-cr", content: record("person-cr", "+15550000901", "Person Cr") },
      ]);
      await home.list("People over the cast");
      expect((await at.person(E)).person.id).toBe(R);
      await settledAfter(at, { id: YOU, add: [R] });
      expect((await at.person(E)).person.id).toBe(YOU);

      await askHome(home.sock, "pause", ["kind:people", "--reason", "a test holds People's publish"]);
      await at.ok({ kind: "confirm", request: randomUUID(), id: YOU, split: [R] });
      const you = await at.stated("person", "person-cy");
      const heldR = (await at.person(E)).person;
      expect([heldR.id, ids(heldR), heldR.counting]).toEqual([R, [E, "phone:+15550000901"], undefined]);
      expect(ids((await at.person(YOU)).person)).not.toContain(E);
      const edited = await at.ok({ kind: "confirm", request: randomUUID(), id: E, name: "Person Cr B" });
      const photo = await at.ok({ kind: "photo", request: randomUUID(), id: E, upload: jpeg("person cr", 1024).toString("base64") });
      expect([edited.id, photo.id]).toEqual([R, R]);
      expect([await at.stated("person", "person-cy"), await at.stated("photo", "person:person-cy"), (await at.stated("person", "person-cr"))?.name]).toEqual([you, null, "Person Cr B"]);
      const byCard = (await at.person(E)).person;
      expect([byCard, byCard.counting]).toEqual([expect.objectContaining({ id: R, name: "Person Cr B", photo: { crop: sha(jpeg("person cr", 1024)) } }), undefined]);
      await askHome(home.sock, "resume", ["kind:people"]);
      await until("People past the edits", () => at.heard(photo.position));
      const settled = (await at.person(E)).person;
      expect([settled.id, settled.name, settled.counting, (await at.person(YOU)).person.name]).toEqual([R, "Person Cr B", undefined, "Person Cy"]);
      report.card = { edited, photo };
    } finally {
      await home.close();
    }
  });

  it("S18: a number two records hold, the root re-anchored to the member's: after a split while People is held, an edit by it goes at once to the earlier claim, the member, never the root", async () => {
    const home = await openHome("lifestream-people-split-claim-", roots);
    const { at } = home;
    try {
      const A = "person:person-da";
      const R = "person:person-dr";
      const H = "phone:+15550000911";
      await home.say([
        { kind: "person", key: "person-dr", content: { ...record("person-dr", "+15550000911", "Person Dr"), handles: [phone("+15550000913")] } },
        { kind: "person", key: "person-da", content: record("person-da", "+15550000912", "Person Da") },
      ]);
      await home.list("People over the cast");
      await settledAfter(at, { id: A, add: [R] });
      await settledAfter(at, { id: A, unlink: ["phone:+15550000912"] });
      expect(await at.stated("person", "person-da")).toMatchObject({ anchor: phone("+15550000911") });

      await askHome(home.sock, "pause", ["kind:people", "--reason", "a test holds People's publish"]);
      const split = await at.ok({ kind: "confirm", request: randomUUID(), id: A, split: [R] });
      const a = await at.stated("person", "person-da");
      expect([(await at.person(H)).person.id, (await at.person(H)).person.counting]).toEqual([R, undefined]);
      const edited = await at.ok({ kind: "confirm", request: randomUUID(), id: H, name: "Person Dr B" });
      const worked = await at.ok({ kind: "confirm", request: randomUUID(), id: H, details: { work: "Example Shop" } });
      expect([edited.id, worked.id]).toEqual([R, R]);
      expect([await at.stated("person", "person-da"), await at.stated("details", "person:person-da"), (await at.stated("person", "person-dr"))?.name]).toEqual([a, null, "Person Dr B"]);
      const byHandle = (await at.person(H)).person;
      expect([byHandle, byHandle.counting]).toEqual([expect.objectContaining({ id: R, name: "Person Dr B", details: expect.objectContaining({ work: "Example Shop" }) }), undefined]);
      await askHome(home.sock, "resume", ["kind:people"]);
      await until("People past the split and the edits", () => at.heard(worked.position));
      const settled = (await at.person(H)).person;
      expect([settled.id, settled.name, settled.counting, (await at.person(A)).person.name]).toEqual([R, "Person Dr B", undefined, "Person Da"]);
      report.claim = { split, edited };
    } finally {
      await home.close();
    }
  });

  it("S3, S4, S7: You: a split moves the mark to You's root; a friend's details go with them, a field cleared stays cleared; each Undo whole", async () => {
    const home = await openHome("lifestream-people-split-you-", roots);
    const { at } = home;
    try {
      const YOU = "person:person-yr";
      await home.say([
        { kind: "person", key: "person-yr", content: { ...record("person-yr", "+15550000801", "Person Yr"), also_called: [] } },
        { kind: "person", key: "person-yb", content: { ...record("person-yb", "+15550000802", "Person Yb"), also_called: [], merged_into: "person-yr" } },
        { kind: "person", key: "person-ym", content: { ...record("person-ym", "+15550000803", "Person Ym"), also_called: [], me: true, merged_into: "person-yb" } },
        { kind: "person", key: "person-yf", content: record("person-yf", "+15550000811", "Person Yf") },
        { kind: "details", key: "person:person-yf", content: { type: "people.details", work: null, birthday: { month: 5, day: 6, year: null }, profiles: [] } },
      ]);
      expect((await home.list("People over the cast")).you).toMatchObject({ id: YOU, me: true });
      const stood = async () => Object.fromEntries(await Promise.all(["person-yr", "person-yb", "person-ym"].map(async (slug) => [slug, await at.stated("person", slug)])));
      const before = await stood();

      const marked = await settledAfter(at, { id: YOU, split: ["person:person-ym"] });
      expect(at.manifest(marked.act!).facts).toMatchObject({ statements: 2 });
      expect([(await at.stated("person", "person-ym"))?.me, (await at.stated("person", "person-ym"))?.merged_into, (await at.stated("person", "person-yr"))?.me]).toEqual([false, null, true]);
      expect((await at.get("/v1/people")).body.you).toMatchObject({ id: YOU });
      const markUndone = await at.ok({ kind: "undo", request: randomUUID(), act: marked.act });
      expect(await stood()).toEqual(before);
      await until("People past the undo", () => at.heard(markUndone.position));
      const ancestor = await settledAfter(at, { id: YOU, split: ["person:person-yb"] });
      expect(at.manifest(ancestor.act!).facts).toMatchObject({ statements: 3 });
      expect(await stood()).toEqual({
        "person-yr": { ...before["person-yr"], me: true, dismissed: [sameIdOf(YOU, "person:person-yb")] },
        "person-yb": { ...before["person-yb"], merged_into: null },
        "person-ym": { ...before["person-ym"], me: false },
      });
      expect((await at.get("/v1/people")).body.you).toMatchObject({ id: YOU });
      const ancestorUndone = await at.ok({ kind: "undo", request: randomUUID(), act: ancestor.act });
      expect(await stood()).toEqual(before);
      await until("People past the second undo", () => at.heard(ancestorUndone.position));
      report.marks = { marked, ancestor };

      const F = "person:person-yf";
      await settledAfter(at, { id: YOU, add: [F] });
      await settledAfter(at, { id: YOU, details: { work: "Example Studio" } });
      expect(await at.stated("details", "person:person-yr")).toEqual({ type: "people.details", work: "Example Studio", birthday: null, profiles: [] });
      expect((await at.person(YOU)).person.details).toEqual({ work: "Example Studio", birthday: { month: 5, day: 6, year: null }, profiles: [] });
      const apart = async () => [(await at.person(YOU)).person.details, (await at.person(F)).person.details];
      const after = [{ work: "Example Studio", birthday: null, profiles: [] }, { work: null, birthday: { month: 5, day: 6, year: null }, profiles: [] }];
      const friend = await settledAfter(at, { id: YOU, split: [F] });
      expect(await apart()).toEqual(after);
      const friendUndone = await at.ok({ kind: "undo", request: randomUUID(), act: friend.act });
      await until("People past the friend's undo", () => at.heard(friendUndone.position));
      expect((await at.person(YOU)).person.details).toEqual({ work: "Example Studio", birthday: { month: 5, day: 6, year: null }, profiles: [] });
      const again = await settledAfter(at, { id: YOU, split: [F] });
      expect(await apart()).toEqual(after);
      const againUndone = await at.ok({ kind: "undo", request: randomUUID(), act: again.act });
      await until("People past the second undo of the friend", () => at.heard(againUndone.position));

      await settledAfter(at, { id: YOU, details: { birthday: null } });
      expect(await at.stated("details", "person:person-yr")).toEqual({ type: "people.details", work: "Example Studio", birthday: null, profiles: [], cleared: ["birthday"] });
      expect((await at.person(YOU)).person.details.birthday).toBeNull();
      await settledAfter(at, { id: YOU, split: [F] });
      expect(await apart()).toEqual(after);
      expect((await at.stated("details", "person:person-yr"))?.cleared).toEqual(["birthday"]);
      await settledAfter(at, { id: YOU, details: { birthday: { month: 1, day: 2 } } });
      expect(await at.stated("details", "person:person-yr")).toEqual({ type: "people.details", work: "Example Studio", birthday: { month: 1, day: 2, year: null }, profiles: [] });
      report.details = { friend, again };
    } finally {
      await home.close();
    }
  });

  it("S13-S16: a split whose moved mark would make an older ignored mark You is refused; a number taken off beside its person's split leaves with them; a card's birthday cleared on the root it joined; details undone to what showed", async () => {
    const home = await openHome("lifestream-people-split-more-", roots);
    const { at } = home;
    try {
      await home.say([{ kind: "person", key: "person-mr", content: { ...record("person-mr", "+15550000901", "Person Mr"), me: true } }]);
      await home.say([{ kind: "person", key: "person-mq", content: { ...record("person-mq", "+15550000902", "Person Mq"), me: true } }]);
      await home.say([{ kind: "person", key: "person-mc", content: { ...record("person-mc", "+15550000903", "Person Mc"), me: true, merged_into: "person-mr" } }]);
      expect((await home.list("People over the marks")).you).toMatchObject({ id: "person:person-mr" });
      const marks = () => Promise.all(["person-mr", "person-mq", "person-mc"].map((slug) => at.stated("person", slug)));
      const marked = await marks();
      const refusal = await at.refused({ kind: "confirm", request: randomUUID(), id: "person:person-mr", split: ["person:person-mc"] }, 409, "IS_YOU");
      expect(refusal.message).toBe("Not split off: that would make Person Mq you.");
      expect(await marks()).toEqual(marked);
      expect((await at.get("/v1/people")).body.you).toMatchObject({ id: "person:person-mr" });

      await home.say([
        { kind: "person", key: "person-ur", content: record("person-ur", "+15550000911", "Person Ur") },
        { kind: "person", key: "person-ux", content: record("person-ux", "+15550000912", "Person Ux") },
      ]);
      await settledAfter(at, { id: "person:person-ur", add: ["person:person-ux"] });
      const ur = (await at.stated("person", "person-ur"))!;
      await settledAfter(at, { id: "person:person-ur", split: ["person:person-ux"], unlink: ["phone:+15550000912"] });
      expect(await at.stated("person", "person-ur")).toEqual({ ...ur, also_called: [], excluded: [], dismissed: [...ur.dismissed, sameIdOf("person:person-ur", "person:person-ux")].sort() });
      expect((await at.person("phone:+15550000912")).person.id).toBe("person:person-ux");

      const xCard = card("FN:Person Kx", "TEL;TYPE=CELL:+15550000922");
      await home.send(BOOK, [xCard]);
      await home.say([
        { kind: "person", key: "person-kr", content: record("person-kr", "+15550000921", "Person Kr") },
        { kind: "person", key: "person-kx", content: record("person-kx", "+15550000922", "Person Kx") },
        { kind: "details", key: contactPersonId({ id: contactId({ source: BOOK, key: xCard.key }) }), content: { type: "people.details", work: null, birthday: { month: 9, day: 10, year: null }, profiles: [] } },
      ]);
      await settledAfter(at, { id: "person:person-kr", add: ["person:person-kx"] });
      expect((await at.person("person:person-kr")).person.details?.birthday).toEqual({ month: 9, day: 10, year: null });
      const cleared = await settledAfter(at, { id: "person:person-kr", details: { birthday: null } });
      expect(cleared.act).not.toBeNull();
      expect(await at.stated("details", "person:person-kr")).toEqual({ type: "people.details", work: null, birthday: null, profiles: [], cleared: ["birthday"] });
      expect((await at.person("person:person-kr")).person.details?.birthday ?? null).toBeNull();

      await home.say([
        { kind: "person", key: "person-dr", content: record("person-dr", "+15550000931", "Person Dr") },
        { kind: "details", key: "person:person-dr", content: { type: "people.details", work: "Earlier Works", birthday: null, profiles: [] } },
      ]);
      const LATER = { type: "people.details", work: "Later Works", birthday: null, profiles: [{ network: "instagram", value: "person.dr" }] };
      await home.say([{ kind: "details", key: "phone:+15550000931", content: LATER }]);
      await home.list("People over the details");
      const shown = (await at.person("person:person-dr")).person.details;
      expect(shown).toEqual({ work: "Later Works", birthday: null, profiles: LATER.profiles });
      const birthday = await settledAfter(at, { id: "person:person-dr", details: { birthday: { month: 11, day: 12 } } });
      expect(await at.stated("details", "person:person-dr")).toEqual({ ...LATER, birthday: { month: 11, day: 12, year: null } });
      const undone = await at.ok({ kind: "undo", request: randomUUID(), act: birthday.act });
      expect([await at.stated("details", "person:person-dr"), await at.stated("details", "phone:+15550000931")]).toEqual([null, LATER]);
      await until("People past the details' undo", () => at.heard(undone.position));
      expect((await at.person("person:person-dr")).person.details).toEqual(shown);
      report.more = { refusal, cleared, birthday, undone };
    } finally {
      await home.close();
    }
  });
});

describe("A People act on the next read", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("People paused, a card's person confirmed: ?id= and /v1/people show them at once at the position they were read at, never below the act's, /v1/people/photos answers for the id just made, nothing reads counting; resumed, People's run shows the same, its position not below the act's", async () => {
    const home = await openHome("lifestream-owner-act-reads-", roots);
    const { at } = home;
    try {
      const BAKERY = "phone:+15550000821";
      await home.send(BOOK, [card("ORG:Synthetic Bakery", "TEL:+15550000821")]);
      await home.list("People over the card");
      const list = async () => (await at.get("/v1/people")).body;
      const entry = (people: Body, id: string) => (people.people as Body[]).find((each) => each.id === id);
      const counting = (people: Body) => (people.people as Body[]).filter((each) => each.counting !== undefined);

      await askHome(home.sock, "pause", ["kind:people", "--reason", "a test holds People's publish"]);
      const confirmed = await at.ok({ kind: "confirm", request: randomUUID(), id: BAKERY, name: "Bakery Example" });
      const made = await at.person(confirmed.id!);
      const held = await list();
      expect([made.person.id, made.person.name, made.person.counting, entry(held, confirmed.id!)?.name, counting(held)]).toEqual([confirmed.id, "Bakery Example", undefined, "Bakery Example", []]);
      expect([seq(made.position) >= seq(confirmed.position), seq(held.position) >= seq(made.position)]).toEqual([true, true]);
      expect((await at.get(`/v1/people/photos?id=${encodeURIComponent(confirmed.id!)}`)).body).toMatchObject({ photos: [], total: 0 });

      await askHome(home.sock, "resume", ["kind:people"]);
      await until("People past the act", () => at.heard(confirmed.position));
      const after = await list();
      expect([entry(after, confirmed.id!)?.name, counting(after), seq(after.position) >= seq(confirmed.position)]).toEqual(["Bakery Example", [], true]);
    } finally {
      await home.close();
    }
  });
});

describe("People's writer killed at each handoff", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it.each(["owner.seal", "owner.land", "owner.answer"])("A16: the home killed at %s, started again, lands the action once, and a retry of its request says so", async (failpoint) => {
    const root = homeRoot(`lifestream-people-kill-${failpoint.replace(".", "-")}-`);
    roots.push(root);
    let url = "";
    const at = through(root, () => url);
    let home: Home | null = await startHome(root, { registry: REGISTRY, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY });
    url = `http://127.0.0.1:${door.port}`;
    const child = new ChildHome(root);
    try {
      await ship(root, { source: BOOK, fetched_ms: T, rows: [card("FN:Person R", "TEL;TYPE=CELL:+15550000121")] as never });
      await until("the card landed and People prepared it", async () => at.settled() && (await at.get(`/v1/people?id=${encodeURIComponent("phone:+15550000121")}`)).status === 200);
      const earlier = await at.ok({ kind: "confirm", request: randomUUID(), id: "phone:+15550000121", relationship: "friend" });
      await home.stop();
      home = null;

      child.start(failpoint, { env: { LIFESTREAM_TEST_REGISTRY: pathToFileURL(REGISTRY).href } });
      await child.ready();
      const action = { kind: "confirm", request: randomUUID(), id: "person:person-r", name: "Ree" };
      const lost = await at.act(action);
      expect([lost.status, lost.body.code]).toEqual([503, "OUTCOME_UNKNOWN"]);
      expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
      const lane = join(root, "inbox", PEOPLE);
      const sealed = readdirSync(lane).filter((name) => /\.[0-9a-f]{12}$/u.test(name) && readSealed(openHomeFolder(dirname(dirname(lane))), join(lane, name))?.facts.request === action.request);
      expect(sealed).toHaveLength(failpoint === "owner.seal" ? 0 : 1);
      const unsealed = join(lane, "20261001T000000Z.0123456789ab");
      mkdirSync(unsealed);
      writeFileSync(join(unsealed, ".statements.ndjson.partial"), "{}\n");

      rmSync(testSocket(root).path, { force: true });
      home = await startHome(root, { registry: REGISTRY, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
      expect(existsSync(unsealed)).toBe(false);
      const after = at.deliveries().filter((each) => each.facts.request === action.request);
      expect(after.map((each) => each.state)).toEqual(failpoint === "owner.seal" ? [] : ["imported"]);

      const retried = await at.ok(action);
      expect(retried.id).toBe("person:person-r");
      const landed = at.deliveries().filter((each) => each.facts.request === action.request);
      expect(landed).toHaveLength(1);
      expect(retried.act).toBe(failpoint === "owner.land" ? null : landed[0]!.id);
      expect(await at.stated("person", "person-r")).toMatchObject({ name: "Ree", relationship: "friend" });
      expect((await at.ok(action)).act).toBe(retried.act);
      await at.refused({ kind: "undo", request: randomUUID(), act: earlier.act }, 409, "NOT_LAST");
      if (failpoint === "owner.land") {
        await at.refused({ kind: "undo", request: randomUUID(), act: landed[0]!.id }, 409, "NOT_LAST");
      } else {
        await at.ok({ kind: "undo", request: randomUUID(), act: retried.act });
        expect(await at.stated("person", "person-r")).toMatchObject({ name: null, relationship: "friend" });
      }
    } finally {
      child.kill();
      await door.close();
      await home?.stop().catch(() => undefined);
    }
  });

  it("S11: a split sealed and not landed, the home started again: recovery keeps its request with the person's own id from its facts, and the same request is answered it, landing nothing twice", async () => {
    const root = homeRoot("lifestream-people-kill-split-");
    roots.push(root);
    let url = "";
    const at = through(root, () => url);
    let home: Home | null = await startHome(root, { registry: REGISTRY, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY });
    url = `http://127.0.0.1:${door.port}`;
    const child = new ChildHome(root);
    try {
      await shipFiles(root, PEOPLE, T, statements([
        { kind: "person", key: "person-kr", content: record("person-kr", "+15550000901", "Person Kr") },
        { kind: "person", key: "person-kx", content: { ...record("person-kx", "+15550000911", "Person Kx"), merged_into: "person-kr" } },
      ]));
      await until("People lists X joined into R", async () => at.settled()
        && ((await at.get(`/v1/people?id=${encodeURIComponent("person:person-kr")}`)).body.person?.joined as Body[] | undefined)?.[0]?.id === "person:person-kx");
      await home.stop();
      home = null;

      child.start("owner.land", { env: { LIFESTREAM_TEST_REGISTRY: pathToFileURL(REGISTRY).href } });
      await child.ready();
      const action = { kind: "confirm", request: randomUUID(), id: "person:person-kr", split: ["person:person-kx"] };
      const lost = await at.act(action);
      expect([lost.status, lost.body.code]).toEqual([503, "OUTCOME_UNKNOWN"]);
      expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });

      rmSync(testSocket(root).path, { force: true });
      home = await startHome(root, { registry: REGISTRY, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
      const landed = at.deliveries().filter((each) => each.facts.request === action.request);
      expect(landed.map((each) => [each.state, each.facts.id])).toEqual([["imported", "person:person-kr"]]);
      expect(JSON.parse(at.meta(`${OWNER_REQUEST}${action.request}`)!)).toMatchObject({ of: "people", id: "person:person-kr", undoable: false });
      const retried = await at.ok(action);
      expect([retried.act, retried.id]).toEqual([null, "person:person-kr"]);
      expect(at.deliveries().filter((each) => each.facts.request === action.request)).toHaveLength(1);
      expect(await at.stated("person", "person-kx")).toMatchObject({ merged_into: null });
    } finally {
      child.kill();
      await door.close();
      await home?.stop().catch(() => undefined);
    }
  });
});
