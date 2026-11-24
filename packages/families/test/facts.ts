import { dayBounds, digest, render, type Json } from "@lifestreamprotocol/core";
import { checkFacts, dayFacts, type DayFileFact } from "../days.js";
import type { DayFact, DayInput, DayLine, DayProjection, Family } from "../family.js";

export function factsConform(family: Family, inputs: readonly DayInput[]): string[] {
  const violations: string[] = [];
  const held = new Map<string, { whole: DayFact; stated: { day: string; fact: DayFileFact }[] }>();
  for (const input of inputs) {
    const projection = family.day(input);
    try {
      checkFacts(family, projection.facts, projection.lines.length);
    } catch (error) {
      violations.push(`${input.day}: ${(error as Error).message}`);
      continue;
    }
    const read = new Set(input.extracts.map((extract) => extract.unit));
    for (const fact of projection.facts) {
      if (fact.from.units.length === 0) violations.push(`${input.day}: ${fact.id} names no unit`);
      for (const unit of fact.from.units) if (!read.has(unit)) violations.push(`${input.day}: ${fact.id} names ${unit}, which no extract of the day holds`);
    }
    const reversed = family.day({ ...input, extracts: [...input.extracts].reverse() });
    const order = (projection_: DayProjection) => [...stated(projection_).values()].sort().join("\n");
    if (order(reversed) !== order(projection)) violations.push(`${input.day}: a fact's id, time, provenance or lines move with the order of the extracts`);
    for (const fact of projection.facts) {
      const entry = held.get(fact.id) ?? { whole: fact, stated: [] };
      if (digest(without(entry.whole)) !== digest(without(fact))) violations.push(`${input.day}: ${fact.id} is stated otherwise on another day`);
      held.set(fact.id, entry);
    }
    for (const fact of dayFacts(family, projection, input.day, input.settings, (line) => line + 1)) held.get(fact.id)!.stated.push({ day: input.day, fact });
  }
  for (const [id, { whole, stated: days }] of held) {
    const settings = inputs[0]!.settings;
    const holds = (day: string) => {
      const window = dayBounds(day, settings);
      return whole.date_only === true ? render(whole.time_ms, settings.zone, "day") === day : whole.time_ms >= window.start_ms && whole.time_ms < window.end_ms;
    };
    const owner = inputs.map((input) => input.day).filter(holds);
    if (days.length !== owner.length || days.some(({ day }) => !holds(day))) {
      violations.push(`${id}: stated by ${days.map(({ day }) => day).join(", ") || "no day"}, not by ${owner.join(", ") || "no day given"}, the one day of its time`);
    }
    for (const { day, fact } of days) if (wholeOf(fact) !== wholeOf(whole)) violations.push(`${id}: ${day} does not state it whole`);
  }
  return violations;
}

function wholeOf(fact: DayFact | DayFileFact): string {
  return JSON.stringify([fact.time_ms, fact.start_ms, fact.end_ms, fact.keys, fact.measures, fact.who.map(({ handle, role }) => [handle, role]), "part" in fact]);
}

export function insertKeepsFacts(family: Family, before: DayInput, after: DayInput): string[] {
  const was = stated(family.day(before));
  const is = stated(family.day(after));
  return [...was].flatMap(([id, said]) => is.get(id) === said ? [] : [`${id} moved when a thing was added to ${after.day}`]);
}

function stated(projection: DayProjection): Map<string, string> {
  return new Map(projection.facts.map((fact) => [fact.id, JSON.stringify({
    ...JSON.parse(JSON.stringify(without(fact))) as object,
    lines: fact.lines.map((index) => lineOf(projection.lines[index]!)).sort(),
  })]));
}

function without(fact: DayFact): Json {
  const { lines: _lines, ...rest } = fact;
  return rest as unknown as Json;
}

function lineOf(line: DayLine): string {
  return JSON.stringify([line.unit, line.units, line.record ?? null, line.item ?? null, line.start_ms, line.end_ms, line.text]);
}
