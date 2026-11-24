import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { crc32, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { type DaySettings, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import type { DayDocument } from "../days.js";
import { buildLabels } from "../shared/labels.js";
import { TEXT_BYTES } from "../shared/text.js";
import { shuffled, TestHome } from "../test/drive.js";
import { LINE_CHARS, notesFamily as notesOver, type Note } from "./family.js";
import { FED } from "../test/fed.js";
import { pin } from "../test/pin.js";

const notesFamily = notesOver(FED.notes);
const GOLDEN = new URL("./test/", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const NEW_YORK: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const LABELS = buildLabels({ people: [], contacts: [], places: [] });
const MAC = "apple-notes:person-a@example.com:macbook-pro-0001";
const GRANOLA = "granola:person-a@example.com:cloud";
const OTHER_MAC = "apple-notes:person-a@example.com:mac-mini-aa43";
const APPLE_EPOCH_S = 978_307_200;
const STATED = Date.UTC(2026, 9, 12);


type Field = [number, number | Uint8Array | string | Field[]];

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

function message(fields: readonly Field[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [number, value] of fields) {
    if (typeof value === "number") {
      parts.push(Uint8Array.from([...varint(number * 8), ...varint(value)]));
      continue;
    }
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : message(value);
    parts.push(Uint8Array.from([...varint(number * 8 + 2), ...varint(bytes.length)]), bytes);
  }
  return Buffer.concat(parts);
}

interface Run { length: number; style?: number; indent?: number; done?: 0 | 1; attachment?: { id: string; uti: string } }

function runOf(run: Run): Field[] {
  const paragraph: Field[] = [];
  if (run.style !== undefined) paragraph.push([1, run.style]);
  if (run.indent !== undefined) paragraph.push([4, run.indent]);
  if (run.done !== undefined) paragraph.push([5, [[1, new Uint8Array(16)], [2, run.done]]]);
  const fields: Field[] = [[1, run.length]];
  if (paragraph.length > 0) fields.push([2, paragraph]);
  fields.push([13, 7]);
  if (run.attachment !== undefined) fields.push([12, [[1, run.attachment.id], [2, run.attachment.uti]]]);
  return fields;
}

function noteProto(text: string, runs: readonly Run[]): Uint8Array {
  const note: Field[] = [[2, text], [3, [[1, [[1, 1], [2, 1]]], [2, 4]]], [4, [[1, new Uint8Array(16)]]], ...runs.map((run): Field => [5, runOf(run)])];
  return message([[1, 0], [2, [[1, 0], [2, 0], [3, note]]]]);
}

function gzip(bytes: Uint8Array, block = 65_535): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff])];
  for (let at = 0; at === 0 || at < bytes.length; at += block) {
    const chunk = bytes.subarray(at, at + block);
    const last = at + block >= bytes.length ? 1 : 0;
    parts.push(Uint8Array.from([last, chunk.length & 0xff, chunk.length >> 8, ~chunk.length & 0xff, (~chunk.length >> 8) & 0xff]), chunk);
  }
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(bytes), 0);
  tail.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([...parts, tail]);
}

function body(text: string, runs: readonly Run[] = [{ length: text.length }]): Uint8Array {
  return gzip(noteProto(text, runs));
}

function bytes64(value: Uint8Array): JsonObject {
  return { $bytes64: Buffer.from(value).toString("base64") };
}

interface NoteSpec {
  id: string;
  title: string | null;
  snippet?: string | null;
  created?: string;
  edited?: string;
  body?: Uint8Array | null;
  locked?: boolean;
  marked?: boolean;
  folder?: { title: string; type: number };
  attachments?: { id: string; uti: string; url?: string; title?: string }[];
  sync?: number;
}

function seconds(iso: string): number {
  return Date.parse(iso) / 1000 - APPLE_EPOCH_S;
}

