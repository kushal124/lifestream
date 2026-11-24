import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import type { Epoch } from "@lifestreamprotocol/model";
import { BUSY_WORDS, ERASING_WORDS, openReaders, type Readers } from "./readers.js";
import { Refusal, STARTING } from "./refusal.js";
import { writeFolder } from "./test/folder.js";
import { until } from "./test/harness-root.js";

const REGISTRY = `import fs, { appendFileSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const wait = new Int32Array(new SharedArrayBuffer(4));
export default (_settings, { root }) => {
  appendFileSync(root + "/loads", "loading\\n");
  while (existsSync(root + "/loading")) Atomics.wait(wait, 0, 0, 10);
  const exists = fs.existsSync;
  fs.existsSync = (path) => {
    if (String(path) === root + "/home.db" && exists(root + "/hold")) {
      appendFileSync(root + "/started", "held\\n");
      if (exists(root + "/stuck.fifo")) fs.readFileSync(root + "/stuck.fifo");
      else while (!exists(root + "/release")) Atomics.wait(wait, 0, 0, 10);
    }
    return exists(path);
  };
  syncBuiltinESMExports();
  return { connectors: [], readers: [], families: [] };
};
`;

interface Bench {
  root: string;
  readers: Readers;
  logs: JsonObject[];
  bounds: { name: string; reach(): void; gone: boolean }[];
  started(): number;
  loads(): number;
  epoch: Epoch;
  probe?: () => Promise<Epoch>;
}

function bench(options: { loading?: boolean } = {}): Bench {
  const root = mkdtempSync(join(tmpdir(), "readers-"));
  writeFolder(root);
  writeFileSync(join(root, "registry.mjs"), REGISTRY);
  if (options.loading === true) writeFileSync(join(root, "loading"), "");
  const logs: JsonObject[] = [];
  const bounds: Bench["bounds"] = [];
  const epoch: Epoch = { epoch: 0, erasing: false };
  const readers = openReaders(openHomeFolder(root), join(root, "machine"), pathToFileURL(join(root, "registry.mjs")).href, (line) => logs.push(line), () => at.probe?.() ?? Promise.resolve({ ...epoch }), undefined,
    (name, letGo) => new Promise<void>((resolve) => {
      const bound = { name, reach: resolve, gone: false };
      void letGo.then(() => { bound.gone = true; });
      bounds.push(bound);
    }));
  onTestFinished(async () => {
    writeFileSync(join(root, "release"), "");
    rmSync(join(root, "loading"), { force: true });
    letGo(root);
    await readers.close(new Error("the test ended"));
    rmSync(root, { recursive: true, force: true });
  });
  const lines = (file: string) => () => existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8").split("\n").filter(Boolean).length : 0;
  const at: Bench = { root, readers, logs, bounds, started: lines("started"), loads: lines("loads"), epoch };
  return at;
}

function letGo(root: string): boolean {
  const fifo = join(root, "stuck.fifo");
  if (!existsSync(fifo)) return true;
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    return true;
  } catch {
    return false;
  }
}

const read = (readers: Readers, options?: Parameters<Readers["read"]>[1]) => readers.read<string[] | null>({ served: ["sha256:" + "0".repeat(64)] }, options)
  .then((value) => ({ value }), (error: unknown) => ({ error: error as Error }));

const refusalOf = (answer: { error: Error } | { value: unknown }) => "error" in answer && answer.error instanceof Refusal ? [answer.error.status, answer.error.words, answer.error.retryAfter] : answer;

afterEach(() => { vi.restoreAllMocks(); });

