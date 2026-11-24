import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { DeliveryRefused, isStopped, openHome, openHomeFolder, readTables, type DeliveryMove, type HomeDb, type Tx } from "./index.js";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const SOURCE = "apple-notes:local:macbook-pro-0001";
const FED = "gmail:person-a@example.com:cloud";
const PASS = "p-0000000a";
const CODE = "sha256:code-1";
const LATER = "sha256:code-2";

const AT = {
  sealed: [],
  importing: [{ move: "begin", run: 1 }],
  failed: [{ move: "begin", run: 1 }, { move: "fail", error: "synthetic" }],
  imported: [{ move: "begin", run: 1 }, { move: "land", run: 1, refused: 0, error: null, code: CODE }],
  "imported unread": [{ move: "begin", run: 1 }, { move: "land", run: 1, refused: 2, error: null, code: CODE }],
  superseded: [{ move: "supersede" }],
  dead: [{ move: "give-up", code: CODE }],
} satisfies Record<string, DeliveryMove[]>;

const MOVES = {
  begin: { move: "begin", run: 2 },
  land: { move: "land", run: 1, refused: 0, error: null, code: LATER },
  pass: { move: "pass" },
  fail: { move: "fail", error: "synthetic" },
  supersede: { move: "supersede", why: "removed" },
  "give-up": { move: "give-up", code: LATER },
  reread: { move: "reread", code: LATER, refused: 0 },
  unread: { move: "unread" },
  purge: { move: "purge", why: "purged" },
} satisfies Record<string, DeliveryMove>;

const TABLE: Record<keyof typeof AT, Record<keyof typeof MOVES, string>> = {
  sealed: { begin: "importing", land: "imported", pass: "imported", fail: "refused", supersede: "superseded", "give-up": "dead", reread: "refused", unread: "refused", purge: "sealed" },
  importing: { begin: "importing", land: "imported", pass: "refused", fail: "failed", supersede: "superseded", "give-up": "dead", reread: "refused", unread: "refused", purge: "importing" },
  failed: { begin: "importing", land: "refused", pass: "refused", fail: "refused", supersede: "superseded", "give-up": "dead", reread: "refused", unread: "refused", purge: "failed" },
  imported: { begin: "refused", land: "refused", pass: "refused", fail: "refused", supersede: "refused", "give-up": "refused", reread: "imported", unread: "refused", purge: "imported" },
  "imported unread": { begin: "refused", land: "refused", pass: "refused", fail: "refused", supersede: "refused", "give-up": "dead", reread: "imported", unread: "imported", purge: "imported" },
  superseded: { begin: "refused", land: "refused", pass: "refused", fail: "refused", supersede: "refused", "give-up": "refused", reread: "refused", unread: "refused", purge: "superseded" },
  dead: { begin: "refused", land: "refused", pass: "refused", fail: "refused", supersede: "superseded", "give-up": "refused", reread: "imported", unread: "dead", purge: "dead" },
};

interface Row {
  state: string;
  run: number | null;
  failures: number;
  error: string | null;
  refused: number;
  read_by: string | null;
}

