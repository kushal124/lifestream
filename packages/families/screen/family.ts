import {
  daysOf,
  digest,
  instant,
  type EnrichmentRow, type ExtractRow, type Json, type ScreenAdapter, type SourceRow, type Version, type View,
} from "@lifestreamprotocol/core";
import { accountsOf, deviceWords, factId, OPS, type Collection, type DayFact, type DayLine, type DayProjection, type Family, type Given, type Touched } from "../family.js";
import { ACCOUNT, planAccount, SCREEN_PROMPTS, SCREEN_READERS, type Account, type Block } from "./account.js";
import { sittingsOf, GAP_MS, identityMs, object, parseUnit, Roles, sourceIn, sourceOf, sourceRole, unitOf, type Role, type Sitting } from "./sittings.js";
import { appSeconds, blocksOf, clockOf, duration, evidenceOf, partEvidence } from "./evidence.js";
import { readSitting, shipperRun } from "./frames.js";

export { SCREEN_PROMPTS } from "./account.js";

const NEEDS = { effort: "medium", timeout_ms: 600_000 };
export const SCREEN_CUTOVER_MS = instant("2026-09-22T04:53:00Z", "rfc3339").start_ms;
export interface ScreenSettings {
  zone: string;
  cutover_ms?: number;
}

export type SittingContent = OpenSitting | ClosedSitting;

export interface OpenSitting {
  machine: string;
  start_ms: number;
  end_ms: number;
  closed: false;
}

export interface ClosedSitting {
  machine: string;
  start_ms: number;
  end_ms: number;
  closed: true;
  frames: number;
  text_missing: number;
  apps: [string, number][];
  blocks: Block[];
}

export function screenFamily(settings: ScreenSettings): (given: readonly Given<ScreenAdapter>[]) => Family {
  return (given) => screenOver(settings, given);
}

