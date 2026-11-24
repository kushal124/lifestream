import {
  daysOf, digest, render, selects, textHead,
  type Head, type Json, type RecordRef, type ScreenAdapter, type SourceRow, type SourceSelector, type Version, type View, type WebAdapter,
  type WebItem as Stated, type WebVisit,
} from "@lifestreamprotocol/core";
import { deviceWords, drawnFrom, linesOnly, type Change, type DayInput, type DayLine, type Family, type FamilyInput, type Given, type Touched } from "../family.js";
import { recordRead, recordText } from "../shared/text.js";
import { SCREEN_CUTOVER_MS } from "../screen/family.js";
import { GAP_MS, identityMs, object, Roles, sittingsOf, sourceIn, sourceOf, text, unitOf as sittingUnit, type Sitting } from "../screen/sittings.js";

export const WEB_FAMILY = "web";
const KINDS = ["page-visit", "search", "download", "tab"] as const;
const TEXT_KINDS: readonly string[] = ["page-visit", "search"];
const VISIT_KIND = "page-visit";
const CLAIMS: SourceSelector = { product: ["stations"] };
export const SEEN_MS = 60_000;
const TITLES = 3;
const TITLE_CHARS = 80;
const HOUR_MS = 3_600_000;
const REPEAT_REACH_MS = 24 * HOUR_MS;
const ANOTHER_DEVICE = "another device";


export interface WebSettings {
  cutover_ms?: number;
  screen?: readonly Given<ScreenAdapter>[];
}

export interface WebItem {
  what: "visit" | "search" | "download" | "tab";
  browser: string;
  record: RecordRef;
  at_ms: number;
  device: string | null;
  sitting: number | null;
  site: string;
  title: string | null;
  term?: string;
  file?: string;
  state?: string;
  seen?: boolean;
}

export interface WebHour {
  machine: string;
  hour: string;
  items: WebItem[];
}

export function pagesShown(hours: Iterable<WebHour>, sources: ReadonlySet<string>, starts: readonly number[]): number[] {
  const days = new Array<number>(starts.length - 1).fill(0);
  for (const { items } of hours) {
    for (const { record, at_ms } of items) {
      if (record.kind !== "page-visit" || !sources.has(record.source)) continue;
      const at = starts.findLastIndex((start) => start <= at_ms);
      if (at >= 0 && at < days.length) days[at] = days[at]! + 1;
    }
  }
  return days;
}

