import {
  daysOf, digest, instant, render,
  isObject,
  type DaySettings, type ExtractRow, type Head, type Json, type MoneyAdapter, type SourceParts, type SourceRow, type Version, type View,
} from "@lifestreamprotocol/core";
import { factId, OPS, type Change, type Collection, type DayFact, type DayInput, type DayLine, type DayProjection, type Extracted, type Family, type FamilyInput, type Given, type Touched } from "../family.js";
import { recordRead, recordText } from "../shared/text.js";

export const MONEY_FAMILY = "money";
const TXN = "txn";
const DAY_MS = 86_400_000;
export const MONEY_DATE = /^\d{4}-\d{2}-\d{2}$/u;
export const MONEY_AMOUNT = /^(?:0|[1-9]\d*)\.\d{2}$/u;
export const CHAIN_LOOKBACK_DAYS = 62;

export interface StatementLine {
  key: string;
  direction: "debit" | "credit";
  amount: string;
  balance: string;
  currency: string;
  narration: string;
}

export interface DateRun {
  date: string;
  opening: string | null;
  lines: StatementLine[];
  breaks: (string | null)[];
}

export function moneyFamily(given: readonly Given<MoneyAdapter>[]): Family {
  const byProduct = new Map(given.map((each) => [each.product, each]));
  const statementOf = (view: View, source: string): Statement | undefined => {
    const row = view.source(source);
    const fed = row === undefined ? undefined : byProduct.get(row.product);
    return row === undefined || fed === undefined ? undefined : { row, adapter: fed.adapter };
  };
  return {
    name: MONEY_FAMILY,
    type: "money",
    code: "1",
    inputs: given.map((each): FamilyInput => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),
    text: {
      version: "1",
      kinds: [...new Set(given.flatMap((each) => each.adapter.kinds))].sort(),
      of(record, version, _files, view) {
        const statement = statementOf(view, record.source);
        return statement === undefined || !statement.adapter.kinds.includes(record.kind) ? null : recordText({ text: readLine(record.key, txnOf(statement, version))?.narration });
      },
    },

    read: {
      of(record, version, _files, view) {
        const statement = statementOf(view, record.source);
        return statement === undefined || !statement.adapter.kinds.includes(record.kind) ? null : recordRead({ text: readLine(record.key, txnOf(statement, version))?.narration });
      },
    },

    touched(changes: readonly Change[], view: View): Touched[] {
      return changes.flatMap((change): Touched[] => {
        const { record, before, after } = change;
        const statement = statementOf(view, record.source);
        if (statement === undefined || !statement.adapter.kinds.includes(record.kind)) return [];
        const dates = new Set<string>();
        for (const version of [before, after]) {
          const date = version === undefined ? null : dateOf(txnOf(statement, version));
          if (date === null) continue;
          dates.add(date);
          const next = nextDate(view, statement, date);
          if (next !== null) dates.add(next);
        }
        return [...dates].sort().map((date) => ({ unit: `${record.source}/${date}` }));
      });
    },

    extract(unit: string, view: View): Extracted | null {
      const parsed = parseUnit(unit);
      if (parsed === null) return null;
      const { source, date } = parsed;
      const statement = statementOf(view, source);
      if (statement === undefined) return null;
      const lines = linesOn(view, statement, date);
      if (lines.length === 0) return null;
      const opening = closingBefore(view, statement, date);
      const run = chain(date, opening, lines);
      const start = dateMs(date);
      return { content: run as unknown as Json, start_ms: start, end_ms: start + DAY_MS, reading: digest(run as unknown as Json) };
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      if (extract.start_ms === null) return [];
      return daysOf({ start_ms: extract.start_ms, end_ms: extract.start_ms + DAY_MS, precision: "day" }, settings);
    },

    day(input: DayInput): DayProjection {
      const lines: DayLine[] = [];
      const facts: DayFact[] = [];
      for (const extract of input.extracts) {
        const { source } = parseUnit(extract.unit)!;
        const run = extract.content as unknown as DateRun;
        const parts = input.sources.get(source);
        const bank = parts === undefined ? undefined : byProduct.get(parts.product);
        const account = parts === undefined || bank === undefined ? "bank" : accountWords(bank.name, parts);
        const at = dateMs(run.date);
        for (const [index, line] of run.lines.entries()) {
          const missing = run.breaks[index] ?? null;
          const record = { source, kind: bank?.adapter.kinds[0] ?? TXN, key: line.key };
          const printed = lines.push({
            family: MONEY_FAMILY, unit: extract.unit, units: [extract.unit],
            start_ms: extract.start_ms, end_ms: null, date_only: true,
            text: `${line.direction === "debit" ? "−" : "+"}${line.amount} ${line.currency} ${account}: ${line.narration} (balance ${line.balance})` +
              (missing === null ? "" : ` [the balance before it does not follow: ${missing} ${line.currency} of lines missing]`),
            record,
          }) - 1;
          const { payee, channel } = payeeOf(line.narration);
          facts.push({
            of: "payments", id: factId("payments", `${source}/${line.key}`), time_ms: at, start_ms: at, end_ms: at, date_only: true,
            keys: { ...(payee === null ? {} : { payee }), account, direction: line.direction, ...(channel === null ? {} : { channel }), currency: line.currency },
            measures: { amount: line.amount, balance: line.balance }, who: [], from: { units: [extract.unit], record, alone: true }, lines: [printed],
          });
        }
      }
      return { lines, facts };
    },
    collections: MONEY_COLLECTIONS,
  };
}

