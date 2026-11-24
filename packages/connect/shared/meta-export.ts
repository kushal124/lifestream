import type { BlobReader, Delivery, Guard, Instant, Json, JsonObject, ReaderOutput } from "@lifestreamprotocol/core";
import { isObject } from "@lifestreamprotocol/core";
import { instantOf } from "./delivery.js";
import type { Reader } from "../seams.js";
import { forThisAccount } from "./exported.js";
import { fingerprint } from "./fingerprint.js";
import { jsonAt, jsonElements, readJson, utf8, type JsonPart } from "./json.js";
import { fileMember, stored, zipped, type Member, type Streamed } from "./members.js";
import { each, refuse } from "./refused.js";

export type ItemKind = "post" | "story" | "comment" | "like" | "follow";

export interface ItemFile {
  path: RegExp;
  kind: ItemKind;
  under?: string;
  key?: (item: JsonObject) => string | undefined;
  time: (item: JsonObject) => Json | undefined;
}

export interface MetaProduct {
  product: string;
  name: string;
  activity: string;
  profile: string;
  accounts(profile: JsonObject, where: string): string[];
  files: readonly ItemFile[];
}

export const KINDS = ["post", "story", "comment", "like", "follow", "chat", "msg"] as const;

const ADDED = ["type", "blobs"];
const ADDED_TO_MSG = [...ADDED, "thread_path"];
const BLOB = /^sha256:[0-9a-f]{64}$/u;
const MEDIA: Readonly<Record<string, string>> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic",
  mp4: "video/mp4", mov: "video/quicktime", m4a: "audio/mp4", mp3: "audio/mpeg", aac: "audio/aac", wav: "audio/wav", pdf: "application/pdf",
};


const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function repairText(text: string): string {
  if (!/[^\u0000-\u007f]/u.test(text) || /[^\u0000-ÿ]/u.test(text)) return text;
  try {
    return UTF8.decode(Buffer.from(text, "latin1"));
  } catch {
    return text;
  }
}

function repaired(value: Json, where: string): Json {
  if (typeof value === "string") return repairText(value);
  if (Array.isArray(value)) return value.map((item) => repaired(item, where));
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [name, member] of Object.entries(value)) {
    const fixed = repairText(name);
    if (Object.hasOwn(out, fixed)) refuse(`${where}: two members read as ${JSON.stringify(fixed)} once repaired`);
    out[fixed] = repaired(member, where);
  }
  return out;
}


export function metaConnector(spec: MetaProduct): Reader {
  const source = new RegExp(`^${spec.product}:([^:]+):export$`, "u");
  const guards = Object.fromEntries(KINDS.map((kind) => [kind, guardOf(`${spec.product}.${kind}`, kind)]));
  return {
    name: spec.name,
    kinds: guards,
    async *read(delivery, files) {
      const account = source.exec(delivery.source)?.[1] ?? refuse(`${delivery.source} is not a ${spec.product}:<account>:export source`);
      if (!forThisAccount(delivery)) return;
      yield* zipped(delivery, files, async function* (zips) {
        const members = exportMembers(delivery, files, zips, spec.activity);
        if (members.size > 0) {
          const profile = members.get(spec.profile) ?? refuse(`the delivery holds a ${spec.product} export with no ${spec.profile}: its account cannot be checked`);
          const named = spec.accounts(repaired(wholeObject(profile), profile.where) as JsonObject, profile.where);
          if (named.length === 0) refuse(`${profile.where} names no account`);
          if (!named.includes(account)) refuse(`the export is ${named.join(" / ")}'s, and the source is ${account}'s: nothing is filed under the wrong account`);
          const media = new Media(members);
          const sorted = [...members.values()].sort((left, right) => compare(left.path, right.path));
          for (const file of spec.files) {
            yield* each(sorted.filter((member) => file.path.test(member.path)), (member) => member.where, (member) =>
              each(listed(member, file.under), (item) => item.where, async (item) => [await itemRow(spec.product, file, item.read(), item.where, media)]));
          }
          yield* threads(spec, sorted, media);
        }
      });
    },
  };
}

