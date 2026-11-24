import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { basename } from "node:path";
import { isMainThread, threadId } from "node:worker_threads";

const ENGINE = "better-sqlite3-multiple-ciphers";
const into = process.env.LIFESTREAM_ENGINE_REPORT;
const program = isMainThread ? basename(process.argv[1] ?? "") : "thread";
const say = (line) => appendFileSync(into, `${JSON.stringify({ pid: process.pid, thread: threadId, program, ...line })}\n`);

if (into !== undefined) {
  say({ at: "start" });
  registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (resolved.url.includes(ENGINE)) say({ at: "load", module: resolved.url });
      return resolved;
    },
  });
  if (isMainThread) {
    process.once("exit", () => {
      say({ at: "exit", binaries: process.report.getReport().sharedObjects.filter((path) => path.includes(ENGINE)) });
    });
  }
}
