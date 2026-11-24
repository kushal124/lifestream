import { join } from "node:path";
import { chromeSites, connectorName, formOf, roadsOf, ROUTE, StationFailed, vendorOf, type Acquirer, type ChromeSite, type Connector, type DoorStations } from "@lifestreamprotocol/connect";
import { canonical, SourceNameError, type Json, type JsonObject, type ReadTables } from "@lifestreamprotocol/core";
import type { StreamsReport } from "../streams-report.js";
import { catalogOf, switchOf } from "../catalog.js";
import { shownOf } from "../connectors.js";
import { HomeFile } from "../home-file.js";
import { readStreams } from "../status.js";
import { BY_HAND, pageAgain, pageTurns, pollStatus, queuePoll, rereadPoll, type Call, type PollStatus } from "../import.js";
import { targetOf } from "../attempts.js";
import { reasonWords, when, wordsOf } from "../stream-words.js";
import { machine } from "../machine.js";
import { LANE, pauseTarget } from "../jobs.js";
import { blockOf, checkMember, chosenWith, connectorSettings, effective, planned, plannedBlock, SettingsError, type Member, type Shown } from "../settings.js";
import { DOOR_AWAY, Refusal, refuse } from "../refusal.js";
import { read, readArgs } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { FOLDER_USAGE } from "./connectors-folder.js";
import { storedOf } from "./models.js";
import { routeLines } from "./signin.js";
import { builds as homeBuilds } from "../registry-home.js";
import { lift, stand } from "./loop.js";
import { refresh, type HomeRefresh } from "./act.js";
import { macRefreshes } from "../refresh-now.js";
import type { RefreshAnswer } from "../wire.js";
import { CLI } from "../cli-name.js";

const SETTING_REFUSED = "SETTING_REFUSED";

const USAGE = "connectors [--unit <mac unit>] | connectors show <id> | connectors set <id> <member> <value> [<member> <value>…] [--was <value>] | connectors reset <id> <member>… | "
  + "connectors pause <id> [--reason <words>] | connectors resume <id> | connectors backfill <id> pause|resume|now [--reason <words>] | connectors on <id|source|unit> | connectors off <id|source|unit> | connectors refresh <id> | connectors reread <id> | connectors check | "
  + FOLDER_USAGE;

export async function connectors(ctx: VerbContext, args: readonly string[]) {
  const { positionals, values } = parsed(args);
  const [action, id, member] = positionals;
  if (action === undefined) {
    const registry = await ctx.registry();
    const report = new HomeFile(ctx.folder, 5_000).read((db) =>
      readStreams(db, { folder: ctx.folder, now_ms: ctx.now(), settings: ctx.settings, registry, ledger: ctx.ledger, machine: machine().dir, sites: null, present: [], refused: [], stated: null, ...(values.unit === undefined ? {} : { unit: values.unit }) }))!;
    printed(report, registry.connectors, ctx.out);
    return report;
  }
  const words = positionals.length;
  if (action === "show" && words === 2) return await show(ctx, await declared(ctx, id!));
  if (action === "set" && words >= 4 && words % 2 === 0) {
    const named = pairs(positionals.slice(2)).map(([each, typed]) => [each, read(typed)] as const);
    return await setMembers(ctx, await declared(ctx, id!), named, values.was === undefined ? undefined : read(values.was));
  }
  if (action === "reset" && words >= 3) return await setMembers(ctx, await declared(ctx, id!), positionals.slice(2).map((each) => [each, undefined] as const));
  if ((action === "pause" || action === "resume") && words === 2) {
    const target = pauseTarget((await declared(ctx, id!)).id);
    return action === "pause" ? stand(ctx, target, values.reason) : lift(ctx, target, true);
  }
  if (action === "backfill" && words === 3) return backfill(ctx, await declared(ctx, id!), member!, values.reason);
  if ((action === "on" || action === "off") && words === 2) return turn(ctx, id!, action === "on");
  if (action === "refresh" && words === 2) {
    const connector = await declared(ctx, id!);
    if (ctx.by !== "you" && ctx.refreshAll !== undefined && connectorRoadsOf(connector).includes("mac") && macRefreshes(connector)) return await refreshEverywhere(ctx, connector, ctx.refreshAll);
    const present = connector.chrome === undefined ? null : await viaDoor(ctx, (stations) => stations.present());
    return refresh(ctx, connector, present ?? null);
  }
  if (action === "reread" && words === 2) return await reread(ctx, await declared(ctx, id!));
  if (action === "check" && words === 1) return await check(ctx);
  return fail(`usage: ${CLI} ${USAGE}`);
}
connectors.usage = USAGE;

