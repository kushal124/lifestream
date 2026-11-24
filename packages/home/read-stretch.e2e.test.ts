import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { ANSWER_CHARS } from "./call.js";
import { CITES_MOST, PAGE_LINES, PICTURE_WORDS } from "./read.js";
import { makeRef } from "./refs.js";
import { readScreen, screenFileOf, screenPositionOf } from "./screen-index.js";
import { answerOf, type ReadAnswer } from "./search-contract.js";
import { searchFileOf } from "./search-index.js";
import { artifact, hex, makeRoot, readHome, removeRoot, settled, until, TICK_MS } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { openHomeFolder } from "@lifestreamprotocol/core";


const REGISTRY = fileURLToPath(new URL("./test/read-registry.ts", import.meta.url));
const READER = "synthetic-token-read-stretch".padEnd(43, "r");
const WHATSAPP = "whatsapp:local:iphone-aa01";
const NOTES = "apple-notes:local:device-a";
const SCREEN = "screen:local:mac-0001";
const ADA = "15550000142@s.whatsapp.net";
const APPLE_EPOCH_S = 978_307_200;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = Math.floor(Date.now() / DAY) * DAY - 10 * DAY + 9 * HOUR;
const D = new Date(T).toISOString().slice(0, 10);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const E_MS = T + 3 * DAY;
const MANY = 420;
const S = T - 3 * HOUR;
const NOW = Date.now();
const PHOTO = Buffer.from("synthetic day photo bytes");
const EARLY = "The synthetic itinerary: ferry at noon, then the lighthouse museum.";
const LATE = "A later synthetic line about the harbour timetable for the evening.";
const AFTER = "An afternoon synthetic line, the last the window showed that day.";
const LONG = Array.from({ length: 30 }, (_, at) => `${String(at).padStart(2, "0")} synthetic screen line about item ${at}: ${"quiet harbour words ".repeat(120)}${at}`);
const answers: Record<string, unknown> = {};

