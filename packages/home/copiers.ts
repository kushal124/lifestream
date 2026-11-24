import { SHARE_ENV, Worker } from "node:worker_threads";
import type { HandedFolder } from "@lifestreamprotocol/core";
import { detachWorker, takeWorker, workerKey } from "./idle-workers.js";
import { jobError, type JobError } from "./job-error.js";
import { threadProgram } from "./programs.js";
import type { Copied } from "./write-log.js";

export type ToCopier = { attach: HandedFolder } | "copy" | "detach" | "close";
export type FromCopier = Copied | { failed: JobError } | "detached";
export type CopierAnswer = Copied | { lost: JobError } | "closed";

export interface Copier {
  copy(): void;
  close(): Promise<void>;
}

export function openCopier(handed: HandedFolder, answered: (answer: CopierAnswer) => void): Copier {
  let worker: Worker | null = null;
  let key = "";
  let out = false;
  let closed = false;

  const settle = (answer: CopierAnswer) => {
    if (!out) return;
    out = false;
    answered(answer);
  };

  const spawn = (): Worker => {
    const program = threadProgram("copier");
    key = workerKey(program);
    const thread = takeWorker(key) ?? new Worker(program.url, { env: SHARE_ENV, ...(program.execArgv === undefined ? {} : { execArgv: program.execArgv }) });
    thread.postMessage({ attach: handed } satisfies ToCopier);
    let why: JobError | null = null;
    thread.on("message", (said: FromCopier) => {
      if (thread !== worker || said === "detached") return;
      settle("failed" in said ? { lost: said.failed } : said);
    });
    thread.on("error", (error) => {
      why = jobError(error);
    });
    thread.on("exit", (code) => {
      if (thread !== worker) return;
      worker = null;
      settle({ lost: why === null ? { message: `the copier ended: exit ${code}` } : { ...why, message: `the copier ended: ${why.message}` } });
    });
    return thread;
  };

  return {
    copy() {
      if (closed) throw new Error("the copier is closed");
      if (out) throw new Error("a copy is out already");
      worker ??= spawn();
      worker.postMessage("copy" satisfies ToCopier);
      out = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      const thread = worker;
      const busy = out;
      worker = null;
      if (thread !== null) {
        if (!busy && process.env.LIFESTREAM_FAILPOINT === undefined) {
          await detachWorker(key, thread, "detach" satisfies ToCopier, (reply) => reply === "detached");
        } else {
          const ended = new Promise<void>((resolve) => thread.once("exit", () => resolve()));
          thread.postMessage("close" satisfies ToCopier);
          await ended;
        }
      }
      settle("closed");
    },
  };
}
