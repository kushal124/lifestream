import type { DetailType } from "./hide.js";
import type { SourceParts, SourceSelector } from "./sources.js";

/** Any value JSON can spell, the shape of a record's content. */
export type Json = null | boolean | number | string | Json[] | { [member: string]: Json };
/** A JSON object, its values by member name. */
export type JsonObject = { [member: string]: Json };

/** How finely a source stated a time, from a millisecond to a calendar year. */
export type Precision =
  /** Stated to a millisecond or finer. */
  | "ms"
  /** Stated to a second, with fewer than three digits of its fraction if any. */
  | "s"
  /** Stated to a minute, with no seconds. */
  | "minute"
  /** A calendar date with no clock, the same day in every zone. */
  | "day"
  /** A calendar month with no day. */
  | "month"
  /** A calendar year with no month. */
  | "year";

/** A record's own time in milliseconds since the Unix epoch, with how finely its source stated it. */
export interface Instant {
  /** When it starts, or for a date midnight UTC of its first day. */
  start_ms: number;
  /** When a time that lasts ends, exclusive, or for a date midnight UTC after its last day. */
  end_ms?: number;
  /** The UTC offset the source stated, in minutes, absent when it stated none. */
  offset_min?: number;
  /** How finely the source stated the time. */
  precision: Precision;
}

/** The name of one record: the source that states it, its kind and its key. */
export interface RecordRef {
  /** The source's name, as `<product>:<account>:<copy>`. */
  source: string;
  /** The kind of record, one its connector declares. */
  kind: string;
  /** The source's own id for the record within its kind, opaque text. */
  key: string;
}

/** One row a reader yields from a delivery: what the source states of one record, its deletion, or a refusal. */
export interface ReaderOutput {
  /** The record's kind, whose guard checks the content. */
  kind: string;
  /** The source's own id for the record within its kind, opaque text. */
  key: string;
  /** What the reader keeps of what the source stated of the record, ignored on a gone row. */
  content: Json;
  /** The record's own time, when the source states one. */
  time?: Instant;
  /** The hashes of the blobs the content refers to, each `sha256:` and hex. */
  blobs?: string[];
  /** The media type of a named blob, by its hash, which decides whether the home stores it compressed. */
  media?: Record<string, string>;
  /** Bytes of a blob no delivery file holds whole, as one message cut from an mbox, which the home stores before it lands the row. */
  bytes?: Uint8Array[];
  /** Blobs no delivery file holds whole and too large to hold at once, as a video in a zip, which the home stores a chunk at a time before it lands the row. */
  streamed?: {
    /** The blob's hash, `sha256:` and hex. */
    hash: string;
    /** The blob's length in bytes. */
    size: number;
    /** Reads the blob's bytes from its start, a chunk at a time, while the reader runs. */
    chunks(): AsyncIterable<Uint8Array>;
  }[];
  /** Set when the source stated the record's deletion. */
  gone?: true;
  /** Why the reader refuses this row, which then lands nothing and is named among the run's refusals. */
  refused?: string;
  /** The delivery file or archive member a refused row lies in, by which the run counts what did not read. */
  member?: string;
  /** The unit id of the device that stated the row, kept on its statement. */
  device?: string;
  /** Where in the delivery the reader found the row, as `visits row 12`, kept on its statement. */
  locator?: string;
}

/** Checks one kind's content and returns its violations, none when the content is accepted. */
export type Guard = (content: Json) => string[];

export interface Version {
  id: string;
  kind: string;
  key: string;
  content: Json;
  text: string;
  time?: Instant;
}

export const GONE = "gone" as const;

export interface Head extends RecordRef {
  version: string;
  stated_ms: number;
  since_ms: number;
  start_ms: number | null;
  end_ms: number | null;
}

export interface Statement extends RecordRef {
  seq: number;
  version: string;
  stated_ms: number;
  run: number;
  device: string | null;
  locator: string | null;
  origin: "source" | "repair";
  late: boolean;
}

export interface Landed {
  new: number;
  restated: number;
  changed: number;
  late: number;
  gone: number;
  erased: number;
  refused: number;
  duplicated: number;
  replayed: number;
  changedPaths: Record<string, number>;
  refusals: { kind: string; key: string; violations: string[] }[];
  refusedMembers?: Map<string, number>;
  consumed?: string[];
}

/** The kind of row by which a reader says it has read whole the import file its key names, so the home may let that file go once the import lands clean. */
export const CONSUMED = "consumed";

/** One sealed set of files a device or acquirer handed the home, with the facts it stated about them. */
export interface Delivery {
  /** The delivery's id, its source's name and its own folder's name joined by a slash. */
  id: string;
  /** The name of the source the delivery is of. */
  source: string;
  /** When the delivery was fetched, from its manifest's `fetched_at`, or its statement time for an owner's statements the door reads as they arrive. */
  sealed_ms: number;
  /** When the source said what the delivery holds, from its facts or else its fetch, the time every row it lands is stated at. */
  stated_ms: number;
  /** The facts the device or acquirer stated about the delivery in its manifest. */
  facts: JsonObject;
  /** Each file the delivery holds, by its path and its blob. */
  files: DeliveryFile[];
}

/** One file of a delivery, held in the home's blob store. */
export interface DeliveryFile {
  /** The file's path inside the delivery. */
  path: string;
  /** The hash of the file's bytes, `sha256:` and hex, by which the blob store holds them. */
  blob: string;
  /** The file's length in bytes. */
  size: number;
}