async function itemRow(product: string, file: ItemFile, element: Buffer, locator: string, media: Media): Promise<ReaderOutput> {
  const item = parsedObject(element, locator, ADDED);
  const linked = await media.of(item);
  return {
    kind: file.kind,
    key: file.key?.(item) ?? fingerprint(item),
    content: { type: `${product}.${file.kind}`, ...item, ...listedBlobs(linked) },
    ...timed(file.time(item), "unix-s", locator),
    ...rowBlobs(linked),
    locator,
  };
}


function threadPart(activity: string): RegExp {
  return new RegExp(`^${activity}/messages/([^/]+/[^/]+)/message_(\\d+)\\.json$`, "u");
}

async function* threads(spec: MetaProduct, members: readonly Rooted[], media: Media): AsyncGenerator<ReaderOutput> {
  const part = threadPart(spec.activity);
  const byThread = new Map<string, { number: number; member: Rooted }[]>();
  for (const member of members) {
    const match = part.exec(member.path);
    if (match === null) continue;
    const parts = byThread.get(match[1]!) ?? [];
    parts.push({ number: Number(match[2]), member });
    byThread.set(match[1]!, parts);
  }
  for (const [, parts] of [...byThread].sort(([left], [right]) => compare(left, right))) {
    parts.sort((left, right) => left.number - right.number);
    let first = true;
    yield* each(parts, ({ member }) => member.where, async function* ({ member }) {
      const value = repaired(wholeObject(member), member.where);
      const { messages, ...chat } = value as JsonObject;
      const thread_path = chat.thread_path;
      if (typeof thread_path !== "string" || thread_path === "") refuse(`${member.where} states no thread_path`);
      if (!Array.isArray(messages)) refuse(`${member.where} states no messages list`);
      const thread = threadId(thread_path);
      if (first) {
        for (const name of ADDED) if (Object.hasOwn(chat, name)) refuse(`${member.where} states a ${name} member, which this connector does not read`);
        const linked = await media.of(chat);
        first = false;
        yield { kind: "chat", key: thread, content: { type: `${spec.product}.chat`, ...chat, ...listedBlobs(linked) }, ...rowBlobs(linked), locator: member.where };
      }
      yield* each(messages.entries(), ([index]) => `${member.where} messages[${index}]`, async ([index, message]) => {
        const locator = `${member.where} messages[${index}]`;
        if (!isObject(message)) refuse(`${locator} is not a JSON object`);
        for (const name of ADDED_TO_MSG) if (Object.hasOwn(message, name)) refuse(`${locator} states a ${name} member, which this connector does not read`);
        const linked = await media.of(message);
        return [{
          kind: "msg",
          key: messageKey(thread, message),
          content: { type: `${spec.product}.msg`, thread_path, ...message, ...listedBlobs(linked) },
          ...timed(message.timestamp_ms, "unix-ms", locator),
          ...rowBlobs(linked),
          locator,
        }];
      });
    });
  }
}

export function threadId(thread_path: string): string {
  return /(?:^|[/_])(\d+)$/u.exec(thread_path)?.[1] ?? thread_path;
}

export function messageKey(thread: string, message: JsonObject): string {
  const fields: JsonObject = { thread };
  if (message.sender_name !== undefined) fields.sender = message.sender_name;
  if (message.timestamp_ms !== undefined) fields.time_ms = message.timestamp_ms;
  if (message.content !== undefined) fields.text = message.content;
  return fingerprint(fields);
}


interface Rooted extends Member {
  readonly path: string;
}

function exportMembers(delivery: Delivery, files: BlobReader, zipped: readonly Member[], activity: string): Map<string, Rooted> {
  const own = delivery.files.map((file): Rooted => ({ ...fileMember(files, file), path: file.path }));
  const byZip = new Map<string, Rooted[]>();
  for (const member of zipped) byZip.set(member.zip!, [...(byZip.get(member.zip!) ?? []), { ...member, path: member.name }]);
  const members = new Map<string, Rooted>();
  for (const [where, list] of [["the delivery", own] as const, ...byZip]) {
    const root = rootOf(list.map((member) => member.path), activity, where);
    if (root === undefined) continue;
    for (const member of [...list].sort((left, right) => compare(left.path, right.path))) {
      if (!member.path.startsWith(root)) continue;
      const path = member.path.slice(root.length);
      const other = members.get(path);
      if (other !== undefined) refuse(`the delivery holds ${path} twice: ${other.where} and ${member.where}`);
      members.set(path, { ...member, path });
    }
  }
  return members;
}

