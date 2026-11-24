import { carries, FormatError, parse, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { refuse } from "./refused.js";
import { BYTES_LIMIT } from "./zip.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Parses JSON text, keeping a number that would lose digits as its text, and refuses text that is not JSON under the name given. */
export function readJson(text: string, where: string): Json {
  try {
    return parse(text);
  } catch (error) {
    if (!(error instanceof FormatError)) throw error;
    if (!/^number /u.test(error.reason)) refuse(`${where}: ${error.message}`);
  }
  try {
    return parse(quoteLossyNumbers(text));
  } catch (error) {
    refuse(`${where}: ${(error as Error).message}`);
  }
}

/** Decodes bytes as UTF-8, refusing bytes that are not UTF-8 under the name given. */
export function utf8(bytes: Buffer, where: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    refuse(`${where} is not UTF-8`);
  }
}

const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const COMMA = 0x2c;
const COLON = 0x3a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

export interface ElementLimits {
  readonly bytes: number;
  readonly depth: number;
}

export const ELEMENT_LIMITS: ElementLimits = { bytes: BYTES_LIMIT, depth: 1_000 };

/** One value found in a streamed JSON file, read only when asked so that a value too large or of the wrong shape refuses alone. */
export interface JsonPart {
  /** Where the value sits, as the file's name and its member names and indexes. */
  readonly where: string;
  /** The value's bytes as the file holds them, or Refused when it holds more than the limit or is not the shape its path steps into. */
  read(): Buffer;
}

/** One value `jsonAt` found, with the path that matched it. */
export interface JsonAtPart extends JsonPart {
  /** The path that matched it, as it was given. */
  readonly path: string;
  /** Its place in the file, as member names and array indexes from the top. */
  readonly at: readonly (string | number)[];
}

/** The elements of a JSON file's top-level array, streamed from its chunks one at a time. */
export function jsonElements(chunks: AsyncIterable<Buffer> | Iterable<Buffer>, where: string, limits = ELEMENT_LIMITS): AsyncGenerator<JsonAtPart> {
  return jsonAt(chunks, where, ["[*]"], limits);
}

export interface JsonPath {
  readonly path: string;
  readonly steps: readonly (string | null)[];
}

interface Frame {
  readonly kind: "object" | "array";
  readonly at: readonly (string | number)[];
  readonly live: readonly JsonPath[];
  state: "open" | "next" | "colon" | "value" | "comma";
  index: number;
  name: string;
  readonly names: Set<string>;
}

interface Scanned {
  readonly path: JsonPath | null;
  readonly at: readonly (string | number)[];
  readonly container: boolean;
  depth: number;
  inString: boolean;
  escaped: boolean;
  pieces: Buffer[];
  kept: number;
  past: string | null;
}

