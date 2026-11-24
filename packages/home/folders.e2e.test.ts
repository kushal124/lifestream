import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { declarations } from "@lifestreamprotocol/connect";
import { openHome, openHomeFolder, tryLock } from "@lifestreamprotocol/core";
import { switchOf } from "./catalog.js";
import { runCli } from "./cli.js";
import { admittedSet, folderDigest, folderFindings, generationsFolder, hand, handed, handHeard, loadGeneration, type Generation } from "./folders.js";
import { askGeneration } from "./door.js";
import { startHome } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { homeRegistryModule } from "./programs.js";
import { homeOf, loadRegistry } from "./registry.js";
import { effective, settingsPath } from "./settings.js";
import { NOT_NOW, Refusal } from "./refusal.js";
import { askHome, serveSocket } from "./socket.js";
import type { StatusReport } from "./status.js";
import type { Raised } from "./streams-report.js";
import "./test/folder.js";
import { artifact, LOOK_MS, makeRoot, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { doorHere, openDoor } from "./test/harness-door.js";
import { homeWithDoor } from "./test/harness-home.js";
import { REPO } from "./test/support.js";
import { folderVerb, type FolderContext } from "./verbs/connectors-folder.js";
import { testSocket } from "./test/folder.js";

const TEMPLATE = join(REPO, "packages", "connect", "templates", "api");
const made: string[] = [];
afterAll(() => {
  for (const dir of made) removeRoot(dir);
});

function scratch(): { root: string; machineDir: string } {
  const root = makeRoot("lifestream-folders-", { sources: {} });
  const machineDir = mkdtempSync(join(tmpdir(), "lifestream-folders-machine-"));
  made.push(root, machineDir);
  mkdirSync(join(root, "connectors"));
  return { root, machineDir };
}

function folder(root: string, name: string, id = "example-api"): string {
  const at = join(root, "connectors", name);
  cpSync(TEMPLATE, at, { recursive: true });
  if (id !== "example-api") {
    for (const file of ["connector.ts", "index.ts", "reader.ts", "acquirer.ts"]) {
      const path = join(at, file);
      writeFileSync(path, readFileSync(path, "utf8").replaceAll("example-api", id).replaceAll("product: \"example\"", `product: "${id}"`).replaceAll("example:<account>", `${id}:<account>`));
    }
  }
  return at;
}

function entry(root: string, name: string, text: string, file = "index.ts"): void {
  mkdirSync(join(root, "connectors", name), { recursive: true });
  writeFileSync(join(root, "connectors", name, file), text);
}

const refusals = (generation: Generation) => Object.fromEntries(generation.refused.map((each) => [each.name, each.faults[0]]));

describe("the loader", () => {
  it("loads a folder from a running copy, or lets a broken one, a hanging one or one taking a taken name load, stop the start, or go unsaid", async () => {
    const { root, machineDir } = scratch();
    folder(root, "good");
    folder(root, "twice");
    folder(root, "release-name", "spotify");
    entry(root, "throws", "throw new Error(\"broken on purpose\\nits second line\");\nexport const contract = 3;\n");
    entry(root, "unread", readFileSync(join(TEMPLATE, "index.ts"), "utf8").replace(/export const readers[^;]*;/u, "export const readers = [];"));
    cpSync(TEMPLATE, join(root, "connectors", "unread"), { recursive: true, filter: (path) => !path.endsWith("index.ts") });
    entry(root, "old", "export const contract = 0;\nexport const connectors = [];\n", "index.mjs");
    mkdirSync(join(root, "connectors", "empty"));
    mkdirSync(join(root, "connectors", ".removed", "skipped"), { recursive: true });

    const generation = await loadGeneration({ root, machineDir });
    artifact(root, "generation", generation);
    expect(generation.folders.map((each) => each.name)).toEqual(["good"]);
    expect(refusals(generation)).toEqual({
      empty: ["folder", "holds no index.ts or index.mjs"],
      old: ["contract", "0 is no contract this home serves (it serves 3)"],
      "release-name": ["connectors[0].id", "spotify is a connector the folder listening/spotify holds already"],
      throws: ["import", "broken on purpose"],
      twice: ["readers[0].name", "example-api is a reader the folder good holds already"],
      unread: ["connectors[0].sources[0].read", "example-api is no reader the module exports"],
    });
    const [good] = generation.folders;
    expect(good!.entry.startsWith(join(generationsFolder(machineDir), good!.digest.replace("sha256:", ""), "index.ts"))).toBe(true);

    hand(generation);
    const set = await admittedSet(root);
    expect(set.filter((each) => each.whose === "home").map((each) => [each.folder, each.entry.connectors.map((connector) => connector.id)])).toEqual([["good", ["example-api"]]]);
    const draft = join(root, "drafts", "example-throws");
    mkdirSync(draft, { recursive: true });
    writeFileSync(join(root, "connectors", ".installed.json"), JSON.stringify({
      old: { from: join(root, "drafts", "example-old"), ids: ["example-old"] }, throws: { from: draft, ids: ["example-throws"] }, unread: { ids: ["example-unread"] },
    }));
    const findings = folderFindings(root);
    const install = (path: string) => `Fix it, then run lifestream connectors install ${path}`;
    const installed = (name: string) => install(join(root, "connectors", name));
    const failed = (name: string, line: string, detail: string, connector: string | null) => [`folder:${name}`, `${name} didn't load`, line, detail, connector];
    const code = "Its code has an error";
    expect(findings.needs.map((need) => [need.id, need.words, need.line, need.detail, need.connector])).toEqual([
      failed("empty", code, `holds no index.ts or index.mjs. ${installed("empty")}`, null),
      failed("old", code, `0 is no contract this home serves (it serves 3). ${installed("old")}`, "example-old"),
      failed("release-name", "Another connector holds its connector", "the release's listening/spotify holds the connector spotify: rename this folder's connector", null),
      failed("throws", code, `broken on purpose. ${install(draft)}`, "example-throws"),
      failed("twice", "Another connector holds its reader", "connectors/good holds the reader example-api: rename this folder's reader, or remove good first", null),
      failed("unread", code, `example-api is no reader the module exports. ${installed("unread")}`, "example-unread"),
    ]);
    expect(findings.notices.length).toBeGreaterThanOrEqual(6);
  });

  it("lets a folder whose import never ends hold the start past its trial's time, or load, its need asking for a restart", async () => {
    const { root, machineDir } = scratch();
    entry(root, "hangs", "setInterval(() => undefined, 1_000);\nawait new Promise(() => undefined);\nexport const contract = 3;\n");
    const generation = await loadGeneration({ root, machineDir, trialMs: 2_000 });
    expect([generation.folders, refusals(generation)]).toEqual([[], { hangs: ["import", "took too long to load"] }]);
    hand(generation);
    expect(folderFindings(root).needs.map((need) => [need.id, need.words, need.line, need.detail])).toEqual([["folder:hangs", "hangs didn't load", "Restart Lifestream to load it again", "took too long to load"]]);
  });

  it("lets an edit while the home runs change what runs or go unsaid, keeps a copy no process names, or moves the connect code with no folder", async () => {
    const { root, machineDir } = scratch();
    const settings = effective(root).settings;
    const bare = await loadRegistry(homeRegistryModule().href, settings, homeOf(openHomeFolder(root)));
    const path = folder(root, "good");
    const first = await loadGeneration({ root, machineDir });
    hand(first);
    const loaded = await loadRegistry(homeRegistryModule().href, settings, homeOf(openHomeFolder(root)));
    expect(loaded.connectors.some((connector) => connector.id === "example-api")).toBe(true);
    expect(loaded.code).not.toBe(bare.code);
    expect(folderFindings(root).needs).toEqual([]);

    writeFileSync(join(path, "connector.ts"), readFileSync(join(path, "connector.ts"), "utf8").replace("Every note's title and text.", "Every note's title, and its text."));
    folder(root, "later", "example-later");
    expect(folderFindings(root).needs.map((need) => [need.id, need.words])).toEqual([
      ["folder:good", "good changed"],
      ["folder:later", "later changed"],
    ]);
    expect((await admittedSet(root)).find((each) => each.folder === "good")!.entry.connectors[0]!.records).toBe("Every note's title and text.");

    const second = await loadGeneration({ root, machineDir });
    const copies = () => readdirSync(generationsFolder(machineDir)).filter((name) => !name.startsWith(".")).sort();
    const firstCopy = first.folders[0]!.digest.replace("sha256:", "");
    expect(second.folders.map((each) => each.name)).toEqual(["good", "later"]);
    expect(copies()).toContain(firstCopy);
    hand(second);
    expect((await loadRegistry(homeRegistryModule().href, settings, homeOf(openHomeFolder(root)))).code).not.toBe(loaded.code);
    await loadGeneration({ root, machineDir });
    expect(copies()).not.toContain(firstCopy);
    expect(copies()).toHaveLength(2);
  });

  it("lets a running home with a folder that does not load stop its start, or leave a good folder out of its report", async () => {
    const { root } = scratch();
    folder(root, "good");
    entry(root, "throws", "throw new Error(\"broken on purpose\");\n");
    const home = await homeWithDoor(root, { registry: homeRegistryModule(), log: () => undefined });
    try {
      const report = await askHome(testSocket(root), "connectors") as { connectors: { id: string }[]; needs: { id: string; words: string }[] };
      artifact(root, "report", report);
      expect(report.connectors.map((each) => each.id)).toContain("example-api");
      expect(report.needs.filter((need) => need.id.startsWith("folder:"))).toEqual([expect.objectContaining({ id: "folder:throws", words: "throws didn't load" })]);
      expect(await askHome(testSocket(root), "generation")).toEqual(expect.objectContaining({ root, folders: [expect.objectContaining({ name: "good" })] }));
    } finally {
      await home.stop();
    }
  });

  it("lets a folder fail to load from a checkout, through tsx and the hook, with no test bundles, or one Node's own stripping refuses load there", () => {
    const { root, machineDir } = scratch();
    folder(root, "good");
    folder(root, "unstrippable", "acme-unstrippable");
    writeFileSync(join(root, "connectors", "unstrippable", "test", "server.ts"), "export class Server {\n  constructor(private readonly port: number) {}\n}\n");
    const script = join(machineDir, "load.mts");
    writeFileSync(script, [
      `import { admittedSet, hand, loadGeneration } from ${JSON.stringify(pathToFileURL(join(REPO, "packages", "home", "folders.ts")).href)};`,
      `const generation = await loadGeneration({ root: ${JSON.stringify(root)}, machineDir: ${JSON.stringify(machineDir)}, trialMs: 25_000 });`,
      "hand(generation);",
      "const set = await admittedSet(generation.root);",
      "process.stdout.write(JSON.stringify({ sdk: generation.sdk, refused: generation.refused, home: set.filter((each) => each.whose === \"home\").map((each) => each.folder) }));",
    ].join("\n"));
    const env = { ...process.env };
    delete env.LIFESTREAM_TEST_DIST;
    const run = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: REPO, env, encoding: "utf8" });
    expect([run.status, run.status === 0 ? "" : run.stderr]).toEqual([0, ""]);
    const loaded = JSON.parse(run.stdout) as { sdk: string; refused: { name: string; faults: unknown[] }[]; home: string[] };
    expect({ ...loaded, refused: loaded.refused.map((each) => [each.name, each.faults]) }).toEqual({
      sdk: join(REPO, "packages", "connect", "sdk.ts"), home: ["good"],
      refused: [["unstrippable", [["import", "test/server.ts: TypeScript parameter property is not supported in strip-only mode"]]]],
    });
    expect(existsSync(join(machineDir, "generations"))).toBe(true);
  });

  it("lets a folder that loads in the home's own thread but not in its helpers give the helpers a registry without it, or the home run on", async () => {
    const { root } = scratch();
    const at = folder(root, "threadless");
    const index = join(at, "index.ts");
    writeFileSync(index, `import { isMainThread } from "node:worker_threads";\nif (!isMainThread) throw new Error("not in a thread");\n${readFileSync(index, "utf8")}`);
    let why: string | null = null;
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: homeRegistryModule(), log: () => undefined }).catch((error: Error) => { why = error.message; return null; });
    void home?.stopped.then((reason) => { why = reason; });
    try {
      await until("the home stopped by itself", () => why !== null);
      expect(why).toMatch(/connector folder threadless did not load in a thread: not in a thread/u);
    } finally {
      await home?.stop();
    }
  });

  it("lets a door that starts before its home serve a route of its registry before it holds the home's generation", async () => {
    const { root } = scratch();
    folder(root, "good");
    const { token } = mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], now_ms: Date.now() });
    const { url, logs } = await openDoor(root, { registry: homeRegistryModule(), generation: askGeneration });
    const products = async () => {
      const response = await fetch(`${url}/v1/products`, { headers: { authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json() as { code?: string; products?: Record<string, unknown> } };
    };
    const before = await products();
    expect([before.status, before.body.code]).toEqual([503, "NOT_NOW"]);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: homeRegistryModule(), log: () => undefined });
    try {
      await until("the door serving once the home is up", () => logs.some((line) => line.includes('"door":"serving"')));
      const after = await products();
      artifact(root, "door-products", { before: before.body, after: after.status, logs });
      expect([after.status, Object.hasOwn(after.body.products ?? {}, "example")]).toEqual([200, true]);
    } finally {
      await home.stop();
    }
  });

  it("lets a restarted home answer its own generation when a door in its process hears the stopped home's answer after the start, and lets the door's fill the folder once no home here runs it", async () => {
    const { root } = scratch();
    folder(root, "good");
    const options = { registry: homeRegistryModule(), log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS };
    let home = await startHome(root, options);
    const before = await askHome(testSocket(root), "generation", [], () => undefined, 30_000) as Generation;
    await home.stop();
    home = await startHome(root, options);
    try {
      handHeard({ ...before, root });
      const now = await askHome(testSocket(root), "generation", [], () => undefined, 30_000) as Generation;
      expect([now.start === before.start, handed(root)?.start === now.start]).toEqual([false, true]);
    } finally {
      await home.stop();
    }
    handHeard({ ...before, root });
    expect(handed(root)?.start).toBe(before.start);
  });
});

