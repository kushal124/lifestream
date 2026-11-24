import { createHash } from "node:crypto";
import { archive, consuming, each, instant, isObject, listedBlobs, mboxMessages, readHeaders, readJson, refuse, sourceName, span, tryInstant, utf8, type BlobReader, type Delivery, type DeliveryFile, type Guard, type Headers, type Instant, type Json, type JsonObject, type Member, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

const TAKEOUT_MAIL = /(?:^|\/)Takeout\/Mail\/.+\.mbox$/iu;

export const PULL_FORMAT = "org.lifestreamprotocol.gmail-imap-pull/0.2";
export const PULL_MANIFEST = "pull.json";


const DECIMAL = /^\d+$/u;
const BLOB = /^sha256:[0-9a-f]{64}$/u;

const mailmsg: Guard = (content) => {
  const out = exact(content, ["type", "content", "blobs"], "");
  if (out.length > 0) return out;
  const value = content as JsonObject;
  if (value.type !== "gmail.msg") out.push("type must be gmail.msg");
  const blobs = value.blobs;
  if (!Array.isArray(blobs) || blobs.length !== 1) out.push("blobs must hold exactly one message/rfc822 blob");
  else {
    const blob = blobs[0] as JsonObject;
    out.push(...exact(blob, ["hash", "bytes", "media_type", "role"], "blobs[0]"));
    if (typeof blob.hash !== "string" || !BLOB.test(blob.hash)) out.push("blobs[0].hash must be sha256:<hex>");
    if (!Number.isSafeInteger(blob.bytes) || (blob.bytes as number) < 0) out.push("blobs[0].bytes must be a byte count");
    if (blob.media_type !== "message/rfc822" || blob.role !== "original") out.push("blobs[0] must be the original message/rfc822");
  }
  const inner = value.content as JsonObject;
  if (exact(inner, ["from_line"], "content").length === 0) {
    if (typeof inner.from_line !== "string") out.push("content.from_line must be text");
    return out;
  }
  out.push(...exact(inner, ["gm_msgid", "gm_thrid", "folder", "labels", "internaldate"], "content"));
  if (!isDecimal(inner.gm_msgid) || !isDecimal(inner.gm_thrid)) out.push("content.gm_msgid and gm_thrid must be decimal ids");
  if (typeof inner.folder !== "string" || inner.folder.length === 0) out.push("content.folder must be named");
  const labels = inner.labels;
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string") || new Set(labels).size !== labels.length) {
    out.push("content.labels must be distinct strings");
  }
  if (typeof inner.internaldate !== "string" || !isInstant(inner.internaldate)) out.push("content.internaldate must be an RFC 3339 instant");
  return out;
};

const chat: Guard = (content) => {
  const out = exact(content, ["type", "thread_id", "messages"], "");
  if (out.length > 0) return out;
  const value = content as JsonObject;
  if (value.type !== "gmail.thread") out.push("type must be gmail.thread");
  if (!isDecimal(value.thread_id)) out.push("thread_id must be a decimal id");
  const messages = value.messages;
  if (!Array.isArray(messages) || !messages.every(isDecimal)) out.push("messages must be decimal ids");
  else if (messages.some((id, index) => index > 0 && compareDecimal(messages[index - 1] as string, id as string) >= 0)) {
    out.push("messages must ascend without repeats");
  }
  return out;
};

const KINDS: Record<string, Guard> = { mailmsg, chat };

export const GMAIL_IMAP = "gmail-imap";
export const GMAIL_TAKEOUT = "gmail-takeout";

export const gmail: Reader = {
  name: "gmail",
  kinds: KINDS,
  async *read(delivery, files) {
    const named = Array.isArray(delivery.facts.sources) ? delivery.facts.sources.find((each) => isObject(each) && each.id === delivery.source) : undefined;
    const feeder = isObject(named) ? named.connector : undefined;
    if (feeder === GMAIL_IMAP) {
      if (delivery.files.length > 0) yield* pull(delivery, files);
    }
    else if (feeder === GMAIL_TAKEOUT) yield* takeout(delivery, files);
    else if (feeder !== undefined) refuse(`the delivery names feeder ${JSON.stringify(feeder)} for ${delivery.source}, neither ${GMAIL_IMAP} nor ${GMAIL_TAKEOUT}`);
    else if (delivery.id.startsWith(`${delivery.source}/`)) refuse(`the delivery names no feeder for ${delivery.source}`);
  },
};


