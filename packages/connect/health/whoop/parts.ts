import { instantOf, isObject, refuse, rfc3339, tryInstant, type Instant, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";

export const SHA256 = /^[0-9a-f]{64}$/u;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE = /^[1-9]\d*$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function everyUserId(value: Json, account: string, where: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => everyUserId(item, account, `${where}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [name, item] of Object.entries(value)) {
    if (name === "user_id" || name === "userId") {
      const stated = userId(item, `${where}.${name}`);
      if (stated !== account) refuse(`${where}.${name} states user_id ${stated}, expected ${account}`);
    }
    everyUserId(item, account, `${where}.${name}`);
  }
}

export function userId(value: Json | undefined, where: string): string {
  const spelled = typeof value === "number" ? String(value) : value;
  if (typeof spelled !== "string" || !POSITIVE.test(spelled) || !Number.isSafeInteger(Number(spelled))) refuse(`${where} must be a positive whole number`);
  return spelled;
}

export function integerText(value: Json | undefined, where: string): string {
  const spelled = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  if (!POSITIVE.test(spelled)) refuse(`${where} must be a positive whole number`);
  return spelled;
}

export function at(value: Json | undefined, where: string, offset?: string): Instant {
  return instantOf(timestamp(value, where), "rfc3339", where, offset === undefined ? {} : { offset });
}

export function timestamp(value: Json | undefined, where: string): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) refuse(`${where} must be a full RFC 3339 instant`);
  return value;
}

export function date(value: Json | undefined, where: string): string {
  if (typeof value !== "string" || !DATE.test(value) || tryInstant(value, "date") === undefined) refuse(`${where} must be a calendar date YYYY-MM-DD`);
  return value;
}

export function count(value: Json | undefined, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse(`${where} must be a whole number`);
  return value;
}

export function text(value: Json | undefined, where: string): string {
  if (typeof value !== "string" || value.length === 0) refuse(`${where} must be non-empty text`);
  return value;
}

export function object(value: Json | undefined, where: string): JsonObject {
  if (!isObject(value)) refuse(`${where} must be an object`);
  return value;
}

export function member(value: JsonObject, name: string, where: string): JsonObject {
  return object(value[name], `${where}.${name}`);
}

export function url(value: string, where: string): URL {
  try {
    return new URL(value);
  } catch {
    return refuse(`${where} is not a URL`);
  }
}

export function apiUrl(value: string, where: string): URL {
  const parsed = url(value, where);
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.prod.whoop.com") refuse(`${where} is not WHOOP's API host`);
  return parsed;
}

export function basic(ms: number): string {
  return rfc3339(ms).replace(/[-:]/gu, "");
}

export function cycleWindow(url: URL, where: string): { start: number; end: number } {
  const start = at(url.searchParams.get("startTime") ?? undefined, `${where} startTime`).start_ms;
  const end = at(url.searchParams.get("endTime") ?? undefined, `${where} endTime`).start_ms;
  if (end < start) refuse(`${where} ends before it starts`);
  return { start, end };
}

export function covers(window: { start: number; end: number }, span: { start: number; end: number }): boolean {
  return span.start >= window.start && span.end <= window.end;
}
