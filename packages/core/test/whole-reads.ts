import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function wholeReads(paths: readonly string[]): string {
  return `
    import { watchWholeReads } from ${JSON.stringify(import.meta.url)};
    const whole = await watchWholeReads(${JSON.stringify(paths)});
  `;
}

type PathLike = string | Buffer | URL | number;

export async function watchWholeReads(paths: readonly string[]): Promise<{ largest(): number }> {
  const watched = paths.map((path) => resolve(path));
  const named = (path: Exclude<PathLike, number>): string =>
    resolve(path instanceof URL || String(path).startsWith("file:") ? fileURLToPath(path instanceof URL ? path : String(path)) : String(path));
  const isWatched = (path: PathLike): boolean => {
    if (typeof path === "number") return false;
    const at = named(path);
    return watched.some((each) => at === each || at.startsWith(each + sep));
  };
  const refuse = (path: PathLike): never => {
    throw new Error(`a whole read of ${typeof path === "number" ? path : named(path)}`);
  };
  const guard = <F extends (path: PathLike, ...rest: never[]) => unknown>(read: F): F =>
    function (this: unknown, path: PathLike, ...rest: never[]) {
      if (isWatched(path)) refuse(path);
      return read.call(this, path, ...rest);
    } as F;
  fs.readFileSync = guard(fs.readFileSync as never);
  fs.readFile = guard(fs.readFile as never);
  fs.promises.readFile = guard(fs.promises.readFile as never);
  const opened = new WeakMap<object, PathLike>();
  const open = fs.promises.open;
  fs.promises.open = async function (this: unknown, path: PathLike, ...rest: never[]) {
    const handle = await (open as (...args: unknown[]) => Promise<FileHandle>).call(this, path, ...rest);
    opened.set(handle, path);
    return handle;
  } as typeof fs.promises.open;
  const probe = await open(process.execPath, "r");
  const handles = Object.getPrototypeOf(probe) as { readFile: (...args: unknown[]) => unknown };
  await probe.close();
  const readFile = handles.readFile;
  handles.readFile = function (this: object, ...rest: unknown[]) {
    const path = opened.get(this);
    if (path !== undefined && isWatched(path)) refuse(path);
    return readFile.apply(this, rest);
  };
  syncBuiltinESMExports();
  let largest = 0;
  const made = Buffer as unknown as Record<string, (...args: unknown[]) => Buffer>;
  for (const name of ["alloc", "allocUnsafe", "allocUnsafeSlow", "from", "concat"]) {
    const make = made[name]!;
    made[name] = function (this: unknown, ...args: unknown[]) {
      const buffer = make.apply(this, args);
      largest = Math.max(largest, buffer.length);
      return buffer;
    };
  }
  return { largest: () => largest };
}
