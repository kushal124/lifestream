import { chromeSites, connectorName, routeOf, vendorOf, whoNamed, type Connector, type Who } from "@lifestreamprotocol/connect";
import { roomAt } from "@lifestreamprotocol/core";
import { answerImport, answerPhone, dropImport, fileId, heldImports, letGo, letGoOf, listingOf } from "../imports.js";
import { readPrincipals } from "../principals.js";
import { DISMISSED, stampOf, standingOf } from "../connectors.js";
import { HomeFile } from "../home-file.js";
import { catalogOf, laneSources } from "../catalog.js";
import { needsMet, outcomesOf } from "../attempts.js";
import { BY_HAND, lookAtInbox, pollStatus, queuePoll } from "../import.js";
import { refuse } from "../refusal.js";
import { change, effective } from "../settings.js";
import { connectorOfJob, covers, LANE, pauseTarget } from "../jobs.js";
import { blockedOf, homeLanes, laneBlocked, lanesBlocked, POLL_REFRESH } from "../refresh-now.js";
import type { RefreshAnswer } from "../wire.js";
import { needs, offered, offeredSource, type Act } from "../status.js";
import { readArgs } from "./args.js";
import { fail, holdHome, type VerbContext } from "./context.js";
import { dropJobIn, dropped, giveUpIn } from "./drop.js";
import { resumeErasure, standingIntent } from "./erase.js";
import { CLI } from "../cli-name.js";

const USAGE = "act <key> try|skip|read|ignore|dismiss [<source>] | act import:<id>:whose choose <account> | act import:<id>:which choose <unit>|new | act import:<id>:file:<file> let-go | act import:<id>:refused skip";
const ACTS: readonly (Act["do"] | "dismiss")[] = ["try", "skip", "read", "ignore", "dismiss"];
const ERASURE = "erasure";

