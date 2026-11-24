import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { canonical, openHomeFolder, type Json } from "@lifestreamprotocol/core";
import { afterEach, describe, expect, it } from "vitest";
import { ACCESS_CHANGED, CALL_ITEMS_KEPT, LAPSE_MS, reasonFault, SESSION_GAP_MS, type CallItem, type ChangeBy, type Scrub } from "./access-log.js";
import { openLedger, type Ledger } from "./ledger.js";
import type { NewOutbound } from "./outbound.js";

const T0 = Date.UTC(2026, 10, 13, 6, 0, 0);
const AGENT = "p-1a2b3c4d";
const OTHER = "p-5e6f7a8b";
const PHONE = "pass-phone-7";
const ACCOUNT = "whatsapp:+15550000001";
const MAIL = "gmail:person-a@example.com";
const CHAT = "chat-9";
const RECORD = { source: ACCOUNT, kind: "message", key: "msg-erased-1" };

function access(allow: Json[], items: Json[] = []): Json {
  return { allow, items, not: [], only: [], window: null, hide: "names", shown: [] };
}
const FULL = access([{ reach: { all: true, but: [] }, window: null, until_ms: null }]);
const NO_HEALTH = access([{ reach: { all: true, but: ["health", "money"] }, window: null, until_ms: null }]);
const person = (at_ms: number): ChangeBy => ({ at_ms, by: "person", device: PHONE });
const agent = (at_ms: number): ChangeBy & { by: "agent" } => ({ at_ms, by: "agent", device: AGENT });
const chat = (at_ms: number): ChangeBy => ({ at_ms, by: "chat", device: null });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ledgerAt(): { ledger: Ledger; path: string } {
  const root = mkdtempSync(join(tmpdir(), "model-access-"));
  roots.push(root);
  const path = join(root, "replies", "replies.db");
  return { ledger: openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" }), path };
}

function raw<T>(path: string, work: (db: Database.Database) => T): T {
  const db = new Database(path);
  try {
    return work(db);
  } finally {
    db.close();
  }
}

const TABLES = ["access", "access_changes", "access_requests", "access_moved", "calls", "call_withheld", "outbound_calls"];
function rows(path: string): Record<string, unknown[]> {
  return raw(path, (db) => Object.fromEntries(TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

function failing<T>(path: string, table: string, work: () => T): unknown {
  raw(path, (db) => db.exec(`CREATE TRIGGER failpoint BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'failpoint'); END`));
  try {
    work();
    return undefined;
  } catch (error) {
    return error;
  } finally {
    raw(path, (db) => db.exec("DROP TRIGGER failpoint"));
  }
}

function scrubOf(...erased: string[]): Scrub {
  const names = (value: Json) => erased.some((each) => canonical(value).includes(each));
  return {
    names,
    access(lines) {
      const of = lines as { allow: Json[]; items: Json[] };
      const allow = of.allow.filter((each) => !names(each));
      const items = of.items.filter((each) => !names(each));
      const went = of.allow.length - allow.length + of.items.length - items.length;
      return { lines: { ...(lines as Record<string, Json>), allow, items }, went: went === 0 ? null : { lines: went } };
    },
  };
}

describe("an access and its changes", () => {
  it("a fault between a change and its row leaves neither", () => {
    const { ledger, path } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [ACCOUNT] }, person(T0));
      const request = ledger.access.ask(AGENT, { from: 1, want: { read: { category: "health" } }, want_key: "sha256:want-health", reason: "to read your sleep", for_ms: 3_600_000 }, agent(T0 + 1));
      const before = rows(path);
      expect(failing(path, "access_changes", () => ledger.access.change(AGENT, { from: 1, what: "widened", lines: FULL, covers: [ACCOUNT] }, person(T0 + 2)))).toMatchObject({ message: "failpoint" });
      expect(failing(path, "access_changes", () => ledger.access.change(OTHER, { from: 0, what: "granted", lines: FULL, covers: [] }, person(T0 + 2)))).toMatchObject({ message: "failpoint" });
      expect(failing(path, "access_changes", () => ledger.access.answer(request.id, { from: 1, answer: "allowed", lines: FULL, covers: [ACCOUNT] }, person(T0 + 2)))).toMatchObject({ message: "failpoint" });
      expect(failing(path, "access_changes", () => ledger.access.ask(AGENT, { from: 1, want: { read: "everything" }, want_key: "sha256:want-all", reason: "more", for_ms: null }, agent(T0 + 2)))).toMatchObject({ message: "failpoint" });
      expect(failing(path, "access_changes", () => ledger.access.remove(AGENT, 1, person(T0 + 2)))).toMatchObject({ message: "failpoint" });
      expect(rows(path)).toEqual(before);
      expect(ledger.access.request(request.id, T0 + 2)).toMatchObject({ state: "open" });
    } finally {
      ledger.close();
    }
  });

  it("a write made from another version changes nothing and is refused", () => {
    const { ledger, path } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [] }, person(T0));
      ledger.access.change(AGENT, { from: 1, what: "narrowed", lines: access([]), covers: [] }, person(T0 + 1));
      const request = ledger.access.ask(AGENT, { from: 2, want: { read: "everything" }, want_key: "sha256:want-all", reason: "the whole record", for_ms: null }, agent(T0 + 2));
      const before = rows(path);
      const stale = [
        () => ledger.access.change(AGENT, { from: 1, what: "widened", lines: FULL, covers: [] }, person(T0 + 3)),
        () => ledger.access.change(AGENT, { from: 0, what: "granted", lines: FULL, covers: [] }, person(T0 + 3)),
        () => ledger.access.change(OTHER, { from: 1, what: "granted", lines: FULL, covers: [] }, person(T0 + 3)),
        () => ledger.access.remove(AGENT, 1, person(T0 + 3)),
        () => ledger.access.ask(AGENT, { from: 1, want: { read: "everything" }, want_key: "sha256:want-all", reason: "again", for_ms: null }, agent(T0 + 3)),
        () => ledger.access.answer(request.id, { from: 1, answer: "allowed", lines: FULL, covers: [] }, person(T0 + 3)),
        () => ledger.access.answer(request.id, { from: 3, answer: "declined" }, person(T0 + 3)),
        () => ledger.access.drop(AGENT, 1, agent(T0 + 3)),
      ];
      for (const write of stale) expect(write).toThrow(expect.objectContaining({ code: ACCESS_CHANGED }));
      expect(rows(path)).toEqual(before);
      expect(ledger.access.get(AGENT)).toMatchObject({ version: 2, lines: access([]) });
    } finally {
      ledger.close();
    }
  });

  it("a reader's versions only grow, a grant after a removal too, and each row holds the access after it", () => {
    const { ledger } = ledgerAt();
    try {
      expect(ledger.access.get(AGENT)).toBeUndefined();
      expect(ledger.access.change(AGENT, { from: 0, what: "granted", lines: FULL, covers: [MAIL, ACCOUNT, MAIL] }, person(T0))).toEqual({
        reader: AGENT, version: 1, lines: FULL, covers: [MAIL, ACCOUNT].sort(), at_ms: T0,
      });
      ledger.access.change(AGENT, { from: 1, what: "narrowed", lines: NO_HEALTH, covers: [ACCOUNT] }, person(T0 + 1));
      ledger.access.remove(AGENT, 2, { at_ms: T0 + 2, by: "home", device: null });
      expect(ledger.access.get(AGENT)).toBeUndefined();
      expect(ledger.access.change(AGENT, { from: 0, what: "granted", lines: FULL, covers: [] }, person(T0 + 3)).version).toBe(4);
      expect(ledger.access.changes(AGENT, { limit: 10 }).map(({ what, version, by, device, lines }) => ({ what, version, by, device, lines }))).toEqual([
        { what: "granted", version: 4, by: "person", device: PHONE, lines: FULL },
        { what: "removed", version: 3, by: "home", device: null, lines: null },
        { what: "narrowed", version: 2, by: "person", device: PHONE, lines: NO_HEALTH },
        { what: "granted", version: 1, by: "person", device: PHONE, lines: FULL },
      ]);
      const [newest, ...older] = ledger.access.changes(AGENT, { limit: 10 });
      expect(ledger.access.changes(AGENT, { before: newest!.seq, limit: 2 })).toEqual(older.slice(0, 2));
      expect(ledger.access.all().map((each) => each.reader)).toEqual([AGENT]);
    } finally {
      ledger.close();
    }
  });
});

