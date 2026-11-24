import { isObject } from "./format.js";
import { instant, TimeError } from "./time.js";
import { canonicalEmail, canonicalJid, canonicalNetwork, canonicalPhone, compareHandles, handleFrom, handleId, type Handle, type HandleKind } from "./handles.js";
import type { Guard, Json, JsonObject } from "./types.js";

export const ENTITIES = ["person", "ai", "business", "bot"] as const;
export type Entity = (typeof ENTITIES)[number];

export interface PersonRecord {
  slug: string;
  name: string | null;
  full_name: string | null;
  show: "name" | "full_name";
  entity: Entity | null;
  relationship: string | null;
  hidden: boolean;
  me: boolean;
  anchor: Handle | null;
  handles: Handle[];
  excluded: Handle[];
  dismissed: string[];
  also_called: string[];
  merged_into: string | null;
}

export const MOST_CALLED = 12;
const CALLED_CHARACTERS = 60;
const CONTROL = /\p{Cc}/u;

export function foldName(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
}

export function calledName(text: string): string | null {
  const made = text.replace(/\s+/gu, " ").trim();
  const length = [...made].length;
  return length >= 1 && length <= CALLED_CHARACTERS && !CONTROL.test(made) ? made : null;
}

const RECORD = ["anchor", "dismissed", "entity", "excluded", "full_name", "handles", "hidden", "me", "merged_into", "name", "relationship", "show", "slug", "type"].join(",");
const BEFORE = [...RECORD.split(","), "photo"].sort().join(",");
const CALLED = "also_called";
const OLDER = ["excluded", "handles", "merged_into", "name", "slug", "type"].join(",");
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export function notASlug(what: string): string {
  return `${what} must be a person's slug: 1 to 64 lower-case letters, digits and dashes, the first no dash`;
}
const SUGGESTION = /^[0-9a-f]{16}$/u;
const KINDS: readonly HandleKind[] = ["phone", "email", "jid", "network"];
const OLDER_KINDS = ["name", "phone", "email", "jid", "contact"];
const SPELLING: Readonly<Record<HandleKind, (value: string) => string | null>> = { phone: canonicalPhone, email: canonicalEmail, jid: canonicalJid, network: canonicalNetwork };
const FACE_KEY = /^([0-9a-f]{64}):((?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*))$/u;

export function slugOf(name: string): string {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "").slice(0, 56).replace(/-+$/u, "");
  return SLUG.test(slug) ? slug : "person";
}

export const personRecordFaults: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const called = Object.hasOwn(content, CALLED);
  const members = Object.keys(content).filter((member) => member !== CALLED).sort().join(",");
  if (members === RECORD) return [...recordFaults(content), ...called ? calledFaults(content.also_called) : []];
  if (members === BEFORE && !called) {
    const faults = recordFaults(content);
    return content.photo === null || (typeof content.photo === "string" && isFaceKey(content.photo)) ? faults : [...faults, "photo must be null or a face key"];
  }
  if (members === OLDER && !called) return olderFaults(content);
  return [`content must hold exactly ${RECORD.split(",").join(", ")} and ${CALLED} if any (or the first without ${CALLED} and with photo, or the older ${OLDER.split(",").join(", ")})`];
};

export function readPersonRecord(content: Json): PersonRecord | null {
  if (personRecordFaults(content).length > 0) return null;
  const record = content as JsonObject;
  if (Object.hasOwn(record, "anchor")) {
    return {
      slug: record.slug as string, name: record.name as string | null, full_name: record.full_name as string | null,
      show: record.show as PersonRecord["show"], entity: record.entity as Entity | null, relationship: record.relationship as string | null,
      hidden: record.hidden as boolean, me: record.me as boolean,
      anchor: record.anchor === null ? null : handleFrom((record.anchor as JsonObject).kind as string, (record.anchor as JsonObject).value as string),
      handles: canonical(record.handles), excluded: canonical(record.excluded), dismissed: [...record.dismissed as string[]],
      also_called: [...record.also_called as string[] | undefined ?? []], merged_into: record.merged_into as string | null,
    };
  }
  const handles = canonical(record.handles);
  return {
    slug: record.slug as string, name: (record.name as string).trim(), full_name: null, show: "name", entity: null, relationship: null,
    hidden: false, me: false, anchor: handles[0] ?? null, handles, excluded: canonical(record.excluded), dismissed: [], also_called: [],
    merged_into: record.merged_into as string | null,
  };
}

