import { addDays, digest, type Json } from "@lifestreamprotocol/core";
import { connectorName, type Connector } from "@lifestreamprotocol/connect";
import { shownOf } from "./connectors.js";
import type { AnswerOf, Body, PageAsk, PageHandler, Phrase, PhrasePart, StorageTone } from "./pages.js";
import { OTHER, OWN, type StorageRead } from "./storage-read.js";
import { amount, NB, sentence as capital } from "./stream-words.js";

export type Storage = Body<AnswerOf<"storage">>;
type Part = Storage["bar"]["parts"][number];
type Use = Storage["uses"][number];
type Read = Omit<StorageRead, "position">;
type Stream = Read["home"]["streams"][number];

const RANKED = 5;
const GROWING = 1e6;
const WEEK = 7;
const SOON_DAYS = 30;
const FAR_DAYS = 5 * 365;

export const WORDS = {
  title: "Storage",
  own: "Index and AI",
  ownLine: "Search, summaries and model answers",
  other: "Other connectors",
  uncounted: "Not yet counted",
  otherFiles: "Other files",
  free: "Free",
  counting: "Counting…",
  yours: "Lifestream",
  growth: "Growth",
  used: "What uses the space",
  fewer: "Show fewer",
  keep: "Space kept free",
  keepLine: "Under this, Lifestream keeps taking what is new; history and imports wait.",
  thisMac: "this Mac",
  yourMac: "your Mac",
} as const;

export function spaceWords(bytes: number): string {
  if (bytes <= 0) return `0${NB}KB`;
  const said = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
  const kb = Math.max(1, said(bytes / 1e3, 0));
  if (kb < 1000) return `${kb}${NB}KB`;
  const mb = said(bytes / 1e6, 0);
  if (mb < 1000) return `${mb}${NB}MB`;
  const gb = said(bytes / 1e9, bytes < 9.95e9 ? 1 : 0);
  if (gb < 1000) return `${gb}${NB}GB`;
  return `${said(bytes / 1e12, 2)}${NB}TB`;
}

export const leftWords = (ms: number | null): string =>
  ms === null ? "" : ms < 60_000 ? "Less than a minute left" : `About ${amount(Math.round(ms / 60_000), ["minute", "minutes"])} left`;

export const moreWords = (rest: number): string => `Show ${amount(rest, ["more connector", "more connectors"])}`;

const words = (text: string): PhrasePart => ({ kind: "words", words: text });
const onDay = (day: string): PhrasePart => ({ kind: "time", time: { kind: "day", day } });

type Forecast = "young" | "full" | "still" | "rate";

function forecastOf({ growth }: Read): Forecast {
  const soon = growth.days_left !== null && growth.days_left < SOON_DAYS;
  if (growth.readings < WEEK && !soon) return "young";
  if (growth.days_left !== null && growth.days_left <= 0) return "full";
  if (growth.bytes_a_day === null || growth.bytes_a_day <= 0) return "still";
  return "rate";
}

export function sentenceOf(read: Read, today: string, here: string): Phrase {
  const { disk, growth } = read;
  const named = disk.name ?? capital(here);
  const forecast = forecastOf(read);
  if (forecast === "young") {
    return [words(`Lifestream has been measuring for ${amount(Math.max(1, growth.readings), ["day", "days"])}. How fast it grows shows here after a week.`)];
  }
  if (forecast === "full") return [words(`${named} is full.`)];
  if (forecast === "still" || growth.bytes_a_day === null) return [words(`${named} is not filling.`)];
  const rate = `${named} fills by about ${spaceWords(growth.bytes_a_day)} a day.`;
  if (growth.days_left === null || growth.days_left > FAR_DAYS) return [words(rate)];
  return [words(`${rate} At this rate it is full around `), onDay(addDays(today, growth.days_left)), words(".")];
}

export interface StorageAsk {
  readonly connectors: readonly Connector[];
  readonly today: string;
  readonly here: string;
}

export const hereOf = (ask: Pick<PageAsk, "device">): string => (ask.device === "phone" ? WORDS.yourMac : WORDS.thisMac);