describe("requests", () => {
  const want = (n: number) => ({ from: 1, want: { read: { product: "whatsapp" }, past: `${n}h` }, want_key: `sha256:want-${n}`, reason: `reason ${n}`, for_ms: 3_600_000 });

  it("one stands open per reader: a second replaces the first in its write, and the waiting list holds the second alone", () => {
    const { ledger, path } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [] }, person(T0));
      const first = ledger.access.ask(AGENT, want(1), agent(T0 + 1));
      const second = ledger.access.ask(AGENT, want(2), agent(T0 + 2));
      expect(ledger.access.request(first.id, T0 + 3)).toMatchObject({ state: "replaced", answered_ms: T0 + 2 });
      expect(ledger.access.waiting(T0 + 3)).toEqual([expect.objectContaining({ id: second.id, state: "open", want: want(2).want, want_key: "sha256:want-2", reason: "reason 2" })]);
      expect(ledger.access.changes(AGENT, { limit: 10 }).map(({ what, request, version }) => ({ what, request, version }))).toEqual([
        { what: "requested", request: second.id, version: 1 },
        { what: "replaced", request: first.id, version: 1 },
        { what: "requested", request: first.id, version: 1 },
        { what: "granted", request: null, version: 1 },
      ]);
      expect(() => raw(path, (db) => db.prepare("UPDATE access_requests SET state = 'open' WHERE id = ?").run(first.id))).toThrow(/UNIQUE/u);
      expect(() => ledger.access.ask(AGENT, { ...want(3), reason: "two\nlines" }, agent(T0 + 4))).toThrow(TypeError);
      expect(() => ledger.access.ask(AGENT, { ...want(3), reason: "x".repeat(301) }, agent(T0 + 4))).toThrow(TypeError);
      expect(ledger.access.ask(OTHER, { ...want(4), from: 0 }, agent(T0 + 4))).toMatchObject({ reader: OTHER, state: "open" });
    } finally {
      ledger.close();
    }
  });

  it("a request lapses a day after it was sent, read and never answered; it is written lapsed when touched, and told once", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [] }, person(T0));
      const asked = ledger.access.ask(AGENT, want(1), agent(T0));
      expect(ledger.access.request(asked.id, T0 + LAPSE_MS - 1)).toMatchObject({ state: "open" });
      expect(ledger.access.request(asked.id, T0 + LAPSE_MS)).toMatchObject({ state: "lapsed", answered_ms: T0 + LAPSE_MS });
      expect(ledger.access.waiting(T0 + LAPSE_MS)).toEqual([]);
      expect(ledger.access.answer(asked.id, { from: 1, answer: "allowed", lines: FULL, covers: [] }, person(T0 + LAPSE_MS + 5))).toMatchObject({ applied: false, request: { state: "lapsed" } });
      expect(ledger.access.get(AGENT)).toMatchObject({ version: 1, lines: NO_HEALTH });
      expect(ledger.access.changes(AGENT, { limit: 1 })).toMatchObject([{ what: "lapsed", by: "home", request: asked.id }]);
      const begun = ledger.access.begin({ reader: AGENT, tool: "search", sent: {}, read: {}, at_ms: T0 + LAPSE_MS + 10 });
      expect(begun.news).toMatchObject({ id: asked.id, state: "lapsed", told_ms: T0 + LAPSE_MS + 10 });
      expect(ledger.access.begin({ reader: AGENT, tool: "search", sent: {}, read: {}, at_ms: T0 + LAPSE_MS + 11 }).news).toBeUndefined();
    } finally {
      ledger.close();
    }
  });

  it("an answer moves an open request once, an allow writes its access, and the next call is told", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [] }, person(T0));
      const asked = ledger.access.ask(AGENT, want(1), agent(T0 + 1));
      expect(ledger.access.answer("rq-unknown", { from: 1, answer: "declined" }, person(T0 + 2))).toBeUndefined();
      expect(ledger.access.answer(asked.id, { from: 1, answer: "allowed", lines: FULL, covers: [ACCOUNT] }, person(T0 + 2))).toMatchObject({ applied: true, request: { state: "allowed", answered_ms: T0 + 2, device: PHONE } });
      expect(ledger.access.get(AGENT)).toMatchObject({ version: 2, lines: FULL, covers: [ACCOUNT] });
      expect(ledger.access.changes(AGENT, { limit: 1 })).toMatchObject([{ what: "allowed", version: 2, request: asked.id, lines: FULL }]);
      expect(ledger.access.answer(asked.id, { from: 2, answer: "declined" }, person(T0 + 3))).toMatchObject({ applied: false, request: { state: "allowed" } });
      const news = ledger.access.begin({ reader: AGENT, tool: "access", sent: {}, read: {}, at_ms: T0 + 4 }).news;
      expect(news).toMatchObject({ id: asked.id, state: "allowed", told_ms: T0 + 4 });
      expect(ledger.access.request(asked.id, T0 + 5)?.told_ms).toBe(T0 + 4);
      const no = ledger.access.ask(AGENT, { ...want(2), from: 2 }, agent(T0 + 6));
      ledger.access.answer(no.id, { from: 2, answer: "declined" }, person(T0 + 7));
      expect(ledger.access.get(AGENT)?.version).toBe(2);
      const dropped = ledger.access.ask(AGENT, { ...want(3), from: 2 }, agent(T0 + 8));
      expect(ledger.access.drop(AGENT, 2, agent(T0 + 9))).toMatchObject({ id: dropped.id, state: "dropped" });
      expect(ledger.access.drop(AGENT, 2, agent(T0 + 10))).toBeUndefined();
      expect(ledger.access.requests(AGENT, T0 + 11).map((each) => each.state)).toEqual(["dropped", "declined", "allowed"]);
    } finally {
      ledger.close();
    }
  });

  it("an agent's request and Chat's proposal stand open side by side: each replaces only its own maker's, the agent drops only its own, and the agent is told only of its own", () => {
    const { ledger, path } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [] }, person(T0));
      const proposal = { from: 1, want: { access: FULL }, want_key: "sha256:want-full", reason: "", for_ms: null };
      const proposed = ledger.access.ask(AGENT, proposal, chat(T0 + 1));
      const asked = ledger.access.ask(AGENT, want(1), agent(T0 + 2));
      const again = ledger.access.ask(AGENT, want(2), agent(T0 + 3));
      expect([proposed.by, asked.by, again.by]).toEqual(["chat", "agent", "agent"]);
      expect(ledger.access.request(asked.id, T0 + 4)?.state, "the agent's second replaced its first").toBe("replaced");
      expect(ledger.access.waiting(T0 + 4).map((each) => [each.id, each.by])).toEqual([[proposed.id, "chat"], [again.id, "agent"]]);
      expect(ledger.access.drop(AGENT, 1, agent(T0 + 5))).toMatchObject({ id: again.id, state: "dropped" });
      expect(ledger.access.drop(AGENT, 1, agent(T0 + 6)), "Chat's proposal is not the agent's to drop").toBeUndefined();
      expect(ledger.access.request(proposed.id, T0 + 7)?.state).toBe("open");
      const newer = ledger.access.ask(AGENT, { ...proposal, want_key: "sha256:want-newer" }, chat(T0 + 8));
      expect(ledger.access.request(proposed.id, T0 + 9)?.state, "Chat's second replaced its first").toBe("replaced");
      expect(() => raw(path, (db) => db.prepare("UPDATE access_requests SET state = 'open' WHERE id = ?").run(proposed.id))).toThrow(/UNIQUE/u);
      ledger.access.answer(newer.id, { from: 1, answer: "declined" }, person(T0 + 10));
      expect(ledger.access.begin({ reader: AGENT, tool: "access", sent: null, read: null, at_ms: T0 + 11 }).news?.id, "told of its own dropped request only").toBeUndefined();
      expect(ledger.access.request(newer.id, T0 + 12)?.told_ms).toBeNull();
    } finally {
      ledger.close();
    }
  });

  it("a reason is one line of plain text of at most 300 characters, counted as a person sees them", () => {
    expect(reasonFault("Your sleep this week.")).toBeNull();
    expect(reasonFault("😴".repeat(300)), "300 emoji are 300 characters, 600 UTF-16 units").toBeNull();
    expect(reasonFault("😴".repeat(301))).toBe("reason is one line of at most 300 characters: this one has 301");
    for (const [char, name] of [["\n", "U+000A"], ["\t", "U+0009"], ["\u0000", "U+0000"], ["\u0085", "U+0085"], ["\u2028", "U+2028"]] as const) {
      expect(reasonFault(`one${char}two`), name).toBe(`reason is one line of plain text: it holds a line break or a control character (${name})`);
    }
    for (const [char, name] of [["\u202e", "U+202E"], ["\u2066", "U+2066"], ["\u200f", "U+200F"]] as const) {
      expect(reasonFault(`one${char}two`), name).toBe(`reason is plain text: it holds a mark that turns the direction of the text (${name}), which would show your words as something else`);
    }
    expect(reasonFault("👩\u200d💻 a family emoji's joiner stays")).toBeNull();
  });
});

