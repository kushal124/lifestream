import { join } from "node:path";
import type Database from "better-sqlite3";
import { HOME_STORE, homeError, type HomeFolder } from "@lifestreamprotocol/core";
import { readArgs } from "./args.js";
import { fail } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "maintenance checkpoint";

export function maintenance(folder: HomeFolder, args: readonly string[]) {
  const { positionals } = readArgs("maintenance", args, {}, USAGE, 1);
  if (positionals[0] !== "checkpoint") fail(`usage: ${CLI} ${USAGE}`);
  try {
    const db = openExclusive(folder, join(folder.root, "home.db"));
    try {
      const [row] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[];
      if (row!.busy !== 0) fail("home.db's log could not be truncated: a reader holds it");
      return { checkpoint: row };
    } finally {
      db.close();
    }
  } catch (error) {
    throw homeError(error);
  }
}
maintenance.usage = USAGE;

function openExclusive(folder: HomeFolder, path: string): Database.Database {
  const db = folder.store(HOME_STORE, path, { mustExist: true });
  db.pragma("locking_mode = EXCLUSIVE");
  db.exec("BEGIN IMMEDIATE; COMMIT");
  return db;
}