export function storagePage(read: Read, { connectors, today, here }: StorageAsk): Storage {
  const { disk, home, series } = read;
  const declared = new Map(connectors.map((each) => [each.id, each]));
  const nameOf = (id: string): string => {
    const connector = declared.get(id);
    return connector === undefined ? id : connectorName(connector);
  };
  const opens = (id: string): string | null => {
    const connector = declared.get(id);
    return connector !== undefined && shownOf(connector) !== null ? id : null;
  };
  const total = Math.max(1, disk.total_bytes);
  const free = Math.max(0, Math.min(disk.free_bytes, total));
  const used = total - free;
  const share = (bytes: number) => (bytes / total) * 100;
  const named = disk.name ?? here;
  const Named = capital(named);
  const ranked = home.streams.slice(0, RANKED);
  const rest = home.streams.slice(RANKED);
  const restBytes = rest.reduce((sum, stream) => sum + stream.bytes, 0);
  const toneOf = new Map(ranked.map((stream, at) => [stream.connector, `s${at + 1}` as StorageTone]));
  const outside = Math.max(0, used - home.bytes);
  const freePart: Part = { id: "", name: WORDS.free, tone: "free", share: share(free), size: spaceWords(free) };
  const frame = {
    title: WORDS.title, growth: WORDS.growth, used: WORDS.used, fewer: WORDS.fewer, sentence: sentenceOf(read, today, here),
    disk: `${spaceWords(free)} free of ${spaceWords(total)} on ${named}`,
    keep: { label: WORDS.keep, line: WORDS.keepLine, size: spaceWords(disk.keep_bytes) },
  };
  if (read.counting?.map === true) {
    return {
      ...frame, counted: false, figure: WORDS.counting, after: "", chart: null, uses: [], more: null,
      bar: {
        label: `${Named}: used ${spaceWords(used)}, counting, ${spaceWords(free)} free`, left: "",
        parts: [{ id: "", name: WORDS.uncounted, tone: "uncounted", share: share(used), size: spaceWords(used) }, freePart],
        key: [{ id: "", name: WORDS.uncounted, tone: "uncounted" }],
      },
    };
  }
  const counting = read.counting !== null;
  const parts: Part[] = [
    ...ranked.map((stream) => ({ id: stream.connector, name: nameOf(stream.connector), tone: toneOf.get(stream.connector)!, share: share(stream.bytes), size: spaceWords(stream.bytes) })),
    ...(rest.length > 0 ? [{ id: OTHER, name: WORDS.other, tone: "other" as const, share: share(restBytes), size: spaceWords(restBytes) }] : []),
    { id: OWN, name: WORDS.own, tone: "own", share: share(home.own.bytes), size: spaceWords(home.own.bytes) },
  ];
  const elsewhere: StorageTone = counting ? "uncounted" : "disk";
  const bar = {
    label: counting
      ? `${Named}: counted so far ${spaceWords(home.bytes)}, not yet counted ${spaceWords(outside)}, ${spaceWords(free)} free`
      : `${Named}: Lifestream ${spaceWords(home.bytes)}, other files ${spaceWords(outside)}, ${spaceWords(free)} free`,
    parts: [...parts, { id: "", name: counting ? WORDS.uncounted : `Other files on ${named}`, tone: elsewhere, share: share(outside), size: spaceWords(outside) }, freePart],
    key: [...parts.map(({ id, name, tone }) => ({ id, name, tone })), { id: "", name: counting ? WORDS.uncounted : WORDS.otherFiles, tone: elsewhere }],
    left: counting ? leftWords(read.counting?.left_ms ?? null) : "",
  };
  const young = series !== null && series.first_day > addDays(today, -WEEK);
  const weekOf = (week: number | null): Phrase | null => {
    if (week === null) return null;
    if (week < GROWING) return [words("Not growing")];
    return young && series !== null ? [words(`+${spaceWords(week)} since `), onDay(series.first_day)] : [words(`+${spaceWords(week)} this week`)];
  };
  const whole = Math.max(1, home.bytes);
  const use = (stream: Stream, tone: StorageTone, part: string, folded: boolean): Use => ({
    id: stream.connector, part, name: nameOf(stream.connector), tone, size: spaceWords(stream.bytes), share: (stream.bytes / whole) * 100,
    line: weekOf(stream.week_bytes), opens: opens(stream.connector), folded,
  });
  const uses: Use[] = [
    ...ranked.map((stream) => use(stream, toneOf.get(stream.connector)!, stream.connector, false)),
    ...rest.map((stream) => use(stream, "other", OTHER, true)),
    { id: OWN, part: OWN, name: WORDS.own, tone: "own", size: spaceWords(home.own.bytes), share: (home.own.bytes / whole) * 100, line: [words(WORDS.ownLine)], opens: null, folded: false },
  ];
  const chart = counting || series === null ? null : {
    label: [words("Lifestream’s size since "), onDay(series.first_day)],
    first: series.first_day,
    parts: series.parts.map((part) => ({
      id: part.part, bytes: part.bytes,
      name: part.part === OTHER ? WORDS.other : part.part === OWN ? WORDS.own : nameOf(part.part),
      tone: part.part === OTHER ? "other" as const : part.part === OWN ? "own" as const : toneOf.get(part.part) ?? "other",
    })),
    rate: forecastOf(read) === "rate" ? read.growth.bytes_a_day : null,
    room: { bytes: home.bytes + free - disk.keep_bytes - disk.coming_bytes, name: `${Named} full` },
  };
  return {
    ...frame, counted: !counting, figure: counting ? WORDS.counting : spaceWords(home.bytes), after: counting ? `${spaceWords(home.bytes)} so far` : WORDS.yours,
    bar, chart, uses, more: rest.length > 0 ? moreWords(rest.length) : null,
  };
}

export interface StorageReads {
  read(ask: Pick<PageAsk, "now_ms">): { position: string; read: Read; connectors: readonly Connector[] };
}

export function storageHandler(reads: StorageReads): PageHandler<AnswerOf<"storage">> {
  return {
    params: [],
    open(ask, use) {
      const { position, read, connectors } = reads.read(ask);
      const body = storagePage(read, { connectors, today: ask.today, here: hereOf(ask) });
      return use({ position, inputs: [digest(body as unknown as Json)], counting: false, build: () => body });
    },
  };
}
