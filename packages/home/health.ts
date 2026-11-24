import type { LabelerUnavailable, NeedReason, Road, WaitReason } from "@lifestreamprotocol/connect";

export const STATES = ["off", "setup", "paused", "needs-you", "broken", "waiting", "quiet", "syncing", "ok"] as const;
export type State = (typeof STATES)[number];

export const REQUIREMENTS = ["form", "sign-in", "choose", "app", "grant", "pair", "export", "install"] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

export type NeedYouReason = Exclude<NeedReason, "provider-changed"> | "grant";

export const BROKEN_REASONS = ["failing", "import", "provider-changed", "missing-file"] as const;
export type BrokenReason = (typeof BROKEN_REASONS)[number];

export const QUIET_REASONS = ["nothing-new", "device"] as const;
export type QuietReason = (typeof QUIET_REASONS)[number];

export type Reason = Requirement | NeedYouReason | WaitReason | BrokenReason | QuietReason;

export type Outcome = "ok" | "wait" | "need" | "fail";

export type Health<A = unknown> = {
  state: State;
  reason: Reason | null;
  words: string;
  since_ms: number | null;
  next_ms: number | null;
  acts: A[];
  detail: string | null;
  line?: string;
};

export const stateOfNeed = (reason: NeedReason): State => (reason === "provider-changed" ? "broken" : "needs-you");

export const REST_OF: Readonly<Record<LabelerUnavailable["reason"], readonly [Outcome, Reason]>> = {
  "not-installed": ["need", "install"],
  "waiting-for-power": ["wait", "power"],
  crashed: ["fail", "failing"],
  timeout: ["fail", "failing"],
  unreadable: ["fail", "failing"],
  refused: ["need", "password"],
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const WINDOWS: Readonly<Record<Road, { fails: number; fail_ms: number; quiet_ms: number | "refresh" | null }>> = {
  poll: { fails: 3, fail_ms: 15 * MINUTE, quiet_ms: "refresh" },
  chrome: { fails: 3, fail_ms: 15 * MINUTE, quiet_ms: "refresh" },
  mac: { fails: 1, fail_ms: HOUR, quiet_ms: 2 * HOUR },
  phone: { fails: 1, fail_ms: HOUR, quiet_ms: 26 * HOUR },
  upload: { fails: 2, fail_ms: 0, quiet_ms: null },
  owner: { fails: 2, fail_ms: 0, quiet_ms: null },
  label: { fails: 3, fail_ms: 0, quiet_ms: null },
};

export function refreshQuiet(refresh_ms: number): number {
  return 3 * refresh_ms + 15 * MINUTE;
}
