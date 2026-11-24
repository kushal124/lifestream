import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactId, contactPersonId } from "@lifestreamprotocol/families";
import { openHome as openHomeDb, openHomeFolder, type OpenView } from "@lifestreamprotocol/core";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { peoplePage } from "./page-people.js";
import { servePages } from "./page-serve.js";
import { PAGES, PageShapeError, type AnswerOf, type Body as PageBody, type Opened, type PageAsk } from "./pages.js";
import type { PeopleJoin } from "./people.js";
import type { PreparedRead } from "./prepared.js";
import { mintPrincipal } from "./principals.js";
import { NB } from "./stream-words.js";
import type { Ask } from "./reads.js";
import { Refusal } from "./refusal.js";
import { askHome } from "./socket.js";
import { testSocket } from "./test/folder.js";
import { clientFixture, makeRoot, readHome, removeRoot, REPO, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";

const ZONE = "Asia/Kolkata";
const DAY = { zone: ZONE, day_start_hour: 4 };
const UNIT = "macbook-pro-0001";
const WHATSAPP = "whatsapp:919000000009:iphone-aa01";
const BOOK = "apple-contacts:local:iphone-aa01";
const PEOPLE = `people:local:${UNIT}`;
const REGISTRY = join(REPO, "packages", "home", "test", "groups-registry.ts");
const READER = "synthetic-page-reader".padEnd(43, "r");
const SENDER = "synthetic-page-sender".padEnd(43, "s");
const APPLE_EPOCH_S = 978_307_200;
const FRIENDS = "120363000000000031@g.us";
const SHOP = "120363000000000032@g.us";
const STRANGER = "15550000399@s.whatsapp.net";
const at = (utc: string) => Date.parse(`${utc}Z`);
const MINUTE = 60_000;

type Body = Record<string, any>;
type People = AnswerOf<"people">;

function wa(stanza: string, chat: string, when: number, from: { me?: true; member?: string } = {}) {
  const date = when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: stanza, ZTEXT: `synthetic line ${stanza}`, ZFROMJID: from.me === true ? null : chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: 0, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: from.me === true ? 1 : 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${chat}:${stanza}`, at: when,
    content: { type: "whatsapp.msg", message, session_jid: chat, parent_stanza_id: null, media_item: null, group_member_jid: from.member ?? null, blobs: [] },
  };
}
const group = (chat: string, partner: string, archived = false) => ({ kind: "chat", key: chat, content: { type: "whatsapp.chat", group_info: null,
  chat: { ZCONTACTJID: chat, ZCONTACTIDENTIFIER: null, ZPARTNERNAME: partner, ZSESSIONTYPE: 1, ZARCHIVED: archived ? 1 : 0 } } });
const card = (...lines: string[]) => {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.map((line) => `${line}\r\n`).join("")}END:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
};
const record = (slug: string, phone: string, more: Record<string, unknown> = {}) => ({
  kind: "person", key: slug, content: {
    type: "people.person", slug, name: null, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: { kind: "phone", value: phone }, handles: [], excluded: [], dismissed: [], also_called: [], merged_into: null, ...more,
  },
});
const statements = (lines: object[]) => ({ "statements.ndjson": Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) });
const jid = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;
const rows = (page: Body) => (page.sections as Body[]).flatMap((section) => section.rows as Body[]);
const ids = (listed: Body[]) => listed.map((row) => row.id as string);

function asked(url: string, more: Partial<Ask> = {}): Ask {
  return { url, now_ms: at("2026-10-05T06:00:00"), held: { machine: "machine-0001" }, ...more } as unknown as Ask;
}

const EMPTY: PageBody<People> = {
  you: null, counts: { people: 0, groups: 0 }, most: [], sections: [], ai: [], new: [], businesses: null,
  organise: { count: 0, line: null, queue: [], organised: 0, often: 0 }, groups: { yours: [], quiet: [], quiet_line: null },
};

describe("A page served from PAGES", () => {
  const built: string[] = [];
  const serve = (body: () => PageBody<People>, counting = false) => servePages({
    people: {
      params: [],
      open: <T>(ask: PageAsk, use: (opened: Opened<People>) => T) => use({
        position: "7:1700000000000", inputs: ["list-etag", ask.machine], counting, build: () => { built.push(ask.today); return body(); },
      }),
    },
  }, () => DAY).get(PAGES.people.route)!;

  it("answers its shape with the position and the home's today, and a 304 on its ETag without building", async () => {
    const route = serve(() => EMPTY);
    const first = await route(asked("/v1/page/people"));
    expect([first.status, first.headers["lifestream-position"], first.counting]).toEqual([200, "7:1700000000000", undefined]);
    expect(PAGES.people.shape.parse(JSON.parse(first.body as string))).toMatchObject({ position: "7:1700000000000", today: "2026-10-05" });
    built.length = 0;
    const again = await route(asked("/v1/page/people", { if_none_match: first.headers.etag! }));
    expect([again.status, again.body, again.headers["lifestream-position"], built]).toEqual([304, "", "7:1700000000000", []]);
  });

  it("marks a counting answer for settled=1 to hold on, its 304 too, so a held read never ends on the counting answer's ETag", async () => {
    const route = serve(() => EMPTY, true);
    const reply = await route(asked("/v1/page/people?settled=1"));
    expect([reply.status, reply.counting, JSON.parse(reply.body as string).counting]).toEqual([200, true, true]);
    built.length = 0;
    const again = await route(asked("/v1/page/people?settled=1", { if_none_match: reply.headers.etag! }));
    expect([again.status, again.counting, built]).toEqual([304, true, []]);
    expect((await serve(() => EMPTY)(asked("/v1/page/people", { if_none_match: reply.headers.etag! }))).counting, "a settled answer's 304 is not marked").toBeUndefined();
  });

  it("stamps the answer People prepared at the view it was read at, never the prepared file's older position, so settling never falls behind a joined answer", async () => {
    const VIEW = "110:1700000110000", FILE = "100:1700000100000";
    const list = { you: null, people: [], chats: [], organise: { queue: [], organised: 0, often: 0, businesses: [] } };
    let same = false;
    const route = servePages({
      people: peoplePage({
        joined: (_machine, use) => use(
          { same, list: () => list } as unknown as PeopleJoin,
          { position: FILE, etag: () => "\"kept\"", value: () => undefined } as unknown as PreparedRead,
          { position: () => VIEW } as unknown as OpenView,
        ),
        day: () => DAY,
      }),
    }, () => DAY).get(PAGES.people.route)!;
    const joined = await route(asked("/v1/page/people"));
    same = true;
    const completed = await route(asked("/v1/page/people?settled=1"));
    expect([joined, completed].map((reply) => [reply.status, reply.headers["lifestream-position"], JSON.parse(reply.body as string).position]))
      .toEqual([[200, VIEW, VIEW], [200, VIEW, VIEW]]);
  });

  it("refuses to serve an answer its shape does not state, naming the page and the member", () => {
    const broken = serve(() => ({ ...EMPTY, sections: [{ key: "none", title: null, rows: [{ id: "person:a", name: "A", named: true, face: false, photo: null, when: 0 as never, line: null, find: [] }] }] }));
    expect(() => broken(asked("/v1/page/people"))).toThrow(PageShapeError);
    expect(() => broken(asked("/v1/page/people"))).toThrow(/^page people, member sections\[0\]\.rows\[0\]\.when: /u);
  });

  it("is never read for a model, and takes no parameter it does not name", () => {
    const route = serve(() => EMPTY);
    const refused = (ask: Ask): Refusal => {
      try {
        route(ask);
      } catch (error) {
        if (error instanceof Refusal) return error;
        throw error;
      }
      throw new Error("answered");
    };
    const model = refused(asked("/v1/page/people", { reader: "model" }));
    expect([model.status, model.code]).toEqual([403, "PRINCIPAL_SCOPE"]);
    for (const url of ["/v1/page/people?id=person:a", "/v1/page/people?settled=1&settled=1"]) {
      const bad = refused(asked(url));
      expect([bad.status, bad.code], url).toEqual([422, "BAD_PARAMETER"]);
    }
  });
});

describe("The People page through the door", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  let now = at("2026-10-05T06:00:00");
  let shipped = 0;
  const bounds = new Set<() => void>();
  const report: Record<string, unknown> = {};

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const send = async (source: string, lines: object[]) => {
    const made = source === WHATSAPP && readHome(root, (db) => db.prepare("SELECT count(*) FROM sources WHERE id = ?").pluck().get(source)) === 0;
    const id = await ship(root, { source, fetched_ms: now + shipped * MINUTE, rows: lines as never, ...(made ? { facts: { sources: [{ id: source, connector: "people-rows" }] } } : {}) });
    shipped++;
    await until(`${id} imported and People written after it`, () => imported(id) && ran());
  };
  const say = async (lines: object[], held = false) => {
    const id = await shipFiles(root, PEOPLE, now + shipped * MINUTE, statements(lines));
    shipped++;
    await until(held ? `${id} imported` : `${id} imported and People written after it`, () => imported(id) && (held || ran()));
  };
  const get = async (path: string, headers: Record<string, string> = {}, token = READER) => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get("etag"), position: response.headers.get("lifestream-position"), body: text === "" ? null : JSON.parse(text) as Body };
  };
  const page = async (query = "") => {
    const answer = await get(`/v1/page/people${query}`);
    expect(answer.status, `/v1/page/people${query}`).toBe(200);
    PAGES.people.shape.parse(answer.body);
    return answer;
  };
  const pinned = (name: string, body: Body) => {
    mkdirSync(join(REPO, "homelink", "Tests", "Fixtures", "pages"), { recursive: true });
    const fixture = clientFixture(`pages/people.${name}`, body);
    expect(fixture.held, `homelink/Tests/Fixtures/pages/people.${name}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
  };
  const start = async () => {
    home = await startHome(root, { registry: REGISTRY, log: () => undefined });
  };

  const A = "+15550000301", B = "+15550000302", C = "+15550000303", ASSISTANT = "+15550000391", U = "+15550000231", U2 = "+15550000232", SHOP_PHONE = "+15550000392";
  const cardOnly = card("FN:Person Card Only");
  const shopCard = card("FN:Synthetic Shop", "ORG:Synthetic Shop", `TEL:${SHOP_PHONE}`);

  beforeAll(async () => {
    root = makeRoot("lifestream-page-people-", { sources: { [BOOK]: "people-rows", [PEOPLE]: "people-home" }, settings: { unit: UNIT, "day.zone": ZONE } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    mintPrincipal(openHomeFolder(root), { unit: "sender-0001", scopes: ["deliver"], sources: [BOOK], token: SENDER, now_ms: 0 });
    await start();
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, {
      log: () => undefined, registry: REGISTRY, clock: () => now, beats: { settled: (end) => { bounds.add(end); return () => { bounds.delete(end); }; } },
    });
    url = `http://127.0.0.1:${door.port}`;
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "page-people.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("files a person with no card and no messages under No messages yet, with no time and no date standing in for one", async () => {
    await say([record("person-u", U)]);
    await until("the record listed", async () => (await get("/v1/page/people")).status === 200);
    const { body } = await page();
    expect(body!.today).toBe("2026-10-05");
    expect(body!.sections.map((section: Body) => [section.key, section.title, ids(section.rows)])).toEqual([["none", "No messages yet", ["person:person-u"]]]);
    const [row] = rows(body!);
    expect([row!.name, row!.named, row!.when, row!.line, row!.photo], "named by no one: the app draws no initials").toEqual([U, false, null, null, null]);
    expect(row!.find).toContain(U);
    expect([body!.most, body!.ai, body!.groups, body!.counting]).toEqual([[], [], { yours: [], quiet: [], quiet_line: null }, false]);
    report.nothing = body;
    pinned("nothing", body!);
  });

  it("files every listed person by their newest contact, this year by month and before by year, AIs apart, and the groups yours and quiet", async () => {
    await send(BOOK, [card("FN:Person A", `TEL:${A}`), card("FN:Person B", `TEL:${B}`), card("FN:Person C", `TEL:${C}`), cardOnly, shopCard]);
    await say([record("person-ai", ASSISTANT, { name: "Synthetic Assistant", entity: "ai" })]);
    await send(WHATSAPP, [
      group(FRIENDS, "Group Friends"), group(SHOP, "Group Shop", true),
      wa("a1", jid(A), at("2026-10-04T10:00:00"), { me: true }), wa("a2", jid(A), at("2026-10-04T10:01:00")), wa("a3", jid(A), at("2026-10-04T10:02:00"), { me: true }),
      wa("b1", jid(B), at("2026-08-20T10:00:00"), { me: true }), wa("b2", jid(B), at("2026-08-20T10:01:00")),
      wa("c1", jid(C), at("2025-06-10T10:00:00"), { me: true }), wa("c2", jid(C), at("2025-06-10T10:01:00")),
      wa("ai1", jid(ASSISTANT), at("2026-10-03T10:00:00"), { me: true }), wa("ai2", jid(ASSISTANT), at("2026-10-03T10:00:05")),
      wa("fr1", FRIENDS, at("2026-10-04T09:00:00"), { me: true }), wa("fr2", FRIENDS, at("2026-10-04T09:01:00"), { member: jid(A) }),
      wa("shop1", SHOP, at("2026-10-02T09:00:00"), { member: STRANGER }),
    ]);
    const { body } = await page();
    const cardId = contactPersonId({ id: contactId({ source: BOOK, key: cardOnly.key }) });
    const shopId = `phone:${SHOP_PHONE}`;
    expect(body!.sections.map((section: Body) => [section.key, section.title])).toEqual([
      ["month:2026-10", null], ["month:2026-08", null], ["year:2025", null], ["none", "No messages yet"],
    ]);
    const filed = Object.fromEntries(body!.sections.map((section: Body) => [section.key, ids(section.rows)]));
    expect(filed["month:2026-10"]![0]).toBe(`phone:${A}`);
    expect(filed["month:2026-10"]).not.toEqual(expect.arrayContaining([`phone:${B}`]));
    expect(filed["month:2026-08"]).toEqual([`phone:${B}`]);
    expect(filed["year:2025"]).toEqual([`phone:${C}`]);
    expect(filed.none).toEqual(expect.arrayContaining(["person:person-u", cardId]));
    expect(ids(rows(body!))).not.toContain("person:person-ai");
    expect(ids(body!.ai)).toEqual(["person:person-ai"]);
    expect(body!.ai[0].when).toEqual({ kind: "at", at_ms: at("2026-10-03T10:00:05") });
    const byId = new Map(rows(body!).map((row) => [row.id as string, row]));
    expect(byId.get(`phone:${A}`)).toMatchObject({ name: "Person A", named: true, when: { kind: "at", at_ms: at("2026-10-04T10:02:00") }, line: null });
    expect(byId.get(cardId)).toMatchObject({ name: "Person Card Only", when: null, line: "Contact card" });
    expect(byId.get(`phone:${A}`)!.find).toEqual(expect.arrayContaining(["Person A", A.slice(1)]));
    expect(rows(body!).every((row) => row.when === null || row.when.at_ms > 0), "no time stands for none").toBe(true);
    expect(body!.most.map((each: Body) => each.id)).toEqual([`phone:${A}`]);
    expect(body!.most.every((each: Body) => /^\d+\u00a0messages?$/u.test(each.line)), "a count's words, no time word: the app says which month").toBe(true);
    expect(body!.new.every((entry: Body) => body!.organise.queue.includes(entry.id)), "a new person is one Organise asks about").toBe(true);
    expect(body!.new.every((entry: Body) => /^New · \d+\u00a0messages?$/u.test(entry.line)), "each new person's line is their messages").toBe(true);
    expect(body!.businesses, "a card of a company with no person's name, offered with its sign and what the dialog ticks").toEqual({
      line: "1 to accept",
      offered: [{ id: shopId, name: "Synthetic Shop", named: true, photo: null, why: "A company, no person’s name", handles: [{ id: `phone:${SHOP_PHONE}`, words: expect.any(String) }] }],
    });
    expect(body!.organise.count).toBe(body!.organise.queue.length);
    expect(body!.organise.line === null).toBe(body!.organise.count === 0);
    expect([body!.groups.yours.map((chat: Body) => [chat.chat, chat.title]), body!.groups.quiet.map((chat: Body) => [chat.chat, chat.title]), body!.groups.quiet_line])
      .toEqual([[[`whatsapp:${FRIENDS}`, "Group Friends"]], [[`whatsapp:${SHOP}`, "Group Shop"]], `1${NB}group`]);
    const listed = (await get("/v1/people")).body!.people as Body[];
    const writes = ids(listed.filter((each) => each.sent > 0 || each.by === "contact" || each.by === "registry"));
    expect(writes, "people you write to or named, AIs among them; never a record no one named").toEqual(expect.arrayContaining([`phone:${A}`, cardId, "person:person-ai"]));
    expect(writes).not.toContain("person:person-u");
    expect(body!.counts, "the phone's pills: those people, and the groups not quiet").toEqual({ people: writes.length, groups: 1 });
    expect(body!.counting).toBe(false);
    report.full = body;
    pinned("full", body!);
  });

  it("answers 304 on its ETag, and moves it when a message lands and when the home's day turns", async () => {
    const first = await page();
    const same = await get("/v1/page/people", { "if-none-match": first.etag! });
    expect([same.status, same.body, same.position]).toEqual([304, null, first.position]);

    await send(WHATSAPP, [wa("b3", jid(B), at("2026-10-04T11:00:00"))]);
    const landed = await get("/v1/page/people", { "if-none-match": first.etag! });
    expect(landed.status, "a message moved the ETag").toBe(200);
    PAGES.people.shape.parse(landed.body);
    expect(Object.fromEntries(landed.body!.sections.map((section: Body) => [section.key, ids(section.rows)]))["month:2026-10"].slice(0, 2)).toEqual([`phone:${B}`, `phone:${A}`]);
    expect((await get("/v1/page/people", { "if-none-match": landed.etag! })).status).toBe(304);

    now = at("2026-10-06T06:00:00");
    const turned = await get("/v1/page/people", { "if-none-match": landed.etag! });
    expect([turned.status, turned.body?.today], "the day turned: today moved the ETag").toEqual([200, "2026-10-06"]);
    expect(turned.etag).not.toBe(landed.etag);
  });

  it("holds settled=1 until People has counted the owner's word giving a person a handle, and answers counting beside it", async () => {
    await askHome(testSocket(root), "pause", ["kind:people", "--reason", "a test holds People's run"]);
    await say([record("person-u", U, { name: "Person U", handles: [{ kind: "phone", value: U2 }] })], true);
    await home.stop();
    const db = openHomeDb(openHomeFolder(root), "migrate");
    try {
      db.commit((tx) => {
        for (const control of tx.tables.controls.list()) tx.tables.controls.clear(control.target);
      });
    } finally {
      db.close();
    }

    const counting = await page();
    expect(counting.body!.counting, "the word is joined, People's run not yet made").toBe(true);
    const newest = readHome(root, (db) => db.prepare("SELECT seq || ':' || at_ms FROM events ORDER BY seq DESC LIMIT 1").pluck().get());
    expect([counting.body!.position, counting.position], "a join of newer heads carries the joining view's position, never the prepared file's").toEqual([newest, newest]);
    pinned("counting", counting.body!);
    const held = get("/v1/page/people?settled=1", { "if-none-match": counting.etag! });
    await until("the settled read held, though it carries the counting answer's ETag", () => bounds.size === 1);
    expect((await get("/v1/page/people")).status, "a plain read answers beside the held one").toBe(200);

    await start();
    const settled = await held;
    expect(settled.status).toBe(200);
    PAGES.people.shape.parse(settled.body);
    const u = rows(settled.body!).find((row) => row.id === "person:person-u");
    expect([settled.body!.counting, u?.name], "answered at People's event, the word counted").toEqual([false, "Person U"]);
    expect(u?.find, "the handle the word gave").toContain(U2);
    expect(bounds.size).toBe(0);
    await until("People written after the restart", ran);
  });

  it("is read only by a reader the read gate lets in, never for a model", async () => {
    expect((await get("/v1/page/people", {}, SENDER)).body).toMatchObject({ code: "PRINCIPAL_SCOPE" });
    expect((await get("/v1/page/people", { "lifestream-reader": "model" })).body).toMatchObject({ code: "PRINCIPAL_SCOPE" });
    expect((await get("/v1/page/people?q=person")).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await get("/v1/page/people?settled=yes")).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await get("/v1/page/person?id=person:person-u", {}, SENDER)).body).toMatchObject({ code: "PRINCIPAL_SCOPE" });
  });
});

