import { putBack } from "../derive.js";
import { BY_HAND, queuedFor } from "../import.js";
import { connectorOfJob, covers, LANE } from "../jobs.js";
import { ANY_KEY, KINDS, ONE_KEY, unpausable, unrun } from "../kinds.js";
import { heldRunners } from "../principals.js";
import { readArgs, required, wholeNumber } from "./args.js";
import { fail, type VerbContext } from "./context.js";

const LANES: readonly number[] = Object.values(LANE);

function lane(value: string, name: string): number {
  return wholeNumber(value, name, (number) => LANES.includes(number), `one of ${LANES.join(", ")}`);
}

function sourcesIn(ctx: VerbContext): ReadonlySet<string> {
  const view = ctx.db.view();
  try {
    return new Set(view.tables.sources.list().map((source) => source.id));
  } finally {
    view.close();
  }
}

async function inputs(ctx: VerbContext, kind: string) {
  const fixed = (!Object.hasOwn(KINDS, kind) && kind !== "pause") || Object.hasOwn(ONE_KEY, kind) || ANY_KEY.includes(kind);
  return { registry: fixed ? { families: [], connectors: [], readers: [] } : await ctx.registry(), sources: kind === "import" ? sourcesIn(ctx) : new Set<string>() };
}

const RUN = `run <kind> <key> [--lane ${LANES.join("|")}]`;
const PAUSE = "pause home|kind:<kind>|<kind>:<key>|pause:<connector>|pause:<connector>:history|runner:<unit> --reason <words>";
const RESUME = "resume home|kind:<kind>|<kind>:<key>|pause:<connector>|pause:<connector>:history|runner:<unit>";

export async function run(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("run", args, { lane: { type: "string" } }, RUN, 2);
  const [name, key] = positionals as [string, string];
  const at = values.lane === undefined ? LANE.live : lane(values.lane, "--lane");
  const { registry, sources } = await inputs(ctx, name);
  const why = unrun(registry, sources, name, key);
  if (why !== null) fail(why);
  const now = ctx.now();
  return ctx.db.commit((tx) => {
    const revived = tx.tables.jobs.revive(now, { kind: name, key }).length > 0;
    const connector = connectorOfJob(registry, tx.tables, name, key);
    const enqueued = tx.tables.jobs.enqueue({ kind: name, key, connector, lane: at, not_before_ms: now, now_ms: now });
    if (name === "poll") queuedFor(tx, key, BY_HAND);
    const state = revived ? "queued" : enqueued;
    const held = covers(new Set(tx.tables.controls.list().map((control) => control.target)), { kind: name, key, connector });
    return {
      kind: name, key, lane: at, state,
      ...(name === "extract" ? { retried: putBack(tx, key) } : name === "plan" ? { retried: tx.tables.dirty.retry(key) } : name === "render" ? { retried: tx.tables.dirty.retryDays() } : {}),
      ...(name === "import" ? { unread: tx.tables.deliveries.unreadAgain(key) } : {}),
      ...(held === null ? {} : { held }),
    };
  });
}
run.usage = RUN;

export async function pause(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("pause", args, { reason: { type: "string" } }, PAUSE, 1);
  const paused = positionals[0]!;
  const kind = paused === "home" || paused.startsWith("kind:") ? "" : paused.split(":")[0]!;
  const { registry, sources } = await inputs(ctx, kind);
  const runners = kind === "runner" ? heldRunners(ctx.folder) : new Set<string>();
  const why = unpausable(registry, sources, paused, runners);
  if (why !== null) fail(why);
  return stand(ctx, paused, required(values.reason, "reason", PAUSE));
}
pause.usage = PAUSE;

export async function resume(ctx: VerbContext, args: readonly string[]) {
  const { positionals } = readArgs("resume", args, {}, RESUME, 1);
  return lift(ctx, positionals[0]!, ctx.by !== "terminal");
}
resume.usage = RESUME;

const actor = (ctx: VerbContext): string => ctx.by ?? fail("a pause or a resume names who acts (by): terminal, you or a pass's unit");

export function stand(ctx: VerbContext, target: string, reason: string | undefined): { paused: string; by: string } {
  const by = actor(ctx);
  if (by === "terminal" && (reason === undefined || reason === "")) fail(`a pause from the terminal states why: --reason <words>`);
  const now = ctx.now();
  ctx.db.commit((tx) => {
    const standing = tx.tables.controls.list().find((control) => control.target === target);
    if (standing !== undefined && standing.by === by && standing.reason === (reason ?? "")) return;
    tx.tables.controls.set({ target, reason: reason ?? "", at_ms: now, by });
    tx.tables.events.append({ at_ms: now, kind: "pause", key: target, detail: { by, reason: reason ?? "" } });
  });
  return { paused: target, by };
}

export function lift(ctx: VerbContext, target: string, once = false): { resumed: string } {
  const view = ctx.db.view();
  let standing: boolean;
  try {
    standing = view.tables.controls.list().some((control) => control.target === target);
  } finally {
    view.close();
  }
  const by = actor(ctx);
  if (!standing) return once ? { resumed: target } : fail(`no pause stands on ${target}`);
  const now = ctx.now();
  ctx.db.commit((tx) => {
    tx.tables.controls.clear(target);
    tx.tables.events.append({ at_ms: now, kind: "resume", key: target, detail: { by } });
  });
  return { resumed: target };
}