describe("calls", () => {
  it("a call begun and never ended reads running; an end is written once, its words bounded, its withheld counts summed by line", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [] }, person(T0));
      const left = ledger.access.begin({ reader: AGENT, tool: "read", sent: { handle: "h-1" }, read: { key: "msg-1" }, at_ms: T0 });
      const call = ledger.access.begin({ reader: AGENT, tool: "search", sent: { q: "[[Person 3]] lunch" }, read: { q: "Person3 Example lunch" }, at_ms: T0 + 1 });
      expect(call).toMatchObject({ session: 1, epoch: 0, access: { version: 1 } });
      expect(ledger.access.end("call-unknown", { result: "answered", words: null, ms: 1, withheld: [] })).toBe(false);
      expect(ledger.access.end(call.id, {
        result: "refused", words: `too\nmany ${"words ".repeat(80)}`, ms: 12.4,
        withheld: [{ line: "3", n: 5, least: false }, { line: "no-line", n: 2, least: false }, { line: "3", n: 1, least: true }],
      })).toBe(true);
      expect(ledger.access.end(call.id, { result: "answered", words: null, ms: 1, withheld: [] })).toBe(false);
      const read = ledger.access.call(call.id)!;
      expect(read).toMatchObject({ result: "refused", ms: 12, access_version: 1, sent: { q: "[[Person 3]] lunch" }, read: { q: "Person3 Example lunch" }, withheld: [{ line: "3", n: 6, least: true }, { line: "no-line", n: 2, least: false }] });
      expect([...read.words!].length).toBeLessThanOrEqual(300);
      expect(read.words).toMatch(/^…/u);
      expect(read.words).not.toMatch(/\n/u);
      expect(ledger.access.call(left.id)).toMatchObject({ result: "running", words: null, ms: null });
      expect(ledger.access.calls(AGENT, { limit: 10 }).map((each) => each.id)).toEqual([call.id, left.id]);
      expect(ledger.access.begin({ reader: OTHER, tool: "access", sent: {}, read: {}, at_ms: T0 }).access).toBeUndefined();
      expect(ledger.access.calls(OTHER, { limit: 1 })[0]?.access_version).toBeNull();
    } finally {
      ledger.close();
    }
  });

  it("what came back is kept as kinds and counts, refused when not; an unlisted reader is written once", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [] }, person(T0));
      const shown = ledger.access.begin({ reader: AGENT, tool: "search", sent: { q: "lunch" }, read: { q: "lunch" }, at_ms: T0 });
      const none = ledger.access.begin({ reader: AGENT, tool: "search", sent: { q: "dinner" }, read: { q: "dinner" }, at_ms: T0 + 1 });
      const refused = ledger.access.begin({ reader: AGENT, tool: "read", sent: {}, read: {}, at_ms: T0 + 2 });
      const bad = ledger.access.begin({ reader: AGENT, tool: "read", sent: {}, read: {}, at_ms: T0 + 3 });
      expect(ledger.access.end(shown.id, { result: "answered", words: null, ms: 3, withheld: [], came: { mail: 12, photos: 2 } })).toBe(true);
      expect(ledger.access.end(none.id, { result: "answered", words: null, ms: 3, withheld: [], came: {} })).toBe(true);
      expect(ledger.access.end(refused.id, { result: "refused", words: "no", ms: 3, withheld: [] })).toBe(true);
      expect(() => ledger.access.end(bad.id, { result: "answered", words: null, ms: 3, withheld: [], came: { "Mail Box": 1 } })).toThrow(TypeError);
      expect(() => ledger.access.end(bad.id, { result: "answered", words: null, ms: 3, withheld: [], came: { mail: 0 } })).toThrow(TypeError);
      expect(ledger.access.call(shown.id)?.came).toEqual({ mail: 12, photos: 2 });
      expect(ledger.access.call(none.id)?.came).toEqual({});
      expect(ledger.access.call(refused.id)?.came).toBeNull();
      expect(ledger.access.call(bad.id)).toMatchObject({ result: "running", came: null });
      expect(ledger.access.unlisted()).toEqual(new Set());
      expect(ledger.access.unlist(AGENT, T0)).toBe(true);
      expect(ledger.access.unlist(AGENT, T0 + 1)).toBe(false);
      expect(ledger.access.unlisted()).toEqual(new Set([AGENT]));
    } finally {
      ledger.close();
    }
  });

  it("calls under 30 minutes apart are one session, 30 minutes apart two, and an initialize starts the next", () => {
    const { ledger } = ledgerAt();
    try {
      const at = (at_ms: number, initialize = false) => ledger.access.begin({ reader: AGENT, tool: "who", sent: {}, read: {}, at_ms, initialize }).session;
      expect(at(T0)).toBe(1);
      expect(at(T0 + SESSION_GAP_MS - 1)).toBe(1);
      expect(at(T0 + 2 * SESSION_GAP_MS - 1)).toBe(2);
      expect(at(T0 + 2 * SESSION_GAP_MS, true)).toBe(3);
      expect(ledger.access.begin({ reader: OTHER, tool: "who", sent: {}, read: {}, at_ms: T0 + 2 * SESSION_GAP_MS }).session).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("the access read that opens a session starts it and is no line of History; an access the agent asks for itself is one", () => {
    const { ledger } = ledgerAt();
    try {
      const call = (tool: string, at_ms: number, initialize = false) => {
        const begun = ledger.access.begin({ reader: AGENT, tool, sent: {}, read: {}, at_ms, initialize });
        ledger.access.end(begun.id, { result: "answered", words: null, ms: 3, withheld: [] });
        return begun;
      };
      call("search", T0);
      const opened = call("access", T0 + 1, true);
      const asked = call("access", T0 + 2);
      const read = call("read", T0 + 3);
      expect(opened.session).toBe(2);
      expect([asked.session, read.session]).toEqual([2, 2]);
      expect(ledger.access.calls(AGENT, { limit: 10 }).map((each) => [each.tool, each.session])).toEqual([["read", 2], ["access", 2], ["search", 1]]);
      expect(ledger.access.calls(AGENT, { limit: 10 }).map((each) => each.id)).not.toContain(opened.id);
      expect(ledger.access.call(opened.id)?.tool).toBe("access");
    } finally {
      ledger.close();
    }
  });

  it("a call that ends after an erasure keeps its result and time, and no words", () => {
    const { ledger } = ledgerAt();
    try {
      const call = ledger.access.begin({ reader: AGENT, tool: "read", sent: {}, read: {}, at_ms: T0 });
      ledger.placeholders.beginErasure();
      ledger.placeholders.endErasure();
      expect(ledger.access.end(call.id, { result: "failed", words: "the record went", ms: 40, withheld: [] })).toBe(true);
      expect(ledger.access.call(call.id)).toMatchObject({ result: "failed", words: null, ms: 40 });
      const after = ledger.access.begin({ reader: AGENT, tool: "read", sent: {}, read: {}, at_ms: T0 + 1 });
      expect(after.epoch).toBe(2);
      ledger.access.end(after.id, { result: "failed", words: "a failure", ms: 1, withheld: [] });
      expect(ledger.access.call(after.id)?.words).toBe("a failure");
    } finally {
      ledger.close();
    }
  });

  it("a source that joins an access is a row before the call that reads it, once; a fault there leaves no call and no row", () => {
    const { ledger, path } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [ACCOUNT] }, person(T0));
      const reaches = () => [ACCOUNT, MAIL, "calendar:person-a@example.com"];
      const before = rows(path);
      expect(failing(path, "calls", () => ledger.access.begin({ reader: AGENT, tool: "search", sent: {}, read: {}, at_ms: T0 + 1, reaches }))).toMatchObject({ message: "failpoint" });
      expect(rows(path)).toEqual(before);
      const begun = ledger.access.begin({ reader: AGENT, tool: "search", sent: {}, read: {}, at_ms: T0 + 2, reaches });
      expect(begun.access).toMatchObject({ version: 3, lines: NO_HEALTH, covers: [ACCOUNT, "calendar:person-a@example.com", MAIL].sort() });
      expect(ledger.access.changes(AGENT, { limit: 10 }).map(({ what, version, about, by }) => ({ what, version, about, by }))).toEqual([
        { what: "joined", version: 3, about: MAIL, by: "home" },
        { what: "joined", version: 2, about: "calendar:person-a@example.com", by: "home" },
        { what: "granted", version: 1, about: null, by: "person" },
      ]);
      expect(ledger.access.call(begun.id)?.access_version).toBe(3);
      expect(ledger.access.begin({ reader: AGENT, tool: "search", sent: {}, read: {}, at_ms: T0 + 3, reaches }).access?.version).toBe(3);
    } finally {
      ledger.close();
    }
  });

  it("an outbound row names the call it answers, and one naming a call the ledger never began is not written", () => {
    const { ledger, path } = ledgerAt();
    try {
      const call = ledger.access.begin({ reader: AGENT, tool: "read", sent: {}, read: {}, at_ms: T0 });
      const row = (more: Partial<NewOutbound>): NewOutbound => ({
        at_ms: T0, receiver: "Agent App", route: null, by: AGENT, what: "read", tool: "read", level: "names", counts: {}, chars: 10, pictures: 0, key: null, attempt: null, ...more,
      });
      const first = ledger.outbound.write(row({ call: call.id }));
      const second = ledger.outbound.write(row({ call: call.id }));
      ledger.outbound.write(row({}));
      expect(ledger.access.call(call.id)?.outbound).toEqual([first, second]);
      const before = raw(path, (db) => db.prepare("SELECT count(*) AS n FROM outbound").get());
      expect(() => ledger.outbound.write(row({ call: "call-never" }))).toThrow(TypeError);
      expect(raw(path, (db) => db.prepare("SELECT count(*) AS n FROM outbound").get())).toEqual(before);
    } finally {
      ledger.close();
    }
  });
});

