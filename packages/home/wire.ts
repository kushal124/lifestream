import type { Json, Months } from "@lifestreamprotocol/core";
import type { StoreBlock } from "./stores.js";
import type { StoreState } from "./streams-report.js";
import type { SignInRefusal } from "./verbs/signin.js";


export interface Open {
  label: string;
  href: string;
}


export interface RefreshBlocked {
  reason: "running" | "held" | "paused" | "offline" | "chrome" | "disk" | "vault" | "device";
  words: string;
  until_ms: number | null;
}

export type RefreshAnswer =
  | { state: "queued" | "asked" }
  | { state: "blocked"; blocked: RefreshBlocked };


export type SealAnswer = { sealed: true } | SignInRefusal;

export interface SettingAnswer {
  readonly landed: { readonly connector: string; readonly member: string; readonly value: Json | null };
}


export interface ExchangeAnswerAdds {
  stores?: Record<string, StoreBlock>;
  refresh?: Record<string, number>;
}

export interface StatedThrough {
  read_through: string;
  stated_at: string;
  left?: number;
  start_ms?: number | null;
  months?: Months;
  seal?: number;
}

export interface ExchangeBodyAdds {
  stores?: { digest: string | null; states: Record<string, StoreState> };
  through?: Record<string, StatedThrough>;
}
