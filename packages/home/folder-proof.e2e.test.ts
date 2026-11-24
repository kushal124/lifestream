import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DayDocument } from "@lifestreamprotocol/families";
import { literal, runFolder, typeCheck, typesOf } from "./conformance.js";
import { READS_AGAIN_RULE, SPOILED_RULES, TIMED_RULE } from "./fixture-proof.js";
import { dayPath } from "./derive.js";
import { startHome, type Home } from "./home.js";
import { homeRegistryModule, sdkModule } from "./programs.js";
import { checkTypes, emitTypes } from "./release.js";
import { makeRoot, readHome, removeRoot, until } from "./test/harness-root.js";
import { shipFiles } from "./test/harness-deliveries.js";
import { REPO } from "./test/support.js";
import type { Connector } from "@lifestreamprotocol/connect";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { keyedFolder } from "@lifestreamprotocol/core/test/keyed";
import { blocksOf, previewFolder, SECRET_WORDS, type AskedSecret } from "./folder-preview.js";
import { machine } from "./machine.js";
import { trial } from "./folders.js";
import { effectiveOf } from "./settings.js";
import { conformanceOf, folderVerb, RELEASE_DAYS } from "./verbs/connectors-folder.js";

const TEMPLATES = join(REPO, "packages", "connect", "templates");

