import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { addDays, openHomeFolder } from "@lifestreamprotocol/core";
import { distanceMeters, takesIn } from "@lifestreamprotocol/families";
import { openLedger } from "@lifestreamprotocol/model";
import type { Access } from "@lifestreamprotocol/privacy";
import { requestIn } from "./access-ledger.js";
import type { AskWant } from "./access-words.js";
import { REQUEST_MS, type Added, type Granted } from "./agents.js";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { adopt } from "./lifecycle.js";
import { machine } from "./machine.js";
import { PAGES, type PageName } from "./pages.js";
import { peopleFileOf, readNameTable } from "./people.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { clientFixture, FAKES, makeRoot, readHome, removeRoot, REPO, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { editSettings, TEST_UNIT, testSocket } from "./test/folder.js";
import { DEVICE } from "./test/support.js";

const ZONE = "Asia/Kolkata";
const UNIT = "iphone-aa01";
const WHATSAPP = `whatsapp:15550000000:${UNIT}`;
const IMESSAGE = `imessage:+15550000090:${UNIT}`;
const BOOK = `apple-contacts:local:${UNIT}`;
const PEOPLE = `people:local:${UNIT}`;
const CALLS = `apple-calls:sam.2014@example.com:${UNIT}`;
const MAIL = "gmail:sam.2014@example.com:cloud";
const REGISTRY = join(REPO, "packages", "home", "test", "canned-registry.ts");
const PLACES_REGISTRY = join(REPO, "packages", "home", "test", "places-registry.ts");
const PLACES_UNIT = "macbook-pro-0001";
const PLACES = `places:local:${PLACES_UNIT}`;
const FIXES = "location:local:iphone-fixes-aa01";
const PHOTOS = "google-photos:person-a@example.com:export";
const FACES = `faces:local:${PLACES_UNIT}`;
const PLACES_PEOPLE = `people:local:${PLACES_UNIT}`;
const CAMERAS = `cameras:local:${PLACES_UNIT}`;
const INSTALL = "11111111-1111-4111-8111-111111111111";
const DESK = "synthetic-canned-places-desk".padEnd(43, "d");
const READER = "synthetic-canned-reader".padEnd(43, "r");
const OWNER = "synthetic-canned-owner".padEnd(43, "o");
const APPLE_EPOCH_S = 978_307_200;
const NOW = Date.parse("2026-10-05T06:00:00Z");
const DAY_MS = 86_400_000;
const MINUTE = 60_000;
const MORNING = 3 * 3_600_000;
const SPREAD_DAYS = 12;
const GROUP_SPAN = 60;
const GROUP_MOST = 300;

type Body = Record<string, any>;
type Line = { stanza: string; when: number; me: boolean };

const jid = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;
const groupJid = (n: number) => `1203630000000000${String(n).padStart(2, "0")}@g.us`;
const back = (days: number) => NOW - days * DAY_MS;

function spread(prefix: string, count: number, firstBack: number, lastBack: number, me = false): Line[] {
  const days = Math.max(1, Math.min(SPREAD_DAYS, count));
  return Array.from({ length: count }, (_, n) => {
    const slot = n % days;
    const daysBack = lastBack + Math.round(((firstBack - lastBack) * slot) / Math.max(1, days - 1));
    return { stanza: `${prefix}-${n}`, when: back(daysBack) + MORNING + Math.floor(n / days) * MINUTE, me };
  });
}

