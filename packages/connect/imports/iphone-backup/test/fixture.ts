import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseCalls, createCallHistory } from "../../../calls/apple/test/fixture.js";
import * as imessage from "../../../messages/imessage/imessage.test-support.js";
import * as whatsapp from "../../../messages/whatsapp/whatsapp.test-support.js";
import type { BackupJson, BackupStore } from "../import.js";

export const BACKUP: Omit<BackupJson, "store"> = {
  accounts: { apple: [imessage.ACCOUNT], whatsapp: [`${whatsapp.PHONE}@s.whatsapp.net`] },
  device: "3f9c0d1e2a4b5c6d",
  encrypted: true,
  ios: "27.0",
  last_backup: "2026-08-28T09:12:44Z",
  model: "iPhone18,1",
  model_name: "iPhone 17 Pro",
  serial4: "c0de",
};

export function backupJsonText(backup: BackupJson): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(sorted)
      : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]))
        : value;
  return JSON.stringify(sorted(backup));
}

export interface BackupFolders {
  readonly folders: Readonly<Record<BackupStore, string>>;
  readonly members: Readonly<Record<BackupStore, Readonly<Record<string, string>>>>;
  readonly media: { readonly imessage: string; readonly whatsapp: string };
}

export type BackupChange = { readonly [K in keyof typeof BACKUP]?: (typeof BACKUP)[K] | undefined };

export function writeBackupFolders(dir: string, backup: BackupChange = {}): BackupFolders {
  const stated = Object.fromEntries(Object.entries({ ...BACKUP, ...backup }).filter(([, value]) => value !== undefined)) as Omit<BackupJson, "store">;
  const stores = join(dir, ".stores");
  const messages = imessage.phoneStore(join(stores, "imessage"));
  const chats = whatsapp.macStore(join(stores, "whatsapp"));
  const out = (store: BackupStore) => {
    const folder = join(dir, store);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "backup.json"), backupJsonText({ ...stated, store }));
    return folder;
  };
  const folders = { imessage: out("imessage"), whatsapp: out("whatsapp"), "apple-calls": out("apple-calls") };
  const calls = join(folders["apple-calls"], "callhistory.sqlite");
  createCallHistory(calls, baseCalls());
  const members = {
    imessage: { ...imessage.sealSnapshot(messages, folders.imessage), "backup.json": join(folders.imessage, "backup.json") },
    whatsapp: { ...whatsapp.sealSnapshot(chats, folders.whatsapp), "backup.json": join(folders.whatsapp, "backup.json") },
    "apple-calls": { "callhistory.sqlite": calls, "backup.json": join(folders["apple-calls"], "backup.json") },
  };
  return { folders, members, media: { imessage: messages.attachments, whatsapp: chats.media } };
}
