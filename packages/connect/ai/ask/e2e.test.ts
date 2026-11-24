import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, deliver, openTestHome } from "../../test/drive.js";
import { STATEMENTS_FILE, type Pictures } from "../../shared/statements.js";
import { askHome, voiceMs } from "./reader.js";

const ASK = "ask:local:macbook-pro-0001";
const REFS = {
  message: "record.WyJyZWNvcmQiLCJ3aGF0c2FwcDoxNTU1MDAwMDAwOTppcGhvbmUtYWEwMSIsIm1lc3NhZ2UiLCJhMSJd",
  chat: "chat.WyJjaGF0Iiwid2hhdHNhcHA6MTU1NTAwMDAwMDFAcy53aGF0c2FwcC5uZXQiXQ",
  record: "record.WyJyZWNvcmQiLCJnb29nbGUtY2FsZW5kYXI6bWVAZXhhbXBsZS5jb206Y2xvdWQiLCJldmVudCIsImUzIl0",
  line: "line.WyJsaW5lIiwiMjAyNi0xMC0wMSIsImNhbGVuZGFyL2UzIixudWxsLCJyZXY5Il0",
  photo: "record.WyJyZWNvcmQiLCJwaG90b3M6bG9jYWw6aXBob25lLWFhMDEiLCJwaG90byIsInBoMSJd",
  window: "window.WyJ3aW5kb3ciLCJtYWNib29rLXByby1hYTQyIiwiMjAyNi0xMS0wMiIsIkV4YW1wbGUgQnJvd3NlciIsImV4YW1wbGUtYWlyLmV4YW1wbGUuY29tIiwiRXhhbXBsZSBBaXI6IHlvdXIgdHJpcCIsMTc5MzU5NTc4MDAwMF0",
  row: "row.WyJyb3ciLHsiYnkiOlsiaXRlbSJdLCJmcm9tIjoiMjAyNi0wMy0wMSIsIm1hdGNoIjp7InBheWVlIjoiYWNtZSJ9LCJtZWFzdXJlIjoiYW1vdW50Iiwib2YiOiJwYXltZW50cyIsInRvIjoiMjAyNi0wMy0zMSJ9LHsidmFsdWVzIjp7InBheWVlIjpbIkFDTUUgQ0FCUyBMSU1JVEVEIiwiQUNNRSBDQUJTIl19fSxbXSw3XQ",
  person: "person.WyJwZXJzb24iLCJwZXJzb246cGVyc29uLWEtMSJd",
  group: "chat.WyJjaGF0Iiwid2hhdHNhcHA6MTIwMzYzMDAwMDAwMDAwMDA0QGcudXMiXQ",
  place: "place.WyJwbGFjZSIsImV4YW1wbGUtY2FmZSJd",
};
const PHOTO = { ref: REFS.photo, kind: "photo", day: "2026-10-04", at: "2026-10-04T12:30+01:00", title: "A cafe table with two cups", image: `sha256:${"a".repeat(64)}`,
  opens: { page: "days", day: "2026-10-04", focus: "rec:photos:local:iphone-aa01 photo ph1" } };
const MESSAGE = { ref: REFS.message, kind: "message", day: "2026-10-04", at: "2026-10-04T09:15+01:00", title: "Person A", chat: REFS.chat, chat_title: "Person A",
  opens: { page: "days", day: "2026-10-04", focus: "rec:whatsapp:15550000009:iphone-aa01 message a1" } };
const DOOR = new URL("../../../home/test/contract/citations.json", import.meta.url);
const KEPT_ACCESS = new URL("../../../../homelink/Tests/Fixtures/agents/ask/kept.json", import.meta.url);
const T0 = Date.UTC(2026, 9, 14, 8);
const CHAT = `${T0}-3fa9c2`;
const statements = (lines: unknown[]) => Buffer.from(lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""));
const facts = (fetched_ms: number) => ({ fetched_at: new Date(fetched_ms).toISOString(), device: "ask" });
const chat = (title: string | null, at_ms: number, more: Record<string, unknown> = {}) => ({ kind: "chat", key: CHAT, content: { type: "ask.chat", title, at_ms, ...more } });
const question = (n: number, at_ms: number, text = "What did I eat on the synthetic Sunday?", more: Record<string, unknown> = {}) =>
  ({ kind: "msg", key: `${CHAT}:${String(n).padStart(4, "0")}`, content: { type: "ask.msg", chat: CHAT, n, at_ms, role: "user", text, ...more } });
