
export const PART_BYTES = 8 * 1024 * 1024;
export const PAGE_FILE_BYTES = 32 * 1024 * 1024;
export const FETCH_MS = 60_000;
export const FETCH_AT_ONCE = 4;
export const SECRET = "[secret]";

export interface ErrandSpec {
  readonly name: string;
  readonly origins: readonly string[];
  readonly secrets?: readonly string[];
  readonly cookies?: readonly string[];
  readonly deadline_ms: number;
}

export type Locator =
  | { readonly ref: string }
  | { readonly role: string; readonly name?: string; readonly exact?: boolean }
  | { readonly label: string }
  | { readonly text: string }
  | { readonly css: string };

export type Value =
  | string
  | { readonly secret: string; readonly value?: string }
  | { readonly held: string; readonly prefix?: string }
  | FromCookie;

export interface FromCookie {
  readonly cookie: string;
  readonly prefix?: string;
}

export type PageRequest = JsonRequest | FileRequest;

interface PageAsk {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, Value>>;
  readonly body?: string;
}

type JsonRequest = PageAsk & {
  readonly as: "json";
  readonly hold?: { readonly name: string; readonly path: string };
  readonly name?: never;
};

type FileRequest = PageAsk & { readonly as: "file"; readonly name: string; readonly hold?: never };

export interface PageResponse {
  readonly status: number;
  readonly url: string;
  readonly json?: unknown;
  readonly file?: FileRef;
  readonly held?: string;
  readonly error?: Pick<CallError, "code" | "message">;
}

export interface FileRef {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly path?: string;
}

export interface Outline {
  readonly url: string;
  readonly title: string;
  readonly lines: string;
  readonly text?: string;
  readonly signals: Signals;
}

export interface Signals {
  readonly captcha: boolean;
  readonly otp: boolean;
  readonly password: boolean;
  readonly verify: boolean;
}

export interface Found {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly checked?: boolean;
}

export type WaitFor = Locator | { readonly url: string } | { readonly gone: Locator } | { readonly any: readonly Locator[] };

export type Op =
  | { readonly op: "open"; readonly url: string }
  | { readonly op: "goto"; readonly tab: number; readonly url: string }
  | { readonly op: "snapshot"; readonly tab: number; readonly text?: boolean }
  | { readonly op: "find"; readonly tab: number; readonly target: Locator }
  | { readonly op: "click"; readonly tab: number; readonly target: Locator }
  | { readonly op: "fill"; readonly tab: number; readonly target: Locator; readonly value: Value }
  | { readonly op: "select"; readonly tab: number; readonly target: Locator; readonly option: string }
  | { readonly op: "wait"; readonly tab: number; readonly for: WaitFor; readonly ms: number }
  | {
      readonly op: "fetch";
      readonly tab: number;
      readonly requests: readonly PageRequest[];
    };

export interface Answers {
  open: { tab: number; url: string };
  goto: { url: string };
  snapshot: Outline;
  find: Found[];
  click: { url: string };
  fill: { filled: true };
  select: { selected: string };
  wait: Outline;
  fetch: PageResponse[];
}

export type Call = { readonly id: string; readonly errand: string } & (
  | Op
  | { readonly op: "begin"; readonly spec: ErrandSpec }
  | { readonly op: "end" }
);

export const CODES = [
  "ORIGIN_REFUSED",
  "SITE_NOT_ALLOWED",
  "SECRET_REFUSED",
  "NOT_FOUND",
  "AMBIGUOUS",
  "REF_STALE",
  "TIMEOUT",
  "INTERRUPTED",
  "DOWNLOAD_FAILED",
  "PAGE_ERROR",
  "OFFLINE",
  "TOO_LARGE",
  "NO_ERRAND",
  "BUSY",
  "NO_STATION",
  "BAD_CALL",
  "HOME_TOO_OLD",
] as const;
export type Code = (typeof CODES)[number];

export interface CallError {
  readonly code: Code;
  readonly message: string;
  readonly snapshot?: Outline;
}

export type Result = { readonly id: string } & (
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: CallError }
);

export interface StationInfo {
  readonly unit: string;
  readonly version: string;
  readonly slots: number;
  readonly errands: readonly string[];
  readonly boot: string;
  readonly running: readonly string[];
  readonly pressed: Pressed;
  readonly allowing: readonly string[];
  readonly withheld?: readonly string[];
  readonly opened: readonly string[];
  readonly acted: readonly Pressing[];
  readonly tabs: readonly StationTab[];
  readonly survey?: true;
  readonly development?: true;
}

export interface StationTab {
  readonly tab: number;
  readonly errand: string | null;
  readonly from: number;
  readonly until: number;
}

export interface Pressed {
  readonly choose: readonly string[];
  readonly stop: readonly string[];
}

export interface Site {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly origins: readonly string[];
  readonly form?: true;
  readonly signed_in: boolean | null;
  readonly account: { readonly email: string } | null;
}

export type Act =
  | { readonly do: "try" | "skip"; readonly label: string; readonly need: string }
  | { readonly do: "read" | "ignore"; readonly label: string; readonly need: string; readonly of: string }
  | { readonly do: "open"; readonly label: string; readonly url: string }
  | { readonly do: "allow"; readonly label: string; readonly origin: string }
  | { readonly do: "chrome"; readonly label: string; readonly url: string };

export type Pressing = Extract<Act, { do: "try" | "skip" | "read" | "ignore" }>;

export const ACTS: readonly Act["do"][] = ["try", "skip", "read", "ignore", "open", "allow", "chrome"];

export interface Need {
  readonly id: string;
  readonly state: "needs-you" | "broken";
  readonly reason: string | null;
  readonly words: string;
  readonly since_ms: number | null;
  readonly next_ms: number | null;
  readonly acts: readonly Act[];
  readonly detail: string | null;
  readonly connector: string | null;
  readonly copy: string | null;
  readonly unit: string | null;
  readonly at: { readonly site: string; readonly open: string | null; readonly errand: string | null } | null;
}

export const ownNeed = (id: string, words: string, act: Act, site: string | null): Need => ({
  id, state: "needs-you", reason: null, words, since_ms: null, next_ms: null, acts: [act], detail: null, connector: null, copy: null, unit: null,
  at: site === null ? null : { site, open: null, errand: null },
});

export interface HomeNamed {
  readonly version: string;
  readonly generation: number | null;
}

export interface ExchangeAnswer {
  readonly home: HomeNamed;
  readonly calls: Call[];
  readonly needs: Need[];
  readonly sites: Site[];
  readonly chosen: string[];
  readonly reload?: true;
}

export class StationError extends Error {
  constructor(
    readonly code: Code,
    message: string,
    readonly snapshot?: Outline,
  ) {
    super(message);
    this.name = "StationError";
  }

  toJSON(): CallError {
    return this.snapshot === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, snapshot: this.snapshot };
  }
}
