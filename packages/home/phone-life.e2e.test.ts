import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { mintPrincipal, readPrincipals, writePrincipals } from "./principals.js";
import { readConnectors } from "./connectors.js";
import { effective } from "./settings.js";
import { askHome, type HomeSocket } from "./socket.js";
import fakeRegistry from "./test/fakes.js";
import { makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship as shipRows } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { startHere } from "./test/harness-home.js";
import { statusOf } from "./test/harness-status.js";
import { DEVICE, healthLine, phoneBundle, sha256 } from "./test/support.js";
import { readOpsSettings } from "./verbs/context.js";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { homeOf } from "./registry.js";
import { testSocket } from "./test/folder.js";
import { photosComing, photosStart } from "./status.js";

const MAC_NOTES = "apple-notes:local:macbook-pro-0001";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const report: Record<string, unknown> = {};
const removeAtEnd = (path: string): void => onTestFinished(() => removeRoot(path));
afterAll(() => {
  const directory = join(tmpdir(), "lifestream-home-ops-e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "phone-life.json"), `${JSON.stringify(report, null, 2)}\n`);
});

type Answer = { status: number; body: Record<string, unknown> };

function homeOn(root: string): { start(): Promise<void>; stop(): Promise<void> } {
  let home: ReturnType<typeof startHere> | undefined;
  return {
    async start() {
      home = startHere(root, { tickMs: TICK_MS, log: () => undefined });
      await home;
    },
    async stop() {
      await (await home)?.stop();
    },
  };
}

async function running(prefix: string, sources: Record<string, string> = {}): Promise<{ root: string; door: Awaited<ReturnType<typeof doorHere>>; home: ReturnType<typeof homeOn>; sock: HomeSocket }> {
  const root = makeRoot(prefix, { sources });
  removeAtEnd(root);
  const door = await doorHere(root);
  const home = homeOn(root);
  await home.start();
  return { root, door, home, sock: testSocket(root) };
}

async function request(url: string, method: string, path: string, headers: Record<string, string>, body?: Buffer | string): Promise<Answer> {
  const response = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, body: type.includes("json") ? await response.json() as Record<string, unknown> : { bytes: Buffer.from(await response.arrayBuffer()).toString("utf8") } };
}

const newPass = (): string => randomBytes(32).toString("base64url");
const code = async (sock: HomeSocket, replace?: string) => ((await askHome(sock, "pair", replace === undefined ? [] : ["--replace", replace])) as { code: string }).code;
const pair = (url: string, body: Record<string, unknown>) =>
  request(url, "POST", "/v1/pair", { ...DEVICE.phone, "content-type": "application/json" }, JSON.stringify({ kind: "phone", model: "iPhone 17 Pro", account: "person-a@example.com", ...body }));
const exchange = (url: string, pass: string, body: Record<string, unknown> = {}) =>
  request(url, "POST", "/v1/exchange", { authorization: `Bearer ${pass}`, ...DEVICE.phone, "content-type": "application/json" }, JSON.stringify(body));
const get = (url: string, pass: string, path: string) => request(url, "GET", path, { authorization: `Bearer ${pass}`, ...DEVICE.phone });

const WALL = "2026-08-31T10:00:00.125+05:30";
const PROCESS = "00000000-0000-4000-8000-0000000000c1";
const captured = { wall_rfc3339: WALL, wall_unix_seconds: Date.parse(WALL) / 1000, elapsed_seconds: 100 };
const envelope = (domain: string, kind: string, sequence: number, observed_at: string, payload: object) =>
  ({ schema_version: 1, domain, kind, sequence, observed_at, captured, process_instance_id: PROCESS, payload });
const lifecycle = (sequence: number) => ({ domain: "location", kind: "lifecycle", sequence, captured, payload: { event: "process_launch" } });

function locations(unit: string, seal: number, sequences: number[], second: number) {
  return phoneBundle({ entries: { "location.jsonl": sequences.map(lifecycle) }, custody: { [`location:local:${unit}`]: { seal } }, second });
}

