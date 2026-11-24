import { describe, expect, it, vi } from "vitest";
import { AI_FAMILY, type LazyFrame } from "@lifestreamprotocol/families";
import { ANSWER_CHARS, type Call } from "./call.js";
import type { CountAsk, CountPlace } from "./counting.js";
import { sealed } from "./cursor-text.js";
import { describedOf, HIT_CHARS, READ_ROWS, readAnswerOf, type ReadSources, type ScreenSource } from "./read.js";
import type { Presence } from "./presence.js";
import { NAMING_FRAMES, NEAR_FRAMES, windowLinesOf, windowNearOf, windowReadOf, type WindowNamed } from "./screen-reads.js";
import { makeRef, readRef } from "./refs.js";
import { refused, Refusal } from "./refusal.js";
import { answerOf, describeParams, paramsOf, readParams, type Citation, type ReadAnswer, type RowAsk } from "./search-contract.js";
import type { RowOpened } from "./count.js";
import { rowsCounted, Work } from "./work.js";

const fakes = vi.hoisted(() => ({ row: undefined as ((call: Call) => RowOpened) | undefined, countAsk: undefined as ((asked: RowAsk) => CountAsk) | undefined }));
vi.mock("./count.js", async (original) => {
  const real = await original<typeof import("./count.js")>();
  return {
    ...real,
    openRow: (call: Call, ...rest: [never, never, never, never]) => (fakes.row === undefined ? real.openRow(call, ...rest) : fakes.row(call)),
    countAskOf: (asked: RowAsk, collections: never) => (fakes.countAsk === undefined ? real.countAskOf(asked, collections) : fakes.countAsk(asked)),
  };
});

const UTC = { zone: "UTC", day_start_hour: 0 };
const DAY = "2026-11-02";
const T0 = Date.parse(`${DAY}T08:00:00Z`);
const SOURCE = "claude:org-0001:cloud";
const CHAT = `${SOURCE}/00000000-0000-4000-8000-0000000000c1`;

type IndexFake = <T>(work: (read: never) => T) => T;

interface Sources extends Partial<Omit<ReadSources, "call" | "screen">> {
  view?: unknown;
  clock?: { zone: string; day_start_hour: number };
  networks?: unknown;
  index?: IndexFake;
  indexFile?: () => { file: string; factsBuild: string };
  screen?: ScreenSource;
  countAsk?: (asked: RowAsk) => CountAsk;
  row?: (call: Call) => RowOpened;
  where?: Presence;
  answerChars?: number;
}

function sourcesOf(over: Sources): Sources {
  return over;
}

function readSourcesOf(over: Sources): ReadSources {
  const { view, networks, index, indexFile, screen, countAsk, row, clock, where, answerChars, ...rest } = over;
  const file = indexFile ?? (() => ({ file: "file-1", factsBuild: "build-1" }));
  const call = {
    now_ms: T0 + 86_400_000, epoch: null, meter: new Work(READ_ROWS), families: [], networks: networks ?? { of: () => undefined, products: [] },
    answerChars: answerChars ?? ANSWER_CHARS.person,
    view: () => view, clock: () => clock ?? UTC, whereIfReady: () => where, labels: () => ({}), chat: (asked: string) => asked,
    index: () => ({
      clock: UTC, seq: 0, held: (from: string, to: string) => ({ from, to, days: new Map() }),
      get file() {
        return file().file;
      },
      get factsBuild() {
        return file().factsBuild;
      },
      facts: <T>(work: (read: never) => T) => index!(work),
    }),
    fresh: () => ({ as_of: null, pending: [] }),
  } as unknown as Call;
  fakes.row = row;
  fakes.countAsk = countAsk;
  return { ...rest, call, screen: () => screen!, screenIfReady: () => screen } as ReadSources;
}

function call(sources: Sources, params: Record<string, string | string[]>): ReadAnswer {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) for (const each of [value].flat()) query.append(name, each);
  const answer = readAnswerOf(paramsOf(readParams, query), readSourcesOf(sources));
  const text = JSON.stringify(answer);
  expect(text.length).toBeLessThanOrEqual(ANSWER_CHARS.person);
  return answerOf("/v1/read", 200, JSON.parse(text)) as ReadAnswer;
}
function described(sources: Sources, refs: string[]): Citation[] {
  const query = new URLSearchParams(refs.map((ref): [string, string] => ["ref", ref]));
  const answer = describedOf(paramsOf(describeParams, query), readSourcesOf(sources));
  return (answerOf("/v1/describe", 200, JSON.parse(JSON.stringify(answer))) as { described: Citation[] }).described;
}
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Refusal) return error.code;
    throw error;
  }
  return "answered";
}

type Line = { t_ms: number; text: string };

function framesOf(lines: readonly Line[], window: Pick<WindowNamed, "app" | "site" | "name">): LazyFrame[] {
  const times = [...new Set(lines.map((line) => line.t_ms))].sort((left, right) => left - right);
  return times.map((t) => ({
    t, app: window.app, title: window.name, site: window.site === "" ? null : window.site, display: "1", read: `v-${t}`,
    text: () => ({ lines: lines.filter((line) => line.t_ms === t).map((line) => line.text), ocr: [] }),
  }));
}

function framesScreen(frames: (window: Pick<WindowNamed, "app" | "site" | "name">) => LazyFrame[], segments: () => number[], file: () => string = () => "screen-1"): ScreenSource {
  return {
    get file() {
      return file();
    },
    clock: UTC, as_of: null, stretchLines: () => [], sources: { of: () => [], machines: () => [] }, segments,
    windowRead: (window: WindowNamed, from: number, to: number, near: readonly number[]) => windowReadOf(frames(window), window, from, to, near),
    windowNear: (window: WindowNamed, from: number, to: number, at: number | null) => windowNearOf(frames(window), window, from, to, at ?? from),
  } as unknown as ScreenSource;
}

const linesScreen = (lines: () => readonly Line[], segments: () => number[], file?: () => string): ScreenSource => framesScreen((window) => framesOf(lines(), window), segments, file);

