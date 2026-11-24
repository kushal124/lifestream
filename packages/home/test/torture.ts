import type { JsonObject } from "@lifestreamprotocol/core";
import type { Home } from "../home.js";
import { artifact, ChildHome, hex, makeRoot, readHome, readLedger, removeRoot, settled, snapshot, TICK_MS, until } from "./harness-root.js";
import { ship, type Planned } from "./harness-deliveries.js";
import { startHere } from "./harness-home.js";

const DEVICES = ["apple-notes:local:device-a", "apple-notes:local:device-b", "apple-notes:local:device-c"];
const ROUNDS = 8;
const NOTES = 30;
const BASE = Math.floor((Date.now() - 20 * 60_000) / 1_000) * 1_000;

export const PLANNED: Planned[] = plan();

function plan(): Planned[] {
  const planned: Planned[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    DEVICES.forEach((source, device) => {
      const fetched_ms = BASE + round * 60_000 + device * 7_000;
      const rows: JsonObject[] = [];
      for (let index = 0; index < NOTES; index++) {
        const at = fetched_ms - (NOTES - index) * 1_000;
        const content: JsonObject = { text: `note ${device}-${round}-${index}`, at };
        if (index === 0 && round % 2 === 0) content.photo = true;
        rows.push({ kind: "note", key: `${device}-${round}-${index}`, content, at });
      }
      if (round > 0) {
        for (let index = 1; index < 6; index++) {
          const at = fetched_ms - 60_000 - (NOTES - index) * 1_000;
          rows.push({ kind: "note", key: `${device}-${round - 1}-${index}`, content: { text: `note ${device}-${round - 1}-${index}`, at }, at });
        }
        const at = fetched_ms - 60_000 - (NOTES - 6) * 1_000;
        rows.push({ kind: "note", key: `${device}-${round - 1}-6`, content: { text: `note ${device}-${round - 1}-6 edited`, at }, at });
      }
      const bytes = Buffer.from(`synthetic attachment ${device}-${round}`);
      const blob = hex(bytes);
      const at = fetched_ms - 500;
      rows.push({ kind: "note", key: `${device}-${round}-blob`, content: { text: `attachment ${device}-${round}`, at, blob: `sha256:${blob}` }, at, blobs: [`sha256:${blob}`] });
      planned.push({ source, fetched_ms, rows, carried: { [blob]: bytes } });
    });
  }
  return planned;
}

export interface TortureSnapshot {
  snapshot: ReturnType<typeof snapshot>;
  kills: number;
}

export async function tortureRun(failpoint: string | undefined, planned: Planned[] = PLANNED): Promise<TortureSnapshot> {
  const root = makeRoot("lifestream-torture-", { sources: Object.fromEntries(DEVICES.map((source) => [source, "fake-rows"])), fake: { delay_ms: 50 } });
  const child = failpoint === undefined ? null : new ChildHome(root);
  let here: Home | null = null;
  const alive = (): boolean => child?.alive ?? true;
  let kills = 0;
  const recover = async (): Promise<void> => {
    const exit = await child!.exited();
    if (exit.signal === "SIGKILL") kills++;
    else throw new Error(`the child home ended by itself: ${JSON.stringify(exit)}`);
    child!.start();
    await child!.ready();
  };
  try {
    if (child === null) here = await startHere(root, { tickMs: TICK_MS, log: () => undefined });
    else {
      child.start(failpoint);
      await child.ready();
    }
    for (const delivery of planned) {
      await ship(root, delivery);
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (!alive()) await recover();
    }
    for (;;) {
      await until(`the home settled (${failpoint ?? "calm"})`, () => settled(root, planned.length) || !alive()).catch((error: Error) => {
        throw new Error(`${error.message}: ${JSON.stringify(unsettled(root))}`);
      });
      if (alive()) break;
      await recover();
    }
    if (here !== null) await here.stop();
    else {
      const exit = await child!.stop();
      if (exit.code !== 0) throw new Error(`the child home stopped with ${JSON.stringify(exit)}`);
    }
    const result = { snapshot: snapshot(root), kills };
    artifact(root, `torture-${failpoint ?? "calm"}`, result);
    return result;
  } finally {
    child?.kill();
    await here?.stop();
    removeRoot(root);
  }
}

function unsettled(root: string): unknown {
  return {
    home: readHome(root, (db) => ({
      jobs: db.prepare("SELECT kind, key, state, lane, attempts, requeue, not_before_ms, error FROM jobs WHERE state <> 'done'").all(),
      top: db.prepare("SELECT max(seq) FROM statements").pluck().get(),
      cursors: db.prepare("SELECT name, seq, reread, generation FROM cursors").all(),
      dirty: { days: db.prepare("SELECT day FROM dirty_days").pluck().all(), units: db.prepare("SELECT family, unit FROM dirty_units").all() },
      waiting: db.prepare("SELECT id, source, state, failures, error FROM deliveries WHERE state <> 'imported'").all(),
      pending: db.prepare("SELECT family, item, unit, waits, retry_ms FROM asks WHERE state = 'pending'").all(),
      rereads: db.prepare("SELECT count(*) FROM rereads").pluck().get(),
    })),
    ledger: readLedger(root, (db) => ({
      open: db.prepare("SELECT key, unit, open FROM requests WHERE open = 1").all(),
      attempts: db.prepare("SELECT key, state FROM attempts WHERE state = 'sending'").all(),
    })),
  };
}