const DAY = "2026-11-13";
const recordItem = (kind: string, record: { source: string; kind: string; key: string }): CallItem =>
  ({ kind, ref: `record.${record.key}`, source: record.source, rkind: record.kind, key: record.key, day: null });
const lineItem = (n: number, day = DAY): CallItem => ({ kind: "messages", ref: `line.${day}-${n}`, source: null, rkind: null, key: null, day });
const KEPT_EMAIL = { source: MAIL, kind: "email", key: "email-kept-1" };

function itemRows(path: string): { call: number; at: number; ref: string }[] {
  return raw(path, (db) => db.prepare("SELECT call, at, ref FROM call_items ORDER BY call, at").all() as { call: number; at: number; ref: string }[]);
}

describe("a call's items", () => {
  function begun(ledger: Ledger, at_ms: number, tool = "search") {
    return ledger.access.begin({ reader: AGENT, tool, sent: {}, read: {}, at_ms });
  }

  it("are written with the call's end, in answer order, and `came` is their tally", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: FULL, covers: [] }, person(T0));
      const call = begun(ledger, T0 + 1);
      const items = [recordItem("messages", RECORD), lineItem(1), recordItem("mail", KEPT_EMAIL), lineItem(2)];
      expect(ledger.access.end(call.id, { result: "answered", words: null, ms: 1, withheld: [], items })).toBe(true);
      expect(ledger.access.call(call.id)?.came).toEqual({ messages: 3, mail: 1 });
      const read = ledger.access.items(call.seq, { limit: 3 });
      expect(read).toMatchObject({ kept: 4, unkept: 0, next: 2 });
      expect(read.items.map(({ at, ref }) => [at, ref])).toEqual([[0, `record.${RECORD.key}`], [1, `line.${DAY}-1`], [2, `record.${KEPT_EMAIL.key}`]]);
      expect(read.items[0]).toEqual({ at: 0, ...items[0] });
      expect(ledger.access.items(call.seq, { after: 2, limit: 3 })).toMatchObject({ items: [{ at: 3, day: DAY }], next: null });
      expect(() => ledger.access.end(begun(ledger, T0 + 2).id, { result: "answered", words: null, ms: 1, withheld: [], came: { messages: 1 }, items: [lineItem(1)] })).toThrow(TypeError);
    } finally {
      ledger.close();
    }
  });

  it("an end that throws after its items are written leaves no item and the call running", () => {
    const { ledger, path } = ledgerAt();
    try {
      const call = begun(ledger, T0);
      expect(() => ledger.access.end(call.id, { result: "answered", words: null, ms: 1, withheld: [{ line: "1", n: 0, least: false }], items: [lineItem(1), lineItem(2)] })).toThrow(TypeError);
      expect(itemRows(path)).toEqual([]);
      expect(ledger.access.call(call.id)).toMatchObject({ result: "running", came: null });
      expect(failing(path, "call_items", () => ledger.access.end(call.id, { result: "answered", words: null, ms: 1, withheld: [], items: [lineItem(1)] }))).toBeInstanceOf(Error);
      expect(ledger.access.call(call.id)).toMatchObject({ result: "running", came: null });
    } finally {
      ledger.close();
    }
  });

  it(`keeps the first ${CALL_ITEMS_KEPT} of a larger answer and says how many were not kept`, () => {
    const { ledger, path } = ledgerAt();
    try {
      const call = begun(ledger, T0, "read");
      const items = Array.from({ length: 1_100 }, (_, n) => lineItem(n));
      ledger.access.end(call.id, { result: "answered", words: null, ms: 1, withheld: [], items });
      expect(ledger.access.call(call.id)?.came).toEqual({ messages: 1_100 });
      expect(itemRows(path)).toHaveLength(CALL_ITEMS_KEPT);
      expect(itemRows(path).at(-1)).toMatchObject({ at: CALL_ITEMS_KEPT - 1, ref: `line.${DAY}-${CALL_ITEMS_KEPT - 1}` });
      expect(ledger.access.items(call.seq, { after: CALL_ITEMS_KEPT - 2, limit: 50 })).toMatchObject({ kept: CALL_ITEMS_KEPT, unkept: 76, next: null, items: [{ at: CALL_ITEMS_KEPT - 1 }] });
    } finally {
      ledger.close();
    }
  });

  it("a call that ends after an erasure keeps what came back by kind and none of its items", () => {
    const { ledger, path } = ledgerAt();
    try {
      const call = begun(ledger, T0);
      ledger.placeholders.beginErasure();
      ledger.placeholders.endErasure();
      ledger.access.end(call.id, { result: "answered", words: null, ms: 1, withheld: [], items: [recordItem("messages", RECORD), lineItem(1)] });
      expect(ledger.access.call(call.id)?.came).toEqual({ messages: 2 });
      expect(itemRows(path)).toEqual([]);
      expect(ledger.access.items(call.seq, { limit: 50 })).toEqual({ items: [], next: null, kept: 0, unkept: 2 });
    } finally {
      ledger.close();
    }
  });

  it("an erasure of a record or a day takes the items naming it and keeps the rest; a call's delete takes its own", () => {
    const { ledger, path } = ledgerAt();
    try {
      const first = begun(ledger, T0);
      const second = begun(ledger, T0 + 1);
      ledger.access.end(first.id, { result: "answered", words: null, ms: 1, withheld: [], items: [recordItem("messages", RECORD), recordItem("mail", KEPT_EMAIL), lineItem(1)] });
      ledger.access.end(second.id, { result: "answered", words: null, ms: 1, withheld: [], items: [recordItem("messages", RECORD), lineItem(2, "2026-11-12")] });
      ledger.forget([], [RECORD]);
      expect(itemRows(path).map(({ call, ref }) => [call, ref])).toEqual([[first.seq, `record.${KEPT_EMAIL.key}`], [first.seq, `line.${DAY}-1`], [second.seq, "line.2026-11-12-2"]]);
      ledger.forget([], [], undefined, [DAY]);
      expect(itemRows(path).map(({ call, ref }) => [call, ref])).toEqual([[first.seq, `record.${KEPT_EMAIL.key}`], [second.seq, "line.2026-11-12-2"]]);
      raw(path, (db) => db.prepare("DELETE FROM calls WHERE seq = ?").run(first.seq));
      expect(itemRows(path).map(({ call }) => call)).toEqual([second.seq]);
    } finally {
      ledger.close();
    }
  });

  it("calls of one kind page through every call that carried it, once each, scanning a bounded number of calls a page", () => {
    const { ledger } = ledgerAt();
    try {
      const carried: number[] = [];
      for (let n = 0; n < 60; n++) {
        const call = begun(ledger, T0 + n);
        const messages = n % 3 === 0;
        if (messages) carried.push(call.seq);
        ledger.access.end(call.id, { result: "answered", words: null, ms: 1, withheld: [], items: messages ? [lineItem(n), recordItem("mail", KEPT_EMAIL)] : [recordItem("mail", KEPT_EMAIL)] });
      }
      const seen: number[] = [];
      let before: number | undefined;
      let pages = 0;
      for (;;) {
        const page = ledger.access.calls(AGENT, { ...(before === undefined ? {} : { before }), limit: 4, kind: "messages", scan: 7 });
        pages++;
        expect(page.calls.length).toBeLessThanOrEqual(3);
        seen.push(...page.calls.map((each) => each.seq));
        if (page.next === null) break;
        before = page.next;
      }
      expect(seen).toEqual([...carried].reverse());
      expect(pages).toBe(9);
      const full = ledger.access.calls(AGENT, { limit: 4, kind: "mail", scan: 100 });
      expect(full.calls).toHaveLength(4);
      expect(full.next).toBe(full.calls.at(-1)!.seq);
      expect(() => ledger.access.calls(AGENT, { limit: 4, kind: "mail", scan: 0 })).toThrow(TypeError);
    } finally {
      ledger.close();
    }
  });
});

