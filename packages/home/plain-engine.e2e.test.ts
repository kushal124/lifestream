import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { testSocket } from "./test/folder.js";
import { ChildHome, makeRoot, readHome, readLedger, removeRoot, settled, until } from "./test/harness-root.js";
import { acquisitionBundle, DEVICE, startDoor } from "./test/support.js";

const SOURCE = "apple-notes:local:device-a";
const PROBE = fileURLToPath(new URL("./test/engine-report.mjs", import.meta.url));
const TOKEN = "synthetic-token-device".padEnd(43, "d");
const DAY = "2026-09-20";
const AT = Date.parse(`${DAY}T06:00:00Z`);

interface Said {
  pid: number;
  thread: number;
  program: string;
  at: "start" | "load" | "exit";
  module?: string;
  binaries?: string[];
}

function kindOf(program: string): string {
  if (program === "thread") return "thread";
  if (/door-child\.m?[jt]s$/u.test(program)) return "door";
  if (/(?:^|~)child\.m?[jt]s$/u.test(program)) return "home";
  if (/call-main\.m?[jt]s$/u.test(program)) return "call";
  return program;
}

describe("a plain home's processes", () => {
  it("never load the cipher engine: the home, its threads, the door and a call process, through a delivery, a model call and a walk", async () => {
    const root = makeRoot("lifestream-plain-engine-", { sources: { [SOURCE]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    mkdirSync(join(root, "artifacts"), { recursive: true });
    const report = join(root, "artifacts", "engine-report.ndjson");
    mintPrincipal(openHomeFolder(root), { unit: "device", kind: "mac", scopes: ["deliver"], sources: [SOURCE], token: TOKEN, now_ms: 0 });
    const env = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${PROBE}`.trim(), LIFESTREAM_ENGINE_REPORT: report };

    const home = new ChildHome(root);
    onTestFinished(async () => { await home.stop(); });
    home.start(undefined, { env });
    await home.ready();
    const door = await startDoor({ root, tokens: {}, ids: {} }, env, undefined, true);
    onTestFinished(async () => { await door.stop(); });

    const rows = Buffer.from(`${JSON.stringify({ kind: "note", key: "n1", content: { text: "synthetic note n1", at: AT, photo: true }, at: AT })}\n`);
    const bundle = acquisitionBundle({ source: SOURCE, feeder: "fake-rows", fetched_ms: AT, files: [["rows.ndjson", rows]], custody: { [SOURCE]: { seal: 1 } } });
    const put = await fetch(`${door.url}${bundle.path}`, { method: "PUT", body: bundle.bytes, headers: { authorization: `Bearer ${TOKEN}`, ...DEVICE.mac } });
    expect(put.status, await put.clone().text()).toBe(201);
    const day = join(root, "days", `${DAY}.day.txt`);
    await until("the delivery imported and its day captioned by a model call", () => settled(root, 1) && existsSync(day) && readFileSync(day, "utf8").includes("[fake reply "));
    expect(readLedger(root, (db) => db.prepare("SELECT count(*) FROM attempts").pluck().get() as number)).toBeGreaterThan(0);

    const walks = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM runs WHERE kind = 'walk' AND subject = 'notes' AND counts LIKE '%publish_ms%'").pluck().get() as number);
    const walked = walks();
    await askHome(testSocket(root), "rebuild", ["extracts", "--family", "notes"]);
    await until("the notes walk published", () => walks() > walked && settled(root, 1));

    expect(await door.stop()).toBe(0);
    expect((await home.stop()).code).toBe(0);
    const said = readFileSync(report, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Said);
    const started = said.filter((each) => each.at === "start");
    expect(new Set(started.map((each) => kindOf(each.program)))).toEqual(new Set(["home", "thread", "door", "call"]));
    const ended = said.filter((each) => each.at === "exit");
    expect(new Set(ended.map((each) => each.pid))).toEqual(new Set(started.filter((each) => each.thread === 0).map((each) => each.pid)));
    expect(said.filter((each) => each.at === "load" || (each.binaries ?? []).length > 0)).toEqual([]);
  });
});