/** Reads the blobs the home holds, by their hash. */
export interface BlobReader {
  /** Whether the home holds the blob. */
  has(hash: string): boolean;
  /** The blob's whole bytes, checked against its hash. */
  bytes(hash: string): Buffer;
  /** The blob's whole bytes read as UTF-8 text. */
  text(hash: string): string;
  /** The blob's first bytes, as many as asked or all of a shorter blob, read no further than they need and so not checked against the hash. */
  prefix(hash: string, bytes: number): Buffer;
  /** A path to a file of the blob's raw bytes, a link or a temporary copy that `dispose` removes. */
  materialise(hash: string): Promise<{ path: string; dispose(): void }>;
}

export type StatementFilter = { sources?: undefined; kinds?: undefined } | { sources: string[]; kinds?: string[] };

export interface View {
  readonly through: number;
  readonly snapshot?: object;
  head(ref: RecordRef): Head | undefined;
  heads(source: string, kind: string, range?: { start_ms?: number; end_ms?: number }): Iterable<Head>;
  records(
    source: string,
    kind: string,
    range?: { start_ms?: number; end_ms?: number },
  ): Iterable<{ head: Head; version: Version }>;
  version(id: string): Version;
  keyedUnder(source: string, kind: string, prefix: string): Head[];
  erasedUnder(source: string, kind: string, prefix: string): boolean;
  naming(blob: string): Version[];
  statements(after: number, filter?: StatementFilter): Iterable<Statement>;
  history(ref: RecordRef): Statement[];
  sources(selector?: SourceSelector): SourceRow[];
  source(id: string): SourceRow | undefined;
  since(source: string, kinds: readonly string[]): number | undefined;
  extract(family: string, unit: string): ExtractRow | undefined;
  extracts(family: string, range?: { start_ms?: number; end_ms?: number }): Iterable<ExtractRow>;
  extractsUnder(family: string, prefix: string): Iterable<ExtractRow>;
  extractsOn(family: string, day: string): ExtractRow[];
  unitsPending(family: string): boolean;
  enrichment(family: string, item: string, prompt: string): EnrichmentRow | undefined;
}

export interface SourceRow extends SourceParts {
  id: string;
  connector: string;
  options: JsonObject;
  read_through_ms: number | null;
  added_ms: number;
}

export interface ExtractRow {
  family: string;
  unit: string;
  reading: string;
  code: string;
  content: Json;
  start_ms: number | null;
  end_ms: number | null;
  days: string[];
  items?: string[];
  seq: number;
}

export interface DayUnit {
  family: string;
  unit: string;
  reading: string;
  code: string;
  shown: boolean;
}

export interface EnrichmentRow {
  family: string;
  item: string;
  prompt: string;
  input_hash: string;
  reply_key: string | null;
  reused_from: string | null;
  content: Json;
  state: "done" | "refused" | "given-up";
}

export interface AskRow {
  family: string;
  item: string;
  prompt: string;
  version: number;
  input_hash: string;
  unit: string;
  work_id: string | null;
  at_key: number;
  started: boolean;
  waits: string | null;
  retry_ms: number | null;
  given_up: string | null;
  unhideable: string | null;
  state: "pending" | "done" | "given-up";
}

export const NEWEST = Number.MAX_SAFE_INTEGER;

export interface ItemRoute {
  family: string;
  item: string;
  prompt: string;
  route: string;
  model: string;
}

export interface Ask {
  family: string;
  item: string;
  prompt: string;
  input: readonly Piece[];
  attachments?: { blob: string; media_type: string; drawn?: Drawn[] }[];
  identity?: Json;
  work: string;
  source: string;
  needs?: { effort?: string; timeout_ms?: number };
}

export type AnswerType = "text" | JsonObject;

export interface Prompt {
  version: number;
  type: AnswerType;
  keeps: { version: number; type: AnswerType }[];
  text: string;
  converters?: Readonly<Record<number, (answer: Json) => Json>>;
}

export type Drawn = { placeholder: string; box: { x: number; y: number; width: number; height: number } };

export interface Mark {
  start: number;
  end: number;
  type: DetailType;
  who?: string;
  shown?: string;
}

export type Piece =
  | { text: string }
  | { text: string; free: true; whole?: string; known?: readonly Mark[] }
  | { text: string; is: DetailType; who?: string; shown?: string };

export function piecesText(pieces: readonly { text: string }[]): string {
  return pieces.map((piece) => piece.text).join("");
}

export type Quote = { text: string; quote: true };

export interface Reply {
  key: string;
  model: string;
  text: string;
  value: Json;
  version: number;
  at_ms: number;
  reused_from?: string;
  marks?: readonly Mark[];
  faces?: readonly Drawn[];
}

/** How the home cuts time into civil days: the zone they are counted in and the hour each starts at. */
export interface DaySettings {
  /** The zone days are counted in, an IANA name or a fixed `±HH:MM`. */
  zone: string;
  /** The hour of the wall clock in the zone at which each civil day starts. */
  day_start_hour: number;
}

/** What one copy holds at its source by the UTC month its road dates items by, `YYYY-MM` or `undated`, each month its items and the bytes of their files, null where the road has not reached them yet. */
export type Months = { [month: string]: [items: number, bytes: number | null] };

/** The key of `Months` under which a copy counts the items its source dates with no time. */
export const UNDATED = "undated";
