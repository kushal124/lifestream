import { readFileSync } from "node:fs";
import type { JsonObject, ReaderOutput } from "@lifestreamprotocol/core";

export const CLAUDE_CODE = "claude-code:local:macbook-pro-0001";
export const CODEX = "codex:local:macbook-pro-0001";

const CONNECT = new URL("../../../connect/ai/", import.meta.url);
const PROJECT = "-Users-person-a-project";
export const A1 = "00000000-0000-4000-8000-0000000000a1";
export const C3 = "00000000-0000-4000-8000-0000000000c3";
export const D1 = "00000000-0000-7000-8000-0000000000d1";
export const D3 = "00000000-0000-7000-8000-0000000000d3";
export const D4 = "00000000-0000-7000-8000-0000000000d4";
const E1 = "00000000-0000-7000-8000-0000000000e1";

function lines(path: string): JsonObject[] {
  const text = readFileSync(new URL(path, CONNECT), "utf8").replace(/:(\d{16,})([,}\]])/gu, ':"$1"$2');
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as JsonObject);
}

export function claudeCodeRow(line: JsonObject): ReaderOutput[] {
  if (typeof line.uuid !== "string") return [];
  return [{
    kind: "agent-turn", key: line.uuid, content: { type: "claude-code.line", line },
    time: { start_ms: Date.parse(line.timestamp as string), precision: "ms" }, device: "macbook-pro-0001",
  }];
}

export function codexRows(log: string, values: JsonObject[], from = 1): ReaderOutput[] {
  return values.map((line, index) => ({
    kind: "agent-turn", key: `${log}:${from + index}`, content: { type: "codex.line", line },
    time: { start_ms: Date.parse(line.timestamp as string), precision: "ms" }, device: "macbook-pro-0001",
  }));
}

export function agentDeliveries(): { claudeCode: ReaderOutput[][]; codex: ReaderOutput[][] } {
  const first = [
    `claude-code/test/logs/projects/${PROJECT}/${A1}.jsonl`,
    `claude-code/test/logs/projects/${PROJECT}/${A1}/subagents/agent-a0000000000000001.jsonl`,
    `claude-code/test/logs/projects/${PROJECT}/${C3}.jsonl`,
  ];
  const appended = [`claude-code/test/logs/appended/projects/${PROJECT}/${A1}.jsonl`, `claude-code/test/logs/appended/projects/${PROJECT}/${C3}.jsonl`];
  const day = "codex/test/logs/codex/sessions/2026/10/01";
  const d1 = lines(`${day}/rollout-2026-10-01T10-00-00-${D1}.jsonl`);
  return {
    claudeCode: [first, appended].map((paths) => paths.flatMap((path) => lines(path).flatMap(claudeCodeRow))),
    codex: [
      [
        ...codexRows(D1, d1),
        ...codexRows(`${D1}_${E1}`, lines(`${day}/rollout-2026-10-01T10-30-00-${D1}_${E1}.jsonl`)),
        ...codexRows(D4, lines(`${day}/rollout-2026-10-01T10-40-00-${D4}.jsonl`)),
        ...codexRows(D3, lines(`codex/test/logs/codex/archived_sessions/rollout-2026-09-20T08-00-00-${D3}.jsonl`)),
      ],
      codexRows(D1, lines(`codex/test/logs/appended/codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-${D1}.jsonl`), d1.length + 1),
    ],
  };
}
