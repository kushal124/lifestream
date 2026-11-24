import { openHome, openHomeFolder, type HomeDb, type JobRow, type Json, type JsonObject, type Tx } from "@lifestreamprotocol/core";
import { Due } from "../due.js";
import { indexKind, indexNudged } from "../import.js";
import { openSealing, type Custody, type Received as Stamped } from "../inbox.js";
import type { HelperEnv, Main, Running } from "../jobs.js";
import { mintPrincipal } from "../principals.js";
import { quietKind } from "../quiet.js";
import { effective } from "../settings.js";
import { keptOf, leftOf, stateLeft, waitingOf, type Kept, type Received, type Statement, type Value, type Waiting } from "../through.js";
import type { StatedThrough } from "../wire.js";
import { makeRoot, removeRoot } from "./harness-root.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const MAC_SOURCE = "screen:local:macbook-pro-0001";
export const PHONE_SOURCE = "location:local:iphone-aa01";
export const PHONE_OTHER = "apple-health:local:iphone-aa01";
export const COAST_SOURCE = "coast:local:macbook-pro-0001";
export const PASS_P = "p-0000000a";
export const PASS_Q = "p-0000000b";

const iso = (ms: number): string => new Date(ms).toISOString();

export function value(read_through_ms: number, stated_ms = read_through_ms, more: Pick<Value, "left" | "start_ms" | "months"> = {}): Value {
  return { read_through_ms, stated_ms, ...more };
}

export function stated(of: Value): StatedThrough {
  return {
    read_through: iso(of.read_through_ms), stated_at: iso(of.stated_ms),
    ...(of.left === undefined ? {} : { left: of.left }), ...(of.start_ms === undefined ? {} : { start_ms: of.start_ms }),
    ...(of.months === undefined ? {} : { months: of.months }),
  };
}

export function statement(of: Value, received: Received = {}, at_ms = of.stated_ms): Statement {
  return { value: of, received, at_ms };
}

export interface ThroughHome {
  readonly root: string;
  db: HomeDb;
  now: number;
  commit<T>(work: (tx: Tx) => T): T;
  reopen(): void;
  readThrough(source: string): number | null;
  kept(source: string): Kept;
  waiting(source: string): Waiting | undefined;
  imported(pass: string, source: string): number;
  close(): void;
}

export function throughHome(prefix: string, now: number): ThroughHome {
  const root = makeRoot(prefix, { sources: { [MAC_SOURCE]: "fake-rows", [PHONE_SOURCE]: "fake-rows", [PHONE_OTHER]: "fake-rows", [COAST_SOURCE]: "fake-rows" } });
  const open = () => openHome(openHomeFolder(root), "migrate");
  const dueOf = () => new Due({
    folder: openHomeFolder(root), settings: effective(root).settings, registry: { connectors: [], readers: [], families: [], code: "test" },
    families: new Map(), now: () => home.now, running: () => undefined,
  });
  let due = dueOf();
  const home: ThroughHome = {
    root,
    db: open(),
    now,
    commit: (work) => home.db.commit((tx) => {
      const done = work(tx);
      due.after(tx);
      return done;
    }),
    reopen: () => {
      due.close();
      home.db.close();
      home.db = open();
      due = dueOf();
    },
    readThrough: (source) => home.db.commit((tx) => tx.tables.sources.get(source)?.read_through_ms ?? null),
    kept: (source) => home.db.commit((tx) => keptOf(tx.tables.meta, source)),
    waiting: (source) => home.db.commit((tx) => waitingOf(tx.tables.meta, source)),
    imported: (pass, source) => home.db.commit((tx) => tx.tables.custody.imported(pass, source)),
    close: () => {
      due.close();
      home.db.close();
      removeRoot(root);
    },
  };
  return home;
}

export function sealed(tx: Tx, row: { id: string; source: string; sealed_ms: number; stated_ms?: number; pass?: string; seal?: number; facts?: JsonObject }): void {
  tx.tables.deliveries.add({
    id: row.id, source: row.source, sealed_ms: row.sealed_ms, stated_ms: row.stated_ms ?? row.sealed_ms, facts: row.facts ?? {},
    pass: row.pass ?? null, seal: row.seal ?? null,
  });
}

export function deliveryLeft(tx: Tx, source: string, facts: JsonObject, stated_ms: number): void {
  const left = leftOf(facts);
  if (left !== null) stateLeft(tx, source, { ...left, stated_ms, from: "delivery" });
}

export function delivered(tx: Tx, row: { id: string; source: string; sealed_ms: number; stated_ms?: number; facts: JsonObject; pass?: string; seal?: number }): void {
  sealed(tx, row);
  deliveryLeft(tx, row.source, row.facts, row.stated_ms ?? row.sealed_ms);
}

export function settled(tx: Tx, id: string, source: string, at_ms: number, read_through_ms?: number): void {
  const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: at_ms });
  tx.tables.deliveries.move(id, source, { move: "begin", run });
  tx.tables.deliveries.move(id, source, { move: "land", run, refused: 0, error: null, code: "sha256:code-1" });
  if (read_through_ms !== undefined) tx.tables.sources.advance(source, read_through_ms);
  tx.tables.runs.end(run, { ended_ms: at_ms, outcome: "ok" });
}

export function custodyAt(tx: Tx, pass: string, source: string, seals: number, at_ms: number): void {
  for (let seal = 1; seal <= seals; seal++) {
    const id = `lane-${pass}/${source}-${seal}`;
    sealed(tx, { id, source, sealed_ms: at_ms, pass, seal });
    settled(tx, id, source, at_ms);
  }
}

