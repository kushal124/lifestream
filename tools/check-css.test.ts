import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { breaksOf, checkCss, type Break } from "./check-css.js";

const roots: string[] = [];
const artifact: Record<string, Break[]> = {};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  writeFileSync(join(tmpdir(), "check-css.json"), `${JSON.stringify(artifact, null, 2)}\n`);
});

const lines = (...each: string[]): string => `${each.join("\n")}\n`;

function check(name: string, text: string): string[] {
  const breaks = breaksOf("page.css", text);
  artifact[name] = breaks;
  return breaks.map((entry) => `${entry.line}: ${entry.what}`);
}

describe("raw px", () => {
  it("names a px typed in spacing, corners and type, each on its own line", () => {
    expect(check("raw", lines(
      ".a { padding: 6px var(--space-2); }",
      ".b { margin-inline: 0 2px; gap: 10px; }",
      ".c { row-gap: 3px; column-gap: 5px; }",
      ".d { border-radius: 10px; border-top-left-radius: 6px; }",
      ".e {",
      "  font-size: 12.5px;",
      "  font: 600 14px/20px var(--font-sans);",
      "}",
    ))).toEqual([
      "1: padding types 6px by hand: var(--space-*) in its place",
      "2: margin-inline types 2px by hand: var(--space-*) in its place",
      "2: gap types 10px by hand: var(--space-*) in its place",
      "3: row-gap types 3px by hand: var(--space-*) in its place",
      "3: column-gap types 5px by hand: var(--space-*) in its place",
      "4: border-radius types 10px by hand: var(--radius-*) in its place",
      "4: border-top-left-radius types 6px by hand: var(--radius-*) in its place",
      "6: font-size types 12.5px by hand: a type style's var(--mac-*-size) or var(--ob-*-size) in its place",
      "7: font types 14px by hand: a type style's var(--mac-*-size) or var(--ob-*-size) in its place",
    ]);
  });

  it("names a negative px, one inside calc, and a var's fallback", () => {
    expect(check("hidden", lines(
      ".a { margin: 0 0 0 -6px; }",
      ".b { padding-left: calc(var(--space-2) + 10px); }",
      ".c { gap: var(--gap, 4px); }",
      "@media (max-width: 720px) { .d { padding: 14px; } }",
    ))).toEqual([
      "1: margin types 6px by hand: var(--space-*) in its place",
      "2: padding-left types 10px by hand: var(--space-*) in its place",
      "3: gap types 4px by hand: var(--space-*) in its place",
      "4: padding types 14px by hand: var(--space-*) in its place",
    ]);
  });

  it("passes tokens, 0, a font's line height, and px where this check does not look", () => {
    expect(check("sound", lines(
      "/* padding: 6px in a comment */",
      ".a { padding: 0 var(--space-2); margin: calc(-1 * var(--space-2)) 0 0; gap: 0; border-radius: 50%; }",
      ".b { font: 500 var(--mac-body-size)/20px var(--font-sans); font-size: var(--mac-subhead-size); line-height: 18px; }",
      ".c { width: 120px; height: 32px; inset: 0 0 auto 116px; border: 1px solid var(--hairline); outline-offset: -2px; }",
      ".d { --edge: 116px; padding-left: var(--edge); box-shadow: 0 0 0 4px var(--canvas); }",
      '.e::after { content: "padding: 6px;"; }',
      ".f { margin: 0px; padding: 0 auto; }",
    ))).toEqual([]);
  });
});

