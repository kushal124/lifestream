import { createHash } from "node:crypto";
import { canonical, type HomeFolder, type Json, type Level } from "@lifestreamprotocol/core";
import { openLedger } from "@lifestreamprotocol/model";
import { ASK_READER, fullAccess } from "../access.js";
import type { HiddenReader } from "../principals.js";
import type { Writer } from "../writers.js";

const LEVELS = new Map<string, Level>();

export function agentAt(level: Level, name = "Vault App"): HiddenReader {
  const pass = `p-${createHash("sha256").update(JSON.stringify(level)).digest("hex").slice(0, 8)}`;
  LEVELS.set(pass, level);
  return { pass, agent: { table: `grant:${pass}`, name } };
}

export function settled(folder: HomeFolder, now_ms: number): void {
  const ledger = openLedger(folder, { mode: "write" });
  try {
    if (ledger.access.moved() === null) ledger.access.move([{ reader: ASK_READER, lines: fullAccess("none") as unknown as Json, covers: [] }], now_ms);
  } finally {
    ledger.close();
  }
}

export function levelled<W extends Pick<Writer, "begin" | "person">>(folder: HomeFolder, writer: W, now_ms: number): W {
  const held = (reader: string) => {
    settled(folder, now_ms);
    const level = LEVELS.get(reader);
    if (level === undefined) return;
    const ledger = openLedger(folder, { mode: "write" });
    try {
      const lines = fullAccess(level) as unknown as Json;
      const now = ledger.access.get(reader);
      if (now === undefined || canonical(now.lines) !== canonical(lines)) ledger.access.change(reader, { from: now?.version ?? 0, what: "granted", lines, covers: [] }, { at_ms: now_ms, by: "person", device: null });
    } finally {
      ledger.close();
    }
  };
  return {
    ...writer,
    begin: (async (call) => {
      held(call.reader);
      return writer.begin(call);
    }) as W["begin"],
    person: (async (asked) => {
      if ("reader" in asked) held(asked.reader.reader);
      return writer.person(asked);
    }) as W["person"],
  };
}