function wa(line: Line, chat: string, member: string | null = null) {
  const date = line.when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: line.stanza, ZTEXT: `synthetic line ${line.stanza}`, ZFROMJID: line.me ? null : chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: 0, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: line.me ? 1 : 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${chat}:${line.stanza}`, at: line.when,
    content: { type: "whatsapp.msg", message, session_jid: chat, parent_stanza_id: null, media_item: null, group_member_jid: line.me ? null : member, blobs: [] },
  };
}
function imessage(line: Line, handle: { kind: "phone" | "email"; canonical: string }) {
  return {
    kind: "msg", key: line.stanza, at: line.when,
    content: line.me
      ? { type: "imessage.msg", sender: null, recipients: [handle], flags: { is_from_me: 1 }, text: `synthetic imessage ${line.stanza}` }
      : { type: "imessage.msg", sender: handle, recipients: [], flags: { is_from_me: 0 }, text: `synthetic imessage ${line.stanza}` },
  };
}
const chatRow = (chat: string, title: string, archived = false) => ({ kind: "chat", key: chat, content: { type: "whatsapp.chat", group_info: null,
  chat: { ZCONTACTJID: chat, ZCONTACTIDENTIFIER: null, ZPARTNERNAME: title, ZSESSIONTYPE: 1, ZARCHIVED: archived ? 1 : 0 } } });
const pushName = (chat: string, name: string) => ({ kind: "pushname", key: chat, content: { type: "whatsapp.pushname", ZJID: chat, ZPUSHNAME: name } });
const card = (...lines: string[]) => {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.map((line) => `${line}\r\n`).join("")}END:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
};
const record = (slug: string, anchor: [string, string], more: Record<string, unknown>) => ({
  kind: "person", key: slug, content: {
    type: "people.person", slug, name: null, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: { kind: anchor[0], value: anchor[1] }, handles: [], excluded: [], dismissed: [], also_called: [], merged_into: null, ...more,
  },
});
const details = (id: string, more: Record<string, unknown>) => ({ kind: "details", key: id, content: { type: "people.details", work: null, birthday: null, profiles: [], ...more } });
const phoneCall = (id: string, when: number, seconds: number, outgoing: boolean, phone: string) => {
  const handle = { ZTYPE: 2, ZNORMALIZEDVALUE: phone, ZVALUE: phone };
  return {
    kind: "call", key: id, at: when, content: {
      type: "apple.call", initiator: outgoing ? null : handle, handles: [handle], emergency_media: [],
      call: { ZUNIQUE_ID: id, ZDATE: when / 1000 - APPLE_EPOCH_S, ZDURATION: seconds, ZORIGINATED: outgoing ? 1 : 0, ZANSWERED: 1, ZSERVICE_PROVIDER: "com.apple.Telephony", ZCALL_CATEGORY: 1, ZNAME: null },
    },
  };
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
const statements = (lines: object[]) => ({ "statements.ndjson": Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) });
const caseOf = (words: string) => words.toLowerCase().replace(/^person:/u, "").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

const A = "+15550000001", B = "+15550000002", D = "+15550000004", E = "+15550000005", N6 = "+15550000006", N7 = "+15550000007", F = "+15550000008", G = "+15550000009";
const H = "+15550000010", J = "+15550000011";
const C_PHOTO = readFileSync(join(REPO, "homelink", "Tests", "Fixtures", "pages", "canned", "photo.person-c.png"));
const C_FACE = `sha256:${createHash("sha256").update(C_PHOTO).digest("hex")}`;
const C_MAIL = "person-c@example.com", F_MAIL = "person-f@example.com", A_HOME = "person-a.home@example.com";
const ALPHA = groupJid(1), BETA = groupJid(2), DELTA = groupJid(11), SHOP = groupJid(12), KAPPA = groupJid(13);
const MORE = ["Gamma", "Epsilon", "Zeta", "Eta", "Theta", "Iota"].map((name, index) => ({
  title: `Group ${name}`, chat: groupJid(index + 3), theirs: 90 - index * 10, mine: 60 - index * 5, lastBack: 2 + index * 3,
}));
const QUIET = [
  { title: "Group Delta", chat: DELTA, theirs: 310, mine: 12, lastBack: 0, mineBack: 100, archived: false },
  { title: "Synthetic Shop Deals", chat: SHOP, theirs: 1_418, mine: 0, lastBack: 0, mineBack: 0, archived: true },
  { title: "Group Kappa", chat: KAPPA, theirs: 75, mine: 40, lastBack: 6, mineBack: 6, archived: false },
];
const FORMER = [
  { name: "D", phone: D, received: 412, sent: 380, firstBack: 700, lastBack: 23, beta: true },
  { name: "6", phone: N6, received: 9, sent: 4, firstBack: 40, lastBack: 26, beta: false },
  { name: "7", phone: N7, received: 20, sent: 1, firstBack: 210, lastBack: 200, beta: false },
  { name: "F", phone: F, received: 140, sent: 122, firstBack: 900, lastBack: 410, beta: true },
  { name: "H", phone: H, received: 1_800, sent: 1_500, firstBack: 2_000, lastBack: 4, beta: false },
  { name: "J", phone: J, received: 5, sent: 3, firstBack: 40, lastBack: 30, beta: false },
];
const A_CALLS = [
  phoneCall("CALL-A-0001", back(2) + MORNING, 185, true, A), phoneCall("CALL-A-0002", back(9) + MORNING, 42, false, A), phoneCall("CALL-A-0003", back(20) + MORNING, 600, true, A),
];
const birthdayIn = (days: number) => {
  const day = new Date(NOW + days * DAY_MS).toISOString().slice(0, 10);
  return { month: Number(day.slice(5, 7)), day: Number(day.slice(8, 10)), year: null };
};
const A_FULL = "Person A Fullname";
const A_SIGNED = [A_FULL, "person a fullname", "PERSON A FULLNAME", "Person A FULLNAME"];
const A_MAILS = A_SIGNED.map((name, index) => mail(`mail-a-${index + 1}`, back(4 + index) + MORNING, `${name} <${A_HOME}>`, "Sam Example <sam.2014@example.com>"));
const A_DETAILS = {
  work: "Community lead, Northern Harbour Synthetic Supporters' Club (Coast District)", birthday: birthdayIn(3),
  profiles: [{ network: "instagram", value: "person.a" }, { network: "site", value: "example.com/person-a" }],
};

const lines = (label: string, chat: string, member: string | null, count: number, firstBack: number, lastBack: number) =>
  spread(label, Math.min(count, GROUP_MOST), firstBack, lastBack, member === null).map((line) => wa(line, chat, member));

function directRows(): object[] {
  const one = (label: string, phone: string, received: number, sent: number, firstBack: number, lastBack: number) => [
    ...spread(`${label}-in`, received, firstBack, lastBack).map((line) => wa(line, jid(phone))),
    ...spread(`${label}-out`, sent, firstBack, lastBack, true).map((line) => wa(line, jid(phone))),
  ];
  return [
    pushName(jid(G), "Stranger G"), pushName(jid(A), A_FULL),
    ...one("a", A, 120, 80, 280, 1), ...one("b", B, 40, 30, 200, 3),
    ...FORMER.flatMap((each) => one(`former-${each.name}`, each.phone, each.received - (each.beta ? Math.floor(each.received / 4) : 0), each.sent, each.firstBack, each.lastBack)),
  ];
}

function groupRows(): object[] {
  return [
    chatRow(ALPHA, "Group Alpha"), chatRow(BETA, "Group Beta"),
    ...lines("alpha-a", ALPHA, jid(A), 30, 60, 0), ...lines("alpha-b", ALPHA, jid(B), 25, 60, 1), ...lines("alpha-me", ALPHA, null, 20, 60, 0),
    ...FORMER.filter((each) => each.beta).flatMap((each) => lines(`beta-${each.name}`, BETA, jid(each.phone), Math.floor(each.received / 4), each.firstBack, each.lastBack)),
    ...lines("beta-g", BETA, jid(G), 17, 120, 24), ...lines("beta-me", BETA, null, 214, 700, 23),
  ];
}

function moreGroupRows(): object[] {
  return [
    ...MORE.map((group) => chatRow(group.chat, group.title)), ...QUIET.map((group) => chatRow(group.chat, group.title, group.archived)),
    ...MORE.flatMap((group) => [
      ...lines(`${group.chat}-a`, group.chat, jid(A), group.theirs, group.lastBack + GROUP_SPAN, group.lastBack),
      ...lines(`${group.chat}-me`, group.chat, null, group.mine, group.lastBack + GROUP_SPAN, group.lastBack),
    ]),
    ...QUIET.flatMap((group) => [
      ...lines(`${group.chat}-a`, group.chat, jid(A), group.theirs, group.lastBack + GROUP_SPAN, group.lastBack),
      ...(group.chat === DELTA ? lines(`${group.chat}-b`, group.chat, jid(B), group.theirs, group.lastBack + GROUP_SPAN, group.lastBack) : []),
      ...lines(`${group.chat}-me`, group.chat, null, group.mine, group.mineBack + GROUP_SPAN, group.mineBack),
    ]),
  ];
}

function imessageRows(): object[] {
  const one = (label: string, handle: { kind: "phone" | "email"; canonical: string }, received: number, sent: number, firstBack: number, lastBack: number) => [
    ...spread(`${label}-in`, received, firstBack, lastBack).map((line) => imessage(line, handle)),
    ...spread(`${label}-out`, sent, firstBack, lastBack, true).map((line) => imessage(line, handle)),
  ];
  return [
    ...one("c", { kind: "email", canonical: C_MAIL }, 25, 20, 120, 9),
    ...one("e", { kind: "phone", canonical: E }, 88, 61, 300, 52),
    ...one("f-mail", { kind: "email", canonical: F_MAIL }, 30, 25, 800, 430),
  ];
}

function pin(written: string[], name: PageName, kase: string, body: Body) {
  mkdirSync(join(REPO, "homelink", "Tests", "Fixtures", "pages", "canned"), { recursive: true });
  const fixture = clientFixture(`pages/canned/${name}.${kase}`, body);
  written.push(`${name}.${kase}`);
  expect(fixture.held, `homelink/Tests/Fixtures/pages/canned/${name}.${kase}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
}

