import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { hideDetails, openHomeFolder, piecesText, wantedOf, type BlobReader, type Marked, type Piece, type Prompt } from "@lifestreamprotocol/core";
import { openAsker, type Asker, type RoutedAsk } from "./asker.js";
import { runCall, type CallOptions } from "./call.js";
import { openLedger, type Ledger } from "./ledger.js";
import type { SentPicture } from "./sent.js";
import { SendFailed } from "./transport.js";
import { fakeTransport, type FakeOptions } from "./transports/fake.js";

const RECEIVER = "Example AI";
const DAY = { zone: "UTC", day_start_hour: 0 };
const T0 = Date.UTC(2026, 10, 11, 9);
const HOUR = 60 * 60_000;
const ADA = { who: "p-ada", shown: "Ada Example" };
const PROMPTS: Readonly<Record<string, Prompt>> = {
  note: { version: 1, type: "text", keeps: [], text: "Say in one line what this synthetic note is about." },
  summary: {
    version: 1, keeps: [], text: "Summarise this synthetic note.",
    type: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
  },
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Home {
  root: string;
  ledger: Ledger;
  asker: Asker;
  log: string;
  received(): { input: string; attachments: { media_type: string; bytes: string }[] }[];
  request(ask: RoutedAsk): { send: string; pieces: readonly Piece[]; quoted?: { key: string; at: number } };
  hiddenCopy(key: string, revision: string, pieces: readonly Marked[], more?: { receiver?: string; pictures?: SentPicture[] }): number;
  plainCopy(key: string, receiver?: string): number;
  pictureFolders(): string[];
  call(key: string, fake: FakeOptions, more?: Partial<CallOptions>): ReturnType<typeof runCall>;
  close(): void;
}

function openHome(): Home {
  const root = mkdtempSync(join(tmpdir(), "model-sent-"));
  roots.push(root);
  const path = join(root, "replies", "replies.db");
  const ledger = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" });
  const asker = openAsker({ ledger, prompt: (name) => PROMPTS[name]!, blobs: noBlobs(), clock: () => T0 });
  const log = join(root, "received.jsonl");
  return {
    root, ledger, asker, log,
    received: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as ReturnType<Home["received"]>[number]) : []),
    request(ask) {
      const sending = asker.request(ask);
      if (!("send" in sending)) throw new Error(`no request: ${JSON.stringify(sending)}`);
      return sending;
    },
    hiddenCopy(key, revision, pieces, more = {}) {
      const read = ledger.placeholders.part(`ask:${revision}`, wantedOf(pieces));
      const hidden = hideDetails(pieces, "all", read.table, null);
      const made = ledger.sent.make({
        key, receiver: more.receiver ?? RECEIVER, route: "fake:fake-model", level: "all", body: hidden.texts.join(""), pictures: more.pictures ?? [],
        counts: hidden.counts, detector: null,
      }, T0, ledger.placeholders.epoch().epoch, { read, answered: hidden.table });
      if (!("id" in made)) throw new Error(`no copy: ${JSON.stringify(made)}`);
      return made.id;
    },
    plainCopy(key, receiver = RECEIVER) {
      const made = ledger.sent.make({ key, receiver, route: "fake:fake-model", level: "none", body: null, pictures: [], counts: {}, detector: null }, T0, ledger.placeholders.epoch().epoch);
      if (!("id" in made)) throw new Error(`no copy: ${JSON.stringify(made)}`);
      return made.id;
    },
    pictureFolders: () => (existsSync(join(root, "replies", "sent")) ? readdirSync(join(root, "replies", "sent")).sort() : []),
    call: (key, fake, more = {}) => runCall({
      folder: openHomeFolder(root), key, route: { transport: "fake", timeout_ms: 30_000 }, copies: join(root, "calls"), clock: () => T0, transport: () => fakeTransport({ leaves: RECEIVER, log, ...fake }), ...more,
    }),
    close: () => ledger.close(),
  };
}

