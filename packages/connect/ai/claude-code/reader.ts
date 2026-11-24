import { instantMs, isObject, refuse, unitOf, type Guard, type Reader } from "@lifestreamprotocol/connect/sdk";
import { AGENT_TURN, lineTime, sessionRows, type SessionLine } from "../../shared/sessions.js";

export const CLAUDE_CODE = "claude-code-sessions";
export const CLAUDE_CODE_LINE = "claude-code.line";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const CLAUDE_CODE_LOG = new RegExp(`^${UUID}(?:/subagents/agent-[0-9a-z]+)?\\.jsonl$`, "u");
export const CLAUDE_CODE_FILE = new RegExp(`^${UUID}/(?:subagents/agent-[0-9a-z]+\\.meta\\.json|tool-results/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)$`, "u");
const NAMED = new RegExp(`/(${UUID}/tool-results/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*)`, "gu");
const PROGRAM = /^sdk-/u;

const turn: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const problems: string[] = [];
  if (Object.keys(content).sort().join(",") !== "line,type") problems.push("content must be exactly type and line");
  if (content.type !== CLAUDE_CODE_LINE) problems.push(`type must be ${CLAUDE_CODE_LINE}`);
  const line = content.line;
  if (!isObject(line)) return [...problems, "line must be the log's line, an object"];
  if (typeof line.uuid !== "string" || line.uuid === "") problems.push("line.uuid must be a non-empty string");
  if (typeof line.type !== "string") problems.push("line.type must be a string");
  if (typeof line.timestamp !== "string" || instantMs(line.timestamp) === undefined) problems.push("line.timestamp must be an RFC 3339 instant");
  return problems;
};

export const claudeCodeSessions: Reader = {
  name: CLAUDE_CODE,
  kinds: { [AGENT_TURN]: turn },
  read(delivery, files) {
    const device = unitOf(delivery.source);
    return sessionRows(delivery, files, { log: CLAUDE_CODE_LOG, file: CLAUDE_CODE_FILE, started }, ({ text, value, locator, files: wholes }) => {
      const uuid = value.uuid;
      if (uuid === undefined) return [];
      if (typeof uuid !== "string" || uuid === "") refuse(`${locator} states a uuid that is not a non-empty string`);
      const time = lineTime(value.timestamp);
      const blobs = named(text, wholes);
      return [{
        kind: AGENT_TURN,
        key: uuid,
        content: { type: CLAUDE_CODE_LINE, line: value },
        ...(time === undefined ? {} : { time }),
        ...(blobs.length === 0 ? {} : { blobs }),
        device,
        locator,
      }];
    });
  },
};

function started({ value, locator }: SessionLine): boolean {
  if (typeof value.entrypoint !== "string") return false;
  if (PROGRAM.test(value.entrypoint)) refuse(`${locator}: a program started this session (entrypoint ${value.entrypoint}); it is never shipped`);
  return true;
}

function named(text: string, wholes: ReadonlyMap<string, string>): string[] {
  const found = new Map<string, string>();
  for (const match of text.matchAll(NAMED)) {
    for (let name = match[1]!; name.includes("/tool-results/"); name = name.slice(0, -1)) {
      const blob = wholes.get(name);
      if (blob !== undefined) {
        found.set(name, blob);
        break;
      }
      if (!/[.]$/u.test(name)) break;
    }
  }
  return [...found.keys()].sort().map((name) => found.get(name)!);
}