describe("The canned home's page answers, which the phone's canned home serves", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  let shipped = 0;
  const written: string[] = [];

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const send = async (source: string, rows: object[], carried: Record<string, Buffer> = {}) => {
    const made = source !== BOOK && readHome(root, (db) => db.prepare("SELECT count(*) FROM sources WHERE id = ?").pluck().get(source)) === 0;
    const id = await ship(root, { source, fetched_ms: NOW + shipped * MINUTE, rows: rows as never, carried, ...(made ? { facts: { sources: [{ id: source, connector: "people-rows" }] } } : {}) });
    shipped++;
    await until(`${id} imported and its work done`, () => imported(id) && ran());
  };
  const say = async (lines: object[]) => {
    const id = await shipFiles(root, PEOPLE, NOW + shipped * MINUTE, statements(lines));
    shipped++;
    await until(`${id} imported and its work done`, () => imported(id) && ran());
  };
  const call = async (path: string, init: RequestInit = {}, token = READER) => {
    const response = await fetch(`${url}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) } });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) as Body };
  };
  const page = async (name: PageName, query: Record<string, string> = {}) => {
    const path = `${PAGES[name].route}?${new URLSearchParams(query)}`;
    const answer = await call(path);
    expect(answer.status, path).toBe(200);
    PAGES[name].shape.parse(answer.body);
    return answer.body!;
  };
  const act = async (action: Body) => {
    const answer = await call("/v1/owner/act", { method: "POST", body: JSON.stringify({ of: "people", request: randomUUID(), ...action }) }, OWNER);
    expect(answer, `${action.kind}`).toMatchObject({ status: 200, body: { position: expect.stringMatching(/^\d+:\d+$/u) } });
    return answer.body as { act: string; position: string };
  };
  const pinned = (name: PageName, kase: string, body: Body) => pin(written, name, kase, body);
  const listed = (people: Body) => [...(people.you === null ? [] : [people.you]), ...people.sections.flatMap((section: Body) => section.rows), ...people.ai] as Body[];

  beforeAll(async () => {
    root = makeRoot("lifestream-page-canned-", { sources: { [BOOK]: "people-rows", [PEOPLE]: "people-home" }, settings: { unit: UNIT, "day.zone": ZONE } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    mintPrincipal(openHomeFolder(root), { unit: `dashboard-${UNIT}`, scopes: ["read", "deliver"], sources: [PEOPLE], token: OWNER, now_ms: 0 });
    home = await startHome(root, { registry: REGISTRY, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY, clock: () => NOW });
    url = `http://127.0.0.1:${door.port}`;

    await send(BOOK, [
      card("FN:Sam Example", "TEL:+15550000091", "EMAIL:sam@work.example.com", "EMAIL:s.example@example.net"),
      card("FN:Person A", `TEL:${A}`, `EMAIL:${A_HOME}`), card("FN:Person B", `TEL:${B}`), card("FN:Person C", `EMAIL:${C_MAIL}`, `PHOTO:data:image/png;base64,${C_PHOTO.toString("base64")}`),
      card("FN:Person E", `TEL:${E}`), card("FN:Person F", `TEL:${F}`), card("FN:Person F", `EMAIL:${F_MAIL}`),
    ]);
    await say([
      record("sam-example", ["phone", "+15550000091"], {
        name: "Sam", full_name: "Sam Example", me: true, also_called: ["Sammy"],
        handles: [
          { kind: "phone", value: "+15550000000" }, { kind: "phone", value: "+15550000090" }, { kind: "phone", value: "+15550000092" }, { kind: "email", value: "sam.2014@example.com" },
        ],
      }),
      record("person-a", ["phone", A], { name: "Person A", relationship: "Friend from college" }),
      record("person-b", ["phone", B], { name: "Person B" }),
      record("person-c", ["email", C_MAIL], { name: "Person C" }),
      record("person-d", ["phone", D], { name: "Person D" }),
      record("person-h", ["phone", H], { name: "Person H" }),
      record("person-j", ["phone", J], { name: "Person J" }),
      details("person:person-a", A_DETAILS),
      details("person:person-b", { birthday: birthdayIn(40) }),
    ]);
    await send(WHATSAPP, directRows());
    await send(WHATSAPP, groupRows());
    await send(WHATSAPP, moreGroupRows());
    await send(IMESSAGE, imessageRows());
    await send(CALLS, A_CALLS);
    await send(MAIL, A_MAILS.map((each) => each.row), Object.fromEntries(A_MAILS.map((each) => each.carried)));
    await act({ kind: "group", chat: `whatsapp:${KAPPA}`, quiet: true });
    await until("People counted the owner's word on Group Kappa", async () => (await page("people")).counting === false);
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("answers the list with the canned cast under the ids the UI journeys tap", async () => {
    const people = await page("people");
    const ids = listed(people).map((row) => row.id as string);
    expect(people.you?.id).toBe("person:sam-example");
    expect(people.you?.name).toBe("Sam");
    expect(ids).toEqual(expect.arrayContaining([
      "person:person-a", "person:person-b", "person:person-c", "person:person-d", "person:person-h", "person:person-j",
      `phone:${E}`, `phone:${F}`, `email:${F_MAIL}`, `phone:${N6}`,
    ]));
    expect(listed(people).find((row) => row.id === `phone:${N6}`)?.named, "a person you write to with no name").toBe(false);
    expect(listed(people).find((row) => row.id === "person:person-c")?.photo, "Person C's card photo, which the canned home serves by its hash").toBe(C_FACE);
    expect(people.groups.yours.map((chat: Body) => chat.chat)).toEqual(expect.arrayContaining([`whatsapp:${ALPHA}`, `whatsapp:${BETA}`, ...MORE.map((group) => `whatsapp:${group.chat}`)]));
    expect(people.groups.quiet.map((chat: Body) => chat.chat)).toEqual(expect.arrayContaining([`whatsapp:${SHOP}`, `whatsapp:${KAPPA}`]));
    pinned("people", "list", people);
  });

  it("answers every listed person's page, Person A's with weeks, their talk, where they talk and their calls", async () => {
    const people = await page("people");
    for (const row of listed(people)) {
      const body = await page("person", { id: row.id });
      if (row.id === "person:person-a") {
        expect([body.head.name, body.head.relationship, body.history.kind, body.talk?.chat]).toEqual(["Person A", "Friend from college", "weeks", `whatsapp:${jid(A)}`]);
        expect(body.where.map((each: Body) => each.chat)).toEqual(expect.arrayContaining([`whatsapp:${MORE[0]!.chat}`, `whatsapp:${DELTA}`]));
        expect(body.edit.details).toMatchObject({ work: A_DETAILS.work, birthday: A_DETAILS.birthday, profiles: A_DETAILS.profiles });
        expect(body.month.calls?.count, "their calls of 30 days, which the phone's Calls row draws").toBe(A_CALLS.length);
        expect(body.edit.suggestions, "the full name WhatsApp and their mail say, which Edit's Full name field ends with").toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "full_name", value: A_FULL, reasons: expect.arrayContaining([{ reason: "whatsapp", count: 1 }, { reason: "mail", count: A_SIGNED.length }]), ticked: true }),
        ]));
      }
      if (row.id === "person:sam-example") expect(body.me, "your page").toBe(true);
      if (row.id === "person:person-c") expect(body.head.photo, "their card photo heads their page").toBe(C_FACE);
      pinned("person", caseOf(row.id as string), body);
    }
  });

  it("answers every group's page", async () => {
    const people = await page("people");
    for (const chat of [...people.groups.yours, ...people.groups.quiet] as Body[]) {
      const body = await page("group", { chat: chat.chat });
      if (chat.chat === `whatsapp:${KAPPA}`) expect([body.head.word, body.head.quiet, body.head.why?.words]).toEqual(["always", true, "You set it"]);
      if (chat.chat === `whatsapp:${SHOP}`) expect([body.head.quiet, body.head.why?.words]).toEqual([true, expect.stringMatching(/^You archived it in /u)]);
      pinned("group", caseOf(chat.chat as string), body);
    }
  });

  it("answers the find page for the words the UI journeys type", async () => {
    const typed = await page("peopleFind", { q: "@person.a.photos", for: "person:person-a" });
    expect(typed.profiles).toEqual([{ network: "instagram", value: "person.a.photos" }, { network: "x", value: "person.a.photos" }]);
    pinned("peopleFind", "person-a-photos", typed);
    const stranger = await page("peopleFind", { q: "Stranger" });
    expect(stranger.rows.map((row: Body) => row.id)).toEqual([`phone:${G}`]);
    pinned("peopleFind", "stranger", stranger);
    const none = await page("peopleFind", { q: "zzz" });
    expect([none.rows, none.profiles]).toEqual([[], []]);
    pinned("peopleFind", "zzz", none);
  });

  it("answers the places list of a home with no place yet, as the canned empty home serves it", async () => {
    const places = await page("places");
    expect([places.cities, places.to_name, places.hidden, places.counting], "nothing to list, nothing still counting").toEqual([[], [], [], false]);
    pinned("places", "nothing", places);
  });

  it("answers after each save the UI journeys make: Group Delta always quiet, Person A's edit, then its undo", async () => {
    await act({ kind: "group", chat: `whatsapp:${DELTA}`, quiet: true });
    const delta = await page("group", { chat: `whatsapp:${DELTA}`, settled: "1" });
    expect([delta.head.word, delta.head.quiet, delta.head.why?.words, delta.counting]).toEqual(["always", true, "You set it", false]);
    pinned("group", `${caseOf(`whatsapp:${DELTA}`)}-always`, delta);

    const saved = await act({
      kind: "confirm", id: "person:person-a", name: "Ace", relationship: "Friend from school", unlink: [`email:${A_HOME}`],
      details: { birthday: birthdayIn(0), profiles: [...A_DETAILS.profiles, { network: "instagram", value: "person.a.photos" }] },
    });
    const ace = await page("person", { id: "person:person-a", settled: "1" });
    expect([ace.head.name, ace.head.relationship, ace.counting]).toEqual(["Ace", "Friend from school", false]);
    expect(ace.handles.map((handle: Body) => handle.id)).not.toContain(`email:${A_HOME}`);
    expect(ace.head.chips).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "profile", network: "instagram", words: "@person.a.photos" })]));
    pinned("person", "person-a-saved", ace);

    await act({ kind: "undo", act: saved.act });
    const undone = await page("person", { id: "person:person-a", settled: "1" });
    expect([undone.head.name, undone.head.relationship, undone.counting]).toEqual(["Person A", "Friend from college", false]);
    pinned("person", "person-a-undone", undone);
    process.stdout.write(`canned page answers written: ${written.length} (${written.join(", ")})\n`);
  });
});

