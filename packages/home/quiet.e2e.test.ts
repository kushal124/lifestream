import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyLanded, importSubject, type JobRow, type Json, type JsonObject, openHomeFolder } from "@lifestreamprotocol/core";
import { basicInstant, MANIFEST_FILE, openSealing } from "./inbox.js";
import { importKind, routes } from "./import.js";
import type { Running } from "./jobs.js";
import { phoneShare } from "./phone.js";
import { mintPrincipal } from "./principals.js";
import { LEFT_FOLDED, passAhead, QUIET_DONE, quietOf } from "./quiet.js";
import { applyThrough } from "./through.js";
import { artifact } from "./test/harness-root.js";
import {
  COAST_SOURCE, heartbeatFacts, look, MAC_SOURCE, mainOf, MINUTE, PASS_P, phoneFacts, PHONE_LANE, PHONE_OTHER, PHONE_SOURCE, PHONE_UNIT, quietRun, sealed, settled,
  nudge, ship, statement, throughHome, value, type ThroughHome,
} from "./test/through.js";

const { FakeCoast } = (await import(new URL("../connect/screen/coast/test/fixture.ts", import.meta.url).href)) as typeof import("../connect/screen/coast/test/fixture.js");
const { coastAcquirer } = (await import(new URL("../connect/screen/coast/acquirer.ts", import.meta.url).href)) as typeof import("../connect/screen/coast/acquirer.js");
const { LENT } = (await import(new URL("../connect/test/drive.ts", import.meta.url).href)) as typeof import("../connect/test/drive.js");

const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
const at = (minutes: number): number => T0 + minutes * MINUTE;
const iso = (ms: number): string => new Date(ms).toISOString();
const row = (source: string, facts: JsonObject, seal: number | null = null, run: number | null = null) => ({ source, facts, seal, stated_ms: at(1), run });
const PLACES = `places:local:${PHONE_UNIT}`;
const line = (counts: Partial<Record<"folded" | "fold_rows" | "settled" | "held" | "rows" | "directories" | "kept" | "left", number>>) => ({
  quiet: { folded: 0, fold_rows: 0, fold_ms: expect.any(Number), settled: 0, held: 0, rows: 0, directories: 0, kept: 0, left: 0, ...counts },
});

describe("what a quiet row is", () => {
  it("reads Coast's real fetch of nothing and a Mac heartbeat as quiet, and nothing that carries", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "lifestream-quiet-coast-"));
    const live = join(dir, "rem.db");
    const store = new FakeCoast(live, "id", { wal: true });
    try {
      mkdirSync(join(dir, "videos"));
      let now = at(60);
      const acquirer = coastAcquirer({ unit: "macbook-pro-0001", database: live, videos: join(dir, "videos"), settle_ms: MINUTE, work: join(dir, "work"), clock: () => now });
      const nothing = await acquirer.fetch(null, { get: () => undefined, rotate: () => undefined }, LENT);
      expect([nothing.files.length, quietOf(row(COAST_SOURCE, nothing.facts))]).toEqual([0, { through: at(59) }]);
      store.video(1, "a".repeat(64));
      store.segment(1, at(10), null);
      store.frame(1, at(10), 1);
      now = at(70);
      const frames = await acquirer.fetch(nothing.state, { get: () => undefined, rotate: () => undefined }, LENT);
      expect(frames.files.length).toBeGreaterThan(0);
      expect(quietOf(row(COAST_SOURCE, frames.facts))).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(quietOf(row(MAC_SOURCE, heartbeatFacts(at(2), at(1))))).toEqual({ through: at(1) });
    expect(quietOf(row(MAC_SOURCE, heartbeatFacts(at(2), at(1), { left: 40, start_ms: null })))).toEqual({ through: at(1) });
    expect(quietOf(row(PHONE_SOURCE, phoneFacts(at(1), ["health"])))).toEqual({ through: at(1) });
    expect(quietOf(row(PHONE_SOURCE, phoneFacts(at(1), ["health"], [PHONE_SOURCE])))).toEqual({ through: null });
    expect([phoneShare(phoneFacts(at(1), ["location"]), PLACES), phoneShare({ left: 0 }, PLACES)]).toEqual(["none", "lines"]);
    expect(quietOf(row(PLACES, phoneFacts(at(1), ["location", "health"])))).toEqual({ through: at(1) });
    expect(quietOf(row(PLACES, phoneFacts(at(1), ["location", "health"]), null, 7))).toBeUndefined();
    expect(quietOf(row(PHONE_SOURCE, phoneFacts(at(1), ["health"]), null, 7))).toEqual({ through: at(1) });
    expect(quietOf(row(MAC_SOURCE, heartbeatFacts(at(2), at(1)), 3))).toBeUndefined();
    expect(quietOf(row(MAC_SOURCE, { left: 0, history: true, start_ms: null }))).toBeUndefined();
    expect(quietOf(row(PHONE_SOURCE, phoneFacts(at(1), ["location"])))).toBeUndefined();
    expect(quietOf(row(MAC_SOURCE, { snapshot_taken_at: iso(at(2)), read_through: "yesterday" }))).toBeUndefined();
  });
});

