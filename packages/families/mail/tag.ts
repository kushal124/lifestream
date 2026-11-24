import { render, textHead, type Json, type Piece } from "@lifestreamprotocol/core";
import { statedPrompt } from "../shared/prompts.js";
import { detail, free, said, sayJoined } from "../shared/said.js";

export const MAIL_TAG = "mail-tag";
export const MAIL_TAG_PROMPT = statedPrompt(new URL("./prompts/", import.meta.url), MAIL_TAG);
export const MAIL_TAG_ZONE = { name: "Asia/Kolkata", label: "IST" } as const;
export const MAIL_TAG_BODY_CAP = 4_000;
const HEADER_CAP = 256 * 1024;

export const MAIL_TAG_KINDS = [
  "transaction", "order", "travel", "bill", "subscription", "security",
  "invite", "notice", "newsletter", "promotion", "document", "other",
] as const;

export interface MailTag {
  [member: string]: Json;
  from: "person" | "machine";
  kind: (typeof MAIL_TAG_KINDS)[number];
  topic: string;
  provider: string | null;
  amount: string | null;
  reference: string | null;
  gist: string;
}

export function tagPack(bytes: Uint8Array, at_ms: number, exported: boolean): Piece[] | null {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mail = readMailV1(exported ? unexported(raw) : raw);
  if (mail.from === null) return null;
  const body = textHead(mail.text, MAIL_TAG_BODY_CAP);
  const omitted = mail.text.length - body.length;
  const attachments = mail.attachments.map((item) => said`${item.name === null ? "unnamed" : free(item.name)} (${item.media_type}, ${item.bytes} bytes)`);
  return sayJoined([
    "MAIL",
    said`From: ${address(mail.from)}`,
    said`To: ${mail.to.length === 0 ? "none" : sayJoined(mail.to.map(address), ", ")}`,
    said`Subject: ${free(mail.subject)}`,
    `Time: ${wallClock(at_ms)} ${MAIL_TAG_ZONE.label}`,
    said`Attachments: ${attachments.length === 0 ? "none" : sayJoined(attachments, ", ")}`,
    ...(mail.calendar === null ? [] : [said`Calendar: ${calendarLine(mail.calendar)}`]),
    "",
    "BODY",
    said`${free(body, omitted === 0 ? undefined : textHead(mail.text, 2 * MAIL_TAG_BODY_CAP))}${omitted === 0 ? "" : `\n[... ${omitted} characters omitted ...]`}`,
  ], "\n");
}

export function tagInput(pack: readonly Piece[]): Piece[] {
  return said`\n\n${pack}`;
}

export function tagRefusal(value: Json): string | null {
  const answer = value as MailTag;
  if (answer.topic.trim() === "") return "topic must be non-empty";
  if (answer.topic.trim().split(/\s+/u).length > 3) return "topic must be at most three words";
  if (answer.gist.trim() === "") return "gist must be non-empty";
  for (const member of ["provider", "amount", "reference"] as const) {
    if (answer[member]?.trim() === "") return `${member} must be a non-empty string or null`;
  }
  const tag = tagOf(value);
  const phrase = pipelinePhrase(tag.gist);
  if (phrase !== null) return `the gist uses pipeline language: ${JSON.stringify(phrase)}`;
  const secret = secretIn(JSON.stringify(tag));
  if (secret !== null) return `the tag reproduces ${secret}`;
  return null;
}

export function tagOf(value: Json): MailTag {
  const answer = value as MailTag;
  return {
    from: answer.from, kind: answer.kind, topic: answer.topic.trim(),
    provider: answer.provider, amount: answer.amount, reference: answer.reference, gist: answer.gist.trim(),
  };
}


function unexported(bytes: Buffer): Buffer {
  return Buffer.from(bytes.toString("latin1").replace(/(\r?\n)\r?\n$/u, "$1").replace(/^>(>*From )/gmu, "$1"), "latin1");
}

interface Address { address: string; name: string | null }
interface Attachment { name: string | null; media_type: string; bytes: number }
interface Invitation {
  method: string | null; summary: string | null; start: string | null; end: string | null;
  organizer: string | null; attendees: number;
}
interface Parts { plain: string[]; html: string[]; calendars: string[]; attachments: Attachment[] }

