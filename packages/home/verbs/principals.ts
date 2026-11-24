import { rememberRevoked } from "../lifecycle.js";
import { SCOPES, mintPrincipal, resumePrincipal, revokePrincipal, type Scope } from "../principals.js";
import { readArgs } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "principals mint --unit <reader> --scope read [--scope deliver --source <source>…] | principals mint --unit <name> --scope find | principals revoke <id> | principals resume <id>";

export function principals(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("principals", args, {
    unit: { type: "string" }, scope: { type: "string", multiple: true }, source: { type: "string", multiple: true },
  }, USAGE, { min: 1, max: 2 });
  if (positionals[0] === "mint" && positionals.length === 1) {
    const scopes = values.scope ?? [];
    const unknown = scopes.find((scope) => !(SCOPES as readonly string[]).includes(scope));
    if (unknown !== undefined) fail(`--scope is ${SCOPES.join(" or ")}, not ${JSON.stringify(unknown)}`);
    if (values.unit === undefined || scopes.length === 0) fail(`usage: ${CLI} ${USAGE}`);
    if (scopes.includes("find")) {
      if (scopes.length !== 1 || values.source !== undefined) fail(`a find pass places finds, and nothing else: --scope find alone\nusage: ${CLI} ${USAGE}`);
    } else if (!scopes.includes("read") || scopes.includes("station") || scopes.includes("drive")) {
      fail(`a reader's pass reads: a device pairs instead (${CLI} pair), and the home mints its own drive pass\nusage: ${CLI} ${USAGE}`);
    }
    const { principal, token } = mintPrincipal(ctx.folder, { unit: values.unit, scopes: scopes as Scope[], sources: values.source ?? [], now_ms: ctx.now() });
    ctx.out(`token for ${principal.id} (shown once, never stored): ${token}`);
    return { principal, token };
  }
  const named = values.unit !== undefined || values.scope !== undefined || values.source !== undefined;
  if (positionals[0] === "revoke" && positionals.length === 2 && !named) {
    rememberRevoked(ctx.machine, ctx.folder.root, [positionals[1]!]);
    const principal = revokePrincipal(ctx.folder, positionals[1]!, ctx.now());
    ctx.db.commit((tx) => tx.tables.events.append({ at_ms: ctx.now(), kind: "pass-revoked", key: principal.id, detail: { unit: principal.unit } }));
    return { principal };
  }
  if (positionals[0] === "resume" && positionals.length === 2 && !named) return { principal: resumePrincipal(ctx.folder, positionals[1]!) };
  return fail(`usage: ${CLI} ${USAGE}`);
}
principals.usage = USAGE;
