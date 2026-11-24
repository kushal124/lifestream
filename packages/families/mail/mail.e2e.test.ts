import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { civilDay, digest, piecesText, type Ask, type DaySettings, type Json, type ReaderOutput } from "@lifestreamprotocol/core";
import { readLabels } from "../shared/labels.js";
import { renderDay, type DayDocument, tableUnits } from "../days.js";
import { mailDayPart } from "../messages/people.js";
import { mailFamily } from "./family.js";
import { MAIL_TAG, MAIL_TAG_KINDS, MAIL_TAG_PROMPT } from "./tag.js";
import { askKey, blobName, dayReader, FakeLedger, inputHash, TAG_ROUTE, TestHome } from "../test/drive.js";
import { FED, NETWORKED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { conforming } from "../test/units.js";

interface GoldenMail { file: string; at_ms: number; input: string }
interface Golden {
  prompt: { sha256: string };
  mails: GoldenMail[];
}

const mail = mailFamily({ books: FED.labels })(FED.mail);
const TEST = new URL("./test/", import.meta.url);
const GOLDEN = JSON.parse(readFileSync(new URL("tag-v1/golden.json", TEST), "utf8")) as Golden;
const DAY_GOLDEN = new URL("day.golden.txt", TEST);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const SOURCE = "gmail:person-a@example.com:cloud";
const CONTACTS = "apple-contacts:person-a@example.com:iphone-aa01";
const T0 = Date.UTC(2026, 9, 6, 12);
const HOUR = 3_600_000;

interface Mail { key: string; bytes: Buffer; at_ms: number; folder?: string; labels?: string[]; takeout?: boolean; extra?: Record<string, Json> }

const GOLDEN_MAILS: Mail[] = GOLDEN.mails.map((golden, index) => ({
  key: `179000000000000000${index + 1}`,
  bytes: readFileSync(new URL(`tag-v1/${golden.file}`, TEST)),
  at_ms: golden.at_ms,
}));

function syntheticMail(subject: string, headers: string[] = []): Buffer {
  return Buffer.from([
    "From: Machine B <alerts@example.com>", "To: person-a@example.com", `Subject: ${subject}`, ...headers,
    "Content-Type: text/plain; charset=utf-8", "", `Synthetic ${subject.toLowerCase()} body.`, "",
  ].join("\r\n"));
}

const SPAM: Mail = { key: "1790000000000000101", bytes: syntheticMail("Spam offer"), at_ms: Date.UTC(2026, 9, 4, 12), folder: "[Gmail]/Spam" };
const TRASH: Mail = { key: "1790000000000000102", bytes: syntheticMail("Old notice"), at_ms: Date.UTC(2026, 9, 4, 13), labels: ["\\Trash"] };
const TAKEOUT_SPAM: Mail = {
  key: "1790000000000000103", bytes: syntheticMail("Takeout spam", ["X-Gmail-Labels: Spam,Category Promotions", "X-GM-THRID: 1790000000000000103"]),
  at_ms: Date.UTC(2026, 9, 4, 14), takeout: true,
};

function threaded(key: string, minute: number, body: string, how: { thread: string; labels: string[]; takeout?: boolean; from?: string; to?: string }): Mail {
  const bytes = Buffer.from([
    `From: ${how.from ?? "Person A <person-a@example.com>"}`, `To: ${how.to ?? "Person B <person-b@example.com>"}`, "Subject: Re: synthetic plans",
    ...(how.takeout === true ? [`X-GM-THRID: ${how.thread}`, `X-Gmail-Labels: ${how.labels.join(",")}`] : []),
    "Content-Type: text/plain; charset=utf-8", "", body, "",
  ].join("\r\n"));
  const at_ms = Date.UTC(2026, 9, 4, 18, minute);
  return how.takeout === true ? { key, bytes, at_ms, takeout: true } : { key, bytes, at_ms, labels: how.labels, extra: { gm_thrid: how.thread } };
}
const THREAD = "1790000000000000120", OTHER = "1790000000000000130";
const DRAFTS: Mail[] = [
  threaded("1790000000000000120", 5, "Synthetic first save.", { thread: THREAD, labels: ["\\Draft"] }),
  threaded("1790000000000000121", 11, "Synthetic second save.", { thread: THREAD, labels: ["Drafts", "Opened"], takeout: true }),
  threaded("1790000000000000122", 12, "Synthetic reply as sent.", { thread: THREAD, labels: ["\\Sent"] }),
  threaded("1790000000000000130", 20, "Synthetic draft left standing.", { thread: OTHER, labels: ["\\Draft"] }),
  threaded("1790000000000000131", 30, "Synthetic answer from B.", { thread: OTHER, labels: ["\\Inbox"], from: "Person B <person-b@example.com>", to: "person-a@example.com" }),
];

const FROM_LINES: Mail = {
  key: "1790000000000000110", at_ms: Date.UTC(2026, 9, 4, 15), bytes: Buffer.from([
    "From: Person B <person-b@example.com>", "To: person-a@example.com", "Subject: Synthetic garden", "Date: Sun, 4 Oct 2026 15:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8", "", "From the synthetic garden, a note.", "From here on, the plans hold.", "",
  ].join("\r\n")),
};

const ATTACHED: Mail = {
  key: "1790000000000000111", at_ms: Date.UTC(2026, 9, 4, 16), bytes: Buffer.from([
    "From: Person B <person-b@example.com>", "To: person-a@example.com", "Subject: Synthetic sheet", "Date: Sun, 4 Oct 2026 16:00:00 +0000",
    "Content-Type: text/csv; name=\"sheet.csv\"", "Content-Disposition: attachment; filename=\"sheet.csv\"", "Content-Transfer-Encoding: 7bit",
    "", "a,b", "1,2", "",
  ].join("\r\n")),
};

function quotedLine(key: string, base64: boolean): Mail {
  const body = "Forwarded below.\r\n>From person-c: the synthetic line, as written.\r\n";
  return {
    key, at_ms: Date.UTC(2026, 9, 4, 17), bytes: Buffer.from([
      "From: Person B <person-b@example.com>", "To: person-a@example.com", "Subject: Synthetic forward", "Date: Sun, 4 Oct 2026 17:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8", `Content-Transfer-Encoding: ${base64 ? "base64" : "7bit"}`, "",
      base64 ? Buffer.from(body).toString("base64") : body,
    ].join("\r\n")),
  };
}

function takeout(item: Mail): Mail {
  const quoted = Buffer.from(item.bytes.toString("latin1").replace(/^(>*From )/gmu, ">$1"), "latin1");
  return { ...item, takeout: true, bytes: Buffer.concat([Buffer.from(`X-GM-THRID: ${item.key}\r\nX-Gmail-Labels: Inbox\r\n`), quoted, Buffer.from("\r\n")]) };
}

function row(item: Mail): ReaderOutput {
  const blob = blobName(item.bytes);
  const provider: Json = item.takeout === true
    ? { from_line: `From ${item.key}@xxx Sun Oct 04 12:00:00 +0000 2026` }
    : { gm_msgid: item.key, gm_thrid: item.key, folder: item.folder ?? "[Gmail]/All Mail", labels: item.labels ?? ["\\Inbox"], internaldate: new Date(item.at_ms).toISOString(), ...item.extra };
  return {
    kind: "mailmsg", key: item.key,
    content: { type: "gmail.msg", content: provider, blobs: [{ hash: blob, bytes: item.bytes.length, media_type: "message/rfc822", role: "original" }] },
    time: { start_ms: item.at_ms, precision: "s" },
    blobs: [blob],
  };
}

function landMail(home: TestHome, stated_ms: number, mails: Mail[]): void {
  for (const item of mails) home.blobs.put(item.bytes);
  home.land(SOURCE, stated_ms, mails.map(row));
}

function tagger(ask: Ask): string {
  const machine = /\nFrom: (?:Synthetic News|Machine)/u.test(piecesText(ask.input));
  return JSON.stringify(machine
    ? { from: "machine", kind: "newsletter", topic: "weekly digest", provider: "Synthetic News", amount: null, reference: null, gist: "A weekly digest of synthetic items." }
    : { from: "person", kind: "other", topic: "plans", provider: null, amount: null, reference: null, gist: "A synthetic note between people." });
}

const PEOPLE = "people:local:macbook-pro-0001";

function you(address: string, others: string[] = [], me = true): ReaderOutput {
  return {
    kind: "person", key: "sam",
    content: {
      type: "people.person", slug: "sam", name: "Sam", full_name: "Sam Example", show: "name", entity: "person", relationship: null, hidden: false, me,
      anchor: { kind: "email", value: address }, handles: others.map((value) => ({ kind: "email", value })), excluded: [], dismissed: [], merged_into: null,
    },
  };
}

function card(name: string, email: string): ReaderOutput {
  const text = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${name}\r\nEMAIL:${email}\r\nEND:VCARD\r\n`;
  return { kind: "contact", key: createHash("sha256").update(text).digest("hex"), content: { type: "contacts.card", card: text } };
}

function renderAll(home: TestHome): Map<string, DayDocument> {
  const days = home.read((view) => [...new Set([...view.extracts("mail")].flatMap((extract) => extract.days))].sort());
  const rendered = home.renderDays(days, (view) => readLabels(view, null, NETWORKED), [mail], SETTINGS);
  return new Map([...rendered].map(([day, files]) => [day, JSON.parse(files.json) as DayDocument]));
}

const homes: TestHome[] = [];
function home(prefix: string): TestHome {
  const opened = new TestHome(`families-mail-${prefix}-`);
  homes.push(opened);
  return opened;
}
afterEach(() => {
  for (const opened of homes.splice(0)) opened.close();
});

describe("mail family", () => {
  it("a mail-tag input differs from the golden, or its prompt states a type that leaves a tag's member unchecked", () => {
    const h = home("golden");
    landMail(h, T0, GOLDEN_MAILS);
    expect(h.extractPass(mail, SETTINGS).written.length).toBeGreaterThan(0);
    const asks = h.read((view) => [...view.extracts("mail")]).flatMap((extract) => mail.plan!(extract, new Map()).asks);
    const found = GOLDEN.mails.map((golden, index) => {
      const ask = asks.find((candidate) => candidate.item === `${SOURCE}/${GOLDEN_MAILS[index]!.key}`);
      expect(ask, golden.file).toBeDefined();
      const text = golden.input.slice(0, golden.input.length - piecesText(ask!.input).length);
      expect(golden.input.endsWith(piecesText(ask!.input)), golden.file).toBe(true);
      expect(createHash("sha256").update(text, "utf8").digest("hex"), golden.file).toBe(GOLDEN.prompt.sha256);
      expect(ask!.prompt, golden.file).toBe(MAIL_TAG);
      expect(ask!.identity, golden.file).toBeUndefined();
      expect(inputHash(ask!), golden.file).toBe(digest(piecesText(ask!.input)));
      expect([ask!.work, ask!.source], golden.file).toEqual(["mail", SOURCE]);
      return { file: golden.file, item: ask!.item, ...askKey(mail, ask!, TAG_ROUTE) };
    });
    const type = MAIL_TAG_PROMPT.type as { properties: Record<string, { type: unknown; enum?: string[] }>; required: string[]; additionalProperties: boolean };
    expect([MAIL_TAG_PROMPT.version, MAIL_TAG_PROMPT.keeps]).toEqual([1, []]);
    expect([Object.keys(type.properties), type.required, type.additionalProperties])
      .toEqual([["from", "kind", "topic", "provider", "amount", "reference", "gist"], ["from", "kind", "topic", "provider", "amount", "reference", "gist"], false]);
    expect([type.properties.from!.enum, type.properties.kind!.enum]).toEqual([["person", "machine"], [...MAIL_TAG_KINDS]]);
    expect(["provider", "amount", "reference"].map((member) => type.properties[member]!.type)).toEqual([["string", "null"], ["string", "null"], ["string", "null"]]);
    h.artifact("asks.json", found);
  });

  it("a mail's search text reads quoted history, misses its words or addresses, or reads past 256 KB of its bytes", () => {
    const h = home("texts");
    landMail(h, T0, [...GOLDEN_MAILS, SPAM, TRASH, TAKEOUT_SPAM]);
    h.land(SOURCE, T0, [row({ key: "1790000000000000201", bytes: syntheticMail("Never here"), at_ms: Date.UTC(2026, 9, 5, 12) })]);
    const texts = h.texts(mail);
    const of = (key: string) => texts.find((entry) => entry.record === `${SOURCE} mailmsg ${key}`)!.text;
    expect(of(GOLDEN_MAILS[0]!.key)).toEqual({
      title: "Re: synthetic plans",
      text: "Sounds good, see you at the synthetic place at six. It’s on me. Bring the synthetic notes.",
      who: ["person-b@example.com", "person-a@example.com"],
    });
    expect(of(GOLDEN_MAILS[4]!.key)!.who).toEqual(["no-reply@example.com", "person-b@example.com", "person-c@example.com"]);
    expect(of("1790000000000000201")).toBeNull();
    const path = new URL("text.golden.json", TEST);
    const json = `${JSON.stringify(texts, null, 2)}\n`;
    if (UPDATE) writeFileSync(path, json);
    expect(json).toBe(readFileSync(path, "utf8"));
    h.artifact("texts.json", texts);

    const boundary = "synthetic-boundary";
    const big = (key: string, subject: string, parts: string[]): Mail => ({
      key, at_ms: Date.UTC(2026, 9, 5, 13), bytes: Buffer.from([
        "From: Person B <person-b@example.com>", "To: person-a@example.com", `Subject: ${subject}`, `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
        ...parts.flatMap((part) => [`--${boundary}`, part]), `--${boundary}--`, "",
      ].join("\r\n")),
    });
    const long = big("1790000000000000301", "Long", [`Content-Type: text/plain; charset=utf-8\r\n\r\n${"synthetic ".repeat(10_000)}`]);
    const late = big("1790000000000000302", "Late body", [
      `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="pad.bin"\r\n\r\n${"A".repeat(300 * 1024)}`,
      "Content-Type: text/plain; charset=utf-8\r\n\r\nWords past the read.",
    ]);
    landMail(h, T0 + HOUR, [long, late]);
    const after = h.texts(mail);
    const cut = after.find((entry) => entry.record === `${SOURCE} mailmsg ${long.key}`)!.text!;
    expect(cut.text).toBe("synthetic ".repeat(6_554).slice(0, 65_536));
    expect(after.find((entry) => entry.record === `${SOURCE} mailmsg ${late.key}`)!.text).toEqual({
      title: "Late body", text: "", who: ["person-b@example.com", "person-a@example.com"],
    });
  });

  it("an HTML mail's character reference naming half of a character puts half of one alone in its words, which the record route serves", () => {
    const h = home("references");
    const html: Mail = {
      key: "1790000000000000401", at_ms: Date.UTC(2026, 9, 5, 14), bytes: Buffer.from([
        "From: Person B <person-b@example.com>", "To: person-a@example.com", "Subject: Synthetic references", "Content-Type: text/html; charset=utf-8", "",
        "<p>Halves &#xD83C;&#xDF89; and &#55356; whole &#x1F389; zero &#0; past &#x110000; end</p>", "",
      ].join("\r\n")),
    };
    landMail(h, T0, [html]);
    const text = h.texts(mail).find((entry) => entry.record === `${SOURCE} mailmsg ${html.key}`)!.text!;
    expect(text.text).toBe("Halves \uFFFD\uFFFD and \uFFFD whole \u{1F389} zero \uFFFD past \uFFFD end");
    expect(JSON.stringify(text)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/u);
    h.artifact("references.json", text);
  });

  it("an extract is written when only an unread field ticked", () => {
    const h = home("tick");
    landMail(h, T0, [...GOLDEN_MAILS, SPAM]);
    h.extractPass(mail, SETTINGS);
    const ledger = new FakeLedger(TAG_ROUTE);
    ledger.settle(h, mail, tagger);
    const before = h.read((view) => [...view.extracts("mail")]);

    const ticked = [...GOLDEN_MAILS, SPAM].map((item): Mail => ({
      ...item,
      folder: item.folder ?? "INBOX",
      labels: item.labels ?? ["\\Inbox", "\\Important", "\\Starred", "Category Updates"],
      extra: { flags: ["\\Seen", "\\Flagged"], internaldate: new Date(item.at_ms + 7_000).toISOString() },
    }));
    const landed = h.land(SOURCE, T0 + HOUR, ticked.map(row));
    expect(landed.changed).toBe(ticked.length);
    const pass = h.extractPass(mail, SETTINGS);
    expect(pass.touched.length).toBeGreaterThan(0);
    expect(pass.written).toEqual([]);
    expect(ledger.settle(h, mail, tagger).asked).toEqual([]);
    expect(h.read((view) => [...view.extracts("mail")])).toEqual(before);
    h.artifact("tick.json", { changedPaths: landed.changedPaths, pass });
  });

  it("units differ when the same data arrives in another order", () => {
    const all = [...GOLDEN_MAILS, SPAM, TRASH, TAKEOUT_SPAM];
    const forward = home("forward");
    landMail(forward, T0, all);
    forward.extractPass(mail, SETTINGS);

    const backward = home("backward");
    [...all].reverse().forEach((item, index) => landMail(backward, T0 + index * HOUR, [item]));
    landMail(backward, T0 + HOUR, [all.at(-2)!]);
    landMail(backward, T0 - HOUR, [{ ...GOLDEN_MAILS[0]!, labels: ["\\Inbox", "Old"] }]);
    backward.extractPass(mail, SETTINGS);

    const units = (h: TestHome) => h.read((view) => [...view.extracts("mail")].map(({ unit, reading, content, days, start_ms, end_ms }) =>
      ({ unit, reading, content, days, start_ms, end_ms })));
    expect(units(backward)).toEqual(units(forward));
    forward.artifact("units.json", units(forward));
    pin(mail, { mail: FED.mail }, units(forward));
  });

  it("an answered email is asked again", () => {
    const h = home("answered");
    const mails = [...GOLDEN_MAILS, FROM_LINES, ATTACHED];
    landMail(h, T0, mails);
    h.extractPass(mail, SETTINGS);
    const ledger = new FakeLedger(TAG_ROUTE);
    let broken = false;
    const first = ledger.settle(h, mail, (ask) => {
      if (!broken && ask.item.endsWith(GOLDEN_MAILS[1]!.key)) {
        broken = true;
        return "not json";
      }
      return tagger(ask);
    });
    expect(first.refused).toEqual([`${SOURCE}/${GOLDEN_MAILS[1]!.key}`]);
    expect(first.asked).toHaveLength(mails.length + 1);
    const enrichments = h.read((view) => mails.map((item) => view.enrichment("mail", `${SOURCE}/${item.key}`, MAIL_TAG)));
    expect(enrichments.map((row) => row?.state)).toEqual(mails.map(() => "done"));
    expect(piecesText(first.asked.find((ask) => ask.item.endsWith(FROM_LINES.key))!.input)).toContain("\nFrom the synthetic garden, a note.\nFrom here on");
    expect(piecesText(first.asked.find((ask) => ask.item.endsWith(ATTACHED.key))!.input)).toContain("Attachments: sheet.csv (text/csv, 10 bytes)");

    expect(ledger.settle(h, mail, tagger).asked).toEqual([]);
    const exported = mails.map(takeout);
    expect(exported.map((item) => blobName(item.bytes))).not.toEqual(expect.arrayContaining(mails.map((item) => blobName(item.bytes))));
    landMail(h, T0 + 24 * HOUR, exported);
    expect(h.extractPass(mail, SETTINGS).written.length).toBeGreaterThan(0);
    expect(ledger.settle(h, mail, tagger).asked).toEqual([]);
    landMail(h, T0 + 48 * HOUR, mails);
    h.extractPass(mail, SETTINGS);
    expect(ledger.settle(h, mail, tagger).asked).toEqual([]);
    h.artifact("ledger.json", { sent: ledger.sent, enrichments });
  });

  it("a line a pull's body starts with `>From ` loses its `>`, or the same text in another encoding or from a Takeout is asked again", () => {
    const h = home("quoted");
    const mails = [quotedLine("1790000000000000120", false), quotedLine("1790000000000000121", true)];
    landMail(h, T0, mails);
    h.extractPass(mail, SETTINGS);
    const ledger = new FakeLedger(TAG_ROUTE);
    const first = ledger.settle(h, mail, tagger);
    expect(first.asked).toHaveLength(1);
    expect(piecesText(first.asked[0]!.input)).toContain("\nForwarded below.\n>From person-c: the synthetic line, as written.");
    expect(h.read((view) => mails.map((item) => view.enrichment("mail", `${SOURCE}/${item.key}`, MAIL_TAG)?.state))).toEqual(["done", "done"]);
    const exported = mails.map(takeout);
    expect(exported[0]!.bytes.toString("latin1")).toContain("\r\n>>From person-c:");
    landMail(h, T0 + HOUR, exported);
    expect(h.extractPass(mail, SETTINGS).written).toEqual([]);
    expect(ledger.settle(h, mail, tagger).asked).toEqual([]);
    h.artifact("quoted.json", { asked: first.asked.map((ask) => piecesText(ask.input)) });
  });

  it("a renamed contact re-asks anything", () => {
    const h = home("rename");
    landMail(h, T0, GOLDEN_MAILS);
    const before = card("Person B", "person-b@example.com");
    h.land(CONTACTS, T0, [before]);
    h.extractPass(mail, SETTINGS);
    const ledger = new FakeLedger(TAG_ROUTE);
    ledger.settle(h, mail, tagger);
    const extracts = h.read((view) => [...view.extracts("mail")]);
    const days = renderAll(h);
    const named = [...days.values()].flatMap((day) => day.atoms).filter((atom) => atom.text.includes("Mail from Person B"));
    expect(named.length).toBeGreaterThan(0);

    h.land(CONTACTS, T0 + HOUR, [{ ...before, content: null, gone: true }, card("Person B Renamed", "person-b@example.com")]);
    expect(h.extractPass(mail, SETTINGS)).toEqual({ touched: [], written: [], deleted: [] });
    expect(ledger.settle(h, mail, tagger).asked).toEqual([]);
    expect(h.read((view) => [...view.extracts("mail")])).toEqual(extracts);
    const after = renderAll(h);
    const renamed = [...after.values()].flatMap((day) => day.atoms).filter((atom) => atom.text.includes("Mail from Person B Renamed"));
    expect(renamed).toHaveLength(named.length);
    for (const [day, document] of after) {
      if (days.get(day)!.atoms.some((atom) => atom.text.includes("Person B"))) expect(document.inputs, day).not.toBe(days.get(day)!.inputs);
    }
    h.artifact("rename.json", { before: named.map((atom) => atom.text), after: renamed.map((atom) => atom.text) });
  });

  it("renderDay reads outside days()", () => {
    const h = home("days");
    h.land(PEOPLE, T0, [you("person-a@example.com")]);
    landMail(h, T0, [...GOLDEN_MAILS, SPAM, TRASH]);
    h.extractPass(mail, SETTINGS);
    new FakeLedger(TAG_ROUTE).settle(h, mail, tagger);

    const reads: { day: string; unit: string; days: string[] }[] = [];
    const first = civilDay(Math.min(...[...GOLDEN_MAILS, SPAM, TRASH].map((item) => item.at_ms)), SETTINGS);
    const range = Array.from({ length: 6 }, (_, index) => new Date(Date.parse(`${first}T00:00:00Z`) + (index - 1) * 86_400_000).toISOString().slice(0, 10));
    const printed = new Map<string, string[]>();
    h.read((view) => {
      const labels = readLabels(view, null, NETWORKED);
      const reader = dayReader(view);
      for (const day of range) {
        const files = conforming(renderDay(day, [mail], {
          ...reader,
          extractsOn: (family, on) => [...reader.extractsOn(family, on)].map((extract) => {
            reads.push({ day: on, unit: extract.unit, days: extract.days });
            return extract;
          }),
        }, SETTINGS, tableUnits(labels)));
        for (const atom of (JSON.parse(files.json) as DayDocument).atoms) printed.set(atom.record!.key, [...printed.get(atom.record!.key) ?? [], day]);
      }
    });
    for (const item of [...GOLDEN_MAILS, SPAM, TRASH]) expect(printed.get(item.key), item.key).toEqual([civilDay(item.at_ms, SETTINGS)]);
    for (const entry of reads) expect(entry.days).toContain(entry.day);

    const extract = h.read((view) => [...view.extracts("mail")][0]!);
    const outside = "2026-01-01";
    const stray = h.read((view) => renderDay(outside, [mail], { ...dayReader(view), extractsOn: () => [{ ...extract, days: [...extract.days, outside] }] }, SETTINGS, tableUnits(readLabels(view, null, NETWORKED))));
    expect((JSON.parse(stray.json) as DayDocument).atoms).toEqual([]);
    h.artifact("reads.json", { reads, printed: Object.fromEntries(printed) });

    const golden = h.renderDays([civilDay(GOLDEN_MAILS[0]!.at_ms, SETTINGS)], (view) => readLabels(view, null, NETWORKED), [mail], SETTINGS);
    const txt = [...golden.values()][0]!.txt;
    if (UPDATE) writeFileSync(DAY_GOLDEN, txt);
    expect(txt).toBe(readFileSync(DAY_GOLDEN, "utf8"));
  });

  it("an email in spam or trash is asked", () => {
    const h = home("junk");
    landMail(h, T0, [GOLDEN_MAILS[0]!, SPAM, TRASH, TAKEOUT_SPAM]);
    h.extractPass(mail, SETTINGS);
    const ledger = new FakeLedger(TAG_ROUTE);
    const asked = ledger.settle(h, mail, tagger).asked.map((ask) => ask.item);
    expect(asked).toEqual([`${SOURCE}/${GOLDEN_MAILS[0]!.key}`]);
    const items = h.read((view) => [...view.extracts("mail")].flatMap((extract) => mail.items!(extract).map((entry) => entry.item)));
    expect(items).toEqual(asked);

    landMail(h, T0 + HOUR, [{ ...GOLDEN_MAILS[0]!, labels: ["\\Trash"] }]);
    expect(h.extractPass(mail, SETTINGS).written).toHaveLength(1);
    expect(ledger.settle(h, mail, tagger).asked).toEqual([]);
    const atoms = [...renderAll(h).values()].flatMap((day) => day.atoms);
    const junk = atoms.filter((atom) => atom.text.startsWith("Mail in ")).map((atom) => atom.text);
    expect(junk).toEqual(expect.arrayContaining([
      "Mail in Spam from Machine B: “Spam offer”", "Mail in Trash from Machine B: “Old notice”", "Mail in Spam from Machine B: “Takeout spam”",
      "Mail in Trash from Person B: “Re: synthetic plans”",
    ]));
    expect(atoms.filter((atom) => atom.item !== undefined)).toEqual([]);
    h.artifact("junk.json", { asked, junk });
  });

  it("a replaced draft save prints, a standing draft is lost, a draft is asked or counts to anyone, or a mail sent prints as a draft", () => {
    const h = home("drafts");
    h.land(PEOPLE, T0, [you("person-a@example.com")]);
    landMail(h, T0, DRAFTS);
    h.extractPass(mail, SETTINGS);
    const asked = new FakeLedger(TAG_ROUTE).settle(h, mail, tagger).asked.map((ask) => ask.item);
    expect(asked).toEqual([`${SOURCE}/1790000000000000122`, `${SOURCE}/1790000000000000131`]);
    const lines = [...renderAll(h).values()].flatMap((day) => day.atoms).filter((atom) => atom.family === "mail").map((atom) => atom.text);
    expect(lines).toEqual([
      "Mail from the user to Person B: “Re: synthetic plans” — Synthetic reply as sent.",
      "Mail in Drafts from the user to Person B: “Re: synthetic plans” — Synthetic draft left standing.",
      "Mail from Person B to the user: “Re: synthetic plans” — Synthetic answer from B.",
    ]);
    const parts = h.read((view) => [...view.extracts("mail")].map((extract) => mailDayPart(extract.content, "person-a@example.com", SETTINGS)));
    const b = parts.flatMap((part) => part.addresses).filter((address) => address.address === "person-b@example.com");
    expect(b.map((address) => [Object.values(address.to), Object.values(address.from)])).toEqual([[[1], [1]]]);
    h.artifact("drafts.json", { asked, lines, person_b: b });
  });

  it("mail from or to another address of You names the owner, or the mailbox's own address stops reading \"the user\"", () => {
    const h = home("you");
    const own = "gmail:sam@example.com:cloud";
    const between = (key: string, hour: number, from: string, to: string, body: string): Mail => ({
      key, at_ms: Date.UTC(2026, 9, 5, hour), bytes: Buffer.from([
        `From: ${from}`, `To: ${to}`, "Subject: Plan", `Date: Mon, 5 Oct 2026 ${hour}:00:00 +0000`, "Content-Type: text/plain; charset=utf-8", "", body, "",
      ].join("\r\n")),
    });
    const mails = [
      between("1790000000000000501", 14, "Sam <sam-work@example.com>", "Person A <person-a@example.com>", "see you"),
      between("1790000000000000502", 15, "Person A <person-a@example.com>", "sam-work@example.com", "sounds good"),
      between("1790000000000000503", 16, "sam@example.com", "Person A <person-a@example.com>", "from the mailbox"),
    ];
    for (const item of mails) h.blobs.put(item.bytes);
    h.land(own, T0, mails.map(row));
    h.land(CONTACTS, T0, [card("Person A", "person-a@example.com")]);
    h.land(PEOPLE, T0, [you("sam-work@example.com", [], false)]);
    h.extractPass(mail, SETTINGS);
    const lines = () => [...renderAll(h).values()].flatMap((day) => day.atoms).filter((atom) => atom.family === "mail").map((atom) => atom.text);
    const before = lines();
    expect(before).toEqual([
      "Mail from Sam to Person A: “Plan” — see you",
      "Mail from Person A to Sam: “Plan” — sounds good",
      "Mail from the user to Person A: “Plan” — from the mailbox",
    ]);
    h.land(PEOPLE, T0 + 1, [you("sam@example.com", ["sam-work@example.com"])]);
    const after = lines();
    expect(after).toEqual([
      "Mail from the user to Person A: “Plan” — see you",
      "Mail from Person A to the user: “Plan” — sounds good",
      "Mail from the user to Person A: “Plan” — from the mailbox",
    ]);
    const spans = [...renderAll(h).values()].flatMap((day) => day.atoms).filter((atom) => atom.family === "mail").flatMap((atom) => atom.names ?? []);
    expect(spans.some((span) => span.who === "person:sam")).toBe(false);
    h.artifact("you.json", { before, after });
  });

  it("an erasure misses an email's copy from either route, names another mailbox's email, or takes a thing that is no mail", () => {
    const h = home("erase");
    const OTHER_BOX = "gmail:person-c@example.com:cloud";
    const [one, two] = GOLDEN_MAILS as [Mail, Mail];
    landMail(h, T0, [one, two]);
    landMail(h, T0 + HOUR, [takeout(one)]);
    h.land(SOURCE, T0 + HOUR, [{ kind: "chat", key: one.key, content: { type: "gmail.thread", thread_id: one.key, messages: [one.key] }, time: { start_ms: one.at_ms, precision: "s" } }]);
    h.land(SOURCE, T0 + 2 * HOUR, [{ ...row(two), gone: true }]);
    h.land(OTHER_BOX, T0, [row(one)]);
    h.extractPass(mail, SETTINGS);
    const email = (source: string, key: string) => ({ source, kind: "mailmsg", key });
    const erased = h.read((view) => {
      const labels = readLabels(view, null, NETWORKED);
      const of = (thing: string) => mail.replicas!(thing, view, labels);
      return {
        one: of(`${SOURCE}/${one.key}`), gone: of(`${SOURCE}/${two.key}`), other: of(`${OTHER_BOX}/${one.key}`),
        mailbox: of(SOURCE), all: of("all"),
        none: [`${SOURCE}/1790000000000009999`, "gmail:person-z@example.com:cloud", `gmail:person-z@example.com:cloud/${one.key}`, "whatsapp:+15550000001:macbook-pro-0001", one.key, ""].map(of),
        versions: new Set(view.history(email(SOURCE, one.key)).map((statement) => statement.version)).size,
        asked: [...view.extracts("mail")].flatMap((extract) => mail.items!(extract).map((each) => each.item)),
      };
    });
    expect(erased.one).toEqual({ records: [email(SOURCE, one.key)], items: [`${SOURCE}/${one.key}`] });
    expect(erased.versions).toBe(2);
    expect(erased.asked).toContain(`${SOURCE}/${one.key}`);
    expect(erased.gone).toEqual({ records: [email(SOURCE, two.key)], items: [`${SOURCE}/${two.key}`] });
    expect(erased.other).toEqual({ records: [email(OTHER_BOX, one.key)], items: [`${OTHER_BOX}/${one.key}`] });
    const mailbox = { records: [{ source: SOURCE, kind: "chat", key: one.key }, email(SOURCE, one.key), email(SOURCE, two.key)], items: [`${SOURCE}/${one.key}`, `${SOURCE}/${two.key}`] };
    expect(erased.mailbox).toEqual(mailbox);
    expect(erased.all).toEqual({ records: [...mailbox.records, email(OTHER_BOX, one.key)], items: [...mailbox.items, `${OTHER_BOX}/${one.key}`] });
    for (const none of erased.none) expect(none).toEqual({ records: [], items: [] });
    h.artifact("erase.json", erased);
  });
});
