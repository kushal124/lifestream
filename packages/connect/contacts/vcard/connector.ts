import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const appleContacts = {
  id: "apple-contacts", product: "apple-contacts", name: "Contacts", vendor: "apple", type: "contacts", products: { "google-contacts": { name: "Google Contacts", vendor: "google" } }, icon: "people", noun: ["contact", "contacts"], mirror: true,
  gives: "Every contact card, so names show instead of numbers.",
  records: "Every contact card, whole, with its photo.",
  sources: [
    { id: "apple-contacts:<account>:<unit>", read: "contacts-ios-bundle", arrives: "phone" },
    { id: "apple-contacts:<account>:export", read: "contacts-vcard", arrives: "upload" },
    { id: "google-contacts:<account>:export", read: "contacts-vcard", arrives: "upload" },
  ],
  phone: {
    grants: ["contacts"], misses: "the names of the people in them", domain: "contacts", restore: "contacts",
    why: "Every contact card, with its photo. So Lifestream knows who's who in your messages, calls and photos.",
  },
  export: { recognise: ["Takeout/Contacts/*/*.vcf"], product: { id: "contacts", name: "Contacts" } },
} satisfies Connector;