const AGENTS_NOW = Date.UTC(2026, 10, 7, 17, 0);
const AGENTS_MAC = "macbook-pro-0001";
const AGENT_CHAT = "whatsapp:15550000001";
const AGENT_SOURCES = { [`${AGENT_CHAT}:${AGENTS_MAC}`]: "whatsapp-db", "gmail:person-a@example.com:cloud": "gmail" };
const SIGN_INS = [
  { name: "Claude", checked: true, host: "claude.ai", choices: [27, 64, 81] },
  { name: "Hermes", checked: false, host: "hermes.example.com", choices: [90, 12, 45] },
  { name: "Atlas", checked: false, host: null, choices: [16, 49, 73] },
] as const;

function cannedWaiting(body: Body, ids: Map<string, string>): Body {
  const choices = new Map<string, readonly number[]>(SIGN_INS.map((each) => [each.name, each.choices]));
  const pinnedBody = { ...body, position: "1:0", requests: body.requests.map((each: Body) => ({ ...each, choices: [...choices.get(each.name)!] })) };
  let text = JSON.stringify(pinnedBody);
  for (const [id, as] of ids) text = text.split(id).join(as);
  const seen = new Map<string, string>();
  text = text.replace(/\brq-[0-9a-f]{16}\b|\bp-[0-9a-f]{8}\b/gu, (id) => {
    if (!seen.has(id)) {
      const kind = id.startsWith("rq-") ? "rq-" : "p-";
      const count = [...seen.keys()].filter((each) => each.startsWith(kind)).length + 1;
      seen.set(id, kind === "rq-" ? `rq-${count.toString(16).padStart(16, "0")}` : `p-${count.toString(16).padStart(8, "0")}`);
    }
    return seen.get(id)!;
  });
  return JSON.parse(text) as Body;
}

describe("The canned home's waiting answers, which the phone's canned home serves", () => {
  it("answers the sign-in journey's waiting list at each step, then the four asks: Chat's for Instinct, Claude's, Hermes's and ChatGPT's", async () => {
    let now = AGENTS_NOW;
    const clock = () => now;
    const written: string[] = [];
    const root = makeRoot("lifestream-page-canned-agents-", { sources: AGENT_SOURCES, settings: { "families.messages": {}, "families.mail": {} } });
    const dir = mkdtempSync(join(tmpdir(), "lifestream-canned-agents-machine-"));
    writeFileSync(join(dir, "machine.json"), JSON.stringify({ dnssd: join(dir, "no-dns-sd"), bonjour: "127.0.0.1", unit: TEST_UNIT, tailscale: join(dir, "no-tailscale") }));
    const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir } });
    await adopt(root, { machine: at, now: clock });
    const pass = () => randomBytes(32).toString("base64url");
    const passes = { reader: pass(), phone: pass() };
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: passes.reader, now_ms: 0 });
    mintPrincipal(openHomeFolder(root), { unit: "iphone-17-pro-aa01", kind: "phone", scopes: ["deliver", "read"], sources: ["location:local:iphone-17-pro-aa01"], token: passes.phone, now_ms: 0 });
    const door = await serveDoor(root, { port: 0, lan_port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, clock, registry: FAKES, machine: at });
    editSettings(root, { "door.port": door.port });
    const home = await startHome(root, { registry: FAKES, clock, machine: at, log: () => undefined, tickMs: TICK_MS });
    const people = peopleFileOf(root, at.dir);
    await until("People's first file", () => readNameTable(openHomeFolder(dirname(people)), people) !== undefined);
    const ledger = openLedger(openHomeFolder(root), { mode: "write" });
    onTestFinished(async () => {
      ledger.close();
      await door.close();
      await home.stop();
      removeRoot(root);
      rmSync(dir, { recursive: true, force: true });
    });
    await until("the start moved Chat's access", () => ledger.access.moved() !== null);
    const url = `http://127.0.0.1:${door.port}`;
    const sock = testSocket(root, at.dir);
    const server = readFileSync(join(dir, "mcp", "door-token"), "utf8").trim();
    const call = async (method: string, path: string, bearer: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`${url}${path}`, {
        method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      });
      const text = await response.text();
      return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Body };
    };
    const phone = (method: string, path: string, body?: unknown) => call(method, path, passes.phone, body, DEVICE.phone);
    const ids = new Map<string, string>();
    const waiting = async (kase: string) => {
      const answer = await phone("GET", PAGES.agentsWaiting.route);
      expect(answer.status, kase).toBe(200);
      PAGES.agentsWaiting.shape.parse(answer.body);
      pin(written, "agentsWaiting", kase, cannedWaiting(answer.body, ids));
      return answer.body;
    };
    const badge = async () => {
      const answer = await phone("GET", PAGES.connectors.route);
      expect(answer.status, "the phone's Streams").toBe(200);
      return answer.body.badge.asks as number;
    };

    const signIns: { id: string; number: number }[] = [];
    for (const each of SIGN_INS) {
      const made = await call("POST", "/v1/agents/request", server, { name: each.name, checked: each.checked, host: each.host });
      expect(made.status, each.name).toBe(200);
      const signIn = made.body as { id: string; number: number };
      ids.set(signIn.id, `agent-${each.name.toLowerCase()}`);
      signIns.push(signIn);
      now += 1_000;
    }
    const [claudeIn, hermesIn] = signIns as [{ id: string; number: number }, { id: string; number: number }];
    const opening = await waiting("claude-hermes-atlas");
    expect(opening.requests.map((each: Body) => [each.name, each.host]), "the three sign-ins, oldest first, as the home lists them")
      .toEqual(SIGN_INS.map((each) => [each.name, each.host]));
    expect(opening.asks).toEqual([]);

    const approved = await phone("POST", "/v1/agents/answer", { id: claudeIn.id, answer: claudeIn.number });
    expect(approved.body.state).toBe("approved");
    expect((await waiting("hermes-atlas")).requests.map((each: Body) => each.name)).toEqual(["Hermes", "Atlas"]);
    const denied = await phone("POST", "/v1/agents/answer", { id: hermesIn.id, answer: "deny" });
    expect(denied.body.state).toBe("denied");
    expect((await waiting("atlas")).requests.map((each: Body) => each.name)).toEqual(["Atlas"]);
    const granted = await call("POST", "/v1/agents/grant", server, { id: claudeIn.id, client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata", resource: "https://macbook-pro-0001.tail0000.ts.net/mcp" });
    expect(granted.status, "Claude's grant, while the home still holds its answered sign-in").toBe(200);
    const claude = (granted.body as unknown as Granted).grant;
    now += REQUEST_MS;
    const none = await waiting("none");
    expect([none.requests, none.asks], "Atlas's sign-in over by the home's clock: nothing waits").toEqual([[], []]);
    expect(await badge(), "no ask waits: the badge counts none").toBe(0);

    const add = async (name: string) => (await askHome(sock, "agents", ["add", name]) as Added).agent.id;
    const instinct = await add("Instinct");
    const hermes = await add("Hermes");
    const gpt = mintPrincipal(openHomeFolder(root), {
      unit: "agent", kind: "agent", scopes: ["read"], now_ms: now, granted: { agent: { name: "ChatGPT", via: "pass", from: null, checked: false, client_id: null, resource: null } },
    }).principal.id;
    const held = ledger.access.get(instinct)!;
    const lines = held.lines as unknown as Access;
    const health: Access = { ...lines, allow: [...lines.allow, { reach: { type: "health", but: [] }, window: null, until_ms: null }] };
    const proposed = await call("POST", `/v1/agents/${instinct}/propose`, passes.reader, { access: health, expect: held.version }, { "lifestream-chat": "chat-1" });
    expect(proposed.body.kind, "Chat's ask to widen Instinct").toBe("asked");
    const ask = (reader: string, want: AskWant, for_ms: number, reason: string) => {
      now += 1_000;
      const made = requestIn(ledger, { reader, want, reason, for_ms, now_ms: now });
      if (!("request" in made)) throw new Error(`the request was held: ${JSON.stringify(made)}`);
    };
    ask(claude, { read: { product: "whatsapp" }, window: null }, 3_600_000, "Sam moved Saturday's dinner in a WhatsApp chat.");
    ask(hermes, { read: { category: "plans" }, window: { since_ms: now - 30 * 86_400_000 } }, 3 * 3_600_000, "Your plans this month.");
    ask(gpt, { read: { category: "money" }, window: null }, 3_600_000, "Who paid for the dinner?");
    const asked = await waiting("ask-instinct-ask-claude-ask-hermes-ask-chatgpt");
    expect(asked.requests).toEqual([]);
    expect(asked.asks.map((each: Body) => [each.name, each.by, each.editable]), "each open ask, oldest first")
      .toEqual([["Instinct", "chat", true], ["Claude", "agent", true], ["Hermes", "agent", true], ["ChatGPT", "agent", true]]);
    expect(await badge(), "the four open asks: the badge counts them, as the canned home does").toBe(4);
    process.stdout.write(`canned waiting answers written: ${written.length} (${written.join(", ")})\n`);
  });
});

