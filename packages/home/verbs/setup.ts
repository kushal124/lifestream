import { atKey, skipKey } from "../connectors.js";
import { readPrincipals } from "../principals.js";
import { readArgs } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "setup skip <mac unit> <step> | setup at <mac unit> <screen>";
const STEP = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export function setup(ctx: VerbContext, args: readonly string[]) {
  const { positionals } = readArgs("setup", args, {}, USAGE, 3);
  const [what, unit, step] = positionals as [string, string, string];
  if (what !== "skip" && what !== "at") return fail(`usage: ${CLI} ${USAGE}`);
  if (!STEP.test(step) || step.length > 32) fail(`setup ${what}: ${JSON.stringify(step)} is not a ${what === "at" ? "screen" : "step"}'s name (a lower-case word, hyphens between its parts)`);
  const mac = readPrincipals(ctx.folder).principals.some((principal) => principal.kind === "mac" && principal.unit === unit);
  if (!mac) fail(`setup ${what}: the home holds no Mac ${unit}`);
  if (what === "at") {
    ctx.db.commit((tx) => tx.tables.meta.set(atKey(unit), step));
    return { unit, at: step };
  }
  return ctx.db.commit((tx) => {
    const marked = tx.tables.meta.get(skipKey(unit, step));
    if (marked !== undefined) return { unit, step, at_ms: Number(marked) };
    const now = ctx.now();
    tx.tables.meta.set(skipKey(unit, step), String(now));
    tx.tables.events.append({ at_ms: now, kind: "setup-skip", key: unit, detail: { step } });
    return { unit, step, at_ms: now };
  });
}
setup.usage = USAGE;