const pairs = (words: readonly string[]): [string, string][] => words.flatMap((word, at) => (at % 2 === 0 ? [[word, words[at + 1]!] as [string, string]] : []));

export function relayConnectors(args: readonly string[], read: (route: string) => Promise<JsonObject>, out: (line: string) => void, declared: readonly Connector[]): Promise<JsonObject> | null {
  const { positionals, values } = parsed(args);
  if (positionals.length > 0) return null;
  return read(`/v1/connectors${values.unit === undefined ? "" : `?unit=${encodeURIComponent(values.unit)}`}`).then((report) => {
    printed(report as unknown as StreamsReport, declared, out);
    return report;
  });
}

function parsed(args: readonly string[]) {
  const { positionals, values } = readArgs("connectors", args, { unit: { type: "string" }, was: { type: "string" }, reason: { type: "string" } }, USAGE, { min: 0, max: Infinity });
  const action = positionals[0];
  if (values.unit !== undefined && action !== undefined) fail(`connectors ${action} takes no --unit\nusage: ${CLI} ${USAGE}`);
  if (values.was !== undefined && action !== "set") fail(`${action === undefined ? "connectors" : `connectors ${action}`} takes no --was\nusage: ${CLI} ${USAGE}`);
  if (values.was !== undefined && positionals.length !== 4) fail(`--was is the value one member was: set that member alone\nusage: ${CLI} ${USAGE}`);
  return { positionals, values };
}

function printed(report: StreamsReport, declared: readonly Connector[], out: (line: string) => void): void {
  for (const connector of report.connectors) {
    out(`${connector.name}: ${connector.set_up ? "set up" : "not set up"}, ${connector.copies.length} cop${connector.copies.length === 1 ? "y" : "ies"}; ${connector.line}`);
  }
  for (const connector of declared.filter((each) => each.hidden === true)) out(`${connectorName(connector)}: not offered yet`);
}

async function declared(ctx: VerbContext, id: string): Promise<Connector> {
  const { connectors: all } = await ctx.registry();
  return all.find((connector) => connector.id === id) ?? fail(`no connector ${id}; the home runs ${all.map((connector) => connector.id).join(", ") || "none"}`);
}

function memberLine(member: Member): string {
  const whose = member.from === "person" ? "yours" : member.from === "declaration" ? "the default" : "not set";
  const bounds = member.min === undefined && member.max === undefined ? "" : `, ${member.min ?? "any"} to ${member.max ?? "any"}`;
  const defaulted = member.from === "person" && member.default !== undefined ? `, default ${JSON.stringify(member.default)}` : "";
  const written = member.written === undefined ? "" : `, written ${JSON.stringify(member.written)} and run at the bound`;
  return `${member.member} = ${member.value === null ? "-" : JSON.stringify(member.value)}  (${whose}${defaulted}${bounds}${written})`;
}

interface LastCall {
  call: "fetch" | "page";
  source: string | null;
  at_ms: number;
  outcome: string;
  reason: string | null;
  words: string;
  detail: string | null;
  fails: number;
}

interface PollShown extends Pick<PollStatus, "now" | "read"> {
  acquirer: string;
  next_ms: number | null;
  held_ms: number | null;
  calls: LastCall[];
}

interface DeliveryShown {
  source: string;
  sealed_ms: number;
  state: string;
  counts: JsonObject | null;
}

