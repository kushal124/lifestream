import type { Piece } from "@lifestreamprotocol/core";

export const TEXT_KINDS = ["answer", "connector", "app"] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

export interface AskStep {
  name: string;
  words: string;
  ms: number;
  error?: string;
  line?: string;
}

export interface AskAnswer {
  text: string;
  steps?: readonly AskStep[];
  model?: string;
  thinking?: string;
  ms?: number;
  end?: "done" | "stopped" | "failed";
  error?: string;
  failed?: string;
}

export interface AskQuestion {
  text: string;
  spoken: string | null;
}

export interface ConnectorFacts {
  id: string;
  name: string;
  contract: string;
  state: string;
  reason: string | null;
  since_ms: number | null;
  next_ms: number | null;
  words: string;
  line: string | null;
  detail: string | null;
  more: string | null;
  failed: readonly { at_ms: number; error: string }[];
}

export interface AppFacts {
  device: "mac" | "phone";
  release: { generation: string; commit: string };
  encrypted: boolean;
  mac: { build: string; macos: string; model: string } | null;
  phone: { version: string; ios: string } | null;
}

export const FAILED_RUNS = 5;

export const KIND_TITLES = { answer: "This answer", connector: "{name}'s status", app: "App details", screenshot: "Screenshot" } as const;

export function titleOf(kind: TextKind, name = ""): string {
  return KIND_TITLES[kind].replace("{name}", name);
}

const plain = (text: string): Piece => ({ text });
const free = (text: string): Piece[] => (text === "" ? [] : [{ text, free: true }]);

function seconds(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${Math.round(ms / 1_000)} s`;
}

function instant(ms: number | null): string {
  return ms === null ? "none" : new Date(ms).toISOString();
}

export function answerText(question: AskQuestion | null, answer: AskAnswer): Piece[] {
  const pieces: Piece[] = [];
  if (question !== null) pieces.push(plain("Question: "), ...free(question.spoken ?? question.text), plain("\n"));
  pieces.push(plain("Answer: "), ...free(answer.text), plain("\n"));
  const steps = answer.steps ?? [];
  if (steps.length > 0) {
    pieces.push(plain("Steps:\n"));
    for (const step of steps) {
      pieces.push(plain("  "), ...free(step.line ?? step.words), plain(` (${step.ms} ms)`));
      if (step.error !== undefined) pieces.push(plain(" error: "), ...free(step.error));
      pieces.push(plain("\n"));
    }
  }
  const said = [
    answer.model,
    answer.thinking === undefined ? undefined : `thinking ${answer.thinking}`,
    answer.ms === undefined ? undefined : seconds(answer.ms),
    answer.end,
  ].filter((part): part is string => part !== undefined);
  if (said.length > 0) pieces.push(plain(`Model: ${said.join(", ")}\n`));
  if (answer.end === "failed") {
    pieces.push(plain(`Failed: ${answer.failed ?? "unknown"}`));
    if (answer.error !== undefined) pieces.push(plain(": "), ...free(answer.error));
    pieces.push(plain("\n"));
  }
  return pieces;
}

export function connectorText(facts: ConnectorFacts): Piece[] {
  const pieces: Piece[] = [
    plain(`Connector: ${facts.name} (${facts.id})\n`),
    plain(`Contract: ${facts.contract}\n`),
    plain(`State: ${facts.state}${facts.reason === null ? "" : `, ${facts.reason}`}, since ${instant(facts.since_ms)}, next ${instant(facts.next_ms)}\n`),
    plain("Card: "), ...free(facts.words), plain("\n"),
  ];
  for (const [label, words] of [["Line", facts.line], ["Detail", facts.detail], ["More", facts.more]] as const) {
    if (words !== null) pieces.push(plain(`${label}: `), ...free(words), plain("\n"));
  }
  const failed = [...facts.failed].sort((a, b) => b.at_ms - a.at_ms).slice(0, FAILED_RUNS);
  if (failed.length > 0) {
    pieces.push(plain("Failed runs:\n"));
    for (const run of failed) pieces.push(plain(`  ${instant(run.at_ms)}: `), ...free(run.error), plain("\n"));
  }
  return pieces;
}

export function appText(facts: AppFacts): Piece[] {
  const lines = [
    `Home: ${facts.release.generation} (${facts.release.commit})${facts.encrypted ? ", encrypted" : ""}`,
    ...(facts.mac === null ? [] : [`Mac app: ${facts.mac.build}, macOS ${facts.mac.macos}, ${facts.mac.model}`]),
    ...(facts.phone === null ? [] : [`iPhone app: ${facts.phone.version}, iOS ${facts.phone.ios}`]),
  ];
  return [plain(`${lines.join("\n")}\n`)];
}
