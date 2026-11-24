import type { AttemptRow, JsonObject, ReadTables, SourceRow, Tx } from "@lifestreamprotocol/core";
import type { Outcome, Reason } from "./health.js";

export type Run = "fetch" | "page" | "label";

export const targetOf = (run: Run, name: string): string => `${run}:${name}`;

export interface Ended {
  outcome: Outcome;
  reason: Reason | null;
  facts?: JsonObject;
  detail?: string | null;
  answered: boolean;
}

export function aboutOf(own: readonly SourceRow[], named: { stated: readonly string[]; accounts: readonly string[] }): string[] {
  if (named.stated.length > 0) return [...new Set(named.stated)].sort();
  const accounts = named.accounts.filter((account) => account !== "");
  if (accounts.length > 0) return own.filter((row) => accounts.includes(row.account) || (typeof row.options.email === "string" && accounts.includes(row.options.email))).map((row) => row.id).sort();
  return own.length === 1 ? [own[0]!.id] : [];
}

export function record(tx: Tx, target: string, about: readonly string[], end: Ended, now: number): void {
  if (end.outcome === "ok" && about.length > 0) {
    const none = tx.tables.attempts.get(target, "");
    if (none !== undefined) remove(tx, none, now);
  }
  for (const source of about.length === 0 ? [""] : about) {
    const before = tx.tables.attempts.get(target, source);
    const own = !end.answered && end.outcome === "wait";
    if (own && before?.outcome === "need") {
      tx.tables.attempts.put({ ...before, at_ms: now });
      continue;
    }
    const failing = before !== undefined && before.fails > 0 && (end.outcome === "fail" || own);
    const same = before !== undefined && before.outcome === end.outcome && before.reason === end.reason;
    tx.tables.attempts.put({
      target, source, outcome: end.outcome, reason: end.reason, facts: end.facts ?? {}, detail: end.detail ?? null,
      since_ms: same || failing ? before.since_ms : now, at_ms: now, contact_ms: end.answered ? now : before?.contact_ms ?? null,
      fails: end.outcome === "fail" ? (failing ? before.fails + 1 : 1) : failing ? before.fails : 0,
    });
    if (!same || end.outcome === "fail") tx.tables.events.append({ at_ms: now, kind: "attempt", key: target, detail: { source, outcome: end.outcome, reason: end.reason } });
  }
}

export function latest(read: Pick<ReadTables, "attempts">, target: string): AttemptRow | undefined {
  let newest: AttemptRow | undefined;
  for (const row of read.attempts.of(target)) if (newest === undefined || row.at_ms > newest.at_ms) newest = row;
  return newest;
}

export function outcomesOf(read: Pick<ReadTables, "attempts">, acquirer: string, holds: (row: AttemptRow) => boolean): AttemptRow[] {
  return [...read.attempts.of(targetOf("fetch", acquirer)), ...read.attempts.of(targetOf("page", acquirer))].filter(holds);
}

export function needsMet(tx: Tx, rows: readonly AttemptRow[], now: number): void {
  for (const row of rows) if (row.outcome === "need") remove(tx, row, now);
}

function remove(tx: Tx, row: Pick<AttemptRow, "target" | "source">, now: number): void {
  tx.tables.attempts.delete(row.target, row.source);
  tx.tables.events.append({ at_ms: now, kind: "attempt", key: row.target, detail: { source: row.source, outcome: null, reason: null } });
}
