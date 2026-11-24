import { readArgs } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";
import { SHOWN_MS, TYPED_MS } from "../pairing.js";

const USAGE = "connect [answer <id> allow|deny]";

export async function connect(ctx: VerbContext, args: readonly string[]) {
  const { positionals } = readArgs("connect", args, {}, USAGE, { min: 0, max: 3 });
  const pairing = ctx.pairing ?? fail(`no home is running on ${ctx.folder.root} to take it: a browser's ask to connect lives in the running home's memory. Once ${CLI} status says the home runs, connect again`);
  const [action, first, second] = positionals;
  if (action === undefined) {
    const typed = ctx.by === "terminal";
    const lease = typed ? TYPED_MS : SHOWN_MS;
    const now = pairing.connecting(lease);
    const held = lease >= 60_000 ? `${lease / 60_000} minutes` : `${lease / 1_000} s`;
    if (now.requests.length === 0) {
      ctx.out(`no browser asks yet: Lifestream waits ${held} for one. A browser with the Lifestream extension asks within 30 s; ${CLI} connect lists it`);
    }
    for (const request of now.requests) ctx.out(`${request.id}: ${request.browser} asks to connect; ${CLI} connect answer ${request.id} allow lets it in, deny turns it away`);
    return now;
  }
  if (action !== "answer" || first === undefined || (second !== "allow" && second !== "deny")) return fail(`usage: ${CLI} ${USAGE}`);
  let answered: ReturnType<typeof pairing.answer>;
  try {
    answered = pairing.answer(first, second === "allow");
  } catch (error) {
    return fail((error as Error).message);
  }
  ctx.out(`${first}: ${second === "allow" ? "allowed" : "not now"}`);
  return answered;
}
connect.usage = USAGE;