function verbs(root: string, restart: () => boolean = () => false): { ctx: FolderContext; lines: string[]; restarts: () => number } {
  const lines: string[] = [];
  let restarts = 0;
  const ctx: FolderContext = { root, cwd: root, out: (line) => lines.push(line), restart: () => { restarts++; return restart(); } };
  return { ctx, lines, restarts: () => restarts };
}

function outside(dir: string, under = ""): Record<string, string> {
  return Object.fromEntries(readdirSync(join(dir, under)).flatMap((name) => {
    const path = under === "" ? name : `${under}/${name}`;
    if (path === "connectors" || path === "artifacts" || name.startsWith("home.db-") || name.endsWith(".sock")) return [];
    return statSync(join(dir, path)).isDirectory() ? Object.entries(outside(dir, path)) : [[path, createHash("sha256").update(readFileSync(join(dir, path))).digest("hex")]];
  }));
}

function renameId(dir: string, from: string, to: string): void {
  const pascal = (text: string) => text.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
  const camel = (text: string) => pascal(text).replace(/^./u, (first) => first.toLowerCase());
  const words = (text: string) => text.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
  const walk = (at: string): string[] => readdirSync(at).flatMap((name) => (statSync(join(at, name)).isDirectory() ? walk(join(at, name)) : [join(at, name)]));
  for (const path of walk(dir)) {
    writeFileSync(path, readFileSync(path, "utf8").replaceAll(from, to).replaceAll(pascal(from), pascal(to)).replaceAll(camel(from), camel(to)).replaceAll(words(from), words(to)));
  }
  renameSync(join(dir, `${from}.md`), join(dir, `${to}.md`));
}