export async function act(ctx: VerbContext, args: readonly string[]) {
  const { positionals } = readArgs("act", args, {}, USAGE, { min: 2, max: 4 });
  if (positionals[0]!.startsWith("import:")) return importAct(ctx, positionals);
  if (positionals.length > 3) fail(`usage: ${CLI} ${USAGE}`);
  const [id, chosen, of] = positionals as [string, Act["do"] | "dismiss", string | undefined];
  if (!ACTS.includes(chosen) || (of !== undefined) !== (chosen === "read" || chosen === "ignore")) fail(`usage: ${CLI} ${USAGE}`);
  if (id === ERASURE) return erasureTry(ctx, chosen);
  const registry = await ctx.registry();
  if (chosen === "dismiss") return dismiss(ctx, registry, id);
  const { connectors, families } = registry;
  const options = { folder: ctx.folder, now_ms: ctx.now(), settings: ctx.settings, connectors, families, ledger: ctx.ledger };
  const offering = (offered: Act) => offered.do === chosen && "need" in offered && offered.need === id && (!("of" in offered) || offered.of === of);
  if (!(new HomeFile(ctx.folder, 5_000).read((db) => offered(db, options)) ?? offered(null, options)).some(offering)) refuse(409, "NOT_OFFERED", `${id} offers no ${chosen} now`);
  if (chosen === "skip" && id.startsWith("unread:")) {
    const source = id.slice("unread:".length);
    const ids = new HomeFile(ctx.folder, 5_000).read((db) => standingOf(db, source)) ?? [];
    const now = ctx.now();
    const { code } = await ctx.registry();
    const given = ctx.db.commit((tx) => giveUpIn(tx, now, code, id, ids.map((each) => ({ id: each, source }))));
    return { acted: given.length === 0 ? "already" : "skipped" };
  }
  if (chosen === "skip") {
    const source = id.slice("job:import:".length);
    const now = ctx.now();
    const { code } = await ctx.registry();
    const gave = ctx.db.commit((tx) => tx.tables.jobs.get("import", source)?.state === "running" ? null : { blocking: dropJobIn(tx, now, code, "import", source) });
    if (gave === null) return { acted: "already" };
    dropped(ctx, "import", source, gave.blocking);
    return { acted: "skipped" };
  }
  if (id.startsWith("label:")) {
    const labeler = id.slice("label:".length);
    const now = ctx.now();
    ctx.db.commit((tx) => {
      tx.tables.meta.set(`${labeler}:now`, String(now));
      tx.tables.jobs.enqueue({ kind: "label", key: labeler, connector: connectorOfJob(registry, tx.tables, "label", labeler), lane: LANE.live, not_before_ms: now, now_ms: now });
    });
    return { acted: "queued" };
  }
  const acquirer = id.slice("poll:".length);
  const now = ctx.now();
  const paused = (tx: Parameters<Parameters<VerbContext["db"]["commit"]>[0]>[0]) => new Set(tx.tables.controls.list().map((control) => control.target));
  if (chosen === "read" || chosen === "ignore") {
    const made = ctx.db.commit((tx) => {
      const asking = outcomesOf(tx.tables, acquirer, (row) => row.outcome === "need" && row.reason === "other-account");
      const sources = laneSources(connectors, tx.tables.sources.list(), acquirer, tx.tables.deliveries.fedBy(acquirer));
      const offers = asking.flatMap((row) => {
        const offered = row.facts.offered as Who | undefined;
        const made = offered === undefined ? null : offeredSource(sources, offered);
        return made === null ? [] : [{ offered: offered!, made }];
      });
      const offer = offers.find((each) => each.made.id === of && tx.tables.sources.get(each.made.id) === undefined);
      if (offer === undefined) return null;
      if (chosen === "ignore") change(ctx.folder, "sources.off", [...new Set([...effective(ctx.folder).settings.sources.off, offer.made.id])].sort());
      tx.tables.sources.add({ id: offer.made.id, vendor: vendorOf(connectors, offer.made.id), connector: offer.made.connector, options: { lane: acquirer, ...whoNamed(offer.offered) }, added_ms: now });
      needsMet(tx, asking.filter((row) => (row.facts.offered as { id?: unknown } | undefined)?.id === offer.offered.id), now);
      queuePoll(tx, connectors, acquirer, now, paused(tx), BY_HAND);
      return offer.made.id;
    });
    if (made === null) refuse(409, "NOT_OFFERED", `${id} offers no ${chosen} of ${of} now`);
    if (chosen === "ignore") ctx.settingsChanged?.();
    void ctx.survey?.().catch(() => undefined);
    ctx.out(`${made} is ${chosen === "read" ? "read" : "made, and off"}`);
    return { acted: chosen === "read" ? "read" : "ignored", source: made };
  }
  return ctx.db.commit((tx) => {
    const own = tx.tables.jobs.get("poll", acquirer)?.state;
    if (own === "queued" || own === "running") return { acted: "already" };
    const held = tx.tables.polls.get(acquirer)?.held_ms ?? null;
    if (held !== null && held > now) return { acted: "blocked", until_ms: held };
    queuePoll(tx, connectors, acquirer, now, paused(tx), BY_HAND);
    const row = tx.tables.polls.get(acquirer);
    if (row !== undefined) tx.tables.polls.put({ ...row, next_ms: now });
    return { acted: "queued" };
  });
}
act.usage = USAGE;

async function erasureTry(ctx: VerbContext, chosen: Act["do"] | "dismiss") {
  if (chosen !== "try" || ctx.by !== "terminal") refuse(409, "NOT_OFFERED", `${ERASURE} offers no ${chosen} here: run ${CLI} act erasure try at the terminal`);
  erasureStanding(ctx);
  return await holdHome(ctx, async () => {
    const intent = erasureStanding(ctx);
    const applied = await resumeErasure(ctx, intent);
    ctx.out(applied === null ? `the erasure of ${intent.family} names no record any more: ended` : `erase ${intent.family}: applied, run ${applied.run}`);
    return { acted: "erased", run: applied?.run ?? null };
  });
}

const erasureStanding = (ctx: VerbContext) => standingIntent(ctx) ?? refuse(409, "NOT_OFFERED", "no erasure stands");

export type HomeRefresh = Exclude<RefreshAnswer, { state: "asked" }> | { state: "none" };