/** The values a streamed JSON file holds at the paths given, each written as member names joined by dots with `[*]` for every element of an array, handed one at a time as each ends. */
export async function* jsonAt(
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>, where: string, paths: readonly string[], limits = ELEMENT_LIMITS,
): AsyncGenerator<JsonAtPart> {
  const compiled = paths.map(jsonPath);
  for (const outer of compiled) {
    for (const inner of compiled) {
      if (outer !== inner && outer.steps.length <= inner.steps.length && outer.steps.every((step, index) => step === inner.steps[index])) {
        throw new Error(`jsonAt: ${JSON.stringify(outer.path)} holds ${JSON.stringify(inner.path)}: a value is handed whole or its values are, never both`);
      }
    }
  }
  const stack: Frame[] = [];
  let done = false;
  let handed = 0;
  const broken = (why: string): never => refuse(`${where}: ${why}, after ${handed} value${handed === 1 ? "" : "s"}`);
  const place = (at: readonly (string | number)[]): string =>
    at.reduce<string>((text, step, index) => (typeof step === "number" ? `${text}[${step}]` : `${text}${index === 0 ? " " : "."}${step}`), where);
  let value: Scanned | null = null;
  let name: { pieces: Buffer[]; kept: number; escaped: boolean } | null = null;
  const tooLarge = `holds more than the ${limits.bytes} bytes one value is read in`;
  const ended = (scanned: Scanned, tail: Buffer): JsonAtPart | null => {
    value = null;
    if (scanned.path === null) return null;
    const said = place(scanned.at);
    const past = scanned.past ?? (scanned.kept + tail.length > limits.bytes ? tooLarge : null);
    const bytes = past === null ? finish(scanned.pieces, tail) : null;
    handed++;
    return { where: said, path: scanned.path.path, at: scanned.at, read: () => bytes ?? refuse(`${said} ${past}`) };
  };
  const begin = (at: readonly (string | number)[], live: readonly JsonPath[], byte: number): JsonAtPart | null => {
    if (byte === COMMA || byte === CLOSE_BRACE || byte === CLOSE_BRACKET || byte === COLON) broken(`a ${String.fromCharCode(byte)} where a value is owed`);
    const depth = at.length;
    const here = depth === 0 ? live : live.filter((path) => (path.steps[depth - 1] === null ? typeof at[depth - 1] === "number" : path.steps[depth - 1] === at[depth - 1]));
    const whole = here.find((path) => path.steps.length === depth);
    const container = byte === OPEN_BRACE || byte === OPEN_BRACKET;
    const scan = (path: JsonPath | null): void => {
      value = { path, at, container, depth: container ? 1 : 0, inString: byte === QUOTE, escaped: false, pieces: [], kept: 0, past: null };
    };
    const below = here.filter((path) => path.steps.length > depth);
    if (whole !== undefined || below.length === 0) {
      scan(whole ?? null);
      return null;
    }
    const wanted = new Set(below.map((path) => (path.steps[depth] === null ? "array" : "object")));
    const kind = byte === OPEN_BRACE ? "object" : byte === OPEN_BRACKET ? "array" : null;
    if (kind !== null && wanted.has(kind)) {
      stack.push({ kind, at, live: below, state: "open", index: 0, name: "", names: new Set() });
      return null;
    }
    if (depth === 0) broken(`the top-level value is no ${[...wanted].join(" or ")}, as ${below[0]!.path} steps into`);
    scan(null);
    const said = place(at);
    handed++;
    return { where: said, path: below[0]!.path, at, read: () => refuse(`${said} is no ${[...wanted].join(" or ")}, as ${below[0]!.path} steps into`) };
  };
  const close = (): void => {
    stack.pop();
    if (stack.length === 0) done = true;
  };
  for await (const chunk of chunks) {
    let from = value !== null || name !== null ? 0 : -1;
    for (let offset = 0; offset < chunk.length; offset++) {
      const byte = chunk[offset]!;
      const scanned = value as Scanned | null;
      if (scanned !== null) {
        if (scanned.inString) {
          if (scanned.escaped) scanned.escaped = false;
          else if (byte === BACKSLASH) scanned.escaped = true;
          else if (byte === QUOTE) scanned.inString = false;
          continue;
        }
        if (byte === QUOTE) {
          scanned.inString = true;
          continue;
        }
        if (scanned.container) {
          if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
            if (++scanned.depth > limits.depth && scanned.path !== null && scanned.past === null) {
              scanned.past = `nests deeper than the ${limits.depth} levels one value is read in`;
              scanned.pieces = [];
            }
          } else if ((byte === CLOSE_BRACE || byte === CLOSE_BRACKET) && --scanned.depth === 0) {
            const part = ended(scanned, chunk.subarray(from, offset + 1));
            if (part !== null) yield part;
          }
          continue;
        }
        if (byte === OPEN_BRACE || byte === OPEN_BRACKET) broken("a bracket inside a scalar value");
        if (!isSpace(byte) && byte !== COMMA && byte !== CLOSE_BRACKET && byte !== CLOSE_BRACE) continue;
        const part = ended(scanned, chunk.subarray(from, offset));
        if (part !== null) yield part;
      }
      if (name !== null) {
        if (name.escaped) name.escaped = false;
        else if (byte === BACKSLASH) name.escaped = true;
        else if (byte === QUOTE) {
          const bytes = finish(name.pieces, chunk.subarray(from, offset + 1));
          const frame = stack.at(-1)!;
          const named = memberName(bytes) ?? broken(`a member name that does not read in ${place(frame.at)}`);
          const key = named.normalize("NFC");
          if (frame.names.has(key)) broken(`a member named ${JSON.stringify(named)} twice in ${place(frame.at)}`);
          frame.names.add(key);
          frame.name = named;
          frame.state = "colon";
          name = null;
        }
        continue;
      }
      if (isSpace(byte)) continue;
      const frame = stack.at(-1);
      let part: JsonAtPart | null = null;
      if (frame === undefined) {
        if (done) broken("bytes follow the top-level value");
        part = begin([], compiled, byte);
      } else if (frame.kind === "object") {
        if ((frame.state === "open" || frame.state === "comma") && byte === CLOSE_BRACE) close();
        else if ((frame.state === "open" || frame.state === "next") && byte === QUOTE) name = { pieces: [], kept: 0, escaped: false };
        else if (frame.state === "colon" && byte === COLON) frame.state = "value";
        else if (frame.state === "comma" && byte === COMMA) frame.state = "next";
        else if (frame.state === "value") {
          frame.state = "comma";
          part = begin([...frame.at, frame.name], frame.live, byte);
        } else {
          broken(frame.state === "colon" ? `a member name with no colon after it in ${place(frame.at)}` : frame.state === "comma" ? `two members with no comma between them in ${place(frame.at)}` : `a member owed in ${place(frame.at)}`);
        }
      } else if ((frame.state === "open" || frame.state === "comma") && byte === CLOSE_BRACKET) {
        close();
      } else if (frame.state === "comma") {
        if (byte !== COMMA) broken(`two elements with no comma between them in ${place(frame.at)}`);
        frame.state = "value";
      } else {
        frame.state = "comma";
        part = begin([...frame.at, frame.index++], frame.live, byte);
      }
      if (part !== null) yield part;
      if (value !== null || name !== null) from = offset;
    }
    const open = value as Scanned | null;
    if (open !== null && open.path !== null && open.past === null) {
      const rest = chunk.subarray(from);
      if (open.kept + rest.length > limits.bytes) {
        open.past = tooLarge;
        open.pieces = [];
      } else {
        open.pieces.push(Buffer.from(rest));
        open.kept += rest.length;
      }
    }
    if (name !== null) {
      const rest = chunk.subarray(from);
      if (name.kept + rest.length > limits.bytes) broken(`a member name past the ${limits.bytes} bytes one is read in`);
      name.pieces.push(Buffer.from(rest));
      name.kept += rest.length;
    }
  }
  if (!done) broken(stack.length === 0 ? "the file holds no JSON" : `the top-level ${stack[0]!.kind} is not closed`);
}