type Point = { latitude: number; longitude: number };
type Stay = [from: number, to: number, point: Point, step: number];
type CannedPlace = { slug: string; name: string; centre: Point; radius_m: number; also?: { centre: Point; radius_m: number }[] };

const LEGS = 30;
const CLEAR_M = 200;
const HOME_PLACE = { latitude: 37.3349, longitude: -122.009 };
const OFFICE = { latitude: 37.322, longitude: -122.001 };
const OLD_OFFICE = { latitude: 37.3275, longitude: -121.9905 };
const BAKERY = { latitude: 37.3301, longitude: -122.0142 };
const INN = { latitude: 36.6031, longitude: -121.8991 };
const WILLOW = { latitude: 37.342, longitude: -122.017 };
const GYM = { latitude: 37.3187, longitude: -122.009 };
const AWAY = { latitude: 36.6002, longitude: -121.8947 };
const PHOTO = { latitude: 37.3412, longitude: -122.0215 };
const PIN = { latitude: 37.3426, longitude: -122.0153 };
const NEAR_HOME = { latitude: 37.3365, longitude: -122.011 };
const SOUTH = { latitude: 37.315, longitude: -122.03 };
const NAMED_GYM = { slug: "synthetic-gym-0c0c0c", name: "Synthetic Gym", centre: GYM, radius_m: 80 };
const CANNED_PLACES: CannedPlace[] = [
  { slug: "home-place", name: "Home", centre: HOME_PLACE, radius_m: 120 },
  { slug: "the-office", name: "The Office", centre: OFFICE, radius_m: 90 },
  { slug: "old-office", name: "Old Office", centre: OLD_OFFICE, radius_m: 80 },
  { slug: "corner-bakery", name: "Corner Bakery", centre: BAKERY, radius_m: 80 },
  { slug: "harbour-inn", name: "Harbour Inn", centre: INN, radius_m: 80 },
  { slug: "willow-court", name: "Willow Court", centre: WILLOW, radius_m: 55, also: [
    { centre: { latitude: 37.342, longitude: -122.01626 }, radius_m: 30 }, { centre: { latitude: 37.34097, longitude: -122.017 }, radius_m: 80 },
  ] },
];
const TO_NAME = [GYM, AWAY, PHOTO];
const OFFICE_DAYS = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30"];
const FACE_BOX = [10, 10, 50, 50];
const SCENES = ["cafe", "plate", "dusk", "park", "window", "sea", "coffee"];
const spotKey = (point: Point) => `spot:${point.latitude},${point.longitude}`;
const SCALED_PLACES = 38;
function word(index: number): string {
  const consonants = "bdfgklmnprstvz", vowels = "aeiou";
  let n = index, letters = "";
  do {
    letters += consonants[n % consonants.length];
    n = Math.floor(n / consonants.length);
    letters += vowels[n % vowels.length];
    n = Math.floor(n / vowels.length);
  } while (n > 0);
  return letters[0]!.toUpperCase() + letters.slice(1);
}
const hide = (key: string, centre: Point) => ({ kind: "hidden", key, content: { type: "places.hidden", centre, radius_m: 80 } });
const at = (day: string, clock: string) => Date.parse(`${day}T${clock}Z`);
const placed = (times: readonly number[], from: number) => [...times].sort((left, right) => right - left).map((at_ms, index) => {
  const bytes = Buffer.from(`synthetic canned photo ${SCENES[index % SCENES.length]} ${from + index}`);
  return { at_ms, bytes, hex: createHash("sha256").update(bytes).digest("hex") };
});
const GYM_SHOTS = placed(["2026-09-24", "2026-09-26", "2026-09-27", "2026-09-29", "2026-10-01"].flatMap((day) => [at(day, "19:00:00"), at(day, "20:00:00")]).slice(0, 9), 0);
const SPOT_SHOTS = placed([at("2026-09-25", "15:30:00")], 9);
const BAKERY_SHOTS = placed([at("2026-09-16", "08:20:00")], 10);
const OFFICE_SHOTS = placed(OFFICE_DAYS.map((day) => at(day, "10:30:00")), 11);
const SHOTS = [...GYM_SHOTS, ...SPOT_SHOTS, ...BAKERY_SHOTS, ...OFFICE_SHOTS];
const image = (shot: { hex: string }) => `sha256:${shot.hex}`;

let sequence = 0;
function fix(when: number, point: Point, speed: number) {
  const iso = new Date(when).toISOString();
  const n = ++sequence;
  return { kind: "fix", key: `${INSTALL}:${n}`, at: when + 1_500, content: { type: "location.fix", content: {
    schema_version: 1, domain: "location", kind: "fix", sequence: n,
    payload: { location: { timestamp_rfc3339_utc: iso, timestamp_unix_seconds: when / 1000, ...point, horizontal_accuracy: 5, vertical_accuracy: 3, altitude: 12, speed, course: 90 },
      capture_context: { engine: "app_owned", authorization: "always" } },
    captured: { wall_rfc3339: iso, wall_unix_seconds: when / 1000, elapsed_seconds: n * 7.5 }, process_instance_id: INSTALL,
  } } };
}

