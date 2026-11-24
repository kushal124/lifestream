import { accountName, SourceNameError, sourceName } from "@lifestreamprotocol/core";
import type { Link } from "../pairing.js";
import { identity, listening, matchOf, pairLink, reach } from "../lan.js";
import { effective } from "../settings.js";
import { holdpoint } from "../failpoint.js";
import { readArgs } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const LOOPBACK = "127.0.0.1";
const USAGE = "pair [--replace <unit>] [--account <apple id>] | pair show [--account <apple id>] | pair check <code>";

export async function pair(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("pair", args, { replace: { type: "string" }, account: { type: "string" } }, USAGE, { min: 0, max: 2 });
  const pairing = ctx.pairing ?? fail("pairing needs the running home: its codes live in its memory (start the home, then pair again)");
  const [action, code] = positionals;
  if (action === "check") {
    if (code === undefined || values.replace !== undefined || values.account !== undefined) return fail(`usage: ${CLI} ${USAGE}`);
    const state = pairing.state(code);
    ctx.out(`code ${code}: ${state.state === "used" ? `used by ${state.unit}` : state.state}`);
    return { code, ...state };
  }
  if ((action !== undefined && action !== "show") || code !== undefined || (action === "show" && values.replace !== undefined)) return fail(`usage: ${CLI} ${USAGE}`);
  let account: string | null;
  try {
    account = values.account === undefined ? suggested(ctx) : accountName(values.account);
  } catch (error) {
    if (error instanceof SourceNameError) return fail(`--account: ${error.message}`);
    throw error;
  }
  let minted: { code: string; unit: string | null; expires_ms: number } & Link;
  try {
    if (action === "show") minted = { ...await pairing.show((shown) => linkOf(ctx, shown, account)), unit: null };
    else {
      const byHand = pairing.mint(values.replace ?? null);
      minted = { ...byHand, ...await linkOf(ctx, byHand.code, account) };
    }
  } catch (error) {
    return fail((error as Error).message);
  }
  const { link, why } = minted;
  const match = matchOf(identity(ctx.folder.root), minted.code);
  ctx.out(`code ${minted.code}${minted.unit === null ? "" : ` replaces ${minted.unit}`}, match ${match}, until ${new Date(minted.expires_ms).toISOString()}`);
  ctx.out(link === null ? `no link: ${why} An app on this Mac pairs with this code at http://${LOOPBACK}:${effective(ctx.folder).settings.door.port}` : `link ${link}`);
  return { code: minted.code, unit: minted.unit, expires_ms: minted.expires_ms, link, ...(why === null ? {} : { why }), match, account };
}
pair.usage = USAGE;

async function linkOf(ctx: VerbContext, code: string, account: string | null): Promise<Link> {
  await holdpoint("pair.link", code);
  const port = effective(ctx.folder).settings.door.lan_port ?? 0;
  const addresses = await listening(ctx.folder.root, port) ? reach(ctx.machine, port) : [];
  if (addresses.length === 0) return { link: null, why: `Lifestream can't open its Wi-Fi connection. Quit what uses port ${port}, or restart Lifestream.` };
  return { link: pairLink({ code, addresses, fingerprint: identity(ctx.folder.root).fingerprint, account }), why: null };
}

function suggested(ctx: VerbContext): string | null {
  const unit = effective(ctx.folder).settings.unit;
  if (unit === null) return null;
  const counts = new Map<string, number>();
  const view = ctx.db.view();
  try {
    for (const source of view.tables.sources.list()) {
      const parts = sourceName(source.id);
      if (source.vendor !== "apple" || parts.copy !== unit || !parts.account.includes("@")) continue;
      const account = accountName(parts.account);
      counts.set(account, (counts.get(account) ?? 0) + 1);
    }
  } finally {
    view.close();
  }
  return [...counts].sort(([a, m], [b, n]) => n - m || (a < b ? -1 : 1))[0]?.[0] ?? null;
}