export async function refresh(ctx: VerbContext, connector: Connector, present: readonly string[] | null = null): Promise<HomeRefresh> {
  const registry = await ctx.registry();
  const now = ctx.now();
  const say = (blocked: Parameters<typeof blockedOf>[0], until_ms: number | null = null): HomeRefresh =>
    ({ state: "blocked", blocked: blockedOf(blocked, { name: connectorName(connector), until_ms, now, day: ctx.settings.day }) });
  let none = "";
  const answer = ctx.db.commit((tx): HomeRefresh => {
    const targets = new Set(tx.tables.controls.list().map((control) => control.target));
    if (targets.has("home") || targets.has(pauseTarget(connector.id))) return say("paused");
    if (roomAt(ctx.folder.root) === "full") return say("disk");
    const lanes = homeLanes(connector, ctx.settings.connectors[connector.id], tx.tables);
    if (lanes.length === 0) {
      none = unfetched(connector, ctx.settings.connectors[connector.id]);
      return { state: "none" };
    }
    if (lanes.some((lane) => covers(targets, { kind: "poll", key: lane, connector: connector.id }) !== null)) return say("paused");
    const site = connector.chrome === undefined ? undefined : chromeSites(registry.connectors).find((each) => each.origin === connector.chrome!.origin);
    if (site !== undefined && (!ctx.settings.sites.chosen.includes(site.id) || present?.length === 0)) return say("chrome");
    const blocks = lanes.map((lane) => {
      const blocked = laneBlocked(tx.tables, lane, now);
      if (blocked !== null) return blocked;
      queuePoll(tx, registry.connectors, lane, now, targets, ["fetch"]);
      tx.tables.meta.set(`${POLL_REFRESH}${lane}`, "queued");
      return null;
    });
    if (blocks.some((each) => each === null)) return { state: "queued" };
    const lane = lanesBlocked(blocks)!;
    return say(lane.reason, lane.until_ms);
  });
  ctx.out(answer.state === "blocked" ? `${connector.id}: ${answer.blocked.words}` : answer.state === "none" ? `${connector.id}: ${none}` : `${connector.id}: a fetch queued`);
  return answer;
}

function unfetched(connector: Connector, block: Parameters<typeof routeOf>[1]): string {
  const first = connector.signin?.[0];
  if (first !== undefined && routeOf(connector, block) === null) return `${first.way === "key" ? "set it up" : "sign in"} first`;
  return "the home fetches none of it";
}

