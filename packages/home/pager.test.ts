import { describe, expect, it } from "vitest";
import { byHandles, HANDLE_CHARS, NoRoom, Room, sizeOf, type Cut, type Cutting } from "./pager.js";
import { Refusal } from "./refusal.js";
import { readAnswer, type Shape } from "./search-contract.js";

function pages<T>(item: T, size: number, how: Omit<Cutting, "from"> = {}): { pieces: T[]; sizes: number[] } {
  const pieces: T[] = [];
  const sizes: number[] = [];
  let from: Cut | undefined;
  for (let n = 0; n < 10_000; n++) {
    const room = new Room(size);
    room.state({ what: "page", items: [] });
    const got = room.admit(item, { ...how, from })!;
    pieces.push(got.piece);
    sizes.push(sizeOf({ what: "page", items: [got.piece] }));
    expect(room.left).toBeGreaterThanOrEqual(0);
    if (got.to === null) return { pieces, sizes };
    expect(got.to).not.toEqual(from);
    from = got.to;
  }
  throw new Error("the pages never ended");
}

describe("an item past the room", () => {
  it("a text: cut by its characters, every one given once, never a surrogate pair split, each page within its size", () => {
    const words = "ab😀".repeat(5_000);
    const { pieces, sizes } = pages({ ref: "r", text: words }, 2_000, { keep: ["ref"] });
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.map((piece) => piece.text).join("")).toBe(words);
    for (const piece of pieces) expect(piece.ref).toBe("r");
    for (const piece of pieces) expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(piece.text)).toBe(false);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(2_000);
  });

  it("any member, not text alone: a record's recipients, then its words, each given once in order, its text stated empty where a page holds none", () => {
    const to = Array.from({ length: 300 }, (_, n) => `Recipient ${n} <person-${n}@example.com>`);
    const record = { what: "record", ref: "record.x", family: "mail", title: "Synthetic subject", to, text: "w".repeat(9_000) };
    const { pieces, sizes } = pages(record, 4_000, { keep: ["what", "ref", "family"], need: ["text"] });
    expect(pieces.flatMap((piece) => piece.to ?? [])).toEqual(to);
    expect(pieces.map((piece) => piece.text).join("")).toBe(record.text);
    for (const piece of pieces) expect(piece).toMatchObject({ what: "record", ref: "record.x", family: "mail", text: expect.any(String) });
    expect(pieces.filter((piece) => piece.title !== undefined)).toHaveLength(1);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(4_000);
  });

  it("a nested list: a place's visits, each whole, newest first as given, its name on each page", () => {
    const visits = Array.from({ length: 2_000 }, (_, n) => ({ unit: `visit/${2_000 - n}`, start_ms: 2_000 - n, people: ["person-a"] }));
    const entry = { what: "place", ref: "place.x", place: { slug: "example-cafe", name: "Example Cafe", visits, photos_count: 3 } };
    const { pieces, sizes } = pages(entry, 20_000, { keep: ["what", "ref", "slug", "name", "unit", "start_ms"] });
    expect(pieces.flatMap((piece) => piece.place.visits ?? [])).toEqual(visits);
    for (const piece of pieces) expect(piece.place).toMatchObject({ slug: "example-cafe", name: "Example Cafe" });
    expect(pieces.at(-1)!.place.photos_count).toBe(3);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(20_000);
  });

  it("a row's cells: the first cut inside, those given before null on the page that goes on, every cell in its place", () => {
    const cells = ["a".repeat(50), "b".repeat(30_000), 42, null, "tail"];
    const { pieces } = pages(cells, 12_000, { tuple: true });
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(cells.length);
    const second = pieces.map((piece) => (typeof piece[1] === "string" ? piece[1] : "")).join("");
    expect(second).toBe(cells[1]);
    expect(pieces[0]![0]).toBe(cells[0]);
    for (const piece of pieces.slice(1)) expect(piece[0]).toBeNull();
    expect(pieces.at(-1)!.slice(2)).toEqual([42, null, "tail"]);
  });
});

describe("a page of several items", () => {
  it("each whole while it fits; a later one that does not ends the page (null), never cut to a sliver", () => {
    const room = new Room(1_000);
    expect(room.admit({ text: "x".repeat(400) })?.to).toBeNull();
    expect(room.admit({ text: "y".repeat(800) })).toBeNull();
  });

  it("an entry that may not cut its first item (a later ref of several): NoRoom, and what it took given back", () => {
    const room = new Room(1_000);
    room.admit({ text: "x".repeat(600) });
    const mark = room.mark();
    const end = room.begin(false);
    expect(() => room.admit({ text: "y".repeat(600) })).toThrow(NoRoom);
    room.back(mark);
    end();
    expect(room.left).toBe(mark);
  });

  it("a member held at its bound and settled at what it came to: the page measures it, never past the hold", () => {
    const room = new Room(500);
    const held = room.hold(200);
    expect(room.left).toBe(298);
    room.settle(held, { next: "abc" });
    expect(room.left).toBe(500 - 2 - (sizeOf({ next: "abc" }) - 1));
    expect(() => room.hold(10_000)).toThrow(NoRoom);
  });
});

describe("a cut bound to its item", () => {
  it("the item changed since its page was cut: CURSOR_EXPIRED, never one version's start joined to another's end", () => {
    const room = new Room(1_000);
    const got = room.admit({ text: "a".repeat(5_000) })!;
    expect(got.to).not.toBeNull();
    const again = new Room(1_000);
    let code = "";
    try {
      again.admit({ text: `${"a".repeat(4_999)}b` }, { from: got.to! });
    } catch (error) {
      code = error instanceof Refusal ? error.code : "thrown";
    }
    expect(code).toBe("CURSOR_EXPIRED");
  });
});

describe("a model reader's room", () => {
  const measure = byHandles(readAnswer as Shape<unknown>);
  const line = (n: number) => ({ ref: `line.${"x".repeat(400)}${n}`, text: `synthetic line ${n}`, cites: [`record.${"y".repeat(400)}${n}`, `record.${"z".repeat(400)}${n}`] });
  const filled = (room: Room): number => {
    room.state({ what: "lines", lines: [] });
    let n = 0;
    while (room.admit(line(n)) !== null) n++;
    return n;
  };

  it("counts each ref and cursor at a handle's length, every other member as written", () => {
    const handle = "h".repeat(HANDLE_CHARS - 2);
    expect(measure(line(1))).toBe(sizeOf({ ref: handle, text: "synthetic line 1", cites: [handle, handle] }));
    expect(measure({ what: "lines", span: { from: "2026-11-02", to: "2026-11-02" }, lines: [line(1)], next: "c".repeat(900) }))
      .toBe(sizeOf({ what: "lines", span: { from: "2026-11-02", to: "2026-11-02" }, lines: [{ ref: handle, text: "synthetic line 1", cites: [handle, handle] }], next: handle }));
    expect(measure({ ref: "r1", next: null })).toBe(sizeOf({ ref: "r1", next: null }));
  });

  it("a page of long refs fits by handles: many lines where its full text holds a few", () => {
    const full = filled(new Room(3_000));
    const handled = filled(new Room(3_000, measure));
    expect(full).toBeLessThan(3);
    expect(handled).toBeGreaterThan(30);
  });
});
