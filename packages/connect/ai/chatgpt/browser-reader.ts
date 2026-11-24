import { carriesNothing, each, isObject, readJson, refuse, utf8, type Reader } from "@lifestreamprotocol/connect/sdk";
import { chatgptConnector, chatgptConversation, chatgptMedia } from "./reader.js";

export const CHATGPT_BROWSER_CONNECTOR = "chatgpt-browser";
const CONVERSATION = /^conversations\/([^/]+)\.json$/u;

export const chatgptBrowserConnector: Reader = {
  name: CHATGPT_BROWSER_CONNECTOR,
  kinds: chatgptConnector.kinds,
  async *read(delivery, files) {
    if (carriesNothing(delivery)) return;
    const me = delivery.files.find((file) => file.path === "me.json") ?? refuse(`delivery ${delivery.id} holds no me.json`);
    const stated = readJson(utf8(files.bytes(me.blob), "me.json"), "me.json");
    const account = isObject(stated) ? stated.id : undefined;
    if (typeof account !== "string" || !/^user-[^:]+$/u.test(account)) refuse("me.json states no user-… account id");
    if (delivery.source !== `chatgpt:${account}:browser`) refuse(`me.json states ${account}; the source is ${delivery.source}`);
    const media = chatgptMedia(delivery.files);
    const conversations = delivery.files.filter((file) => CONVERSATION.test(file.path)).sort((left, right) => left.path < right.path ? -1 : 1);
    yield* each(conversations, (file) => file.path, (file) => {
      const value = readJson(utf8(files.bytes(file.blob), file.path), file.path);
      if (!isObject(value)) refuse(`${file.path}: a conversation must be an object`);
      if (value.conversation_id !== CONVERSATION.exec(file.path)![1]) refuse(`${file.path} holds another conversation`);
      return chatgptConversation(value, file.path, media, "browser");
    });
  },
};