function note(spec: NoteSpec): ReaderOutput {
  const created = spec.created === undefined ? null : seconds(spec.created);
  const edited = spec.edited === undefined ? null : seconds(spec.edited);
  const locked = spec.locked === true;
  return {
    kind: "note",
    key: spec.id,
    content: {
      type: "apple.note",
      note: {
        ZIDENTIFIER: spec.id, ZTITLE1: spec.title, ZSNIPPET: spec.snippet ?? null, ZPASSWORDHINT: locked ? "a synthetic hint" : null,
        ZCREATIONDATE3: created, ZMODIFICATIONDATE1: edited,
        ZISPINNED: 0, ZISPASSWORDPROTECTED: locked ? 1 : 0, ZMARKEDFORDELETION: spec.marked === true ? 1 : 0, ZHASCHECKLIST: 0, ZHASCHECKLISTINPROGRESS: 0,
        ZHASEMPHASIS: 0, ZHASSYSTEMTEXTATTACHMENTS: 0, ZPAPERSTYLETYPE: spec.sync ?? 0, ZISSYSTEMPAPER: 0, ZCRYPTOITERATIONCOUNT: locked ? 20000 : null,
        ZCRYPTOSALT: locked ? bytes64(new Uint8Array(16).fill(1)) : null, ZCRYPTOWRAPPEDKEY: locked ? bytes64(new Uint8Array(24).fill(2)) : null,
        ZCRYPTOINITIALIZATIONVECTOR: locked ? bytes64(new Uint8Array(16).fill(3)) : null, ZCRYPTOTAG: locked ? bytes64(new Uint8Array(16).fill(4)) : null,
      },
      body: spec.body === null ? null : {
        ZDATA: spec.body === undefined ? null : bytes64(spec.body),
        ZCRYPTOINITIALIZATIONVECTOR: locked ? bytes64(new Uint8Array(16).fill(5)) : null,
        ZCRYPTOTAG: locked ? bytes64(new Uint8Array(16).fill(6)) : null,
      },
      folder: spec.folder === undefined ? { ZIDENTIFIER: "FOLDER-NOTES", ZTITLE2: "Notes", ZFOLDERTYPE: 0, parent: null }
        : { ZIDENTIFIER: `FOLDER-${spec.folder.type}`, ZTITLE2: spec.folder.title, ZFOLDERTYPE: spec.folder.type, parent: null },
      attachments: (spec.attachments ?? []).map((attachment) => ({
        ZIDENTIFIER: attachment.id, ZTYPEUTI: attachment.uti, ZTITLE: attachment.title ?? null, ZURLSTRING: attachment.url ?? null,
        ZCREATIONDATE: created, ZMODIFICATIONDATE: edited, ZFILESIZE: null, ZMARKEDFORDELETION: 0, media: null,
      })),
    },
    ...(created === null && edited === null ? {} : {
      time: created === null || edited === null || edited <= created
        ? { start_ms: Math.round(((created ?? edited)! + APPLE_EPOCH_S) * 1000), precision: "ms" as const }
        : { start_ms: Math.round((created + APPLE_EPOCH_S) * 1000), end_ms: Math.round((edited + APPLE_EPOCH_S) * 1000), precision: "ms" as const },
    }),
  };
}


const GROCERIES_TEXT = "Groceries\n😀 fake list\nsynthetic milk\nsynthetic eggs\nsynthetic bread\n";
const GROCERIES = body(GROCERIES_TEXT, [
  { length: 10, style: 0 },
  { length: 13 },
  { length: 15, style: 103, done: 1 },
  { length: 15, style: 103, done: 0 },
  { length: 16, style: 103, done: 0 },
]);

const PLAN_TEXT = "Plan\nfirst synthetic step\nsecond synthetic step\nnested bullet\nthird synthetic step\n";
const PLAN = body(PLAN_TEXT, [
  { length: 5, style: 0 },
  { length: 21, style: 102 },
  { length: 22, style: 102 },
  { length: 14, style: 101, indent: 1 },
  { length: 21, style: 102 },
]);