export function heartbeatFacts(stated_ms: number, read_through_ms: number, left?: { left: number; start_ms?: number | null }): JsonObject {
  return {
    snapshot_taken_at: iso(stated_ms), read_through: iso(read_through_ms),
    ...(left === undefined ? {} : { left: left.left, ...(left.start_ms === undefined ? {} : { start_ms: left.start_ms }) }),
  };
}

export function phoneFacts(sealed_ms: number, carries: readonly string[], sat_out: readonly string[] = []): JsonObject {
  const domains: JsonObject = {};
  for (const domain of carries) domains[`${domain}.jsonl`] = { observations: 1, first_sequence: 1, last_sequence: 1 };
  return {
    bundle_id: `bundle-${sealed_ms}`, created_at: iso(sealed_ms), install_id: "install-aa01",
    time_range_covered: { start: iso(sealed_ms - MINUTE), end: iso(sealed_ms) }, domains, blobs_carried: 0, blobs_referenced: 0,
    ...(sat_out.length === 0 ? {} : { sat_out: [...sat_out] }),
  };
}

export const PHONE_UNIT = "iphone-aa01";
export const PHONE_LANE = `phone:${PHONE_UNIT}`;

export function phonePass(home: ThroughHome): string {
  const { principal } = mintPrincipal(openHomeFolder(home.root), { unit: PHONE_UNIT, kind: "phone", scopes: ["deliver"], sources: [PHONE_SOURCE, PHONE_OTHER], now_ms: home.now });
  home.db.commit((tx) => {
    for (const source of [PHONE_SOURCE, PHONE_OTHER]) tx.tables.sources.restate(source, { lane: PHONE_LANE });
  });
  return principal.id;
}

export function ship(home: ThroughHome, shipment: {
  pass: string; sealed_ms: number; stated_ms?: number; carries: readonly string[]; sat_out?: readonly string[]; custody?: Custody; received?: Stamped;
}): string {
  const name = `bundle-${shipment.sealed_ms}`;
  const sealing = openSealing(openHomeFolder(home.root), { source: PHONE_LANE, name, feeder: "ios-bundle", fetched_at: iso(shipment.sealed_ms) });
  const facts = { ...phoneFacts(shipment.sealed_ms, shipment.carries, shipment.sat_out), created_at: iso(shipment.stated_ms ?? shipment.sealed_ms) };
  sealing.seal(facts, undefined, {
    pass: shipment.pass, sealed_at: iso(shipment.sealed_ms), ...(shipment.custody === undefined ? {} : { custody: shipment.custody }),
    ...(shipment.received === undefined ? {} : { received: shipment.received }),
  });
  return `${PHONE_LANE}/${name}`;
}

export function mainOf(home: Pick<ThroughHome, "root" | "now">, lines: Json[] = [], off: readonly string[] = []): Main {
  const settings = effective(home.root).settings;
  return {
    folder: openHomeFolder(home.root), settings: { ...settings, sources: { off: [...off] } }, now: () => home.now, ending: 0, log: (line: Json) => void lines.push(line), polled: () => undefined,
    registry: { connectors: [], readers: [{ name: "fake-rows" }], families: [], acquirers: [], labelers: [], code: "test" },
  } as unknown as Main;
}

export function nudge(home: ThroughHome, id: string, lines: Json[] = []): number {
  return home.commit((tx) => indexNudged(mainOf(home, lines), tx, id));
}

export function beginLook(home: ThroughHome, lines: Json[] = []): { end(): Promise<void> } {
  const main = mainOf(home, lines);
  const begun = home.commit((tx) => indexKind.begin!(main, tx, {} as JobRow)!);
  const running = { job: {} as JobRow, state: begun.state } as Running<typeof begun.state>;
  return {
    async end() {
      const env = { folder: openHomeFolder(home.root), db: home.db, registry: main.registry, reading: () => undefined } as unknown as HelperEnv;
      const pages = indexKind.helper(env, { job: 0, kind: "index-inbox", key: "inbox", lane: 1, now_ms: home.now, data: begun.data });
      for (let page = await pages.next(); ; page = await pages.next()) {
        if (page.done === true) {
          home.commit((tx) => indexKind.done(main, tx, running, page.value));
          return;
        }
        for (const slice of indexKind.chunk!(main, running, page.value)) home.commit((tx) => slice.work(tx));
      }
    },
  };
}

export async function look(home: ThroughHome, lines: Json[] = []): Promise<void> {
  await beginLook(home, lines).end();
}

export async function quietRun(
  home: Pick<ThroughHome, "root" | "db" | "now" | "commit">, lines: Json[] = [], options: { off?: readonly string[]; commits?: number; beforeClear?: () => void } = {},
): Promise<boolean> {
  const main = mainOf(home, lines, options.off);
  const commits = options.commits ?? Infinity;
  const begun = home.commit((tx) => quietKind.begin!(main, tx, {} as JobRow)!);
  const running = { job: { lane: 1 } as JobRow, state: begun.state } as Running<typeof begun.state>;
  const env = { folder: openHomeFolder(home.root), db: home.db, committed: () => Promise.resolve() } as unknown as HelperEnv;
  let made = 0;
  for await (const turn of quietKind.helper(env, { job: 0, kind: "quiet", key: "rows", lane: 1, now_ms: home.now, data: undefined })) {
    if (made++ === commits) return false;
    if (turn !== null) options.beforeClear?.();
    for (const slice of quietKind.chunk!(main, running, turn)) home.commit((tx) => slice.work(tx));
  }
  home.commit((tx) => quietKind.done(main, tx, running, undefined));
  return running.again === undefined;
}