function rootOf(paths: Iterable<string>, activity: string, where: string): string | undefined {
  const marker = new RegExp(`(?:^|/)${activity}/`, "u");
  let root: string | undefined;
  for (const path of paths) {
    const match = marker.exec(path);
    if (match === null) continue;
    const prefix = path.slice(0, match.index + (match[0].startsWith("/") ? 1 : 0));
    if (root === undefined) root = prefix;
    else if (root !== prefix) refuse(`${where} holds two exports, at ${JSON.stringify(root)} and ${JSON.stringify(prefix)}: one delivery is one profile's export`);
  }
  return root;
}

function wholeObject(member: Member): JsonObject {
  const value = readJson(utf8(member.bytes(), member.where), member.where);
  if (!isObject(value)) refuse(`${member.where} is not a JSON object`);
  return value;
}

function parsedObject(element: Buffer, locator: string, added: readonly string[]): JsonObject {
  const value = readJson(utf8(element, locator), locator);
  if (!isObject(value)) refuse(`${locator} is not a JSON object`);
  const item = repaired(value, locator) as JsonObject;
  for (const name of added) if (Object.hasOwn(item, name)) refuse(`${locator} states a ${name} member, which this connector does not read`);
  return item;
}


const SPACE = new Set([0x20, 0x0a, 0x0d, 0x09]);
const OPEN_BRACE = 0x7b;
const OPEN_BRACKET = 0x5b;
const WRAPPED = /^[ \t\r\n]*\{[ \t\r\n]*"([^"\\]*)"[ \t\r\n]*:/u;
const HEAD_LIMIT = 4096;

async function* listed(member: Member, under: string | undefined): AsyncGenerator<JsonPart> {
  const where = member.where;
  const iterator = member.chunks()[Symbol.asyncIterator]();
  const seen: Buffer[] = [];
  const head = async (enough: (bytes: Buffer) => boolean): Promise<Buffer> => {
    let bytes = Buffer.concat(seen);
    while (!enough(bytes)) {
      const next = await iterator.next();
      if (next.done === true) break;
      seen.push(next.value);
      bytes = Buffer.concat([bytes, next.value]);
    }
    return bytes;
  };
  const first = (await head((bytes) => bytes.some((byte) => !SPACE.has(byte)))).find((byte) => !SPACE.has(byte));
  if (first === undefined) refuse(`${where} is empty`);
  const all = (async function* () {
    yield* seen;
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) yield next.value;
  })();
  if (under !== undefined) {
    const opening = (bytes: Buffer) => WRAPPED.exec(bytes.subarray(0, HEAD_LIMIT).toString("latin1"));
    const named = opening(await head((bytes) => bytes.length >= HEAD_LIMIT || opening(bytes) !== null))?.[1] ?? refuse(`${where} does not open as {"${under}": [...]}`);
    if (named !== under) refuse(`${where} lists its items under "${named}", not "${under}"`);
    yield* jsonAt(all, where, [`${under}[*]`]);
  } else if (first === OPEN_BRACKET) {
    yield* jsonElements(all, where);
  } else if (first === OPEN_BRACE) {
    await iterator.return?.();
    const bytes = member.bytes();
    yield { where: `${where}[0]`, read: () => bytes };
  } else {
    refuse(`${where} is neither a JSON array nor an object`);
  }
}


interface Linked {
  listed: JsonObject;
  streamed?: Streamed;
}

class Media {
  readonly #members: ReadonlyMap<string, Member>;

  constructor(members: ReadonlyMap<string, Member>) {
    this.#members = members;
  }