function noteAsk(prompt = "note", item = "note-1"): RoutedAsk {
  return {
    family: "notes", item, prompt, model: "fake-model", effort: "low", work: "notes", source: "synthetic:account-a",
    input: [{ text: "\n\nNote: " }, { text: "Ada Example", is: "person", ...ADA }, { text: " wrote to ", free: true }, { text: "person-a@example.com", free: true, known: [{ start: 0, end: 20, type: "email" }] }],
  };
}

function another(item: string): RoutedAsk {
  const ask = noteAsk("note", item);
  return { ...ask, input: [...ask.input, { text: `, of ${item}.` }] };
}

function marked(pieces: readonly Piece[]): Marked[] {
  return pieces.map((piece): Marked => {
    if ("is" in piece) return { text: piece.text, marks: [{ start: 0, end: piece.text.length, type: piece.is, ...(piece.who === undefined ? {} : { who: piece.who }), ...(piece.shown === undefined ? {} : { shown: piece.shown }) }] };
    if ("free" in piece) return { text: piece.text, marks: [...piece.known ?? []] };
    return { text: piece.text, marks: [] };
  });
}

function watchFlushes(seen: (directory: string) => void): void {
  const opened = new Map<number, string>();
  const { openSync, fsyncSync } = fs;
  fs.openSync = ((...args: Parameters<typeof openSync>) => {
    const fd = openSync(...args);
    if (typeof args[0] === "string" && args[1] === "r") opened.set(fd, args[0]);
    return fd;
  }) as typeof openSync;
  fs.fsyncSync = (fd) => {
    const path = opened.get(fd);
    if (path !== undefined && statSync(path).isDirectory()) seen(path);
    fsyncSync(fd);
  };
  syncBuiltinESMExports();
  onTestFinished(() => { fs.openSync = openSync; fs.fsyncSync = fsyncSync; syncBuiltinESMExports(); });
}

function noBlobs(): BlobReader {
  const none = (): never => {
    throw new Error("no blob in these tests");
  };
  return { has: () => false, bytes: none, text: none, prefix: none, materialise: none };
}

