import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@lifestreamprotocol/core";
import type { Fixture } from "../../../test/drive.js";

export const CONTACTS_SOURCE = "apple-contacts:person-a@example.com:iphone-aa01";
export const EXPORT_FACTS: JsonObject = { exported_at: "2026-09-07T03:00:00+05:30", fetched_at: "2026-09-07T04:00:00Z" };

const crlf = (lines: string[]): string => lines.map((line) => `${line}\r\n`).join("");

export const CARD_B = crlf(["BEGIN:VCARD", "VERSION:3.0", "N:B;Person;;;", "FN:Person B", "TEL;type=CELL;type=VOICE;type=pref:+15550000002", "EMAIL;type=INTERNET;type=HOME;type=pref:person-b@example.com", "END:VCARD"]);
export const CARD_C = crlf(["BEGIN:VCARD", "VERSION:3.0", "N:C;Person;;;", "FN:Person Ç", "NOTE:a folded note that runs", " on to the next line", "END:VCARD"]);
export const CARD_D = "BEGIN:VCARD\nVERSION:3.0\nFN:Person D\nTEL:+15550000004\nEND:VCARD\n";

export function vcardBytes(cards: string[] = [CARD_B, CARD_C, CARD_D]): Buffer {
  return Buffer.from(cards.join("\r\n"), "utf8");
}

export const EMPTY_LIST = Buffer.alloc(0);
export const BLANK_LIST = Buffer.from("\r\n \r\n");

export function takeoutContacts(): Record<string, Buffer> {
  return {
    "Takeout/Contacts/My Contacts/My Contacts.vcf": vcardBytes(),
    "Takeout/Contacts/Starred/Starred.vcf": EMPTY_LIST,
    "Takeout/Contacts/Coworkers/Coworkers.vcf": BLANK_LIST,
  };
}

export const fixture: Fixture = (folder) => {
  const exports: Record<string, { bytes: Buffer; alone: string[] }> = {
    "contacts.vcf": { bytes: vcardBytes([CARD_B, CARD_C]), alone: [CARD_B, CARD_C] },
    "more.vcf": { bytes: vcardBytes([CARD_D]), alone: [CARD_D] },
    "empty.vcf": { bytes: EMPTY_LIST, alone: [] },
    "blank.vcf": { bytes: BLANK_LIST, alone: [] },
  };
  for (const [path, { bytes }] of Object.entries(exports)) writeFileSync(join(folder, path), bytes);
  const heads = (cards: string[]) => ({ alone: cards.map((card) => `contact ${createHash("sha256").update(card).digest("hex")}`) });
  return { source: CONTACTS_SOURCE, facts: EXPORT_FACTS, files: Object.fromEntries(Object.entries(exports).map(([path, { alone }]) => [path, heads(alone)])) };
};