describe("a short read that never returns", () => {
  it("is answered the one 503 at its bound and its thread cut; three stuck take every thread, a later read is answered at its bound, and the cut threads are kept until gone", async () => {
    const at = bench();
    writeFileSync(join(at.root, "hold"), "");
    expect(spawnSync("mkfifo", [join(at.root, "stuck.fifo")]).status).toBe(0);
    const stuck = [read(at.readers), read(at.readers), read(at.readers)];
    await until("three reads stuck on their threads", () => at.started() === 3);
    const fourth = read(at.readers);
    await until("the fourth read queued", () => at.readers.depth() === 1);
    expect(at.bounds.map((bound) => bound.name)).toEqual(["served", "served", "served", "served"]);
    for (const bound of at.bounds.slice(0, 3)) bound.reach();
    for (const answer of await Promise.all(stuck)) {
      expect(refusalOf(answer)).toEqual([503, "Lifestream took too long to read this: try again in a few minutes.", 300]);
    }
    expect(at.readers.depth()).toBe(1);
    expect(at.started()).toBe(3);
    at.bounds[3]!.reach();
    expect(refusalOf(await fourth)).toEqual([503, BUSY_WORDS, 60]);
    expect(at.started()).toBe(3);
    rmSync(join(at.root, "hold"));
    await until("the stuck steps let go", () => letGo(at.root));
    rmSync(join(at.root, "stuck.fifo"));
    await until("the three cut threads gone", () => at.logs.filter((line) => line.reader === "ended").length === 3);
    expect(at.logs.filter((line) => line.reader === "ended")).toEqual(Array(3).fill({ reader: "ended", why: "served read past its bound" }));
    expect(await read(at.readers)).toEqual({ value: null });
  });

  it("ends its caller's wait at a deadline waited on before it, through its signal, and cuts its thread only at its own bound", async () => {
    const at = bench();
    writeFileSync(join(at.root, "hold"), "");
    const due = at.readers.deadline("custody answer");
    const late = new AbortController();
    void due.reached.then(() => late.abort(new Refusal(503, "NOT_NOW", BUSY_WORDS, 60)));
    const held = read(at.readers, { signal: late.signal });
    await until("the read held on its thread", () => at.started() === 1);
    expect(at.bounds.map((bound) => bound.name)).toEqual(["custody answer", "served"]);
    at.bounds[0]!.reach();
    expect(refusalOf(await held)).toEqual([503, BUSY_WORDS, 60]);
    const next = read(at.readers);
    await until("the next read held on another thread", () => at.started() === 2);
    expect(at.logs.filter((line) => line.reader === "ended")).toEqual([]);
    at.bounds[1]!.reach();
    await until("the first read's thread gone", () => at.logs.some((line) => line.reader === "ended"));
    writeFileSync(join(at.root, "release"), "");
    expect(await next).toEqual({ value: null });
    expect(at.logs.filter((line) => line.reader === "ended")).toEqual([{ reader: "ended", why: "served read past its bound" }]);
  });
});

const days = (readers: Readers) => readers.ask("/v1/days", { computed: { key: "days", ask: () => ({ url: "/v1/days", now_ms: Date.now(), held: { machine: "m", sites: [], present: [], refused: [], stated: {} } }) as never } }, new AbortController().signal)
  .then((value) => ({ value }), (error: unknown) => ({ error: error as Error }));

const prepared = (readers: Readers, url: string) => readers.ask(new URL(url, "http://door").pathname, { prepared: () => ({ url, now_ms: Date.now(), gzip: false, held: { machine: "m" } }) }, new AbortController().signal)
  .then((value) => ({ value }), (error: unknown) => ({ error: error as Error }));

const PHOTO = "/v1/photos/sha256:" + "0".repeat(64);

describe("a read an erasure overlaps", () => {
  it("is run again when the epoch moved while it read, and refused while an erasure stays marked; one no erasure overlapped runs once", async () => {
    const at = bench();
    writeFileSync(join(at.root, "hold"), "");
    writeFileSync(join(at.root, "release"), "");
    expect(await days(at.readers)).toHaveProperty("value");
    const once = at.started();
    expect(once).toBeGreaterThan(0);
    rmSync(join(at.root, "release"));

    const moved = days(at.readers);
    await until("the read holds its look at home.db", () => at.started() === once + 1);
    at.epoch.epoch = 2;
    writeFileSync(join(at.root, "release"), "");
    expect(await moved).toHaveProperty("value");
    expect(at.started()).toBe(3 * once);
    rmSync(join(at.root, "release"));

    const marked = days(at.readers);
    await until("the read holds its look at home.db", () => at.started() === 3 * once + 1);
    at.epoch.erasing = true;
    writeFileSync(join(at.root, "release"), "");
    expect(refusalOf(await marked)).toEqual([503, ERASING_WORDS, 60]);
    expect(at.started()).toBe(4 * once);
  });

  it("a photo's facts, a prepared reply, held across an erasure is run again, and refused while the erasure stays marked", async () => {
    const at = bench();
    writeFileSync(join(at.root, "hold"), "");
    writeFileSync(join(at.root, "release"), "");
    const alone = refusalOf(await prepared(at.readers, PHOTO));
    const once = at.started();
    expect(once).toBeGreaterThan(0);
    rmSync(join(at.root, "release"));

    const moved = prepared(at.readers, PHOTO);
    await until("the photo read holds its look at home.db", () => at.started() === once + 1);
    at.epoch.epoch = 2;
    writeFileSync(join(at.root, "release"), "");
    expect(refusalOf(await moved)).toEqual(alone);
    expect(at.started()).toBe(3 * once);
    rmSync(join(at.root, "release"));

    const marked = prepared(at.readers, PHOTO);
    await until("the photo read holds its look at home.db", () => at.started() === 3 * once + 1);
    at.epoch.erasing = true;
    writeFileSync(join(at.root, "release"), "");
    expect(refusalOf(await marked)).toEqual([503, ERASING_WORDS, 60]);
    expect(at.started()).toBe(4 * once);
  });

  it("a prepared route's refusal an erasure overlapped is run again, then answered; refused while the erasure stays marked; People with no home.db is starting, with no People file being prepared", async () => {
    const at = bench();
    expect(refusalOf(await prepared(at.readers, "/v1/people"))).toEqual([503, STARTING, expect.any(Number)]);
    openHome(openHomeFolder(at.root), "migrate").close();
    const alone = refusalOf(await prepared(at.readers, "/v1/people"));
    expect(alone).toEqual([503, "Your people are being prepared.", expect.any(Number)]);
    let readings = 0;
    at.probe = async () => {
      readings++;
      if (readings === 2) at.epoch.epoch = 2;
      return { ...at.epoch };
    };
    expect(refusalOf(await prepared(at.readers, "/v1/people"))).toEqual(alone);
    expect(readings).toBe(4);
    readings = 0;
    at.epoch.erasing = true;
    expect(refusalOf(await prepared(at.readers, "/v1/people"))).toEqual([503, ERASING_WORDS, 60]);
    expect(readings).toBe(4);
  });
});