export function webFamily(settings: WebSettings = {}): (given: readonly Given<WebAdapter>[]) => Family {
  const cutover = settings.cutover_ms ?? SCREEN_CUTOVER_MS;
  const roles = new Roles(settings.screen ?? []);
  return (given) => {
    const browsers: Browsers = {
    sources: { product: given.map((each) => each.product) },
    stations: { product: given.filter((each) => each.adapter.station === true).map((each) => each.product) },
    of: new Map(given.map((each) => [each.product, each])),
  };
  return {
    name: WEB_FAMILY,
    borrowed: { screen: settings.screen ?? [] },
    type: "web",
    code: `4:${cutover}`,
    inputs: [
      ...given.map((each): FamilyInput => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),
      { sources: roles.selector("prior"), kinds: ["frame"], role: "labels" },
      { sources: roles.selector("frames"), kinds: ["frame", "recorder"], role: "labels" },
      { sources: CLAIMS, kinds: ["tab"], role: "labels" },
    ],

    touched(changes, view) {
      const units = new Set<string>();
      const frames = new Map<string, [number, number][]>();
      const pages: Pages = new Map();
      for (const change of changes) {
        const source = view.source(change.record.source);
        if (source === undefined) continue;
        const versions = [change.before, change.after].filter((version): version is Version => version !== undefined);
        if (selects(CLAIMS, source)) {
          for (const version of versions) for (const visit of claimedVisits(view, browsers, version)) units.add(unitOf(visit.machine, utcHour(visit.at_ms)));
          continue;
        }
        if (selects(browsers.sources, source)) {
          for (const version of versions) if (version.time !== undefined) units.add(unitOf(source.copy, utcHour(version.time.start_ms)));
          notePage(pages, browsers, source, change);
          continue;
        }
        const coast = roles.of(source) === "prior";
        for (const version of versions) {
          const span = frameSpan(version, coast);
          if (span === null) continue;
          const [lo, hi] = coast ? [span[0], Math.min(span[1], cutover - 1)] : [Math.max(span[0], cutover), span[1]];
          if (lo <= hi) frames.set(source.copy, [...frames.get(source.copy) ?? [], [lo, hi]]);
        }
      }
      for (const [machine, spans] of frames) {
        for (const [lo, hi] of joined(spans, 2 * GAP_MS)) for (const unit of moved(view, roles, machine, cutover, lo, hi)) units.add(unit);
      }
      for (const { source, at_ms } of repeatsIn(view, browsers, pages)) units.add(unitOf(source.copy, utcHour(at_ms)));
      return [...units].sort().map((unit): Touched => ({ unit }));
    },

    extract(unit, view) {
      const parsed = parseUnit(unit);
      if (parsed === null) return null;
      const { machine, hour } = parsed;
      const start = Date.parse(`${hour}:00:00Z`);
      const items = readHour(view, browsers, machine, start, start + HOUR_MS);
      if (items.length === 0) return null;
      placeInSittings(view, roles, machine, cutover, items, start, start + HOUR_MS);
      const json = { machine, hour, items } satisfies WebHour as unknown as Json;
      return { content: json, start_ms: items[0]!.at_ms, end_ms: items.at(-1)!.at_ms, reading: digest(json) };
    },

    days: (extract, settings) => parseUnit(extract.unit) === null ? [] : daysOf({ start_ms: extract.start_ms!, end_ms: extract.end_ms! + 1, precision: "ms" }, settings),

    day: linesOnly((input) => webLines(input, (machine, at_ms) => framesSeenBy(input.sources, roles, cutover, machine, at_ms))),

    text: {
      version: "3",
      kinds: TEXT_KINDS.filter((kind) => given.some((each) => each.adapter.kinds.includes(kind))),
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const item = source === undefined || !TEXT_KINDS.includes(record.kind) ? null : statedOf(browsers, source, version);
        if (item === null) return null;
        if (version.time !== undefined && (erranded(item, version.time.start_ms, view) || repeated(view, browsers, source!, record, version, version.time.start_ms))) return null;
        if (item.what === "search") return recordText({ text: item.term, link: item.url });
        return item.what === "visit" ? recordText({ title: item.title, text: item.url, link: item.url }) : null;
      },
      follows: [
        {
          sources: CLAIMS, kinds: ["tab"],
          moved: (changes, view) => changes.flatMap((change) => change.after === undefined ? [] : claimedVisits(view, browsers, change.after).map((visit) => visit.record)),
        },
        {
          sources: browsers.sources, kinds: [VISIT_KIND],
          moved(changes, view) {
            const pages: Pages = new Map();
            for (const change of changes) {
              const source = view.source(change.record.source);
              if (source !== undefined) notePage(pages, browsers, source, change);
            }
            return repeatsIn(view, browsers, pages).map((repeat) => repeat.record);
          },
        },
      ],
    },

    read: {
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const item = source === undefined || !TEXT_KINDS.includes(record.kind) ? null : statedOf(browsers, source, version);
        if (item === null) return null;
        if (item.what === "search") return recordRead({ text: item.term, link: item.url });
        return item.what === "visit" ? recordRead({ title: item.title, text: item.url, link: item.url }) : null;
      },
    },
  };
  };
}

interface Browsers {
  sources: SourceSelector;
  stations: SourceSelector;
  of: ReadonlyMap<string, Given<WebAdapter>>;
}

function statedOf(browsers: Browsers, source: SourceRow, version: Version): Stated | null {
  const fed = browsers.of.get(source.product);
  if (fed === undefined || !fed.adapter.kinds.includes(version.kind)) return null;
  const item = fed.adapter.item({ source, version });
  if (item === null || item.tab === undefined || fed.adapter.station === true) return item;
  const { tab: _tab, ...rest } = item;
  return rest;
}


type Read = WebItem & { url: string | null };

function readHour(view: View, browsers: Browsers, machine: string, start: number, end: number): WebItem[] {
  const items: WebItem[] = [];
  for (const source of view.sources(browsers.sources).filter((row) => row.copy === machine)) {
    const fed = browsers.of.get(source.product)!;
    const read: Read[] = [];
    for (const kind of KINDS.filter((each) => fed.adapter.kinds.includes(each))) {
      for (const { head, version } of view.records(source.id, kind, { start_ms: start, end_ms: end })) {
        if (head.start_ms! < start || head.start_ms! >= end) continue;
        const stated = statedOf(browsers, source, version);
        if (stated === null || erranded(stated, head.start_ms!, view) || repeated(view, browsers, source, { source: source.id, kind, key: head.key }, version, head.start_ms!)) continue;
        read.push(readOf(stated, fed.name, { source: source.id, kind, key: head.key }, head.start_ms!));
      }
    }
    items.push(...joinSearches(read));
  }
  return items.sort(byTime);
}

