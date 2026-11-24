import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BlobError, diskFailed, openHome, openHomeFolder, type BlobStore, type HomeDb, type Json, type ReaderOutput, type View } from "@lifestreamprotocol/core";
import { screenFamily, type Change, type Extracted, type Family } from "@lifestreamprotocol/families";
import { RELEASE_FED } from "./test/fed.js";
import { extractCursor, extractKind, rebuildCursor, rebuildExtracts, walkKind } from "./derive.js";
import { LANE, type HelperEnv, type Main, type Running } from "./jobs.js";
import { drain, screenBacklog } from "./test/backlog.js";
import { land, removeDir, tempDir } from "./test/ops-support.js";

const NAME = "sample";
const SOURCE = "apple-notes:local:device-a";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EARLY = Date.UTC(2026, 5, 1, 12);
const LATE = Date.UTC(2026, 5, 22, 8);
const SETTINGS = { zone: "UTC", day_start_hour: 4 };

type Build = (view: View) => Extracted | null;

const built = (unit: string, code: string, content: Json = { unit, code }): Extracted => ({ content, start_ms: EARLY, end_ms: EARLY, reading: `${unit}-${code}` });

function family(code: string, builds: Record<string, Build> = {}): Family {
  return {
    name: NAME, code, inputs: [{ sources: { product: ["apple-notes"] }, kinds: ["msg"], role: "evidence" }],
    touched: (changes: readonly Change[]) => changes.flatMap((change) => {
      const { units, previous } = change.after!.content as { units: string[]; previous?: string };
      return units.map((unit) => ({ unit, ...(previous === undefined ? {} : { previous }) }));
    }),
    extract: (unit: string, view: View) => {
      const build = builds[unit];
      return build === undefined ? built(unit, code) : build(view);
    },
    days: () => [],
  } as unknown as Family;
}

const record = (key: string, at: number, units: string[], previous?: string): ReaderOutput => ({
  kind: "msg", key, time: { start_ms: at, precision: "ms" }, content: { units, ...(previous === undefined ? {} : { previous }) },
});

const throws = (unit: string): Build => () => {
  throw new Error(`${unit} is malformed`);
};
const late = (view: View): boolean => [...view.records(SOURCE, "msg", { start_ms: LATE, end_ms: LATE + 1 })].length > 0;

function open() {
  const dir = tempDir("extract-aside");
  const db = openHome(openHomeFolder(dir), "migrate");
  const reader = openHome(openHomeFolder(dir), "read");
  const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
  onTestFinished(() => {
    reader.close();
    db.close();
    removeDir(dir);
  });
  let deliveries = 0;
  const view = <T>(read: (view: ReturnType<HomeDb["view"]>) => T): T => {
    const opened = db.view();
    try {
      return read(opened);
    } finally {
      opened.close();
    }
  };
  return {
    db, reader, blobs,
    ship: (...rows: ReaderOutput[]) => land(db, { source: SOURCE, stated_ms: EARLY + ++deliveries, rows, name: `delivery-${deliveries}` }),
    run: (each: Family) => drain(db, reader, blobs, each),
    walk: async (each: Family) => {
      db.commit((tx) => rebuildExtracts(tx, NAME, 0));
      return drain(db, reader, blobs, each);
    },
    rows: () => view((read) => [...read.extracts(NAME)].map(({ unit, code, reading }) => ({ unit, code, reading }))),
    codes: () => view((read) => [...read.extracts(NAME)].map(({ unit, code }) => [unit, code])),
    aside: () => db.commit((tx) => tx.derived.extracts.aside.list(NAME)).map(({ unit, error }) => ({ unit, error })),
    cursor: () => view((read) => ({ seq: read.tables.cursors.get(extractCursor(NAME))!.seq, through: read.through })),
    walkOwed: () => view((read) => read.tables.cursors.get(rebuildCursor(NAME))?.seq ?? 0) > 0,
    place: () => {
      const text = view((read) => read.tables.meta.get(`walk:${NAME}`));
      return text === undefined ? undefined : JSON.parse(text) as { log?: string; aside: string[]; errors?: Record<string, string> };
    },
  };
}

async function walkRun(home: ReturnType<typeof open>, plain: Family) {
  const walk = begin(home, plain, "walk");
  let step = await walk.steps.next();
  for (; step.done !== true; step = await walk.steps.next()) walk.commit(step.value);
  return { walk, result: step.value };
}