export const MONEY_COLLECTIONS: Readonly<Record<string, Collection>> = {
  payments: {
    keys: ["payee", "account", "direction", "channel", "currency"],
    measures: {
      amount: { unit: "currency", ops: OPS, time: "start", split: "whole", from: "stated" },
      balance: { unit: "currency", ops: ["min", "max", "first", "last"], time: "start", split: "whole", from: "stated" },
    },
  },
};

const RAIL = /^(UPI|POS|NEFT|IMPS|RTGS|ATW|ATM|NWD|ACH|NACH|ECS)(?:\s+(?:CR|DR|C|D))?(?=[-\s/])[-\s/]*/u;

export function payeeOf(narration: string): { payee: string | null; channel: string | null } {
  const rail = RAIL.exec(narration);
  const rest = rail === null ? narration : narration.slice(rail[0].length);
  for (const field of rest.split(/[-/]/u)) {
    const words = field.split(/\s+/u).filter((word) => word !== "" && !/[\d@]/u.test(word));
    if (words.length > 0) return { payee: words.join(" "), channel: rail?.[1] ?? null };
  }
  return { payee: null, channel: rail?.[1] ?? null };
}

interface Statement {
  row: SourceRow;
  adapter: MoneyAdapter;
}

export function contentTxn({ version }: { version: Version }): Json {
  return version.content;
}

function txnOf(statement: Statement, version: Version): Json {
  return statement.adapter.txn === undefined ? contentTxn({ version }) : (statement.adapter.txn({ source: statement.row, version }) as Json | null) ?? null;
}

function parseUnit(unit: string): { source: string; date: string } | null {
  const slash = unit.lastIndexOf("/");
  const source = unit.slice(0, slash);
  const date = unit.slice(slash + 1);
  return slash < 0 || !MONEY_DATE.test(date) ? null : { source, date };
}

function linesOn(view: View, statement: Statement, date: string): StatementLine[] {
  const start = dateMs(date);
  const lines: StatementLine[] = [];
  for (const kind of statement.adapter.kinds) {
    for (const { head, version } of view.records(statement.row.id, kind, { start_ms: start, end_ms: start + DAY_MS })) {
      const txn = txnOf(statement, version);
      const line = dateOf(txn) === date ? readLine(head.key, txn) : null;
      if (line !== null) lines.push(line);
    }
  }
  return lines.sort((left, right) => compare(left.key, right.key));
}

function closingBefore(view: View, statement: Statement, date: string): string | null {
  const start = dateMs(date);
  let latest: string | null = null;
  for (const head of heads(view, statement, start - CHAIN_LOOKBACK_DAYS * DAY_MS, start)) {
    const stated = head.start_ms === null ? null : utcDate(head.start_ms);
    if (stated !== null && stated < date && (latest === null || stated > latest)) latest = stated;
  }
  if (latest === null) return null;
  const run = chain(latest, null, linesOn(view, statement, latest));
  return run.lines.at(-1)?.balance ?? null;
}

function nextDate(view: View, statement: Statement, date: string): string | null {
  const after = dateMs(date) + DAY_MS;
  let next: string | null = null;
  for (const head of heads(view, statement, after, after + CHAIN_LOOKBACK_DAYS * DAY_MS)) {
    const stated = head.start_ms === null ? null : utcDate(head.start_ms);
    if (stated !== null && stated > date && (next === null || stated < next)) next = stated;
  }
  return next;
}