function repeated(view: View, browsers: Browsers, source: SourceRow, record: RecordRef, version: Version, at_ms: number): boolean {
  const visit = visitOf(browsers, source, version);
  if (visit?.from === undefined || visit.url === null || visit.tab === undefined) return false;
  let from: Head | undefined;
  for (const head of view.keyedUnder(source.id, record.kind, visit.from)) {
    if (head.key === record.key || head.start_ms === null || head.start_ms >= at_ms || (from !== undefined && head.start_ms < from.start_ms!)) continue;
    from = head;
  }
  const was = from === undefined ? null : visitOf(browsers, source, view.version(from.version));
  return was !== null && was.url === visit.url && was.tab === visit.tab;
}

function visitOf(browsers: Browsers, source: SourceRow, version: Version): WebVisit | null {
  const fed = browsers.of.get(source.product);
  if (fed?.adapter.visit === undefined || version.kind !== VISIT_KIND || !fed.adapter.kinds.includes(VISIT_KIND)) return null;
  return fed.adapter.visit({ source, version });
}

function pageOf(visit: WebVisit | null): string | null {
  return visit === null ? null : JSON.stringify([visit.url, visit.tab ?? null]);
}

type Pages = Map<string, { source: SourceRow; keys: string[]; spans: [number, number][] }>;

function notePage(pages: Pages, browsers: Browsers, source: SourceRow, change: Change): void {
  const pagesOf = [change.before, change.after].map((version) => version === undefined ? null : pageOf(visitOf(browsers, source, version)));
  if (pagesOf.every((page) => page === null) || (change.before !== undefined && change.after !== undefined && pagesOf[0] === pagesOf[1])) return;
  const held = pages.get(source.id) ?? { source, keys: [], spans: [] };
  held.keys.push(change.record.key);
  for (const version of [change.before, change.after]) if (version?.time !== undefined) held.spans.push([version.time.start_ms, version.time.start_ms + REPEAT_REACH_MS]);
  pages.set(source.id, held);
}

function repeatsIn(view: View, browsers: Browsers, pages: Pages): { record: RecordRef; source: SourceRow; at_ms: number }[] {
  const out: { record: RecordRef; source: SourceRow; at_ms: number }[] = [];
  for (const { source, keys, spans } of pages.values()) {
    if (browsers.of.get(source.product)?.adapter.visit === undefined) continue;
    const sorted = [...keys].sort(compare);
    const names = (prefix: string): boolean => {
      let low = 0;
      let high = sorted.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (sorted[middle]! < prefix) low = middle + 1;
        else high = middle;
      }
      return low < sorted.length && sorted[low]!.startsWith(prefix);
    };
    for (const [lo, hi] of joined(spans, 0)) {
      for (const { head, version } of view.records(source.id, VISIT_KIND, { start_ms: lo, end_ms: hi + 1 })) {
        const from = visitOf(browsers, source, version)?.from;
        if (from !== undefined && head.start_ms !== null && names(from)) out.push({ record: { source: source.id, kind: VISIT_KIND, key: head.key }, source, at_ms: head.start_ms });
      }
    }
  }
  return out;
}

type Claimed = ReadonlyMap<number, readonly (readonly [number, number])[]>;

const claimsRead = new WeakMap<View, Map<number, Claimed>>();

function claimsAt(view: View, at_ms: number): Claimed {
  const hour = Math.floor(at_ms / HOUR_MS) * HOUR_MS;
  const held = claimsRead.get(view) ?? new Map<number, Claimed>();
  claimsRead.set(view, held);
  const read = held.get(hour);
  if (read !== undefined) return read;
  const claimed = new Map<number, [number, number][]>();
  for (const source of view.sources(CLAIMS)) {
    for (const { version } of view.records(source.id, "tab", { start_ms: hour, end_ms: hour + HOUR_MS })) {
      const { tab, from_ms, until_ms } = object(version.content);
      claimed.set(tab as number, [...claimed.get(tab as number) ?? [], [from_ms as number, until_ms as number]]);
    }
  }
  held.set(hour, claimed);
  return claimed;
}