export function jsonPath(path: string): JsonPath {
  const steps: (string | null)[] = [];
  path.split(".").forEach((segment, index) => {
    const match = /^([^.[\]]*)((?:\[\*\])*)$/u.exec(segment);
    if (match === null || (match[1] === "" && (index > 0 || match[2] === ""))) {
      throw new Error(`jsonAt: ${JSON.stringify(path)} is no path: member names joined by dots, each with any [*] after it (chats.list[*].messages[*])`);
    }
    if (match[1] !== "") steps.push(match[1]!);
    for (let every = 0; every < match[2]!.length / 3; every++) steps.push(null);
  });
  return { path, steps };
}

function memberName(bytes: Buffer): string | undefined {
  try {
    return parse(UTF8.decode(bytes)) as string;
  } catch {
    return undefined;
  }
}

function finish(pieces: Buffer[], tail: Buffer): Buffer {
  const bytes = pieces.length === 0 ? tail : Buffer.concat([...pieces, tail]);
  let end = bytes.length;
  while (end > 0 && isSpace(bytes[end - 1]!)) end--;
  return bytes.subarray(0, end);
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

function quoteLossyNumbers(text: string): string {
  let out = "";
  let copied = 0;
  let at = 0;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === 0x22) {
      at++;
      while (at < text.length) {
        const inner = text.charCodeAt(at);
        if (inner === 0x5c) at += 2;
        else if (inner === 0x22) break;
        else at++;
      }
      at++;
    } else if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      let end = at + 1;
      while (end < text.length && /[0-9.eE+-]/u.test(text[end]!)) end++;
      const spelled = text.slice(at, end);
      if (!carries(spelled)) {
        out += `${text.slice(copied, at)}"${spelled}"`;
        copied = end;
      }
      at = end;
    } else {
      at++;
    }
  }
  return out + text.slice(copied);
}

/** A type as it reads made only of JSON's parts, readonly throughout, with every function in it as never so that a value holding one does not fit. */
export type JsonShaped<T> = T extends string | number | boolean | null ? T
  : T extends readonly (infer Element)[] ? readonly JsonShaped<Element>[]
  : T extends (...args: never[]) => unknown ? never
  : T extends object ? { readonly [Member in keyof T]: JsonShaped<T[Member]> }
  : never;

/** The value given, typed as Json, or as a JsonObject for an object, once its type is made only of JSON's parts. */
export function asJson<T>(value: T & JsonShaped<T>): T extends readonly unknown[] ? Json : T extends object ? JsonObject : Json {
  return value as never;
}