const STATE_OF: Readonly<Record<string, string>> = { ok: "ok", wait: "waiting", need: "needs-you", fail: "broken" };
const OUTCOME_WORDS: Readonly<Record<string, string>> = { ok: "read", wait: "waiting", need: "needs you", fail: "failed" };

async function show(ctx: VerbContext, connector: Connector): Promise<{ connector: string; members: Member[]; polls: PollShown[]; deliveries: DeliveryShown[] }> {
  const running = connectorSettings(connector, ctx.settings.connectors[connector.id]);
  for (const member of running.members) ctx.out(memberLine(member));
  for (const notice of running.notices) ctx.out(`(info) ${notice.what}`);
  const registry = await ctx.registry();
  for (const line of routeLines(connector, registry.clients ?? [])) ctx.out(line);
  const built = builtOf(registry, connector);
  const now = ctx.now();
  const day = ctx.settings.day;
  const say = (ms: number) => when(ms, now, day);
  const name = connectorName(connector);
  const noun = connector.noun === undefined ? null : [...connector.noun] as [string, string];
  const { polls, deliveries } = withView(ctx, (view) => {
    const catalog = catalogOf(registry.connectors);
    const sources = view.tables.sources.list().filter((row) => catalog.of(row) === connector).map((row) => row.id);
    const polls = built.map((acquirer): PollShown => {
      const row = view.tables.polls.get(acquirer.name);
      const calls = (["fetch", "page"] as const).flatMap((call) => view.tables.attempts.of(targetOf(call, acquirer.name)).map((attempt): LastCall => ({
        call, source: attempt.source === "" ? null : attempt.source, at_ms: attempt.at_ms, outcome: attempt.outcome, reason: attempt.reason,
        words: reasonWords(STATE_OF[attempt.outcome] ?? attempt.outcome, attempt.reason, wordsOf(name, noun, now, day, { ...attempt.facts, connector: connector.id })),
        detail: attempt.outcome === "ok" ? null : attempt.detail, fails: attempt.fails,
      })));
      const { now: standing, read } = pollStatus(view.tables, acquirer.name);
      return {
        acquirer: acquirer.name, next_ms: row === undefined ? null : Math.max(row.next_ms, row.held_ms ?? 0), held_ms: row?.held_ms ?? null,
        now: standing, read, calls,
      };
    });
    return { polls, deliveries: sources.flatMap((source) => newestOf(view.tables, source)) };
  });
  if (built.length === 0 && (connector.acquirers ?? []).length > 0) ctx.out(`no poll of ${connector.id} runs: set it up first, in the Lifestream app's Streams, ${name} › Set up`);
  for (const poll of polls) {
    const next = poll.next_ms === null ? "it has no turn yet" : poll.next_ms <= now ? "its fetch is due now" : `its fetch runs next ${say(poll.next_ms)}`;
    const held = poll.held_ms !== null && poll.held_ms > now ? `, held by the provider until ${say(poll.held_ms)}` : "";
    ctx.out(`poll ${poll.acquirer}: ${next}${held}`);
    for (const line of nowLines(poll, home(ctx), say)) ctx.out(`  ${line}`);
    for (const call of poll.calls) ctx.out(`  ${callLine(call, say)}`);
  }
  for (const delivery of deliveries) ctx.out(deliveryLine(delivery, say));
  return { connector: connector.id, members: running.members, polls, deliveries };
}

const home = (ctx: VerbContext): boolean => ctx.background !== undefined;

function callsWords(calls: readonly Call[]): string {
  const named = calls.map((call) => (call === "page" ? "a page of history" : "a fetch"));
  return named.length === 0 ? "its next call" : named.join(" and ");
}

const callWords = (call: Call): string => (call === "page" ? "a page of history" : "a fetch");