function begin(home: ReturnType<typeof open>, plain: Family, name: "extract" | "walk" = "extract") {
  const kind = (name === "walk" ? walkKind : extractKind) as unknown as typeof extractKind;
  const main = { families: new Map([[plain.name, plain]]), now: () => EARLY, log: () => undefined } as unknown as Main;
  const env = { db: home.reader, folder: openHomeFolder(join(home.db.path, "..")), blobs: home.blobs, registry: { connectors: [], families: [plain] }, settings: { day: SETTINGS }, committed: async () => undefined } as unknown as HelperEnv;
  const job = { id: 1, kind: name, key: plain.name, lane: LANE.backfill, not_before_ms: 0, started_ms: 0 } as never;
  const begun = home.db.commit((tx) => kind.begin!(main, tx, job))!;
  const running: Running<typeof begun.state> = { job, state: begun.state };
  const steps = kind.helper(env, { job: 1, kind: name, key: plain.name, lane: LANE.backfill, now_ms: 0, data: begun.data });
  return {
    running, steps, holds: begun.holds,
    commit: (chunk: Parameters<NonNullable<typeof extractKind.chunk>>[2]) => {
      for (const slice of kind.chunk!(main, running, chunk)) home.db.commit((tx) => slice.work(tx));
    },
    done: (result: Parameters<typeof extractKind.done>[3]) => home.db.commit((tx) => kind.done(main, tx, running, result)),
  };
}

describe("a run with units that throw", () => {
  it("a run whose every unit throws fails the job, or leaves the cursor behind", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["a"]), record("r2", EARLY + DAY, ["b"]), record("r3", EARLY + 2 * DAY, ["c"]));
    await home.run(family("1", { a: throws("a"), b: throws("b"), c: throws("c") }));
    expect(home.aside()).toEqual([{ unit: "a", error: "a is malformed" }, { unit: "b", error: "b is malformed" }, { unit: "c", error: "c is malformed" }]);
    expect(home.rows()).toEqual([]);
    expect(home.cursor().seq).toBe(home.cursor().through);
  });

  it("a value with no canonical form or a time no column holds stops the batch, in the run and in the walk", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["good", "nan", "surrogate", "fraction", "day", "item"]));
    const bad = (code: string): Record<string, Build> => ({
      nan: () => built("nan", code, { value: Number.NaN }),
      surrogate: () => built("surrogate", code, { value: "cut \ud83d" }),
      fraction: () => ({ ...built("fraction", code), end_ms: EARLY + 0.5 }),
    });
    const expected = [
      { unit: "fraction", error: expect.stringContaining("no whole millisecond") as string },
      { unit: "nan", error: expect.stringContaining("non-finite number NaN") as string },
      { unit: "surrogate", error: expect.stringContaining("lone surrogate") as string },
    ];
    const withRow = (code: string): Family => ({
      ...family(code, bad(code)),
      days: (row) => (row.unit === "day" ? ["cut \ud83d"] : []),
      items: (row) => (row.unit === "item" ? [{ item: "cut \ud83d", prompt: "p" }] : []),
    });
    const both = [...expected, { unit: "day", error: expect.stringContaining("lone surrogate") as string }, { unit: "item", error: expect.stringContaining("lone surrogate") as string }].sort((left, right) => left.unit.localeCompare(right.unit));
    await home.run(withRow("1"));
    expect(home.aside()).toEqual(both);
    expect(home.codes()).toEqual([["good", "1"]]);
    await home.walk(withRow("2"));
    expect(home.aside()).toEqual(both);
    expect(home.codes()).toEqual([["good", "2"]]);
  });

  it("a previous unit survives beside a set-aside unit, or a set-aside unit is written", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["left", "stands"]));
    await home.run(family("1"));
    const stood = home.rows().find((row) => row.unit === "stands");
    home.ship(record("r2", EARLY + DAY, ["stands"], "left"));
    await home.run(family("1", { stands: throws("stands") }));
    expect(home.rows()).toEqual([stood]);
    expect(home.aside()).toEqual([{ unit: "stands", error: "stands is malformed" }]);
  });

  it("a unit whose blob the disk fails to look for is set aside and its run moves on, where the job fails and is tried again", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["a"]), record("r2", EARLY + DAY, ["b"]));
    const asks: Family = { ...family("1"), extract: (unit: string, _view: View, files: BlobStore) => {
      files.has(`sha256:${"0".repeat(64)}`);
      return built(unit, "1");
    } } as unknown as Family;
    const eio = Object.assign(new Error("EIO: i/o error, access"), { code: "EIO" });
    const failing = new Proxy(home.blobs, {
      get: (target, property) => {
        if (property === "has") return () => { throw new BlobError("BLOB_NOT_STORED", `whether a blob is stored cannot be read: ${eio.message}`, { cause: eio }); };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const thrown = await drain(home.db, home.reader, failing, asks).then(() => undefined, (error: unknown) => error);
    expect([diskFailed(thrown), home.aside(), home.rows(), home.cursor().seq < home.cursor().through]).toEqual([true, [], [], true]);
    await drain(home.db, home.reader, home.blobs, asks);
    expect([home.aside(), home.rows().map((row) => row.unit)]).toEqual([[], ["a", "b"]]);
  });

  it("a failure count stops healthy work: the bad units met first leave the healthy ones behind them lost", async () => {
    const home = open();
    screenBacklog(home.db, 12, 1);
    const plain = screenFamily({ zone: "UTC" })(RELEASE_FED.screen);
    let clock = 0;
    const bad = new Set<string>();
    const slow: Family = { ...plain, extract: (unit, ...rest) => {
      clock += 25_000;
      if (bad.size < 3) bad.add(unit);
      if (bad.has(unit)) throw new Error(`${unit} is malformed`);
      return plain.extract(unit, ...rest);
    } };
    const aside = () => home.db.commit((tx) => tx.derived.extracts.aside.list(plain.name)).map((row) => row.unit).sort();
    const units = () => {
      const view = home.db.view();
      try {
        return [...view.extracts(plain.name)].map((row) => row.unit);
      } finally {
        view.close();
      }
    };
    const ran: { built: string[]; more: boolean; aside: string[]; served: number; cursor: number; through: number }[] = [];
    const clocked = vi.spyOn(performance, "now").mockImplementation(() => clock);
    onTestFinished(() => clocked.mockRestore());
    await drain(home.db, home.reader, home.blobs, slow, { afterRun: ({ built: tried, more }) => {
      const stood = { built: tried, more, aside: aside(), served: units().length };
      const view = home.db.view();
      ran.push({ ...stood, cursor: view.tables.cursors.get(extractCursor(plain.name))!.seq, through: view.through });
      view.close();
    } });
    expect(ran[0]).toMatchObject({ built: [...bad], more: true, aside: [...bad].sort(), served: 0 });
    expect(ran[0]!.cursor).toBe(ran[0]!.through);
    expect(aside()).toEqual([...bad].sort());
    expect(units().length).toBe(9);
    expect(units().some((unit) => bad.has(unit))).toBe(false);
  });
});

