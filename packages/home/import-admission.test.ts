import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declarations, imports as declared } from "@lifestreamprotocol/connect";
import { openHome, openHomeFolder, type HomeDb, type ReadTables } from "@lifestreamprotocol/core";
import { readImports } from "./imports-report.js";
import { admitImport, dropImport, failedLook, heldImports, importIdOf, importImported, isVoid, listingOf, type Looked } from "./imports.js";
import { importKind } from "./import.js";
import { effective } from "./settings.js";
import { sweepInbox } from "./sweep.js";
import { makeRoot, readHome, removeRoot } from "./test/harness-root.js";
import importsRegistry from "./test/imports-registry.js";
import { sealDelivery } from "./test/ops-support.js";
import { zip } from "./test/support.js";

const ACCOUNT = "synthetic-user-0001";
const SOURCE = `spotify:${ACCOUNT}:export`;
const NOW = Date.UTC(2026, 10, 1, 12);
const FILE = "my_spotify_data.zip";
const FACTS = { import: { kind: "spotify" } };
const HISTORY = { of: "spotify", members: "**/Streaming_History_Audio_*.json", product: "spotify", copy: "export", connector: "spotify-export" } as const;
const VIDEO = { ...HISTORY, members: "**/Streaming_History_Video_*.json" } as const;

const opened: { root: string; db: HomeDb }[] = [];
afterEach(() => {
  for (const { root, db } of opened.splice(0)) {
    db.close();
    removeRoot(root);
  }
});

function home() {
  const root = makeRoot("lifestream-import-admission-", { sources: {} });
  const db = openHome(openHomeFolder(root), "migrate");
  opened.push({ root, db });
  return { root, db };
}

function looked(digest: string, routes: readonly declared.ImportRead[], more: Partial<Looked> = {}): Looked {
  return {
    kind: "spotify", digest, stamp: null, named: [], account: ACCOUNT, time_ms: NOW - 86_400_000, anchor: `first-play-${digest}`, refused: null, contradicted: null,
    checked: { source: SOURCE, anchor: null }, device: null,
    listing: { kind: "spotify", hash: "synthetic", files: [{ path: FILE, bytes: 4_096 }], products: [{ id: "spotify", name: "Spotify", reads: true, files: [FILE], unclaimed: 0, activity: null }],
      routes: routes.map((route) => ({ ...route, files: [FILE] })) },
    ...more,
  };
}

const admit = (db: HomeDb, id: string, look: Looked) =>
  db.commit((tx) => admitImport(tx, importsRegistry().connectors, { id, facts: FACTS, stated_ms: NOW }, "import", look, NOW, []));

