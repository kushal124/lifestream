import { addDays, dayBounds, type RecordRef } from "@lifestreamprotocol/core";
import type { DayAtom } from "./days.js";
import {
  episodes, photosOf,
  type Chapter as Stretch, type Count, type Episode, type EpisodesExtras, type EpisodesFile, type Gap, type Hour, type Kind, type Mode, type Name, type Run,
} from "./day-episodes.js";
import { daySide, spotsToName, staysAtHome, type DaySide, type DaySideExtras } from "./day-side.js";
import { duration, productOf, quietLineOf, type Products } from "./day-words.js";

export type DayExtras = EpisodesExtras & DaySideExtras;

export type DayWords = Run | { type: "text"; text: string; tone: "tertiary"; title: true };

export type DayName = Name;

export interface DayRow {
  key: string;
  kind: Kind | "gap";
  at_ms: number | null;
  end_ms: number | null;
  icon: string;
  name: string;
  note: string;
  words: DayWords[];
  count: Count | null;
  quiet: boolean;
  focus: string | null;
  divider: string | null;
}

export interface DayPhoto {
  hash: string;
  at_ms: number | null;
  alt: string;
  video: boolean;
  duration_ms: number | null;
}

export interface ChapterHead {
  title: string;
  line: string | null;
  place: string | null;
  stated_by: string | null;
  since_ms: number | null;
  icon: string;
  quiet: boolean;
  words: Run[];
  length: string | null;
}

export interface Block {
  key: string;
  kind: "hour" | "run";
  start_ms: number;
  title: null;
  line: string | null;
  count: Count | null;
  folded: boolean;
  rows: DayRow[];
  divider: string | null;
}

export interface Chapter {
  key: string;
  kind: "stay" | "move" | "none" | "day" | "gap";
  episode: string | null;
  head: ChapterHead | null;
  start_ms: number;
  end_ms: number | null;
  folded: boolean;
  names: DayName[];
  photos: DayPhoto[];
  blocks: Block[];
  divider: string | null;
}

export interface DayAlso {
  folded: boolean;
  names: DayName[];
  rows: DayRow[];
}

export interface DayPage {
  state: "ready" | "empty";
  line: string | null;
  now_ms: number | null;
  updated_ms: number | null;
  all_day: DayRow[];
  chapters: Chapter[];
  also: DayAlso | null;
  plans: DayRow[];
  until_ms: number | null;
  now_divider: string | null;
  end_ms: number | null;
  before_home: string | null;
  side: DaySide;
}

export const QUIET_GAP_MS = 60 * 60000;
export const EMPTY_LINE = "Nothing recorded this day.";
const NO_PLACE = "No place recorded";
const MINUTE = 60_000;

const KIND_ICONS: Record<Kind, string> = {
  stay: "place", move: "move", sleep: "sleep", workout: "workout", sitting: "work-mac", phone: "phone-screen", browsing: "web",
  conversation: "message", ai: "ai", call: "call", mail_sent: "mail", mail_received: "mail", event: "calendar-event", note: "note",
  voice_note: "voice-note", dictation: "voice-note", search: "search", photos: "photos", listening: "listening", check_in: "check-in",
  payment: "money", other: "info",
};
const ROW_MODE_ICONS: Record<Mode, string> = { walk: "walk", run: "run", transit: "transit", drive: "drive" };
const HEAD_MODE_ICONS: Partial<Record<Mode, string>> = { drive: "drive", walk: "walk", run: "run" };

export function iconOf(episode: Episode, products: Products | undefined): string {
  if (episode.product !== undefined) return productOf(products, episode.product).icon ?? KIND_ICONS[episode.kind];
  if (episode.kind === "move" && episode.mode) return ROW_MODE_ICONS[episode.mode];
  if (episode.kind === "conversation" && episode.group) return "meeting";
  if (episode.kind === "photos" && episode.count === 1) return "photo";
  return KIND_ICONS[episode.kind];
}

const headIcon = (episode: Episode): string => (episode.mode && HEAD_MODE_ICONS[episode.mode]) ?? "move";

const textLine = (words: Run[]): string | null =>
  words.map((run) => run.type === "text" ? run.text : "").filter(Boolean).join(" · ") || null;

const countText = (count: Count | null): string | null => count && "text" in count ? count.text : null;

