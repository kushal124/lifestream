import { canonical, type AnswerType, type Prompt, type Tx } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { bare, compatible, faults } from "@lifestreamprotocol/model";


export const VERSION_META = "prompt:";
export const HELD_META = "prompts:held";

export type PromptShape = Pick<Prompt, "version" | "type" | "keeps" | "converters">;

export interface Recorded {
  name: string;
  version: number;
  type: AnswerType;
}

export function askingFamilies(families: readonly Family[]): Family[] {
  return families.filter((family) => family.works !== undefined && family.plan !== undefined);
}

export function planAgain(tx: Tx, families: readonly Family[]): void {
  for (const family of families) tx.tables.dirty.units(family.name, tx.derived.extracts.units(family.name).map((row) => row.unit));
}

export function promptsOf(families: readonly Family[]): Map<string, { family: string; prompt: Prompt }> {
  const found = new Map<string, { family: string; prompt: Prompt }>();
  for (const family of families) {
    for (const [name, prompt] of Object.entries(family.prompts ?? {})) {
      const other = found.get(name);
      if (other !== undefined) throw new TypeError(`families ${other.family} and ${family.name} both state prompt ${name}`);
      found.set(name, { family: family.name, prompt });
    }
  }
  return found;
}

export function promptFaults(prompts: Readonly<Record<string, PromptShape>>, before: readonly Recorded[], keptEqual = false): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const fault = (name: string, why: string) => found.set(name, [...found.get(name) ?? [], why]);
  for (const [name, prompt] of Object.entries(prompts)) {
    for (const { version, type } of [prompt, ...prompt.keeps]) {
      for (const why of faults(type)) fault(name, `version ${version}'s answer type is outside the subset: ${why}`);
    }
    const kept = new Set<number>();
    for (const each of prompt.keeps) {
      if (each.version >= prompt.version) fault(name, `keeps version ${each.version}, which is not below its version ${prompt.version}`);
      if (kept.has(each.version)) fault(name, `keeps version ${each.version} twice`);
      kept.add(each.version);
      const reasons = compatible(each.type, prompt.type);
      if (reasons.length > 0 && prompt.converters?.[each.version] === undefined) {
        fault(name, `keeps version ${each.version}, whose answers version ${prompt.version}'s type does not read (${reasons.join("; ")}), with no converter`);
      }
    }
  }
  for (const recorded of before) {
    const prompt = prompts[recorded.name];
    if (prompt === undefined) continue;
    if (recorded.version > prompt.version) {
      fault(recorded.name, `went down from version ${recorded.version} to ${prompt.version}`);
      continue;
    }
    const current = recorded.version === prompt.version;
    const stated = current ? prompt.type : prompt.keeps.find((each) => each.version === recorded.version)?.type;
    if (stated === undefined) continue;
    if (!current && keptEqual) {
      if (canonical(bare(recorded.type)) !== canonical(bare(stated))) fault(recorded.name, `keeps version ${recorded.version} with a type other than the one it was stated with`);
      continue;
    }
    const reasons = compatible(recorded.type, stated);
    if (reasons.length > 0) fault(recorded.name, `version ${recorded.version}'s answer type changed: give it a new version (${reasons.join("; ")})`);
  }
  return found;
}

export function startPrompts(tx: Tx, families: readonly Family[], recorded: readonly Recorded[]): Map<string, { family: string; faults: string[] }> {
  const prompts = promptsOf(families);
  const moved = new Set<string>();
  for (const [name, { family, prompt }] of prompts) {
    const stored = tx.tables.meta.get(`${VERSION_META}${name}`);
    if (stored === String(prompt.version)) continue;
    if (stored !== undefined) moved.add(family);
    tx.tables.meta.set(`${VERSION_META}${name}`, String(prompt.version));
  }
  planAgain(tx, askingFamilies(families).filter((family) => moved.has(family.name)));
  const faulty = promptFaults(Object.fromEntries([...prompts].map(([name, { prompt }]) => [name, prompt])), recorded);
  const held = new Map([...faulty].map(([name, why]) => [name, { family: prompts.get(name)!.family, faults: why }]));
  if (held.size === 0) tx.tables.meta.delete(HELD_META);
  else tx.tables.meta.set(HELD_META, JSON.stringify(Object.fromEntries(held)));
  return held;
}
