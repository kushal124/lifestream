import { addDays } from "@lifestreamprotocol/core";

export interface GroupFacts {
  readonly word: boolean | null;
  readonly archived: boolean;
  readonly yours: readonly string[];
}

export interface GroupRule {
  readonly archived: boolean;
  readonly after_days: number | null;
}

export type Span = readonly [string, string];

export const EVERY_DAY: Span = ["0000-01-01", "9999-12-31"];

export type Why = "owner" | "archived" | "silent";

export function spans(facts: GroupFacts, rule: GroupRule): Span[] {
  if (facts.word === false) return [EVERY_DAY];
  if (facts.word === true) return [];
  if (facts.archived && rule.archived) return [];
  if (rule.after_days === null) return [EVERY_DAY];
  if (!Number.isSafeInteger(rule.after_days) || rule.after_days < 1) throw new RangeError(`a silence is a whole number of days, at least 1, not ${rule.after_days}`);
  const out: [string, string][] = [];
  for (const day of [...new Set(facts.yours)].sort()) {
    const last = addDays(day, rule.after_days - 1);
    const open = out.at(-1);
    if (open !== undefined && day <= addDays(open[1], 1)) {
      if (last > open[1]) open[1] = last;
    } else {
      out.push([day, last]);
    }
  }
  return out;
}

export function quiet(yours: readonly Span[], day: string): boolean {
  let low = 0;
  let high = yours.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [first, last] = yours[middle]!;
    if (day < first) high = middle - 1;
    else if (day > last) low = middle + 1;
    else return false;
  }
  return true;
}

export function why(facts: GroupFacts, rule: GroupRule): Why {
  if (facts.word === true) return "owner";
  if (facts.archived && rule.archived) return "archived";
  return "silent";
}
