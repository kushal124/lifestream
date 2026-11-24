import type { JsonObject } from "@lifestreamprotocol/core";
import type { SearchRefusal } from "./search-contract.js";
import type { Act } from "./streams-report.js";

export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly words: string,
    readonly retryAfter?: number,
    readonly extra: JsonObject = {},
  ) {
    super(`[${code}] ${words}`);
    this.name = "Refusal";
  }
}

export function refuse(status: number, code: string, message: string, retryAfter?: number, extra?: JsonObject): never {
  throw new Refusal(status, code, message, retryAfter, extra);
}

export const NOT_NOW = "NOT_NOW";
export const LOCKED = "LOCKED";
export const LOCKED_WORDS = "Lifestream is locked: unlock it on your Mac.";
export type Wait = "starting" | "needs" | "busy";
export interface Said {
  title: string;
  line: string | null;
  acts: Act[];
}
export const RETRY_S = 60;
export const RETRY_SOON_S = 5;
export const RETRY_FULL_S = 300;
export const UNWRITABLE = "Lifestream cannot write down what leaves it now, so nothing leaves: try again in a minute.";
export const STARTING = "Lifestream is starting: it answers in a moment.";
export const STARTING_SAID: Said = { title: "Lifestream is starting", line: null, acts: [] };
export const DOOR_AWAY = "Lifestream's door isn't answering: it asks again in a moment.";

export function starting(): never {
  return notNow("starting", STARTING, RETRY_SOON_S);
}

export function notNow(wait: Wait, words: string, retryAfter: number = RETRY_S, said?: Said): never {
  throw notNowRefusal(wait, words, retryAfter, said);
}

export function notNowRefusal(wait: Wait, words: string, retryAfter: number = RETRY_S, said?: Said): Refusal {
  return new Refusal(503, NOT_NOW, words, retryAfter, waitBody(wait, said));
}

export function waitBody(wait: Wait, said?: Said): { wait: Wait; title: string | null; line: string | null; acts: Act[] } {
  if (wait === "busy") return { wait, title: null, line: null, acts: [] };
  if (wait === "needs" && said === undefined) throw new Error("a wait on the person states its words");
  const { title, line, acts } = said ?? STARTING_SAID;
  return { wait, title, line, acts };
}

export const NOT_BEGUN = "Not saved: Lifestream is busy.";

export function notBegun(): Refusal {
  return notNowRefusal("busy", NOT_BEGUN, RETRY_SOON_S);
}

export const OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN";
export const STILL_WORKING = "Lifestream is still working on this.";
export const NO_ANSWER = "Lifestream didn't answer.";

export function outcomeUnknown(again: boolean, began: boolean): never {
  throw new Refusal(503, OUTCOME_UNKNOWN, began ? STILL_WORKING : NO_ANSWER, RETRY_SOON_S, { again, began });
}

export const SEARCH_REFUSALS = {
  BAD_PARAMETER: 422,
  PERSON_UNKNOWN: 404,
  TOO_BROAD: 422,
  CURSOR_EXPIRED: 409,
  HANDLE_UNKNOWN: 404,
  LINE_MOVED: 409,
  INDEX_BUILDING: 503,
  NOT_NOW: 503,
  WITHHELD: 422,
  HIDE_NOT_READY: 503,
  OUTSIDE_ACCESS: 403,
} as const;
export type SearchRefusalCode = keyof typeof SEARCH_REFUSALS;
export const NOT_YET: ReadonlySet<string> = new Set(Object.entries(SEARCH_REFUSALS).filter(([, status]) => status === 503).map(([code]) => code));

export const BUILDING = ["words", "facts", "people", "places", "screen"] as const;
export type Building = (typeof BUILDING)[number];

type Fix = Omit<SearchRefusal, "code" | "message">;
export interface SearchFixes {
  BAD_PARAMETER: Pick<Fix, "keys" | "ops" | "instead">;
  PERSON_UNKNOWN: Pick<Fix, "matches">;
  TOO_BROAD: Pick<Fix, "fits">;
  CURSOR_EXPIRED: Record<never, never>;
  HANDLE_UNKNOWN: Record<never, never>;
  LINE_MOVED: Record<never, never>;
  INDEX_BUILDING: { building: Building[] };
  NOT_NOW: Record<never, never>;
  WITHHELD: Pick<Fix, "not_searched">;
  HIDE_NOT_READY: Record<never, never>;
  OUTSIDE_ACCESS: Record<never, never>;
}

export function refused<C extends SearchRefusalCode>(code: C, words: string, ...fix: Record<never, never> extends SearchFixes[C] ? [SearchFixes[C]?] : [SearchFixes[C]]): never {
  const status = SEARCH_REFUSALS[code];
  throw new Refusal(status, code, words, status === 503 ? RETRY_SOON_S : undefined, (fix[0] ?? {}) as JsonObject);
}

export const HOME_FAILED = "HOME_FAILED";

export function homeFailed(): never {
  throw new Refusal(500, HOME_FAILED, "Lifestream failed at this. Its log says why.");
}

export const BODY_TOO_LARGE = "BODY_TOO_LARGE";

export function notReadable(error: unknown): never {
  throw notReadableRefusal(error);
}

export function notReadableRefusal(error: unknown): Refusal {
  return notNowRefusal("busy", `Lifestream cannot be read now (${(error as Error).message}). Try again in a moment.`, RETRY_SOON_S);
}
