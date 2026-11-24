import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { contactPersonId, contactId } from "@lifestreamprotocol/families";
import { serveDoor, type Door } from "./door.js";
import { readNameTable } from "./people.js";
import { personRef } from "./refs.js";
import { startHome, type Home } from "./home.js";
import { PEOPLE as PEOPLE_FILE, preparedDirOf, preparedFileOf, readPrepared } from "./prepared.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { readRef } from "./refs.js";
import { searchFileOf } from "./search-index.js";
import { askHome } from "./socket.js";
import { inboxLane } from "./inbox.js";
import { clientFixture, LOOK_MS, makeRoot, readHome, removeRoot, REPO, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { editSettings, testSocket } from "./test/folder.js";
import { openHomeFolder } from "@lifestreamprotocol/core";


const ZONE = "Asia/Kolkata";
const UNIT = "macbook-pro-0001";
const WHATSAPP = "whatsapp:919000000009:iphone-aa01";
const WHATSAPP_MAC = "whatsapp:919000000009:macbook-pro-0001";
const IMESSAGE = "imessage:person-me@example.com:macbook-pro-0001";
const MAIL = "gmail:person-me@example.com:cloud";
const BOOK1 = "apple-contacts:local:iphone-aa01";
const BOOK2 = "apple-contacts:local:macbook-pro-0001";
const BOOK3 = "apple-contacts:local:ipad-aa03";
const PEOPLE = `people:local:${UNIT}`;
const FACES = `faces:local:${UNIT}`;
const REGISTRY = join(REPO, "packages", "home", "test", "people-registry.ts");
const READER = "synthetic-people-reader".padEnd(43, "r");
const DASHBOARD = "synthetic-people-dashboard".padEnd(43, "d");
const PHONE = "synthetic-people-phone".padEnd(43, "p");
const PHONE_UNIT = "iphone-photo-aa07";
const APPLE_EPOCH_S = 978_307_200;
const GROUP = "120363000000000001@g.us";
const L_PHONE = "15550000031@s.whatsapp.net";
const L_LID = "900000000031@lid";
const G_LID = "900000000032@lid";
const at = (utc: string) => Date.parse(`${utc}Z`);
const T = at("2026-10-01T10:00:00");
const MINUTE = 60_000;


function wa(stanza: string, chat: string, when: number, from: { me?: true; member?: string; jid?: string } = {}) {
  const date = when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: stanza, ZTEXT: `synthetic line ${stanza}`, ZFROMJID: from.me === true ? null : from.jid ?? chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: 0, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: from.me === true ? 1 : 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${chat}:${stanza}`, at: when,
    content: { type: "whatsapp.msg", message, session_jid: chat, parent_stanza_id: null, media_item: null, group_member_jid: from.member ?? null, blobs: [] },
  };
}
const shell = (key: string, partner: string, pairs: { phone?: string; lid?: string } = {}) => ({ kind: "chat", key, content: { type: "whatsapp.chat", group_info: null,
  chat: { ZCONTACTJID: pairs.phone ?? key, ZCONTACTIDENTIFIER: pairs.lid ?? null, ZPARTNERNAME: partner, ZSESSIONTYPE: key.endsWith("@g.us") ? 1 : 0 } } });
const pushName = (jid: string, name: string) => ({ kind: "pushname", key: jid, content: { type: "whatsapp.pushname", ZJID: jid, ZPUSHNAME: name } });
const imessage = (guid: string, phone: string, when: number) => ({
  kind: "msg", key: guid, at: when,
  content: { type: "imessage.msg", sender: { kind: "phone", canonical: phone }, recipients: [], flags: { is_from_me: 0 }, text: `synthetic imessage ${guid}` },
});
const card = (...lines: string[]) => {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.map((line) => `${line}\r\n`).join("")}END:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
};
function mailRow(key: string, when: number, from: string, to: string, headers: string[] = []) {
  const bytes = Buffer.from([`From: ${from}`, `To: ${to}`, `Subject: synthetic ${key}`, `Date: ${new Date(when).toUTCString()}`, `Message-ID: <${key}@example.com>`, ...headers,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "A synthetic body.", ""].join("\r\n"));
  const hex = createHash("sha256").update(bytes).digest("hex");
  return {
    row: { kind: "mailmsg", key, at: when, blobs: [`sha256:${hex}`], content: { content: { gm_msgid: key, folder: "INBOX", labels: [] }, blobs: [{ hash: `sha256:${hex}`, role: "original", media_type: "message/rfc822" }] } },
    carried: [hex, bytes] as const,
  };
}
function record(slug: string, anchor: [string, string] | null, more: Record<string, unknown> = {}) {
  return {
    type: "people.person", slug, name: null, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: anchor === null ? null : { kind: anchor[0], value: anchor[1] }, handles: [], excluded: [], dismissed: [], also_called: [], merged_into: null, ...more,
  };
}
const statements = (lines: object[]) => ({ "statements.ndjson": Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) });
const photo = (name: string) => createHash("sha256").update(`synthetic photo ${name}`).digest("hex");
const crop = (name: string) => `sha256:${createHash("sha256").update(`synthetic crop ${name}`).digest("hex")}`;
const BOX = [10, 10, 50, 50];
const faceOf = (name: string) => `${photo(name)}:${BOX.join(",")}`;
function named(slug: string, faces: { name: string; when: number | null; camera?: true }[], labels: string[] = []) {
  const photos = faces.map(({ name, when, camera }) => ({ face: faceOf(name), at_ms: when, camera: camera === true, crop: crop(name), tier: "seed", size: 40 }))
    .sort((left, right) => (right.at_ms ?? -Infinity) - (left.at_ms ?? -Infinity) || (left.face < right.face ? -1 : 1));
  return { kind: "named", key: slug, content: { photos, labels } };
}
const cluster = (id: string, members: string[], suggested: { person: string; score: number }[]) => ({
  kind: "cluster", key: id, content: { size: members.length, photos: members.length, years: [2026, 2026], year_count: 1, faces: members.map((name) => ({ face: faceOf(name), at_ms: T, crop: crop(name) })),
    outliers: [], chat_share: 0, suggested, evidence: { senders: [], labels: [] }, rule: "0".repeat(64) },
});
const P_GROUP = "00000000000000a1";
const JPEG = Buffer.from("synthetic jpeg bytes of a card photo");
const PNG = Buffer.from("synthetic png bytes of a card photo");
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const segment = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
const jpeg = (name: string, width: number, height = width, pad = 0) => Buffer.concat([
  Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")), segment(0xfe, Buffer.from(`synthetic picture ${name}`)),
  segment(0xc0, Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0])), segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  Buffer.alloc(pad), Buffer.from([0xff, 0xd9]),
]);

function rounds(prefix: string, chat: string, start: number, answers: number, after: number, jid?: string) {
  return Array.from({ length: 20 }, (_, round) => {
    const asked = start + round * 10 * MINUTE;
    return [wa(`${prefix}${round}m`, chat, asked, { me: true }),
      ...Array.from({ length: answers }, (_, n) => wa(`${prefix}${round}a${n}`, chat, asked + after * (n + 1), jid === undefined ? {} : { jid }))];
  }).flat();
}


type Person = Record<string, any>;

describe("People through the door", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url: string;
  let shipped = 0;
  const report: Record<string, unknown> = {};

  const open = async () => {
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: () => undefined, registry: REGISTRY });
    url = `http://127.0.0.1:${door.port}`;
  };
  const calm = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() === shipped
    && db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get() === 0 && db.prepare("SELECT count(*) FROM dirty_days").pluck().get() === 0);
  const send = async (source: string, rows: object[], carried?: Record<string, Buffer>) => {
    const made = [WHATSAPP, WHATSAPP_MAC].includes(source) && readHome(root, (db) => db.prepare("SELECT count(*) FROM sources WHERE id = ?").pluck().get(source)) === 0;
    await ship(root, {
      source, fetched_ms: T + shipped * MINUTE, rows: rows as never, ...(carried === undefined ? {} : { carried }),
      ...(made ? { facts: { sources: [{ id: source, connector: "people-rows" }] } } : {}),
    });
    shipped++;
    await until("the home settled", calm);
  };
  const say = async (lines: object[]) => {
    await shipFiles(root, PEOPLE, T + shipped * MINUTE, statements(lines));
    shipped++;
    await until("the home settled", calm);
  };
  const get = async (path: string, etag?: string) => {
    const started = performance.now();
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READER}`, ...(etag === undefined ? {} : { "if-none-match": etag }) } });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get("etag"), body: text === "" ? null : JSON.parse(text) as Record<string, any>, ms: Math.round(performance.now() - started) };
  };
  const raw = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    httpGet(`${url}${path}`, { headers: { authorization: `Bearer ${READER}`, ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    }).on("error", reject);
  });
  const list = async () => (await get("/v1/people")).body!;
  const one = async (id: string): Promise<Person> => {
    const answer = await get(`/v1/people?id=${encodeURIComponent(id)}`);
    expect(answer.status, id).toBe(200);
    return answer.body!.person;
  };
  const handles = (person: Person) => person.handles.map((handle: Person) => [handle.kind, handle.kind === "network" ? handle.id : handle.id.slice(handle.kind.length + 1), handle.from]);
  const kinds = (person: Person) => person.suggestions.map((suggestion: Person) => `${suggestion.kind} ${suggestion.value}`);

  beforeAll(async () => {
    root = makeRoot("lifestream-people-", {
      sources: { ...Object.fromEntries([IMESSAGE, MAIL, BOOK1, BOOK2, BOOK3].map((id) => [id, "people-rows"])), [FACES]: "faces", [PEOPLE]: "people-home" },
      settings: { unit: UNIT, "day.zone": ZONE },
    });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    mintPrincipal(openHomeFolder(root), { unit: `dashboard-${UNIT}`, scopes: ["read", "deliver"], sources: [PEOPLE], token: DASHBOARD, now_ms: 0 });
    mintPrincipal(openHomeFolder(root), {
      unit: PHONE_UNIT, kind: "phone", scopes: ["deliver", "read"], sources: [`places:local:${UNIT}`, `devices:local:${UNIT}`], token: PHONE, now_ms: 0,
    });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
    await open();
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "people.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("joins one human across cards, WhatsApp and records, and keeps apart what the owner keeps apart", async () => {
    const n1 = card("FN:Person N", "TEL;TYPE=CELL:+91 90000 00011");
    const n2 = card("FN:Person N", "TEL;TYPE=CELL:090000 00011");
    await send(BOOK1, [n1]);
    await send(BOOK2, [n2]);
    const n2Id = contactPersonId({ id: contactId({ source: BOOK2, key: n2.key }) });
    const before = await list();
    expect(before.people.filter((person: Person) => person.name === "Person N").map((person: Person) => person.id).sort()).toEqual(["phone:+919000000011", n2Id].sort());

    const e1 = card("FN:Person E", "TEL:+15550000021");
    const nameless = card("FN:Person Nameless");
    const ab = card("FN:Person AB", "TEL:+15550000041", "EMAIL:person-ab@example.com");
    const bc = card("FN:Person BC", "EMAIL:Person-AB@Example.com", "TEL:+1 555 000 0043");
    await send(BOOK1, [e1, card("FN:Person M", "TEL:+15550000061", "TEL:+15550000063"), card("FN:Synthetic Assistant", "TEL:+15550000091"),
      card("FN:Person Photo", "TEL:+15550000151", `PHOTO;ENCODING=b;TYPE=JPEG:${JPEG.toString("base64")}`), card("FN:Person Png", "TEL:+15550000152", `PHOTO:data:image/png;base64,${PNG.toString("base64")}`)]);
    await send(BOOK2, [ab, card("FN:Person F", "TEL:+15550000071"), card("FN:Synthetic Assistant", "TEL:+15550000092")]);
    await send(BOOK3, [nameless, bc, card("FN:Person H", "TEL:+15550000101"), card("N:Synthetic;Person K;;;", "FN:Person K Synthetic", "TEL:+15550000121"),
      card("ORG:Synthetic Bakery", "TEL:+15550000131")]);
    await send(WHATSAPP, [
      shell(L_LID, "Person L", { phone: L_PHONE, lid: L_LID }), shell(GROUP, "Group Alpha"), pushName("15550000071@s.whatsapp.net", "Fiona Synthetic"),
      wa("L1", L_LID, T, { me: true }), wa("L2", L_LID, T + MINUTE, { me: true }), wa("L3", L_LID, T + 2 * MINUTE, { me: true }), wa("L4", L_LID, T + 3 * MINUTE),
      wa("G1", GROUP, T, { member: G_LID }), wa("G2", GROUP, T + MINUTE, { me: true }),
      wa("Q1", "15550000081@s.whatsapp.net", T, { me: true }), wa("Q2", "15550000081@s.whatsapp.net", T + MINUTE, { me: true }), wa("Q3", "15550000081@s.whatsapp.net", T + 2 * MINUTE, { me: true }),
      wa("R1", "15550000082@s.whatsapp.net", T, { me: true }), wa("R2", "15550000082@s.whatsapp.net", T + MINUTE, { me: true }),
      ...rounds("AI1", "15550000091@s.whatsapp.net", T, 2, 3_000), ...rounds("AI2", "15550000092@s.whatsapp.net", T, 2, 4_000),
      ...rounds("H", "15550000101@s.whatsapp.net", T, 1, 10_000),
    ]);
    await send(IMESSAGE, [imessage("GUID-E1", "+15550000021", T), imessage("GUID-E2", "+15550000021", T + MINUTE)]);
    const mails = [
      mailRow("k1", T, "Person Me <person-me@example.com>", "Person K Synthetic <person-k@example.com>"),
      mailRow("k2", T + MINUTE, "Person Me <person-me@example.com>", "\"Person K Synthetic\" <person-k@example.com>, No Reply <no-reply@example.com>"),
      mailRow("j1", T, "Person Me <person-me@example.com>", "Person J <person-j@example.com>"),
      mailRow("n1", T, "Synthetic News <news@example.com>", "person-me@example.com", ["List-ID: <news.example.com>"]),
      mailRow("n2", T + MINUTE, "Synthetic News <news@example.com>", "person-me@example.com", ["List-ID: <news.example.com>"]),
    ];
    await send(MAIL, mails.map((each) => each.row), Object.fromEntries(mails.map((each) => each.carried)));
    await shipFiles(root, PEOPLE, T + shipped * MINUTE, { "people.json": Buffer.from(JSON.stringify({ format: "org.lifestreamprotocol.people/1", people: [{
      type: "people.person", slug: "person-o", name: "Person O", excluded: [], merged_into: null,
      handles: [{ kind: "name", value: "Person O", by: "subject", since: "2025-01-01T00:00:00Z" }, { kind: "phone", value: "+1 555 000 0111", by: "subject", since: "2025-01-01T00:00:00Z" }],
    }] })) });
    shipped++;
    await until("the home settled", calm);

    const first = await list();
    const listed = new Map<string, Person>(first.people.map((person: Person) => [person.id, person]));
    expect(handles(await one(n2Id))).toEqual([["phone", "+919000000011", null]]);
    expect((await one(n2Id)).id).toBe("phone:+919000000011");
    expect([...listed.values()].filter((person) => person.name === "Person N")).toHaveLength(1);
    const namelessId = contactPersonId({ id: contactId({ source: BOOK3, key: nameless.key }) });
    expect(listed.get(namelessId)).toMatchObject({ name: "Person Nameless", by: "contact", handles: [], card: true, show: "name" });
    expect(first.organise.queue).not.toContain(namelessId);
    expect(listed.get("phone:+15550000031")).toMatchObject({ name: "Person L", by: "provider", sent: 3, received: 1, networks: ["whatsapp"] });
    expect(handles(listed.get("phone:+15550000031")!)).toEqual([["phone", "+15550000031", "WhatsApp"], ["jid", L_LID, "WhatsApp"]]);
    expect((await one(`jid:${L_LID}`)).id).toBe("phone:+15550000031");
    expect((await one(`jid:${L_PHONE}`)).id).toBe("phone:+15550000031");
    expect(listed.has(`jid:${G_LID}`)).toBe(false);
    expect(await one(`jid:${G_LID}`)).toMatchObject({ id: `jid:${G_LID}`, name: "unknown lid …00032", received: 1, sent: 0 });
    expect((await get("/v1/people?q=900000000032")).body!.people.map((person: Person) => person.id)).toEqual([`jid:${G_LID}`]);
    expect(handles(listed.get("phone:+15550000041")!)).toEqual([["phone", "+15550000041", "Contacts"], ["phone", "+15550000043", "Contacts"], ["email", "person-ab@example.com", "Contacts"]]);
    expect(listed.get("phone:+15550000081")).toMatchObject({ sent: 3, received: 0, organised: false });
    expect(listed.has("phone:+15550000082")).toBe(false);
    expect(listed.get("email:person-k@example.com")).toMatchObject({ mails_to: 2, mails_from: 0 });
    expect(listed.has("email:person-j@example.com")).toBe(false);
    expect(listed.has("email:news@example.com")).toBe(false);
    expect(listed.has("email:no-reply@example.com")).toBe(false);
    expect(await one("email:news@example.com")).toMatchObject({ mails_from: 0, mails_to: 0 });
    expect(listed.get("person:person-o")).toMatchObject({ name: "Person O", by: "registry", person: "person-o", organised: true });
    expect(handles(listed.get("person:person-o")!)).toEqual([["phone", "+15550000111", "You added"]]);
    expect((await one("person:person-o")).record).toEqual(record("person-o", ["phone", "+15550000111"], { name: "Person O", entity: null }));
    expect(first.you).toMatchObject({ id: "phone:+919000000009", me: true, person: null, also_called: [] });
    expect(listed.has("phone:+919000000009")).toBe(false);
    expect(first.organise.queue).not.toContain("phone:+919000000009");
    expect(handles(first.you)).toEqual([["phone", "+919000000009", "Your WhatsApp"], ["email", "person-me@example.com", "Your Gmail and iMessage"]]);
    expect(first.you.handles.map((handle: Person) => handle.own)).toEqual([true, true]);
    expect((await one("email:person-me@example.com")).id).toBe("phone:+919000000009");
    expect(await one("me")).toEqual(await one("phone:+919000000009"));
    expect(kinds(await one("me")).filter((each: string) => each.startsWith("me "))).toEqual([]);
    const ai1 = await one("phone:+15550000091");
    expect(kinds(ai1)).toEqual(expect.arrayContaining(["entity ai", "same phone:+15550000092"]));
    expect(kinds(await one("phone:+15550000092"))).toEqual(expect.arrayContaining(["entity ai", "same phone:+15550000091"]));
    expect(ai1.suggestions.find((suggestion: Person) => suggestion.kind === "entity")).toMatchObject({ reasons: { replies: 20, quick: 20, theirs: 40, mine: 20 }, ticked: true });
    expect(ai1.suggestions.find((suggestion: Person) => suggestion.kind === "same")).toMatchObject({ value: "phone:+15550000092", ticked: false });
    expect(kinds(await one("phone:+15550000101"))).not.toContain("entity ai");
    expect(kinds(await one("phone:+15550000131"))).toContain("entity business");
    expect(kinds(await one("phone:+15550000121"))).toContain("handle email:person-k@example.com");
    const fiona = (await one("phone:+15550000071")).suggestions.find((suggestion: Person) => suggestion.kind === "full_name");
    expect(fiona).toMatchObject({ value: "Fiona Synthetic", reasons: { whatsapp: 1, mail: 0, photos: 0 }, ticked: true });
    expect(fiona.id).toBe(createHash("sha256").update("full_name\0Fiona Synthetic").digest("hex").slice(0, 16));
    report.first = { people: first.people, organise: first.organise, others: first.others };

    await say([{ kind: "person", key: "person-a41", content: record("person-a41", ["phone", "+15550000041"], { name: "Person A", excluded: [{ kind: "email", value: "person-ab@example.com" }] }) }]);
    await say([{ kind: "person", key: "person-p1", content: record("person-p1", ["phone", "+15550000051"], { name: "Person P" }) },
      { kind: "person", key: "person-m1", content: record("person-m1", ["phone", "+15550000061"], { name: "Person M One" }) }]);
    await say([{ kind: "person", key: "person-p2", content: record("person-p2", ["phone", "+15550000052"], { name: "Person P", handles: [{ kind: "phone", value: "+15550000051" }] }) },
      { kind: "person", key: "person-m2", content: record("person-m2", ["phone", "+15550000062"], { name: "Person M Two", excluded: [{ kind: "phone", value: "+15550000063" }], merged_into: "person-m1" }) },
      { kind: "person", key: "person-f", content: record("person-f", ["phone", "+15550000071"], { dismissed: [fiona.id] }) }]);
    await send(WHATSAPP, [shell("15550000071@s.whatsapp.net", "Fiona Synthetic")]);
    await send(FACES, [
      cluster(P_GROUP, ["a1", "a2", "a3"], [{ person: "person-p1", score: 0.66 }]),
      named("person-p1", [{ name: "p1", when: T - 400 * 86_400_000, camera: true }, { name: "p2", when: T }], ["Person P Synthetic"]),
      { kind: "maybe", key: "person-p1", content: { faces: [{ face: faceOf("m"), score: 0.52, crop: crop("m") }] } },
    ]);

    const second = await list();
    const now = new Map<string, Person>(second.people.map((person: Person) => [person.id, person]));
    expect(handles(now.get("person:person-a41")!)).toEqual([["phone", "+15550000041", "You added"]]);
    expect(handles(await one("email:person-ab@example.com"))).toEqual([["email", "person-ab@example.com", null]]);
    expect(handles(await one("phone:+15550000043"))).toEqual([["phone", "+15550000043", null]]);
    expect((await one("phone:+15550000043")).id).toBe("phone:+15550000043");
    expect((await one("phone:+15550000051")).id).toBe("person:person-p1");
    expect(handles(await one("person:person-p2"))).toEqual([["phone", "+15550000052", "You added"]]);
    expect(kinds(await one("person:person-p1"))).toContain("same person-p2");
    expect(kinds(await one("person:person-p2"))).toContain("same person-p1");
    expect((await one("phone:+15550000062")).id).toBe("person:person-m1");
    expect((await one("person:person-m2")).id).toBe("person:person-m1");
    expect(handles(await one("person:person-m1"))).toEqual([["phone", "+15550000061", "You added"], ["phone", "+15550000062", "You added"]]);
    expect((await one("person:person-m1")).record).toEqual(record("person-m1", ["phone", "+15550000061"], { name: "Person M One" }));
    expect(await one("phone:+15550000063")).toMatchObject({ id: "phone:+15550000063", name: "Person M" });
    const f = await one("person:person-f");
    expect(f).toMatchObject({ name: "Person F", by: "contact" });
    expect(kinds(f).filter((each: string) => each.startsWith("full_name "))).toEqual([]);
    expect(kinds(await one("person:person-p1")).filter((each: string) => each.startsWith("face "))).toEqual([]);
    expect((await one("person:person-p1")).names_seen).toContain("Person P Synthetic");
    expect(second.organise).toMatchObject({ organised: 6 });
    expect(second.organise.queue).not.toContain("person:person-p1");

    const photos = await get(`/v1/people/photos?id=${encodeURIComponent("phone:+15550000051")}`);
    expect(photos.body!.photos.map((each: Person) => [each.image, each.camera])).toEqual([[photo("p2"), false], [photo("p1"), true]]);
    expect(Object.keys(photos.body!).sort()).toEqual(["photos", "position", "total"]);
    expect(photos.body!.total).toBe(2);
    await send(FACES, [named("person-p2", Array.from({ length: 61 }, (_, n) => ({ name: `q${n}`, when: T - n * MINUTE })))]);
    const paged = await get(`/v1/people/photos?id=${encodeURIComponent("person:person-p2")}`);
    const next = await get(`/v1/people/photos?id=${encodeURIComponent("person:person-p2")}&after=${paged.body!.next as string}`);
    expect([paged.body!.photos.length, paged.body!.total, next.body!.photos.length, next.body!.total, Object.hasOwn(next.body!, "next")]).toEqual([60, 61, 1, 61, false]);
    const numbered = await get(`/v1/people/photos?id=${encodeURIComponent("person:person-p2")}&at=48&limit=12`);
    expect([numbered.body!.photos.map((each: Person) => each.image), numbered.body!.total]).toEqual([paged.body!.photos.slice(48).map((each: Person) => each.image), 61]);
    const rest = await get(`/v1/people/photos?id=${encodeURIComponent("person:person-p2")}&at=60&limit=12`);
    expect([rest.body!.photos.map((each: Person) => each.image), Object.hasOwn(rest.body!, "next")]).toEqual([next.body!.photos.map((each: Person) => each.image), false]);
    expect(now.get("person:person-p1")!.photo).toEqual({ crop: crop("p1") });

    await until("the search index caught up", () => {
      try {
        statSync(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!));
      } catch {
        return false;
      }
      return readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'index' AND key = 'search' AND state <> 'done'").pluck().get()) === 0;
    });
    const found = await get(`/v1/search?lists=record&person=${encodeURIComponent(`jid:${L_LID}`)}&limit=50`);
    expect(found.status).toBe(200);
    const keys = found.body!.record.hits.flatMap((hit: { ref: string }) => {
      const ref = readRef(hit.ref, "ref", ["record", "line"]);
      return ref.kind === "record" ? [ref.parts.key] : [];
    });
    expect(keys).toEqual(expect.arrayContaining([`${L_LID}:L4`, L_LID]));
    expect(keys.every((key: string) => key.startsWith(L_LID))).toBe(true);
    expect((await get(`/v1/search?lists=record&person=${encodeURIComponent("phone:+15550000031")}&limit=50`)).body!.record.hits).toEqual(found.body!.record.hits);
    expect(await get("/v1/search?lists=record&person=person:nobody")).toMatchObject({ status: 404, body: { code: "PERSON_UNKNOWN" } });

    expect((await get("/v1/people?q=fiona")).body!.people.map((person: Person) => person.id)).toEqual(["person:person-f"]);
    expect((await get("/v1/people?q=synthetic%20assistant")).body!.people.map((person: Person) => person.id).sort()).toEqual(["phone:+15550000091", "phone:+15550000092"]);
    expect((await get("/v1/people?id=phone:%2B15550009999")).body!.code).toBe("PERSON_UNKNOWN");
    expect((await get("/v1/people?q=")).status).toBe(422);

    const sock = testSocket(root);
    const on = await get(`/v1/people/photos?id=${encodeURIComponent("person:person-p1")}`);
    const memoOfFaces = () => {
      const memo = new Database(join(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "people"), "memo.db"), { readonly: true });
      try {
        return ["named"].map((space) => memo.prepare("SELECT count(*) FROM sqlite_master WHERE name = ?").pluck().get(`space:${space}`) === 0 ? 0
          : memo.prepare(`SELECT count(*) FROM "space:${space}"`).pluck().get() as number);
      } finally {
        memo.close();
      }
    };
    expect(memoOfFaces().reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
    await askHome(sock, "faces", ["off"]);
    await until("the home settled", calm);
    expect(memoOfFaces()).toEqual([0]);
    const off = await get(`/v1/people/photos?id=${encodeURIComponent("person:person-p1")}`);
    expect(off.body).toMatchObject({ photos: [], total: 0 });
    expect((await list()).people.find((person: Person) => person.id === "person:person-p1").photo).toBeNull();
    await askHome(sock, "connectors", ["on", "faces"]);
    await until("the home settled", calm);
    const back = await get(`/v1/people/photos?id=${encodeURIComponent("person:person-p1")}`);
    expect([back.etag, back.body!.photos]).toEqual([on.etag, on.body!.photos]);
    expect((await list()).people.find((person: Person) => person.id === "person:person-p1").photo).toEqual({ crop: crop("p1") });

    const photoed = await one("phone:+15550000151");
    const vcard4 = await one("phone:+15550000152");
    expect([photoed.photo, vcard4.photo]).toEqual([{ card: sha(JPEG) }, { card: sha(PNG) }]);
    for (const [bytes, type] of [[JPEG, "image/jpeg"], [PNG, "image/png"]] as const) {
      const served = await raw(`/v1/people/card?hash=${sha(bytes)}`);
      expect([served.status, served.headers["content-type"], served.headers["cache-control"], sha(served.body)]).toEqual([200, type, "private, max-age=86400", sha(bytes)]);
      const again = await raw(`/v1/people/card?hash=${sha(bytes)}`, { "if-none-match": served.headers.etag as string });
      expect([again.status, again.headers["cache-control"]]).toEqual([304, "private, max-age=86400"]);
    }
    expect((await raw(`/v1/people/card?hash=sha256:${"0".repeat(64)}`)).status).toBe(404);
    const whole = await raw("/v1/people");
    expect(whole.body.toString("utf8")).not.toMatch(/base64|data:image/u);
    for (const path of ["/v1/people", `/v1/people?id=${encodeURIComponent("person:person-p1")}`, "/v1/people?q=fiona", `/v1/people/photos?id=${encodeURIComponent("person:person-p1")}`]) {
      const [plain, zipped] = [await raw(path), await raw(path, { "accept-encoding": "gzip" })];
      expect([zipped.headers["content-encoding"], zipped.headers.etag], path).toEqual(["gzip", plain.headers.etag]);
      expect(JSON.parse(gunzipSync(zipped.body).toString("utf8")), path).toEqual(JSON.parse(plain.body.toString("utf8")));
    }
    await until("the home settled", calm);
    const at = [await get("/v1/people"), await get("/v1/people?id=person:person-p1"), await get(`/v1/people/photos?id=${encodeURIComponent("person:person-p1")}`)];
    expect(new Set(at.map((answer) => answer.body!.position)).size).toBe(1);

    const everyone = new Set<string>([...second.people.map((person: Person) => person.id), `jid:${G_LID}`, "phone:+15550000082", "email:news@example.com", "email:person-j@example.com", "phone:+15550000043", "email:person-ab@example.com"]);
    report.people = await Promise.all([...everyone].sort().map(async (id) => {
      const person = await one(id);
      return { id: person.id, name: person.name, by: person.by, listed: second.people.some((each: Person) => each.id === person.id), handles: person.handles, suggestions: person.suggestions, names_seen: person.names_seen, score: person.score };
    }));
    report.organise = second.organise;
    report.others = second.others;
    report.photos = photos.body;
  });

  it("answers what the home prepared: 304 while a row stands, nothing read again for a run that moved nothing but its event, one extract for one moved, and at once from a door started again", async () => {
    const sock = testSocket(root);
    const runs = () => readHome(root, (db) => (db.prepare("SELECT counts FROM runs WHERE kind = 'people' AND outcome = 'ok' ORDER BY id").pluck().all() as string[])
      .map((counts) => JSON.parse(counts) as Record<string, number>));
    const events = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'people'").pluck().get() as number);
    const said = () => JSON.parse(readHome(root, (db) => db.prepare("SELECT detail FROM events WHERE kind = 'people' ORDER BY seq DESC LIMIT 1").pluck().get() as string)) as { position: string; changed: string };
    const seq = (position: string) => Number(position.split(":")[0]);
    const first = await get("/v1/people");
    const etag = first.etag!;
    expect((await get("/v1/people", etag)).status).toBe(304);
    const plain = await raw("/v1/people");
    expect(plain.headers["lifestream-position"]).toBe(JSON.parse(plain.body.toString("utf8")).position);
    for (const path of ["/v1/people", `/v1/people?id=${encodeURIComponent("person:person-p1")}`, "/v1/people?q=fiona", `/v1/people/photos?id=${encodeURIComponent("person:person-p1")}`]) {
      const answered = await raw(path);
      const again = await raw(path, { "if-none-match": String(answered.headers.etag) });
      expect([again.status, again.headers["lifestream-position"]], path).toEqual([304, JSON.parse(answered.body.toString("utf8")).position]);
    }

    const [ran, told, stood] = [runs().length, events(), said().changed];
    await askHome(sock, "run", ["people", "people"]);
    await until("the run asked for ran", () => runs().length > ran && calm());
    expect(runs().at(-1)).toMatchObject({ extracts: 0, joined: 0, versions: 0, written: 0, removed: 0 });
    expect(events()).toBe(told + 1);
    expect(said().changed).toBe(stood);
    expect(seq(said().position)).toBeGreaterThanOrEqual(seq(stood));
    expect((await get("/v1/people", etag)).status).toBe(304);

    await home.stop();
    const lost = "1:1";
    const file = new Database(preparedFileOf(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "people"), "people"));
    file.prepare("UPDATE meta SET value = ? WHERE key = 'changed'").run(lost);
    file.close();
    const stopped = runs().length;
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
    await until("the start's run ran", () => runs().length > stopped && calm());
    expect(runs().at(-1)).toMatchObject({ written: 0, removed: 0 });
    expect(said().changed).toBe(lost);
    expect(events()).toBeGreaterThanOrEqual(told + 2);

    await home.stop();
    const unit = (readHome(root, (db) => db.prepare("SELECT unit FROM extracts WHERE family = 'messages' AND unit LIKE ?").pluck().get(`%:whatsapp:${L_LID}`)) as string);
    const db = new Database(join(root, "home.db"));
    const content = JSON.parse(db.prepare("SELECT content FROM extracts WHERE family = 'messages' AND unit = ?").pluck().get(unit) as string) as { messages: { from: { id: string; kind: string } }[] };
    for (const message of content.messages) if (message.from.kind === "jid") message.from.id = "15550000099@s.whatsapp.net";
    db.prepare("UPDATE extracts SET content = ?, reading = ? WHERE family = 'messages' AND unit = ?").run(JSON.stringify(content), `sha256:${"0".repeat(64)}`, unit);
    db.close();
    const peopleFile = preparedFileOf(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "people"), "people");
    const marks = () => readPrepared(openHomeFolder(dirname(peopleFile)), peopleFile, PEOPLE_FILE.format, (read) => Object.fromEntries(PEOPLE_FILE.tables.map((table) => [table, read.meta(`changed:${table}`) ?? null])))!.value;
    const marked = marks();
    const named = readPrepared(openHomeFolder(dirname(peopleFile)), peopleFile, PEOPLE_FILE.format, (read) => {
      const ids = new Set((read.db.prepare("SELECT key FROM image").pluck().all() as string[]).flatMap((key) => read.value<{ people: { id: string }[] }>("image", key)!.people.map((person) => person.id)));
      return { ids: [...ids].sort(), named: (read.db.prepare("SELECT key FROM named ORDER BY key").pluck().all() as string[]).map((key) => read.value<Record<string, unknown>>("named", key)!) };
    })!.value;
    expect(named.ids.length).toBeGreaterThan(0);
    expect(named.named.map((each) => each.id)).toEqual(named.ids);
    expect(named.named.every((each) => Object.keys(each).sort().join() === "id,me,name,photo")).toBe(true);
    const before = runs().length;
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
    await until("the start's run ran", () => runs().length > before && calm());
    expect(runs().slice(before).reduce((read, counts) => read + counts.extracts!, 0)).toBe(1);
    const moved = await get("/v1/people", etag);
    expect(moved.status).toBe(200);
    expect(moved.body!.people.find((person: Person) => person.id === "phone:+15550000031")).toMatchObject({ received: 0, sent: 3 });
    expect((await one("jid:15550000099@s.whatsapp.net")).received).toBe(1);
    const remarked = marks();
    expect(remarked.person).not.toBe(marked.person);
    expect([remarked.image, remarked.named]).toEqual([marked.image, marked.named]);

    await say([{ kind: "person", key: "person-l", content: record("person-l", ["phone", "+15550000031"], { name: "Person L Named" }) }]);
    const landed = readHome(root, (db) => db.prepare("SELECT max(seq) FROM events WHERE kind = 'import' AND key LIKE ?").pluck().get(`${PEOPLE}/%`) as number);
    const renamed = await get("/v1/people", moved.etag!);
    expect(renamed.status).toBe(200);
    expect(Number((renamed.body!.position as string).split(":")[0])).toBeGreaterThanOrEqual(landed);
    expect(renamed.body!.people.find((person: Person) => person.id === "person:person-l")).toMatchObject({ name: "Person L Named", received: 0, sent: 3 });
    expect((await get("/v1/people", renamed.etag!)).status).toBe(304);

    const standing = runs().length;
    await door.close();
    await open();
    const again = await get("/v1/people", renamed.etag!);
    expect([again.status, runs().length]).toEqual([304, standing]);
    report.reads = { kept_ms: first.ms, moved_ms: moved.ms, record_ms: renamed.ms, restarted_ms: again.ms, runs: runs() };
  });

  it("counts a message once, in one chat, when a chat moved to its LID keeps a copy under each key", async () => {
    const S = "15550000141@s.whatsapp.net";
    const S_LID = "900000000141@lid";
    const when = at("2026-10-03T09:00:00");
    const before = await get("/v1/people");
    await send(WHATSAPP, [wa("S1", S, when), wa("S2", S, when + MINUTE, { me: true })]);
    await send(WHATSAPP_MAC, [shell(S_LID, "Person S", { phone: S, lid: S_LID }),
      wa("S1", S_LID, when, { jid: S }), wa("S2", S_LID, when + MINUTE, { me: true }), wa("S3", S_LID, when + 2 * MINUTE, { jid: S })]);
    const kept = await get("/v1/people", before.etag!);
    expect(kept.status).toBe(200);
    const of = async (answer: typeof kept) => ({
      person: await one("phone:+15550000141"),
      chats: (answer.body!.chats as { key: string }[]).filter((each) => each.key === `whatsapp:${S}` || each.key === `whatsapp:${S_LID}`),
    });
    const counted = await of(kept);
    expect(counted.person).toMatchObject({ name: "Person S", chats: [{ key: `whatsapp:${S_LID}`, count: 2 }], received: 2, sent: 1 });
    expect(counted.chats).toMatchObject([{ key: `whatsapp:${S_LID}`, chat: S_LID, group: false, total: 3, mine: 1 }]);
    for (const asked of [S_LID, S]) {
      const talk = (await get(`/v1/conversation?${new URLSearchParams({ chat: `whatsapp:${asked}`, day: "2026-10-03" })}`)).body!;
      expect(talk.chat, asked).toBe(`whatsapp:${S_LID}`);
      for (const member of ["zone", "day_start_hour"]) expect(talk, asked).not.toHaveProperty(member);
      expect(talk.atoms.map((atom: Person) => [atom.n, atom.start_ms, atom.text.slice(atom.text.indexOf(": ") + 2)]), asked)
        .toEqual([[1, when, "synthetic line S1"], [2, when + MINUTE, "synthetic line S2"], [3, when + 2 * MINUTE, "synthetic line S3"]]);
      expect(talk.atoms[1].text, asked).toBe("the user: synthetic line S2");
      expect(talk.messages.map((fact: Person) => fact.text), asked).toEqual(["synthetic line S1", "synthetic line S2", "synthetic line S3"]);
    }
    expect((await get("/v1/conversation?chat=whatsapp%3A&day=2026-10-03")).status).toBe(422);
    await door.close();
    await open();
    const whole = await get("/v1/people");
    expect((await of(whole)).chats).toEqual(counted.chats);
    report.rekeyed = counted;

    const AI = "15550000301@s.whatsapp.net";
    const AI_LID = "900000000301@lid";
    await send(WHATSAPP_MAC, [shell(AI_LID, "Synthetic Helper", { phone: AI, lid: AI_LID }), ...rounds("AL", AI_LID, when, 2, 3_000, AI)]);
    const helper = await one("phone:+15550000301");
    expect(helper).toMatchObject({ received: 40, sent: 20 });
    expect(helper.suggestions.find((suggestion: Person) => suggestion.kind === "entity")?.reasons).toEqual({ replies: 20, quick: 20, theirs: 40, mine: 20 });

    const V = "15550000151@s.whatsapp.net";
    const sound = Buffer.from("OggS synthetic voice note V1");
    const blob = `sha256:${createHash("sha256").update(sound).digest("hex")}`;
    const spoken = wa("V1", V, when);
    const voice = { ...spoken, blobs: [blob], content: { ...spoken.content, message: { ...spoken.content.message, ZMESSAGETYPE: 3, ZTEXT: null }, blobs: [{ hash: blob, bytes: sound.length, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }] } };
    await send(WHATSAPP_MAC, [shell(V, "Person V"), voice, wa("V2", V, when + MINUTE)], { [blob.slice("sha256:".length)]: sound });
    const talk = (await get(`/v1/conversation?${new URLSearchParams({ chat: `whatsapp:${V}`, day: "2026-10-03" })}`)).body!;
    const [note, line] = talk.messages as { parts?: { what: string; transcribed?: Person }[] }[];
    expect(note!.parts).toEqual([expect.objectContaining({
      what: "voice note", blob, transcribed: expect.objectContaining({
        state: "off", line: "Older than this stream's range", ask: { family: "messages", item: blob, prompt: "voice-note-transcript" },
      }),
    })]);
    expect(line!.parts ?? []).toEqual([]);
    const fixture = clientFixture("conversation", talk);
    expect(fixture.held, "homelink/Tests/Fixtures/conversation.json is this read: LIFESTREAM_FIXTURES=write writes it").toBe(fixture.written);
  });

  it("dates the owner's word by when it last began, names a record by its handle, and never offers again what was declined", async () => {
    const person = (slug: string, phone: string, more: Record<string, unknown> = {}) => ({ kind: "person", key: slug, content: record(slug, ["phone", phone], more) });
    const same = (answer: Person, value: string) => answer.suggestions.find((suggestion: Person) => suggestion.kind === "same" && suggestion.value === value);

    await say([person("person-u", "+15550000231")]);
    expect(await one("person:person-u")).toMatchObject({ name: "+15550000231", by: "none" });

    await say([person("person-z", "+15550000291", { handles: [{ kind: "phone", value: "+15550000292" }, { kind: "email", value: "person-z@example.com" }] })]);
    expect(handles(await one("person:person-z"))).toEqual([["phone", "+15550000291", "You added"], ["phone", "+15550000292", "You added"], ["email", "person-z@example.com", "You added"]]);

    await say([person("person-me-a", "+15550000261", { me: true })]);
    await say([person("person-me-a", "+15550000261", { me: false })]);
    await say([person("person-me-b", "+15550000262", { me: true })]);
    await say([person("person-me-a", "+15550000261", { me: true })]);
    expect([(await one("person:person-me-a")).me, (await one("person:person-me-b")).me]).toEqual([true, false]);

    await say([person("person-x", "+15550000271", { merged_into: "person-y" }), person("person-y", "+15550000272")]);
    await say([person("person-x", "+15550000271")]);
    await say([person("person-y", "+15550000272", { merged_into: "person-x" })]);
    await say([person("person-x", "+15550000271", { merged_into: "person-y" })]);
    expect((await one("person:person-y")).id).toBe("person:person-x");

    await say([person("person-q1", "+15550000281", { name: "Quinn" }), person("person-q2", "+15550000282", { name: "Quinn" })]);
    expect(kinds(await one("person:person-q1"))).toContain("same person-q2");

    await send(BOOK3, [card("FN:Person V Synthetic", "TEL:+15550000241", "TEL:+15550000242")]);
    await say([person("person-v1", "+15550000241"), person("person-v2", "+15550000242")]);
    expect(kinds(await one("person:person-v1"))).toContain("same person-v2");
    await say([person("person-v2", "+15550000242", { hidden: true })]);
    expect(kinds(await one("person:person-v1"))).not.toContain("same person-v2");

    const p = same(await one("person:person-p1"), "person-p2");
    expect(p).toBeDefined();
    await say([person("person-p1", "+15550000051", { name: "Person P", dismissed: [p.id] })]);
    expect([kinds(await one("person:person-p1")), kinds(await one("person:person-p2"))].flat().filter((each: string) => each.startsWith("same person-p"))).toEqual([]);

    await send(BOOK2, [card("FN:Person W Synthetic", "TEL:+15550000251"), card("FN:Person W Synthetic", "TEL:+15550000252")]);
    const w = same(await one("phone:+15550000251"), "phone:+15550000252");
    expect(w).toBeDefined();
    await say([person("person-w1", "+15550000251", { dismissed: [w.id] })]);
    expect(kinds(await one("phone:+15550000252")).filter((each: string) => each.startsWith("same "))).toEqual([]);
    await say([person("person-w2", "+15550000252")]);
    expect([kinds(await one("person:person-w1")), kinds(await one("person:person-w2"))].flat().filter((each: string) => each.startsWith("same "))).toEqual([]);
    report.word = await Promise.all(["person:person-u", "person:person-me-a", "person:person-x", "person:person-q1", "person:person-v1", "person:person-w1"].map(async (id) => {
      const answer = await one(id);
      return { id: answer.id, name: answer.name, by: answer.by, me: answer.me, handles: answer.handles, suggestions: answer.suggestions };
    }));
  });

  it("offers no service, an address by its name's first word and another, names across sources, and the first of each kind ticked", async () => {
    const suggested = (answer: Person, kind: string) => answer.suggestions.filter((suggestion: Person) => suggestion.kind === kind);
    await send(BOOK2, [
      card("FN:Alpha Tester", "TEL:+15550000401"), card("FN:Delta Synthetic", "TEL:+15550000402"), card("FN:Echo Middle Synthetic", "TEL:+15550000403"),
      card("FN:Golf Kilo Synthetic", "TEL:+15550000404"), card("FN:Foxtrot Synthetic", "TEL:+15550000405"), card("FN:Foxtrot Synthetic", "TEL:+15550000406"),
      card("FN:Hotel Synthetic", "TEL:+15550000407"), card("FN:India Synthetic", "TEL:+15550000408"), card("FN:Jules", "TEL:+15550000409"),
      card("FN:Lima Synthetic", "TEL:+15550000411"), card("FN:Mike Synthetic", "TEL:+15550000412"),
    ]);
    const me = "Person Me <person-me@example.com>";
    const mails = [
      mailRow("r1", T, "Alpha Tester <comments@relay.example.com>", me), mailRow("r2", T + MINUTE, "Bravo Tester <comments@relay.example.com>", me),
      mailRow("r3", T + 2 * MINUTE, "Charlie Tester <comments@relay.example.com>", me),
      mailRow("r4", T + 3 * MINUTE, me, "Relay <comments@relay.example.com>"), mailRow("r5", T + 4 * MINUTE, me, "comments@relay.example.com"),
      mailRow("i1", T, "Alpha Tester <invites-noreply@network.example.com>", me),
      mailRow("d1", T, "Delta Synthetic <ds@example.com>", me), mailRow("d2", T + MINUTE, "\"Synthetic, Delta\" <ds@example.com>", me),
      mailRow("d3", T + 2 * MINUTE, "Mrs Synthetic <ds@example.com>", me), mailRow("d4", T + 3 * MINUTE, "D. Synthetic <ds@example.com>", me),
      mailRow("ls1", T, "Lima Synthetic <ls@example.com>", me), mailRow("ls2", T + MINUTE, "Lim Synthetic <ls@example.com>", me),
      mailRow("ls3", T + 2 * MINUTE, "L. Synthetic <ls@example.com>", me), mailRow("ls4", T + 3 * MINUTE, "Mrs Synthetic <ls@example.com>", me),
      ...[0, 1, 2].map((n) => mailRow(`lm${n}`, T + n * MINUTE, "Mike Synthetic <letters@example.com>", me, ["List-Id: <letters.example.com>"])),
      mailRow("e1", T, "Echo Synthetic <es@example.com>", me), mailRow("e2", T, "Echo <echo.synthetic@example.com>", me), mailRow("e3", T + MINUTE, "Echo <echo.synthetic@example.com>", me),
      mailRow("g1", T, "synthetic.golf@example.com", me),
      mailRow("f1", T, "Foxtrot Synthetic <family@example.com>", me),
    ];
    await send(MAIL, mails.map((each) => each.row), Object.fromEntries(mails.map((each) => each.carried)));
    const EMOJI = "15550000410@s.whatsapp.net";
    await send(WHATSAPP, [pushName("15550000407@s.whatsapp.net", "+1 555 000 0499"), pushName(EMOJI, "🎉🎉"), pushName("15550000409@s.whatsapp.net", "Juliet Synthetic"),
      wa("EM1", EMOJI, T, { me: true }), wa("EM2", EMOJI, T + MINUTE, { me: true }), wa("EM3", EMOJI, T + 2 * MINUTE, { me: true })]);
    await say([{ kind: "person", key: "person-india-face", content: record("person-india-face", null, { name: "India Synthetic" }) },
      { kind: "person", key: "person-juliet-face", content: record("person-juliet-face", null, { name: "Juliet Synthetic" }) }]);

    const listed = new Set((await list()).people.map((person: Person) => person.id));
    expect(suggested(await one("phone:+15550000401"), "handle")).toEqual([]);
    expect([listed.has("email:comments@relay.example.com"), listed.has("email:invites-noreply@network.example.com")]).toEqual([false, false]);
    expect(await one("email:comments@relay.example.com")).toMatchObject({ mails_from: 3, mails_to: 2, names_seen: [], suggestions: [] });
    const judgedAs = async (id: string) => { const person = await one(id); return [person.entity, person.entity_by]; };
    expect([await judgedAs("email:comments@relay.example.com"), await judgedAs("email:invites-noreply@network.example.com")]).toEqual([["person", "home"], ["bot", "home"]]);
    expect((await one("email:ds@example.com")).names_seen).toHaveLength(4);
    expect(suggested(await one("phone:+15550000402"), "handle").map((each: Person) => [each.value, each.ticked])).toEqual([["email:ds@example.com", true]]);
    expect((await one("email:ls@example.com")).names_seen).toHaveLength(4);
    expect(suggested(await one("phone:+15550000411"), "handle").map((each: Person) => each.value)).toEqual(["email:ls@example.com"]);
    expect(suggested(await one("phone:+15550000412"), "handle")).toEqual([]);
    expect(await one("email:letters@example.com")).toMatchObject({ names_seen: [], suggestions: [], entity: "person" });
    expect(suggested(await one("phone:+15550000403"), "handle").map((each: Person) => [each.value, each.ticked]))
      .toEqual([["email:echo.synthetic@example.com", true], ["email:es@example.com", false]]);
    expect(kinds(await one("phone:+15550000404"))).toContain("handle email:synthetic.golf@example.com");
    expect([kinds(await one("phone:+15550000405")), kinds(await one("phone:+15550000406"))].map((each) => each.includes("handle email:family@example.com"))).toEqual([true, true]);
    expect(suggested(await one("phone:+15550000407"), "full_name")).toEqual([]);
    expect(await one("phone:+15550000410")).toMatchObject({ name: "+15550000410", by: "none" });
    expect(listed.has("phone:+15550000410")).toBe(true);
    const india = await one("person:person-india-face");
    expect(suggested(india, "same").map((each: Person) => [each.value, each.reasons, each.ticked])).toEqual([["phone:+15550000408", { linked: 0, named: 1, seen: 1 }, false]]);
    expect(kinds(await one("phone:+15550000408"))).toContain("same person-india-face");
    const juliet = await one("person:person-juliet-face");
    expect(suggested(juliet, "same").map((each: Person) => [each.value, each.reasons, each.ticked])).toEqual([["phone:+15550000409", { linked: 0, named: 0, seen: 1 }, false]]);
    expect(kinds(await one("phone:+15550000409"))).toContain("same person-juliet-face");

    await say([{ kind: "person", key: "person-foxtrot", content: record("person-foxtrot", ["phone", "+15550000405"], { handles: [{ kind: "email", value: "family@example.com" }] }) }]);
    expect((await one("email:family@example.com")).id).toBe("person:person-foxtrot");
    expect(kinds(await one("phone:+15550000406"))).not.toContain("handle email:family@example.com");
    const now = new Set((await list()).people.map((person: Person) => person.id));
    report.organise_rules = await Promise.all(["phone:+15550000401", "phone:+15550000402", "phone:+15550000403", "phone:+15550000404", "person:person-foxtrot", "phone:+15550000406",
      "phone:+15550000407", "phone:+15550000410", "person:person-india-face", "person:person-juliet-face", "email:comments@relay.example.com"].map(async (id) => {
      const answer = await one(id);
      return { id: answer.id, name: answer.name, by: answer.by, listed: now.has(answer.id), suggestions: answer.suggestions, names_seen: answer.names_seen };
    }));
  });

  it("shows the photo the owner stated, by the newest, faces on or off, until its picture goes", async () => {
    const sock = testSocket(root);
    const cases: Record<string, unknown>[] = [];
    const P = T + 3 * 86_400_000;
    const photoLine = (key: string, image: string, face?: string) => ({ kind: "photo", key, content: { type: "people.photo", image, ...(face === undefined ? {} : { face }) } });
    const land = async (made_ms: number, lines: object[], blobs: Buffer[], id: string, what: string) => {
      const folder = openHomeFolder(root);
      const carried = inboxLane(folder, PEOPLE);
      for (const blob of blobs) await carried.store(sha(blob).slice("sha256:".length), (async function* () { yield blob; })(), blob.length);
      await shipFiles(root, PEOPLE, made_ms, statements(lines));
      shipped++;
      await until("the home settled", calm);
      const person = await one(id);
      cases.push({ case: what, statements: lines, photo: person.photo });
      return { listed: ((await list()).people as Person[]).find((each) => each.id === person.id), person };
    };

    const pass = readPrincipals(openHomeFolder(root)).principals.find((each) => each.unit === PHONE_UNIT)!;
    expect(pass.sources).toContain(PEOPLE);

    const before = await one("person:person-p1");
    expect(before.photo).toEqual({ crop: crop("p1") });
    const SQUARE = jpeg("p1 upload", 1024);
    const p1 = await land(P, [photoLine("person:person-p1", sha(SQUARE))], [SQUARE], "person:person-p1", "an upload");
    expect([p1.listed?.photo, p1.person.photo]).toEqual([{ crop: sha(SQUARE) }, { crop: sha(SQUARE) }]);
    const served = await raw(`/v1/blobs/${sha(SQUARE)}`);
    expect([served.status, sha(served.body)]).toEqual([200, sha(SQUARE)]);
    expect((await get(`/v1/record?source=${encodeURIComponent(PEOPLE)}&kind=photo&key=${encodeURIComponent("person:person-p1")}`)).body!.blobs).toEqual([sha(SQUARE)]);

    const H = jpeg("person h", 640);
    await land(P + MINUTE, [photoLine("phone:+15550000101", sha(H))], [H], "phone:+15550000101", "a photo by a handle id");
    expect((await one("phone:+15550000101")).photo).toEqual({ crop: sha(H) });
    await say([{ kind: "person", key: "person-h", content: record("person-h", ["phone", "+15550000101"], { name: "Person H" }) }]);
    expect(await one("phone:+15550000101")).toMatchObject({ id: "person:person-h", photo: { crop: sha(H) } });

    const [Q1, Q2] = [jpeg("q1", 512), jpeg("q2", 512)];
    await land(P + 2 * MINUTE, [photoLine("person:person-q1", sha(Q1))], [Q1], "person:person-q1", "q1's photo");
    await land(P + 3 * MINUTE, [photoLine("person:person-q2", sha(Q2))], [Q2], "person:person-q2", "q2's photo, newer");
    await say([{ kind: "person", key: "person-q2", content: record("person-q2", ["phone", "+15550000282"], { name: "Quinn", merged_into: "person-q1" }) }]);
    expect((await one("person:person-q1")).photo).toEqual({ crop: sha(Q2) });
    const [MAC, OLD, HANDLE] = [jpeg("q mac", 900), jpeg("q phone old", 900), jpeg("q phone handle", 900)];
    await land(P + 10 * MINUTE, [photoLine("person:person-q1", sha(MAC))], [MAC], "person:person-q1", "a newer photo");
    await land(P + 8 * MINUTE, [photoLine("person:person-q1", sha(OLD))], [OLD], "person:person-q1", "an older photo, late");
    expect((await one("person:person-q1")).photo).toEqual({ crop: sha(MAC) });
    expect(readHome(root, (db) => db.prepare("SELECT late FROM statements WHERE source = ? AND kind = 'photo' AND key = ? ORDER BY seq DESC LIMIT 1").pluck().get(PEOPLE, "person:person-q1"))).toBe(1);
    await land(P + 9 * MINUTE, [photoLine("phone:+15550000281", sha(HANDLE))], [HANDLE], "person:person-q1", "an older photo by a handle");
    expect((await one("person:person-q1")).photo).toEqual({ crop: sha(MAC) });
    await land(P + 11 * MINUTE, [photoLine("phone:+15550000281", sha(HANDLE))], [HANDLE], "person:person-q1", "a picture chosen again");
    expect((await one("person:person-q1")).photo).toEqual({ crop: sha(HANDLE) });

    const { also_called: _called, ...shapeBefore } = record("person-before", ["phone", "+15550000521"], { name: "Person Before" });
    await say([{ kind: "person", key: "person-before", content: { ...shapeBefore, photo: faceOf("p2") } }]);
    const shaped = await one("person:person-before");
    expect([shaped.photo, Object.hasOwn(shaped.record, "photo")]).toEqual([null, false]);

    const [G1, G_CARD] = [jpeg("g1 crop", 160), Buffer.from("synthetic jpeg bytes of person g's card")];
    await send(BOOK2, [card("FN:Person G", "TEL:+15550000501", `PHOTO;ENCODING=b;TYPE=JPEG:${G_CARD.toString("base64")}`)]);
    await say([{ kind: "person", key: "person-g", content: record("person-g", ["phone", "+15550000501"], { name: "Person G" }) }]);
    await send(FACES, [{ kind: "named", key: "person-g", blobs: [sha(G1)], content: { photos: [{ face: faceOf("g1"), at_ms: T, camera: false, crop: sha(G1), tier: "seed", size: 40 }], labels: [] } }],
      { [sha(G1).slice("sha256:".length)]: G1 });
    expect((await one("person:person-g")).photo).toEqual({ card: sha(G_CARD) });
    await land(P + 12 * MINUTE, [photoLine("person:person-g", sha(G1), faceOf("g1"))], [], "person:person-g", "a face picked");
    expect((await one("person:person-g")).photo).toEqual({ crop: sha(G1) });
    expect((await get(`/v1/record?source=${encodeURIComponent(PEOPLE)}&kind=photo&key=${encodeURIComponent("person:person-g")}`)).body!.blobs).toEqual([]);

    await askHome(sock, "faces", ["off"]);
    await until("the home settled", calm);
    expect([(await one("person:person-p1")).photo, (await one("person:person-g")).photo]).toEqual([{ crop: sha(SQUARE) }, { crop: sha(G1) }]);

    await askHome(sock, "faces", ["forget"]);
    await until("the home settled", calm);
    expect((await raw(`/v1/blobs/${sha(G1)}`)).status).toBe(404);
    expect((await one("person:person-g")).photo).toEqual({ card: sha(G_CARD) });
    const G2 = jpeg("g upload", 300);
    await land(P + 30 * MINUTE, [photoLine("person:person-g", sha(G2))], [G2], "person:person-g", "a photo after the face went");
    expect((await one("person:person-g")).photo).toEqual({ crop: sha(G2) });
    expect(Object.hasOwn(await list(), "landed")).toBe(false);
    report.photo = { cases };
  });

  it("shows a person's details by the newest among their ids, whole, and offers no card's work the details say", async () => {
    const D = T + 4 * 86_400_000;
    const detailsLine = (key: string, more: Record<string, unknown> = {}) => ({ kind: "details", key, content: { type: "people.details", work: null, birthday: null, profiles: [], ...more } });
    const put = async (made_ms: number, lines: object[]) => {
      await shipFiles(root, PEOPLE, made_ms, statements(lines));
      shipped++;
      await until("the home settled", calm);
    };
    const work = async (id: string) => ((await list()).people as Person[]).find((each) => each.id === id);

    const listed = await list();
    for (const member of ["zone", "day_start_hour"]) expect(listed).not.toHaveProperty(member);

    expect(Object.hasOwn(await one("person:person-p1"), "details")).toBe(false);
    expect(((await list()).people as Person[]).some((each) => Object.hasOwn(each, "work"))).toBe(false);

    const p1 = { work: "Product designer, Synthetic Labs", birthday: { month: 8, day: 14, year: null }, profiles: [{ network: "instagram", value: "person.p" }, { network: "site", value: "person-p.example.com" }] };
    await put(D, [detailsLine("person:person-p1", p1)]);
    expect((await one("phone:+15550000051")).details).toEqual(p1);
    expect((await work("person:person-p1"))?.work).toBe(p1.work);
    await put(D + MINUTE, [detailsLine("person:person-p1")]);
    expect((await one("person:person-p1")).details).toEqual({ work: null, birthday: null, profiles: [] });
    expect(Object.hasOwn((await work("person:person-p1"))!, "work")).toBe(false);

    const q1 = { work: "Engineer, Synthetic Works", birthday: { month: 3, day: 5, year: 1990 }, profiles: [] };
    const q2 = { work: "Synthetic Two", birthday: { month: 7, day: 9, year: null }, profiles: [{ network: "github", value: "quinn-two" }] };
    await put(D + 2 * MINUTE, [detailsLine("person:person-q1", q1)]);
    await put(D + 3 * MINUTE, [detailsLine("person:person-q2", q2)]);
    expect((await one("person:person-q1")).details).toEqual({ ...q1, profiles: q2.profiles });
    expect((await work("person:person-q1"))?.work).toBe(q1.work);
    await put(D + 3 * MINUTE + 1, [detailsLine("person:person-q1", { ...q1, birthday: null, cleared: ["birthday"] })]);
    expect((await one("person:person-q1")).details).toEqual({ ...q1, birthday: null, profiles: q2.profiles });
    await put(D + 4 * MINUTE, [detailsLine("phone:+15550000121", { work: "Synthetic Kitchens" })]);
    expect((await one("phone:+15550000121")).details).toMatchObject({ work: "Synthetic Kitchens" });
    await say([{ kind: "person", key: "person-k", content: record("person-k", ["phone", "+15550000121"], { name: "Person K" }) }]);
    expect(await one("phone:+15550000121")).toMatchObject({ id: "person:person-k", details: { work: "Synthetic Kitchens" } });
    await put(D + 5 * MINUTE, [{ kind: "details", key: "phone:+15550000121", gone: true }]);
    expect(Object.hasOwn(await one("person:person-k"), "details")).toBe(false);

    await send(BOOK2, [card("N:Synthetic;Person T;;;", "FN:Person T Synthetic", "TEL:+15550000531", "TITLE:Product designer", "ORG:Synthetic Labs")]);
    const offered = async () => (await one("phone:+15550000531")).suggestions.filter((each: Person) => each.kind === "work").map((each: Person) => [each.value, each.reasons, each.ticked]);
    expect(await offered()).toEqual([["Product designer, Synthetic Labs", { cards: 1 }, true]]);
    await put(D + 6 * MINUTE, [detailsLine("phone:+15550000531", { work: "Product designer, Synthetic Labs" })]);
    expect(await offered()).toEqual([]);

    report.details = { p1: await one("person:person-p1"), q1: (await one("person:person-q1")).details };
  });

  it("shows a phone contact's photo blob and follows it as it changes, names one whose bytes came later only once they came, tells one identifier in two address books apart, and lets a contact go", async () => {
    const id = "P0000000-0000-4000-8000-000000000001:ABPerson";
    const text = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Person Phone\r\nTEL:+15550000601\r\nEND:VCARD\r\n";
    const [first, second] = [jpeg("phone contact first", 4), jpeg("phone contact second", 4)];
    const contact = (bytes: Buffer) => ({
      kind: "contact", key: id, blobs: [sha(bytes)],
      content: { type: "contacts.card", card: text, photo: { hash: sha(bytes), bytes: bytes.length, media_type: "image/jpeg" } },
    });
    const served = async (bytes: Buffer) => {
      const read = await raw(`/v1/people/card?hash=${sha(bytes)}`);
      return [read.status, read.status === 200 ? read.headers["content-type"] : null, read.status === 200 ? sha(read.body) : null];
    };
    await send(BOOK1, [contact(first)], { [sha(first).slice("sha256:".length)]: first });
    expect((await one("phone:+15550000601")).photo).toEqual({ card: sha(first) });
    expect(await served(first)).toEqual([200, "image/jpeg", sha(first)]);
    await send(BOOK1, [contact(second)], { [sha(second).slice("sha256:".length)]: second });
    expect((await one("phone:+15550000601")).photo).toEqual({ card: sha(second) });
    expect([await served(second), (await served(first))[0]]).toEqual([[200, "image/jpeg", sha(second)], 404]);

    const late = jpeg("phone contact late", 4);
    await send(BOOK1, [{
      kind: "contact", key: "P0000000-0000-4000-8000-000000000003:ABPerson", blobs: [sha(late)],
      content: { type: "contacts.card", card: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Person Late\r\nTEL:+15550000602\r\nEND:VCARD\r\n", photo: { hash: sha(late), bytes: late.length, media_type: "image/jpeg" } },
    }]);
    expect(await one("phone:+15550000602")).toMatchObject({ name: "Person Late", photo: null });
    await send(MAIL, [{ kind: "scan", key: "late-photo", blobs: [sha(late)], content: {} }], { [sha(late).slice("sha256:".length)]: late });
    expect((await one("phone:+15550000602")).photo).toEqual({ card: sha(late) });
    expect(await served(late)).toEqual([200, "image/jpeg", sha(late)]);

    const shared = "P0000000-0000-4000-8000-000000000002:ABPerson";
    const named = (name: string) => ({ kind: "contact", key: shared, content: { type: "contacts.card", card: `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nEND:VCARD\r\n` } });
    await send(BOOK2, [named("Person Twin One")]);
    await send(BOOK3, [named("Person Twin Two")]);
    const twins = [BOOK2, BOOK3].map((source) => contactPersonId({ id: contactId({ source, key: shared }) }));
    expect(new Set(twins).size).toBe(2);
    expect(await Promise.all(twins.map(async (twin) => (await one(twin)).name))).toEqual(["Person Twin One", "Person Twin Two"]);

    await send(BOOK1, [{ kind: "contact", key: id, gone: true }]);
    expect((await get(`/v1/people?id=${encodeURIComponent("phone:+15550000601")}`)).status).toBe(404);
    report.phone_contact = { twins, photo: sha(second) };
  });

  it("names each person on a photo once, with the box of their face, left to right, and still serves each face of them", async () => {
    await askHome(testSocket(root), "connectors", ["on", "faces"]);
    await until("the home settled", calm);
    const duo = photo("duo");
    const face = (box: number[], name: string) => ({ face: `${duo}:${box.join(",")}`, at_ms: T, camera: true, crop: crop(name), tier: "seed", size: 40 });
    const [right, left, leftmost] = [[1000, 10, 1050, 60], [300, 10, 350, 60], [10, 10, 60, 60]];
    await say([{ kind: "person", key: "person-x", content: record("person-x", ["phone", "+15550000181"], { name: "Person X" }) },
      { kind: "person", key: "person-y", content: record("person-y", ["phone", "+15550000182"], { name: "Person Y" }) }]);
    await send(FACES, [
      { kind: "named", key: "person-x", content: { labels: [], photos: [face(right, "x-right"), face(left, "x-left")] } },
      { kind: "named", key: "person-y", content: { labels: [], photos: [face(leftmost, "y")] } },
      { kind: "scan", key: duo, content: { pipeline: "0".repeat(64), status: "ok", width: 1200, height: 800, faces: [], vectors: null } },
    ]);
    const file = preparedFileOf(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "people"), "people");
    const row = readPrepared(openHomeFolder(dirname(file)), file, PEOPLE_FILE.format, (read) => read.value<{ size: unknown; people: { id: string; box: number[] | null }[] }>("image", duo))!.value;
    expect(row).toEqual({ size: { width: 1200, height: 800 }, people: [{ id: "person:person-y", box: leftmost }, { id: "person:person-x", box: left }] });
    const photos = await get(`/v1/people/photos?id=${encodeURIComponent("person:person-x")}`);
    expect(photos.body!.photos.map((each: Person) => each.face).sort()).toEqual([`${duo}:${right.join(",")}`, `${duo}:${left.join(",")}`].sort());
    report.image = row;
  });

  it("states the name table hiding reads: every person, their names, accounts and kind, every assistant the ai family speaks as, and the owner; a new version only when one of those moves", async () => {
    const file = preparedFileOf(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "people"), "people");
    await say([{ kind: "person", key: "person-ada", content: record("person-ada", ["phone", "+15550000191"], { name: "Ada", full_name: "Ada Example" }) },
      { kind: "person", key: "person-bea", content: record("person-bea", ["phone", "+15550000192"], { name: "Bea Gym" }) },
      { kind: "person", key: "person-cy", content: record("person-cy", ["phone", "+15550000193"], { name: "Cy Example" }) }]);
    await send(WHATSAPP, [wa("NT0", "15550000191@s.whatsapp.net", T + 20 * MINUTE), wa("NT0b", "15550000192@s.whatsapp.net", T + 21 * MINUTE)]);
    const table = readNameTable(openHomeFolder(dirname(file)), file)!;
    expect(readNameTable(openHomeFolder(dirname(file)), file)).toBe(table);
    expect(readNameTable(openHomeFolder(dirname(file)), file, table.version)).toBe("same");
    expect(readNameTable(openHomeFolder(dirname(file)), file, "people-0")).toBe(table);
    const of = (who: string) => table.people.find((person) => person.who === who);
    expect(of("person:person-ada")).toEqual({ who: "person:person-ada", is: "human", shown: "Ada", names: ["Ada Example", "Ada"], accounts: ["+15550000191"] });
    expect(of("person:person-bea")).toMatchObject({ names: ["Bea Gym", "Bea"] });
    expect(of("person:person-cy")).toMatchObject({ names: ["Cy Example"] });
    expect(of("person:person-x")).toMatchObject({ accounts: ["+15550000181"] });
    expect(of("person:person-x")!.names).not.toContain("X");
    expect(of(`jid:${G_LID}`)).toEqual({ who: `jid:${G_LID}`, is: "human", shown: "unknown lid …00032", names: [], accounts: [G_LID] });
    const owner = await one("person:person-me-a");
    expect(owner.me).toBe(true);
    expect(table.owner).toEqual({ who: owner.id, shown: owner.name });
    expect(of(owner.id)).toBeDefined();
    expect(of("assistant:claude")).toEqual({ who: "assistant:claude", is: "bot", shown: "Claude", names: ["Claude"], accounts: [] });
    expect(["ask", "chatgpt", "claude-code", "codex"].map((product) => of(`assistant:${product}`)?.is)).toEqual(["bot", "bot", "bot", "bot"]);

    await send(WHATSAPP, [wa("NT1", "15550000191@s.whatsapp.net", T + 30 * MINUTE)]);
    expect(readNameTable(openHomeFolder(dirname(file)), file)).toEqual(table);
    await send(WHATSAPP, [wa("NT2", "15550000193@s.whatsapp.net", T + 31 * MINUTE)]);
    const talked = readNameTable(openHomeFolder(dirname(file)), file)!;
    expect(talked.version).not.toBe(table.version);
    expect(talked.people.find((person) => person.who === "person:person-cy")).toMatchObject({ names: ["Cy Example", "Cy"] });
    await say([{ kind: "person", key: "person-bakery", content: record("person-bakery", ["phone", "+15550000131"], { name: "Synthetic Bakery", entity: "business" }) }]);
    const moved = readNameTable(openHomeFolder(dirname(file)), file)!;
    expect(moved.version).not.toBe(talked.version);
    expect(readNameTable(openHomeFolder(dirname(file)), file, talked.version)).toBe(moved);
    expect(moved.people.find((person) => person.who === "person:person-bakery")).toMatchObject({ is: "business", shown: "Synthetic Bakery" });
    report.name_table = { version: moved.version, owner: moved.owner, people: moved.people.length };
  });

  it("says in search_people's same the persons likely one human, by the signal, and a search by both finds what each holds", async () => {
    const refOf = async (id: string) => {
      const person = await one(id);
      return personRef({ id: person.id, handles: person.handles.map((handle: Person) => handle.id) });
    };
    const sameOf = async (id: string) => {
      const answer = await get(`/v1/people/search?id=${encodeURIComponent(await refOf(id))}`);
      expect(answer.status, id).toBe(200);
      return answer.body!.matches[0].same;
    };
    const WHY = { sender: "the same full name, as a sender or a chat gave it", face: "a face named with a name of the other's", name: "the same full name" };
    const same = async (id: string, by: keyof typeof WHY) => [{ ref: await refOf(id), why: WHY[by] }];
    expect(await sameOf("phone:+15550000402")).toEqual(await same("email:ds@example.com", "sender"));
    expect(await sameOf("email:ds@example.com")).toEqual(await same("phone:+15550000402", "sender"));
    expect(await sameOf("phone:+15550000411")).toEqual(await same("email:ls@example.com", "sender"));
    expect(await sameOf("person:person-india-face")).toEqual(await same("phone:+15550000408", "face"));
    expect(await sameOf("phone:+15550000409")).toEqual(await same("person:person-juliet-face", "face"));
    expect(await sameOf("phone:+15550000406")).toEqual(await same("person:person-foxtrot", "name"));
    for (const id of ["phone:+15550000403", "phone:+15550000401", "phone:+15550000412"]) expect(await sameOf(id), id).toBeUndefined();
    await send(WHATSAPP, [wa("SM1", "15550000402@s.whatsapp.net", T + 40 * MINUTE)]);
    const families = async (...persons: string[]) => {
      const found = await get(`/v1/search?lists=record&${persons.map((each) => `person=${encodeURIComponent(each)}`).join("&")}&limit=50`);
      expect(found.status, persons.join()).toBe(200);
      return found.body!.record.hits.map((hit: { family: string }) => hit.family).sort();
    };
    const [card, address] = [await families("phone:+15550000402"), await families("email:ds@example.com")];
    expect([card.includes("messages"), card.includes("mail"), address.length > 0 && address.every((family: string) => family === "mail")]).toEqual([true, false, true]);
    expect(await families("phone:+15550000402", "email:ds@example.com")).toEqual([...card, ...address].sort());
  });
});

describe("You through the door", () => {
  const FIXTURE = join(REPO, "packages", "home", "test", "people-you.json");
  const OWN_WHATSAPP = "whatsapp:15550000001:iphone-aa01";
  const OWN_IMESSAGE = "imessage:+15550000001:macbook-pro-0001";
  const OWN_MAIL = "gmail:sam@example.com:cloud";
  const RILEY = "15550000021@s.whatsapp.net";

  it("serves You beside the list and by `me`, every person's Also called and Joined in, and the name table's owner, as the contract fixture holds them", async () => {
    const root = makeRoot("lifestream-people-you-", { sources: { [BOOK1]: "people-rows", [PEOPLE]: "people-home" }, settings: { unit: UNIT, "day.zone": ZONE } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: () => undefined, registry: REGISTRY });
    editSettings(root, { "door.port": door.port });
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
    const sock = testSocket(root);
    const file = preparedFileOf(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "people"), "people");
    let shipped = 0;
    const calm = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() === shipped
      && db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get() === 0 && db.prepare("SELECT count(*) FROM dirty_days").pluck().get() === 0);
    const send = async (source: string, rows: object[], carried?: Record<string, Buffer>) => {
      const made = readHome(root, (db) => db.prepare("SELECT count(*) FROM sources WHERE id = ?").pluck().get(source)) === 0;
      await ship(root, {
        source, fetched_ms: T + shipped * MINUTE, rows: rows as never, ...(carried === undefined ? {} : { carried }),
        ...(made ? { facts: { sources: [{ id: source, connector: "people-rows" }] } } : {}),
      });
      shipped++;
      await until("the home settled", calm);
    };
    const say = async (lines: object[]) => {
      await shipFiles(root, PEOPLE, T + shipped * MINUTE, statements(lines));
      shipped++;
      await until("the home settled", calm);
    };
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${door.port}${path}`, { headers: { authorization: `Bearer ${READER}` } });
      const { position: _position, ...body } = await response.json() as Record<string, any>;
      return { status: response.status, body };
    };
    const one = async (id: string): Promise<Person> => (await get(`/v1/people?id=${encodeURIComponent(id)}`)).body.person;
    const found = async (q: string) => (await get(`/v1/people?q=${encodeURIComponent(q)}`)).body.people.map((person: Person) => [person.id, person.me]);
    const setupYou = async () => ((await askHome(sock, "connectors", ["--unit", UNIT])) as { setup: { you: boolean } | null }).setup?.you;
    const person = (slug: string, anchor: [string, string] | null, more: Record<string, unknown> = {}) => ({ kind: "person", key: slug, content: record(slug, anchor, more) });
    const detailsLine = (key: string, more: Record<string, unknown>) => ({ kind: "details", key, content: { type: "people.details", work: null, birthday: null, profiles: [], ...more } });
    try {
      await send(BOOK1, [card("FN:Synthetic Bakery Staff", "TEL:+15550000099")]);
      await until("People prepared", async () => (await get("/v1/people")).status === 200);
      expect((await get("/v1/people")).body.you).toBeNull();
      expect([(await get("/v1/people?id=me")).status, (await get("/v1/people?id=me")).body.code]).toEqual([404, "PERSON_UNKNOWN"]);
      expect(await setupYou()).toBe(false);

      await say([person("sam-example", null, { name: "Sam", full_name: "Sam Example", me: true, also_called: ["Sammy"] })]);
      expect(await setupYou()).toBe(true);
      expect(await one("me")).toMatchObject({ id: "person:sam-example", me: true, handles: [], received: 0, sent: 0 });
      const first = readNameTable(openHomeFolder(dirname(file)), file)!;
      expect(first.owner).toEqual({ who: "person:sam-example", shown: "Sam" });
      expect(first.people.find((each) => each.who === "person:sam-example")).toMatchObject({ names: ["Sam Example", "Sam", "Sammy"] });

      await send(OWN_WHATSAPP, [wa("RY1", RILEY, T), wa("RY2", RILEY, T + MINUTE, { me: true }), wa("RY3", RILEY, T + 2 * MINUTE)]);
      await send(OWN_IMESSAGE, [imessage("GUID-RY", "+15550000021", T + 3 * MINUTE)]);
      const signed = mailRow("sx1", T + 4 * MINUTE, "Sam Example <sam.example@example.org>", "sam@example.com");
      await send(OWN_MAIL, [signed.row], Object.fromEntries([signed.carried]));
      await send(BOOK1, [card("FN:Riley Example", "NICKNAME:Bear", "TEL:+15550000021", "TEL:+15550000024"),
        card("FN:Riley Work", "EMAIL:riley@work.example", "TEL:+15550000022", "TEL:+15550000024")]);
      await say([person("sam-phone", ["phone", "+15550000001"], { merged_into: "sam-example" }), person("sam-b", ["phone", "+15550000009"], { full_name: "Sam Example" }),
        person("riley", ["phone", "+15550000021"], { name: "Riley", full_name: "Riley Example", also_called: ["Big Riley"], excluded: [{ kind: "phone", value: "+15550000022" }] })]);
      await say([person("riley-work", ["email", "riley@work.example"], { merged_into: "riley" })]);
      await say([person("riley-old", ["phone", "+15550000023"], { name: "Riley Old", merged_into: "riley-work" })]);
      await say([detailsLine("person:riley", { work: "Synthetic Works" })]);
      await say([detailsLine("email:riley@work.example", { work: "Other Works", birthday: { month: 2, day: 3, year: null } })]);

      const list = (await get("/v1/people")).body;
      const you = list.you as Person;
      expect(you).toMatchObject({ id: "person:sam-example", me: true, also_called: [{ name: "Sammy", from: "You added" }], suggested: 2 });
      expect(you.handles.map((handle: Person) => [handle.id, handle.from, handle.own])).toEqual([
        ["phone:+15550000001", "Your iMessage and WhatsApp", true], ["email:sam@example.com", "Your Gmail", true],
      ]);
      expect(list.people.map((each: Person) => each.id)).not.toContain("person:sam-example");
      expect(list.organise.queue).not.toContain("person:sam-example");
      expect(list.organise.organised).toBe(2);
      const me = await one("me");
      expect(me.suggestions.map((each: Person) => `${each.kind} ${each.value}`)).toEqual(expect.arrayContaining(["handle email:sam.example@example.org", "same sam-b"]));
      expect(me.joined).toEqual([]);
      expect(await found("sam")).toContainEqual(["person:sam-example", true]);
      expect(await found("sammy")).toEqual([["person:sam-example", true]]);

      const riley = await one("person:riley");
      expect(riley.also_called).toEqual([{ name: "Big Riley", from: "You added" }, { name: "Bear", from: "Contacts" }]);
      expect(riley.names_seen.filter((name: string) => ["bear", "big riley"].includes(name.toLowerCase()))).toEqual([]);
      expect(await found("bear")).toEqual([["person:riley", false]]);
      expect(riley.joined).toEqual([
        { id: "person:riley-work", name: "Riley Work", photo: null, handles: ["phone:+15550000022", "phone:+15550000023", "email:riley@work.example"], with: ["Riley Old"] },
        { id: "person:riley-old", name: "Riley Old", photo: null, handles: ["phone:+15550000023"], with: [] },
      ]);
      expect(riley.details).toEqual({ work: "Synthetic Works", birthday: { month: 2, day: 3, year: null }, profiles: [] });
      expect(list.people.find((each: Person) => each.id === "person:riley")?.work).toBe("Synthetic Works");

      const table = readNameTable(openHomeFolder(dirname(file)), file)!;
      expect(table.owner).toEqual({ who: "person:sam-example", shown: "Sam" });
      expect(table.people.find((each) => each.who === "person:sam-example")).toMatchObject({ names: ["Sam Example", "Sam", "Sammy"] });
      expect(table.people.find((each) => each.who === "person:riley")).toMatchObject({ names: ["Riley Example", "Big Riley", "Riley", "Bear"] });

      const served = { you, me, person: riley };
      mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
      writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "people-you.json"), `${JSON.stringify(served, null, 2)}\n`);
      expect(served).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
    } finally {
      await door.close();
      await home.stop().catch(() => undefined);
      removeRoot(root);
    }
  });
});

