import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import type { KindsHit, Sitting } from "./kinds-contract.js";
import { hitRow, sittingRow } from "./page-search.js";
import { PAGES } from "./pages.js";
import { mintPrincipal } from "./principals.js";
import { makeRef } from "./refs.js";
import { askHome } from "./socket.js";
import { testSocket } from "./test/folder.js";
import { clientFixture, makeRoot, readHome, removeRoot, REPO, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";

const ZONE = "Asia/Kolkata";
const UNIT = "macbook-pro-0001";
const WHATSAPP = "whatsapp:919000000009:iphone-aa01";
const BOOK = "apple-contacts:local:iphone-aa01";
const PEOPLE = `people:local:${UNIT}`;
const REGISTRY = join(REPO, "packages", "home", "test", "groups-registry.ts");
const READER = "synthetic-search-reader".padEnd(43, "r");
const APPLE_EPOCH_S = 978_307_200;
const FRIENDS = "120363000000000041@g.us";
const A = "+15550000401";
const B = "+15550000402";
const WORD = "lighthouse";
const FACE = Buffer.from("synthetic jpeg bytes of person a's card photo");
const MINUTE = 60_000;
const at = (utc: string) => Date.parse(`${utc}Z`);

type Body = Record<string, any>;

const jid = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;

function wa(stanza: string, chat: string, when: number, text: string, from: { me?: true; member?: string } = {}) {
  const date = when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: stanza, ZTEXT: text, ZFROMJID: from.me === true ? null : chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: 0, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: from.me === true ? 1 : 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${chat}:${stanza}`, at: when,
    content: { type: "whatsapp.msg", message, session_jid: chat, parent_stanza_id: null, media_item: null, group_member_jid: from.member ?? null, blobs: [] },
  };
}
const group = (chat: string, partner: string) => ({ kind: "chat", key: chat, content: { type: "whatsapp.chat", group_info: null,
  chat: { ZCONTACTJID: chat, ZCONTACTIDENTIFIER: null, ZPARTNERNAME: partner, ZSESSIONTYPE: 1, ZARCHIVED: 0 } } });
const card = (...lines: string[]) => {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.map((line) => `${line}\r\n`).join("")}END:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
};

const times = (text: string, part: string): number => text.split(part).length - 1;

describe("A search row worded by the home", () => {
  const apps = { product: (id: string) => (id === "chatgpt" ? "ChatGPT" : id) };
  const ai = (title: string | undefined): KindsHit => ({
    ref: "record.synthetic-ai", family: "ai", day: "2026-10-04", at: "2026-10-04T10:00+05:30", product: "chatgpt",
    ...(title === undefined ? {} : { title }), from: "the user", snippet: `a ${WORD} «trip»`,
  });

  it("names an AI hit's app once: dropped from its title, said in its line", () => {
    const hit = hitRow(apps, ai("ChatGPT · Synthetic trip plan"), null) as Body;
    expect([hit.title, hit.line]).toEqual(["Synthetic trip plan", `ChatGPT · You: a ${WORD} «trip»`]);
    expect(times(`${hit.title}\n${hit.line}`, "ChatGPT")).toBe(1);
    expect(hit.when).toEqual({ kind: "at", at_ms: Date.parse("2026-10-04T10:00+05:30") });
  });

  it("titles an AI hit with no title of its own by its app, and then says the app nowhere else", () => {
    for (const title of [undefined, "ChatGPT · "]) {
      const hit = hitRow(apps, ai(title), null) as Body;
      expect(hit.title, String(title)).toBe("ChatGPT");
      expect(times(`${hit.title}\n${hit.line}`, "ChatGPT"), String(title)).toBe(1);
    }
  });

  it("titles a message by its chat, its line the speaker only when another than the chat, and a hit with nothing by its kind", () => {
    const message: KindsHit = { ref: "record.synthetic-message", family: "messages", day: "2026-10-04", chat_title: "Friends", from: "Person A", snippet: "see  you\nthere" };
    expect(hitRow(apps, message, null)).toEqual({
      kind: "hit", ref: message.ref, family: "messages", title: "Friends", line: "Person A: see you there", when: { kind: "day", day: "2026-10-04" }, picture: null, opens: null,
    });
    expect((hitRow(apps, { ...message, chat_title: "Person A" }, null) as Body).line).toBe("see you there");
    expect(hitRow(apps, { ref: "record.synthetic-note", family: "notes" }, null)).toMatchObject({ title: "Notes", line: null, when: null });
  });

  it("shows a photo's picture and opens a hit where it is told", () => {
    const image = `sha256:${"a".repeat(64)}`;
    const opens = { page: "days", day: "2026-10-04", focus: "u:photos/1" } as const;
    expect(hitRow(apps, { ref: "record.synthetic-photo", family: "photos", day: "2026-10-04", image }, opens)).toMatchObject({ picture: image, opens });
  });

  it("words a sitting by its summary or first window, its windows each opening at their own minute, the sitting at its day", () => {
    const at_ms = Date.parse("2026-10-04T10:40:00Z");
    const window = { ref: "window.synthetic", at: new Date(at_ms).toISOString(), app: "Example Editor", title: "", snippet: `the ${WORD}  «plan»` };
    const sitting: Sitting = { at: "2026-10-04T10:00:00Z", day: "2026-10-04", windows: 2, matched: [window], focus: "u:screen:local:mac-0001/1", summary: "Writing a plan" };
    const minute = { page: "days", day: "2026-10-04", focus: `u:screen:local:mac-0001/1@${at_ms}-${at_ms + MINUTE}` } as const;
    expect(sittingRow(sitting, (ref) => (ref === window.ref ? minute : null))).toEqual({
      kind: "sitting", key: "u:screen:local:mac-0001/1", title: "Writing a plan", line: `2\u00a0windows · Example Editor · the ${WORD} «plan»`, said: null,
      when: { kind: "at", at_ms: Date.parse(sitting.at) },
      windows: [{ ref: window.ref, app: "Example Editor", title: "Example Editor", line: `Example Editor · the ${WORD} «plan»`, when: { kind: "at", at_ms }, opens: minute }],
      windows_line: "1 of 2\u00a0windows",
      opens: { page: "days", day: "2026-10-04", focus: "u:screen:local:mac-0001/1" },
    });
    const run: Sitting = { at: sitting.at, day: sitting.day, windows: 0, matched: [], snippet: "Writing" };
    expect(sittingRow(run, () => null)).toMatchObject({ key: `at:${Date.parse(sitting.at)}`, title: "Mac", line: "Writing", said: "Writing", windows: [], windows_line: null, opens: { focus: null } });
  });
});

describe("The search page through the door", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  let shipped = 0;
  const now = at("2026-10-05T06:00:00");

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const quietButSearch = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running') AND NOT (kind = 'index' AND key = 'search')").pluck().get()) === 0;
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const send = async (source: string, lines: object[]) => {
    const made = source === WHATSAPP;
    const id = await ship(root, { source, fetched_ms: now + shipped * MINUTE, rows: lines as never, ...(made ? { facts: { sources: [{ id: source, connector: "people-rows" }] } } : {}) });
    shipped++;
    await until(`${id} imported and all but the search index written after it`, () => imported(id) && quietButSearch());
  };
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READER}`, ...headers } });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get("etag"), position: response.headers.get("lifestream-position"), body: text === "" ? null : JSON.parse(text) as Body };
  };
  const page = async (name: "search" | "searchKind", query: string) => {
    const { route, shape } = PAGES[name];
    const began = performance.now();
    const answer = await get(`${route}?${query}`);
    const ms = performance.now() - began;
    expect(answer.status, `${route}?${query}: ${JSON.stringify(answer.body)}`).toBe(200);
    shape.parse(answer.body);
    return { ...answer, ms };
  };
  const pinned = (name: "search" | "searchKind", fixture: string, body: Body) => {
    mkdirSync(join(REPO, "homelink", "Tests", "Fixtures", "pages"), { recursive: true });
    const written = clientFixture(`pages/${name}.${fixture}`, body);
    expect(written.held, `homelink/Tests/Fixtures/pages/${name}.${fixture}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(written.written);
  };
  const rowsIn = (body: Body): Body[] => [...body.top, ...body.kinds.flatMap((kind: Body) => kind.rows)];
  const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)]!;

  beforeAll(async () => {
    root = makeRoot("lifestream-page-search-", { sources: { [BOOK]: "people-rows", [PEOPLE]: "people-home" }, settings: { unit: UNIT, "day.zone": ZONE } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    home = await startHome(root, { registry: REGISTRY, log: () => undefined });
    await askHome(testSocket(root), "pause", ["index:search", "--reason", "a test reads the page before search is built"]);
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY, clock: () => now });
    url = `http://127.0.0.1:${door.port}`;
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("says search is getting ready, on the page and on a kind's page, while its index is first built", async () => {
    await send(BOOK, [card("FN:Person A", `TEL:${A}`, `PHOTO;ENCODING=b;TYPE=JPEG:${FACE.toString("base64")}`), card("FN:Person B", `TEL:${B}`)]);
    await send(WHATSAPP, [
      group(FRIENDS, "Group Friends"),
      wa("a1", jid(A), at("2026-10-04T10:00:00"), `the ${WORD} at dusk`, { me: true }), wa("a2", jid(A), at("2026-10-04T10:01:00"), `a ${WORD} keeper waved`),
      wa("a3", jid(A), at("2026-10-04T10:02:00"), "synthetic reply"),
      wa("b1", jid(B), at("2026-09-20T10:00:00"), "synthetic hello", { me: true }),
      wa("f1", FRIENDS, at("2026-10-03T09:00:00"), "synthetic group line", { me: true }), wa("f2", FRIENDS, at("2026-10-03T09:01:00"), "synthetic group answer", { member: jid(A) }),
    ]);
    const { body } = await page("search", `query=${WORD}`);
    expect(body).toMatchObject({ top: [], kinds: [], total: { n: 0, partial: false }, held: null, reading: { state: "building", line: expect.stringMatching(/^Search is getting ready/u) }, nothing: null });
    pinned("search", "reading", body!);
    const kind = (await page("searchKind", `query=${WORD}&see=messages`)).body!;
    expect(kind).toMatchObject({ family: "messages", title: "Messages", upcoming: false, rows: [], next: null, unread: null, reading: { state: "building" }, nothing: null });
  });

  it("finds a message with the home's title, line, time and where it opens, in its kind's section and on its kind's page", async () => {
    await askHome(testSocket(root), "resume", ["index:search"]);
    await until("the search index written", ran);
    const { body } = await page("search", `query=${WORD}`);
    expect(body!.reading).toBeNull();
    expect(body!.nothing).toBeNull();
    const rows = rowsIn(body!);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect([row.kind, row.family, row.title], row.ref).toEqual(["hit", "messages", "Person A"]);
      expect(row.when.kind, row.ref).toBe("at");
      expect(row.opens, row.ref).toMatchObject({ page: "days", day: "2026-10-04" });
    }
    expect(rows.map((row) => row.line)).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^You: .*${WORD}`, "u")), expect.stringMatching(new RegExp(`^a .*${WORD}`, "u"))]));
    const messages = (body!.kinds as Body[]).find((kind) => kind.family === "messages");
    expect(messages).toMatchObject({ title: "Messages", upcoming: null, unread: null });
    expect(body!.total).toEqual({ n: messages!.count.n, partial: false });
    pinned("search", "full", body!);

    const kind = (await page("searchKind", `query=${WORD}&see=messages`)).body!;
    expect(kind).toMatchObject({ family: "messages", title: "Messages", upcoming: false, next: null, unread: null, reading: null, nothing: null });
    expect((kind.rows as Body[]).map((row) => row.ref).sort()).toEqual(rows.map((row) => row.ref).sort());
    pinned("searchKind", "full", kind);
    expect((await page("searchKind", `query=${WORD}&see=calls`)).body).toMatchObject({ family: "calls", rows: [], nothing: `Nothing matches “${WORD}”.` });
    expect((await page("search", "query=xylophone")).body).toMatchObject({ top: [], kinds: [], nothing: "Nothing matches “xylophone”." });
  });

  it("costs what the kinds read costs plus one batched describe of its rows (printed, never asserted)", async () => {
    const kindsMs: number[] = [];
    const pageMs: number[] = [];
    const describeMs: number[] = [];
    const refs = rowsIn((await page("search", `query=${WORD}`)).body!).flatMap((row) => (typeof row.ref === "string" ? [row.ref] : []));
    for (let round = 0; round < 5; round++) {
      let began = performance.now();
      expect((await get(`/v1/search/kinds?query=${WORD}`)).status).toBe(200);
      kindsMs.push(performance.now() - began);
      pageMs.push((await page("search", `query=${WORD}`)).ms);
      began = performance.now();
      expect((await get(`/v1/describe?${new URLSearchParams(refs.map((ref): [string, string] => ["ref", ref]))}`)).status).toBe(200);
      describeMs.push(performance.now() - began);
    }
    process.stdout.write(`search page ${median(pageMs).toFixed(1)} ms, /v1/search/kinds ${median(kindsMs).toFixed(1)} ms, /v1/describe of its ${refs.length} rows ${median(describeMs).toFixed(1)} ms (medians of 5)\n`);
  });

  it("answers 304 on its ETag, takes each parameter once and a kind's page only with its kind or cursor, and is never read for a model", async () => {
    const first = await page("search", `query=${WORD}`);
    const same = await get(`${PAGES.search.route}?query=${WORD}`, { "if-none-match": first.etag! });
    expect([same.status, same.body, same.position]).toEqual([304, null, first.position]);
    expect((await get(`${PAGES.search.route}?query=${WORD}&query=keeper`)).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await get(`${PAGES.search.route}?query=${WORD}&see=messages`)).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await get(`${PAGES.search.route}?query=${WORD}&settled=1`)).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await get(`${PAGES.searchKind.route}?query=${WORD}`)).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await get(`${PAGES.search.route}?query=${WORD}`, { "lifestream-reader": "model" })).body).toMatchObject({ code: "PRINCIPAL_SCOPE" });
  });

  it("goes to a named person with their People photo and id, a named day, and a named month at its newest written day", async () => {
    const named = (await page("search", "query=Person%20A")).body!;
    const top = named.top as Body[];
    const person = top.find((row) => row.kind === "person" && row.name === "Person A");
    const people = (await get(PAGES.people.route)).body!;
    const listed = (people.sections as Body[]).flatMap((section) => section.rows as Body[]).find((row) => row.name === "Person A");
    expect(listed?.photo, JSON.stringify(people.sections)).toEqual(expect.any(String));
    expect(person, JSON.stringify(top)).toMatchObject({ picture: listed!.photo, opens: { page: "people", person: listed!.id, group: null } });
    pinned("search", "person", named);

    const [day] = (await page("search", "query=yesterday")).body!.top as Body[];
    expect(day).toEqual({ kind: "date", when: { kind: "day", day: "2026-10-04" }, opens: { page: "days", day: "2026-10-04", focus: null } });

    const [month] = (await page("search", "query=october%202026")).body!.top as Body[];
    expect(month).toMatchObject({ kind: "date", when: { kind: "month", month: "2026-10" }, opens: { page: "month", month: "2026-10" } });
    const newest = month!.opens.day as string;
    expect(newest >= "2026-10-04" && newest <= "2026-10-05", newest).toBe(true);
    expect((await get(`/v1/days/${newest}`)).status, "the day it opens is written").toBe(200);
    if (newest === "2026-10-04") expect((await get("/v1/days/2026-10-05")).status, "no later October day is written").not.toBe(200);
    expect(((await page("search", "query=september%202026")).body!.top as Body[])[0]!.opens).toEqual({ page: "month", month: "2026-09", day: "2026-09-20" });
  });

  it("describes a person by their handle alone, a one-to-one chat with the person at its other end, and a group as its own page with no one", async () => {
    const one = makeRef("chat", { key: `whatsapp:${jid(A)}` });
    const unanswered = makeRef("chat", { key: `whatsapp:${jid(B)}` });
    const friends = makeRef("chat", { key: `whatsapp:${FRIENDS}` });
    const them = makeRef("person", { handle: `phone:${A}` });
    const { status, body } = await get(`/v1/describe?${new URLSearchParams([["ref", one], ["ref", unanswered], ["ref", friends], ["ref", them]])}`);
    expect(status, JSON.stringify(body)).toBe(200);
    const [chat, mine, room, person] = body!.described as Body[];
    expect(chat).toMatchObject({ kind: "chat", opens: { page: "people", id: `whatsapp:${jid(A)}`, person: `phone:${A}` } });
    expect(chat!.opens, "a one-to-one chat is no group").not.toHaveProperty("group");
    expect(mine, "a chat where only you wrote opens the person you wrote to").toMatchObject({ kind: "chat", opens: { page: "people", id: `whatsapp:${jid(B)}`, person: `phone:${B}` } });
    expect(mine!.opens).not.toHaveProperty("group");
    expect(room).toMatchObject({ kind: "chat", name: "Group Friends", opens: { page: "people", id: `whatsapp:${FRIENDS}`, person: null, group: `whatsapp:${FRIENDS}` } });
    expect(person).toEqual({ ref: them, kind: "person", name: "Person A", opens: { page: "people", id: `phone:${A}` } });
  });
});
