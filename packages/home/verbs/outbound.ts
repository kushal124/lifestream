import { civilDay } from "@lifestreamprotocol/core";
import { readArgs, wholeNumber } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "outbound [<seq>] [--from <day>] [--to <day>] [--receiver <name>] [--before <seq>]";

export function outbound(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("outbound", args, {
    from: { type: "string" }, to: { type: "string" }, receiver: { type: "string" }, before: { type: "string" },
  }, USAGE, { min: 0, max: 1 });
  const { day } = ctx.settings;
  if (positionals.length === 1) {
    const seq = wholeNumber(positionals[0]!, "the row", (number) => number > 0, "an outbound row's seq");
    return ctx.ledger.outbound.row(seq, day) ?? fail(`no outbound row ${seq}`);
  }
  const from = values.from ?? civilDay(ctx.now(), day);
  try {
    return ctx.ledger.outbound.list({
      from, to: values.to ?? from, day, ...(values.receiver === undefined ? {} : { receiver: values.receiver }),
      ...(values.before === undefined ? {} : { before: wholeNumber(values.before, "--before", (number) => number > 0, "an outbound row's seq") }),
    });
  } catch (error) {
    if (error instanceof RangeError) fail(`${error.message}\nusage: ${CLI} ${USAGE}`);
    throw error;
  }
}
outbound.usage = USAGE;
