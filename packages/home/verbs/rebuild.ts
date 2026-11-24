import { rebuildExtracts } from "../derive.js";
import { rebuildBegan } from "../due.js";
import { indexNamed } from "../index-job.js";
import { readArgs, required } from "./args.js";
import { fail, familyOf, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "rebuild extracts --family <family> [--from YYYY-MM-DD --to YYYY-MM-DD] | rebuild enrichments --family <family> | rebuild search | rebuild screen";
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export async function rebuild(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("rebuild", args, { family: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, USAGE, 1);
  const [what] = positionals;
  if (what === "search" || what === "screen") {
    if (values.family !== undefined || values.from !== undefined || values.to !== undefined) fail(`rebuild ${what} takes no option`);
    const now = ctx.now();
    return ctx.db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: `rebuild-${what}`, subject: "index", started_ms: now });
      const generation = indexNamed(what)!.build(tx, now);
      tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts: { generation } });
      return { run, generation };
    });
  }
  if (what !== "extracts" && what !== "enrichments") return fail(`usage: ${CLI} ${USAGE}`);
  const family = (await familyOf(ctx, required(values.family, "family", USAGE))).name;
  const now = ctx.now();
  if (values.from !== undefined || values.to !== undefined) {
    if (what !== "extracts") fail("--from and --to name the days of a rebuild of extracts");
    const from = required(values.from, "from", USAGE);
    const to = required(values.to, "to", USAGE);
    if (!DAY.test(from) || !DAY.test(to)) fail(`--from and --to are days, YYYY-MM-DD, not ${JSON.stringify(DAY.test(from) ? to : from)}`);
    if (from > to) fail(`--from ${from} is after --to ${to}`);
    return ctx.db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "rebuild-extracts", subject: family, started_ms: now });
      const units = tx.derived.extracts.unitsOn(family, from, to);
      const reread = tx.records.rereadUnits(family, units);
      tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts: { units: reread } });
      ctx.out(`${reread} units of ${family} on ${from}..${to} to extract again`);
      return { run, family, from, to, units: reread };
    });
  }
  if (what === "extracts") {
    return ctx.db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "rebuild-extracts", subject: family, started_ms: now });
      const generation = rebuildExtracts(tx, family, now);
      rebuildBegan(tx, family, generation, ["verb"]);
      tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts: { generation } });
      return { run, family, generation };
    });
  }
  return ctx.db.commit((tx) => {
    const run = tx.tables.runs.start({ kind: "rebuild-enrichments", subject: family, started_ms: now });
    const units = tx.derived.extracts.units(family).map((row) => row.unit);
    tx.tables.dirty.units(family, units);
    tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts: { units: units.length } });
    return { run, family, units: units.length };
  });
}
rebuild.usage = USAGE;
