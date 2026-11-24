import { createHash } from "node:crypto";
import type { Json, JsonObject } from "./types.js";

declare global {
  interface String {
    isWellFormed(): boolean;
    toWellFormed(): string;
  }
}

export class FormatError extends Error {
  constructor(
    readonly reason: string,
    readonly path: string,
  ) {
    super(`${reason} at ${path}`);
    this.name = "FormatError";
  }
}

const ASCII = /^[\x00-\x7f]*$/;

/** The one canonical JSON text of a value, its members sorted by UTF-16 code units and no white space. */
export function canonical(value: Json): string {
  try {
    return write(value);
  } catch (error) {
    if (error instanceof Located) throw new FormatError(error.reason, "$" + error.segments.reverse().map(segment).join(""));
    throw error;
  }
}

class Located {
  segments: (number | string)[] = [];
  constructor(readonly reason: string) {}
}

function write(value: Json): string {
  switch (typeof value) {
    case "string":
      return text(value);
    case "number":
      if (!Number.isFinite(value)) throw new Located(`non-finite number ${value}`);
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object":
      if (value === null) return "null";
      if (Array.isArray(value)) {
        let out = "[";
        for (let index = 0; index < value.length; index++) {
          if (index > 0) out += ",";
          out += within(index, value[index]);
        }
        return out + "]";
      }
      return object(value);
    default:
      throw new Located(`${typeof value} is not a JSON value`);
  }
}

function within(at: number | string, value: Json | undefined): string {
  try {
    if (value === undefined) throw new Located("undefined is not a JSON value");
    return write(value);
  } catch (error) {
    if (error instanceof Located) error.segments.push(at);
    throw error;
  }
}

function object(value: object): string {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Located(`${(value as { constructor?: { name?: string } }).constructor?.name ?? "object"} is not a JSON value`);
  }
  const members = Object.keys(value).sort();
  const record = value as Record<string, Json | undefined>;
  let seen: Set<string> | undefined;
  let out = "{";
  for (let index = 0; index < members.length; index++) {
    const name = members[index]!;
    if (!ASCII.test(name)) {
      if (!name.isWellFormed()) throw located("member name has a lone surrogate", name);
      seen ??= new Set(members.filter((other) => ASCII.test(other)));
      const normal = name.normalize("NFC");
      if (seen.has(normal)) throw located("two member names are equal under NFC", name);
      seen.add(normal);
    }
    if (index > 0) out += ",";
    out += JSON.stringify(name) + ":" + within(name, record[name]);
  }
  return out + "}";
}

function located(reason: string, name: string): Located {
  const error = new Located(reason);
  error.segments.push(name);
  return error;
}

function segment(at: number | string): string {
  if (typeof at === "number") return `[${at}]`;
  return /^[A-Za-z_$][\w$]*$/.test(at) ? `.${at}` : `[${JSON.stringify(at)}]`;
}

function text(value: string): string {
  if (!ASCII.test(value) && !value.isWellFormed()) throw new Located("string has a lone surrogate");
  return JSON.stringify(value);
}

export function wellFormedJson(value: unknown): string {
  return JSON.stringify(value, wellFormedMember);
}

function wellFormedMember(_name: string, member: unknown): unknown {
  return typeof member === "string" ? member.toWellFormed() : member;
}

/** Parses JSON text into a value that has one canonical text, throwing for text whose value has none. */
export function parse(source: string): Json {
  let value: Json;
  try {
    value = JSON.parse(source) as Json;
  } catch (error) {
    throw new FormatError((error as Error).message, "$");
  }
  if (!source.isWellFormed()) throw new FormatError("text has a lone surrogate", "$");
  scan(source);
  return value;
}

const QUOTE = 0x22;
const BACKSLASH = "\\";