const PROOF = join(import.meta.dirname, "test", "proof");
const made: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function folderOf(files: Record<string, string>): string {
  const dir = scratch("lifestream-folder-types-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("a home folder's types, against the release's declarations", () => {
  let release: string;
  beforeAll(() => {
    release = scratch("lifestream-release-types-");
    symlinkSync(join(REPO, "packages"), join(release, "packages"));
    symlinkSync(join(REPO, "node_modules"), join(release, "node_modules"));
    emitTypes(REPO, join(release, "dist", "types"));
  });

  it("a folder importing node:fs or a core type the SDK re-exports faults, or reads core anywhere but dist/types/core", async () => {
    const folder = folderOf({
      "index.ts": [
        'import { readFileSync } from "node:fs";',
        'import type { Line } from "@lifestreamprotocol/connect/sdk";',
        "",
        'export const line = (path: string): Line => ({ text: readFileSync(path, "utf8").trim() });',
        "",
      ].join("\n"),
    });
    const checked = await typeCheck(folder, typesOf(release, true));
    expect(checked.faults).toEqual([]);
    const core = checked.files.filter((file) => file.includes("/core/")).map((file) => relative(release, file));
    expect(core.length).toBeGreaterThan(0);
    expect(core.filter((file) => !file.startsWith("dist/types/core/") || !file.endsWith(".d.ts"))).toEqual([]);
  });

  it("a folder importing @lifestreamprotocol/core is refused by the typecheck and by the loader, in words that state the one door", async () => {
    const folder = folderOf({ "index.ts": 'import { versionId } from "@lifestreamprotocol/core";\n\nexport const id = versionId;\n' });
    const rule = "@lifestreamprotocol/core: a home folder imports Lifestream through @lifestreamprotocol/connect/sdk alone";
    expect((await typeCheck(folder, typesOf(release, true))).faults).toContain(`index.ts:1:27 imports ${rule}`);
    expect((await typeCheck(folder, typesOf(REPO, false))).faults).toContain(`index.ts:1:27 imports ${rule}`);
    expect((await trial({ name: "core-reach", entry: join(folder, "index.ts"), store: folder, sdk: sdkModule(), lifestream: [] })).faults).toEqual([["import", rule]]);
  });

  it("the SDK's declarations reach core by their own paths, never by a specifier a folder could name", () => {
    const held = readdirSync(join(release, "dist", "types"), { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".d.ts"))
      .filter((file) => readFileSync(join(release, "dist", "types", file), "utf8").includes('"@lifestreamprotocol/core"'));
    expect(held).toEqual([]);
    expect(typesOf(release, true).paths).toEqual({ "@lifestreamprotocol/connect/sdk": [join(release, "dist", "types", "connect", "sdk.d.ts")] });
  });

  it("a type fault is said without its folder's path, line and column, or a fault inside the SDK's declarations is said", async () => {
    const broken = scratch("lifestream-release-broken-");
    for (const name of ["packages", "node_modules"]) symlinkSync(join(REPO, name), join(broken, name));
    cpSync(join(release, "dist"), join(broken, "dist"), { recursive: true });
    appendFileSync(join(broken, "dist", "types", "connect", "sdk.d.ts"), "\nexport declare const broken: ;\n");
    const folder = folderOf({
      "reader.ts": 'import type { Line } from "@lifestreamprotocol/connect/sdk";\n\nexport const line: Line = { text: 1 };\n',
      "test/fixture.ts": "export const count: number = \"two\";\n",
    });
    expect((await typeCheck(folder, typesOf(broken, true))).faults).toEqual([
      "reader.ts:3:29 Type 'number' is not assignable to type 'string'.",
      "test/fixture.ts:1:14 Type 'string' is not assignable to type 'number'.",
    ]);
  });

  it("syntax Node's type stripping refuses is said with what to write instead", async () => {
    const folder = folderOf({ "test/fixture.ts": "export class Site {\n  constructor(private readonly page: string) {}\n}\n" });
    expect((await typeCheck(folder, typesOf(release, true))).faults).toContainEqual(expect.stringMatching(
      /^test\/fixture\.ts:2:15 This syntax is not allowed when 'erasableSyntaxOnly' is enabled\. \(a home runs a folder's TypeScript with its types erased, compiling nothing: a constructor parameter property is a field declared in the class and set in the constructor, /u));
  });

  it("a template's program holds a .ts file of the release, or one that does passes the release build", () => {
    expect(() => checkTypes(release)).not.toThrow();
    const reaching = folderOf({ "index.ts": `import type { Json } from ${JSON.stringify(join(REPO, "packages", "core", "types.ts"))};\n\nexport const value: Json = 1;\n` });
    expect(() => checkTypes(release, [reaching])).toThrow(/a home folder's program holds the release's source, not its declarations \(dist\/types\): lifestream-folder-types-\w+ compiles .*packages\/core\/types\.ts/u);
  });
});

describe("the families over the release's folders and this one", () => {
  const chat = (...edits: [file: string, from: string | RegExp, to: string][]) => {
    const folder = join(scratch("lifestream-folder-chat-"), "example-chat");
    cpSync(join(PROOF, "example-chat"), folder, { recursive: true });
    for (const [file, from, to] of edits) {
      const text = readFileSync(join(folder, file), "utf8");
      expect(text, `${file}: ${String(from)}`).toMatch(from);
      writeFileSync(join(folder, file), text.replace(from, to));
    }
    return folder;
  };

  it("a home messages folder declaring processing.photos is refused, or one declaring none passes", async () => {
    expect((await conformanceOf(chat())).faults).toEqual([]);
    expect((await conformanceOf(chat(["connector.ts", /^ {2}processing: .*\n/mu, ""]))).faults).toEqual([
      "example-chat.processing.photos: the messages family asks it of its sources: declare it",
      "example-chat.processing.voice: the messages family asks it of its sources: declare it",
    ]);
  });

  it("an offered connector whose only road is upload, with no export of its own and none under a kind's root, fails", async () => {
    const folder = chat(["connector.ts", /^ {2}export: \{\n[\s\S]*?^ {2}\},\n/mu, ""]);
    expect((await conformanceOf(folder)).faults).toContain(
      "example-chat.export: a file handed over would reach no source: declare `export: { recognise, guide }` (templates/export)",
    );
  });

  it("an icon fault names no candidate by its key and Phosphor name", async () => {
    const folder = join(scratch("lifestream-folder-icon-"), "example-log");
    cpSync(join(PROOF, "example-log"), folder, { recursive: true });
    const path = join(folder, "connector.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace('icon: "recording"', 'icon: "runing"'));
    expect((await conformanceOf(folder)).faults).toEqual([expect.stringMatching(/^connectors\[0\]\.icon: runing is none of the release's icons: did you mean `run` \(person-simple-run\)/u)]);
  });
});

describe("the whole run of test, in one guarded and timed child", () => {
  const template = (kind: string, ...edits: [file: string, from: string, to: string][]) => {
    const folder = join(scratch(`lifestream-folder-child-${kind}-`), kind);
    cpSync(join(TEMPLATES, kind), folder, { recursive: true });
    for (const [file, from, to] of edits) {
      const text = readFileSync(join(folder, file), "utf8");
      expect(text, `${file}: ${from}`).toContain(from);
      writeFileSync(join(folder, file), text.replace(from, to));
    }
    return folder;
  };
  const settings = effectiveOf({ "day.zone": "UTC", unit: "macbook-pro-0001" }, "the conformance run").settings;

  it("a fixture module that connects as it loads is refused and named, nothing after it run", async () => {
    const folder = template("api", ["test/fixture.ts", 'import { join } from "node:path";\n', 'import { join } from "node:path";\nimport { connect } from "node:net";\n\nconnect(443, "api.example.com").on("error", () => undefined);\n']);
    const run = await runFolder({ folder, settings });
    expect(run.faults).toEqual(["the folder: it connects to api.example.com:443 as it loads, refused: a folder reaches the world only through the `fetch` its acquirer is built with"]);
    expect(run.lines).toEqual([]);
  });

  it("a reader that reads its own delivery's records from view reads other rows when read again with them landed, and faults", async () => {
    const folder = template("export", ["reader.ts", "  async *read(delivery, files) {\n", "  async *read(delivery, files, view) {\n    if (view !== undefined && [...view.heads(delivery.source, NOTE)].length > 0) yield { kind: NOTE, key: \"note-again\", content: { type: \"example.note\", id: \"note-again\", created_at: \"2026-09-28T10:00:00Z\" } };\n"]);
    const run = await runFolder({ folder, settings });
    expect(run.faults).toContainEqual(expect.stringMatching(new RegExp(`^fixtures\\.example-export: read again with its own records landed, its row 1 is note note-again where it read note \\S+, (\\d+) rows where it read \\d+: ${literal(READS_AGAIN_RULE)}$`, "u")));
    expect((await runFolder({ folder: template("export"), settings })).faults).toEqual([]);
  });

  it("a fixture whose spoiled file costs a head its `files` entry does not state faults, naming the head and the rule", async () => {
    const folder = template("export", ["test/fixture.ts", '"example-export/notes.json": { alone: ["note note-001", "note note-002"] }', '"example-export/notes.json": { alone: ["note note-001"] }']);
    const run = await runFolder({ folder, settings });
    expect(run.faults).toEqual(["half", "no file"].map((spoil) => `fixtures.example-export: example-export/notes.json ${spoil}: landed 1 of 2 expected: lost note note-002, landed besides none: ${SPOILED_RULES.costs}`));
  });

  it("a reader that times an item by its delivery's arrival faults, naming the item and the rule", async () => {
    const folder = template("export", ["reader.ts", "time: instantOf(String(item.created_at), \"rfc3339\", `note ${item.id} created_at`)", "time: instantOf(new Date(delivery.stated_ms).toISOString(), \"rfc3339\", `note ${item.id} created_at`)"]);
    const run = await runFolder({ folder, settings });
    expect(run.faults).toEqual([`fixtures.example-export: note note-003 starts at its delivery's statement time: ${TIMED_RULE}`]);
  });

  it("a reader that never returns is killed at its time and named, the acquirers after it not run", async () => {
    const folder = template("api", ["reader.ts", "  async *read(delivery, files) {\n", "  async *read(delivery, files) {\n    for (;;);\n"]);
    const run = await runFolder({ folder, settings, limits: { case_ms: 1_000, run_ms: 120_000 } });
    expect(run.faults).toEqual([expect.stringMatching(/^the fixtures: did not end in 1 s and was killed: a fixture, a reader or an adapter never returned: /u)]);
    expect(run.lines).toEqual(["example-api: not run (the run ended at the fixtures)"]);
    expect([run.ids, run.polls]).toEqual([[], false]);
  });

  it("a record its family keeps silent by contract is said as read as nothing, or one its adapter reads as nothing is not", async () => {
    const marked = await runFolder({ folder: template("export", ["adapter.ts", "trashed: false, marked: false", 'trashed: false, marked: content.title === "Synthetic note 3"']), settings });
    expect(marked.faults).toEqual([]);
    expect(marked.lines).toContainEqual("search note note-003: (no words)");
    const rejected = await runFolder({ folder: template("export", ["adapter.ts", 'typeof content.title !== "string") return null;', 'typeof content.title !== "string" || content.title === "Synthetic note 3") return null;']), settings });
    expect(rejected.faults).toContainEqual("adapters.example-export.notes: reads 1 note record as nothing (note-003): no day prints it and no search finds it (one its adapter leaves out on purpose, test/fixture.ts names in `export const skipped = [\"<kind> <key>\"]`)");
  });

  it("a record test/fixture.ts names skipped is held to being read as nothing wherever the run lands it, and one no landing holds is a fault", async () => {
    const rejects: [string, string, string] = ["adapter.ts", 'typeof content.title !== "string") return null;', 'typeof content.title !== "string" || content.title === "Synthetic note 3") return null;'];
    const skip = (heads: string): [string, string, string] => ["test/fixture.ts", "\nexport const files =", `\nexport const skipped = ${heads};\n\nexport const files =`];
    const skipped = await runFolder({ folder: template("export", rejects, skip('["note note-003"]')), settings });
    expect(skipped.faults).toEqual([]);
    expect(skipped.lines).toContainEqual("search note note-003: (read as nothing, as test/fixture.ts's skipped says)");
    const read = await runFolder({ folder: template("export", skip('["note note-003"]')), settings });
    expect(read.faults).toEqual([
      "test/fixture.ts: its skipped names note note-003, and its adapter reads it: a day prints it",
      "acquirers.example-export: reaches the day: test/fixture.ts: its skipped names note note-003, and its adapter reads it: a day prints it",
    ]);
    const unheld = await runFolder({ folder: template("export", rejects, skip('["note note-003", "note note-999", "note-004"]')), settings });
    expect(unheld.faults).toEqual([
      "test/fixture.ts: its skipped holds \"note-004\", no head: each is `<kind> <key>`, as `test`'s search lines name a record",
      "test/fixture.ts: its skipped names note note-999, which nothing the run landed holds",
    ]);
  });

  it("skipped never names a whole kind: every note the run landed skipped, none reaching its family, is a fault", async () => {
    const all = JSON.stringify(Array.from({ length: 24 }, (_, n) => `note note-${String(n + 1).padStart(3, "0")}`));
    const run = await runFolder({
      folder: template("export",
        ["adapter.ts", 'typeof content.title !== "string") return null;', 'typeof content.title !== "string" || content.title.startsWith("Synthetic")) return null;'],
        ["test/fixture.ts", "\nexport const files =", `\nexport const skipped = ${all};\n\nexport const files =`]),
      settings,
    });
    expect(run.faults).toEqual([
      "test/fixture.ts: its skipped names every note record of example-export the run landed (note-001, note-002, note-003, …), so none reached its family: skipped names the records an adapter leaves out on purpose, never a whole kind; land a note record its adapter reads, in a fixture or a fake",
    ]);
  });

  it("skipped never names a whole kind of one connector: a second connector's every note skipped faults, though the first reads its own", async () => {
    const all = JSON.stringify(Array.from({ length: 24 }, (_, n) => `note b-note-${String(n + 1).padStart(3, "0")}`));
    const run = await runFolder({
      folder: template("export",
        ["reader.ts", "kind: NOTE, key: item.id,", 'kind: NOTE, key: delivery.source.startsWith("example-b:") ? `b-${item.id}` : item.id,'],
        ["reader.ts", "\n};\n", '\n};\n\nexport const exampleB: Reader = { ...exampleExport, name: "example-b" };\n'],
        ["connector.ts", "} satisfies Connector;", '} satisfies Connector;\n\nexport const exampleB = { ...exampleExport, id: "example-b", product: "example-b", sources: [{ id: "example-b:<account>:export", read: "example-b", arrives: "upload" }] } satisfies Connector;'],
        ["index.ts", 'import { exampleExport as exampleExportConnector } from "./connector.js";', 'import { exampleB, exampleExport as exampleExportConnector } from "./connector.js";'],
        ["index.ts", 'import { exampleExport } from "./reader.js";', 'import { exampleB as exampleBReader, exampleExport } from "./reader.js";'],
        ["index.ts", "[exampleExportConnector];", "[exampleExportConnector, exampleB];"],
        ["index.ts", "[exampleExport];", "[exampleExport, exampleBReader];"],
        ["index.ts", '{ "example-export": { notes } }', '{ "example-export": { notes }, "example-b": { notes: { ...notes, note: () => null } } }'],
        ["test/fixture.ts", "\nexport const files =", `\nexport const skipped = ${all};\n\nexport const files =`],
        ["test/fixture.ts", "/^note-(\\d+)$/u", "/^(?:b-)?note-(\\d+)$/u"],
        ["test/fixture.ts", '{ "example-export": fixture }', '{ "example-export": fixture, "example-b": (folder) => ({ ...fixture(folder), source: "example-b:person-a@example.com:export", files: { "example-export/account.json": "trust", "example-export/notes.json": { alone: ["note b-note-001", "note b-note-002"] }, "example-export/notes-2.json": { alone: ["note b-note-003"] } } }) }']),
      settings,
    });
    expect(run.faults).toEqual([
      "test/fixture.ts: its skipped names every note record of example-b the run landed (b-note-001, b-note-002, b-note-003, …), so none reached its family: skipped names the records an adapter leaves out on purpose, never a whole kind; land a note record its adapter reads, in a fixture or a fake",
    ]);
  });

  it("a web stream that counts its records says, of a record it skips, that the stream counts it too, and one counted by the web family does not", async () => {
    const visits = ["reader.ts", 'export const NOTE = "note";', 'export const NOTE = "page-visit";'] as [string, string, string];
    const web = ["index.ts", '{ "example-export": { notes } }', '{ "example-export": { web: { version: "1", kinds: ["page-visit"], item: (record) => { const content = record.version.content as { id: string; title: string }; return content.id === "note-003" ? null : { what: "visit", url: `https://example.com/${content.id}`, title: content.title }; } } } }'] as [string, string, string];
    const skip = ["test/fixture.ts", "\nexport const files =", '\nexport const skipped = ["page-visit note-003"];\n\nexport const files ='] as [string, string, string];
    const heads = [["test/fixture.ts", '["note note-001", "note note-002"]', '["page-visit note-001", "page-visit note-002"]'], ["test/fixture.ts", '["note note-003"]', '["page-visit note-003"]']] as [string, string, string][];
    const counted = await runFolder({ folder: template("export", visits, web, skip, ...heads), settings });
    expect(counted.faults).toEqual([]);
    expect(counted.lines).toContainEqual("search page-visit note-003: (read as nothing, as test/fixture.ts's skipped says; its stream counts these too: see `counted_by`)");
    const byWeb = await runFolder({ folder: template("export", visits, web, skip, ...heads, ["connector.ts", 'noun: ["note", "notes"],', 'noun: ["note", "notes"], counted_by: "web",']), settings });
    expect(byWeb.faults).toEqual([]);
    expect(byWeb.lines).toContainEqual("search page-visit note-003: (read as nothing, as test/fixture.ts's skipped says)");
  });

  it("a record whose family gives search no text of its own prints the words of its day lines, which search finds it by", async () => {
    const folder = template("export",
      ["reader.ts", "import { archive, consuming, each, instantOf,", "import { archive, consuming, each, instantOf, spanOf,"],
      ["reader.ts", 'export const NOTE = "note";', 'export const NOTE = "workout";'],
      ["reader.ts", "time: instantOf(String(item.created_at), \"rfc3339\", `note ${item.id} created_at`),", "time: spanOf(instantOf(String(item.created_at), \"rfc3339\", `note ${item.id} created_at`), instantOf(new Date(Date.parse(String(item.created_at)) + 1_800_000).toISOString(), \"rfc3339\", `note ${item.id} end`), `note ${item.id}`),"],
      ["adapter.ts", "import { isObject, type InputRecord, type Note, type NotesAdapter } from \"@lifestreamprotocol/connect/sdk\";", "import { isObject, type HealthAdapter, type HealthItem, type InputRecord, type Note, type NotesAdapter } from \"@lifestreamprotocol/connect/sdk\";"],
      ["adapter.ts", "export const notes: NotesAdapter = { version: \"1\", kinds: [NOTE], note };", "export const notes: NotesAdapter = { version: \"1\", kinds: [NOTE], note };\n\nexport const health: HealthAdapter = {\n  version: \"1\", kinds: [NOTE],\n  item: (record: InputRecord): HealthItem | null => (note(record) === null ? null : { item: \"instrument-workout\", instrument: \"Example\", activity: note(record)!.title, duration_s: 1_800, distance: \"5000 m\", strain: null }),\n};"],
      ["index.ts", "import { notes } from \"./adapter.js\";", "import { health } from \"./adapter.js\";"],
      ["index.ts", "{ \"example-export\": { notes } }", "{ \"example-export\": { health } }"],
      ["test/fixture.ts", '["note note-001", "note note-002"]', '["workout note-001", "workout note-002"]'],
      ["test/fixture.ts", '["note note-003"]', '["workout note-003"]']);
    const run = await runFolder({ folder, settings });
    expect(run.faults).toEqual([]);
    const searched = run.lines.filter((line) => line.startsWith("search workout note-001: "));
    expect(searched.length).toBeGreaterThan(0);
    for (const line of searched) expect(line).toMatch(/^search workout note-001: .*Synthetic note 1\b.* \(its day line's words\)$/u);
    expect(run.lines.filter((line) => line.endsWith("(no words)"))).toEqual([]);
  });

  it("a folder that passes says its ids and that it polls, its acquirers' cases run", async () => {
    const run = await runFolder({ folder: template("api"), settings });
    expect(run.faults).toEqual([]);
    expect([run.ids, run.polls]).toEqual([["example-api"], true]);
    expect(run.lines).toContainEqual(expect.stringMatching(/^example-api reaches the day: run, /u));
  });
});

describe("the day file's own lines, in the home's day zone and start", () => {
  const SOURCE = "example-log:local:macbook-pro-0001";
  let root: string;
  let home: Home | undefined;

  beforeAll(async () => {
    root = makeRoot("lifestream-folder-days-", {
      sources: {},
      settings: { "day.zone": "America/Los_Angeles", "day.day_start_hour": 4, "connectors.example-log": { file: "/Users/person-a/Library/Logs/example-log.ndjson" } },
    });
    cpSync(join(PROOF, "example-log"), join(root, "connectors", "example-log"), { recursive: true });
    home = await startHome(root, { registry: homeRegistryModule(), tickMs: 10, lookMs: 10, stopGraceMs: 50, log: () => undefined });
    const { fixture } = await import("./test/proof/example-log/test/fixture.js") as { fixture: (folder: string) => { facts: Record<string, unknown> } };
    const delivery = scratch("lifestream-folder-days-delivery-");
    const { facts } = fixture(delivery);
    await shipFiles(root, SOURCE, Date.UTC(2026, 8, 28, 11), { "entries.ndjson": readFileSync(join(delivery, "entries.ndjson")) }, facts as never);
    await until("the delivery imported and its day rendered", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() === 1
      && db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running') AND kind != 'label'").pluck().get() === 0 && db.prepare("SELECT count(*) FROM dirty_days").pluck().get() === 0));
  });

  afterAll(async () => {
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("the lines test prints are not the day file's own lines, rendered elsewhere than in the home's zone and day start", async () => {
    const day = "2026-09-27";
    const document = JSON.parse(readFileSync(dayPath(root, day, "json"), "utf8")) as DayDocument;
    const ours = new Set(document.atoms.filter((atom) => atom.record?.source === SOURCE).map((atom) => atom.n));
    const printed = JSON.parse(readFileSync(dayPath(root, day, "lines"), "utf8")) as number[][];
    const file = readFileSync(dayPath(root, day, "txt"), "utf8").split("\n").filter((_, index) => (printed[index] ?? []).some((n) => ours.has(n)));
    expect(file.length).toBe(3);

    const out: string[] = [];
    await folderVerb({ root, cwd: root, out: (line) => out.push(line) }, ["test", "example-log"]);
    expect(out).toContain("Days in America/Los_Angeles, each from 04:00 (this home's settings):");
    expect(out.filter((line) => /^\d{4}-\d\d-\d\d /u.test(line))).toEqual(file.map((line) => `${day} ${line}`));
  });
});

describe("preview: the folder's acquirers once over the person's real input, in a scratch home", () => {
  const STATEMENT = [
    "account,00001234",
    "date,narration,debit,credit,closing_balance,currency",
    "2026-09-27,SYNTHETIC GROCER,12.50,,987.50,EUR",
    "2026-09-28,SYNTHETIC BAKERY,2.00,3.00,985.50,EUR",
    "2026-09-28,SYNTHETIC SALARY,,1000.00,1987.50,EUR",
    "2026-09-30,SYNTHETIC CINEMA,9.00,,1978.50,EUR",
  ].join("\n");

  const bank = (root: string, secret = false) => {
    const folder = join(root, "connectors", ".drafts", "example-bank");
    cpSync(join(PROOF, "example-bank"), folder, { recursive: true });
    if (secret) {
      const connector = join(folder, "connector.ts");
      const text = readFileSync(connector, "utf8");
      const at = "  export: {";
      expect(text).toContain(at);
      writeFileSync(connector, text.replace(`  },\n${at}`, `    token: { kind: "secret", secret: "example-bank.token", label: "Token" },\n  },\n${at}`));
    }
    return folder;
  };

  const listing = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .map((path) => `${relative(dir, path)} ${statSync(path).size} ${statSync(path).mtimeMs}`)
    .sort();
  const scratches = () => readdirSync(tmpdir()).filter((name) => name.startsWith("lifestream-connector-preview-"));
  const unasked = async (secret: AskedSecret): Promise<string> => {
    throw new Error(`no secret is asked of this preview, and ${secret.member} was`);
  };
  const api = async (root: string) => {
    const folder = join(root, "connectors", ".drafts", "example-api");
    cpSync(join(TEMPLATES, "api"), folder, { recursive: true });
    return { folder, fake: await import(join(TEMPLATES, "api", "test", "fixture.ts")) as typeof import("../connect/templates/api/test/fixture.js") };
  };
  const withMacApp = () => {
    const user = scratch("lifestream-folder-preview-user-");
    mkdirSync(join(user, "Applications", "Lifestream.app"), { recursive: true });
    return machine({ env: { LIFESTREAM_MACHINE_DIR: scratch("lifestream-folder-preview-machine-") }, home: user, system: scratch("lifestream-folder-preview-system-") });
  };

  it("preview of an export over a file prints counts, refusals and the first and last day's lines, and leaves no file under the home's root", async () => {
    const root = makeRoot("lifestream-folder-preview-", { sources: {}, settings: { "day.zone": "America/Los_Angeles", "day.day_start_hour": 4 } });
    try {
      bank(root);
      const where = scratch("lifestream-folder-preview-input-");
      writeFileSync(join(where, "statement.csv"), `${STATEMENT}\n`);
      const before = listing(root);
      const handed = listing(where);
      const out: string[] = [];
      const answer = await folderVerb({ root, cwd: where, out: (line) => out.push(line) }, ["preview", "example-bank", "statement.csv", "--set", "since=2026-01-01", "--set", "nickname=Everyday"]) as { refused: number; kinds: { kind: string; records: number }[] };
      expect(out[0]).toBe("Days in America/Los_Angeles, each from 04:00 (this home's settings):");
      expect(out).toContainEqual(expect.stringMatching(/^example-bank: one delivery of example-bank:00001234:export, \d+ bytes, read in \d+\.\d s$/u));
      expect(out).toContain("3 txn, 2026-09-27 to 2026-09-30");
      expect(out).toContainEqual(expect.stringMatching(/^refused 1, the first 1: \S+ .*not exactly one of a debit or a credit/u));
      const first = out.indexOf("First day, 2026-09-27:");
      const last = out.indexOf("Last day, 2026-09-30:");
      expect([first > 0, last > first]).toEqual([true, true]);
      expect(out[first + 1]).toMatch(/^2026-09-27 /u);
      expect(out[last + 1]).toMatch(/^2026-09-30 /u);
      expect(out.at(-1)).toBe(`Nothing was kept: the scratch home is removed. lifestream connectors install example-bank installs it`);
      expect([answer.refused, answer.kinds]).toEqual([1, [{ kind: "txn", records: 3, first: "2026-09-27", last: "2026-09-30" }]]);
      expect(listing(root)).toEqual(before);
      expect(listing(where)).toEqual(handed);
      expect(scratches()).toEqual([]);
    } finally {
      removeRoot(root);
    }
  });

  it("a path field's ~ is the person's home folder; a text field that begins with ~ is kept as typed", () => {
    const connectors = [{ id: "acme-notes", fields: {
      place: { kind: "path", label: "Place" }, nickname: { kind: "text", label: "Nickname" },
    } }] as unknown as Connector[];
    const block = (...words: string[]) => blocksOf(connectors, words, "/typed/here", "/Users/person-a").blocks.get("acme-notes");
    expect(block("place=~/notes", "nickname=~/Everyday")).toEqual({ place: "/Users/person-a/notes", nickname: "~/Everyday" });
    expect(block("place=~", "nickname=~")).toEqual({ place: "/Users/person-a", nickname: "~" });
    expect(block("place=~other/notes")).toEqual({ place: "/typed/here/~other/notes" });
    expect(block("place=notes", "nickname=Everyday")).toEqual({ place: "/typed/here/notes", nickname: "Everyday" });
  });

  it("a secret typed on the command line is refused, naming `-`; one given as `-` is read once, and an unset field is named", async () => {
    const root = makeRoot("lifestream-folder-preview-secret-", { sources: {} });
    try {
      bank(root, true);
      const asked: string[] = [];
      const ask = (sets: string[]) => folderVerb({ root, cwd: root, out: () => undefined, input: async (secret) => (asked.push(secret.label), "synthetic-token") }, ["preview", "example-bank", ...sets.flatMap((set) => ["--set", set])]).then(() => null, (error: Error) => error.message);
      expect(await ask(["token=synthetic-token"])).toBe(`token: ${SECRET_WORDS} (--set token=-)`);
      expect(await ask(["since=2026-01-01", "nickname=Everyday"])).toBe("example-bank has nothing preview can read before install: example-bank: name the export you downloaded: lifestream connectors preview example-bank <path>");
      expect(asked).toEqual([]);
      expect(await ask(["nickname=Everyday", "nothing=1"])).toBe("nothing is no field of example-bank: its fields are since, nickname, token");
    } finally {
      removeRoot(root);
    }
    const plain = makeRoot("lifestream-folder-preview-unset-", { sources: {} });
    try {
      bank(plain);
      const refused = await folderVerb({ root: plain, cwd: plain, out: () => undefined }, ["preview", "example-bank"]).then(() => null, (error: Error) => error.message);
      expect(refused).toBe("example-bank has nothing preview can read before install: example-bank: name the export you downloaded: lifestream connectors preview example-bank <path>");
    } finally {
      removeRoot(plain);
    }
  });

  it("a key given as `-` is lent to the api template's acquirer under its declared secret, its requests signed, and kept nowhere", async () => {
    const root = makeRoot("lifestream-folder-preview-key-", { sources: {} });
    try {
      const folder = join(root, "connectors", ".drafts", "example-api");
      cpSync(join(TEMPLATES, "api"), folder, { recursive: true });
      const fake = await import(join(TEMPLATES, "api", "test", "fixture.ts")) as typeof import("../connect/templates/api/test/fixture.js");
      const provider = fake.provider({ items: 4, old: 2, edited: [], removed: [], start_ms: Date.now() + 3_600_000 });
      const signed: (string | null)[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        signed.push(request.headers.get("authorization"));
        return await provider(request);
      };
      const before = listing(root);
      const out: string[] = [];
      const preview = await previewFolder({ folder, sets: [`account=${fake.ACCOUNT}`, "key=-"], cwd: root, days: RELEASE_DAYS, unit: "macbook-pro-0001", out: (line) => out.push(line), input: async () => fake.KEY, fetch });
      expect([preview.faults, preview.acquirers.map((each) => each.ran)]).toEqual([[], [true]]);
      expect(signed.length).toBeGreaterThan(0);
      expect(new Set(signed)).toEqual(new Set([`Bearer ${fake.KEY}`]));
      expect(preview.kinds).toEqual([expect.objectContaining({ kind: "note", records: 2 })]);
      expect(listing(root)).toEqual(before);
      expect(out.some((line) => line.includes(fake.KEY))).toBe(false);
      expect(scratches()).toEqual([]);
    } finally {
      removeRoot(root);
    }
  });

  it("a second secret is refused from the one standard input", () => {
    const connectors = [{ id: "acme-notes", fields: {
      key: { kind: "secret", label: "API key", secret: "acme-notes.key" }, link: { kind: "secret", label: "Link", secret: "acme-notes.link" },
    } }] as unknown as Connector[];
    expect(blocksOf(connectors, ["key=-"], "/typed/here").secret).toEqual({ connector: "acme-notes", member: "key", label: "API key", name: "acme-notes.key" });
    expect(() => blocksOf(connectors, ["key=-", "link=-"], "/typed/here")).toThrow("link: one secret a preview, from its one standard input, and key is read already");
  });

  it("a secret typed at a terminal on a Mac with the Lifestream app is refused before anything runs, naming the pipe with the verb as typed", async () => {
    const terminal = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const words = "API key is not typed at a terminal on a Mac with the Lifestream app: its screen recorder and input log would keep it. Pipe it in: ";
    const root = makeRoot("lifestream-folder-preview-terminal-", { sources: {} });
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(terminal() as unknown as typeof process.stdin);
    try {
      await api(root);
      const refused = await folderVerb({ root, cwd: root, out: () => undefined, machine: withMacApp() }, ["preview", "example-api", "--set", "account=person-a@example.com", "--set", "key=-"]).then(() => null, (error: Error) => error.message);
      expect(refused).toBe(`${words}printf '%s' "<API key>" | lifestream connectors preview example-api --set account=person-a@example.com --set key=-`);
    } finally {
      stdin.mockRestore();
      removeRoot(root);
    }
  });

  it("a secret is lent to its own connector's acquirer alone, never another connector's of the folder", async () => {
    const root = makeRoot("lifestream-folder-preview-lent-", { sources: {} });
    try {
      const { folder, fake } = await api(root);
      const index = join(folder, "index.ts");
      const text = readFileSync(index, "utf8");
      const listedAs = "export const connectors: readonly Connector[] = [exampleApiConnector];";
      const builtAs = '{ "example-api": exampleApiAcquirer };';
      expect([text.includes(listedAs), text.includes(builtAs)]).toEqual([true, true]);
      writeFileSync(index, text
        .replace(listedAs, `const peek = {
  id: "example-peek", product: "example-peek", name: "Example peek", vendor: "example", type: "notes", noun: ["note", "notes"],
  records: "Every note's title.", sources: [{ id: "example-peek:local:cloud", read: "example-api", arrives: "poll" }],
  acquirers: ["example-peek"], refresh: { default: "5m", min: "1m" },
  fields: { account: { kind: "email", label: "Example email" } },
} satisfies Connector;
export const connectors: readonly Connector[] = [exampleApiConnector, peek];`)
        .replace("{ \"example-api\": { notes } }", "{ \"example-api\": { notes }, \"example-peek\": { notes } }")
        .replace(builtAs, `{ "example-api": exampleApiAcquirer, "example-peek": () => ({
  name: "example-peek", source: "example-peek:local:cloud",
  async fetch(_state, secrets) { throw new Error(\`lent \${secrets.get("example-api") === undefined ? "no secret" : "the API key"}\`); },
}) };`));
      const provider = fake.provider({ items: 2, old: 1, edited: [], removed: [], start_ms: Date.now() + 3_600_000 });
      const preview = await previewFolder({ folder, sets: [`account=${fake.ACCOUNT}`, "key=-"], cwd: root, days: RELEASE_DAYS, unit: "macbook-pro-0001", out: () => undefined, input: async () => fake.KEY, fetch: async (input, init) => await provider(new Request(input, init)) });
      expect(preview.acquirers.map((each) => [each.name, each.ran])).toEqual([["example-api", true], ["example-peek", true]]);
      expect(preview.faults).toEqual(["acquirers.example-peek: its fetch threw: lent no secret"]);
    } finally {
      removeRoot(root);
    }
  });

  it("an acquirer's error that holds the secret, as typed or URL-escaped, reaches no line, fault or field of the answer", async () => {
    const root = makeRoot("lifestream-folder-preview-cleared-", { sources: {} });
    try {
      const { folder, fake } = await api(root);
      const key = "synthetic key/+&=1";
      const fetch: typeof globalThis.fetch = async () => {
        throw new Error(`the provider refused ${key} at https://api.example.com/v1/notes?key=${encodeURIComponent(key)}`);
      };
      const out: string[] = [];
      const preview = await previewFolder({ folder, sets: [`account=${fake.ACCOUNT}`, "key=-"], cwd: root, days: RELEASE_DAYS, unit: "macbook-pro-0001", out: (line) => out.push(line), input: async () => key, fetch })
        .catch((error: Error) => error.message);
      const answer = JSON.stringify(preview);
      expect(answer).toContain("acquirers.example-api: its fetch threw: the provider refused <key> at https://api.example.com/v1/notes?key=<key>");
      expect([...out, answer].filter((said) => said.includes(key) || said.includes(encodeURIComponent(key)))).toEqual([]);
      expect(out).toContain("acquirers.example-api: its fetch threw: the provider refused <key> at https://api.example.com/v1/notes?key=<key>");
    } finally {
      removeRoot(root);
    }
  });

  it("SIGINT mid-fetch ends the preview: its request aborted, nothing landed after, the scratch home removed before it answers", async () => {
    const root = makeRoot("lifestream-folder-preview-stopped-", { sources: {} });
    try {
      const { folder, fake } = await api(root);
      let held: AbortSignal | undefined;
      const fetch: typeof globalThis.fetch = async (_input, init) => await new Promise<Response>((_, refused) => {
        held = init!.signal!;
        held.addEventListener("abort", () => refused(held!.reason), { once: true });
      });
      const signals = new EventEmitter();
      let said: string | undefined;
      const ended = previewFolder({ folder, sets: [`account=${fake.ACCOUNT}`, "key=-"], cwd: root, days: RELEASE_DAYS, unit: "macbook-pro-0001", out: () => undefined, input: async () => fake.KEY, fetch, signals })
        .then(() => "answered", (error: Error) => error.message).then((message) => (said = message));
      await until("the preview's request is held", () => held !== undefined);
      const ours = scratches().map((name) => join(tmpdir(), name)).filter((dir) => existsSync(join(dir, "home", "work", "example-api")));
      expect(ours).not.toEqual([]);
      signals.emit("SIGINT", "SIGINT");
      await until("the preview answers once stopped", () => said !== undefined);
      await ended;
      expect([said, held!.aborted, ours.filter((dir) => existsSync(dir))]).toEqual(["preview stopped (SIGINT): nothing was kept, the scratch home is removed", true, []]);
      expect([signals.listenerCount("SIGINT"), signals.listenerCount("SIGTERM")]).toEqual([0, 0]);
    } finally {
      removeRoot(root);
    }
  });

  it("a folder whose input waits on a grant names it and `test`: an OAuth sign-in, a site in Chrome, a Mac app's store", async () => {
    const reason = async (kind: string) => {
      const folder = join(scratch(`lifestream-folder-preview-${kind}-`), `example-${kind}`);
      cpSync(join(TEMPLATES, kind), folder, { recursive: true });
      return previewFolder({ folder, sets: [], cwd: folder, days: RELEASE_DAYS, unit: "macbook-pro-0001", out: () => undefined, input: unasked }).then(() => null, (error: Error) => error.message);
    };
    const test = (id: string) => `lifestream connectors test ${id} runs it over its own scenario (test/fixture.ts) and prints what it lands as the day and search show it`;
    const oauth = await reason("oauth");
    expect([oauth?.startsWith("example-oauth has nothing preview can read before install: example-oauth: it signs in by OAuth ("), oauth?.endsWith(`), which only the installed home does; once installed and signed in, lifestream connectors show example-oauth says its first poll. ${test("example-oauth")}`)]).toEqual([true, true]);
    expect(await reason("browser")).toBe(`example-browser has nothing preview can read before install: example-browser: its input is a site in your Chrome, read through the extension once installed and turned on. ${test("example-browser")}`);
    expect(await reason("mac-app")).toBe("example-mac-app has nothing preview can read before install: example-mac-app: the Mac app reads its store once installed and allowed on this Mac (Set up › Allow): lifestream connectors test example-mac-app prints its fixture's store as the day and search show it");
  });

  it("a unit the folder's adapter throws on is a fault of the preview, its days and counts read all the same", async () => {
    const folder = join(scratch("lifestream-folder-preview-aside-"), "example-folder");
    cpSync(join(TEMPLATES, "folder"), folder, { recursive: true });
    const adapter = join(folder, "adapter.ts");
    const text = readFileSync(adapter, "utf8");
    expect(text).toContain("  const title = titleOf(content.path);\n");
    writeFileSync(adapter, text.replace("  const title = titleOf(content.path);\n", '  if (content.path.includes("broken")) throw new Error("synthetic adapter fault");\n  const title = titleOf(content.path);\n'));
    const notes = scratch("lifestream-folder-preview-notes-");
    writeFileSync(join(notes, "kept.md"), "A synthetic note.\n");
    writeFileSync(join(notes, "broken.md"), "Another synthetic note.\n");
    const preview = await previewFolder({ folder, sets: [`folder=${notes}`], cwd: notes, days: RELEASE_DAYS, unit: "macbook-pro-0001", out: () => undefined, input: unasked });
    expect(preview.kinds).toEqual([expect.objectContaining({ kind: "note", records: 2 })]);
    expect(preview.faults).toEqual([
      expect.stringMatching(/^adapters\.example-folder\.notes: threw on its unit \S+broken\.md: synthetic adapter fault$/u),
      "adapters.example-folder.notes: its search text of note broken.md throws: synthetic adapter fault",
    ]);
  });

  it("a preview for a keyed home makes its scratch home in the home's work folder and empties it at the end; a plain home's stays in the temporary folder", async () => {
    const folder = join(scratch("lifestream-folder-preview-keyed-"), "example-folder");
    cpSync(join(TEMPLATES, "folder"), folder, { recursive: true });
    const notes = scratch("lifestream-folder-preview-keyed-notes-");
    writeFileSync(join(notes, "kept.md"), "A synthetic note.\n");
    const machineDir = scratch("lifestream-folder-preview-machine-");
    const home = keyedFolder(scratch("lifestream-folder-preview-home-"), machineDir);
    const work = join(machineDir, "scratch", "home");
    const seen: string[][] = [];
    const preview = await previewFolder({ home, folder, sets: [`folder=${notes}`], cwd: notes, days: RELEASE_DAYS, unit: "macbook-pro-0001", out: () => seen.push(readdirSync(work).filter((name) => name.startsWith("connector-preview-"))), input: unasked });
    expect(preview.kinds).toEqual([expect.objectContaining({ kind: "note", records: 1 })]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((names) => names.length === 1)).toBe(true);
    expect(readdirSync(work).filter((name) => name.startsWith("connector-preview-"))).toEqual([]);
    expect(await previewFolder({ home: openHomeFolder(scratch("lifestream-folder-preview-plain-")), folder, sets: [`folder=${notes}`], cwd: notes, days: RELEASE_DAYS, unit: "macbook-pro-0001", out: () => undefined, input: unasked }))
      .toMatchObject({ kinds: [expect.objectContaining({ kind: "note", records: 1 })] });
  });

  it("where the export cannot be cloned and the disk lacks room, preview goes on, or where it has room, stops", async () => {
    const root = mkdtempSync(join(tmpdir(), "lifestream-folder-preview-disk-"));
    made.push(root);
    const folder = bank(root);
    const file = join(root, "statement.csv");
    writeFileSync(file, `${STATEMENT}\n`);
    const unclonable = (free: number) => ({
      clone: () => { throw Object.assign(new Error("clone: operation not supported"), { code: "ENOTSUP" }); },
      free: () => free,
    });
    const run = (free: number) => previewFolder({ folder, path: file, sets: ["since=2026-01-01", "nickname=Everyday"], cwd: root, days: RELEASE_DAYS, unit: "macbook-pro-0001", out: () => undefined, input: unasked, disk: unclonable(free) });
    await expect(run(10)).rejects.toThrow(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} is \\d+ bytes, its disk cannot clone it into the scratch home \\(.+\\), and that disk has 10 bytes free: free \\d+ bytes there, or move the file onto that disk$`, "u"));
    expect((await run(1 << 30)).kinds).toEqual([{ kind: "txn", records: 3, first: "2026-09-27", last: "2026-09-30" }]);
    expect(existsSync(file)).toBe(true);
  });
});
