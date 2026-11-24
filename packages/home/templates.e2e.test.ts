import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Machine } from "./machine.js";
import { artifact, makeRoot, removeRoot } from "./test/harness-root.js";
import { REPO } from "./test/support.js";
import { conformanceOf, folderVerb } from "./verbs/connectors-folder.js";

const TEMPLATES = join(REPO, "packages", "connect", "templates");
const RELEASE_KINDS = ["label", "phone"];

const MOVED = ["lands nothing older when its start moves later", "reads the gap when its start moves later, then back"] as const;

const POLL = ["lands new", "lands at a sealed time", "lands history", "keeps to its start", "a fetch keeps to its start", "reads the gap when its start moves earlier", ...MOVED, "replays", "edits", "removals", "cursor stays bounded", "waits out a limit", "signs out"] as const;

const MATRIX: Readonly<Record<string, { run: readonly string[]; not: readonly string[] }>> = {
  api: { run: [...POLL, "reaches the day"], not: ["refreshes"] },
  oauth: { run: [...POLL, "refreshes", "reaches the day"], not: [] },
  browser: { run: [...POLL.filter((each) => each !== "waits out a limit"), "reaches the day"], not: ["waits out a limit"] },
  export: { run: ["hands in", "replays", "edits", "removals", "reaches the day"], not: [] },
  folder: {
    run: ["lands new", "lands at a sealed time", "a fetch keeps to its start", "reads the gap when its start moves earlier", "replays", "edits", "removals", "cursor stays bounded", "reaches the day"],
    not: ["lands history", ...MOVED, "waits out a limit", "signs out"],
  },
  "mac-app": { run: [], not: [] },
};

const HOME_KINDS = readdirSync(TEMPLATES, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !RELEASE_KINDS.includes(entry.name)).map((entry) => entry.name).sort();

describe("the home templates, as `new` writes them and `test` runs them", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) removeRoot(dir);
  });
  const home = () => {
    const root = makeRoot("lifestream-templates-", { sources: {} });
    const machine = { dir: mkdtempSync(join(tmpdir(), "lifestream-templates-machine-")) } as Machine;
    made.push(root, machine.dir);
    const lines: string[] = [];
    return { root, lines, ctx: { root, cwd: root, out: (line: string) => lines.push(line), machine } };
  };

  it("a home kind the matrix leaves out, or a row of a kind that is gone", () => {
    expect(Object.keys(MATRIX).sort()).toEqual(HOME_KINDS);
  });

  it("a template copied faults, prints no day or no search words, runs a case its kind does not meet, or leaves one it meets not run", async () => {
    const { root, ctx } = home();
    const ran: Record<string, { faults: string[]; run: string[]; not: string[]; day: boolean; search: boolean }> = {};
    for (const kind of HOME_KINDS) {
      const { folder } = await folderVerb(ctx, ["new", kind, `acme-${kind}`]) as { folder: string };
      const { faults, lines } = await conformanceOf(folder);
      const cases = (said: RegExp) => lines.flatMap((line) => said.exec(line)?.[1] ?? []);
      ran[kind] = {
        faults, run: cases(/^\S+ (.+?): run\b/u), not: cases(/^\S+ (.+?): not run \(/u),
        day: lines.some((line) => /^\d{4}-\d\d-\d\d /u.test(line)), search: lines.some((line) => /^search .*: (?!\(no words\))/u.test(line)),
      };
    }
    artifact(root, "templates-run", ran);
    expect(ran).toEqual(Object.fromEntries(HOME_KINDS.map((kind) => {
      const { run, not } = MATRIX[kind]!;
      return [kind, { faults: [], run: [...run], not: [...not], day: true, search: true }];
    })));
  });

  it("test of a fresh draft names its page, still the template's, owed before install, just before its pass line", async () => {
    const { ctx } = home();
    const lines: string[] = [];
    await folderVerb(ctx, ["new", "oauth", "acme-oauth"]);
    const answer = await folderVerb({ ...ctx, out: (line) => lines.push(line) }, ["test", "acme-oauth"]) as { passed: boolean; owed: string[] };
    const owed = "before install: acme-oauth.md is still the oauth template's page; write what acme-oauth reads (its source, its kinds and keys, what its proof holds), templates/oauth/oauth.md's sections its shape";
    expect([answer.passed, answer.owed, lines.slice(-2)]).toEqual([true, [owed], [owed, "acme-oauth passes the conformance run"]]);
  });

  it("a template's page calls its kind synthetic in the sentence help prints, or ends without its plain line", () => {
    const pages = Object.fromEntries(HOME_KINDS.map((kind) => {
      const text = readFileSync(join(TEMPLATES, kind, `${kind}.md`), "utf8");
      const first = /^The `[\w-]+` kind's template \([^)]*\): (.*?\.)(?=\s)/su.exec(text.split("\n").filter((line) => !line.startsWith("#")).join(" "))?.[1] ?? "";
      const sections = [...text.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
      return [kind, { synthetic: /synthetic|Example/u.test(first), last: sections.at(-1) }];
    }));
    expect(pages).toEqual(Object.fromEntries(HOME_KINDS.map((kind) => [kind, { synthetic: false, last: "No family fits: state a line" }])));
  });

  it("new line drafts a folder, or says anything but that a line is no way data arrives and where it is stated", async () => {
    const { root, ctx } = home();
    await expect(folderVerb(ctx, ["new", "line", "acme-diary"])).rejects.toThrow(
      `line is not a way data arrives: pick one (${HOME_KINDS.join(", ")}) and state a line in its adapter (its page, "No family fits")`,
    );
    expect(existsSync(join(root, "connectors", ".drafts", "acme-diary"))).toBe(false);
  });
});
