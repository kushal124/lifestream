import { works, type Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const imessage = {
  id: "imessage", product: "imessage", name: "iMessage", vendor: "apple", type: "messages", starter: true, noun: ["message", "messages"], counts: ["msg"], mirror: true,
  gives: "Every message and attachment, with who sent it.",
  records: "Every message and attachment, who sent each, and group members.",
  sources: [
    { id: "imessage:<account>:<unit>", read: "imessage-db", arrives: "mac", feeders: ["imessage-mac"] },
    { id: "imessage:<account>:<unit>", read: "imessage-db", arrives: "upload" },
  ],
  fields: {
    groups_quiet_after: {
      kind: "choice", home: true, label: "Quiet after", default: "90d",
      about: "A group goes quiet once you have written nothing in it for this long.",
      options: { "30d": "30 days", "90d": "90 days", "180d": "6 months", "365d": "1 year", never: "Never" },
    },
    groups_talk: {
      kind: "choice", home: true, label: "Count group messages", default: "joined",
      options: { joined: "Groups, on days you write there", all: "Every group", none: "No groups" },
    },
  },
  backfill: { about: "Catches up on messages from before you connected." },
  processing: { photos: works.CHAT_PHOTOS, voice: works.CHAT_VOICE },
  mac: { app: "Messages", grants: ["fullDiskAccess"], store },
  before: ["Turn on Messages in iCloud on your iPhone and your Mac."],
  open: { chat: { url: "imessage:{chat}" } },
  export: { kind: "iphone-backup", product: { id: "imessage", name: "iMessage" }, recognise: ["**/imessage/messages.db", "**/imessage/attachments.json"] },
} satisfies Connector;
