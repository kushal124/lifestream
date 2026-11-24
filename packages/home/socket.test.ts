import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { JsonObject } from "@lifestreamprotocol/core";
import { NOT_BEGUN, NOT_NOW, Refusal } from "./refusal.js";
import { ask, askHome, NoHomeError, serveSocket, socketPath, type Call, type Early, type KeptRead } from "./socket.js";
import { until } from "./test/harness-root.js";

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-socket-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const serve = async (path: string, answer: (request: Record<string, unknown>) => unknown) => {
  const served = await serveSocket(path, async (request) => answer(request));
  onTestFinished(() => served.close());
  return served;
};

describe("the home's socket on the machine", () => {
  it("is run/ and the first 8 hex of the id's SHA-256, under the machine directory", () => {
    const dir = scratch();
    const id = "3f1c2a90-7d4e-4b8a-9c11-0f2e3d4c5b6a";
    const name = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8);
    expect(socketPath(dir, id)).toBe(join(dir, "run", `${name}.sock`));
    expect(socketPath(dir, "another-home")).not.toBe(socketPath(dir, id));
  });

  it("refuses a path of 104 bytes or more, naming the machine directory", () => {
    const dir = join("/", "x".repeat(90));
    const path = join(dir, "run", "00000000.sock");
    expect(Buffer.byteLength(path)).toBeGreaterThanOrEqual(104);
    expect(() => socketPath(dir, "a-home")).toThrow(/is \d+ bytes; a socket's path must be under 104: give this machine a shorter directory \(LIFESTREAM_MACHINE_DIR\)$/u);
  });

  it("makes run/ 0700, and narrows a looser one", async () => {
    const made = scratch();
    const path = socketPath(made, "a-home");
    await serve(path, () => "made");
    expect(statSync(join(made, "run")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const loose = scratch();
    mkdirSync(join(loose, "run"));
    chmodSync(join(loose, "run"), 0o755);
    await serve(socketPath(loose, "a-home"), () => "narrowed");
    expect(statSync(join(loose, "run")).mode & 0o777).toBe(0o700);
  });

  it("replaces a socket file no process listens on", async () => {
    const dir = scratch();
    const path = socketPath(dir, "a-home");
    mkdirSync(join(dir, "run"), { mode: 0o700 });
    writeFileSync(path, "");
    await serve(path, () => "fresh");
    expect(await askHome({ path, folder: "/homes/a" }, "status")).toBe("fresh");
  });

  it("leaves a home that answers alone, and the second serve fails in its words", async () => {
    const dir = scratch();
    const path = socketPath(dir, "a-home");
    await serve(path, () => "first");
    await expect(serveSocket(path, async () => "second")).rejects.toThrow(
      `a home with this folder's id already runs on this machine and answers ${path}: stop it first, or give this copy its own machine directory (LIFESTREAM_MACHINE_DIR)`,
    );
    expect(await askHome({ path, folder: "/homes/a" }, "status")).toBe("first");
  });

  it("lets one of two serves started together take the socket, and the other fails in its words", async () => {
    const dir = scratch();
    const path = socketPath(dir, "a-home");
    const both = await Promise.allSettled([serveSocket(path, async () => "one"), serveSocket(path, async () => "two")]);
    for (const each of both) if (each.status === "fulfilled") onTestFinished(() => each.value.close());
    expect(both.filter((each) => each.status === "fulfilled")).toHaveLength(1);
    const refused = both.find((each) => each.status === "rejected");
    expect(String(refused?.reason)).toContain(`a home with this folder's id already runs on this machine and answers ${path}`);
    expect(await askHome({ path, folder: "/homes/a" }, "status")).toBe(both[0].status === "fulfilled" ? "one" : "two");
  });

  it("serves two homes side by side, each at its own id's path", async () => {
    const dir = scratch();
    await serve(socketPath(dir, "home-a"), () => "a");
    await serve(socketPath(dir, "home-b"), () => "b");
    expect(await askHome({ path: socketPath(dir, "home-a"), folder: "/homes/a" }, "status")).toBe("a");
    expect(await askHome({ path: socketPath(dir, "home-b"), folder: "/homes/b" }, "status")).toBe("b");
  });

  it("removes its socket at close", async () => {
    const dir = scratch();
    const path = socketPath(dir, "a-home");
    const served = await serveSocket(path, async () => null);
    await served.close();
    expect(existsSync(path)).toBe(false);
  });

  it("at its close ends a connection whose answer is out, whole, and cuts one still waiting", async () => {
    const path = socketPath(scratch(), "a-home");
    const big = "x".repeat(8 << 20);
    const heard: unknown[] = [];
    let closing: Promise<void> | undefined;
    const served: { close(): Promise<void> } = await serveSocket(path, async (request) => {
      heard.push(request.verb);
      if (request.verb === "wait") return new Promise(() => undefined);
      setImmediate(() => { closing = served.close(); });
      return big;
    });
    const cut = lines(path, { verb: "wait" }).catch(() => []);
    await until("the waiting request reached the home", () => heard.includes("wait"));
    expect(await lines(path, { verb: "big" })).toEqual([{ result: big }]);
    expect(await cut).toEqual([]);
    await until("the close began", () => closing !== undefined);
    await closing;
    expect(existsSync(path)).toBe(false);
  });

  it("names the folder a caller means on every request", async () => {
    const dir = scratch();
    const path = socketPath(dir, "a-home");
    const heard: Record<string, unknown>[] = [];
    await serve(path, (request) => {
      heard.push(request);
      return null;
    });
    await ask({ path, folder: "/homes/a" }, { verb: "status" });
    await askHome({ path, folder: "/homes/a" }, "status");
    expect(heard.map((request) => request.folder ?? null)).toEqual(["/homes/a", "/homes/a"]);
  });
});

const lines = (path: string, request: JsonObject): Promise<JsonObject[]> => new Promise((resolve, reject) => {
  const socket = createConnection(path);
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => { text += chunk; });
  socket.on("end", () => resolve(text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as JsonObject)));
  socket.on("error", reject);
  socket.write(`${JSON.stringify(request)}\n`);
});

