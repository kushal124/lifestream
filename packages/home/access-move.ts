import type { HomeFolder, Json, Level } from "@lifestreamprotocol/core";
import type { AccessLog } from "@lifestreamprotocol/model";
import { AccessError, parseAccess } from "@lifestreamprotocol/privacy";
import { ASK_READER, fullAccess, reachesOf, type Existing } from "./access.js";
import { failpoint } from "./failpoint.js";
import { readPrincipals, writePrincipals, type Principal } from "./principals.js";


export interface Settled {
  moved: boolean;
  removed: string[];
}

export interface SettleInputs {
  readonly folder: HomeFolder;
  readonly access: Pick<AccessLog, "moved" | "move" | "all" | "remove">;
  readonly existing: () => readonly Existing[];
  readonly now_ms: number;
}

export function settleAccess(inputs: SettleInputs): Settled {
  const moved = moveAccess(inputs);
  failpoint("access.moved");
  dropLevels(inputs.folder);
  return { moved, removed: removeUnheld(inputs) };
}

export function dropLevels(folder: HomeFolder): boolean {
  const file = readPrincipals(folder);
  if (!file.principals.some((row) => row.agent !== undefined && Object.hasOwn(row.agent, "level"))) return false;
  writePrincipals(folder, {
    ...file,
    principals: file.principals.map((row) => {
      if (row.agent === undefined || !Object.hasOwn(row.agent, "level")) return row;
      const { level: _level, ...agent } = row.agent as typeof row.agent & { level?: Json };
      return { ...row, agent };
    }),
  });
  return true;
}

export function moveAccess(inputs: SettleInputs): boolean {
  if (inputs.access.moved() !== null) return false;
  const agents = readPrincipals(inputs.folder).principals.filter(live);
  const existing = inputs.existing();
  const accesses = [
    ...agents.map((row) => ({ reader: row.id, hide: oldLevel((row.agent as { level?: Json } | undefined)?.level) })),
    { reader: ASK_READER, hide: "none" as Level },
  ].map(({ reader, hide }) => {
    const lines = fullAccess(hide);
    return { reader, lines: lines as unknown as Json, covers: reachesOf(lines, existing, inputs.now_ms) };
  });
  return inputs.access.move(accesses, inputs.now_ms);
}

export function removeUnheld(inputs: Pick<SettleInputs, "folder" | "access" | "now_ms">): string[] {
  const held = new Set(readPrincipals(inputs.folder).principals.filter(live).map((row) => row.id));
  const removed: string[] = [];
  for (const each of inputs.access.all()) {
    if (each.reader === ASK_READER || held.has(each.reader)) continue;
    inputs.access.remove(each.reader, each.version, { at_ms: inputs.now_ms, by: "home", device: null });
    removed.push(each.reader);
  }
  return removed;
}

function live(row: Principal): boolean {
  return row.kind === "agent" && row.revoked_at === null;
}

function oldLevel(value: Json | undefined): Level {
  if (value === undefined) return "names";
  return hideOf(value) ?? "all";
}

function hideOf(value: Json): Level | null {
  try {
    return parseAccess({ ...fullAccess("all"), hide: value } as unknown).hide;
  } catch (error) {
    if (error instanceof AccessError) return null;
    throw error;
  }
}
