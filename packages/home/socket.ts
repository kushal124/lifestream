import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@lifestreamprotocol/core";
import { errorText } from "./jobs.js";
import { notBegun, notReadableRefusal, Refusal } from "./refusal.js";

const SOCKET_PATH_BYTES = 104;
const RUN_DIRECTORY = "run";

export interface HomeSocket {
  path: string;
  folder: string;
}

export function socketPath(machineDir: string, homeId: string): string {
  const name = createHash("sha256").update(homeId, "utf8").digest("hex").slice(0, 8);
  const path = join(machineDir, RUN_DIRECTORY, `${name}.sock`);
  const bytes = Buffer.byteLength(path);
  if (bytes >= SOCKET_PATH_BYTES) {
    throw new Error(`${path} is ${bytes} bytes; a socket's path must be under ${SOCKET_PATH_BYTES}: give this machine a shorter directory (LIFESTREAM_MACHINE_DIR)`);
  }
  return path;
}

function answering(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export async function claimSocket(path: string): Promise<void> {
  if (await answering(path)) {
    throw new Error(`a home with this folder's id already runs on this machine and answers ${path}: stop it first, or give this copy its own machine directory (LIFESTREAM_MACHINE_DIR)`);
  }
}

function ownRunDirectory(path: string): void {
  const run = dirname(path);
  mkdirSync(run, { recursive: true, mode: 0o700 });
  if ((statSync(run).mode & 0o777) !== 0o700) chmodSync(run, 0o700);
}

type SaidRefusal = { status: number; code: string; words: string; retryAfter?: number; extra: JsonObject };

const refusalOf = (error: Refusal): SaidRefusal => ({
  status: error.status, code: error.code, words: error.words, ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }), extra: error.extra,
});

export interface Call {
  readonly left: AbortSignal;
  readonly sent_ms: number | null;
  began(): void;
}

export type Dispatch = (request: JsonObject, out: Out, call: Call) => Promise<unknown>;

export type Out = (line: string, going?: boolean) => void;

export type Early = (verb: string | null, sent_ms: number | null, answer: string) => void;

