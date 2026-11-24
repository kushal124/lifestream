import { archive, consuming, each, instantOf, isObject, jsonElements, readJson, refuse, Refused, sourceName, stored, utf8, wholeFiles, checks, type ImportStated, type Instant, type Json, type JsonObject, type Member, type Reader, type ReaderOutput, type Streamed } from "@lifestreamprotocol/connect/sdk";

const { conversationRefused, uuid } = checks;

export const CHATGPT_CONNECTOR = "chatgpt-export";
const SHARD = /^conversations-\d+\.json$/u;
const USER = /(?:^|\/)user\.json$/u;
const PAGE = "chat.html";

export const chatgptConnector: Reader = {
  name: CHATGPT_CONNECTOR,
  kinds: { msg: msgGuard, chat: shellGuard },
  account: { file: "**/user.json", json: (stated) => (isObject(stated) && typeof stated.id === "string" ? stated.id : undefined) },
  states: chatgptStated,
  async *read(delivery, files) {
    let whole: Member[] = [];
    yield* consuming(delivery, archive(delivery, files, async function* (members) {
      const exported = chatgptExport(members, `delivery ${delivery.id}`);
      const { user } = exported;
      const stated = readJson(utf8(user.bytes(), user.where), user.where);
      const account = isObject(stated) ? stated.id : undefined;
      if (typeof account !== "string" || !/^user-[^:]+$/u.test(account)) refuse("user.json states no user-… account id");
      if (sourceName(delivery.source).account !== account) refuse(`user.json states ${account}; the source is ${delivery.source}`);
      if (exported.shards.length === 0) refuse(`delivery ${delivery.id} holds no conversations-NNN.json shard`);
      const read = new Set<Member>([user, ...exported.shards, ...exported.page]);
      yield* each(exported.shards, (shard) => exported.label(shard), (shard) => each(jsonElements(shard.chunks(), `${exported.label(shard)}:conversations`), (part) => part.where, async function* ({ read: bytes, where }) {
        const value = readJson(utf8(bytes(), where), where);
        if (!isObject(value)) refuse(`${where}: a conversation must be an object`);
        if (Object.keys(value).length === 0) return;
        for (const row of chatgptConversation(value, where, exported.media)) yield await storedBlobs(row, exported.held, read);
      }));
      whole = wholeFiles(members, (member) => read.has(member));
    }), () => whole);
  },
};

interface ChatgptExport {
  readonly user: Member;
  readonly shards: readonly Member[];
  readonly page: readonly Member[];
  readonly media: ChatgptMedia;
  readonly held: ReadonlyMap<string, Member>;
  label(member: Member): string;
}

function chatgptExport(members: readonly Member[], what: string): ChatgptExport {
  const users = members.filter((member) => USER.test(member.name));
  if (users.length === 0) refuse(`${what} holds no user.json`);
  if (users.length > 1) refuse(`${what} holds ${users.length} user.json: one export at a time`);
  const user = users[0]!;
  const root = user.name.slice(0, -"user.json".length);
  const top = members.filter((member) => member.name.startsWith(root) && !member.name.slice(root.length).includes("/") && (member.zip ?? "") === (user.zip ?? ""));
  const named = (member: Member) => member.name.slice(root.length);
  const label = (member: Member) => (member.zip === undefined ? member.where : `${member.zip}:${member.name}`);
  const shards = top.filter((member) => SHARD.test(named(member))).sort((left, right) => (named(left) < named(right) ? -1 : 1));
  const held = new Map(top.map((member) => [member.where, member]));
  return { user, shards, page: top.filter((member) => named(member) === PAGE), media: chatgptMedia(top.map((member) => ({ path: named(member), blob: member.where }))), held, label };
}

async function storedBlobs(row: ReaderOutput, held: ReadonlyMap<string, Member>, read: Set<Member>): Promise<ReaderOutput> {
  if (row.blobs === undefined) return row;
  const blobs: string[] = [];
  const streamed: Streamed[] = [];
  for (const where of row.blobs) {
    const member = held.get(where)!;
    read.add(member);
    const blob = await stored(member);
    if (blobs.includes(blob.hash)) continue;
    blobs.push(blob.hash);
    if (blob.streamed !== undefined) streamed.push(blob.streamed);
  }
  return { ...row, blobs, ...(streamed.length === 0 ? {} : { streamed }) };
}

async function chatgptStated(members: readonly Member[]): Promise<ImportStated> {
  const exported = chatgptExport(members, "This ChatGPT export");
  let newest: number | undefined;
  for (const shard of exported.shards) {
    try {
      for await (const { read, where } of jsonElements(shard.chunks(), `${exported.label(shard)}:conversations`)) {
        const value = readJson(utf8(read(), where), where);
        const time = isObject(value) ? conversationTime(value) : undefined;
        if (time !== undefined) newest = Math.max(newest ?? time.start_ms, time.start_ms);
      }
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
    }
  }
  return newest === undefined ? {} : { time_ms: newest };
}

function conversationTime(value: JsonObject): Instant | undefined {
  const created = unixSeconds(value.create_time);
  const updated = unixSeconds(value.update_time);
  return updated === undefined ? created : created !== undefined && updated.start_ms < created.start_ms ? created : updated;
}

