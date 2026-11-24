import { isObject, type BlobReader, type Delivery, type DeliveryFile, type Instant, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { deliveredLines } from "./lanes.js";
import { lineText } from "./lines.js";
import { tryInstant } from "./delivery.js";
import { readJson, utf8 } from "./json.js";
import { each, refuse } from "./refused.js";

export const PARTS = "parts.json";
export const AGENT_TURN = "agent-turn";

export interface Part {
  file: string;
  from_byte: number;
  from_line: number;
  lines: number;
  delivered: DeliveryFile;
}

export interface SessionLine {
  part: Part;
  line: number;
  text: string;
  value: JsonObject;
  locator: string;
  files: ReadonlyMap<string, string>;
}

export interface SessionLogs {
  log: RegExp;
  file?: RegExp;
  started?: (line: SessionLine) => boolean;
}

export async function* sessionRows(delivery: Delivery, files: BlobReader, logs: SessionLogs, derive: (line: SessionLine) => Iterable<ReaderOutput>): AsyncGenerator<ReaderOutput> {
  const { list, wholes } = index(delivery, files, logs);
  yield* each(list, (part) => part.file, async function* (part) {
    const read = ({ bytes, line: at }: { bytes: Buffer; line: number }): SessionLine => {
      const line = part.from_line - 1 + at;
      const locator = `${part.file} line ${line}`;
      const text = lineText(bytes, locator);
      const value = readJson(text, locator);
      if (!isObject(value)) refuse(`${locator} is not one JSON object`);
      return { part, line, text, value, locator, files: wholes };
    };
    if (part.from_line === 1 && logs.started !== undefined) {
      for await (const line of deliveredLines(files, part.delivered)) if (logs.started(read(line))) break;
    }
    let count = 0;
    yield* each(deliveredLines(files, part.delivered), ({ line: at }) => `${part.file} line ${part.from_line - 1 + at}`, (line) => {
      count = line.line;
      return derive(read(line));
    });
    if (count !== part.lines) refuse(`${part.file} holds ${count} lines from line ${part.from_line}; ${PARTS} states ${part.lines}`);
  });
}

function index(delivery: Delivery, files: BlobReader, logs: SessionLogs): { list: Part[]; wholes: Map<string, string> } {
  const byPath = new Map(delivery.files.map((file) => [file.path, file]));
  const manifest = byPath.get(PARTS) ?? refuse(`the delivery carries no ${PARTS}`);
  const stated = readJson(utf8(files.bytes(manifest.blob), PARTS), PARTS);
  if (!isObject(stated) || !Array.isArray(stated.parts) || !Array.isArray(stated.files) || Object.keys(stated).length !== 2) {
    refuse(`${PARTS} must be exactly {"parts":[…],"files":[…]}`);
  }
  const name = logs.log;
  const seen = new Set<string>();
  const list = stated.parts.map((entry, index): Part => {
    const at = `${PARTS} parts[${index}]`;
    if (!isObject(entry) || Object.keys(entry).sort().join(",") !== "file,from_byte,from_line,lines") refuse(`${at} must state exactly file, from_byte, from_line and lines`);
    const { file, from_byte, from_line, lines } = entry;
    if (typeof file !== "string" || !name.test(file)) refuse(`${at} names ${JSON.stringify(file)}, which is not a session log`);
    if (seen.has(file)) refuse(`${at} names ${file} a second time`);
    seen.add(file);
    if (!whole(from_byte, 0) || !whole(from_line, 1) || !whole(lines, 1)) refuse(`${at} must state whole numbers: from_byte from 0, from_line and lines from 1`);
    if ((from_byte === 0) !== (from_line === 1)) refuse(`${at} starts at byte ${from_byte} but line ${from_line}`);
    const delivered = byPath.get(file) ?? refuse(`${at} names ${file}, which the delivery does not carry`);
    return { file, from_byte, from_line, lines, delivered };
  });
  const wholes = new Map<string, string>();
  for (const [index, entry] of stated.files.entries()) {
    const at = `${PARTS} files[${index}]`;
    if (!isObject(entry) || Object.keys(entry).sort().join(",") !== "bytes,file,sha256") refuse(`${at} must state exactly file, sha256 and bytes`);
    const { file, sha256, bytes } = entry;
    if (typeof file !== "string" || logs.file === undefined || !logs.file.test(file) || file.split("/").includes("..")) {
      refuse(`${at} names ${JSON.stringify(file)}, which is not a session's file`);
    }
    if (seen.has(file) || wholes.has(file)) refuse(`${at} names ${file} a second time`);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256) || !whole(bytes, 0)) refuse(`${at} must state a hex sha256 and whole bytes`);
    const carried = byPath.get(file);
    if (carried !== undefined && (carried.blob !== `sha256:${sha256}` || carried.size !== bytes)) refuse(`${file} is not the bytes ${PARTS} states`);
    wholes.set(file, `sha256:${sha256}`);
  }
  for (const path of byPath.keys()) {
    if (path !== PARTS && !seen.has(path) && !wholes.has(path)) refuse(`${path} is carried but ${PARTS} states no part of it`);
  }
  return { list, wholes };
}

function whole(value: unknown, least: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= least;
}

export function lineTime(value: unknown): Instant | undefined {
  return typeof value === "string" ? tryInstant(value, "rfc3339") : undefined;
}
