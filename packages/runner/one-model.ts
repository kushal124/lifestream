import { createHash } from "node:crypto";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { Artifact } from "@lifestreamprotocol/model";
import { NotReady } from "./library.js";


export class Broken extends Error {
  override readonly name = "Broken";
}

export interface Disposable {
  dispose(): void;
}

export interface Pinned {
  readonly path: string;
  readonly artifact: Artifact;
}

export interface OneModel<R extends { readonly id: string }, M extends Disposable> {
  use<T>(row: R, signal: AbortSignal, work: (model: () => Promise<M>) => Promise<T>): Promise<T>;
  letGo(row: R, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

const IDLE_MS = 5 * 60_000;

interface Held<M> {
  readonly id: string;
  readonly model: Promise<M>;
  users: number;
  leaving: boolean;
  idle: ReturnType<typeof setTimeout> | undefined;
  readonly gone: Promise<void>;
  readonly letGo: () => void;
}

export function oneModel<R extends { readonly id: string }, M extends Disposable>(load: (row: R) => Promise<M>, idle_ms = IDLE_MS): OneModel<R, M> {
  let loaded: Held<M> | null = null;
  let closing: Promise<void> | null = null;

  function begin(row: R): Held<M> {
    const model = load(row);
    let wentAway = (): void => undefined;
    const gone = new Promise<void>((resolve) => { wentAway = resolve; });
    let letting = false;
    const made: Held<M> = {
      id: row.id, model, users: 0, leaving: false, idle: undefined, gone,
      letGo() {
        if (letting) return;
        letting = true;
        void model.then((each) => each.dispose(), () => undefined).finally(() => {
          if (loaded === made) loaded = null;
          wentAway();
        });
      },
    };
    model.catch(() => { made.leaving = true; });
    return made;
  }

  function dispose(made: Held<M>): void {
    made.leaving = true;
    clearTimeout(made.idle);
    made.letGo();
  }

  async function take(row: R, signal: AbortSignal): Promise<Held<M>> {
    for (;;) {
      signal.throwIfAborted();
      if (closing !== null) throw new Error("the runner is stopping");
      loaded ??= begin(row);
      const made = loaded;
      if (made.id === row.id && !made.leaving) {
        made.users++;
        clearTimeout(made.idle);
        return made;
      }
      made.leaving = true;
      if (made.users === 0) dispose(made);
      await until(made.gone, signal);
    }
  }

  function release(made: Held<M>): void {
    made.users--;
    if (made.users > 0) return;
    if (made.leaving) return dispose(made);
    made.idle = setTimeout(() => dispose(made), idle_ms);
    made.idle.unref();
  }

  return {
    async use(row, signal, work) {
      const made = await take(row, signal);
      try {
        return await work(() => until(made.model, signal));
      } catch (error) {
        if (error instanceof Broken) made.leaving = true;
        throw error;
      } finally {
        release(made);
      }
    },
    async letGo(row, signal) {
      const made = loaded;
      if (made?.id !== row.id) return;
      made.leaving = true;
      if (made.users === 0) dispose(made);
      await until(made.gone, signal);
    },
    close() {
      closing ??= (async () => {
        while (loaded !== null) {
          const made = loaded;
          made.leaving = true;
          if (made.users === 0) dispose(made);
          await made.gone;
        }
      })();
      return closing;
    },
  };
}

export async function checkedLoad<M extends Disposable>(id: string, files: readonly Pinned[], load: () => Promise<M>): Promise<M> {
  const opened: FileHandle[] = [];
  try {
    const before = [];
    for (const { path, artifact } of files) {
      const file = await open(path, "r").catch(() => {
        throw new NotReady(`${id}'s file is not on this runner`);
      });
      opened.push(file);
      const stated = await file.stat({ bigint: true });
      if (stated.size !== BigInt(artifact.bytes)) throw new NotReady(`${id}'s file is not the one this runner pins`);
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== artifact.sha256) throw new NotReady(`${id}'s file is not the one this runner pins`);
      before.push(stated);
    }
    const model = await load();
    for (const [index, { path }] of files.entries()) {
      const after = await opened[index]!.stat({ bigint: true });
      const named = await stat(path, { bigint: true }).catch(() => null);
      if (named?.ino !== before[index]!.ino || named.dev !== before[index]!.dev || after.ctimeNs !== before[index]!.ctimeNs) {
        model.dispose();
        throw new NotReady(`${id}'s file changed while it was checked and loaded`);
      }
    }
    return model;
  } finally {
    await Promise.all(opened.map((file) => file.close()));
  }
}

function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = (): void => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