function canonical(list: Json | undefined): Handle[] {
  const found = new Map<string, Handle>();
  for (const each of list as JsonObject[]) {
    const handle = typeof each.kind === "string" && typeof each.value === "string" ? handleFrom(each.kind, each.value) : null;
    if (handle !== null) found.set(handleId(handle), handle);
  }
  return [...found.values()].sort(compareHandles);
}

function recordFaults(content: JsonObject): string[] {
  const out: string[] = [];
  common(content, out);
  for (const member of ["name", "full_name", "relationship"]) {
    const value = content[member];
    if (value !== null && (typeof value !== "string" || value.trim() !== value || value === "")) out.push(`${member} must be null or text with no space around it`);
  }
  if (content.show !== "name" && content.show !== "full_name") out.push("show must be name or full_name");
  if (content.entity !== null && !ENTITIES.includes(content.entity as Entity)) out.push(`entity must be null or one of ${ENTITIES.join(", ")}`);
  for (const member of ["hidden", "me"]) if (typeof content[member] !== "boolean") out.push(`${member} must be true or false`);
  if (content.anchor !== null) out.push(...handleFaults(content.anchor as Json, "anchor"));
  out.push(...listFaults(content.handles, "handles", handleFaults, inCoreOrder), ...listFaults(content.excluded, "excluded", handleFaults, inCoreOrder));
  const dismissed = content.dismissed;
  if (!Array.isArray(dismissed) || !dismissed.every((id) => typeof id === "string" && SUGGESTION.test(id))) out.push("dismissed must be a list of suggestion ids, 16 lowercase hex");
  else if (!dismissed.every((id, index) => index === 0 || (dismissed[index - 1] as string) < (id as string))) out.push("dismissed must be sorted, without repeats");
  if (out.length > 0) return out;
  if (content.name === null && content.full_name === null && content.anchor === null && (content.handles as Json[]).length === 0) {
    out.push("a person carries a name, a full name or a handle (its anchor counts)");
  }
  const held = new Set([...(content.anchor === null ? [] : [content.anchor as Json]), ...content.handles as Json[]].map(heldId));
  if ((content.excluded as Json[]).some((handle) => held.has(heldId(handle)))) out.push("a handle is both held and excluded");
  return out;
}

function calledFaults(value: Json | undefined): string[] {
  if (!Array.isArray(value) || value.length > MOST_CALLED) return [`${CALLED} must be a list of at most ${MOST_CALLED} names`];
  const out: string[] = [];
  value.forEach((name, index) => {
    if (typeof name !== "string" || calledName(name) !== name) out.push(`${CALLED}[${index}] must be a name of 1 to ${CALLED_CHARACTERS} characters, one space between words, none around them, no control character`);
  });
  if (out.length > 0) return out;
  const names = value as string[];
  names.forEach((name, index) => {
    const previous = names[index - 1];
    if (previous === undefined) return;
    const [before, after] = [foldName(previous), foldName(name)];
    if (before === after) out.push(`${CALLED} must hold no two names that fold alike: ${JSON.stringify(previous)} and ${JSON.stringify(name)}`);
    else if (before > after) out.push(`${CALLED} must be sorted by each name's fold`);
  });
  return out;
}

function olderFaults(content: JsonObject): string[] {
  const out: string[] = [];
  common(content, out);
  if (typeof content.name !== "string" || content.name.length === 0) out.push("name must be non-empty");
  out.push(...listFaults(content.handles, "handles", olderHandleFaults, byKindString), ...listFaults(content.excluded, "excluded", olderHandleFaults, byKindString));
  if (Array.isArray(content.handles) && !content.handles.some((handle) => isObject(handle) && handle.kind === "name" && handle.value === content.name)) {
    out.push("handles must hold the name");
  }
  if (Array.isArray(content.handles) && Array.isArray(content.excluded)) {
    const excluded = new Set(content.excluded.map((handle) => (isObject(handle) ? `${handle.kind}\0${handle.value}` : "")));
    if (content.handles.some((handle) => isObject(handle) && excluded.has(`${handle.kind}\0${handle.value}`))) out.push("a handle is both held and excluded");
  }
  return out;
}

function common(content: JsonObject, out: string[]): void {
  if (content.type !== "people.person") out.push("type must be people.person");
  if (typeof content.slug !== "string" || !SLUG.test(content.slug)) out.push(notASlug("slug"));
  const merged = content.merged_into;
  if (merged !== null && (typeof merged !== "string" || !SLUG.test(merged))) out.push(`${notASlug("merged_into")}, or null`);
  else if (merged === content.slug) out.push("merged_into must be another person's slug");
}

