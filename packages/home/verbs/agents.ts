import type { JsonObject } from "@lifestreamprotocol/core";
import { ANSWER_ROUTE, offeredOf, WAITING_ROUTE, type AgentAsk, type AgentRead, type AnswerReply, type HistoryPage, type WaitingList } from "../access-routes.js";
import { defaultAccess } from "../access.js";
import { settleAccess } from "../access-move.js";
import { Agents } from "../agents.js";
import { publicStatus } from "../funnel.js";
import { readArgs } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";
import { CALL_USAGE } from "../agent-call.js";

const USAGE = `agents | agents list | agents notes | agents waiting | agents answer [--access <json>] [--] <id> <number|deny|once|always|no> | agents add [--anywhere] [--] <name> | agents disconnect [--] <id> | agents unlist [--] <id> | agents access [--] <id> [set <json>] | agents history [--] <id> | agents public on|off|status | ${CALL_USAGE}`;

export async function agents(ctx: VerbContext, args: readonly string[]) {
  const { positionals, values } = readArgs("agents", args, { anywhere: { type: "boolean" }, access: { type: "string" } }, USAGE, { min: 0, max: 4 });
  const [action, first, second, third] = positionals;
  const words = positionals.length;
  if (values.anywhere === true && action !== "add") fail(`--anywhere is add's alone\nusage: ${CLI} ${USAGE}`);
  if (values.access !== undefined && action !== "answer") fail(`--access is answer's alone\nusage: ${CLI} ${USAGE}`);
  if (action === "list" && words === 1) return { agents: (await agentsOf(ctx)).list() };
  if (action === undefined) {
    const listed = (await agentsOf(ctx)).list();
    for (const agent of listed) ctx.out(`${agent.id} ${agent.name}: ${agent.via === "sign-in" ? `signed in${agent.from === null ? "" : ` from ${agent.from}`}` : `copied pass${agent.anywhere ? " from anywhere" : ""}`}, ${agent.minted_at}`);
    return { agents: listed, public: await publicStatus(ctx.machine) };
  }
  if (action === "notes" && words === 1) {
    const notes = (await agentsOf(ctx)).notes();
    for (const note of notes) ctx.out(`${note.at} ${shown(note.who)} ${note.category}${note.tool === null ? "" : ` (${shown(note.tool)})`}: ${shown(note.message)}`);
    return { notes };
  }
  if (action === "waiting" && words === 1) {
    const list = await door(ctx)(WAITING_ROUTE) as unknown as WaitingList;
    for (const signIn of list.requests) ctx.out(`${signIn.id} ${shown(signIn.name)} signs in${signIn.host === null ? "" : ` from ${shown(signIn.host)}`}: ${shown(signIn.sentence)}`);
    for (const ask of list.asks) ctx.out(`${ask.id} ${shown(ask.head)}${ask.reason === null ? "" : ` "${shown(ask.reason)}"`}`);
    return list;
  }
  if (action === "answer" && words === 3) {
    const pick = /^\d{6}$/u.test(second!) ? second! : ["deny", "once", "always", "no"].includes(second!) ? second! : fail(`an answer is the 6-digit code the sign-in page shows or deny, or once, always or no\nusage: ${CLI} ${USAGE}`);
    const expect = pick === "once" || pick === "always" ? (await door(ctx)(`/v1/agents/asks/${encodeURIComponent(first!)}`) as unknown as AgentAsk).version : undefined;
    const answered = await door(ctx)(ANSWER_ROUTE, { id: first!, answer: pick, ...(values.access === undefined ? {} : { access: accessArg(values.access) }), ...(expect === undefined ? {} : { expect }) } as JsonObject) as unknown as AnswerReply;
    ctx.out(`${first}: ${answered.state}${answered.outcome === null ? "" : ` (${answered.outcome})`}`);
    return answered;
  }
  if (action === "add" && words === 2) {
    const added = (await agentsOf(ctx)).add(first!, `http://127.0.0.1:${ctx.settings.door.port}`, values.anywhere === true, defaultAccess(), null);
    ctx.out(`a pass for ${added.agent.name}, ${added.agent.id}${added.agent.anywhere ? ", from anywhere" : ""}: shown once, stored nowhere`);
    ctx.out(`pass: ${added.pass}`);
    ctx.out(`Claude Code: run this, then paste the pass: ${added.claude_code}`);
    ctx.out("Claude Desktop: add this to its claude_desktop_config.json:");
    for (const line of added.claude_desktop.split("\n")) ctx.out(line);
    return added;
  }
  if (action === "disconnect" && words === 2) {
    const gone = (await agentsOf(ctx)).disconnect(first!);
    ctx.out(`${gone.id} ${gone.name}: disconnected, its history kept`);
    return {};
  }
  if (action === "unlist" && words === 2) {
    const list = await door(ctx)(`/v1/agents/${encodeURIComponent(first!)}/unlist`, {});
    ctx.out(`${first}: off the list, its history kept`);
    return list;
  }
  if (action === "access" && (words === 2 || (words === 4 && second === "set"))) {
    const route = `/v1/agents/${encodeURIComponent(first!)}`;
    const read = await door(ctx)(route) as unknown as AgentRead;
    if (words === 2) {
      ctx.out(`${read.id} ${read.name}: ${read.view.summary} (version ${read.version})`);
      ctx.out(JSON.stringify(read.access));
      return read;
    }
    const saved = await door(ctx)(`${route}/access`, { access: accessArg(third!), expect: read.version } as JsonObject) as unknown as { expect: number; view: { summary: string } };
    ctx.out(`${read.id} ${read.name}: ${saved.view.summary} (version ${saved.expect})`);
    return saved;
  }
  if (action === "history" && words === 2) {
    const page = await door(ctx)(`/v1/agents/${encodeURIComponent(first!)}/history`) as unknown as HistoryPage;
    for (const session of page.sessions) {
      ctx.out(`${new Date(session.from_ms).toISOString()} to ${new Date(session.to_ms).toISOString()}, ${session.calls} call${session.calls === 1 ? "" : "s"}`);
      for (const line of session.lines.flatMap((each) => (each.kind === "fold" ? each.lines : [each]))) {
        ctx.out(`  ${new Date(line.at_ms).toISOString()} ${shown(line.words)}${line.line !== null ? `: ${shown(line.line)}` : ""}`);
      }
    }
    if (page.next !== null) ctx.out(page.next.words);
    return page;
  }
  if (action === "public" && words === 2 && (first === "on" || first === "off" || first === "status")) {
    const state = first === "status" ? await publicStatus(ctx.machine) : await (await agentsOf(ctx)).address(first === "on");
    ctx.out(`reach from anywhere: ${state.state}${state.state !== "on" || state.origin === null ? "" : ` at ${state.origin}/mcp`}${state.why === null ? "" : ` (${state.why})`}`);
    return state;
  }
  return fail(`usage: ${CLI} ${USAGE}`);
}
agents.usage = USAGE;

function shown(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (each) => `\\u${each.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function accessArg(text: string): JsonObject {
  try {
    return JSON.parse(text) as JsonObject;
  } catch {
    return fail(`an access is one JSON value\nusage: ${CLI} ${USAGE}`);
  }
}

function door(ctx: VerbContext): (route: string, body?: JsonObject) => Promise<JsonObject> {
  return ctx.door ?? fail("an agent's access is read and set through the door: start the home, then ask again");
}

async function agentsOf(ctx: VerbContext): Promise<Agents> {
  if (ctx.agents !== undefined) return ctx.agents;
  const { connectors, families } = await ctx.registry();
  const existing = () => {
    const view = ctx.db.view();
    try {
      return offeredOf(view.sources(), connectors, families).map(({ account, category }) => ({ account, category }));
    } finally {
      view.close();
    }
  };
  settleAccess({ folder: ctx.folder, access: ctx.ledger.access, existing, now_ms: ctx.now() });
  return new Agents({ folder: ctx.folder, machine: ctx.machine, commit: (work) => ctx.db.commit(work), tables: ctx.ledger.placeholders, access: ctx.ledger.access, existing, now: () => ctx.now() });
}