describe("the quiet rows", () => {
  let home: ThroughHome | undefined;
  const seen: Record<string, unknown> = {};
  const open = (): ThroughHome => (home = throughHome("lifestream-quiet-", at(600)));
  afterEach(() => {
    if (home === undefined) return;
    artifact(home.root, "quiet", seen);
    home.close();
    home = undefined;
  });
  const states = (h: ThroughHome, source: string): string[] => h.db.commit((tx) => tx.tables.deliveries.list().filter((each) => each.source === source).map((each) => each.state));
  const phoneRow = (h: ThroughHome, source: string, n: number, carries: readonly string[], sat_out: readonly string[] = [], seal?: number) =>
    h.commit((tx) => sealed(tx, { id: `phone:iphone-aa01/${String(n).padStart(4, "0")}`, source, sealed_ms: at(n), pass: PASS_P, ...(seal === undefined ? {} : { seal }), facts: phoneFacts(at(n), carries, sat_out) }));

  it("begin settles a phone source's leading quiet rows in order and hands its first carrying row; a row sat out moves nothing", () => {
    const h = open();
    phoneRow(h, PHONE_SOURCE, 1, ["health"]);
    phoneRow(h, PHONE_SOURCE, 2, ["health"], [PHONE_SOURCE]);
    phoneRow(h, PHONE_SOURCE, 3, ["location"], [], 1);
    phoneRow(h, PHONE_SOURCE, 4, ["health"]);
    const next = h.commit((tx) => passAhead(mainOf(h), tx, PHONE_SOURCE, undefined));
    expect(next?.facts).toEqual(phoneFacts(at(3), ["location"]));
    expect(states(h, PHONE_SOURCE)).toEqual(["imported", "imported", "sealed", "sealed"]);
    expect(h.readThrough(PHONE_SOURCE)).toBe(at(1));
  });

  it("folds the `left` the rows hold, newest by statement, resuming after a kill, never over a value stated since", async () => {
    const h = open();
    h.commit((tx) => {
      sealed(tx, { id: "lane-mac/stated-late", source: MAC_SOURCE, sealed_ms: at(1), stated_ms: at(3), pass: PASS_P, facts: heartbeatFacts(at(3), at(2), { left: 0, start_ms: null }) });
      sealed(tx, { id: "lane-mac/stated-early", source: MAC_SOURCE, sealed_ms: at(4), stated_ms: at(1), pass: PASS_P, facts: { left: 100, start_ms: null, history: true } });
      sealed(tx, { id: "phone:iphone-aa01/page", source: PHONE_OTHER, sealed_ms: at(2), pass: PASS_P, facts: { ...phoneFacts(at(2), ["health"]), left: 9 } });
      sealed(tx, { id: "phone:iphone-aa01/later", source: PHONE_SOURCE, sealed_ms: at(2), pass: PASS_P, facts: { ...phoneFacts(at(2), ["location"]), left: 5 } });
      sealed(tx, { id: "poll/page", source: COAST_SOURCE, sealed_ms: at(2), facts: { left: 3, history: true, start_ms: null } });
    });
    h.commit((tx) => applyThrough(tx, PHONE_SOURCE, statement(value(at(6), at(6), { left: 1 })), h.now));
    const lines: Json[] = [];
    expect(await quietRun(h, lines, { commits: 1 })).toBe(false);
    expect(h.kept(MAC_SOURCE).left).toBeNull();
    expect(h.kept(PHONE_OTHER).left).toEqual({ left: 9, stated_ms: at(2), from: "delivery" });
    expect(await quietRun(h, lines)).toBe(true);
    expect(h.kept(MAC_SOURCE).left).toEqual({ left: 0, start_ms: null, stated_ms: at(3), from: "delivery" });
    expect(h.kept(PHONE_SOURCE).left).toEqual({ left: 1, stated_ms: at(6), from: "value" });
    expect(h.kept(COAST_SOURCE).left).toBeNull();
    expect(h.db.commit((tx) => tx.tables.meta.get(LEFT_FOLDED))).toBe(String(h.now));
    expect(lines).toEqual([line({ folded: 2, fold_rows: 3, left: 1 })]);
    seen.fold = { lines, mac: h.kept(MAC_SOURCE), phone: h.kept(PHONE_SOURCE) };
  });

  it("drains the quiet rows of a source that is off or has no connector, in order, a batch a commit; leaves a paused source's, counted held", async () => {
    const h = open();
    const GONE = "location:local:iphone-aa02";
    const PAUSED = "apple-health:local:iphone-aa02";
    h.commit((tx) => {
      tx.tables.sources.add({ id: GONE, vendor: "apple", connector: "gone-reader", added_ms: 0 });
      tx.tables.sources.add({ id: PAUSED, vendor: "apple", connector: "fake-rows", added_ms: 0 });
      tx.tables.controls.set({ target: `import:${PAUSED}`, reason: "a test", at_ms: 0, by: "you" });
    });
    phoneRow(h, PHONE_SOURCE, 1, ["health"]);
    phoneRow(h, PHONE_SOURCE, 2, ["health"]);
    phoneRow(h, PHONE_SOURCE, 3, ["location"], [], 1);
    phoneRow(h, PHONE_SOURCE, 4, ["health"]);
    for (let n = 1; n <= 600; n++) phoneRow(h, GONE, n, ["health"], n === 600 ? [GONE] : []);
    for (let n = 1; n <= 3; n++) phoneRow(h, PAUSED, n, ["location"]);
    phoneRow(h, PHONE_OTHER, 1, ["location"]);
    const lines: Json[] = [];
    expect(await quietRun(h, lines, { off: [PHONE_SOURCE], commits: 2 })).toBe(false);
    expect(states(h, GONE).filter((state) => state === "imported")).toHaveLength(493);
    expect(await quietRun(h, lines, { off: [PHONE_SOURCE] })).toBe(true);
    expect(lines).toEqual([line({ settled: 107, rows: 603, left: 4 })]);
    expect(states(h, PHONE_SOURCE)).toEqual(["sealed"]);
    expect([h.readThrough(PHONE_SOURCE), h.kept(PHONE_SOURCE).heard_ms]).toEqual([at(2), at(4)]);
    expect(states(h, GONE)).toEqual([]);
    expect([h.readThrough(GONE), h.kept(GONE).heard_ms]).toEqual([at(599), at(600)]);
    expect(states(h, PAUSED)).toEqual(["sealed", "sealed", "sealed"]);
    expect(states(h, PHONE_OTHER)).toEqual(["sealed"]);
    expect(await quietRun(h, lines, { off: [PHONE_SOURCE] })).toBe(true);
    expect(lines.at(-1)).toEqual(line({ held: 3, left: 4 }));
    expect(h.db.commit((tx) => tx.tables.meta.get(QUIET_DONE))).toBeUndefined();
    seen.drain = lines;
  });

  it("leaves a paused source's rows, counted held, though it is off or has no connector: nothing moves", async () => {
    const h = open();
    const GONE = "location:local:iphone-aa02";
    h.commit((tx) => {
      tx.tables.sources.add({ id: GONE, vendor: "apple", connector: "gone-reader", added_ms: 0 });
      for (const source of [PHONE_SOURCE, GONE]) tx.tables.controls.set({ target: `import:${source}`, reason: "a test", at_ms: 0, by: "you" });
    });
    for (let n = 1; n <= 2; n++) {
      phoneRow(h, PHONE_SOURCE, n, ["health"]);
      phoneRow(h, GONE, n, ["health"]);
    }
    const lines: Json[] = [];
    expect(await quietRun(h, lines, { off: [PHONE_SOURCE] })).toBe(true);
    expect(lines).toEqual([line({ held: 4, left: 4 })]);
    expect([states(h, PHONE_SOURCE), states(h, GONE)]).toEqual([["sealed", "sealed"], ["sealed", "sealed"]]);
    expect([h.readThrough(PHONE_SOURCE), h.readThrough(GONE)]).toEqual([null, null]);
  });

  it("leaves the rows of a source whose import is running to it", async () => {
    const h = open();
    phoneRow(h, PHONE_SOURCE, 1, ["health"]);
    h.commit((tx) => {
      tx.tables.jobs.enqueue({ kind: "import", key: PHONE_SOURCE, connector: null, lane: 0, not_before_ms: 0, now_ms: 0 });
      tx.tables.jobs.take(h.now, [0]);
    });
    expect(await quietRun(h, [], { off: [PHONE_SOURCE] })).toBe(true);
    expect(states(h, PHONE_SOURCE)).toEqual(["sealed"]);
  });

  it("Places: a phone shipment carries nothing of it, so routes feeds it none and the drain settles its rows while it is off", async () => {
    const h = open();
    h.commit((tx) => tx.tables.sources.add({ id: PLACES, vendor: "apple", connector: "fake-rows", added_ms: 0 }));
    const { principal } = mintPrincipal(openHomeFolder(h.root), {
      unit: PHONE_UNIT, kind: "phone", scopes: ["deliver"], sources: [PHONE_SOURCE, PHONE_OTHER, PLACES], now_ms: h.now,
    });
    h.commit((tx) => {
      for (const source of [PHONE_SOURCE, PHONE_OTHER, PLACES]) tx.tables.sources.restate(source, { lane: PHONE_LANE });
    });
    const sources = h.db.commit((tx) => tx.tables.sources.list());
    expect(routes(sources, [principal], PHONE_LANE, { pass: principal.id, facts: phoneFacts(at(1), ["location", "health"]) })).toEqual([PHONE_OTHER, PHONE_SOURCE]);
    for (let n = 1; n <= 26; n++) phoneRow(h, PLACES, n, ["location"]);
    const lines: Json[] = [];
    expect(await quietRun(h, lines, { off: [PLACES] })).toBe(true);
    expect(lines).toEqual([line({ settled: 26, rows: 26 })]);
    expect([states(h, PLACES), h.readThrough(PLACES), h.kept(PLACES).heard_ms]).toEqual([[], at(26), at(26)]);
    expect(h.db.commit((tx) => tx.tables.meta.get(QUIET_DONE))).toBe(String(h.now));
  });

  it("rows waiting at a deploy behind a paused import: begin at the resume settles each by its old meaning, in order, and hands only a carrying row on", () => {
    const h = open();
    phoneRow(h, PHONE_SOURCE, 1, ["health"]);
    phoneRow(h, PHONE_SOURCE, 2, ["health"], [PHONE_SOURCE]);
    phoneRow(h, PHONE_SOURCE, 3, ["location"], [], 1);
    h.commit((tx) => {
      sealed(tx, { id: `${MAC_SOURCE}/heartbeat`, source: MAC_SOURCE, sealed_ms: at(4), pass: PASS_P, facts: heartbeatFacts(at(4), at(4) - MINUTE) });
      sealed(tx, { id: `${MAC_SOURCE}/frames`, source: MAC_SOURCE, sealed_ms: at(5), pass: PASS_P, seal: 1, facts: {} });
      for (const key of [MAC_SOURCE, PHONE_SOURCE]) tx.tables.jobs.enqueue({ kind: "import", key, connector: null, lane: 0, not_before_ms: 0, now_ms: 0 });
    });
    const main = mainOf(h);
    const handed = [0, 1].map(() => {
      const job = h.commit((tx) => tx.tables.jobs.take(h.now, [0])!);
      return h.commit((tx) => importKind.begin!(main, tx, job)!).data.id;
    });
    expect(handed.sort()).toEqual(["phone:iphone-aa01/0003", `${MAC_SOURCE}/frames`]);
    expect([states(h, PHONE_SOURCE), states(h, MAC_SOURCE)]).toEqual([["imported", "imported", "importing"], ["imported", "importing"]]);
    expect([h.readThrough(PHONE_SOURCE), h.readThrough(MAC_SOURCE)]).toEqual([at(1), at(4) - MINUTE]);
  });

  it("a heartbeat's import cut short ends in its own run, as a read of nothing, and the source's next carrying delivery imports", () => {
    const h = open();
    const name = (n: number) => `${MAC_SOURCE}/heartbeat-${n}`;
    const runs = h.commit((tx) => {
      for (let n = 1; n <= 3; n++) sealed(tx, { id: name(n), source: MAC_SOURCE, sealed_ms: at(n), pass: PASS_P, facts: heartbeatFacts(at(n), at(n) - MINUTE) });
      sealed(tx, { id: `${MAC_SOURCE}/frames`, source: MAC_SOURCE, sealed_ms: at(4), pass: PASS_P, seal: 1, facts: {} });
      const begun = (n: number, failures: number): number => {
        const run = tx.tables.runs.start({ kind: "import", subject: importSubject(MAC_SOURCE, name(n)), started_ms: at(n) });
        tx.tables.deliveries.move(name(n), MAC_SOURCE, { move: "begin", run });
        for (let failed = 0; failed < failures; failed++) {
          if (failed > 0) tx.tables.deliveries.move(name(n), MAC_SOURCE, { move: "begin", run });
          tx.tables.deliveries.move(name(n), MAC_SOURCE, { move: "fail", error: "a test" });
          tx.tables.runs.end(run, { ended_ms: at(n), outcome: "failed", error: "a test" });
        }
        return run;
      };
      const made = [begun(1, 0), begun(2, 1), begun(3, 2)];
      tx.tables.jobs.enqueue({ kind: "import", key: MAC_SOURCE, connector: null, lane: 0, not_before_ms: 0, now_ms: 0 });
      tx.tables.jobs.progress(tx.tables.jobs.get("import", MAC_SOURCE)!.id, { run: made[0]!, delivery: name(1), counts: emptyLanded() } as never);
      return made;
    });
    h.commit((tx) => tx.tables.runs.interrupt(h.now));
    expect(h.db.commit((tx) => tx.tables.deliveries.stopped())).toEqual([MAC_SOURCE]);
    const main = mainOf(h);
    const job = h.commit((tx) => tx.tables.jobs.take(h.now, [0])!);
    const begun = h.commit((tx) => importKind.begin!(main, tx, job)!);
    expect(begun.data.id).toBe(`${MAC_SOURCE}/frames`);
    h.db.commit((tx) => {
      for (const [index, run] of runs.entries()) {
        expect(tx.tables.deliveries.get(name(index + 1), MAC_SOURCE)).toMatchObject({ state: "imported", run });
        expect(tx.tables.runs.get(run)).toMatchObject({ outcome: "ok" });
      }
      expect(tx.tables.deliveries.stopped()).toEqual([]);
      expect(tx.tables.jobs.get("import", MAC_SOURCE)!.progress).toMatchObject({ run: begun.state.run, delivery: `${MAC_SOURCE}/frames` });
      expect(tx.tables.sources.get(MAC_SOURCE)!.read_through_ms).toBe(at(3) - MINUTE);
    });
    h.commit((tx) => importKind.done(main, tx, { job, state: begun.state } as Running<typeof begun.state>, { read_through_ms: at(4), held: [], caught_up: 0 }));
    expect([states(h, MAC_SOURCE), h.readThrough(MAC_SOURCE)]).toEqual([["imported", "imported", "imported", "imported"], at(4)]);
    seen.cut = h.db.commit((tx) => tx.tables.deliveries.list().map(({ id, state, run, failures }) => ({ id, state, run, failures })));
  });

  it("the drain ends a heartbeat's import cut short of a source that is off, in its own run", async () => {
    const h = open();
    const id = `${MAC_SOURCE}/heartbeat`;
    const run = h.commit((tx) => {
      sealed(tx, { id, source: MAC_SOURCE, sealed_ms: at(1), pass: PASS_P, facts: heartbeatFacts(at(1), at(1) - MINUTE) });
      const made = tx.tables.runs.start({ kind: "import", subject: importSubject(MAC_SOURCE, id), started_ms: at(1) });
      tx.tables.deliveries.move(id, MAC_SOURCE, { move: "begin", run: made });
      tx.tables.deliveries.move(id, MAC_SOURCE, { move: "fail", error: "a test" });
      tx.tables.runs.end(made, { ended_ms: at(1), outcome: "failed", error: "a test" });
      return made;
    });
    expect(await quietRun(h, [], { off: [MAC_SOURCE], commits: 2 })).toBe(false);
    h.db.commit((tx) => {
      expect(tx.tables.deliveries.get(id, MAC_SOURCE)).toMatchObject({ state: "imported", run });
      expect(tx.tables.runs.get(run)).toMatchObject({ outcome: "ok" });
    });
    expect(h.readThrough(MAC_SOURCE)).toBe(at(1) - MINUTE);
  });

  async function sealHeartbeat(h: ThroughHome, n: number, file = false): Promise<string> {
    const name = basicInstant(iso(at(n)));
    const sealing = openSealing(openHomeFolder(h.root), { source: MAC_SOURCE, name, feeder: "screen-recorder", fetched_at: iso(at(n)) });
    if (file) await sealing.write("frames.bin", (async function* () { yield Buffer.from("synthetic frames"); })());
    sealing.seal(heartbeatFacts(at(n), at(n) - MINUTE), undefined, { pass: PASS_P, sealed_at: iso(at(n)) });
    return `${MAC_SOURCE}/${name}`;
  }

  async function heartbeat(h: ThroughHome, n: number, file = false): Promise<string> {
    const id = await sealHeartbeat(h, n, file);
    h.commit((tx) => sealed(tx, { id, source: MAC_SOURCE, sealed_ms: at(n), pass: PASS_P, facts: heartbeatFacts(at(n), at(n) - MINUTE) }));
    return id;
  }

  const doneAt = (h: ThroughHome): string | undefined => h.db.commit((tx) => tx.tables.meta.get(QUIET_DONE));
  const quietJob = (h: ThroughHome): string | undefined => h.db.commit((tx) => tx.tables.jobs.get("quiet", "rows")?.state);

  it("clears out the settled quiet rows and a heartbeat's directory; leaves a shipment that carried, and a delivery with a file, kept; resumes after a kill", async () => {
    const h = open();
    const inbox = join(h.root, "inbox");
    const beats = [await heartbeat(h, 1), await heartbeat(h, 2), await heartbeat(h, 3)];
    const withFile = await heartbeat(h, 4, true);
    writeFileSync(join(inbox, beats[1]!, "swept.json"), "{}\n");
    rmSync(join(inbox, beats[1]!, MANIFEST_FILE));
    const shipment = ship(h, { pass: PASS_P, sealed_ms: at(5), carries: ["health"] });
    h.commit((tx) => {
      for (const source of [PHONE_OTHER, PHONE_SOURCE]) sealed(tx, { id: shipment, source, sealed_ms: at(5), pass: PASS_P, facts: phoneFacts(at(5), ["health"]) });
      settled(tx, shipment, PHONE_OTHER, at(5));
    });
    const main = mainOf(h);
    h.commit((tx) => {
      expect(passAhead(main, tx, MAC_SOURCE, undefined)).toBeUndefined();
      expect(passAhead(main, tx, PHONE_SOURCE, undefined)).toBeUndefined();
    });
    const before = { mac: h.readThrough(MAC_SOURCE), phone: h.readThrough(PHONE_SOURCE) };
    expect(before).toEqual({ mac: at(4) - MINUTE, phone: at(5) });
    expect(await quietRun(h, [], { commits: 0 })).toBe(false);
    expect([...beats, withFile, shipment].map((id) => existsSync(join(inbox, id)))).toEqual([true, true, true, true, true]);
    expect(await quietRun(h, [], { commits: 2 })).toBe(false);
    expect([...beats, withFile, shipment].map((id) => existsSync(join(inbox, id)))).toEqual([false, false, false, true, true]);
    expect(states(h, MAC_SOURCE)).toEqual(["imported", "imported", "imported", "imported"]);
    const lines: Json[] = [];
    expect(await quietRun(h, lines)).toBe(true);
    expect(lines).toEqual([line({ rows: 4, kept: 1, left: 1 })]);
    h.db.commit((tx) => {
      expect(tx.tables.deliveries.list().map((each) => [each.id, each.source])).toEqual([[withFile, MAC_SOURCE], [shipment, PHONE_OTHER]]);
    });
    expect(existsSync(join(inbox, withFile, MANIFEST_FILE))).toBe(true);
    expect(existsSync(join(inbox, shipment, MANIFEST_FILE))).toBe(true);
    expect({ mac: h.readThrough(MAC_SOURCE), phone: h.readThrough(PHONE_SOURCE) }).toEqual(before);
    expect([h.kept(MAC_SOURCE).heard_ms, h.kept(PHONE_SOURCE).heard_ms]).toEqual([at(3), at(5)]);
    await look(h);
    expect(h.db.commit((tx) => tx.tables.deliveries.list().length)).toBe(2);
    seen.clear = lines;
  });

  it("keeps a Places row an import ran, in a shipment that carried for another source or for it alone; one never run drains", async () => {
    const h = open();
    h.commit((tx) => tx.tables.sources.add({ id: PLACES, vendor: "apple", connector: "fake-rows", added_ms: 0 }));
    const both = ship(h, { pass: PASS_P, sealed_ms: at(1), carries: ["health"] });
    const alone = ship(h, { pass: PASS_P, sealed_ms: at(2), carries: [] });
    h.commit((tx) => {
      for (const [id, n, sources, carries] of [[both, 1, [PHONE_OTHER, PLACES], ["health"]], [alone, 2, [PLACES], []]] as const) {
        for (const source of sources) {
          sealed(tx, { id, source, sealed_ms: at(n), pass: PASS_P, facts: phoneFacts(at(n), carries) });
          settled(tx, id, source, at(n));
        }
      }
    });
    phoneRow(h, PLACES, 3, ["location"]);
    const lines: Json[] = [];
    expect(await quietRun(h, lines, { off: [PLACES] })).toBe(true);
    expect(lines).toEqual([line({ settled: 1, rows: 1 })]);
    h.db.commit((tx) => {
      expect(tx.tables.deliveries.list().map((each) => [each.id, each.source, each.state])).toEqual([[both, PHONE_OTHER, "imported"], [both, PLACES, "imported"], [alone, PLACES, "imported"]]);
    });
    expect([both, alone].map((id) => existsSync(join(h.root, "inbox", id, MANIFEST_FILE)))).toEqual([true, true]);
    seen.places = lines;
  });

  it("begin settles a quiet row an import would read again with no helper: given up, imported refusing, a re-read left unfinished; a heartbeat stated after its read-through moves it only that far", () => {
    const h = open();
    const name = (n: number) => `${MAC_SOURCE}/heartbeat-${n}`;
    const unfinished = h.commit((tx) => {
      sealed(tx, { id: name(1), source: MAC_SOURCE, sealed_ms: at(10), stated_ms: at(10), pass: PASS_P, facts: heartbeatFacts(at(10), at(5)) });
      const first = tx.tables.runs.start({ kind: "import", subject: importSubject(MAC_SOURCE, name(1)), started_ms: at(10) });
      tx.tables.deliveries.move(name(1), MAC_SOURCE, { move: "begin", run: first });
      tx.tables.deliveries.move(name(1), MAC_SOURCE, { move: "fail", error: "a test" });
      tx.tables.runs.end(first, { ended_ms: at(10), outcome: "failed", error: "a test" });
      tx.tables.deliveries.move(name(1), MAC_SOURCE, { move: "give-up", code: "sha256:old-code" });
      const reread = tx.tables.runs.start({ kind: "import", subject: importSubject(MAC_SOURCE, name(1)), started_ms: at(11) });
      tx.tables.jobs.enqueue({ kind: "import", key: MAC_SOURCE, connector: null, lane: 0, not_before_ms: 0, now_ms: 0 });
      tx.tables.jobs.progress(tx.tables.jobs.get("import", MAC_SOURCE)!.id, { run: reread, delivery: name(1), counts: emptyLanded() } as never);
      sealed(tx, { id: name(2), source: MAC_SOURCE, sealed_ms: at(12), stated_ms: at(12), pass: PASS_P, facts: heartbeatFacts(at(12), at(8)) });
      const second = tx.tables.runs.start({ kind: "import", subject: importSubject(MAC_SOURCE, name(2)), started_ms: at(12) });
      tx.tables.deliveries.move(name(2), MAC_SOURCE, { move: "begin", run: second });
      tx.tables.deliveries.move(name(2), MAC_SOURCE, { move: "land", run: second, refused: 1, error: null, code: "sha256:old-code" });
      tx.tables.runs.end(second, { ended_ms: at(12), outcome: "ok" });
      return reread;
    });
    const main = mainOf(h);
    const job = h.commit((tx) => tx.tables.jobs.take(h.now, [0])!);
    expect(h.commit((tx) => importKind.begin!(main, tx, job))).toBeNull();
    h.db.commit((tx) => {
      expect(tx.tables.deliveries.get(name(1), MAC_SOURCE)).toMatchObject({ state: "imported", refused: 0, read_by: "test" });
      expect(tx.tables.runs.get(unfinished)).toMatchObject({ outcome: "ok" });
      expect(tx.tables.jobs.get("import", MAC_SOURCE)!.progress).toBeNull();
    });
    expect(h.readThrough(MAC_SOURCE)).toBe(at(5));
    expect(h.commit((tx) => importKind.begin!(main, tx, job))).toBeNull();
    h.db.commit((tx) => {
      expect(tx.tables.deliveries.get(name(2), MAC_SOURCE)).toMatchObject({ state: "imported", refused: 0, read_by: "test" });
      expect(tx.tables.runs.running()).toEqual([]);
    });
    expect(h.readThrough(MAC_SOURCE)).toBe(at(8));
    expect(h.commit((tx) => importKind.begin!(main, tx, job))).toBeNull();
    seen.unread = h.db.commit((tx) => tx.tables.deliveries.list().map(({ id, state, refused, read_by, run }) => ({ id, state, refused, read_by, run })));
  });

  it("the clear-out leaves every row of a source whose import runs, a row a paused import names, and a row whose source an import took after the helper read", async () => {
    const h = open();
    const inbox = join(h.root, "inbox");
    const beats = [await heartbeat(h, 1), await heartbeat(h, 2)];
    h.commit((tx) => expect(passAhead(mainOf(h), tx, MAC_SOURCE, undefined)).toBeUndefined());
    const lines: Json[] = [];
    const job = h.commit((tx) => {
      tx.tables.jobs.enqueue({ kind: "import", key: MAC_SOURCE, connector: null, lane: 0, not_before_ms: 0, now_ms: 0 });
      return tx.tables.jobs.take(h.now, [0])!;
    });
    expect(job).toMatchObject({ kind: "import", key: MAC_SOURCE });
    expect(await quietRun(h, lines)).toBe(true);
    expect([states(h, MAC_SOURCE), beats.map((id) => existsSync(join(inbox, id)))]).toEqual([["imported", "imported"], [true, true]]);
    h.commit((tx) => {
      tx.tables.jobs.recover();
      tx.tables.jobs.progress(job.id, { run: 1, delivery: beats[0]!, counts: emptyLanded() } as never);
      tx.tables.controls.set({ target: `import:${MAC_SOURCE}`, reason: "a test", at_ms: 0, by: "you" });
    });
    expect(await quietRun(h, lines)).toBe(true);
    expect([states(h, MAC_SOURCE), beats.map((id) => existsSync(join(inbox, id)))]).toEqual([["imported"], [true, false]]);
    h.commit((tx) => {
      tx.tables.jobs.progress(job.id, null);
      tx.tables.controls.clear(`import:${MAC_SOURCE}`);
    });
    expect(await quietRun(h, lines, { beforeClear: () => expect(h.commit((tx) => tx.tables.jobs.take(h.now, [0]))?.id).toBe(job.id) })).toBe(true);
    expect([states(h, MAC_SOURCE), existsSync(join(inbox, beats[0]!))]).toEqual([["imported"], false]);
    expect(h.db.commit((tx) => tx.tables.meta.get(QUIET_DONE))).toBeUndefined();
    h.commit((tx) => tx.tables.jobs.recover());
    expect(await quietRun(h, lines)).toBe(true);
    expect(states(h, MAC_SOURCE)).toEqual([]);
    expect(lines).toEqual([line({ left: 2 }), line({ rows: 1, directories: 1, left: 1 }), line({ directories: 1, left: 1 }), line({ rows: 1 })]);
    expect(h.db.commit((tx) => tx.tables.meta.get(QUIET_DONE))).toBe(String(h.now));
    seen.held = lines;
  });

  it("a walk of rows that change nothing makes no commit of its own: the fold's mark, the drain's, the walk's end", async () => {
    const h = open();
    h.commit((tx) => {
      for (let n = 1; n <= 1200; n++) {
        const source = [MAC_SOURCE, PHONE_SOURCE, PHONE_OTHER, COAST_SOURCE][n % 4]!;
        const id = `lane-test/${String(n).padStart(5, "0")}`;
        sealed(tx, { id, source, sealed_ms: at(n), facts: {} });
        settled(tx, id, source, at(n));
      }
    });
    const lines: Json[] = [];
    expect(await quietRun(h, lines, { commits: 3 })).toBe(true);
    expect(lines).toEqual([line({})]);
    expect(h.db.commit((tx) => tx.tables.meta.get(QUIET_DONE))).toBe(String(h.now));
  });

  it("an old heartbeat indexed between the walk's last read and its commit begins the walk again, which clears it out and is done", async () => {
    const h = open();
    const id = await sealHeartbeat(h, 1);
    const lines: Json[] = [];
    expect(await quietRun(h, lines, { off: [MAC_SOURCE], beforeClear: () => expect(nudge(h, id)).toBe(1) })).toBe(false);
    expect([states(h, MAC_SOURCE), doneAt(h), quietJob(h)]).toEqual([["sealed"], undefined, "queued"]);
    h.now = at(700);
    expect(await quietRun(h, lines, { off: [MAC_SOURCE] })).toBe(true);
    expect([states(h, MAC_SOURCE), existsSync(join(h.root, "inbox", id)), doneAt(h)]).toEqual([[], false, String(at(700))]);
    expect(lines).toEqual([line({}), line({ settled: 1, rows: 1, directories: 1 })]);
    seen.late = lines;
  });

  it("an old heartbeat the look indexes after the walk was done clears the mark and queues the job, which clears it out and is done again", async () => {
    const h = open();
    const lines: Json[] = [];
    expect(await quietRun(h, lines)).toBe(true);
    expect([doneAt(h), quietJob(h)]).toEqual([String(h.now), undefined]);
    const id = await sealHeartbeat(h, 1);
    await look(h);
    expect([states(h, MAC_SOURCE), doneAt(h), quietJob(h)]).toEqual([["sealed"], undefined, "queued"]);
    h.now = at(700);
    expect(await quietRun(h, lines, { off: [MAC_SOURCE] })).toBe(true);
    expect([states(h, MAC_SOURCE), existsSync(join(h.root, "inbox", id)), doneAt(h)]).toEqual([[], false, String(at(700))]);
    expect(lines).toEqual([line({}), line({ settled: 1, rows: 1, directories: 1 })]);
    seen.after = lines;
  });
});