const SKETCH_TEXT = "Sketches\nsee ￼ and ￼\nalso ￼\n￼";
const SKETCH = body(SKETCH_TEXT, [
  { length: 9, style: 0 },
  { length: 4 }, { length: 1, attachment: { id: "ATT-IMAGE-1", uti: "public.png" } }, { length: 5 },
  { length: 1, attachment: { id: "ATT-DRAW-1", uti: "com.apple.drawing.2" } }, { length: 6 },
  { length: 1, attachment: { id: "ATT-LINK-1", uti: "public.url" } }, { length: 1 },
  { length: 1, attachment: { id: "ATT-ODD-1", uti: "com.example.synthetic" } },
]);
const SKETCH_ATTACHMENTS = [
  { id: "ATT-IMAGE-1", uti: "public.png" },
  { id: "ATT-DRAW-1", uti: "com.apple.drawing.2" },
  { id: "ATT-LINK-1", uti: "public.url", url: "https://example.com/synthetic" },
  { id: "ATT-ODD-1", uti: "com.example.synthetic", title: "synthetic file.bin" },
];

const NOTEBOOK: ReaderOutput[] = [
  note({ id: "NOTE-GROCERIES", title: "Groceries", snippet: "😀 fake list", created: "2026-10-03T13:00:00Z", edited: "2026-10-03T13:20:00Z", body: GROCERIES }),
  note({ id: "NOTE-PLAN", title: "Plan", snippet: "first synthetic step", created: "2026-09-20T15:00:00Z", edited: "2026-10-03T18:30:00Z", body: PLAN }),
  note({ id: "NOTE-SKETCH", title: "Sketches", snippet: "see and", created: "2026-10-03T20:00:00Z", edited: "2026-10-03T20:00:00Z", body: SKETCH, attachments: SKETCH_ATTACHMENTS }),
  note({ id: "NOTE-LOCKED", title: "Synthetic secret", snippet: null, created: "2026-10-03T21:00:00Z", edited: "2026-10-03T21:05:00Z", body: Uint8Array.from([0x9e, 0x11, 0x42, 0x07]), locked: true }),
  note({ id: "NOTE-TRASH", title: "Old synthetic draft", snippet: "draft text", created: "2026-10-03T22:00:00Z", edited: "2026-10-03T22:10:00Z", body: body("Old synthetic draft\ndraft text"), folder: { title: "Recently Deleted", type: 1 } }),
  note({ id: "NOTE-PURGED", title: "Purged synthetic", snippet: "gone soon", created: "2026-10-03T23:00:00Z", edited: "2026-10-03T23:01:00Z", body: body("Purged synthetic\ngone soon"), marked: true }),
  note({ id: "NOTE-UNTIMED", title: "No synthetic time", snippet: "timeless", body: body("No synthetic time\ntimeless") }),
  note({ id: "NOTE-BLANK-FIRST", title: "Blank first", created: "2026-10-03T15:00:00Z", edited: "2026-10-03T15:00:00Z", body: body("\nBlank first\nafter the blank") }),
  note({ id: "NOTE-CUT-TITLE", title: "A synthetic first line that Notes cut…", created: "2026-10-03T16:00:00Z", edited: "2026-10-03T16:00:00Z", body: body("A synthetic first line that Notes cut short as its title\nmore") }),
  note({ id: "NOTE-BROKEN", title: "Broken synthetic", snippet: "the preview Notes kept", created: "2026-10-03T14:00:00Z", edited: "2026-10-03T14:00:00Z", body: gzip(Uint8Array.from([0x0a, 0xff, 0xff])) }),
];

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function newHome(): TestHome {
  const home = new TestHome("families-notes-", { families: [notesFamily], settings: NEW_YORK });
  home.addSource(MAC, "notes-mac");
  home.addSource(OTHER_MAC, "notes-mac");
  homes.push(home);
  return home;
}

function golden(name: string, text: string): void {
  const path = new URL(name, GOLDEN);
  if (UPDATE) writeFileSync(path, text);
  expect(existsSync(path), `${path.pathname} is missing; run with LIFESTREAM_UPDATE_GOLDEN=1`).toBe(true);
  expect(text).toBe(readFileSync(path, "utf8"));
}

