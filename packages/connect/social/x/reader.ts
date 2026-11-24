import { each, fileMember, forThisAccount, instantOf, isObject, jsonElements, readJson, refuse, stored, utf8, zipped, type BlobReader, type Delivery, type Guard, type Instant, type Json, type JsonObject, type Member, type Reader, type ReaderOutput, type Streamed } from "@lifestreamprotocol/connect/sdk";

export const POST = "post";
export const LIKE = "like";
export const MSG = "msg";

export const FILES: Readonly<Record<string, { kind: string; member: string; media?: string }>> = {
  tweets: { kind: POST, member: "tweet", media: "tweets_media" },
  "deleted-tweets": { kind: POST, member: "tweet", media: "deleted_tweets_media" },
  like: { kind: LIKE, member: "like" },
  "direct-messages": { kind: MSG, member: "dmConversation", media: "direct_messages_media" },
  "direct-messages-group": { kind: MSG, member: "dmConversation", media: "direct_messages_group_media" },
};

export const MESSAGES = ["messageCreate", "welcomeMessageCreate"] as const;

const TYPES: Readonly<Record<string, string>> = { [POST]: "x.post", [LIKE]: "x.like", [MSG]: "x.msg" };

const MANIFEST = /^(.*?)data\/manifest\.js$/u;
const DATA_FILE = /^([a-z-]+?)(?:-part(\d+))?\.js$/u;
const ASSIGNMENT = /^\s*window\.YTD\.([A-Za-z_]+)\.part(\d+)\s*$/u;
const SOURCE = /^x:([^:]+):export$/u;
const ID = /^\d+$/u;
const BLOB = /^sha256:[0-9a-f]{64}$/u;
const PREFIX_LIMIT = 1024;

const MEDIA: Readonly<Record<string, string>> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", mp4: "video/mp4",
};


