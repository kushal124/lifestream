import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allowed, checked, checkComments, commentsAlone, commentsOf, docFault, refusedIn, sdkDeclarations, strip, typesOf, typesOnly } from "./check-comments.js";

const texts = (path: string, text: string): string[] => commentsOf(path, text).map((comment) => comment.text);

describe("reading comments", () => {
  it("reads TypeScript's comments and never a string, a template or a regex", () => {
    const text = [
      "#!/usr/bin/env node",
      "const url = \"https://example.com/a\"; // one",
      "const t = `a ${b /* two */} // not ${c}`;",
      "const r = /\\/\\/x/u;",
      "/** three */",
      "export const x = 1;",
      "// four",
    ].join("\n");
    expect(texts("a.ts", text)).toEqual(["// one", "/* two */", "/** three */", "// four"]);
  });

  it("reads Swift's comments, nested blocks, and never a string, a raw string, an interpolation or a regex", () => {
    const text = [
      "let a = \"// no\" // one",
      "let b = #\"raw \"// no\"#",
      "let c = \"\\(f(\"// no)\")) // two\"",
      "let d = \"\"\"",
      "  // no",
      "  \"\"\"",
      "/* three /* nested */ still three */",
      "let e = /^\\W*\\/\\/x/",
      "let f = #/a//b/#",
      "let g = x / y // four",
    ].join("\n");
    expect(texts("A.swift", text)).toEqual(["// one", "/* three /* nested */ still three */", "// four"]);
  });

  it("reads a shell script's comments and never `$#`, `${#x}`, a word's `#`, a quote or a heredoc", () => {
    const text = [
      "#!/bin/sh",
      "# one",
      "n=$# m=${#list} tag=a#b",
      "echo \"a # b\" 'c # d' # two",
      "cat <<'EOF'",
      "# no",
      "EOF",
      "x=$((1<<2)) # three",
    ].join("\n");
    expect(texts("a.sh", text)).toEqual(["# one", "# two", "# three"]);
  });

  it("reads Python's, CSS's, SQL's and HTML's comments and never a string", () => {
    expect(texts("a.py", "x = '#no' # one\ny = \"\"\"\n# no\n\"\"\"\n")).toEqual(["# one"]);
    expect(texts("a.css", "a { content: \"/* no */\"; } /* one */")).toEqual(["/* one */"]);
    expect(texts("a.sql", "SELECT '--no', 'it''s' -- one\n/* two */")).toEqual(["-- one", "/* two */"]);
    expect(texts("a.html", "<p>x</p><!-- one -->")).toEqual(["<!-- one -->"]);
  });
});

describe("what may stay", () => {
  it("keeps the comments a tool reads and the facts tagged external", () => {
    expect(allowed("Package.swift", "// swift-tools-version:6.0")).toBe(true);
    expect(allowed("a.mjs", "// @ts-check")).toBe(true);
    expect(allowed("a.ts", "// @ts-expect-error the library's type is wrong")).toBe(true);
    expect(allowed("a.sh", "# shellcheck disable=SC2086")).toBe(true);
    expect(allowed("A.swift", "// external: iOS colours a bar item by what lies under it")).toBe(true);
    expect(allowed("a.sh", "# external: macOS has no GNU timeout")).toBe(true);
    expect(allowed("a.test.ts", "// paces: the fake records nothing to wait on")).toBe(true);
    expect(allowed("a.ts", "// external:")).toBe(false);
    expect(allowed("a.ts", "// The runners' calls: each runner is answered its files.")).toBe(false);
    expect(allowed("a.ts", "// @ts-ignore")).toBe(false);
    expect(allowed("a.ts", "/** @type {string} */")).toBe(false);
  });

  it("keeps JavaScript's JSDoc that holds only types, and refuses any prose in it", () => {
    expect(typesOnly("/** @type {string} */")).toBe(true);
    expect(typesOnly("/** @type {{ a: number, b: { c: string } }} */")).toBe(true);
    expect(typesOnly("/**\n * @param {string} name\n * @param {number} [count]\n * @returns {Promise<void>}\n */")).toBe(true);
    expect(typesOnly("/** @typedef {{ id: string }} Row */")).toBe(true);
    expect(typesOnly("/** @import { Row, Page } from \"./types.js\" */")).toBe(true);
    expect(typesOnly("/** @template T */")).toBe(true);
    expect(typesOnly("/** A row. @type {string} */")).toBe(false);
    expect(typesOnly("/** @param {string} name the person's name */")).toBe(false);
    expect(typesOnly("/** @returns {number} how many */")).toBe(false);
    expect(typesOnly("/** @see elsewhere */")).toBe(false);
    expect(allowed("a.js", "/** @type {string} */")).toBe(true);
  });

  it("leaves generated files, vendored code and fixtures alone", () => {
    expect(checked("packages/home/door.ts")).toBe(true);
    expect(checked("ios-app/install-phone.sh")).toBe(true);
    expect(checked("dashboard/public/vendor/maplibre.js")).toBe(false);
    expect(checked("macos-app/Tests/Fixtures/stores/a.swift")).toBe(false);
    expect(checked("docs/DESIGN.md")).toBe(false);
  });
});