function track(stays: readonly Stay[]) {
  const rows: ReturnType<typeof fix>[] = [];
  stays.forEach(([from, to, point, step], index) => {
    for (let t = from; t < to; t += step) rows.push(fix(t, point, 0));
    const next = stays[index + 1];
    if (next === undefined) return;
    const apart = distanceMeters(point, next[2]);
    for (let leg = 1; leg < LEGS; leg++) {
      const share = leg / LEGS;
      if (apart * Math.min(share, 1 - share) < CLEAR_M) continue;
      rows.push(fix(to + leg * 20_000, { latitude: point.latitude + (next[2].latitude - point.latitude) * share, longitude: point.longitude + (next[2].longitude - point.longitude) * share }, 9));
    }
  });
  return rows;
}

function cannedDays(): Stay[] {
  const two = 2 * MINUTE;
  const away: Stay[] = [
    ...["2026-09-15", "2026-09-17"].map((day): Stay => [at(day, "10:00:00"), at(day, "12:00:00"), OLD_OFFICE, two]),
    [at("2026-09-16", "08:00:00"), at("2026-09-16", "08:40:00"), BAKERY, two],
    ...OFFICE_DAYS.map((day): Stay => [at(day, "09:00:00"), at(day, "12:00:00"), OFFICE, two]),
    ...["2026-09-17", "2026-09-19", "2026-09-22", "2026-09-24", "2026-09-26", "2026-09-27", "2026-09-29", "2026-10-01"]
      .map((day): Stay => [at(day, "18:00:00"), at(day, "21:30:00"), GYM, two]),
    ...["2026-09-23", "2026-09-30"].map((day): Stay => [at(day, "13:00:00"), at(day, "13:20:00"), PIN, two]),
    [at("2026-09-25", "15:00:00"), at("2026-09-25", "16:10:00"), PHOTO, two],
    ...["2026-09-20", "2026-09-27"].map((day): Stay => [at(day, "14:00:00"), at(day, "16:00:00"), WILLOW, two]),
    ...["2026-10-02", "2026-10-03", "2026-10-04"].map((day): Stay => [at(day, "01:00:00"), at(day, "05:00:00"), AWAY, 10 * MINUTE]),
    [at("2026-10-02", "12:00:00"), at("2026-10-02", "14:30:00"), INN, two],
  ];
  away.sort((left, right) => left[0] - right[0]);
  const stays: Stay[] = [];
  let cursor = at("2026-09-14", "20:00:00");
  for (const stay of away) {
    stays.push([cursor, stay[0] - 15 * MINUTE, HOME_PLACE, 10 * MINUTE], stay);
    cursor = stay[1] + 15 * MINUTE;
  }
  stays.push([cursor, at("2026-10-04", "20:00:00"), HOME_PLACE, 10 * MINUTE]);
  return stays;
}