describe("a chat's pages by place", () => {
  const turns = Array.from({ length: 450 }, (_, n) => ({ key: `t${n}`, at_ms: T0 + n * 1_000, role: "user", words: `turn ${n}`, attachments: [], images: 0, source: SOURCE }));
  const sources = sourcesOf({
    isAiChat: () => true, productName: () => "Assistant",
    view: {
      extractReadings: (family: string) => (family === AI_FAMILY ? [{ unit: `${CHAT}/${DAY}` }] : []),
      extract: () => ({ content: { provider: "claude", title: "A chat", turns: [...turns].sort((left, right) => left.at_ms - right.at_ms) } }),
    },
  });
  const keysOf = (answer: ReadAnswer) => (answer as Extract<ReadAnswer, { what: "chat" }>).lines.map((line) => readRef(line.ref!, "ref", ["record"]).parts.key);

  it("a turn inserted before its place and one erased past it between two pages: each turn of the chat once, none passed over", () => {
    const first = call(sources, { chat: makeRef("chat", { key: CHAT }), from: DAY, to: DAY }) as Extract<ReadAnswer, { what: "chat" }>;
    const given = first.lines.length;
    expect(given).toBeGreaterThan(0);
    expect(given).toBeLessThan(450);
    const gone = `t${given + 20}`;
    turns.push({ key: "early", at_ms: T0 - 5_000, role: "user", words: "early", attachments: [], images: 0, source: SOURCE });
    turns.splice(turns.findIndex((turn) => turn.key === gone), 1);
    const keys = keysOf(first);
    for (let page = first, n = 0; page.next && n < 10; n++) {
      page = call(sources, { cursor: page.next }) as Extract<ReadAnswer, { what: "chat" }>;
      keys.push(...keysOf(page));
    }
    expect(keys).toEqual(Array.from({ length: 450 }, (_, n) => `t${n}`).filter((key) => key !== gone));
  });

  it("a chat's cursor is bound to the index file it walks: after the index was built again, CURSOR_EXPIRED", () => {
    let file = "file-1";
    const bound = sourcesOf({ ...sources, indexFile: () => ({ file, factsBuild: "build-1" }) });
    const first = call(bound, { chat: makeRef("chat", { key: CHAT }), from: DAY, to: DAY }) as Extract<ReadAnswer, { what: "chat" }>;
    expect(first.next).toEqual(expect.any(String));
    expect(refusal(() => call(bound, { cursor: first.next! }))).toBe("answered");
    file = "file-2";
    expect(refusal(() => call(bound, { cursor: first.next! }))).toBe("CURSOR_EXPIRED");
  });
});

function indexOf(atoms: { n: number; item: string; start_ms: number; same?: string }[]): IndexFake {
  return (work) => work({
    walk: (sql: string, params: unknown[], limit: number) => {
      const all = sql.includes("FROM days")
        ? [{ day: DAY, inputs: "in-1" }].filter(({ day }) => (sql.includes("day >= ?") ? day >= String(params[0]) : day > String(params[0])) && day <= String(params[1]))
        : atoms.filter((atom) => params[0] === DAY && atom.n >= Number(params[1])).sort((left, right) => left.n - right.n).map((atom) => ({
          day: DAY, n: atom.n, family: "notes", unit: `notes/${DAY}`, item: null, source: "notes:local:mac-0001", kind: "item", key: atom.item,
          start_ms: atom.start_ms, end_ms: null, dated: 0, line: `line ${atom.item}`, title: "", pictures: null, same: atom.same ?? `same-${atom.item}`,
        }));
      return { rows: all.slice(0, limit), more: all.length > limit };
    },
  } as never);
}

describe("a stretch's pages by place", () => {
  it("lines rendered again between two pages, one inserted before its place and one erased past it: each line once; another index file, CURSOR_EXPIRED", () => {
    let atoms = Array.from({ length: 450 }, (_, n) => ({ n, item: `i${n}`, start_ms: T0 + n * 1_000 }));
    let file = "file-1";
    const sources = sourcesOf({ index: (work) => indexOf(atoms)(work), indexFile: () => ({ file, factsBuild: "build-1" }) });
    const first = call(sources, { from: DAY, to: DAY, detail: "lines" }) as Extract<ReadAnswer, { what: "lines" }>;
    const given = first.lines.length;
    expect(given).toBeGreaterThan(0);
    expect(given).toBeLessThan(450);
    const gone = `i${given + 20}`;
    atoms = [{ n: 0, item: "early", start_ms: T0 - 5_000 }, ...atoms.filter((atom) => atom.item !== gone).map((atom, at) => ({ ...atom, n: at + 1 }))];
    const keyOf = (line: { ref?: string }) => readRef(line.ref!, "ref", ["record"]).parts.key;
    const second = call(sources, { cursor: first.next! }) as Extract<ReadAnswer, { what: "lines" }>;
    const items = first.lines.map(keyOf);
    for (let page = second, n = 0; ; n++) {
      items.push(...page.lines.map(keyOf));
      if (!page.next || n > 10) break;
      page = call(sources, { cursor: page.next }) as Extract<ReadAnswer, { what: "lines" }>;
    }
    expect(items).toEqual(Array.from({ length: 450 }, (_, n) => `i${n}`).filter((item) => item !== gone));
    atoms = atoms.filter((atom) => atom.item !== `i${given - 1}`);
    const again = call(sources, { cursor: first.next! }) as Extract<ReadAnswer, { what: "lines" }>;
    expect(again.lines.map(keyOf)).toEqual(second.lines.map(keyOf));
    file = "file-2";
    expect(refusal(() => call(sources, { cursor: first.next! }))).toBe("CURSOR_EXPIRED");
  });

  it("atoms the same as each other on one day (one `same`): a page goes on after the one it gave by how many came before it, each once", () => {
    const atoms = Array.from({ length: 450 }, (_, n) => ({ n, item: `i${n}`, start_ms: T0, same: "one-same" }));
    const sources = sourcesOf({ index: (work) => indexOf(atoms)(work) });
    const keyOf = (line: { ref?: string }) => readRef(line.ref!, "ref", ["record"]).parts.key;
    const items: string[] = [];
    let page = call(sources, { from: DAY, to: DAY, detail: "lines" }) as Extract<ReadAnswer, { what: "lines" }>;
    for (let n = 0; ; n++) {
      items.push(...page.lines.map(keyOf));
      if (!page.next || n > 10) break;
      page = call(sources, { cursor: page.next }) as Extract<ReadAnswer, { what: "lines" }>;
    }
    expect(items).toEqual(atoms.map((atom) => atom.item));
  });
});