const ship = (url: string, pass: string, bundle: { id: string; bytes: Buffer }) =>
  request(url, "PUT", `/v1/bundles/${bundle.id}`, { authorization: `Bearer ${pass}`, ...DEVICE.phone }, bundle.bytes);

const imported = (root: string, pass: string, source: string) => readHome(root, (db) =>
  db.prepare("SELECT count(*) FROM deliveries WHERE pass = ? AND source = ? AND state = 'imported'").pluck().get(pass, source)) as number;

const passId = (answer: Answer) => ((answer.body.answer ?? answer.body) as { pass: string }).pass;

describe("live first", () => {
  it("a week-old bundle imports as live, and one that carries none of a source's lines costs that source an import, or leaves its read-through", async () => {
    const { root, door, sock } = await running("lifestream-phone-life-live-");
    const pass = newPass();
    const paired = await pair(door.url, { code: await code(sock), pass });
    const unit = paired.body.unit as string;
    const id = passId(paired);
    const location = `location:local:${unit}`, motion = `motion:local:${unit}`;
    const instant = (ms: number) => new Date(ms).toISOString();
    const now = Date.now();
    const page = phoneBundle({ entries: { "location.jsonl": [1, 2].map(lifecycle) }, custody: { [location]: { seal: 1 } }, second: 1, range: { start: instant(now - 400 * DAY), end: instant(now - 8 * DAY) } });
    const fresh = phoneBundle({ entries: { "location.jsonl": [3].map(lifecycle) }, custody: { [location]: { seal: 2 } }, second: 2, range: { start: instant(now - MINUTE), end: instant(now) } });
    for (const bundle of [page, fresh]) expect((await ship(door.url, pass, bundle)).status).toBe(201);
    const readThrough = () => readHome(root, (db) => db.prepare("SELECT id, read_through_ms FROM sources WHERE id IN (?, ?) ORDER BY id").all(location, motion)) as { id: string; read_through_ms: number | null }[];
    await until("both imported for location, motion read through by their statements", () => imported(root, id, location) === 2 && readThrough()[0]!.read_through_ms !== null
      && readThrough()[0]!.read_through_ms === readThrough()[1]!.read_through_ms);
    const rows = readHome(root, (db) => db.prepare("SELECT id, source, facts, run FROM deliveries WHERE source IN (?, ?) ORDER BY sealed_ms, source").all(location, motion)) as { id: string; source: string; facts: string; run: number | null }[];
    const history = (bundle: { id: string }) => (JSON.parse(rows.find((row) => row.id.endsWith(bundle.id))!.facts) as { history?: boolean }).history;
    expect([history(page), history(fresh)]).toEqual([true, undefined]);
    expect(rows.filter((row) => row.source === motion)).toEqual([]);
    const runs = readHome(root, (db) => db.prepare("SELECT subject FROM runs WHERE kind = 'import'").pluck().all()) as string[];
    expect(runs.every((subject) => subject.startsWith(`${location} `))).toBe(true);
    const read = readThrough();
    report.live = { rows, runs, read };
  });
});

