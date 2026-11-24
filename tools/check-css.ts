import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Break {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

const PAGE_CSS = /^dashboard\/public\/[^/]+\.css$/u;
const NOT_PAGES = new Set(["dashboard/public/kit-gallery.css"]);
const SPACING = /^(?:(?:padding|margin)(?:-[a-z-]+)?|(?:grid-)?(?:row-|column-)?gap|border(?:-[a-z-]+)?-radius|font-size)$/u;
const RAW_PX = /(?<![\w.])(\d*\.?\d+)px\b/gu;

export function checkCss(root: string): Break[] {
  return pageFiles(root).flatMap((file) => breaksOf(file, readFileSync(join(root, file), "utf8")));
}

export function breaksOf(file: string, text: string): Break[] {
  const breaks: Break[] = [];
  const firstAt = new Map<string, number>();
  const context: string[] = [];
  for (const piece of piecesOf(text)) {
    if (piece.kind === "close") {
      context.pop();
    } else if (piece.kind === "open") {
      const at = piece.text.startsWith("@");
      const name = selectorOf(piece.text);
      if (!at) {
        const key = [...context, name].join(" { ");
        const first = firstAt.get(key);
        if (first === undefined) firstAt.set(key, piece.line);
        else breaks.push({ file, line: piece.line, what: `${name} is defined again (first at line ${first}): fold it into that rule` });
      }
      context.push(name);
    } else if (context.length > 0 && !piece.text.startsWith("@")) {
      const colon = piece.text.indexOf(":");
      if (colon < 0) continue;
      const property = piece.text.slice(0, colon).trim().toLowerCase();
      const value = blankStrings(piece.text.slice(colon + 1));
      const sized = property === "font" ? withoutLineHeight(value) : SPACING.test(property) ? value : undefined;
      if (sized === undefined) continue;
      const raw = [...sized.matchAll(RAW_PX)].filter((match) => Number(match[1]) !== 0).map((match) => match[0]);
      if (raw.length > 0) breaks.push({ file, line: piece.line, what: `${property} types ${raw.join(", ")} by hand: ${hintOf(property)} in its place` });
    }
  }
  return breaks;
}

type Piece =
  | { readonly kind: "open" | "declaration"; readonly text: string; readonly line: number }
  | { readonly kind: "close" };

function piecesOf(text: string): Piece[] {
  const pieces: Piece[] = [];
  let held = "";
  let heldLine = 1;
  let line = 1;
  let depth = 0;
  const hold = (chunk: string): void => {
    if (held.trim() === "" && chunk.trim() !== "") heldLine = line;
    held += chunk;
    line += chunk.split("\n").length - 1;
  };
  const take = (kind: "open" | "declaration"): void => {
    const body = held.trim();
    if (body !== "" || kind === "open") pieces.push({ kind, text: body, line: heldLine });
    held = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const comment = text.slice(index, end < 0 ? text.length : end + 2);
      hold(comment.replace(/[^\n]/gu, " "));
      index += comment.length - 1;
    } else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== char && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
      hold(text.slice(index, end + 1));
      index = end;
    } else if (char === "\\") {
      hold(text.slice(index, index + 2));
      index += 1;
    } else if (char === "(") {
      depth += 1;
      hold(char);
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
      hold(char);
    } else if (depth === 0 && char === "{") {
      take("open");
    } else if (depth === 0 && char === ";") {
      take("declaration");
    } else if (depth === 0 && char === "}") {
      take("declaration");
      pieces.push({ kind: "close" });
    } else {
      hold(char);
    }
  }
  return pieces;
}

function selectorOf(prelude: string): string {
  return outsideStrings(prelude, (part) => part.replace(/\s+/gu, " ").replace(/\s*([,>+~])\s*/gu, "$1")).trim();
}

function blankStrings(value: string): string {
  return value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gu, (string) => string[0] + " ".repeat(string.length - 2) + string[0]);
}

function withoutLineHeight(value: string): string {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "/" && depth === 0) {
      let end = index + 1;
      while (end < value.length && /\s/u.test(value.charAt(end))) end += 1;
      let inner = 0;
      for (; end < value.length; end += 1) {
        if (value[end] === "(") inner += 1;
        else if (value[end] === ")") inner -= 1;
        else if (inner === 0 && /\s/u.test(value.charAt(end))) break;
      }
      return value.slice(0, index) + value.slice(end);
    }
  }
  return value;
}

function outsideStrings(text: string, map: (part: string) => string): string {
  return text.split(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/u).map((part, index) => (index % 2 === 0 ? map(part) : part)).join("");
}

function hintOf(property: string): string {
  if (property.endsWith("radius")) return "var(--radius-*)";
  if (property.startsWith("font")) return "a type style's var(--mac-*-size) or var(--ob-*-size)";
  return "var(--space-*)";
}

function pageFiles(root: string): string[] {
  const listed = (...args: string[]): string[] =>
    execFileSync("git", ["-C", root, "ls-files", ...args], { encoding: "utf8" }).split("\n").filter(Boolean);
  const lane = execFileSync("git", ["-C", root, "rev-parse", "--git-dir"], { encoding: "utf8" }).includes("/worktrees/");
  const files = [...listed(), ...(lane ? listed("--others", "--exclude-standard") : [])];
  return [...new Set(files)].filter((file) => PAGE_CSS.test(file) && !NOT_PAGES.has(file) && existsSync(join(root, file))).sort();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const breaks = checkCss(root);
  for (const entry of breaks) process.stdout.write(`${relative(root, join(root, entry.file))}:${entry.line}: ${entry.what}\n`);
  if (breaks.length > 0) {
    process.stdout.write(`check-css: ${breaks.length} broken (tools/check-css.ts says what each rule holds)\n`);
    process.exit(1);
  }
}