function screenOver(settings: ScreenSettings, given: readonly Given<ScreenAdapter>[]): Family {
  const cutover = settings.cutover_ms ?? SCREEN_CUTOVER_MS;
  const clock = clockOf(settings.zone);
  const roles = new Roles(given);
  return {
    name: "screen",
    type: "device-activity",
    code: "3",
    inputs: given.map((each) => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),

    touched(changes, view) {
      const spans = new Map<string, [number, number][]>();
      for (const change of changes) {
        const of = sourceRole(view, roles, change.record.source);
        if (of === null) continue;
        if (of.role === "machine" && [change.before, change.after].every((version) => version === undefined || shipperRun(version.content))) continue;
        const stated = [change.before, change.after].flatMap((version) => version === undefined ? [] : [spanOf(version, of.role)])
          .filter((span): span is [number, number] => span !== null);
        if (stated.length === 0) continue;
        let lo = Math.min(...stated.map((span) => span[0]));
        let hi = Math.max(...stated.map((span) => span[1]));
        if (of.role === "prior") hi = Math.min(hi, cutover - 1);
        if (of.role === "frames") lo = Math.max(lo, cutover);
        if (lo > hi) continue;
        spans.set(of.machine, [...spans.get(of.machine) ?? [], [lo, hi]]);
      }
      const touched: Touched[] = [];
      for (const [machine, list] of spans) {
        for (const [lo, hi] of joined(list, 2 * GAP_MS)) touched.push(...touchedAround(view, roles, machine, cutover, lo, hi));
      }
      return touched;
    },

    prompts: SCREEN_PROMPTS,
    readers: SCREEN_READERS,
    works: { screen: roles.selector("frames", "prior") },

    extract(unit, view, files) {
      const parsed = parseUnit(unit);
      if (parsed === null) return null;
      const sitting = sittingsOf(view, roles, parsed.machine, cutover).startingAt(parsed.first_ms);
      if (sitting === null) return null;
      if (!closed(view, roles, sitting, cutover)) {
        const span: OpenSitting = { machine: sitting.machine, start_ms: sitting.first_ms, end_ms: sitting.last_ms, closed: false };
        return { content: span as unknown as Json, start_ms: sitting.first_ms, end_ms: sitting.last_ms, reading: digest(span as unknown as Json) };
      }
      const start = sitting.first_ms;
      const end = sitting.last_ms + 1;
      const read = readSitting(view, roles, files, sitting.machine, cutover, start, end);
      const evidence = evidenceOf(read, clock);
      const content: ClosedSitting = {
        machine: sitting.machine,
        start_ms: sitting.first_ms,
        end_ms: sitting.last_ms,
        closed: true,
        frames: read.rows.length,
        text_missing: read.textMissing,
        apps: appSeconds(read.rows, end),
        blocks: blocksOf(evidence, start, end).map((block) => ({
          ...block,
          parts: block.parts.map((part) => ({ ...part, evidence: partEvidence(evidence, part.start_ms, part.end_ms, end) })),
        })),
      };
      const json = content as unknown as Json;
      return { content: json, start_ms: sitting.first_ms, end_ms: sitting.last_ms, reading: digest(json) };
    },

    days: (extract, settings) => daysOf({ start_ms: extract.start_ms!, end_ms: extract.end_ms! + 1, precision: "ms" }, settings),

    plan(extract, answered) {
      const content = extract.content as unknown as SittingContent;
      if (!content.closed) return { asks: [] };
      const product = roles.products(content.end_ms < cutover ? "prior" : "frames")[0];
      if (product === undefined) return { asks: [] };
      const source = `${product}:local:${content.machine}`;
      return planAccount(extract.unit, content.blocks, { work: "screen", source, needs: NEEDS }, answered, clock);
    },

    items: (extract) => [{ item: extract.unit, prompt: ACCOUNT }],

    readThrough(move, view) {
      const of = sourceRole(view, roles, move.source);
      if (of === null) return [];
      const flips = (sitting: Sitting) =>
        !readPast(of.role, move.before_ms, sitting, cutover) && readPast(of.role, move.after_ms, sitting, cutover);
      if (move.before_ms === null) {
        return [...view.extracts("screen")].filter((row) => {
          const content = row.content as unknown as SittingContent;
          return content.machine === of.machine && !content.closed && flips({ machine: content.machine, first_ms: content.start_ms, last_ms: content.end_ms });
        }).map((row) => row.unit);
      }
      return sittingsOf(view, roles, of.machine, cutover).around(move.before_ms - GAP_MS, move.after_ms)
        .filter(flips).map((sitting) => unitOf(sitting.machine, sitting.first_ms));
    },

    day(input): DayProjection {
      const mac = deviceWords(input, input.extracts.map((extract) => (extract.content as unknown as SittingContent).machine));
      const lines: DayLine[] = [];
      const facts: DayFact[] = [];
      for (const extract of input.extracts) {
        const first = lines.length;
        const accounts = sittingAccounts(input.sources, roles, extract.content as unknown as SittingContent, cutover);
        const stated = accounts.length === 0 ? {} : { accounts };
        lines.push(...sittingLines(extract, input.enrichments.get(extract.unit), mac).map((line) => ({ ...line, ...stated })));
        facts.push(...appFacts(extract, first).map((fact) => ({ ...fact, from: { ...fact.from, ...stated } })));
      }
      return { lines, facts };
    },
    collections: SCREEN_COLLECTIONS,
  };
}

export const SCREEN_COLLECTIONS: Readonly<Record<string, Collection>> = {
  screen_time: {
    keys: ["app", "machine"],
    measures: { minutes: { unit: "min", ops: OPS, time: "start", split: "whole", from: "derived" } },
  },
};

function appFacts(extract: ExtractRow, line: number): DayFact[] {
  const content = extract.content as unknown as SittingContent;
  if (!content.closed) return [];
  return content.apps.filter(([, seconds]) => seconds > 0).map(([app, seconds]): DayFact => ({
    of: "screen_time", id: factId("screen_time", `${extract.unit}\0${app}`), time_ms: content.start_ms, start_ms: content.start_ms, end_ms: content.end_ms,
    keys: { app, machine: content.machine }, measures: { minutes: seconds / 60 }, who: [], from: { units: [extract.unit], item: app }, lines: [line],
  }));
}

function sittingAccounts(sources: ReadonlyMap<string, SourceRow>, roles: Roles, sitting: SittingContent, cutover: number): string[] {
  const read = { machine: sitting.machine, first_ms: sitting.start_ms, last_ms: sitting.end_ms };
  return accountsOf((["prior", "frames", "input", "machine"] as const)
    .filter((role) => reads(role, read, cutover))
    .flatMap((role) => sourceIn(sources.values(), roles, sitting.machine, role) ?? []));
}