interface Context {
  byId: Map<string, Episode>;
  atoms: Map<number, DayAtom>;
  quiet: Set<string>;
  products: Products | undefined;
  window: { start_ms: number; end_ms: number };
  now: number | null;
  unreturned: Set<string>;
  spots: Map<string, string>;
  homes: Set<string>;
}

export const recordFocus = (ref: RecordRef): string => `rec:${ref.source} ${ref.kind} ${ref.key}`;

export const unitFocus = (unit: string, span?: { from_ms: number; to_ms: number }): string => (span === undefined ? `u:${unit}` : `u:${unit}@${span.from_ms}-${span.to_ms}`);

export const atomFocus = (n: number): string => `a${n}`;

export function focusOf(atom: Pick<DayAtom, "record" | "unit" | "start_ms" | "end_ms">): string {
  if (atom.record !== undefined) return recordFocus(atom.record);
  return atom.start_ms === null ? unitFocus(atom.unit) : unitFocus(atom.unit, { from_ms: atom.start_ms, to_ms: atom.end_ms ?? atom.start_ms + 1 });
}

const episodeOf = (ctx: Context, id: string): Episode => ctx.byId.get(id) as Episode;
const firstAtom = (ctx: Context, episode: Episode): DayAtom => ctx.atoms.get(episode.atoms[0] as number) as DayAtom;

const UNRETURNED: DayWords = { type: "text", text: "not returned yet", tone: "tertiary" };

function rowOf(ctx: Context, episode: Episode): DayRow {
  const { name, note, words, count, quiet } = episode.row;
  const titled: DayWords[] = episode.kind === "ai" && episode.folder === undefined && note
    ? [{ type: "text", text: note, tone: "tertiary", title: true }] : [];
  return {
    key: episode.id, kind: episode.kind, at_ms: episode.at_ms, end_ms: null,
    icon: ctx.quiet.has(episode.id) ? "meeting" : iconOf(episode, ctx.products), name, note,
    words: [...titled, ...words, ...ctx.unreturned.has(episode.id) ? [UNRETURNED] : []], count, quiet,
    focus: focusOf(firstAtom(ctx, episode)), divider: null,
  };
}

function gapChapter(gap: Gap): Chapter {
  const { name, words, quiet } = gap.row;
  return {
    key: gap.id, kind: "gap", episode: null,
    head: { title: name, line: null, place: null, stated_by: null, since_ms: null, icon: gap.played.length ? "listening" : "pause", quiet, words, length: null },
    start_ms: gap.start_ms, end_ms: gap.end_ms, folded: false, names: [], photos: [], blocks: [], divider: null,
  };
}

function photosIn(ctx: Context, rows: DayRow[]): DayPhoto[] {
  const atoms = rows.filter((row) => row.kind === "photos")
    .flatMap((row) => episodeOf(ctx, row.key).atoms.map((n) => ctx.atoms.get(n) as DayAtom));
  return photosOf(atoms).map((held) => {
    const about = /^(?:Photo|Screenshot|Image): ([\s\S]*)$/u.exec(atoms.find((atom) => atom.item === held.item)?.text ?? "")?.[1];
    return {
      hash: held.hash, at_ms: held.at_ms, video: held.video, duration_ms: held.duration_ms,
      alt: held.live ? about ? `Live Photo, ${about}` : "Live Photo" : about ?? (held.video ? "Video" : "Photo"),
    };
  });
}

function hourBlock(ctx: Context, hour: Hour, standing: Map<string, DayRow[]>, chapter: string, from: number): Block {
  const rows = hour.rows.flatMap((id) => standing.get(id) ?? []);
  const wrote = rows.every((row) => row.kind === "conversation") && hour.sent === 0 ? rows.length : 0;
  const said = wrote ? [`${wrote} ${wrote === 1 ? "chat" : "chats"} wrote to you`] : hour.names.slice(0, 3).map((name) => name.text);
  const others = wrote ? 0 : hour.names.length - said.length;
  const line = said.length ? said.join(", ") + (others ? ` and ${others} ${others === 1 ? "other" : "others"}` : "") : rows[0]?.name ?? "";
  return {
    key: `${chapter}#${hour.start_ms}`, kind: "hour", start_ms: Math.max(hour.start_ms, from), title: null, line: line || null,
    count: hour.sent ? { sent: hour.sent } : null, folded: true, rows, divider: null,
  };
}

