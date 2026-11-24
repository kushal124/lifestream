import type { Level } from "@lifestreamprotocol/core";
import type { Access, HomeAccount } from "@lifestreamprotocol/privacy";
import type { Principal } from "./principals.js";

export const ASK_READER = "ask";
export const CHAT_NAME = "Chat";

export function fullAccess(hide: Level): Access {
  return { allow: [{ reach: { all: true, but: [] }, window: null, until_ms: null }], items: [], not: [], only: [], window: null, hide, shown: [] };
}

export function defaultAccess(): Access {
  return { allow: [{ reach: { all: true, but: ["health", "money"] }, window: null, until_ms: null }], items: [], not: [], only: [], window: null, hide: "names", shown: [] };
}

export function emptyAccess(): Access {
  return { allow: [], items: [], not: [], only: [], window: null, hide: "names", shown: [] };
}

export function noAccess(reader: string): Access {
  return reader === ASK_READER ? { ...emptyAccess(), hide: "none" } : emptyAccess();
}

export type Existing = HomeAccount;

export function reachesOf(access: Access, existing: readonly Existing[], now_ms: number): string[] {
  const reached = new Set<string>();
  for (const allow of access.allow) {
    if (allow.until_ms !== null && now_ms >= allow.until_ms) continue;
    const reach = allow.reach;
    for (const { account, category } of existing) {
      if ("all" in reach ? reach.but.length === 0 || (category !== null && !reach.but.includes(category))
        : "type" in reach ? category === reach.type && !reach.but.includes(account)
          : reach.account === account) reached.add(account);
    }
  }
  return [...reached].sort();
}

export type Reader =
  | { readonly kind: "person" }
  | { readonly kind: "agent"; readonly reader: string }
  | { readonly kind: "ask"; readonly reader: typeof ASK_READER };

export function readerOf(pass: Principal, chat: string | null): Reader {
  if (pass.kind === "agent") return { kind: "agent", reader: pass.id };
  return pass.turn !== undefined || chat !== null ? { kind: "ask", reader: ASK_READER } : { kind: "person" };
}