describe("a walk with units that throw", () => {
  it("a release that throws on every unit takes every served row", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["a", "b"]), record("r2", LATE, ["c"]));
    await home.run(family("1"));
    const served = home.rows();
    await home.walk(family("2", { a: throws("a"), b: throws("b"), c: throws("c") }));
    expect(home.rows()).toEqual(served);
    expect(home.aside().map((row) => row.unit)).toEqual(["a", "b", "c"]);
    expect(home.walkOwed()).toBe(false);
  });

  it("a walk's slabs disagree about a unit, and its last outcome does not stand", async () => {
    const home = open();
    home.ship(
      record("a1", EARLY, ["thenThrows"]), record("a2", EARLY, ["thenBuilt"]), record("a3", EARLY, ["thenNamedGone"]), record("a4", EARLY, ["thenObsolete"]),
      record("l1", LATE, ["later", "thenThrows", "thenBuilt"]), record("l2", LATE + HOUR, ["later"], "thenNamedGone"),
    );
    await home.run(family("1"));
    expect(home.rows().length).toBe(5);
    const fam = family("2", {
      thenThrows: (view) => {
        if (late(view)) throw new Error("thenThrows is malformed");
        return built("thenThrows", "2");
      },
      thenBuilt: (view) => {
        if (!late(view)) throw new Error("thenBuilt is malformed");
        return built("thenBuilt", "2");
      },
      thenNamedGone: throws("thenNamedGone"),
      thenObsolete: (view) => {
        if (!late(view)) throw new Error("thenObsolete is malformed");
        return null;
      },
    });
    await home.walk(fam);
    expect(home.codes()).toEqual([["later", "2"], ["thenBuilt", "2"], ["thenObsolete", "1"], ["thenThrows", "1"]]);
    await home.run(fam);
    expect(home.codes()).toEqual([["later", "2"], ["thenBuilt", "2"], ["thenThrows", "1"]]);
    expect(home.aside()).toEqual([{ unit: "thenThrows", error: "thenThrows is malformed" }]);
  });

  it("a log read's build reads the family's served rows, not the next generation", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["reader"]), record("r2", LATE, ["read"]));
    await home.run(family("1"));
    home.db.commit((tx) => rebuildExtracts(tx, NAME, 0));
    const fam = family("2", {
      reader: (view) => {
        if (view.extract(NAME, "read")?.code !== "2") throw new Error("reader read no row of this generation");
        return built("reader", "2");
      },
    });
    for (let runs = 0; runs < 12 && home.place()?.log === undefined; runs++) {
      const { walk, result } = await walkRun(home, fam);
      walk.done(result);
    }
    expect(home.place()).toEqual(expect.objectContaining({ log: "reading", aside: ["reader"] }));
    home.ship(record("r3", EARLY + HOUR, ["reader"]));
    for (let runs = 0; runs < 12 && home.walkOwed(); runs++) {
      const { walk, result } = await walkRun(home, fam);
      walk.done(result);
    }
    expect({ walkOwed: home.walkOwed(), aside: home.aside(), codes: home.codes() }).toEqual({ walkOwed: false, aside: [], codes: [["read", "2"], ["reader", "2"]] });
  });

  it("a unit whose build needs a row the closing stage built late is published without its served row, or is never built", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["reader"]));
    await home.run(family("1"));
    home.db.commit((tx) => rebuildExtracts(tx, NAME, 0));
    const fam = family("2", {
      reader: (view) => {
        if (view.extract(NAME, "read")?.code !== "2") throw new Error("reader read no row of this generation");
        return built("reader", "2");
      },
    });
    for (let runs = 0; runs < 12 && home.place()?.log !== "closing"; runs++) {
      const { walk, result } = await walkRun(home, fam);
      walk.done(result);
    }
    expect(home.place()).toEqual(expect.objectContaining({ log: "closing", aside: ["reader"] }));
    home.ship(record("r2", LATE, ["read"]));
    const closing = await walkRun(home, fam);
    closing.walk.done(closing.result);
    expect({ walkOwed: home.walkOwed(), aside: home.aside().map((row) => row.unit), codes: home.codes() }).toEqual({
      walkOwed: false, aside: ["reader"], codes: [["read", "2"], ["reader", "1"]],
    });
    await home.run(fam);
    expect({ aside: home.aside(), codes: home.codes() }).toEqual({ aside: [], codes: [["read", "2"], ["reader", "2"]] });
  });

  it("a log read stopped after its last commit, before its end, loses a throw it met, or keeps an error it cleared", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["fails", "mends", "fine"]));
    await home.run(family("1"));
    const served = home.rows();
    home.db.commit((tx) => rebuildExtracts(tx, NAME, 0));
    const fam = family("2", {
      fails: throws("fails"),
      mends: (view) => {
        if (!late(view)) throw new Error("mends is malformed");
        return built("mends", "2");
      },
    });
    const slabs = await walkRun(home, fam);
    slabs.walk.done(slabs.result);
    home.ship(record("r1b", EARLY + HOUR, ["fails", "mends"]));
    await walkRun(home, fam);
    expect(home.place()).toEqual(expect.objectContaining({ log: "reading", aside: ["fails", "mends"], errors: { fails: "fails is malformed", mends: "mends is malformed" } }));
    const again = await walkRun(home, fam);
    again.walk.done(again.result);
    home.ship(record("r2", LATE, ["mends"]));
    await walkRun(home, fam);
    expect(home.place()).toEqual(expect.objectContaining({ log: "closing", aside: ["fails"], errors: { fails: "fails is malformed" } }));
    const closing = await walkRun(home, fam);
    closing.walk.done(closing.result);
    expect({ walkOwed: home.walkOwed(), aside: home.aside(), rows: home.rows() }).toEqual({
      walkOwed: false,
      aside: [{ unit: "fails", error: "fails is malformed" }],
      rows: [served.find((row) => row.unit === "fails"), { unit: "fine", code: "2", reading: "fine-2" }, { unit: "mends", code: "2", reading: "mends-2" }],
    });
  });
});

