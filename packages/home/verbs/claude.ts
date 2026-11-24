import { checkClaude } from "@lifestreamprotocol/model";
import { machine } from "../machine.js";
import { readArgs } from "./args.js";
import type { VerbContext } from "./context.js";

export async function claude(_ctx: VerbContext, args: readonly string[]) {
  readArgs("claude", args, {}, claude.usage, 0);
  return checkClaude(machine().claude ?? undefined);
}
claude.usage = "claude";
