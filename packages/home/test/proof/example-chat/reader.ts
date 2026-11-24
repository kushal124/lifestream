import { archive, each, instantOf, isObject, readJson, refuse, sourceName, utf8, type Guard, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const MSG = "msg";
const FILE = "messages.json";

const msg: Guard = (content) =>
  isObject(content) && content.type === "example-chat.msg" && typeof content.chat === "string" && typeof content.from === "string" && typeof content.text === "string"
    ? [] : ["a message is { type: example-chat.msg, chat, from, text, … }"];

export const exampleChat: Reader = {
  name: "example-chat",
  account: { file: "**/messages.json", json: (json) => (isObject(json) && typeof json.account === "string" ? json.account : refuse("messages.json states no account")) },
  kinds: { [MSG]: msg },
  read: (delivery, files) => archive(delivery, files, async function* (members) {
    const found = members.filter((member) => member.name === FILE || member.name.endsWith(`/${FILE}`));
    if (found.length !== 1) refuse(found.length === 0 ? `the delivery carries no ${FILE}` : `the delivery carries ${found.length} ${FILE}`);
    const value = readJson(utf8(found[0]!.bytes(), found[0]!.where), found[0]!.where);
    if (!isObject(value) || !Array.isArray(value.messages)) refuse(`${FILE} is not { account, messages: [...] }`);
    if (value.account !== sourceName(delivery.source).account) refuse(`${FILE} is account ${String(value.account)}'s, not ${delivery.source}'s`);
    yield* each(value.messages, (_, index) => `${FILE} messages[${index}]`, (item): ReaderOutput[] => {
      if (!isObject(item) || typeof item.id !== "string" || typeof item.chat !== "string") refuse("a message states no id or chat");
      if (Object.hasOwn(item, "type")) refuse(`message ${item.id} states a member type, which is the content's own`);
      return [{ kind: MSG, key: `${item.chat}:${item.id}`, content: { type: "example-chat.msg", ...item }, time: instantOf(String(item.at), "rfc3339", `message ${item.id} at`), locator: found[0]!.where }];
    });
  }),
};
