import { instantMs, isObject, refuse, unitOf, type Guard, type Reader } from "@lifestreamprotocol/connect/sdk";
import { AGENT_TURN, lineTime, sessionRows, type SessionLine } from "../../shared/sessions.js";

export const CODEX = "codex-sessions";
export const CODEX_LINE = "codex.line";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const CODEX_LOG = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_(${UUID}))?\\.jsonl$`, "u");

const turn: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const problems: string[] = [];
  if (Object.keys(content).sort().join(",") !== "line,type") problems.push("content must be exactly type and line");
  if (content.type !== CODEX_LINE) problems.push(`type must be ${CODEX_LINE}`);
  const line = content.line;
  if (!isObject(line)) return [...problems, "line must be the log's line, an object"];
  if (typeof line.type !== "string") problems.push("line.type must be a string");
  if (typeof line.timestamp !== "string" || instantMs(line.timestamp) === undefined) problems.push("line.timestamp must be an RFC 3339 instant");
  return problems;
};

export const codexSessions: Reader = {
  name: CODEX,
  kinds: { [AGENT_TURN]: turn },
  read(delivery, files) {
    const device = unitOf(delivery.source);
    return sessionRows(delivery, files, { log: CODEX_LOG, started }, ({ part, line, value, locator }) => {
      const [, id, segment] = CODEX_LOG.exec(part.file)!;
      const time = lineTime(value.timestamp);
      return [{
        kind: AGENT_TURN,
        key: `${segment === undefined ? id : `${id}_${segment}`}:${line}`,
        content: { type: CODEX_LINE, line: value },
        ...(time === undefined ? {} : { time }),
        device,
        locator,
      }];
    });
  },
};

function started({ part, value, locator }: SessionLine): true {
  const id = CODEX_LOG.exec(part.file)![1]!;
  const payload = value.payload;
  if (value.type !== "session_meta" || !isObject(payload)) refuse(`${locator} must be the session's meta`);
  if (payload.id !== id) refuse(`${locator} states session ${JSON.stringify(payload.id)}; the log's name states ${id}`);
  if (payload.originator === "codex_exec" || payload.source === "exec" || payload.thread_source === "automation") {
    refuse(`${locator}: a program started this session (originator ${JSON.stringify(payload.originator)}, source ${JSON.stringify(payload.source)}, thread_source ${JSON.stringify(payload.thread_source ?? null)}); it is never shipped`);
  }
  return true;
}
