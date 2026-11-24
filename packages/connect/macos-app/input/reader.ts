import { basicInstant, deliveredLines, each, instantOf, isObject, lineText, parseLine, refuse, span, unitOf, type Guard, type Instant, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { Ranks } from "../../shared/lanes.js";

export const INPUT = "input";

export const INPUT_EVENT_NAMES: ReadonlySet<string> = new Set([
  "key_down", "key_up", "flags", "down", "up", "move", "scroll", "activate",
  "log_start", "log_stop", "secure_input", "locked", "tap_restart", "layout", "site_unknown",
]);

const REQUIRED = ["type", "until", "layout", "apps", "events"];
const OPTIONAL = ["sites", "activity", "lost", "recovered"];
const LOG_FILE = /\.jsonl$/u;
const OPEN_LOG = "current.jsonl";
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const chunk: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const problems: string[] = [];
  for (const member of REQUIRED) if (!(member in content)) problems.push(`${member} is missing`);
  for (const member of Object.keys(content)) {
    if (!REQUIRED.includes(member) && !OPTIONAL.includes(member)) problems.push(`${member} is not a chunk member`);
  }
  if (content.type !== "input.chunk") problems.push("type must be input.chunk");
  if (typeof content.until !== "string" || !UTC_MS.test(content.until)) problems.push("until must be an RFC 3339 UTC instant with milliseconds");
  if (typeof content.layout !== "string") problems.push("layout must be a string");
  const apps = content.apps;
  const appCount = Array.isArray(apps) && apps.every((app) => typeof app === "string") ? apps.length : -1;
  if (appCount < 0) problems.push("apps must be an array of strings");
  if (content.sites !== undefined && !(Array.isArray(content.sites) && content.sites.every((site) => typeof site === "string"))) {
    problems.push("sites must be an array of strings");
  }
  if (!Array.isArray(content.events)) problems.push("events must be an array");
  else {
    for (const [index, event] of content.events.entries()) {
      if (!isObject(event)) {
        problems.push(`events[${index}] must be an object`);
        continue;
      }
      if (typeof event.e !== "string" || !INPUT_EVENT_NAMES.has(event.e)) problems.push(`events[${index}] type ${JSON.stringify(event.e ?? null)} is outside the closed list`);
      for (const member of ["app", "syn"]) {
        if (member in event && !indexInto(event[member], appCount)) problems.push(`events[${index}] ${member} is not an index into apps`);
      }
    }
  }
  if (content.activity !== undefined) {
    if (!Array.isArray(content.activity)) problems.push("activity must be an array");
    else {
      for (const [index, entry] of content.activity.entries()) {
        if (!isObject(entry) || !indexInto(entry.app, appCount)) problems.push(`activity[${index}] app is not an index into apps`);
      }
    }
  }
  if (content.lost !== undefined && !(Number.isSafeInteger(content.lost) && (content.lost as number) >= 0)) problems.push("lost must be a non-negative integer");
  if (content.recovered !== undefined && typeof content.recovered !== "boolean") problems.push("recovered must be a boolean");
  return problems;
};

export const inputEvents: Reader = {
  name: "input-events",
  kinds: { [INPUT]: chunk },
  async *read(delivery, files) {
    const device = unitOf(delivery.source);
    const ranks = new Ranks();
    const logs = delivery.files.filter((file) => LOG_FILE.test(file.path) && file.path !== OPEN_LOG);
    logs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const log of logs) {
      yield* each(deliveredLines(files, log), (part) => part.where, ({ bytes, line, where }): ReaderOutput[] => {
        const locator = `${log.path}:line ${line}`;
        const value = parseLine(lineText(bytes, where), locator);
        const { at, ...rest } = value;
        if (typeof at !== "string" || !UTC_MS.test(at)) refuse(`${locator} at must be an RFC 3339 UTC instant with milliseconds`);
        const start = instantOf(at, "rfc3339", locator);
        const key = ranks.key(basicInstant(start.start_ms));
        return [{ kind: INPUT, key, content: { type: "input.chunk", ...rest }, time: lasting(start, rest), device, locator }];
      });
    }
  },
};

function lasting(start: Instant, rest: JsonObject): Instant {
  const until = rest.until;
  if (typeof until !== "string" || !UTC_MS.test(until)) return start;
  const end = instantOf(until, "rfc3339", "until");
  return end.start_ms > start.start_ms ? span(start, end) : start;
}

function indexInto(value: unknown, length: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < length;
}
