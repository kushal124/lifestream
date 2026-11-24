import { refuse } from "./refused.js";

/** One header field of a mail message. */
export interface Header {
  /** The field's name as written. */
  name: string;
  /** The field's value, its folded lines joined and trimmed. */
  value: string;
  /** The whole field as written, folded lines included, read as UTF-8, or as Latin-1 when it is not UTF-8. */
  raw: string;
}

/** A mail message's header fields. */
export interface Headers {
  /** Every field, in the order written. */
  fields: Header[];
  /** The value of the first field of the name given, in any case, or undefined when it has none. */
  get(name: string): string | undefined;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Reads the header fields at the start of a mail message, up to its first empty line. */
export function readHeaders(bytes: Buffer): Headers {
  const fields = splitHeaders(bytes);
  return { fields, get: (name) => fields.find((field) => field.name.toLowerCase() === name.toLowerCase())?.value };
}

/** Whether a line is the `From ` line that starts a message in an mbox file, a sender then a date as `ctime` writes it. */
export function isMboxDelimiter(line: string): boolean {
  return /^From \S+ +(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) +(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} +\d{1,2}:\d{2}(?::\d{2})?(?: |$)/u.test(line);
}

/** The messages of an mbox file, cut from its chunks as they stream, each with the line that started it and the byte offset where its bytes begin. */
export async function* mboxMessages(
  chunks: AsyncIterable<Buffer> | Iterable<Buffer>,
  delimiter: (line: string) => boolean = isMboxDelimiter,
): AsyncGenerator<{ from_line: string; offset: number; bytes: Buffer }> {
  let offset = 0;
  let carry: Buffer[] = [];
  let current: { from_line: string; offset: number; parts: Buffer[] } | undefined;
  const step = (line: Buffer): { from_line: string; offset: number; bytes: Buffer } | undefined => {
    let closed: { from_line: string; offset: number; bytes: Buffer } | undefined;
    const start = offset;
    offset += line.length;
    if (line.length >= 5 && line.toString("latin1", 0, 5) === "From ") {
      const text = line.toString("latin1").replace(/\r?\n$/u, "");
      if (delimiter(text)) {
        if (current !== undefined) closed = { from_line: current.from_line, offset: current.offset, bytes: Buffer.concat(current.parts) };
        current = { from_line: text, offset: start + line.length, parts: [] };
        return closed;
      }
    }
    if (current === undefined) refuse("the mbox does not begin with a delimiter line");
    current.parts.push(line);
    return undefined;
  };
  for await (const chunk of chunks) {
    let at = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, at)) {
      const piece = chunk.subarray(at, newline + 1);
      const closed = step(carry.length === 0 ? piece : Buffer.concat([...carry, piece]));
      carry = [];
      if (closed !== undefined) yield closed;
      at = newline + 1;
    }
    if (at < chunk.length) carry.push(chunk.subarray(at));
  }
  if (carry.length > 0) {
    const closed = step(Buffer.concat(carry));
    if (closed !== undefined) yield closed;
  }
  if (current !== undefined) yield { from_line: current.from_line, offset: current.offset, bytes: Buffer.concat(current.parts) };
}

function splitHeaders(bytes: Buffer): Header[] {
  const headers: Header[] = [];
  let field: { start: number; end: number } | undefined;
  const close = (): void => {
    if (field === undefined) return;
    const raw = headerText(bytes.subarray(field.start, field.end));
    field = undefined;
    const colon = raw.indexOf(":");
    if (colon <= 0) return;
    headers.push({ name: raw.slice(0, colon).trimEnd(), value: raw.slice(colon + 1).replace(/\r?\n(?=[ \t])/gu, "").trim(), raw });
  };
  for (let at = 0; at < bytes.length; ) {
    const newline = bytes.indexOf(0x0a, at);
    const next = newline === -1 ? bytes.length : newline + 1;
    let end = newline === -1 ? bytes.length : newline;
    if (end > at && bytes[end - 1] === 0x0d) end--;
    if (end === at) {
      close();
      return headers;
    }
    if ((bytes[at] === 0x20 || bytes[at] === 0x09) && field !== undefined) {
      field.end = end;
    } else {
      close();
      field = { start: at, end };
    }
    at = next;
  }
  close();
  return headers;
}

function headerText(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}