describe("a window's pages by place", () => {
  it("a line inserted before its place and one erased past it between two pages: each line once; another screen file, CURSOR_EXPIRED", () => {
    let lines = Array.from({ length: 60 }, (_, n) => ({ t_ms: T0 + n * 1_000, text: `line ${n} ${"x".repeat(1_200)}` }));
    let file = "screen-1";
    const screen = linesScreen(() => lines, () => [T0 - 60_000], () => file);
    const sources = sourcesOf({ screen, view: { extractPage: () => [] } });
    const ref = makeRef("window", { machine: "macbook-pro-0001", day: DAY, app: "Example Browser", site: "", name: "Example page", at_ms: null });
    const first = call(sources, { ref }) as Extract<ReadAnswer, { what: "window" }>;
    expect(first.lines.length).toBeLessThan(60);
    const given = first.lines.length;
    lines = [{ t_ms: T0 - 1, text: "inserted before" }, ...lines.filter((_, n) => n !== given + 3)];
    const second = call(sources, { cursor: first.next! }) as Extract<ReadAnswer, { what: "window" }>;
    const read = [...first.lines, ...second.lines].map((line) => line.text.split(" ").slice(0, 2).join(" "));
    const kept = Array.from({ length: 60 }, (_, n) => `line ${n}`).filter((_, n) => n !== given + 3);
    expect(read).toEqual([...kept.slice(0, given), "inserted before", ...kept.slice(given)].slice(0, read.length));
    expect(new Set(read).size).toBe(read.length);
    file = "screen-2";
    expect(refusal(() => call(sources, { cursor: first.next! }))).toBe("CURSOR_EXPIRED");
  });
});

function recordSources(size: number, versions = 0): { sources: Sources; ref: string; text: string } {
  const text = Array.from({ length: size }, (_, n) => String.fromCharCode(97 + (n % 26))).join("");
  const record = { source: "notes:local:mac-0001", kind: "item", key: "big" };
  const sources = sourcesOf({
    view: {
      head: () => ({ version: "v1", start_ms: T0, stated_ms: T0 }), source: () => undefined, blobsOf: () => [],
      history: () => Array.from({ length: versions }, (_, n) => ({ seq: n + 1, version: `v${n}`, stated_ms: T0 + n })),
    },
    networks: { of: () => undefined },
    aiChatOf: () => undefined, name: (id) => id,
    recordOf: () => ({ family: "notes", read: { text }, product: undefined, dated: false }),
  });
  return { sources, ref: makeRef("record", record), text };
}

describe("one answer budget", () => {
  it("a record's words larger than the page: the answer within its bound, its pages giving every character once", () => {
    const { sources, ref, text } = recordSources(150_000);
    let page = call(sources, { ref }) as Extract<ReadAnswer, { what: "record" }>;
    let read = page.text;
    for (let n = 0; page.next !== undefined && page.next !== null && n < 10; n++) {
      page = call(sources, { cursor: page.next }) as Extract<ReadAnswer, { what: "record" }>;
      read += page.text;
    }
    expect(read).toBe(text);
  });

  it("a record's cursor is bound to the version whose words it cuts: a new version since, CURSOR_EXPIRED", () => {
    const { sources, ref } = recordSources(150_000);
    const first = call(sources, { ref }) as Extract<ReadAnswer, { what: "record" }>;
    expect(first.next).toEqual(expect.any(String));
    expect(refusal(() => call(sources, { cursor: first.next! }))).toBe("answered");
    const view = sources.view as { head: () => { version: string } };
    const head = view.head;
    view.head = () => ({ ...head(), version: "v2" });
    expect(refusal(() => call(sources, { cursor: first.next! }))).toBe("CURSOR_EXPIRED");
  });

  it("a record's versions past the page: given on the pages after its words, each once", () => {
    const { sources, ref } = recordSources(30_000, 6);
    const pages: Extract<ReadAnswer, { what: "record" }>[] = [call(sources, { ref, history: "1" }) as Extract<ReadAnswer, { what: "record" }>];
    while (pages.at(-1)!.next) pages.push(call(sources, { cursor: pages.at(-1)!.next! }) as Extract<ReadAnswer, { what: "record" }>);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((each) => each.history ?? [])).toHaveLength(6);
  });

  it("several refs: one meter for the call; a ref its rows cannot hold and those after it are named unopened, and no cursor is written", () => {
    const refs = ["a", "b", "c"].map((key) => makeRef("row", { ask: { of: "calls", match: { outcome: key } }, kept: {}, scope: { t: null }, n: 1 }));
    const sources = sourcesOf({
      countAsk: (asked) => ({ of: asked.of!, by: [], person: [], match: {}, op: "count", limit: 50 }) as never,
      row: (on) => {
        if (!on.meter.inner(Infinity).made(50_000)) refused("TOO_BROAD", "this asks more of the record's index than one call reads");
        return { answer: { asked: { is: "plain", value: "calls" }, columns: ["n", "ref"], rows: [], next: null } } as never;
      },
    });
    const before = rowsCounted();
    const first = call(sources, { ref: refs }) as Extract<ReadAnswer, { what: "refs" }>;
    expect(rowsCounted() - before).toBeLessThanOrEqual(READ_ROWS);
    expect(first.opened.map((each) => (each as { ref: string }).ref)).toEqual(refs.slice(0, 2));
    expect(first.unopened).toEqual(refs.slice(2));
    expect(Object.hasOwn(first, "next")).toBe(false);
    const second = call(sources, { ref: first.unopened![0]! }) as Extract<ReadAnswer, { what: "row" }>;
    expect(second.ref).toBe(refs[2]);
  });

  it("several refs whose words pass the page: the answer within its bound, every ref's words given whole, each `next` alone", () => {
    const { sources, ref, text } = recordSources(40_000);
    let refs = [ref, ref, ref];
    const texts: string[] = [];
    const follow = (one: Extract<ReadAnswer, { what: "record" }>) => {
      let words = one.text;
      for (let page = one; page.next; ) {
        page = call(sources, { cursor: page.next }) as Extract<ReadAnswer, { what: "record" }>;
        words += page.text;
      }
      texts.push(words);
    };
    for (let n = 0; n < 5 && refs.length > 0; n++) {
      const answer = refs.length === 1 ? { opened: [call(sources, { ref: refs[0]! })], unopened: undefined } : call(sources, { ref: refs }) as Extract<ReadAnswer, { what: "refs" }>;
      for (const one of answer.opened) follow(one as Extract<ReadAnswer, { what: "record" }>);
      refs = answer.unopened ?? [];
    }
    expect(texts).toEqual([text, text, text]);
  });
});

