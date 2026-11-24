import { carriesNothing, checks, each, isObject, readJson, refuse, utf8, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { claudeConnector, claudeConversation } from "./reader.js";

const { uuid } = checks;

export const CLAUDE_BROWSER_CONNECTOR = "claude-browser";
const READ = /^conversations\/([^/]+)\.(messages|text)\.json$/u;

export const claudeBrowserConnector: Reader = {
  name: CLAUDE_BROWSER_CONNECTOR,
  kinds: claudeConnector.kinds,
  async *read(delivery, files) {
    if (carriesNothing(delivery)) return;
    const object = (path: string): JsonObject => {
      const file = delivery.files.find((held) => held.path === path) ?? refuse(`delivery ${delivery.id} holds no ${path}`);
      const value = readJson(utf8(files.bytes(file.blob), path), path);
      return isObject(value) ? value : refuse(`${path} must hold an object`);
    };
    const account = object("account.json").uuid;
    if (typeof account !== "string" || !uuid(account)) refuse("account.json states no account UUID");
    if (delivery.source !== `claude:${account}:browser`) refuse(`account.json states ${account}; the source is ${delivery.source}`);
    const reads = new Map<string, Set<string>>();
    for (const file of delivery.files) {
      const match = READ.exec(file.path);
      if (match !== null) reads.set(match[1]!, (reads.get(match[1]!) ?? new Set()).add(match[2]!));
    }
    yield* each([...reads].sort(([left], [right]) => left < right ? -1 : 1), ([id]) => `conversations/${id}`, ([id, kinds]) => {
      if (!uuid(id)) refuse(`conversations/${id}: a conversation is named by its provider UUID`);
      if (kinds.size !== 2) refuse(`conversation ${id} is one read of two; both are needed`);
      const where = `conversations/${id}`;
      return claudeBrowserConversation(id, object(`${where}.messages.json`), object(`${where}.text.json`), where);
    });
  },
};

export function* claudeBrowserConversation(id: string, rendered: JsonObject, plain: JsonObject, where: string): Generator<ReaderOutput> {
  if (rendered.uuid !== id || plain.uuid !== id) refuse(`${where}: a read holds another conversation`);
  yield* claudeConversation({ ...rendered, chat_messages: merged(rendered.chat_messages, plain.chat_messages, where) }, id, where);
}

function merged(rendered: Json | undefined, plain: Json | undefined, where: string): JsonObject[] {
  if (!Array.isArray(rendered) || !Array.isArray(plain)) return refuse(`${where}: both reads must hold chat_messages`);
  const blocks = new Map<string, JsonObject>();
  for (const [index, message] of rendered.entries()) {
    if (!isObject(message) || typeof message.uuid !== "string") return refuse(`${where}.chat_messages[${index}]: a message must be an object with a uuid`);
    blocks.set(message.uuid, message);
  }
  const messages = plain.map((message, index) => {
    const at = `${where}.chat_messages[${index}]`;
    if (!isObject(message) || typeof message.uuid !== "string") return refuse(`${at}: a message must be an object with a uuid`);
    if (typeof message.text !== "string") return refuse(`${at}: the plain read states no text for it`);
    const both = blocks.get(message.uuid);
    blocks.delete(message.uuid);
    const kept = both === undefined ? { content: null, ...message } : { ...both, text: message.text };
    return { ...kept, ...("parent_message_uuid" in kept ? {} : { parent_message_uuid: null }) };
  });
  if (blocks.size > 0) refuse(`${where}: the rendered read holds ${[...blocks.keys()].join(", ")}, which the plain read does not`);
  return messages;
}
