import { openHomeFolder } from "@lifestreamprotocol/core";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open as openPath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stagedFile } from "./ask-files.js";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { engineMaker, forgetPictures, fromBytes, openPictures, RECIPE, type Maker, type Outcome } from "./pictures.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { sharded } from "./test/erasures.js";
import { ChildHome, clientFixture, FAKES, LOOK_MS, makeRoot, readHome, removeRoot, REPO, until, TICK_MS } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { freePort } from "./test/harness-door.js";
import { editSettings, testSocket } from "./test/folder.js";


const NOTES = "apple-notes:local:device-a";
const BOOK = "apple-contacts:local:device-a";
const READER = "synthetic-pictures-reader".padEnd(43, "r");
const T = Date.parse("2026-10-01T10:00:00Z");
const MINUTE = 60_000;


const jpeg = (name: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`synthetic jpeg ${name}`)]);
const png = (name: string) => Buffer.from(`\x89PNG\r\n\x1a\nsynthetic png ${name}`, "latin1");
const gif = (name: string) => Buffer.from(`GIF89asynthetic gif ${name}`, "latin1");
const iso = (brand: string, name: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}synthetic ${name}`, "latin1")]);

const hexOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha = (bytes: Buffer) => `sha256:${hexOf(bytes)}`;


const STAND_IN = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const dir = process.env.STAND_IN_DIR;
const [command, requestPath, resultPath] = process.argv.slice(2);
const request = JSON.parse(readFileSync(requestPath, "utf8"));
const hex = createHash("sha256").update(readFileSync(request.from)).digest("hex");
appendFileSync(join(dir, "calls.log"), JSON.stringify({ command, hex, type: request.type, side: request.side }) + "\\n");
while (existsSync(join(dir, hex + ".gate"))) await new Promise((resolve) => setTimeout(resolve, 10));
const does = JSON.parse(readFileSync(join(dir, "engine.json"), "utf8"))[hex] ?? "jpeg";
if (does === "fail") {
  process.stderr.write("stand-in: this one fails\\n");
  process.exit(1);
}
const result = does === "animated" ? { animated: true } : does === "cannot" ? { cannot: "stand-in: no picture of it" } : { made: does };
if (result.made !== undefined) writeFileSync(request.to, "made " + (request.side ?? "full") + " of " + hex);
writeFileSync(resultPath, JSON.stringify(result));
`;

