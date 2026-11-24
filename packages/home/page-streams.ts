import { digest, type HomeFolder, type Json } from "@lifestreamprotocol/core";
import type { Ledger } from "@lifestreamprotocol/model";
import { ASK_READER } from "./access.js";
import type { DeviceKind } from "./devices.js";
import type { Health, State } from "./health.js";
import type { Act as PageAct, AnswerOf, Body, Health as PageHealth, Need as PageNeed, PageAsk, PageHandler, StreamRow } from "./pages.js";
import { readPrincipals } from "./principals.js";
import type { Act, ConnectorReport, LineParts, Need, StreamsReport } from "./streams-report.js";

export interface StreamsRead {
  readonly position: string;
  readonly report: StreamsReport;
  readonly asks: number;
}

export interface StreamsReads {
  read(ask: PageAsk, unit: string | null): StreamsRead;
}

type Answer = Body<AnswerOf<"connectors">>;

export interface Asking {
  readonly device: DeviceKind | null;
  readonly unit: string | null;
}

export function streamsPage(reads: StreamsReads): PageHandler<AnswerOf<"connectors">> {
  return {
    params: ["unit"],
    open(ask, use) {
      const { position, report, asks } = reads.read(ask, ask.query.get("unit"));
      const body = streamsAnswer(report, asks, ask);
      return use({ position, inputs: [digest(withoutMoment(body))], counting: false, build: () => body });
    },
  };
}

export function openAsks(ledger: Ledger, folder: HomeFolder, now_ms: number): number {
  const agents = readPrincipals(folder).principals.filter((each) => each.kind === "agent" && each.agent !== undefined && each.revoked_at === null).map((each) => each.id);
  const readers = new Set([ASK_READER, ...agents]);
  return ledger.access.waiting(now_ms).filter((each) => readers.has(each.reader)).length;
}

const withoutMoment = ({ at_ms: _at, ...rest }: Answer): Json => rest as unknown as Json;

export function streamsAnswer(report: StreamsReport, asks: number, asking: Asking): Answer {
  const needs = report.needs.map(needOf);
  return {
    ...report,
    connectors: report.connectors.map((connector) => ({ ...connector, callout: calloutOf(connector, needs) })),
    needs,
    rows: rowsOf(report.connectors, asking),
    badge: { needs: needs.filter((need) => !need.banner).length, asks },
  };
}

const WORST: readonly State[] = ["broken", "needs-you", "waiting", "paused", "syncing", "quiet", "ok", "off", "setup"];

const rank = (connector: ConnectorReport): number => WORST.indexOf(connector.health.state);

export function rowsOf(connectors: readonly ConnectorReport[], asking: Asking): StreamRow[] {
  const rows = new Map<string, ConnectorReport[]>();
  for (const connector of connectors.filter((each) => each.shown === "stream")) {
    const key = connector.joins === null ? `stream:${connector.id}` : `joins:${connector.joins.name}`;
    rows.set(key, [...rows.get(key) ?? [], connector]);
  }
  return [...rows.values()].map((members) => rowOf(members, asking));
}

function rowOf(members: readonly ConnectorReport[], asking: Asking): StreamRow {
  const lead = [...members].sort((left, right) => rank(left) - rank(right))[0]!;
  const joins = lead.joins;
  const newest = members.reduce<number | null>((latest, each) => {
    const last = each.figure?.last_ms ?? null;
    return last !== null && (latest === null || last > latest) ? last : latest;
  }, null);
  const line: LineParts = lead.set_up ? wholeLine(lead) : { words: joins?.gives ?? lead.gives, time: null, more: [] };
  return {
    ids: members.map((each) => each.id),
    joined: joins !== null,
    name: joins?.name ?? lead.name,
    icon: joins?.icon ?? lead.icon,
    health: healthOf(lead.health),
    line: line.words,
    time: line.time,
    more: line.more,
    last: newest === null ? null : { kind: "at", at_ms: newest },
    act: !lead.set_up ? null : resumeOf(lead, asking) ?? oneTap(lead, asking),
    find: [...new Set([joins?.name ?? "", ...members.map((each) => each.name), ...joins?.apps ?? [], lead.type?.name ?? "", joins?.gives ?? "", ...members.map((each) => each.gives)]
      .filter((word) => word !== ""))],
  };
}

const wholeLine = (connector: ConnectorReport): LineParts =>
  ({ ...connector.line_parts, words: [connector.lead, connector.line_parts.words].filter((part): part is string => part !== null && part !== "").join(" · ") });