const refusalOf = (line: JsonObject | undefined) => (line?.refusal as { code: string; words: string } | undefined);

async function held(kept: KeptRead = () => null, early: Early = () => undefined) {
  const path = socketPath(scratch(), "a-home");
  const calls: { request: JsonObject; call: Call; release: (answer: unknown) => void }[] = [];
  const served = await serveSocket(path, (request, _out, call) => new Promise((resolve) => {
    calls.push({ request, call, release: resolve });
    if (request.begin === true) call.began();
  }), kept, early);
  onTestFinished(() => served.close());
  return { path, calls };
}

describe("a request's deadline on the socket", () => {
  it("answers a kept answer at arrival, past its deadline, and never dispatches it", async () => {
    const at = await held((request) => (request.request === "kept-1" ? { kept: { act: "a", id: null, position: "7:1" } } : null));
    expect(await lines(at.path, { verb: "owner-act", request: "kept-1", deadline_ms: Date.now() - 60_000 })).toEqual([{ result: { act: "a", id: null, position: "7:1" } }]);
    expect(at.calls).toEqual([]);
  });

  it("refuses notReadable when the kept read cannot be made, never NOT_BEGUN, and answers the next request", async () => {
    let readable = false;
    const at = await held(() => (readable ? null : { unreadable: new TypeError("The database connection is not open") }));
    const [refused] = await lines(at.path, { verb: "owner-act", deadline_ms: Date.now() - 60_000 });
    expect(refusalOf(refused)?.code).toBe(NOT_NOW);
    expect(refusalOf(refused)?.words).toMatch(/^Lifestream cannot be read now \(The database connection is not open\)/u);
    expect(refusalOf(refused)?.words).not.toBe(NOT_BEGUN);
    readable = true;
    const answered = lines(at.path, { verb: "status", begin: true });
    await until("the request dispatched", () => at.calls.length === 1);
    at.calls[0]!.release("up");
    expect(await answered).toEqual([{ began: true }, { result: "up" }]);
  });

  it("refuses a request whose deadline has passed NOT_BEGUN, unrun", async () => {
    const at = await held();
    const [refused] = await lines(at.path, { verb: "owner-act", deadline_ms: Date.now() - 1 });
    expect(refusalOf(refused)).toMatchObject({ code: NOT_NOW, words: NOT_BEGUN });
    expect(at.calls).toEqual([]);
  });

  it("refuses at the deadline one not begun, aborts its caller's signal, and drops what it answers later: one answer per request", async () => {
    const at = await held();
    const answered = lines(at.path, { verb: "owner-act", deadline_ms: Date.now() + 50 });
    const refused = await answered;
    expect(refused).toHaveLength(1);
    expect(refusalOf(refused[0])).toMatchObject({ code: NOT_NOW, words: NOT_BEGUN });
    expect(at.calls.map(({ request }) => request)).toEqual([{ verb: "owner-act" }]);
    expect(at.calls[0]!.call.left.aborted).toBe(true);
    at.calls[0]!.release("too late");
  });

  it("answers at the deadline what was kept meanwhile, never NOT_BEGUN", async () => {
    let reads = 0;
    const at = await held(() => (++reads === 1 ? null : { kept: { act: "b", id: null, position: "9:1" } }));
    expect(await lines(at.path, { verb: "owner-act", deadline_ms: Date.now() + 50 })).toEqual([{ result: { act: "b", id: null, position: "9:1" } }]);
    expect([reads, at.calls.length, at.calls[0]!.call.left.aborted]).toEqual([2, 1, true]);
  });

  it("says began before any other line and stops the deadline: a begun request runs to its answer", async () => {
    const at = await held();
    const answered = lines(at.path, { verb: "owner-act", begin: true, deadline_ms: Date.now() + 50 });
    await until("the request dispatched", () => at.calls.length === 1);
    const late = lines(at.path, { verb: "status", deadline_ms: Date.now() + 100 });
    expect(refusalOf((await late)[0])?.words).toBe(NOT_BEGUN);
    at.calls[0]!.release("kept");
    expect(await answered).toEqual([{ began: true }, { result: "kept" }]);
    expect(at.calls[0]!.call.left.aborted).toBe(false);
    expect(at.calls[0]!.request).toEqual({ verb: "owner-act", begin: true });
  });

  it("reports every request it answers at arrival, kept, unreadable, past its deadline or unread, by its verb, its send and its answer, and none it dispatches", async () => {
    const early: Parameters<Early>[] = [];
    let unreadable = false;
    const at = await held((request) => (unreadable ? { unreadable: new TypeError("The database connection is not open") } : request.request === "kept-1" ? { kept: { act: "a", id: null, position: "7:1" } } : null), (...said) => early.push(said));
    await lines(at.path, { verb: "owner-act", request: "kept-1", sent_ms: 1_000 });
    await lines(at.path, { verb: "owner-act", sent_ms: 2_000, deadline_ms: Date.now() - 1 });
    const raw = new Promise<void>((resolve, reject) => {
      const socket = createConnection(at.path);
      socket.on("close", () => resolve());
      socket.on("error", reject);
      socket.resume();
      socket.write("not a request\n");
    });
    await raw;
    unreadable = true;
    await lines(at.path, { verb: "owner-act", sent_ms: 3_000 });
    unreadable = false;
    const dispatched = lines(at.path, { verb: "status", begin: true, sent_ms: 4_000 });
    await until("the request dispatched", () => at.calls.length === 1);
    at.calls[0]!.release("up");
    await dispatched;
    expect(early).toEqual([["owner-act", 1_000, "ok"], ["owner-act", 2_000, NOT_NOW], [null, null, "error"], ["owner-act", 3_000, NOT_NOW]]);
  });

  it("hands its caller a line that came while its loop stalled past the wait, never the give-up", async () => {
    const path = join(scratch(), "stalled.sock");
    const WAIT_MS = 500;
    let due = 0;
    const stallUntil = (at: number) => {
      while (Date.now() < at) continue;
    };
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(`${JSON.stringify({ result: "up" })}\n`);
        setImmediate(() => stallUntil(due));
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    due = Date.now() + WAIT_MS + 50;
    expect(await ask({ path, folder: "/homes/a" }, { verb: "status" }, undefined, WAIT_MS)).toBe("up");
  });

  it("tells its caller whether the home began, when no answer came in its time", async () => {
    const at = await held();
    const began = await ask({ path: at.path, folder: "/homes/a" }, { verb: "owner-act", begin: true }, undefined, 100).then(() => null, (error: unknown) => error);
    expect([began instanceof NoHomeError, (began as NoHomeError).asked, (began as NoHomeError).began]).toEqual([true, true, true]);
    const silent = await ask({ path: at.path, folder: "/homes/a" }, { verb: "owner-act" }, undefined, 100).then(() => null, (error: unknown) => error);
    expect([silent instanceof NoHomeError, (silent as NoHomeError).asked, (silent as NoHomeError).began]).toEqual([true, true, false]);
    const refused = await ask({ path: at.path, folder: "/homes/a" }, { verb: "owner-act", deadline_ms: Date.now() - 1 }).then(() => null, (error: unknown) => error);
    expect([refused instanceof Refusal, (refused as Refusal).words]).toEqual([true, NOT_BEGUN]);
  });
});