describe("a short read whose value is sent", () => {
  const card = (readers: Readers) => readers.leaving({ card: { machine: "m", hash: "sha256:" + "0".repeat(64) } })
    .then((value) => ({ value }), (error: unknown) => ({ error: error as Error }));

  it("a card photo's reply held across an erasure is refused, run again when the epoch moved, and answered when none overlapped", async () => {
    const at = bench();
    let readings = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    at.probe = async () => {
      readings++;
      return { ...at.epoch };
    };
    const alone = refusalOf(await card(at.readers));
    expect(readings).toBe(2);

    readings = 0;
    at.probe = async () => {
      if (++readings === 2) at.epoch.epoch = 2;
      return { ...at.epoch };
    };
    expect(refusalOf(await card(at.readers))).toEqual(alone);
    expect(readings).toBe(4);

    readings = 0;
    at.probe = async () => {
      if (++readings === 2) await held;
      return { ...at.epoch };
    };
    const asked = card(at.readers);
    await until("the card's reply held at the epoch's reading after it", () => readings === 2);
    at.epoch.erasing = true;
    release();
    expect(refusalOf(await asked)).toEqual([503, ERASING_WORDS, 60]);
  });
});

describe("a reply read whole on the door's thread", () => {
  it("a day's brief copied, its file then erased and the erasure committed, is read again, and refused while an erasure stays marked", async () => {
    const at = bench();
    let file = "erased text";
    let readings = 0;
    let holding = false;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    at.probe = async () => {
      readings++;
      return { ...at.epoch };
    };
    const brief = (readers: Readers) => readers.here("day brief", async () => {
      const copied = file;
      if (readings === 1 && copied === "erased text") {
        holding = true;
        await held;
      }
      return copied;
    }).then((value) => ({ value }), (error: unknown) => ({ error: error as Error }));
    const asked = brief(at.readers);
    await until("the brief copied its file and held", () => holding);
    file = "rendered again";
    at.epoch.epoch = 2;
    release();
    expect(await asked).toEqual({ value: "rendered again" });
    expect(readings).toBe(4);
    at.epoch.erasing = true;
    const refused = await brief(at.readers);
    expect("error" in refused && refusalOf(refused)).toEqual([503, ERASING_WORDS, 60]);
    at.epoch.erasing = false;
  });
});