function chaptersOf(ctx: Context, stretch: Stretch): Chapter[] {
  const { window, now } = ctx;
  if (stretch.kind === "none" && stretch.rows.every((id) => !ctx.byId.has(id))) return stretch.gaps.map(gapChapter);
  const from = Math.max(stretch.start_ms, window.start_ms);
  const gaps = new Map(stretch.gaps.map((gap) => [gap.id, gap]));
  const standing = new Map(stretch.rows.map((id): [string, DayRow[]] => {
    const gap = gaps.get(id);
    return [id, gap ? gap.played.map((played) => rowOf(ctx, episodeOf(ctx, played))) : [rowOf(ctx, episodeOf(ctx, id))]];
  }));
  const rows = stretch.rows.flatMap((id) => standing.get(id) ?? []);
  const end_ms = Math.min(stretch.end_ms, window.end_ms);
  if (stretch.kind === "day") {
    if (!rows.length) return [];
    return [{
      key: `day@${from}`, kind: "day", episode: null, head: null, start_ms: from, end_ms, folded: false, names: [], photos: [],
      blocks: [{ key: `day@${from}#run`, kind: "run", start_ms: from, title: null, line: null, count: null, folded: false, rows, divider: null }],
      divider: null,
    }];
  }
  const episode = stretch.episode ? episodeOf(ctx, stretch.episode) : null;
  const first = episode ? firstAtom(ctx, episode) : null;
  const key = first && episode ? `${first.unit}@${episode.start_ms}` : `${stretch.kind}@${from}`;
  const lengthMs = Math.max(0, Math.min(stretch.end_ms, now ?? window.end_ms, window.end_ms) - from);
  const shownLength = lengthMs >= MINUTE ? duration(lengthMs) : null;
  const stay = stretch.kind === "stay" && episode !== null;
  const head: ChapterHead = {
    title: episode ? episode.row.name : NO_PLACE,
    line: stay ? textLine(episode.row.words) : null,
    place: stay ? ctx.spots.get(episode.id) ?? null : null,
    stated_by: stay && first ? /\((from photos|stated by [^)]*)\)$/u.exec(first.text)?.[1] ?? null : null,
    since_ms: stay && (episode.start_ms as number) < window.start_ms ? episode.start_ms : null,
    icon: stay ? ctx.homes.has(episode.id) ? "home" : "place" : stretch.kind === "move" && episode ? headIcon(episode) : "",
    quiet: stay && episode.row.quiet,
    words: stretch.kind === "move" && episode ? episode.row.words : [],
    length: stretch.kind === "move" && episode && !rows.length ? countText(episode.row.count) : shownLength,
  };
  const blocks: Block[] = !rows.length ? []
    : stretch.hours ? stretch.hours.map((hour) => hourBlock(ctx, hour, standing, key, from)).filter((block) => block.rows.length)
    : [{ key: `${key}#run`, kind: "run", start_ms: from, title: null, line: null, count: null, folded: false, rows, divider: null }];
  return [{
    key, kind: stretch.kind, episode: stretch.episode, head, start_ms: from, end_ms, folded: rows.length > 0,
    names: stretch.names, photos: photosIn(ctx, rows), blocks, divider: null,
  }];
}

function quietGaps(built: Chapter[], now: number | null): Chapter[] {
  const things = built.map((chapter, at) => chapter.kind === "gap" ? -1 : at).filter((at) => at >= 0);
  const [first, last] = [things[0] ?? -1, things.at(-1) ?? -1];
  return built.flatMap((chapter, at) => {
    if (chapter.kind !== "gap") return [chapter];
    const end = Math.min(chapter.end_ms as number, now ?? Infinity);
    return at > first && at < last && end - chapter.start_ms >= QUIET_GAP_MS ? [{ ...chapter, end_ms: end }] : [];
  });
}

function openLastStay(chapters: Chapter[], stretches: Map<string, Stretch>, now: number | null): void {
  const last = chapters.findLast((chapter) => chapter.kind !== "gap");
  if (now === null || last?.kind !== "stay" || !last.head) return;
  const stretch = stretches.get(last.key) as Stretch;
  if (stretch.start_ms > now || now - stretch.end_ms > QUIET_GAP_MS) return;
  last.end_ms = null;
  last.head.length = null;
}