describe("an import's admission", () => {
  it("two exports answered for one unanchored account, looked at in one look: the first feeds it and keeps its anchor, the second is looked at again", () => {
    const { db } = home();
    const [first, second] = [looked("aa", [HISTORY]), looked("bb", [HISTORY])];
    expect(admit(db, "import/1", first)).toEqual({ sources: [SOURCE], stated_ms: first.time_ms });
    expect(admit(db, "import/2", second)).toEqual({ sources: [], stated_ms: NOW, again: true });
    db.commit((tx) => {
      expect([tx.tables.meta.get(`import-anchor:${SOURCE}`), importIdOf(tx.tables.meta, "import/2"), listingOf(tx.tables.meta, "import/2")]).toEqual(["first-play-aa", null, null]);
    });
    expect(admit(db, "import/2", looked("bb", [HISTORY], { checked: { source: SOURCE, anchor: "first-play-aa" }, contradicted: "This isn't the same account's history" })).sources).toEqual([]);
    db.commit((tx) => expect(heldImports(tx.tables.meta)[importIdOf(tx.tables.meta, "import/2")!]).toMatchObject({ account: null, refused: "This isn't the same account's history" }));
  });

  it("a file listed again whose rows claim more of it is read again by the source that read it whole; one claiming nothing new, or naming no account, stays as it was", () => {
    const { db } = home();
    admit(db, "import/1", looked("aa", [HISTORY]));
    db.commit((tx) => {
      tx.tables.deliveries.add({ id: "import/1", source: SOURCE, sealed_ms: NOW, stated_ms: NOW, facts: FACTS });
      const run = tx.tables.runs.start({ kind: "import", subject: `${SOURCE} import/1`, started_ms: NOW });
      tx.tables.deliveries.move("import/1", SOURCE, { move: "begin", run });
      tx.tables.deliveries.move("import/1", SOURCE, { move: "land", run, refused: 0, error: null, code: "code-1" });
    });
    const row = () => db.commit((tx) => tx.tables.deliveries.shipment("import/1").map((each) => [each.state, each.read_by]));
    const id = db.commit((tx) => importIdOf(tx.tables.meta, "import/1"));
    admit(db, "import/1", looked("aa", [HISTORY], { account: null, checked: null, anchor: null }));
    expect([row(), db.commit((tx) => importIdOf(tx.tables.meta, "import/1"))]).toEqual([[["imported", "code-1"]], id]);
    admit(db, "import/1", looked("aa", [HISTORY, VIDEO]));
    expect([row(), db.commit((tx) => listingOf(tx.tables.meta, "import/1")?.routes.length)]).toEqual([[["sealed", null]], 2]);
  });

  it("a file whose look threw is an import ended broken, its need Skip it; skipped, nothing of it stays", () => {
    const { root, db } = home();
    const kind = declared.importKinds(importsRegistry().connectors, importsRegistry().readers).find((each) => each.id === "spotify")!;
    const failed = failedLook(kind, { files: [{ path: `files/${FILE}`, blob: `sha256:${"cd".repeat(32)}`, size: 4_096 }] }, new Error("a reader's fault"));
    expect(failed).toMatchObject({ failed: "a reader's fault", listing: { files: [{ path: FILE, bytes: 4_096 }], routes: [] } });
    admit(db, "import/9", failed);
    const id = db.commit((tx) => importIdOf(tx.tables.meta, "import/9"))!;
    const report = () => readHome(root, (read) => readImports(read, {
      folder: openHomeFolder(root), now_ms: NOW, connectors: importsRegistry().connectors, free_bytes: Number.MAX_SAFE_INTEGER, max_bundle_bytes: Number.MAX_SAFE_INTEGER, day: effective(root).settings.day, stated: null,
    }));
    const broken = report();
    const held = broken.imports.find((each) => each.kind === "spotify")!.held;
    expect([held.map((each) => [each.id, each.line, each.health.state, each.products, each.files.map((file) => file.name)]), broken.needs.map((need) => [need.id, need.state, need.detail, need.acts])]).toEqual([
      [[id, "Lifestream couldn't read this file", "broken", [], [FILE]]], [[`import:${id}:refused`, "broken", "a reader's fault", [{ do: "skip", label: "Skip it", need: `import:${id}:refused` }]]]]);
    db.commit((tx) => dropImport(tx, id));
    const gone = report();
    expect([gone.imports.find((each) => each.kind === "spotify")!.held, gone.needs, db.commit((tx) => [isVoid(tx.tables.meta, "import/9"), importIdOf(tx.tables.meta, "import/9"), tx.tables.meta.get("imports:files")])]).toEqual([
      [], [], [true, null, "{}"]]);
  });

  it("a file read whole after a failed read the person skipped, whose claims grow: read again in a new run, the failed run as it ended", () => {
    const { root, db } = home();
    admit(db, "import/1", looked("aa", [HISTORY]));
    const subject = `${SOURCE} import/1`;
    const runs = db.commit((tx) => {
      tx.tables.deliveries.add({ id: "import/1", source: SOURCE, sealed_ms: NOW, stated_ms: NOW, facts: FACTS });
      const first = tx.tables.runs.start({ kind: "import", subject, started_ms: NOW });
      tx.tables.deliveries.move("import/1", SOURCE, { move: "begin", run: first });
      tx.tables.deliveries.move("import/1", SOURCE, { move: "fail", error: "a synthetic failure" });
      tx.tables.runs.end(first, { ended_ms: NOW, outcome: "failed", error: "a synthetic failure" });
      tx.tables.deliveries.move("import/1", SOURCE, { move: "give-up", code: "code-1" });
      const second = tx.tables.runs.start({ kind: "import", subject, started_ms: NOW });
      tx.tables.deliveries.move("import/1", SOURCE, { move: "reread", code: "code-1", refused: 0, error: null });
      tx.tables.runs.end(second, { ended_ms: NOW, outcome: "ok" });
      return { first, second };
    });
    const r1 = db.commit((tx) => tx.tables.runs.get(runs.first));
    admit(db, "import/1", looked("aa", [HISTORY, VIDEO]));
    const main = {
      root, settings: effective(root).settings, registry: { ...importsRegistry(), code: "code-2" }, families: new Map(), now: () => NOW,
      blobs: { has: () => false, stored: () => undefined }, log: () => undefined, ending: 0, room: "ok" as const, stated: {},
    } as never;
    const job = db.commit((tx) => {
      tx.tables.jobs.enqueue({ kind: "import", key: SOURCE, lane: 0, now_ms: NOW, not_before_ms: NOW });
      return tx.tables.jobs.get("import", SOURCE)!;
    });
    const begun = db.commit((tx) => importKind.begin!(main, tx, job))!;
    expect([begun.state.run > runs.second, begun.state.relisted, db.commit((tx) => [tx.tables.runs.get(runs.first), tx.tables.deliveries.get("import/1", SOURCE)?.run])])
      .toEqual([true, true, [r1, begun.state.run]]);
  });

  it("the sweep decides a file from one snapshot: an admission whose claims grew between any two of its reads keeps the file until its new read is whole", () => {
    const read = (db: HomeDb, run: number) => db.commit((tx) => {
      tx.tables.deliveries.move("import/1", SOURCE, { move: "begin", run });
      tx.tables.deliveries.move("import/1", SOURCE, { move: "land", run, refused: 0, error: null, code: "code-1" });
      importImported(tx, "import/1", SOURCE, { consumed: [FILE], refused: 0 }, null);
    });
    const older = (look: Looked): Looked => ({ ...look, listing: { ...look.listing, files: look.listing.files.map((file) => ({ ...file, unclaimed: 1 })), products: look.listing.products.map((product) => ({ ...product, unclaimed: 1 })) } });
    const readWhole = () => {
      const { root, db } = home();
      sealDelivery(root, "import", "1", { [`files/${FILE}`]: zip([["Spotify Account Data/Streaming_History_Audio_2025.json", Buffer.from("[]")], ["Spotify Account Data/Streaming_History_Video_2025.json", Buffer.from("[]")]]) }, FACTS);
      admit(db, "import/1", older(looked("aa", [HISTORY])));
      db.commit((tx) => tx.tables.deliveries.add({ id: "import/1", source: SOURCE, sealed_ms: NOW, stated_ms: NOW, facts: FACTS }));
      read(db, db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: `${SOURCE} import/1`, started_ms: NOW })));
      return { root, db, file: join(root, "inbox", "import", "1", "files", FILE) };
    };
    const pass = (root: string, db: HomeDb, between: { after: number; work: () => void } | null = null) => {
      let reads = 0;
      const lookup = <T>(work: (tables: ReadTables) => T): T => {
        const view = db.view();
        try {
          return work(view.tables);
        } finally {
          view.close();
          if (++reads === between?.after) between.work();
        }
      };
      const report = sweepInbox({ folder: openHomeFolder(root), read: lookup, commit: (work) => db.commit(work), blobs: openHomeFolder(root).blobs(join(root, "blobs")), now_ms: NOW, off: [], connectors: declarations() });
      return { report, reads };
    };
    const quiet = readWhole();
    const { reads } = pass(quiet.root, quiet.db);
    expect([existsSync(quiet.file), reads > 1]).toEqual([true, true]);
    for (let after = 1; after <= reads; after++) {
      const { root, db, file } = readWhole();
      pass(root, db, { after, work: () => void admit(db, "import/1", looked("aa", [HISTORY, VIDEO])) });
      expect([after, existsSync(file), db.commit((tx) => tx.tables.deliveries.get("import/1", SOURCE)?.state)]).toEqual([after, true, "sealed"]);
      read(db, db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: `${SOURCE} import/1`, started_ms: NOW })));
      pass(root, db);
      expect([after, existsSync(file)]).toEqual([after, false]);
    }
  });

  it("the sweep's decision and its removal are one step against admission: one after the pass's snapshot keeps the file until its new claim reads it whole; one after the file is let go claims nothing of it", () => {
    const read = (db: HomeDb) => db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "import", subject: `${SOURCE} import/1`, started_ms: NOW });
      tx.tables.deliveries.move("import/1", SOURCE, { move: "begin", run });
      tx.tables.deliveries.move("import/1", SOURCE, { move: "land", run, refused: 0, error: null, code: "code-1" });
      importImported(tx, "import/1", SOURCE, { consumed: [FILE], refused: 0 }, null);
    });
    const readWhole = () => {
      const { root, db } = home();
      sealDelivery(root, "import", "1", { [`files/${FILE}`]: zip([["Spotify Account Data/Streaming_History_Audio_2025.json", Buffer.from("[]")], ["Spotify Account Data/Streaming_History_Video_2025.json", Buffer.from("[]")]]) }, FACTS);
      admit(db, "import/1", looked("aa", [HISTORY]));
      db.commit((tx) => tx.tables.deliveries.add({ id: "import/1", source: SOURCE, sealed_ms: NOW, stated_ms: NOW, facts: FACTS }));
      read(db);
      return { root, db, file: join(root, "inbox", "import", "1", "files", FILE) };
    };
    const pass = (root: string, db: HomeDb, at: number | null, admission: () => void) => {
      let steps = 0;
      const step = () => void (++steps === at && admission());
      const lookup = <T>(work: (tables: ReadTables) => T): T => {
        const view = db.view();
        try {
          return work(view.tables);
        } finally {
          view.close();
          step();
        }
      };
      sweepInbox({
        folder: openHomeFolder(root), read: lookup, blobs: openHomeFolder(root).blobs(join(root, "blobs")), now_ms: NOW, off: [], connectors: declarations(),
        commit: <T>(work: (tx: Parameters<Parameters<HomeDb["commit"]>[0]>[0]) => T): T => {
          step();
          const done = db.commit(work);
          step();
          return done;
        },
      });
      return steps;
    };
    const quiet = readWhole();
    const steps = pass(quiet.root, quiet.db, null, () => undefined);
    expect([existsSync(quiet.file), steps > 1]).toEqual([false, true]);
    const outcomes = new Set<string>();
    for (let at = 1; at <= steps; at++) {
      const { root, db, file } = readWhole();
      pass(root, db, at, () => void admit(db, "import/1", looked("aa", [HISTORY, VIDEO])));
      const state = db.commit((tx) => tx.tables.deliveries.get("import/1", SOURCE)?.state);
      if (state === "sealed") {
        expect([at, existsSync(file)]).toEqual([at, true]);
        read(db);
        pass(root, db, null, () => undefined);
        expect([at, existsSync(file)]).toEqual([at, false]);
      } else {
        const claims = db.commit((tx) => listingOf(tx.tables.meta, "import/1")!.routes.filter((route) => route.files.includes(FILE)).map((route) => route.members));
        expect([at, state, existsSync(file), claims]).toEqual([at, "imported", false, [HISTORY.members]]);
      }
      outcomes.add(state!);
    }
    expect([...outcomes].sort()).toEqual(["imported", "sealed"]);
  });
});