function pair(draft: string): void {
  const edit = (file: string, ...swaps: [string, string][]) => {
    let text = readFileSync(join(draft, file), "utf8");
    for (const [from, to] of swaps) {
      expect(text, `${file}: ${from}`).toContain(from);
      text = text.replace(from, to);
    }
    writeFileSync(join(draft, file), text);
  };
  edit("index.ts",
    ["[acmePairConnector];", "[acmePairConnector, { ...acmePairConnector, id: \"acme-pair-two\", product: \"acme-pair-two\", hidden: true, acquirers: [], sources: [{ id: \"acme-pair-two:<account>:export\", read: \"acme-pair-two\", arrives: \"upload\" }] }];"],
    ["[acmePair];", "[acmePair, { ...acmePair, name: \"acme-pair-two\" }];"],
    ["{ notes } };", "{ notes }, \"acme-pair-two\": { notes } };"]);
  edit(join("test", "fixture.ts"), ['{ "acme-pair": fixture };', '{ "acme-pair": fixture, "acme-pair-two": (folder) => ({ ...fixture(folder), source: `acme-pair-two:${ACCOUNT}:export` }) };']);
}

const installedFile = (root: string) => JSON.parse(readFileSync(join(root, "connectors", ".installed.json"), "utf8")) as Record<string, { from?: string; ids: string[] }>;
const listed = (root: string) => readdirSync(join(root, "connectors")).sort();