function listenAt(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function takeSocket(server: Server, path: string): Promise<void> {
  try {
    await listenAt(server, path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  }
  await claimSocket(path);
  rmSync(path, { force: true });
  await listenAt(server, path);
}

export type KeptRead = (request: JsonObject) => { kept: unknown } | { unreadable: unknown } | null;

const ANSWER_LINE = (answer: unknown): JsonObject => ({ result: (answer ?? null) as never });
const REFUSAL_LINE = (error: unknown): JsonObject => (error instanceof Refusal ? { error: error.words, refusal: refusalOf(error) } : { error: errorText(error) });

function keptLine(kept: KeptRead, request: JsonObject): JsonObject | null {
  const said = kept(request);
  if (said === null) return null;
  return "kept" in said ? ANSWER_LINE(said.kept) : REFUSAL_LINE(notReadableRefusal(said.unreadable));
}

const timeOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const answerOf = (line: JsonObject): string => (line.refusal as SaidRefusal | undefined)?.code ?? ("error" in line ? "error" : "ok");

export async function serveSocket(path: string, dispatch: Dispatch, kept: KeptRead = () => null, early: Early = () => undefined): Promise<{ close(): Promise<void> }> {
  ownRunDirectory(path);
  const sockets = new Set<Socket>();
  const answeredOn = new WeakSet<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const send = (line: JsonObject) => {
      if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(line)}\n`);
    };
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    const left = new AbortController();
    let answered = false;
    let timer: NodeJS.Timeout | undefined;
    const answer = (line: JsonObject) => {
      if (answered) return;
      answered = true;
      answeredOn.add(socket);
      clearTimeout(timer);
      send(line);
      socket.end();
    };
    socket.on("close", () => {
      if (!answered) left.abort(new Error("the client left before the answer"));
    });
    let asked = false;
    lines.on("line", (line) => {
      if (asked || line.trim() === "") return;
      asked = true;
      lines.close();
      let request: JsonObject;
      let deadline_ms: number | null;
      let call: Call;
      let verb: string | null = null;
      let sent_ms: number | null = null;
      const answerEarly = (said: JsonObject) => {
        answer(said);
        early(verb, sent_ms, answerOf(said));
      };
      try {
        const parsed = JSON.parse(line) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || typeof (parsed as JsonObject).verb !== "string") {
          throw new TypeError("a request is a JSON object naming its verb");
        }
        const { sent_ms: sent, deadline_ms: deadline, ...rest } = parsed as JsonObject;
        request = rest;
        verb = rest.verb as string;
        sent_ms = timeOf(sent);
        deadline_ms = timeOf(deadline);
        let begun = false;
        call = {
          left: left.signal,
          sent_ms,
          began: () => {
            if (begun || answered) return;
            begun = true;
            clearTimeout(timer);
            send({ began: true });
          },
        };
        const said = keptLine(kept, request);
        if (said !== null) return answerEarly(said);
      } catch (error) {
        return answerEarly(REFUSAL_LINE(error));
      }
      if (left.signal.aborted || (deadline_ms !== null && Date.now() >= deadline_ms)) return answerEarly(REFUSAL_LINE(notBegun()));
      if (deadline_ms !== null) {
        timer = setTimeout(() => {
          answer(keptLine(kept, request) ?? REFUSAL_LINE(notBegun()));
          left.abort(notBegun());
        }, deadline_ms - Date.now());
      }
      let running: Promise<unknown>;
      try {
        running = dispatch(request, (out, going) => {
          if (!answered) send(going === true ? { out, going } : { out });
        }, call);
      } catch (error) {
        running = Promise.reject(error);
      }
      running.then((result) => answer(ANSWER_LINE(result)), (error: unknown) => answer(REFUSAL_LINE(error)));
    });
  });
  await takeSocket(server, path);
  chmodSync(path, 0o600);
  return {
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) {
        if (!answeredOn.has(socket)) socket.destroy();
        else if (socket.writableFinished) socket.destroy();
        else socket.once("finish", () => socket.destroy());
      }
      server.close(() => {
        rmSync(path, { force: true });
        resolve();
      });
    }),
  };
}

export class NoHomeError extends Error {
  override name = "NoHomeError";

  constructor(message: string, readonly asked = false, readonly absent = false, readonly began = false) {
    super(message);
  }
}

export function askHome(at: HomeSocket, verb: string, args: readonly string[] = [], out: Out = () => undefined, timeoutMs?: number): Promise<unknown> {
  return ask(at, { verb, args: [...args], cwd: process.cwd(), by: "terminal" }, out, timeoutMs);
}

export function ask(at: HomeSocket, asked: JsonObject, out: Out = () => undefined, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
  const { path } = at;
  const request = { ...asked, folder: at.folder };
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const socket = createConnection(path);
    let connected = false;
    let began = false;
    let settled = false;
    let buffered = "";
    const end = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      socket.destroy();
      settle();
    };
    const giveUp = () => end(() => reject(new NoHomeError(`the home did not answer ${path} within ${timeoutMs} ms`, connected, false, began)));
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => (connected ? setImmediate(giveUp) : giveUp()), timeoutMs);
    const aborted = () => end(() => reject(signal!.reason));
    signal?.addEventListener("abort", aborted, { once: true });
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify({ ...request, sent_ms: Date.now() })}\n`);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => end(() => reject(new NoHomeError(`${connected ? "the home gave no answer at" : "no home answers"} ${path}: ${error.message}`, connected, !connected && error.code === "ENOENT", began))));
    socket.on("close", () => end(() => reject(new NoHomeError(connected ? `the home closed ${path} without an answer` : `no home answers ${path}`, connected, false, began))));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const line = JSON.parse(buffered.slice(0, at)) as { began?: boolean; out?: string; going?: boolean; result?: unknown; error?: string; refusal?: SaidRefusal };
        buffered = buffered.slice(at + 1);
        if (line.began === true) began = true;
        if (line.out !== undefined) out(line.out, line.going === true);
        if ("result" in line) end(() => resolve(line.result));
        if (line.error !== undefined) {
          const refused = line.refusal;
          end(() => reject(refused === undefined ? new Error(line.error) : new Refusal(refused.status, refused.code, refused.words, refused.retryAfter, refused.extra)));
        }
      }
    });
  });
}