function nowLines(poll: Pick<PollShown, "now" | "read" | "calls">, running: boolean, say: (ms: number) => string): string[] {
  const lines: string[] = [];
  if (poll.now?.state === "running") {
    const what = callWords(poll.now.call);
    lines.push(running ? `running since ${say(poll.now.began_ms)}: ${what}` : `cut short when the home stopped (${what}, begun ${say(poll.now.began_ms)}): it runs again as the home starts`);
  } else if (poll.now?.state === "queued") lines.push(`queued: ${callsWords(poll.now.calls)} runs ${running ? "as soon as a helper is free" : "as the home starts"}`);
  if (poll.read !== null && !poll.calls.some((call) => call.outcome === "ok")) lines.push(`last read ${say(poll.read.at_ms)} (${callWords(poll.read.call)})`);
  else if (lines.length === 0 && poll.read === null && poll.calls.length === 0) lines.push("not run yet");
  return lines;
}

function callLine(call: LastCall, say: (ms: number) => string): string {
  const outcome = `${OUTCOME_WORDS[call.outcome] ?? call.outcome}${call.outcome === "fail" && call.fails > 1 ? `, ${call.fails} in a row` : ""}`;
  const words = call.words === "" ? "" : `: ${call.words}`;
  const detail = call.detail === null || call.detail === "" ? "" : ` (${call.detail})`;
  return `${call.source ?? "no source named"} ${call.call} ${say(call.at_ms)}: ${outcome}${words}${detail}`;
}

const COUNTED: readonly (readonly [string, string])[] = [["new", "new"], ["changed", "changed"], ["gone", "gone"], ["restated", "the same"], ["replayed", "read before"], ["refused", "refused"]];

function deliveryLine(delivery: DeliveryShown, say: (ms: number) => string): string {
  const counted = delivery.counts === null ? [] : COUNTED.flatMap(([key, word]) => (typeof delivery.counts![key] === "number" && delivery.counts![key] !== 0 ? [`${delivery.counts![key] as number} ${word}`] : []));
  const landed = delivery.counts === null ? "" : `: ${counted.length === 0 ? "nothing" : counted.join(", ")}`;
  return `${delivery.source} newest delivery ${say(delivery.sealed_ms)}, ${delivery.state}${landed}`;
}

function newestOf(tables: Pick<ReadTables, "deliveries" | "runs">, source: string): DeliveryShown[] {
  const shipped = tables.deliveries.shipped(source);
  const row = shipped === undefined ? undefined : tables.deliveries.get(shipped.id, source);
  if (row === undefined) return [];
  const counts = row.run === null ? null : tables.runs.get(row.run)?.counts ?? null;
  return [{ source, sealed_ms: row.sealed_ms, state: row.state, counts: counts !== null && typeof counts === "object" && !Array.isArray(counts) ? withoutExamples(counts as JsonObject) : null }];
}

const withoutExamples = ({ refusals: _refusals, ...counts }: JsonObject): JsonObject => counts;

async function refreshEverywhere(ctx: VerbContext, connector: Connector, pressed: (connector: string) => Promise<RefreshAnswer>): Promise<RefreshAnswer | HomeRefresh> {
  let answer: RefreshAnswer;
  try {
    answer = await pressed(connector.id);
  } catch (error) {
    if (error instanceof Refusal && error.code === "NOT_OFFERED") {
      ctx.out(`${connector.id}: no Mac reads it yet: set it up in the Lifestream app on your Mac, ${connectorName(connector)} › Set up`);
      return { state: "none" };
    }
    if (!(error instanceof Refusal && error.words === DOOR_AWAY)) throw error;
    const home = await refresh(ctx, connector, null);
    ctx.out(`the door isn't answering, so no Mac was asked to read ${connector.id} now: each reads it at its own pace`);
    return home;
  }
  ctx.out(answer.state === "blocked" ? `${connector.id}: ${answer.blocked.words}`
    : answer.state === "asked" ? `${connector.id}: your Mac is asked to read it now; ${CLI} connectors show ${connector.id} says what lands`
      : `${connector.id}: a fetch queued`);
  return answer;
}