  async of(item: Json): Promise<Linked[]> {
    const out: Linked[] = [];
    const seen = new Set<string>();
    for (const uri of uris(item)) {
      const member = this.#members.get(uri);
      if (member === undefined || seen.has(uri)) continue;
      seen.add(uri);
      const media_type = MEDIA[extension(uri)] ?? "application/octet-stream";
      const held = await stored(member);
      out.push({ listed: { hash: held.hash, bytes: held.size, media_type, role: "attachment", file: uri }, ...(held.streamed === undefined ? {} : { streamed: held.streamed }) });
    }
    return out;
  }
}

export function* uris(value: Json): Generator<string> {
  if (Array.isArray(value)) {
    for (const item of value) yield* uris(item);
  } else if (isObject(value)) {
    for (const [name, member] of Object.entries(value)) {
      if (name === "uri" && typeof member === "string") yield member;
      else yield* uris(member);
    }
  }
}

function listedBlobs(linked: readonly Linked[]): JsonObject {
  return linked.length === 0 ? {} : { blobs: linked.map((blob) => blob.listed) };
}

function rowBlobs(linked: readonly Linked[]): Pick<ReaderOutput, "blobs" | "media" | "streamed"> {
  if (linked.length === 0) return {};
  const streamed = linked.flatMap((blob) => (blob.streamed === undefined ? [] : [blob.streamed]));
  return {
    blobs: [...new Set(linked.map((blob) => blob.listed.hash as string))],
    media: Object.fromEntries(linked.map((blob) => [blob.listed.hash as string, blob.listed.media_type as string])),
    ...(streamed.length === 0 ? {} : { streamed }),
  };
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= name.lastIndexOf("/") ? "" : name.slice(dot + 1).toLowerCase();
}


function timed(value: Json | undefined, rule: "unix-s" | "unix-ms", locator: string): { time?: Instant } {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return {};
  return { time: instantOf(value, rule, `${locator}: the time`) };
}

function guardOf(type: string, kind: string): Guard {
  return (content) => {
    if (!isObject(content)) return ["content must be an object"];
    const out: string[] = [];
    if (content.type !== type) out.push(`type must be ${type}`);
    if (Object.keys(content).every((name) => name === "type" || name === "blobs" || (kind === "msg" && name === "thread_path"))) out.push("the item states nothing");
    if (kind === "msg" || kind === "chat") {
      if (typeof content.thread_path !== "string") out.push("thread_path must be a string");
    }
    if (kind === "msg") {
      if (!Number.isSafeInteger(content.timestamp_ms)) out.push("timestamp_ms must be an integer");
      if (content.sender_name !== undefined && typeof content.sender_name !== "string") out.push("sender_name must be a string");
      if (content.content !== undefined && typeof content.content !== "string") out.push("content must be a string");
    }
    if (kind === "chat" && content.participants !== undefined && (!Array.isArray(content.participants) || content.participants.some((one) => !isObject(one)))) {
      out.push("participants must be a list of objects");
    }
    if (content.blobs !== undefined) {
      if (!Array.isArray(content.blobs) || content.blobs.length === 0) out.push("blobs, when stated, must list at least one file");
      else {
        for (const blob of content.blobs) {
          if (!isObject(blob) || Object.keys(blob).sort().join(",") !== "bytes,file,hash,media_type,role" || typeof blob.hash !== "string" || !BLOB.test(blob.hash) ||
            !Number.isSafeInteger(blob.bytes) || (blob.bytes as number) < 0 || typeof blob.media_type !== "string" || blob.role !== "attachment" ||
            typeof blob.file !== "string" || blob.file === "") {
            out.push("a blob is exactly { hash, bytes, media_type, role: attachment, file }");
          }
        }
      }
    }
    return out;
  };
}


export function textOf(item: JsonObject, member: string): string | undefined {
  const value = item[member];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function labelledLink(item: JsonObject): string | undefined {
  const values = item.label_values;
  if (!Array.isArray(values)) return undefined;
  const links = values.flatMap((entry) => (isObject(entry) && typeof entry.href === "string" && entry.href !== "" ? [entry.href] : []));
  return links.length === 1 ? links[0] : undefined;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
