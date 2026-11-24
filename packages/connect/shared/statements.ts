import {
  addDays, isObject, sourceName, TimeError, type Delivery, type DeliveryFile, type Guard, type Instant, type Json, type JsonObject, type ReaderOutput,
} from "@lifestreamprotocol/core";
import type { Reader } from "../seams.js";
import { instantOf, SOURCE_TIME_FACTS } from "./delivery.js";
import { parseLine } from "./lanes.js";
import { LineSplitter, lineText } from "./lines.js";
import { Refused, refusedFile, refuse } from "./refused.js";

export const STATEMENTS_FILE = "statements.ndjson";

export interface StatementKind {
  readonly guard: Guard;
  readonly key: (key: string, content: Json | null) => string | undefined;
  readonly time?: string;
  readonly ends?: string;
  readonly blobs?: (content: JsonObject) => Readonly<Record<string, string | null>>;
  readonly picture?: (content: JsonObject, pictures: Pictures) => string | undefined;
}

export interface Pictures {
  carried(hash: string): { readonly size: number; bytes(): Buffer } | undefined;
  staged?(hash: string): { readonly size: number; head(length: number): Buffer } | undefined;
  held(hash: string): boolean;
}

export interface OwnerReader extends Reader {
  readonly statements: Readonly<Record<string, StatementKind>>;
}

/** Whether a value is an object holding every required member and no member but the required and optional ones. */
export function exact(value: Json | undefined, required: readonly string[], optional: readonly string[] = []): value is JsonObject {
  return isObject(value) && required.every((member) => Object.hasOwn(value, member)) && Object.keys(value).every((member) => required.includes(member) || optional.includes(member));
}

export function isCalendarDate(value: Json | undefined): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  try {
    return addDays(value, 0) === value;
  } catch (error) {
    if (error instanceof TimeError) return false;
    throw error;
  }
}

export function ownerConnector(name: string, kinds: Readonly<Record<string, StatementKind>>): OwnerReader {
  return {
    name,
    statements: kinds,
    kinds: Object.fromEntries(Object.entries(kinds).map(([kind, { guard }]) => [kind, guard])),
    read: async function* (delivery, files) {
      yield* readStatements(delivery, (file) => files.bytes(file.blob), kinds);
    },
  };
}

export function readStatements(delivery: Delivery, bytes: (file: DeliveryFile) => Buffer, kinds: Readonly<Record<string, StatementKind>>): ReaderOutput[] {
  const [file, ...more] = delivery.files;
  if (file === undefined || more.length > 0 || file.path !== STATEMENTS_FILE) {
    refuse(`an owner-statements delivery holds one ${STATEMENTS_FILE}, not ${JSON.stringify(delivery.files.map((each) => each.path))}`);
  }
  const timed = SOURCE_TIME_FACTS.filter((fact) => Object.hasOwn(delivery.facts, fact));
  if (timed.length > 0) refuse(`${STATEMENTS_FILE} is stated at its delivery's fetched_at; its facts state ${timed.join(", ")}`);
  const stated = delivery.facts.device;
  if (stated !== undefined && (typeof stated !== "string" || stated.length === 0)) refuse("facts.device must name the unit of the pass that sealed it");
  const device = stated ?? sourceName(delivery.source).copy;
  const splitter = new LineSplitter();
  const lines = splitter.push(bytes(file));
  const last = splitter.end();
  if (last !== undefined) lines.push(last);
  if (lines.length === 0) refuse(`${STATEMENTS_FILE} states nothing`);
  return lines.flatMap((line, index) => {
    const locator = `${STATEMENTS_FILE}:${index + 1}`;
    try {
      return [statementOf(line, `${STATEMENTS_FILE} line ${index + 1}`, locator, kinds, device)];
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return [{ ...refusedFile(locator, error.message), member: locator }];
    }
  });
}

function statementOf(line: Buffer, at: string, locator: string, kinds: Readonly<Record<string, StatementKind>>, device: string): ReaderOutput {
  const value = parseLine(lineText(line, at), at);
  if (typeof value.kind !== "string" || typeof value.key !== "string") return refuse(`${at} must state a kind and a key`);
  const { kind, key } = value;
  const rule = Object.hasOwn(kinds, kind) ? kinds[kind]! : refuse(`${at} states kind ${JSON.stringify(kind)}; this source states ${Object.keys(kinds).join(", ")}`);
  const members = Object.keys(value).sort().join(",");
  const gone = members === "gone,key,kind" && value.gone === true;
  if (!gone && members !== "content,key,kind") return refuse(`${at} must hold exactly kind, key and content, or kind, key and gone: true`);
  const content = gone ? null : value.content!;
  const keyed = rule.key(key, content);
  const violations = [...(gone ? [] : rule.guard(content!)), ...(keyed === undefined ? [] : [keyed])];
  if (violations.length > 0) return refuse(`${at}: ${violations.join("; ")}`);
  if (gone) return { kind, key, content: null, gone: true, device, locator };
  const named = rule.blobs?.(content as JsonObject);
  const media = named === undefined ? [] : Object.entries(named).filter((entry): entry is [string, string] => entry[1] !== null);
  return {
    kind, key, content: content!, device, locator,
    ...(rule.time === undefined ? {} : { time: { ...statedTime(content!, rule.time, at), ...(rule.ends === undefined ? {} : { end_ms: statedTime(content!, rule.ends, at).start_ms }) } }),
    ...(named === undefined ? {} : { blobs: Object.keys(named), ...(media.length === 0 ? {} : { media: Object.fromEntries(media) }) }),
  };
}

function statedTime(content: Json, member: string, at: string): Instant {
  const value = isObject(content) ? content[member] : undefined;
  if (typeof value !== "number") return refuse(`${at}: ${member} must be ms since the epoch`);
  return instantOf(value, "unix-ms", `${at}: ${member}`);
}
