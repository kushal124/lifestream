import { isObject, type Guard, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { instantMs } from "./delivery.js";
import { exact } from "./statements.js";

export { exact };

/** A blob's name: `sha256:` and 64 lowercase hex digits. */
export const SHA256 = /^sha256:[0-9a-f]{64}$/u;
/** A UUID written with its hyphens, in either case. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether text is a UUID written with its hyphens. */
export const uuid = (value: string): boolean => UUID.test(value);

/** What is wrong with a conversation row's content, one line each: members other than those listed, a `type` other than the one given, or an id member that is no UUID. */
export function conversationRefused(content: JsonObject, members: string[], type: string, id: string): string[] {
  const names = Object.keys(content).sort();
  const violations = names.join(",") === members.join(",") ? [] : [`members are ${names.join(", ")}, not ${members.join(", ")}`];
  if (content.type !== type) violations.push(`type is not ${type}`);
  const stated = content[id];
  if (typeof stated !== "string" || !uuid(stated)) violations.push(`${id} is not a provider UUID`);
  return violations;
}

const LINE = ["schema_version", "domain", "kind", "sequence", "observed_at", "captured", "process_instance_id", "payload"];

/** Whether a value is the envelope the phone app writes each line in, with exactly its members and its clock readings. */
export function lineEnvelope(value: Json | undefined): value is JsonObject {
  if (!isObject(value)) return false;
  return value.boot_id === undefined
    ? exact(value, LINE, ["capture_replay_key"]) && exact(value.captured, ["wall_rfc3339", "wall_unix_seconds", "elapsed_seconds"])
    : exact(value, [...LINE, "boot_id"], ["capture_replay_key"]) && exact(value.captured, ["wall_rfc3339", "wall_unix_seconds", "monotonic_seconds"]);
}

/** Whether a value is an RFC 3339 instant. */
export const rfc3339 = (value: Json | undefined): value is string => typeof value === "string" && instantMs(value) !== undefined;
/** Whether a value is an RFC 3339 instant written in UTC, ending `Z` or `+00:00`. */
export const utc = (value: Json | undefined): value is string => rfc3339(value) && /(?:Z|\+00:00)$/u.test(value);
/** Whether a value is a string that is not empty. */
export const text = (value: Json | undefined): value is string => typeof value === "string" && value.length > 0;
/** Whether a value is a whole number of one or more. */
export const positive = (value: Json | undefined): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
/** Whether a value is a whole number of zero or more. */
export const count = (value: Json | undefined): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Whether a value is a finite number. */
export const finite = (value: Json | undefined): value is number => typeof value === "number" && Number.isFinite(value);
/** Whether a value is one of the strings given. */
export const oneOf = (value: Json | undefined, values: readonly string[]): boolean => typeof value === "string" && values.includes(value);

/** A guard from a check that returns the one thing wrong with a content, or undefined when nothing is. */
export function guard(check: (content: Json) => string | undefined): Guard {
  return (content) => {
    const violation = check(content);
    return violation === undefined ? [] : [violation];
  };
}

/** The words of the first pair whose test returns false, or undefined when every test holds. */
export function first(checks: [string, () => boolean][]): string | undefined {
  for (const [violation, ok] of checks) if (!ok()) return violation;
  return undefined;
}