function readMailV1(bytes: Buffer) {
  const headers = readHeaders(split(bytes).header.toString("latin1"));
  const first = (name: string) => headers.get(name)?.[0] ?? null;
  const parts: Parts = { plain: [], html: [], calendars: [], attachments: [] };
  collect(bytes, "text/plain", false, parts, 0);
  const plain = longest(parts.plain.filter((part) => part.trim().length > 0));
  const html = longest(parts.html.filter((part) => part.trim().length > 0));
  const text = plain === undefined ? htmlPartToText(html ?? "")
    : /<\/?[a-z][\s\S]*>/iu.test(plain) ? htmlToText(plain) : collapse(plain);
  return {
    from: readAddresses(first("from") ?? "")[0] ?? null,
    to: readAddresses(first("to") ?? ""),
    subject: decodeWords(first("subject") ?? "").trim(),
    text,
    attachments: parts.attachments,
    calendar: parts.calendars.map(readInvitation).find((value) => value !== null) ?? null,
  };
}

function collect(bytes: Buffer, inherited: string, nested: boolean, into: Parts, depth: number): void {
  if (depth > 64) return;
  const { header, body, terminated } = split(bytes, nested);
  const headers = readHeaders(header.toString("latin1"));
  const first = (name: string) => headers.get(name)?.[0] ?? null;
  const contentType = first("content-type") ?? (nested && !terminated ? "application/octet-stream" : inherited);
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  const disposition = first("content-disposition") ?? "";
  const filename = parameter(disposition, "filename") ?? parameter(contentType, "name");
  if (mediaType.startsWith("multipart/")) {
    const boundary = parameter(contentType, "boundary");
    if (boundary === null || boundary.length === 0) return;
    for (const part of splitMultipart(body, boundary)) collect(part, "text/plain", true, into, depth + 1);
    return;
  }
  const decoded = transferDecode(body, first("content-transfer-encoding") ?? "");
  const charset = parameter(contentType, "charset") ?? "utf-8";
  const attached = filename !== null || /\battachment\b/iu.test(disposition);
  if (mediaType === "text/plain" && !attached) into.plain.push(decodeBytes(decoded, charset));
  else if (mediaType === "text/html" && !attached) into.html.push(decodeBytes(decoded, charset));
  else if (mediaType === "text/calendar") into.calendars.push(decodeBytes(decoded, charset));
  if (attached) into.attachments.push({ name: filename === null ? null : decodeWords(filename), media_type: mediaType, bytes: decoded.byteLength });
}

function split(bytes: Buffer, missingTerminatorIsBody = false): { header: Buffer; body: Buffer; terminated: boolean } {
  let index = bytes.indexOf("\r\n\r\n");
  let width = 4;
  const lf = bytes.indexOf("\n\n");
  if (index < 0 || (lf >= 0 && lf < index)) {
    index = lf;
    width = 2;
  }
  if (index < 0) {
    if (missingTerminatorIsBody) return { header: Buffer.alloc(0), body: bytes, terminated: false };
    if (bytes.byteLength > HEADER_CAP) throw new TypeError("mail headers exceed 256 KB");
    return { header: bytes, body: Buffer.alloc(0), terminated: false };
  }
  if (index > HEADER_CAP) throw new TypeError("mail headers exceed 256 KB");
  return { header: bytes.subarray(0, index), body: bytes.subarray(index + width), terminated: true };
}

function readHeaders(text: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  const add = (line: string) => {
    const colon = line.indexOf(":");
    if (colon <= 0) return;
    const name = line.slice(0, colon).trim().toLowerCase();
    headers.set(name, [...headers.get(name) ?? [], line.slice(colon + 1).trim()]);
  };
  let current = "";
  for (const line of text.replace(/\r\n/gu, "\n").split("\n")) {
    if (/^[ \t]/u.test(line) && current.length > 0) {
      current += ` ${line.trim()}`;
      continue;
    }
    if (current.length > 0) add(current);
    current = line;
  }
  if (current.length > 0) add(current);
  return headers;
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString("latin1");
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const marks = [...text.matchAll(new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, "gu"))];
  const parts: Buffer[] = [];
  for (let index = 0; index < marks.length - 1; index++) {
    const mark = marks[index]!;
    if (mark[1] === "--") break;
    parts.push(Buffer.from(text.slice(mark.index! + mark[0].length, marks[index + 1]!.index!), "latin1"));
  }
  return parts;
}

