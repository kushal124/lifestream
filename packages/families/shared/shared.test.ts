import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nameParty, unknownName } from "./cast.js";
import { handleId, piecesText, sha256, type Handle, type Json, type PersonRecord } from "@lifestreamprotocol/core";
import { contactId, contactPhotoBytes } from "./contact.js";
import { buildLabels, foldProviders, labelReading } from "./labels.js";
import {
  alsoCalled, BUSINESS_LEVEL, businessNames, calledId, cardParts, contactPersonId, detailsOf, judged, mergeTree, organise, readCard, resolve, sameIdOf, serviceOf, suggestionId,
  whoseDetails, youOf, type Details, type DetailsStatement, type OwnHandle, type People, type Person, type RecordState, type Seen,
} from "./people.js";
import { readMail, withoutQuotedHistory } from "./mime.js";
import { bySourceOrder, chooseReplicas } from "./replicas.js";
import { detail, free, said, sayJoined } from "./said.js";

const record: Record<string, unknown> = {};
const dir = mkdtempSync(join(tmpdir(), "families-shared-"));
afterAll(() => {
  writeFileSync(join(dir, "shared.json"), `${JSON.stringify(record, null, 2)}\n`);
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS === "1") console.log(`shared artifact kept: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
});

function mail(headers: string[], body: string): Uint8Array {
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8");
}

const person = (slug: string, name: string, handles: Handle[], extra: Partial<PersonRecord> = {}, since = 1): RecordState => {
  const record: PersonRecord = {
    slug, name, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: handles[0] ?? null, handles: handles.slice(1), excluded: [], dismissed: [], also_called: [], merged_into: null, ...extra,
  };
  return { record, since: new Map(handles.map((handle) => [handleId(handle), since])), me_since: null, merged_since: record.merged_into === null ? null : since };
};
const BOOK = "apple-contacts:person-a@example.com:iphone-aa01";
const card = (vcard: string, since = 1) => readCard({ source: BOOK, key: vcard }, since, cardParts({ type: "contacts.card", card: vcard })!);

describe("shared fold code: what must be impossible", () => {
  it("what a family says reads otherwise joined than written, a record's word is said as the family's own, or a free piece states a whole it was not cut from", () => {
    const name = detail("Ada Example", "person");
    const pieces = said`From: ${name} <${detail("person-a@example.com", "email")}>\n${sayJoined([free("a subject"), "", 3, free("")], ", ")}`;
    const text = "From: Ada Example <person-a@example.com>\na subject, , 3, ";
    expect(piecesText(pieces)).toBe(text);
    expect(pieces).toEqual([
      { text: "From: " }, { text: "Ada Example", is: "person" }, { text: " <" }, { text: "person-a@example.com", is: "email" },
      { text: ">\n" }, { text: "a subject", free: true }, { text: ", , 3, " },
    ]);
    expect(free("Call me on +1555", "Call me on +15550000142")).toEqual({ text: "Call me on +1555", free: true, whole: "Call me on +15550000142" });
    expect(free("whole")).toEqual({ text: "whole", free: true });
    expect(free("whole", "whole")).toEqual({ text: "whole", free: true });
    expect(() => free("tail", "the tail")).toThrow(/begins with its text/u);
    record.said = { text, pieces };
  });

  it("quoted history left in a displayed mail body, or the person's own words dropped", () => {
    const cases: [string, string][] = [
      ["Thanks, see you then.\n\nOn Mon, 5 Oct 2026 at 10:00, Person A <person-a@example.com> wrote:\n> Are we still on?\n> Earlier words", "Thanks, see you then."],
      ["Works for me.\n\nOn Mon, 5 Oct 2026 at 10:00, Person A <\nperson-a@example.com> wrote:\n\n> Earlier", "Works for me."],
      ["Approved.\n\n________________________________\nFrom: Person B <person-b@example.com>\nSent: Monday, 5 October 2026 10:00\nTo: Person A\nSubject: Quote", "Approved."],
      ["Noted.\n\n-----Original Message-----\nFrom: someone@example.com\nEarlier text", "Noted."],
      ["> First question?\nMy first answer.\n> Second question?\nMy second answer.", "My first answer.\nMy second answer."],
      ["On Monday we can meet at the usual place.\nBring the drafts.", "On Monday we can meet at the usual place.\nBring the drafts."],
      ["See below.\n\n---------- Forwarded message ---------\nFrom: Person C <person-c@example.com>\nThe forwarded words", "See below.\n\n---------- Forwarded message ---------\nFrom: Person C <person-c@example.com>\nThe forwarded words"],
    ];
    for (const [input, expected] of cases) expect(withoutQuotedHistory(input)).toBe(expected);
    const html = readMail(mail([
      "From: Person A <person-a@example.com>", "To: person-b@example.com", "Subject: Re: plan",
      "MIME-Version: 1.0", 'Content-Type: text/html; charset="utf-8"',
    ], '<div dir="ltr">Sounds good&nbsp;to me.<br>Thanks</div><br><div class="gmail_quote"><div class="gmail_attr">On Mon, Person B wrote:</div><blockquote>Earlier words</blockquote></div>'));
    expect(html.reply).toBe("Sounds good to me.\nThanks");
    expect(html.text).toContain("Earlier words");
    record.quoted = cases.map(([input]) => withoutQuotedHistory(input));
  });

  it("an HTML-only mail shown as markup, or an encoded subject left encoded", () => {
    const multipart = readMail(mail([
      "From: =?UTF-8?Q?Person_=C3=89?= <PERSON-E@Example.com>",
      "To: person-a@example.com, \"Person, B\" <person-b@example.com>",
      "Subject: =?UTF-8?B?Q2Fmw6k=?= =?UTF-8?B?IOKYlQ==?= plans",
      "Content-Type: multipart/alternative; boundary=\"b1\"",
    ], [
      "--b1", "Content-Type: text/html; charset=utf-8", "", "<p>Hello <b>there</b> &amp; welcome</p><script>x()</script>",
      "--b1", "Content-Type: application/pdf", "Content-Disposition: attachment; filename=\"plan.pdf\"", "Content-Transfer-Encoding: base64", "", "AAECAw==",
      "--b1", "Content-Type: text/calendar; method=REQUEST", "",
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:ev-1\r\nSUMMARY:Plan\\, review\r\nDTSTART:20261005T100000Z\r\nORGANIZER:mailto:Person-A@example.com\r\nATTENDEE:mailto:person-b@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR",
      "--b1--", "",
    ].join("\r\n")));
    expect(multipart.subject).toBe("Café ☕ plans");
    expect(multipart.from).toEqual({ address: "person-e@example.com", name: "Person É" });
    expect(multipart.to).toEqual([{ address: "person-a@example.com", name: null }, { address: "person-b@example.com", name: "Person, B" }]);
    expect(multipart.text).toBe("Hello there & welcome");
    expect(multipart.attachments).toEqual([{ name: "plan.pdf", media_type: "application/pdf", bytes: 4 }]);
    expect(multipart.invitation).toEqual({ method: "REQUEST", uid: "ev-1", summary: "Plan, review", start: "20261005T100000Z", end: null, organizer: "person-a@example.com", attendees: 1 });
    record.mail = { subject: multipart.subject, text: multipart.text, invitation: multipart.invitation };
  });

  it("two replicas of one thing both shown, or the chosen one depending on input order", () => {
    const copies = [
      { source: "chat:mac-0001", key: "m1", text: "hello" },
      { source: "chat:phone-aa01", key: "m1", text: "hello" },
      { source: "chat:mac-0001", key: "m2", text: "only on the mac" },
      { source: "chat:other-aa03", key: "m1", text: "hello" },
    ];
    const rule = { same: (copy: (typeof copies)[number]) => copy.key, prefer: bySourceOrder(["chat:phone-aa01", "chat:mac-0001"]), id: (copy: (typeof copies)[number]) => copy.source };
    const chosen = chooseReplicas(copies, rule);
    expect(chosen.map((group) => [group.chosen.source, group.chosen.key, group.others.map((other) => other.source)])).toEqual([
      ["chat:phone-aa01", "m1", ["chat:mac-0001", "chat:other-aa03"]],
      ["chat:mac-0001", "m2", []],
    ]);
    for (const order of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
      expect(chooseReplicas(order.map((index) => copies[index]!), rule)).toEqual(chosen);
    }
    record.replicas = chosen;
  });

  it("a card outranking a record, a contested handle named twice, a merge or an exclusion ignored", () => {
    const labels = buildLabels({
      people: [
        person("person-b", "Person B", [{ kind: "phone", value: "+15550000002" }]),
        person("old-b", "Old B", [{ kind: "phone", value: "+15550000009" }], { merged_into: "person-b" }),
        person("person-c", "Person C", [{ kind: "phone", value: "+15550000004" }, { kind: "email", value: "shared@example.com" }], {}, 1),
        person("person-d", "Person D", [{ kind: "phone", value: "+15550000004" }, { kind: "email", value: "shared@example.com" }], {}, 2),
        person("person-e", "Person E", [{ kind: "phone", value: "+15550000005" }], { excluded: [{ kind: "phone", value: "+15550000006" }] }),
        person("person-f", "Person F", [{ kind: "phone", value: "+15550000006" }], { merged_into: "person-e" }),
      ],
      contacts: [
        card("BEGIN:VCARD\r\nFN:Contact Name\r\nTEL:+15550000002\r\nitem1.EMAIL:other@example.com\r\nEND:VCARD\r\n"),
        card("BEGIN:VCARD\r\nFN:Later Card\r\nEMAIL:other@example.com\r\nEND:VCARD\r\n", 2),
      ],
      places: [],
    });
    const b = { id: "person:person-b", name: "Person B", by: "registry", slug: "person-b", me: false };
    expect(labels.person("+15550000002")).toEqual(b);
    expect(labels.person("+15550000009")).toEqual(b);
    expect(labels.person("other@example.com")).toEqual(b);
    expect(labels.person("+15550000004")).toEqual({ id: "person:person-c", name: "Person C", by: "registry", slug: "person-c", me: false });
    expect(labels.person("shared@example.com")?.id).toBe("person:person-c");
    expect(labels.person("+15550000006")).toBeUndefined();
    record.registry = ["+15550000002", "+15550000009", "+15550000004", "shared@example.com", "+15550000006", "other@example.com"].map((id) => [id, labels.person(id) ?? null]);
  });

  it("a phone JID, a formatted phone and an E.164 phone naming different people", () => {
    const labels = buildLabels({
      people: [person("person-l", "Person L", [{ kind: "jid", value: "123456789012345@lid" }])],
      contacts: [card("BEGIN:VCARD\r\nFN:Person A\r\nTEL;TYPE=CELL:+1 (555) 000-0001\r\nEMAIL:Person-A@Example.com\r\nEND:VCARD\r\n")],
      places: [],
    });
    for (const id of ["+15550000001", "+1 555 000 0001", "15550000001@s.whatsapp.net", "15550000001@S.WHATSAPP.NET", "\u202a+1 (555) 000-0001\u202c"]) {
      expect(labels.person(id)?.name, id).toBe("Person A");
    }
    expect(labels.person("mailto:PERSON-A@example.com")?.name).toBe("Person A");
    expect(labels.person("123456789012345@lid")?.name).toBe("Person L");
    expect(labels.person("5550000001")).toBeUndefined();
    expect(labels.person("555-0001")).toBeUndefined();
  });

  it("the labels version moving when no name changed", () => {
    const named = (name: string, phone: string, extra = "") => card(`BEGIN:VCARD\r\nFN:${name}\r\nTEL:${phone}\r\n${extra}END:VCARD\r\n`);
    const base = buildLabels({ people: [], contacts: [named("Person A", "+15550000001"), named("Person B", "+15550000002")], places: [] });
    expect(buildLabels({ people: [], contacts: [named("Person B", "+15550000002"), named("Person A", "+15550000001", "BDAY:2000-01-01\r\n")], places: [] }).version).toBe(base.version);
    expect(buildLabels({ people: [], contacts: [named("Person A2", "+15550000001"), named("Person B", "+15550000002")], places: [] }).version).not.toBe(base.version);
    const home = { slug: "home", name: "Home", latitude: 10, longitude: 20, radius_m: 100, ids: [], also: [] };
    expect(buildLabels({ people: [], contacts: [], places: [home] }).version).not.toBe(buildLabels({ people: [], contacts: [], places: [] }).version);
  });

  it("a party named by a phone-shaped provider label, or its name served under another rung", () => {
    const labels = buildLabels({ people: [], contacts: [card("BEGIN:VCARD\r\nFN:Person A\r\nTEL:+15550000001\r\nEND:VCARD\r\n")], places: [] });
    expect(nameParty({ id: "+15550000001", kind: "phone", provider: "Shown Name" }, labels)).toEqual({ name: "Person A", by: "contact", person: null, who: "phone:+15550000001" });
    expect(nameParty({ id: "123456789012345@lid", kind: "jid", aliases: ["+15550000001"] }, labels)).toEqual({ name: "Person A", by: "contact", person: null, who: "phone:+15550000001" });
    expect(nameParty({ id: "+15550000007", kind: "phone", provider: "+1 555 000 0007", pushName: "Pushed" }, labels)).toEqual({ name: "Pushed", by: "push-name", person: null, who: "phone:+15550000007" });
    expect(nameParty({ id: "+15550000007", kind: "phone", provider: "Shown Name" }, labels)).toEqual({ name: "Shown Name", by: "provider", person: null, who: "phone:+15550000007" });
    expect(nameParty({ id: "person-c@example.com", kind: "email", provider: "person-c@example.com" }, labels)).toEqual({ name: "person-c@example.com", by: "provider", person: null, who: null });
    expect(nameParty({ id: "15550000008@s.whatsapp.net", kind: "jid" }, labels)).toEqual({ name: "unknown …00008", by: "none", person: null, who: null });
    expect(unknownName("123456789012345@lid")).toBe("unknown lid …12345");
    expect(nameParty({ id: "me", kind: "me" }, labels)).toEqual({ name: "the user", by: "me", person: null, who: null });
  });
  it("a contact known by its key alone: one identifier in two sources, or two sharing their first 16 characters, one person", () => {
    const nameless = (source: string, key: string, name: string) => readCard({ source, key }, 1, cardParts({ type: "contacts.card", card: `BEGIN:VCARD\r\nFN:${name}\r\nEND:VCARD\r\n` })!);
    const other = "apple-contacts:person-a@example.com:iphone-aa02";
    const id = "AAAAAAAA-0000-4000-8000-000000000001:ABPerson";
    const twin = "AAAAAAAA-0000-4000-8000-000000000002:ABPerson";
    const cards = [nameless(BOOK, id, "Person Q"), nameless(other, id, "Person R"), nameless(BOOK, twin, "Person S")];
    const people = resolve({ cards, records: [], providers: new Map(), country: null });
    const ids = people.all.map((person) => [person.name, person.id]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids.map(([, each]) => each)).size).toBe(3);
    expect(people.ids.get(contactPersonId({ id: contactId({ source: other, key: id }) }))?.name).toBe("Person R");
    expect(contactPersonId(cards[0]!)).toBe(`contact:${sha256(`${BOOK}\n${id}`).slice("sha256:".length, "sha256:".length + 16)}`);
    record.contact_ids = ids;
  });

  it("a phone's photo lost or read from the card, an export's lost, or a photo changed while the card stays left as it was", () => {
    const text = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Person P\r\nTEL:+15550000031\r\nEND:VCARD\r\n";
    const first = Buffer.from("synthetic heic bytes of a phone contact's photo");
    const second = Buffer.from("synthetic heic bytes of the photo changed");
    const phone = (bytes: Buffer): Json => ({ type: "contacts.card", card: text, photo: { hash: sha256(bytes), bytes: bytes.length, media_type: "image/heic" } });
    const store = new Map([first, second].map((bytes) => [sha256(bytes), bytes]));
    const blobs = { has: (hash: string) => store.has(hash), bytes: (hash: string) => store.get(hash)! };
    const ref = { source: BOOK, key: "AAAAAAAA-0000-4000-8000-000000000003:ABPerson" };
    expect(cardParts(phone(first))!.photo).toEqual({ hash: sha256(first), blob: true });
    expect(contactPhotoBytes(phone(first), blobs)).toEqual({ bytes: first, type: "image/heic" });
    expect(cardParts(phone(second))!.photo).toEqual({ hash: sha256(second), blob: true });
    expect(labelReading({ kind: "contact", key: ref.key }, phone(second))).toBe(labelReading({ kind: "contact", key: ref.key }, phone(first)));
    expect(contactPhotoBytes(phone(Buffer.from("not stored")), blobs)).toBeNull();
    const embedded = Buffer.from("synthetic jpeg bytes inside an exported card");
    const exported: Json = { type: "contacts.card", card: text.replace("END:VCARD", `PHOTO;ENCODING=b;TYPE=JPEG:${embedded.toString("base64")}\r\nEND:VCARD`) };
    expect(cardParts(exported)!.photo).toEqual({ hash: sha256(embedded), blob: false });
    expect(contactPhotoBytes(exported, { has: () => false, bytes: () => Buffer.alloc(0) })).toEqual({ bytes: embedded, type: "image/jpeg" });
    expect(cardParts({ type: "contacts.card", card: text })!.photo).toBeNull();
  });

  it("a network's word that an id is a business's lost, made a name or a pairing, or the weaker of two words kept", () => {
    const said = (key: string, ids: string[], level: number, name?: string, stated_ms = 1) => ({
      source: "whatsapp:15550000000:macbook-pro-0001", kind: "business", key, stated_ms, said: { names: [], business: { ids, level, ...(name === undefined ? {} : { name }) } },
    });
    const shell = { source: "whatsapp:15550000000:macbook-pro-0001", kind: "chat", key: "90000000000062@lid", stated_ms: 1, said: { names: [], pair: ["90000000000062@lid", "15550000062@s.whatsapp.net"] as const } };
    const labels = foldProviders([
      said("90000000000061@lid", ["90000000000061@lid", "15550000061@s.whatsapp.net"], 3, "Example Shop"),
      said("90000000000061@lid", ["90000000000061@lid"], 1, "Example Shop Two", 2),
      said("90000000000062@lid", ["90000000000062@lid"], 2), shell,
      said("90000000000063@lid", ["90000000000063@lid"], 3, "Old Shop Name"), said("90000000000064@lid", ["90000000000063@lid"], 3, "New Shop Name", 2),
    ]);
    expect(Object.fromEntries(labels)).toEqual({
      "90000000000061@lid": { business: 3, businessName: "Example Shop" }, "15550000061@s.whatsapp.net": { business: 3, businessName: "Example Shop" },
      "90000000000063@lid": { business: 3, businessName: "New Shop Name" },
      "90000000000062@lid": { business: 2, aliases: ["15550000062@s.whatsapp.net"] }, "15550000062@s.whatsapp.net": { business: 2, aliases: ["90000000000062@lid"] },
    });
    expect(resolve({ cards: [], records: [], providers: new Map([["jid:90000000000061@lid", { business: 3, businessName: "Example Shop" }]]), country: null }).all).toEqual([]);
  });

  it("a service's address read for another reason than its own, or someone judged no person by a weak sign", () => {
    const mail = (from: number, to: number, machine: number) => ({ from, to, machine });
    expect([
      serviceOf("invites-noreply@network.example.com", [], mail(1, 0, 0)),
      serviceOf("hello@shop.example.com", ["Alpha at Shop", "Bravo Shop", "Charlie from Shop"], mail(3, 1, 0)),
      serviceOf("person-l@example.com", ["Person L"], mail(0, 0, 4)),
      serviceOf("person-l@example.com", ["Person L"], mail(0, 1, 4)),
      serviceOf("person-a@example.com", ["Person A", "Synthetic, Person"], mail(2, 2, 0)),
    ]).toEqual(["no-reply", "relay", "list", null, null]);
    const seen = (sender: Seen["sender"]): Seen => ({
      counts: { theirs: new Map(), groups: new Map(), mine: new Map(), replies: 0, quick: 0, mail_from: new Map(), mail_to: new Map(), photos: new Map() },
      mail_names: [], service: sender !== null, sender, senders: [], photo_labels: [], wished: [],
    });
    const someone = { me: false };
    expect([
      judged(someone, undefined, [BUSINESS_LEVEL]), judged(someone, undefined, [BUSINESS_LEVEL, BUSINESS_LEVEL + 1]), judged(someone, undefined, [BUSINESS_LEVEL - 1]),
      judged(someone, undefined, [BUSINESS_LEVEL, 0]),
      judged(someone, seen("relay"), []), judged(someone, seen("no-reply"), []), judged(someone, seen(null), []), judged(someone, undefined, []),
      judged({ me: true }, undefined, [BUSINESS_LEVEL]), judged({ me: true }, seen("no-reply"), []),
    ]).toEqual(["business", "business", "person", "person", "person", "bot", "person", "person", "person", "person"]);
  });

  it("a business's name read off another part of a domain, off a short or plain domain, off a hyphen, or off a name verified below the highest level", () => {
    const known = businessNames(
      ["orders-noreply@mail.exampleshop.co.in", "hello@relay.shoplex.com", "noreply@exampleshop.com", "noreply@ab.com", "noreply@garden.com", "noreply@localhost", "noreply@synth-store.example"],
      [{ business: BUSINESS_LEVEL, businessName: "Synth Shop's Online" }, { business: BUSINESS_LEVEL - 1, businessName: "Lowshop" }, { business: BUSINESS_LEVEL }],
    );
    expect([...known.names].sort()).toEqual(["exampleshop", "shoplex", "synthshopsonline", "synthstore"]);
    expect(Object.fromEntries(known.domains)).toEqual({ "exampleshop.co.in": "exampleshop", "exampleshop.com": "exampleshop", "shoplex.com": "shoplex", "synth-store.example": "synthstore" });
  });

  it("one person in a phone's address book and in an export read as two", () => {
    const text = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Person P\r\nTEL:+15550000031\r\nEND:VCARD\r\n";
    const photo = Buffer.from("synthetic heic bytes of a phone contact's photo");
    const fromPhone = readCard({ source: BOOK, key: "AAAAAAAA-0000-4000-8000-000000000003:ABPerson" }, 2,
      cardParts({ type: "contacts.card", card: text, photo: { hash: sha256(photo), bytes: photo.length, media_type: "image/heic" } })!);
    const fromExport = readCard({ source: "google-contacts:person-a@example.com:export", key: sha256(text).slice(7) }, 1, cardParts({ type: "contacts.card", card: text })!);
    const people = resolve({ cards: [fromExport, fromPhone], records: [], providers: new Map(), country: null });
    expect(people.all).toHaveLength(1);
    expect(people.all[0]).toMatchObject({ id: "phone:+15550000031", name: "Person P" });
    expect(people.all[0]!.cards.map((each) => each.id)).toEqual([fromPhone.id, fromExport.id]);
    expect(people.ids.get(contactPersonId(fromExport))).toBe(people.all[0]);
  });
});


const marked = (state: RecordState, since = 1): RecordState => ({ ...state, record: { ...state.record, me: true }, me_since: since });
const OWN_PHONE: Handle = { kind: "phone", value: "+15550000001" };
const OWN_EMAIL: Handle = { kind: "email", value: "person-a@example.com" };
const OWN: OwnHandle[] = [{ ...OWN_PHONE, product: "imessage" }, { ...OWN_PHONE, product: "whatsapp" }, { ...OWN_EMAIL, product: "gmail" }];
const DAY = "2026-11-01";
const saw = (mine = 0, theirs = 0, mail_names: string[] = [], mail_from = 0): Seen => ({
  counts: {
    theirs: new Map([[DAY, theirs]]), groups: new Map(), mine: new Map([[DAY, mine]]), replies: 0, quick: 0,
    mail_from: new Map([[DAY, mail_from]]), mail_to: new Map(), photos: new Map(),
  },
  mail_names, service: false, sender: null, senders: [], photo_labels: [], wished: [],
});
const youIn = (people: People) => people.all.filter((each) => each.me).map((each) => ({ id: each.id, record: each.record !== null }));

describe("You: one answer, own accounts always joined, apart from the list", () => {
  it("two owner answers disagree: youOf over records alone, and resolve's me the same", () => {
    const cases: [string, RecordState[], OwnHandle[], ReturnType<typeof youOf>][] = [
      ["one mark", [marked(person("sam", "Sam", [])), person("pat", "Pat", [{ kind: "phone", value: "+15550000002" }])], OWN, { root: "sam", marked: true }],
      ["two marks: the newest wins", [marked(person("sam", "Sam", []), 9), marked(person("old-sam", "Sam", [], {}, 1), 5)], OWN, { root: "sam", marked: true }],
      ["two marks of one time: by slug", [marked(person("sam-b", "Sam", []), 5), marked(person("sam-a", "Sam", []), 5)], OWN, { root: "sam-a", marked: true }],
      ["a mark on a merged record: its root", [person("sam", "Sam", []), marked(person("me-old", "Me", [], { merged_into: "sam" }))], OWN, { root: "sam", marked: true }],
      ["no mark, two claims: the earliest", [person("late", "Late", [OWN_PHONE], {}, 7), person("early", "Early", [OWN_EMAIL], {}, 3)], OWN, { root: "early", marked: false }],
      ["no mark, two claims of one time: by slug", [person("claim-b", "B", [OWN_PHONE], {}, 3), person("claim-a", "A", [OWN_EMAIL], {}, 3)], OWN, { root: "claim-a", marked: false }],
      ["a claim by a merged record: its root", [person("root-r", "R", []), person("held", "H", [OWN_PHONE], { merged_into: "root-r" })], OWN, { root: "root-r", marked: false }],
      ["no record claims: the holder", [person("pat", "Pat", [{ kind: "phone", value: "+15550000002" }])], OWN, { holder: true }],
      ["neither", [person("pat", "Pat", [{ kind: "phone", value: "+15550000002" }])], [], null],
    ];
    const answers: Record<string, unknown> = {};
    for (const [name, records, own, expected] of cases) {
      const you = youOf(mergeTree(records), own);
      expect(you, name).toEqual(expected);
      const people = resolve({ cards: [], records, providers: new Map(), country: null, own });
      expect(youIn(people), name).toEqual(you === null ? [] : "root" in you ? [{ id: `person:${you.root}`, record: true }] : [{ id: "phone:+15550000001", record: false }]);
      answers[name] = you;
    }
    record.youOf = answers;
  });

  it("an own account stays outside You, another record keeps one, an exclusion takes one off, or a merged person's type fills You's", () => {
    const pat: Handle = { kind: "phone", value: "+15550000002" };
    const alone = resolve({ cards: [], records: [marked(person("sam", "Sam", []))], providers: new Map(), country: null, own: [{ ...OWN_PHONE, product: "imessage" }] });
    expect(alone.all.map((each) => ({ id: each.id, me: each.me, handles: each.handles }))).toEqual([{ id: "person:sam", me: true, handles: [{ ...OWN_PHONE, from: "home" }] }]);
    const claimed = resolve({
      cards: [], providers: new Map(), country: null, own: OWN,
      records: [marked(person("sam", "Sam", [], {}, 5), 5), person("other", "Other", [OWN_PHONE, pat], {}, 1)],
    });
    expect(claimed.ids.get("phone:+15550000001")?.id).toBe("person:sam");
    expect(claimed.ids.get("phone:+15550000002")?.id).toBe("person:other");
    expect([...claimed.apart]).toEqual([]);
    const listed = organise(claimed, () => undefined, DAY, () => undefined, []);
    expect([listed.you, ...listed.listed].flatMap((each) => listed.suggestions(each!)).filter((each) => each.kind === "same")).toEqual([]);
    const excluded = resolve({
      cards: [], providers: new Map(), country: null, own: OWN,
      records: [marked(person("sam", "Sam", [], { excluded: [OWN_EMAIL] })), person("pat", "Pat", [pat], { excluded: [OWN_PHONE] })],
    });
    expect(["phone:+15550000001", "email:person-a@example.com"].map((id) => excluded.ids.get(id)?.id)).toEqual(["person:sam", "person:sam"]);
    const holder = resolve({ cards: [], providers: new Map(), country: null, own: OWN, records: [person("pat", "Pat", [pat], { excluded: [OWN_EMAIL] })] });
    expect(youIn(holder)).toEqual([{ id: "phone:+15550000001", record: false }]);
    expect(holder.ids.get("email:person-a@example.com")?.handles.map((each) => each.from)).toEqual(["home", "home"]);
    const PARTNER: Handle = { kind: "email", value: "person-b@example.com" };
    const shared = resolve({
      cards: [card(`BEGIN:VCARD\r\nFN:Owner Example\r\nTEL:${OWN_PHONE.value}\r\nEMAIL:${PARTNER.value}\r\nEND:VCARD\r\n`)], providers: new Map(), country: null,
      own: [{ ...OWN_PHONE, product: "whatsapp" }], records: [person("partner", "Partner", [PARTNER])],
    });
    expect(shared.all.map((each) => ({ id: each.id, me: each.me, record: each.record?.slug ?? null, handles: each.handles.map(handleId) }))).toEqual([
      { id: "person:partner", me: false, record: "partner", handles: ["email:person-b@example.com"] },
      { id: "phone:+15550000001", me: true, record: null, handles: ["phone:+15550000001"] },
    ]);
    expect(shared.all.find((each) => each.slug === "partner")?.relationship).toBeNull();
    expect([...shared.apart]).toEqual([["phone:+15550000001", ["person:partner"]], ["person:partner", ["phone:+15550000001"]]]);
    const claim = resolve({ cards: [], providers: new Map(), country: null, own: OWN, records: [person("sam", "Sam", [OWN_PHONE]), person("sam-mail", "Sam", [], { merged_into: "sam" })] });
    expect(youIn(claim)).toEqual([{ id: "person:sam", record: true }]);
    expect(claim.ids.get("email:person-a@example.com")?.id).toBe("person:sam");
    const filled = resolve({
      cards: [], providers: new Map(), country: null, own: OWN,
      records: [marked(person("sam", "Sam", [], { entity: null, hidden: true })), person("shop", "Shop", [pat], { entity: "business", relationship: "friend", hidden: true, merged_into: "sam" })],
    });
    const you = filled.all.find((each) => each.me)!;
    expect({ entity: you.entity, relationship: you.relationship, hidden: you.hidden, record: { entity: you.record!.entity, relationship: you.record!.relationship, hidden: you.record!.hidden } })
      .toEqual({ entity: "person", relationship: null, hidden: false, record: { entity: "person", relationship: null, hidden: false } });
    record.resolveYou = { alone: alone.all, claimed: youIn(claimed), holder: youIn(holder), you };
  });

  it("You stay in the list or a count, lose a suggestion, or another card offers You", () => {
    const pat: Handle = { kind: "phone", value: "+15550000002" };
    const stranger: Handle = { kind: "phone", value: "+15550000004" };
    const address: Handle = { kind: "email", value: "sam.example@example.org" };
    const records = [
      marked(person("sam", "Sam", [], { full_name: "Sam Example" })),
      person("pat", "Pat", [pat]),
      person("namesake", "Sam Example", [{ kind: "phone", value: "+15550000005" }]),
    ];
    const cards = [card("BEGIN:VCARD\r\nFN:Quinn Card\r\nTEL:+15550000003\r\nEND:VCARD\r\n")];
    const sawOf = new Map<string, Seen>([
      ["phone:+15550000001", saw(200, 200)], ["phone:+15550000003", saw(60, 60)], ["phone:+15550000004", saw(0, 1)],
      ["email:sam.example@example.org", saw(0, 0, ["Sam Example"], 4)],
    ]);
    const seen = (each: Person) => sawOf.get(each.handles[0] === undefined ? "" : handleId(each.handles[0]));
    for (const [home, mark] of [["marked", true], ["holder", false]] as const) {
      const people = resolve({ cards, records: mark ? records : records.slice(1), providers: new Map(), country: null, own: OWN, seen: [stranger, address] });
      const organised = organise(people, seen, DAY, () => undefined, []);
      const you = people.all.find((each) => each.me)!;
      expect(organised.you, home).toBe(you);
      expect(organised.listed.some((each) => each.me), home).toBe(false);
      expect(organised.queue, home).toEqual(["phone:+15550000003"]);
      expect(organised.organised, home).toBe(2);
      expect(organised.often, home).toBe(1);
      expect(organised.others, home).toBe(2);
      const offers = organised.suggestions(you);
      expect(offers.filter((each) => each.kind === "handle").map((each) => each.value), home).toEqual(mark ? ["email:sam.example@example.org"] : []);
      expect(offers.some((each) => (each.kind as string) === "me" || each.kind === "entity"), home).toBe(false);
      for (const other of organised.listed) {
        expect(organised.suggestions(other).some((each) => (each.kind as string) === "me"), home).toBe(false);
        expect(organised.suggestions(other).filter((each) => each.kind === "same" && each.value === you.slug), home).toEqual([]);
      }
      if (mark) {
        expect(offers.filter((each) => each.kind === "same")).toEqual([
          { id: sameIdOf("person:sam", "person:namesake"), kind: "same", value: "namesake", reasons: { linked: 0, named: 1, seen: 0 }, ticked: false },
        ]);
        const namesake = people.ids.get("person:namesake")!;
        expect(organised.suggestions(namesake).filter((each) => each.kind === "same")).toEqual([]);
        const typed = resolve({ cards: [], providers: new Map(), country: null, own: OWN, records: [records[0]!, person("faced", "Sam", [])] });
        const typedOffers = organise(typed, () => undefined, DAY, () => undefined, []);
        expect(typedOffers.suggestions(typedOffers.you!).map((each) => [each.kind, each.value])).toEqual([["same", "faced"]]);
      }
      record[`organiseYou_${home}`] = { you: you.id, listed: organised.listed.map((each) => each.id), queue: organised.queue, offers };
    }
    const shopCard = card("BEGIN:VCARD\r\nORG:Example Shop\r\nEMAIL:person-a@example.com\r\nEND:VCARD\r\n");
    const holder = resolve({ cards: [shopCard], records: [], providers: new Map(), country: null, own: OWN });
    const offered = organise(holder, () => undefined, DAY, () => undefined, []);
    expect(offered.suggestions(offered.you!).filter((each) => each.kind === "entity")).toEqual([]);
    expect(offered.entity(offered.you!)).toBe("person");
  });

  it("a declined pair comes back when an anchor moves, or a pair split apart is offered again", () => {
    const a1: Handle = { kind: "phone", value: "+15550000011" };
    const a2: Handle = { kind: "phone", value: "+15550000012" };
    const b1: Handle = { kind: "phone", value: "+15550000013" };
    const pair = (aAnchor: Handle, dismissed: string[]) => resolve({
      cards: [], providers: new Map(), country: null,
      records: [person("pat-a", "Pat", [aAnchor], { full_name: "Pat Example", dismissed }), person("pat-b", "Pat", [b1], { full_name: "Pat Example" })],
    });
    const sames = (people: People) => {
      const organised = organise(people, () => undefined, DAY, () => undefined, []);
      return organised.listed.flatMap((each) => organised.suggestions(each).filter((offer) => offer.kind === "same").map((offer) => [each.id, offer.value]));
    };
    expect(sames(pair(a1, []))).toEqual([["person:pat-a", "pat-b"], ["person:pat-b", "pat-a"]]);
    const declined = [sameIdOf("person:pat-a", "person:pat-b")];
    expect(sames(pair(a1, declined))).toEqual([]);
    expect(sames(pair(a2, declined))).toEqual([]);
    const old = suggestionId("same", [handleId(a1), handleId(b1)].sort().join("\0"));
    expect(sames(pair(a1, [old]))).toEqual([]);
    const card2 = card("BEGIN:VCARD\r\nFN:Robin Example\r\nTEL:+15550000021\r\nTEL:+15550000022\r\nEND:VCARD\r\n");
    const split = (dismissed: string[]) => resolve({
      cards: [card2], providers: new Map(), country: null,
      records: [person("robin", "Robin Example", [{ kind: "phone", value: "+15550000021" }], { dismissed }), person("robin-x", "Robin Example", [{ kind: "phone", value: "+15550000022" }])],
    });
    expect(sames(split([]))).toEqual([["person:robin", "robin-x"], ["person:robin-x", "robin"]]);
    expect(sames(split([sameIdOf("person:robin", "person:robin-x")]))).toEqual([]);
  });

  it("a nickname is lost, doubled, or brought back after removal", () => {
    const robin: Handle = { kind: "phone", value: "+15550000031" };
    const long = "N".repeat(61);
    const people = (cardText: string, root: Partial<PersonRecord> = {}) => resolve({
      cards: [card(`BEGIN:VCARD\r\nFN:Robin Example\r\nTEL:+15550000031\r\n${cardText}END:VCARD\r\n`)], providers: new Map(), country: null,
      records: [
        person("robin", "Robin", [robin], { also_called: ["Rob"], dismissed: [calledId("Bobby"), calledId("Birdie"), calledId("Rob")].sort(), ...root }),
        person("robin-m", "Robin M", [], { also_called: ["Bobby", "Robbie"], merged_into: "robin" }),
      ],
    }).ids.get("person:robin")!;
    const one = people(`NICKNAME:Birdie,Robin,Ace,ROBBIE,${long}\r\n`);
    expect(alsoCalled(one)).toEqual([{ name: "Rob", from: "you" }, { name: "Robbie", from: "you" }, { name: "Ace", from: "card" }]);
    const many = people(`NICKNAME:${Array.from({ length: 14 }, (_, n) => `Nick ${String.fromCharCode(65 + n)}`).join(",")}\r\n`);
    expect(alsoCalled(many)).toHaveLength(12);
    expect(alsoCalled(many).slice(0, 3).map((each) => each.from)).toEqual(["you", "you", "card"]);
    const organised = organise(resolve({ cards: [], records: [], providers: new Map(), country: null }), () => undefined, DAY, () => undefined, []);
    expect(organised.namesSeen(one)).toEqual(["Robin Example", "Rob", "Robbie", "Ace"]);

    const bear = (nickname: string, dismissed: string[], also_called: string[] = []) => resolve({
      cards: [card(`BEGIN:VCARD\r\nFN:Theodore Example\r\nTEL:+15550000041\r\nNICKNAME:${nickname}\r\nEND:VCARD\r\n`)], providers: new Map(), country: null,
      records: [person("theodore", "Theodore", [{ kind: "phone", value: "+15550000041" }], { dismissed, also_called })],
    }).ids.get("person:theodore")!;
    const said = (friend: Person) => ({ also: alsoCalled(friend).map((each) => each.name), seen: organised.namesSeen(friend) });
    const removed = [calledId("Bear")];
    const steps = {
      before: said(bear("Bear", [])), removed: said(bear("Bear", removed)), changed: said(bear("Bear B.", removed)), back: said(bear("Bear", removed)),
    };
    expect(steps).toEqual({
      before: { also: ["Bear"], seen: ["Theodore Example", "Bear"] }, removed: { also: [], seen: ["Theodore Example"] },
      changed: { also: ["Bear B."], seen: ["Theodore Example", "Bear B."] }, back: { also: [], seen: ["Theodore Example"] },
    });
    expect(alsoCalled(bear("Bear", removed, ["Bear"]))).toEqual([{ name: "Bear", from: "you" }]);
    record.alsoCalled = { one: alsoCalled(one), steps };
  });

  it("a group's details read wrong: a member's field lost, the root's word or emptied field overridden, or a person of one record not as today", () => {
    const at = (key: string, stated_ms: number, details: Partial<Details>): DetailsStatement => ({ key, stated_ms, details: { work: null, birthday: null, profiles: [], ...details } });
    const r = { ...person("r", "R", [{ kind: "phone", value: "+15550000051" }]).record };
    const x = { ...person("x", "X", [{ kind: "phone", value: "+15550000052" }], { merged_into: "r" }).record };
    const group = { root: "r", records: [x, r] };
    expect([whoseDetails(group, "person:x"), whoseDetails(group, "phone:+15550000051"), whoseDetails(group, "phone:+15550000052"), whoseDetails(group, "contact:0123456789abcdef")])
      .toEqual(["x", "r", "x", null]);
    const birthday = { month: 8, day: 14, year: null };
    expect(detailsOf({ root: "r", records: [r] }, [at("person:r", 2, { work: "Designer" }), at("contact:0123456789abcdef", 1, { birthday })])).toEqual({ work: "Designer", birthday: null, profiles: [] });
    expect(detailsOf({ root: "r", records: [r] }, [at("phone:+15550000051", 2, { work: "B" }), at("person:r", 2, { work: "A" })])?.work).toBe("A");
    expect(detailsOf({ root: "r", records: [r] }, [])).toBeUndefined();
    expect(detailsOf(group, [at("person:r", 1, { work: "R's work" }), at("person:x", 5, { work: "X's work", birthday })])).toEqual({ work: "R's work", birthday, profiles: [] });
    const profiles = [{ network: "github" as const, value: "person-r" }];
    expect(detailsOf(group, [at("person:r", 3, { work: "R's work", cleared: ["birthday"] }), at("phone:+15550000052", 5, { birthday }), at("contact:0123456789abcdef", 1, { profiles })]))
      .toEqual({ work: "R's work", birthday: null, profiles });
    const y = { ...person("y", "Y", [], { merged_into: "r" }).record };
    expect(detailsOf({ root: "r", records: [r, x, y] }, [at("person:x", 4, { work: "X" }), at("person:y", 4, { work: "Y" })])?.work).toBe("X");
    expect(detailsOf({ root: "r", records: [r, x, y] }, [at("person:x", 4, { work: "X" }), at("person:y", 6, { work: "Y" })])?.work).toBe("Y");
  });

  it("a member's leaving handles lose one the member holds, or take one the root's card holds beside the root's", () => {
    const rPhone: Handle = { kind: "phone", value: "+15550000601" };
    const xPhone: Handle = { kind: "phone", value: "+15550000611" };
    const address: Handle = { kind: "email", value: "person-shared@example.com" };
    const leaving = (records: RecordState[], vcards: string[]) =>
      resolve({ cards: vcards.map((each) => card(`BEGIN:VCARD\r\n${each}\r\nEND:VCARD\r\n`)), records, providers: new Map(), country: null, own: OWN })
        .joined.get("r")?.map((member) => [member.slug, member.leaving.map(handleId)]);
    const xCard = `FN:Person X\r\nTEL:${xPhone.value}\r\nTEL:+15550000612\r\nEMAIL:${address.value}`;
    const held = leaving([person("r", "R", [rPhone, address]), person("x", "X", [xPhone], { merged_into: "r" })], [xCard]);
    expect(held).toEqual([["x", ["phone:+15550000611", "phone:+15550000612"]]]);
    const both = leaving([person("r", "R", [rPhone]), person("x", "X", [xPhone], { merged_into: "r" })], [`FN:Person R\r\nTEL:${rPhone.value}\r\nEMAIL:${address.value}`, xCard]);
    expect(both).toEqual([["x", ["phone:+15550000611", "phone:+15550000612"]]]);
    record.leaving = { held, both };
  });
});
