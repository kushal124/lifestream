import { lstatSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { feeds, fileSha256, rfc3339, type Acquirer, type AcquirerSettings, type Dependencies, type FetchedFile, type Memory } from "@lifestreamprotocol/connect/sdk";

export const NOTES = /\.md$/iu;
export const PER_CALL = 500;
const BYTES = 64 * 1024 * 1024;
export const FILE = "file";
export const MANIFEST = "folder.json";

export interface ExampleFolderFields {
  folder: string;
}

interface Sealed {
  size: number;
  modified_ms: number;
  sha256: string;
}

interface Found {
  path: string;
  file: string;
  size: number;
  created_ms: number;
  modified_ms: number;
}

export function exampleFolderAcquirer(settings: AcquirerSettings<ExampleFolderFields>, dependencies: Dependencies = {}): Acquirer {
  const now = dependencies.now ?? Date.now;
  const source = `example-folder:local:${settings.unit}`;
  return {
    name: "example-folder",
    source,
    async fetch(_state, _secrets, lent) {
      const at = now();
      const folder = opened(settings.folder);
      const { found, present } = walk(folder);
      if (present.size === 0 && lent.memory.list(FILE, undefined, 1).length > 0) {
        throw new Error(`the notes folder ${folder} holds no note now: connect its drive if it is on one. Notes deleted from it go gone once it holds a note again`);
      }
      const floor = lent.start_ms ?? -Infinity;
      const files: FetchedFile[] = [];
      const listed: { path: string; file: string; created: string; modified: string }[] = [];
      let bytes = 0;
      let more = false;
      for (const each of found) {
        if (each.modified_ms < floor) continue;
        const known = sealedOf(lent.memory.get(FILE, each.path));
        if (known?.size === each.size && known.modified_ms === each.modified_ms) continue;
        if (listed.length === PER_CALL || (listed.length > 0 && bytes + each.size > BYTES)) {
          more = true;
          break;
        }
        const sha256 = fileSha256(each.file);
        lent.memory.put(FILE, each.path, { size: each.size, modified_ms: each.modified_ms, sha256 });
        if (known?.sha256 === sha256) continue;
        bytes += each.size;
        const name = `files/${listed.length + 1}`;
        files.push({ path: name, file: each.file });
        listed.push({ path: each.path, file: name, created: rfc3339(each.created_ms), modified: rfc3339(each.modified_ms) });
      }
      const gone = goneFrom(lent.memory, present);
      for (const path of gone) lent.memory.drop(FILE, path);
      if (listed.length === 0 && gone.length === 0) return { files: [], facts: {}, state: {}, ...(more ? { more: true as const } : {}) };
      files.push({ path: MANIFEST, bytes: Buffer.from(JSON.stringify({ files: listed, gone })) });
      return { files, facts: { fetched_at: rfc3339(at), ...feeds(source, "example-folder") }, state: {}, ...(more ? { more: true as const } : {}) };
    },
  };
}

function opened(folder: unknown): string {
  if (typeof folder !== "string" || !isAbsolute(folder)) throw new Error(`the notes folder ${JSON.stringify(folder ?? "")} is no full path: choose it in the connector's settings`);
  let stat;
  try {
    stat = statSync(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new Error(`the notes folder ${folder} is not there: connect its drive, or choose it again in the connector's settings`);
    throw denied(folder, error);
  }
  if (!stat.isDirectory()) throw new Error(`the notes folder ${folder} is a file, not a folder: choose the folder in the connector's settings`);
  return folder;
}

function denied(folder: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES"
    ? new Error(`the home may not read ${folder}: allow Lifestream in System Settings, Privacy & Security, Full Disk Access`)
    : (error as Error);
}

function walk(folder: string): { found: Found[]; present: Set<string> } {
  const found: Found[] = [];
  const present = new Set<string>();
  const failed = (path: string, error: unknown): Error => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return denied(path, error);
    return new Error(path === folder
      ? `the notes folder ${folder} is not there: connect its drive, or choose it again in the connector's settings`
      : `the notes folder ${folder} changed while it was read: the next poll reads it again`);
  };
  const visit = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw failed(dir, error);
    }
    for (const entry of entries) {
      const evicted = /^\.(.+)\.icloud$/u.exec(entry.name)?.[1];
      if (evicted !== undefined && NOTES.test(evicted)) present.add(`${prefix}${evicted}`);
      if (entry.name.startsWith(".")) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visit(file, `${prefix}${entry.name}/`);
      else if (entry.isFile() && NOTES.test(entry.name)) {
        let stat;
        try {
          stat = lstatSync(file);
        } catch (error) {
          throw failed(file, error);
        }
        const modified_ms = Math.trunc(stat.mtimeMs);
        const created_ms = Math.min(Math.trunc(stat.birthtimeMs) || modified_ms, modified_ms);
        const path = `${prefix}${entry.name}`;
        present.add(path);
        found.push({ path, file, size: stat.size, created_ms, modified_ms });
      }
    }
  };
  visit(folder, "");
  return { found: found.sort((left, right) => (left.path < right.path ? -1 : 1)), present };
}

function sealedOf(value: unknown): Sealed | undefined {
  return typeof value === "object" && value !== null && typeof (value as Sealed).sha256 === "string" ? value as Sealed : undefined;
}

function goneFrom(memory: Memory, present: ReadonlySet<string>): string[] {
  const gone: string[] = [];
  for (let after: string | undefined; ;) {
    const page = memory.list(FILE, after);
    for (const [path] of page) if (!present.has(path)) gone.push(path);
    if (page.length === 0) return gone;
    after = page.at(-1)![0];
  }
}