describe("deleting comments", () => {
  it("names each refused comment's first line", () => {
    const text = ["// one", "const a = 1;", "const b = 2; // two", "/*", " * three", " */", "const c = 3;"].join("\n");
    expect(refusedIn("a.ts", text).map((comment) => [comment.line, comment.text])).toEqual([[1, "// one"], [3, "// two"], [4, "/*\n * three\n */"]]);
  });

  it("deletes a refused comment and leaves the code as it was", () => {
    const source = [
      "// whole line",
      "const a = 1; // trailing",
      "f(/* inline */ a);",
      "  /**",
      "   * a block",
      "   */",
      "  const b = 2;",
    ].join("\n");
    expect(strip(source, commentsOf("a.ts", source))).toBe(["const a = 1;", "f(a);", "  const b = 2;"].join("\n"));
  });

  it("never joins two words, and keeps the line break a block over lines stood for", () => {
    const joined = "const a = b/* x */in c;";
    expect(strip(joined, commentsOf("a.ts", joined))).toBe("const a = b in c;");
    const asi = "function f() { return /* one\n two */ value; }";
    expect(strip(asi, commentsOf("a.ts", asi))).toBe("function f() { return\nvalue; }");
  });

  it("keeps a JavaScript JSDoc's types and deletes its prose, so the typecheck reads what it read", () => {
    const source = [
      "  /**",
      "   * The named parameters a request carries, {@link Foo} and person-a@example.com.",
      "   * @param {URL} url the request's",
      "   * @param {{ a: number,",
      "   *   b: string }} [options]",
      "   * @returns {Promise<void>} when done",
      "   * @see elsewhere",
      "   */",
      "  function f(url, options) {}",
      "/** The row. @type {Row} */ (row);",
      "/** Only prose. */",
      "const x = 1;",
    ].join("\n");
    const out = strip(source, commentsOf("a.js", source).filter((comment) => !allowed("a.js", comment.text)), "a.js");
    expect(out).toBe([
      "  /**",
      "   * @param {URL} url",
      "   * @param {{ a: number, b: string }} [options]",
      "   * @returns {Promise<void>}",
      "   */",
      "  function f(url, options) {}",
      "/** @type {Row} */ (row);",
      "const x = 1;",
    ].join("\n"));
    expect(commentsOf("a.js", out).every((comment) => allowed("a.js", comment.text))).toBe(true);
    expect(typesOf("/** Only prose. */")).toBeNull();
    expect(typesOf("/** @import { A, B } from \"./x.js\" */")).toEqual(["@import { A, B } from \"./x.js\""]);
  });
});