describe("the folder verbs", () => {
  it("lets a draft into a started home's generation, help list a release-only kind or a guide that is not there, or new with no kind list other kinds", async () => {
    const { root, machineDir } = scratch();
    const { ctx, lines } = verbs(root);
    const { folder } = await folderVerb(ctx, ["new", "export", "acme-notes"]) as { folder: string };
    expect(folder).toBe(join(root, "connectors", ".drafts", "acme-notes"));
    expect(lines).toEqual([`export acme-notes drafted at ${folder}, which no start loads. lifestream connectors test acme-notes checks it; lifestream connectors install acme-notes installs it`]);
    const generation = await loadGeneration({ root, machineDir });
    expect([generation.folders, generation.refused]).toEqual([[], []]);

    const help: string[] = [];
    expect(await runCli(["help", "connectors"], { write: (text) => help.push(text) })).toBe(0);
    const text = help.join("").split("\n");
    artifact(root, "help-connectors", text);
    expect(text[0]).toMatch(/^usage: lifestream connectors /u);
    const kinds = text.slice(text.indexOf("The kinds a home folder can be:") + 1, text.indexOf("", text.indexOf("The kinds a home folder can be:")));
    expect(kinds.map((line) => line.trim().split(/\s+/u)[0])).toEqual(["api", "browser", "export", "folder", "mac-app", "oauth"]);
    for (const line of kinds) expect(line.trim().split(/\s+/u).length, line).toBeGreaterThan(3);
    const guide = text.find((line) => line.startsWith("The guide: "))!.slice("The guide: ".length);
    expect([guide.endsWith(join("packages", "connect", "SKILL.md")), existsSync(guide)]).toEqual([true, true]);
    expect(text.some((line) => line.startsWith("preview reads an export at the path you name, "))).toBe(true);
    expect(text).toContain("An installed connector's fields are set in the Lifestream app's Streams, or by lifestream connectors set <id> <field> <value> [<field> <value>…]: fields that change together go in one set; each call polls at once.");
    expect(text).toContain("What Chat's model reads of it: lifestream agents call lists the tools and their arguments; lifestream agents call <tool> '<json arguments>' prints one's answer.");

    lines.length = 0;
    expect(await folderVerb(ctx, ["new"])).toEqual({ kinds: kinds.map((line) => line.trim().split(/\s+/u)[0]) });
    expect(lines.slice(1)).toEqual(kinds);
  });

  it("lets install replace by a declared id, leave a copy, touch a file outside connectors/, move a draft whose id changed, or install an installed folder anywhere but where it is", async () => {
    const { root } = scratch();
    const { ctx, lines, restarts } = verbs(root);
    await folderVerb(ctx, ["new", "export", "a-holder"]);
    const draft = join(root, "connectors", ".drafts", "a-holder");
    const target = join(root, "connectors", "a-holder");
    expect(await folderVerb(ctx, ["install", "a-holder"])).toEqual({ installed: target, connectors: ["a-holder"], runs: false });
    expect(lines.at(-1)).toBe(`installed a-holder at ${target}; start the home again to load it`);
    expect(installedFile(root)).toEqual({ "a-holder": { from: realpathSync(draft), ids: ["a-holder"] } });
    const kept = outside(root);

    writeFileSync(join(draft, "connector.ts"), readFileSync(join(draft, "connector.ts"), "utf8").replace("Every note in the download", "Every diary note in the download"));
    await folderVerb(ctx, ["install", "a-holder"]);
    expect(readFileSync(join(target, "connector.ts"), "utf8")).toContain("Every diary note in the download");
    expect(folderDigest(target)).toBe(folderDigest(draft));
    expect(listed(root)).toEqual([".drafts", ".installed.json", "a-holder"]);

    renameId(draft, "a-holder", "acme-notes");
    expect(await folderVerb(ctx, ["install", "a-holder"])).toEqual({ installed: target, connectors: ["acme-notes"], runs: false });
    expect(readFileSync(join(target, "connector.ts"), "utf8")).toContain('id: "acme-notes"');
    expect([listed(root), installedFile(root)]).toEqual([[".drafts", ".installed.json", "a-holder"], { "a-holder": { from: realpathSync(draft), ids: ["acme-notes"] } }]);

    writeFileSync(join(target, "notes.txt"), "kept\n");
    expect(await folderVerb(ctx, ["install", target])).toEqual(expect.objectContaining({ installed: target }));
    expect([readFileSync(join(target, "notes.txt"), "utf8"), listed(root), installedFile(root)]).toEqual(["kept\n", [".drafts", ".installed.json", "a-holder"], { "a-holder": { from: realpathSync(draft), ids: ["acme-notes"] } }]);
    expect(await folderVerb({ ...ctx, cwd: tmpdir() }, ["install", "acme-notes"])).toEqual(expect.objectContaining({ installed: target }));
    expect([existsSync(join(target, "notes.txt")), folderDigest(target), listed(root)]).toEqual([false, folderDigest(draft), [".drafts", ".installed.json", "a-holder"]]);
    expect(outside(root)).toEqual(kept);
    expect(restarts()).toBe(5);
  });

  it("lets a folder of two connectors replace more or less than its own folder", async () => {
    const { root } = scratch();
    const { ctx } = verbs(root);
    await folderVerb(ctx, ["new", "export", "acme-other"]);
    await folderVerb(ctx, ["install", "acme-other"]);
    const other = folderDigest(join(root, "connectors", "acme-other"));
    await folderVerb(ctx, ["new", "export", "acme-pair"]);
    const draft = join(root, "connectors", ".drafts", "acme-pair");
    pair(draft);
    expect(await folderVerb(ctx, ["install", "acme-pair"])).toEqual(expect.objectContaining({ installed: join(root, "connectors", "acme-pair"), connectors: ["acme-pair", "acme-pair-two"] }));
    writeFileSync(join(draft, "connector.ts"), readFileSync(join(draft, "connector.ts"), "utf8").replace("Every note in the download", "Every pair note in the download"));
    expect(await folderVerb(ctx, ["install", join(draft)])).toEqual(expect.objectContaining({ installed: join(root, "connectors", "acme-pair") }));
    expect([listed(root), folderDigest(join(root, "connectors", "acme-pair")), folderDigest(join(root, "connectors", "acme-other"))])
      .toEqual([[".drafts", ".installed.json", "acme-other", "acme-pair"], folderDigest(draft), other]);
    writeFileSync(join(draft, "connector.ts"), readFileSync(join(draft, "connector.ts"), "utf8").replace("Every pair note in the download", "Every second pair note in the download"));
    expect(await folderVerb({ ...ctx, cwd: tmpdir() }, ["test", "acme-pair-two"])).toEqual(expect.objectContaining({ folder: draft, passed: true }));
    expect(await folderVerb({ ...ctx, cwd: tmpdir() }, ["install", "acme-pair-two"])).toEqual(expect.objectContaining({ installed: join(root, "connectors", "acme-pair") }));
    expect(folderDigest(join(root, "connectors", "acme-pair"))).toBe(folderDigest(draft));
  });

  it("lets install move a connector set up in the home whose id its folder no longer declares, or refuse it after a file moved or without the way through", async () => {
    const { root } = scratch();
    const { ctx, restarts } = verbs(root);
    await folderVerb(ctx, ["new", "export", "acme-notes"]);
    const draft = join(root, "connectors", ".drafts", "acme-notes");
    await folderVerb(ctx, ["install", "acme-notes"]);
    const file = settingsPath(root);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")) as object, "connectors.acme-notes": { export_file: join(root, "exports", "notes.zip") } }));
    renameId(draft, "acme-notes", "acme-diary");
    const before = { listed: listed(root), digest: folderDigest(join(root, "connectors", "acme-notes")), installed: installedFile(root), settings: readFileSync(file, "utf8"), restarts: restarts() };
    const refused = await folderVerb(ctx, ["install", "acme-notes"]).then(() => null, (error: Error) => error.message);
    expect(refused).toBe("connectors/acme-notes declares acme-notes, set up in this home, and this folder declares acme-diary instead: a connector's id holds its settings, its sign-in and its poll memory, which stay under acme-notes. "
      + "Keep the id acme-notes, or run lifestream connectors remove acme-notes, then install this folder as a new connector and set it up again");
    expect({ listed: listed(root), digest: folderDigest(join(root, "connectors", "acme-notes")), installed: installedFile(root), settings: readFileSync(file, "utf8"), restarts: restarts() }).toEqual(before);
    await folderVerb(ctx, ["remove", "acme-notes"]);
    expect(await folderVerb(ctx, ["install", "acme-notes"])).toEqual(expect.objectContaining({ installed: join(root, "connectors", "acme-diary"), connectors: ["acme-diary"] }));
  });

  it("lets install move a connector set up in the home whose installed folder, edited where it is with no home running, no longer declares its id", async () => {
    const { root } = scratch();
    const { ctx, restarts } = verbs(root);
    await folderVerb(ctx, ["new", "export", "acme-notes"]);
    await folderVerb(ctx, ["install", "acme-notes"]);
    const file = settingsPath(root);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")) as object, "connectors.acme-notes": { export_file: join(root, "exports", "notes.zip") } }));
    const installed = join(root, "connectors", "acme-notes");
    renameId(installed, "acme-notes", "acme-diary");
    const before = { listed: listed(root), digest: folderDigest(installed), record: installedFile(root), settings: readFileSync(file, "utf8"), restarts: restarts() };
    const refused = await folderVerb(ctx, ["install", installed]).then(() => null, (error: Error) => error.message);
    expect(refused).toBe("connectors/acme-notes declares acme-notes, set up in this home, and this folder declares acme-diary instead: a connector's id holds its settings, its sign-in and its poll memory, which stay under acme-notes. "
      + "Keep the id acme-notes, or run lifestream connectors remove acme-notes, then install this folder as a new connector and set it up again");
    expect({ listed: listed(root), digest: folderDigest(installed), record: installedFile(root), settings: readFileSync(file, "utf8"), restarts: restarts() }).toEqual(before);
  });

  it("lets an installed folder named by its id run any of its code outside the guarded proof, or pass where its path is refused", async () => {
    const { root, machineDir } = scratch();
    const { ctx } = verbs(root);
    let reached = 0;
    const listener = createServer((socket) => { reached++; socket.destroy(); });
    await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
    const { port } = listener.address() as AddressInfo;
    try {
      await folderVerb(ctx, ["new", "export", "acme-net"]);
      await folderVerb(ctx, ["install", "acme-net"]);
      renameSync(join(root, "connectors", ".drafts", "acme-net"), join(machineDir, "acme-net"));
      const installed = join(root, "connectors", "acme-net");
      writeFileSync(join(installed, "index.ts"), `import { connect } from "node:net";\nconnect(${port}, "127.0.0.1").on("error", () => undefined);\n${readFileSync(join(installed, "index.ts"), "utf8")}`);
      const tested = (word: string) => folderVerb(ctx, ["test", word]).then(() => null, (error: { answer?: { folder: string; faults: string[] } }) => error.answer);
      const byId = await tested("acme-net");
      const byPath = await tested(installed);
      expect(byId).toEqual(byPath);
      expect(byId?.folder).toBe(installed);
      expect(byId?.faults).toContainEqual(`the folder: it connects to 127.0.0.1:${port} as it loads, refused: a folder reaches the world only through the \`fetch\` its acquirer is built with`);
      expect(reached).toBe(0);
    } finally {
      await new Promise<void>((done) => listener.close(() => done()));
    }
  });

  for (const holder of ["a-holder", "z-holder"]) {
    it(`lets an unrelated folder declaring a held id, or a moved draft, past install, or refused after a file moved or unnamed (holder ${holder})`, async () => {
      const { root, machineDir } = scratch();
      const { ctx, restarts } = verbs(root);
      await folderVerb(ctx, ["new", "export", holder]);
      const draft = join(root, "connectors", ".drafts", holder);
      await folderVerb(ctx, ["install", holder]);
      renameId(draft, holder, "acme-notes");
      await folderVerb(ctx, ["install", holder]);
      const before = { listed: listed(root), holder: folderDigest(join(root, "connectors", holder)), installed: installedFile(root), restarts: restarts() };
      const held = `connectors/${holder} holds acme-notes (installed from ${realpathSync(draft)}): install from there, edit connectors/${holder} and install that, or remove it first`;

      await folderVerb(ctx, ["new", "export", "acme-notes"]);
      const refused = await folderVerb(ctx, ["install", "acme-notes"]).then(() => null, (error: Error) => error.message);
      expect(refused?.split("\n")).toContain(held);
      const moved = join(machineDir, "moved");
      renameSync(draft, moved);
      const movedRefusal = await folderVerb(ctx, ["install", moved]).then(() => null, (error: Error) => error.message);
      expect(movedRefusal?.split("\n")).toContain(held);
      artifact(root, "refusals", { refused, movedRefusal });
      expect({ listed: listed(root), holder: folderDigest(join(root, "connectors", holder)), installed: installedFile(root), restarts: restarts() }).toEqual(before);
    });
  }

  it("lets a moved draft whose id names the folder take its place, a remove keep its line, delete, or say nothing of the records, or install from .removed nest a stamp", async () => {
    const { root, machineDir } = scratch();
    const { ctx, lines } = verbs(root);
    await folderVerb(ctx, ["new", "export", "acme-solo"]);
    const draft = join(root, "connectors", ".drafts", "acme-solo");
    await folderVerb(ctx, ["install", "acme-solo"]);
    const moved = join(machineDir, "acme-solo");
    cpSync(draft, moved, { recursive: true });
    const refused = await folderVerb(ctx, ["install", moved]).then(() => null, (error: Error) => error.message);
    expect(refused).toBe(`connectors/acme-solo holds acme-solo (installed from ${realpathSync(draft)}): install from there, edit connectors/acme-solo and install that, or remove it first`);

    await folderVerb(ctx, ["new", "export", "acme-draft"]);
    expect(await folderVerb(ctx, ["remove", "acme-draft"]).then(() => null, (error: Error) => error.message)).toBe("acme-draft is a draft, never installed: nothing to remove");

    const answer = await folderVerb(ctx, ["remove", "acme-solo"]) as { kept: string };
    expect(answer).toEqual({ removed: "acme-solo", kept: expect.stringMatching(/\/connectors\/\.removed\/acme-solo-\d{4}-/u), connectors: ["acme-solo"], runs: false });
    expect(lines.at(-1)).toBe(`removed acme-solo, kept at ${answer.kept}; start the home again to leave it out. Its records stay in Lifestream and leave your days and search once the rebuild ends. lifestream connectors install ${answer.kept} brings it back with them.`);
    expect([listed(root), installedFile(root), folderDigest(answer.kept)]).toEqual([[".drafts", ".installed.json", ".removed"], {}, folderDigest(draft)]);

    expect(await folderVerb(ctx, ["install", answer.kept])).toEqual(expect.objectContaining({ installed: join(root, "connectors", "acme-solo") }));
    expect([listed(root), installedFile(root)]).toEqual([[".drafts", ".installed.json", ".removed", "acme-solo"], { "acme-solo": { from: realpathSync(draft), ids: ["acme-solo"] } }]);
    writeFileSync(join(draft, "acme-solo.md"), `${readFileSync(join(draft, "acme-solo.md"), "utf8")}\nEdited in the draft.\n`);
    expect(await folderVerb(ctx, ["install", "acme-solo"])).toEqual(expect.objectContaining({ installed: join(root, "connectors", "acme-solo") }));
    expect([folderDigest(join(root, "connectors", "acme-solo")), installedFile(root)]).toEqual([folderDigest(draft), { "acme-solo": { from: realpathSync(draft), ids: ["acme-solo"] } }]);

    const solo = await folderVerb(ctx, ["remove", "acme-solo"]) as { kept: string };
    renameSync(draft, join(machineDir, "acme-solo-elsewhere"));
    await folderVerb(ctx, ["install", solo.kept]);
    expect(installedFile(root)).toEqual({ "acme-solo": { ids: ["acme-solo"] } });
    expect(lines.at(-1)).toBe(`installed acme-solo at ${join(root, "connectors", "acme-solo")}; start the home again to load it`);
  });

  it("lets a removed folder's landed sources stop the next release's start, turn off what the person had on, or install again turn on what the person turned off", async () => {
    const { root } = scratch();
    const { ctx, lines } = verbs(root);
    await folderVerb(ctx, ["new", "export", "acme-solo"]);
    await folderVerb(ctx, ["install", "acme-solo"]);
    const [landed, chosen] = ["acme-solo:person-a@example.com:export", "acme-solo:person-b@example.com:export"];
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      for (const id of [landed, chosen]) tx.tables.sources.add({ id, vendor: "example", connector: "acme-solo", added_ms: 0 });
    });
    const sources = db.commit((tx) => tx.tables.sources.list());
    db.close();
    const file = settingsPath(root);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")) as object, "sources.off": [chosen, "spotify"] }));
    const off = () => effective(root).settings.sources.off;

    const installed = readFileSync(join(root, "connectors", ".installed.json"), "utf8");
    writeFileSync(join(root, "connectors", ".installed.json"), "{ cut short");
    expect(await folderVerb(ctx, ["remove", "acme-solo"]).then(() => null, (error: Error) => error.message)).toMatch(/\.installed\.json is not JSON /u);
    expect([listed(root), off()]).toEqual([[".drafts", ".installed.json", "acme-solo"], [chosen, "spotify"]]);
    writeFileSync(join(root, "connectors", ".installed.json"), installed);

    const answer = await folderVerb(ctx, ["remove", "acme-solo"]) as { kept: string };
    expect(off()).toEqual([chosen, landed, "spotify"].sort());
    const now = switchOf(declarations(), off());
    expect(sources.filter((source) => !now.source(source)).map((source) => source.id)).toEqual([]);
    expect(lines.at(-1)).toMatch(/^removed acme-solo, kept at /u);

    await folderVerb(ctx, ["install", answer.kept]);
    expect(off()).toEqual([chosen, "spotify"]);
    await folderVerb(ctx, ["remove", "acme-solo"]);
    await folderVerb(ctx, ["install", "acme-solo"]);
    expect(off()).toEqual([chosen, "spotify"]);
  });

  it("lets remove miss a landed source whose reader is named unlike its connector, or record it under the reader's name", async () => {
    const { root } = scratch();
    const { ctx } = verbs(root);
    await folderVerb(ctx, ["new", "export", "acme-solo"]);
    const draft = join(root, "connectors", ".drafts", "acme-solo");
    for (const [path, from, to] of [["reader.ts", 'name: "acme-solo"', 'name: "acme-reader"'], ["connector.ts", 'read: "acme-solo"', 'read: "acme-reader"'], [join("test", "fixture.ts"), '{ "acme-solo": fixture }', '{ "acme-reader": fixture }']] as const) {
      const text = readFileSync(join(draft, path), "utf8");
      expect(text, `${path}: ${from}`).toContain(from);
      writeFileSync(join(draft, path), text.replace(from, to));
    }
    await folderVerb(ctx, ["install", "acme-solo"]);
    const landed = "acme-solo:person-a@example.com:export";
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.sources.add({ id: landed, vendor: "example", connector: "acme-reader", added_ms: 0 }));
    const sources = db.commit((tx) => tx.tables.sources.list());
    db.close();
    const off = () => effective(root).settings.sources.off;

    await folderVerb(ctx, ["remove", "acme-solo"]);
    expect(off()).toEqual([landed]);
    expect(sources.filter((source) => !switchOf(declarations(), off()).source(source)).map((source) => source.id)).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "connectors", ".removed", "sources-off.json"), "utf8"))).toEqual({ "acme-solo": [landed] });
    await folderVerb(ctx, ["install", "acme-solo"]);
    expect(off()).toEqual([]);
  });

  it("lets remove or install touch the sites the person turned on in Chrome", async () => {
    const { root } = scratch();
    const { ctx } = verbs(root);
    await folderVerb(ctx, ["new", "browser", "acme-shop"]);
    await folderVerb(ctx, ["install", "acme-shop"]);
    const file = settingsPath(root);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")) as object, "sites.chosen": ["acme-shop", "chatgpt"] }));
    const chosen = () => effective(root).settings.sites.chosen;

    const answer = await folderVerb(ctx, ["remove", "acme-shop"]) as { kept: string };
    expect(chosen()).toEqual(["acme-shop", "chatgpt"]);
    await folderVerb(ctx, ["install", answer.kept]);
    expect([chosen(), readdirSync(join(root, "connectors", ".removed")).filter((name) => name.endsWith(".json"))]).toEqual([["acme-shop", "chatgpt"], []]);
  });

  it("lets install whose restart throws say nothing of the folder in place or what to run", async () => {
    const { root } = scratch();
    const { ctx, lines } = verbs(root, () => {
      throw new Error("launchctl print failed: Bad request.");
    });
    await folderVerb(ctx, ["new", "export", "acme-notes"]);
    const target = join(root, "connectors", "acme-notes");
    expect(await folderVerb(ctx, ["install", "acme-notes"])).toEqual({ installed: target, connectors: ["acme-notes"], runs: false });
    expect(lines.at(-1)).toBe(`installed acme-notes at ${target}; the home did not restart (launchctl print failed: Bad request.): launchctl kickstart -k gui/${process.getuid?.() ?? 0}/org.lifestreamprotocol.home starts it with the folder`);
    expect(existsSync(join(target, "index.ts"))).toBe(true);
  });

  it("lets preview read an export's path typed as ~/… from the directory it was typed in", async () => {
    const { root } = scratch();
    const { ctx, lines } = verbs(root);
    await folderVerb(ctx, ["new", "export", "acme-notes"]);
    const refused = await folderVerb(ctx, ["preview", "acme-notes", "~/lifestream-no-such-export.zip"]).then(() => null, (error: Error) => error.message);
    const said = [...lines, refused].join("\n");
    expect(said).toContain(join(homedir(), "lifestream-no-such-export.zip"));
    expect(said).not.toContain(join(root, "~"));
  });

  it("lets a folder verb at the CLI print its lines and its answer too, print a line under --json, or a failure's answer nowhere", async () => {
    const { root } = scratch();
    const { ctx } = verbs(root);
    await folderVerb(ctx, ["new", "export", "acme-notes"]);
    const run = async (...args: string[]) => {
      const out: string[] = [];
      const status = await runCli(["connectors", ...args, "--root", root], { write: (text) => out.push(text) });
      return { status, lines: out.join("").trimEnd().split("\n") };
    };
    const said = await run("test", "acme-notes");
    expect([said.status, said.lines.at(-1), said.lines.some((line) => line.startsWith("{"))]).toEqual([0, "acme-notes passes the conformance run", false]);
    const json = await run("test", "acme-notes", "--json");
    expect([json.status, json.lines.length]).toEqual([0, 1]);
    expect(JSON.parse(json.lines[0]!)).toEqual(expect.objectContaining({ folder: join(root, "connectors", ".drafts", "acme-notes"), passed: true, ids: ["acme-notes"] }));
    const draft = join(root, "connectors", ".drafts", "acme-notes");
    writeFileSync(join(draft, "connector.ts"), readFileSync(join(draft, "connector.ts"), "utf8").replace('type: "notes"', 'type: "nothing-of-the-sort"'));
    const failed = await run("test", "acme-notes");
    expect([failed.status, failed.lines.at(-1), failed.lines.some((line) => line.startsWith("{"))]).toEqual([1, expect.stringMatching(/^acme-notes fails the conformance run: \d+ faults?$/u), false]);
    const failedJson = await run("test", "acme-notes", "--json");
    expect([failedJson.status, failedJson.lines.length]).toEqual([1, 1]);
    expect(JSON.parse(failedJson.lines[0]!)).toEqual(expect.objectContaining({ passed: false, faults: failed.lines.slice(0, -1) }));
  });

  it("lets install or remove answer before the door serves a generation of the restarted home's own start holding the change, or raise a restart need for the change it loads", async () => {
    const { root } = scratch();
    const options = { registry: homeRegistryModule(), log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS };
    const door = await doorHere(root, { registry: homeRegistryModule() });
    onTestFinished(() => door.stop());
    let home = await startHome(root, options);
    let cycled: Promise<void> = Promise.resolve();
    const window: Raised[][] = [];
    const { ctx, lines } = verbs(root, () => {
      window.push(folderFindings(root).needs.filter((need) => need.id.startsWith("folder:")));
      cycled = (async () => {
        await home.stop();
        home = await startHome(root, options);
      })();
      return true;
    });
    const served = async () => [((await askHome(testSocket(root), "status", ["--json"])) as StatusReport).generation, (await askHome(testSocket(root), "generation") as Generation).start];
    try {
      const first = await askHome(testSocket(root), "generation") as Generation;
      await folderVerb(ctx, ["new", "export", "acme-notes"]);
      const target = join(root, "connectors", "acme-notes");
      expect(await folderVerb(ctx, ["install", "acme-notes"])).toEqual({ installed: target, connectors: ["acme-notes"], runs: true });
      const now = await askHome(testSocket(root), "generation") as Generation;
      expect([now.start === first.start, now.folders.map((each) => [each.name, each.digest, each.ids])]).toEqual([false, [["acme-notes", folderDigest(target), ["acme-notes"]]]]);
      expect(lines.slice(-2)).toEqual([`installed acme-notes at ${target}; the home is restarting to load it`, "installed acme-notes; the home runs it"]);
      expect(await served()).toEqual([now.start, now.start]);

      await cycled;
      expect(await folderVerb(ctx, ["install", "acme-notes"])).toEqual({ installed: target, connectors: ["acme-notes"], runs: true });
      const again = await askHome(testSocket(root), "generation") as Generation;
      expect([again.start === now.start, again.folders.map((each) => each.digest), lines.slice(-2)]).toEqual([false, [folderDigest(target)], [
        `installed acme-notes at ${target}; the home is restarting to load it`,
        "installed acme-notes; the home runs it",
      ]]);
      expect(await served()).toEqual([again.start, again.start]);

      await cycled;
      const removed = await folderVerb(ctx, ["remove", "acme-notes"]) as { kept: string };
      const after = await askHome(testSocket(root), "generation") as Generation;
      expect([after.start === again.start, after.folders]).toEqual([false, []]);
      expect(lines.at(-1)).toMatch(new RegExp(`^removed acme-notes; the home runs without it\\. Its records stay in Lifestream .* lifestream connectors install ${removed.kept.replaceAll(".", "\\.")} brings it back with them\\.$`, "u"));
      expect(await served()).toEqual([after.start, after.start]);
      expect(window).toEqual([[], [], []]);
      artifact(root, "restarts", lines);

      await cycled;
      cpSync(removed.kept, target, { recursive: true });
      expect(folderFindings(root).needs.map((need) => [need.id, need.words])).toEqual([["folder:acme-notes", "acme-notes changed"]]);
    } finally {
      await cycled;
      await home.stop();
    }
  });

  it("lets an install or a remove that could not restart the home leave the need to restart it unsaid", async () => {
    const { root, machineDir } = scratch();
    hand(await loadGeneration({ root, machineDir }));
    const { ctx } = verbs(root);
    await folderVerb(ctx, ["new", "export", "acme-notes"]);
    expect(await folderVerb(ctx, ["install", "acme-notes"])).toMatchObject({ runs: false });
    expect(folderFindings(root).needs.map((need) => need.words)).toEqual(["acme-notes changed"]);
    hand(await loadGeneration({ root, machineDir }));
    expect(await folderVerb(ctx, ["remove", "acme-notes"])).toMatchObject({ runs: false });
    expect(folderFindings(root).needs.map((need) => need.words)).toEqual(["acme-notes changed"]);
  });

  it("lets a verb meeting a start under way give up, or meeting NOT_NOW word it itself, say it twice or not ask again", async () => {
    const { root } = scratch();
    const lock = tryLock(join(root, "home.lock"))!;
    const out: string[] = [];
    const going: string[] = [];
    const ran = runCli(["connectors", "--root", root], { write: (text) => out.push(text), going: (text) => going.push(text) });
    let server: { close(): Promise<void> } | null = null;
    try {
      await until("the starting line", () => going.join("").includes("the home is starting; waiting"));
      let asks = 0;
      server = await serveSocket(testSocket(root).path, async () => {
        asks++;
        if (asks === 1) throw new Refusal(503, NOT_NOW, "The home is held: a check found damage.", 1);
        return { answered: true };
      });
      expect(await ran).toBe(0);
      expect([going.join(""), out.join("")]).toEqual(["the home is starting; waiting\n[NOT_NOW] The home is held: a check found damage. (asking again)\n", "{\"answered\":true}\n"]);
      expect(asks).toBe(2);
    } finally {
      await ran;
      await server?.close();
      lock.release();
    }
  });
});
