import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@lifestreamprotocol/core";
import type { Connector } from "@lifestreamprotocol/connect";
import { ANSWERED_RULE, BACK_RULE, CASE_MS, EARLIER_RULE, FETCH_START_RULE, LATER_RULE, MONTHS_RULE, NOTHING_NEW_RULE, proveAcquirers, RUN_MS, STAMPED_RULE, START_RULE, WALK_CALLS, WHO_RULE, type Limits, type ProofEvent, type ProveAsk } from "./conformance-acquirers.js";
import { literal } from "./conformance.js";
import { readerOf } from "./fixture-day.js";
import { previewFolder } from "./folder-preview.js";
import { trialCommand } from "./programs.js";
import { effectiveOf } from "./settings.js";
import { PAGE } from "./test/acquirer-proof/acquirers.js";
import { REPO } from "./test/support.js";
import { RELEASE_DAYS } from "./verbs/connectors-folder.js";

const ACCOUNT = "person-a@example.com";
const FOLDER = join(import.meta.dirname, "test", "acquirer-proof");
const TEMPLATES = join(REPO, "packages", "connect", "templates");

const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    if (KEEP) process.stdout.write(`kept ${dir}\n`);
    else rmSync(dir, { recursive: true, force: true });
  }
});

const BATCHED = new Set([
  "synthetic-good", "synthetic-untitled", "synthetic-resends", "synthetic-idles", "synthetic-deaf", "synthetic-mute",
  "synthetic-history", "synthetic-direct", "synthetic-grows", "synthetic-grows-first", "synthetic-backwards",
  "synthetic-loses-first", "synthetic-loses", "synthetic-drops", "synthetic-unfloored", "synthetic-whole-first",
  "synthetic-page-only", "synthetic-own-start", "synthetic-counts", "synthetic-counts-every", "synthetic-daily",
  "synthetic-due", "synthetic-blind", "synthetic-nopage", "synthetic-endless", "synthetic-open", "synthetic-by-time",
  "synthetic-oauth", "synthetic-bearer", "synthetic-unrotated", "synthetic-swallows", "synthetic-connects",
]);
interface TrialWorker {
  prove(ask: ProveAsk): Promise<{ faults: string[]; lines: string[] }>;
  close(): Promise<void>;
}
let worker: TrialWorker | undefined;
function trialWorker(): TrialWorker {
  if (worker !== undefined) return worker;
  const [command, ...args] = trialCommand();
  const child: ChildProcess = spawn(command!, [...args, "--serve"], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let current: { faults: string[]; lines: string[]; done: (result: { faults: string[]; lines: string[] }) => void; fail: (error: Error) => void } | null = null;
  let tail = Promise.resolve();
  let err = "";
  child.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
  child.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    for (let at = buf.indexOf("\n"); at >= 0; at = buf.indexOf("\n")) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (current === null) continue;
      let event: ProofEvent;
      try {
        event = JSON.parse(line) as ProofEvent;
      } catch {
        continue;
      }
      if (event.proof === "fault") current.faults.push(event.text);
      else if (event.proof === "line") current.lines.push(event.text);
      else if (event.proof === "done") {
        const settled = current;
        current = null;
        settled.done({ faults: settled.faults, lines: settled.lines });
      }
    }
  });
  child.on("close", (code) => {
    if (current !== null) {
      const settled = current;
      current = null;
      settled.fail(new Error(`trial worker exited ${String(code)}: ${err.trim().split("\n").at(-1) ?? ""}`));
    }
    worker = undefined;
  });
  worker = {
    prove(ask) {
      const next = tail.then(() => new Promise<{ faults: string[]; lines: string[] }>((done, fail) => {
        current = { faults: [], lines: [], done, fail };
        child.stdin!.write(`${JSON.stringify(ask)}\n`);
      }));
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
    close() {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise<void>((done) => {
        child.once("close", () => done());
        child.stdin!.end();
        child.kill("SIGTERM");
      });
    },
  };
  return worker;
}
afterAll(async () => {
  const closing = worker;
  worker = undefined;
  await closing?.close();
});

let batched: Promise<Map<string, { faults: string[]; lines: string[] }>> | undefined;

function proveBatch(): Promise<Map<string, { faults: string[]; lines: string[] }>> {
  if (batched !== undefined) return batched;
  batched = (async () => {
    const dir = mkdtempSync(join(tmpdir(), "conformance-acquirers-batch-"));
    const work = join(dir, "work");
    mkdirSync(work);
    const settings = effectiveOf({ "day.zone": "UTC", unit: "macbook-pro-0001" }, "the conformance run").settings;
    try {
      const result = await proveAcquirers({
        dir: FOLDER, work, settings,
        acquirers: [...BATCHED].map((name) => ({ name, settings: settingsOf(name) })),
      });
      const byId = new Map<string, { faults: string[]; lines: string[] }>();
      for (const name of BATCHED) {
        const faultPrefix = `acquirers.${name}: `;
        const linePrefix = `${name} `;
        byId.set(name, {
          faults: result.faults.filter((fault) => fault.startsWith(faultPrefix)),
          lines: result.lines.filter((line) => line.startsWith(linePrefix)),
        });
      }
      return byId;
    } finally {
      if (KEEP) process.stdout.write(`kept ${dir}\n`);
      else rmSync(dir, { recursive: true, force: true });
    }
  })();
  return batched;
}

function settingsOf(id: string): JsonObject {
  if (id === "synthetic-open") return { account: ACCOUNT };
  if (["synthetic-oauth", "synthetic-bearer", "synthetic-unrotated", "synthetic-swallows"].includes(id)) return { account: ACCOUNT, signin: `${id}.signin` };
  if (["synthetic-export", "synthetic-unsourced"].includes(id)) return { account: ACCOUNT };
  return { account: ACCOUNT, key: `${id}.key` };
}

