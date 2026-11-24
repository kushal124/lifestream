import { execFileSync } from "node:child_process";
import type { Connector } from "@lifestreamprotocol/connect";
import { CONTRACTS } from "@lifestreamprotocol/connect/sdk";
import { GENERATION, isObject, RELEASE, type Json, type OpenView, type ReadTables } from "@lifestreamprotocol/core";
import type { ChatTurn, DeviceSaid, RecordRef } from "./feedback.js";
import { FAILED_RUNS, type AppFacts, type AskAnswer, type AskStep, type ConnectorFacts } from "./feedback-text.js";
import type { StreamRow } from "./pages.js";

export const ASK_MSG = "msg";
const ENDS = ["done", "stopped", "failed"] as const;
const NOT_STATED = "not stated";

export const askKey = (chat: string, n: number): string => `${chat}:${String(n).padStart(4, "0")}`;

const textOf = (value: Json | undefined): string | undefined => (typeof value === "string" ? value : undefined);

function stepsOf(value: Json | undefined): AskStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((step): AskStep[] => {
    if (!isObject(step) || typeof step.name !== "string" || typeof step.words !== "string" || typeof step.ms !== "number") return [];
    const error = textOf(step.error);
    const line = textOf(step.line);
    return [{ name: step.name, words: step.words, ms: step.ms, ...(error === undefined ? {} : { error }), ...(line === undefined ? {} : { line }) }];
  });
}

function answerOf(content: Record<string, Json>): AskAnswer {
  const end = ENDS.find((each) => each === content.end);
  const [model, thinking, error, failed] = [textOf(content.model), textOf(content.thinking), textOf(content.error), textOf(content.failed)];
  return {
    text: textOf(content.text) ?? "", steps: stepsOf(content.steps),
    ...(model === undefined ? {} : { model }), ...(thinking === undefined ? {} : { thinking }), ...(typeof content.ms === "number" ? { ms: content.ms } : {}),
    ...(end === undefined ? {} : { end }), ...(error === undefined ? {} : { error }), ...(failed === undefined ? {} : { failed }),
  };
}

export function turnOf(view: Pick<OpenView, "head" | "version">, source: string, chat: string, n: number): ChatTurn | null {
  const said = (k: number): { ref: RecordRef; content: Record<string, Json> } | null => {
    const ref = { source, kind: ASK_MSG, key: askKey(chat, k) };
    const head = view.head(ref);
    if (head === undefined) return null;
    const content = view.version(head.version).content;
    return isObject(content) ? { ref, content } : null;
  };
  const answer = said(n);
  if (answer === null || answer.content.role !== "assistant") return null;
  for (let k = n - 1; k >= 1; k--) {
    const before = said(k);
    if (before === null) continue;
    if (before.content.role !== "user") break;
    return { refs: [answer.ref, before.ref], question: { text: textOf(before.content.text) ?? "", spoken: null }, answer: answerOf(answer.content) };
  }
  return { refs: [answer.ref], question: null, answer: answerOf(answer.content) };
}

export function failedRuns(runs: Pick<ReadTables["runs"], "failed">, connector: Pick<Connector, "sources">): ConnectorFacts["failed"] {
  const found = connector.sources.flatMap((source) => {
    const [prefix] = source.id.split("<");
    const pattern = new RegExp(`^${source.id.split(/<[^>]+>/u).map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("[^ ]+")} `, "u");
    return runs.failed("import", prefix!, FAILED_RUNS).filter((run) => pattern.test(run.subject));
  });
  const once = [...new Map(found.map((run) => [run.id, run])).values()];
  return once.sort((a, b) => b.started_ms - a.started_ms).slice(0, FAILED_RUNS)
    .map((run) => ({ at_ms: run.ended_ms ?? run.started_ms, error: run.error ?? "no error was kept" }));
}

export function connectorFactsOf(connector: Pick<Connector, "id" | "name">, row: StreamRow | undefined, failed: ConnectorFacts["failed"]): ConnectorFacts | null {
  if (row === undefined) return null;
  const { health } = row;
  return {
    id: connector.id, name: connector.name, contract: CONTRACTS.join(", "), state: health.state, reason: health.reason, since_ms: health.since_ms, next_ms: health.next_ms,
    words: health.words, line: health.line ?? row.line, detail: health.detail, more: row.more.length === 0 ? null : row.more.join("\n"), failed,
  };
}

export function appFactsOf(asker: DeviceSaid, encrypted: boolean, mac: { macos: string; model: string }): AppFacts {
  const release = { generation: GENERATION === null ? "checkout" : String(GENERATION), commit: RELEASE.slice(0, 12) };
  const version = asker.version ?? NOT_STATED;
  if (asker.kind === "phone") {
    return { device: "phone", release, encrypted, mac: null, phone: { version, ios: NOT_STATED } };
  }
  return { device: "mac", release, encrypted, mac: { build: version, macos: mac.macos, model: mac.model }, phone: null };
}

let macos: string | undefined;

export function macosVersion(): string {
  if (macos !== undefined) return macos;
  try {
    macos = process.platform === "darwin" ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 2_000 }).trim() || NOT_STATED : NOT_STATED;
  } catch {
    macos = NOT_STATED;
  }
  return macos;
}