const resumeOf = (connector: ConnectorReport, asking: Asking): PageAct | null =>
  resumes(connector, asking) && connector.pauses.some((pause) => pause.scope === "all")
    ? { do: "resume", label: connector.sensor ? "Resume reading" : "Resume", of: connector.id }
    : null;

const macOnly = (connector: ConnectorReport): boolean => connector.roads.length > 0 && connector.roads.every((road) => road === "mac");

const resumes = (connector: ConnectorReport, asking: Asking): boolean =>
  asking.device === "mac" || (asking.device === "phone" && !macOnly(connector));

function oneTap(connector: ConnectorReport, asking: Asking): PageAct | null {
  const taps = connector.health.acts.filter((act) => tapped(act, connector, asking));
  return taps.length === 1 ? actOf(taps[0]!) : null;
}

const OPENS_PAGE: ReadonlySet<Act["do"]> = new Set(["signin", "set", "import"]);

const ANYWHERE: ReadonlySet<Act["do"]> = new Set(["try", "skip", "let-go", "import", "copy", "read", "ignore"]);
const ON_PHONE: ReadonlySet<Act["do"]> = new Set([...ANYWHERE, "open", "verify", "refresh", "signin", "report"]);
const ON_MAC: ReadonlySet<Act["do"]> = new Set([...ANYWHERE, "turn", "open", "pair", "extension", "browser", "storage", "vault", "install", "upload", "refresh", "report"]);
const BESIDE: ReadonlySet<Act["do"]> = new Set(["report"]);

export function taken(act: Act, connector: ConnectorReport, asking: Asking): boolean {
  if (act.do === "grant") return (asking.device === "phone" || asking.device === "mac") && act.unit === asking.unit;
  if (asking.device === "phone") return ON_PHONE.has(act.do);
  if (asking.device !== "mac") return ANYWHERE.has(act.do);
  if (act.do === "signin") return connector.routes.some((route) => route.id === act.of);
  if (act.do === "set") {
    const member = connector.members.find((each) => each.key === act.member);
    return member !== undefined && member.control !== null && member.control !== "secret" && (member.control !== "path" || member.where === null || member.where.unit === asking.unit);
  }
  return ON_MAC.has(act.do);
}

const tapped = (act: Act, connector: ConnectorReport, asking: Asking): boolean =>
  !BESIDE.has(act.do) && taken(act, connector, asking) && !(asking.device === "phone" && OPENS_PAGE.has(act.do));

export function calloutOf(connector: ConnectorReport, needs: readonly PageNeed[]): PageNeed[] {
  const own = actsKey(connector.health.acts.filter((act) => !BESIDE.has(act.do)).map(actOf));
  return needs.filter((need) => (need.streams ?? (need.connector === null ? [] : [need.connector])).includes(connector.id)
    && !(need.words === connector.health.words && actsKey(need.acts) === own));
}

const actsKey = (acts: readonly PageAct[]): string => JSON.stringify(acts);

export function needOf(need: Need): PageNeed {
  return {
    id: need.id, ...healthOf(need),
    connector: need.connector, streams: need.streams ?? null, copy: need.copy, unit: need.unit,
    at: need.at === null ? null : { site: need.at.site, open: need.at.open, errand: need.at.errand },
    weight: need.weight, banner: need.banner, dismissed: need.dismissed, kind: need.kind, about: need.about,
  };
}

export function healthOf(health: Health<Act>): PageHealth {
  return {
    state: health.state, reason: health.reason, words: health.words, since_ms: health.since_ms, next_ms: health.next_ms,
    acts: health.acts.map(actOf), detail: health.detail, line: health.line ?? null,
  };
}

export function actOf(act: Act): PageAct {
  switch (act.do) {
    case "try":
    case "skip":
    case "let-go":
      return { do: act.do, label: act.label, need: act.need };
    case "import":
      return { do: act.do, label: act.label, kind: act.kind };
    case "read":
    case "ignore":
      return { do: act.do, label: act.label, need: act.need, of: act.of };
    case "turn":
      return { do: act.do, label: act.label, ids: [...act.ids] };
    case "signin":
    case "refresh":
    case "browser":
    case "report":
      return { do: act.do, label: act.label, of: act.of };
    case "set":
      return { do: act.do, label: act.label, member: act.member };
    case "grant":
      return { do: act.do, label: act.label, unit: act.unit, grant: act.grant };
    case "open":
      return { do: act.do, label: act.label, url: act.url };
    case "copy":
      return { do: act.do, label: act.label, text: act.text };
    default:
      return { do: act.do, label: act.label };
  }
}