const answer = (n: number, at_ms: number, more: Record<string, unknown> = {}) => ({
  kind: "msg", key: `${CHAT}:${String(n).padStart(4, "0")}`,
  content: {
    type: "ask.msg", chat: CHAT, n, at_ms, role: "assistant", text: "Synthetic soup [r1].",
    refs: { r1: PHOTO },
    steps: [{ name: "search", words: "Searched notes for “lunch”", ms: 120, line: "search {query: lunch} → r1 (1 found)" }, { name: "codemode", words: "Ran a script", ms: 4 }], model: "gpt-6-luna", ms: 9_000, thought_ms: 4_200, end: "done", ...more,
  },
});

const blobOf = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fake = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

function wav(samples: number, change: (header: Buffer) => void = () => {}): Buffer {
  const data = samples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data, 40);
  change(header);
  return Buffer.concat([header, Buffer.alloc(data, 7)]);
}

const PHOTOS = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from("synthetic jpeg")]),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("synthetic png")]),
  heic: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.from("synthetic heic")]),
  heif: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmif1"), Buffer.from("synthetic heif")]),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 synthetic webp")]),
  gif: Buffer.from("GIF89a synthetic gif"),
};

function pictures(files: { carried?: Buffer[]; staged?: Buffer[]; held?: string[]; misnamed?: [string, Buffer] }): Pictures {
  const byName = (list: Buffer[] = []) => new Map(list.map((bytes) => [blobOf(bytes), bytes]));
  const carried = byName(files.carried);
  if (files.misnamed !== undefined) carried.set(files.misnamed[0], files.misnamed[1]);
  const staged = byName(files.staged);
  return {
    carried: (hash) => {
      const bytes = carried.get(hash);
      return bytes === undefined ? undefined : { size: bytes.length, bytes: () => bytes };
    },
    staged: (hash) => {
      const bytes = staged.get(hash);
      return bytes === undefined ? undefined : { size: bytes.length, head: (length) => bytes.subarray(0, length) };
    },
    held: (hash) => files.held?.includes(hash) === true,
  };
}

