import { createHash, randomBytes } from "node:crypto";
import fs, { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import Database from "better-sqlite3";
import { HOME_STORE, KEEP_BYTES, openHomeFolder, tryLock, trySharedLock } from "@lifestreamprotocol/core";
import { callsLock, fakeTransport, openAsker, openLedger, runCall } from "@lifestreamprotocol/model";
import { QUIET, serveDoor } from "./door.js";
import { hold, holdLine, readHold, release, type Hold } from "./hold.js";
import { readHome } from "./lifecycle.js";
import { machine } from "./machine.js";
import { startHome, type Home } from "./home.js";
import { move } from "./move.js";
import { mintPrincipal } from "./principals.js";
import { FAKES, freeSpace, until } from "./test/harness-root.js";
import { serveOnce, startHere } from "./test/harness-home.js";
import { CLI, doorOn, HEADERS, home, json, machineOf, mintPasses, newMachine, printed, removeTemps, runsOn, start, stopChildren, temp } from "./test/machines.js";
import { writeArtifact } from "./test/ops-support.js";
import { acquisitionBundle, phoneBundle } from "./test/support.js";

const TIME_LEFT = / at (?!0 )[\d.]+ MB\/s: (?:under a minute|about \d+ minutes?) left$/u;
const report: Record<string, unknown> = {};

afterAll(() => {
  writeArtifact("move", report);
  removeTemps();
});

describe("move", () => {
  const LEFT_OUT = ["home.lock", "home.lock-journal", "stop.lock", "stop.lock-journal", "home.db-wal", "home.db-shm", "replies/replies.db-wal", "replies/replies.db-shm", "replies/calls.lock", "replies/calls.lock-journal", "door"];
  const filesOf = (root: string): Record<string, string> => {
    const found: Record<string, string> = {};
    const visit = (at: string) => {
      for (const name of readdirSync(join(root, at))) {
        const path = at === "" ? name : `${at}/${name}`;
        if (LEFT_OUT.includes(path)) continue;
        const stat = statSync(join(root, path));
        if (stat.isDirectory()) visit(path);
        else found[path] = `${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")} ${(stat.mode & 0o7777).toString(8)}`;
      }
    };
    visit("");
    return found;
  };
  const pointer = (on: { dir: string }) => readFileSync(join(on.dir, "home"), "utf8").trim();
  const holdOf = (on: { dir: string }, folder: string) => readHold(machine({ env: { LIFESTREAM_MACHINE_DIR: on.dir } }), readHome(folder).id);
  const callOn = (folder: string) => trySharedLock(callsLock(join(folder, "replies", "replies.db")))!;
  const LOCKED = "a move or a verb holds the home: it starts when that ends";
  const NOTES = "apple-notes:local:macbook-pro-0001";
  const notes = (n: number) => acquisitionBundle({ source: NOTES, fetched_ms: Date.UTC(2026, 9, 9, 12, n), files: [[`${n}.jsonl`, Buffer.from(`{"synthetic":${n}}\n`)]], custody: { [NOTES]: { seal: n } } });
  const sealedAt = (folder: string, source: string, name: string) => existsSync(join(folder, "inbox", source, name, "manifest.json"));
  const ROUTE = { transport: "fake", model: "synthetic/model", effort: "low", timeout_ms: 120_000 };
  const MODEL_REPLY = "synthetic reply";
  const modelCall = (folder: string) => {
    const path = join(folder, "replies", "replies.db");
    const ledger = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" });
    let key: string;
    try {
      const asker = openAsker({ ledger, prompt: () => ({ version: 1, type: "text", keeps: [], text: "synthetic prompt" }), blobs: openHomeFolder(folder).blobs(join(folder, "blobs"), { reading: true }) });
      const asked = asker.request({
        family: "synthetic", item: "synthetic:item-1", prompt: "synthetic", input: [{ text: "\n\nsynthetic input" }], work: "photos", source: NOTES, model: ROUTE.model, effort: ROUTE.effort,
      });
      if (!("send" in asked)) throw new Error(`the synthetic ask is not sendable: ${JSON.stringify(asked)}`);
      key = asked.send;
    } finally {
      ledger.close();
    }
    let reply!: () => void;
    const answered = new Promise<void>((resolve) => { reply = resolve; });
    const result = runCall({ folder: openHomeFolder(dirname(dirname(path))), key, route: ROUTE, transports: { fake: {} }, copies: join(tmpdir(), "lifestream-move-call-copies"), transport: () => fakeTransport({ reply: async () => { await answered; return MODEL_REPLY; } }) });
    return { key, reply, result };
  };
  const ledgerRows = (folder: string, key: string) => {
    const db = new Database(join(folder, "replies", "replies.db"), { readonly: true });
    try {
      return {
        attempts: db.prepare("SELECT state FROM attempts WHERE key = ? ORDER BY id").pluck().all(key),
        replies: db.prepare("SELECT text FROM replies WHERE key = ?").pluck().all(key),
      };
    } finally {
      db.close();
    }
  };

  let prepared: Promise<{ dir: string; folder: string }> | undefined;
  const preparedHome = () => prepared ??= (async () => {
    const here = newMachine("move-prepared");
    const folder = join(temp("move-prepared-parent"), "home");
    expect((await home(here, ["adopt", folder])).status).toBe(0);
    expect((await home(here, ["settings", "set", "helpers", "2"])).status).toBe(0);
    await mintPasses(here, folder);
    await serveOnce(null, { machine: machineOf(here) });
    const file = (path: string, bytes: Buffer | string, mode = 0o644) => {
      mkdirSync(join(folder, path, ".."), { recursive: true });
      writeFileSync(join(folder, path), bytes, { mode });
    };
    file(`blobs/ab/cd/abcd${"0".repeat(60)}`, randomBytes(64 * 1024), 0o444);
    file("days/2026-10-01.day.txt", "synthetic day\n");
    file("tools/faces/models/synthetic.onnx", randomBytes(1024));
    file("config/secrets/synthetic", "synthetic-value", 0o600);
    file("door/uploads/synthetic.part", randomBytes(1024));
    return { dir: here.dir, folder: realpathSync(folder) };
  })();

  const movable = async (name: string) => {
    const { dir, folder } = await preparedHome();
    const here = newMachine(name);
    const source = join(realpathSync(temp(`${name}-from`)), "home");
    cpSync(folder, source, { recursive: true });
    cpSync(join(dir, "revoked"), join(here.dir, "revoked"), { recursive: true });
    writeFileSync(join(here.dir, "home"), `${source}\n`);
    return { here, at: machine({ env: { LIFESTREAM_MACHINE_DIR: here.dir }, home: here.user }), source, target: join(realpathSync(temp(`${name}-to`)), "home") };
  };

  it("a move while the home and the door run, a device ships and a dashboard tab reads: the door answers other than 200 or the one 503, exits, or seals into a folder being copied; a call in flight is cut; a home started meanwhile exits or starts anywhere but the new folder", async () => {
    try {
      const { here, source, target } = await movable("move-live");
      const passes = await mintPasses(here, source);
      const { door, port, logs: doorLines } = await doorOn(here);
      const running = start(here, CLI, ["serve", "--registry", FAKES]);
      await printed(running, "the home started", '"home":"started"');
      const exchanges: string[] = [];
      const exchange = async () => {
        const answer = await fetch(`http://127.0.0.1:${port}/v1/exchange`, { method: "POST", headers: { authorization: `Bearer ${passes.deliver.token}`, ...HEADERS.deliver } });
        const text = await answer.text();
        if (answer.status !== 200) exchanges.push(`${answer.status} ${text}`);
        return answer.status;
      };
      expect(await exchange(), exchanges.join("; ")).toBe(200);
      const reads: number[] = [];
      const odd: string[] = [];
      const reading = new AbortController();
      const tab = (async () => {
        while (!reading.signal.aborted) {
          let failed = "";
          const answer = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { authorization: `Bearer ${passes.read.token}` }, signal: reading.signal }).catch((error: unknown) => {
            failed = `${(error as Error).message}: ${String((error as Error).cause ?? "")}`;
            return null;
          });
          if (reading.signal.aborted) break;
          const body = answer === null ? null : await answer.json().catch(() => null) as { code?: string } | null;
          const status = answer === null ? 0 : answer.status === 503 && body?.code !== "NOT_NOW" ? -503 : answer.status;
          reads.push(status);
          if (status !== 200 && status !== 503) odd.push(answer === null ? `read ${reads.length} had no answer: ${failed}` : `read ${reads.length} was ${answer.status} ${JSON.stringify(body)}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })();
      onTestFinished(async () => {
        reading.abort();
        await tab;
      });
      const call = modelCall(source);
      let moving: ReturnType<typeof start>;
      const waitingLines: string[] = [];
      let waiting: Promise<Home>;
      let shipped: { status: number };
      try {
        moving = start(here, CLI, ["move", target]);
        expect(await running.exited, running.out()).toBe(1);
        expect(running.out()).toContain('"home":"stopped","why":"stopped: a move or a verify asked"');
        await until("the move waits for the call", () => moving.out().includes("waiting for a model call or a delivery to end"));
        const delivery = notes(1);
        const put = await fetch(`http://127.0.0.1:${port}${delivery.path}`, { method: "PUT", headers: { authorization: `Bearer ${passes.deliver.token}`, ...HEADERS.deliver }, body: delivery.bytes });
        shipped = { status: put.status };
        expect(shipped.status, await put.text()).toBe(201);
        waiting = startHere(null, { machine: machineOf(here), log: (line) => waitingLines.push(line) });
        await until("the home waits for the move", () => waitingLines.some((line) => line.includes(`"home":"waiting","why":${JSON.stringify(LOCKED)}`)));
      } finally {
        call.reply();
      }
      expect(await call.result).toMatchObject({ outcome: "replied", sent: true });
      expect(await moving.exited, moving.out()).toBe(0);
      expect(ledgerRows(target, call.key)).toEqual({ attempts: ["replied"], replies: [MODEL_REPLY] });
      await until("the home started on the new folder", () => waitingLines.some((line) => line.includes('"home":"started"')));
      await waiting!;
      expect(waitingLines.join("\n")).toContain(`"home":"started","root":${JSON.stringify(target)}`);
      await until("the door serves the moved home", () => {
        const moved = doorLines.findIndex((line) => line.includes(`Lifestream moved to ${target}`));
        return moved >= 0 && doorLines.slice(moved).some((line) => line.includes('"door":"serving"'));
      });
      await until("the exchange answers from the new folder", () => existsSync(join(target, "door", "custody.db")));
      expect(await exchange(), exchanges.join("; ")).toBe(200);
      reading.abort();
      await tab;
      expect({ door: await exchange(), home: runsOn(target), pointer: pointer(here), hold: holdOf(here, target) }, exchanges.join("; ")).toEqual({ door: 200, home: true, pointer: target, hold: null });
      expect(sealedAt(target, NOTES, notes(1).path.split("/").at(-1)!)).toBe(true);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.filter((status) => status !== 200 && status !== 503), odd.join("; ")).toEqual([]);
      report.move_live = { shipped: shipped!, reads: [...new Set(reads)], moved: moving!.out().trim().split("\n"),
        home: waitingLines.filter((line) => line.includes('"home":"waiting"') || line.includes('"home":"started"')),
        door: doorLines.filter((line) => line.includes('"door":"waiting"') || line.includes('"door":"serving"')) };
    } finally {
      await stopChildren();
    }
  });

  it("a move copies other than every file every time, leaves a commit in the write-ahead log behind or a file the target holds that the home does not, loses a phone seal in flight as it begins, seals a delivery sent during the copy anywhere, says a step late, or a speed before it has written for 10 s", async () => {
    const { here, at, source, target } = await movable("move-many");
    const phone = randomBytes(32).toString("base64url");
    const unit = "synthetic-iphone-aa01";
    mintPrincipal(openHomeFolder(source), { unit, kind: "phone", scopes: ["deliver"], sources: [`phone:${unit}`, `location:local:${unit}`], token: phone, now_ms: Date.now() });
    expect((await home(here, ["settings", "set", "unit", "macbook-pro-0001"])).status).toBe(0);
    const desk = randomBytes(32).toString("base64url");
    mintPrincipal(openHomeFolder(source), { unit: "dashboard-macbook-pro-0001", scopes: ["read", "deliver"], sources: [NOTES], token: desk, now_ms: Date.now() });
    const blobs = Array.from({ length: 160 }, (_, n) => `blobs/${(n % 256).toString(16).padStart(2, "0")}/${createHash("sha256").update(String(n)).digest("hex")}`);
    for (const path of blobs) {
      mkdirSync(join(source, path, ".."), { recursive: true });
      writeFileSync(join(source, path), randomBytes(8 * 1024));
    }
    writeFileSync(join(source, "blobs", "large"), randomBytes(9 << 20));
    writeFileSync(join(source, "blobs", "empty"), "");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "HOME.json"), readFileSync(join(source, "HOME.json")));
    for (const path of blobs.slice(0, blobs.length / 2)) cpSync(join(source, path), join(target, path));
    writeFileSync(join(target, "blobs", "stray"), "not the home's");
    const door = await serveDoor(source, { port: 0, max_bundle_bytes: 1 << 30 },
      { machine: at, log: () => undefined, lookMs: 50, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
    const url = `http://127.0.0.1:${door.port}`;
    const writer = openHomeFolder(source).store(HOME_STORE, join(source, "home.db"));
    const lines: string[] = [];
    let moving: Promise<Awaited<ReturnType<typeof move>>> | undefined;
    let edit: Promise<Response> | undefined;
    const late = acquisitionBundle({ source: NOTES, fetched_ms: Date.now() - 60_000, files: [["late.jsonl", Buffer.from('{"synthetic":"late"}\n')]] });
    const lateName = late.path.split("/").at(-1)!;
    let clock = 0;
    const write = fs.createWriteStream;
    try {
      writer.prepare("INSERT INTO meta (key, value) VALUES ('synthetic:move', 'in the log')").run();
      expect(statSync(join(source, "home.db-wal")).size).toBeGreaterThan(0);
      fs.createWriteStream = ((path: Parameters<typeof write>[0], options?: Parameters<typeof write>[1]) => {
        if (moving === undefined && String(path).startsWith(join(source, "inbox", `phone:${unit}`))) {
          moving = move(target, { machine: at, now: () => clock += 1_000, out: (line) => {
            lines.push(line);
            if (line.startsWith("listing what")) edit = fetch(`${url}${late.path}`, { method: "PUT", headers: { authorization: `Bearer ${desk}` }, body: late.bytes });
          } });
        }
        return write(path, options);
      }) as typeof write;
      syncBuiltinESMExports();
      const bundle = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [`location:local:${unit}`]: { seal: 1 } } });
      const sealed = await fetch(`${url}/v1/bundles/${bundle.id}`, { method: "PUT", headers: { authorization: `Bearer ${phone}`, ...HEADERS.phone }, body: bundle.bytes });
      expect(sealed.status).toBe(201);
      const moved = await moving!;
      const files = filesOf(source);
      expect(filesOf(target)).toEqual(files);
      expect(moved).toMatchObject({ folder: target, from: source, files: Object.keys(files).length, removed: 1 });
      expect(sealedAt(target, `phone:${unit}`, bundle.id)).toBe(true);
      const meta = new Database(join(target, "home.db"), { readonly: true });
      expect(meta.prepare("SELECT value FROM meta WHERE key = 'synthetic:move'").pluck().get()).toBe("in the log");
      meta.close();
      const answered = await edit!;
      expect({ status: answered.status, body: await answered.json() }).toEqual({ status: 503, body: { code: "NOT_NOW", message: QUIET, wait: "busy", title: null, line: null, acts: [] } });
      expect([sealedAt(source, NOTES, lateName), sealedAt(target, NOTES, lateName)]).toEqual([false, false]);
      await until("the door serves the new folder", () => existsSync(join(target, "door", "custody.db")));
      const again = await fetch(`${url}${late.path}`, { method: "PUT", headers: { authorization: `Bearer ${desk}` }, body: late.bytes });
      expect(again.status).toBe(201);
      expect(sealedAt(target, NOTES, lateName)).toBe(true);
      expect({ pointer: pointer(here), hold: holdOf(here, target), moved: json(join(here.dir, "moved", `${readHome(source).id}.json`)) })
        .toEqual({ pointer: target, hold: null, moved: { from: source, to: target, bytes: moved.bytes } });
    } finally {
      fs.createWriteStream = write;
      syncBuiltinESMExports();
      writer.close();
      await door.close();
    }
    const steps = [/^looking at what .* holds$/u, /^moving .* GB$/u, /^waiting for a model call or a delivery to end$/u, /^writing home\.db's write-ahead log into it$/u,
      /^writing replies\.db's write-ahead log into it$/u, /^listing what .* holds, Lifestream stopped$/u, /^flushing .* to its disk$/u, /^Lifestream is at /u];
    const said = steps.map((step) => lines.findIndex((line) => step.test(line)));
    expect(said.every((index, n) => index >= 0 && (n === 0 || index > said[n - 1]!)), lines.join("\n")).toBe(true);
    const progress = lines.filter((line) => line.includes(" files done"));
    expect(progress.length, lines.join("\n")).toBeGreaterThan(2);
    expect(progress[0], lines.join("\n")).not.toMatch(/MB\/s|left/u);
    for (const line of progress) if (/ left$/u.test(line)) expect(line).toMatch(TIME_LEFT);
    expect(progress.some((line) => /: about \d+ minutes? left$/u.test(line)), lines.join("\n")).toBe(true);
    const quick = await movable("move-quick");
    let fast = 0;
    const quickLines: string[] = [];
    await move(quick.target, { machine: quick.at, now: () => fast += 10_000, out: (line) => quickLines.push(line) });
    const timed = quickLines.filter((line) => / left$/u.test(line));
    expect(timed.length, quickLines.join("\n")).toBeGreaterThan(0);
    for (const line of timed) expect(line).toMatch(TIME_LEFT);
    expect(timed.at(-1), quickLines.join("\n")).toMatch(/ MB\/s: under a minute left$/u);
    report.move_many = { lines, quick: timed };
  });

  it("a move SIGKILLed before or after its pointer leaves two homes, a hold, or a home that exits rather than waiting on home.lock and then starting on its own where the pointer says", async () => {
    try {
      const cuts: Record<string, unknown> = {};
      for (const point of ["move.copying", "move.pointed"] as const) {
        const { here, at, source, target } = await movable(point.replace(".", "-"));
        const running = await startHere(null, { machine: at });
        const call = callOn(source);
        const cut = start({ env: { ...here.env, LIFESTREAM_FAILPOINT: point } }, CLI, ["move", target]);
        const said: string[] = [];
        let waiting: Promise<Home>;
        try {
          expect(await running.stopped).toBe("stopped: a move or a verify asked");
          await until("the move waits for the call", () => cut.out().includes("waiting for a model call or a delivery to end"));
          waiting = startHere(null, { machine: at, log: (line) => said.push(line) });
          await until("the start waits on the move", () => said.some((line) => line.includes(`"home":"waiting","why":${JSON.stringify(LOCKED)}`)));
        } finally {
          call.release();
        }
        await cut.exited;
        expect(cut.child.signalCode, cut.out()).toBe("SIGKILL");
        const home_ = point === "move.copying" ? source : target;
        await until("the waiting home started", () => said.some((line) => line.includes('"home":"started"')));
        const started = await waiting!;
        expect(said.join("\n")).toContain(`"home":"started","root":${JSON.stringify(home_)}`);
        expect({ runs: runsOn(home_), pointer: pointer(here), hold: holdOf(here, home_) }).toEqual({ runs: true, pointer: home_, hold: null });
        let after: unknown;
        if (point === "move.copying") {
          const taken = await home(here, ["adopt", target]);
          expect(taken.status, taken.out).toBe(1);
          expect(taken.out).toContain(`${target} is a copy of the Lifestream folder this machine runs, which is at ${source}`);
          const again = await home(here, ["move", target]);
          expect(again.status, again.out).toBe(0);
          expect(await started.stopped).toBe("stopped: a move or a verify asked");
          expect(filesOf(target)).toEqual(filesOf(source));
          expect({ pointer: pointer(here), hold: holdOf(here, target) }).toEqual({ pointer: target, hold: null });
          after = again.result;
        }
        cuts[point] = { started: home_, after };
        await started.stop();
        await stopChildren();
      }
      report.move_cut = cuts;
    } finally {
      await stopChildren();
    }
  });

  it("two moves begun together: the second refused at once, or once the first has moved the home, changing nothing", async () => {
    const { here, at, source, target } = await movable("move-twice");
    const other = join(realpathSync(temp("move-twice-other")), "home");
    const call = callOn(source);
    const lines: string[] = [];
    const first = move(target, { machine: at, out: (line) => lines.push(line) });
    let refused: string;
    try {
      await until("the first move waits for the call", () => lines.includes("waiting for a model call or a delivery to end"));
      refused = await move(other, { machine: at }).then(() => "moved", (error: Error) => error.message);
    } finally {
      call.release();
    }
    await first;
    expect(refused).toBe(`a move, a verb, or Lifestream starting or stopping holds Lifestream: try again once it has ended. Nothing changed: Lifestream stays at ${source}`);
    expect({ pointer: pointer(here), other: existsSync(other), hold: holdOf(here, target) }).toEqual({ pointer: target, other: false, hold: null });
    report.move_twice = refused;
  });

  it("a start made the moment the home stops for a move, as launchd's is when the stopped home exits: it opens the old folder, or makes the move ask twice, rather than waiting and starting on the new folder", async () => {
    const { here, at, target } = await movable("move-race");
    const lookMs = 20;
    const first = await startHome(null, { stopGraceMs: 50, machine: at, registry: FAKES, tickMs: 50, lookMs, log: () => undefined });
    const logs: string[] = [];
    let next: Promise<Home> | undefined;
    void first.stopped.then(() => {
      next = startHome(null, { stopGraceMs: 50, machine: at, registry: FAKES, tickMs: 50, lookMs, log: (line) => logs.push(line) });
    });
    onTestFinished(async () => {
      await next?.then((home) => home.stop(), () => undefined);
    });
    const lines: string[] = [];
    const moved = await move(target, { machine: at, out: (line) => lines.push(line) });
    expect(await first.stopped).toBe("stopped: a move or a verify asked");
    await next;
    const said = logs.map((line) => JSON.parse(line) as { home?: string; why?: string; root?: string }).filter((line) => line.home === "waiting" || line.home === "started");
    expect(said.map(({ home, why, root }) => ({ home, ...(why === undefined ? {} : { why }), ...(root === undefined ? {} : { root }) })))
      .toEqual([{ home: "waiting", why: LOCKED }, { home: "started", root: target }]);
    expect({ folder: moved.folder, pointer: pointer(here), hold: holdOf(here, target), waited: lines.filter((line) => line === "waiting for Lifestream to stop").length })
      .toEqual({ folder: target, pointer: target, hold: null, waited: 1 });
    report.move_race = { lines, second: logs };
  });

  it("a reader holding home.db past SQLite's busy timeout: the move waits for it, saying so, never fails, and copies every commit", async () => {
    const { here, at, source, target } = await movable("move-reader");
    const writer = openHomeFolder(source).store(HOME_STORE, join(source, "home.db"));
    writer.prepare("INSERT INTO meta (key, value) VALUES ('synthetic:read', 'behind a reader')").run();
    const reader = new Database(join(source, "home.db"), { readonly: true });
    reader.prepare("BEGIN").run();
    reader.prepare("SELECT count(*) FROM meta").get();
    writer.close();
    const lines: string[] = [];
    try {
      await move(target, { machine: at, out: (line) => {
        lines.push(line);
        if (line === "waiting for a reader of home.db to finish") reader.prepare("COMMIT").run();
      } });
    } finally {
      if (reader.inTransaction) reader.prepare("COMMIT").run();
      reader.close();
    }
    const waited = lines.indexOf("waiting for a reader of home.db to finish");
    expect([lines.indexOf("writing home.db's write-ahead log into it") + 1, lines.indexOf("writing replies.db's write-ahead log into it") - 1], lines.join("\n")).toEqual([waited, waited]);
    const copied = new Database(join(target, "home.db"), { readonly: true });
    expect(copied.prepare("SELECT value FROM meta WHERE key = 'synthetic:read'").pluck().get()).toBe("behind a reader");
    copied.close();
    expect({ pointer: pointer(here), hold: holdOf(here, target) }).toEqual({ pointer: target, hold: null });
    report.move_reader = lines;
  });

  it("a connection that locks the ledger whole as the move opens it: the move waits for it, saying so, never fails, and goes on", async () => {
    const { here, at, source, target } = await movable("move-locked");
    const holder = new Database(join(source, "replies", "replies.db"));
    holder.pragma("locking_mode = EXCLUSIVE");
    holder.prepare("BEGIN EXCLUSIVE").run();
    const lines: string[] = [];
    try {
      await move(target, { machine: at, out: (line) => {
        lines.push(line);
        if (line === "waiting for a reader of replies.db to finish") holder.close();
      } });
    } finally {
      if (holder.open) holder.close();
    }
    expect(lines.indexOf("waiting for a reader of replies.db to finish") - lines.indexOf("writing replies.db's write-ahead log into it"), lines.join("\n")).toBe(1);
    expect({ pointer: pointer(here), hold: holdOf(here, target) }).toEqual({ pointer: target, hold: null });
    report.move_locked = lines;
  });

  it("a move SIGKILLed while it writes HOME.json leaves the folder as it was, never a HOME.json cut short, and the move run again goes on", async () => {
    try {
      const cuts: Record<string, string[]> = {};
      for (const before of ["empty", "a move cut before"] as const) {
        const { here, source, target } = await movable(`move-naming-${before === "empty" ? "e" : "c"}`);
        if (before !== "empty") {
          mkdirSync(target, { recursive: true });
          writeFileSync(join(target, "HOME.json"), readFileSync(join(source, "HOME.json")));
        }
        const cut = start({ env: { ...here.env, LIFESTREAM_FAILPOINT: "move.naming" } }, CLI, ["move", target]);
        await cut.exited;
        expect(cut.child.signalCode, cut.out()).toBe("SIGKILL");
        cuts[before] = readdirSync(target).sort();
        expect(cuts[before]).toEqual(before === "empty" ? [".HOME.json.moving"] : [".HOME.json.moving", "HOME.json"]);
        if (before !== "empty") expect(readFileSync(join(target, "HOME.json"), "utf8")).toBe(readFileSync(join(source, "HOME.json"), "utf8"));
        expect(pointer(here)).toBe(source);
        const again = await home(here, ["move", target]);
        expect(again.status, again.out).toBe(0);
        expect(filesOf(target)).toEqual(filesOf(source));
        expect(existsSync(join(target, ".HOME.json.moving"))).toBe(false);
        expect({ pointer: pointer(here), hold: holdOf(here, target) }).toEqual({ pointer: target, hold: null });
      }
      report.move_naming = cuts;
    } finally {
      await stopChildren();
    }
  });

  it("the folder a move left is offered to adopt, or not shown in status; a move back cut after its pointer offers the running home as the old copy; --replace does not take a copy", async () => {
    const { here, at, source, target } = await movable("move-copies");
    await move(target, { machine: at });
    const status = await home(here, ["status", "--json"]);
    expect((status.result as { old_copy: unknown }).old_copy).toMatchObject({ path: source, bytes: expect.any(Number) });
    expect((await home(here, ["status"])).out).toMatch(new RegExp(`Old copy\\n  ${source}: .*only second copy until a backup exists`, "u"));
    const refused = await home(here, ["adopt", source]);
    expect(refused.status, refused.out).toBe(1);
    const words = `${source} is a copy of the Lifestream folder this machine runs, which is at ${target}: a move cut part way, or the folder a move left. lifestream adopt ${source} --replace takes this copy instead, and gives up whatever the folder at ${target} holds that this copy does not`;
    expect(refused.out.trim()).toBe(words);
    expect(((await home(here, ["machine", source])).result as { folder: { refused: string } }).folder.refused).toBe(words);
    await expect(startHome(source, { stopGraceMs: 50, machine: at, registry: FAKES, log: () => undefined })).rejects.toThrow(words);
    const free = tryLock(join(source, "home.lock"));
    expect(free).not.toBeNull();
    free!.release();
    const back = start({ env: { ...here.env, LIFESTREAM_FAILPOINT: "move.pointed" } }, CLI, ["move", source]);
    await back.exited;
    expect(back.child.signalCode, back.out()).toBe("SIGKILL");
    expect(pointer(here)).toBe(source);
    const looked = await home(here, ["status", "--json"]);
    expect((looked.result as { old_copy: { path: string } }).old_copy.path).toBe(target);
    const replaced = await home(here, ["adopt", target, "--replace"]);
    expect(replaced.status, replaced.out).toBe(0);
    expect({ as: (replaced.result as { as: string }).as, pointer: pointer(here) }).toEqual({ as: "kept", pointer: target });
    report.move_copies = { old_copy: (status.result as { old_copy: unknown }).old_copy, refused: refused.out.trim(), back: (looked.result as { old_copy: unknown }).old_copy };
  });

  it("a folder inside the home, holding another home or other files, on a network volume, a disk not APFS or too small a disk is moved into, a damaged home is moved, a lock no home answers for is waited on, or any changes anything", async () => {
    const { here, at, source, target } = await movable("move-refused");
    const files = filesOf(source);
    const other = join(realpathSync(temp("move-refused-other")), "home");
    mkdirSync(other);
    writeFileSync(join(other, "HOME.json"), JSON.stringify({ format: "org.lifestreamprotocol.home/1", id: "another-home", created: "2026-10-01T00:00:00.000Z" }));
    const stray = realpathSync(temp("move-refused-stray"));
    writeFileSync(join(stray, "notes.txt"), "someone's file");
    const refusals: Record<string, string> = {};
    const refuse = async (name: string, folder: string, options: Parameters<typeof move>[1] = {}) => {
      const before = existsSync(folder) ? readdirSync(folder).sort() : null;
      const error = await move(folder, { machine: at, ...options }).then(() => null, (thrown: Error) => thrown.message);
      expect(error, name).not.toBeNull();
      expect(existsSync(folder) ? readdirSync(folder).sort() : null, name).toEqual(before);
      refusals[name] = error!;
    };
    await refuse("inside", join(source, "inside"));
    await refuse("another home", other);
    await refuse("other files", stray);
    await refuse("network", target, { fileSystem: () => "smbfs" });
    await refuse("not apfs", target, { fileSystem: () => "hfs" });
    const free = freeSpace(KEEP_BYTES);
    await refuse("too small", target);
    free.set(1e12);
    const id = readHome(source).id;
    const held: Hold = { since_ms: 1, cause: { met: "home.db", error: "SQLITE_CORRUPT" }, check: { found: ["home.db is damaged: SQLite finds synthetic"], at_ms: 1 } };
    hold(at, id, held);
    await refuse("damaged", target);
    expect(readHold(at, id)).toEqual(held);
    release(at, id);
    const verb = tryLock(join(source, "home.lock"))!;
    try {
      await refuse("locked", target);
    } finally {
      verb.release();
    }
    expect(refusals).toEqual({
      inside: expect.stringContaining("are one inside the other"),
      "another home": expect.stringContaining("holds another home (another-home)"),
      "other files": expect.stringContaining("holds files that are not Lifestream's"),
      network: expect.stringContaining("is on a network volume (smbfs)"),
      "not apfs": `${target} is on a hfs disk; Lifestream needs APFS: format the disk APFS in Disk Utility`,
      "too small": expect.stringMatching(/on a disk with 5\.0 GB free; the move needs .* GB: the .* GB it copies and the 5 GB every disk keeps free/u),
      damaged: holdLine(held, source),
      locked: `a move, a verb, or Lifestream starting or stopping holds Lifestream: try again once it has ended. Nothing changed: Lifestream stays at ${source}`,
    });
    expect({ pointer: pointer(here), hold: holdOf(here, source) }).toEqual({ pointer: source, hold: null });
    expect(filesOf(source)).toEqual(files);
    report.move_refused = refusals;
  });
});
