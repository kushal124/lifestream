import { archive, checks, consuming, each, instantOf, isObject, jsonElements, readJson, refuse, Refused, refusedFile, sourceName, tryInstant, utf8, wholeFiles, type ImportStated, type Instant, type Json, type JsonObject, type Member, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

const { conversationRefused, uuid } = checks;

export const CLAUDE_CONNECTOR = "claude-export";
const MANIFEST = /(?:^|\/)manifest-[^/]*\.json$/u;
const USERS = /(?:^|\/)users\.json$/u;
const CONVERSATIONS = /(?:^|\/)conversations\.json$/u;
const ZIPPED = /\.zip$/iu;
const MESSAGE_MEMBERS = ["text", "content", "sender", "attachments", "files", "parent_message_uuid"];

const label = (member: Member): string => (member.zip === undefined ? member.where : `${member.zip}:${member.name}`);
const byLabel = (left: Member, right: Member): number => (label(left) < label(right) ? -1 : 1);

export const claudeConnector: Reader = {
  name: CLAUDE_CONNECTOR,
  kinds: { msg: msgGuard, chat: shellGuard },
  account: [
    { file: "**/users.json", json: (stated) => (Array.isArray(stated) && stated.length === 1 && isObject(stated[0]) && typeof stated[0].uuid === "string" ? stated[0].uuid : undefined) },
    { file: "**/conversations.json", at: "[*]", json: (stated) => (isObject(stated) && isObject(stated.account) && typeof stated.account.uuid === "string" ? stated.account.uuid : undefined) },
  ],
  states: claudeStated,
  async *read(delivery, files) {
    const account = sourceName(delivery.source).account;
    let whole: Member[] = [];
    yield* consuming(delivery, archive(delivery, files, async function* (members) {
      for (const member of members) if (member.zip === undefined && ZIPPED.test(member.name)) yield refusedFile(member.where, "named .zip, its first bytes are not a zip's: it didn't open, download it again");
      for (const users of members.filter((member) => USERS.test(member.name)).sort(byLabel)) {
        const where = label(users);
        const stated = readJson(utf8(users.bytes(), where), where);
        const user = Array.isArray(stated) && stated.length === 1 && isObject(stated[0]) ? stated[0].uuid : undefined;
        if (typeof user !== "string" || !uuid(user)) refuse(`${where} must hold one user with a provider UUID`);
        if (user !== account) refuse(`${where} states ${user}; the source is ${delivery.source}`);
      }
      const parts = members.filter((member) => CONVERSATIONS.test(member.name)).sort(byLabel);
      if (parts.length === 0) refuse(`delivery ${delivery.id} holds no conversations.json`);
      const owners = new Map<string, string>();
      yield* each(parts, label, (part) => each(jsonElements(part.chunks(), `${label(part)}:conversations`), (element) => element.where, ({ read, where: at }) => {
        const value = readJson(utf8(read(), at), at);
        if (!isObject(value)) refuse(`${at}: a conversation must be an object`);
        return conversation(value, at, label(part), account, owners);
      }));
      whole = wholeFiles(members, (member) => USERS.test(member.name) || CONVERSATIONS.test(member.name));
    }), () => whole);
  },
};

async function claudeStated(members: readonly Member[]): Promise<ImportStated> {
  const manifests = members.filter((member) => MANIFEST.test(member.name));
  if (manifests.length === 1) {
    const where = label(manifests[0]!);
    const manifest = await unlessRefused(async () => readJson(utf8(manifests[0]!.bytes(), where), where));
    const made = isObject(manifest) && typeof manifest.created_at === "string" ? tryInstant(manifest.created_at, "rfc3339") : undefined;
    if (made !== undefined) return { time_ms: made.start_ms };
  }
  let newest: number | undefined;
  for (const part of members.filter((member) => CONVERSATIONS.test(member.name))) {
    await unlessRefused(async () => {
      for await (const { read, where } of jsonElements(part.chunks(), `${label(part)}:conversations`)) {
        const value = readJson(utf8(read(), where), where);
        const time = isObject(value) ? shellTime(value) : undefined;
        if (time !== undefined) newest = Math.max(newest ?? time.start_ms, time.start_ms);
      }
    });
  }
  return newest === undefined ? {} : { time_ms: newest };
}

async function unlessRefused<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Refused) return undefined;
    throw error;
  }
}