async function importAct(ctx: VerbContext, positionals: readonly string[]) {
  const [key, chosen, account] = positionals as [string, string, string | undefined];
  const match = /^import:([0-9a-f]+):(whose|which|refused|file:([0-9a-f]+))$/u.exec(key);
  const notOffered = (): never => refuse(409, "NOT_OFFERED", `${key} offers no ${chosen} now`);
  if (match === null) return notOffered();
  const [, id, what, file] = match as unknown as [string, string, string, string | undefined];
  const now = ctx.now();
  if (what === "whose") {
    if (chosen !== "choose" || account === undefined || account.trim() === "" || positionals.length !== 3) fail(`usage: ${CLI} act import:<id>:whose choose <account>`);
    const spelled = account!.trim().includes("@") ? account!.trim().toLowerCase() : account!.trim();
    if (/[:/\\\0\s]/u.test(spelled)) refuse(422, "BAD_REQUEST", "an account has no colon, slash, backslash, space or NUL");
    const answered = ctx.db.commit((tx) => {
      const held = heldImports(tx.tables.meta)[id];
      if (held === undefined || held.account !== null || held.ended === true || held.unit === null) return false;
      if (held.named !== undefined && !held.named.includes(spelled)) refuse(422, "BAD_REQUEST", `its files name ${held.named.join(" and ")}: choose one of them`);
      answerImport(tx, id, spelled);
      lookAtInbox(tx, now);
      return true;
    });
    if (!answered) return notOffered();
    return { acted: "chosen" };
  }
  if (what === "which") {
    if (chosen !== "choose" || account === undefined || account.trim() === "" || positionals.length !== 3) fail(`usage: ${CLI} act import:<id>:which choose <unit>|new`);
    const passes = readPrincipals(ctx.folder).principals;
    const answered = ctx.db.commit((tx) => {
      const held = heldImports(tx.tables.meta)[id];
      if (held?.device === undefined || held.unit !== null) return false;
      try {
        answerPhone(tx, id, account!.trim(), passes, now);
      } catch (error) {
        refuse(422, "BAD_REQUEST", `${error instanceof Error ? error.message : String(error)}: choose a phone it lists, or new`);
      }
      lookAtInbox(tx, now);
      return true;
    });
    if (!answered) return notOffered();
    return { acted: "chosen" };
  }
  if (positionals.length !== 2) fail(`usage: ${CLI} ${USAGE}`);
  if (what === "refused") {
    if (chosen !== "skip") return notOffered();
    const { code } = await ctx.registry();
    const acted = ctx.db.commit((tx) => {
      const held = heldImports(tx.tables.meta)[id];
      if (held === undefined) return null;
      if (held.ended === true) {
        dropImport(tx, id);
        return 1;
      }
      const given = giveUpIn(tx, now, code, key, held.deliveries.flatMap((each) => tx.tables.deliveries.shipment(each)));
      let files = 0;
      for (const delivery of held.deliveries) {
        const rows = tx.tables.deliveries.shipment(delivery);
        if (!rows.some((row) => row.state === "dead" && row.refused > 0)) continue;
        const kept = (listingOf(tx.tables.meta, delivery)?.files ?? []).map((each) => each.path);
        if (kept.length === 0) continue;
        letGo(tx, delivery, kept);
        files += kept.length;
      }
      return given.length + files;
    });
    if (acted === null) return notOffered();
    if (acted > 0) ctx.background?.();
    return { acted: acted === 0 ? "already" : "skipped" };
  }
  if (chosen !== "let-go") return notOffered();
  const acted = ctx.db.commit((tx) => {
    const held = heldImports(tx.tables.meta)[id];
    for (const delivery of held?.deliveries ?? []) {
      const path = listingOf(tx.tables.meta, delivery)?.files.find((each) => fileId(delivery, each.path) === file)?.path;
      if (path === undefined) continue;
      if (tx.tables.deliveries.shipment(delivery).some((row) => row.state === "sealed" || row.state === "importing")) return false;
      letGo(tx, delivery, [path]);
      if ((held!.account === null || held!.unit === null) && held!.deliveries.every((each) => (listingOf(tx.tables.meta, each)?.files ?? []).every((kept) => letGoOf(tx.tables.meta, each).includes(kept.path)))) dropImport(tx, id);
      return true;
    }
    return false;
  });
  if (!acted) return notOffered();
  ctx.background?.();
  return { acted: "let-go" };
}

async function dismiss(ctx: VerbContext, { connectors, families }: Awaited<ReturnType<VerbContext["registry"]>>, id: string) {
  const options = { folder: ctx.folder, now_ms: ctx.now(), settings: ctx.settings, connectors, families, ledger: null, stated: (await ctx.stated?.()) ?? null };
  const read = new HomeFile(ctx.folder, 5_000).read((db) => ({
    standing: needs(db, options),
    kept: (db.prepare("SELECT key FROM meta WHERE key >= ? AND key < ?").pluck().all(DISMISSED, `${DISMISSED}\uffff`) as string[]).map((key) => key.slice(DISMISSED.length)),
  }));
  const need = read?.standing.find((each) => each.id === id);
  if (read === undefined || need === undefined) refuse(409, "NOT_OFFERED", `${id} is no need now`);
  if (need!.weight === "stopped") refuse(409, "NOT_OFFERED", `${id} says something is not kept now: it goes when it is fixed`);
  const now = ctx.now();
  ctx.db.commit((tx) => {
    for (const gone of read!.kept.filter((kept) => !read!.standing.some((each) => each.id === kept))) tx.tables.meta.delete(`${DISMISSED}${gone}`);
    tx.tables.meta.set(`${DISMISSED}${id}`, stampOf(need!));
    tx.tables.events.append({ at_ms: now, kind: "dismissed", key: id, detail: {} });
  });
  return { acted: "dismissed" };
}