function erranded(item: Stated, at_ms: number, view: View): boolean {
  if (item.what !== "visit" || item.tab === undefined || item.tab.shown) return false;
  const tab = item.tab.id;
  return claimsAt(view, at_ms).get(tab)?.some(([from, until]) => from <= at_ms && at_ms <= until) === true;
}

function claimedVisits(view: View, browsers: Browsers, claim: Version): { record: RecordRef; machine: string; at_ms: number }[] {
  const { tab, from_ms, until_ms } = object(claim.content);
  const from = from_ms as number;
  const until = until_ms as number;
  return view.sources(browsers.stations).flatMap((source) => {
    const visits: { record: RecordRef; machine: string; at_ms: number }[] = [];
    for (const kind of browsers.of.get(source.product)!.adapter.kinds) {
      for (const { head, version } of view.records(source.id, kind, { start_ms: from, end_ms: until + 1 })) {
        if (head.start_ms! < from || head.start_ms! > until) continue;
        const item = statedOf(browsers, source, version);
        if (item?.what !== "visit" || item.tab?.id !== tab) continue;
        visits.push({ record: { source: source.id, kind, key: head.key }, machine: source.copy, at_ms: head.start_ms! });
      }
    }
    return visits;
  });
}

function joinSearches(read: Read[]): WebItem[] {
  const terms = new Map<string, string>();
  for (const item of read) if (item.what === "search" && item.url !== null) terms.set(item.url, item.term!);
  const searched = new Set<string>();
  const out: WebItem[] = [];
  for (const { url, ...item } of read) {
    if (item.what === "visit") {
      const term = url === null ? undefined : terms.get(url);
      if (term !== undefined) searched.add(url!);
      out.push(term === undefined ? item : { ...item, what: "search", term });
    }
  }
  for (const { url, ...item } of read) {
    if (item.what === "visit" || (item.what === "search" && url !== null && searched.has(url))) continue;
    out.push(item);
  }
  return out;
}

function readOf(stated: Stated, browser: string, record: RecordRef, at_ms: number): Read {
  const device = stated.device ?? (stated.synced === true ? ANOTHER_DEVICE : null);
  const url = stated.what === "visit" || stated.what === "search" ? stated.url : null;
  return {
    browser, record, at_ms, device, sitting: null, title: stated.what === "search" || stated.what === "download" ? null : stated.title, url,
    what: stated.what, site: siteOf(stated.url),
    ...(stated.term === undefined ? {} : { term: stated.term }),
    ...(stated.file === undefined ? {} : { file: stated.file }), ...(stated.state === undefined ? {} : { state: stated.state }),
  };
}

function placeInSittings(view: View, roles: Roles, machine: string, cutover: number, items: WebItem[], start: number, end: number): void {
  const local = items.filter((item) => item.device === null);
  if (local.length === 0) return;
  const sittings = sittingsOf(view, roles, machine, cutover).around(start, end - 1);
  for (const item of local) item.sitting = sittingAt(sittings, item.at_ms);
  const visits = local.filter((item) => item.what === "visit" && item.sitting !== null);
  if (visits.length === 0) return;
  const shown = new Map<string, number[]>();
  for (const frame of frameSites(view, roles, machine, cutover, joined(visits.map((item) => [item.at_ms, item.at_ms + SEEN_MS]), 0))) {
    const times = shown.get(frame.site);
    if (times === undefined) shown.set(frame.site, [frame.t]);
    else times.push(frame.t);
  }
  for (const times of shown.values()) times.sort((left, right) => left - right);
  for (const item of visits) {
    const times = shown.get(item.site) ?? [];
    const first = firstAtOrAfter(times, item.at_ms);
    item.seen = first < times.length && times[first]! <= item.at_ms + SEEN_MS;
  }
}