describe("which phone", () => {
  it("asks which phone a second install is, keeps the code through the question, continues a unit it holds with the model it now is", async () => {
    const { root, door, sock } = await running("lifestream-phone-life-pair-");
    const first = await pair(door.url, { code: await code(sock), pass: newPass() });
    expect(first.status).toBe(200);
    const unit = first.body.unit as string;
    const asked = await code(sock);
    const which = await pair(door.url, { code: asked, pass: newPass() });
    expect([which.status, which.body.code]).toEqual([409, "PAIR_WHICH_PHONE"]);
    expect(which.body.phones).toEqual([{ unit, model: "iPhone 17 Pro", account: "person-a@example.com", last_ms: null }]);
    const unknown = await pair(door.url, { code: asked, pass: newPass(), unit: "iphone-17-pro-ffff" });
    expect([unknown.status, unknown.body.code]).toEqual([409, "PAIR_UNIT_UNKNOWN"]);
    const mac = await pair(door.url, { code: asked, pass: newPass(), unit: "macbook-pro-0001" });
    expect([mac.status, mac.body.code]).toEqual([409, "PAIR_UNIT_UNKNOWN"]);
    const both = await pair(door.url, { code: asked, pass: newPass(), unit, new: true });
    expect([both.status, both.body.code]).toEqual([422, "PAIR_REQUEST"]);
    const continued = await pair(door.url, { code: asked, pass: newPass(), unit, model: "iPhone 18 Pro" });
    expect([continued.status, continued.body.unit]).toEqual([200, unit]);
    expect(readHome(root, (db) => db.prepare("SELECT model FROM devices WHERE unit = ?").pluck().get(unit))).toBe("iPhone 18 Pro");
    expect((await pair(door.url, { code: asked, pass: newPass(), new: true })).body.code).toBe("PAIR_CODE");
    const another = await pair(door.url, { code: await code(sock), pass: newPass(), new: true });
    expect(another.status).toBe(200);
    expect(another.body.unit).not.toBe(unit);
    await askHome(sock, "device", ["retire", another.body.unit as string]);
    const retired = await pair(door.url, { code: await code(sock), pass: newPass(), unit: another.body.unit });
    expect([retired.status, retired.body.code]).toEqual([409, "PAIR_UNIT_UNKNOWN"]);
    report.which = { which: which.body, unknown: unknown.body, continued: continued.body.unit, another: another.body.unit };
  });
});

const me = async (url: string, pass: string): Promise<[number, unknown]> => {
  const { status, body } = await get(url, pass, "/v1/me");
  return [status, body.code];
};

describe("handing over", () => {
  it("replaces an install once a later one ships, refuses its drained while a seal waits, revokes it after, and replaces a retired phone's: a replaced pass delivers and reads nothing", async () => {
    const { root, door, home, sock } = await running("lifestream-phone-life-handover-");
    const old = newPass();
    const paired = await pair(door.url, { code: await code(sock), pass: old });
    const unit = paired.body.unit as string;
    const oldId = passId(paired);
    expect((await ship(door.url, old, locations(unit, 1, [1, 2], 1))).status).toBe(201);
    await until("the old install's first seal imported", () => imported(root, oldId, `location:local:${unit}`) === 1);
    const live = await exchange(door.url, old, { drained: true });
    expect([live.status, live.body.code]).toEqual([409, "NOT_DRAINED"]);

    const fresh = newPass();
    expect((await pair(door.url, { code: await code(sock), pass: fresh, unit })).status).toBe(200);
    expect((await exchange(door.url, old)).body.replaced).toBeUndefined();
    expect((await ship(door.url, fresh, locations(unit, 1, [1], 2))).status).toBe(201);
    const told = await exchange(door.url, old);
    expect(told.body.replaced).toEqual(expect.any(String));
    expect([await me(door.url, old), await me(door.url, fresh)]).toEqual([[403, "PRINCIPAL_SCOPE"], [200, undefined]]);

    await home.stop();
    expect((await ship(door.url, old, locations(unit, 2, [3], 3))).status).toBe(201);
    const waiting = await exchange(door.url, old, { drained: true });
    expect([waiting.status, waiting.body.code]).toEqual([409, "NOT_DRAINED"]);
    await home.start();
    await until("the old install's last seal imported", () => imported(root, oldId, `location:local:${unit}`) === 2);
    const drained = await exchange(door.url, old, { drained: true });
    expect(drained.status).toBe(200);
    expect(readPrincipals(openHomeFolder(root)).principals.find((row) => row.id === oldId)!.revoked_at).toEqual(expect.any(String));
    expect((await exchange(door.url, old)).body.code).toBe("PRINCIPAL_UNKNOWN");
    expect((await exchange(door.url, fresh)).body.replaced).toBeUndefined();

    await askHome(sock, "device", ["retire", unit]);
    expect(readPrincipals(openHomeFolder(root)).principals.filter((row) => row.unit === unit).map((row) => row.retired_at)).toEqual([expect.any(String), expect.any(String)]);
    expect([await me(door.url, fresh), (await get(door.url, fresh, "/v1/people")).status]).toEqual([[403, "PRINCIPAL_SCOPE"], 403]);
    await door.stop();
    const again = await doorHere(root);
    onTestFinished(() => again.stop());
    expect(await me(again.url, fresh)).toEqual([403, "PRINCIPAL_SCOPE"]);
    expect((await exchange(again.url, fresh)).body.replaced).toEqual(expect.any(String));
    expect((await ship(again.url, fresh, locations(unit, 2, [2], 4))).status).toBe(201);
    const late = newPass();
    const repaired = await pair(again.url, { code: await code(sock, unit), pass: late });
    expect([repaired.status, await me(again.url, late)]).toEqual([200, [403, "PRINCIPAL_SCOPE"]]);
    const file = openHomeFolder(root);
    const held = readPrincipals(file);
    writePrincipals(file, { ...held, principals: held.principals.map(({ retired_at: _, ...row }) => row) });
    expect(await me(again.url, late)).toEqual([200, undefined]);
    await home.stop();
    await home.start();
    expect([await me(again.url, late), await me(again.url, fresh)]).toEqual([[403, "PRINCIPAL_SCOPE"], [403, "PRINCIPAL_SCOPE"]]);
    report.handover = { told: told.body.replaced, waiting: waiting.body.message, drained: drained.status };
  });
});