describe("the move's mark", () => {
  const readers = [{ reader: "ask", lines: FULL, covers: [] }, { reader: AGENT, lines: FULL, covers: [] }];

  it("writes each reader's full access and the mark, once; a fault inside leaves none of it", () => {
    const { ledger, path } = ledgerAt();
    try {
      expect(ledger.access.moved()).toBeNull();
      expect(failing(path, "access_moved", () => ledger.access.move(readers, T0))).toMatchObject({ message: "failpoint" });
      expect(Object.values(rows(path)).flat()).toEqual([]);
      expect(ledger.access.move(readers, T0 + 1)).toBe(true);
      expect(ledger.access.moved()).toBe(T0 + 1);
      expect(ledger.access.all()).toEqual(readers.map(({ reader }) => ({ reader, version: 1, lines: FULL, covers: [], at_ms: T0 + 1 })));
      expect(ledger.access.changes(AGENT, { limit: 5 })).toMatchObject([{ what: "granted", by: "home", version: 1 }]);
      const after = rows(path);
      expect(ledger.access.move([{ reader: OTHER, lines: FULL, covers: [] }], T0 + 2)).toBe(false);
      expect(rows(path)).toEqual(after);
      expect(() => raw(path, (db) => db.prepare("INSERT INTO access_moved (at_ms) VALUES (1)").run())).toThrow("the move is marked once");
    } finally {
      ledger.close();
    }
  });

  it("is refused over an access with no mark, which it would write over", () => {
    const { ledger, path } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [] }, person(T0));
      const before = rows(path);
      expect(() => ledger.access.move(readers, T0 + 1)).toThrow("the ledger holds an access but not the move's mark");
      expect(rows(path)).toEqual(before);
    } finally {
      ledger.close();
    }
  });
});

