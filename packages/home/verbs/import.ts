import { open, opendir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { HomeFile } from "../home-file.js";
import { filesAt, sealImport } from "../import-file.js";
import { lookAtInbox } from "../import.js";
import { readImports } from "../imports-report.js";
import { answerImport, heldImports, importIdOf, isVoid, listingOf, type HeldImport } from "../imports.js";
import { CLI } from "../cli-name.js";
import { readArgs } from "./args.js";
import { fail, type VerbContext } from "./context.js";

const USAGE = "import <kind> <path> [--account <account>]";
export const STILL_MS = 3_000;

export interface ImportAnswer {
  import: string | null;
  kind: string;
  line: string;
  delivery: string;
}

export async function importVerb(ctx: VerbContext, args: readonly string[]): Promise<ImportAnswer> {
  const { values, positionals } = readArgs("import", args, { account: { type: "string" } }, USAGE, 2);
  const [kind, given] = positionals as [string, string];
  const account = values.account?.trim();
  if (account !== undefined && (account === "" || /[:/\\\0\s]/u.test(account))) fail("--account names an account: no colon, slash, backslash, space or NUL");
  if (ctx.committed === undefined) fail(`${CLI} import hands a file to a running home: start it first`);
  const registry = await ctx.registry();
  const path = resolve(ctx.cwd, given);
  let delivery: string;
  try {
    await reaching(path, ctx.out);
    delivery = await sealImport(ctx.folder, registry, kind, filesAt(path), ctx.now());
  } catch (error) {
    return fail(`${CLI} import: ${(error as Error).message}`);
  }
  ctx.db.commit((tx) => lookAtInbox(tx, ctx.now()));
  let joined = await admitted(ctx, delivery);
  if (account !== undefined && joined.id !== null && joined.held !== undefined && joined.held.ended !== true) {
    if (joined.held.account !== null) fail(`its files name ${joined.held.account}: --account answers whose an export is only where it names none`);
    const spelled = account.includes("@") ? account.toLowerCase() : account;
    if (joined.held.named !== undefined && !joined.held.named.includes(spelled)) fail(`its files name ${joined.held.named.join(" and ")}: --account is one of them`);
    const asked = joined.id;
    ctx.db.commit((tx) => {
      answerImport(tx, asked, spelled);
      lookAtInbox(tx, ctx.now());
    });
    joined = await admitted(ctx, delivery);
  }
  const id = joined.void ? null : joined.id;
  const held = id === null ? undefined : new HomeFile(ctx.folder, 5_000).read((db) => readImports(db, {
    folder: ctx.folder, now_ms: ctx.now(), connectors: registry.connectors, free_bytes: Number.MAX_SAFE_INTEGER, max_bundle_bytes: Number.MAX_SAFE_INTEGER,
    day: ctx.settings.day, stated: null,
  }).imports.find((each) => each.kind === kind)?.held.find((each) => each.id === id));
  const line = joined.void ? "Already imported" : held?.line ?? "Imported";
  ctx.out(id === null ? `${kind}: ${line}` : `${kind} import ${id}: ${line}`);
  return { import: id, kind, line, delivery };
}
importVerb.usage = USAGE;

export async function reaching(path: string, say: (line: string) => void, read: (path: string) => Promise<unknown> = firstBytes, after_ms = STILL_MS): Promise<void> {
  say(`Reading ${basename(path)}…`);
  const asking = setTimeout(() => say(`Still reading ${basename(path)}: macOS may be asking on this Mac's screen to let Lifestream read ${basename(dirname(path))}. Allow it there.`), after_ms);
  try {
    await read(path);
  } finally {
    clearTimeout(asking);
  }
}

async function firstBytes(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    if ((await handle.stat()).isDirectory()) {
      const folder = await opendir(path);
      try {
        await folder.read();
      } finally {
        await folder.close();
      }
    } else await handle.read(Buffer.alloc(1), 0, 1, null);
  } finally {
    await handle.close();
  }
}

async function admitted(ctx: VerbContext, delivery: string): Promise<{ id: string | null; held: HeldImport | undefined; void: boolean }> {
  for (;;) {
    const view = ctx.db.view();
    let state: { id: string | null; held: HeldImport | undefined; void: boolean; listed: boolean; dead: boolean };
    try {
      const { meta, jobs } = view.tables;
      const id = importIdOf(meta, delivery);
      state = { id, held: id === null ? undefined : heldImports(meta)[id], void: isVoid(meta, delivery), listed: listingOf(meta, delivery) !== null, dead: jobs.get("index-inbox", "inbox")?.state === "dead" };
    } finally {
      view.close();
    }
    if (state.void || (state.id !== null && state.listed)) return state;
    if (state.dead) fail(`${CLI} import: the inbox look (index-inbox inbox) is dead: ${CLI} run index-inbox revives it`);
    await ctx.committed!();
  }
}