describe("Ask's conversations: each of these is impossible", () => {
  it("A1 A2: a line of another shape lands, refuses its neighbours, or is not named by its line", async () => {
    const home = openTestHome();
    const good = question(1, T0);
    const bad: [string, unknown][] = [
      ["a chat key that is no conversation's id", { ...chat("What did I eat", T0), key: "chat-1" }],
      ["a message key that is no message's key", { ...question(1, T0), key: `${CHAT}:1` }],
      ["a message keyed 0000", { ...question(0, T0), key: `${CHAT}:0000` }],
      ["a key that disagrees with n", { ...question(1, T0), key: `${CHAT}:0002` }],
      ["a key that disagrees with chat", { ...question(1, T0), key: `${T0 + 1}-3fa9c2:0001` }],
      ["a member more on a chat", chat("What did I eat", T0, { unread: 0 })],
      ["a member more on a question", question(1, T0, "Synthetic question?", { mood: "curious" })],
      ["an answer's member on a question", question(1, T0, "Synthetic question?", { end: "done" })],
      ["a member more on an answer", answer(2, T0, { tokens: 10 })],
      ["a title null", chat(null, T0)],
      ["a title empty", chat("", T0)],
      ["a title over 200 characters", chat("t".repeat(201), T0)],
      ["an at_ms that is no instant", question(1, -5)],
      ["an at_ms in seconds' text", question(1, "1792396847" as unknown as number)],
      ["an n out of range", { ...question(10_000, T0), key: `${CHAT}:10000` }],
      ["another role", { ...question(1, T0), content: { ...question(1, T0).content, role: "system" } }],
      ["an unknown end", answer(2, T0, { end: "cancelled" })],
      ["an error on a done answer", answer(2, T0, { error: "model" })],
      ["a failure on a done answer", answer(2, T0, { failed: "model" })],
      ["an unknown failure", answer(2, T0, { end: "failed", error: "It broke.", failed: "crash" })],
      ["an unknown thinking", answer(2, T0, { thinking: "deep" })],
      ["a thought_ms that is no whole ms", answer(2, T0, { thought_ms: 1.5 })],
      ["a handle that is no r<n>", answer(2, T0, { refs: { ref1: MESSAGE } })],
      ["a ref of an object", answer(2, T0, { refs: { r1: { ...MESSAGE, ref: { source: "x", kind: "message", key: "a1" } } } })],
      ["a ref that starts blank", answer(2, T0, { refs: { r1: { ...MESSAGE, ref: ` ${REFS.message}` } } })],
      ["a citation of no kind", answer(2, T0, { refs: { r1: { ref: REFS.record, day: "2026-10-01", title: "Example review" } } })],
      ["a citation of a kind unknown", answer(2, T0, { refs: { r1: { ...MESSAGE, kind: "note" } } })],
      ["a thing with no opens", answer(2, T0, { refs: { r1: { ref: REFS.record, kind: "record", day: "2026-10-01", title: "Example review" } } })],
      ["an opens of no page the door names", answer(2, T0, { refs: { r1: { ...MESSAGE, opens: { page: "chat", id: "a1" } } } })],
      ["a focus Days does not read", answer(2, T0, { refs: { r1: { ...MESSAGE, opens: { page: "days", day: "2026-10-04", focus: "a1" } } } })],
      ["a day of another form", answer(2, T0, { refs: { r1: { ...MESSAGE, day: "4 Oct" } } })],
      ["a time that is no instant", answer(2, T0, { refs: { r1: { ...MESSAGE, at: "09:15" } } })],
      ["a photo with no blob", answer(2, T0, { refs: { r1: { ...PHOTO, image: undefined } } })],
      ["a window with no app", answer(2, T0, { refs: { r1: { ref: REFS.window, kind: "window", day: "2026-11-02", title: "Example Air: your trip", opens: { page: "read" } } } })],
      ["a row with no sentence", answer(2, T0, { refs: { r1: { ref: REFS.row, kind: "row", n: 7, opens: { page: "read" } } } })],
      ["a row with no number", answer(2, T0, { refs: { r1: { ref: REFS.row, kind: "row", asked: "count of calls", opens: { page: "read" } } } })],
      ["a person with no name", answer(2, T0, { refs: { r1: { ref: REFS.person, kind: "person", opens: { page: "people", id: "phone:+15550000001" } } } })],
      ["a person cited with a day", answer(2, T0, { refs: { r1: { ref: REFS.person, kind: "person", name: "Person A", day: "2026-10-14", opens: { page: "people", id: "phone:+15550000001" } } } })],
      ["a gone with no why", answer(2, T0, { refs: { r1: { ref: REFS.record, kind: "gone" } } })],
      ["a step of another shape", answer(2, T0, { steps: [{ name: "search", ms: 3 }] })],
      ["a call's line with no words", answer(2, T0, { steps: [{ name: "search", words: "Searched notes", ms: 3, line: " " }] })],
      ["no change of access", answer(2, T0, { access: [] })],
      ["a change of access of no kind", answer(2, T0, { access: [{ id: "ch-1", reader: "p-00000001", words: "Synthetic Agent reads only Mail." }] })],
      ["a narrowing with no Undo", answer(2, T0, { access: [{ id: "ch-1", kind: "narrowed", reader: "p-00000001", words: "Synthetic Agent reads only Mail." }] })],
      ["an ask whose snapshot is another's", answer(2, T0, { access: [{ id: "rq-0000000000000001", kind: "asked", snapshot: { id: "rq-0000000000000002" } }] })],
      ["a question with no words", question(1, T0, "  ")],
      ["another kind", { kind: "conversation", key: CHAT, content: chat("What did I eat", T0).content }],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, ASK, { [STATEMENTS_FILE]: statements([good, line, good]) }, facts(T0 + 60_000));
      const rows = await collect(askHome.read(delivery, home.blobs));
      expect(rows.map((row) => [row.locator, row.refused === undefined]), name).toEqual([[`${STATEMENTS_FILE}:1`, true], [`${STATEMENTS_FILE}:2`, false], [`${STATEMENTS_FILE}:3`, true]]);
      expect(rows[1]!.refused, name).toContain(`${STATEMENTS_FILE} line 2`);
      refusals[name] = rows[1]!.refused!;
    }
    expect(home.heads(ASK)).toEqual([]);
    artifact(home.dir, "refusals.json", refusals);
  });

  it("A3 A4: a turn lands without its times, at another time than its end, under another device, or a later turn's chat loses its title or time", async () => {
    const home = openTestHome();
    const turn = (fetched_ms: number, lines: unknown[]) => deliver(home, ASK, { [STATEMENTS_FILE]: statements(lines) }, facts(fetched_ms));
    const first = await home.land(askHome, turn(T0 + 10_000, [chat("What did I eat", T0 + 9_000), question(1, T0), answer(2, T0 + 9_000)]));
    expect(first).toMatchObject({ new: 3, refused: 0 });
    const rows = await collect(askHome.read(turn(T0 + 10_000, [chat("What did I eat", T0 + 9_000), question(1, T0), answer(2, T0 + 9_000)]), home.blobs));
    expect(rows.map((row) => [row.key, row.time, row.device])).toEqual([
      [CHAT, { start_ms: T0 + 9_000, precision: "ms" }, "ask"],
      [`${CHAT}:0001`, { start_ms: T0, precision: "ms" }, "ask"],
      [`${CHAT}:0002`, { start_ms: T0 + 9_000, precision: "ms" }, "ask"],
    ]);
    const stated = (key: string) => home.heads(ASK).find((head) => head.key === key)!;
    expect(stated(`${CHAT}:0001`)).toMatchObject({ stated_ms: T0 + 10_000 });

    const second = await home.land(askHome, turn(T0 + 70_000, [chat("Synthetic lunch", T0 + 69_000), question(3, T0 + 60_000, "And dinner?"), answer(4, T0 + 69_000, { end: "stopped" })]));
    expect(second).toMatchObject({ new: 2, changed: 1, refused: 0 });
    expect(stated(CHAT)).toMatchObject({ content: { type: "ask.chat", title: "Synthetic lunch", at_ms: T0 + 69_000 }, stated_ms: T0 + 70_000 });
    const late = await home.land(askHome, turn(T0 + 10_000 - 1, [chat("What did I eat", T0 + 9_000)]));
    expect(late).toMatchObject({ late: 1 });
    expect(stated(CHAT)).toMatchObject({ content: { title: "Synthetic lunch" } });
    artifact(home.dir, "turns.json", { first, second, late, heads: home.heads(ASK) });
  });

  it("A5: an answer citing each kind of citation, by the door's refs, is read and kept with every one, its steps with their calls' lines", async () => {
    const home = openTestHome();
    const refs = {
      r1: MESSAGE,
      r2: { ref: REFS.record, kind: "record", day: "2026-10-01", title: "Example review", opens: { page: "days", day: "2026-10-01", focus: "rec:google-calendar:me@example.com:cloud event e3" } },
      r3: { ref: REFS.line, kind: "line", day: "2026-10-01", title: "Example review", opens: { page: "days", day: "2026-10-01", focus: "u:calendar/e3" } },
      r4: PHOTO,
      r5: { ref: REFS.window, kind: "window", day: "2026-11-02", at: "2026-11-02T06:03+01:00", app: "Example Browser", title: "Example Air: your trip", opens: { page: "days", day: "2026-11-02" } },
      r6: { ref: REFS.row, kind: "row", asked: "sum of amount over payments, by item", n: 7, opens: { page: "read" } },
      r7: { ref: REFS.person, kind: "person", name: "Person A", opens: { page: "people", id: "phone:+15550000001" } },
      r8: { ref: REFS.group, kind: "chat", name: "Example Group", opens: { page: "people", id: "whatsapp:120363000000000004@g.us" } },
      r9: { ref: REFS.place, kind: "place", name: "Example Cafe", opens: { page: "places", id: "example-cafe" } },
      r10: { ref: REFS.record, kind: "gone", why: "this record is no longer held" },
    };
    const said = answer(2, T0 + 9_000, { text: "Person A [r7] wrote [r1] of the review [r2][r3], with a photo [r4] and a booking [r5] paid [r6] in [r8] at [r9]; [r10] is gone.", refs });
    const landed = await home.land(askHome, deliver(home, ASK, { [STATEMENTS_FILE]: statements([chat("Who wrote", T0 + 9_000), question(1, T0), said]) }, facts(T0 + 10_000)));
    expect(landed).toMatchObject({ new: 3, refused: 0 });
    const kept = home.heads(ASK).find((head) => head.key === `${CHAT}:0002`)!;
    expect((kept.content as { refs: unknown }).refs).toEqual(refs);
    expect((kept.content as { steps: unknown }).steps).toEqual([{ name: "search", words: "Searched notes for “lunch”", ms: 120, line: "search {query: lunch} → r1 (1 found)" }, { name: "codemode", words: "Ran a script", ms: 4 }]);
    artifact(home.dir, "cited.json", kept);
  });

  it("A11: an answer that changed agents' access, as the Ask server keeps it, lands with its changes whole, in order", async () => {
    const home = openTestHome();
    const sent = JSON.parse(readFileSync(KEPT_ACCESS, "utf8")) as { chat: string; n: number; at_ms: number; access: unknown[] };
    const line = { kind: "msg", key: `${sent.chat}:${String(sent.n).padStart(4, "0")}`, content: sent };
    const landed = await home.land(askHome, deliver(home, ASK, { [STATEMENTS_FILE]: statements([{ kind: "chat", key: sent.chat, content: { type: "ask.chat", title: "Agents", at_ms: sent.at_ms } }, line]) }, facts(sent.at_ms + 1_000)));
    expect(landed).toMatchObject({ new: 2, refused: 0 });
    const kept = home.heads(ASK).find((head) => head.key === line.key)!;
    expect(sent.access.map((change) => (change as { kind: string }).kind)).toEqual(["narrowed", "asked"]);
    expect(kept.content).toEqual(sent);
  });

  it("A6: the Ask server's delivery of a kept answer citing the door's citations, a ref alone and a picture with no day lands whole, each as delivered", async () => {
    const home = openTestHome();
    const lines = readFileSync(new URL("./test/cited.ndjson", import.meta.url));
    const sent = lines.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as { key: string; content: { refs: Record<string, unknown> } });
    const answer = sent[2]!;
    expect(answer.content.refs).toMatchObject(JSON.parse(readFileSync(DOOR, "utf8")) as object);
    const landed = await home.land(askHome, deliver(home, ASK, { [STATEMENTS_FILE]: lines }, facts(1_792_396_862_000)));
    expect(landed).toMatchObject({ new: 3, refused: 0 });
    const kept = home.heads(ASK).find((head) => head.key === answer.key)!;
    expect((kept.content as { refs: unknown }).refs).toEqual(answer.content.refs);
    artifact(home.dir, "cited-delivery.json", kept);
  });

  it("A7: each citation the door makes lands as made (its contract fixture, test/citable.json's kept), a voice note's audio no file of it; each the contract does not define is refused", async () => {
    const home = openTestHome();
    const rule = JSON.parse(readFileSync(new URL("./test/citable.json", import.meta.url), "utf8")) as { kept: unknown[]; refused: unknown[] };
    const made = [...Object.values(JSON.parse(readFileSync(DOOR, "utf8")) as Record<string, unknown>), ...rule.kept];
    const refs = Object.fromEntries(made.map((each, at) => [`r${at + 1}`, each]));
    expect(made.some((each) => (each as { voice?: unknown }).voice !== undefined)).toBe(true);
    const landed = await home.land(askHome, deliver(home, ASK, { [STATEMENTS_FILE]: statements([chat("Cited", T0 + 9_000), question(1, T0), answer(2, T0 + 9_000, { refs })]) }, facts(T0 + 10_000)));
    expect(landed).toMatchObject({ new: 3, refused: 0 });
    expect((home.heads(ASK).find((head) => head.key === `${CHAT}:0002`)!.content as { refs: unknown }).refs).toEqual(refs);
    const good = question(1, T0);
    const voiced = await collect(askHome.read(deliver(home, ASK, { [STATEMENTS_FILE]: statements([good, answer(2, T0, { refs })]) }, facts(T0 + 60_000)), home.blobs));
    expect(voiced.map((row) => [row.refused, row.blobs, row.media])).toEqual([[undefined, [], undefined], [undefined, [], undefined]]);
    for (const cited of rule.refused) {
      const rows = await collect(askHome.read(deliver(home, ASK, { [STATEMENTS_FILE]: statements([good, answer(2, T0, { refs: { r1: cited } })]) }, facts(T0 + 60_000)), home.blobs));
      expect(rows.map((row) => row.refused === undefined), JSON.stringify(cited)).toEqual([true, false]);
    }
  });

  it("A8: a question's photos or voice note of another shape lands", async () => {
    const home = openTestHome();
    const good = question(1, T0);
    const note = { audio: fake(1), ms: 38_412 };
    const bad: [string, unknown][] = [
      ["no photo", question(1, T0, "Where?", { photos: [] })],
      ["eleven photos", question(1, T0, "Where?", { photos: Array.from({ length: 11 }, (_, index) => fake(index + 1)) })],
      ["a photo twice", question(1, T0, "Where?", { photos: [fake(1), fake(2), fake(1)] })],
      ["a photo that is no blob", question(1, T0, "Where?", { photos: ["IMG_0001.HEIC"] })],
      ["photos that are no list", question(1, T0, "Where?", { photos: fake(1) })],
      ["a voice note with typed words", question(1, T0, "Also this", { voice: note })],
      ["a voice note with no ms", question(1, T0, "", { voice: { audio: fake(1) } })],
      ["a voice note of 0 ms", question(1, T0, "", { voice: { audio: fake(1), ms: 0 } })],
      ["a voice note past ten minutes", question(1, T0, "", { voice: { audio: fake(1), ms: 600_001 } })],
      ["a voice note's ms in seconds' text", question(1, T0, "", { voice: { audio: fake(1), ms: "38" } })],
      ["a member more on a voice note", question(1, T0, "", { voice: { ...note, words: "Synthetic words" } })],
      ["a voice note whose audio is no blob", question(1, T0, "", { voice: { audio: "note.wav", ms: 1_000 } })],
      ["a typed question with no words and no voice note", question(1, T0, "")],
      ["photos on an answer", answer(2, T0, { photos: [fake(1)] })],
      ["a voice note on an answer", answer(2, T0, { voice: note })],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, ASK, { [STATEMENTS_FILE]: statements([good, line, good]) }, facts(T0 + 60_000));
      const rows = await collect(askHome.read(delivery, home.blobs));
      expect(rows.map((row) => [row.locator, row.refused === undefined]), name).toEqual([[`${STATEMENTS_FILE}:1`, true], [`${STATEMENTS_FILE}:2`, false], [`${STATEMENTS_FILE}:3`, true]]);
      expect(rows[1]!.refused, name).toContain(`${STATEMENTS_FILE} line 2`);
      refusals[name] = rows[1]!.refused!;
    }
    const fine = [
      question(1, T0, "Where?", { photos: Array.from({ length: 10 }, (_, index) => fake(index + 1)) }),
      question(2, T0, "", { voice: { audio: fake(1), ms: 1 } }),
      question(3, T0, "", { voice: { audio: fake(2), ms: 600_000 }, photos: [fake(3)] }),
    ];
    const rows = await collect(askHome.read(deliver(home, ASK, { [STATEMENTS_FILE]: statements(fine) }, facts(T0 + 60_000)), home.blobs));
    expect(rows.map((row) => row.refused)).toEqual([undefined, undefined, undefined]);
    artifact(home.dir, "refusals.json", refusals);
  });

  it("A9: a question's photos and audio land without their blobs, or the audio without its media type", async () => {
    const home = openTestHome();
    const photos = [blobOf(PHOTOS.heic), blobOf(PHOTOS.jpeg)];
    const audio = blobOf(wav(16_000));
    const lines = [chat("Voice note", T0 + 9_000), question(1, T0, "Where was this?", { photos }), answer(2, T0 + 1_000), question(3, T0 + 5_000, "", { voice: { audio, ms: 1_000 }, photos: [photos[0]] })];
    const rows = await collect(askHome.read(deliver(home, ASK, { [STATEMENTS_FILE]: statements(lines) }, facts(T0 + 10_000)), home.blobs));
    expect(rows.map((row) => [row.key, row.blobs, row.media])).toEqual([
      [CHAT, undefined, undefined],
      [`${CHAT}:0001`, photos, undefined],
      [`${CHAT}:0002`, [], undefined],
      [`${CHAT}:0003`, [photos[0], audio], { [audio]: "audio/wav" }],
    ]);
    artifact(home.dir, "files.json", rows as unknown as JsonObject[]);
  });

  it("A10: the door seals a question whose files break the kind's rule, or refuses one whose files keep it", () => {
    const rule = askHome.statements.msg!.picture!;
    const content = (more: Record<string, unknown>, text = "") => question(1, T0, text, more).content as unknown as JsonObject;
    const second = wav(16_000);
    const short = wav(17);
    const faults: Record<string, string | undefined> = {
      "a photo neither carried, staged nor held": rule(content({ photos: [blobOf(PHOTOS.jpeg)] }, "Where?"), pictures({})),
      "a voice note neither carried, staged nor held": rule(content({ voice: { audio: blobOf(second), ms: 1_000 } }), pictures({})),
      "a carried photo under another hash": rule(content({ photos: [fake(9)] }, "Where?"), pictures({ misnamed: [fake(9), PHOTOS.jpeg] })),
      "a staged GIF": rule(content({ photos: [blobOf(PHOTOS.gif)] }, "Where?"), pictures({ staged: [PHOTOS.gif] })),
      "a carried GIF": rule(content({ photos: [blobOf(PHOTOS.gif)] }, "Where?"), pictures({ carried: [PHOTOS.gif] })),
      "a note in stereo": ((bytes) => rule(content({ voice: { audio: blobOf(bytes), ms: 1_000 } }), pictures({ staged: [bytes] })))(wav(16_000, (header) => header.writeUInt16LE(2, 22))),
      "a note at 44.1 kHz": ((bytes) => rule(content({ voice: { audio: blobOf(bytes), ms: 1_000 } }), pictures({ staged: [bytes] })))(wav(16_000, (header) => header.writeUInt32LE(44_100, 24))),
      "a note of floats": ((bytes) => rule(content({ voice: { audio: blobOf(bytes), ms: 1_000 } }), pictures({ staged: [bytes] })))(wav(16_000, (header) => header.writeUInt16LE(3, 20))),
      "a note whose data runs short of its file": ((bytes) => rule(content({ voice: { audio: blobOf(bytes), ms: 1_000 } }), pictures({ staged: [bytes] })))(Buffer.concat([second, Buffer.from("LIST")])),
      "a note with no samples": rule(content({ voice: { audio: blobOf(wav(0)), ms: 1 } }), pictures({ staged: [wav(0)] })),
      "a note that is a header alone, cut short": rule(content({ voice: { audio: blobOf(second.subarray(0, 30)), ms: 1 } }), pictures({ staged: [second.subarray(0, 30)] })),
      "a note whose samples disagree with its ms": rule(content({ voice: { audio: blobOf(second), ms: 1_001 } }), pictures({ staged: [second] })),
      "a GIF beside a good note": rule(content({ voice: { audio: blobOf(second), ms: 1_000 }, photos: [blobOf(PHOTOS.gif)] }), pictures({ staged: [second, PHOTOS.gif] })),
    };
    for (const [name, fault] of Object.entries(faults)) expect(fault, name).toEqual(expect.any(String));
    expect(faults["a note whose samples disagree with its ms"]).toBe("its voice note's samples last 1000 ms, not its ms 1001");

    const kept: Record<string, string | undefined> = {
      ...Object.fromEntries(Object.entries(PHOTOS).filter(([kind]) => kind !== "gif").flatMap(([kind, bytes]) => [
        [`a staged ${kind}`, rule(content({ photos: [blobOf(bytes)] }, "Where?"), pictures({ staged: [bytes] }))],
        [`a carried ${kind}`, rule(content({ photos: [blobOf(bytes)] }, "Where?"), pictures({ carried: [bytes] }))],
      ])),
      "a held photo": rule(content({ photos: [fake(5)] }, "Where?"), pictures({ held: [fake(5)] })),
      "a staged note": rule(content({ voice: { audio: blobOf(second), ms: 1_000 } }), pictures({ staged: [second] })),
      "a carried note": rule(content({ voice: { audio: blobOf(second), ms: 1_000 } }), pictures({ carried: [second] })),
      "a held note": rule(content({ voice: { audio: fake(6), ms: 1_000 } }), pictures({ held: [fake(6)] })),
      "a note of 17 samples, 2 ms": rule(content({ voice: { audio: blobOf(short), ms: 2 } }), pictures({ staged: [short] })),
      "a note with photos, all staged": rule(content({ voice: { audio: blobOf(second), ms: 1_000 }, photos: [blobOf(PHOTOS.png), blobOf(PHOTOS.webp)] }), pictures({ staged: [second, PHOTOS.png, PHOTOS.webp] })),
      "a typed question with no files": rule(content({}, "Where?"), pictures({})),
    };
    expect(Object.entries(kept).filter(([, fault]) => fault !== undefined)).toEqual([]);
    expect([voiceMs(1), voiceMs(16), voiceMs(17), voiceMs(16_000), voiceMs(9_600_000)]).toEqual([1, 1, 2, 1_000, 600_000]);
    const unstaged: Pictures = { carried: () => undefined, held: () => false };
    expect(rule(content({ photos: [blobOf(PHOTOS.jpeg)] }, "Where?"), unstaged)).toEqual(expect.any(String));
    artifact(openTestHome().dir, "rule.json", { faults, kept } as unknown as JsonObject);
  });
  it("A12: an answer's record of what the model saw of another shape lands, as does a step with hid; a picture it names neither carried, staged nor held is sealed", async () => {
    const home = openTestHome();
    const covered = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from("synthetic covered picture")]);
    const seen = {
      asked: [{ start: 18, end: 22, placeholder: "[[Person 1]]" }, { start: 28, end: 28, added: "\n[Photo 1: taken 3 Nov 2026 14:02 at " }, { start: 28, end: 28, placeholder: "[[Place 1]]" }, { start: 28, end: 28, added: "]" }],
      answered: [{ start: 7, end: 16, placeholder: "[[Person 1]]" }],
      photos: [blobOf(covered)],
    };
    const step = { name: "search", words: "Searched notes for Person A", ms: 120 };
    const good = answer(2, T0, { seen });
    const bad: [string, unknown][] = [
      ["seen on a question", question(1, T0, "Where?", { seen })],
      ["seen on a failed answer", answer(2, T0, { seen, end: "failed", error: "The model failed.", failed: "model" })],
      ["seen with no answered", answer(2, T0, { seen: { asked: seen.asked } })],
      ["seen with a member more", answer(2, T0, { seen: { ...seen, model: "Synthetic" } })],
      ["spans out of order", answer(2, T0, { seen: { ...seen, asked: [...seen.asked].reverse() } })],
      ["spans that overlap", answer(2, T0, { seen: { ...seen, answered: [{ start: 0, end: 5, placeholder: "[[Person 1]]" }, { start: 3, end: 8, placeholder: "[[Person 2]]" }] } })],
      ["a span whose offset is no whole number", answer(2, T0, { seen: { ...seen, answered: [{ start: 7.5, end: 16, placeholder: "[[Person 1]]" }] } })],
      ["a span that ends before it starts", answer(2, T0, { seen: { ...seen, answered: [{ start: 9, end: 7, placeholder: "[[Person 1]]" }] } })],
      ["answered past the answer's text", answer(2, T0, { seen: { ...seen, answered: [{ start: 7, end: 21, placeholder: "[[Person 1]]" }] } })],
      ["an added span with width", answer(2, T0, { seen: { ...seen, asked: [{ start: 0, end: 4, added: "Synthetic" }] } })],
      ["an added span in answered", answer(2, T0, { seen: { ...seen, answered: [{ start: 0, end: 0, added: "Synthetic" }] } })],
      ["a span both placed and added", answer(2, T0, { seen: { ...seen, asked: [{ start: 0, end: 0, placeholder: "[[Person 1]]", added: "x" }] } })],
      ["spoken that is no string", answer(2, T0, { seen: { ...seen, spoken: 3 } })],
      ["no photos in a list", answer(2, T0, { seen: { ...seen, photos: [] } })],
      ["eleven photos", answer(2, T0, { seen: { ...seen, photos: Array.from({ length: 11 }, () => null) } })],
      ["a photo that is no blob", answer(2, T0, { seen: { ...seen, photos: ["covered.jpg"] } })],
      ["a step with hid", answer(2, T0, { steps: [{ ...step, hid: { words: [{ start: 19, end: 27, placeholder: "[[Person 1]]" }] } }] })],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, ASK, { [STATEMENTS_FILE]: statements([question(1, T0), line]) }, facts(T0 + 60_000));
      const rows = await collect(askHome.read(delivery, home.blobs));
      expect(rows[1]!.refused, name).toContain(`${STATEMENTS_FILE} line 2`);
      refusals[name] = rows[1]!.refused!;
    }
    const fine = [
      question(1, T0), good,
      answer(4, T0, { seen: { asked: [{ start: 0, end: 0, added: "[A voice note, written out:]\n\n" }, { start: 5, end: 9, placeholder: "[[Person 1]]" }], spoken: "Call Maya tomorrow", answered: [] }, end: "stopped", steps: [step] }),
      answer(6, T0, { seen: { ...seen, photos: [null] } }),
    ];
    const rows = await collect(askHome.read(deliver(home, ASK, { [STATEMENTS_FILE]: statements(fine) }, facts(T0 + 60_000)), home.blobs));
    expect(rows.map((row) => row.refused)).toEqual([undefined, undefined, undefined, undefined]);
    expect(rows.map((row) => [row.blobs, row.media])).toEqual([[[], undefined], [[blobOf(covered)], { [blobOf(covered)]: "image/jpeg" }], [[], undefined], [[], undefined]]);

    const rule = askHome.statements.msg!.picture!;
    const content = good.content as unknown as JsonObject;
    expect(rule(content, pictures({ carried: [covered] }))).toBeUndefined();
    expect(rule(content, pictures({ staged: [covered] }))).toBeUndefined();
    expect(rule(content, pictures({ held: [blobOf(covered)] }))).toBeUndefined();
    expect(rule(content, pictures({}))).toEqual(expect.stringContaining("neither carried by the bundle, staged by the door, nor held by the home"));
    artifact(home.dir, "seen.json", refusals);
  });
});