function touchedAround(view: View, roles: Roles, machine: string, cutover: number, lo: number, hi: number): Touched[] {
  const now = sittingsOf(view, roles, machine, cutover).around(lo, hi);
  const from = Math.min(lo - GAP_MS, ...now.map((sitting) => sitting.first_ms));
  const to = Math.max(hi + GAP_MS, ...now.map((sitting) => sitting.last_ms));
  const units = new Set(now.map((sitting) => unitOf(sitting.machine, sitting.first_ms)));
  const touched: Touched[] = [...units].map((unit) => ({ unit }));
  for (const stored of view.extracts("screen", { start_ms: from, end_ms: to + 1 })) {
    if (stored.end_ms! < from || units.has(stored.unit) || parseUnit(stored.unit)?.machine !== machine) continue;
    const into = now.find((sitting) => sitting.first_ms <= stored.end_ms! && sitting.last_ms >= stored.start_ms!);
    touched.push(into === undefined ? { unit: stored.unit } : { unit: unitOf(into.machine, into.first_ms), previous: stored.unit });
  }
  return touched;
}

function joined(spans: readonly [number, number][], reach: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [lo, hi] of [...spans].sort((left, right) => left[0] - right[0])) {
    const last = out.at(-1);
    if (last !== undefined && lo - last[1] <= reach) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function closed(view: View, roles: Roles, sitting: Sitting, cutover: number): boolean {
  const read = new Map(view.sources().map((source) => [source.id, source.read_through_ms]));
  return (["prior", "frames", "input", "machine"] as const).every((role) => {
    if (!reads(role, sitting, cutover)) return true;
    const source = sourceOf(view, roles, sitting.machine, role);
    if (source === undefined || !read.has(source)) return role === "input" || role === "machine";
    return readPast(role, read.get(source) ?? null, sitting, cutover);
  });
}

function reads(role: Role, sitting: Sitting, cutover: number): boolean {
  return role === "prior" ? sitting.first_ms < cutover : role === "frames" ? sitting.last_ms >= cutover : true;
}

function readPast(role: Role, read_ms: number | null, sitting: Sitting, cutover: number): boolean {
  if (read_ms === null || !reads(role, sitting, cutover)) return false;
  return read_ms > sitting.last_ms + GAP_MS || (role === "prior" && read_ms >= cutover);
}

function spanOf(version: Version, role: Role): [number, number] | null {
  if (version.time !== undefined) return [version.time.start_ms, Math.max(version.time.start_ms, version.time.end_ms ?? version.time.start_ms)];
  const content = object(version.content);
  if (role === "prior" && version.kind === "session") {
    const instants = [content.start_frame_identity, ...(Array.isArray(content.frames) ? content.frames : [])]
      .map((identity) => typeof identity === "string" ? identityMs(identity) : null)
      .filter((ms): ms is number => ms !== null);
    return instants.length === 0 ? null : [Math.min(...instants), Math.max(...instants)];
  }
  if (role === "prior") {
    const at = identityMs(version.key);
    return at === null ? null : [at, at];
  }
  return null;
}

function sittingLines(extract: ExtractRow, enrichment: EnrichmentRow | undefined, mac: (unit: string) => string | null): DayLine[] {
  const content = extract.content as unknown as SittingContent;
  const unit = extract.unit;
  const apps = (content.closed ? content.apps : []).filter(([, seconds]) => seconds > 0).map(([app, seconds]) => `${app} ${seconds < 30 ? "<1" : Math.round(seconds / 60)} min`);
  const block = { key: unit, title: `Screen${apps.length > 0 ? `: ${apps.join(", ")}` : ""}` };
  const line = (start_ms: number, end_ms: number | null, text: string): DayLine =>
    ({ family: "screen", unit, units: [unit], start_ms, end_ms, text, item: unit, block });
  if (enrichment?.state !== "done") {
    const state = content.closed ? enrichment?.state === "given-up" ? "no account: given up" : "account pending" : "so far";
    const at = mac(content.machine);
    return [line(content.start_ms, content.end_ms, `${duration(content.end_ms - content.start_ms)} at ${at ?? "the Mac"} (${state})`)];
  }
  const account = enrichment.content as unknown as Account;
  const presence = (entry: Account["timeline"][number]) => entry.present === "yes" ? ""
    : ` (${entry.present === "no" ? "away" : "presence unsure"}: ${entry.present_why})`;
  return [
    line(content.start_ms, content.end_ms, `Summary: ${account.summary}`),
    ...account.timeline.map((entry) => line(entry.start_ms, entry.end_ms, `${entry.doing} [${entry.task}]${entry.where ? ` in ${entry.where}` : ""}${presence(entry)}`)),
    ...account.actions.map((act) => line(act.at_ms, null, `Did: ${act.what}`)),
  ];
}

