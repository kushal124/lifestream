import { works, type Connector } from "@lifestreamprotocol/connect/sdk";

export const claude = {
  id: "claude", product: "claude", name: "Claude", vendor: "anthropic", type: "ai", noun: ["message", "messages"], counts: ["msg"],
  gives: "Your conversations and their files.",
  records: "Your conversations and their files, as claude.ai shows them.",
  sources: [
    { id: "claude:<account>:browser", read: "claude-browser", arrives: "chrome" },
    { id: "claude:<account>:cloud", read: "claude-export", arrives: "upload" },
  ],
  acquirers: ["claude-browser"],
  refresh: { default: "30m", min: "5m" },
  backfill: { pace: { default: "2m", min: "30s", max: "1h" }, unit: ["conversation", "conversations"],
    about: "Catches up on older conversations." },
  processing: { chats: works.AI_CHATS },
  chrome: { origin: "https://claude.ai", probe: { url: "/api/account", has: "uuid", who: { id: "uuid", email: "email_address" } } },
  export: {
    recognise: ["**/conversations.json"],
    leaves: ["**/users.json", "**/login_history.json", "**/memories.json", "**/projects.json", "**/projects/**", "**/design_chats/**"],
    takes: "Claude takes a few minutes",
    wait: "A few minutes",
    guide: [
      { title: "Ask Claude", words: "In Claude, open Settings › Privacy and press Export data.", open: { label: "Open Claude", url: "https://claude.ai/settings/data-privacy-controls" } },
      { title: "Wait for the email", words: "When Claude emails you, download every file it offers." },
    ],
  },
  open: { record: { kinds: ["msg", "chat"], url: "https://claude.ai/chat/{key|before::}" } },
} satisfies Connector;