describe("a change in comments alone", () => {
  it.each([
    ["a line comment deleted", "a.ts", "// why\nconst a = 1;\n", "const a = 1;\n", true],
    ["a trailing comment deleted", "a.ts", "x(); // a\n", "x();\n", true],
    ["a JSDoc's prose deleted, its types kept", "a.js", "/** Why. @type {number} */\nconst a = 1;\n", "/** @type {number} */\nconst a = 1;\n", true],
    ["a Swift comment deleted", "A.swift", "let a = 1 // why\n", "let a = 1\n", true],
    ["a comment deleted and a code line changed", "a.ts", "// why\nconst a = 1;\n", "const a = 2;\n", false],
    ["a comment added or reworded", "a.ts", "// a\nconst a = 1;\n", "// paces: b\n\nconst a = 1;\n", true],
    ["a blank line alone", "a.ts", "const a = 1;\n", "\nconst a = 1;\n", true],
    ["a JSDoc type changed, which the static suite's typecheck reads", "a.js", "/** @type {number} */\nlet a;\n", "/** @type {string} */\nlet a;\n", true],
    ["nothing changed", "a.ts", "const a = 1;\n", "const a = 1;\n", false],
    ["a page", "a.md", "<!-- x -->\n", "\n", false],
  ])("%s", (_name, path, before, after, alone) => {
    expect(commentsAlone(path, before, after)).toBe(alone);
  });
});

describe("what a review found", () => {
  it("never changes what a script runs when a comment goes", () => {
    const cases: [string, string][] = [
      ["function f() { return/* x */1; }", "function f() { return 1; }"],
      ["function f() { return /* x\n*/ 1; }", "function f() { return\n1; }"],
      ["const s = `${typeof/* x */value}`;", "const s = `${typeof value}`;"],
      ["const n = x +/* x */+ y;", "const n = x + + y;"],
    ];
    for (const [source, fixed] of cases) expect(strip(source, commentsOf("a.ts", source))).toBe(fixed);
  });

  it("keeps a defaulted template and a literal type exactly, quotes and braces in it too", () => {
    expect(typesOf("/** Explanation.\n * @template [R=never]\n * @param {R} value\n */")).toEqual(["@template [R=never]", "@param {R} value"]);
    expect(typesOf("/** Explanation. @type {\"a  b\"} */")).toEqual(["@type {\"a  b\"}"]);
    expect(typesOnly("/** @type {\"{\"} */")).toBe(true);
    expect(typesOf("/** Prose. @type {\"}\" | '{'} */")).toEqual(["@type {\"}\" | '{'}"]);
  });

  it("decides an unknown tag, `@constructor` among them, without throwing", () => {
    expect(typesOnly("/** @constructor */")).toBe(false);
    expect(typesOf("/** @constructor */")).toBeNull();
    expect(allowed("a.js", "/** @toString */")).toBe(false);
  });

  it("reads Swift's regex after switch and division after a name of any script", () => {
    expect(texts("A.swift", "switch /[//]/ {\ndefault: break\n}")).toEqual([]);
    expect(texts("A.swift", "let n = α/2 // one")).toEqual(["// one"]);
  });

  it("reads a shell word's escaped space, arithmetic shifts and here-strings", () => {
    expect(texts("a.sh", "echo a\\ #literal")).toEqual([]);
    expect(texts("a.sh", "x=$((1<<bits))\n# one")).toEqual(["# one"]);
    expect(texts("a.sh", "read x <<<word # one\n# two")).toEqual(["# one", "# two"]);
  });

  it("reads JSX text, SQLite's quoted names and Python's raw strings", () => {
    expect(texts("a.tsx", "const view = <div>// literal text</div>; // one")).toEqual(["// one"]);
    expect(texts("a.sql", "SELECT [--name], `--b` FROM t; -- one")).toEqual(["-- one"]);
    expect(texts("a.py", "x = r\"\\\\\" # one")).toEqual(["# one"]);
  });
});

