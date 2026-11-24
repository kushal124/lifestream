import { checkCodex } from "@lifestreamprotocol/model";
import { machine } from "../machine.js";
import { readArgs } from "./args.js";
import type { VerbContext } from "./context.js";

export async function codex(_ctx: VerbContext, args: readonly string[]) {
  readArgs("codex", args, {}, codex.usage, 0);
  return checkCodex(machine().codex ?? undefined);
}
codex.usage = "codex";