describe("The canned home's places pages, which the phone's canned home serves", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  const written: string[] = [];

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const get = async (path: string) => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${DESK}` } });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) as Body };
  };
  const page = async (name: PageName, query: Record<string, string> = {}) => {
    const path = `${PAGES[name].route}?${new URLSearchParams(query)}`;
    const answer = await get(path);
    expect(answer.status, path).toBe(200);
    PAGES[name].shape.parse(answer.body);
    return answer.body!;
  };
  const pinned = (kase: string, body: Body, name: PageName = "placeEdit") => {
    mkdirSync(join(REPO, "homelink", "Tests", "Fixtures", "pages", "canned"), { recursive: true });
    const fixture = clientFixture(`pages/canned/${name}.${kase}`, body);
    written.push(`${name}.${kase}`);
    expect(fixture.held, `homelink/Tests/Fixtures/pages/canned/${name}.${kase}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
  };
  let stated = 0;
  const state = async (lines: object[]) => {
    stated++;
    const said = await shipFiles(root, PLACES, NOW - DAY_MS + stated * MINUTE, statements(lines));
    await until(`${said} imported and the places written after it`, () => imported(said) && ran());
    await until("the places counted", async () => (await page("places")).counting === false);
  };
  const keys = (rows: Body[]) => rows.map((row) => row.key as string);
  const dragged = (edit: Body) => edit.held + takesIn({ slug: edit.slug, ...edit.circle }, edit.others, edit.points);

  beforeAll(async () => {
    root = makeRoot("lifestream-page-canned-places-", {
      sources: { [FIXES]: "fake-rows", [PLACES]: "places-home", [PHOTOS]: "fake-rows", [FACES]: "faces-rows", [PLACES_PEOPLE]: "people-home", [CAMERAS]: "cameras-rows" },
      settings: { unit: PLACES_UNIT, "day.zone": "UTC" },
    });
    mintPrincipal(openHomeFolder(root), { unit: `dashboard-${PLACES_UNIT}`, scopes: ["read", "deliver"], sources: [PLACES], token: DESK, now_ms: 0 });
    home = await startHome(root, { registry: PLACES_REGISTRY, clock: () => NOW, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: PLACES_REGISTRY, clock: () => NOW });
    url = `http://127.0.0.1:${door.port}`;

    const places = [
      ...CANNED_PLACES.map(({ slug, name, centre, radius_m, also }) =>
        ({ kind: "place", key: slug, content: { type: "places.place", name, centre, radius_m, ids: [], ...(also === undefined ? {} : { also }) } })),
      hide("hidden-c0ffee", NEAR_HOME), hide("hidden-0a0b0c", SOUTH),
    ];
    const said = await shipFiles(root, PLACES, NOW - DAY_MS, statements(places));
    await until(`${said} imported and the places written after it`, () => imported(said) && ran());
    const known = await shipFiles(root, PLACES_PEOPLE, NOW - DAY_MS, statements([record("person-a", ["phone", A], { name: "Person A" })]));
    await until(`${known} imported`, () => imported(known) && ran());
    const cameras = await ship(root, { source: CAMERAS, fetched_ms: NOW, rows: SHOTS.map(({ hex }) => ({ kind: "photo", key: hex, content: { type: "cameras.photo", camera: "synthetic/synthetic-model" } })) as never });
    await until(`${cameras} imported`, () => imported(cameras) && ran());
    const photos = await ship(root, {
      source: PHOTOS, fetched_ms: NOW, carried: Object.fromEntries(SHOTS.map(({ hex, bytes }) => [hex, bytes])),
      rows: SHOTS.map(({ hex, bytes, at_ms }) => ({ kind: "img", key: hex, at: at_ms, blobs: [`sha256:${hex}`],
        content: { type: "photos.asset", blobs: [{ hash: `sha256:${hex}`, bytes: bytes.length, media_type: "image/jpeg", role: "original" }] } })) as never,
    });
    await until(`${photos} imported`, () => imported(photos) && ran());
    const faces = await ship(root, { source: FACES, fetched_ms: NOW, rows: [{ kind: "named", key: "person-a", content: { labels: [], photos: OFFICE_SHOTS
      .map(({ hex, at_ms }) => ({ face: `${hex}:${FACE_BOX.join(",")}`, at_ms, camera: true, crop: null, tier: null, size: 0 }))
      .sort((left, right) => right.at_ms - left.at_ms || (left.face < right.face ? -1 : 1)) } }] as never });
    await until(`${faces} imported`, () => imported(faces) && ran());
    const shipped = await ship(root, { source: FIXES, fetched_ms: NOW, rows: track(cannedDays()) as never });
    await until(`${shipped} imported and the places written after it`, () => imported(shipped) && ran());
    await until("the places counted", async () => (await page("places")).counting === false);
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("answers every canned place's edit page, its drag summing to its place page's stays, The Office among the circles near it", async () => {
    for (const place of CANNED_PLACES) {
      const edit = await page("placeEdit", { slug: place.slug });
      const stays = (await page("place", { slug: place.slug })).stays as number;
      expect([edit.slug, edit.circle, edit.read, edit.counting]).toEqual([place.slug, { ...place.centre, radius_m: place.radius_m }, true, false]);
      expect(dragged(edit), `${place.slug}: held and what its circle takes in are its place page's stays`).toBe(stays);
      pinned(caseOf(place.slug), edit);
    }
    const office = await page("placeEdit", { slug: "the-office" });
    expect(office.others.map((circle: Body) => circle.slug), "every other place's circle within 5 km, none 80 km away").toEqual(expect.arrayContaining(["home-place", "willow-court"]));
    expect(office.others.map((circle: Body) => circle.slug)).not.toContain("harbour-inn");
  });

  it("answers every canned place's page: The Office with its photos, Person A and more visits than the page shows, Home with Is this home?, the bakery's one visit and photo", async () => {
    for (const place of CANNED_PLACES) {
      const body = await page("place", { slug: place.slug });
      expect([body.head.name, body.counting], place.slug).toEqual([place.name, false]);
      pinned(caseOf(place.slug), body, "place");
    }
    const office = await page("place", { slug: "the-office" });
    expect([office.photos.first, office.photos.total], "The Office's newest four photos of its eight").toEqual([OFFICE_SHOTS.slice(0, 4).map(image), OFFICE_SHOTS.length]);
    expect(office.people.map((person: Body) => person.id), "Person A, on its photos").toEqual(["person:person-a"]);
    expect([office.visits.count > 6, office.rhythm !== null, office.ask_home], "more visits than the page's six, a rhythm, nothing asked").toEqual([true, true, null]);
    expect((await page("place", { slug: "home-place" })).ask_home, "Home asks Is this home?").not.toBeNull();
    const bakery = await page("place", { slug: "corner-bakery" });
    expect([bakery.visits.count, bakery.photos.first, bakery.rhythm], "one visit, its photo, no rhythm").toEqual([1, BAKERY_SHOTS.map(image), null]);
  });

  it("answers Willow Court's edit page with its own other circles and the pin's two stays beside them, its own two afternoons held by its first circle", async () => {
    const willow = await page("placeEdit", { slug: "willow-court" });
    expect(willow.others.filter((circle: Body) => circle.slug === "willow-court").map((circle: Body) => circle.radius_m), "its other circles, under its slug").toEqual([30, 80]);
    expect(willow.points.filter((point: Body) => point.latitude === PIN.latitude && point.longitude === PIN.longitude), "the pin's two stays, one point").toEqual([{ ...PIN, count: 2 }]);
    expect(dragged(willow), "the two afternoons at Willow Court").toBe(2);
    expect(dragged({ ...willow, circle: { ...PIN, radius_m: 35 }, others: [...willow.others, { slug: "willow-court", ...willow.circle }] }), "a circle added on the pin takes in its two stays with the place's two").toBe(4);
  });

  it("answers the edit page of every spot to name, keyed as the canned home keys its spots", async () => {
    const places = await page("places");
    const keys = (places.to_name as Body[]).map((spot) => spot.key as string);
    expect([...keys].sort(), "the home's spots to name sit on the canned home's spots").toEqual(TO_NAME.map(spotKey).sort());
    const listed = (await get("/v1/places")).body!.spots as Body[];
    for (const key of keys) {
      const edit = await page("placeEdit", { spot: key });
      expect([edit.slug, edit.circle.radius_m, edit.held]).toEqual([key, 80, 0]);
      expect(dragged(edit), `${key}: a new circle on the spot takes in the spot's stays`).toBe(listed.find((spot) => spot.key === key)!.stays);
      pinned(caseOf(key), edit);
    }
    const gym = await page("placeEdit", { spot: spotKey(GYM) });
    expect(gym.others, "The Office near the gym, for the naming card's circle to reach").toEqual(expect.arrayContaining([{ slug: "the-office", ...OFFICE, radius_m: 90 }]));
  });

  it("answers the list as the list journey reads it: at open, after its naming, after its hide, after its unhide", async () => {
    const opened = await page("places");
    expect(keys(opened.to_name), "the order the list journey names them in: the gym, the nights away, the photo").toEqual([GYM, AWAY, PHOTO].map(spotKey));
    expect((opened.to_name as Body[]).map((spot) => spot.ask !== null), "Is this home? asked of the nights away alone").toEqual([false, true, false]);
    expect((opened.to_name as Body[]).map((spot) => spot.photos), "the gym's card opens on its newest six photos, the photo spot on its one, the nights away on none")
      .toEqual([GYM_SHOTS.slice(0, 6).map(image), [], SPOT_SHOTS.map(image)]);
    expect((opened.to_name as Body[]).map((spot) => spot.photos_total), "how many photos each spot holds, for the card's more").toEqual([GYM_SHOTS.length, 0, 1]);
    expect(keys(opened.hidden).sort(), "the two spots hidden before").toEqual(["hidden-0a0b0c", "hidden-c0ffee"]);
    const cityOf = (slug: string) => (opened.cities as Body[]).find((city) => [...city.places, ...city.once].some((row: Body) => row.slug === slug))!;
    expect(cityOf("home-place").key, "Home's city first, the city of the newest visit").toBe(opened.cities[0].key);
    expect([cityOf("home-place").once.map((row: Body) => row.slug), cityOf("harbour-inn").places, cityOf("harbour-inn").once.map((row: Body) => row.slug)],
      "a place of one day folds under Visited once: the bakery beside Home, the inn alone in its city").toEqual([["corner-bakery"], [], ["harbour-inn"]]);
    pinned("list", opened, "places");

    await state([
      { kind: "place", key: NAMED_GYM.slug, content: { type: "places.place", name: NAMED_GYM.name, centre: NAMED_GYM.centre, radius_m: NAMED_GYM.radius_m, ids: [] } },
    ]);
    const gym = await page("places");
    expect(keys(gym.to_name), "the gym named: the nights away and the photo still to name, the walk's next two cards").toEqual([AWAY, PHOTO].map(spotKey));
    pinned("gym", gym, "places");

    await state([hide("hidden-3c3c3c", PHOTO)]);
    const named = await page("places");
    expect(keys(named.to_name), "the nights away, left undone, still to name; the gym named, the photo hidden").toEqual([spotKey(AWAY)]);
    expect(keys(named.hidden).sort(), "the home's two and the one just hidden").toEqual(["hidden-0a0b0c", "hidden-3c3c3c", "hidden-c0ffee"]);
    expect((named.cities as Body[]).flatMap((city) => city.places.map((row: Body) => row.slug)), "the gym a place of its own").toContain(NAMED_GYM.slug);
    pinned("named", named, "places");

    await state([{ kind: "hidden", key: "hidden-c0ffee", gone: true }]);
    const unhidden = await page("places");
    expect([keys(unhidden.to_name), keys(unhidden.hidden).sort()], "no spot made up where the unhidden one was").toEqual([[spotKey(AWAY)], ["hidden-0a0b0c", "hidden-3c3c3c"]]);
    pinned("unhidden", unhidden, "places");

    const near = [...CANNED_PLACES.map((place) => place.centre), GYM, AWAY, PHOTO, PIN, NEAR_HOME, SOUTH];
    const filler = Array.from({ length: SCALED_PLACES }, (_, index) => ({
      key: `filler-place-${index}`, name: `Place ${word(index + 300)}`,
      centre: { latitude: 37.3 + ((index * 7) % SCALED_PLACES) / 380, longitude: -122.05 + ((index * 11) % SCALED_PLACES) / 380 },
    })).filter(({ centre }) => near.every((point) => distanceMeters(point, centre) > CLEAR_M));
    await state(filler.map(({ key, name, centre }) => ({ kind: "place", key, content: { type: "places.place", name, centre, radius_m: 100, ids: [] } })));
    const scaled = await page("places");
    expect((scaled.cities as Body[]).flatMap((city) => city.places).length, "a list long enough to scroll, as the live-size canned home lists").toBeGreaterThan(SCALED_PLACES / 2);
    expect(scaled.cities[0].places[0].slug, "Home still first, the places of no stay last").toBe("home-place");
    pinned("scaled", scaled, "places");
  });

  it("answers the place pages after the saves the place journeys make: The Office renamed, Home answered as home", async () => {
    await state([{ kind: "place", key: "the-office", content: { type: "places.place", name: "The Office Annex", centre: OFFICE, radius_m: 90, ids: [] } }]);
    const renamed = await page("place", { slug: "the-office", settled: "1" });
    expect([renamed.head.name, renamed.counting]).toEqual(["The Office Annex", false]);
    pinned("the-office-renamed", renamed, "place");

    await state([{ kind: "place", key: "home-place", content: { type: "places.place", name: "Home", centre: HOME_PLACE, radius_m: 120, ids: [], home: true } }]);
    const home = await page("place", { slug: "home-place", settled: "1" });
    expect([home.head.name, home.ask_home, home.counting], "answered, nothing left to ask").toEqual(["Home", null, false]);
    pinned("home-place-home", home, "place");
    process.stdout.write(`canned places answers written: ${written.length} (${written.join(", ")})\n`);
  });
});