function wa(stanza: string, when: number, words: string | null, photo?: string) {
  const date = when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: stanza, ZTEXT: words, ZFROMJID: ADA, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: photo === undefined ? 0 : 1, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${ADA}:${stanza}`, at: when,
    content: {
      type: "whatsapp.msg", message, session_jid: ADA, parent_stanza_id: null, media_item: null, group_member_jid: null,
      blobs: photo === undefined ? [] : [{ hash: `sha256:${photo}`, bytes: PHOTO.length, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }],
    },
    ...(photo === undefined ? {} : { blobs: [`sha256:${photo}`] }),
  };
}

function note(key: string, at: number, text: string) {
  return { kind: "note", key, at, content: { text, at } };
}

function frame(key: string, at: number, ...lines: string[]) {
  return {
    kind: "frame", key, at,
    content: {
      at, status: "captured", displayID: 1, application: { name: "Example Editor", bundleID: "com.example.editor" },
      frontWindow: { windowID: 11 }, windows: [{ windowID: 11, title: "Notes" }],
      accessibility: { nodes: lines.map((value) => ({ depth: 1, role: "AXStaticText", value })) }, ocr: [],
    },
  };
}

function caughtUp(root: string): boolean {
  const machine = process.env.LIFESTREAM_MACHINE_DIR!;
  let index: { seq: number; days: number };
  let screen: number;
  try {
    const db = new Database(searchFileOf(root, machine), { readonly: true, fileMustExist: true, timeout: 5_000 });
    try {
      index = {
        seq: (JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'position'").pluck().get() as string) as { seq: number }).seq,
        days: db.prepare("SELECT count(*) FROM days").pluck().get() as number,
      };
    } finally {
      db.close();
    }
    const file = readScreen(openHomeFolder(root), screenFileOf(searchFileOf(root, machine)));
    if (file === undefined) return false;
    try {
      screen = screenPositionOf(file)?.seq ?? 0;
    } finally {
      file.close();
    }
  } catch {
    return false;
  }
  return readHome(root, (db) => {
    const seq = db.prepare("SELECT coalesce(max(seq), 0) FROM statements").pluck().get() as number;
    return index.seq === seq && screen === seq
      && (db.prepare("SELECT count(*) FROM jobs WHERE state <> 'done'").pluck().get() as number) === 0
      && (db.prepare("SELECT count(*) FROM dirty_days").pluck().get() as number) === 0
      && (db.prepare("SELECT count(*) FROM days").pluck().get() as number) === index.days;
  });
}

function windowKey(root: string): { machine: string; app: string; site: string; name: string } {
  const db = readScreen(openHomeFolder(root), screenFileOf(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!)))!;
  try {
    return db.prepare("SELECT machine, app, site, name FROM screen_key").get() as { machine: string; app: string; site: string; name: string };
  } finally {
    db.close();
  }
}

describe("read: stretches and the screen", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let shipped = 0;
  const photo = hex(PHOTO);
  const message = (stanza: string) => makeRef("record", { source: WHATSAPP, kind: "msg", key: `${ADA}:${stanza}` });

  const send = async (planned: Parameters<typeof ship>[1]) => {
    await ship(root, planned);
    shipped++;
    await until("the home settled", () => settled(root, shipped));
  };
  const sendScreen = async (planned: Parameters<typeof ship>[1]) => {
    await ship(root, planned);
    shipped++;
    await until("the home settled, the screen's accounts owed with no text route", () => readHome(root, (db) =>
      db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() === shipped
      && db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get() === 0
      && db.prepare("SELECT count(*) FROM asks WHERE state = 'pending' AND family <> 'screen'").pluck().get() === 0
      && (db.prepare("SELECT count(*) FROM asks WHERE state = 'pending' AND family = 'screen'").pluck().get() as number) > 0));
  };
  const read = async (name: string, query: Record<string, string | string[]>): Promise<{ status: number; body: any }> => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) for (const each of typeof value === "string" ? [value] : value) params.append(key, each);
    const response = await fetch(`http://127.0.0.1:${door.port}/v1/read?${params}`, { headers: { authorization: `Bearer ${READER}` } });
    const body = await response.json() as Record<string, unknown>;
    answers[name] = { query, status: response.status, body };
    answerOf("/v1/read", response.status, body);
    return { status: response.status, body };
  };
  const opened = async (name: string, query: Record<string, string | string[]>): Promise<any> => {
    const { status, body } = await read(name, query);
    expect(status, JSON.stringify(body)).toBe(200);
    return body as ReadAnswer;
  };
  const described = async (name: string, refs: string[]): Promise<any[]> => {
    const response = await fetch(`http://127.0.0.1:${door.port}/v1/describe?${new URLSearchParams(refs.map((ref): [string, string] => ["ref", ref]))}`, { headers: { authorization: `Bearer ${READER}` } });
    const body = await response.json() as { described: unknown[] };
    answers[name] = { refs, status: response.status, body };
    answerOf("/v1/describe", response.status, body);
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.described;
  };
  const pages = async (name: string, first: any): Promise<any[]> => {
    const all = [first];
    for (let at = 1; all.at(-1).next !== null && all.at(-1).next !== undefined; at++) {
      if (at > 20) throw new Error(`${name}: more than 20 pages`);
      all.push(await opened(`${name}-${at}`, { cursor: all.at(-1).next }));
    }
    return all;
  };

  beforeAll(async () => {
    root = makeRoot("lifestream-read-stretch-", { sources: { [WHATSAPP]: "fake-rows", [NOTES]: "fake-rows", [SCREEN]: "fake-rows" }, settings: { "model.defaults.text": null } });
    mintPrincipal(openHomeFolder(root), { unit: "read-stretch-aa01", scopes: ["read"], token: READER, now_ms: 0 });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
    await send({
      source: NOTES, fetched_ms: Date.now(),
      rows: [
        note("before", T - DAY, "synthetic note the day before"), note("nine", T, "synthetic note at nine"), note("eleven", T + 2 * HOUR, "synthetic note at eleven"),
        ...Array.from({ length: MANY }, (_, at) => note(`many-${at}`, E_MS + at * 10_000, `synthetic busy note ${at}`)),
        note("just-now", NOW - 30 * MINUTE, "synthetic note just now"),
      ],
    });
    await send({
      source: WHATSAPP, fetched_ms: Date.now() + 1, carried: { [photo]: PHOTO },
      rows: [
        wa("m1", T + 30 * MINUTE, "dinner at the lighthouse tonight"), wa("m2", T + 35 * MINUTE, null, photo), wa("m3", T + DAY + HOUR, "see you there"),
        wa("m4", NOW - 20 * MINUTE, "on my way now"),
      ],
    });
    await sendScreen({
      source: SCREEN, fetched_ms: Date.now() + 2,
      rows: [
        frame("f0", S, EARLY), frame("f1", S + MINUTE, EARLY),
        ...LONG.map((line, at) => frame(`l${at}`, S + 2 * MINUTE + at * 20_000, EARLY, line)),
        frame("late", S + 40 * MINUTE, EARLY, LATE), frame("after", S + 7 * HOUR, AFTER),
      ] as never,
    });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY });
    await until("both indexes caught up with the home", () => caughtUp(root));
  });

  afterAll(async () => {
    if (root !== undefined) artifact(root, "read-stretch", answers);
    await door?.close();
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("a day read as lines holds every family's lines in time order, a message's photo a line of its own; families and part of a day keep theirs", async () => {
    const day = await opened("day-lines", { from: D });
    expect(day).toMatchObject({ what: "lines", span: { from: D, to: D }, next: null });
    expect(day.as_of).toEqual(expect.any(String));
    expect(day.pending).toBeUndefined();
    const timed = day.lines.filter((line: any) => line.at !== undefined).map((line: any) => Date.parse(line.at));
    expect(timed).toEqual([...timed].sort((left, right) => left - right));
    const families = day.lines.map((line: any) => line.family);
    expect(families).toEqual(["screen", "screen", "notes", "messages", "messages", "messages", "notes", "screen"]);
    expect(day.lines.every((line: any) => line.day === D)).toBe(true);
    const at = day.lines.findIndex((line: any) => line.ref === message("m1"));
    expect(day.lines[at].text).toContain("dinner at the lighthouse tonight");
    expect(day.lines[at + 1].ref).toBe(message("m2"));
    expect(day.lines[at + 2]).toMatchObject({ picture: true, text: PICTURE_WORDS, ref: makeRef("picture", { image: `sha256:${photo}` }), at: day.lines[at + 1].at });
    expect(await opened("day-line-message", { ref: message("m1") })).toMatchObject({ what: "chat", around: message("m1") });
    expect(await opened("day-line-note", { ref: day.lines[2].ref })).toMatchObject({ what: "record", text: "synthetic note at nine" });
    const screen = day.lines.filter((line: any) => line.family === "screen");
    expect(screen.map((line: any) => line.text)).toEqual([
      expect.stringMatching(/^06:00–06:1\d, not summarised yet: Example Editor(, .+)?, \d+ min on screen$/u),
      "1 more window, under a minute each", "1 more window, under a minute each",
    ]);
    expect(screen[1].cites).toHaveLength(1);
    expect(JSON.stringify(day)).not.toMatch(/frames|account pending/u);
    expect(await opened("day-line-sitting", { ref: day.lines[0].ref })).toMatchObject({ what: "window", day: D, app: "Example Editor" });

    const notes = await opened("day-notes", { from: D, families: "notes" });
    expect(notes.lines.map((line: any) => line.text)).toEqual(["synthetic note at nine", "synthetic note at eleven"]);
    const part = await opened("day-part", { from: `${D}T09:20:00Z`, to: `${D}T09:40:00Z` });
    expect(part).toMatchObject({ what: "lines", span: { from: `${D}T09:20+00:00`, to: `${D}T09:40+00:00` } });
    expect(part.lines.map((line: any) => line.ref)).toEqual([message("m1"), message("m2"), makeRef("picture", { image: `sha256:${photo}` })]);
    const two = await opened("two-days", { from: dayOf(T - DAY), to: D });
    expect(two).toMatchObject({ what: "lines", span: { from: dayOf(T - DAY), to: D } });
    expect(two.lines[0]).toMatchObject({ text: "synthetic note the day before", day: dayOf(T - DAY) });
  });

  it("three whole days are a brief, each day at a glance, each line citing refs that open; a day with no file has none", async () => {
    const brief = await opened("brief", { from: dayOf(T - DAY), to: dayOf(T + 2 * DAY) });
    expect(brief).toMatchObject({ what: "brief", span: { from: dayOf(T - DAY), to: dayOf(T + 2 * DAY) }, next: null });
    expect(brief.as_of).toEqual(expect.any(String));
    expect(brief.pending).toBeUndefined();
    expect(brief.days.map((day: any) => day.day)).toEqual([dayOf(T - DAY), D, dayOf(T + DAY), dayOf(T + 2 * DAY)]);
    expect(brief.days[3].lines).toEqual([]);
    const lines = brief.days[1].lines;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(40);
    for (const [at, line] of lines.entries()) {
      expect(line.cites.length).toBeGreaterThan(0);
      expect(line.cites.length).toBeLessThanOrEqual(CITES_MOST);
      for (const cite of line.cites) expect((await read(`brief-cite-${at}`, { ref: cite })).status).toBe(200);
    }
    const chats = await opened("brief-messages", { from: dayOf(T - DAY), to: dayOf(T + 2 * DAY), families: "messages" });
    for (const day of chats.days) {
      for (const line of day.lines) expect(line.cites.some((cite: string) => cite === message("m1") || cite === message("m2") || cite === message("m3"))).toBe(true);
    }
    expect(chats.days[1].lines.some((line: any) => line.cites.includes(message("m1")))).toBe(true);
    expect(chats.days[1].lines.some((line: any) => line.text.includes("synthetic note"))).toBe(false);
    expect(await opened("three-as-lines", { from: dayOf(T - DAY), to: dayOf(T + DAY), detail: "lines" })).toMatchObject({ what: "lines" });
  });

  it("`last` reads the stretch ending now, as a brief by default; `products` keeps one product's lines in every view; an unknown product, or `last` with `from`, is refused", async () => {
    const asked = Date.now();
    const brief = await opened("last-brief", { last: "2h" });
    expect(brief).toMatchObject({ what: "brief", next: null });
    const [from, to] = [Date.parse(brief.span.from), Date.parse(brief.span.to)];
    expect([to - from, to >= Math.floor(asked / MINUTE) * MINUTE]).toEqual([2 * HOUR, true]);
    const texts = brief.days.flatMap((day: any) => day.lines.map((line: any) => line.text));
    expect(texts).toContain("notes: 1 line");
    expect(texts.some((text: string) => /^\d{2}:\d{2} .+: 1 message$/u.test(text))).toBe(true);
    expect(texts.some((text: string) => text.includes("lighthouse"))).toBe(false);
    expect(brief.freshness).toEqual(expect.stringMatching(/synced/u));
    expect(await opened("last-as-plain", { from: brief.span.from, to: brief.span.to, detail: "brief" })).not.toHaveProperty("freshness");
    const empty = await opened("last-empty", { last: "1m", families: "notes" });
    expect([empty.days.flatMap((day: any) => day.lines), empty.freshness]).toEqual([[], expect.stringMatching(/synced/u)]);
    const chats = await opened("last-whatsapp", { last: "2h", products: "whatsapp" });
    const kept = chats.days.flatMap((day: any) => day.lines);
    expect(kept.map((line: any) => line.text)).toEqual([expect.stringMatching(/: 1 message$/u)]);
    expect(kept[0].cites).toEqual([message("m4")]);
    const lines = await opened("last-whatsapp-lines", { last: "2h", products: "whatsapp", detail: "lines" });
    expect(lines.lines.map((line: any) => line.ref)).toEqual([message("m4")]);
    expect(lines.freshness).toEqual(expect.stringMatching(/synced/u));
    expect((await read("last-unknown-product", { last: "2h", products: "no-such-product" })).body).toMatchObject({ code: "BAD_PARAMETER", message: expect.stringContaining("no-such-product") });
    expect((await read("last-with-from", { last: "2h", from: D })).body).toMatchObject({ code: "BAD_PARAMETER", message: expect.stringContaining("`last` is a stretch that ends now") });
  });

  it("raw gives each record the stretch prints once, whole", async () => {
    const raw = await opened("raw", { from: D, detail: "raw" });
    expect(raw).toMatchObject({ what: "raw", span: { from: D, to: D }, next: null });
    const refs = raw.records.map((record: any) => record.ref);
    expect(new Set(refs).size).toBe(refs.length);
    expect(raw.records.find((record: any) => record.text === "synthetic note at nine")).toMatchObject({ what: "record", family: "notes", day: D });
    expect(refs).toContain(message("m1"));
    const notes = await opened("raw-notes", { from: D, detail: "raw", families: "notes" });
    expect(notes.records.map((record: any) => record.text)).toEqual(["synthetic note at nine", "synthetic note at eleven"]);
  });

  it("a stretch past a page goes on by next, each line once and in order; a cursor with other arguments, or forged, is refused", async () => {
    const asked = { from: dayOf(E_MS) };
    const first = await opened("busy-day", asked);
    expect(first.lines.length).toBeLessThanOrEqual(PAGE_LINES);
    expect(first.next).toEqual(expect.any(String));
    const all = await pages("busy-day", first);
    expect(all).toHaveLength(2);
    expect(all.flatMap((page) => page.lines.map((line: any) => line.text))).toEqual(Array.from({ length: MANY }, (_, at) => `synthetic busy note ${at}`));
    expect(all[1].span.from).toBe(dayOf(E_MS));
    expect((await read("busy-day-own-args", { ...asked, cursor: first.next })).status).toBe(200);
    expect((await read("busy-day-other-args", { from: D, cursor: first.next })).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await read("busy-day-forged", { cursor: `read.${Buffer.from('{"k":"days"}').toString("base64url")}` })).body).toMatchObject({ code: "BAD_PARAMETER" });
  });

  it("a stretch of 30 minutes of screen text: the lines new in it, each with its window, across pages each once; longer, or mixed, is refused", async () => {
    const asked = { from: new Date(S).toISOString(), to: new Date(S + 30 * MINUTE).toISOString(), families: "screen", detail: "raw" };
    const first = await opened("screen-text", asked);
    expect(first).toMatchObject({ what: "screen", span: { from: `${D}T06:00+00:00`, to: `${D}T06:30+00:00` } });
    expect(first.next).toEqual(expect.any(String));
    const all = await pages("screen-text", first);
    expect(all.length).toBeGreaterThan(1);
    for (const page of all) expect(JSON.stringify(page).length).toBeLessThanOrEqual(ANSWER_CHARS.person);
    const lines = all.flatMap((page) => page.lines);
    expect(lines.map((line: any) => line.text)).toEqual([EARLY, ...LONG]);
    expect(lines[0]).toMatchObject({ at: `${D}T06:00+00:00`, app: "Example Editor", title: "Notes" });
    const later = await opened("screen-text-later", { from: new Date(S + 30 * MINUTE).toISOString(), to: new Date(S + 60 * MINUTE).toISOString(), families: "screen", detail: "raw" });
    expect(later.lines.map((line: any) => line.text)).toEqual([LATE]);
    expect((await read("screen-text-long", { ...asked, to: new Date(S + 31 * MINUTE).toISOString() })).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await read("screen-text-day", { from: D, families: "screen", detail: "raw" })).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await read("screen-text-mixed", { ...asked, families: ["screen", "notes"] })).body).toMatchObject({ code: "BAD_PARAMETER" });
    expect((await read("screen-text-other-args", { ...asked, from: new Date(S + MINUTE).toISOString(), cursor: first.next })).body).toMatchObject({ code: "BAD_PARAMETER" });
  });

  it("a window opens at its minute, with the line it first showed earlier that day, and goes on to its later rows; its citation names that minute; one not held is gone", async () => {
    const key = windowKey(root);
    expect(key).toMatchObject({ machine: "mac-0001", app: "Example Editor" });
    const minute = S + 40 * MINUTE;
    const ref = makeRef("window", { ...key, day: D, at_ms: minute });
    const window = await opened("window", { ref });
    expect(window).toMatchObject({ what: "window", ref, day: D, app: "Example Editor", title: key.name !== "" ? key.name : key.app, at: `${D}T06:40+00:00` });
    expect(window.lines).toEqual([{ at: `${D}T06:40+00:00`, text: EARLY }, { at: `${D}T06:40+00:00`, text: LATE }]);
    const on = await pages("window", window);
    expect(on.slice(1).flatMap((page) => page.lines.map((line: any) => line.text))).toEqual([AFTER]);
    expect(on.at(-1).next).toBeNull();
    const whole = await pages("window-whole", await opened("window-whole", { ref: makeRef("window", { ...key, day: D, at_ms: null }) }));
    const texts = whole.flatMap((page) => page.lines.map((line: any) => line.text));
    expect(texts.slice(0, 31)).toEqual([EARLY, ...LONG]);
    expect(texts.slice(31)).toEqual([EARLY, LATE, AFTER]);
    const day = await opened("window-day", { from: D, families: "screen" });
    const sittings = (await described("window-sittings", day.lines.map((line: any) => line.ref ?? line.cites[0]))).map((each) => each.opens.focus.replace(/@\d+-\d+$/u, ""));
    expect(sittings.every((focus) => focus.startsWith("u:"))).toBe(true);
    const [atMinute, first] = await described("window-described", [ref, makeRef("window", { ...key, day: D, at_ms: null })]);
    expect(atMinute).toEqual({ ref, kind: "window", day: D, at: window.at, app: window.app, title: window.title, opens: { page: "days", day: D, focus: `${sittings[1]}@${minute}-${minute + MINUTE}` } });
    expect(first.opens.focus).toBe(sittings[0]);
    expect(first.opens.focus, "a whole window names no minute").not.toMatch(/@\d+-\d+$/u);
    expect(window).not.toHaveProperty("focus");
    const gone = makeRef("window", { ...key, name: "No such window", day: D, at_ms: null });
    expect(await opened("window-gone", { ref: gone })).toMatchObject({ what: "gone", ref: gone });
  });
});
