import type { Json } from "@lifestreamprotocol/core";
import { SESSIONS_UNIT } from "../../test/sessions.js";

export const SOURCE = `claude-code:local:${SESSIONS_UNIT}`;
export const SESSION = "00000000-0000-4000-8000-0000000000a1";
export const LOG = `${SESSION}.jsonl`;
export const uuid = (n: number): string => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function typed(n: number, extra: Record<string, Json> = {}): string {
  return JSON.stringify({
    parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: "Synthetic prompt." }, uuid: uuid(n),
    timestamp: "2026-10-01T09:00:01.000Z", promptSource: "typed", origin: { kind: "human" }, userType: "external", entrypoint: "cli",
    cwd: "/Users/person-a/project", sessionId: SESSION, version: "2.1.290", gitBranch: "main", ...extra,
  });
}
