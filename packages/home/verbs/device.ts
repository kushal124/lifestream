import { deviceName, nameDevice } from "../devices.js";
import { readPrincipals, retireUnit } from "../principals.js";
import { readArgs, required } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "device add <unit> --model <model> | device retire <unit> | device name <unit> <name>";

export function device(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("device", args, { model: { type: "string" } }, USAGE, { min: 2, max: 3 });
  const [what, unit, word] = positionals as [string, string, string | undefined];
  const now = ctx.now();
  if (what !== "name" && word !== undefined) fail(`usage: ${CLI} ${USAGE}: ${JSON.stringify(word)} is not an argument of device`);
  if (what === "add") {
    const model = required(values.model, "model", USAGE);
    return ctx.db.commit((tx) => {
      const known = tx.tables.devices.get(unit);
      if (known !== undefined) fail(`device ${unit} exists${known.retired_ms === null ? "" : `, retired at ${new Date(known.retired_ms).toISOString()}`}`);
      tx.tables.devices.add({ unit, model, added_ms: now });
      tx.tables.events.append({ at_ms: now, kind: "device-add", key: unit, detail: { model } });
      return { unit, model, added_ms: now };
    });
  }
  if (what === "retire") {
    if (values.model !== undefined) fail(`device retire takes no --model\nusage: ${CLI} ${USAGE}`);
    return ctx.db.commit((tx) => {
      const known = tx.tables.devices.get(unit) ?? fail(`no device ${unit}: device add names one`);
      if (known.retired_ms !== null) fail(`device ${unit} was retired at ${new Date(known.retired_ms).toISOString()}`);
      retireUnit(ctx.folder, unit, now);
      tx.tables.devices.retire(unit, now);
      tx.tables.events.append({ at_ms: now, kind: "device-retire", key: unit });
      return { ...known, retired_ms: now };
    });
  }
  if (what === "name") {
    if (values.model !== undefined) fail(`device name takes no --model\nusage: ${CLI} ${USAGE}`);
    const name = nameOf(word);
    const paired = readPrincipals(ctx.folder).principals.some((principal) => principal.kind !== null && principal.unit === unit);
    return ctx.db.commit((tx) => {
      if (tx.tables.devices.get(unit) === undefined && !paired) fail(`no device ${unit}: the home holds no device of that unit`);
      nameDevice(tx, unit, name, now);
      return { unit, name };
    });
  }
  return fail(`usage: ${CLI} ${USAGE}`);
}
device.usage = USAGE;

function nameOf(typed: string | undefined): string {
  const named = deviceName(typed ?? "");
  if ("refused" in named) return fail(`${named.refused}${typed?.trim() ? "" : `\nusage: ${CLI} ${USAGE}`}`);
  return named.name;
}
