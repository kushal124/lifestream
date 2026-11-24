import { canonicalEmail, ics } from "@lifestreamprotocol/core";

const HEADER_LIMIT = 256 * 1024;

export interface MailAddress {
  address: string;
  name: string | null;
}

export interface MailAttachment {
  name: string | null;
  media_type: string;
  bytes: number;
}

export interface MailInvitation {
  method: string | null;
  uid: string | null;
  summary: string | null;
  start: string | null;
  end: string | null;
  organizer: string | null;
  attendees: number;
}

export interface Mail {
  header(name: string): string | null;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  date: string | null;
  readonly text: string;
  readonly reply: string;
  readonly attachments: MailAttachment[];
  readonly invitation: MailInvitation | null;
}

export function readMail(bytes: Uint8Array): Mail {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers = readHeaders(split(buffer).header.toString("latin1"));
  const first = (name: string) => headers.get(name.toLowerCase())?.[0] ?? null;
  let body: Body | undefined;
  const decoded = () => body ??= readBody(buffer);
  return {
    header: first,
    from: readAddresses(first("from") ?? "")[0] ?? null,
    to: readAddresses(first("to") ?? ""),
    cc: readAddresses(first("cc") ?? ""),
    subject: decodeWords(first("subject") ?? "").trim(),
    date: first("date"),
    get text() { return decoded().text; },
    get reply() { return decoded().reply; },
    get attachments() { return decoded().attachments; },
    get invitation() { return decoded().invitation; },
  };
}

export function withoutQuotedHistory(text: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (/^-{2,}\s*Original Message\s*-{2,}$/iu.test(line)) break;
    if (/^_{8,}$/u.test(line) && outlookHeader(lines, index + 1)) break;
    if (outlookHeader(lines, index)) break;
    if (/^On\b/u.test(line) && (/wrote:$/u.test(line) || /wrote:$/u.test(`${line} ${lines[index + 1]?.trim() ?? ""}`))) break;
    if (line.startsWith(">")) continue;
    kept.push(lines[index]!);
  }
  return collapse(kept.join("\n"));
}

export function htmlToText(html: string): string {
  const blocks = "address|article|aside|blockquote|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul";
  return collapse(decodeEntities(html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(new RegExp(`</?(?:${blocks})\\b[^>]*>`, "giu"), "\n")
    .replace(/<[^>]+>/gu, " ")));
}

export function decodeWords(value: string): string {
  const WORD = /=\?([^?]+)\?([bq])\?([^?]*)\?=/giu;
  return value
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?[^?]+\?[bq]\?[^?]*\?=)/giu, "$1")
    .replace(/(?:=\?[^?]+\?[bq]\?[^?]*\?=)+/giu, (run) => {
      let out = "";
      let charset: string | null = null;
      let bytes: Buffer[] = [];
      const flush = () => {
        if (charset !== null) out += decodeBytes(Buffer.concat(bytes), charset);
        bytes = [];
      };
      for (const [word, wordCharset, encoding, encoded] of run.matchAll(WORD)) {
        let decoded: Buffer;
        try {
          decoded = encoding!.toLowerCase() === "b"
            ? Buffer.from(encoded!.replace(/\s/gu, ""), "base64")
            : Buffer.from(encoded!.replace(/_/gu, " ").replace(/=([0-9a-f]{2})/giu,
              (_hex, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
        } catch {
          flush();
          charset = null;
          out += word;
          continue;
        }
        if (charset === null || charset.toLowerCase() !== wordCharset!.toLowerCase()) {
          flush();
          charset = wordCharset!;
        }
        bytes.push(decoded);
      }
      flush();
      return out;
    });
}

export function readAddresses(value: string): MailAddress[] {
  return splitAddresses(decodeWords(value)).flatMap((raw): MailAddress[] => {
    const text = raw.trim();
    if (text.length === 0) return [];
    const bracketed = [...text.matchAll(/<\s*((?:mailto:)?[^@\s<>]+@[^@\s<>]+)\s*>/giu)].at(-1);
    if (bracketed !== undefined) {
      const address = canonicalEmail(bracketed[1]!);
      return address === null ? [] : [{ address, name: displayName(text.slice(0, text.indexOf("<"))) }];
    }
    const bare = /(?:mailto:)?[^@\s()<>]+@[^@\s()<>;]+/iu.exec(text);
    const address = bare === null ? null : canonicalEmail(bare[0]);
    if (bare === null || address === null) return [];
    const comment = /^\(([^()]*)\)$/u.exec(text.slice(bare.index + bare[0].length).trim());
    return [{ address, name: displayName(comment?.[1] ?? text.slice(0, bare.index)) }];
  });
}

interface Body {
  text: string;
  reply: string;
  attachments: MailAttachment[];
  invitation: MailInvitation | null;
}

interface Parts {
  plain: string[];
  html: string[];
  calendars: string[];
  attachments: MailAttachment[];
}

function readBody(bytes: Buffer): Body {
  const parts: Parts = { plain: [], html: [], calendars: [], attachments: [] };
  collectParts(bytes, "text/plain", false, parts, 0);
  const plain = longest(parts.plain);
  const html = longest(parts.html);
  const looksHtml = plain !== undefined && /<\/?[a-z][\s\S]*>/iu.test(plain);
  const text = plain !== undefined ? (looksHtml ? htmlToText(plain) : collapse(plain)) : htmlToText(html ?? "");
  const reply = plain !== undefined && !looksHtml ? withoutQuotedHistory(plain)
    : withoutQuotedHistory(htmlToText(htmlBeforeQuote(plain ?? html ?? "")));
  const invitation = parts.calendars.map(readInvitation).find((value) => value !== null) ?? null;
  return { text, reply, attachments: parts.attachments, invitation };
}

function htmlBeforeQuote(html: string): string {
  const quote = /<(?:div|blockquote)\b[^>]*(?:class="[^"]*\bgmail_quote\b|type="cite"|id="(?:divRplyFwdMsg|appendonsend)")|<blockquote\b/iu.exec(html);
  return quote === null ? html : html.slice(0, quote.index);
}

function collectParts(bytes: Buffer, inherited: string, nested: boolean, into: Parts, depth: number): void {
  if (depth > 32) return;
  const { header, body, terminated } = split(bytes, nested);
  const headers = readHeaders(header.toString("latin1"));
  const first = (name: string) => headers.get(name)?.[0] ?? null;
  const contentType = first("content-type") ?? (nested && !terminated ? "application/octet-stream" : inherited);
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType.startsWith("multipart/")) {
    const boundary = parameter(contentType, "boundary");
    if (boundary !== null && boundary.length > 0) {
      for (const part of splitMultipart(body, boundary)) collectParts(part, "text/plain", true, into, depth + 1);
    }
    return;
  }
  const disposition = first("content-disposition") ?? "";
  const filename = parameter(disposition, "filename") ?? parameter(contentType, "name");
  const decoded = transferDecode(body, first("content-transfer-encoding") ?? "");
  const charset = parameter(contentType, "charset") ?? "utf-8";
  const attached = filename !== null || /\battachment\b/iu.test(disposition);
  if (!attached && mediaType === "text/plain") into.plain.push(decodeBytes(decoded, charset));
  else if (!attached && mediaType === "text/html") into.html.push(decodeBytes(decoded, charset));
  else if (mediaType === "text/calendar") into.calendars.push(decodeBytes(decoded, charset));
  if (attached) into.attachments.push({ name: filename === null ? null : decodeWords(filename), media_type: mediaType, bytes: decoded.byteLength });
}