describe("the restore", () => {
  it("hands a new install the phone's check-ins and notes as the entries that made them, its since, and a note's blob; the phone reads its whole home", async () => {
    const { root, door, home, sock } = await running("lifestream-phone-life-restore-", { [MAC_NOTES]: "fake-rows" });
    const pass = newPass();
    const paired = await pair(door.url, { code: await code(sock), pass });
    const unit = paired.body.unit as string;
    const archive = Buffer.from("a synthetic rich-text archive");
    const note = (sequence: number, id: string, purged: boolean) => envelope("notes", "note", sequence, "2026-08-31T04:30:00Z", {
      id, folder: null, title: "A synthetic note", text: "A synthetic note", created: "2026-08-31T04:20:00Z", modified: "2026-08-31T04:30:00Z",
      pinned: false, pin_order: 0, deleted_at: null, purged, rich: { hash: `sha256:${sha256(archive)}`, bytes: archive.length }, attachments: [],
    });
    const answered = "2026-08-31T04:25:00Z";
    const checkin = envelope("checkin", "report", 1, answered, {
      form: "moment", form_version: 1, prompt_id: null, trigger: "manual", opened_at: "2026-08-31T04:24:00Z", answered_at: answered, local_zone: "Asia/Kolkata",
      response_ms: 1000, changes: 0, awake_for_s: null, wake_source: null, block_id: null, items: [], note: null,
    });
    const kept = "00000000-0000-4000-8000-00000000e001", purged = "00000000-0000-4000-8000-00000000e002";
    const bundle = phoneBundle({
      entries: { "checkin.jsonl": [checkin], "notes.jsonl": [note(1, kept, false), note(2, purged, false), note(3, purged, true)] },
      blobs: [archive], second: 1,
      custody: { [`checkin:local:${unit}`]: { seal: 1 }, [`notes:local:${unit}`]: { seal: 1 } },
    });
    await home.stop();
    expect((await ship(door.url, pass, bundle)).status).toBe(201);
    const early = await get(door.url, pass, "/v1/restore");
    expect([early.status, early.body.code, early.body.message]).toEqual([503, "NOT_NOW", expect.stringMatching(/^Lifestream is still importing /u)]);
    await home.start();
    await until("the bundle imported", () => ["checkin", "notes"].every((product) => imported(root, passId(paired), `${product}:local:${unit}`) === 1));

    const restored = await get(door.url, pass, "/v1/restore");
    expect(restored.status).toBe(200);
    const since = restored.body.since as Record<string, number | null>;
    expect(Object.values(since).every((at) => at === null)).toBe(true);
    expect(Object.keys(since)).toContain(`notes:local:${unit}`);
    expect(restored.body.domains).toEqual({
      checkin: [{ kind: "report", observed_at: answered, payload: checkin.payload }],
      notes: [{ kind: "note", observed_at: "2026-08-31T04:30:00Z", payload: note(1, kept, false).payload }],
    });
    const blob = await get(door.url, pass, `/v1/blobs/sha256:${sha256(archive)}`);
    expect([blob.status, blob.body.bytes]).toEqual([200, archive.toString("utf8")]);

    const book = `apple-contacts:person-a@example.com:${unit}`;
    expect(restored.body.contacts).toEqual({ [book]: [] });
    const contact = "00000000-0000-4000-8000-00000000c0a1:ABPerson";
    const card = envelope("contacts", "card", 1, "2026-08-31T04:40:00Z", {
      id: contact, card: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Person A\r\nEND:VCARD\r\n", serializer: "CNContactVCardSerialization",
    });
    await home.stop();
    expect((await ship(door.url, pass, phoneBundle({ entries: { "contacts.jsonl": [card] }, second: 2, custody: { [book]: { seal: 1 } } }))).status).toBe(201);
    const pending = await get(door.url, pass, "/v1/restore");
    expect([pending.status, pending.body.code, pending.body.message]).toEqual([503, "NOT_NOW", `Lifestream is still importing ${book}: ask again in a moment.`]);
    await home.start();
    await until("the contact imported", () => imported(root, passId(paired), book) === 1);
    const withContact = await get(door.url, pass, "/v1/restore");
    expect([withContact.status, withContact.body.contacts]).toEqual([200, { [book]: [contact] }]);

    const macBlob = Buffer.from("a synthetic attachment a Mac delivered");
    const noted = Date.parse("2026-08-31T05:00:00Z");
    await shipRows(root, { source: MAC_NOTES, fetched_ms: noted, carried: { [sha256(macBlob)]: macBlob },
      rows: [{ kind: "note", key: "n1", at: noted, blobs: [`sha256:${sha256(macBlob)}`], content: { text: "synthetic note", at: noted } }] });
    await until("the Mac's note imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ?").pluck().get(MAC_NOTES)) === 1);
    const other = newPass();
    expect((await pair(door.url, { code: await code(sock), pass: other, new: true })).status).toBe(200);
    const days = await get(door.url, other, "/v1/days");
    expect([days.status, Array.isArray(days.body.days)]).toEqual([200, true]);
    const read = await Promise.all([macBlob, archive].map((bytes) => get(door.url, other, `/v1/blobs/sha256:${sha256(bytes)}`)));
    expect(read.map((answer) => [answer.status, answer.body.bytes])).toEqual([[200, macBlob.toString("utf8")], [200, archive.toString("utf8")]]);
    expect((await get(door.url, other, `/v1/records?source=notes:local:${unit}&kind=note`)).status).toBe(200);
    const bare = await request(door.url, "GET", "/v1/days", { authorization: `Bearer ${other}` });
    expect([bare.status, bare.body.code]).toEqual([426, "DEVICE_TOO_OLD"]);
    report.restore = { first: restored.body, contact_pending: pending.body, contact_imported: withContact.body };
    report.phone_reads = { days: days.body.days, blobs: read.map((answer) => answer.status) };
  });
});