describe("a generation reset with a set-aside in play", () => {
  it("a run's late commit clears or writes the set-aside under a turned cursor", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["held"]));
    await home.run(family("1", { held: throws("held") }));
    const stood = home.aside();
    home.ship(record("r2", EARLY + DAY, ["held", "fresh"]));
    const run = begin(home, family("1", { fresh: throws("fresh") }));
    const first = await run.steps.next();
    expect(first.done).toBe(false);
    const cursor = home.cursor().seq;
    home.db.commit((tx) => tx.tables.cursors.turn(extractCursor(NAME), 0));
    run.commit(first.value as never);
    expect(run.running.stale).toBe(true);
    expect({ aside: home.aside(), rows: home.rows(), cursor: home.cursor().seq }).toEqual({ aside: stood, rows: [], cursor });
    expect(cursor).toBeGreaterThan(0);
  });

  it("a walk's late publish replaces the set-aside under a reset cursor, and the next walk does not", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["held", "good"]));
    await home.run(family("1", { held: throws("held") }));
    const stood = home.aside();
    const served = home.rows();
    home.db.commit((tx) => rebuildExtracts(tx, NAME, 0));
    const fam = family("2", { good: throws("good") });
    for (let runs = 0; runs < 2; runs++) {
      const { walk, result } = await walkRun(home, fam);
      walk.done(result);
    }
    const { walk, result } = await walkRun(home, fam);
    expect(home.place()?.aside).toEqual(["good"]);
    const step = { value: result };
    home.db.commit((tx) => rebuildExtracts(tx, NAME, 0));
    walk.done(step.value);
    expect(walk.running.stale).toBe(true);
    expect({ aside: home.aside(), rows: home.rows() }).toEqual({ aside: stood, rows: served });
    await home.run(family("2", { good: throws("good") }));
    expect(home.aside()).toEqual([{ unit: "good", error: "good is malformed" }]);
    expect(home.codes()).toEqual([["good", "1"], ["held", "2"]]);
  });
});