describe("reading CSS as CSS reads", () => {
  it("names a px inside an at-rule nested in a rule, and in a rule nested in that", () => {
    expect(check("nested", lines(
      ".a { @media (min-width: 1px) { padding: 6px; } }",
      ".b {",
      "  @supports (display: grid) {",
      "    .c { gap: 3px; }",
      "  }",
      "}",
    ))).toEqual([
      "1: padding types 6px by hand: var(--space-*) in its place",
      "4: gap types 3px by hand: var(--space-*) in its place",
    ]);
  });

  it("reads comment marks inside a string as the string's, and a comment's lines as lines", () => {
    expect(check("strings", lines(
      '.a::after { content: "/*"; padding: 6px; }',
      "/* a comment",
      "   over two lines */",
      '.b::after { content: "*/ padding: 6px; /*"; margin: 2px; }',
      ".c { background: url(data:image/svg+xml;utf8,x); gap: 4px; }",
    ))).toEqual([
      "1: padding types 6px by hand: var(--space-*) in its place",
      "4: margin types 2px by hand: var(--space-*) in its place",
      "5: gap types 4px by hand: var(--space-*) in its place",
    ]);
  });

  it("keeps a selector's quoted words as written: two labels that differ by a space are two rules", () => {
    expect(check("quoted", lines(
      '[data-label="a > b"] { gap: 0; }',
      '[data-label="a>b"] { gap: 0; }',
      "[data-label='a, b'] { gap: 0; }",
      "[data-label='a,b'] { gap: 0; }",
      '[data-label="a > b"]  { margin: 0; }',
    ))).toEqual([
      '5: [data-label="a > b"] is defined again (first at line 1): fold it into that rule',
    ]);
  });

  it("sets a font's line height aside whole, a function's among them, and still names its size", () => {
    expect(check("line-height", lines(
      ".a { font: var(--mac-body-size)/calc(1em + 2px) var(--font-sans); }",
      ".b { font: 500 var(--mac-body-size) / max(18px, 1.2em) var(--font-sans); }",
      ".c { font: 13px/calc(1em + 2px) var(--font-sans); }",
      '.d { font: var(--mac-body-size)/20px "Face 12px", sans-serif; }',
    ))).toEqual([
      "3: font types 13px by hand: a type style's var(--mac-*-size) or var(--ob-*-size) in its place",
    ]);
  });
});

describe("one rule per selector", () => {
  it("names a selector list written again in a file, with where it first stands, however it is spaced", () => {
    expect(check("again", lines(
      ".a > .b { color: red; }",
      ".c, .d { color: red; }",
      ".a>.b { gap: 0; }",
      "",
      ".c,.d",
      "{ gap: 0; }",
    ))).toEqual([
      "3: .a>.b is defined again (first at line 1): fold it into that rule",
      "5: .c,.d is defined again (first at line 2): fold it into that rule",
    ]);
  });

  it("names a selector written again inside the same at-rule, and passes it under another", () => {
    expect(check("at-rules", lines(
      ".a { gap: 0; }",
      "@media (max-width: 720px) { .a { gap: 0; } }",
      "@media (max-width: 900px) { .a { gap: 0; } }",
      "@media (max-width: 720px) { .a { margin: 0; } }",
      "@keyframes one { from { opacity: 0; } }",
      "@keyframes two { from { opacity: 0; } }",
      ".b { gap: 0; }",
      ".a .b, .b { gap: 0; }",
    ))).toEqual([
      "4: .a is defined again (first at line 2): fold it into that rule",
    ]);
  });
});

describe("files", () => {
  it("reads the page stylesheets alone: not the gallery's, a folder's below, or the system's", () => {
    const root = mkdtempSync(join(tmpdir(), "check-css-"));
    roots.push(root);
    const raw = ".a { padding: 6px; }\n";
    const files: Record<string, string> = {
      "dashboard/public/days.css": raw,
      "dashboard/public/kit-gallery.css": raw,
      "dashboard/public/vendor/map.css": raw,
      "design/css/kit.css": raw,
      "design/css/cockpit.css": raw,
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "add", "-A"]);
    const breaks = checkCss(root);
    artifact.files = breaks;
    expect(breaks.map((entry) => `${entry.file}:${entry.line}`)).toEqual(["dashboard/public/days.css:1"]);
  });
});
