import { accountFaults, checkDayFile, type DayDocument, type RenderedDay } from "../days.js";

export function unitsFault(rendered: RenderedDay): string[] {
  const document = JSON.parse(rendered.json) as DayDocument;
  const shape = checkDayFile(document);
  if (shape.length > 0) return shape;
  const read = new Map<string, Set<string>>();
  for (const { family, unit } of rendered.units) read.set(family, (read.get(family) ?? new Set()).add(unit));
  const faults: string[] = [];
  const judge = (what: string, family: string, units: readonly string[]) => {
    if (units.length === 0) faults.push(`${document.day} ${what} names no unit`);
    for (const unit of units) {
      if (/^(?:days|vitals)\//u.test(unit)) faults.push(`${document.day} ${what} names ${unit}, a unit for the day that no extract has`);
      else if (read.get(family)?.has(unit) !== true) faults.push(`${document.day} ${what} names ${unit}, which no ${family} extract the day read holds`);
    }
  };
  for (const atom of document.atoms) {
    if (typeof atom.unit !== "string" || atom.unit === "") faults.push(`${document.day} atom ${atom.n} (${atom.family}) names no unit it is printed under`);
  }
  for (const atom of document.atoms) judge(`atom ${atom.n} (${atom.family})`, atom.family, atom.units);
  for (const fact of document.facts) judge(`fact ${fact.id} (${fact.family})`, fact.family, fact.from.units);
  return [...faults, ...accountFaults(document)];
}

export function conforming(rendered: RenderedDay): RenderedDay {
  const faults = unitsFault(rendered);
  if (faults.length > 0) throw new Error(`a day's things do not name their units and accounts:\n${faults.join("\n")}`);
  return rendered;
}