describe("a phone paired before phones read", () => {
  it("gains read at the home's start, and keeps what it delivers", async () => {
    const root = makeRoot("lifestream-phone-life-grant-", { sources: {} });
    removeAtEnd(root);
    const unit = "iphone-17-pro-aa01";
    const token = newPass();
    const minted = mintPrincipal(openHomeFolder(root), {
      unit, kind: "phone", scopes: ["deliver"], sources: [`location:local:${unit}`], account: "person-a@example.com", token, now_ms: Date.now(),
    }).principal;
    const door = await doorHere(root);
    expect((await get(door.url, token, "/v1/days")).body.code).toBe("PRINCIPAL_SCOPE");
    await homeOn(root).start();
    const row = readPrincipals(openHomeFolder(root)).principals.find((each) => each.id === minted.id)!;
    expect(row.scopes).toEqual(["deliver", "read"]);
    expect(row.sources).toContain(`location:local:${unit}`);
    const days = await get(door.url, token, "/v1/days");
    expect(days.status).toBe(200);
    report.granted = { scopes: row.scopes, days: days.status };
  });
});

describe("read points", () => {
  it("makes since the newest read point the unit's own imported seals stated, with Health's types, and the cache learns them again", async () => {
    const { root, door, home, sock } = await running("lifestream-phone-life-points-");
    const pass = newPass();
    const paired = await pair(door.url, { code: await code(sock), pass });
    const unit = paired.body.unit as string;
    const location = `location:local:${unit}`, health = "apple-health:person-a@example.com:cloud";
    const at = (second: number) => `2026-08-31T04:30:${String(second).padStart(2, "0")}Z`;
    type Point = { history_through?: string; types?: string[] };
    const sealed = (seal: number, second: number, stated: Point = {}, more: Record<string, Point & { seal: number }> = {}) =>
      phoneBundle({ entries: { "location.jsonl": [lifecycle(seal)], ...(more[health] === undefined ? {} : { "health.jsonl": [healthLine(more[health].seal)] }) }, custody: { [location]: { seal, ...stated }, ...more }, second });
    const since = async () => {
      const restored = await get(door.url, pass, "/v1/restore");
      expect(restored.status).toBe(200);
      return { location: (restored.body.since as Record<string, number | null>)[location], health: (restored.body.since as Record<string, number | null>)[health],
        types: restored.body.types as Record<string, string[]> };
    };

    expect((await ship(door.url, pass, sealed(1, 1))).status).toBe(201);
    await until("seal 1 imported", () => imported(root, passId(paired), location) === 1);
    expect((await since()).location).toBeNull();

    expect((await ship(door.url, pass, sealed(2, 2, { history_through: at(2) }, { [health]: { seal: 1, history_through: at(1), types: ["HKQuantityTypeIdentifierStepCount"] } }))).status).toBe(201);
    await until("seal 2 imported, and Health's seal 1", () => imported(root, passId(paired), location) === 2 && imported(root, passId(paired), health) === 1);
    expect(await since()).toEqual({ location: Date.parse(at(2)), health: Date.parse(at(1)), types: { [health]: ["HKQuantityTypeIdentifierStepCount"] } });

    await home.stop();
    expect((await ship(door.url, pass, sealed(3, 3, { history_through: at(3) }))).status).toBe(201);
    expect((await since()).location).toBe(Date.parse(at(2)));
    await home.start();
    await until("seal 3 imported", () => imported(root, passId(paired), location) === 3);
    expect((await since()).location).toBe(Date.parse(at(3)));

    const other = newPass();
    const another = await pair(door.url, { code: await code(sock), pass: other, new: true });
    const otherUnit = another.body.unit as string;
    expect((await ship(door.url, other, phoneBundle({ entries: { "location.jsonl": [lifecycle(1)], "health.jsonl": [healthLine(1)] }, second: 5,
      custody: { [`location:local:${otherUnit}`]: { seal: 1 }, [health]: { seal: 1, history_through: at(5), types: ["HKCategoryTypeIdentifierSleepAnalysis"] } } }))).status).toBe(201);
    await until("the other phone's seals imported", () => imported(root, passId(another), `location:local:${otherUnit}`) === 1 && imported(root, passId(another), health) === 1);
    expect((await since()).health).toBe(Date.parse(at(1)));

    await door.stop();
    const cache = new Database(join(root, "door", "custody.db"));
    cache.exec("UPDATE seals SET history_through_ms = NULL, types = NULL");
    cache.pragma("user_version = 1");
    cache.close();
    const again = await doorHere(root);
    const restored = await get(again.url, pass, "/v1/restore");
    expect((restored.body.since as Record<string, number | null>)[location]).toBe(Date.parse(at(3)));
    report.points = { since: restored.body.since, types: restored.body.types };
  });
});