describe("a repository's change", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const write = (root: string, path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const repo = (): string => {
    const root = mkdtempSync(join(tmpdir(), "check-comments-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "person-a@example.com");
    git(root, "config", "user.name", "Person A");
    write(root, "old.ts", "// kept from before\nexport const a = 1;\n");
    write(root, "moved.ts", "// kept from before\nexport const m = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "lane");
    return root;
  };

  it("refuses the comments in every file a lane touched, renamed, non-ASCII, spaced or untracked, and none in a file it left", () => {
    const root = repo();
    write(root, "old.ts", "// kept from before\nexport const a = 1;\n");
    write(root, "touched.ts", "// from before\nexport const t = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "more");
    git(root, "checkout", "-q", "-b", "lane2");
    git(root, "branch", "-f", "main", "HEAD");
    write(root, "touched.ts", "// from before\nexport const t = 2;\n");
    git(root, "mv", "moved.ts", "renamed.ts");
    write(root, "renamed.ts", "// kept from before\nexport const m = 2;\n");
    write(root, "café.ts", "// added\n");
    write(root, "a b.ts", "export const b = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "lane");
    write(root, "a b.ts", "export const b = 1; // added\n");
    write(root, "untracked.ts", "/* added */\n");
    const { refused } = checkComments(root, "lane");
    expect(refused.map(({ file, line }) => `${file}:${line}`).sort()).toEqual(["a b.ts:1", "café.ts:1", "renamed.ts:1", "touched.ts:1", "untracked.ts:1"]);
    expect(checkComments(root, "all").refused.map(({ file }) => file).sort()).toEqual(["a b.ts", "café.ts", "old.ts", "renamed.ts", "touched.ts", "untracked.ts"]);
  });

  it("refuses only what is staged, and fixes only the working tree, keeping unstaged work", () => {
    const root = repo();
    git(root, "checkout", "-q", "main");
    write(root, "old.ts", "export const a = 1; // staged\n");
    git(root, "add", "old.ts");
    write(root, "old.ts", "export const a = 2; // staged\n");
    expect(checkComments(root, "staged").refused.map(({ file, line }) => `${file}:${line}`)).toEqual(["old.ts:1"]);
    expect(checkComments(root, "all", true).fixed).toBe(2);
    expect(readFileSync(join(root, "old.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(readFileSync(join(root, "moved.ts"), "utf8")).toBe("export const m = 1;\n");
  });

  it("strips a lane's touched files as the sweep strips main, so their merge meets the same lines", () => {
    const root = repo();
    write(root, "old.ts", "// kept from before\nexport const a = 1;\nexport const z = 1; // lane's\n");
    git(root, "commit", "-qam", "lane");
    git(root, "checkout", "-q", "main");
    checkComments(root, "all", true);
    git(root, "commit", "-qam", "sweep");
    git(root, "checkout", "-q", "lane");
    checkComments(root, "lane", true);
    git(root, "commit", "-qam", "lane fix");
    git(root, "merge", "-q", "--no-edit", "main");
    expect(readFileSync(join(root, "old.ts"), "utf8")).toBe("export const a = 1;\nexport const z = 1;\n");
  });
});

describe("the connector SDK's doc comments", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const write = (root: string, path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const DECLARATION = [
    "import type { Far } from \"@lifestreamprotocol/core\";",
    "/** A thing an author declares. */",
    "export interface Thing {",
    "  /** What it is called. */",
    "  name: string;",
    "  inner: {",
    "    /** How many. */",
    "    count: number;",
    "  };",
    "  shape: Shape;",
    "  far?: Far;",
    "}",
    "/** A shape. */",
    "export type Shape =",
    "  /** Round. */",
    "  | \"round\"",
    "  | /** Square. */ \"square\"",
    "  | \"flat\";",
    "/** The reasons. */",
    "export const REASONS = [",
    "  /** It is late. */",
    "  \"late\",",
    "  \"lost\",",
    "] as const;",
    "/** One of the reasons. */",
    "export type Reason = (typeof REASONS)[number];",
    "/** Makes a thing. */",
    "export function made(reason: Reason): Thing {",
    "  return { name: reason, inner: { count: 1 }, shape: \"round\" };",
    "}",
    "/** Not in the SDK. */",
    "export const INSIDE = 1;",
    "",
  ].join("\n");
  const repo = (declaration = DECLARATION): string => {
    const root = mkdtempSync(join(tmpdir(), "check-comments-sdk-"));
    roots.push(root);
    execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
    write(root, ".gitignore", "node_modules/\n");
    write(root, "packages/core/package.json", JSON.stringify({ name: "@lifestreamprotocol/core", type: "module", exports: { ".": "./index.ts" } }));
    write(root, "packages/core/index.ts", "export type { Far } from \"./far.js\";\n");
    write(root, "packages/core/far.ts", "export interface Far {\n  away: boolean;\n}\n/** Not in the SDK. */\nexport interface Near {\n  here: boolean;\n}\n");
    mkdirSync(join(root, "node_modules/@lifestreamprotocol"), { recursive: true });
    symlinkSync("../../packages/core", join(root, "node_modules/@lifestreamprotocol/core"));
    write(root, "packages/connect/sdk.ts", "export type { Thing, Reason } from \"./declaration.js\";\nexport { made } from \"./declaration.js\";\n");
    write(root, "packages/connect/declaration.ts", declaration);
    return root;
  };
  const listed = (root: string): string[] => sdkDeclarations(root).map(({ file, name, doc, required }) => `${file} ${name}${required ? "" : "?"}${doc === null ? " -" : ""}`);

  it("reaches every declaration, member and closed union's literal through the SDK's exports, across packages, and only those", () => {
    expect(listed(repo())).toEqual([
      "packages/connect/declaration.ts Thing",
      "packages/connect/declaration.ts Thing.name",
      "packages/connect/declaration.ts Thing.inner -",
      "packages/connect/declaration.ts Thing.inner.count",
      "packages/connect/declaration.ts Thing.shape -",
      "packages/connect/declaration.ts Thing.far -",
      "packages/connect/declaration.ts Shape",
      "packages/connect/declaration.ts Shape.\"round\"",
      "packages/connect/declaration.ts Shape.\"square\"",
      "packages/connect/declaration.ts Shape.\"flat\" -",
      "packages/connect/declaration.ts REASONS",
      "packages/connect/declaration.ts REASONS.\"late\"",
      "packages/connect/declaration.ts REASONS.\"lost\" -",
      "packages/connect/declaration.ts Reason",
      "packages/connect/declaration.ts made",
      "packages/core/far.ts Far -",
      "packages/core/far.ts Far.away -",
    ]);
  });

  it("reaches a class's shown members and never what its private constructor or private field takes", () => {
    const root = repo([
      "interface Hidden {",
      "  secret: string;",
      "}",
      "/** A made thing. */",
      "export class Made {",
      "  readonly #hidden: Hidden;",
      "  /** Its name. */",
      "  readonly name: string;",
      "  private constructor(hidden: Hidden) {",
      "    this.#hidden = hidden;",
      "    this.name = hidden.secret;",
      "  }",
      "}",
      "",
    ].join("\n"));
    write(root, "packages/connect/sdk.ts", "export { Made } from \"./declaration.js\";\n");
    expect(listed(root)).toEqual(["packages/connect/declaration.ts Made", "packages/connect/declaration.ts Made.name"]);
  });

  it("allows a one-sentence doc comment on what the SDK reaches, requires one on each, and refuses one outside it", () => {
    const root = repo();
    const { refused } = checkComments(root, "all");
    expect(refused.map(({ file, line, text, why }) => `${file}:${line}: ${text} (${why ?? "not the SDK's"})`).sort()).toEqual([
      "packages/connect/declaration.ts:10: Thing.shape (no doc comment)",
      "packages/connect/declaration.ts:11: Thing.far (no doc comment)",
      "packages/connect/declaration.ts:18: Shape.\"flat\" (no doc comment)",
      "packages/connect/declaration.ts:23: REASONS.\"lost\" (no doc comment)",
      "packages/connect/declaration.ts:31: /** Not in the SDK. */ (not the SDK's)",
      "packages/connect/declaration.ts:6: Thing.inner (no doc comment)",
      "packages/core/far.ts:1: Far (no doc comment)",
      "packages/core/far.ts:2: Far.away (no doc comment)",
      "packages/core/far.ts:4: /** Not in the SDK. */ (not the SDK's)",
    ]);
  });

  it.each([
    ["two sentences", "/** What it is called. It is short. */", "more than one sentence"],
    ["a spec's path", "/** What it is called, as docs/connectors.md says. */", "names docs/ or §"],
    ["a section sign", "/** What it is called (§2). */", "names docs/ or §"],
    ["an @ tag", "/** What it is called.\n   * @deprecated\n   */", "carries an @ tag"],
    ["an inline tag", "/** What it is called, as {@link Thing} says. */", "carries an @ tag"],
    ["no full stop", "/** What it is called */", "not a sentence ending in a full stop"],
  ])("refuses a doc comment of %s, and --fix keeps it for a person to rewrite", (_name, doc, why) => {
    const root = repo(DECLARATION.replace("/** What it is called. */", doc));
    const refused = checkComments(root, "all", true).refused.filter((each) => each.why === why);
    expect(refused.map(({ file, line }) => `${file}:${line}`)).toEqual(["packages/connect/declaration.ts:4"]);
    expect(readFileSync(join(root, "packages/connect/declaration.ts"), "utf8")).toContain(doc);
  });

  it("refuses a line comment where a doc comment goes, and reads a sentence's code and abbreviations whole", () => {
    const root = repo(DECLARATION.replace("/** What it is called. */", "// What it is called."));
    const refused = checkComments(root, "all").refused.filter(({ file, line }) => file === "packages/connect/declaration.ts" && line <= 5).map(({ text, why }) => `${text} (${why ?? "not the SDK's"})`);
    expect(refused).toEqual(["// What it is called. (not the SDK's)", "Thing.name (no doc comment)"]);
    expect(docFault("/** The name, as `a. b` or \"x.y\". */")).toBeNull();
    expect(docFault("/** The name, as person-a@example.com writes it. */")).toBeNull();
  });

  it("--fix deletes every other comment and leaves the SDK's doc comments as they are", () => {
    const root = repo(DECLARATION.replace("  name: string;", "  name: string; // why"));
    expect(checkComments(root, "all", true).fixed).toBe(3);
    const after = readFileSync(join(root, "packages/connect/declaration.ts"), "utf8");
    expect(after).toBe(DECLARATION.replace("/** Not in the SDK. */\n", ""));
    expect(readFileSync(join(root, "packages/core/far.ts"), "utf8")).not.toContain("Not in the SDK");
  });

  const lane = (root: string): ((...args: string[]) => string) => {
    const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("config", "user.email", "person-a@example.com");
    git("config", "user.name", "Person A");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "lane");
    return git;
  };

  it("requires a doc comment in every file the SDK reaches when a change reaches it, a file the change left among them", () => {
    const root = repo();
    const git = lane(root);
    write(root, "packages/connect/declaration.ts", DECLARATION.replace("  inner: {", "  /** What it holds. */\n  inner: {"));
    const staged = (): string[] => checkComments(root, "staged").refused.filter(({ file }) => file === "packages/core/far.ts").map(({ line, text, why }) => `${line}: ${text} (${why ?? "not the SDK's"})`);
    expect(checkComments(root, "lane").refused.filter(({ file }) => file === "packages/core/far.ts").map(({ line, text, why }) => `${line}: ${text} (${why ?? "not the SDK's"})`)).toEqual([
      "1: Far (no doc comment)",
      "2: Far.away (no doc comment)",
    ]);
    git("add", "packages/connect/declaration.ts");
    expect(staged()).toEqual(["1: Far (no doc comment)", "2: Far.away (no doc comment)"]);
  });

  it("refuses a doc comment the SDK no longer reaches when the change is to the SDK, in a file the change left", () => {
    const root = repo();
    lane(root);
    expect(checkComments(root, "lane").refused).toEqual([]);
    write(root, "packages/connect/sdk.ts", "export type { Thing } from \"./declaration.js\";\n");
    expect(checkComments(root, "lane").refused.filter(({ why }) => why === undefined).map(({ file, line, text }) => `${file}:${line}: ${text}`)).toEqual([
      "packages/connect/declaration.ts:19: /** The reasons. */",
      "packages/connect/declaration.ts:21: /** It is late. */",
      "packages/connect/declaration.ts:25: /** One of the reasons. */",
      "packages/connect/declaration.ts:27: /** Makes a thing. */",
      "packages/connect/declaration.ts:31: /** Not in the SDK. */",
      "packages/core/far.ts:4: /** Not in the SDK. */",
    ]);
  });

  it("reads no SDK where the repository has none, and refuses every doc comment there", () => {
    const root = mkdtempSync(join(tmpdir(), "check-comments-sdk-"));
    roots.push(root);
    expect(sdkDeclarations(root)).toEqual([]);
    expect(refusedIn("packages/connect/a.ts", "/** A thing. */\nexport const a = 1;\n").map(({ text }) => text)).toEqual(["/** A thing. */"]);
  });
});