describe("People before the home's first run", () => {
  it("answers 503 NOT_NOW, Retry-After 2, for the list, a person, their photos and a card photo", async () => {
    const root = makeRoot("lifestream-people-new-", { sources: {}, settings: { unit: UNIT } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 20 }, { lookMs: LOOK_MS, log: () => undefined, registry: REGISTRY });
    try {
      for (const path of ["/v1/people", "/v1/people?id=person:person-a", "/v1/people?q=person", "/v1/people/photos?id=person:person-a", `/v1/people/card?hash=sha256:${"0".repeat(64)}`]) {
        const response = await fetch(`http://127.0.0.1:${door.port}${path}`, { headers: { authorization: `Bearer ${READER}` } });
        expect([response.status, response.headers.get("retry-after"), ((await response.json()) as { code: string }).code], path).toEqual([503, "2", "NOT_NOW"]);
      }
    } finally {
      await door.close();
      removeRoot(root);
    }
  });
});

describe("Groups through the door", () => {
  const GROUPS_REGISTRY = join(REPO, "packages", "home", "test", "groups-registry.ts");
  const FRIENDS = "120363000000000021@g.us";
  const SHOP = "120363000000000022@g.us";
  const LEFT = "120363000000000023@g.us";
  const NEW = "120363000000000024@g.us";
  const F = "15550000041@s.whatsapp.net";
  const S = "15550000042@s.whatsapp.net";
  const M = "15550000043@s.whatsapp.net";
  const NOW_DAY = "2026-09-15";
  const key = (chat: string) => `whatsapp:${chat}`;
  const on = (day: string, stanza: string, chat: string, from: { me?: true; member?: string; jid?: string } = {}) => wa(stanza, chat, at(`${day}T10:00:00`), from);
  const group = (chat: string, partner: string, archived = false) => ({ kind: "chat", key: chat, content: { type: "whatsapp.chat", group_info: null,
    chat: { ZCONTACTJID: chat, ZCONTACTIDENTIFIER: null, ZPARTNERNAME: partner, ZSESSIONTYPE: 1, ZARCHIVED: archived ? 1 : 0 } } });
  const shopDays = Array.from({ length: 30 }, (_, n) => new Date(Date.parse(`${NOW_DAY}T00:00:00Z`) - (29 - n) * 86_400_000).toISOString().slice(0, 10));
  const DATA_DAYS = new Set(["2026-06-07", ...shopDays]);

  let root: string;
  let home: Home;
  let door: Door;
  let url: string;
  const report: Record<string, unknown> = {};

  const settled = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state IN ('sealed', 'importing')").pluck().get() === 0
    && db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get() === 0 && db.prepare("SELECT count(*) FROM dirty_days").pluck().get() === 0);
  const settledBut = (kind: string, jobKey?: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state IN ('sealed', 'importing')").pluck().get() === 0
    && db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running') AND NOT (kind = ? AND (? IS NULL OR key = ?))").pluck().get(kind, jobKey ?? null, jobKey ?? null) === 0);
  let shipped = 0;
  const send = async (rows: object[]) => {
    const made = readHome(root, (db) => db.prepare("SELECT count(*) FROM sources WHERE id = ?").pluck().get(WHATSAPP)) === 0;
    await ship(root, { source: WHATSAPP, fetched_ms: T + ++shipped * MINUTE, rows: rows as never, ...(made ? { facts: { sources: [{ id: WHATSAPP, connector: "people-rows" }] } } : {}) });
  };
  const get = async (path: string) => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READER}` } });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) as Record<string, any> };
  };
  const act = async (action: Record<string, unknown>) => {
    const response = await fetch(`${url}/v1/owner/act`, { method: "POST", headers: { authorization: `Bearer ${DASHBOARD}`, "content-type": "application/json" }, body: JSON.stringify({ of: "people", ...action }) });
    return { status: response.status, body: JSON.parse(await response.text()) as Record<string, any> };
  };
  const list = async () => (await get("/v1/people")).body!;
  const chats = async () => Object.fromEntries(((await list()).chats as Person[]).map((chat) => [chat.key, chat]));
  const stream = async () => ((await get("/v1/connectors")).body!.connectors as Person[]).find((each) => each.id === "whatsapp")!;
  const person = async (jid: string) => {
    const answer = await get(`/v1/people?id=${encodeURIComponent(`phone:+${jid.split("@")[0]}`)}`);
    return answer.status === 200 ? answer.body!.person as Person : null;
  };
  const day = (which: string) => readFileSync(join(root, "days", `${which}.day.txt`), "utf8");
  const set = (member: string, value: string) => askHome(testSocket(root), "connectors", ["set", "whatsapp", member, value]);

  beforeAll(async () => {
    root = makeRoot("lifestream-groups-", { sources: { [PEOPLE]: "people-home", [BOOK1]: "people-rows" }, settings: { unit: UNIT, "day.zone": ZONE } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    mintPrincipal(openHomeFolder(root), { unit: `dashboard-${UNIT}`, scopes: ["read", "deliver"], sources: [PEOPLE], token: DASHBOARD, now_ms: 0 });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: GROUPS_REGISTRY, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: () => undefined, registry: GROUPS_REGISTRY });
    url = `http://127.0.0.1:${door.port}`;
    await ship(root, { source: BOOK1, fetched_ms: T, rows: [card("FN:Person F", "TEL:+15550000041"), card("FN:Shop Sender", "TEL:+15550000042"), card("FN:Person M", "TEL:+15550000043")] as never });
    await send([
      group(FRIENDS, "Group Friends"), group(SHOP, "Group Shop", true), group(LEFT, "Group Left"), shell(F, "Person F"),
      on("2026-08-26", "fr1", FRIENDS, { me: true }), on("2026-09-15", "fr2", FRIENDS, { me: true }),
      ...["2026-08-26", "2026-09-05", "2026-09-15"].map((each) => on(each, `fr-f-${each}`, FRIENDS, { member: F })),
      ...shopDays.map((each) => on(each, `shop-${each}`, SHOP, { member: S })),
      on("2026-06-07", "left1", LEFT, { me: true }), on("2026-06-07", "left-f", LEFT, { member: F }), on("2026-06-07", "left-m", LEFT, { member: M }),
      on("2026-09-10", "f1", F, { me: true }), on("2026-09-10", "f2", F),
    ]);
    await until("the shop's group folded in its day", () => settled() && (() => {
      try { return day(NOW_DAY).includes("You were quiet in"); } catch { return false; }
    })());
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "groups.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (typeof report.day === "string") writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "groups-day.txt"), report.day);
    if (root !== undefined) removeRoot(root);
  });

  it("serves the chats in the Groups view's order, a person's in their page's, quiet and word on groups alone, and folds the quiet group in its day", async () => {
    const served = await list();
    expect((served.chats as Person[]).map((chat) => chat.key)).toEqual([key(FRIENDS), key(F), key(SHOP), key(LEFT)]);
    const byKey = Object.fromEntries((served.chats as Person[]).map((chat) => [chat.key, chat]));
    expect([byKey[key(FRIENDS)].quiet, byKey[key(FRIENDS)].word]).toEqual([null, null]);
    expect([byKey[key(SHOP)].quiet, byKey[key(SHOP)].word]).toEqual([{ why: "archived", last_day: null }, null]);
    expect([byKey[key(LEFT)].quiet, byKey[key(LEFT)].word]).toEqual([{ why: "silent", last_day: "2026-06-07" }, null]);
    expect(Object.keys(byKey[key(F)])).not.toContain("quiet");
    expect(Object.keys(byKey[key(F)])).not.toContain("word");
    expect(served).not.toHaveProperty("quiet");
    const whatsapp = await stream();
    expect(whatsapp.quiet).toBe(2);
    expect((whatsapp.members as Person[]).filter((member) => member.key.startsWith("groups_")).map((member) => [member.key, member.panel]))
      .toEqual([["groups_archived", "groups"], ["groups_quiet_after", "groups"], ["groups_talk", "groups"]]);
    const f = (await person(F))!;
    expect(f.chats.map((chat: Person) => chat.key)).toEqual([key(F), key(FRIENDS), key(LEFT)]);
    expect(f.received).toBe(4);
    expect(f.days).toEqual({ "2026-06-07": 1, "2026-08-26": 1, "2026-09-10": 2, "2026-09-15": 1 });
    expect((await person(S))?.received ?? 0).toBe(0);
    const text = day(NOW_DAY);
    expect(text).toContain("You were quiet in");
    expect(text).toContain("  Group Shop · 1 message");
    expect(text).not.toContain(`synthetic line shop-${NOW_DAY}`);
    expect(text).toContain("synthetic line fr2");
    const shop = (await get(`/v1/conversation?${new URLSearchParams({ chat: key(SHOP), day: NOW_DAY })}`)).body!;
    const [, sender] = ((await get(`/v1/labels?${new URLSearchParams({ id: S })}`)).body!.names as [string, string][])[0]!;
    expect([shop.title, shop.atoms.map((atom: Person) => atom.text), shop.atoms.map((atom: Person) => atom.block)])
      .toEqual(["Group Shop", [`${sender}: synthetic line shop-${NOW_DAY}`], [{ key: key(SHOP), title: "Group Shop" }]]);
    report.after = { chats: served.chats, quiet: whatsapp.quiet, people: (served.people as Person[]).map(({ id, name, received, last_ms, score }) => ({ id, name, received, last_ms, score })) };
    report.day = text;
  });

  it("the group act lands its word, Undo takes it back, and a one-to-one chat takes none", async () => {
    const never = await act({ kind: "group", request: randomUUID(), chat: key(SHOP), quiet: false });
    expect(never.status).toBe(200);
    await until("the shop's group is yours by the word", async () => settled() && (await chats())[key(SHOP)]?.word === false && day(NOW_DAY).includes(`synthetic line shop-${NOW_DAY}`));
    expect((await chats())[key(SHOP)].quiet).toBeNull();
    const record = await get(`/v1/record?${new URLSearchParams({ source: PEOPLE, kind: "group", key: key(SHOP) })}`);
    expect(record.body?.version?.content).toEqual({ quiet: false });
    expect(day(NOW_DAY)).not.toContain("Group Shop · 1 message");
    const undone = await act({ kind: "undo", request: randomUUID(), act: never.body.act });
    expect(undone.status).toBe(200);
    await until("the word undone", async () => settled() && (await chats())[key(SHOP)]?.word === null && day(NOW_DAY).includes("Group Shop · 1 message"));
    expect((await chats())[key(SHOP)].quiet).toEqual({ why: "archived", last_day: null });
    const gone = await get(`/v1/record?${new URLSearchParams({ source: PEOPLE, kind: "group", key: key(SHOP) })}`);
    expect(gone.status === 200 ? gone.body?.version?.content ?? null : null).toBeNull();
    const always = await act({ kind: "group", request: randomUUID(), chat: key(FRIENDS), quiet: true });
    expect(always.status).toBe(200);
    await until("the friends' group quiet by the word", async () => settled() && (await chats())[key(FRIENDS)]?.quiet?.why === "owner");
    const follow = await act({ kind: "group", request: randomUUID(), chat: key(FRIENDS), quiet: null });
    expect(follow.status).toBe(200);
    await until("the friends' group follows the rule", async () => settled() && (await chats())[key(FRIENDS)]?.word === null && (await chats())[key(FRIENDS)]?.quiet === null);
    for (const chat of [key(F), "whatsapp:not-a-group", "telegram:120363000000000021@g.us", FRIENDS]) {
      const refused = await act({ kind: "group", request: randomUUID(), chat, quiet: true });
      expect({ status: refused.status, code: refused.body.code }, chat).toEqual({ status: 400, code: "BAD_ACTION" });
    }
    expect((await act({ kind: "group", request: randomUUID(), chat: key(SHOP), quiet: "yes" })).status).toBe(400);
  });

  it("the group act reads on the next read, People held; Follow the rule reads quiet null until People runs the rule again", async () => {
    const always = await act({ kind: "group", request: randomUUID(), chat: key(SHOP), quiet: true });
    expect(always.status).toBe(200);
    await until("the shop's group quiet by the word", async () => settled() && (await chats())[key(SHOP)]?.quiet?.why === "owner");
    const sock = testSocket(root);
    await askHome(sock, "pause", ["kind:people", "--reason", "a test holds People's publish"]);
    try {
      const never = await act({ kind: "group", request: randomUUID(), chat: key(SHOP), quiet: false });
      expect(never.status).toBe(200);
      expect((await chats())[key(SHOP)]).toMatchObject({ word: false, quiet: null });
      const follow = await act({ kind: "group", request: randomUUID(), chat: key(SHOP), quiet: null });
      expect(follow.status).toBe(200);
      expect((await chats())[key(SHOP)]).toMatchObject({ word: null, quiet: null });
    } finally {
      await askHome(sock, "resume", ["kind:people"]);
    }
    await until("the shop's group archived by the rule again", async () => settled() && (await chats())[key(SHOP)]?.quiet?.why === "archived");
    expect((await chats())[key(SHOP)].word).toBeNull();
  });

  it("a stream's settings changed queue People: every group counted and nothing quiet, then the defaults again", async () => {
    const defaults = await list();
    await set("groups_talk", "all");
    await set("groups_archived", "off");
    await set("groups_quiet_after", "never");
    await until("People re-folded by the settings", async () => settled() && (await stream()).quiet === 0 && day(NOW_DAY).includes(`synthetic line shop-${NOW_DAY}`));
    const old = await list();
    expect((await person(S))?.received).toBe(30);
    expect((await person(F))?.received).toBe(5);
    expect(day(NOW_DAY)).not.toContain("You were quiet in");
    report.before = { settings: { groups_talk: "all", groups_archived: "off", groups_quiet_after: "never" }, chats: old.chats, quiet: (await stream()).quiet,
      people: (old.people as Person[]).map(({ id, name, received, last_ms, score }) => ({ id, name, received, last_ms, score })) };
    await set("groups_talk", "joined");
    await set("groups_archived", "on");
    await set("groups_quiet_after", "90d");
    await until("People folded by the defaults again", async () => settled() && (await stream()).quiet === 2 && day(NOW_DAY).includes("You were quiet in"));
    expect((await list()).chats).toEqual(defaults.chats);
    report.verdicts = Object.fromEntries(((await list()).chats as Person[]).filter((chat) => chat.group).map((chat) => [chat.label, { quiet: chat.quiet, word: chat.word }]));
  });

  it("a day rendered before its month was stated renders again when it comes", async () => {
    const sock = testSocket(root);
    await askHome(sock, "pause", ["label:groups", "--reason", "the test renders a day before its month is stated"]);
    await send([group(NEW, "Group New"), on("2026-09-13", "new1", NEW, { member: S })]);
    await until("the day rendered without its month", () => settledBut("label", "groups") && day("2026-09-13").includes("synthetic line new1"));
    await askHome(sock, "resume", ["label:groups"]);
    await until("the month came and the day folded the group", () => settled() && day("2026-09-13").includes("Group New · 1 message"));
    expect(day("2026-09-13")).not.toContain("synthetic line new1");
  });

  it("a late backup renders again only the days of the months it flipped", async () => {
    const sock = testSocket(root);
    await askHome(sock, "pause", ["kind:render", "--reason", "the test reads what the backup marked"]);
    const months = () => JSON.stringify(readHome(root, (db) => db.prepare("SELECT unit, reading FROM extracts WHERE family = 'labels' AND unit LIKE 'group:%' ORDER BY unit").all()));
    const was = months();
    await send([on("2026-05-08", "left0", LEFT, { me: true })]);
    await until("the months the backup flipped were stated", () => months() !== was && settledBut("render"));
    const marked = (readHome(root, (db) => db.prepare("SELECT day FROM dirty_days ORDER BY day").pluck().all()) as string[]).filter((each) => DATA_DAYS.has(each) || each === "2026-05-08");
    await askHome(sock, "resume", ["kind:render"]);
    await until("the marked days rendered", settled);
    expect(marked).toEqual(["2026-05-08", "2026-06-07"]);
    report.backup = { marked };
  });
});
