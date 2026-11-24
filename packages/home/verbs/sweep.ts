import { rehydrate as rehydrateDelivery, sweepInbox } from "../sweep.js";
import type { ReadTables } from "@lifestreamprotocol/core";
import { readArgs } from "./args.js";
import type { VerbContext } from "./context.js";

export async function sweep(ctx: VerbContext, args: readonly string[]) {
  readArgs("sweep", args, {}, sweep.usage, 0);
  if (ctx.background !== undefined) {
    ctx.background();
    return { queued: "sweep" };
  }
  const read = <T>(work: (tables: ReadTables) => T): T => {
    const view = ctx.db.view();
    try {
      return work(view.tables);
    } finally {
      view.close();
    }
  };
  return sweepInbox({ folder: ctx.folder, read, commit: (work) => ctx.db.commit(work), blobs: ctx.blobs, now_ms: ctx.now(), off: ctx.settings.sources.off, connectors: (await ctx.registry()).connectors });
}
sweep.usage = "sweep";

export async function rehydrate(ctx: VerbContext, args: readonly string[]) {
  const { positionals } = readArgs("rehydrate", args, {}, rehydrate.usage, 1);
  return rehydrateDelivery({ folder: ctx.folder, blobs: ctx.blobs, delivery: positionals[0]! });
}
rehydrate.usage = "rehydrate <source>/<name>";