async function reread(ctx: VerbContext, connector: Connector): Promise<{ reread: string[] }> {
  const registry = await ctx.registry();
  const built = builtOf(registry, connector);
  if (built.length === 0) {
    fail((connector.acquirers ?? []).length === 0
      ? `${connector.id} is read from what its devices send or what you hand in: the home polls nothing of it to read again`
      : `no poll of ${connector.id} runs yet: set it up first`);
  }
  const now = ctx.now();
  ctx.db.commit((tx) => {
    const paused = new Set(tx.tables.controls.list().map((control) => control.target));
    for (const acquirer of built) {
      rereadPoll(tx, acquirer, now);
      queuePoll(tx, registry.connectors, acquirer.name, now, paused, BY_HAND);
    }
  });
  ctx.out(`${connector.id} reads its source again from the start; its records stay, and an unchanged item lands no new version`);
  return { reread: built.map((acquirer) => acquirer.name) };
}

async function setMembers(ctx: VerbContext, connector: Connector, named: readonly (readonly [string, Json | undefined])[], was?: Json): Promise<{ changed: Member[] }> {
  const routes = storedOf(ctx).routes;
  const members = named.map(([member]) => member);
  const twice = members.find((member, at) => members.indexOf(member) !== at);
  if (twice !== undefined) fail(`${twice} is named twice: name each member once`);
  for (const [member, value] of named) {
    if (member === ROUTE && connector.signin !== undefined) refuse(422, SETTING_REFUSED, `${connector.id}'s ${ROUTE} is written by its sign-in alone: sign in by the route that should run, in the Lifestream app's Streams, ${connectorName(connector)} › Set up`);
    if (value === undefined) continue;
    try {
      checkMember(connector, member, value, routes);
    } catch (error) {
      if (error instanceof SettingsError) refuse(422, SETTING_REFUSED, error.message);
      throw error;
    }
  }
  const held = blockOf(ctx.folder, connector.id);
  const same = ([member, value]: readonly [string, Json | undefined]) => (held[member] === undefined ? value === undefined : value !== undefined && canonical(held[member]!) === canonical(value));
  if (named.every(same)) {
    const standing = connectorSettings(connector, held).members;
    for (const member of members) {
      const shown = standing.find((each) => each.member === member);
      ctx.out(shown === undefined ? `${member} is not set` : memberLine(shown));
    }
    return { changed: standing.filter((each) => members.includes(each.member)) };
  }
  const changing = named.filter((each) => !same(each));
  const block: JsonObject = { ...held };
  for (const [member, value] of changing) {
    if (value === undefined) delete block[member];
    else block[member] = value;
  }
  const sets = changing.flatMap(([member, value]) => (value === undefined ? [] : [member]));
  const registry = await ctx.registry();
  const running = plannedBlock(ctx.folder, connector, block, sets, was === undefined ? {} : { [members[0]!]: was }, routes).write();
  ctx.settingsChanged?.();
  const now = ctx.now();
  const built = builtOf(registry, connector).filter((acquirer) => homeBuilds(registry.connectors, connector, block, acquirer.name));
  const polled: string[] = [];
  ctx.db.commit((tx) => {
    for (const acquirer of built) {
      const row = tx.tables.polls.get(acquirer.name);
      if (row !== undefined && row.next_ms > now) tx.tables.polls.put({ ...row, next_ms: now });
      polled.push(acquirer.name);
      if (changing.some(([member]) => member === "start") && acquirer.page !== undefined) pageAgain(tx, acquirer.name);
    }
  });
  const changed = changing.flatMap(([member]) => running.members.find((each) => each.member === member) ?? []);
  for (const [member] of changing) {
    const shown = running.members.find((each) => each.member === member);
    ctx.out(shown === undefined ? `${member} removed` : memberLine(shown));
  }
  if (polled.length > 0) ctx.out(home(ctx) ? `${connector.id}: its fetch runs now with this change` : `${connector.id}: its fetch runs with this change as the home starts: no home runs now`);
  else if (running.unset.length === 1) ctx.out(`no poll of ${connector.id} runs until ${running.unset[0]} is set`);
  else if (running.unset.length > 1) ctx.out(`no poll of ${connector.id} runs until ${listed(running.unset)} are set: set them in one call`);
  return { changed };
}