describe("the call is the gate", () => {
  it("a route that leaves sends nothing and charges nothing without a copy made for its receiver, and the copy it would not send goes", async () => {
    const home = openHome();
    try {
      const { send: key } = home.request(noteAsk());
      expect(await home.call(key, {})).toMatchObject({ outcome: "busy", sent: false, reason: `nothing is sent to ${RECEIVER}: no copy of the request was made for it` });
      const other = home.hiddenCopy(key, key, marked(home.request(noteAsk()).pieces), { receiver: "Another AI" });
      expect(await home.call(key, {}, { sentCopy: other })).toMatchObject({ outcome: "busy", sent: false });
      expect(home.ledger.sent.get(other)).toBeUndefined();
      expect(home.received()).toEqual([]);
      expect(home.ledger.inFlight()).toEqual([]);
      expect(home.ledger.outbound.list({ from: "2026-11-11", to: "2026-11-11", day: DAY }).rows).toEqual([]);
      expect(await home.call(key, {}, { transport: () => fakeTransport({ log: home.log, reply: "A note to a friend." }) })).toMatchObject({ outcome: "replied", sent: true });
      expect(home.received().map((each) => each.input)).toEqual([home.ledger.row(key)!.body]);
      expect(home.ledger.outbound.list({ from: "2026-11-11", to: "2026-11-11", day: DAY }).rows).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("a copy sends only its hidden body, writes its ask row with the attempt before the send, and its reply lands restored with its marks, the model's own text kept on the copy", async () => {
    const home = openHome();
    try {
      const request = home.request(noteAsk());
      const copy = home.hiddenCopy(request.send, request.send, marked(request.pieces));
      let rowsAtSend = -1;
      const result = await home.call(request.send, {
        reply: () => {
          rowsAtSend = home.ledger.outbound.list({ from: "2026-11-11", to: "2026-11-11", day: DAY }).rows.length;
          return "[[Person 1]] wrote to [[Email 1]] about lunch.";
        },
      }, { sentCopy: copy });
      expect(result).toMatchObject({ outcome: "replied", sent: true });
      const [received] = home.received();
      expect(received!.input).toBe(`${PROMPTS.note!.text}\n\nNote: [[Person 1]] wrote to [[Email 1]]`);
      expect(JSON.stringify(home.received())).not.toMatch(/Ada|person-a@example\.com/u);
      expect(rowsAtSend).toBe(1);
      const [row] = home.ledger.outbound.list({ from: "2026-11-11", to: "2026-11-11", day: DAY }).rows;
      expect(row).toMatchObject({ what: "ask", receiver: RECEIVER, route: "fake:fake-model", key: request.send, attempt: 1, level: "all", counts: { person: 1, email: 1 } });
      expect(home.ledger.outbound.row(row!.seq, DAY)!.sent).toEqual({ body: received!.input, pictures: [] });
      const reply = home.ledger.reply(request.send)!;
      expect(reply.text).toBe("Ada Example wrote to person-a@example.com about lunch.");
      expect(reply.marks).toEqual([{ start: 0, end: 11, type: "person", ...ADA }, { start: 21, end: 41, type: "email" }]);
      expect(home.ledger.sent.get(copy)!.written).toBe("[[Person 1]] wrote to [[Email 1]] about lunch.");
      const answered = home.asker.answer(noteAsk());
      expect(answered !== null && "reply" in answered ? answered.reply.marks : undefined).toEqual(reply.marks);
    } finally {
      home.close();
    }
  });

  it("a reply that writes an unknown placeholder lands refused as one try in the home's words, and the retry quotes the model's own words with its table", async () => {
    const home = openHome();
    try {
      const request = home.request(noteAsk());
      const copy = home.hiddenCopy(request.send, request.send, marked(request.pieces));
      expect(await home.call(request.send, { reply: "[[Person 1]] met [[Person 9]] and Email 1." }, { sentCopy: copy })).toMatchObject({ outcome: "replied", sent: true });
      const reply = home.ledger.reply(request.send)!;
      expect(reply.validation).toBe("refused");
      expect(reply.unknown).toEqual(["[[Person 9]]"]);
      expect(home.ledger.lastFailure(request.send)).toBe("Your answer wrote [[Person 9]], which the text does not hold.");
      expect(home.ledger.placeholders.part(`ask:${request.send}`, wantedOf([])).table.next.person).toBeGreaterThan(9);
      const retry = home.request(noteAsk());
      expect(retry.send).not.toBe(request.send);
      expect(retry.quoted).toEqual({ key: request.send, at: 6 });
      expect(retry.pieces[retry.quoted!.at]).toEqual({ text: "Ada Example met [[Person 9]] and person-a@example.com.", free: true, known: [{ start: 0, end: 11, type: "person", ...ADA }, { start: 33, end: 53, type: "email" }] });
      expect(retry.pieces[8]).toEqual({ text: home.ledger.lastFailure(request.send) });
      expect(home.ledger.sent.written(request.send, RECEIVER, "all")).toBe("[[Person 1]] met [[Person 9]] and Email 1.");
      expect(piecesText(retry.pieces)).toBe(home.ledger.row(retry.send)!.body);
    } finally {
      home.close();
    }
  });

  it("a typed answer is restored string by string, so a name that holds a quote leaves its JSON whole", async () => {
    const home = openHome();
    try {
      const quoted = { text: 'Ada "Ace" Example', is: "person" as const, who: "p-ace" };
      const ask: RoutedAsk = { ...noteAsk("summary"), input: [{ text: "\n\nNote from " }, quoted] };
      const request = home.request(ask);
      const copy = home.hiddenCopy(request.send, request.send, marked(request.pieces));
      expect(await home.call(request.send, { reply: '{"summary":"[[Person 1]] says hello."}' }, { sentCopy: copy })).toMatchObject({ outcome: "replied" });
      const reply = home.ledger.reply(request.send)!;
      expect(JSON.parse(reply.text)).toEqual({ summary: 'Ada "Ace" Example says hello.' });
      expect(reply.validation).toBeNull();
      const answered = home.asker.answer(ask);
      expect(answered !== null && "reply" in answered ? answered.reply.value : undefined).toEqual({ summary: 'Ada "Ace" Example says hello.' });
    } finally {
      home.close();
    }
  });

  it("a reply on a route that leaves nothing keeps as marks the details the ask stated that it writes plain, in their exact form", async () => {
    const home = openHome();
    try {
      const request = home.request(noteAsk());
      await home.call(request.send, {}, { transport: () => fakeTransport({ reply: "Ada Example wrote; ada example did not; Adam did." }) });
      const answered = home.asker.answer(noteAsk());
      expect(answered !== null && "reply" in answered ? answered.reply.marks : undefined).toEqual([{ start: 0, end: 11, type: "person", ...ADA }]);
    } finally {
      home.close();
    }
  });
});

describe("what a reply is put back by", () => {
  it("a reply to what was sent plain lands as written: a `[[…]]` of its own on a route that leaves nothing, or to a copy under `none`, is no unknown placeholder", async () => {
    const home = openHome();
    try {
      const local = home.request(noteAsk());
      await home.call(local.send, {}, { transport: () => fakeTransport({ reply: "See [[Something]] and [[Person 4]]." }) });
      expect(home.ledger.reply(local.send)).toMatchObject({ text: "See [[Something]] and [[Person 4]].", validation: null, unknown: [] });
      const plain = home.request(another("note-2"));
      await home.call(plain.send, { reply: "Linked from [[Something]]." }, { sentCopy: home.plainCopy(plain.send) });
      expect(home.ledger.reply(plain.send)).toMatchObject({ text: "Linked from [[Something]].", validation: null, unknown: [] });
      expect(home.ledger.lastFailure(plain.send)).toBeUndefined();
    } finally {
      home.close();
    }
  });

  it("a landing's counters are written over the ask's table as it stands then, each the larger, never over a part read before; during an erasure the landing writes nothing", () => {
    const home = openHome();
    try {
      const outgoing = (copy: number) => ({ copy, outbound: { at_ms: T0, receiver: RECEIVER, route: "fake:fake-model", by: null, what: "ask" as const, tool: null, level: "all" as const, counts: {}, chars: 1, pictures: 0 } });
      const request = home.request(noteAsk());
      const begun = home.ledger.beginAttempt(request.send, T0, "fake", outgoing(home.hiddenCopy(request.send, request.send, marked(request.pieces))));
      if (!("attempt" in begun)) throw new Error(`not begun: ${JSON.stringify(begun)}`);
      home.hiddenCopy("sha256:other", request.send, [{ text: "Bea Example at person-b@example.com", marks: [{ start: 0, end: 11, type: "person", who: "p-bea" }, { start: 15, end: 35, type: "email" }] }]);
      const before = home.ledger.placeholders.part(`ask:${request.send}`, wantedOf([])).table.next;
      expect(home.ledger.land(begun.attempt, { text: "x", model: "fake-model", transport: "fake", table: { scope: `ask:${request.send}`, next: { person: 10, email: 1 } } }, T0)).toBe(true);
      expect(home.ledger.placeholders.part(`ask:${request.send}`, wantedOf([])).table.next).toEqual({ ...before, person: 10 });
      const second = home.request(another("note-2"));
      const again = home.ledger.beginAttempt(second.send, T0, "fake", outgoing(home.hiddenCopy(second.send, second.send, marked(second.pieces))));
      if (!("attempt" in again)) throw new Error(`not begun: ${JSON.stringify(again)}`);
      home.ledger.placeholders.beginErasure();
      expect(home.ledger.land(again.attempt, { text: "[[Person 7]]", model: "fake-model", transport: "fake", table: { scope: `ask:${second.send}`, next: { person: 8 } } }, T0)).toBe(false);
      home.ledger.placeholders.endErasure();
      expect(home.ledger.reply(second.send)).toBeUndefined();
      expect(home.ledger.placeholders.part(`ask:${second.send}`, wantedOf([])).table.next.person).toBeLessThan(8);
    } finally {
      home.close();
    }
  });
});

describe("what a retry quotes as the model wrote it", () => {
  it("only the words of the attempt that landed the reply, by a copy for the same receiver under the same level: never a `none` copy's, another receiver's, or an earlier attempt's", async () => {
    const home = openHome();
    try {
      const plain = home.request(noteAsk());
      await home.call(plain.send, { reply: "Ada Example ate." }, { sentCopy: home.plainCopy(plain.send) });
      expect(home.ledger.sent.written(plain.send, RECEIVER, "all")).toBeUndefined();
      expect(home.ledger.sent.written(plain.send, RECEIVER, "none")).toBe("Ada Example ate.");
      const hidden = home.request(another("note-2"));
      await home.call(hidden.send, { reply: "[[Person 1]] ate." }, { sentCopy: home.hiddenCopy(hidden.send, hidden.send, marked(hidden.pieces)) });
      expect(home.ledger.sent.written(hidden.send, RECEIVER, "all")).toBe("[[Person 1]] ate.");
      expect(home.ledger.sent.written(hidden.send, "Another AI", "all")).toBeUndefined();
      expect(home.ledger.sent.written(hidden.send, RECEIVER, "names")).toBeUndefined();
      home.ledger.refuse(hidden.send, { family: "notes", unit: "note-2" }, "Too short.", T0);
      const begun = home.ledger.beginAttempt(hidden.send, T0 + 31 * 60_000, "fake");
      if (!("attempt" in begun)) throw new Error(`not begun: ${JSON.stringify(begun)}`);
      home.ledger.land(begun.attempt, { text: "Ada Example ate lunch.", model: "fake-model", transport: "fake" }, T0 + 31 * 60_000);
      expect(home.ledger.sent.written(hidden.send, RECEIVER, "all")).toBeUndefined();
    } finally {
      home.close();
    }
  });
});

describe("a copy's pictures", () => {
  const RECIPE = { blob: "sha256:synthetic-photo", filled: [], written: [], engine: "test" };
  const outbound = (copy: number) => ({ copy, outbound: { at_ms: T0, receiver: RECEIVER, route: "fake:fake-model", by: null, what: "ask" as const, tool: null, level: "all" as const, counts: {}, chars: 1, pictures: 1 } });

  it("are files of the copy alone, sent from there and removed once the reply lands, their recipes kept", async () => {
    const home = openHome();
    try {
      const request = home.request(noteAsk());
      const copy = home.hiddenCopy(request.send, request.send, marked(request.pieces), { pictures: [{ jpeg: JPEG, recipe: RECIPE }] });
      expect(home.ledger.sent.files(copy).every((file) => file.exists())).toBe(true);
      expect(existsSync(join(home.root, "replies", "blobs"))).toBe(false);
      await home.call(request.send, { reply: "[[Person 1]] in a photo." }, { sentCopy: copy });
      expect(home.received()[0]!.attachments).toEqual([{ media_type: "image/jpeg", bytes: JPEG.toString("base64") }]);
      expect(home.pictureFolders()).toEqual([]);
      expect(home.ledger.sent.get(copy)!.pictures).toEqual([RECIPE]);
      const seq = home.ledger.outbound.list({ from: "2026-11-11", to: "2026-11-11", day: DAY }).rows[0]!.seq;
      expect(home.ledger.outbound.row(seq, DAY)!.sent!.pictures).toEqual([RECIPE]);
    } finally {
      home.close();
    }
  });

  it("go when the attempt ends with no reply: a failed send, a provider's rest (with the copy), a process that died", async () => {
    const home = openHome();
    try {
      const failing = home.request(noteAsk());
      const failed = home.hiddenCopy(failing.send, failing.send, marked(failing.pieces), { pictures: [{ jpeg: JPEG, recipe: RECIPE }] });
      expect(await home.call(failing.send, { fail: "the request was malformed" }, { sentCopy: failed })).toMatchObject({ outcome: "failed" });
      expect(home.pictureFolders()).toEqual([]);
      expect(home.ledger.sent.get(failed)!.pictures).toEqual([RECIPE]);
      const resting = home.request(another("note-2"));
      const rested = home.hiddenCopy(resting.send, resting.send, marked(resting.pieces), { pictures: [{ jpeg: JPEG, recipe: RECIPE }] });
      const busy = () => {
        throw new SendFailed("fake", "the provider is busy", 503);
      };
      expect(await home.call(resting.send, { reply: busy }, { sentCopy: rested })).toMatchObject({ outcome: "unavailable" });
      expect(home.ledger.sent.get(rested)!.pictures).toEqual([RECIPE]);
      expect(home.pictureFolders()).toEqual([]);
      const dying = home.request(another("note-3"));
      const died = home.hiddenCopy(dying.send, dying.send, marked(dying.pieces), { pictures: [{ jpeg: JPEG, recipe: RECIPE }] });
      const begun = home.ledger.beginAttempt(dying.send, T0, "fake", outbound(died));
      if (!("attempt" in begun)) throw new Error(`not begun: ${JSON.stringify(begun)}`);
      expect(home.ledger.sent.sweep(T0 + 1, 0)).toBe(0);
      expect(home.pictureFolders()).toEqual([String(died)]);
      expect(home.ledger.sent.sweep(T0 + 2 * HOUR, HOUR)).toBe(0);
      expect(home.pictureFolders()).toEqual([String(died)]);
      expect(home.ledger.reapQuiet(T0 + 2 * HOUR)).toBe(1);
      expect(home.pictureFolders()).toEqual([]);
      expect(home.ledger.sent.get(died)!.pictures).toEqual([RECIPE]);
    } finally {
      home.close();
    }
  });
});

describe("the copies' lifecycle", () => {
  it("a save an erasure ran past writes no copy and no picture; a copy no call took goes at the sweep; an erasure takes every copy of an item's requests with their pictures", () => {
    const home = openHome();
    try {
      const request = home.request(noteAsk());
      const pieces = marked(request.pieces);
      const epoch = home.ledger.placeholders.epoch().epoch;
      const read = home.ledger.placeholders.part(`ask:${request.send}`, wantedOf(pieces));
      home.ledger.placeholders.beginErasure();
      home.ledger.placeholders.endErasure();
      const hidden = hideDetails(pieces, "all", read.table, null);
      const copy = { key: request.send, receiver: RECEIVER, route: "fake:fake-model", level: "all" as const, body: hidden.texts.join(""), pictures: [{ jpeg: JPEG, recipe: { engine: "test" } }], counts: hidden.counts, detector: null };
      expect(home.ledger.sent.make(copy, T0, epoch, { read, answered: hidden.table })).toEqual({ erased: true });
      expect(home.ledger.sent.make({ ...copy, level: "none", body: null, pictures: [] }, T0, epoch)).toEqual({ erased: true });
      expect(home.pictureFolders()).toEqual([]);
      const untaken = home.hiddenCopy(request.send, request.send, pieces, { pictures: [{ jpeg: JPEG, recipe: { engine: "test" } }] });
      expect(home.ledger.sent.sweep(T0, HOUR)).toBe(0);
      expect(home.pictureFolders()).toEqual([String(untaken)]);
      expect(home.ledger.sent.sweep(T0 + 1, 0)).toBe(1);
      expect(home.ledger.sent.get(untaken)).toBeUndefined();
      expect(home.pictureFolders()).toEqual([]);
      const erased = home.hiddenCopy(request.send, request.send, pieces, { pictures: [{ jpeg: JPEG, recipe: { engine: "test" } }] });
      home.ledger.placeholders.beginErasure();
      home.ledger.forget(["note-1"]);
      home.ledger.placeholders.endErasure();
      expect(home.ledger.sent.get(erased)).toBeUndefined();
      expect(home.pictureFolders()).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("an erasure removes a copy's pictures and flushes nothing, or flushes after its commit, so a power cut brings a picture back once its rows are gone", () => {
    const home = openHome();
    try {
      const request = home.request(noteAsk());
      const copy = home.hiddenCopy(request.send, request.send, marked(request.pieces), { pictures: [{ jpeg: JPEG, recipe: { engine: "test" } }] });
      const sent = join(home.root, "replies", "sent");
      expect(home.pictureFolders()).toEqual([String(copy)]);
      const reader = new Database(join(home.root, "replies", "replies.db"), { readonly: true });
      onTestFinished(() => { reader.close(); });
      const flushed: { path: string; committed: boolean; standing: boolean }[] = [];
      watchFlushes((path) => {
        flushed.push({ path, committed: reader.prepare("SELECT 1 FROM sent_copies WHERE id = ?").get(copy) === undefined, standing: existsSync(join(sent, String(copy))) });
      });
      home.ledger.placeholders.beginErasure();
      home.ledger.forget(["note-1"]);
      home.ledger.placeholders.endErasure();
      expect(flushed.filter((each) => each.path === sent)).toEqual([{ path: sent, committed: false, standing: false }]);
      expect(home.ledger.sent.get(copy)).toBeUndefined();
      expect(home.pictureFolders()).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("an erasure run again after one that died, finding a copy's pictures and an attachment already removed, leaves their folders unflushed at its commit", () => {
    const home = openHome();
    try {
      const request = home.request(noteAsk());
      const copy = home.hiddenCopy(request.send, request.send, marked(request.pieces), { pictures: [{ jpeg: JPEG, recipe: { engine: "test" } }] });
      const sha256 = home.ledger.keep(Buffer.from("synthetic attachment of the erased item"));
      home.ledger.request({
        key: "attached-1", family: "notes", unit: "note-1", revision: "attached-1", model: "fake-model", effort: "low",
        prompt: { name: "describe", version: 1, text: "Describe the item.", type: "text" }, input_hash: "synthetic-input-hash", body: "synthetic input", attachments: [{ kind: "image", sha256, extension: ".jpg" }],
      }, T0);
      const sent = join(home.root, "replies", "sent");
      const attachment = join(home.root, "replies", "blobs", sha256.slice(0, 2), sha256.slice(2, 4), sha256);
      expect({ pictures: home.pictureFolders(), attachment: existsSync(attachment) }).toEqual({ pictures: [String(copy)], attachment: true });
      rmSync(join(sent, String(copy)), { recursive: true });
      rmSync(attachment);
      const reader = new Database(join(home.root, "replies", "replies.db"), { readonly: true });
      onTestFinished(() => { reader.close(); });
      const flushed = new Map<string, boolean>();
      watchFlushes((path) => {
        flushed.set(path, reader.prepare("SELECT 1 FROM sent_copies WHERE id = ?").get(copy) === undefined);
      });
      home.ledger.placeholders.beginErasure();
      home.ledger.forget(["note-1"]);
      home.ledger.placeholders.endErasure();
      expect([sent, dirname(attachment)].map((path) => [path, flushed.get(path)])).toEqual([[sent, false], [dirname(attachment), false]]);
      expect(home.ledger.sent.get(copy)).toBeUndefined();
    } finally {
      home.close();
    }
  });

  it("a copy handed to a call whose route leaves nothing is deleted: the call sends the request as it is, and its attempt names no copy", async () => {
    const home = openHome();
    try {
      const request = home.request(noteAsk());
      const copy = home.hiddenCopy(request.send, request.send, marked(request.pieces), { pictures: [{ jpeg: JPEG, recipe: { engine: "test" } }] });
      expect(await home.call(request.send, {}, { sentCopy: copy, transport: () => fakeTransport({ log: home.log, reply: "A note." }) })).toMatchObject({ outcome: "replied" });
      expect(home.ledger.sent.get(copy)).toBeUndefined();
      expect(home.pictureFolders()).toEqual([]);
      expect(home.received().map((each) => each.input)).toEqual([home.ledger.row(request.send)!.body]);
    } finally {
      home.close();
    }
  });
});
