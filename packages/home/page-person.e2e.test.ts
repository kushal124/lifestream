import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHome as openHomeDb, openHomeFolder } from "@lifestreamprotocol/core";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { PAGES, type PageName } from "./pages.js";
import { mintPrincipal } from "./principals.js";
import { NB } from "./stream-words.js";
import { askHome } from "./socket.js";
import { testSocket } from "./test/folder.js";
import { clientFixture, makeRoot, readHome, removeRoot, REPO, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";

const ZONE = "Asia/Kolkata";
const UNIT = "macbook-pro-0001";
const WHATSAPP = "whatsapp:919000000009:iphone-aa01";
const MAIL = "gmail:person-me@example.com:cloud";
const BOOK = "apple-contacts:local:iphone-aa01";
const PEOPLE = `people:local:${UNIT}`;
const REGISTRY = join(REPO, "packages", "home", "test", "groups-registry.ts");
const READER = "synthetic-person-reader".padEnd(43, "r");
const SENDER = "synthetic-person-sender".padEnd(43, "s");
const APPLE_EPOCH_S = 978_307_200;
const FRIENDS = "120363000000000051@g.us";
const at = (utc: string) => Date.parse(`${utc}Z`);
const MINUTE = 60_000;
const WEEK = 7 * 86_400_000;
const SENT_TO_BE_LISTED = 3;

type Body = Record<string, any>;

const FORWARDED_FLAG = 256;

function wa(stanza: string, chat: string, when: number, from: { me?: true; member?: string; flags?: number } = {}) {
  const date = when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: stanza, ZTEXT: `synthetic line ${stanza}`, ZFROMJID: from.me === true ? null : chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: 0, ZGROUPEVENTTYPE: null, ZFLAGS: from.flags ?? 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: from.me === true ? 1 : 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${chat}:${stanza}`, at: when,
    content: { type: "whatsapp.msg", message, session_jid: chat, parent_stanza_id: null, media_item: null, group_member_jid: from.member ?? null, blobs: [] },
  };
}
const group = (chat: string, partner: string, session = 1) => ({ kind: "chat", key: chat, content: { type: "whatsapp.chat", group_info: null,
  chat: { ZCONTACTJID: chat, ZCONTACTIDENTIFIER: null, ZPARTNERNAME: partner, ZSESSIONTYPE: session, ZARCHIVED: 0 } } });
const card = (...lines: string[]) => {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.map((line) => `${line}\r\n`).join("")}END:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
};
function mail(key: string, when: number, from: string, to: string) {
  const bytes = Buffer.from([`From: ${from}`, `To: ${to}`, `Subject: synthetic ${key}`, `Date: ${new Date(when).toUTCString()}`, `Message-ID: <${key}@example.com>`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "A synthetic body.", ""].join("\r\n"));
  const hex = createHash("sha256").update(bytes).digest("hex");
  return {
    row: { kind: "mailmsg", key, at: when, blobs: [`sha256:${hex}`], content: { content: { gm_msgid: key, folder: "INBOX", labels: [] }, blobs: [{ hash: `sha256:${hex}`, role: "original", media_type: "message/rfc822" }] } },
    carried: [hex, bytes] as const,
  };
}
const record = (slug: string, phone: string, more: Record<string, unknown> = {}) => ({
  kind: "person", key: slug, content: {
    type: "people.person", slug, name: null, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: { kind: "phone", value: phone }, handles: [], excluded: [], dismissed: [], also_called: [], merged_into: null, ...more,
  },
});
const statements = (lines: object[]) => ({ "statements.ndjson": Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) });
const jid = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;
const texts = (talk: Body | null) => (talk?.lines as Body[] | undefined)?.map((line) => line.text as string) ?? [];

describe("The person, group and find pages through the door", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  let now = at("2026-10-05T06:00:00");
  let shipped = 0;
  const report: Record<string, unknown> = {};

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const send = async (source: string, lines: object[], carried: Record<string, Buffer> = {}) => {
    const made = readHome(root, (db) => db.prepare("SELECT count(*) FROM sources WHERE id = ?").pluck().get(source)) === 0 && source !== BOOK;
    const id = await ship(root, { source, fetched_ms: now + shipped * MINUTE, rows: lines as never, carried, ...(made ? { facts: { sources: [{ id: source, connector: "people-rows" }] } } : {}) });
    shipped++;
    await until(`${id} imported and its work done`, () => imported(id) && ran());
  };
  const say = async (lines: object[], held = false) => {
    const id = await shipFiles(root, PEOPLE, now + shipped * MINUTE, statements(lines));
    shipped++;
    await until(held ? `${id} imported` : `${id} imported and its work done`, () => imported(id) && (held || ran()));
  };
  const get = async (path: string, headers: Record<string, string> = {}, token = READER) => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get("etag"), position: response.headers.get("lifestream-position"), body: text === "" ? null : JSON.parse(text) as Body };
  };
  const page = async (name: PageName, query: string) => {
    const answer = await get(`${PAGES[name].route}?${query}`);
    expect(answer.status, `${PAGES[name].route}?${query}`).toBe(200);
    PAGES[name].shape.parse(answer.body);
    return answer;
  };
  const pinned = (name: string, body: Body) => {
    mkdirSync(join(REPO, "homelink", "Tests", "Fixtures", "pages"), { recursive: true });
    const fixture = clientFixture(`pages/${name}`, body);
    expect(fixture.held, `homelink/Tests/Fixtures/pages/${name}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
  };
  const idOf = async (name: string) => {
    const { body } = await page("people", "");
    const row = (body!.sections as Body[]).flatMap((section) => section.rows as Body[]).find((each) => each.name === name);
    expect(row, `${name} is listed`).toBeDefined();
    return row!.id as string;
  };

  const M = "+15550000408";
  const K = "+15550000401", L = "+15550000402", U = "+15550000403", X = "+15550000404", Y = "+15550000405", Q1 = "+15550000406", Q2 = "+15550000407";
  const U2 = "+15550000410";
  const cardOnly = card("FN:Person Card Only");

  beforeAll(async () => {
    root = makeRoot("lifestream-page-person-", { sources: { [BOOK]: "people-rows", [PEOPLE]: "people-home" }, settings: { unit: UNIT, "day.zone": ZONE } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    mintPrincipal(openHomeFolder(root), { unit: "sender-0001", scopes: ["deliver"], sources: [BOOK], token: SENDER, now_ms: 0 });
    home = await startHome(root, { registry: REGISTRY, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY, clock: () => now });
    url = `http://127.0.0.1:${door.port}`;

    await send(BOOK, [card("FN:Person K", `TEL:${K}`, "EMAIL:person-k@example.com"), card("FN:Person L", `TEL:${L}`), card("FN:Person M", `TEL:${M}`), cardOnly]);
    await say([record("person-u", U), record("person-x", X, { name: "Person X" }), record("person-y", Y, { name: "Person Y", merged_into: "person-x" }),
      record("person-q1", Q1, { name: "Quinn" }), record("person-q2", Q2, { name: "Quinn" })]);
    await send(WHATSAPP, [
      group(FRIENDS, "Group Friends"),
      wa("k1", jid(K), at("2026-09-20T10:00:00")), wa("k2", jid(K), at("2026-09-20T10:01:00"), { me: true, flags: FORWARDED_FLAG }),
      wa("fr1", FRIENDS, at("2026-10-04T10:00:00"), { member: jid(L) }), wa("fr2", FRIENDS, at("2026-10-04T10:01:00"), { member: jid(M) }),
      wa("fr3", FRIENDS, at("2026-10-04T10:02:00"), { me: true }),
    ]);
    const mails = [mail("m1", at("2026-10-03T10:00:00"), "Person K <person-k@example.com>", "Person Me <person-me@example.com>")];
    await send(MAIL, mails.map((each) => each.row), Object.fromEntries(mails.map((each) => each.carried)));
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "page-person.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("answers Last talked from the newest one-to-one chat's day, though a newer email is their newest contact", async () => {
    const k = await idOf("Person K");
    const single = await get(`/v1/people?id=${encodeURIComponent(k)}`);
    expect(single.body!.person.last_ms, "the email is their newest contact").toBe(at("2026-10-03T10:00:00"));
    await until("Person K's chat day written", async () => (await page("person", `id=${encodeURIComponent(k)}`)).body!.talk !== null);
    const { body } = await page("person", `id=${encodeURIComponent(k)}`);
    expect([body!.talk.day, body!.talk.chat]).toEqual(["2026-09-20", `whatsapp:${jid(K)}`]);
    expect(texts(body!.talk), "the day file's (forwarded) is the line's mark, not its words").toEqual(["synthetic line k1", "synthetic line k2"]);
    expect(body!.talk.lines.map((line: Body) => [line.who, line.mine, line.forwarded])).toEqual([[k, false, false], [expect.any(String), true, true]]);
    const numbers = body!.talk.lines.map((line: Body) => line.n as number);
    expect(numbers[0] > 0 && numbers[1] > numbers[0], "each line opens at its own day-file line").toBe(true);
    expect(body!.talk.focus, "the talk opens its day at its last line").toBe(`a${numbers[1]}`);
    expect([body!.talk.group, typeof body!.talk.network]).toEqual([false, "string"]);
    expect([body!.became, body!.counting, body!.head.name, body!.head.named]).toEqual([null, false, "Person K", true]);
    expect(body!.where.map((each: Body) => [each.chat, each.group, each.quiet]), "a group they never wrote in is not where they talk; their mail is a row of its own after their chats")
      .toEqual([[`whatsapp:${jid(K)}`, false, false], [null, false, false]]);
    expect(body!.where[1]).toEqual({ chat: null, title: "Mail", group: false, network: "Mail", when: null, count: 1, line: `1${NB}mail`, quiet: false });
    expect(body!.where[0].when).toEqual({ kind: "at", at_ms: at("2026-09-20T10:01:00") });
    expect(body!.history, "two weeks of a few messages: the facts, first contact its day").toMatchObject({ kind: "facts", first: "2026-09-20" });
    expect(body!.month.days).toHaveLength(30);
    expect(body!.month.days.at(-1)).toEqual({ day: "2026-10-05", count: 0 });
    await until("Person K's mail read for Edit", async () => (await page("person", `id=${encodeURIComponent(k)}`)).body!.edit.mails.newest !== null);
    const edit = (await page("person", `id=${encodeURIComponent(k)}`)).body!.edit;
    expect([edit.call, edit.face, edit.reach, edit.much], "Edit's words are the home's: where they talk and how much")
      .toEqual(["Person K", false, "WhatsApp and Mail", `2${NB}messages · 1${NB}mail`]);
    expect(edit.last, "their last contact, the mail").toEqual({ kind: "at", at_ms: at("2026-10-03T10:00:00") });
    expect([edit.mails.from, edit.mails.to]).toEqual([1, 0]);
    expect(edit.mails.newest, "their newest mail, for Edit's evidence").toMatchObject([{ family: "mail", day: "2026-10-03" }]);
    report.full = body;
    pinned("person.full", { ...body!, edit });
  });

  it("keeps only their lines and yours from a group, never another member's", async () => {
    const l = await idOf("Person L");
    await until("Person L's group day written", async () => (await page("person", `id=${encodeURIComponent(l)}`)).body!.talk !== null);
    const { body } = await page("person", `id=${encodeURIComponent(l)}`);
    expect([body!.talk.day, body!.talk.chat]).toEqual(["2026-10-04", `whatsapp:${FRIENDS}`]);
    expect(texts(body!.talk), "another member's line in the group is not Person L's talk").toEqual(["synthetic line fr1", "synthetic line fr3"]);
  });

  it("answers a group with who writes most and the whole group's last run", async () => {
    const { body } = await page("group", `chat=${encodeURIComponent(`whatsapp:${FRIENDS}`)}`);
    expect([body!.head.title, body!.total, body!.yours, body!.head.word, body!.head.quiet, body!.head.why]).toEqual(["Group Friends", 3, "33%", "rule", false, null]);
    expect([body!.talk.group, body!.writers.every((writer: Body) => writer.named === true && writer.photo === null)]).toEqual([true, true]);
    expect(body!.writers.map((writer: Body) => writer.id)).toEqual(expect.arrayContaining([await idOf("Person L"), await idOf("Person M")]));
    expect(body!.writers).toHaveLength(2);
    expect(texts(body!.talk), "every member's line").toEqual(["synthetic line fr1", "synthetic line fr2", "synthetic line fr3"]);
    pinned("group.full", body!);
    expect((await get(`/v1/page/group?chat=${encodeURIComponent(`whatsapp:${jid(K)}`)}`)).body).toMatchObject({ code: "CHAT_UNKNOWN" });
  });

  it("words a group set never quiet as the owner's choice, as it words every other quiet state", async () => {
    const chat = `whatsapp:${FRIENDS}`;
    await say([{ kind: "group", key: chat, content: { quiet: false } }]);
    const { body } = await page("group", `chat=${encodeURIComponent(chat)}`);
    expect([body!.head.word, body!.head.quiet, body!.head.why]).toEqual(["never", false, { words: "You set it", since: null }]);
    await say([{ kind: "group", key: chat, content: { quiet: true } }]);
    const always = (await page("group", `chat=${encodeURIComponent(chat)}`)).body!;
    expect([always.head.word, always.head.quiet, always.head.why]).toEqual(["always", true, { words: "You set it", since: null }]);
    await say([{ kind: "group", key: chat, gone: true }]);
    const rule = (await page("group", `chat=${encodeURIComponent(chat)}`)).body!;
    expect([rule.head.word, rule.head.quiet, rule.head.why], "the rule's group, written in, carries no reason").toEqual(["rule", false, null]);
  });

  it("answers a person with no messages with no talk, no weeks and no date standing in for one", async () => {
    const { body } = await page("person", "id=person:person-u");
    expect([body!.talk, body!.history, body!.head.since, body!.month.line, body!.month.before, body!.where])
      .toEqual([null, { kind: "facts", total: 0, first: null }, null, "None in the last 30 days", null, []]);
    pinned("person.nothing", body!);
  });

  it("answers an id merged away with the survivor's page and became, and an id never held with 404", async () => {
    const { body } = await page("person", "id=person:person-y");
    expect([body!.became, body!.head.name]).toEqual(["person:person-x", "Person X"]);
    pinned("person.became", body!);
    expect((await get("/v1/page/person?id=person:person-never")).body).toMatchObject({ code: "PERSON_UNKNOWN" });
  });

  it("finds at most six people, never a contact card's id, the person asked for or anyone already suggested for them", async () => {
    const { body } = await page("peopleFind", "q=Person");
    expect(body!.rows.length).toBeGreaterThan(0);
    expect(body!.rows.length).toBeLessThanOrEqual(6);
    expect(body!.rows.some((row: Body) => (row.id as string).startsWith("contact:"))).toBe(false);
    pinned("peopleFind.full", body!);
    const quinn = await page("person", "id=person:person-q1");
    const same = (quinn.body!.edit.suggestions as Body[]).find((each) => each.kind === "same");
    expect(same?.other, "the same-person suggestion carries its other side").toEqual({ id: "person:person-q2", name: "Quinn", photo: null, named: true, face: false });
    expect([quinn.body!.edit.call, quinn.body!.edit.record_id, quinn.body!.edit.much]).toEqual(["Quinn", "person-q1", `0${NB}messages`]);
    const found = await page("peopleFind", "q=Quinn&for=person:person-q1");
    expect(found.body!.rows.map((row: Body) => row.id)).toEqual([]);
    expect((await page("peopleFind", "q=Person&for=person:person-x")).body!.rows.map((row: Body) => row.id), "never the person asked for, nor a number of theirs")
      .not.toContain("person:person-x");
    const typed = await page("peopleFind", `q=${encodeURIComponent("@person_a")}`);
    expect(typed.body!.profiles, "an @handle typed is a profile on Instagram and X").toEqual([{ network: "instagram", value: "person_a" }, { network: "x", value: "person_a" }]);
    expect(typed.body!.rows.length).toBeLessThanOrEqual(4);
    expect((await get("/v1/page/people/find?q=%20")).body).toMatchObject({ code: "BAD_PARAMETER" });
  });

  it("finds a person by a name they are also called, and carries it in the words their row is found by, here and on the People list", async () => {
    const N = "+15550000412";
    await say([record("person-n", N, { name: "Person N", also_called: ["Nicky Synthetic"] })]);
    const found = await page("peopleFind", "q=Nicky");
    const row = (found.body!.rows as Body[]).find((each) => each.id === "person:person-n");
    expect(row?.name, "found by the name they are also called").toBe("Person N");
    expect(row!.find, "the row carries the names it was found by, so a filter over its words keeps it").toEqual(expect.arrayContaining(["nicky", "synthetic"]));
    const listed = ((await page("people", "")).body!.sections as Body[]).flatMap((section) => section.rows as Body[]).find((each) => each.id === "person:person-n");
    expect(listed!.find, "the People list's row is found by the same names").toEqual(expect.arrayContaining(["nicky", "synthetic"]));
  });

  it("marks a found row face when the person is known by a face alone, never one with a number", async () => {
    await say([record("person-pn", "+15550000414", { name: "Pat Numbered" }), record("person-pf", "+15550000415", { name: "Pat Faced", anchor: null })]);
    const rows = (await page("peopleFind", "q=Pat")).body!.rows as Body[];
    expect(rows.map((row) => [row.id, row.face]), "Edit keys a face-only person Face, anyone else Same as, from this flag")
      .toEqual(expect.arrayContaining([["person:person-pn", false], ["person:person-pf", true]]));
  });

  it("answers 304 on its ETag, and moves it when a message lands", async () => {
    const k = await idOf("Person K");
    const first = await page("person", `id=${encodeURIComponent(k)}`);
    expect((await get(`/v1/page/person?id=${encodeURIComponent(k)}`, { "if-none-match": first.etag! })).status).toBe(304);
    const merged = await page("person", "id=person:person-y");
    expect(merged.etag, "the survivor's own page and the merged id's page differ by became").not.toBe((await page("person", "id=person:person-x")).etag);
    await send(WHATSAPP, [wa("k3", jid(K), at("2026-10-05T05:00:00"))]);
    await until("the new day's file written", async () => (await page("person", `id=${encodeURIComponent(k)}`)).body!.talk.day === "2026-10-05");
    const landed = await get(`/v1/page/person?id=${encodeURIComponent(k)}`, { "if-none-match": first.etag! });
    expect(landed.status, "a message moved the ETag").toBe(200);
    expect(texts(landed.body!.talk)).toEqual(["synthetic line k3"]);
  });

  it("shows a reader no more than the person's own read, and never a model or a sender", async () => {
    const k = await idOf("Person K");
    const single = (await get(`/v1/people?id=${encodeURIComponent(k)}`)).body!.person;
    const { body } = await page("person", `id=${encodeURIComponent(k)}`);
    expect(body!.head.name).toBe(single.name);
    expect(body!.handles.map((handle: Body) => handle.id)).toEqual(single.handles.map((handle: Body) => handle.id));
    expect(body!.edit.suggestions.map((each: Body) => each.id)).toEqual(single.suggestions.map((each: Body) => each.id));
    for (const path of [`/v1/page/person?id=${encodeURIComponent(k)}`, `/v1/page/group?chat=${encodeURIComponent(`whatsapp:${FRIENDS}`)}`, "/v1/page/people/find?q=Person"]) {
      expect((await get(path, {}, SENDER)).body, path).toMatchObject({ code: "PRINCIPAL_SCOPE" });
      expect((await get(path, { "lifestream-reader": "model" })).body, path).toMatchObject({ code: "PRINCIPAL_SCOPE" });
    }
  });

  it("answers counting while People has not counted the owner's word giving a person a handle, then settles", async () => {
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
    let counting: Awaited<ReturnType<typeof page>>;
    let joined: Awaited<ReturnType<typeof page>>[];
    let read: Awaited<ReturnType<typeof get>>[];
    let newest: unknown;
    try {
      counting = await page("person", "id=person:person-u");
      joined = [counting, await page("group", `chat=${encodeURIComponent(`whatsapp:${FRIENDS}`)}`), await page("peopleFind", "q=Person")];
      read = [await get("/v1/people?id=person:person-u"), await get("/v1/people"), await get("/v1/people?q=Person"), await get("/v1/people/photos?id=person:person-u")];
      newest = readHome(root, (db) => db.prepare("SELECT seq || ':' || at_ms FROM events ORDER BY seq DESC LIMIT 1").pluck().get());
    } finally {
      home = await startHome(root, { registry: REGISTRY, log: () => undefined });
    }
    expect(counting.body!.counting, "the word gave a handle, People's run not yet made").toBe(true);
    expect(joined.map((each) => each.body!.position), "a join of newer heads carries the joining view's position, never the prepared file's").toEqual([newest, newest, newest]);
    expect(read.map((each) => [each.status, each.body!.position, each.position]), "/v1/people's joined answers carry the joining view's position too, in the body and the header")
      .toEqual(read.map(() => [200, newest, newest]));
    expect(counting.body!.head.name).toBe("Person U");
    pinned("person.counting", counting.body!);
    await until("People counted the word", async () => (await page("person", "id=person:person-u")).body!.counting === false);
  });

  it("answers a person heard in two years but not lately with a bar a year, the busiest marked and opening its day, and the day before the last 30", async () => {
    const R = "+15550000411";
    await send(BOOK, [card("FN:Person R", `TEL:${R}`)]);
    await send(WHATSAPP, [
      ...Array.from({ length: 12 }, (_, n) => wa(`r24-${n}`, jid(R), at("2024-05-02T10:00:00") + n * MINUTE)),
      ...Array.from({ length: 10 }, (_, n) => wa(`r25-${n}`, jid(R), at("2025-03-14T10:00:00") + n * MINUTE)),
    ]);
    const r = await idOf("Person R");
    await until("Person R's years counted", async () => (await page("person", `id=${encodeURIComponent(r)}`)).body!.history.kind === "years");
    const { body } = await page("person", `id=${encodeURIComponent(r)}`);
    expect(body!.history).toEqual({
      kind: "years", total: 22, marked: 0,
      years: [{ year: "2024", count: 12, day: "2024-05-02" }, { year: "2025", count: 10, day: "2025-03-14" }, { year: "2026", count: 0, day: null }],
    });
    expect([body!.month.count, body!.month.before], "none in the last 30 days: the day before them is the last").toEqual([0, { day: "2025-03-14", joiner: " · last, " }]);
  });

  it("answers a person with 104 weeks of messages, its time printed for the evidence step", async () => {
    const P = "+15550000409";
    await send(BOOK, [card("FN:Person P", `TEL:${P}`)]);
    await send(WHATSAPP, Array.from({ length: 104 }, (_, week) => wa(`p${week}`, jid(P), at("2026-10-04T10:00:00") - week * WEEK)));
    const p = await idOf("Person P");
    await until("Person P's weeks counted", async () => {
      const { history } = (await page("person", `id=${encodeURIComponent(p)}`)).body!;
      return history.kind === "weeks" && history.weeks.length === 104;
    });
    const times: number[] = [];
    for (let read = 0; read < 5; read++) {
      const began = performance.now();
      await page("person", `id=${encodeURIComponent(p)}`);
      times.push(performance.now() - began);
    }
    const median = [...times].sort((left, right) => left - right)[2]!;
    const { body } = await page("person", `id=${encodeURIComponent(p)}`);
    expect(body!.history.marked, "every week holds one message: no one week is the busiest").toBeNull();
    expect([body!.month.count, body!.month.before], "some in the last 30 days: the day before them comes before that").toEqual([5, { day: "2026-08-30", joiner: " · before that, " }]);
    expect(body!.history.weeks.slice(-2), "a week's bar opens its busiest day; this week is empty").toEqual([
      { start: "2026-09-28", count: 1, day: "2026-10-04" }, { start: "2026-10-05", count: 0, day: null },
    ]);
    Object.assign(report, { weeks: 104, person_ms: times, person_median_ms: median, budget_ms: 200 });
    process.stdout.write(`page /v1/page/person with 104 weeks: median ${median.toFixed(1)} ms over 5 reads (budget 200)\n`);
  });

  it("answers the members both apps draw: the owner's own page, where a name came from, who set the kind, the other side of a same, a typed profile, the list's counts", async () => {
    const ME = "+15550000412", N = "+15550000413", BOT = "+15550000414";
    await say([record("person-me", ME, { name: "Person Me", me: true }), record("person-bot", BOT, { name: "Synthetic Bot", entity: "business" })]);
    await send(WHATSAPP, [
      group(jid(N), "Person Named There", 0), wa("n1", jid(N), at("2026-10-04T12:00:00")),
      ...Array.from({ length: SENT_TO_BE_LISTED }, (_, n) => wa(`n-mine-${n}`, jid(N), at("2026-10-04T12:05:00") + n * MINUTE, { me: true })),
    ]);

    const mine = await page("person", "id=person:person-me");
    const k = await page("person", `id=${encodeURIComponent(await idOf("Person K"))}`);
    expect([mine.body!.me, k.body!.me], "the owner's own page says so").toEqual([true, false]);

    const n = await idOf("Person Named There");
    const named = await page("person", `id=${encodeURIComponent(n)}`);
    expect(named.body!.edit.name_from, "a name WhatsApp gave: the product's name, the words both apps draw").toBe(named.body!.where[0].network);
    expect(named.body!.edit.name_from).not.toBeNull();
    expect(k.body!.edit.name_from, "a name from a contact card: no source drawn").toBeNull();

    const bot = await page("person", "id=person:person-bot");
    expect([bot.body!.head.entity, bot.body!.head.entity_by], "the owner said it").toEqual(["business", "you"]);
    expect([k.body!.head.entity, k.body!.head.entity_by], "a person: no kind to own").toEqual(["person", null]);

    const quinn = await page("person", "id=person:person-q1");
    const same = (quinn.body!.edit.suggestions as Body[]).find((each) => each.kind === "same");
    expect(same!.other, "the other side, drawn without a second read").toEqual({ id: "person:person-q2", name: "Quinn", photo: null, named: true, face: false });
    expect((quinn.body!.edit.suggestions as Body[]).filter((each) => each.kind !== "same").every((each) => each.other === null)).toBe(true);

    const typed = await page("peopleFind", "q=%40person.k");
    expect(typed.body!.profiles, "a typed handle, as each network's profile").toEqual([{ network: "instagram", value: "person.k" }, { network: "x", value: "person.k" }]);
    expect((await page("peopleFind", "q=Person")).body!.profiles).toEqual([]);

    const people = (await page("people", "")).body!;
    const listed = (await get("/v1/people")).body!.people as Body[];
    const writes = listed.filter((each) => each.sent > 0 || each.by === "contact" || each.by === "registry").length;
    expect(people.counts, "people you write to, and groups not quiet").toEqual({ people: writes, groups: people.groups.yours.length });
    expect(people.counts.groups).toBe(1);
  });
});