describe("an erasure", () => {
  function served(): { ledger: Ledger; path: string; call: string; outbound: number } {
    const { ledger, path } = ledgerAt();
    const conversation = { reach: { conversation: CHAT, account: ACCOUNT }, window: null, until_ms: T0 + 3_600_000 };
    const leftOut = { reach: { account: ACCOUNT, but: [CHAT] }, window: null, until_ms: null };
    const mail = { reach: { type: "mail", but: [MAIL] }, window: null, until_ms: null };
    ledger.access.change(AGENT, { from: 0, what: "granted", lines: access([leftOut]), covers: [ACCOUNT] }, person(T0));
    const call = ledger.access.begin({ reader: AGENT, tool: "read", sent: { handle: "h-msg" }, read: { key: RECORD.key }, at_ms: T0 + 1 });
    const outbound = ledger.outbound.write({
      at_ms: T0 + 1, receiver: "Agent App", route: null, by: AGENT, what: "read", tool: "read", level: "names", counts: {}, chars: 10, pictures: 0, key: null, attempt: null,
      refs: [RECORD, { source: MAIL, kind: "email", key: "email-kept-1" }], call: call.id,
    });
    ledger.access.end(call.id, { result: "answered", words: null, ms: 3, withheld: [] });
    const asked = ledger.access.ask(AGENT, { from: 1, want: { read: { handle: CHAT } }, want_key: "sha256:want-chat", reason: `the ${CHAT} thread, please`, for_ms: 3_600_000 }, agent(T0 + 2));
    ledger.access.answer(asked.id, { from: 1, answer: "allowed", lines: access([leftOut, conversation], [RECORD]), covers: [ACCOUNT] }, person(T0 + 3));
    ledger.access.change(OTHER, { from: 0, what: "granted", lines: access([mail]), covers: [MAIL] }, person(T0 + 4));
    return { ledger, path, call: call.id, outbound };
  }

  it("leaves no want, snapshot or live line naming what it took, writes an `erased` row, takes the record's refs, and keeps what an agent wrote", () => {
    const { ledger, path, call, outbound } = served();
    try {
      const counts = ledger.forget([], [RECORD], { scrub: scrubOf(CHAT, RECORD.key), at_ms: T0 + 10 });
      expect(counts.access).toEqual({ accesses: 1, snapshots: 3, wants: 1, reads: 1 });
      const text = canonical(raw(path, (db) => ({
        calls: db.prepare("SELECT read FROM calls").all(), access: db.prepare("SELECT * FROM access").all(), changes: db.prepare("SELECT * FROM access_changes").all(), requests: db.prepare("SELECT id, want, want_key, state FROM access_requests").all(),
      })) as Json);
      expect(text).not.toContain(CHAT);
      expect(text).not.toContain(RECORD.key);
      expect(ledger.access.requests(AGENT, T0 + 11)).toMatchObject([{ want: null, want_key: null, reason: `the ${CHAT} thread, please`, state: "allowed" }]);
      expect(ledger.access.call(call)).toMatchObject({ sent: { handle: "h-msg" }, read: null, outbound: [outbound] });
      expect(ledger.access.get(AGENT)).toMatchObject({ version: 3, lines: access([]), covers: [ACCOUNT] });
      expect(ledger.access.changes(AGENT, { limit: 1 })).toMatchObject([{ what: "erased", by: "person", version: 3, about: { lines: 3 }, lines: access([]) }]);
      expect(ledger.access.get(OTHER)).toMatchObject({ version: 1 });
      expect(ledger.outbound.row(outbound, { zone: "UTC", day_start_hour: 0 })?.refs).toEqual([{ source: MAIL, kind: "email", key: "email-kept-1" }]);
    } finally {
      ledger.close();
    }
  });

  it("never widens: an allow whose `but` names an erased account goes whole, and the access after allows nothing the one before did not", () => {
    const { ledger } = served();
    try {
      const before = ledger.access.get(OTHER)!;
      ledger.forget([], [], { scrub: scrubOf(MAIL), at_ms: T0 + 10 });
      const after = ledger.access.get(OTHER)!;
      expect(after).toMatchObject({ version: 2, lines: access([]), covers: [] });
      const allows = (lines: Json) => (lines as { allow: Json[] }).allow.map((each) => canonical(each));
      for (const allow of allows(after.lines)) expect(allows(before.lines)).toContain(allow);
      expect(ledger.access.get(AGENT)?.version).toBe(2);
      expect(ledger.access.changes(AGENT, { limit: 1 })[0]?.what).toBe("allowed");
    } finally {
      ledger.close();
    }
  });

  it("a scrub that leaves an erased identity writes nothing of the erasure", () => {
    const { ledger, path } = served();
    try {
      raw(path, (db) => db.exec(`INSERT INTO prompts (hash, version, text) VALUES ('sha256:prompt-a', 'v1', 'Caption this synthetic photo.');
        INSERT INTO requests (key, unit, model, effort, transport, prompt_hash, input_hash, body, attachments, requested)
        VALUES ('request-a', 'photo:synthetic-1', 'synthetic/model-a', 'none', 'fake', 'sha256:prompt-a', 'sha256:input-a', 'body', '[]', '2026-11-13T06:00:00.000Z')`));
      const made = ledger.sent.make({ key: "request-a", receiver: "Agent App", route: "fake:fake-model", level: "none", body: null,
        pictures: [{ jpeg: new Uint8Array([0xff, 0xd8, 0xff]), recipe: {} }], counts: {}, detector: null }, T0, ledger.placeholders.epoch().epoch);
      if (!("id" in made)) throw new Error(`no copy: ${JSON.stringify(made)}`);
      const picture = join(dirname(path), "sent", String(made.id), "0.jpg");
      expect(existsSync(picture)).toBe(true);
      const before = { ...rows(path), refs: raw(path, (db) => db.prepare("SELECT * FROM outbound_refs ORDER BY rowid").all()), requests: raw(path, (db) => db.prepare("SELECT key FROM requests").all()) };
      const leaky: Scrub = { ...scrubOf(CHAT, RECORD.key), access: (lines) => ({ lines, went: null }) };
      expect(() => ledger.forget(["photo:synthetic-1"], [RECORD], { scrub: leaky, at_ms: T0 + 10 })).toThrow("the scrub left an erased identity in an access");
      expect({ ...rows(path), refs: raw(path, (db) => db.prepare("SELECT * FROM outbound_refs ORDER BY rowid").all()), requests: raw(path, (db) => db.prepare("SELECT key FROM requests").all()) }).toEqual(before);
      expect(existsSync(picture)).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("an approval made before an erasure that cleared its request's want writes nothing", () => {
    const { ledger, path } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [ACCOUNT] }, person(T0));
      const asked = ledger.access.ask(AGENT, { from: 1, want: { read: { handle: CHAT } }, want_key: "sha256:want-chat", reason: "the thread", for_ms: 3_600_000 }, agent(T0 + 1));
      ledger.forget([], [], { scrub: scrubOf(CHAT), at_ms: T0 + 2 });
      expect(ledger.access.get(AGENT)?.version).toBe(1);
      const stale = access([{ reach: { conversation: CHAT, account: ACCOUNT }, window: null, until_ms: T0 + 3_600_000 }]);
      expect(ledger.access.answer(asked.id, { from: 1, answer: "allowed", lines: stale, covers: [ACCOUNT] }, person(T0 + 3))).toMatchObject({ applied: false });
      expect(ledger.access.get(AGENT)).toMatchObject({ version: 1, lines: NO_HEALTH });
      expect(canonical(rows(path) as unknown as Json)).not.toContain(CHAT);
      expect(ledger.access.answer(asked.id, { from: 1, answer: "declined" }, person(T0 + 4))).toMatchObject({ applied: true, request: { state: "declined", want: null } });
      expect(ledger.access.get(AGENT)?.version).toBe(1);
    } finally {
      ledger.close();
    }
  });
});