function firstAtOrAfter(times: readonly number[], t: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (times[middle]! < t) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sittingAt(sittings: readonly Sitting[], t: number): number | null {
  return sittings.find((sitting) => sitting.first_ms <= t && t <= sitting.last_ms)?.first_ms ?? null;
}

function frameSites(view: View, roles: Roles, machine: string, cutover: number, ranges: readonly [number, number][]): { t: number; site: string }[] {
  const out: { t: number; site: string }[] = [];
  const coast = sourceOf(view, roles, machine, "prior");
  const recorder = sourceOf(view, roles, machine, "frames");
  const sessions = new Map<string, string | null>();
  const sessionSite = (identity: Json | undefined): string | null => {
    if (typeof identity !== "string" || coast === undefined) return null;
    if (!sessions.has(identity)) {
      const head = view.head({ source: coast, kind: "session", key: identity });
      const version = head === undefined || head.version === "gone" ? undefined : view.version(head.version);
      const url = text(object(version?.content).url);
      sessions.set(identity, url === null ? null : siteOf(url));
    }
    return sessions.get(identity)!;
  };
  for (const [lo, hi] of ranges) {
    if (coast !== undefined && lo < cutover) {
      for (const { head, version } of view.records(coast, "frame", { start_ms: lo, end_ms: Math.min(hi + 1, cutover) })) {
        const site = sessionSite(object(version.content).session_start_frame_identity);
        if (site !== null) out.push({ t: head.start_ms!, site });
      }
    }
    if (recorder !== undefined && hi >= cutover) {
      for (const { head, version } of view.records(recorder, "frame", { start_ms: Math.max(lo, cutover), end_ms: hi + 1 })) {
        const site = text(object(version.content).site);
        if (site !== null) out.push({ t: head.start_ms!, site: hostOf(site) });
      }
    }
  }
  return out;
}


function moved(view: View, roles: Roles, machine: string, cutover: number, lo: number, hi: number): string[] {
  const now = sittingsOf(view, roles, machine, cutover).around(lo, hi);
  const from = Math.min(lo, ...now.map((sitting) => sitting.first_ms)) - GAP_MS;
  const to = Math.max(hi, ...now.map((sitting) => sitting.last_ms)) + GAP_MS;
  const units: string[] = [];
  for (let hour = Math.floor(from / HOUR_MS) * HOUR_MS; hour <= to; hour += HOUR_MS) {
    const unit = unitOf(machine, utcHour(hour));
    const stored = view.extract(WEB_FAMILY, unit);
    if (stored === undefined) continue;
    const stale = (stored.content as unknown as WebHour).items.some((item) => item.device === null && item.at_ms >= from && item.at_ms <= to && (
      sittingAt(now, item.at_ms) !== item.sitting || (item.what === "visit" && item.at_ms >= lo - SEEN_MS && item.at_ms <= hi)));
    if (stale) units.push(unit);
  }
  return units;
}

function frameSpan(version: Version, coast: boolean): [number, number] | null {
  if (version.time !== undefined) return [version.time.start_ms, Math.max(version.time.start_ms, version.time.end_ms ?? version.time.start_ms)];
  const at = coast ? identityMs(version.key) : null;
  return at === null ? null : [at, at];
}


interface Placed {
  item: WebItem;
  unit: string;
  machine: string;
}

interface Block {
  key: string;
  title: string;
  named: boolean;
  items: Placed[];
  last_ms: number;
}

function framesSeenBy(sources: ReadonlyMap<string, SourceRow>, roles: Roles, cutover: number, machine: string, at_ms: number): string[] {
  const read = [...at_ms < cutover ? ["prior" as const] : [], ...at_ms + SEEN_MS >= cutover ? ["frames" as const] : []];
  return read.flatMap((role) => sourceIn(sources.values(), roles, machine, role) ?? []);
}

export function webLines(input: DayInput, seenBy: (machine: string, at_ms: number) => string[]): DayLine[] {
  const placed = input.extracts.flatMap((extract) => {
    const content = extract.content as unknown as WebHour;
    return content.items.map((item): Placed => ({ item, unit: extract.unit, machine: content.machine }));
  });
  const mac = deviceWords(input, placed.map(({ machine }) => machine));
  const on = (machine: string) => {
    const name = mac(machine);
    return name === null ? "" : ` on ${name}`;
  };
  const blocks = new Map<string, Block>();
  const runs = new Map<string, Block>();
  for (const each of placed.sort((left, right) => byTime(left.item, right.item))) {
    const { item, machine } = each;
    if (item.sitting !== null) {
      const key = sittingUnit(machine, item.sitting);
      const title = `Web in the ${render(item.sitting, input.settings.zone, "minute", input.day)} sitting${on(machine)}`;
      const block = blocks.get(key) ?? { key, title, named: true, items: [], last_ms: item.at_ms };
      block.items.push(each);
      blocks.set(key, block);
      continue;
    }
    const lane = `${machine}\0${item.browser}\0${item.device ?? ""}`;
    const open = runs.get(lane);
    if (open !== undefined && item.at_ms - open.last_ms <= GAP_MS) {
      open.items.push(each);
      open.last_ms = item.at_ms;
      continue;
    }
    const key = `web:${machine}/${item.at_ms}/${item.browser}/${item.device ?? "this Mac"}`;
    const title = item.device === null ? `${item.browser}${on(machine)}`
      : item.device === ANOTHER_DEVICE ? `${item.browser}, synced from another device` : `${item.browser} on ${item.device}`;
    const block: Block = { key, title, named: false, items: [each], last_ms: item.at_ms };
    runs.set(lane, block);
    blocks.set(key, block);
  }
  return [...blocks.values()].flatMap((block) => blockLines(block, seenBy));
}

function blockLines(block: Block, seenBy: (machine: string, at_ms: number) => string[]): DayLine[] {
  const groups = new Map<string, Placed[]>();
  for (const each of block.items) {
    const { item } = each;
    const by = item.what === "visit" ? `visit\0${item.browser}\0${item.site}`
      : item.what === "search" ? `search\0${item.browser}\0${item.term}` : `${item.what}\0${item.record.source}\0${item.record.key}`;
    const group = groups.get(by);
    if (group === undefined) groups.set(by, [each]);
    else group.push(each);
  }
  return [...groups.values()].map((group): DayLine => {
    const first = group[0]!.item;
    const last = group.at(-1)!.item.at_ms;
    const words = groupWords(group.map(({ item }) => item));
    const units = [...new Set(group.map(({ unit }) => unit))];
    const shownBy = group.flatMap(({ item, machine }) => (item.seen === true ? seenBy(machine, item.at_ms) : []));
    return {
      family: WEB_FAMILY, unit: group[0]!.unit, units, ...drawnFrom(units, group.map(({ item }) => item.record), shownBy), start_ms: first.at_ms, end_ms: last > first.at_ms ? last : null,
      text: block.named ? `${first.browser}: ${words}` : words,
      record: first.record,
      block: { key: block.key, title: block.title },
    };
  });
}

function groupWords(items: WebItem[]): string {
  const first = items[0]!;
  switch (first.what) {
    case "search":
      return `searched "${first.term}"${items.length > 1 ? ` (${items.length} times)` : ""}`;
    case "download":
      return `downloaded ${first.file ?? "a file"} from ${first.site}${first.state === undefined ? "" : ` (${first.state})`}`;
    case "tab":
      return `tab open: ${first.title === null ? first.site : `"${clip(first.title)}" (${first.site})`}`;
    case "visit": {
      const titles = [...new Set(items.map((item) => item.title).filter((title): title is string => title !== null))];
      const quoted = titles.slice(0, TITLES).map((title) => `"${clip(title)}"`).join(", ");
      const others = titles.length - TITLES;
      const more = others > 0 ? ` and ${others} other title${others === 1 ? "" : "s"}` : "";
      const seen = items.filter((item) => item.seen === true).length;
      const shown = seen === 0 ? "" : seen === items.length ? " (on screen)" : ` (${seen} of ${items.length} on screen)`;
      return `visited ${first.site}${items.length > 1 ? ` ${items.length} times` : ""}${titles.length === 0 ? "" : `: ${quoted}${more}`}${shown}`;
    }
  }
}


export function unitOf(machine: string, hour: string): string {
  return `${machine}/${hour}`;
}

export function parseUnit(unit: string): { machine: string; hour: string } | null {
  const match = /^([^/:]+)\/(\d{4}-\d{2}-\d{2}T\d{2})$/u.exec(unit);
  return match === null ? null : { machine: match[1]!, hour: match[2]! };
}

function utcHour(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

function siteOf(href: string | null): string {
  if (href === null) return "unknown";
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:") return hostOf(url.hostname);
    return url.host === "" ? url.protocol : `${url.protocol}//${url.host}`;
  } catch {
    return "unknown";
  }
}

function hostOf(host: string): string {
  return host.toLowerCase().replace(/^www\./u, "");
}

function clip(title: string): string {
  return title.length > TITLE_CHARS ? `${textHead(title, TITLE_CHARS - 1)}…` : title;
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

function byTime(left: WebItem, right: WebItem): number {
  return left.at_ms - right.at_ms || compare(left.record.source, right.record.source)
    || compare(left.record.kind, right.record.kind) || compare(left.record.key, right.record.key);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
