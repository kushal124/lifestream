import { works, type Connector } from "@lifestreamprotocol/connect/sdk";

export const exampleChat = {
  id: "example-chat", product: "example-chat", name: "Example Chat", vendor: "example", type: "messages", noun: ["message", "messages"],
  records: "Every message in your chats, with who sent it.",
  sources: [{ id: "example-chat:<account>:export", read: "example-chat", arrives: "upload" }],
  processing: { photos: works.CHAT_PHOTOS, voice: works.CHAT_VOICE },
  export: {
    recognise: ["**/messages.json"],
    guide: [
      { words: "In Example Chat, open Settings › Download and press Request download.", open: { label: "Open Example Chat", url: "https://chat.example.com/settings/download" } },
      { words: "Example Chat emails you a link. Download the zip." },
    ],
  },
  open: { chat: { url: "https://chat.example.com/c/{chat}" } },
} satisfies Connector;