function guard(kind: string): Guard {
  return (content) => {
    if (!isObject(content)) return ["content must be an object"];
    const out: string[] = [];
    if (content.type !== TYPES[kind]) out.push(`type must be ${TYPES[kind]}`);
    if (kind === MSG) {
      if (typeof content.conversationId !== "string") out.push("conversationId must be a string");
      const stated = MESSAGES.filter((member) => content[member] !== undefined);
      if (stated.length !== 1) out.push(`a message states exactly one of ${MESSAGES.join(", ")}`);
      for (const member of stated) {
        const message = content[member];
        if (!isObject(message)) out.push(`${member} must be an object`);
        else {
          for (const field of ["id", "senderId", "createdAt"]) if (typeof message[field] !== "string") out.push(`${member}.${field} must be a string`);
          if (message.text !== undefined && typeof message.text !== "string") out.push(`${member}.text must be a string`);
          if (message.mediaUrls !== undefined && (!Array.isArray(message.mediaUrls) || message.mediaUrls.some((url) => typeof url !== "string"))) out.push(`${member}.mediaUrls must be a list of strings`);
        }
      }
    } else {
      const member = kind === POST ? "tweet" : "like";
      const item = content[member];
      if (!isObject(item)) out.push(`${member} must be an object`);
      else if (kind === POST) {
        for (const field of ["id_str", "created_at"]) if (typeof item[field] !== "string") out.push(`tweet.${field} must be a string`);
        for (const field of ["full_text", "deleted_at"]) if (item[field] !== undefined && typeof item[field] !== "string") out.push(`tweet.${field} must be a string`);
        for (const field of ["entities", "extended_entities"]) if (item[field] !== undefined && !isObject(item[field])) out.push(`tweet.${field} must be an object`);
      } else {
        if (typeof item.tweetId !== "string") out.push("like.tweetId must be a string");
        for (const field of ["fullText", "expandedUrl"]) if (item[field] !== undefined && typeof item[field] !== "string") out.push(`like.${field} must be a string`);
      }
    }
    if (content.blobs !== undefined) {
      if (kind === LIKE || !Array.isArray(content.blobs) || content.blobs.length === 0) out.push("blobs, when stated, list at least one media file of a post or message");
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


export const xArchive: Reader = {
  name: "x-archive",
  kinds: { [POST]: guard(POST), [LIKE]: guard(LIKE), [MSG]: guard(MSG) },
  async *read(delivery, files) {
    const account = accountOf(delivery.source);
    if (!forThisAccount(delivery)) return;
    yield* zipped(delivery, files, async function* (members) {
      const download = downloadOf(delivery, files, members);
      if (download !== undefined) {
        await checkAccount(download, account);
        yield* each(download.parts, (part) => part.where, (part) => {
          const read = FILES[part.data]!;
          const media = read.media === undefined ? undefined : download.media.get(read.media);
          return each(jsonElements(assigned(part), part.where), (element) => element.where, (element) => {
            const where = element.where;
            const value = readJson(utf8(element.read(), where), where);
            return read.kind === MSG ? messageRows(value, where, media) : itemRow(read.kind, read.member, value, where, media).then((row) => [row]);
          });
        });
      }
    });
  },
};

function accountOf(source: string): string {
  const match = SOURCE.exec(source);
  if (match === null) refuse(`${source} is not an x:<account id>:export source`);
  return match[1]!;
}

interface Data extends Member {
  readonly path: string;
}

interface Part extends Data {
  readonly data: string;
  readonly part: number;
}

interface Download {
  where: string;
  account: Part | undefined;
  parts: Part[];
  media: Map<string, Map<string, Data[]>>;
}

function downloadOf(delivery: Delivery, files: BlobReader, zipped: readonly Member[]): Download | undefined {
  const sorted = [...delivery.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const found: Download[] = [];
  const roots = sorted.flatMap((file) => MANIFEST.exec(file.path)?.[1] ?? []);
  for (const root of roots) {
    const data = `${root}data/`;
    found.push(downloadFrom(root === "" ? "the delivery" : root, sorted.flatMap((file) => (file.path.startsWith(data) ? [{ ...fileMember(files, file), path: file.path.slice(data.length) }] : []))));
  }
  const byZip = new Map<string, Member[]>();
  for (const member of zipped) byZip.set(member.zip!, [...(byZip.get(member.zip!) ?? []), member]);
  for (const [zip, entries] of byZip) {
    for (const root of entries.flatMap((entry) => MANIFEST.exec(entry.name)?.[1] ?? [])) {
      const data = `${root}data/`;
      found.push(downloadFrom(`${zip}/${root}`, entries.flatMap((entry) => (entry.name.startsWith(data) ? [{ ...entry, path: entry.name.slice(data.length) }] : []))));
    }
  }
  if (found.length > 1) refuse(`the delivery holds ${found.length} X archives (${found.map((download) => download.where).join(", ")}); one delivery is one download`);
  return found[0];
}

function downloadFrom(where: string, members: Data[]): Download {
  const parts: Part[] = [];
  let account: Part | undefined;
  const media = new Map<string, Map<string, Data[]>>();
  const folders = new Set(Object.values(FILES).flatMap((read) => read.media ?? []));
  for (const member of members) {
    const slash = member.path.indexOf("/");
    if (slash < 0) {
      const match = DATA_FILE.exec(member.path);
      if (match === null) continue;
      const part: Part = { ...member, data: match[1]!, part: match[2] === undefined ? 0 : Number(match[2]) };
      if (part.data === "account" && part.part === 0) account = part;
      else if (Object.hasOwn(FILES, part.data)) parts.push(part);
      continue;
    }
    const folder = member.path.slice(0, slash);
    const name = member.path.slice(slash + 1);
    const dash = name.indexOf("-");
    if (!folders.has(folder) || name.includes("/") || dash <= 0) continue;
    let byId = media.get(folder);
    if (byId === undefined) media.set(folder, (byId = new Map()));
    const id = name.slice(0, dash);
    const list = byId.get(id);
    if (list === undefined) byId.set(id, [member]);
    else list.push(member);
  }
  const order = Object.keys(FILES);
  parts.sort((left, right) => order.indexOf(left.data) - order.indexOf(right.data) || left.part - right.part);
  for (const byId of media.values()) for (const list of byId.values()) list.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { where, account, parts, media };
}

async function checkAccount(download: Download, account: string): Promise<void> {
  const part = download.account ?? refuse(`${download.where} holds no data/account.js; the archive's account cannot be checked`);
  const elements: Json[] = [];
  for await (const element of jsonElements(assigned(part), part.where)) elements.push(readJson(utf8(element.read(), part.where), part.where));
  const stated = elements.length === 1 && isObject(elements[0]) && isObject(elements[0].account) ? elements[0].account.accountId : undefined;
  if (typeof stated !== "string") refuse(`${part.where} does not state one account's accountId`);
  if (stated !== account) refuse(`${part.where} names account ${stated}, not the source's account ${account}`);
}

async function* assigned(part: Part): AsyncGenerator<Buffer> {
  let head: Buffer | undefined = Buffer.alloc(0);
  for await (const chunk of part.chunks()) {
    if (head === undefined) {
      yield chunk;
      continue;
    }
    head = Buffer.concat([head, chunk]);
    const equals = head.indexOf(0x3d);
    if (equals < 0) {
      if (head.length > PREFIX_LIMIT) break;
      continue;
    }
    const match = ASSIGNMENT.exec(head.subarray(0, equals).toString("latin1"));
    const name = part.data.replaceAll("-", "_");
    if (match === null || match[1] !== name || Number(match[2]) !== part.part) refuse(`${part.where} does not begin window.YTD.${name}.part${part.part} =`);
    const rest = head.subarray(equals + 1);
    head = undefined;
    if (rest.length > 0) yield rest;
  }
  if (head !== undefined) refuse(`${part.where} does not begin window.YTD.<name>.part<n> =`);
}

async function itemRow(kind: string, member: string, value: Json, locator: string, media: Map<string, Data[]> | undefined): Promise<ReaderOutput> {
  if (!isObject(value) || !isObject(value[member])) refuse(`${locator} is not {${member}: {…}}`);
  checkOwn(value, ["type", "blobs"], locator);
  const item = value[member] as JsonObject;
  const key = kind === POST ? item.id_str : item.tweetId;
  if (typeof key !== "string" || !ID.test(key)) refuse(`${locator} states no ${kind === POST ? "id_str" : "tweetId"} of digits`);
  const time = kind === POST ? postTime(item.created_at, locator) : undefined;
  return row(kind, key, { type: TYPES[kind]!, ...value }, time, kind === POST ? await mediaOf(media, key) : [], locator);
}

function messageRows(value: Json, locator: string, media: Map<string, Data[]> | undefined): AsyncGenerator<ReaderOutput> {
  const conversation = isObject(value) ? value.dmConversation : undefined;
  if (!isObject(conversation) || typeof conversation.conversationId !== "string" || !Array.isArray(conversation.messages)) {
    refuse(`${locator} is not {dmConversation: {conversationId, messages: […]}}`);
  }
  const conversationId = conversation.conversationId;
  const at = (index: number) => `${locator}.dmConversation.messages[${index}]`;
  return each(conversation.messages.entries(), ([index]) => at(index), async ([index, element]) => {
    const where = at(index);
    if (!isObject(element)) refuse(`${where} is not an object`);
    const stated = MESSAGES.find((member) => element[member] !== undefined);
    if (stated === undefined) return [];
    checkOwn(element, ["type", "blobs", "conversationId"], where);
    const message = element[stated];
    if (!isObject(message) || typeof message.id !== "string" || !ID.test(message.id)) refuse(`${where}.${stated} states no id of digits`);
    if (typeof message.createdAt !== "string") refuse(`${where}.${stated} states no createdAt`);
    return [row(MSG, message.id, { type: TYPES[MSG]!, conversationId, ...element }, instantOf(message.createdAt, "rfc3339", where), await mediaOf(media, message.id), where)];
  });
}

function checkOwn(value: JsonObject, members: readonly string[], locator: string): void {
  for (const member of members) if (Object.hasOwn(value, member)) refuse(`${locator} states a ${member} member, which this connector does not read`);
}

function postTime(value: Json | undefined, locator: string): Instant {
  if (typeof value !== "string") refuse(`${locator} states no created_at`);
  return instantOf(value, "mbox", `${locator} created_at`);
}

interface Linked {
  listed: JsonObject;
  streamed?: Streamed;
}

async function mediaOf(media: Map<string, Data[]> | undefined, id: string): Promise<Linked[]> {
  const out: Linked[] = [];
  for (const member of media?.get(id) ?? []) {
    const file = member.path.slice(member.path.indexOf("/") + 1);
    const media_type = MEDIA[extension(file)] ?? "application/octet-stream";
    const held = await stored(member);
    out.push({ listed: { hash: held.hash, bytes: held.size, media_type, role: "attachment", file }, ...(held.streamed === undefined ? {} : { streamed: held.streamed }) });
  }
  return out;
}

function row(kind: string, key: string, content: JsonObject, time: Instant | undefined, linked: Linked[], locator: string): ReaderOutput {
  if (linked.length > 0) content.blobs = linked.map((blob) => blob.listed);
  const streamed = linked.flatMap((blob) => (blob.streamed === undefined ? [] : [blob.streamed]));
  return {
    kind,
    key,
    content,
    ...(time === undefined ? {} : { time }),
    ...(linked.length === 0 ? {} : { blobs: linked.map((blob) => blob.listed.hash as string), media: Object.fromEntries(linked.map((blob) => [blob.listed.hash as string, blob.listed.media_type as string])) }),
    ...(streamed.length === 0 ? {} : { streamed }),
    locator,
  };
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