describe("a walk's closing run beside an ordinary run", () => {
  it("a slabs run or a first log read holds the ordinary run, or a closing run does not", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["one"]));
    await home.run(family("1"));
    home.db.commit((tx) => rebuildExtracts(tx, NAME, 0));
    const fam = family("2");
    const held: Record<string, readonly string[] | undefined> = {};
    for (const stage of ["slabs", "reading", "closing"]) {
      const walk = begin(home, fam, "walk");
      held[stage] = walk.holds;
      let step = await walk.steps.next();
      for (; step.done !== true; step = await walk.steps.next()) walk.commit(step.value);
      walk.done(step.value);
    }
    expect({ held, walkOwed: home.walkOwed() }).toEqual({ held: { slabs: undefined, reading: undefined, closing: [`extract:${NAME}`] }, walkOwed: false });
  });

  it("an ordinary run in flight when a closing run begins commits after it, or what it read is not served by the publish", async () => {
    const home = open();
    home.ship(record("r1", EARLY, ["one"]));
    await home.run(family("1"));
    home.db.commit((tx) => rebuildExtracts(tx, NAME, 0));
    const fam = family("2");
    for (let runs = 0; runs < 2; runs++) {
      const walk = begin(home, fam, "walk");
      let step = await walk.steps.next();
      for (; step.done !== true; step = await walk.steps.next()) walk.commit(step.value);
      walk.done(step.value);
    }
    home.ship(record("r2", LATE, ["two"]));
    home.db.commit((tx) => {
      tx.tables.jobs.enqueue({ kind: "extract", key: NAME, lane: LANE.live, not_before_ms: 0, now_ms: 0 });
      tx.tables.jobs.take(EARLY, [LANE.live]);
    });
    const run = begin(home, fam);
    const read = await run.steps.next();
    expect(read.done).toBe(false);
    await run.steps.return(undefined as never);
    const closing = begin(home, fam, "walk");
    run.commit(read.value as never);
    expect({ stale: run.running.stale, rows: home.rows().map((row) => row.unit) }).toEqual({ stale: true, rows: ["one"] });
    let step = await closing.steps.next();
    for (; step.done !== true; step = await closing.steps.next()) closing.commit(step.value);
    closing.done(step.value);
    expect({ walkOwed: home.walkOwed(), rows: home.codes(), cursor: home.cursor().seq }).toEqual({ walkOwed: false, rows: [["one", "2"], ["two", "2"]], cursor: home.cursor().through });
  });
});