describe("a row looked up", () => {
  it("reads the row that made each version, never a request's row at it, and a request's own row", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: FULL, covers: [] }, person(T0));
      ledger.access.change(AGENT, { from: 1, what: "narrowed", lines: NO_HEALTH, covers: [] }, person(T0 + 1));
      const asked = ledger.access.ask(AGENT, { from: 2, want: { read: { type: "health" } }, want_key: "sha256:want-health", reason: "steps", for_ms: null }, agent(T0 + 2));
      ledger.access.remove(AGENT, 2, person(T0 + 3));
      expect(ledger.access.made(AGENT, 1)).toMatchObject({ what: "granted", lines: FULL });
      expect(ledger.access.made(AGENT, 2)).toMatchObject({ what: "narrowed", lines: NO_HEALTH });
      expect(ledger.access.made(AGENT, 3)).toMatchObject({ what: "removed", lines: null });
      expect([ledger.access.made(AGENT, 0), ledger.access.made(AGENT, 4), ledger.access.made(OTHER, 1)]).toEqual([undefined, undefined, undefined]);
      expect(ledger.access.requested(AGENT, asked.id)).toMatchObject({ what: "requested", version: 2, request: asked.id, lines: NO_HEALTH });
      expect(ledger.access.requested(OTHER, asked.id)).toBeUndefined();
    } finally {
      ledger.close();
    }
  });
});