describe("a row's cursor", () => {
  it("is bound to the facts layer's build: built again, CURSOR_EXPIRED; given with another call's arguments, BAD_PARAMETER", () => {
    let build = "build-1";
    const place: CountPlace = { after: { unit: "calls/c2", p: null, fact: "calls:c2", t: T0, d: DAY, v: null } };
    const sources = sourcesOf({
      indexFile: () => ({ file: "file-1", factsBuild: build }),
      countAsk: (asked) => ({ of: asked.of!, by: [], person: [], match: {}, op: "count", limit: 2 }) as never,
      row: () => ({ answer: { asked: { is: "plain", value: "calls" }, columns: ["time", "ref"], rows: [[{ is: "plain", value: DAY }, { is: "ref", value: "record.x" }]], next: { is: "ref", value: "x" }, place, places: [place] } }) as never,
    });
    const ref = makeRef("row", { ask: { of: "calls" }, kept: {}, scope: {}, n: 3 });
    const first = call(sources, { ref }) as Extract<ReadAnswer, { what: "row" }>;
    expect(first.next).toEqual(expect.any(String));
    expect(refusal(() => call(sources, { cursor: first.next! }))).toBe("answered");
    expect(refusal(() => call(sources, { cursor: first.next!, ref }))).toBe("answered");
    expect(refusal(() => call(sources, { cursor: first.next!, ref: makeRef("row", { ask: { of: "messages" }, kept: {}, scope: {}, n: 3 }) }))).toBe("BAD_PARAMETER");
    build = "build-2";
    expect(refusal(() => call(sources, { cursor: first.next! }))).toBe("CURSOR_EXPIRED");
  });

  it("refuses a `next` of another route", () => {
    const sources = sourcesOf({});
    for (const route of ["record", "count", "people"] as const) {
      expect(refusal(() => call(sources, { cursor: sealed(route, [1], route === "people" ? { name: "x" } : { of: "calls" }, {}) }))).toBe("BAD_PARAMETER");
    }
  });
});