export function midnightOf(file: Pick<EpisodesFile, "day" | "zone" | "window">): { ms: number; day: string } | null {
  const day = addDays(file.day, 1);
  const ms = dayBounds(day, { zone: file.zone, day_start_hour: 0 }).start_ms;
  return file.window.start_ms < ms && ms < file.window.end_ms ? { ms, day } : null;
}

class Divider {
  private covered: number;
  private drawn = false;

  constructor(private readonly midnight: { ms: number; day: string } | null, start_ms: number) {
    this.covered = start_ms;
  }

  before(ms: number | null): string | null {
    const { midnight } = this;
    if (this.drawn || !midnight || ms === null || this.covered >= midnight.ms || ms < midnight.ms) return null;
    this.drawn = true;
    return midnight.day;
  }

  past(ms: number | null): void {
    if (ms !== null) this.covered = Math.max(this.covered, ms);
  }
}

function divide(chapters: Chapter[], plans: DayRow[], midnight: { ms: number; day: string } | null, start_ms: number, now: number | null): string | null {
  const line = new Divider(midnight, start_ms);
  for (const chapter of chapters) {
    chapter.divider = line.before(chapter.start_ms);
    for (const block of chapter.blocks) {
      if (block.kind === "hour") block.divider = line.before(block.start_ms);
      for (const row of block.rows) {
        row.divider = line.before(row.at_ms);
        line.past(row.at_ms);
      }
      if (block.kind === "hour") line.past(block.start_ms);
    }
    line.past(chapter.end_ms ?? now);
  }
  if (now === null) return null;
  const before = line.before(now);
  for (const plan of plans) plan.divider = line.before(plan.at_ms);
  return before;
}

export function dayPage(file: EpisodesFile, extras: DayExtras, now_ms: number | null): DayPage {
  const { window } = file;
  const now = now_ms !== null && window.start_ms <= now_ms && now_ms < window.end_ms ? now_ms : null;
  const result = episodes(file, extras, now);
  const atoms = new Map(file.atoms.map((atom) => [atom.n, atom]));
  const byId = new Map(result.episodes.map((episode) => [episode.id, episode]));
  const quiet = new Set(result.also.filter((id) => quietLineOf(atoms.get((byId.get(id) as Episode).atoms[0] as number) as DayAtom)));
  const side = daySide(file, extras, result, now);
  const ctx: Context = {
    byId, atoms, quiet, products: extras.products, window, now, unreturned: new Set(side.unreturned.map((call) => call.key)),
    spots: spotsToName(file, extras.where, result, now), homes: staysAtHome(file, extras, result, now),
  };

  const stretches = new Map<string, Stretch>();
  const built = result.chapters.flatMap((stretch) => chaptersOf(ctx, stretch).map((chapter) => {
    stretches.set(chapter.key, stretch);
    return chapter;
  }));
  const chapters = quietGaps(built, now);
  openLastStay(chapters, stretches, now);

  const dated = result.untimed.rows.filter((id) => !quiet.has(id));
  const held = new Set(dated);
  const also: DayAlso | null = dated.length
    ? { folded: false, names: result.untimed.names.filter((name) => held.has(name.firstRowId)), rows: dated.map((id) => rowOf(ctx, episodeOf(ctx, id))) }
    : null;
  const plans = now === null ? [] : result.plan.map((id) => rowOf(ctx, episodeOf(ctx, id)));
  const now_divider = divide(chapters, plans, midnightOf(file), window.start_ms, now);
  const starts = plans.flatMap((plan) => plan.at_ms ?? []);

  return {
    state: file.atoms.length ? "ready" : "empty",
    line: file.atoms.length ? null : EMPTY_LINE,
    now_ms: now,
    updated_ms: now === null ? null : result.updated,
    all_day: result.all_day.map((id) => rowOf(ctx, episodeOf(ctx, id))),
    chapters,
    also,
    plans,
    until_ms: starts.length ? Math.min(...starts) : null,
    now_divider,
    end_ms: chapters.length || also || now !== null ? window.end_ms : null,
    before_home: null,
    side,
  };
}