function shellTime(value: JsonObject): Instant | undefined {
  const created = typeof value.created_at === "string" ? tryInstant(value.created_at, "rfc3339") : undefined;
  const updated = typeof value.updated_at === "string" ? tryInstant(value.updated_at, "rfc3339") : undefined;
  if (created === undefined || updated === undefined) return undefined;
  return updated.start_ms < created.start_ms ? created : updated;
}

function* conversation(value: JsonObject, where: string, file: string, account: string, owners: Map<string, string>): Generator<ReaderOutput> {
  const id = value.uuid;
  if (typeof id !== "string" || !uuid(id)) refuse(`${where}.uuid must be a provider UUID`);
  const owner = owners.get(id);
  if (owner !== undefined && owner !== file) refuse(`${where}: conversation ${id} is also in ${owner}; the export's files must be disjoint`);
  owners.set(id, file);
  const stated = isObject(value.account) ? value.account.uuid : undefined;
  if (stated !== account) refuse(`${where} states account ${JSON.stringify(stated)}; the source is claude:${account}:cloud`);
  yield* claudeConversation(value, id, where);
}

export function* claudeConversation(value: JsonObject, id: string, where: string): Generator<ReaderOutput> {
  for (const member of ["name", "summary"]) if (!(member in value)) refuse(`${where} states no ${member}`);
  const createdText = timestamp(value.created_at, `${where}.created_at`);
  const updatedText = timestamp(value.updated_at, `${where}.updated_at`);
  if (!Array.isArray(value.chat_messages)) refuse(`${where}.chat_messages must be an array`);
  for (const [index, raw] of value.chat_messages.entries()) {
    const at = `${where}.chat_messages[${index}]`;
    if (!isObject(raw)) refuse(`${at}: a message must be an object`);
    const message = raw.uuid;
    if (typeof message !== "string" || !uuid(message)) refuse(`${at}.uuid must be a provider UUID`);
    const created = stamp(timestamp(raw.created_at, `${at}.created_at`), `${at}.created_at`);
    timestamp(raw.updated_at, `${at}.updated_at`);
    for (const member of MESSAGE_MEMBERS) if (!(member in raw)) refuse(`${at} states no ${member}`);
    const parent = raw.parent_message_uuid;
    if (parent !== null && (typeof parent !== "string" || !uuid(parent))) refuse(`${at}.parent_message_uuid must be null or a provider UUID`);
    yield { kind: "msg", key: `${id}:${message}`, content: { type: "claude.msg", conversation_uuid: id, message: withoutNestedUuids(raw) }, time: created, locator: at };
  }
  const created = stamp(createdText, `${where}.created_at`);
  const updated = stamp(updatedText, `${where}.updated_at`);
  yield {
    kind: "chat",
    key: id,
    content: { type: "claude.shell", conversation_uuid: id, name: value.name!, summary: value.summary!, created_at: createdText, updated_at: updatedText },
    time: updated.start_ms < created.start_ms ? created : updated,
    locator: where,
  };
}

function withoutNestedUuids(message: JsonObject): JsonObject {
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((block) => {
      if (!isObject(block) || !Array.isArray(block.content)) return block;
      return {
        ...block,
        content: block.content.map((nested) => {
          if (!isObject(nested)) return nested;
          const { uuid: _, ...kept } = nested;
          return kept;
        }),
      };
    }),
  };
}

function timestamp(value: Json | undefined, where: string): string {
  if (typeof value !== "string") refuse(`${where} must be a full RFC 3339 instant`);
  return value;
}

function stamp(value: string, where: string): Instant {
  return instantOf(value, "rfc3339", where);
}


function msgGuard(content: Json): string[] {
  if (!isObject(content)) return ["content is not an object"];
  const violations = conversationRefused(content, ["conversation_uuid", "message", "type"], "claude.msg", "conversation_uuid");
  if (!isObject(content.message)) violations.push("message is not an object");
  return violations;
}

function shellGuard(content: Json): string[] {
  if (!isObject(content)) return ["content is not an object"];
  const violations = conversationRefused(content, ["conversation_uuid", "created_at", "name", "summary", "type", "updated_at"], "claude.shell", "conversation_uuid");
  for (const name of ["created_at", "updated_at"]) if (typeof content[name] !== "string") violations.push(`${name} is not text`);
  return violations;
}
