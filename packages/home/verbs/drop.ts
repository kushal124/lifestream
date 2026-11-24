import { isUnread, isWaiting, type DeliveryRow, type Tx } from "@lifestreamprotocol/core";
import { outstandingOf } from "../imports-report.js";
import { importDropped, importIdOf, importIn } from "../imports.js";
import type { ImportProgress } from "../import.js";
import { DROPPED, type Dropped } from "../status.js";
import { readArgs } from "./args.js";
import { fail, familyOf, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "drop item <family> <item> [--reason <why>] | drop job <kind> <key>\n"
  + `       ${CLI} drop job import <source> gives up the delivery its source waits at: the device may forget its copy; its bytes stay in the inbox`;

export async function drop(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("drop", args, { reason: { type: "string" } }, USAGE, 3);
  const [what, first, second] = positionals as [string, string, string];
  const now = ctx.now();
  if (what === "item") {
    const family = (await familyOf(ctx, first)).name;
    return ctx.db.commit((tx) => {
      const rows = tx.derived.enrichments.list(family, { item: second });
      if (!rows.some((row) => row.state === "given-up")) fail(`${family} ${second} is not given up`);
      tx.tables.meta.set(`${DROPPED}${family}/${second}`, JSON.stringify({ reason: values.reason ?? "dropped by the owner", at_ms: now } satisfies Dropped));
      return { dropped: `${family}/${second}` };
    });
  }
  if (what === "job") {
    if (values.reason !== undefined) fail(`drop job takes no --reason\nusage: ${CLI} ${USAGE}`);
    const { code } = await ctx.registry();
    return dropped(ctx, first, second, ctx.db.commit((tx) => dropJobIn(tx, now, code, first, second)));
  }
  return fail(`usage: ${CLI} ${USAGE}`);
}
drop.usage = USAGE;

export function dropJobIn(tx: Tx, now: number, code: string, kind: string, key: string): DeliveryRow | undefined {
  const job = tx.tables.jobs.get(kind, key) ?? fail(`no job ${kind} ${key}`);
  if (job.state !== "dead" && !(kind === "import" && job.state === "queued")) fail(`${kind} ${key} is ${job.state}, not dead`);
  const progress = kind === "import" ? job.progress as ImportProgress | null : null;
  const run = progress === null ? undefined : tx.tables.runs.get(progress.run);
  if (run !== undefined && run.counts === null) {
    const { changedPaths, refusals, consumed: _consumed, ...counts } = progress!.counts;
    tx.tables.runs.end(run.id, { ended_ms: run.ended_ms ?? now, outcome: "failed", error: run.error ?? job.error ?? "given up", counts: { ...counts, refusals: refusals as never }, changed_paths: changedPaths });
  }
  tx.tables.jobs.finish(job.id, now);
  const reading = progress === null ? undefined : tx.tables.deliveries.get(progress.delivery, key);
  const blocking = kind !== "import" ? undefined : reading === undefined ? tx.tables.deliveries.next(key) : isWaiting(reading) ? reading : undefined;
  if (blocking !== undefined) givenUp(tx, [{ ...blocking, source: key, ...(blocking === reading ? { refused: progress!.counts.refused } : {}) }], code);
  else if (reading !== undefined && isUnread(reading)) tx.tables.deliveries.move(reading.id, key, { move: "reread", code });
  if (reading !== undefined) partRead(tx, reading, key, progress!);
  tx.tables.events.append({ at_ms: now, kind: "drop", key: `${kind}/${key}`, detail: { error: job.error, ...(blocking === undefined ? {} : { delivery: blocking.id }) } });
  return blocking;
}

export function giveUpIn(tx: Tx, now: number, code: string, key: string, rows: readonly { id: string; source: string }[]): DeliveryRow[] {
  const given = rows.flatMap((each) => {
    const row = tx.tables.deliveries.get(each.id, each.source);
    return row !== undefined && outstandingOf(row) ? [row] : [];
  });
  givenUp(tx, given, code);
  if (given.length > 0) tx.tables.events.append({ at_ms: now, kind: "drop", key, detail: { deliveries: given.map((row) => `${row.id} ${row.source}`) } });
  return given;
}

function partRead(tx: Tx, reading: Pick<DeliveryRow, "id" | "run" | "facts">, source: string, progress: ImportProgress): void {
  if (progress.tally === undefined) return;
  const first = reading.run === progress.run;
  const refusedMembers = new Map(progress.members ?? []);
  importDropped(tx, reading.id, source, { refused: progress.counts.refused, refusedMembers }, progress.tally, !first);
}

function givenUp(tx: Tx, rows: readonly (Pick<DeliveryRow, "id" | "source" | "facts"> & { refused?: number })[], code: string): void {
  for (const row of rows) tx.tables.deliveries.move(row.id, row.source, { move: "give-up", code, ...(row.refused === undefined ? {} : { refused: row.refused }) });
  for (const id of new Set(rows.flatMap((row) => importIdOf(tx.tables.meta, row.id) ?? []))) importIn(tx, id);
}

export function dropped(ctx: VerbContext, kind: string, key: string, blocking: DeliveryRow | undefined) {
  if (blocking !== undefined && blocking.pass !== null) ctx.going(`the device may forget its copy of ${blocking.id}; its bytes stay in the inbox`);
  return { dropped: `${kind} ${key}`, ...(blocking === undefined ? {} : { delivery: blocking.id }) };
}