describe("The People page at the live home's size", () => {
  const PEOPLE_AT_SIZE = 2_700;
  const TALKED = 900;
  const READS = 5;
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  const report: Record<string, unknown> = {};

  const timed = async (path: string) => {
    const began = performance.now();
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READER}` } });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as Body, ms: performance.now() - began };
  };
  const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;

  beforeAll(async () => {
    root = makeRoot("lifestream-page-people-size-", { sources: { [BOOK]: "people-rows", [PEOPLE]: "people-home" }, settings: { unit: UNIT, "day.zone": ZONE } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    home = await startHome(root, { registry: REGISTRY, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY, clock: () => at("2026-10-05T06:00:00") });
    url = `http://127.0.0.1:${door.port}`;
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "page-people-size.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("answers about 2,700 people in one page, its time printed for the evidence step", async () => {
    const phone = (n: number) => `+1555001${String(n).padStart(4, "0")}`;
    await ship(root, { source: BOOK, fetched_ms: at("2026-10-05T00:00:00"), rows: Array.from({ length: PEOPLE_AT_SIZE }, (_, n) => card(`FN:Person S${n}`, `TEL:${phone(n)}`)) as never });
    await ship(root, {
      source: WHATSAPP, fetched_ms: at("2026-10-05T00:01:00"), facts: { sources: [{ id: WHATSAPP, connector: "people-rows" }] },
      rows: Array.from({ length: TALKED }, (_, n) => wa(`s${n}`, jid(phone(n * 3)), at("2026-10-04T10:00:00") - (n % 120) * 86_400_000 - n * MINUTE)) as never,
    });
    await until("every person prepared and every message counted", async () => {
      const answer = await timed("/v1/page/people");
      return answer.status === 200 && answer.body.counting === false && rows(answer.body).length === PEOPLE_AT_SIZE
        && rows(answer.body).filter((row) => row.when !== null).length === TALKED;
    });
    const page: number[] = [];
    const list: number[] = [];
    for (let read = 0; read < READS; read++) {
      const shaped = await timed("/v1/page/people");
      PAGES.people.shape.parse(shaped.body);
      page.push(shaped.ms);
      list.push((await timed("/v1/people")).ms);
    }
    const answer = await timed("/v1/page/people");
    expect(rows(answer.body)).toHaveLength(PEOPLE_AT_SIZE);
    expect(rows(answer.body).filter((row) => row.when !== null)).toHaveLength(TALKED);
    Object.assign(report, { people: PEOPLE_AT_SIZE, talked: TALKED, sections: answer.body.sections.length, page_ms: page, list_ms: list, page_median_ms: median(page), list_median_ms: median(list), budget_ms: 60 });
    process.stdout.write(`page /v1/page/people at ${PEOPLE_AT_SIZE} people: median ${median(page).toFixed(1)} ms over ${READS} reads (budget 60), /v1/people ${median(list).toFixed(1)} ms\n`);
  });
});

