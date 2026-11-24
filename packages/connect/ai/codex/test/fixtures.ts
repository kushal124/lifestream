import { SESSIONS_UNIT } from "../../test/sessions.js";

export const SOURCE = `codex:local:${SESSIONS_UNIT}`;
export const id = (n: string): string => `00000000-0000-7000-8000-0000000000${n}`;
export const PERSON = id("d1");
export const LOG = `rollout-2026-10-01T10-00-00-${PERSON}.jsonl`;

export function meta(payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-10-01T10:00:00.000Z", type: "session_meta",
    payload: { session_id: PERSON, id: PERSON, cwd: "/Users/person-a/project", originator: "Codex Desktop", source: "vscode", ...payload }, ordinal: 0,
  });
}
