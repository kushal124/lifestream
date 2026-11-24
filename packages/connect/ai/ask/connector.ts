import { works, type Connector } from "@lifestreamprotocol/connect/sdk";

export const ask = {
  id: "ask", product: "ask", name: "Ask", vendor: "lifestream", mentions: false, type: "ai", noun: ["message", "messages"], counts: ["msg"],
  records: "Each question you ask and its answer, with what it cited.",
  sources: [{ id: "ask:local:<home>", read: "ask-home", arrives: "owner" }],
  processing: { chats: works.AI_CHATS, voice: works.ASK_VOICE },
} satisfies Connector;