describe("answers told", () => {
  it("two answers waiting are told one a call, newest first, and neither is lost", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(AGENT, { from: 0, what: "granted", lines: NO_HEALTH, covers: [ACCOUNT] }, person(T0));
      const first = ledger.access.ask(AGENT, { from: 1, want: { read: { type: "health" } }, want_key: "sha256:want-health", reason: "steps", for_ms: 3_600_000 }, agent(T0 + 1));
      ledger.access.answer(first.id, { from: 1, answer: "declined" }, person(T0 + 2));
      const second = ledger.access.ask(AGENT, { from: 1, want: { read: { type: "money" } }, want_key: "sha256:want-money", reason: "spend", for_ms: 3_600_000 }, agent(T0 + 3));
      ledger.access.answer(second.id, { from: 1, answer: "declined" }, person(T0 + 4));
      const told = [5, 6, 7].map((n) => ledger.access.begin({ reader: AGENT, tool: "search", sent: {}, read: {}, at_ms: T0 + n }).news?.id);
      expect(told).toEqual([second.id, first.id, undefined]);
      expect(ledger.access.told(AGENT, { from_ms: T0 + 5, to_ms: T0 + 7, limit: 3 }).map((each) => [each.id, each.told_ms, each.state])).toEqual([[first.id, T0 + 6, "declined"], [second.id, T0 + 5, "declined"]]);
      expect(ledger.access.told(AGENT, { from_ms: T0 + 6, to_ms: T0 + 7, limit: 3 }).map((each) => each.id)).toEqual([first.id]);
      expect(ledger.access.told(AGENT, { from_ms: T0 + 5, to_ms: T0 + 7, limit: 1 }).map((each) => each.id)).toEqual([first.id]);
      expect(ledger.access.told(OTHER, { from_ms: T0, to_ms: T0 + 7, limit: 3 })).toEqual([]);
    } finally {
      ledger.close();
    }
  });
});
