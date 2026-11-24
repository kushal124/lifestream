import { describe, expect, it } from "vitest";
import { makeRef, personRef, readRef, REF_KINDS, type RefKind, type RefParts } from "./refs.js";
import { Refusal } from "./refusal.js";

const PARTS: { [K in RefKind]: RefParts[K] } = {
  record: { source: "whatsapp:15550000009:iphone-aa01", kind: "msg", key: "15550000002@s.whatsapp.net:AAA, 1 & 2=3+4/5" },
  line: { day: "2026-10-01", same: "00aa00aa00aa00aa", m: 0, unit: "calendar/e3", item: null },
  person: { handle: "phone:+15550000001" },
  chat: { key: "whatsapp:15550000001@s.whatsapp.net" },
  place: { id: "example-cafe" },
  picture: { image: `sha256:${"0a".repeat(32)}` },
  window: { machine: "macbook-pro-0001", day: "2026-11-02", app: "Example Browser", site: "", name: "Example Air: your trip", at_ms: null },
  row: {
    ask: { of: "payments", measure: "amount", by: ["month", "payee"], match: { payee: "acme OR -cabs" }, from: "2026-03-01", at_least: 10.5 },
    kept: { persons: [["phone:+15550000001", "email:person-a@example.com"], "phone:+15550000002"], values: { payee: { in: ["ACME CABS LIMITED"], out: ["ACME, CABS"] } }, chat: [],
      place: { in: [{ level: "city", id: "example-city" }], out: [] } },
    scope: { g: ["2026-03", 12, null, ["phone:+15550000001", "email:person-a@example.com"]], p: "EUR" },
    n: 7,
  },
};

const refusal = (run: () => unknown): { status: number; code: string; words: string } => {
  try {
    run();
  } catch (error) {
    if (error instanceof Refusal) return { status: error.status, code: error.code, words: error.words };
    throw error;
  }
  throw new Error("not refused");
};

describe("a ref of each kind", () => {
  it("covers the kinds of the spec's section 2.9, Go to's places and the pictures `read` shows", () => {
    expect([...REF_KINDS].sort()).toEqual(["chat", "line", "person", "picture", "place", "record", "row", "window"]);
  });

  it.each(REF_KINDS)("%s: comes back as it went in, one URL-safe token, the same parts the same ref", kind => {
    const made = makeRef(kind, PARTS[kind]);
    expect(made).toMatch(new RegExp(`^${kind}\\.[A-Za-z0-9_-]+$`, "u"));
    expect(readRef(made)).toEqual({ kind, parts: PARTS[kind] });
    expect(makeRef(kind, { ...PARTS[kind] })).toBe(made);
    expect(readRef(made, "ref", [kind])).toEqual({ kind, parts: PARTS[kind] });
  });

  it("different parts make different refs; a window's minute, a line's item and its ordinal are parts", () => {
    expect(makeRef("window", { ...PARTS.window, at_ms: 1793595780000 })).not.toBe(makeRef("window", PARTS.window));
    expect(makeRef("line", { ...PARTS.line, item: "e3/0" })).not.toBe(makeRef("line", PARTS.line));
    expect(makeRef("line", { ...PARTS.line, m: 1 })).not.toBe(makeRef("line", PARTS.line));
    expect(makeRef("row", { ...PARTS.row, n: 8 })).not.toBe(makeRef("row", PARTS.row));
    expect(makeRef("person", { handle: "a" })).not.toBe(makeRef("chat", { key: "a" }));
  });

  it("the door makes no ref of parts its kind refuses", () => {
    expect(() => makeRef("line", { ...PARTS.line, day: "1 Oct" })).toThrow("line ref[0]");
    expect(() => makeRef("line", { ...PARTS.line, same: "not a digest" })).toThrow("line ref[1]");
    expect(() => makeRef("record", { ...PARTS.record, key: "" })).toThrow("record ref[2]");
    expect(() => makeRef("row", { ...PARTS.row, ask: { of: "payments", op: "sum" } })).toThrow("takes a `measure`");
  });

  it("a row holds a durable query: its collection, never a cursor or the catalog", () => {
    const ask = (value: unknown) => ({ ...PARTS.row, ask: value as RefParts["row"]["ask"] });
    expect(() => makeRef("row", ask({ cursor: "old-file-cursor" }))).toThrow("row ref[0].of: is missing");
    expect(() => makeRef("row", ask({ of: "payments", cursor: "old-file-cursor" }))).toThrow("row ref[0].cursor: is no member");
    expect(() => makeRef("row", ask({ measure: "amount", op: "sum" }))).toThrow("row ref[0].of: is missing");
    expect(() => makeRef("row", ask({}))).toThrow("row ref[0].of: is missing");
  });

  it("a row says which row it is: the whole count, a total, a group, a fact, each read back as itself", () => {
    const scopes = [{}, { t: null }, { t: "EUR" }, { g: [["phone:+15550000001"]], p: null }, { g: ["ACME", 3], p: "EUR" }, { u: ["unit-1", null, "fact-1"] }] as const;
    for (const scope of scopes) {
      const ref = makeRef("row", { ...PARTS.row, scope: scope as RefParts["row"]["scope"] });
      expect(readRef(ref, "ref", ["row"]).parts.scope).toEqual(scope);
    }
    expect(new Set(scopes.map((scope) => makeRef("row", { ...PARTS.row, scope: scope as RefParts["row"]["scope"] }))).size).toBe(scopes.length);
    expect(() => makeRef("row", { ...PARTS.row, scope: ["ACME"] as never })).toThrow("row ref[2]");
    expect(() => makeRef("row", { ...PARTS.row, scope: { g: [], p: null } })).toThrow("row ref[2]");
  });
});