export function* chatgptConversation(value: JsonObject, where: string, media: ChatgptMedia, tree: "export" | "browser" = "export"): Generator<ReaderOutput> {
  const id = tree === "export" ? value.id : value.conversation_id;
  if (typeof id !== "string" || !uuid(id)) refuse(`${where}: the conversation id must be a provider UUID`);
  if (!isObject(value.mapping)) refuse(`${where}: mapping must be an object`);
  const mapping = value.mapping;
  const created = unixSeconds(value.create_time);
  const time = conversationTime(value);
  if (time === undefined) refuse(`${where}: the conversation states neither a numeric update_time nor create_time`);
  for (const [nodeId, raw] of Object.entries(mapping)) {
    const at = `${where}.mapping[${JSON.stringify(nodeId)}]`;
    if (nodeId.length === 0) refuse(`${at}: a node id must be non-empty`);
    if (!isObject(raw)) refuse(`${at}: a node must be an object`);
    if (raw.id !== nodeId) refuse(`${at}: the mapping key and node.id differ`);
    if (raw.message === undefined || raw.message === null) {
      if (raw.parent !== null && tree === "export") refuse(`${at}: a message-less node must be a root (parent null)`);
      continue;
    }
    if (!uuid(nodeId)) refuse(`${at}: a message-bearing node id must be a provider UUID`);
    if (!isObject(raw.message)) refuse(`${at}.message must be an object`);
    const stamp = unixSeconds(raw.message.create_time) ??
      (tree === "browser" ? ancestorTime(mapping, raw) ?? created : undefined) ??
      refuse(`${at}.message.create_time must be numeric`);
    const content: JsonObject = { type: "chatgpt.msg", conversation_id: id, node: raw };
    const blobs = chatgptBlobs(content, media, at);
    yield {
      kind: "msg",
      key: `${id}:${nodeId}`,
      content,
      time: stamp,
      ...(blobs.length === 0 ? {} : { blobs }),
      locator: at,
    };
  }
  const shell: JsonObject = { type: "chatgpt.shell", conversation_id: id };
  for (const name of ["title", "update_time", "current_node"]) if (name in value) shell[name] = value[name]!;
  yield { kind: "chat", key: id, content: shell, time, locator: where };
}

function ancestorTime(mapping: JsonObject, node: JsonObject): Instant | undefined {
  const walked = new Set<string>();
  for (let parent = node.parent; typeof parent === "string" && !walked.has(parent); ) {
    walked.add(parent);
    const above = mapping[parent];
    if (!isObject(above)) return undefined;
    const stamp = isObject(above.message) ? unixSeconds(above.message.create_time) : undefined;
    if (stamp !== undefined) return stamp;
    parent = above.parent;
  }
  return undefined;
}

function unixSeconds(value: Json | undefined): Instant | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value))) return undefined;
  return instantOf(value, "unix-s", "create_time");
}

export type ChatgptMedia = Map<string, { path: string; blob: string }[]>;

export function chatgptMedia(files: readonly { path: string; blob: string }[]): ChatgptMedia {
  const out: ChatgptMedia = new Map();
  for (const file of files) {
    if (file.path.includes("/")) continue;
    const id = /^(file_[0-9a-f]+)\.dat$/iu.exec(file.path)?.[1] ?? /^(file-[A-Za-z0-9]+)(?:[-.]|$)/u.exec(file.path)?.[1];
    if (id === undefined) continue;
    out.set(id, [...(out.get(id) ?? []), file]);
  }
  return out;
}

export function chatgptMediaIds(record: Json): string[] {
  const node = isObject(record) ? record.node : undefined;
  const message = isObject(node) ? node.message : undefined;
  if (!isObject(message)) return [];
  const ids = new Set<string>();
  const content = message.content;
  if (isObject(content) && Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (!isObject(part) || typeof part.asset_pointer !== "string") continue;
      const named = /^[a-z][a-z0-9+.-]*:\/\/(.+)$/iu.exec(part.asset_pointer)?.[1] ?? part.asset_pointer;
      const fragment = /#(file[-_][A-Za-z0-9]+)$/u.exec(named)?.[1];
      ids.add(fragment ?? named);
    }
  }
  const metadata = message.metadata;
  if (isObject(metadata) && Array.isArray(metadata.attachments)) {
    for (const attachment of metadata.attachments) {
      if (isObject(attachment) && typeof attachment.id === "string" && attachment.id.length > 0) ids.add(attachment.id);
    }
  }
  return [...ids].sort();
}

export function chatgptBlobs(record: Json, media: ChatgptMedia, where = "a message"): string[] {
  const blobs: string[] = [];
  for (const id of chatgptMediaIds(record)) {
    const found = media.get(id) ?? [];
    if (found.length > 1) refuse(`${where}: media ${id} matches ${found.length} files in the export`);
    if (found.length === 1 && !blobs.includes(found[0]!.blob)) blobs.push(found[0]!.blob);
  }
  return blobs;
}


function msgGuard(content: Json): string[] {
  if (!isObject(content)) return ["content is not an object"];
  const violations = conversationRefused(content, ["conversation_id", "node", "type"], "chatgpt.msg", "conversation_id");
  if (!isObject(content.node)) violations.push("node is not an object");
  return violations;
}

function shellGuard(content: Json): string[] {
  if (!isObject(content)) return ["content is not an object"];
  const allowed = ["conversation_id", "current_node", "title", "type", "update_time"];
  const extra = Object.keys(content).filter((name) => !allowed.includes(name));
  const violations = extra.length === 0 ? [] : [`members ${extra.join(", ")} are not a shell's`];
  if (content.type !== "chatgpt.shell") violations.push("type is not chatgpt.shell");
  if (typeof content.conversation_id !== "string" || !uuid(content.conversation_id)) violations.push("conversation_id is not a provider UUID");
  return violations;
}
