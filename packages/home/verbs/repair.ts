import { resolve } from "node:path";
import { tally, type OpenView, type PlanTally, type RepairAt, type RepairPlan } from "@lifestreamprotocol/core";
import { queueRepair, readFix } from "../repair.js";
import { readArgs, required } from "./args.js";
import { fail, type VerbContext } from "./context.js";

const USAGE = "repair --source <source> [--kinds <kind,kind>] --reason <why> --fix <module> [--apply]";
const PROGRESS_MS = 10_000;
const EXAMPLES = 10;

export async function repair(ctx: VerbContext, args: readonly string[]) {
  const { values } = readArgs("repair", args, {
    source: { type: "string" }, kinds: { type: "string" }, reason: { type: "string" }, fix: { type: "string" }, apply: { type: "boolean" },
  }, USAGE, 0);
  const source = required(values.source, "source", USAGE);
  const reason = required(values.reason, "reason", USAGE);
  const fix = await readFix(resolve(ctx.cwd, required(values.fix, "fix", USAGE)));
  const kinds = values.kinds?.split(",");
  if (kinds?.some((kind) => kind === "") === true) fail(`--kinds is kinds separated by commas, not ${JSON.stringify(values.kinds)}`);
  const view = ctx.db.view();
  let walked: string[];
  try {
    if (view.tables.sources.get(source) === undefined) fail(`no source ${source}`);
    walked = [...new Set(kinds ?? view.kinds(source))].sort();
  } finally {
    view.close();
  }
  if (values.apply !== true) {
    return { applied: false, reason, ...dryRun<RepairAt>(ctx, (page, at) => page.planRepair({ source, kinds: walked, fix: (head) => fix.fix(head, ctx.blobs) }, at)) };
  }
  const run = ctx.db.commit((tx) => queueRepair(tx, ctx.now(), { kind: "repair", subject: source }, {
    source, kinds: walked, reason, fix: { path: fix.path, sha256: fix.sha256 }, at: null,
  }));
  return { queued: true, run, job: `repair ${run}`, source, kinds: walked, reason };
}
repair.usage = USAGE;

export function dryRun<At>(ctx: VerbContext, read: (view: OpenView, at: At | null) => RepairPlan<At>) {
  const total: PlanTally = { counts: { heads: 0, changed: 0, gone: 0, kept: 0, moved: 0, refused: 0 }, changedPaths: {}, refusals: [] };
  const examples: RepairPlan["examples"] = [];
  let at: At | null = null;
  let said = Date.now();
  for (;;) {
    const view = ctx.db.view();
    let page: RepairPlan<At>;
    try {
      page = read(view, at);
    } finally {
      view.close();
    }
    const tallied = tally(page.steps);
    for (const [name, count] of Object.entries(tallied.counts)) total.counts[name as keyof PlanTally["counts"]] += count;
    for (const [path, count] of Object.entries(tallied.changedPaths)) total.changedPaths[path] = (total.changedPaths[path] ?? 0) + count;
    total.refusals.push(...tallied.refusals.slice(0, EXAMPLES - total.refusals.length));
    examples.push(...page.examples.slice(0, EXAMPLES - examples.length));
    if (page.next === null) break;
    at = page.next;
    if (Date.now() - said >= PROGRESS_MS) {
      said = Date.now();
      const { heads, changed, gone, refused } = total.counts;
      ctx.going(`read ${heads} heads: ${changed} changed, ${gone} gone, ${refused} refused so far`);
    }
  }
  return { counts: total.counts, changed_paths: total.changedPaths, examples, refusals: total.refusals };
}