describe("a person's ref", () => {
  it("holds their lowest handle by core's order, whatever order People lists them in; one with none, their own id", () => {
    const handles = ["telegram:12345", "email:person-a@example.com", "jid:100000000000001@lid", "phone:+15550000002", "phone:+15550000001"];
    const lowest = makeRef("person", { handle: "phone:+15550000001" });
    expect(personRef({ id: "person:person-a", handles })).toBe(lowest);
    expect(personRef({ id: "person:person-a", handles: [...handles].reverse() })).toBe(lowest);
    expect(personRef({ id: "phone:+15550000001", handles })).toBe(lowest);
    expect(personRef({ id: "person:person-a", handles: ["email:person-a@example.com", "telegram:12345"] })).toBe(makeRef("person", { handle: "email:person-a@example.com" }));
    expect(personRef({ id: "contact:0123456789abcdef", handles: [] })).toBe(makeRef("person", { handle: "contact:0123456789abcdef" }));
    expect(readRef(lowest, "person", ["person"]).parts).toEqual({ handle: "phone:+15550000001" });
  });
});

describe("a string the door did not make", () => {
  const body = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const bytes = (...parts: (string | number[])[]): string =>
    Buffer.concat(parts.map(part => (typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part)))).toString("base64url");
  const record = makeRef("record", PARTS.record);
  const person = makeRef("person", { handle: "a" });
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const otherBits = person.slice(0, -1) + ALPHABET[ALPHABET.indexOf(person.at(-1)!) ^ 1];

  it.each([
    ["a handle", "r7"],
    ["C0's plain shape", "person:p1"],
    ["no kind", "WyJhIl0"],
    ["an empty string", ""],
    ["a kind no ref has", `photo.${body(["a"])}`],
    ["parts that are not base64url", "record.a+b/c="],
    ["parts that are not JSON", `record.${Buffer.from("not json").toString("base64url")}`],
    ["too few parts", `record.${body(["record", "whatsapp:1:x", "msg"])}`],
    ["a part of another type", `window.${body(["window", "m", "2026-11-02", "A", "", "N", "06:03"])}`],
    ["JSON not written as the door writes it", `record.${Buffer.from('["record", "s","k","x"]').toString("base64url")}`],
    ["a row whose query the contract refuses", `row.${body(["row", { of: "payments", by: ["item", "payee"] }, {}, [], 1])}`],
    ["a row that holds a cursor alone", `row.${body(["row", { cursor: "old-file-cursor" }, {}, [], 7])}`],
    ["a row that names no collection", `row.${body(["row", { measure: "amount" }, {}, [], 7])}`],
    ["a ref cut short", record.slice(0, -4)],
    ["parts with no kind inside", `person.${body(["a"])}`],
    ["the review's padding-bit spelling", "person.WyJhIl1"],
    ["the same bytes with other unused bits", otherBits],
    ["bytes that are not UTF-8", `person.${bytes('["person","', [0xff], '"]')}`],
    ["a prefix edited to another kind", `chat.${person.slice("person.".length)}`],
    ["a lone surrogate", `person.${Buffer.from('["person","\\ud800"]', "utf8").toString("base64url")}`],
  ])("refuses %s with BAD_PARAMETER, naming its member", (_, written) => {
    const refused = refusal(() => readRef(written, "chat"));
    expect(refused).toMatchObject({ status: 422, code: "BAD_PARAMETER" });
    expect(refused.words).toMatch(/^`chat` is not a ref this home made/u);
  });

  it("the premises of three refusals hold: the same bytes, a U+FFFD read, a surrogate JSON takes", () => {
    expect(otherBits).not.toBe(person);
    expect(Buffer.from(otherBits.slice("person.".length), "base64url")).toEqual(Buffer.from(person.slice("person.".length), "base64url"));
    expect(Buffer.from(bytes('["person","', [0xff], '"]'), "base64url").toString("utf8")).toBe('["person","\uFFFD"]');
    expect(JSON.parse('["person","\\ud800"]')[1]).toBe("\ud800");
    expect(readRef(person)).toEqual({ kind: "person", parts: { handle: "a" } });
  });

  it("a member that takes some kinds refuses a ref of another", () => {
    const refused = refusal(() => readRef(record, "chat", ["chat"]));
    expect(refused).toMatchObject({ code: "BAD_PARAMETER" });
    expect(refused.words).toBe("`chat` is not a ref of chat this home made (it is a record).");
    const edited = `chat.${person.slice("person.".length)}`;
    expect(refusal(() => readRef(edited, "chat", ["chat"])).words).toBe("`chat` is not a ref of chat this home made (its parts are not a chat's).");
  });
});
