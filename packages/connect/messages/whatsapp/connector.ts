import { works, type Connector } from "@lifestreamprotocol/connect/sdk";
import { store } from "./store.js";

export const whatsapp = {
  id: "whatsapp", product: "whatsapp", name: "WhatsApp", vendor: "meta", type: "messages", noun: ["message", "messages"], counts: ["msg"], mirror: true,
  gives: "Every chat and group, with its media and calls.",
  records: "Every chat and group with its messages and media, and calls.",
  sources: [
    { id: "whatsapp:<account>:<unit>", read: "whatsapp-db", arrives: "mac", feeders: ["whatsapp-mac"] },
    { id: "whatsapp:<account>:<unit>", read: "whatsapp-db", arrives: "upload" },
  ],
  fields: {
    groups_archived: { kind: "choice", home: true, label: "Archived groups are quiet", options: { on: "Yes", off: "No" }, default: "on",
      about: "Even if you wrote there recently." },
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
  backfill: { about: "Collects the chats that were on your Mac before you connected WhatsApp." },
  processing: { photos: works.CHAT_PHOTOS, voice: works.CHAT_VOICE },
  mac: { app: "WhatsApp", grants: ["fullDiskAccess"], store },
  before: ["Install WhatsApp for Mac and link it to your phone."],
  open: { chat: { url: "https://wa.me/{chat|before:@}" } },
  export: { kind: "iphone-backup", product: { id: "whatsapp", name: "WhatsApp" }, recognise: ["**/whatsapp/chats.sqlite", "**/whatsapp/calls.sqlite", "**/whatsapp/media.json"] },
} satisfies Connector;