function listFaults(value: Json | undefined, name: string, each: (handle: Json, where: string) => string[], before: Order): string[] {
  if (!Array.isArray(value)) return [`${name} must be a list`];
  const out = value.flatMap((handle, index) => each(handle, `${name}[${index}]`));
  if (out.length > 0) return out;
  value.forEach((handle, index) => {
    const previous = value[index - 1];
    if (isObject(previous) && isObject(handle) && !before.precedes(previous, handle)) out.push(`${name} must be sorted ${before.said}, without repeats`);
  });
  return out;
}

interface Order {
  readonly said: string;
  precedes(left: JsonObject, right: JsonObject): boolean;
}

const inCoreOrder: Order = {
  said: "as core orders handles (phones, addresses, WhatsApp ids, networks', each by value)",
  precedes: (left, right) => compareHandles(left as unknown as Handle, right as unknown as Handle) < 0,
};

const byKindString: Order = {
  said: "by kind, then value",
  precedes: (left, right) => String(left.kind) < String(right.kind) || (left.kind === right.kind && String(left.value) < String(right.value)),
};

export function parseFaceKey(key: string): { photo: string; box: [number, number, number, number] } | null {
  const match = FACE_KEY.exec(key);
  if (match === null) return null;
  const box = match[2]!.split(",").map(Number);
  return box.every(Number.isSafeInteger) ? { photo: match[1]!, box: box as [number, number, number, number] } : null;
}

export function isFaceKey(text: string): boolean {
  return parseFaceKey(text) !== null;
}

export const PROFILE_NETWORKS = ["instagram", "x", "linkedin", "facebook", "github", "site"] as const;
export type ProfileNetwork = (typeof PROFILE_NETWORKS)[number];
const LOWER_NETWORKS: ReadonlySet<string> = new Set(["instagram", "x", "github"]);
const PROFILE_CHARACTERS = 200;

export function profileFault(profile: Json): string | undefined {
  if (!isObject(profile) || Object.keys(profile).sort().join(",") !== "network,value") return "must hold exactly network and value";
  const { network, value } = profile;
  if (typeof network !== "string" || !(PROFILE_NETWORKS as readonly string[]).includes(network)) return `network must be one of ${PROFILE_NETWORKS.join(", ")}`;
  if (typeof value !== "string" || value === "" || value.length > PROFILE_CHARACTERS || /[\s?#]/u.test(value)) {
    return `value must be 1 to ${PROFILE_CHARACTERS} characters, no space, query or fragment`;
  }
  if (network !== "site") {
    if (value.includes("/")) return `a ${network} value is its handle, not a link`;
    return LOWER_NETWORKS.has(network) && value !== value.toLowerCase() ? `a ${network} handle is lower case` : undefined;
  }
  let host = "";
  try {
    host = new URL(`https://${value}`).hostname;
  } catch {
  }
  return host.includes(".") && (value === host || value.startsWith(`${host}/`)) ? undefined : "a site is an https page's host, lower case, and its path, no scheme or port";
}

function handleFaults(handle: Json, where: string): string[] {
  if (!isObject(handle) || Object.keys(handle).sort().join(",") !== "kind,value") return [`${where} must hold exactly kind and value`];
  if (!KINDS.includes(handle.kind as HandleKind)) return [`${where}.kind is not one of ${KINDS.join(", ")}`];
  return typeof handle.value === "string" && SPELLING[handle.kind as HandleKind](handle.value) === handle.value
    ? [] : [`${where}.value is not a ${handle.kind} in its canonical spelling`];
}

function olderHandleFaults(handle: Json, where: string): string[] {
  if (!isObject(handle) || Object.keys(handle).sort().join(",") !== "by,kind,since,value") return [`${where} must hold exactly kind, value, by and since`];
  const out: string[] = [];
  if (typeof handle.kind !== "string" || !OLDER_KINDS.includes(handle.kind)) out.push(`${where}.kind is not one of ${OLDER_KINDS.join(", ")}`);
  if (typeof handle.value !== "string" || handle.value.length === 0) out.push(`${where}.value must be non-empty`);
  if (handle.by !== "subject" && handle.by !== "agent") out.push(`${where}.by must be subject or agent`);
  if (typeof handle.since !== "string" || !isTime(handle.since)) out.push(`${where}.since must be a full RFC 3339 time`);
  return out;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;

function isTime(text: string): boolean {
  if (!RFC3339.test(text)) return false;
  try {
    instant(text, "rfc3339");
    return true;
  } catch (error) {
    if (error instanceof TimeError) return false;
    throw error;
  }
}

function heldId(handle: Json): string {
  const found = isObject(handle) && typeof handle.kind === "string" && typeof handle.value === "string" ? handleFrom(handle.kind, handle.value) : null;
  return found === null ? "" : handleId(found);
}
