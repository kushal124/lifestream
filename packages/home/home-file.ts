import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { damaged, HOME_DB, HOME_STORE, homeError, homeSchema, isSqliteError, openHome, type HomeFolder, type OpenView, type Schema, type StorageOrigin, type StoreKind } from "@lifestreamprotocol/core";
import { LEDGER_STORE, ledgerFileOf, ledgerSchema } from "@lifestreamprotocol/model";
import type { HomeDatabase } from "./hold.js";

export class HomeFile {
  readonly path: string;

  constructor(readonly folder: HomeFolder, readonly timeout = 0) {
    this.path = join(folder.root, HOME_DB);
  }

  read<T>(read: (db: Database.Database) => T): T | undefined {
    if (!existsSync(this.path)) return undefined;
    const db = this.folder.store(HOME_STORE, this.path, { mode: "read", mustExist: true, timeout: this.timeout });
    try {
      const why = homeSchema.refusal(homeSchema.version(db));
      if (why !== null) throw new Error(why);
      return read(db);
    } finally {
      db.close();
    }
  }

  view<T>(read: (view: OpenView) => T): T | undefined {
    const held = this.open();
    if (held === undefined) return undefined;
    try {
      return read(held.view);
    } finally {
      held.end();
    }
  }

  open(): { view: OpenView; end(): void } | undefined {
    if (!existsSync(this.path)) return undefined;
    const home = openHome(this.folder, "read", { busy_timeout_ms: this.timeout });
    let view: OpenView;
    try {
      view = home.view();
    } catch (error) {
      home.close();
      throw error;
    }
    let ended = false;
    return {
      view,
      end: () => {
        if (ended) return;
        ended = true;
        try {
          view.close();
        } finally {
          home.close();
        }
      },
    };
  }
}

export interface FileCheck {
  version: number | null;
  refused: string | null;
}

export function checkFile(folder: HomeFolder, { path, schema, kind }: RootFile): FileCheck {
  if (!existsSync(path)) return { version: null, refused: null };
  let db: Database.Database | undefined;
  let version: number | null = null;
  try {
    db = folder.store(kind, path, { mode: "read", mustExist: true, timeout: 5_000 });
    version = schema.version(db);
    schema.check(db);
    return { version: version === 0 ? null : version, refused: null };
  } catch (error) {
    if (isSqliteError(error) || damaged(error)) throw homeError(error, schema.file as StorageOrigin);
    return { version: version === 0 ? null : version, refused: (error as Error).message };
  } finally {
    db?.close();
  }
}

export interface RootFile {
  readonly name: HomeDatabase;
  readonly path: string;
  readonly schema: Schema;
  readonly kind: StoreKind;
}

export function rootFiles(root: string): { home_db: RootFile; ledger: RootFile } {
  return {
    home_db: { name: "home.db", path: join(root, HOME_DB), schema: homeSchema, kind: HOME_STORE },
    ledger: { name: "the ledger", path: ledgerFileOf(root), schema: ledgerSchema, kind: LEDGER_STORE },
  };
}

export function checkFiles(folder: HomeFolder): void {
  for (const file of Object.values(rootFiles(folder.root))) {
    const { refused } = checkFile(folder, file);
    if (refused !== null) throw new Error(refused);
  }
}

export function versionsOff(folder: HomeFolder): string[] {
  const lines: string[] = [];
  for (const file of Object.values(rootFiles(folder.root))) {
    const { schema } = file;
    const { version, refused } = checkFile(folder, file);
    if (version === schema.latest) continue;
    const words = version === null ? null : schema.refusal(version);
    if (words !== null) lines.push(words);
    if (refused !== null && refused !== words) lines.push(refused);
  }
  return lines;
}
