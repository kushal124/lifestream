import { Worker } from "node:worker_threads";

const terminateWorker = Worker.prototype.terminate;

const MAX_IDLE = 4;
const IDLE_MS = 60_000;
const DYNAMIC_ENV = new Set(["LIFESTREAM_FOLDERS", "LIFESTREAM_MACHINE_DIR", "LIFESTREAM_TEST_FREE"]);

interface Parked {
  worker: Worker;
  timer: NodeJS.Timeout;
  onExit: () => void;
}

const pools = new Map<string, Parked[]>();

function envStamp(): string {
  const keys = Object.keys(process.env).filter((key) => key.startsWith("LIFESTREAM_") && !DYNAMIC_ENV.has(key)).sort();
  return keys.map((key) => `${key}=${process.env[key] ?? ""}`).join("\0");
}

export function workerKey(program: { url: URL; execArgv?: string[] }): string {
  return `${program.url.href}\0${program.execArgv === undefined ? "" : JSON.stringify(program.execArgv)}\0${envStamp()}`;
}

export function takeWorker(key: string): Worker | undefined {
  const list = pools.get(key);
  if (list === undefined || list.length === 0) return undefined;
  const entry = list.pop()!;
  clearTimeout(entry.timer);
  entry.worker.off("exit", entry.onExit);
  entry.worker.removeAllListeners("error");
  entry.worker.ref();
  return entry.worker;
}

export function parkWorker(key: string, worker: Worker): void {
  let list = pools.get(key);
  if (list === undefined) {
    list = [];
    pools.set(key, list);
  }
  if (list.length >= MAX_IDLE) {
    void terminateWorker.call(worker).catch(() => undefined);
    return;
  }
  for (const event of ["message", "error", "exit"]) worker.removeAllListeners(event);
  worker.on("error", () => undefined);
  const remove = () => {
    clearTimeout(timer);
    const at = list!.indexOf(entry);
    if (at >= 0) list!.splice(at, 1);
  };
  const timer = setTimeout(() => {
    remove();
    void terminateWorker.call(worker).catch(() => undefined);
  }, IDLE_MS);
  timer.unref();
  const entry: Parked = { worker, timer, onExit: remove };
  worker.once("exit", remove);
  worker.unref();
  list.push(entry);
}

export function detachWorker(key: string, worker: Worker, message: unknown, isDetached: (reply: unknown) => boolean, timeoutMs = 500): Promise<void> {
  for (const event of ["message", "error", "exit"]) worker.removeAllListeners(event);
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (park: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
      worker.off("error", onError);
      if (park) {
        parkWorker(key, worker);
        resolve();
      } else {
        void terminateWorker.call(worker).then(() => resolve(), () => resolve());
      }
    };
    const onMessage = (reply: unknown) => {
      if (isDetached(reply)) done(true);
    };
    const onExit = () => done(false);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    worker.once("error", onError);
    try {
      worker.postMessage(message);
    } catch {
      done(false);
    }
  });
}