const listed = (words: readonly string[]): string => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)!}`);

async function backfill(ctx: VerbContext, connector: Connector, action: string, reason: string | undefined): Promise<unknown> {
  if (connector.backfill === undefined) fail(`${connector.id} has no backfill`);
  const target = pauseTarget(connector.id, true);
  if (action === "pause") return stand(ctx, target, reason);
  if (action === "resume") return lift(ctx, target, true);
  if (action !== "now") fail(`usage: ${CLI} ${USAGE}`);
  const registry = await ctx.registry();
  const paging = builtOf(registry, connector).filter((acquirer) => acquirer.page !== undefined).map((acquirer) => acquirer.name);
  if (paging.length === 0) {
    fail(connectorRoadsOf(connector).some((road) => road === "mac" || road === "phone")
      ? `${connector.id}'s backfill is its device's: the home pages nothing of it` : `${connector.id} reads its history with what is new: it has no page to read now`);
  }
  const now = ctx.now();
  return ctx.db.commit((tx) => {
    const paused = new Set(tx.tables.controls.list().map((control) => control.target));
    for (const acquirer of paging) pageAgain(tx, acquirer);
    const turn = pageTurns({ registry, settings: ctx.settings, room: "ok", stated: {} }, tx.tables, now);
    const built = (registry.acquirers ?? []).filter((acquirer) => paging.includes(acquirer.name));
    const queued = built.filter((acquirer) => turn(acquirer).due).map((acquirer) => acquirer.name);
    for (const name of queued) queuePoll(tx, registry.connectors, name, now, paused, ["page"]);
    return { queued };
  });
}

function builtOf(registry: { connectors: readonly Connector[]; acquirers?: readonly Acquirer[] }, connector: Connector): readonly Acquirer[] {
  const catalog = catalogOf(registry.connectors);
  return (registry.acquirers ?? []).filter((acquirer) => catalog.ofAcquirer(acquirer.name)?.id === connector.id);
}

const connectorRoadsOf = (connector: Connector) => connector.sources.flatMap((source) => roadsOf(source));

export async function turn(ctx: VerbContext, id: string, on: boolean, copies = false) {
  const { connectors: declared } = await ctx.registry();
  const changed = await switchTo(ctx, declared, id, on, copies);
  const site = siteOf(declared, id);
  if (site !== undefined) ctx.out(await tellStations(ctx, site, on));
  return { changed };
}

export async function sitesTurned(ctx: VerbContext, chose: readonly string[], stopped: readonly string[]): Promise<string[]> {
  const { connectors: declared } = await ctx.registry();
  const turned: string[] = [];
  for (const site of chromeSites(declared).filter((each) => chose.includes(each.id) || stopped.includes(each.id))) {
    const on = chose.includes(site.id);
    for (const connector of declared.filter((each) => each.chrome?.origin === site.origin)) {
      const was = effective(ctx.folder).settings.sources.off.includes(connector.id);
      await switchTo(ctx, declared, connector.id, on);
      if (was === on) turned.push(connector.id);
    }
  }
  return turned;
}

const siteOf = (declared: readonly Connector[], id: string): ChromeSite | undefined => {
  const connector = declared.find((each) => each.id === id);
  return connector?.chrome === undefined ? undefined : chromeSites(declared).find((each) => each.origin === connector.chrome!.origin);
};

async function tellStations(ctx: VerbContext, site: ChromeSite, on: boolean): Promise<string> {
  const told = await viaDoor(ctx, (stations) => stations.listed());
  if (told === undefined) return `${site.name} is ${on ? "chosen" : "stopped"}: the extension hears it once the home runs`;
  if (told === null) return `${site.name} is ${on ? "chosen" : "stopped"}: the extension hears it once the door answers`;
  if (told.length === 0) return `${site.name} is ${on ? "chosen" : "stopped"}: no browser runs the extension now, and each hears it as it comes`;
  return `${site.name} is ${on ? "chosen" : "stopped"} in ${told.length} browser${told.length === 1 ? "" : "s"}`;
}

async function viaDoor<T>(ctx: VerbContext, use: (stations: DoorStations) => Promise<T>): Promise<T | null | undefined> {
  if (ctx.stations === undefined) return undefined;
  try {
    return await use(ctx.stations());
  } catch (error) {
    if (error instanceof StationFailed) return null;
    throw error;
  }
}

async function switchTo(ctx: VerbContext, declared: readonly Connector[], id: string, on: boolean, copies = false): Promise<Shown> {
  const whole = !id.includes(":");
  if (whole) {
    const connector = declared.find((each) => each.id === id);
    const known = connector !== undefined || withView(ctx, (view) => view.tables.devices.get(id) !== undefined);
    if (!known) fail(`${id} is neither a connector (${declared.map((each) => each.id).join(", ") || "none"}) nor a device's unit this home holds`);
    if (!on && connector !== undefined && shownOf(connector) === null) fail(`${id} has no switch: it is never turned off`);
  } else {
    try {
      vendorOf(declared, id);
    } catch (error) {
      if (error instanceof SourceNameError) return fail(`${id}: ${error.message}`);
      throw error;
    }
  }
  const sources = withView(ctx, (view) => view.tables.sources.list());
  const { sources: { off }, sites: { chosen } } = effective(ctx.folder).settings;
  const withCopies = whole && (copies || !declared.some((connector) => connector.id === id));
  const held = withCopies ? new Set(sources.filter((source) => switchOf(declared, [id]).source(source)).map((source) => source.id)) : new Set<string>();
  const next = on ? off.filter((each) => each !== id && !held.has(each)) : [...new Set([...off, id])].sort();
  const site = siteOf(declared, id)?.id;
  const changed = planned(ctx.folder, { "sources.off": next, ...site === undefined ? {} : { "sites.chosen": chosenWith(chromeSites(declared).map((each) => each.id), chosen, on ? [site] : [], on ? [] : [site]) } }).write()[0]!;
  ctx.settingsChanged?.();
  const isOff = switchOf(declared, next).source;
  const source = sources.find((each) => each.id === id) ?? { id };
  const stays = on && !whole ? next.find((each) => !each.includes(":") && switchOf(declared, [each]).source(source)) : undefined;
  ctx.out(stays === undefined ? `${id} is ${on ? "on" : "off"}` : `${id} stays off: ${stays} is off`);
  if (on) {
    const now = ctx.now();
    const turned = whole ? sources.filter((source) => switchOf(declared, [id]).source(source)).map((source) => source.id) : [id];
    ctx.db.commit((tx) => {
      for (const each of turned) {
        if (isOff(tx.tables.sources.get(each) ?? { id: each })) continue;
        const row = tx.tables.sources.get(each);
        if (tx.tables.deliveries.waiting(each) !== undefined) tx.tables.jobs.enqueue({ kind: "import", key: each, connector: catalogOf(declared).of(row ?? { id: each })?.id ?? null, lane: LANE.live, not_before_ms: now, now_ms: now });
      }
    });
  }
  return changed;
}

function withView<T>(ctx: VerbContext, read: (view: ReturnType<VerbContext["db"]["view"]>) => T): T {
  const view = ctx.db.view();
  try {
    return read(view);
  } finally {
    view.close();
  }
}

async function check(ctx: VerbContext): Promise<{ checking: string[] }> {
  const survey = ctx.survey ?? fail("checking the sites needs the running home: it asks the extension through the door");
  const present = await viaDoor(ctx, (stations) => stations.present());
  if (present === null || present === undefined) {
    ctx.out("the door isn't answering, so no browser is asked now: the home asks each when the door first sees it, at its start and once a day");
    return { checking: [] };
  }
  const units = [...present];
  if (units.length === 0) {
    ctx.out("no browser runs the Lifestream extension now, so none is asked: each is asked as it connects, at the home's start and once a day");
    return { checking: [] };
  }
  void survey().catch(() => undefined);
  ctx.out(`asking ${units.length === 1 ? "1 browser" : `${units.length} browsers`} (${units.join(", ")}) which sites each is signed in to; ${CLI} connectors shows what each found once it answers`);
  return { checking: units };
}

