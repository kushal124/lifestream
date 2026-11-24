import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { damaged, openHandedFolder, plainFolder, type HomeFolder } from "@lifestreamprotocol/core";
import { rootFiles } from "../home-file.js";
import { admitAsk, hold, readHold, release, type Hold, type HomeDatabase } from "../hold.js";
import { handedOnInput, KEYS_ON_INPUT, running } from "../hold-check.js";
import { errorText } from "../jobs.js";
import { HomeRoot, LifecycleError, readHome } from "../lifecycle.js";
import type { Machine } from "../machine.js";
import { quiet } from "../move.js";
import { readArgs } from "./args.js";
import { CLI } from "../cli-name.js";

const USAGE = "verify";
const SHOWN = 10;

export function missingFiles(root: string): HomeDatabase[] {
  const files = rootFiles(root);
  const ran = existsSync(join(root, "blobs")) || existsSync(files.ledger.path);
  return ran ? Object.values(files).filter((file) => !existsSync(file.path)).map((file) => file.name) : [];
}

export function missingLine(name: HomeDatabase): string {
  return `${name} is not there, though the home has run here: it is never made again empty`;
}

export function holdMissing(at: Machine, id: string, missing: readonly HomeDatabase[]): Hold {
  const now = Date.now();
  const value: Hold = { since_ms: now, cause: { missing: missing[0]! }, check: { found: missing.map(missingLine), at_ms: now } };
  hold(at, id, value);
  return value;
}

export interface Verified {
  holds: boolean;
  wrong: string[];
  hold: Hold | null;
}

export interface AskedCheck {
  asked: "asked" | "checking";
}

interface Finding {
  file: HomeDatabase;
  line: string;
  missing: boolean;
}

export async function verify(root: string, at: Machine, args: readonly string[], out: (line: string) => void, signal?: AbortSignal): Promise<Verified | AskedCheck> {
  const told = readArgs("verify", args, { [KEYS_ON_INPUT.slice(2)]: { type: "boolean" } }, USAGE, 0).values[KEYS_ON_INPUT.slice(2)] === true;
  const { id } = readHome(root);
  const folder = told ? openHandedFolder(await handedOnInput()) : plainFolder(root);
  if (folder === null) return askedOfHome(at, id, out);
  const opened = HomeRoot.open(root);
  let locks: { release(): void } | undefined;
  try {
    try {
      locks = await quiet(root, { out, ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      const before = readHold(at, id);
      if (before !== null && !opened.look()) hold(at, id, { ...before, check: { unfinished: "drive", at_ms: Date.now() } });
      throw error;
    }
    const before = readHold(at, id);
    if (before !== null) hold(at, id, { ...before, check: running() });
    let found: Finding[];
    try {
      found = check(folder, opened, out);
    } catch (error) {
      if (before !== null) hold(at, id, { ...before, check: { unfinished: opened.look() ? "stopped" : "drive", at_ms: Date.now() } });
      throw error;
    }
    const wrong = found.map((each) => each.line);
    const holds = wrong.length === 0;
    if (holds && before !== null) release(at, id);
    if (!holds) {
      const now = Date.now();
      const missing = found.find((each) => each.missing);
      hold(at, id, {
        since_ms: before?.since_ms ?? now,
        cause: missing !== undefined ? { missing: missing.file } : { met: found[0]!.file, error: found[0]!.line },
        check: { found: wrong, at_ms: now },
      });
    }
    const after = readHold(at, id);
    if (holds) out(`The home holds${before === null ? "" : ": its hold is released, and it starts"}.`);
    else out(`The home does not hold, and stays held: put back a good copy of the file it names, then run ${CLI} verify again.`);
    return { holds, wrong, hold: after };
  } finally {
    try {
      locks?.release();
    } finally {
      opened.close();
    }
  }
}
verify.usage = USAGE;

function askedOfHome(at: Machine, id: string, out: (line: string) => void): AskedCheck {
  const admitted = admitAsk(at, id);
  if (admitted === "free") throw new LifecycleError("Lifestream is encrypted, and only its home checks it, when something reads wrong: it is not held, so there is nothing to check.");
  out(admitted === "asked" ? `Lifestream checks its database now, with its keys: ${CLI} status says when it ends.` : "Lifestream is already checking its database.");
  return { asked: admitted };
}

function check(folder: HomeFolder, opened: HomeRoot, out: (line: string) => void): Finding[] {
  const { root } = folder;
  const found: Finding[] = [];
  const say = (file: HomeDatabase, line: string, missing = false) => {
    out(line);
    found.push({ file, line, missing });
  };
  const missing = missingFiles(root);
  for (const name of missing) say(name, missingLine(name), true);
  for (const file of Object.values(rootFiles(root))) {
    if (!existsSync(file.path)) {
      if (missing.length === 0) out(`${file.name}: none yet`);
      continue;
    }
    const bytes = statSync(file.path).size;
    out(`${file.name}: checking its ${gb(bytes)}`);
    const began = Date.now();
    const findings = guarded(opened, () => {
      const db = folder.store(file.kind, file.path, { mode: "read", mustExist: true, mapped: bytes });
      try {
        const lines = (db.pragma("integrity_check") as Record<string, unknown>[]).flatMap((row) => String(Object.values(row)[0]).split("\n")).filter((line) => !line.startsWith("*** "));
        const structure = lines.length === 1 && lines[0] === "ok" ? [] : [`${file.name} is damaged: SQLite finds ${lines.slice(0, SHOWN).join("; ")}${lines.length > SHOWN ? `; and ${lines.length - SHOWN} more` : ""}`];
        return file.name === "home.db" ? [...structure, ...guarded(opened, () => headsWithoutVersions(db)).map((line) => `home.db: ${line}`)] : structure;
      } finally {
        db.close();
      }
    }, file.name);
    const took = `in ${((Date.now() - began) / 1_000).toFixed(1)} s`;
    for (const line of findings) say(file.name, line);
    out(findings.length === 0 ? `${file.name}: whole, ${took}` : `${file.name}: checked, ${took}`);
  }
  if (!opened.look()) unfinished();
  return found;
}

function unfinished(): never {
  throw new LifecycleError("the home's folder no longer reads as it was opened (its drive left): the check could not finish, and runs again");
}

function guarded(opened: HomeRoot, check: () => string[], name?: string): string[] {
  try {
    return check();
  } catch (error) {
    if (damaged(error) && opened.look()) return [`${name === undefined ? "" : `${name} is damaged: `}SQLite could not read it: ${errorText(error)}`];
    if (damaged(error)) unfinished();
    throw error;
  }
}

function headsWithoutVersions(db: Database.Database): string[] {
  const rows = db.prepare(`SELECT source, kind, key FROM heads h WHERE version <> 'gone'
    AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.id = h.version)`).iterate() as IterableIterator<{ source: string; kind: string; key: string }>;
  let count = 0;
  const named: string[] = [];
  for (const row of rows) {
    if (count++ < 5) named.push(`${row.source} ${row.kind} ${row.key}`);
  }
  return count === 0 ? [] : [`${count} record${count === 1 ? " points" : "s point"} at content the home does not hold (such as ${named.join("; ")})`];
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes < 1e9 ? 3 : 1)} GB`;
}
