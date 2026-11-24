import { artifact, collect, CONNECT_ROOT, deliver, openTestHome, parityOf, readGolden, temp, writeZip } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONSUMED } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { contactsVcard } from "./reader.js";
import { cardCount, streamCards } from "../../shared/vcard.js";
import { BLANK_LIST, CARD_B, CARD_C, CARD_D, CONTACTS_SOURCE, EMPTY_LIST, EXPORT_FACTS, takeoutContacts, vcardBytes } from "./test/fixtures.js";

const TEST = join(CONNECT_ROOT, "contacts", "vcard", "test");

describe("vCard contacts connector: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected", async () => {
    const home = openTestHome();
    const contacts = await home.land(contactsVcard, deliver(home, CONTACTS_SOURCE, { "contacts.vcf": vcardBytes() }, EXPORT_FACTS));
    expect(contacts).toMatchObject({ new: 3, refused: 0 });
    expect(home.heads(CONTACTS_SOURCE).map((head) => (head.content as { card: string }).card).sort()).toEqual([CARD_B, CARD_C, CARD_D].sort());
    artifact(home.dir, "heads.json", { contacts, heads: home.heads(CONTACTS_SOURCE) });
  });

  it("an empty label .vcf is refused or lands a card", async () => {
    const home = openTestHome();
    const source = "google-contacts:person-a@example.com:export";
    const zip = join(temp(), "takeout-20261028T000000Z-001.zip");
    writeZip(zip, Object.entries(takeoutContacts()).map(([name, bytes]) => ({ name, bytes })));
    const takeout = deliver(home, source, { "takeout-20261028T000000Z-001.zip": readFileSync(zip) }, { ...EXPORT_FACTS, import: { kind: "google-takeout", id: "20261028T000000Z" } });
    const rows = await collect(contactsVcard.read(takeout, home.blobs));
    expect(rows.map((row) => (row.refused === undefined ? `${row.kind} ${row.locator}` : `${row.key}: ${row.refused}`))).toEqual([
      "contact takeout-20261028T000000Z-001.zip/Takeout/Contacts/My Contacts/My Contacts.vcf:byte 0",
      expect.stringMatching(/^contact .*My Contacts\.vcf:byte \d+$/u),
      expect.stringMatching(/^contact .*My Contacts\.vcf:byte \d+$/u),
      `${CONSUMED} takeout-20261028T000000Z-001.zip`,
    ]);
    const landed = await home.land(contactsVcard, takeout);
    expect(landed).toMatchObject({ new: 3, refused: 0 });
    expect(home.heads(source).map((head) => (head.content as { card: string }).card).sort()).toEqual([CARD_B, CARD_C, CARD_D].sort());
    const none = await home.land(contactsVcard, deliver(home, source, { "Starred.vcf": EMPTY_LIST, "Coworkers.vcf": BLANK_LIST }, EXPORT_FACTS));
    expect(none).toMatchObject({ new: 0, refused: 0 });
    artifact(home.dir, "empty-lists.json", { rows, landed, none });
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    const contacts = await collect(contactsVcard.read(deliver(home, CONTACTS_SOURCE, { "contacts.vcf": vcardBytes() }, EXPORT_FACTS), home.blobs));
    const ours = parityOf(contacts);
    const golden = parityOf(readGolden(join(TEST, "golden.json")));
    artifact(home.dir, "parity.json", { golden, ours });
    expect(ours).toEqual(golden);
  });

  it("an edited card replaces the old one", async () => {
    const home = openTestHome();
    await home.land(contactsVcard, deliver(home, CONTACTS_SOURCE, { "contacts.vcf": vcardBytes() }, EXPORT_FACTS));
    const edited = await home.land(contactsVcard, deliver(home, CONTACTS_SOURCE, { "contacts.vcf": vcardBytes([CARD_B, CARD_D.replace("Person D", "Person D2")]) }, { exported_at: "2026-09-20T00:00:00Z" }));
    expect(edited).toMatchObject({ gone: 0, new: 1, restated: 1 });
    expect(home.heads(CONTACTS_SOURCE).filter((head) => head.gone)).toEqual([]);
    expect(home.heads(CONTACTS_SOURCE)).toHaveLength(4);
    artifact(home.dir, "heads.json", { edited, heads: home.heads(CONTACTS_SOURCE) });
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const home = openTestHome();
    const contacts = await home.land(contactsVcard, deliver(home, CONTACTS_SOURCE, { "contacts.vcf": vcardBytes([CARD_B, CARD_C, CARD_B]) }, EXPORT_FACTS));
    expect(contacts.duplicated).toBe(1);
    artifact(home.dir, "landed.json", { contacts });
  });

  it("a malformed export is sliced past its fault, or takes its cards before the fault or the export beside it with it", async () => {
    const home = openTestHome();
    const good = { "b.vcf": vcardBytes([CARD_C]) };
    const read = async (bad: Buffer) => (await collect(contactsVcard.read(deliver(home, CONTACTS_SOURCE, { "a.vcf": bad, ...good }, EXPORT_FACTS), home.blobs))).map((row) => (row.refused === undefined ? `${row.kind} ${row.locator}` : `${row.key}: ${row.refused}`));
    const rows = { stray: await read(Buffer.from(`${CARD_B}stray text\r\n`)), unended: await read(Buffer.from(CARD_B.replace("END:VCARD\r\n", ""))) };
    expect(rows.stray).toEqual(["contact a.vcf:byte 0", expect.stringMatching(/^a\.vcf: a\.vcf: bytes outside a card/u), "contact b.vcf:byte 0"]);
    expect(rows.unended).toEqual([expect.stringMatching(/^a\.vcf: a\.vcf: the card at byte 0 never ends/u), "contact b.vcf:byte 0"]);
    await expect(collect(contactsVcard.read(deliver(home, CONTACTS_SOURCE, { "a.txt": Buffer.from(CARD_B) }, EXPORT_FACTS), home.blobs))).rejects.toThrow(Refused);
    artifact(home.dir, "malformed.json", rows);
  });
  it("a .vcf is read whole or twice, or sliced other than whole by the chunks' edges, or a faulty one refuses the cards before its fault", async () => {
    const home = openTestHome();
    const whole: string[] = [];
    const watched = { ...home.blobs, has: home.blobs.has.bind(home.blobs), prefix: home.blobs.prefix.bind(home.blobs), text: home.blobs.text.bind(home.blobs),
      materialise: home.blobs.materialise.bind(home.blobs), bytes: (blob: string) => { whole.push(blob); return home.blobs.bytes(blob); } };
    const delivery = deliver(home, CONTACTS_SOURCE, { "contacts.vcf": vcardBytes() }, EXPORT_FACTS);
    const rows = await collect(contactsVcard.read(delivery, watched));
    expect(rows.filter((row) => row.refused === undefined)).toHaveLength(3);
    expect(whole).toEqual([]);
    const bytes = vcardBytes();
    const [b, c] = [CARD_B, CARD_C].map((card) => Buffer.byteLength(card)) as [number, number];
    const expected = ([[0, CARD_B], [b + 2, CARD_C], [b + 2 + c + 2, CARD_D]] as const).map(([start, text]) => ({ start, end: start + Buffer.byteLength(text), text }));
    for (const size of [1, 2, 3, 7, 64, bytes.length]) {
      const chunks = Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => bytes.subarray(index * size, (index + 1) * size));
      const cards: { start: number; end: number; text: string }[] = [];
      for await (const card of streamCards(chunks, "contacts.vcf")) cards.push({ start: card.start, end: card.end, text: card.bytes.toString("utf8") });
      expect(cards, `chunks of ${size}`).toEqual(expected);
    }
    expect(cardCount(bytes, "contacts.vcf")).toBe(3);
    const many = Buffer.from(Array.from({ length: 1000 }, (_, index) => `BEGIN:VCARD\r\nFN:Person ${index}\r\nEND:VCARD\r\n`).join(""));
    const size = 32;
    let pulled = 0;
    const counted = function* () {
      for (let at = 0; at < many.length; at += size) {
        pulled++;
        yield many.subarray(at, at + size);
      }
    };
    let ahead = 0, seen = 0;
    for await (const card of streamCards(counted(), "many.vcf")) {
      ahead = Math.max(ahead, pulled - Math.ceil(card.end / size));
      seen++;
    }
    expect(seen).toBe(1000);
    expect(ahead).toBe(0);
    let opened = 0;
    const counting = { ...watched, materialise: (blob: string) => { opened++; return home.blobs.materialise(blob); } };
    const faulty = deliver(home, CONTACTS_SOURCE, { "a.vcf": Buffer.from(`${CARD_B}${CARD_C}stray\r\n`), "b.vcf": vcardBytes([CARD_D]) }, EXPORT_FACTS);
    const read = await collect(contactsVcard.read(faulty, counting));
    expect(read.map((row) => (row.refused === undefined ? `${row.kind} ${row.locator}` : `${row.key}: ${row.refused}`))).toEqual([
      "contact a.vcf:byte 0", `contact a.vcf:byte ${Buffer.byteLength(CARD_B)}`,
      expect.stringMatching(/^a\.vcf: a\.vcf: bytes outside a card at byte \d+/u), "contact b.vcf:byte 0",
    ]);
    expect(opened).toBe(2);
    const landed = await home.land(contactsVcard, faulty);
    expect(landed).toMatchObject({ new: 3, refused: 1 });
    expect(home.heads(CONTACTS_SOURCE).map((head) => (head.content as { card: string }).card)).toEqual(expect.arrayContaining([CARD_B, CARD_C, CARD_D]));
    artifact(home.dir, "stream.json", { rows: rows.length, whole_reads: whole.length, cards: seen, chunks_ahead: ahead, chunks: pulled, faulty: read.map((row) => row.refused ?? row.locator ?? null), faulty_landed: landed, faulty_opened: opened });
  });
});