function chain(date: string, opening: string | null, lines: StatementLine[]): DateRun {
  const opens = (line: StatementLine) => cents(line.balance) - signed(line);
  const steps = new Map<bigint, Step[]>();
  const excess = new Map<bigint, number>();
  const add = (step: Step) => {
    steps.set(step.from, [...(steps.get(step.from) ?? []), step]);
    excess.set(step.from, (excess.get(step.from) ?? 0) + 1);
    excess.set(step.to, (excess.get(step.to) ?? 0) - 1);
  };
  for (const line of [...lines].sort((left, right) => compare(left.key, right.key))) add({ line, from: opens(line), to: cents(line.balance) });
  const sources = [...excess].filter(([, count]) => count > 0).flatMap(([balance, count]) => Array<bigint>(count).fill(balance));
  const leftMore = new Set(sources);
  for (const [balance, count] of [...excess].filter(([, count]) => count < 0).sort(([left], [right]) => compareBig(left, right))) {
    for (let jump = 0; jump < -count; jump++) add({ line: null, from: balance, to: sources.splice(nearest(sources, balance), 1)[0]! });
  }
  const ordered: StatementLine[] = [];
  const breaks: (string | null)[] = [];
  let closing: bigint | null = opening === null ? null : cents(opening);
  for (;;) {
    const pending = [...steps].filter(([, list]) => list.some((step) => step.line !== null)).map(([balance]) => balance);
    if (pending.length === 0) break;
    const firstKey = (balance: bigint) => steps.get(balance)!.find((step) => step.line !== null)!.line!.key;
    const byFirstKey = (balances: bigint[]) => balances.sort((left, right) => compare(firstKey(left), firstKey(right)))[0];
    const start = closing !== null && pending.includes(closing) ? closing
      : closing === null ? (byFirstKey(pending.filter((balance) => leftMore.has(balance))) ?? byFirstKey(pending)!)
      : pending[nearest(pending, closing)]!;
    for (const line of walk(start, steps)) {
      breaks.push(closing === null || opens(line) === closing ? null : decimal(opens(line) - closing));
      ordered.push(line);
      closing = cents(line.balance);
    }
  }
  return { date, opening, lines: ordered, breaks };
}

interface Step {
  line: StatementLine | null;
  from: bigint;
  to: bigint;
}

function walk(start: bigint, steps: Map<bigint, Step[]>): StatementLine[] {
  const at: bigint[] = [start];
  const by: (Step | null)[] = [null];
  const circuit: Step[] = [];
  while (at.length > 0) {
    const next = steps.get(at[at.length - 1]!)?.shift();
    if (next !== undefined) {
      at.push(next.to);
      by.push(next);
    } else {
      at.pop();
      const step = by.pop();
      if (step !== null && step !== undefined) circuit.push(step);
    }
  }
  circuit.reverse();
  let best: StatementLine[] = [];
  let least: bigint | undefined;
  for (const [begin, step] of circuit.entries()) {
    if (step.from !== start || step.line === null) continue;
    const run = [...circuit.slice(begin), ...circuit.slice(0, begin)].filter((each) => each.line !== null);
    const missing = run.reduce((sum, each, index) => (index === 0 ? 0n : sum + abs(each.from - run[index - 1]!.to)), 0n);
    if (least === undefined || missing < least || (missing === least && compare(step.line.key, best[0]!.key) < 0)) {
      best = run.map((each) => each.line!);
      least = missing;
    }
  }
  return best;
}

function nearest(balances: readonly bigint[], to: bigint): number {
  return balances.reduce((best, balance, index) => {
    const gap = abs(balance - to);
    const bestGap = abs(balances[best]! - to);
    return gap < bestGap || (gap === bestGap && balance < balances[best]!) ? index : best;
  }, 0);
}

function compareBig(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readLine(key: string, content: Json): StatementLine | null {
  if (!isObject(content)) return null;
  const { debit, credit, closing_balance, currency, narration } = content;
  const direction = typeof debit === "string" ? "debit" : typeof credit === "string" ? "credit" : null;
  const amount = direction === "debit" ? debit : credit;
  if (direction === null || typeof amount !== "string" || !MONEY_AMOUNT.test(amount)) return null;
  if (typeof closing_balance !== "string" || !MONEY_AMOUNT.test(closing_balance)) return null;
  if (typeof currency !== "string" || typeof narration !== "string") return null;
  return { key, direction, amount, balance: closing_balance, currency, narration };
}

function dateOf(content: Json): string | null {
  return isObject(content) && typeof content.date === "string" && MONEY_DATE.test(content.date) ? content.date : null;
}

function heads(view: View, statement: Statement, from: number, to: number): Head[] {
  return statement.adapter.kinds.flatMap((kind) => [...view.heads(statement.row.id, kind, { start_ms: from, end_ms: to })]);
}

function accountWords(bank: string, source: Pick<SourceParts, "account">): string {
  const digits = source.account.replace(/\D/gu, "");
  return `${bank}${digits.length >= 4 ? ` …${digits.slice(-4)}` : ""}`;
}

function signed(line: StatementLine): bigint {
  return line.direction === "credit" ? cents(line.amount) : -cents(line.amount);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function cents(value: string): bigint {
  return BigInt(value.replace(".", ""));
}

function decimal(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function utcDate(ms: number): string {
  return render(ms, "UTC", "day");
}

function dateMs(date: string): number {
  return instant(date, "date").start_ms;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