async function* pull(delivery: Delivery, files: BlobReader): AsyncGenerator<ReaderOutput> {
  const manifestFile = fileAt(delivery, PULL_MANIFEST) ?? refuse(`an IMAP pull holds ${PULL_MANIFEST}`);
  const manifest = pullManifest(files.bytes(manifestFile.blob));
  const account = accountOf(delivery.source);
  if (manifest.account !== account) refuse(`the pull states account ${JSON.stringify(manifest.account)}, not the source's ${JSON.stringify(account)}`);
  for (const message of manifest.messages) {
    const file = fileAt(delivery, message.file) ?? refuse(`the pull lists ${message.file}, which the delivery does not hold`);
    if (file.blob !== `sha256:${message.sha256}` || (message.bytes !== undefined && file.size !== message.bytes)) {
      refuse(`${message.file} does not match the hash and size the pull states`);
    }
    const bytes = files.bytes(file.blob);
    const headers = readHeaders(bytes);
    const content: JsonObject = {
      type: "gmail.msg",
      content: {
        gm_msgid: message.gm_msgid,
        gm_thrid: message.gm_thrid,
        folder: message.folder,
        labels: message.labels,
        internaldate: message.internaldate,
      },
      blobs: [original(file.blob, bytes.length)],
    };
    yield {
      kind: "mailmsg",
      key: message.gm_msgid,
      content,
      time: dateHeaderTime(headers) ?? instant(message.internaldate, "rfc3339"),
      blobs: listedBlobs(content),
      locator: message.file,
    } satisfies ReaderOutput;
  }
}

interface PullMessage {
  file: string;
  folder: string;
  gm_msgid: string;
  gm_thrid: string;
  labels: string[];
  internaldate: string;
  sha256: string;
  bytes?: number;
}

function pullManifest(bytes: Buffer): { account: string; messages: PullMessage[] } {
  const value = readJson(utf8(bytes, PULL_MANIFEST), PULL_MANIFEST) as JsonObject;
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`${PULL_MANIFEST} is not an object`);
  if (value.format !== PULL_FORMAT || value.complete !== true) refuse(`${PULL_MANIFEST} is not a complete ${PULL_FORMAT} pull`);
  if (typeof value.account !== "string" || value.account.length === 0) refuse(`${PULL_MANIFEST} states no account`);
  if (typeof value.fetched_at !== "string" || !isInstant(value.fetched_at)) refuse(`${PULL_MANIFEST} states no RFC 3339 fetched_at`);
  if (!Array.isArray(value.messages)) refuse(`${PULL_MANIFEST} lists no messages`);
  const messages = value.messages.map((entry, index): PullMessage => {
    const at = `${PULL_MANIFEST} message ${index}`;
    const message = entry as JsonObject;
    if (message === null || typeof message !== "object" || Array.isArray(message)) refuse(`${at} is not an object`);
    const { file, folder, gm_msgid, gm_thrid, labels, internaldate, sha256, bytes } = message;
    if (typeof file !== "string" || file.length === 0) refuse(`${at} names no file`);
    if (!isDecimal(gm_msgid) || !isDecimal(gm_thrid)) refuse(`${at} states no decimal gm_msgid and gm_thrid`);
    if (typeof folder !== "string" || folder.length === 0) refuse(`${at} names no folder`);
    if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string") || new Set(labels).size !== labels.length) {
      refuse(`${at} labels are not distinct strings`);
    }
    if (typeof internaldate !== "string" || !isInstant(internaldate)) refuse(`${at} states no RFC 3339 internaldate`);
    if (typeof sha256 !== "string" || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(sha256)) refuse(`${at} states no sha256`);
    if (bytes !== undefined && (!Number.isSafeInteger(bytes) || (bytes as number) < 0)) refuse(`${at} states a bad byte count`);
    return {
      file,
      folder,
      gm_msgid,
      gm_thrid,
      labels: labels as string[],
      internaldate,
      sha256: sha256.replace(/^sha256:/u, ""),
      ...(bytes === undefined ? {} : { bytes: bytes as number }),
    };
  });
  return { account: value.account, messages };
}


