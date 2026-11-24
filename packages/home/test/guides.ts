import type { Type } from "@lifestreamprotocol/core";
import { viewOf, type EditorAccount } from "../access-edit.js";
import { defaultAccess } from "../access.js";
import { guidesOf, type GuideReader, type Guides } from "../agent-guides.js";
import type { DeviceKind } from "../devices.js";
import { PAGES } from "../pages.js";

export const GUIDE_NOW = Date.UTC(2026, 10, 14, 9, 0);

const account = (id: string, category: Type, name: string): EditorAccount => ({ account: id, category, name, line: null, screen: false });

export const GUIDE_ACCOUNTS: readonly EditorAccount[] = [
  account("gmail:person-a@example.com", "mail", "Gmail"),
  account("whatsapp:15550000001", "messages", "WhatsApp"),
  account("whoop:person-a@example.com", "health", "WHOOP"),
];

export const GUIDE_READERS: readonly GuideReader[] = [
  { id: "ask", kind: "chat", via: null, from: null, app: null, made_ms: 0, disconnected_ms: null },
  { id: "p-00000001", kind: "agent", via: "sign-in", from: "chatgpt.com", app: null, made_ms: GUIDE_NOW - 3_600_000, disconnected_ms: null },
  { id: "p-00000002", kind: "agent", via: "sign-in", from: "chatgpt.com", app: null, made_ms: GUIDE_NOW - 60_000, disconnected_ms: null },
  { id: "p-00000003", kind: "agent", via: "sign-in", from: "claude.ai", app: null, made_ms: GUIDE_NOW - 7_200_000, disconnected_ms: GUIDE_NOW - 3_600_000 },
  { id: "p-00000004", kind: "agent", via: "pass", from: null, app: null, made_ms: GUIDE_NOW - 60_000, disconnected_ms: null },
];

export function guidesBody(device: DeviceKind | null, readers: readonly GuideReader[] = GUIDE_READERS): Guides {
  const access = defaultAccess();
  return guidesOf(readers, device, (name) => ({ access, view: viewOf(access, null, { accounts: GUIDE_ACCOUNTS }, GUIDE_NOW, { name, zone: "UTC", chat: false }) }));
}

export function guidesAnswer(device: DeviceKind | null): unknown {
  return PAGES.agentGuides.shape.parse({ position: "1:0", today: "2026-11-14", ...guidesBody(device) });
}
