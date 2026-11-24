import { SHARE_ENV, Worker } from "node:worker_threads";
import type { DaySettings, HomeFolder, JsonObject, LevelName, PlaceholderTable, Wanted } from "@lifestreamprotocol/core";
import type { Epoch, Ledger, NewOutbound, OutboundList, OutboundRow, Saved, TablePart } from "@lifestreamprotocol/model";
import type { Begun, CallBegin, CallEnd, PersonWriting } from "./access-ledger.js";
import { detachWorker, takeWorker, workerKey } from "./idle-workers.js";
import { threadProgram } from "./programs.js";
import { Refusal } from "./refusal.js";
import type { FromWriter, ToWriter, Writing } from "./writer.js";

const BOOT_DETACH_MS = 2_000;

export interface Writer {
  person<T>(asked: PersonWriting): Promise<T>;
  epoch(): Promise<Epoch>;
  level(scope: string, start: LevelName, pick?: LevelName): Promise<LevelName>;
  level(scope: string, start: null): Promise<LevelName | null>;
  part(scope: string, wanted: Wanted): Promise<TablePart>;
  save(read: TablePart, answered: PlaceholderTable, outbound?: NewOutbound, end?: CallEnd): Promise<Saved>;
  begin(call: CallBegin): Promise<Begun>;
  end(end: CallEnd): Promise<boolean>;
  outbound(row: NewOutbound): Promise<number>;
  list(query: { from: string; to: string; receiver?: string; before?: number; day: DaySettings }): Promise<OutboundList>;
  carried(record: { source: string; kind: string; key: string }, day: DaySettings): Promise<OutboundRow[]>;
  asked(item: { family: string; item: string }, day: DaySettings): Promise<OutboundRow[]>;
  row(seq: number, day: DaySettings): Promise<NonNullable<ReturnType<Ledger["outbound"]["row"]>> | null>;
  close(): Promise<void>;
}

export function openWriter(folder: HomeFolder, machine: string, quiet: string, log: (line: JsonObject) => void): Writer {
  let worker: Worker | null = null;
  let key = "";
  let isUp = false;
  let up: Promise<void> = Promise.resolve();
  let next = 0;
  let closed = false;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  const lost = (why: string) => {
    worker = null;
    isUp = false;
    for (const [id, each] of waiting) {
      waiting.delete(id);
      each.reject(new Error(`the writer thread ended: ${why}`));
    }
  };

  const spawn = (): Worker => {
    const program = threadProgram("writer");
    key = workerKey(program);
    const started = takeWorker(key) ?? new Worker(program.url, {
      env: SHARE_ENV,
      ...(program.execArgv === undefined ? {} : { execArgv: program.execArgv }),
    });
    isUp = false;
    let said!: () => void;
    up = new Promise((resolve) => { said = resolve; });
    started.once("exit", () => said());
    started.on("message", (answer: FromWriter | { up: true } | { detached: true }) => {
      if ("detached" in answer) return;
      if ("up" in answer) {
        isUp = true;
        said();
        return;
      }
      const held = waiting.get(answer.id);
      if (held === undefined) return;
      waiting.delete(answer.id);
      if ("value" in answer) held.resolve(answer.value);
      else if ("refusal" in answer) {
        if (answer.cause !== undefined) log({ writer: "failed", cause: answer.cause });
        const { status, code, message, retryAfter } = answer.refusal;
        held.reject(new Refusal(status, code, message, retryAfter));
      } else held.reject(new Error(answer.error));
    });
    started.on("error", (error) => {
      log({ writer: "ended", why: error.message });
      if (worker === started) lost(error.message);
    });
    started.on("exit", (code) => {
      if (worker === started) lost(`it exited with ${code}`);
    });
    started.postMessage({ attach: { root: folder.root, machine, handed: folder.handOver(), quiet } } satisfies ToWriter);
    return started;
  };

  const ask = <T>(writing: Writing): Promise<T> => {
    if (closed) return Promise.reject(new Error("the door's writer is closed"));
    worker ??= spawn();
    const id = next++;
    const message: ToWriter = { id, writing };
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker!.postMessage(message);
    });
  };

  return {
    epoch: () => ask({ epoch: true }),
    level: ((scope: string, start: LevelName | null, pick?: LevelName) => ask({ level: { scope, start, ...(pick === undefined ? {} : { pick }) } })) as Writer["level"],
    person: (asked) => ask({ person: asked }),
    part: (scope, wanted) => ask({ part: { scope, wanted } }),
    save: (read, answered, outbound, end) => ask({ save: { read, answered, ...(outbound === undefined ? {} : { outbound }), ...(end === undefined ? {} : { end }) } }),
    begin: (call) => ask({ begin: call }),
    end: (end) => ask({ end }),
    outbound: (row) => ask({ outbound: row }),
    list: (query) => ask({ list: query }),
    carried: (record, day) => ask({ carried: { record, day } }),
    asked: (item, day) => ask({ asked: { item, day } }),
    row: (seq, day) => ask({ row: { seq, day } }),
    async close() {
      closed = true;
      const ending = worker;
      const wasUp = isUp;
      const idle = waiting.size === 0;
      lost("the door closed");
      if (ending === null) return;
      if (idle && process.env.LIFESTREAM_FAILPOINT === undefined) {
        await detachWorker(key, ending, { detach: true } satisfies ToWriter, (reply) => typeof reply === "object" && reply !== null && "detached" in reply, wasUp ? 500 : BOOT_DETACH_MS);
        return;
      }
      await up;
      await ending.terminate();
    },
  };
}