describe("a served read's one bound", () => {
  it("covers both runs: a read run again after an erasure, its retry held at the ask's bound, is answered then, its thread cut", async () => {
    const at = bench();
    writeFileSync(join(at.root, "hold"), "");
    writeFileSync(join(at.root, "release"), "");
    expect(await days(at.readers)).toHaveProperty("value");
    const once = at.started();
    let readings = 0;
    at.probe = async () => {
      if (++readings === 2) {
        at.epoch.epoch = 2;
        rmSync(join(at.root, "release"));
      }
      return { ...at.epoch };
    };
    const asked = days(at.readers);
    await until("the retry holds its look at home.db", () => at.started() === 2 * once + 1);
    expect(at.bounds.map((bound) => bound.name)).toEqual(["/v1/days", "/v1/days"]);
    at.bounds[1]!.reach();
    expect(refusalOf(await asked)).toEqual([503, "Lifestream took too long to read this: try again in a few minutes.", 300]);
    expect(readings).toBe(3);
    writeFileSync(join(at.root, "release"), "");
    await until("the cut thread gone", () => at.logs.some((line) => line.reader === "ended"));
    expect(at.logs.filter((line) => line.reader === "ended")).toEqual([{ reader: "ended", why: "/v1/days read past its bound" }]);
  });

  it("stays armed while a thread runs the read its caller left: the caller answered at once, the thread cut at the bound, the bound let go then", async () => {
    const at = bench();
    writeFileSync(join(at.root, "hold"), "");
    const caller = new AbortController();
    const asked = at.readers.ask("/v1/days", { computed: { key: "days", ask: () => ({ url: "/v1/days", now_ms: Date.now(), held: { machine: "m", sites: [], present: [], refused: [], stated: {} } }) as never } }, caller.signal)
      .then((value) => ({ value }), (error: unknown) => ({ error: error as Error }));
    await until("the read holds its look at home.db", () => at.started() === 1);
    caller.abort(new Error("the client went"));
    expect(await asked).toMatchObject({ error: { message: "the client went" } });
    const [bound] = at.bounds;
    expect(at.bounds.map((each) => each.name)).toEqual(["/v1/days"]);
    expect(bound!.gone).toBe(false);
    expect(at.logs.filter((line) => line.reader === "ended")).toEqual([]);
    bound!.reach();
    await until("the thread cut at the bound", () => at.logs.some((line) => line.reader === "ended"));
    expect(at.logs.filter((line) => line.reader === "ended")).toEqual([{ reader: "ended", why: "/v1/days read past its bound" }]);
    await until("the bound let go", () => bound!.gone);
  });

  it("covers the epoch's readings: a reading held at the ask's bound is answered then, the busy 503, and nothing runs", async () => {
    const at = bench();
    writeFileSync(join(at.root, "hold"), "");
    writeFileSync(join(at.root, "release"), "");
    at.probe = () => new Promise<Epoch>(() => undefined);
    const asked = prepared(at.readers, PHOTO);
    await until("the ask's bound armed", () => at.bounds.length === 1);
    at.bounds[0]!.reach();
    expect(refusalOf(await asked)).toEqual([503, BUSY_WORDS, 60]);
    expect(at.started()).toBe(0);
  });
});

describe("the pool's close and its queue", () => {
  it("rejects every ask it holds or queues with the reason it is given, and an ask after it too", async () => {
    const at = bench();
    writeFileSync(join(at.root, "hold"), "");
    const held = [read(at.readers), read(at.readers), read(at.readers)];
    await until("three reads held", () => at.started() === 3);
    const queued = read(at.readers);
    await until("the fourth queued", () => at.readers.depth() === 1);
    const closing = new Refusal(503, "NOT_NOW", "The door is closing: try again in a moment.", 5);
    const closed = at.readers.close(closing);
    for (const answer of await Promise.all([...held, queued])) expect(answer).toEqual({ error: closing });
    expect(await read(at.readers)).toEqual({ error: closing });
    writeFileSync(join(at.root, "release"), "");
    await closed;
  });

  it("keeps the queue's high-water where it grows, read and begun again by peak", async () => {
    const at = bench();
    writeFileSync(join(at.root, "hold"), "");
    const held = [read(at.readers), read(at.readers), read(at.readers)];
    await until("three reads held", () => at.started() === 3);
    const gone = new AbortController();
    const left = [read(at.readers, { signal: gone.signal }), read(at.readers, { signal: gone.signal })];
    await until("two queued", () => at.readers.depth() === 2);
    gone.abort(new Error("the client left"));
    await Promise.all(left);
    expect(at.readers.depth()).toBe(0);
    expect(at.readers.peak()).toBe(2);
    expect(at.readers.peak()).toBe(0);
    writeFileSync(join(at.root, "release"), "");
    await Promise.all(held);
  });
});

describe("a thread ended while it loads", () => {
  it("is never terminated while it loads; the pool closed first ends each once it is up", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const at = bench({ loading: true });
    const pending = [read(at.readers), read(at.readers), read(at.readers)];
    await until("the three threads loading", () => at.loads() === 3);
    const closed = at.readers.close(new Error("the test closed it"));
    expect(terminate).not.toHaveBeenCalled();
    rmSync(join(at.root, "loading"));
    await closed;
    await Promise.all(pending);
    expect(terminate).toHaveBeenCalledTimes(3);
  });

  it("is never terminated while it loads; one cut while it loads, the pool then closed, is still ended once it is up", async () => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const at = bench({ loading: true });
    const cut = read(at.readers);
    const others = [read(at.readers), read(at.readers)];
    await until("the three threads loading", () => at.loads() === 3);
    await until("the read's bound asked", () => at.bounds.length === 3);
    at.bounds[0]!.reach();
    expect(refusalOf(await cut)).toEqual([503, "Lifestream took too long to read this: try again in a few minutes.", 300]);
    const closed = at.readers.close(new Error("the test closed it"));
    expect(terminate).not.toHaveBeenCalled();
    rmSync(join(at.root, "loading"));
    await closed;
    await Promise.all(others);
    expect(terminate).toHaveBeenCalledTimes(3);
    expect(at.logs).toEqual([{ reader: "ended", why: "served read past its bound" }]);
  });
});