async function proved(id: string, options: { dir?: string; settings?: JsonObject; limits?: Limits } = {}) {
  if (options.dir === undefined && options.settings === undefined && options.limits === undefined && BATCHED.has(id)) {
    return (await proveBatch()).get(id)!;
  }
  const dir = mkdtempSync(join(tmpdir(), "conformance-acquirers-"));
  temps.push(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  const settings = effectiveOf({ "day.zone": "UTC", unit: "macbook-pro-0001" }, "the conformance run").settings;
  const prove = { dir: options.dir ?? FOLDER, work, settings, acquirers: [{ name: id, settings: options.settings ?? settingsOf(id) }] };
  const result = options.limits === undefined ? await trialWorker().prove({ prove }) : await proveAcquirers({ ...prove, limits: options.limits });
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(dir, "artifacts", `${id}.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function unfaked(exports = 'export { fixtures, item, secrets } from "./faked.js";\n'): string {
  const dir = mkdtempSync(join(tmpdir(), "conformance-acquirers-unfaked-"));
  temps.push(dir);
  cpSync(FOLDER, dir, { recursive: true });
  renameSync(join(dir, "test", "fixture.ts"), join(dir, "test", "faked.ts"));
  writeFileSync(join(dir, "test", "fixture.ts"), exports);
  return dir;
}

function broken(file: string, ...edits: readonly (readonly [string, string])[]): string {
  return brokenOf("folder", file, ...edits);
}

function brokenOf(kind: string, file: string, ...edits: readonly (readonly [string, string])[]): string {
  const dir = mkdtempSync(join(tmpdir(), `conformance-acquirers-${kind}-`));
  temps.push(dir);
  cpSync(join(TEMPLATES, kind), dir, { recursive: true });
  let text = readFileSync(join(dir, file), "utf8");
  for (const [from, to] of edits) {
    if (!text.includes(from)) throw new Error(`the ${kind} template's ${file} no longer holds ${JSON.stringify(from)}: break it anew`);
    text = text.replaceAll(from, to);
  }
  writeFileSync(join(dir, file), text);
  return dir;
}

const said = (lines: readonly string[]) => lines.filter((line) => !/ (?:edits|removals|reaches the day): (?:[-+…] |\d{4}-|search |open |the day and search )/u.test(line));

const folderProved = (dir = join(TEMPLATES, "folder")) => proved("example-folder", { dir, settings: {} });


describe("an acquirer's cases in `lifestream connectors test`", () => {
  it("passes an acquirer that seals what it finished with backoff_ms and throws NotYet where it finished nothing, every case run", async () => {
    const { faults, lines } = await proved("synthetic-good");
    expect(faults).toEqual([]);
    expect(said(lines)).toEqual([
      "synthetic-good lands new: run, 2 calls, 12 items added after its first fetch, 12 records",
      "synthetic-good lands at a sealed time: run, item 24 stamped 2026-09-15T23:00:00.000Z, the newest sealed item's time, landed",
      `synthetic-good lands history: run, ${12 / PAGE} pages, 12 items`,
      `synthetic-good keeps to its start: run, lent 2026-09-14 over 48 old items, 12 of them dated before it: ${36 / PAGE} pages landed none of those`,
      "synthetic-good a fetch keeps to its start: run, lent 2026-09-14: its fetches landed none of the 12 items its fake dates before it, item 96, added after its first fetch, among them",
      "synthetic-good reads the gap when its start moves earlier: run, 2026-09-14 moved to 2026-09-13: the 12 items dated between them landed",
      `synthetic-good lands nothing older when its start moves later: run, 2026-09-13 for one page, then 2026-09-14: ${36 / PAGE} pages after the move landed none of the 12 items dated before it, ending at \`left: 0\``,
      "synthetic-good reads the gap when its start moves later, then back: run, 2026-09-13 for one page, 2026-09-14 to the walk's end, then 2026-09-13 again: all 48 old items landed",
      "synthetic-good replays: run, no new version",
      "synthetic-good edits: run, the edited item landed one new version",
      "synthetic-good removals: run, nothing changed: the source states no removals",
      expect.stringMatching(/^synthetic-good cursor stays bounded: run, \d+ bytes at 24 items, \d+ at 96$/u),
      "synthetic-good waits out a limit: run, first fetch walk (NotYet), fetch walk (backoff_ms), page walk (NotYet)",
      "synthetic-good signs out: run, NeedsYou signed-out",
      "synthetic-good refreshes: not run (no `client` sign-in route)",
      expect.stringMatching(/^synthetic-good reaches the day: run, 24 records read to \d+ days and search$/u),
    ]);
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/^synthetic-good edits: - \d{4}-\d{2}-\d{2} .*“Synthetic note 23” /u),
      expect.stringMatching(/^synthetic-good edits: \+ \d{4}-\d{2}-\d{2} .*“Synthetic note 23 \(edited\)” /u),
      expect.stringMatching(/^synthetic-good edits: \+ search note note-0023: Synthetic note 23 \(edited\)/u),
      expect.stringMatching(/^synthetic-good reaches the day: \d{4}-\d{2}-\d{2} .*“Synthetic note 0” /u),
      expect.stringMatching(/^synthetic-good reaches the day: search note note-0000: /u),
    ]));
    expect(lines.filter((line) => line.startsWith("synthetic-good removals: "))).toHaveLength(1);
  });

  it("fails an acquirer whose real output its adapter reads as nothing: reaches the day", async () => {
    const { faults, lines } = await proved("synthetic-untitled");
    expect(faults).toEqual([expect.stringMatching(/^acquirers\.synthetic-untitled: reaches the day: adapters\.synthetic-untitled\.notes: reads 24 note records as nothing \(note-\d+, note-\d+, note-\d+, …\): no day prints them and no search finds them \(one its adapter leaves out on purpose, test\/fixture\.ts names in `export const skipped = \["<kind> <key>"\]`\)$/u)]);
    expect(lines.filter((line) => line.includes("lands new: run"))).toHaveLength(1);
  });

  it("fails an acquirer that seals a delivery, or throws NotYet, where nothing is new: replays", async () => {
    const resends = await proved("synthetic-resends");
    expect(resends.faults).toEqual([`acquirers.synthetic-resends: replays: nothing changed at the provider, and its fetch sealed a delivery: ${NOTHING_NEW_RULE}`]);
    const idles = await proved("synthetic-idles");
    expect(idles.faults).toContainEqual(`acquirers.synthetic-idles: replays: nothing changed at the provider, and its fetch threw \`NotYet\`: ${NOTHING_NEW_RULE}`);
  });

  it("fails an acquirer whose answered: false says otherwise than whether its call made a request: says its contact", async () => {
    const deaf = await proved("synthetic-deaf");
    expect(deaf.faults).toEqual([expect.stringMatching(new RegExp(`^acquirers\\.synthetic-deaf: says its contact: its fetch made \\d+ requests? and said \`answered: false\`: ${literal(ANSWERED_RULE)}$`, "u"))]);
    const mute = await proved("synthetic-mute");
    expect(mute.faults).toContainEqual(`acquirers.synthetic-mute: says its contact: its fetch made no request and did not say \`answered: false\`: ${ANSWERED_RULE}`);
  });

  it("fails an acquirer whose facts state history, which only the home states of a page", async () => {
    const { faults } = await proved("synthetic-history");
    expect(faults).toEqual([`acquirers.synthetic-history: lands new: its fetch threw "acquirer synthetic-history's facts state history, which only the home states of a page"`]);
  });

  it("reads a delivery by the reader of the source it delivered, not its connector's first", () => {
    const connector = {
      id: "synthetic-paired", sources: [{ id: "synthetic-paired:<account>:cloud", read: "synthetic-paired-api", arrives: "poll" }, { id: "synthetic-paired:<account>:export", read: "synthetic-paired-export", arrives: "upload" }],
    } as unknown as Connector;
    expect([readerOf(connector, `synthetic-paired:${ACCOUNT}:export`), readerOf(connector, `synthetic-paired:${ACCOUNT}:cloud`)]).toEqual(["synthetic-paired-export", "synthetic-paired-api"]);
  });

  it("fails an acquirer that requests through the global fetch as a direct call", async () => {
    const { faults } = await proved("synthetic-direct");
    expect(faults).toEqual([expect.stringMatching(/^acquirers\.synthetic-direct: lands new: it requests https:\/\/api\.example\.com\/v1\/notes\S* through the global fetch, a direct call/u)]);
  });

  it("fails an acquirer whose cursor grows with its items: cursor stays bounded", async () => {
    const { faults } = await proved("synthetic-grows");
    expect(faults).toEqual([expect.stringMatching(/^acquirers\.synthetic-grows: cursor stays bounded: its cursor after the fetch walk is \d+ bytes at 24 items and \d+ at 96: a field that grows with the items belongs in the poll's memory/u)]);
  });

  it("fails an acquirer whose first call's cursor grows with the items, though its next call replaces it: cursor stays bounded", async () => {
    const { faults } = await proved("synthetic-grows-first");
    expect(faults).toEqual([expect.stringMatching(/^acquirers\.synthetic-grows-first: cursor stays bounded: its cursor after the first fetch walk is \d+ bytes at 12 items and \d+ at 48: a field that grows with the items belongs in the poll's memory/u)]);
  });

  it("fails an acquirer whose fetch lands the old items where the new were owed and whose history lands the new, the counts adding up: lands new", async () => {
    const { faults, lines } = await proved("synthetic-backwards");
    expect(faults).toEqual(["acquirers.synthetic-backwards: lands new: none of the 12 items added after its first fetch landed; it landed old items 0–11 instead, which the source held at its first fetch (an item is new when the scenario adds it after the run's first fetch, whatever time its record states)"]);
    expect(lines).toEqual([]);
  });

  it("fails an acquirer that loses its cursor past a 429 in its first call, the item added at the stream's start never landing: waits out a limit (first fetch walk)", async () => {
    const { faults, lines } = await proved("synthetic-loses-first");
    expect(faults).toEqual(["acquirers.synthetic-loses-first: waits out a limit (first fetch walk): after the 429 at its first fetch's request 1, 1 of the 12 items added later never landed at its next fetch (item 12): the cursor its first call began goes with the wait (afterStop keeps it in `NotYet`'s state)"]);
    expect(lines.some((line) => line.includes("waits out a limit: run"))).toBe(false);
  });

  it("fails an acquirer that loses the rest after a 429, in each walk", async () => {
    const { faults, lines } = await proved("synthetic-loses");
    expect(faults).toEqual([
      expect.stringMatching(/^acquirers\.synthetic-loses: waits out a limit \(first fetch walk\): met a 429 at its request 1 and carried no wait/u),
      expect.stringMatching(/^acquirers\.synthetic-loses: waits out a limit \(fetch walk\): met a 429 at its request 3 and carried no wait/u),
      expect.stringMatching(/^acquirers\.synthetic-loses: waits out a limit \(page walk\): met a 429 at its request 3 and carried no wait/u),
    ]);
    expect(lines.some((line) => line.includes("waits out a limit: run"))).toBe(false);
  });

  it("fails an acquirer whose page drops the second page's old items: lands history, with the count it missed", async () => {
    const { faults } = await proved("synthetic-drops");
    expect(faults).toContain(`acquirers.synthetic-drops: lands history: ${12 / PAGE} pages landed ${12 - PAGE} of the 12 old items, items ${PAGE}–${2 * PAGE - 1} missed (an item is old when the source held it at the run's first fetch, the scenario's first \`old\`, whatever time its record states)`);
    expect(faults.filter((fault) => !/: (?:lands history|waits out a limit \(page walk\)|reads the gap when its start moves (?:earlier|later, then back)): /u.test(fault))).toEqual([]);
  });

  it("fails an acquirer whose page lands what its fake dates before the start the home lent it: keeps to its start", async () => {
    const { faults } = await proved("synthetic-unfloored");
    expect(faults).toEqual([
      `acquirers.synthetic-unfloored: keeps to its start: lent the start 2026-09-14, its ${48 / PAGE} pages landed items 0–11, which its fake dates before it: ${START_RULE}`,
      `acquirers.synthetic-unfloored: lands nothing older when its start moves later: lent 2026-09-13 for one page, then 2026-09-14, its ${48 / PAGE} pages after the move landed items ${PAGE}–11, which its fake dates before it: ${LATER_RULE}`,
    ]);
  });

  it("fails an acquirer whose first fetch reads its source whole, past the start the home lent it: a fetch keeps to its start", async () => {
    const { faults } = await proved("synthetic-whole-first");
    expect(faults).toContain(`acquirers.synthetic-whole-first: a fetch keeps to its start: lent the start 2026-09-14, its fetches landed items 0–11, which its fake dates before it: ${FETCH_START_RULE}`);
    expect(faults.filter((fault) => fault.includes(": a fetch keeps to its start: "))).toHaveLength(1);
  });

  it("fails an acquirer that reads a start moved earlier only in its page, when a fetch ran first and left the cursor at the new start: reads the gap", async () => {
    const { faults } = await proved("synthetic-page-only");
    expect(faults).toEqual([
      `acquirers.synthetic-page-only: reads the gap when its start moves earlier: lent 2026-09-14 moved to 2026-09-13, it never landed items 0–11, which its fake dates between them: ${EARLIER_RULE}`,
      `acquirers.synthetic-page-only: reads the gap when its start moves later, then back: lent 2026-09-13 for one page, 2026-09-14 to the walk's end, then 2026-09-13 again, it never landed items ${PAGE}–11, which its fake dates from 2026-09-13 on: ${BACK_RULE}`,
    ]);
  });

  it("fails an acquirer that keeps the earliest start it was lent instead of comparing with the cursor's: reads the gap when its start moves later, then back", async () => {
    const { faults } = await proved("synthetic-own-start");
    expect(faults).toEqual([`acquirers.synthetic-own-start: reads the gap when its start moves later, then back: lent 2026-09-13 for one page, 2026-09-14 to the walk's end, then 2026-09-13 again, it never landed items ${PAGE}–14, which its fake dates from 2026-09-13 on: ${BACK_RULE}`]);
  });

  it("passes an acquirer that says months and counts its whole source on the first page of its walk, and fails one whose every page counts: counts its months", async () => {
    const counts = await proved("synthetic-counts");
    expect(counts.faults).toEqual([]);
    expect(counts.lines).toContain(`synthetic-counts counts its months: run, its first page counted 24 items in 1 month, as its walks landed them; its other ${12 / PAGE - 1} pages answered none`);
    const every = await proved("synthetic-counts-every");
    expect(every.faults).toEqual([`acquirers.synthetic-counts-every: counts its months: pages ${Array.from({ length: 12 / PAGE }, (_, at) => at + 1).join(", ")} of its walk answered \`months\`, the first alone does: ${MONTHS_RULE}`]);
    expect((await proved("synthetic-good")).lines.filter((line) => line.includes("counts its months"))).toEqual([]);
  });

  it("passes acquirers whose records are dated by their day alone, or by when they are due: old and new are the scenario's", async () => {
    for (const id of ["synthetic-daily", "synthetic-due"]) {
      const { faults, lines } = await proved(id);
      expect(faults, id).toEqual([]);
      expect(lines, id).toContain(`${id} lands new: run, 2 calls, 12 items added after its first fetch, 12 records`);
      expect(lines, id).toContain(`${id} lands history: run, ${12 / PAGE} pages, 12 items`);
      expect(lines.filter((line) => line.includes("not run")), id).toEqual([`${id} refreshes: not run (no \`client\` sign-in route)`]);
    }
  });

  it("fails an acquirer whose fetch lands nothing the provider adds, saying how an item is new: lands new", async () => {
    const { faults, lines } = await proved("synthetic-blind");
    expect(faults).toEqual(["acquirers.synthetic-blind: lands new: none of the 12 items added after its first fetch landed (an item is new when the scenario adds it after the run's first fetch, whatever time its record states)"]);
    expect(lines).toEqual([]);
  });

  it("prints lands history as not run, with its reason, for an acquirer with no page", async () => {
    const { faults, lines } = await proved("synthetic-nopage");
    expect(faults).toEqual([]);
    expect(lines).toContain("synthetic-nopage lands history: not run (no `page`: it has no history behind what `fetch` reads)");
    expect(lines).toContain("synthetic-nopage waits out a limit: run, first fetch walk (NotYet), fetch walk (backoff_ms)");
  });

  it(`stops a walk past ${WALK_CALLS} calls and names it`, async () => {
    const { faults, lines } = await proved("synthetic-endless");
    expect(faults).toEqual([`acquirers.synthetic-endless: lands new: its fetch walk still said \`more\` after ${WALK_CALLS} calls: a walk ends`]);
    expect(lines).toEqual([]);
  });

  it("prints signs out as not run, with its reason, for a connector with no sign-in route and no secret field", async () => {
    const { faults, lines } = await proved("synthetic-open");
    expect(faults).toEqual([]);
    expect(lines).toContain("synthetic-open signs out: not run (no sign-in route, no secret field)");
  });

  it("fails an acquirer whose fixture exports no provider", async () => {
    const { faults, lines } = await proved("synthetic-unfaked", { dir: unfaked() });
    expect(faults).toEqual(["acquirers.synthetic-unfaked: its acquirer would meet its first input in Lifestream: export `provider` from test/fixture.ts (templates/api), or `mailbox` for one that reads mail over IMAP"]);
    expect(lines).toEqual([]);
  });

  it("fails an acquirer whose fixture exports no item, or one whose item names no item of the scenario", async () => {
    const unitemed = await proved("synthetic-good", { dir: unfaked('export { fixtures, provider, secrets } from "./faked.js";\n') });
    expect(unitemed.faults).toEqual(["acquirers.synthetic-good: its walks are read by the items they land: export `item` from test/fixture.ts, which item of the scenario a record it lands is, by its kind and key (ItemOf; templates/api)"]);
    expect(unitemed.lines).toEqual([]);
    const misread = await proved("synthetic-good", { dir: unfaked('export { dated, fixtures, provider, secrets } from "./faked.js";\nexport const item = ({ key }) => Number(key.slice(5)) + 100;\n') });
    expect(misread.faults).toEqual([expect.stringMatching(/^acquirers\.synthetic-good: lands new: test\/fixture\.ts: its item names 1\d\d for note note-00\d\d, while the scenario holds items 0 to 23: `item` names the item a record is by the number its fake gave it, null for a record no item makes$/u)]);
  });

  it("fails an acquirer that judges new by time alone: an item stamped at the newest sealed item's time never lands", async () => {
    const { faults } = await proved("synthetic-by-time");
    expect(faults).toEqual([`acquirers.synthetic-by-time: lands at a sealed time: item 24, added after its last fetch and stamped 2026-09-15T23:00:00.000Z, the time of the newest item that fetch sealed, never landed: ${STAMPED_RULE}`]);
  });

  it("fails a fixture whose dated puts a stamped item elsewhere, and runs no stamp where dated names none", async () => {
    const elsewhere = await proved("synthetic-good", { dir: unfaked('import { dated as own } from "./faked.js";\nexport { fixtures, item, provider, secrets } from "./faked.js";\nexport const dated = (scenario, n) => own({ ...scenario, stamped: undefined }, n);\n') });
    expect(elsewhere.faults).toEqual(["acquirers.synthetic-good: lands at a sealed time: test/fixture.ts: its dated names 1789516800000 for item 24, which the scenario stamps at 2026-09-15T23:00:00.000Z: a fake dates an item `scenario.stamped` names at that time, or `dated` names null where its source holds one item at a time"]);
    const one = await proved("synthetic-good", { dir: unfaked('import { dated as own } from "./faked.js";\nexport { fixtures, item, provider, secrets } from "./faked.js";\nexport const dated = (scenario, n) => (scenario.stamped?.[n] === undefined ? own(scenario, n) : null);\n') });
    expect(one.faults).toEqual([]);
    expect(one.lines).toContain("synthetic-good lands at a sealed time: not run (test/fixture.ts's `dated` names no time for item 24, stamped at 2026-09-15T23:00:00.000Z: its source holds one item at a time)");
  });

  it("fails an acquirer with a page whose fixture exports no dated, or one whose dated names no time", async () => {
    const undated = await proved("synthetic-good", { dir: unfaked('export { fixtures, item, provider, secrets } from "./faked.js";\n') });
    expect(undated.faults).toEqual(["acquirers.synthetic-good: its history is walked from the start the home lends its `page`: export `dated` from test/fixture.ts, when its fake dates item n of the scenario, in ms since the epoch (templates/api)"]);
    expect(undated.lines).toEqual([]);
    const misdated = await proved("synthetic-good", { dir: unfaked('export { fixtures, item, provider, secrets } from "./faked.js";\nexport const dated = () => "yesterday";\n') });
    expect(misdated.faults).toEqual(['acquirers.synthetic-good: lands new: test/fixture.ts: its dated names "yesterday" for item 0: `dated` is when its fake dates an item, in ms since the epoch']);
  });
});

describe("a sign-in's refresh in `lifestream connectors test`", () => {
  it("passes a client route's acquirer that refreshes an expired access token, keeps and sends the rotated refresh token, and signs out on invalid_grant", async () => {
    const { faults, lines } = await proved("synthetic-oauth");
    expect(faults).toEqual([]);
    expect(lines).toContain("synthetic-oauth refreshes: run, refreshed and landed, the rotated refresh token kept and sent, invalid_grant signed out");
    expect(lines).toContain("synthetic-oauth signs out: run, NeedsYou signed-out");
  });

  it("fails one that sends the credential's access token itself: it never refreshes", async () => {
    const { faults } = await proved("synthetic-bearer");
    expect(faults).toEqual([expect.stringMatching(/^acquirers\.synthetic-bearer: refreshes: its access token had expired and it never asked https:\/\/auth\.example\.com\/oauth\/token: /u)]);
  });

  it("fails one that drops the rotated refresh token", async () => {
    const { faults } = await proved("synthetic-unrotated");
    expect(faults).toEqual([expect.stringMatching(/^acquirers\.synthetic-unrotated: refreshes: https:\/\/auth\.example\.com\/oauth\/token answered a new refresh token and the vault still holds the old one: /u)]);
  });

  it("fails one that does not end signed out when the token endpoint answers 400 invalid_grant", async () => {
    const { faults } = await proved("synthetic-swallows");
    expect(faults).toContain("acquirers.synthetic-swallows: refreshes: https://auth.example.com/oauth/token answered 400 invalid_grant and the API 401, and its fetch threw \"Synthetic refused the sign-in\"; its page threw \"Synthetic refused the sign-in\": a refused refresh throws `NeedsYou` `signed-out` (the request loop's refresher does), nothing sealed");
  });
});

describe("an export handed in, in `lifestream connectors test`", () => {
  it("the export template hands in, replays nothing new, lands one version of an edited item and says a removal, each change as the day and search show it", async () => {
    const { faults, lines } = await proved("example-export", { dir: join(TEMPLATES, "export"), settings: {} });
    expect(faults).toEqual([]);
    expect(said(lines)).toEqual([
      `example-export hands in: run, a .zip of 2 files handed in, one delivery of example:${ACCOUNT}:export, 24 records`,
      "example-export replays: run, the same export handed in again, already in: nothing read",
      "example-export edits: run, the edited item landed one new version",
      "example-export removals: run, nothing changed: the export states no removals",
      expect.stringMatching(/^example-export reaches the day: run, 24 records read to \d+ days and search$/u),
    ]);
    const changed = lines.filter((line) => line.startsWith("example-export edits: "));
    expect(changed).toContainEqual(expect.stringMatching(/^example-export edits: - \d{4}-\d{2}-\d{2} .*“Synthetic note 24” /u));
    expect(changed).toContainEqual(expect.stringMatching(/^example-export edits: \+ \d{4}-\d{2}-\d{2} .*“Synthetic note 24, edited” /u));
    expect(lines).toContainEqual(expect.stringMatching(/^example-export reaches the day: \d{4}-\d{2}-\d{2} \S+ /u));
  });

  it("fails a copy of the export template whose download never changes an edited item: edits", async () => {
    const dir = brokenOf("export", join("test", "fixture.ts"), ["return scenario.edited.includes(n) ? { ...written, title: `${written.title}, edited` } : written;", "return written;"]);
    const { faults } = await proved("example-export", { dir, settings: {} });
    expect(faults).toEqual(["acquirers.example-export: edits: item 23 edited, the export handed in after landed no new version of it: the edited item lands a new version, and nothing else does"]);
  });

  it("says edits and removals not run for a fixture that names no item, saying how to name one", async () => {
    const dir = brokenOf("export", join("test", "fixture.ts"), ["export const item: ItemOf", "const item: ItemOf"]);
    const { faults, lines } = await proved("example-export", { dir, settings: {} });
    expect(faults).toEqual([]);
    expect(lines.filter((line) => line.includes("not run"))).toEqual([
      expect.stringMatching(/^example-export edits: not run \(no `item` in test\/fixture\.ts: .*templates\/export\)$/u),
      expect.stringMatching(/^example-export removals: not run \(no `item` in test\/fixture\.ts: /u),
    ]);
  });
});

describe("the child the cases run in", () => {
  it(`kills a case that never ends at its time (${CASE_MS / 1000} s on a home) and names it, the cases after it not run`, async () => {
    const { faults, lines } = await proved("synthetic-spins", { limits: { case_ms: 1_000, run_ms: RUN_MS } });
    expect(faults).toEqual([expect.stringMatching(/^acquirers\.synthetic-spins: lands new: did not end in 1 s and was killed: /u)]);
    expect(lines).toEqual(["synthetic-spins the cases after lands new: not run (the run ended at lands new)"]);
  });

  it("refuses a connection the acquirer opens itself and names it", async () => {
    const { faults } = await proved("synthetic-connects");
    expect(faults).toEqual([expect.stringMatching(/^acquirers\.synthetic-connects: lands new: it connects to api\.example\.com:443 outside `fetch` and `imap`, refused: /u)]);
  });
});

describe("the templates as they ship, through every case they have", () => {
  it("the oauth template refreshes, and passes every case", async () => {
    const { faults, lines } = await proved("example-oauth", { dir: join(TEMPLATES, "oauth"), settings: { account: ACCOUNT, signin: "example-oauth.signin" } });
    expect(faults).toEqual([]);
    expect(lines).toContain("example-oauth refreshes: run, refreshed and landed, the rotated refresh token kept and sent, invalid_grant signed out");
    expect(lines.filter((line) => line.includes("not run"))).toEqual([]);
  });

  it("the browser template's recipe lands, replays nothing new and throws NeedsYou signed out of its site, over the in-memory station", async () => {
    const { faults, lines } = await proved("example-browser", { dir: join(TEMPLATES, "browser"), settings: {} });
    expect(faults).toEqual([]);
    expect(lines).toEqual(expect.arrayContaining([
      "example-browser lands new: run, 2 calls, 12 items added after its first fetch, 12 records",
      "example-browser replays: run, no new version",
      "example-browser signs out: run, a signed-out site, every page sent to https://notes.example.com/login, a sign-in there refused, no session held and every request answered 401: NeedsYou signed-out",
    ]));
  });

  it("sends a signed-out site's every page to its connector's sign-in origin, where it declares one", async () => {
    const dir = brokenOf("browser", "connector.ts", ['chrome: { origin: "https://notes.example.com", ', 'chrome: { origin: "https://notes.example.com", signin: { origin: "https://login.example.com" }, ']);
    const { faults, lines } = await proved("example-browser", { dir, settings: {} });
    expect(faults).toEqual([]);
    expect(lines).toContain("example-browser signs out: run, a signed-out site, every page sent to https://login.example.com/, a sign-in there refused, no session held and every request answered 401: NeedsYou signed-out");
  });
});

describe("an acquirer's `who` in `lifestream connectors test`", () => {
  const PROBE = 'probe: { url: "/api/me", has: "id", who: { id: "id", email: "email" } }';
  const ACQUIRERS = '{ "example-browser": exampleBrowserAcquirer }';
  const whoFaults = (faults: readonly string[]) => faults.filter((fault) => fault.startsWith("acquirers.example-browser: who: "));

  it("passes a site whose connector declares `chrome.probe: null` and whose recipe gives its acquirer `who`", async () => {
    const { faults } = await proved("example-browser", { dir: brokenOf("browser", "connector.ts", [PROBE, "probe: null"]), settings: {} });
    expect(whoFaults(faults)).toEqual([]);
  });

  it("fails an acquirer with no `who` whose connector declares `chrome.probe: null`", async () => {
    const dir = brokenOf("browser", "connector.ts", [PROBE, "probe: null"]);
    const index = join(dir, "index.ts");
    writeFileSync(index, readFileSync(index, "utf8").replace(ACQUIRERS, '{ "example-browser": (settings, dependencies) => ({ ...exampleBrowserAcquirer(settings, dependencies), who: undefined }) }'));
    const { faults } = await proved("example-browser", { dir, settings: {} });
    expect(whoFaults(faults)).toEqual([`acquirers.example-browser: who: it has no \`who\`, and example-browser declares \`chrome.probe: null\`, so the home never learns whose account Chrome holds (${WHO_RULE})`]);
  });

  it("fails an acquirer with `who` whose connector declares a probe", async () => {
    const dir = brokenOf("browser", "index.ts", [ACQUIRERS, '{ "example-browser": (settings, dependencies) => ({ ...exampleBrowserAcquirer(settings, dependencies), who: async () => ({ id: "user-0001" }) }) }']);
    const { faults } = await proved("example-browser", { dir, settings: {} });
    expect(whoFaults(faults)).toEqual([`acquirers.example-browser: who: it has \`who\`, and example-browser declares a \`chrome.probe\`, so the home never asks it (${WHO_RULE})`]);
  });

  it("fails `who` on a site's second lane, which the home never asks, and passes that lane with none", async () => {
    const twoLanes = (second: string) => {
      const dir = brokenOf("browser", "connector.ts", [PROBE, "probe: null"], ['acquirers: ["example-browser"]', 'acquirers: ["example-browser", "example-browser-two"]']);
      const index = join(dir, "index.ts");
      writeFileSync(index, readFileSync(index, "utf8").replace(ACQUIRERS, `{ "example-browser": exampleBrowserAcquirer, "example-browser-two": ${second} }`));
      return dir;
    };
    const secondFaults = (faults: readonly string[]) => faults.filter((fault) => fault.startsWith("acquirers.example-browser-two: who: "));
    const asked = await proved("example-browser-two", { dir: twoLanes("exampleBrowserAcquirer"), settings: {} });
    expect(secondFaults(asked.faults)).toEqual([`acquirers.example-browser-two: who: it has \`who\`, and example-browser is its site's first lane, not example-browser-two, so the home never asks it (${WHO_RULE})`]);
    const unasked = await proved("example-browser-two", { dir: twoLanes("(settings, dependencies) => ({ ...exampleBrowserAcquirer(settings, dependencies), who: undefined })"), settings: {} });
    expect(secondFaults(unasked.faults)).toEqual([]);
  });
});

describe("a folder poll's cases, over its files written in a scratch folder", () => {
  it("the folder template lands every file, replays nothing new even touched, edits once, states a removal gone and its cursor stays bounded; history, a limit and a sign-in not run", async () => {
    const { faults, lines } = await folderProved();
    expect(faults).toEqual([]);
    expect(said(lines)).toEqual([
      "example-folder lands new: run, 2 calls, 12 files there at its first fetch and 12 added after it, 24 records",
      "example-folder lands at a sealed time: run, item 24 stamped 2026-09-15T12:23:00.000Z, the newest sealed item's time, landed",
      "example-folder lands history: not run (a folder poll: its fetch walks the whole folder, so no history lies behind it)",
      "example-folder a fetch keeps to its start: run, lent 2026-09-14: its fetches landed none of the 4 items its fake dates before it, item 24, added after its first fetch and item 0, edited after it, among them",
      "example-folder reads the gap when its start moves earlier: run, 2026-09-14 moved to 2026-09-13: the 3 items dated between them landed",
      "example-folder lands nothing older when its start moves later: not run (no `page`: its first fetch reads its history whole, so a start moved later has nothing left to stop)",
      "example-folder reads the gap when its start moves later, then back: not run (no `page`: its first fetch reads its history whole, so a start moved later has nothing left to stop)",
      "example-folder replays: run, nothing sealed, nor with every file touched",
      "example-folder edits: run, the edited item landed one new version",
      "example-folder removals: run, the removed item went gone",
      "example-folder cursor stays bounded: run, 2 bytes at 24 items, 2 at 96",
      "example-folder waits out a limit: not run (a folder poll requests nothing: no provider's limit to wait out)",
      "example-folder signs out: not run (a folder poll reads the Mac's own files: nothing to sign in to)",
      expect.stringMatching(/^example-folder reaches the day: run, 23 records read to \d+ days and search$/u),
    ]);
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/^example-folder removals: - \d{4}-\d{2}-\d{2} .*“note-012” /u),
      expect.stringMatching(/^example-folder removals: - search note notes\/note-012\.md: /u),
    ]));
  });

  it("fails a folder whose adapter states a value its family relies on otherwise, in the rule's words: reaches the day", async () => {
    const { faults } = await folderProved(broken("index.ts", ['{ "example-folder": { notes } }',
      '{ "example-folder": { notes, money: { version: "1", kinds: notes.kinds, txn: () => ({ date: "2026-09-14", debit: "12.5", closing_balance: "100.00", currency: "XTS", narration: "A synthetic line" }) } } }']));
    expect(faults).toEqual(expect.arrayContaining([
      expect.stringMatching(/^acquirers\.example-folder: reaches the day: adapters\.example-folder\.money\.txn: note notes\/note-\d+\.md: `debit` is an amount of two decimals with no sign, thousands mark or leading zero, such as `1250\.00`: `12\.5` is none$/u),
      expect.stringMatching(/^acquirers\.example-folder: reaches the day: adapters\.example-folder\.money\.txn: \d+ more values like these break its family's rules$/u),
    ]));
  });

  it("holds a money adapter that states no txn to the same rules, over the record's content it reads as the line", async () => {
    const { faults } = await folderProved(broken("index.ts", ['{ "example-folder": { notes } }', '{ "example-folder": { notes, money: { version: "1", kinds: notes.kinds } } }']));
    expect(faults).toEqual(expect.arrayContaining([
      expect.stringMatching(/^acquirers\.example-folder: reaches the day: adapters\.example-folder\.money\.txn: note notes\/note-\d+\.md: a line states exactly one of `debit` and `credit`: it states neither$/u),
    ]));
  });

  it("holds an edit to one new version, and where the fixture exports `immutable`, to none", async () => {
    const unedited = ["bytes: noteText(n, scenario.edited.includes(n))", "bytes: noteText(n)"] as const;
    const stated = ["export const fixtures", "export const immutable = true;\nexport const fixtures"] as const;
    const held = await folderProved(brokenOf("folder", join("test", "fixture.ts"), unedited));
    expect(held.faults).toEqual([expect.stringMatching(/^acquirers\.example-folder: edits: item 23 edited, its fetch landed no new version of it: /u)]);
    const edited = await folderProved(brokenOf("folder", join("test", "fixture.ts"), stated));
    expect(edited.faults).toEqual([
      "acquirers.example-folder: edits: item 23 edited, its fetch landed 1 record new or as another version (item 23): test/fixture.ts exports `immutable`: its source's items never change once captured, so an edit lands nothing",
    ]);
    const immutable = await folderProved(brokenOf("folder", join("test", "fixture.ts"), unedited, stated));
    expect(immutable.faults).toEqual([]);
    expect(said(immutable.lines).filter((line) => / (?:edits|removals): /u.test(line))).toEqual([
      "example-folder edits: run, the edited item landed nothing new (test/fixture.ts exports `immutable`: its source's items never change once captured)",
      "example-folder removals: run, the removed item went gone",
    ]);
  });

  it("fails a copy that seals a file again when it is only touched, its bytes the same: replays", async () => {
    const { faults } = await folderProved(broken("acquirer.ts", ["        if (known?.sha256 === sha256) continue;\n", ""]));
    expect(faults).toEqual(["acquirers.example-folder: replays: every file touched, its bytes the same, and its fetch sealed 25 files again: a file whose bytes did not change seals nothing (the poll's memory holds each file's digest)"]);
  });

  it("fails a copy that seals every file again at each poll, nothing changed: replays", async () => {
    const { faults } = await folderProved(broken("acquirer.ts",
      ["        if (known?.size === each.size && known.modified_ms === each.modified_ms) continue;\n", ""],
      ["        if (known?.sha256 === sha256) continue;\n", ""]));
    expect(faults).toEqual(["acquirers.example-folder: replays: nothing changed in the folder, and its fetch sealed 25 files again: a file whose bytes did not change seals nothing (the poll's memory holds each file's digest)"]);
  });

  it("fails a copy that states another file gone when one is edited: edits", async () => {
    const { faults } = await folderProved(broken("acquirer.ts",
      ["      let more = false;\n", "      let more = false;\n      let edited: string | undefined;\n"],
      ["        if (known?.sha256 === sha256) continue;\n", "        if (known?.sha256 === sha256) continue;\n        if (known !== undefined) edited = each.path;\n"],
      ["      const gone = goneFrom(lent.memory, present);\n", "      const gone = goneFrom(lent.memory, present);\n      const other = found.find((each) => each.path !== edited)?.path;\n      if (edited !== undefined && other !== undefined) gone.push(other);\n"]));
    expect(faults[0]).toBe("acquirers.example-folder: edits: item 23 edited, its fetch stated records of item 0 gone: the edited item lands a new version, and nothing else does");
  });

  it("fails a copy that never states a deleted file gone: removals", async () => {
    const { faults } = await folderProved(broken("acquirer.ts", ["const gone = goneFrom(lent.memory, present);", "const gone: string[] = [];"]));
    expect(faults).toEqual(["acquirers.example-folder: removals: a file deleted from the folder was never stated gone: a folder poll states a removal, a path its memory holds (lent.memory) that its walk no longer finds"]);
  });

  it("fails a copy that reads two records of each file and states only one gone when the file is deleted: removals", async () => {
    const dir = broken("reader.ts", ["        time: modified.start_ms > created.start_ms ? spanOf(created, modified, listed.path) : modified, locator: listed.file,\n      }];",
      "        time: modified.start_ms > created.start_ms ? spanOf(created, modified, listed.path) : modified, locator: listed.file,\n      }, {\n        kind: NOTE, key: `${listed.path}#copy`, content: { type: \"example.note\", path: `${listed.path}#copy`, text: utf8(files.bytes(blob), listed.path) },\n        time: modified, locator: listed.file,\n      }];"]);
    const fixture = join(dir, "test", "fixture.ts");
    const text = readFileSync(fixture, "utf8");
    expect(text).toContain(String.raw`/^notes\/note-(\d+)\.md$/u`);
    writeFileSync(fixture, text.replace(String.raw`/^notes\/note-(\d+)\.md$/u`, String.raw`/^notes\/note-(\d+)\.md(?:#copy)?$/u`));
    const { faults } = await folderProved(dir);
    expect(faults).toEqual(["acquirers.example-folder: removals: item 12 removed, and 1 of its 2 records still live (note notes/note-012.md#copy): a removal states every record of the removed item gone"]);
  });

  it("fails a copy whose cursor holds every path it walked: cursor stays bounded", async () => {
    const { faults } = await folderProved(broken("acquirer.ts", ["state: {}", "state: { walked: found.map((each) => each.path) }"]));
    expect(faults).toEqual([expect.stringMatching(/^acquirers\.example-folder: cursor stays bounded: its cursor after the first fetch walk is \d+ bytes at 12 items and \d+ at 48: a field that grows with the items belongs in the poll's memory/u)]);
  });

  it("fails preview of a copy whose adapter reads its notes as nothing in test's words: reaches the day", async () => {
    const dir = broken("adapter.ts", ["function note(record: InputRecord): Note | null {\n", "function note(record: InputRecord): Note | null {\n  if (isObject(record.version)) return null;\n"]);
    const { faults: tested } = await folderProved(dir);
    const folder = join(mkdtempSync(join(tmpdir(), "conformance-acquirers-preview-")), "example-folder");
    temps.push(dirname(folder));
    cpSync(dir, folder, { recursive: true });
    const notes = mkdtempSync(join(tmpdir(), "conformance-acquirers-notes-"));
    temps.push(notes);
    writeFileSync(join(notes, "first.md"), "A synthetic note.\n");
    writeFileSync(join(notes, "second.md"), "Another synthetic note.\n");
    const preview = await previewFolder({ folder, sets: [`folder=${notes}`], cwd: notes, days: RELEASE_DAYS, unit: "macbook-pro-0001", out: () => undefined, input: async () => { throw new Error("this preview reads no secret"); } });
    const nothing = "adapters\\.example-folder\\.notes: reads \\d+ note records as nothing \\(.+\\): no day prints them and no search finds them \\(one its adapter leaves out on purpose, test/fixture\\.ts names in `export const skipped = \\[\"<kind> <key>\"\\]`\\)";
    expect(tested).toEqual([expect.stringMatching(new RegExp(`^acquirers\\.example-folder: reaches the day: ${nothing}$`, "u"))]);
    expect(preview.faults).toEqual([expect.stringMatching(new RegExp(`^${nothing}$`, "u"))]);
    expect(preview.faults[0]).toMatch(/reads 2 note records as nothing/u);
    const words = (fault: string) => fault.replace(/^acquirers\.example-folder: reaches the day: /u, "").replace(/\d+ note records as nothing \([^)]+\)/u, "N note records as nothing (…)");
    expect(words(preview.faults[0]!)).toBe(words(tested[0]!));
  });

  it("passes a fixture that dates no file, its files `{ bytes }` alone or their text: old and new are the scenario's", async () => {
    for (const undated of ["{ bytes: noteText(n, scenario.edited.includes(n)) }", "noteText(n, scenario.edited.includes(n))"]) {
      const { faults, lines } = await folderProved(broken("test/fixture.ts", ["{ bytes: noteText(n, scenario.edited.includes(n)), modified_ms: noteWritten(scenario, n) }", undated]));
      expect(faults, undated).toEqual([]);
      expect(lines, undated).toContain("example-folder lands new: run, 2 calls, 12 files there at its first fetch and 12 added after it, 24 records");
    }
  });

  it("says how many files `files(scenario)` wrote where its items are fewer, the poll passing over the rest: lands new", async () => {
    const { faults, lines } = await folderProved(broken("test/fixture.ts",
      ["Files => Object.fromEntries(", 'Files => ({ ".app/settings.json": "{}", ...Object.fromEntries('],
      ["modified_ms: noteWritten(scenario, n) }]),\n);", "modified_ms: noteWritten(scenario, n) }]),\n) });"]));
    expect(faults).toEqual([]);
    expect(lines).toContain("example-folder lands new: run, 2 calls, 12 files there at its first fetch and 12 added after it, 24 records (`files(scenario)` wrote 25 files for its 24 items)");
  });
});