describe("notices", () => {
  it("watches a phone's live install, says when none is paired, and names an install still handing over a day on", async () => {
    const { root, door, sock } = await running("lifestream-phone-life-notices-");
    const old = newPass();
    const paired = await pair(door.url, { code: await code(sock), pass: old });
    const unit = paired.body.unit as string;
    expect((await ship(door.url, old, locations(unit, 1, [1], 1))).status).toBe(201);
    const fresh = newPass();
    expect((await pair(door.url, { code: await code(sock), pass: fresh, unit })).status).toBe(200);
    expect((await ship(door.url, fresh, locations(unit, 1, [1], 2))).status).toBe(201);
    const freshId = readPrincipals(openHomeFolder(root)).principals.find((row) => row.unit === unit && row.id !== passId(paired))!.id;
    await until("both installs' seals imported", () => imported(root, passId(paired), `location:local:${unit}`) === 1 && imported(root, freshId, `location:local:${unit}`) === 1);
    const settings = readOpsSettings(root);
    const status = (hours: number) => statusOf(root, { now_ms: Date.now() + hours * 3_600_000, settings });
    const at = (hours: number) => {
      const read = status(hours);
      return [...read.needs.map((need) => need.id), ...read.notices.map((notice) => notice.id)].filter((id) => /^(phone|pair|handing-over):/u.test(id)).sort();
    };
    const devices = (hours = 0) => readHome(root, (db) => readConnectors(db, { folder: openHomeFolder(root), now_ms: Date.now() + hours * 3_600_000, settings: effective(root).settings, registry: fakeRegistry(effective(root).settings, homeOf(openHomeFolder(root))), machine: process.env.LIFESTREAM_MACHINE_DIR!, sites: null, present: [], needs: [], free_bytes: 1 << 40, photos: photosComing(db, photosStart(effective(root).settings, fakeRegistry(effective(root).settings, homeOf(openHomeFolder(root))).connectors, Date.now() + hours * 3_600_000)) }))
      .devices;
    expect(at(1)).toEqual([]);
    expect(at(25)).toEqual([`handing-over:${passId(paired)}`]);
    expect(at(27)).toEqual([`handing-over:${passId(paired)}`]);
    expect(devices(27).find((row) => row.unit === unit)!.health).toMatchObject({ state: "quiet", reason: "device" });
    const late = status(27).notices;
    expect(late.find((notice) => notice.id === `handing-over:${passId(paired)}`)).toMatchObject({
      what: expect.stringMatching(new RegExp(`^the replaced install of ${unit} \\(pass ${passId(paired)}\\) last shipped at .*; if that phone is gone, principals revoke ${passId(paired)}$`, "u")),
    });
    const ids = readPrincipals(openHomeFolder(root)).principals.filter((row) => row.unit === unit).map((row) => row.id);
    for (const id of ids) await askHome(sock, "principals", ["revoke", id]);
    expect(at(1)).toEqual([`pair:${unit}`]);
    expect(status(1).needs.find((need) => need.id === `pair:${unit}`)).toMatchObject({ state: "needs-you", reason: "pair", unit, words: "Pair iPhone 17 Pro again" });
    expect(devices().map((row) => [row.unit, row.retired, row.pass, row.health.state])).toEqual([[unit, false, null, "needs-you"]]);
    await askHome(sock, "device", ["retire", unit]);
    expect(devices().map((row) => [row.unit, row.retired, row.health.state, row.health.words])).toEqual([[unit, true, "off", "Removed · data kept"]]);
    expect(at(1)).toEqual([]);
    report.notices = { day: at(25), late, idle: at(1) };
  });
});