function standIn(dir: string) {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "stand-in.mjs");
  writeFileSync(script, STAND_IN);
  const program = join(dir, "face-engine");
  writeFileSync(program, `#!/bin/sh\nSTAND_IN_DIR='${dir}' exec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(program, 0o755);
  writeFileSync(join(dir, "engine.json"), "{}");
  return {
    program,
    tell: (does: Record<string, string>) => writeFileSync(join(dir, "engine.json"), JSON.stringify(Object.fromEntries(Object.entries(does).map(([hash, word]) => [hash.slice(7), word])))),
    calls: (): { command: string; hex: string; type: string; side: number | null }[] => existsSync(join(dir, "calls.log"))
      ? readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as never) : [],
    gate: (bytes: Buffer) => {
      const gate = join(dir, `${hexOf(bytes)}.gate`);
      writeFileSync(gate, "");
      return () => rmSync(gate, { force: true });
    },
  };
}


const cacheOf = (dir: string) => ({ folder: openHomeFolder(dir), dir });

describe("pictures through the door", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url: string;
  let port: number;
  let shipped = 0;
  let scratch: string;
  let engine: ReturnType<typeof standIn>;
  let folder: string;
  const report: Record<string, unknown> = {};

  const PHOTO = jpeg("photo"), CLEAR = png("clear"), MOVIE = iso("qt  ", "movie"), MP4 = iso("isom", "mp4"), SOUND = iso("M4A ", "sound");
  const MP4V = iso("mp4v", "gif clip"), DASH = iso("dash", "dash clip");
  const [WIDE, MDAT, MOOV] = ["wide", "mdat", "moov"].map((atom) => Buffer.concat([Buffer.from([0, 0, 0, 8]), Buffer.from(`${atom}synthetic motion`, "latin1")])) as [Buffer, Buffer, Buffer];
  const NONE = Buffer.from("synthetic bytes that are no picture\n"), MOVING = gif("moving"), CANNOT = jpeg("cannot"), FAILS = jpeg("fails");
  const ONCE = jpeg("once"), PURGED = jpeg("purged"), LATE = jpeg("late"), ORDER = jpeg("order"), CARD = jpeg("card"), STAGED = jpeg("staged");

  const open = async () => {
    door = await serveDoor(root, { port, max_bundle_bytes: 1 << 30 }, { log: () => undefined, lookMs: LOOK_MS, maker: engineMaker(engine.program) });
    url = `http://127.0.0.1:${door.port}`;
  };
  const calm = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() === shipped
    && db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get() === 0);
  const send = async (source: string, rows: object[], carried: Buffer[]) => {
    await ship(root, { source, fetched_ms: T + shipped * MINUTE, rows: rows as never, carried: Object.fromEntries(carried.map((bytes) => [hexOf(bytes), bytes])) });
    shipped++;
    await until("the home settled", calm);
  };
  const noteOf = (key: string, bytes: Buffer, n: number) => ({ kind: "note", key, at: T + n * MINUTE, content: { text: `synthetic note ${key}`, at: T + n * MINUTE }, blobs: [sha(bytes)] });
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READER}`, ...headers } });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  };
  const picture = (bytes: Buffer | string, size: string, recipe: string | null = String(RECIPE), headers: Record<string, string> = {}) =>
    get(`/v1/pictures/${typeof bytes === "string" ? bytes : sha(bytes)}?size=${size}${recipe === null ? "" : `&recipe=${recipe}`}`, headers);
  const codeOf = (body: Buffer) => (JSON.parse(body.toString("utf8")) as { code: string }).code;
  const madeOf = (bytes: Buffer, side?: number | null) => engine.calls().filter((call) => call.hex === hexOf(bytes) && (side === undefined || call.side === side)).length;
  const keptAt = (bytes: Buffer, size: string, extension: string) => join(folder, `${size}-${RECIPE}`, hexOf(bytes).slice(0, 2), `${hexOf(bytes)}.${extension}`);
  const filesOf = (bytes: Buffer) => !existsSync(folder) ? [] : (readdirSync(folder, { recursive: true }) as string[]).filter((path) => path.includes(hexOf(bytes)));

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "lifestream-pictures-"));
    engine = standIn(join(scratch, "engine"));
    engine.tell({ [sha(CLEAR)]: "png", [sha(MOVING)]: "animated", [sha(CANNOT)]: "cannot", [sha(FAILS)]: "fail" });
    root = makeRoot("lifestream-pictures-", { sources: { [NOTES]: "fake-rows", [BOOK]: "fake-rows" } });
    folder = join(process.env.LIFESTREAM_MACHINE_DIR!, "pictures", (JSON.parse(readFileSync(join(root, "HOME.json"), "utf8")) as { id: string }).id);
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    port = await freePort();
    editSettings(root, { "door.port": port });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, lookMs: LOOK_MS, log: () => undefined });
    await open();
    const held = { photo: PHOTO, clear: CLEAR, movie: MOVIE, mp4: MP4, mp4v: MP4V, dash: DASH, wide: WIDE, mdat: MDAT, moov: MOOV, sound: SOUND, none: NONE, moving: MOVING, cannot: CANNOT, fails: FAILS, once: ONCE };
    await send(NOTES, Object.entries(held).map(([key, bytes], n) => noteOf(key, bytes, n)), Object.values(held));
    await send(NOTES, [noteOf("purged", PURGED, 20)], [PURGED]);
    await send(NOTES, [noteOf("late", LATE, 21)], [LATE]);
    await send(NOTES, [noteOf("order", ORDER, 22)], [ORDER]);
    const vcard = `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Person Card\r\nTEL:+15550000101\r\nPHOTO;ENCODING=b;TYPE=JPEG:${CARD.toString("base64")}\r\nEND:VCARD\r\n`;
    await send(BOOK, [{ kind: "contact", key: hexOf(Buffer.from(vcard)), content: { card: vcard } }], []);
    await until("People lists the card photo", async () => (await get(`/v1/people/card?hash=${sha(CARD)}`)).status === 200);
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    report.calls = engine?.calls();
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "pictures.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  });

  it("states its recipe, the read a client decodes", async () => {
    const answer = await get("/v1/pictures");
    const body = JSON.parse(answer.body.toString("utf8")) as unknown;
    expect([answer.status, body]).toEqual([200, { recipe: 2 }]);
    const fixture = clientFixture("pictures", body);
    expect(fixture.held, "homelink/Tests/Fixtures/pictures.json is this read: LIFESTREAM_FIXTURES=write writes it").toBe(fixture.written);
    expect((await get("/v1/pictures?size=tile")).status).toBe(422);
  });

  it("makes a JPEG at every size, tile 640, screen 2560 and full its own, and keeps each", async () => {
    const said: Record<string, unknown> = {};
    for (const [size, side] of [["tile", 640], ["screen", 2560], ["full", null]] as const) {
      const answer = await picture(PHOTO, size);
      expect([answer.status, answer.headers.get("content-type"), answer.headers.get("etag"), answer.headers.get("cache-control")], size)
        .toEqual([200, "image/jpeg", `"${hexOf(PHOTO)}-${size}-2"`, "private, max-age=86400"]);
      expect([answer.body.toString("utf8"), Number(answer.headers.get("content-length"))], size).toEqual([`made ${side ?? "full"} of ${hexOf(PHOTO)}`, answer.body.length]);
      expect(readFileSync(keptAt(PHOTO, size, "jpg")).equals(answer.body), size).toBe(true);
      said[size] = answer.body.toString("utf8");
    }
    expect(engine.calls().filter((call) => call.hex === hexOf(PHOTO)).map(({ type, side }) => [type, side])).toEqual([["image/jpeg", 640], ["image/jpeg", 2560], ["image/jpeg", null]]);
    const clear = await picture(CLEAR, "tile");
    expect([clear.status, clear.headers.get("content-type"), existsSync(keptAt(CLEAR, "tile", "png"))]).toEqual([200, "image/png", true]);
    report.made = said;
  });

  it("answers another ask while a kept picture's open waits on a disk that does not answer, then serves the picture the open finds", async () => {
    const kept = keptAt(PHOTO, "tile", "jpg");
    const bytes = readFileSync(kept);
    rmSync(kept);
    execFileSync("mkfifo", [kept]);
    try {
      const waiting = picture(PHOTO, "tile");
      expect((await get("/v1/pictures")).status).toBe(200);
      const writer = await openPath(kept, "w");
      await writer.close();
      const served = await waiting;
      expect([served.status, served.headers.get("content-length"), served.body.length]).toEqual([200, "0", 0]);
    } finally {
      rmSync(kept, { force: true });
      writeFileSync(kept, bytes);
    }
  });

  it("makes a video's poster, and asks no picture of a sound or of bytes that are none", async () => {
    for (const [bytes, type] of [[MOVIE, "video/quicktime"], [MP4, "video/mp4"], [MP4V, "video/mp4"], [DASH, "video/mp4"], [WIDE, "video/quicktime"], [MDAT, "video/quicktime"], [MOOV, "video/quicktime"]] as const) {
      const answer = await picture(bytes, "screen");
      expect([answer.status, answer.headers.get("content-type"), answer.body.toString("utf8")], type).toEqual([200, "image/jpeg", `made 2560 of ${hexOf(bytes)}`]);
      expect(engine.calls().filter((call) => call.hex === hexOf(bytes)).map((call) => call.type), type).toEqual([type]);
    }
    for (const bytes of [SOUND, NONE]) {
      const answer = await picture(bytes, "tile");
      expect([answer.status, codeOf(answer.body), madeOf(bytes)]).toEqual([404, "NOT_A_PICTURE", 0]);
      const validated = await picture(bytes, "tile", "2", { "if-none-match": `"${hexOf(bytes)}-tile-2"` });
      expect([validated.status, codeOf(validated.body)]).toEqual([404, "NOT_A_PICTURE"]);
    }
  });

  it("keeps a cannot and an animation, so neither runs the maker again, a door started again too", async () => {
    const cannot = await picture(CANNOT, "tile");
    expect([cannot.status, codeOf(cannot.body), existsSync(keptAt(CANNOT, "tile", "cannot"))]).toEqual([404, "NOT_A_PICTURE", true]);
    const moving = await picture(MOVING, "tile");
    expect([moving.status, moving.headers.get("content-type"), moving.headers.get("etag"), sha(moving.body), existsSync(keptAt(MOVING, "tile", "animated"))])
      .toEqual([200, "image/gif", `"${hexOf(MOVING)}-tile-2"`, sha(MOVING), true]);
    await door.close();
    await open();
    expect([(await picture(CANNOT, "tile")).status, sha((await picture(MOVING, "tile")).body)]).toEqual([404, sha(MOVING)]);
    expect([madeOf(CANNOT), madeOf(MOVING)]).toEqual([1, 1]);
  });

  it("answers a maker that fails 503 NOT_NOW, keeps nothing of it, and asks the maker again at the next ask", async () => {
    const failed = await picture(FAILS, "tile");
    expect([failed.status, codeOf(failed.body), failed.headers.get("retry-after"), filesOf(FAILS), madeOf(FAILS)]).toEqual([503, "NOT_NOW", "5", [], 1]);
    expect((await picture(FAILS, "tile")).status).toBe(503);
    expect(madeOf(FAILS)).toBe(2);
    engine.tell({ [sha(CLEAR)]: "png", [sha(MOVING)]: "animated", [sha(CANNOT)]: "cannot" });
    const made = await picture(FAILS, "tile");
    expect([made.status, made.body.toString("utf8"), madeOf(FAILS)]).toEqual([200, `made 640 of ${hexOf(FAILS)}`, 3]);
  });

  it("draws a photo Chat's stage keeps, not yet imported, at each size for a reader's pass, never an agent's", async () => {
    const staged = stagedFile(openHomeFolder(root), sha(STAGED)).path;
    mkdirSync(join(staged, ".."), { recursive: true });
    writeFileSync(staged, STAGED);
    const said: Record<string, unknown> = {};
    for (const [size, side] of [["tile", 640], ["screen", 2560]] as const) {
      const answer = await picture(STAGED, size);
      expect([answer.status, answer.headers.get("content-type"), answer.headers.get("etag"), answer.body.toString("utf8"), madeOf(STAGED, side)], size)
        .toEqual([200, "image/jpeg", `"${hexOf(STAGED)}-${size}-${RECIPE}"`, `made ${side} of ${hexOf(STAGED)}`, 1]);
      said[size] = answer.status;
    }
    const agent = "synthetic-pictures-agent".padEnd(43, "a");
    const server = "synthetic-pictures-server".padEnd(43, "s");
    mintPrincipal(openHomeFolder(root), { unit: "server-a", scopes: ["admit"], token: server, now_ms: 0 });
    mintPrincipal(openHomeFolder(root), {
      unit: "agent-a", kind: "agent", scopes: ["read"], token: agent, now_ms: 0,
      granted: { agent: { name: "Agent A", via: "pass", from: null, checked: false, client_id: null, resource: null } },
    });
    const asAgent = { authorization: `Bearer ${agent}`, "lifestream-server": server };
    const refused = await Promise.all(["tile", "screen"].map((size) => picture(STAGED, size, String(RECIPE), asAgent)));
    expect(refused.map((answer) => [answer.status, codeOf(answer.body)])).toEqual([[403, "PRINCIPAL_SCOPE"], [403, "PRINCIPAL_SCOPE"]]);
    const record = await picture(PHOTO, "tile", String(RECIPE), asAgent);
    expect([record.status, codeOf(record.body)]).toEqual([403, "PRINCIPAL_SCOPE"]);
    rmSync(staged);
    const gone = await picture(STAGED, "tile");
    expect([gone.status, codeOf(gone.body)]).toEqual([404, "BLOB_UNKNOWN"]);
    report.staged = { ...said, agent: refused.map((answer) => answer.status), gone: gone.status };
  });

  it("makes a picture once for ten asks at once, and a door started again makes it no more", async () => {
    const answers = await Promise.all(Array.from({ length: 10 }, () => picture(ONCE, "tile")));
    expect(answers.map((answer) => answer.status)).toEqual(Array(10).fill(200));
    expect(new Set(answers.map((answer) => sha(answer.body))).size).toBe(1);
    expect(madeOf(ONCE)).toBe(1);
    await door.close();
    await open();
    const again = await picture(ONCE, "tile");
    expect([again.status, sha(again.body), madeOf(ONCE)]).toEqual([200, sha(answers[0]!.body), 1]);
    report.once = { asks: 11, made: madeOf(ONCE), files: filesOf(ONCE) };
  });

  it("answers 304 to an ask naming the recipe and holding its ETag; a URL naming another recipe or none, the picture, cached by no one", async () => {
    const etag = `"${hexOf(PHOTO)}-tile-2"`;
    const held = await picture(PHOTO, "tile", "2", { "if-none-match": etag });
    expect([held.status, held.headers.get("etag"), held.body.length]).toEqual([304, etag, 0]);
    const older = await picture(PHOTO, "tile", "2", { "if-none-match": `"${hexOf(PHOTO)}-tile-1"` });
    expect([older.status, older.headers.get("etag")]).toEqual([200, etag]);
    for (const recipe of [null, "1", "3"]) {
      const answer = await picture(PHOTO, "tile", recipe, { "if-none-match": etag });
      expect([answer.status, answer.headers.get("cache-control"), answer.headers.get("etag"), answer.body.toString("utf8")], `recipe ${recipe}`)
        .toEqual([200, "no-store", null, `made 640 of ${hexOf(PHOTO)}`]);
    }
    expect(madeOf(PHOTO, 640)).toBe(1);
  });

  it("serves a card photo People lists, which no version names, at its size", async () => {
    expect((await get(`/v1/blobs/${sha(CARD)}`)).status).toBe(404);
    const answer = await picture(CARD, "tile");
    expect([answer.status, answer.headers.get("content-type"), answer.body.toString("utf8")]).toEqual([200, "image/jpeg", `made 640 of ${hexOf(CARD)}`]);
    expect(existsSync(keptAt(CARD, "tile", "jpg"))).toBe(true);
  });

  it("refuses a blob no version names, a size not named, original, and a recipe that is no number", async () => {
    const unknown = await picture(`sha256:${hexOf(Buffer.from("synthetic bytes no version names"))}`, "tile");
    expect([unknown.status, codeOf(unknown.body)]).toEqual([404, "BLOB_UNKNOWN"]);
    for (const query of ["", "?size=original", "?size=thumb", "?size=tile&size=screen", "?size=tile&at=1", "?size=tile&recipe=two", "?size=tile&recipe=2&recipe=2"]) {
      const answer = await get(`/v1/pictures/${sha(PHOTO)}${query}`);
      expect([answer.status, codeOf(answer.body)], query).toEqual([422, "BAD_PARAMETER"]);
    }
    const shape = await get("/v1/pictures/sha256:abc?size=tile");
    expect([shape.status, codeOf(shape.body)]).toEqual([422, "BAD_PARAMETER"]);
  });

  it("removes a purged blob's pictures and marks with it, and answers it 404", async () => {
    expect((await picture(PURGED, "tile")).status).toBe(200);
    expect(existsSync(keptAt(PURGED, "tile", "jpg"))).toBe(true);
    writeFileSync(keptAt(PURGED, "tile", "cannot"), "synthetic mark\n");
    const erased = await askHome(testSocket(root), "erase", ["notes", "purged", "--purge-deliveries", "--apply"]) as { deliveries_purged: number };
    expect(erased.deliveries_purged).toBe(1);
    expect(filesOf(PURGED)).toEqual([]);
    await until("the purged picture answered 404", async () => (await picture(PURGED, "tile")).status === 404);
    const after = await picture(PURGED, "tile");
    expect([after.status, codeOf(after.body), filesOf(PURGED)]).toEqual([404, "BLOB_UNKNOWN", []]);
    report.purged = { erased, files: filesOf(PURGED) };
  });

  it("keeps nothing of a picture whose making an erasure overtook, and the ask waiting on it answers 404", async () => {
    const release = engine.gate(LATE);
    const asked = picture(LATE, "tile");
    await until("the erased picture's making begun", () => madeOf(LATE) === 1);
    const erased = await askHome(testSocket(root), "erase", ["notes", "late", "--purge-deliveries", "--apply"]) as { deliveries_purged: number };
    expect(erased.deliveries_purged).toBe(1);
    await until("People prepared again", async () => (await get(`/v1/people/card?hash=${sha(CARD)}`)).status === 200);
    release();
    const answer = await asked;
    expect([answer.status, codeOf(answer.body), madeOf(LATE), filesOf(LATE)]).toEqual([404, "BLOB_UNKNOWN", 1, []]);
    report.overtaken = { status: answer.status, files: filesOf(LATE) };
  });

  it("removes an erased blob before its pictures: killed between the two, the picture is what is left, and the start that finishes the erasure removes it", async () => {
    expect((await picture(ORDER, "tile")).status).toBe(200);
    expect(existsSync(keptAt(ORDER, "tile", "jpg"))).toBe(true);
    const sock = testSocket(root);
    const args = ["notes", "order", "--purge-deliveries", "--apply"];
    await home.stop();
    const dying = new ChildHome(root);
    try {
      dying.start("erase.blobs");
      await dying.ready();
      await expect(askHome(sock, "erase", args)).rejects.toThrow();
      expect(await dying.exited()).toEqual({ code: null, signal: "SIGKILL" });
    } finally {
      await dying.stop();
    }
    const crashed = { blob: existsSync(sharded(join(root, "blobs"), hexOf(ORDER))), picture: existsSync(keptAt(ORDER, "tile", "jpg")) };
    expect(crashed).toEqual({ blob: false, picture: true });
    rmSync(sock.path, { force: true });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, lookMs: LOOK_MS, log: () => undefined });
    expect(filesOf(ORDER)).toEqual([]);
    report.order = { crashed, after: filesOf(ORDER) };
  });
});

describe("the pictures' makings", () => {
  function gated() {
    const entered: string[] = [];
    const held: (() => void)[] = [];
    let making = 0;
    let most = 0;
    const maker: Maker = async ({ from, to }) => {
      entered.push(hexOf(readFileSync(from)));
      most = Math.max(most, ++making);
      await new Promise<void>((resolve) => held.push(resolve));
      writeFileSync(to, "made");
      making--;
      return { made: "jpeg" } satisfies Outcome;
    };
    return { maker, entered, held, most: () => most };
  }
  const originals = (name: string, count: number) => Array.from({ length: count }, (_, n) => jpeg(`${name} ${n}`));

  it("makes at most four at once, the rest in the order asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-pictures-order-"));
    try {
      const { maker, entered, held, most } = gated();
      const pictures = openPictures(cacheOf(dir), maker);
      const asked = originals("order", 6);
      const answers = asked.map((bytes) => pictures.picture(sha(bytes), "tile", fromBytes(bytes, cacheOf(dir), () => true)));
      await until("four makings begun", () => entered.length >= 4);
      for (let next = 5; next <= 6; next++) {
        held.shift()!();
        await until(`making ${next} begun`, () => entered.length >= next);
      }
      while (held.length > 0) held.shift()!();
      const served = await Promise.all(answers);
      expect(most()).toBe(4);
      expect(entered).toEqual(asked.map(hexOf));
      expect(served.map((each) => each?.type)).toEqual(Array(6).fill("image/jpeg"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never makes a waiting picture whose reader left, makes one a second ask still waits on, and keeps one whose reader left once begun", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-pictures-leave-"));
    try {
      const { maker, entered, held } = gated();
      const pictures = openPictures(cacheOf(dir), maker);
      const [first, second, third, fourth, left, shared] = originals("leave", 6) as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer];
      const ask = (bytes: Buffer, leaving?: AbortSignal) => pictures.picture(sha(bytes), "tile", fromBytes(bytes, cacheOf(dir), () => true), leaving);
      const firstReader = new AbortController();
      const busy = [ask(first, firstReader.signal), ask(second), ask(third), ask(fourth)];
      await until("four makings begun", () => entered.length === 4);
      firstReader.abort(new Error("the first's reader left"));
      await expect(busy[0]).rejects.toThrow("the first's reader left");
      const leaver = new AbortController();
      const waiting = ask(left, leaver.signal);
      const sharer = new AbortController();
      const sharing = [ask(shared, sharer.signal), ask(shared)];
      leaver.abort(new Error("its reader left"));
      sharer.abort(new Error("one of its readers left"));
      await expect(waiting).rejects.toThrow("its reader left");
      await expect(sharing[0]).rejects.toThrow("one of its readers left");
      while (entered.length < 5 || held.length > 0) {
        if (held.length > 0) held.shift()!();
        else await until("the next making begun", () => held.length > 0);
      }
      expect(await sharing[1]).toMatchObject({ type: "image/jpeg" });
      await Promise.all(busy.slice(1));
      expect(entered).toEqual([first, second, third, fourth, shared].map(hexOf));
      expect(await ask(first)).toMatchObject({ type: "image/jpeg" });
      expect(entered).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the pictures of every other recipe when it opens, keeps this one's, and forgets a blob's pictures and marks at every size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-pictures-recipes-"));
    try {
      const older = [`tile-${RECIPE - 1}`, `screen-${RECIPE + 1}`];
      const current = [`full-${RECIPE}`, `screen-${RECIPE}`, `tile-${RECIPE}`];
      const hex = "ab".padEnd(64, "c");
      for (const name of [...older, ...current]) {
        mkdirSync(join(dir, name, "ab"), { recursive: true });
        for (const extension of ["jpg", "png", "animated", "cannot"]) writeFileSync(join(dir, name, "ab", `${hex}.${extension}`), "kept");
      }
      openPictures(cacheOf(dir), gated().maker);
      await until("the other recipes' pictures removed", () => older.every((name) => !existsSync(join(dir, name))));
      expect(readdirSync(dir).sort()).toEqual(current);
      expect(forgetPictures(cacheOf(dir), `sha256:${hex}`).sort()).toEqual(current.map((name) => join(dir, name, "ab")));
      expect(current.flatMap((name) => readdirSync(join(dir, name, "ab")))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
