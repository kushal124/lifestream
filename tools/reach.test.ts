import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGraph, hubs, reachedTests, runReach } from "./reach.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "reach-"));
  roots.push(root);
  const files: Record<string, string> = {
    "packages/alpha/package.json": JSON.stringify({ name: "@lifestreamprotocol/alpha", exports: { ".": "./index.ts" } }),
    "packages/alpha/index.ts": 'export { one, two as deux } from "./one.js";\nexport * from "./star.js";\nexport const local = 1;\n',
    "packages/alpha/one.ts": "export const one = 1;\nexport const two = 2;\n",
    "packages/alpha/star.ts": "export function three(): void {}\n",
    "packages/beta/a.ts": 'import { one } from "@lifestreamprotocol/alpha";\nexport const y = one;\n',
    "packages/beta/b.ts": 'import {\n  three,\n  type deux as d,\n} from "@lifestreamprotocol/alpha";\n',
    "packages/beta/c.ts": 'import { local } from "@lifestreamprotocol/alpha";\n',
    "packages/beta/d.ts": 'export * from "../alpha/star.js";\nexport * from "./c.js";\n',
    "packages/beta/b.test.ts": 'import "./b.js";\n',
    "packages/beta/c.test.ts": 'const loaded = await import("./c.js");\n',
    "packages/beta/lone.test.ts": "export const nothing = 1;\n",
    "packages/beta/node_modules/skipped.test.ts": 'import "../a.js";\n',
    "tools/mid.ts": 'export { y } from "../packages/beta/a.js";\n',
    "tools/chain.test.ts": 'import { y } from "./mid.js";\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("reach", () => {
  it("follows a relative chain, a .js specifier, a package index's named and star exports, and a dynamic import", () => {
    const graph = buildGraph(fixture());
    expect(reachedTests(graph, ["packages/alpha/one.ts"])).toEqual(["packages/beta/b.test.ts", "packages/beta/c.test.ts", "tools/chain.test.ts"]);
    expect(reachedTests(graph, ["packages/alpha/star.ts"])).toEqual(["packages/beta/b.test.ts", "packages/beta/c.test.ts"]);
    expect(reachedTests(graph, ["packages/alpha/index.ts"])).toEqual(["packages/beta/c.test.ts"]);
    expect(reachedTests(graph, ["packages/beta/c.ts"])).toEqual(["packages/beta/c.test.ts"]);
    expect(reachedTests(graph, ["tools/mid.ts", "packages/beta/b.ts"])).toEqual(["packages/beta/b.test.ts", "tools/chain.test.ts"]);
  });

  it("follows a namespace re-export (`export * as ns from`) to the file it names", () => {
    const root = mkdtempSync(join(tmpdir(), "reach-"));
    roots.push(root);
    const files: Record<string, string> = {
      "packages/gamma/package.json": JSON.stringify({ name: "@lifestreamprotocol/gamma", exports: { ".": "./index.ts" } }),
      "packages/gamma/index.ts": 'export * as ics from "./ics.js";\nexport * as other from "./other.js";\n',
      "packages/gamma/ics.ts": "export function read(): void {}\n",
      "packages/gamma/other.ts": "export const x = 1;\n",
      "packages/delta/mime.ts": 'import { ics } from "@lifestreamprotocol/gamma";\nexport const m = ics;\n',
      "packages/delta/mime.test.ts": 'import { m } from "./mime.js";\n',
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const graph = buildGraph(root);
    expect(reachedTests(graph, ["packages/gamma/ics.ts"])).toEqual(["packages/delta/mime.test.ts"]);
    expect(reachedTests(graph, ["packages/gamma/other.ts"])).toEqual([]);
  });

  it("counts a test no module reaches, and leaves node_modules out", () => {
    const graph = buildGraph(fixture());
    expect(graph.files.filter((file) => file.endsWith(".test.ts")).sort()).toEqual([
      "packages/beta/b.test.ts", "packages/beta/c.test.ts", "packages/beta/lone.test.ts", "tools/chain.test.ts",
    ]);
    const reached = graph.files.filter((file) => !file.endsWith(".test.ts")).flatMap((file) => reachedTests(graph, [file]));
    expect(reached).not.toContain("packages/beta/lone.test.ts");
  });

  it("orders hubs by the tests they reach, then by their direct importers, then by path", () => {
    expect(hubs(buildGraph(fixture()), 5)).toEqual([
      { file: "packages/alpha/one.ts", tests: 3, importers: 3 },
      { file: "packages/alpha/star.ts", tests: 2, importers: 3 },
      { file: "packages/beta/c.ts", tests: 1, importers: 2 },
      { file: "packages/alpha/index.ts", tests: 1, importers: 1 },
      { file: "packages/beta/a.ts", tests: 1, importers: 1 },
    ]);
  });

  it("prints the reached tests and their count, the hubs, and refuses a file the graph does not hold", () => {
    const root = fixture();
    const run = (args: string[]): { status: number; out: string[]; err: string[] } => {
      const out: string[] = [];
      const err: string[] = [];
      const status = runReach(root, args, join(root, "packages"), (line) => out.push(line), (line) => err.push(line));
      return { status, out, err };
    };
    expect(run(["alpha/one.ts"])).toEqual({
      status: 0, out: ["packages/beta/b.test.ts", "packages/beta/c.test.ts", "tools/chain.test.ts", "3 of 4 test files"], err: [],
    });
    expect(run(["--hubs", "1"])).toEqual({ status: 0, out: ["3 tests  3 importers  packages/alpha/one.ts", "of 4 test files"], err: [] });
    expect(run(["alpha/missing.ts"])).toEqual({ status: 1, out: [], err: ["reach: packages/alpha/missing.ts is no module of the graph"] });
    expect(run(["--hubs", "none"]).status).toBe(2);
  });
});