function readInvitation(calendar: string): MailInvitation | null {
  let read: { method: string | null; event: ics.IcsProperty[] };
  try {
    const root = ics.readComponent(calendar.trim(), "the invitation");
    const vevent = root.name === "VCALENDAR" ? root.children.find((child) => child.name === "VEVENT") : undefined;
    if (vevent === undefined) return null;
    const method = ics.properties(root).find((item) => item.name === "METHOD")?.value.trim().toUpperCase();
    read = { method: method === undefined || method === "" ? null : method, event: ics.properties(vevent) };
  } catch (error) {
    if (error instanceof ics.IcsError) return null;
    throw error;
  }
  const { method, event } = read;
  const property = (name: string) => event.find((item) => item.name === name)?.value ?? null;
  const summary = property("SUMMARY");
  return {
    method,
    uid: property("UID"),
    summary: summary === null ? null : ics.unescapeText(summary),
    start: property("DTSTART"),
    end: property("DTEND"),
    organizer: property("ORGANIZER")?.replace(/^mailto:/iu, "").toLowerCase() ?? null,
    attendees: event.filter((item) => item.name === "ATTENDEE").length,
  };
}

function outlookHeader(lines: readonly string[], index: number): boolean {
  if (!/^\*?From:\*?\s/u.test(lines[index]?.trim() ?? "")) return false;
  return lines.slice(index + 1, index + 3).some((line) => /^\*?(?:Sent|Date):\*?\s/u.test(line.trim()));
}

function split(bytes: Buffer, missingTerminatorIsBody = false): { header: Buffer; body: Buffer; terminated: boolean } {
  const crlf = bytes.indexOf("\r\n\r\n");
  const lf = bytes.indexOf("\n\n");
  const [index, width] = crlf >= 0 && (lf < 0 || crlf < lf) ? [crlf, 4] : [lf, 2];
  if (index < 0) {
    if (missingTerminatorIsBody) return { header: Buffer.alloc(0), body: bytes, terminated: false };
    if (bytes.byteLength > HEADER_LIMIT) throw new TypeError("mail headers exceed 256 KB");
    return { header: bytes, body: Buffer.alloc(0), terminated: false };
  }
  if (index > HEADER_LIMIT) throw new TypeError("mail headers exceed 256 KB");
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
  const name = encoding.trim().toLowerCase();
  if (name === "base64") return Buffer.from(body.toString("ascii").replace(/\s/gu, ""), "base64");
  if (name === "quoted-printable") {
    return Buffer.from(body.toString("latin1").replace(/=\r?\n/gu, "")
      .replace(/=([0-9a-f]{2})/giu, (_hex, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
  }
  return body;
}

function decodeBytes(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.trim().replace(/["']/gu, "").toLowerCase() || "utf-8").decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
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

function displayName(value: string): string | null {
  const name = value.trim().replace(/^"|"$/gu, "").trim();
  return name.length === 0 ? null : name;
}

function parameter(value: string, name: string): string | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "iu").exec(value);
  return match?.[1] ?? match?.[2] ?? null;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (whole, decimal?: string, hex?: string, name?: string) => {
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : hex !== undefined ? Number.parseInt(hex, 16) : undefined;
    if (code === undefined) return named[name!.toLowerCase()] ?? whole;
    return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? "\ufffd" : String.fromCodePoint(code);
  });
}

function collapse(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/[\t  ]+/gu, " ").replace(/ *\n */gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function longest(values: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const value of values) if (value.trim().length > 0 && (best === undefined || value.trim().length > best.trim().length)) best = value;
  return best;
}