const GMAIL_DELIMITER =
  /^From (\d+)@xxx ((?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \+0000 \d{4})$/u;

async function* takeout(delivery: Delivery, files: BlobReader): AsyncGenerator<ReaderOutput> {
  const threads = new Map<string, { messages: Set<string>; first: Instant; last: Instant }>();
  const imported = delivery.facts.import !== undefined;
  let read: Member[] = [];
  yield* consuming(delivery, takeoutRows(delivery, files, threads, imported, (members) => {
    read = members;
  }), () => read);
}

async function* takeoutRows(
  delivery: Delivery, files: BlobReader, threads: Map<string, { messages: Set<string>; first: Instant; last: Instant }>, imported: boolean, reading: (members: Member[]) => void,
): AsyncGenerator<ReaderOutput> {
  yield* archive(delivery, files, (all) => {
    const members = imported ? all.filter((member) => TAKEOUT_MAIL.test(member.name)) : [...all];
    reading(members);
    return each(members, (member) => member.where, async function* (member) {
      if (!(await isMailbox(member))) return;
      const mailbox = { path: member.where, chunks: member.chunks() };
      yield* each(messagesOf(mailbox), (message) => message.where, ({ message, where }) => {
        const [, gmMsgid, date] = GMAIL_DELIMITER.exec(message.from_line)!;
        const internal = tryInstant(date!, "mbox", { offset: "+00:00" }) ?? refuse(`${where}: the delimiter's date ${date} is no instant`);
        const headers = readHeaders(message.bytes);
        const thrid = headers.get("x-gm-thrid")?.trim();
        if (thrid === undefined || !DECIMAL.test(thrid)) refuse(`${mailbox.path}: message ${gmMsgid} states no decimal X-GM-THRID header`);
        const hash = `sha256:${createHash("sha256").update(message.bytes).digest("hex")}`;
        const content: JsonObject = { type: "gmail.msg", content: { from_line: message.from_line }, blobs: [original(hash, message.bytes.length)] };
        const thread = threads.get(thrid);
        if (thread === undefined) threads.set(thrid, { messages: new Set([gmMsgid!]), first: internal, last: internal });
        else {
          thread.messages.add(gmMsgid!);
          if (internal.start_ms < thread.first.start_ms) thread.first = internal;
          if (internal.start_ms > thread.last.start_ms) thread.last = internal;
        }
        return [{
          kind: "mailmsg",
          key: gmMsgid!,
          content,
          time: dateHeaderTime(headers) ?? internal,
          blobs: listedBlobs(content),
          bytes: [message.bytes],
          media: { [hash]: "message/rfc822" },
          locator: where,
        } satisfies ReaderOutput];
      });
    });
  });
  for (const [thrid, thread] of [...threads].sort(([left], [right]) => compareDecimal(left, right))) {
    yield {
      kind: "chat",
      key: thrid,
      content: { type: "gmail.thread", thread_id: thrid, messages: [...thread.messages].sort(compareDecimal) },
      time: span(thread.first, thread.last),
      locator: `thread ${thrid}`,
    } satisfies ReaderOutput;
  }
}

const DELIMITER_BYTES = 128;

async function isMailbox(member: Member): Promise<boolean> {
  const head = (await member.prefix(DELIMITER_BYTES)).toString("latin1");
  if (GMAIL_DELIMITER.test(head.split(/\r?\n/u, 1)[0]!)) return true;
  if (/\.mbox$/iu.test(member.name)) refuse("its name is a mailbox's, and its first line is not Gmail's delimiter");
  return false;
}

async function* messagesOf(mailbox: { path: string; chunks: AsyncIterable<Buffer> }): AsyncGenerator<{ message: { from_line: string; offset: number; bytes: Buffer }; where: string }> {
  let index = 0;
  let delimiterAt = 0;
  for await (const message of mboxMessages(mailbox.chunks, (line) => GMAIL_DELIMITER.test(line))) {
    yield { message, where: `${mailbox.path}:message ${index++} at byte ${delimiterAt}` };
    delimiterAt = message.offset + message.bytes.length;
  }
}


const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const STRICT_DATE =
  /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),[ \t]+)?(\d{1,2})[ \t]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[ \t]+(\d{4})[ \t]+(\d{2}):(\d{2}):(\d{2})[ \t]+([+-])(\d{2})(\d{2})[ \t]*(?:\([^\r\n]*\))?$/u;

function dateHeaderTime(headers: Headers): Instant | undefined {
  const header = headers.get("date");
  const match = header === undefined ? null : STRICT_DATE.exec(header);
  if (match === null) return undefined;
  const month = String(MONTHS.indexOf(match[2]!) + 1).padStart(2, "0");
  return tryInstant(`${match[3]}-${month}-${match[1]!.padStart(2, "0")}T${match[4]}:${match[5]}:${match[6]}${match[7]}${match[8]}:${match[9]}`, "rfc3339");
}

function original(hash: string, bytes: number): JsonObject {
  return { hash, bytes, media_type: "message/rfc822", role: "original" };
}

function accountOf(source: string): string {
  const { account } = sourceName(source);
  return /^[^:@\s]+@[^:@\s]+$/u.test(account) ? account : refuse(`${source} is not a gmail:<address>:<copy> source`);
}

function fileAt(delivery: Delivery, path: string): DeliveryFile | undefined {
  return delivery.files.find((file) => file.path === path);
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value);
}

function isInstant(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(text) && tryInstant(text, "rfc3339") !== undefined;
}

export function compareDecimal(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/u, "");
  const b = right.replace(/^0+(?=\d)/u, "");
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function exact(value: Json | undefined, members: string[], at: string): string[] {
  const where = at === "" ? "content" : at;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [`${where} must be an object`];
  const keys = Object.keys(value);
  const missing = members.filter((member) => !keys.includes(member));
  const extra = keys.filter((key) => !members.includes(key));
  return [...missing.map((member) => `${where}.${member} is missing`), ...extra.map((key) => `${where}.${key} is not a member`)];
}