function transferDecode(body: Buffer, encoding: string): Buffer {
  if (/^base64$/iu.test(encoding.trim())) return Buffer.from(body.toString("ascii").replace(/\s/gu, ""), "base64");
  if (/^quoted-printable$/iu.test(encoding.trim())) {
    return Buffer.from(body.toString("latin1").replace(/=\r?\n/gu, "")
      .replace(/=([0-9a-f]{2})/giu, (_hex, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
  }
  return body;
}

function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.trim().replace(/["']/gu, "").toLowerCase() || "utf-8", { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function decodeWords(value: string): string {
  const words = [...value.matchAll(/=\?([^?]+)\?([bq])\?([^?]*)\?=/giu)];
  if (words.length === 0) return value;
  let output = "";
  let cursor = 0;
  for (let index = 0; index < words.length;) {
    const word = words[index]!;
    const gap = value.slice(cursor, word.index);
    if (index === 0 || !/^\s*$/u.test(gap)) output += gap;
    if (word[2]!.toLowerCase() === "b") {
      const charset = word[1]!;
      const chunks: Buffer[] = [];
      let last = word;
      let next = index;
      while (next < words.length) {
        const candidate = words[next]!;
        const between = next === index ? "" : value.slice(last.index! + last[0].length, candidate.index);
        if (next !== index && (!/^\s*$/u.test(between) || candidate[2]!.toLowerCase() !== "b" ||
            candidate[1]!.toLowerCase() !== charset.toLowerCase())) break;
        chunks.push(Buffer.from(candidate[3]!.replace(/\s/gu, ""), "base64"));
        last = candidate;
        next++;
      }
      output += decodeBytes(Buffer.concat(chunks), charset);
      cursor = last.index! + last[0].length;
      index = next;
      continue;
    }
    const bytes = Buffer.from(word[3]!.replace(/_/gu, " ").replace(/=([0-9a-f]{2})/giu,
      (_hex, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
    output += decodeBytes(bytes, word[1]!);
    cursor = word.index! + word[0].length;
    index++;
  }
  return output + value.slice(cursor);
}

function readAddresses(value: string): Address[] {
  return splitAddresses(decodeWords(value)).flatMap((raw): Address[] => {
    const text = raw.trim();
    if (text.length === 0) return [];
    const bracketed = [...text.matchAll(/<\s*((?:mailto:)?[^@\s<>]+@[^@\s<>]+)\s*>/giu)].at(-1);
    if (bracketed !== undefined) {
      const address = plainAddress(bracketed[1]!);
      if (address === null) return [];
      const opening = text.indexOf("<");
      return [{ address, name: displayName(opening < 0 ? "" : text.slice(0, opening)) }];
    }
    const candidate = text.replace(/^.*?:\s*(?=[^@\s()<>]+@)/u, "");
    const bare = /(?:mailto:)?[^@\s()<>]+@[^@\s()<>]+/iu.exec(candidate);
    const address = bare === null ? null : plainAddress(bare[0]);
    if (bare === null || address === null) return [];
    const comment = /^\(([^()]*)\)$/u.exec(candidate.slice(bare.index + bare[0].length).trim());
    return [{ address, name: displayName(comment?.[1] ?? candidate.slice(0, bare.index)) }];
  });
}

function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  let angle = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
    else if (!quoted && character === "<") angle++;
    else if (!quoted && character === ">") angle = Math.max(0, angle - 1);
    else if (!quoted && angle === 0 && character === ",") {
      out.push(value.slice(start, index));
      start = index + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

function plainAddress(value: string): string | null {
  const address = value.trim().replace(/^mailto:/iu, "").toLowerCase();
  return /^[^@\s<>]+@[^@\s<>]+$/u.test(address) ? address : null;
}

function displayName(value: string): string | null {
  const name = value.trim().replace(/^"|"$/gu, "").trim();
  return name.length === 0 ? null : name;
}

function parameter(value: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "iu").exec(value);
  return match?.[1] ?? match?.[2] ?? null;
}

function htmlPartToText(value: string): string {
  const text = htmlToText(value);
  return /&(?:#\d+|#x[0-9a-f]+|amp|apos|gt|lt|nbsp|quot);/iu.test(text) ? collapse(decodeEntities(text)) : text;
}

function htmlToText(value: string): string {
  const block = "address|article|aside|blockquote|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul";
  return decodeEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(new RegExp(`</?(?:${block})\\b[^>]*>`, "giu"), "\n")
    .replace(/<[^>]+>/gu, " "))
    .replace(/\r/gu, "")
    .replace(/[\t ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{2,}/gu, "\n")
    .trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (whole, decimal?: string, hex?: string, name?: string) => {
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : hex !== undefined ? Number.parseInt(hex, 16) : undefined;
    if (code === undefined) return named[name!.toLowerCase()] ?? whole;
    try {
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

function collapse(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/[\t ]+/gu, " ").replace(/ *\n */gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function longest(values: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const value of values) if (best === undefined || value.trim().length > best.trim().length) best = value;
  return best;
}

function readInvitation(calendar: string): Invitation | null {
  const normalized = calendar.replace(/\r?\n/gu, "\r\n");
  const match = /BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT\r\n/iu.exec(normalized);
  if (match === null) return null;
  const event = readVevent(match[0]);
  if (event === null) return null;
  const property = (name: string) => event.find((item) => item.name === name)?.value ?? null;
  const summary = property("SUMMARY");
  const organizer = property("ORGANIZER");
  return {
    method: /^METHOD(?:;[^:]*)?:(.*)$/imu.exec(normalized)?.[1]?.trim().toUpperCase() ?? null,
    summary: summary === null ? null : unescapeText(summary),
    start: property("DTSTART"),
    end: property("DTEND"),
    organizer: organizer === null ? null : organizer.replace(/^mailto:/iu, "").toLowerCase(),
    attendees: event.filter((item) => item.name === "ATTENDEE").length,
  };
}

function readVevent(text: string): { name: string; value: string }[] | null {
  if (!text.startsWith("BEGIN:VEVENT\r\n") || !text.endsWith("END:VEVENT\r\n")) return null;
  const lines = text.replace(/\r\n[ \t]/gu, "").slice(0, -2).split("\r\n");
  if (lines[0] !== "BEGIN:VEVENT" || lines.at(-1) !== "END:VEVENT") return null;
  const properties: { name: string; value: string }[] = [];
  let depth = 0;
  for (const line of lines.slice(1, -1)) {
    const colon = unquoted(line, ":");
    if (colon < 0) return null;
    const [head = "", ...parameters] = splitUnquoted(line.slice(0, colon), ";");
    const name = head.toUpperCase();
    if (name.length === 0 || parameters.some((item) => unquoted(item, "=") <= 0)) return null;
    if (name === "BEGIN") { depth++; continue; }
    if (name === "END") {
      if (depth === 0) return null;
      depth--;
      continue;
    }
    if (depth > 0 || (name.startsWith("X-") && name !== "X-GOOGLE-CONFERENCE")) continue;
    properties.push({ name, value: line.slice(colon + 1) });
  }
  return depth === 0 ? properties : null;
}

function splitUnquoted(value: string, separator: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '"') quoted = !quoted;
    else if (!quoted && value[index] === separator) {
      out.push(value.slice(start, index));
      start = index + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

function unquoted(value: string, needle: string): number {
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '"') quoted = !quoted;
    else if (!quoted && value[index] === needle) return index;
  }
  return -1;
}

function unescapeText(value: string): string {
  return value.replace(/\\(.)/gsu, (whole, escaped: string) =>
    escaped === "n" || escaped === "N" ? "\n" : escaped === "," || escaped === ";" || escaped === "\\" ? escaped : whole);
}

function calendarLine(value: Invitation): Piece[] {
  return sayJoined([
    value.method === null ? null : free(value.method),
    value.summary === null ? null : free(value.summary),
    value.start === null ? null : `${value.start}${value.end === null ? "" : `-${value.end}`}`,
    value.organizer === null ? null : /^[^@\s]+@[^@\s]+$/u.test(value.organizer) ? detail(value.organizer, "email") : free(value.organizer),
    `${value.attendees} attendees`,
  ].filter((item) => item !== null), " | ");
}

function address(value: Address): Piece[] {
  const email = detail(value.address, "email");
  return value.name === null ? said`<${email}>` : said`${detail(value.name, "person")} <${email}>`;
}

function wallClock(ms: number): string {
  return render(ms, MAIL_TAG_ZONE.name, "minute").slice(11);
}


const PIPELINE_PHRASES = [
  /\b(this|the|each) (transcript|input|header)\b/giu,
  /\b(line|lines|entry|entries) \d/giu,
  /\bthe (facts|header) (say|says|show|shows)\b/giu,
  /\b(above|below) the (cap|threshold)\b/giu,
];

function pipelinePhrase(value: string): string | null {
  const scrubbed = value.replace(/(["“'])[^"”']*(["”'])/gu, " ").replace(/\S+\.[A-Za-z0-9]{1,5}/gu, " ");
  for (const pattern of PIPELINE_PHRASES) {
    const match = scrubbed.match(new RegExp(pattern.source, "iu"));
    if (match !== null) return match[0];
  }
  return null;
}

function secretIn(value: string): string | null {
  if (/\b(?:otp|one-time password|one time code|verification code|passcode|code is)\b[^\d\r\n]{0,20}\d{4,8}\b/iu.test(value)) {
    return "an authentication code value";
  }
  const card = /(?<!\d)(?<!\d[ -])(?:\d[ -]?){12,18}\d(?!\d)(?![ -]\d)/gu;
  return [...value.matchAll(card)].some((match) => luhn(match[0])) ? "a 13-19 digit card number" : null;
}

function luhn(value: string): boolean {
  const digits = [...value].filter((character) => /\d/u.test(character)).map(Number);
  const parity = digits.length % 2;
  const sum = digits.reduce((total, digit, index) => {
    const value = index % 2 === parity ? digit * 2 : digit;
    return total + (value > 9 ? value - 9 : value);
  }, 0);
  return sum % 10 === 0;
}