describe("a delivery's state", () => {
  const dirs: string[] = [];
  const artifact: Record<string, unknown> = {};
  afterAll(() => {
    for (const dir of dirs) {
      writeFileSync(join(dir, "deliveries.json"), `${JSON.stringify(artifact, null, 2)}\n`);
      if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(dir, { recursive: true, force: true });
    }
  });
  const home = (): { db: HomeDb; path: string } => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-deliveries-"));
    dirs.push(dir);
    const path = join(dir, "home.db");
    const db = openHome(openHomeFolder(dirname(path)), "migrate");
    db.commit((tx) => {
      for (const id of [SOURCE, FED]) tx.tables.sources.add({ id, vendor: id === SOURCE ? "apple" : "google", connector: id === SOURCE ? "apple-notes" : "gmail", added_ms: NOW });
      tx.tables.runs.start({ kind: "import", subject: "synthetic", started_ms: NOW });
      tx.tables.runs.start({ kind: "import", subject: "synthetic", started_ms: NOW });
    });
    return { db, path };
  };
  const add = (tx: Tx, id: string, source = SOURCE, seal: number | null = null, facts = {}) =>
    tx.tables.deliveries.add({ id, source, sealed_ms: NOW, stated_ms: NOW, facts, pass: seal === null ? null : PASS, seal });
  const row = (db: HomeDb, id: string, source = SOURCE): Row => {
    const { state, run, failures, error, refused, read_by } = db.commit((tx) => tx.tables.deliveries.get(id, source)!);
    return { state, run, failures, error, refused, read_by };
  };
  const custody = (path: string, source = SOURCE): number | null => {
    const read = new Database(path, { readonly: true });
    try {
      return (read.prepare("SELECT imported FROM custody WHERE pass = ? AND source = ?").pluck().get(PASS, source) as number | undefined) ?? null;
    } finally {
      read.close();
    }
  };

  it("makes every move the table names from every state, and refuses the rest with its commit", () => {
    const { db } = home();
    const answered: Record<string, Record<string, string>> = {};
    for (const [at, path] of Object.entries(AT)) {
      answered[at] = {};
      for (const [name, move] of Object.entries(MOVES)) {
        const id = `lane-a/${at.replace(" ", "-")}-${name}`;
        db.commit((tx) => {
          add(tx, id);
          for (const step of path as DeliveryMove[]) tx.tables.deliveries.move(id, SOURCE, step);
        });
        const before = row(db, id);
        try {
          db.commit((tx) => {
            tx.tables.meta.set(`moved:${id}`, "1");
            tx.tables.deliveries.move(id, SOURCE, move);
          });
          answered[at][name] = row(db, id).state;
        } catch (error) {
          expect(error).toBeInstanceOf(DeliveryRefused);
          expect(row(db, id)).toEqual(before);
          expect(db.commit((tx) => tx.tables.meta.get(`moved:${id}`))).toBeUndefined();
          answered[at][name] = "refused";
        }
      }
    }
    artifact.table = answered;
    expect(answered).toEqual(TABLE);
    expect(() => db.commit((tx) => tx.tables.deliveries.move("lane-a/none", SOURCE, { move: "begin", run: 1 }))).toThrow(DeliveryRefused);
    db.close();
  });

  it("writes what each move carries, and nothing else", () => {
    const { db } = home();
    const id = "lane-a/one";
    db.commit((tx) => add(tx, id));
    const step = (move: DeliveryMove) => {
      db.commit((tx) => tx.tables.deliveries.move(id, SOURCE, move));
      return row(db, id);
    };
    expect(step({ move: "begin", run: 1 })).toEqual({ state: "importing", run: 1, failures: 0, error: null, refused: 0, read_by: null });
    expect(step({ move: "fail", error: "first" })).toEqual({ state: "failed", run: 1, failures: 1, error: "first", refused: 0, read_by: null });
    expect(isStopped(row(db, id))).toBe(false);
    step({ move: "begin", run: 1 });
    expect(step({ move: "fail", error: "second" })).toMatchObject({ state: "failed", failures: 2, error: "second" });
    expect(db.commit((tx) => [tx.tables.deliveries.stopped(), tx.tables.deliveries.blockedAt(SOURCE)?.id])).toEqual([[SOURCE], id]);
    expect(isStopped(step({ move: "begin", run: 1 }))).toBe(true);
    const enters = (move: DeliveryMove) => db.commit((tx) => {
      tx.tables.deliveries.move(id, SOURCE, move);
      return [...tx.moved.imported];
    });
    expect(enters({ move: "land", run: 1, refused: 3, error: "rest refused", code: CODE })).toEqual([SOURCE]);
    expect(row(db, id)).toEqual({ state: "imported", run: 1, failures: 2, error: "rest refused", refused: 3, read_by: CODE });
    expect(enters({ move: "reread", code: CODE, refused: 3 })).toEqual([]);
    expect(db.commit((tx) => tx.tables.deliveries.stopped())).toEqual([]);
    expect(step({ move: "reread", code: LATER, refused: 1, error: null })).toEqual({ state: "imported", run: 1, failures: 2, error: null, refused: 1, read_by: LATER });
    expect(step({ move: "unread" })).toMatchObject({ state: "imported", refused: 1, read_by: null });
    expect(step({ move: "give-up", code: LATER, refused: 4 })).toMatchObject({ state: "dead", refused: 4, read_by: LATER });
    expect(step({ move: "supersede", why: "removed" })).toMatchObject({ state: "superseded", refused: 0, error: "removed" });
    expect(db.commit((tx) => tx.tables.deliveries.unread(SOURCE, "sha256:code-3"))).toBeUndefined();
    db.close();
  });

  it("ends a given-up row a later code reads whole, and keeps one it still refuses or failed on given up", () => {
    const { db } = home();
    const id = "lane-a/given-up";
    db.commit((tx) => add(tx, id));
    const step = (move: DeliveryMove) => {
      db.commit((tx) => tx.tables.deliveries.move(id, SOURCE, move));
      return row(db, id);
    };
    step({ move: "begin", run: 1 });
    step({ move: "fail", error: "first" });
    expect(step({ move: "give-up", code: CODE })).toMatchObject({ state: "dead", read_by: CODE });
    expect(step({ move: "reread", code: LATER, refused: 2, error: null })).toMatchObject({ state: "dead", refused: 2, read_by: LATER });
    expect(step({ move: "reread", code: LATER, refused: 0, error: "disk failed" })).toMatchObject({ state: "dead", refused: 0, error: "disk failed" });
    expect(step({ move: "reread", code: LATER })).toMatchObject({ state: "dead", read_by: LATER });
    expect(db.commit((tx) => tx.tables.deliveries.unread(SOURCE, "sha256:code-3"))?.id).toBe(id);
    expect(step({ move: "reread", code: LATER, refused: 0, error: null })).toMatchObject({ state: "imported", refused: 0, error: null, read_by: LATER });
    expect(db.commit((tx) => tx.tables.deliveries.unread(SOURCE, "sha256:code-3"))).toBeUndefined();
    db.close();
  });

  it("advances custody in the move that settles, and only once a seal is settled", () => {
    const { db, path } = home();
    const seen: Record<string, number | null> = {};
    db.commit((tx) => {
      add(tx, "lane-a/s1", SOURCE, 1);
      add(tx, "lane-a/s2", SOURCE, 2);
      add(tx, "lane-a/s3", SOURCE, 3);
      add(tx, "lane-a/s3", FED, null);
      add(tx, "lane-a/s4", SOURCE, 4);
      add(tx, "lane-a/s4", FED, null);
    });
    const noted: { custody: string[]; imported: number }[] = [];
    const move = (id: string, source: string, ...moves: DeliveryMove[]) => db.commit((tx) => {
      for (const each of moves) tx.tables.deliveries.move(id, source, each);
      noted.push({ custody: [...tx.moved.custody], imported: tx.tables.custody.imported(PASS, SOURCE) });
    });
    const land: DeliveryMove = { move: "land", run: 1, refused: 0, error: null, code: CODE };
    seen.none = custody(path);
    move("lane-a/s1", SOURCE, { move: "begin", run: 1 }, { move: "give-up", code: CODE });
    seen.given_up = custody(path);
    move("lane-a/s2", SOURCE, { move: "pass" });
    seen.passed = custody(path);
    move("lane-a/s3", SOURCE, land);
    seen.read = custody(path);
    move("lane-a/s3", FED, land);
    seen.fed_read = custody(path);
    move("lane-a/s4", SOURCE, land);
    move("lane-a/s4", FED, { move: "give-up", code: CODE });
    seen.fed_given_up = custody(path);
    expect(() => move("lane-a/s4", FED, { move: "supersede" }, { move: "begin", run: 1 })).toThrow(DeliveryRefused);
    seen.refused = custody(path);
    move("lane-a/s4", FED, { move: "supersede" });
    seen.given_up_superseded = custody(path);
    move("lane-a/s3", SOURCE, { move: "reread", code: LATER, refused: 0 });
    seen.reread = custody(path);
    artifact.custody = seen;
    expect(seen).toEqual({ none: null, given_up: 1, passed: 2, read: 3, fed_read: 3, fed_given_up: 4, refused: 4, given_up_superseded: 4, reread: 4 });
    expect(noted.map((each) => each.custody)).toEqual([[SOURCE], [SOURCE], [SOURCE], [], [SOURCE], [], [], []]);
    expect(noted.map((each) => each.imported)).toEqual([1, 2, 3, 3, 4, 4, 4, 4]);
    db.close();
  });

  it("says what waits for a source by the delivery its import takes next and whether a live one waits, in two reads of `deliveries_waiting`", () => {
    const { db, path } = home();
    const waiting = (source: string) => {
      const read = new Database(path, { readonly: true });
      try {
        const prepared: string[] = [];
        const seen = new Proxy(read, {
          get(target, name) {
            if (name === "prepare") return (text: string) => (prepared.push(text), target.prepare(text));
            const value = Reflect.get(target, name, target) as unknown;
            return typeof value === "function" ? (value as (...each: unknown[]) => unknown).bind(target) : value;
          },
        });
        const answer = readTables(seen).deliveries.waiting(source) ?? null;
        const plans = prepared.map((text) => (read.prepare(`EXPLAIN QUERY PLAN ${text}`).all(source) as { detail: string }[]).map((row) => row.detail).join("; "));
        return { answer, plans };
      } finally {
        read.close();
      }
    };
    const put = (id: string, source: string, sealed_ms: number, stated_ms: number, facts = {}, seal: number | null = null) =>
      db.commit((tx) => tx.tables.deliveries.add({ id, source, sealed_ms, stated_ms, facts, pass: seal === null ? null : PASS, seal }));
    const seen: Record<string, unknown> = {};
    seen.none = waiting(SOURCE).answer;
    put("lane-a/page-1", SOURCE, NOW, NOW, { history: true }, 1);
    put("lane-a/page-2", SOURCE, NOW + 1, NOW + 1, { history: true }, 2);
    seen.history = waiting(SOURCE).answer;
    put("lane-a/live", SOURCE, NOW + 2, NOW + 2, {}, 3);
    const behind = waiting(SOURCE);
    seen.live_behind_history = behind.answer;
    db.commit((tx) => {
      for (const id of ["lane-a/page-1", "lane-a/page-2"]) tx.tables.deliveries.move(id, SOURCE, { move: "pass" });
    });
    seen.live = waiting(SOURCE).answer;
    put("fed/later", FED, NOW, NOW + 10);
    put("fed/earlier", FED, NOW + 10, NOW);
    seen.fed = waiting(FED).answer;
    expect(seen).toEqual({
      none: null,
      history: { live: false, since_ms: NOW },
      live_behind_history: { live: true, since_ms: NOW },
      live: { live: true, since_ms: NOW + 2 },
      fed: { live: true, since_ms: NOW + 10 },
    });
    expect(behind.plans).toHaveLength(2);
    for (const plan of behind.plans) expect(plan).toMatch(/USING (COVERING )?INDEX deliveries_waiting\b/u);
    artifact.waiting = { seen, plans: behind.plans };
    db.close();
  });
});