const YEAR_NOW = Date.parse("2026-10-25T06:00:00Z");
const YEAR_DESK = "synthetic-canned-years-desk".padEnd(43, "y");

function yearDays(): Stay[] {
  const ten = 10 * MINUTE;
  return [
    [at("2025-12-30", "20:00:00"), at("2025-12-31", "20:00:00"), HOME_PLACE, ten],
    [at("2026-10-01", "00:00:00"), at("2026-10-07", "20:00:00"), HOME_PLACE, ten],
    [at("2026-10-07", "22:00:00"), at("2026-10-10", "18:00:00"), AWAY, ten],
    [at("2026-10-10", "20:00:00"), at("2026-10-24", "20:00:00"), HOME_PLACE, ten],
  ];
}

describe("The canned home's year pages, which the phone's Trips journey reads", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const year = async (asked: string) => {
    const path = `${PAGES.year.route}?year=${asked}`;
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${YEAR_DESK}` } });
    const body = await response.json() as Body;
    expect(response.status, path).toBe(200);
    PAGES.year.shape.parse(body);
    return body;
  };
  const pinned = (asked: string, body: Body) => {
    const fixture = clientFixture(`pages/canned/year.${asked}`, body);
    expect(fixture.held, `homelink/Tests/Fixtures/pages/canned/year.${asked}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
  };

  beforeAll(async () => {
    root = makeRoot("lifestream-page-canned-years-", {
      sources: { [FIXES]: "fake-rows", [PLACES]: "places-home" },
      settings: { unit: PLACES_UNIT, "day.zone": "UTC" },
    });
    mintPrincipal(openHomeFolder(root), { unit: `dashboard-${PLACES_UNIT}`, scopes: ["read", "deliver"], sources: [PLACES], token: YEAR_DESK, now_ms: 0 });
    home = await startHome(root, { registry: PLACES_REGISTRY, clock: () => YEAR_NOW, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: PLACES_REGISTRY, clock: () => YEAR_NOW });
    url = `http://127.0.0.1:${door.port}`;
    const places = CANNED_PLACES.map(({ slug, name, centre, radius_m, also }) =>
      ({ kind: "place", key: slug, content: { type: "places.place", name, centre, radius_m, ids: [], ...(also === undefined ? {} : { also }) } }));
    const said = await shipFiles(root, PLACES, YEAR_NOW - DAY_MS, statements(places));
    await until(`${said} imported and the places written after it`, () => imported(said) && ran());
    const shipped = await ship(root, { source: FIXES, fetched_ms: YEAR_NOW, rows: track(yearDays()) as never });
    await until(`${shipped} imported and the places written after it`, () => imported(shipped) && ran());
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("answers this year with its three nights away a trip, a row for each of its days, and the year before with no trip", async () => {
    const now = await year("2026");
    expect(now.span, "a home that began in the last days of 2025").toEqual({ first: 2025, last: 2026 });
    expect((now.trips as Body[]).map((trip) => [trip.range, trip.guessed]), "the three nights away, last month on the phone's clock").toEqual([[{ first: "2026-10-07", last: "2026-10-09" }, false]]);
    const [trip] = now.trips as Body[];
    expect([trip!.route.length, trip!.title], "one city away, the trip named for it").toEqual([1, trip!.route[0]]);
    expect((trip!.days as Body[]).map((each) => each.day), "a row a day").toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
    expect((trip!.days as Body[]).filter((each) => !(each.line as string).startsWith(trip!.route[0])), "each night in the city away").toEqual([]);
    pinned("2026", now);

    const before = await year("2025");
    expect([before.span, before.trips, before.base?.name], "the year before: its nights at home, no trip").toEqual([{ first: 2025, last: 2026 }, [], now.base?.name]);
    pinned("2025", before);
  });
});

describe("The canned home's days list, which the phone's canned home serves", () => {
  const PINNED = Date.parse("2026-11-07T22:30:00+05:30");
  const TODAY = "2026-11-07";
  const HISTORY_DAYS = 400;
  const SAYS = 4;
  const canned = Array.from({ length: HISTORY_DAYS + 1 }, (_, back) => addDays(TODAY, back - HISTORY_DAYS));
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const read = async () => {
    const response = await fetch(`${url}${PAGES.days.route}?limit=1024`, { headers: { authorization: `Bearer ${READER}` } });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) as Body };
  };
  const pinned = (kase: string, body: Body) => {
    mkdirSync(join(REPO, "homelink", "Tests", "Fixtures", "pages", "canned"), { recursive: true });
    const fixture = clientFixture(`pages/canned/days.${kase}`, body);
    expect(fixture.held, `homelink/Tests/Fixtures/pages/canned/days.${kase}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
  };

  beforeAll(async () => {
    root = makeRoot("lifestream-page-canned-days-", { sources: { [WHATSAPP]: "people-rows" }, settings: { unit: UNIT, "day.zone": ZONE } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    const began = Date.now();
    const clock = () => PINNED + Date.now() - began;
    home = await startHome(root, { registry: REGISTRY, clock, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY, clock });
    url = `http://127.0.0.1:${door.port}`;
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("answers an empty home with no day, opening on today", async () => {
    await until("the home has listed its days", async () => (await read()).status === 200);
    const { body } = await read();
    PAGES.days.shape.parse(body);
    expect([body!.today, body!.opening, body!.days, body!.next]).toEqual([TODAY, TODAY, [], null]);
    pinned("nothing", body!);
  });

  it("answers the canned home's history, a written day for each of its 401 days up to today, in order, opening on today", async () => {
    const rows = canned.flatMap((day, at) => Array.from({ length: 1 + (at % SAYS) }, (_, n) => {
      const when = Date.parse(`${day}T12:00:00+05:30`) + n * MINUTE;
      return wa({ stanza: `canned-day-${day}-${n}`, when, me: n % 2 === 1 }, jid(A));
    }));
    const id = await ship(root, { source: WHATSAPP, fetched_ms: PINNED, rows: rows as never });
    await until(`${id} imported and every day written`, () => imported(id) && ran());
    const { status, body } = await read();
    expect(status).toBe(200);
    PAGES.days.shape.parse(body);
    expect([body!.today, body!.opening, body!.next]).toEqual([TODAY, TODAY, null]);
    expect(body!.days.map((each: Body) => each.day), "the days the UI journeys open: today, the phone-off day, last month's trip, 22 and 40 days back").toEqual(canned);
    expect(body!.days.every((each: Body) => each.counts.total > 0)).toBe(true);
    pinned("list", body!);
  });
});