describe("notes family: what must be impossible", () => {
  it("a note's search text loses its title and preview when its body cannot be read, or keeps words when it is marked for deletion", () => {
    const home = newHome();
    home.deliver(MAC, STATED, NOTEBOOK);
    const texts = Object.fromEntries(home.texts(notesFamily).map(({ record, text }) => [record.slice(MAC.length + 6), text]));
    expect(texts["NOTE-LOCKED"]).toEqual({ title: "Synthetic secret", text: "" });
    expect(texts["NOTE-BROKEN"]).toEqual({ title: "Broken synthetic", text: "the preview Notes kept" });
    expect(texts["NOTE-PURGED"]).toBeNull();
    expect(texts["NOTE-GROCERIES"]).toEqual({ title: "Groceries", text: "Groceries\n😀 fake list\n[x] synthetic milk\n[ ] synthetic eggs\n[ ] synthetic bread" });
    expect(JSON.stringify(Object.values(texts))).not.toMatch(/NOTE-|ATT-|FOLDER-|\$bytes64|sha256/u);
    golden("texts.golden.json", `${JSON.stringify(texts, null, 2)}\n`);
    home.artifact("texts.json", texts);
  });

  it("a note prints on a day it was neither created nor last edited, twice on one day, or when marked for deletion; a locked one prints words or hides that it is locked", () => {
    const home = newHome();
    const delivered = home.deliver(MAC, STATED, NOTEBOOK);
    expect(delivered.days).toEqual(["2026-09-20", "2026-10-03"]);
    const day = home.render("2026-10-03", LABELS);
    golden("2026-10-03.day.txt", day.txt);
    const created = home.render("2026-09-20", LABELS);
    golden("2026-09-20.day.txt", created.txt);
    const atoms = (JSON.parse(day.json) as DayDocument).atoms.filter((atom) => atom.family === "notes");
    expect(atoms.map((atom) => atom.record?.key)).toEqual(["NOTE-GROCERIES", "NOTE-BROKEN", "NOTE-BLANK-FIRST", "NOTE-CUT-TITLE", "NOTE-PLAN", "NOTE-SKETCH", "NOTE-LOCKED", "NOTE-TRASH"]);
    expect(day.txt).not.toMatch(/Purged synthetic|1970/u);
    expect(atoms.find((atom) => atom.record?.key === "NOTE-LOCKED")!.text).toBe("Note “Synthetic secret” written, locked");
    expect(atoms.find((atom) => atom.record?.key === "NOTE-TRASH")!.text).toMatch(/in Recently Deleted/u);
    expect(atoms.find((atom) => atom.record?.key === "NOTE-GROCERIES")!.text).toBe("Note “Groceries” written: 😀 fake list\n[x] synthetic milk\n[ ] synthetic eggs\n[ ] synthetic bread");
    expect(day.txt).toContain("Note “Groceries” written: 😀 fake list [x] synthetic milk [ ] synthetic eggs [ ] synthetic bread\n");
    expect(atoms.find((atom) => atom.record?.key === "NOTE-BLANK-FIRST")!.text).toBe("Note “Blank first” written: after the blank");
    expect(atoms.find((atom) => atom.record?.key === "NOTE-CUT-TITLE")!.text).toBe("Note “A synthetic first line that Notes cut…” written: A synthetic first line that Notes cut short as its title\nmore");
    golden("extracts.golden.json", `${JSON.stringify(home.extracts("notes").map((row) => ({ unit: row.unit, content: row.content })), null, 2)}\n`);
    home.artifact("day.txt", day.txt);
    pin(notesFamily, { notes: FED.notes }, home.extracts("notes"));
  });

  it("a note that starts with a list prints its title twice or takes its marker as its title, or a marker counts as a word", () => {
    const home = newHome();
    const list = "synthetic milk\nsynthetic eggs\nsynthetic bread";
    const runs: Run[] = [{ length: 15, style: 103, done: 1 }, { length: 15, style: 103, done: 0 }, { length: 15, style: 102 }];
    home.deliver(MAC, STATED, [
      note({ id: "NOTE-LIST-TITLED", title: "synthetic milk", created: "2026-10-03T13:00:00Z", edited: "2026-10-03T13:00:00Z", body: body(list, runs) }),
      note({ id: "NOTE-LIST-UNTITLED", title: null, created: "2026-10-03T14:00:00Z", edited: "2026-10-03T14:00:00Z", body: body(list, runs) }),
    ]);
    const extracts = home.extracts("notes").map((row) => row.content as unknown as Note);
    expect(extracts.map(({ title, excerpt, words }) => ({ title, excerpt, words }))).toEqual([
      { title: "synthetic milk", excerpt: "[ ] synthetic eggs\n1. synthetic bread", words: 6 },
      { title: "synthetic milk", excerpt: "[ ] synthetic eggs\n1. synthetic bread", words: 6 },
    ]);
    const lines = (JSON.parse(home.render("2026-10-03", LABELS).json) as DayDocument).atoms.filter((atom) => atom.family === "notes").map((atom) => atom.text);
    expect(lines).toEqual(["Note “synthetic milk” written: [ ] synthetic eggs\n1. synthetic bread", "Note “synthetic milk” written: [ ] synthetic eggs\n1. synthetic bread"]);
    home.artifact("lists.json", { extracts, lines });
  });

  it("a long note makes a day line of unbounded length", () => {
    const home = newHome();
    const long = `Long synthetic\n${"word ".repeat(3000)}`;
    home.deliver(MAC, STATED, [note({ id: "NOTE-LONG", title: "Long synthetic", created: "2026-10-03T13:00:00Z", edited: "2026-10-03T13:00:00Z", body: body(long) })]);
    const extract = home.extracts("notes")[0]!.content as unknown as Note;
    expect(extract.excerpt.length).toBeLessThanOrEqual(LINE_CHARS + 1);
    expect(extract.excerpt.endsWith("…")).toBe(true);
    expect(extract.words).toBe(3002);
    const line = (JSON.parse(home.render("2026-10-03", LABELS).json) as DayDocument).atoms.find((atom) => atom.family === "notes")!.text;
    expect(line).toMatch(/… \(3,002 words\)$/u);
    const [text] = home.texts(notesFamily);
    expect(text!.text!.text.length).toBe(long.trim().length);
    expect(Buffer.byteLength(text!.text!.text, "utf8")).toBeLessThanOrEqual(TEXT_BYTES);
  });

  it("one note on two Macs prints twice, or the copy that prints depends on arrival order", () => {
    const older = note({ id: "NOTE-SHARED", title: "Shared synthetic", created: "2026-10-03T13:00:00Z", edited: "2026-10-03T13:10:00Z", body: body("Shared synthetic\nolder words") });
    const newer = note({ id: "NOTE-SHARED", title: "Shared synthetic", created: "2026-10-03T13:00:00Z", edited: "2026-10-03T13:40:00Z", body: body("Shared synthetic\nnewer words") });
    const lines: string[][] = [];
    for (const order of [[MAC, OTHER_MAC], [OTHER_MAC, MAC]] as const) {
      const home = newHome();
      home.deliver(order[0], STATED, [order[0] === MAC ? newer : older]);
      home.deliver(order[1], STATED + 1, [order[1] === MAC ? newer : older]);
      expect(home.extracts("notes").map((row) => row.unit)).toEqual(["apple-notes:person-a@example.com/NOTE-SHARED"]);
      lines.push((JSON.parse(home.render("2026-10-03", LABELS).json) as DayDocument).atoms.filter((atom) => atom.family === "notes").map((atom) => `${atom.record?.source} ${atom.text}`));
    }
    expect(lines[0]).toEqual([`${MAC} Note “Shared synthetic” written: newer words`]);
    expect(lines[1]).toEqual(lines[0]);
  });

  it("an extract is written again when nothing its line prints changed", () => {
    const home = newHome();
    home.deliver(MAC, STATED, NOTEBOOK);
    const again = shuffled(NOTEBOOK.map((row) => {
      const content = row.content as JsonObject;
      const stated = content.note as JsonObject;
      const body = content.body as JsonObject | null;
      const data = body?.ZDATA as JsonObject | null | undefined;
      const recompressed = data == null || stated.ZISPASSWORDPROTECTED === 1 ? data : bytes64(gzip(gunzipSync(Buffer.from(data.$bytes64 as string, "base64")), 7));
      return { ...row, content: { ...content, note: { ...stated, ZPAPERSTYLETYPE: 1 }, body: body === null ? null : { ...body, ZDATA: recompressed ?? null } } };
    }), 7);
    const second = home.deliver(MAC, STATED + 60_000, again);
    expect(second.landed.changed).toBe(NOTEBOOK.length);
    expect(second.written).toEqual([]);
    expect(second.deleted).toEqual([]);
  });

  it("a Granola meeting's line loses its title, its people or its length, names the account itself, or prints by its route", () => {
    const home = new TestHome("families-notes-", { families: [notesFamily], settings: NEW_YORK });
    home.addSource(GRANOLA, "granola");
    homes.push(home);
    const person = (n: string) => ({ name: `Person ${n}`, email: `person-${n.toLowerCase()}@example.com` });
    const span = (start: string, end: string) => ({ start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" as const });
    const apiNote = (uuid: string, title: string, attendees: JsonObject[], time: NonNullable<ReaderOutput["time"]>): ReaderOutput => ({
      kind: "note", key: uuid, time,
      content: { type: "granola.note", note: { id: `not_${uuid.slice(0, 8)}`, object: "note", title, owner: person("A"), attendees, summary_markdown: `### ${title}\n- a synthetic decision`, private_notes_markdown: null, web_url: `https://notes.granola.ai/d/${uuid}` } },
    });
    home.deliver(GRANOLA, STATED, [
      apiNote("11111111-aaaa-4bbb-8ccc-000000000001", "Synthetic planning", [person("A"), person("B"), person("C")], span("2026-10-03T14:00:00Z", "2026-10-03T14:33:00Z")),
      apiNote("22222222-aaaa-4bbb-8ccc-000000000002", "Synthetic all-hands", ["A", "B", "C", "D", "E", "F", "G", "H", "I"].map(person), span("2026-10-03T16:00:00Z", "2026-10-03T17:05:00Z")),
      apiNote("33333333-aaaa-4bbb-8ccc-000000000003", "Synthetic focus time", [person("A")], { start_ms: Date.parse("2026-10-03T19:00:00Z"), precision: "ms" }),
      {
        kind: "note", key: "44444444-aaaa-4bbb-8ccc-000000000004", time: { start_ms: Date.parse("2026-10-03T17:00:00.000Z"), offset_min: 330, precision: "ms" },
        content: {
          type: "granola.mcp-note", meeting: { id: "44444444-aaaa-4bbb-8ccc-000000000004", title: "Synthetic one-on-one", meeting_at: "2026-10-03T22:30:00.000+05:30" },
          known_participants: { text: "Person A (note creator) (person-a@example.com), Person D (person-d@example.com)" }, private_notes: { status: "empty" }, summary: { text: "### Synthetic one-on-one\n- a synthetic follow-up" },
        },
      },
    ]);
    const lines = (JSON.parse(home.render("2026-10-03", LABELS).json) as DayDocument).atoms.filter((atom) => atom.family === "notes").map((atom) => atom.text);
    expect(lines).toEqual([
      "Meeting “Synthetic planning” with Person B and Person C, 33 min",
      "Meeting “Synthetic all-hands” with Person B, Person C, Person D, Person E, Person F, Person G and 2 more, 1 h 5 min",
      "Meeting “Synthetic one-on-one” with Person D",
      "Meeting “Synthetic focus time”",
    ]);
    expect(home.extracts("notes").map((row) => row.unit)).toContain("granola:person-a@example.com/44444444-aaaa-4bbb-8ccc-000000000004");
    const texts = home.texts(notesFamily).map(({ text }) => text);
    expect(texts).toContainEqual(expect.objectContaining({ title: "Synthetic one-on-one", text: "### Synthetic one-on-one\n- a synthetic follow-up" }));
    expect(texts).toContainEqual(expect.objectContaining({ title: "Synthetic planning", who: expect.arrayContaining(["person-b@example.com"]) as unknown }));
    home.artifact("granola-day.json", { lines, extracts: home.extracts("notes").map((row) => row.content) });
  });
});
