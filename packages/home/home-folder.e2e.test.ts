import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeRelay, memorySecrets, pollCall, type Acquirer, type KeptPoll } from "@lifestreamprotocol/connect";
import { feeds, type Dependencies, type Files, type Provider, type Scenario, type Site } from "@lifestreamprotocol/connect/sdk";
import { civilDay, openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import type { DayDocument } from "@lifestreamprotocol/families";
import { askGeneration, serveDoor, type Door } from "./door.js";
import { folderDigest, importFolder, type Generation } from "./folders.js";
import { written } from "./fixture-day.js";
import { startHome, type Home, type HomeOptions } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { homeRegistryModule, sdkModule } from "./programs.js";
import { readRef } from "./refs.js";
import { effective } from "./settings.js";
import { NOT_NOW, Refusal } from "./refusal.js";
import { runCli } from "./cli.js";
import { askHome } from "./socket.js";
import type { StatusReport } from "./status.js";
import type { ConnectorReport, StreamsReport } from "./streams-report.js";
import { artifact, copyRoot, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { shipFiles } from "./test/harness-deliveries.js";
import { editSettings, testSocket } from "./test/folder.js";
import { REPO } from "./test/support.js";
import { folderVerb, type FolderContext } from "./verbs/connectors-folder.js";

const { writeZip } = (await import(new URL("../connect/test/drive.ts", import.meta.url).href)) as typeof import("../connect/test/drive.js");

const TEMPLATES = join(REPO, "packages", "connect", "templates");
const RELEASE_KINDS = ["label", "phone"];
const HOME_KINDS = readdirSync(TEMPLATES, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !RELEASE_KINDS.includes(entry.name)).map((entry) => entry.name).sort();
const START_MS = Date.UTC(2026, 8, 15, 9);
const SCENARIO: Scenario = { items: 3, old: 0, edited: [], removed: [], start_ms: START_MS };
const MAC = "macbook-pro-0001";
const WORD = "synthetic";
const READER = randomBytes(32).toString("base64url");

interface Fakes {
  readonly settings?: JsonObject;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly provider?: (scenario: Scenario) => Provider;
  readonly site?: (scenario: Scenario) => Site;
  readonly files?: (scenario: Scenario) => Files;
  readonly fixtures: Readonly<Record<string, (folder: string) => { source: string; facts: JsonObject }>>;
}

interface Look {
  readonly row: { line: string; health: string; words: string } | null;
  readonly lines: string[];
  readonly hits: { key: string; day: string; title: string | null }[];
}

interface Road {
  readonly road: string;
  readonly preview?: (where: string, fakes: Fakes) => string[];
  readonly bring: (journey: Journey) => Promise<void>;
}

function place(dir: string, files: Files): void {
  for (const [path, value] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    const held = typeof value === "string" || value instanceof Uint8Array ? { bytes: value } : value as { bytes: string | Uint8Array; modified_ms?: number };
    writeFileSync(file, held.bytes);
    if (held.modified_ms !== undefined) utimesSync(file, new Date(held.modified_ms), new Date(held.modified_ms));
  }
}

function exported(where: string, fakes: Fakes): string {
  const zip = join(where, "export.zip");
  if (!existsSync(zip)) {
    writeZip(zip, Object.entries(fakes.files!(SCENARIO)).map(([name, value]) => ({ name, bytes: Buffer.from(typeof value === "string" || value instanceof Uint8Array ? value : (value as { bytes: string | Uint8Array }).bytes) })));
  }
  return zip;
}

function notesFolder(where: string, fakes: Fakes): string {
  const dir = join(where, "Notes");
  if (!existsSync(dir)) place(dir, fakes.files!(SCENARIO));
  return dir;
}

const ROADS: Readonly<Record<string, Road>> = {
  api: { road: "the acquirer's own sealed output over the fixture's provider, standing in for the home's poll over the network once Set up holds the key", bring: (journey) => journey.sealed() },
  oauth: { road: "the acquirer's own sealed output over the fixture's provider, standing in for the home's poll once Sign in holds the credential", bring: (journey) => journey.sealed() },
  browser: { road: "the acquirer's own sealed output over the fixture's site in the in-memory station, standing in for Chrome after the site's one Allow", bring: (journey) => journey.sealed() },
  "mac-app": { road: "the template's own synthetic store as its delivery, its source stated, standing in for the Mac app's exchange and read after its Allow", bring: (journey) => journey.stored() },
  export: {
    road: "the import: lifestream import <id> <the zip>, read once by the home",
    preview: (where, fakes) => [exported(where, fakes)],
    bring: async (journey) => {
      const answer = await askHome(testSocket(journey.root), "import", [journey.id, exported(journey.where, journey.fakes)]) as { import: string | null };
      expect(answer.import).toEqual(expect.stringMatching(/^[0-9a-f]{16}$/u));
    },
  },
  folder: {
    road: "the home's own poll of the folder the person picked: connectors set <id> folder <the folder>",
    preview: (where, fakes) => ["--set", `folder=${notesFolder(where, fakes)}`],
    bring: async (journey) => {
      await journey.ask(["set", journey.id, "folder", JSON.stringify(notesFolder(journey.where, journey.fakes))]);
    },
  },
};

interface Journey {
  readonly kind: string;
  readonly id: string;
  readonly root: string;
  readonly where: string;
  fakes: Fakes;
  source: string;
  ask(args: readonly string[]): Promise<unknown>;
  sealed(): Promise<void>;
  stored(): Promise<void>;
}

for (const kind of HOME_KINDS) {
  const road = ROADS[kind];
  describe(`the ${kind} journey: new, test, ${road?.preview === undefined ? "" : "preview, "}install, ${road?.road ?? "no road"}, the day, an edit, remove, back`, () => {
    const id = `acme-${kind}`;
    let root: string;
    let where: string;
    let door: Door | undefined;
    let home: Home | undefined;
    let cycled: Promise<void> = Promise.resolve();
    let restarts = 0;
    const lines: string[] = [];
    const steps: Record<string, unknown> = { road: road?.road };
    const options: HomeOptions = { registry: homeRegistryModule(), log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS };
    const journey = {} as Journey;
    let ctx: FolderContext;
    const draft = () => join(root, "connectors", ".drafts", id);
    const installed = () => join(root, "connectors", id);
    const folders = () => readdirSync(join(root, "connectors"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const recorded = () => Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(root, "connectors", ".installed.json"), "utf8")) as Record<string, { from?: string }>).map(([name, install]) => [name, install.from]));
    const generation = async () => await askHome(testSocket(root), "generation") as Generation;

    const held = () => readHome(root, (db) => ({
      heads: db.prepare("SELECT h.kind, h.key, h.version, v.start_ms FROM heads h LEFT JOIN versions v ON v.id = h.version WHERE h.source = ? ORDER BY h.kind, h.key").all(journey.source) as { kind: string; key: string; version: string; start_ms: number | null }[],
      statements: db.prepare("SELECT count(*) FROM statements WHERE source = ?").pluck().get(journey.source) as number,
    }));
    const deliveries = () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE source LIKE ? || ':%'").pluck().all(id) as string[]);
    const settled = () => readHome(root, (db) => (db.prepare("SELECT count(*) FROM deliveries WHERE source LIKE ? || ':%' AND state <> 'imported'").pluck().get(id) as number) === 0
      && (db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running') AND kind NOT IN ('label', 'poll')").pluck().get() as number) === 0
      && (db.prepare("SELECT count(*) FROM dirty_days").pluck().get() as number) === 0);
    const search = async (): Promise<Look["hits"]> => {
      const response = await fetch(`http://127.0.0.1:${door!.port}/v1/search?lists=record&query=${WORD}`, { headers: { authorization: `Bearer ${READER}` } });
      const body = await response.json() as { record?: { hits: { ref: string; day: string; title?: string | null }[] } };
      expect(response.status, JSON.stringify(body)).toBe(200);
      return (body.record?.hits ?? []).flatMap((hit) => {
        const ref = readRef(hit.ref, "ref", ["record", "line"]);
        return ref.kind === "record" && ref.parts.source === journey.source ? [{ key: ref.parts.key, day: hit.day, title: hit.title ?? null }] : [];
      }).sort((a, b) => a.key.localeCompare(b.key));
    };
    const dayLines = (): string[] => {
      const days = join(root, "days");
      if (!existsSync(days)) return [];
      return readdirSync(days).filter((name) => name.endsWith(".day.json")).sort().flatMap((name) => {
        const doc = JSON.parse(readFileSync(join(days, name), "utf8")) as DayDocument;
        return doc.atoms.filter((atom) => atom.record?.source === journey.source).map((atom) => `${name.slice(0, 10)} ${atom.text}`);
      });
    };
    const report = async (what: string, ready: (report: StreamsReport) => boolean = () => true): Promise<StreamsReport> => {
      let last: StreamsReport | undefined;
      let fault: unknown;
      await until(what, async () => {
        try {
          last = await askHome(testSocket(root), "connectors") as StreamsReport;
        } catch (error) {
          if (!(error instanceof Refusal && error.code === NOT_NOW)) fault = error;
          return false;
        }
        return ready(last);
      }).catch((error: Error) => { throw new Error(`${error.message}${fault === undefined ? "" : `: ${(fault as Error).message}`}`); });
      return last!;
    };
    const rowOf = (from: StreamsReport) => from.connectors.find((each) => each.id === id) ?? null;
    const look = async (step: string, drawn: boolean): Promise<Look> => {
      const shown = rowOf(await report(`the stream's row ${drawn ? "drawn" : "gone"}`, (now) => (rowOf(now) !== null) === drawn));
      const seen: Look = { row: shown === null ? null : { line: shown.line, health: shown.health.state, words: shown.health.words }, lines: dayLines(), hits: await search() };
      steps[step] = seen;
      artifact(root, `journey-${kind}`, steps);
      return seen;
    };
    const daysOf = () => {
      const day = effective(root).settings.day;
      return held().heads.filter((head) => head.version !== "gone").map((head) => ({ key: head.key, day: head.start_ms === null ? null : civilDay(head.start_ms, day) }));
    };
    const poll = () => {
      const db = openHome(openHomeFolder(root), "read");
      const view = db.view();
      try {
        return { cursor: view.tables.polls.cursor(id)?.state ?? null, memory: view.tables.polls.rememberedAfter(id, "file", null, 100) };
      } finally {
        view.close();
        db.close();
      }
    };
    const verb = async (...args: string[]) => await folderVerb(ctx, args);
    const refusal = async (...args: string[]) => await folderVerb(ctx, args).then(() => null, (error: Error) => error.message);

    beforeAll(async () => {
      root = makeRoot(`lifestream-journey-${kind}-`, { sources: {}, clocks: true });
      where = mkdtempSync(join(tmpdir(), `lifestream-journey-${kind}-person-`));
      mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token: READER, now_ms: 0 });
      door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: homeRegistryModule(), generation: askGeneration, lookMs: LOOK_MS });
      editSettings(root, { "door.port": door.port });
      home = await startHome(root, options);
      ctx = {
        root, cwd: where, out: (line) => lines.push(line),
        restart: () => {
          restarts++;
          cycled = (async () => {
            await home!.stop();
            home = await startHome(root, options);
          })();
          return true;
        },
      };
      Object.assign(journey, {
        kind, id, root, where, source: "",
        ask: async (args: readonly string[]) => await askHome(testSocket(root), "connectors", [...args]),
        sealed: async () => {
          const folder = installed();
          const module = await importFolder(join(folder, "index.ts"), folder, sdkModule()) as { acquirers: Record<string, (settings: JsonObject, dependencies?: Dependencies) => Acquirer> };
          const fakes = journey.fakes;
          const provider = fakes.provider?.(SCENARIO);
          const site = fakes.site?.(SCENARIO);
          const dependencies: Dependencies = {
            now: () => START_MS, sleep: async () => undefined,
            ...(provider === undefined ? {} : { fetch: async (input: string | URL | Request, init?: RequestInit) => await provider(new Request(input, init)) }),
          };
          let shipped = 0;
          for (const [name, factory] of Object.entries(module.acquirers)) {
            const work = mkdtempSync(join(tmpdir(), `lifestream-journey-${kind}-work-`));
            const built = factory({ ...fakes.settings, work, zone: effective(root).settings.day.zone, unit: MAC }, dependencies);
            const acquirer = site === undefined ? built : new FakeRelay({ answer: (request) => site.answer(request) }).lend(built);
            const kept: KeptPoll = { state: null };
            const secrets = memorySecrets({ ...fakes.secrets });
            for (const call of acquirer.page === undefined ? ["fetch"] as const : ["fetch", "page"] as const) {
              for (let calls = 0; calls < 50; calls++) {
                await pollCall(acquirer, kept, secrets, call, async (sealing) => {
                  await shipFiles(root, sealing.source, START_MS + shipped * 60_000, { ...sealing.files }, sealing.facts);
                  shipped++;
                });
                if (call === "fetch" ? kept.next?.more !== true : (kept.left ?? 0) === 0) break;
              }
            }
            rmSync(work, { recursive: true, force: true });
            expect([name, shipped > 0]).toEqual([name, true]);
          }
        },
        stored: async () => {
          const at = mkdtempSync(join(tmpdir(), `lifestream-journey-${kind}-store-`));
          try {
            for (const [reader, fixture] of Object.entries(journey.fakes.fixtures)) {
              const made = fixture(at);
              await shipFiles(root, made.source, START_MS, written(at), { ...made.facts, ...feeds(made.source, reader) });
            }
          } finally {
            rmSync(at, { recursive: true, force: true });
          }
        },
      } satisfies Omit<Journey, "fakes">);
    });

    afterAll(async () => {
      await cycled.catch(() => undefined);
      await home?.stop().catch(() => undefined);
      await door?.close().catch(() => undefined);
      if (where !== undefined) rmSync(where, { recursive: true, force: true });
      if (root !== undefined) removeRoot(root);
    });

    it("its road is one this journey names", () => {
      expect(road, `${kind}: a home kind with no road in ROADS`).toBeDefined();
    });

    it("new drafts it anywhere but connectors/.drafts, or the started home loads the draft; test faults or prints no day", async () => {
      const made = await verb("new", kind, id) as { folder: string };
      expect([made.folder, lines.at(-1)]).toEqual([draft(), `${kind} ${id} drafted at ${draft()}, which no start loads. lifestream connectors test ${id} checks it; lifestream connectors install ${id} installs it`]);
      expect((await generation()).folders).toEqual([]);
      journey.fakes = await importFolder(join(draft(), "test", "fixture.ts"), draft(), sdkModule()) as Fakes;
      const tested = await verb("test", id) as { passed: boolean; faults: string[]; lines: string[] };
      steps.test = tested.lines;
      expect([tested.passed, tested.faults, lines.at(-1)]).toEqual([true, [], `${id} passes the conformance run`]);
      expect(tested.lines.filter((line) => /^\d{4}-\d\d-\d\d /u.test(line)).length).toBeGreaterThan(0);
    });

    it.runIf(road?.preview !== undefined)("preview over the person's own input prints none of its day's lines, or keeps anything", async () => {
      const words = road!.preview!(where, journey.fakes);
      const before = folders();
      const from = lines.length;
      await verb("preview", id, ...words);
      const said = lines.slice(from);
      steps.preview = said;
      artifact(root, `journey-${kind}`, steps);
      expect(said.filter((line) => /^\d{4}-\d\d-\d\d /u.test(line) && line.includes("Synthetic")).length).toBeGreaterThan(0);
      expect([said.at(-1), folders()]).toEqual([`Nothing was kept: the scratch home is removed. lifestream connectors install ${id} installs it`, before]);
    });

    it("install answers before the home runs it, runs it with a need, or lets a second copy of it past the one installed", async () => {
      expect(await verb("install", id)).toEqual({ installed: installed(), connectors: [id], runs: true });
      expect(lines.at(-1)).toBe(`installed ${id}; the home runs it`);
      const now = await generation();
      expect(now.folders.map((each) => [each.name, each.digest, each.ids])).toEqual([[id, folderDigest(installed()), [id]]]);
      expect([folders(), recorded()]).toEqual([[".drafts", id], { [id]: realpathSync(draft()) }]);
      const door = await askHome(testSocket(root), "status") as StatusReport;
      expect([door.generation, door.needs.filter((need) => need.id.startsWith("folder:"))]).toEqual([now.start, []]);
      expect((await report("the door serves its connectors")).needs.filter((need) => need.id.startsWith("folder:"))).toEqual([]);
      await cycled;

      const copy = join(where, `${id}-copy`);
      cpSync(draft(), copy, { recursive: true });
      const restarted = restarts;
      expect(await refusal("install", copy)).toBe(`connectors/${id} holds ${id} (installed from ${realpathSync(draft())}): install from there, edit connectors/${id} and install that, or remove it first`);
      expect([restarts - restarted, folders(), folderDigest(installed()), (await generation()).start]).toEqual([0, [".drafts", id], folderDigest(draft()), now.start]);
      await look("installed", true);
    });

    it(`its data reaches no day, no search hit on its day (its clock's precision not asserted), or no stream row, by ${road?.road ?? "no road"}`, async () => {
      await road!.bring(journey);
      await until("its delivery imported", () => deliveries().length > 0 && deliveries().every((state) => state === "imported"));
      journey.source = readHome(root, (db) => db.prepare("SELECT source FROM deliveries WHERE source LIKE ? || ':%' LIMIT 1").pluck().get(id) as string);
      await until("every day rendered", settled);
      const records = daysOf();
      expect(records.length).toBeGreaterThan(0);
      let found: Look["hits"] = [];
      await until("every record found by search", async () => (found = await search()).length === records.length)
        .catch(async (error: Error) => { throw new Error(`${error.message}: ${JSON.stringify({ records, found, lines: dayLines(), raw: await (await fetch(`http://127.0.0.1:${door!.port}/v1/search?lists=record&query=${WORD}`, { headers: { authorization: `Bearer ${READER}` } })).json(), index: readHome(root, (db) => db.prepare("SELECT kind, key, state, count(*) AS n FROM jobs WHERE kind = 'index' AND key = 'search' GROUP BY state").all()) })}`); });
      const seen = await look("arrived", true);
      expect(seen.row).toMatchObject({ health: expect.not.stringMatching(/^(broken|needs-you)$/u) });
      expect(seen.lines.length).toBeGreaterThan(0);
      expect(seen.hits.map((hit) => ({ key: hit.key, day: hit.day }))).toEqual(records.map((record) => ({ key: record.key, day: record.day })).sort((a, b) => a.key.localeCompare(b.key)));
      for (const hit of seen.hits) expect(seen.lines.some((line) => line.startsWith(`${hit.day} `)), `${hit.key} on ${hit.day}`).toBe(true);
      if (kind === "export") expect(deliveries()).toHaveLength(1);
    });

    it("an edit installed again leaves a copy, moves its line, states a record again, forgets its poll, or leaves the day in the old words", async () => {
      const before = held();
      const polled = kind === "folder" ? poll() : null;
      const adapter = join(draft(), "adapter.ts");
      const text = readFileSync(adapter, "utf8");
      const edited = text.replace(/version: "1"/u, 'version: "2"').replace(/return \{ shape: "note", title(?:: ([\w.]+))?, text,/u, (_, title: string | undefined) => `return { shape: "note", title: \`Edited \${${title ?? "title"}}\`, text: \`Edited \${text}\`,`);
      expect(edited.match(/Edited/gu)).toHaveLength(2);
      writeFileSync(adapter, edited);
      const answer = await verb("install", id);
      expect(answer).toEqual({ installed: installed(), connectors: [id], runs: true });
      expect(lines.at(-1)).toBe(kind === "mac-app" || kind === "export"
        ? `installed ${id}; the home runs it`
        : `installed ${id}; the home runs it; if you changed how it reads, lifestream connectors reread ${id} reads its source again from the start`);
      await cycled;
      expect([folders(), recorded(), folderDigest(installed())]).toEqual([[".drafts", id], { [id]: realpathSync(draft()) }, folderDigest(draft())]);
      await until("the day in its new words", () => settled() && dayLines().length > 0 && dayLines().every((line) => line.includes("Edited")));
      if (polled !== null) {
        const polledAt = () => readHome(root, (db) => db.prepare("SELECT max(at_ms) FROM attempts WHERE source = ?").pluck().get(journey.source) as number | null);
        const last = polledAt();
        await journey.ask(["refresh", id]);
        await until("the folder polled again", () => (polledAt() ?? 0) > (last ?? 0));
        expect([poll(), deliveries()]).toEqual([polled, ["imported"]]);
      }
      expect(held()).toEqual(before);
      await look("edited", true);
    });

    it("remove deletes a record, says nothing of what stays, or leaves a line, a hit or a row once its rebuild ends", async () => {
      const before = held();
      const polled = kind === "folder" ? poll() : null;
      const answer = await verb("remove", id) as { kept: string };
      expect(answer).toEqual({ removed: id, kept: expect.stringMatching(new RegExp(`/connectors/\\.removed/${id}-\\d{4}-`, "u")), connectors: [id], runs: true });
      expect(lines.at(-1)).toBe(`removed ${id}; the home runs without it. Its records stay in Lifestream and leave your days and search once the rebuild ends. lifestream connectors install ${answer.kept} brings it back with them.`);
      await cycled;
      steps.kept = answer.kept;
      expect([folders(), recorded(), (await generation()).folders]).toEqual([[".drafts", ".removed"], {}, []]);
      await until("its lines and hits gone", async () => settled() && dayLines().length === 0 && (await search()).length === 0);
      const seen = await look("removed", false);
      expect([seen.row, held()]).toEqual([null, before]);
      if (polled !== null) expect(poll()).toEqual(polled);
    });

    it("install from .removed nests a stamp, records no path, states a record again, forgets its poll, or brings nothing back", async () => {
      const before = held();
      const polled = kind === "folder" ? poll() : null;
      const kept = steps.kept as string;
      const said = lines.length;
      expect(await verb("install", kept)).toEqual({ installed: installed(), connectors: [id], runs: true });
      expect(lines.slice(said).filter((line) => line.endsWith("passes the conformance run"))).toEqual([`${id} passes the conformance run`]);
      expect(lines.slice(-2)).toEqual([`installed ${id}; the home runs it`, `lifestream connectors install ${id} installs ${draft()}, your working copy, not ${kept}`]);
      await cycled;
      expect([folders(), recorded()]).toEqual([[".drafts", ".removed", id], { [id]: realpathSync(draft()) }]);
      const records = daysOf();
      await until("its lines and hits back", async () => settled() && dayLines().length > 0 && (await search()).length === records.length);
      const seen = await look("back", true);
      expect(seen.row).not.toBeNull();
      expect(seen.lines.every((line) => line.includes("Edited"))).toBe(true);
      expect(held()).toEqual(before);
      if (polled !== null) expect(poll()).toEqual(polled);
    });
  });
}

describe("the home's socket: one per home on the machine, never in the folder", () => {
  const options: HomeOptions = { registry: homeRegistryModule(), log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS };
  const roots: string[] = [];
  const homes: Home[] = [];
  let a: string;
  let b: string;

  beforeAll(async () => {
    a = makeRoot("lifestream-socket-a-", { sources: {} });
    b = makeRoot("lifestream-socket-b-", { sources: {} });
    roots.push(a, b);
    homes.push(await startHome(a, options), await startHome(b, options));
  });

  afterAll(async () => {
    for (const home of homes) await home.stop();
    for (const root of roots) removeRoot(root);
  });

  it("a started home leaves no socket in its folder, and serves at its own id's path under the machine directory", () => {
    for (const root of [a, b]) {
      expect(existsSync(join(root, "home.sock"))).toBe(false);
      expect(existsSync(testSocket(root).path)).toBe(true);
    }
    expect(testSocket(a).path).not.toBe(testSocket(b).path);
  });

  it("two homes of two folders on one machine directory each answer for their own", async () => {
    expect(await askHome({ path: testSocket(a).path, folder: a }, "generation")).toMatchObject({ root: a });
    expect(await askHome({ path: testSocket(b).path, folder: b }, "generation")).toMatchObject({ root: b });
  });

  it("a request naming another folder is refused OTHER_HOME, in its words", async () => {
    const refused = await askHome({ path: testSocket(a).path, folder: b }, "generation").then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(Refusal);
    expect(refused).toMatchObject({ status: 409, code: "OTHER_HOME", words: `the home answering here is ${a}, not ${b}: a copy of a home answers for it while the home runs` });
  });

  it("a request naming no folder is answered, as the Mac app asks", async () => {
    expect(await askHome(testSocket(a), "generation")).toMatchObject({ root: a });
  });

  it("a copy of a running home's folder refuses to start, and the running home still answers", async () => {
    const copy = copyRoot(a, "lifestream-socket-copy-");
    roots.push(copy);
    await expect(startHome(copy, options)).rejects.toThrow(
      `a home with this folder's id already runs on this machine and answers ${testSocket(a).path}: stop it first, or give this copy its own machine directory (LIFESTREAM_MACHINE_DIR)`,
    );
    expect(await askHome({ path: testSocket(a).path, folder: a }, "generation")).toMatchObject({ root: a });
  });

  it("--root on a folder with no HOME.json says readHome's words", async () => {
    const empty = mkdtempSync(join(tmpdir(), "lifestream-socket-empty-"));
    roots.push(empty);
    const out: string[] = [];
    expect(await runCli(["status", "--root", empty], { write: (text) => out.push(text) })).toBe(1);
    expect(out.join("")).toContain(`${empty} is not Lifestream's folder: it holds no HOME.json`);
  });
});