describe("a window's lines and its next (R6)", () => {
  const opened: string[] = [];
  const frame = (t: number, app: string, title: string | null, lines: string[], site: string | null = null): LazyFrame => ({
    t, app, title, site, display: "1", read: `v-${t}`,
    text: () => {
      opened.push(`${app}/${title ?? ""}@${(t - T0) / 1_000}`);
      return { lines, ocr: [] };
    },
  });

  it("every line its frames showed, each once by its exact words: two lines sharing their first 60 characters are both there", () => {
    const prefix = "A synthetic itinerary line that runs long enough to share its first sixty chars";
    expect(prefix.length).toBeGreaterThan(60);
    const frames = [
      frame(T0, "Example Editor", "Notes", [`${prefix} ferry`]),
      frame(T0 + 60_000, "Example Editor", "Notes", [`${prefix} lighthouse`, `${prefix} ferry`]),
    ];
    expect(windowLinesOf(frames, { app: "Example Editor", site: "", name: "Notes" }, T0, T0 + 120_000).map((line) => line.text)).toEqual([`${prefix} ferry`, `${prefix} lighthouse`]);
  });

  it("opens the text of the window's own frames only: another app's, another title's, and an untitled frame of another app stay unread", () => {
    const frames = [
      frame(T0, "Example Editor", "Notes", ["A synthetic note line"]),
      frame(T0 + 2_000, "Example Browser", "Example Page", ["A synthetic page line"], "www.example.com"),
      frame(T0 + 4_000, "WhatsApp", null, ["[Button] Start video call with Person A"]),
      frame(T0 + 6_000, "Example Editor", "Other notes", ["Another synthetic note"]),
      frame(T0 + 8_000, "Example Editor", "Notes", ["A later synthetic note line"]),
      frame(T0 + 120_000, "Example Editor", "Notes", ["A note past the read's end"]),
    ];
    opened.length = 0;
    expect(windowLinesOf(frames, { app: "Example Editor", site: "", name: "Notes" }, T0, T0 + 60_000).map((line) => line.text))
      .toEqual(["A synthetic note line", "A later synthetic note line"]);
    expect(opened).toEqual(["Example Editor/Notes@0", "Example Editor/Notes@8"]);
  });

  it("reads an untitled frame's lines only when its app is named by them", () => {
    const frames = [
      frame(T0, "WhatsApp", null, ["[Button] Start video call with Person A", "A synthetic chat line"]),
      frame(T0 + 2_000, "WhatsApp", null, ["[Button] Start video call with Person C", "Another synthetic chat line"]),
      frame(T0 + 4_000, "Example Editor", null, ["An untitled editor line"]),
      frame(T0 + 6_000, "WhatsApp", "WhatsApp", ["[Button] Start video call with Person A", "A later synthetic chat line"]),
    ];
    opened.length = 0;
    expect(windowLinesOf(frames, { app: "WhatsApp", site: "", name: "Person A" }, T0, T0 + 60_000).map((line) => line.text))
      .toEqual(["Start video call with Person A", "A synthetic chat line", "A later synthetic chat line"]);
    expect([...new Set(opened)]).toEqual(["WhatsApp/@0", "WhatsApp/@2", "WhatsApp/WhatsApp@6"]);
  });

  it("goes on at the read's end while a row of the window reaches past it: a line at 06:58 in a window read 06:27 to 06:57 is reached", () => {
    const at = (hh: number, mm: number) => Date.parse(`${DAY}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
    const shown = [{ t_ms: at(6, 42), text: "synthetic line at the minute" }, { t_ms: at(6, 58), text: "synthetic line in the row's tail" }];
    const screen = linesScreen(() => shown, () => [at(6, 40), at(6, 55)]);
    const sources = sourcesOf({ screen, view: { extractPage: () => [] } });
    const ref = makeRef("window", { machine: "macbook-pro-0001", day: DAY, app: "Example Browser", site: "", name: "Example page", at_ms: at(6, 42) });
    const read: string[] = [];
    let page = call(sources, { ref }) as Extract<ReadAnswer, { what: "window" }>;
    for (let n = 0; ; n++) {
      read.push(...page.lines.map((line) => line.text));
      if (page.next === null || page.next === undefined || n > 5) break;
      page = call(sources, { cursor: page.next }) as Extract<ReadAnswer, { what: "window" }>;
    }
    expect(read).toEqual(shown.map((line) => line.text));
  });

  it("is described opening Days in the sitting that holds its minute, from home.db's sittings of its machine, its focus ranged to that minute; read says it no more", () => {
    const screen = {
      ...linesScreen(() => [{ t_ms: T0, text: "synthetic" }], () => [T0]),
      sources: { of: (machine: string) => (machine === "macbook-pro-0001" ? ["screen:local:macbook-pro-0001"] : []), machines: () => ["macbook-pro-0001"] },
    } as unknown as ScreenSource;
    const sittings = [{ unit: `other-mac-aa43/${T0 - 600_000}`, start_ms: T0 - 600_000, end_ms: T0 + 600_000 }, { unit: `macbook-pro-0001/${T0 - 600_000}`, start_ms: T0 - 600_000, end_ms: T0 + 600_000 }];
    const sources = sourcesOf({ screen, view: { extractPage: () => sittings, enrichment: () => undefined } });
    const ref = makeRef("window", { machine: "macbook-pro-0001", day: DAY, app: "Example Browser", site: "", name: "Example page", at_ms: T0 });
    expect(call(sources, { ref })).not.toHaveProperty("focus");
    expect(described(sources, [ref])).toEqual([{
      ref, kind: "window", day: DAY, at: `${DAY}T08:00+00:00`, app: "Example Browser", title: "Example page",
      opens: { page: "days", day: DAY, focus: `u:macbook-pro-0001/${T0 - 600_000}@${T0}-${T0 + 60_000}` },
    }]);
    const none = { ...screen, segments: () => [] } as unknown as ScreenSource;
    expect(described(sourcesOf({ screen: none, view: { extractPage: () => sittings, enrichment: () => undefined } }), [ref])).toEqual([{ ref, kind: "gone", why: expect.stringContaining("no such window") }]);
  });

  it("one moment abroad: a window's minute and its lines where the person was, as a record's; its day the screen file's", () => {
    const screen = linesScreen(() => [{ t_ms: T0, text: "synthetic" }], () => [T0]);
    const abroad = { zoneAt: () => "Asia/Kolkata", pieceAt: () => undefined, placedOn: () => [] } as unknown as Presence;
    const ref = makeRef("window", { machine: "macbook-pro-0001", day: DAY, app: "Example Browser", site: "", name: "Example page", at_ms: T0 });
    const opened = call(sourcesOf({ screen, view: { extractPage: () => [] }, where: abroad }), { ref }) as Extract<ReadAnswer, { what: "window" }>;
    expect([opened.day, opened.at, opened.lines[0]!.at]).toEqual([DAY, "2026-11-02T13:30+05:30", "2026-11-02T13:30+05:30"]);
    expect(described(sourcesOf({ screen, view: { extractPage: () => [] }, where: abroad }), [ref])[0]).toMatchObject({ day: DAY, at: "2026-11-02T13:30+05:30" });
  });
});

describe("a window opened from a search hit", () => {
  const at = (minutes: number, seconds = 0) => T0 + minutes * 60_000 + seconds * 1_000;
  const menu = Array.from({ length: 40 }, (_, n) => ({ t_ms: at(-10), text: `File Edit Format View Window synthetic menu ${n}` }));
  const sets = Array.from({ length: 12 }, (_, n) => ({ t_ms: at(0), text: `synthetic set ${n}: 3 x 5 at ${40 + n} kg` }));
  const later = Array.from({ length: 30 }, (_, n) => ({ t_ms: at(5, n), text: `a later synthetic line ${n} in the same window` }));
  const past = [{ t_ms: at(40), text: "a synthetic line past the stretch" }];
  const shown = [...menu, ...sets, ...later, ...past];
  const segments = () => [at(-10), at(-5), at(0), at(5), at(40)];
  const screen = linesScreen(() => shown, segments);
  const windowRef = (name: string, app = "Example Notes", at_ms: number | null = at(0)) => makeRef("window", { machine: "macbook-pro-0001", day: DAY, app, site: "", name, at_ms });
  const linesSize = (lines: readonly unknown[]) => lines.reduce<number>((sum, line) => sum + JSON.stringify(line).length + 1, 0);
  const allPages = (sources: Sources, first: Extract<ReadAnswer, { what: "window" }>) => {
    const pages = [first];
    for (let n = 0; pages.at(-1)!.next && n < 20; n++) pages.push(call(sources, { cursor: pages.at(-1)!.next! }) as Extract<ReadAnswer, { what: "window" }>);
    expect(pages.at(-1)!.next).toBeNull();
    return pages;
  };

  it("opens as one unbroken run of what the window's frames nearest its minute showed, grown out from its minute within HIT_CHARS; next reads the rest of the half hour, then the stretches after, each line once", () => {
    const sources = sourcesOf({ screen, view: { extractPage: () => [] } });
    const first = call(sources, { ref: windowRef("Training log") }) as Extract<ReadAnswer, { what: "window" }>;
    const texts = first.lines.map((line) => line.text);
    expect(linesSize(first.lines)).toBeLessThanOrEqual(HIT_CHARS);
    expect(texts).toEqual([...sets, ...later.slice(0, NEAR_FRAMES - 1)].map((line) => line.text));
    expect(first.next).toEqual(expect.any(String));
    const pages = allPages(sources, first);
    const read = pages.flatMap((page) => page.lines.map((line) => line.text));
    expect(new Set(read).size).toBe(read.length);
    expect([...read].sort()).toEqual(shown.map((line) => line.text).sort());
    expect(pages[1]!.lines.map((line) => line.text)).toEqual([...menu, ...later.slice(NEAR_FRAMES - 1)].map((line) => line.text));
    expect(pages.at(-1)!.lines.map((line) => line.text)).toEqual(past.map((line) => line.text));
  });

  it("lines that land or go between two pages move nothing: what lies outside the first page's run is read once, and nothing the first page gave comes again", () => {
    const held = [...menu, ...sets, ...later, ...past];
    const sources = sourcesOf({ screen: linesScreen(() => held, segments), view: { extractPage: () => [] } });
    const first = call(sources, { ref: windowRef("Training log") }) as Extract<ReadAnswer, { what: "window" }>;
    expect(first.lines.map((line) => line.text).slice(0, sets.length)).toEqual(sets.map((line) => line.text));
    held.push({ t_ms: at(-12), text: "a synthetic line that landed before the run" }, { t_ms: at(12), text: "a synthetic line that landed after the run" });
    held.splice(held.indexOf(later.at(-1)!), 1);
    held.splice(held.indexOf(menu[0]!), 1);
    const pages = allPages(sources, first);
    const read = pages.flatMap((page) => page.lines.map((line) => line.text));
    expect(new Set(read).size).toBe(read.length);
    expect([...read].sort()).toEqual(held.map((line) => line.text).sort());
    expect(pages[1]!.lines[0]!.text).toBe("a synthetic line that landed before the run");
  });

  it("a run whose first line is past the room is cut there, and the next page gives the rest of it before the lines outside the run", () => {
    const long = "a synthetic long line ".repeat(3_500).trimEnd();
    const lines = [{ t_ms: at(-5), text: "a synthetic line before the long one" }, { t_ms: at(0), text: long }, { t_ms: at(3), text: "a synthetic line after the long one" }];
    const sources = sourcesOf({ screen: linesScreen(() => lines, () => [at(-5), at(0)]), view: { extractPage: () => [] } });
    const first = call(sources, { ref: windowRef("Long note") }) as Extract<ReadAnswer, { what: "window" }>;
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]!.text.length).toBeLessThan(long.length);
    const second = call(sources, { cursor: first.next! }) as Extract<ReadAnswer, { what: "window" }>;
    expect(first.lines[0]!.text + second.lines[0]!.text).toBe(long);
    expect(second.lines.slice(1).map((line) => line.text)).toEqual([lines[0]!.text, lines[2]!.text]);
    expect(second.next).toBeNull();
  });

  it("a ref that names no minute opens at its first row under the same first page, and next goes on from there", () => {
    const sources = sourcesOf({ screen, view: { extractPage: () => [] } });
    const first = call(sources, { ref: windowRef("Training log", "Example Notes", null) }) as Extract<ReadAnswer, { what: "window" }>;
    expect(linesSize(first.lines)).toBeLessThanOrEqual(HIT_CHARS);
    expect(first.lines.map((line) => line.text)).toEqual(menu.slice(0, first.lines.length).map((line) => line.text));
    const second = call(sources, { cursor: first.next! }) as Extract<ReadAnswer, { what: "window" }>;
    expect(second.lines[0]!.text).toBe(menu[first.lines.length]!.text);
  });

  it("a record and four windows from hits open in one model answer: none unopened, each window with its next", () => {
    const { sources: record, ref } = recordSources(4_000);
    const sources = sourcesOf({ ...record, screen, view: { ...(record.view as object), extractPage: () => [] }, answerChars: ANSWER_CHARS.model });
    const windows = [1, 2, 3, 4].map((n) => windowRef(`Training log ${n}`));
    const answer = call(sources, { ref: [ref, ...windows] }) as Extract<ReadAnswer, { what: "refs" }>;
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(ANSWER_CHARS.model);
    expect(answer.unopened).toBeUndefined();
    expect(answer.opened.map((one) => (one as { ref: string }).ref)).toEqual([ref, ...windows]);
    expect(answer.opened[0]).toMatchObject({ what: "record" });
    for (const one of answer.opened.slice(1) as Extract<ReadAnswer, { what: "window" }>[]) {
      expect(one.lines.map((line) => line.text).slice(0, sets.length)).toEqual(sets.map((line) => line.text));
      expect(one.next).toEqual(expect.any(String));
    }
  });

  describe("a window on screen the whole half hour", () => {
    const EVERY = 6_000;
    const from = at(-15);
    const segmentsOf = () => [0, 5, 10, 15, 20, 25].map((minutes) => from + minutes * 60_000);
    const sidebar = Array.from({ length: 30 }, (_, n) => `synthetic sidebar entry ${n}, a thread title long enough to be kept`);
    const content = (n: number) => `synthetic content line ${n}: ${"words of a long synthetic document paragraph ".repeat(4)}${n}`;
    const editorLines = (n: number) => [...sidebar, ...Array.from({ length: 20 }, (_, k) => content(n + k))];
    const opened: number[] = [];
    const lazy = (t: number, app: string, title: string | null, n: number, lines: () => string[]): LazyFrame => {
      let held: { lines: string[]; ocr: string[] } | undefined;
      return { t, app, title, site: null, display: "1", read: `v-${app}-${n}`, text: () => (held ??= (opened.push(n), { lines: lines(), ocr: [] })) };
    };

    it("300 frames of large text: opening it from a hit parses the NEAR_FRAMES frames nearest the minute, its page is what they showed around it, and next reads every line of the half hour once", () => {
      const editor = () => Array.from({ length: 300 }, (_, n) => [
        lazy(from + n * EVERY, "Example Editor", "Training log", n, () => editorLines(n)),
        lazy(from + n * EVERY + EVERY / 2, "Example Browser", "Example page", -1, () => ["a synthetic page line"]),
      ]).flat();
      const sources = sourcesOf({ screen: framesScreen(editor, segmentsOf), view: { extractPage: () => [] } });
      opened.length = 0;
      const first = call(sources, { ref: windowRef("Training log", "Example Editor") }) as Extract<ReadAnswer, { what: "window" }>;
      expect([...opened].sort((left, right) => left - right)).toEqual([148, 149, 150, 151, 152]);
      expect(opened).toHaveLength(NEAR_FRAMES);
      const texts = first.lines.map((line) => line.text);
      expect(linesSize(first.lines)).toBeLessThanOrEqual(HIT_CHARS);
      expect(texts.slice(-4)).toEqual([168, 169, 170, 171].map(content));
      expect(texts.length).toBeGreaterThan(4);
      const near = new Set([148, 149, 150, 151, 152].flatMap(editorLines));
      expect(texts.every((text) => near.has(text))).toBe(true);
      const read = allPages(sources, first).flatMap((page) => page.lines.map((line) => line.text));
      expect(new Set(read).size).toBe(read.length);
      expect([...read].sort()).toEqual([...sidebar, ...Array.from({ length: 319 }, (_, n) => content(n))].sort());
    });

    it("an untitled window its app names by its lines, two of them taking turns: opened from its minute or from its first row, it parses NEAR_FRAMES of its own frames and the others' it named between them, and next reads its own lines once", () => {
      const session = (n: number) => (n % 2 === 0 ? "Session A" : "Session B");
      const turns = () => Array.from({ length: 200 }, (_, n) => lazy(at(-5) + n * 3_000, "Claude", null, n, () => [`[Button] ${session(n)}, rename session`, `synthetic chat line ${n} of ${session(n)}`]));
      const sources = sourcesOf({ screen: framesScreen(turns, segmentsOf), view: { extractPage: () => [] } });
      opened.length = 0;
      const first = call(sources, { ref: windowRef("Session A", "Claude") }) as Extract<ReadAnswer, { what: "window" }>;
      expect([...opened].sort((left, right) => left - right)).toEqual([96, 97, 98, 99, 100, 101, 102, 103, 104]);
      expect(first.lines.map((line) => line.text)).toEqual(["Session A, rename session", ...[96, 98, 100, 102, 104].map((n) => `synthetic chat line ${n} of Session A`)]);
      const read = allPages(sources, first).flatMap((page) => page.lines.map((line) => line.text));
      expect(new Set(read).size).toBe(read.length);
      expect([...read].sort()).toEqual(["Session A, rename session", ...Array.from({ length: 100 }, (_, n) => `synthetic chat line ${2 * n} of Session A`)].sort());
      opened.length = 0;
      call(sources, { ref: windowRef("Session A", "Claude", null) });
      expect([...opened].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });

    const chatLine = (name: string, n: number) => `synthetic chat line ${n} of ${name}`;
    const chatFrame = (t: number, name: string, n: number) => lazy(t, "Claude", null, n, () => [`[Button] ${name}, rename session`, chatLine(name, n)]);
    const ownLines = (frames: readonly LazyFrame[], name: string) => [`${name}, rename session`, ...frames.filter((frame) => frame.text().lines[1]!.endsWith(name)).map((frame) => frame.text().lines[1]!)];

    it("a ref with no minute whose first segment opens with more than NEAR_FRAMES frames of another window of its app: its first page is its own lines, and next reads each of them once", () => {
      const frames = [
        ...Array.from({ length: NEAR_FRAMES + 3 }, (_, n) => chatFrame(at(-5) + n * 3_000, "Session B", n)),
        ...Array.from({ length: 40 }, (_, n) => chatFrame(at(-5) + (NEAR_FRAMES + 3 + n) * 3_000, "Session A", NEAR_FRAMES + 3 + n)),
      ];
      const sources = sourcesOf({ screen: framesScreen(() => frames, () => [at(-5)]), view: { extractPage: () => [] } });
      opened.length = 0;
      const first = call(sources, { ref: windowRef("Session A", "Claude", null) }) as Extract<ReadAnswer, { what: "window" }>;
      expect(opened.length).toBeLessThanOrEqual(NEAR_FRAMES + NAMING_FRAMES);
      expect(first.lines.map((line) => line.text)).toEqual(["Session A, rename session", ...[8, 9, 10, 11, 12].map((n) => chatLine("Session A", n))]);
      const read = allPages(sources, first).flatMap((page) => page.lines.map((line) => line.text));
      expect(new Set(read).size).toBe(read.length);
      expect([...read].sort()).toEqual(ownLines(frames, "Session A").sort());
    });

    it("a hit's minute where another window of its app ships more than NEAR_FRAMES frames nearest it: its first page is its own lines around the minute, and next reads each of them once", () => {
      const frames = [
        ...Array.from({ length: NEAR_FRAMES + 1 }, (_, n) => chatFrame(at(0) + (n - 3) * 1_000, "Session B", n)),
        ...Array.from({ length: 60 }, (_, n) => chatFrame(at(-5) + n * 10_000 + 500, "Session A", 100 + n)),
      ];
      const sources = sourcesOf({ screen: framesScreen(() => frames, () => [at(-5), at(0)]), view: { extractPage: () => [] } });
      opened.length = 0;
      const first = call(sources, { ref: windowRef("Session A", "Claude") }) as Extract<ReadAnswer, { what: "window" }>;
      expect(opened.length).toBeLessThanOrEqual(NEAR_FRAMES + NAMING_FRAMES);
      expect(first.lines.map((line) => line.text)).toEqual(["Session A, rename session", ...[128, 129, 130, 131, 132].map((n) => chatLine("Session A", n))]);
      const read = allPages(sources, first).flatMap((page) => page.lines.map((line) => line.text));
      expect(new Set(read).size).toBe(read.length);
      expect([...read].sort()).toEqual(ownLines(frames, "Session A").sort());
    });
  });

  it("a frame that lands between the first page's frames before the second page: its lines, and a line it shows again from outside the run, are each read once", () => {
    const held = [...menu, ...sets, ...later, ...past];
    const sources = sourcesOf({ screen: linesScreen(() => held, segments), view: { extractPage: () => [] } });
    const first = call(sources, { ref: windowRef("Training log") }) as Extract<ReadAnswer, { what: "window" }>;
    expect(first.lines.map((line) => line.text)).toEqual([...sets, ...later.slice(0, NEAR_FRAMES - 1)].map((line) => line.text));
    held.push({ t_ms: at(2), text: "a synthetic line that landed inside the run's frames" }, { t_ms: at(2), text: menu[0]!.text }, { t_ms: at(2), text: sets[0]!.text });
    const pages = allPages(sources, first);
    const read = pages.flatMap((page) => page.lines.map((line) => line.text));
    expect(new Set(read).size).toBe(read.length);
    expect([...read].sort()).toEqual([...new Set(held.map((line) => line.text))].sort());
    expect(pages[1]!.lines.map((line) => line.text)).toContain("a synthetic line that landed inside the run's frames");
  });
});

describe("a chat's span by instants (R6)", () => {
  const NIGHT = "2026-11-01";
  const start = Date.parse("2026-11-01T04:00:00Z");
  const turns = Array.from({ length: 12 }, (_, n) => ({ key: `n${n}`, at_ms: start + n * 30 * 60_000, role: "user", words: `night turn ${n}`, attachments: [], images: 0, source: SOURCE }));
  const sources = sourcesOf({
    isAiChat: () => true, productName: () => "Assistant", clock: { zone: "America/New_York", day_start_hour: 0 },
    view: {
      extractReadings: (family: string) => (family === AI_FAMILY ? [{ unit: `${CHAT}/${NIGHT}` }] : []),
      extract: () => ({ content: { provider: "claude", title: "A night chat", turns } }),
    },
  });
  const keysOf = (answer: ReadAnswer) => (answer as Extract<ReadAnswer, { what: "chat" }>).lines.map((line) => readRef(line.ref!, "ref", ["record"]).parts.key);

  it("holds the instants asked across the DST overlap: 01:30-04:00 to 01:30-05:00 is that one hour, never the civil day", () => {
    const hour = call(sources, { chat: makeRef("chat", { key: CHAT }), from: "2026-11-01T01:30:00-04:00", to: "2026-11-01T01:30:00-05:00" });
    expect(keysOf(hour)).toEqual(["n3", "n4"]);
  });

  it("an AI conversation read alone starts at its first turn", () => {
    const many = Array.from({ length: 450 }, (_, n) => ({ key: `t${n}`, at_ms: T0 + n * 1_000, role: "user", words: `turn ${n}`, attachments: [], images: 0, source: SOURCE }));
    const alone = sourcesOf({
      isAiChat: () => true, productName: () => "Assistant",
      view: { extractReadings: (family: string) => (family === AI_FAMILY ? [{ unit: `${CHAT}/${DAY}` }] : []), extract: () => ({ content: { provider: "claude", title: "A chat", turns: many } }) },
    });
    const first = call(alone, { chat: makeRef("chat", { key: CHAT }) }) as Extract<ReadAnswer, { what: "chat" }>;
    expect(keysOf(first)[0]).toBe("t0");
    expect(first.next).toEqual(expect.any(String));
  });
});

describe("a record as its family reads it (R6)", () => {
  it("states from and to only as its family states them; people with no direction as `who`, whatever their order", () => {
    const record = { source: "calendar:local:mac-0001", kind: "event", key: "e1" };
    const base = {
      view: { head: () => ({ version: "v1", start_ms: T0, stated_ms: T0 }), source: () => undefined, blobsOf: () => [], history: () => [] },
      networks: { of: () => undefined }, aiChatOf: () => undefined, name: (id: string) => `name of ${id}`,
    };
    const meeting = (who: string[]) => call(sourcesOf({ ...base, recordOf: () => ({ family: "calendar", read: { title: "Synthetic sync", text: "", who }, product: undefined, dated: false }) }), { ref: makeRef("record", record) });
    const one = meeting(["person-a@example.com", "person-b@example.com"]);
    const other = meeting(["person-b@example.com", "person-a@example.com"]);
    for (const answer of [one, other]) {
      expect(answer).not.toHaveProperty("from");
      expect(answer).not.toHaveProperty("to");
    }
    expect(new Set((one as Extract<ReadAnswer, { what: "record" }>).who)).toEqual(new Set(["name of person-a@example.com", "name of person-b@example.com"]));
    const mail = call(sourcesOf({ ...base, recordOf: () => ({ family: "mail", read: { text: "synthetic", from: null, to: ["person-b@example.com"] }, product: undefined, dated: false }) }), { ref: makeRef("record", record) });
    expect(mail).toMatchObject({ from: "You", to: ["name of person-b@example.com"] });
  });
});

describe("a row opened before the index has read a statement", () => {
  it("states no as_of, never one invented, and the contract takes it", () => {
    const ref = makeRef("row", { ask: { of: "messages", by: ["chat"] }, kept: {}, scope: { t: null }, n: 0 });
    const sources = sourcesOf({
      countAsk: () => ({ of: "messages", by: ["chat"], limit: 100 }) as never,
      row: () => ({ answer: { asked: { value: "messages by chat" }, columns: ["chat", "messages"], rows: [], next: null } }) as never,
    });
    const answer = call(sources, { ref });
    expect(answer).toMatchObject({ what: "row", ref, n: 0, rows: [] });
    expect(answer).not.toHaveProperty("as_of");
  });
});
