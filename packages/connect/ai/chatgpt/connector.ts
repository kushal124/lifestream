import { works, type Connector } from "@lifestreamprotocol/connect/sdk";

export const chatgpt = {
  id: "chatgpt", product: "chatgpt", name: "ChatGPT", vendor: "openai", type: "ai", noun: ["message", "messages"], counts: ["msg"],
  gives: "Your conversations and their files.",
  records: "Your conversations and their files, as chatgpt.com shows them.",
  sources: [
    { id: "chatgpt:<account>:browser", read: "chatgpt-browser", arrives: "chrome" },
    { id: "chatgpt:<account>:export", read: "chatgpt-export", arrives: "upload" },
  ],
  acquirers: ["chatgpt-browser"],
  refresh: { default: "30m", min: "5m" },
  backfill: { pace: { default: "2m", min: "30s", max: "1h" }, unit: ["conversation", "conversations"],
    about: "Catches up on older conversations." },
  processing: { chats: works.AI_CHATS },
  chrome: { origin: "https://chatgpt.com", probe: { url: "/api/auth/session", has: "accessToken", who: { url: "/backend-api/me", id: "id", email: "email", bearer: true } } },
  export: {
    recognise: ["**/user.json", "**/chat.html"],
    takes: "ChatGPT takes a few minutes",
    wait: "A few minutes",
    guide: [
      { title: "Ask ChatGPT", words: "In ChatGPT, open Settings › Data controls and press Export data.", open: { label: "Open ChatGPT", url: "https://chatgpt.com/#settings/DataControls" } },
      { title: "Wait for the email", words: "Download the zip from ChatGPT’s email within 24 hours." },
    ],
    leaves: ["**/chat.html"],
  },
  open: { record: { kinds: ["msg", "chat"], url: "https://chatgpt.com/c/{key|before::}" } },
} satisfies Connector;
