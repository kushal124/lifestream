import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { feeds, type Files } from "@lifestreamprotocol/connect/sdk";

export const ACCOUNT = "person-z@example.com";
export const SOURCE = `example-chat:${ACCOUNT}:export`;
export const PARTNER = "12345";

export const DOWNLOAD = {
  account: ACCOUNT,
  messages: [
    { id: "c-1", chat: PARTNER, from: PARTNER, text: "Are we still on for lunch?", at: "2026-09-28T09:00:00.000Z" },
    { id: "c-2", chat: PARTNER, from: "me", text: "Yes, at noon", at: "2026-09-28T09:02:00.000Z" },
  ],
};

export const files = (): Files => ({ "messages.json": JSON.stringify(DOWNLOAD) });

export const fixture = (folder: string) => {
  writeFileSync(join(folder, "messages.json"), JSON.stringify(DOWNLOAD));
  return { source: SOURCE, facts: feeds(SOURCE, "example-chat"), files: { "messages.json": "trust" as const }, heads: [`msg ${PARTNER}:c-1`, `msg ${PARTNER}:c-2`] };
};

export const fixtures = { "example-chat": fixture };
