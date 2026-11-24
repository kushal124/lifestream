import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { openHomeFolder, trySharedLock } from "@lifestreamprotocol/core";
import { callsLock, openLedger } from "@lifestreamprotocol/model";
import { findingsDirOf } from "./engine-pictures.js";
import { readReport } from "./feedback.js";
import { startHome } from "./home.js";
import { machine } from "./machine.js";
import { picturesDirOf } from "./pictures.js";
import { preparedDirOf, preparedFileOf } from "./prepared.js";
import { SearchIndex, searchFileOf } from "./search-index.js";
import { ask, askHome } from "./socket.js";
import { readStatus } from "./status.js";
import { readOpsSettings } from "./verbs/context.js";
import { count, filesUnder, inFlight, left, MINUTE, note, quiet, requests, sharded, SOURCE } from "./test/erasures.js";
import { editSettings, testSocket } from "./test/folder.js";
import { fakeWorker, keptReport } from "./test/feedback-worker.js";
import { artifact, ChildHome, copyRoot, FAKES, hex, makeRoot, readHome, readLedger, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { startHere } from "./test/harness-home.js";
import { exactTerms, searchOf } from "./test/record-reads.js";

const roots: string[] = [];
const homeOn = (root: string, options: { erasureCallsMs?: number; feedbackUrl?: string } = {}) => {
  const lines: string[] = [];
  return { lines, started: startHere(root, { tickMs: TICK_MS, log: (line) => lines.push(line), ...options }) };
};
const childOn = (root: string): ChildHome => {
  const child = new ChildHome(root);
  onTestFinished(async () => { await child.stop(); });
  return child;
};
async function killedAt(root: string, point: string): Promise<void> {
  const dying = childOn(root);
  dying.start(point);
  await dying.ready();
  await expect(askHome(testSocket(root), "erase", ["notes", "n1", "--purge-deliveries", "--apply"])).rejects.toThrow();
  expect(await dying.exited()).toEqual({ code: null, signal: "SIGKILL" });
  rmSync(testSocket(root).path, { force: true });
}
const standing = (root: string) => ({
  intent: count(root, "SELECT count(*) FROM meta WHERE key = 'erasure'"),
  erasing: readLedger(root, (db) => db.prepare("SELECT count(*) FROM meta WHERE key = 'erasing'").pluck().get()),
});
const intentOf = (root: string) => JSON.parse(readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = 'erasure'").pluck().get() as string)) as Record<string, unknown>;
const erasureLines = (lines: readonly string[]) => lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => typeof line.home === "string" && line.home.startsWith("erasure"));
function found(root: string, word: string): number {
  const index = SearchIndex.read(openHomeFolder(root), searchFileOf(root, machine().dir));
  if (index === undefined) return 0;
  try {
    const answer = searchOf(index, { terms: exactTerms(word), order: "relevance", limit: 50 });
    return "hits" in answer ? answer.hits.length : 0;
  } finally {
    index.close();
  }
}
async function flushesDuring(seen: (directory: string) => void, act: () => Promise<unknown>): Promise<void> {
  const opened = new Map<number, string>();
  const { openSync, fsyncSync } = fs;
  fs.openSync = ((...args: Parameters<typeof openSync>) => {
    const fd = openSync(...args);
    if (typeof args[0] === "string" && args[1] === "r") opened.set(fd, args[0]);
    return fd;
  }) as typeof openSync;
  fs.fsyncSync = (fd) => {
    const path = opened.get(fd);
    if (path !== undefined && statSync(path).isDirectory()) seen(path);
    fsyncSync(fd);
  };
  syncBuiltinESMExports();
  try {
    await act();
  } finally {
    fs.openSync = openSync;
    fs.fsyncSync = fsyncSync;
    syncBuiltinESMExports();
  }
}
const days = (root: string): string => filesUnder(join(root, "days")).filter((file) => !file.startsWith(".")).map((file) => readFileSync(join(root, "days", file), "utf8")).join("\n");

afterAll(() => {
  for (const root of roots) removeRoot(root);
});

describe("an erasure of a note with images", () => {
  const imageA = Buffer.from("synthetic image A, only the erased note shows it");
  const imageC = Buffer.from("synthetic image C, the erased note and another show it");
  const [a, c] = [hex(imageA), hex(imageC)];
  const WORD = "zqxerased";
  let prepared: { root: string; deliveries: string[]; blobs: string[] };
  let index: { dir: string; kept: string };
  const indexAsPrepared = () => {
    rmSync(index.dir, { recursive: true, force: true });
    cpSync(index.kept, index.dir, { recursive: true });
  };

  beforeAll(async () => {
    const root = makeRoot("lifestream-erasure-prepared-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.notes": { text: "1" } } });
    roots.push(root);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, tickMs: TICK_MS, log: () => undefined });
    try {
      const at = Date.now() - 30 * MINUTE;
      const erased = note("n1", `a ${WORD} note with two images`, at, { photo: true, images: [`sha256:${a}`, `sha256:${c}`] });
      const d1 = await ship(root, {
        source: SOURCE, fetched_ms: at + 1_000, carried: { [a]: imageA, [c]: imageC },
        rows: [{ ...erased, blobs: [`sha256:${a}`, `sha256:${c}`] }, note("n2", "a plain note", at + 1_000), { ...note("n3", "a note sharing image C", at + 2_000, { photo: true, images: [`sha256:${c}`] }), blobs: [`sha256:${c}`] }],
      });
      await until("both captions", () => count(root, "SELECT count(*) FROM enrichments WHERE state = 'done'") === 2 && quiet(root));
      const d2 = await ship(root, { source: SOURCE, fetched_ms: at + 2 * MINUTE, rows: [{ ...erased, blobs: [`sha256:${a}`, `sha256:${c}`], read_blobs: true }, note("n2", "a plain note", at + 1_000)] });
      const d3 = await ship(root, { source: SOURCE, fetched_ms: at + 3 * MINUTE, rows: [note("n4", "a later note", at + 3 * MINUTE)] });
      await until("the deliveries imported and the note indexed", () => count(root, "SELECT count(*) FROM deliveries WHERE state = 'imported'") === 3 && quiet(root) && found(root, WORD) > 0);
      const deliveries = [d1, d2, d3];
      prepared = { root, deliveries, blobs: deliveries.map((id) => hex(readFileSync(join(root, "inbox", ...id.split("/"), "rows.ndjson")))) };
    } finally {
      await home.stop();
    }
    const dir = dirname(searchFileOf(root, machine().dir));
    index = { dir, kept: mkdtempSync(join(tmpdir(), "lifestream-erasure-index-")) };
    cpSync(dir, index.kept, { recursive: true });
  });

  afterAll(() => {
    rmSync(index.dir, { recursive: true, force: true });
    rmSync(index.kept, { recursive: true, force: true });
  });

  it.each(["none", "erase.intent", "erase.cleanup", "erase.ledger", "erase.forgot.search", "erase.forgot.screen", "erase.search", "erase.blobs", "erase.purge", "erase.delivery", "erase.committed"])(
    "an erasure killed at %s, and the home started again, leaves a copy of the thing, serves it back or leaves a delivery that holds it",
    async (point) => {
      const root = copyRoot(prepared.root, `lifestream-erasure-${point}-`);
      roots.push(root);
      indexAsPrepared();
      const [d1, d2, d3] = prepared.deliveries as [string, string, string];
      const [b1, b2, b3] = prepared.blobs as [string, string, string];
      const copies = (hash: string) => ({
        blobs: existsSync(sharded(join(root, "blobs"), hash)),
        attachments: existsSync(sharded(join(root, "replies", "blobs"), hash)),
        inbox: filesUnder(join(root, "inbox")).filter((file) => hex(readFileSync(join(root, "inbox", file))) === hash).length,
      });
      expect(copies(a)).toEqual({ blobs: true, attachments: true, inbox: 1 });
      expect(copies(b2)).toMatchObject({ blobs: true, inbox: 1 });
      expect({ day: days(root).includes(WORD), found: found(root, WORD) > 0, ...standing(root) }).toEqual({ day: true, found: true, intent: 0, erasing: 0 });
      const findings = (hash: string) => join(findingsDirOf(openHomeFolder(root), machine().dir).dir, hash.slice(0, 2), `${hash}.json`);
      for (const hash of [a, c]) {
        mkdirSync(dirname(findings(hash)), { recursive: true });
        writeFileSync(findings(hash), "synthetic findings");
      }
      onTestFinished(() => rmSync(findingsDirOf(openHomeFolder(root), machine().dir).dir, { recursive: true, force: true }));

      let crashed: unknown = null;
      if (point === "none") {
        await homeOn(root).started;
        expect(await askHome(testSocket(root), "erase", ["notes", "n1", "--purge-deliveries", "--apply"])).toMatchObject({ records: 1, deliveries_purged: 2 });
      } else {
        await killedAt(root, point);
        crashed = { a: copies(a), b1: copies(b1), b2: copies(b2), ...standing(root) };
        await homeOn(root).started;
      }
      await until("the home caught up", () => quiet(root) && inFlight(root) === 0);

      const after = { a: copies(a), c: copies(c), b1: copies(b1), b2: copies(b2), b3: copies(b3) };
      const served = { day: days(root), found: found(root, WORD), ...standing(root) };
      const purged = count(root, "SELECT count(*) FROM deliveries WHERE id IN (?, ?) AND error LIKE 'purged by erasure run %'", d1, d2);
      artifact(root, `erase-killed-${point}`, { crashed, after, served, purged });
      expect(served.day).not.toContain(WORD);
      expect(served.day).toContain("a plain note");
      expect(served.day).toContain("a note sharing image C");
      expect(served.found).toBe(0);
      expect({ intent: served.intent, erasing: served.erasing }).toEqual({ intent: 0, erasing: 0 });
      expect(left(root, "n1")).toEqual({ statements: 0, heads: 0, erasures: 1, enrichments: 0, requests: 0 });
      expect(count(root, "SELECT count(*) FROM versions WHERE key = 'n1'")).toBe(0);
      expect(count(root, "SELECT count(*) FROM version_blobs WHERE blob = ?", `sha256:${a}`)).toBe(0);
      expect(count(root, "SELECT count(*) FROM runs WHERE kind = 'erase' AND outcome = 'ok'")).toBe(1);
      expect(purged).toBe(2);
      expect(existsSync(join(root, "inbox", ...d1.split("/")))).toBe(false);
      expect(existsSync(join(root, "inbox", ...d2.split("/")))).toBe(false);
      const gone = { blobs: false, attachments: false, inbox: 0 };
      expect(after.a).toEqual(gone);
      expect(after.b1).toEqual(gone);
      expect(after.b2).toEqual(gone);
      expect(existsSync(findings(a))).toBe(false);
      expect(after.c).toMatchObject({ blobs: true, attachments: true });
      expect(existsSync(findings(c))).toBe(true);
      expect(after.b3).toMatchObject({ blobs: true, inbox: 1 });
      expect(existsSync(join(root, "inbox", ...d3.split("/")))).toBe(true);
      expect(requests(root, "photo:n3")).toBe(1);
      expect(left(root, "n3")).toMatchObject({ statements: 1, heads: 1, erasures: 0, enrichments: 1 });
    },
  );

  it("a start whose resume fails leaves the erasing mark, tells the operator nothing, logs the note's words, or is never finished; another erasure or a screen's press runs meanwhile", async () => {
    const root = copyRoot(prepared.root, "lifestream-erasure-unfinished-");
    roots.push(root);
    indexAsPrepared();
    const sock = testSocket(root);
    const throws = join(root, "replicas-throw");
    editSettings(root, { "families.notes": { text: "1", replicas_throw: throws } });
    await killedAt(root, "erase.blobs");
    expect(standing(root)).toEqual({ intent: 1, erasing: 1 });
    writeFileSync(throws, "");

    const home = homeOn(root);
    await home.started;
    expect(erasureLines(home.lines)).toEqual([
      expect.objectContaining({ home: "erasure unfinished", family: "notes", step: "plan" }),
      expect.objectContaining({ home: "erasure mark cleared" }),
    ]);
    expect(home.lines.join("\n")).not.toMatch(new RegExp(`${WORD}|replicas of n1`, "u"));
    expect(intentOf(root)).toMatchObject({ family: "notes", thing: "n1", purge: true, deliveries: prepared.deliveries.slice(0, 2), step: "plan", error: "the notes family cannot name the replicas of n1" });
    expect(standing(root)).toEqual({ intent: 1, erasing: 0 });
    const ledger = openLedger(openHomeFolder(root), { mode: "write" });
    try {
      expect(ledger.placeholders.epoch().erasing).toBe(false);
    } finally {
      ledger.close();
    }
    const notices = async () => readHome(root, (db) => readStatus(db, { folder: openHomeFolder(root), now_ms: Date.now(), settings: readOpsSettings(root), connectors: [], families: [], ledger: null }))
      .notices.filter((notice) => notice.id === "erasure");
    expect(await notices()).toEqual([expect.objectContaining({
      what: "erase notes stopped at plan; what it erases still shows until it finishes (lifestream act erasure try runs it again, and its answer says why)",
    })]);
    await expect(askHome(sock, "erase", ["notes", "n2", "--apply"])).rejects.toThrow("an erasure that did not finish stands: run `lifestream act erasure try` first");
    await expect(ask(sock, { verb: "act", args: ["erasure", "try"], by: "you" })).rejects.toMatchObject({ status: 409, code: "NOT_OFFERED" });
    await expect(askHome(sock, "act", ["erasure", "try"])).rejects.toThrow("the notes family cannot name the replicas of n1");
    expect(standing(root)).toEqual({ intent: 1, erasing: 0 });

    rmSync(throws);
    const tried = await askHome(sock, "act", ["erasure", "try"]) as { acted: string; run: number };
    expect(tried).toMatchObject({ acted: "erased", run: expect.any(Number) });
    await until("the home caught up", () => quiet(root) && inFlight(root) === 0);
    expect(await notices()).toEqual([]);
    expect(standing(root)).toEqual({ intent: 0, erasing: 0 });
    expect(left(root, "n1")).toEqual({ statements: 0, heads: 0, erasures: 1, enrichments: 0, requests: 0 });
    expect(days(root)).not.toContain(WORD);
    expect(found(root, WORD)).toBe(0);
    expect(count(root, "SELECT count(*) FROM deliveries WHERE id IN (?, ?) AND error LIKE 'purged by erasure run %'", ...prepared.deliveries.slice(0, 2))).toBe(2);
    await expect(askHome(sock, "act", ["erasure", "try"])).rejects.toMatchObject({ status: 409, code: "NOT_OFFERED" });
    artifact(root, "erase-unfinished", { lines: erasureLines(home.lines), tried });
  });

  it("an erasure killed before it reached the reports leaves a queued report about the note unsent while it stands, and its resume rewrites it, which then goes without the answer", async () => {
    const root = copyRoot(prepared.root, "lifestream-erasure-feedback-");
    roots.push(root);
    indexAsPrepared();
    const folder = openHomeFolder(root);
    const id = "3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f";
    keptReport(folder, id, Date.now(), [{ source: SOURCE, kind: "note", key: "n1" }]);
    const throws = join(root, "replicas-throw");
    editSettings(root, { "families.notes": { text: "1", replicas_throw: throws } });
    await killedAt(root, "erase.intent");
    expect(standing(root)).toMatchObject({ intent: 1 });
    expect(readReport(folder, id)?.attachments.map((each) => each.kind)).toEqual(["answer", "app"]);
    writeFileSync(throws, "");

    const worker = await fakeWorker();
    const home = homeOn(root, { feedbackUrl: worker.url });
    await home.started;
    expect(erasureLines(home.lines)).toContainEqual(expect.objectContaining({ home: "erasure unfinished", family: "notes", step: "plan" }));
    expect(readReport(folder, id)).toMatchObject({ state: "queued", tries: 1 });
    rmSync(throws);
    expect(await askHome(testSocket(root), "act", ["erasure", "try"])).toMatchObject({ acted: "erased" });
    await until("the rewritten report went", () => readReport(folder, id)?.state === "sent");
    expect(readReport(folder, id)).toMatchObject({ refs: [], attachments: [{ kind: "app" }] });
    expect(worker.filed.map((each) => [...each.parts.keys()]), "sent once, after the erasure, with no answer").toEqual([["report", "app"]]);
  });

  it("a start whose barrier never gets calls.lock waits for good, applies the erasure without it, or keeps no error", async () => {
    const root = copyRoot(prepared.root, "lifestream-erasure-barrier-");
    roots.push(root);
    indexAsPrepared();
    await killedAt(root, "erase.intent");
    expect(standing(root)).toEqual({ intent: 1, erasing: 0 });
    const call = trySharedLock(callsLock(join(root, "replies", "replies.db")))!;
    onTestFinished(() => call.release());
    const home = homeOn(root, { erasureCallsMs: 1_000 });
    await home.started;
    expect(erasureLines(home.lines)).toEqual([
      expect.objectContaining({ home: "erasure", line: "waiting for model calls to end" }),
      expect.objectContaining({ home: "erasure unfinished", family: "notes", step: "calls" }),
    ]);
    expect(intentOf(root)).toMatchObject({ step: "calls", error: "a model call did not end" });
    expect(left(root, "n1")).toMatchObject({ statements: 1, heads: 1, erasures: 0 });
    expect(standing(root)).toEqual({ intent: 1, erasing: 0 });
    call.release();
    expect(await askHome(testSocket(root), "act", ["erasure", "try"])).toMatchObject({ acted: "erased" });
    expect(left(root, "n1")).toMatchObject({ statements: 0, heads: 0, erasures: 1 });
    expect(standing(root)).toEqual({ intent: 0, erasing: 0 });
  });

  it("a directory it removed from is not flushed before its commit, so a power cut keeps the erasure and brings a file back", async () => {
    const root = copyRoot(prepared.root, "lifestream-erasure-flush-");
    roots.push(root);
    indexAsPrepared();
    const sock = testSocket(root);
    const [, b2] = prepared.blobs as [string, string, string];
    const [d1] = prepared.deliveries as [string, string, string];
    const inbox = join(root, "inbox");
    await homeOn(root).started;

    const at = machine().dir;
    const picture = join(picturesDirOf(openHomeFolder(root), at).dir, "thumb-1", a.slice(0, 2));
    const preparedDirs = (["people", "places"] as const).map((name) => {
      const directory = preparedDirOf(root, at, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(preparedFileOf(directory, name), "");
      return directory;
    });
    mkdirSync(picture, { recursive: true });
    writeFileSync(join(picture, `${a}.jpg`), "synthetic picture");
    const finding = join(findingsDirOf(openHomeFolder(root), at).dir, a.slice(0, 2));
    mkdirSync(finding, { recursive: true });
    writeFileSync(join(finding, `${a}.json`), "synthetic findings");
    onTestFinished(() => {
      for (const directory of [...preparedDirs, picturesDirOf(openHomeFolder(root), at).dir, findingsDirOf(openHomeFolder(root), at).dir]) rmSync(directory, { recursive: true, force: true });
    });
    const sent = join(root, "replies", "sent");
    const key = readLedger(root, (db) => db.prepare("SELECT key FROM requests WHERE unit = ?").pluck().get("photo:n1")) as string;
    const ledger = openLedger(openHomeFolder(root), { mode: "write" });
    try {
      const made = ledger.sent.make({
        key, receiver: "OpenAI", route: "codex", level: "all", body: "a hidden caption ask", pictures: [{ jpeg: Buffer.from("synthetic hidden picture"), recipe: {} }], counts: {}, detector: null,
      }, Date.now(), ledger.placeholders.epoch().epoch);
      expect(made).toMatchObject({ id: expect.any(Number) });
    } finally {
      ledger.close();
    }
    const sentPictures = filesUnder(sent).map((file) => join(sent, file));
    expect(sentPictures).not.toEqual([]);

    const flushed = new Map<string, { erasures: number; d1: boolean }>();
    const stood: string[] = [];
    const d1Folder = join(inbox, ...d1!.split("/"));
    const inboxCopy = filesUnder(inbox).find((file) => hex(readFileSync(join(inbox, file))) === a)!;
    const attachment = join(root, "replies", "blobs", a.slice(0, 2), a.slice(2, 4), a);
    const files = [
      sharded(join(root, "blobs"), a), sharded(join(root, "blobs"), b2!), join(picture, `${a}.jpg`), join(finding, `${a}.json`), join(inbox, inboxCopy), attachment,
      ...(["people", "places"] as const).map((name) => preparedFileOf(preparedDirOf(root, at, name), name)),
    ];
    expect(files.filter((file) => !existsSync(file))).toEqual([]);

    await flushesDuring((path) => {
      flushed.set(path, { erasures: count(root, "SELECT count(*) FROM erasures"), d1: existsSync(d1Folder) });
      stood.push(...files.filter((file) => dirname(file) === path && existsSync(file)));
    }, () => askHome(sock, "erase", ["notes", "n1", "--purge-deliveries", "--apply"]));

    const directories = [
      join(root, "days"),
      ...preparedDirs,
      dirname(sharded(join(root, "blobs"), a)), dirname(sharded(join(root, "blobs"), b2!)),
      picture, finding,
      dirname(join(inbox, inboxCopy)), join(inbox, d1!.split("/")[0]!),
      dirname(attachment),
      sent,
    ];
    artifact(root, "erase-flushes", { flushed: Object.fromEntries(flushed) });
    const parent = join(inbox, d1!.split("/")[0]!);
    expect(directories.map((directory) => [directory, flushed.get(directory)]))
      .toEqual(directories.map((directory) => [directory, { erasures: 0, d1: directory !== parent }]));
    expect(stood).toEqual([]);
    expect(sentPictures.filter((file) => existsSync(file))).toEqual([]);
    expect(left(root, "n1")).toMatchObject({ erasures: 1 });
  });

  it("a try after a dead one, finding the files that try removed already gone, leaves their directories unflushed at its commit", async () => {
    const root = copyRoot(prepared.root, "lifestream-erasure-retry-flush-");
    roots.push(root);
    indexAsPrepared();
    const inbox = join(root, "inbox");
    const [d1] = prepared.deliveries as [string, string, string];
    const home = await startHere(root, { tickMs: TICK_MS, log: () => undefined });
    const at = Date.now() - 2 * MINUTE;
    const d4 = await shipFiles(root, SOURCE, at, { "rows.ndjson": Buffer.from(`${JSON.stringify(note("n5", "a note beside a file", at))}\n`), "image-a.bin": imageA });
    await until("the delivery imported", () => count(root, "SELECT count(*) FROM deliveries WHERE id = ? AND state = 'imported'", d4) === 1 && quiet(root) && inFlight(root) === 0);
    await home.stop();

    const machineDir = machine().dir;
    const picture = join(picturesDirOf(openHomeFolder(root), machineDir).dir, "thumb-1", a.slice(0, 2));
    mkdirSync(picture, { recursive: true });
    writeFileSync(join(picture, `${a}.jpg`), "synthetic picture");
    const finding = join(findingsDirOf(openHomeFolder(root), machineDir).dir, a.slice(0, 2));
    mkdirSync(finding, { recursive: true });
    writeFileSync(join(finding, `${a}.json`), "synthetic findings");
    onTestFinished(() => {
      for (const directory of [picturesDirOf(openHomeFolder(root), machineDir).dir, findingsDirOf(openHomeFolder(root), machineDir).dir]) rmSync(directory, { recursive: true, force: true });
    });
    const laneCopy = join(inbox, SOURCE, "blobs", a);
    const listedCopy = join(inbox, ...d4.split("/"), "image-a.bin");
    const files = [sharded(join(root, "blobs"), a), laneCopy, listedCopy, join(picture, `${a}.jpg`), join(finding, `${a}.json`)];
    expect(files.filter((file) => !existsSync(file))).toEqual([]);

    await killedAt(root, "erase.purge");
    expect({ files: files.filter((file) => existsSync(file)), ...standing(root) }).toEqual({ files: [], intent: 1, erasing: 1 });

    const flushed = new Map<string, { intent: number; erasures: number; d1: boolean }>();
    const d1Folder = join(inbox, ...d1.split("/"));
    await flushesDuring((path) => {
      if (!flushed.has(path)) flushed.set(path, { intent: count(root, "SELECT count(*) FROM meta WHERE key = 'erasure'"), erasures: count(root, "SELECT count(*) FROM erasures"), d1: existsSync(d1Folder) });
    }, () => homeOn(root).started);
    const directories = files.map((file) => dirname(file));
    artifact(root, "erase-retry-flushes", { flushed: Object.fromEntries(flushed) });
    expect(directories.map((directory) => [directory, flushed.get(directory)]))
      .toEqual(directories.map((directory) => [directory, { intent: 1, erasures: 0, d1: true }]));
    expect(standing(root)).toEqual({ intent: 0, erasing: 0 });
    expect(left(root, "n1")).toMatchObject({ statements: 0, erasures: 1 });
    expect(existsSync(join(inbox, ...d4.split("/")))).toBe(true);
  });
});