function scan(source: string): void {
  const frames: (Set<string> | null)[] = [];
  let expectName = false;
  let backslash = source.indexOf(BACKSLASH);
  const length = source.length;
  let at = 0;
  while (at < length) {
    const code = source.charCodeAt(at);
    if (code === QUOTE) {
      let end: number;
      let escaped = false;
      let from = at + 1;
      for (;;) {
        end = source.indexOf('"', from);
        if (backslash !== -1 && backslash < from) backslash = source.indexOf(BACKSLASH, from);
        if (backslash === -1 || backslash > end) break;
        escaped = true;
        from = backslash + 2;
        backslash = source.indexOf(BACKSLASH, from);
      }
      const frame = frames[frames.length - 1];
      if (expectName && frame) {
        const name = escaped ? (JSON.parse(source.slice(at, end + 1)) as string) : source.slice(at + 1, end);
        if (escaped && !name.isWellFormed()) throw new FormatError("member name has a lone surrogate", "$");
        const key = ASCII.test(name) ? name : name.normalize("NFC");
        if (frame.has(key)) throw new FormatError(`duplicate member name ${JSON.stringify(name)}`, "$");
        frame.add(key);
        expectName = false;
      } else if (escaped && !(JSON.parse(source.slice(at, end + 1)) as string).isWellFormed()) {
        throw new FormatError("string has a lone surrogate", "$");
      }
      at = end + 1;
    } else if (code === 0x7b) {
      frames.push(new Set());
      expectName = true;
      at++;
    } else if (code === 0x5b) {
      frames.push(null);
      expectName = false;
      at++;
    } else if (code === 0x7d || code === 0x5d) {
      frames.pop();
      expectName = false;
      at++;
    } else if (code === 0x2c) {
      expectName = frames[frames.length - 1] != null;
      at++;
    } else if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
      let end = at + 1;
      while (end < length && isNumberChar(source.charCodeAt(end))) end++;
      number(source.slice(at, end));
      at = end;
    } else {
      at++;
    }
  }
}

function isNumberChar(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || code === 0x2e || code === 0x65 || code === 0x45 || code === 0x2b || code === 0x2d;
}

function number(spelled: string): void {
  if (carries(spelled)) return;
  const value = Number(spelled);
  if (!Number.isFinite(value)) throw new FormatError(`number ${spelled} does not fit a 64-bit float`, "$");
  throw new FormatError(`number ${spelled} does not round-trip through a 64-bit float (it reads back as ${String(value)})`, "$");
}

export function carries(spelled: string): boolean {
  const value = Number(spelled);
  if (!Number.isFinite(value)) return false;
  const shortest = String(value);
  return shortest === spelled || decimal(shortest) === decimal(spelled);
}

function decimal(spelled: string): string {
  const negative = spelled.startsWith("-");
  const body = negative ? spelled.slice(1) : spelled;
  const e = body.search(/[eE]/);
  const mantissa = e === -1 ? body : body.slice(0, e);
  let exponent = e === -1 ? 0 : Number.parseInt(body.slice(e + 1), 10);
  const dot = mantissa.indexOf(".");
  const fraction = dot === -1 ? "" : mantissa.slice(dot + 1);
  let digits = (dot === -1 ? mantissa : mantissa.slice(0, dot)) + fraction;
  exponent -= fraction.length;
  digits = digits.replace(/^0+/, "");
  if (digits === "") return "0";
  const trailing = /0+$/.exec(digits);
  if (trailing) {
    exponent += trailing[0].length;
    digits = digits.slice(0, trailing.index);
  }
  return `${negative ? "-" : ""}${digits}e${exponent}`;
}

export function sha256(text: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

export function versionId(kind: string, key: string, content: Json): { id: string; text: string } {
  const text = `{"content":${canonical(content)},"key":${spell(key, "key")},"kind":${spell(kind, "kind")}}`;
  return { id: sha256(text), text };
}

function spell(value: string, name: string): string {
  if (!ASCII.test(value) && !value.isWellFormed()) throw new FormatError("string has a lone surrogate", `$.${name}`);
  return JSON.stringify(value);
}

/** The hash of a value's canonical text, `sha256:` and hex. */
export function digest(value: Json): string {
  return sha256(canonical(value));
}

export function changedPaths(before: Json, after: Json): string[] {
  const paths = new Set<string>();
  diff(before, after, "", paths);
  return [...paths].sort();
}

function diff(before: Json, after: Json, path: string, paths: Set<string>): void {
  if (before === after) return;
  const beforeArray = Array.isArray(before);
  const afterArray = Array.isArray(after);
  if (beforeArray && afterArray) {
    const element = path + "[]";
    const shared = Math.min(before.length, after.length);
    if (before.length !== after.length) paths.add(element);
    for (let index = 0; index < shared; index++) diff(before[index]!, after[index]!, element, paths);
    return;
  }
  if (isObject(before) && isObject(after)) {
    for (const name of Object.keys(before)) {
      const next = path === "" ? name : `${path}.${name}`;
      if (!Object.hasOwn(after, name)) paths.add(next);
      else diff(before[name]!, after[name]!, next, paths);
    }
    for (const name of Object.keys(after)) {
      if (!Object.hasOwn(before, name)) paths.add(path === "" ? name : `${path}.${name}`);
    }
    return;
  }
  paths.add(path === "" ? "$" : path);
}

/** Whether a value is a JSON object, neither null nor a list. */
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
