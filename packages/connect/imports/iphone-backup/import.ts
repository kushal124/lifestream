import { isObject } from "@lifestreamprotocol/core";
import { store as whatsappStore } from "../../messages/whatsapp/store.js";
import type { Member } from "../../shared/members.js";
import { Refused, refuse } from "../../shared/refused.js";
import type { Import, ImportDevice } from "../index.js";

export const NOT_A_BACKUP = "This isn’t an iPhone backup. Choose the backup folder from Finder.";

const STORES = { imessage: "apple", whatsapp: "whatsapp", "apple-calls": "apple" } as const;
export type BackupStore = keyof typeof STORES;

export interface BackupJson {
  readonly accounts: { readonly apple: readonly string[]; readonly whatsapp: readonly string[] };
  readonly device: string;
  readonly encrypted: boolean;
  readonly ios: string;
  readonly last_backup: string;
  readonly model: string;
  readonly model_name: string;
  readonly serial4?: string;
  readonly store: BackupStore;
}

const KEYS = new Set(["accounts", "device", "encrypted", "ios", "last_backup", "model", "model_name", "serial4", "store"]);
const JSON_BYTES = 64 * 1024;
const DEVICE = /^[0-9a-f]{16}$/u;
const SERIAL4 = /^[0-9a-f]{4}$/u;
const IOS = /^\d+(?:\.\d+){0,2}$/u;
const MODEL = /^[A-Za-z]+\d+,\d+$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const APPLE_ID = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/u;

function instantOf(text: string): number | null {
  if (!INSTANT.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && new Date(ms).toISOString() === text.replace("Z", ".000Z") ? ms : null;
}

export function whatsappAccount(jid: string): string | null {
  const rule: { holds?: string; before?: string; digits?: true } = whatsappStore.account;
  let text = jid;
  if (rule.holds !== undefined && !text.includes(rule.holds)) return null;
  if (rule.before !== undefined) {
    if (!text.endsWith(rule.before)) return null;
    text = text.slice(0, -rule.before.length);
  }
  if (rule.digits === true && !/^[0-9]+$/u.test(text)) return null;
  return text === "" || text.includes("/") ? null : text;
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((each, at) => typeof each === "string" && (at === 0 || (value[at - 1] as string) < each));

export function backupJson(value: unknown): BackupJson | { refused: string } {
  if (!isObject(value)) return { refused: "it is not an object" };
  const extra = Object.keys(value).find((key) => !KEYS.has(key));
  if (extra !== undefined) return { refused: `it holds ${extra}, no key of backup.json` };
  const { accounts, device, encrypted, ios, last_backup, model, model_name, serial4, store } = value;
  if (!isObject(accounts) || Object.keys(accounts).sort().join() !== "apple,whatsapp" || !strings(accounts.apple) || !strings(accounts.whatsapp)) {
    return { refused: "accounts is not an apple and a whatsapp list, each sorted and distinct" };
  }
  const apple = accounts.apple.find((each) => !APPLE_ID.test(each));
  if (apple !== undefined) return { refused: `${JSON.stringify(apple)} is no Apple ID as an address in lower case` };
  const jid = accounts.whatsapp.find((each) => whatsappAccount(each) === null);
  if (jid !== undefined) return { refused: `${JSON.stringify(jid)} is no WhatsApp account's JID` };
  if (typeof device !== "string" || !DEVICE.test(device)) return { refused: "device is not 16 lower-case hex" };
  if (typeof encrypted !== "boolean") return { refused: "encrypted is not true or false" };
  if (typeof ios !== "string" || !IOS.test(ios)) return { refused: "ios is no iOS version" };
  if (typeof last_backup !== "string" || instantOf(last_backup) === null) return { refused: "last_backup is no UTC second" };
  if (typeof model !== "string" || !MODEL.test(model)) return { refused: "model is no hardware id" };
  if (typeof model_name !== "string" || model_name.trim() === "" || model_name !== model_name.trim()) return { refused: "model_name is no name" };
  if (serial4 !== undefined && (typeof serial4 !== "string" || !SERIAL4.test(serial4))) return { refused: "serial4 is not 4 lower-case hex" };
  if (typeof store !== "string" || !(store in STORES)) return { refused: "store is none of imessage, whatsapp, apple-calls" };
  return value as unknown as BackupJson;
}

function backupOf(members: readonly Member[]): BackupJson {
  const found = members.filter((member) => /(?:^|\/)backup\.json$/u.test(member.name));
  if (found.length !== 1) refuse(NOT_A_BACKUP);
  const member = found[0]!;
  if (member.size > JSON_BYTES) refuse(NOT_A_BACKUP);
  const text = member.bytes(JSON_BYTES).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    refuse(NOT_A_BACKUP);
  }
  const backup = backupJson(value);
  if ("refused" in backup || (member.name !== `${backup.store}/backup.json` && !member.name.endsWith(`/${backup.store}/backup.json`))) refuse(NOT_A_BACKUP);
  return backup;
}

function backupOrNull(members: readonly Member[]): BackupJson | null {
  try {
    return backupOf(members);
  } catch (error) {
    if (error instanceof Refused) return null;
    throw error;
  }
}

export function namedOf(backup: BackupJson): string[] {
  return accountsOf(backup, STORES[backup.store]);
}

function accountsOf(backup: BackupJson, domain: "apple" | "whatsapp"): string[] {
  const named = domain === "apple" ? backup.accounts.apple : backup.accounts.whatsapp.map((jid) => whatsappAccount(jid)!);
  return [...new Set(named)].sort();
}

export function stampOf(backup: BackupJson): string {
  return `${backup.device}:${backup.last_backup}:${STORES[backup.store]}`;
}

export const iphoneBackup: Import = {
  kind: "iphone-backup",
  name: "iPhone backup",
  of: (connector) => connector.export !== undefined && "kind" in connector.export && connector.export.kind === "iphone-backup",
  icon: "phone-backup",
  takes: "Finder takes an hour or more",
  wait: "An hour or more",
  file: "backup",
  ask: "Whose Apple ID is on this iPhone?",
  accounts: "apple",
  asks: { meta: "Whose WhatsApp is on this iPhone?" },
  guide: [
    { title: "Plug in your iPhone", words: "Plug your iPhone into this Mac. In Finder, choose it in the sidebar." },
    { title: "Choose an encrypted backup", words: "Under Backups, choose Back up all of the data on your iPhone to this Mac and tick Encrypt local backup. Set a password: calls are in the backup only when it's encrypted." },
    { title: "Back up", words: "Press Back Up Now. It takes an hour or more; the phone can stay in use." },
  ],

  async named(members) {
    try {
      return { named: namedOf(backupOf(members)) };
    } catch (error) {
      if (error instanceof Refused) return { refused: error.message };
      throw error;
    }
  },

  async stamp(_file, members) {
    const backup = backupOrNull(members);
    return backup === null ? null : stampOf(backup);
  },

  async states(_file, members) {
    return { time_ms: instantOf(backupOf(members).last_backup)! };
  },

  async device(members): Promise<ImportDevice | null> {
    const backup = backupOrNull(members);
    return backup === null ? null : {
      device: backup.device, accounts: [...new Set([...accountsOf(backup, "apple"), ...accountsOf(backup, "whatsapp")])].sort(),
      model: backup.model, model_name: backup.model_name, serial4: backup.serial4 ?? null,
    };
  },
};
