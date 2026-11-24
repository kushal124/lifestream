import fs, { appendFileSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import Database from "better-sqlite3";

const wait = new Int32Array(new SharedArrayBuffer(4));
let activeRoot = "";

const hold = (root: string, key: string) => {
  appendFileSync(`${root}/started`, `${key}\n`);
  if (existsSync(`${root}/${key}.fifo`)) {
    fs.readFileSync(`${root}/${key}.fifo`);
    return;
  }
  while (!existsSync(`${root}/${key}.release`)) Atomics.wait(wait, 0, 0, 10);
};

const stream = fs.createReadStream;
fs.createReadStream = ((path: fs.PathLike, ...rest: unknown[]) => {
  if (activeRoot !== "" && String(path).startsWith(`${activeRoot}/door/uploads/`)) hold(activeRoot, "bundle");
  return (stream as (...args: unknown[]) => fs.ReadStream)(path, ...rest);
}) as typeof fs.createReadStream;

const exists = fs.existsSync;
fs.existsSync = (path) => {
  if (activeRoot !== "" && String(path).endsWith("/extension/manifest.json")) {
    if (exists(`${activeRoot}/broken`)) throw new Error("a report that cannot be made");
    hold(activeRoot, "connectors");
  }
  return exists(path);
};

const statfs = fs.statfsSync;
fs.statfsSync = ((path: fs.PathLike, ...rest: unknown[]) => {
  if (activeRoot !== "" && exists(`${activeRoot}/answer.hold`)) hold(activeRoot, "answer");
  return (statfs as (...args: unknown[]) => fs.StatsFs)(path, ...rest);
}) as typeof fs.statfsSync;

const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (this: Database.Database, ...args: Parameters<typeof prepare>) {
  if (activeRoot !== "" && String(this.name).endsWith("/people.db") && exists(`${activeRoot}/prepared.hold`)) hold(activeRoot, "prepared");
  return prepare.apply(this, args);
} as typeof prepare;

syncBuiltinESMExports();

export default (_settings: unknown, { root }: { root: string }) => {
  activeRoot = root;
  return {
    connectors: [],
    readers: [],
    families: [{
      name: "held",
      inputs: [{ sources: { product: ["apple-notes"] }, kinds: ["note"] }],
      text: { kinds: ["note"], of: ({ key }: { key: string }) => { hold(root, key); return { title: key, text: key, who: [], link: null }; } },
    }],
  };
};
