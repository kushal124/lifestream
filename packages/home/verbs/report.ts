import { report as readReport } from "../report.js";
import { readArgs, wholeNumber } from "./args.js";
import type { VerbContext } from "./context.js";

const HOUR_MS = 3_600_000;

export async function report(ctx: VerbContext, args: readonly string[]) {
  const { values } = readArgs("report", args, { hours: { type: "string" } }, report.usage, 0);
  const hours = values.hours === undefined ? 24 : wholeNumber(values.hours, "--hours", (n) => n >= 1, "a whole number of hours, 1 or more");
  const to_ms = ctx.now();
  return readReport(ctx.folder, { from_ms: to_ms - hours * HOUR_MS, to_ms });
}
report.usage = "report [--hours <n>]";
