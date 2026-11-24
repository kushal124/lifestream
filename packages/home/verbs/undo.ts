import { queueRepair, stopRepair } from "../repair.js";
import { readArgs, wholeNumber } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { dryRun } from "./repair.js";

const USAGE = "undo <run> [--apply]";

export function undo(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("undo", args, { apply: { type: "boolean" } }, USAGE, 1);
  const run = wholeNumber(positionals[0]!, "the run", (number) => number > 0, "a run's number");
  const reason = `undo run ${run}`;
  if (values.apply !== true) {
    let through: number | undefined;
    return { applied: false, reason, ...dryRun<number>(ctx, (view, at) => {
      if (through === undefined) {
        if (view.tables.runs.get(run) === undefined) fail(`no run ${run}`);
        through = view.through;
      }
      return view.planUndo(run, { through, after: at ?? 0 });
    }) };
  }
  const now = ctx.now();
  return ctx.db.commit((tx) => {
    if (tx.tables.runs.get(run) === undefined) fail(`no run ${run}`);
    const through = tx.records.top();
    const undoing = queueRepair(tx, now, { kind: "undo", subject: `run ${run}` }, { undo: run, through, at: 0 });
    const stopped = stopRepair(tx, run, now, `stopped by undo run ${undoing}`);
    return { queued: true, run: undoing, job: `repair ${undoing}`, reason, ...(stopped ? { stopped: run } : {}) };
  });
}
undo.usage = USAGE;
