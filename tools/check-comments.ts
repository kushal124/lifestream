import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface Comment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface Refused {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly why?: string;
}

const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const TYPED_BY_JSDOC = /\.(?:[cm]?js|jsx)$/u;
const SWIFT = /\.swift$/u;
const CSS = /\.css$/u;
const HASH = /\.(?:sh|bash|zsh|py)$/u;
const PYTHON = /\.py$/u;
const SQL = /\.sql$/u;
const HTML = /\.html$/u;

const SKIPPED = [
  /(?:^|\/)node_modules\//u,
  /^dashboard\/public\/vendor\//u,
  /(?:^|\/)[Ff]ixtures?\//u,
  /^macos-app\/benchmarks\/fixture\//u,
];

export function checked(path: string): boolean {
  if (SKIPPED.some((pattern) => pattern.test(path))) return false;
  return SCRIPT.test(path) || SWIFT.test(path) || CSS.test(path) || HASH.test(path) || SQL.test(path) || HTML.test(path);
}

export function commentsOf(path: string, text: string): Comment[] {
  if (SCRIPT.test(path)) return scriptComments(path, text);
  if (SWIFT.test(path)) return swiftComments(text);
  if (CSS.test(path)) return cssComments(text);
  if (PYTHON.test(path)) return pythonComments(text);
  if (HASH.test(path)) return shellComments(text);
  if (SQL.test(path)) return sqlComments(text);
  if (HTML.test(path)) return htmlComments(text);
  return [];
}

function scriptComments(path: string, text: string): Comment[] {
  const kind = /\.[jt]sx$/u.test(path) ? ts.ScriptKind.TSX : /\.[cm]?js$/u.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const found = new Map<number, Comment>();
  const take = (pos: number, end: number): void => {
    if (!found.has(pos)) found.set(pos, { start: pos, end, text: text.slice(pos, end) });
  };
  const jsxText: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (ts.isJsxText(node)) { jsxText.push([node.pos, node.end]); return; }
    const children = node.getChildren(source);
    if (children.length === 0) {
      ts.forEachLeadingCommentRange(text, node.pos, take);
      ts.forEachTrailingCommentRange(text, node.pos, take);
      ts.forEachTrailingCommentRange(text, node.end, take);
      return;
    }
    for (const child of children) visit(child);
  };
  visit(source);
  return [...found.values()]
    .filter((comment) => !jsxText.some(([pos, end]) => comment.start >= pos && comment.start < end))
    .sort((a, b) => a.start - b.start);
}

function swiftComments(text: string): Comment[] {
  const found: Comment[] = [];
  let i = 0;
  let last = "";
  const code = (closer: string | null): void => {
    let depth = 0;
    while (i < text.length) {
      const c = text[i]!;
      const next = text[i + 1];
      if (c === "/" && next === "/") {
        const end = text.indexOf("\n", i);
        const stop = end === -1 ? text.length : end;
        found.push({ start: i, end: stop, text: text.slice(i, stop) });
        i = stop;
        continue;
      }
      if (c === "/" && next === "*") {
        const start = i;
        let nest = 0;
        while (i < text.length) {
          if (text.startsWith("/*", i)) { nest += 1; i += 2; continue; }
          if (text.startsWith("*/", i)) { nest -= 1; i += 2; if (nest === 0) break; continue; }
          i += 1;
        }
        found.push({ start, end: i, text: text.slice(start, i) });
        continue;
      }
      if (c === "#" && /[#"/]/u.test(next ?? "")) {
        let hashes = 0;
        while (text[i + hashes] === "#") hashes += 1;
        if (text[i + hashes] === '"') { i += hashes; swiftString(hashes); last = '"'; continue; }
        if (text[i + hashes] === "/") {
          const end = text.indexOf(`/${"#".repeat(hashes)}`, i + hashes + 1);
          i = end === -1 ? text.length : end + 1 + hashes;
          last = "/";
          continue;
        }
      }
      if (c === '"') { swiftString(0); last = '"'; continue; }
      if (c === "/" && regexMayStart(last) && next !== undefined && !/\s/u.test(next)) {
        let j = i + 1;
        let inClass = false;
        while (j < text.length && text[j] !== "\n") {
          if (text[j] === "\\") { j += 2; continue; }
          if (text[j] === "[") inClass = true;
          else if (text[j] === "]") inClass = false;
          else if (text[j] === "/" && !inClass) break;
          j += 1;
        }
        if (text[j] === "/") { i = j + 1; last = "/"; continue; }
      }
      if (closer !== null) {
        if (c === "(") depth += 1;
        else if (c === ")") {
          if (depth === 0) { i += 1; return; }
          depth -= 1;
        }
      }
      if (!/\s/u.test(c)) last = SWIFT_WORD.test(c) ? swiftWordEnd(i) : c;
      i += 1;
    }
  };
  const swiftWordEnd = (at: number): string => {
    let start = at;
    while (start > 0 && SWIFT_WORD.test(text[start - 1]!)) start -= 1;
    let end = at;
    while (end + 1 < text.length && SWIFT_WORD.test(text[end + 1]!)) end += 1;
    return text.slice(start, end + 1);
  };
  const swiftString = (hashes: number): void => {
    const pad = "#".repeat(hashes);
    const multi = text.startsWith('"""', i);
    const close = (multi ? '"""' : '"') + pad;
    i += multi ? 3 : 1;
    while (i < text.length) {
      if (text.startsWith(`\\${pad}(`, i)) { i += 2 + hashes; code(")"); continue; }
      if (text.startsWith(`\\${pad}`, i)) { i += 2 + hashes; continue; }
      if (text.startsWith(close, i)) { i += close.length; return; }
      if (!multi && text[i] === "\n") return;
      i += 1;
    }
  };
  code(null);
  return found;
}

const SWIFT_WORD = /[\p{L}\p{N}\p{M}_$]/u;
const SWIFT_KEYWORDS_BEFORE_VALUE = new Set(["return", "case", "in", "where", "if", "guard", "while", "try", "await", "throw", "let", "var", "switch"]);

function regexMayStart(last: string): boolean {
  if (last === "") return true;
  if (/^[\p{L}\p{N}\p{M}_$]+$/u.test(last)) return SWIFT_KEYWORDS_BEFORE_VALUE.has(last);
  return !/[)\]}"'/]/u.test(last);
}

function cssComments(text: string): Comment[] {
  const found: Comment[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i += 1;
      while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      found.push({ start: i, end: stop, text: text.slice(i, stop) });
      i = stop;
      continue;
    }
    i += 1;
  }
  return found;
}

function sqlComments(text: string): Comment[] {
  const found: Comment[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      i += 1;
      while (i < text.length) {
        if (text[i] === close && text[i + 1] === close && close !== "]") { i += 2; continue; }
        if (text[i] === close) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      found.push({ start: i, end: stop, text: text.slice(i, stop) });
      i = stop;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      found.push({ start: i, end: stop, text: text.slice(i, stop) });
      i = stop;
      continue;
    }
    i += 1;
  }
  return found;
}

function htmlComments(text: string): Comment[] {
  const found: Comment[] = [];
  let at = text.indexOf("<!--");
  while (at !== -1) {
    const end = text.indexOf("-->", at + 4);
    const stop = end === -1 ? text.length : end + 3;
    found.push({ start: at, end: stop, text: text.slice(at, stop) });
    at = text.indexOf("<!--", stop);
  }
  return found;
}

function pythonComments(text: string): Comment[] {
  const found: Comment[] = [];
  let i = text.startsWith("#!") ? text.indexOf("\n") : 0;
  if (i === -1) return found;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      found.push({ start: i, end: stop, text: text.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      i += close.length;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (text.startsWith(close, i)) { i += close.length; break; }
        if (!triple && text[i] === "\n") break;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return found;
}

function shellComments(text: string): Comment[] {
  const found: Comment[] = [];
  let i = text.startsWith("#!") ? text.indexOf("\n") : 0;
  if (i === -1) return found;
  const heredocs: { word: string; tabs: boolean }[] = [];
  let boundary = true;
  let arithmetic = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\n") {
      i += 1;
      boundary = true;
      while (heredocs.length > 0) {
        const { word, tabs } = heredocs.shift()!;
        while (i < text.length) {
          const end = text.indexOf("\n", i);
          const stop = end === -1 ? text.length : end;
          const line = text.slice(i, stop);
          i = stop + 1;
          if ((tabs ? line.replace(/^\t+/u, "") : line) === word) break;
        }
      }
      continue;
    }
    if (c === "#" && boundary) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      found.push({ start: i, end: stop, text: text.slice(i, stop) });
      i = stop;
      continue;
    }
    if (c === " " || c === "\t" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      if (text.startsWith("((", i)) { arithmetic += 1; i += 2; boundary = true; continue; }
      if (arithmetic > 0 && text.startsWith("))", i)) { arithmetic -= 1; i += 2; boundary = true; continue; }
      boundary = true;
      i += 1;
      continue;
    }
    boundary = false;
    if (c === "\\") { i += 2; continue; }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '"' || c === "`") {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (text.startsWith("$((", i)) { arithmetic += 1; i += 3; boundary = true; continue; }
    if (text.startsWith("<<<", i)) { i += 3; continue; }
    if (text.startsWith("<<", i) && arithmetic === 0) {
      const opened = /^<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/u.exec(text.slice(i, i + 200));
      if (opened !== null) {
        heredocs.push({ word: opened[3]!, tabs: opened[1] === "-" });
        i += opened[0].length;
        continue;
      }
    }
    i += 1;
  }
  return found;
}

function bodyOf(comment: string): string {
  return comment
    .replace(/^(?:\/\/\/?|\/\*\*?|#|--|<!--)/u, "")
    .replace(/(?:\*\/|-->)$/u, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*(?!\/)\s?/u, ""))
    .join("\n")
    .trim();
}

const DIRECTIVES = [
  /^\/\/\s*swift-tools-version:/u,
  /^\/\/\s*@ts-(?:check|expect-error)\b/u,
  /^\/\/\/\s*<reference\s/u,
  /^#\s*shellcheck\s/u,
];

const NAME = String.raw`(?:[\w$.]+|\[[\w$.]+(?:=[^\]\s]+)?\])`;
const TEMPLATE = String.raw`(?:[\w$]+|\[[\w$]+=[^\]]+\])(?:\s*,\s*[\w$]+)*`;
const HERITAGE = /^(?:\{\}|[\w$.]+(?:<[^>]*>)?)$/u;

const TAG_REST = new Map<string, RegExp>([
  ["type", /^\{\}$/u],
  ["satisfies", /^\{\}$/u],
  ["this", /^\{\}$/u],
  ["enum", /^\{\}$/u],
  ["returns", /^\{\}$/u],
  ["return", /^\{\}$/u],
  ["extends", HERITAGE],
  ["augments", HERITAGE],
  ["implements", HERITAGE],
  ["param", new RegExp(`^\\{\\}\\s*${NAME}$`, "u")],
  ["property", new RegExp(`^\\{\\}\\s*${NAME}$`, "u")],
  ["prop", new RegExp(`^\\{\\}\\s*${NAME}$`, "u")],
  ["typedef", /^(?:\{\}\s*)?[\w$]+$/u],
  ["callback", /^[\w$]+$/u],
  ["template", new RegExp(`^(?:\\{\\}\\s*)?${TEMPLATE}$`, "u")],
  ["import", /^(?:\{\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s+(["'])[^"']+\1$/u],
  ["overload", /^$/u],
  ["readonly", /^$/u],
  ["private", /^$/u],
  ["protected", /^$/u],
  ["public", /^$/u],
  ["override", /^$/u],
]);

function bracedEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

function tagsOf(comment: string): { name: string; type: string; rest: string }[] | null {
  if (!comment.startsWith("/**")) return null;
  const body = bodyOf(comment);
  const tags: { name: string; type: string; rest: string }[] = [];
  let prose = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c === "@" && /[a-z]/u.test(body[i + 1] ?? "") && (i === 0 || /\s/u.test(body[i - 1]!))) {
      const name = /^[a-z]+/u.exec(body.slice(i + 1))![0];
      i += 1 + name.length;
      while (i < body.length && /\s/u.test(body[i]!)) i += 1;
      let type = "";
      if (body[i] === "{") {
        const end = bracedEnd(body, i);
        if (end === -1) return null;
        type = body.slice(i, end + 1).replace(/\s*\n\s*/gu, " ");
        i = end + 1;
      }
      let rest = "";
      while (i < body.length && !(body[i] === "@" && /[a-z]/u.test(body[i + 1] ?? "") && /\s/u.test(body[i - 1]!))) {
        if (body[i] === "{") {
          const end = bracedEnd(body, i);
          if (end === -1) return null;
          rest += body.slice(i, end + 1);
          i = end + 1;
          continue;
        }
        rest += body[i];
        i += 1;
      }
      tags.push({ name, type, rest: rest.replace(/\s+/gu, " ").trim() });
      continue;
    }
    if (c === "{") {
      const end = bracedEnd(body, i);
      if (end === -1) return null;
      prose += body.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    prose += c;
    i += 1;
  }
  return prose.trim() === "" ? tags : [{ name: "", type: "", rest: prose.trim() }, ...tags];
}

function tagFits({ name, type, rest }: { name: string; type: string; rest: string }): boolean {
  const pattern = TAG_REST.get(name);
  return pattern !== undefined && pattern.test([type === "" ? "" : "{}", rest.replace(/\{[^}]*\}/gu, "{}")].filter(Boolean).join(" "));
}

export function typesOnly(comment: string): boolean {
  const tags = tagsOf(comment);
  return tags !== null && tags.length > 0 && tags.every(tagFits);
}

const NAMED = new Set(["param", "property", "prop", "typedef", "callback", "template", "import", "extends", "augments", "implements"]);

export function typesOf(comment: string): string[] | null {
  const tags = tagsOf(comment);
  if (tags === null) return null;
  const kept = tags.flatMap(({ name, type, rest }) => {
    if (!TAG_REST.has(name)) return [];
    const head = name === "import"
      ? rest
      : name === "template"
        ? new RegExp(`^${TEMPLATE}`, "u").exec(rest)?.[0] ?? ""
        : new RegExp(`^${NAME}`, "u").exec(rest)?.[0] ?? "";
    const tag = { name, type, rest: NAMED.has(name) ? head : "" };
    return tagFits(tag) ? [[`@${name}`, type, tag.rest].filter(Boolean).join(" ")] : [];
  });
  return kept.length === 0 ? null : kept;
}

export function allowed(path: string, comment: string): boolean {
  if (DIRECTIVES.some((directive) => directive.test(comment))) return true;
  const body = bodyOf(comment);
  if (/^(?:external|paces):\s*\S/u.test(body)) return true;
  if (/^SPDX-License-Identifier:/u.test(body)) return true;
  return TYPED_BY_JSDOC.test(path) && typesOnly(comment);
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) line += 1;
  return line;
}

export const SDK = "packages/connect/sdk.ts";
const SDK_REACH = /^packages\/(?:connect|core)\/.*\.ts$/u;

export interface SdkDeclaration {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly required: boolean;
  readonly doc: Comment | null;
}

export function docFault(comment: string): string | null {
  if (!/^\/\*\*[^*]/u.test(comment) && comment !== "/***/") return "not a /** */ doc comment";
  const body = bodyOf(comment);
  if (/(?:^|[\s{])@[A-Za-z]/u.test(body)) return "carries an @ tag";
  if (/docs\//u.test(body) || body.includes("§")) return "names docs/ or §";
  const prose = body.replace(/`[^`]*`/gu, "code").replace(/\s+/gu, " ").trim();
  if (prose === "") return "empty";
  if (/[.!?]["')\]]*\s+\S/u.test(prose)) return "more than one sentence";
  if (!/[.!?]["')\]]*$/u.test(prose)) return "not a sentence ending in a full stop";
  return null;
}

export function sdkDeclarations(root: string, read: (path: string) => string | undefined = () => undefined): SdkDeclaration[] {
  const home = realpathSync(root);
  const entry = join(home, SDK);
  if (!existsSync(entry)) return [];
  const local = (fileName: string): string | null => {
    const path = relative(home, fileName);
    return path.startsWith("..") || path.includes("node_modules/") || path.endsWith(".d.ts") ? null : path;
  };
  const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, noLib: true, types: [], noEmit: true };
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (fileName, language) => {
    const path = local(fileName);
    const text = (path === null ? undefined : read(path)) ?? ts.sys.readFile(fileName);
    return text === undefined ? undefined : ts.createSourceFile(fileName, text, language, true);
  };
  const program = ts.createProgram({ rootNames: [entry], options, host });
  const checker = program.getTypeChecker();
  const marked = new Map<ts.Node, { name: ts.Node; required: boolean; bar?: number }>();
  const seen = new Set<ts.Node | ts.Symbol>();
  const mark = (node: ts.Node, required = true, name: ts.Node = node, bar?: number): void => {
    if (!marked.has(node)) marked.set(node, { name, required, ...(bar === undefined ? {} : { bar }) });
  };
  const target = (symbol: ts.Symbol | undefined): ts.Symbol | undefined =>
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  const reach = (symbol: ts.Symbol | undefined): void => {
    const found = target(symbol);
    if (found === undefined || seen.has(found)) return;
    seen.add(found);
    const declarations = found.declarations ?? [];
    for (const each of declarations) {
      if (ts.isSourceFile(each)) {
        for (const member of checker.getExportsOfModule(found)) reach(member);
        continue;
      }
      if (local(each.getSourceFile().fileName) === null) continue;
      declaration(each, declarations.length > 1);
    }
  };
  const named = (node: ts.EntityName | ts.Expression): void => reach(checker.getSymbolAtLocation(node));
  const signature = (node: ts.SignatureDeclarationBase): void => {
    for (const parameter of node.parameters) walk(parameter.type, false);
    walk(node.type, false);
  };
  const heritage = (node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration): void => {
    for (const clause of node.heritageClauses ?? []) for (const type of clause.types) walk(type, false);
  };
  const shown = (node: ts.ClassElement | ts.ParameterDeclaration): boolean => {
    if (node.name === undefined || ts.isComputedPropertyName(node.name) || ts.isPrivateIdentifier(node.name)) return false;
    return !(ts.getCombinedModifierFlags(node as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
  };
  const declaration = (node: ts.Declaration, overloaded: boolean): void => {
    if (ts.isInterfaceDeclaration(node)) {
      mark(node);
      heritage(node);
      for (const member of node.members) element(member, true);
    } else if (ts.isTypeAliasDeclaration(node)) {
      mark(node);
      walk(node.type, true, ts.isUnionTypeNode(node.type) && node.type.types.every(isClosedLiteral));
    } else if (ts.isClassDeclaration(node)) {
      mark(node);
      heritage(node);
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) {
          if (ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
          for (const parameter of member.parameters) {
            if (ts.isParameterPropertyDeclaration(parameter, member) && shown(parameter)) mark(parameter);
            walk(parameter.type, ts.isParameterPropertyDeclaration(parameter, member));
          }
        } else if ((ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && shown(member)) {
          mark(member);
          if (ts.isPropertyDeclaration(member)) walk(member.type, true);
          else signature(member);
        }
      }
    } else if (ts.isFunctionDeclaration(node)) {
      if (node.body === undefined || !overloaded) mark(node);
      signature(node);
    } else if (ts.isVariableDeclaration(node)) {
      const statement = node.parent.parent;
      if (ts.isVariableStatement(statement)) mark(statement, true, node);
      walk(node.type, false);
      const literals = constList(node.initializer);
      for (const element of literals) mark(element);
      if (node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) signature(node.initializer);
    } else if (ts.isEnumDeclaration(node)) {
      mark(node);
      for (const member of node.members) mark(member);
    }
  };
  const element = (member: ts.TypeElement, marking: boolean): void => {
    if (marking && (ts.isPropertySignature(member) || ts.isMethodSignature(member))) mark(member);
    if (ts.isPropertySignature(member)) walk(member.type, marking);
    else if (ts.isMethodSignature(member) || ts.isCallSignatureDeclaration(member) || ts.isConstructSignatureDeclaration(member)) signature(member);
    else if (ts.isIndexSignatureDeclaration(member)) walk(member.type, marking);
  };
  const walk = (node: ts.Node | undefined, marking: boolean, closed = false): void => {
    if (node === undefined) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (ts.isTypeLiteralNode(node)) {
      for (const member of node.members) element(member, marking);
    } else if (ts.isUnionTypeNode(node)) {
      for (const [index, type] of node.types.entries()) {
        if (marking && ts.isLiteralTypeNode(type)) mark(type, closed, type, index === 0 ? node.pos : node.types[index - 1]!.end);
        else walk(type, marking);
      }
    } else if (ts.isTypeReferenceNode(node)) {
      named(node.typeName);
      for (const argument of node.typeArguments ?? []) walk(argument, marking);
    } else if (ts.isExpressionWithTypeArguments(node)) {
      named(node.expression);
      for (const argument of node.typeArguments ?? []) walk(argument, marking);
    } else if (ts.isTypeQueryNode(node)) {
      named(node.exprName);
    } else if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
      signature(node);
    } else {
      ts.forEachChild(node, (child) => walk(child, marking));
    }
  };
  const sdk = program.getSourceFile(entry);
  const module = sdk === undefined ? undefined : checker.getSymbolAtLocation(sdk);
  if (module !== undefined) for (const symbol of checker.getExportsOfModule(module)) reach(symbol);
  return [...marked].map(([node, { name, required, bar }]) => {
    const source = node.getSourceFile();
    const text = source.text;
    const docAt = (pos: number, rest: string): Comment | null => {
      const last = [...ts.getTrailingCommentRanges(text, pos) ?? [], ...ts.getLeadingCommentRanges(text, pos) ?? []].at(-1);
      return last !== undefined && text.startsWith("/**", last.pos) && text.slice(last.end, node.getStart(source)).trim() === rest
        ? { start: last.pos, end: last.end, text: text.slice(last.pos, last.end) }
        : null;
    };
    const doc = docAt(node.pos, "") ?? (bar === undefined ? null : docAt(bar, "|"));
    return { file: local(source.fileName)!, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, name: nameOf(name), required, doc };
  }).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function isClosedLiteral(type: ts.TypeNode): boolean {
  return ts.isLiteralTypeNode(type) && (ts.isStringLiteral(type.literal) || ts.isNumericLiteral(type.literal));
}

function constList(initializer: ts.Expression | undefined): readonly ts.Expression[] {
  let node = initializer;
  let constant = false;
  while (node !== undefined && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))) {
    if (ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === "const") constant = true;
    node = node.expression;
  }
  return constant && node !== undefined && ts.isArrayLiteralExpression(node) && node.elements.every((each) => ts.isStringLiteral(each) || ts.isNumericLiteral(each))
    ? node.elements
    : [];
}

function nameOf(node: ts.Node): string {
  const parts: string[] = [];
  for (let at: ts.Node | undefined = node; at !== undefined && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isLiteralTypeNode(at) || ts.isStringLiteral(at) || ts.isNumericLiteral(at)) {
      if (parts.length === 0) parts.unshift(at.getText());
      continue;
    }
    const name = (at as { name?: ts.Node }).name;
    if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) parts.unshift(name.text);
  }
  return parts.join(".");
}

export function refusedIn(path: string, text: string, sdk: readonly SdkDeclaration[] = []): (Comment & { line: number; why?: string; kept?: true })[] {
  const docs = new Set(sdk.flatMap(({ doc }) => (doc === null ? [] : [doc.start])));
  return commentsOf(path, text).flatMap((comment) => {
    const line = lineAt(text, comment.start);
    if (docs.has(comment.start)) {
      const why = docFault(comment.text);
      return why === null ? [] : [{ ...comment, line, why, kept: true as const }];
    }
    return allowed(path, comment.text) ? [] : [{ ...comment, line }];
  });
}

export function missingIn(sdk: readonly SdkDeclaration[]): Refused[] {
  return sdk.filter(({ required, doc }) => required && doc === null).map(({ file, line, name }) => ({ file, line, text: name, why: "no doc comment" }));
}

export function strip(text: string, comments: readonly Comment[], path = ""): string {
  let out = text;
  for (const comment of [...comments].sort((a, b) => b.start - a.start)) {
    const lineStart = out.lastIndexOf("\n", comment.start - 1) + 1;
    const newline = out.indexOf("\n", comment.end);
    const lineEnd = newline === -1 ? out.length : newline;
    const before = out.slice(lineStart, comment.start);
    const after = out.slice(comment.end, lineEnd);
    const types = TYPED_BY_JSDOC.test(path) ? typesOf(comment.text) : null;
    if (types !== null) {
      const alone = before.trim() === "";
      const kept = types.length === 1 || !alone
        ? `/** ${types.join(" ")} */`
        : ["/**", ...types.map((tag) => `${before} * ${tag}`), `${before} */`].join("\n");
      out = out.slice(0, comment.start) + kept + out.slice(comment.end);
    } else if (before.trim() === "" && after.trim() === "") {
      out = out.slice(0, lineStart) + out.slice(newline === -1 ? lineEnd : lineEnd + 1);
    } else if (after.trim() === "") {
      out = out.slice(0, comment.start).replace(/[ \t]+$/u, "") + out.slice(comment.end).replace(/^[ \t]+/u, "");
    } else if (before.trim() === "") {
      out = out.slice(0, comment.start) + out.slice(comment.end).replace(/^[ \t]+/u, "");
    } else if (comment.text.includes("\n")) {
      out = out.slice(0, comment.start).replace(/[ \t]+$/u, "") + "\n" + out.slice(comment.end).replace(/^[ \t]+/u, "");
    } else {
      const head = /[ \t([{]$/u.test(before) ? out.slice(comment.end).replace(/^[ \t]+/u, "") : out.slice(comment.end);
      const tail = /^[)\]},;]/u.test(head) ? out.slice(0, comment.start).replace(/[ \t]+$/u, "") : out.slice(0, comment.start);
      const apart = /[^\s([{]$/u.test(tail) && /^[^\s)\]},;]/u.test(head);
      out = tail + (apart ? " " : "") + head;
    }
  }
  return out;
}

function bare(path: string, text: string): string {
  return strip(text, commentsOf(path, text)).split("\n").map((line) => line.trimEnd()).filter((line) => line !== "").join("\n");
}

export function commentsAlone(path: string, before: string, after: string): boolean {
  return before !== after && checked(path) && bare(path, before) === bare(path, after);
}

export type Scope = "lane" | "staged" | "all";

function listed(root: string, ...args: string[]): string[] {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
}

function filesOf(root: string, scope: Scope): string[] {
  if (scope === "staged") return listed(root, "diff", "--cached", "--name-only", "-z", "--diff-filter=d");
  const untracked = listed(root, "ls-files", "-z", "--others", "--exclude-standard");
  if (scope === "all") return [...listed(root, "ls-files", "-z"), ...untracked];
  const base = execFileSync("git", ["-C", root, "merge-base", "HEAD", "main"], { encoding: "utf8" }).trim();
  return [...listed(root, "diff", "--name-only", "-z", "--diff-filter=d", base), ...untracked];
}

function reachableOf(root: string, scope: Scope): string[] {
  const packages = ["--", "packages/connect", "packages/core"];
  const indexed = listed(root, "ls-files", "-z", ...packages);
  return scope === "staged" ? indexed : [...indexed, ...listed(root, "ls-files", "-z", "--others", "--exclude-standard", ...packages)];
}

function textOf(root: string, scope: Scope, path: string): string | null {
  if (scope !== "staged") return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
  try {
    return execFileSync("git", ["-C", root, "show", `:${path}`], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export function checkComments(root: string, scope: Scope, fix = false): { refused: Refused[]; fixed: number } {
  const refused: Refused[] = [];
  let fixed = 0;
  const texts = new Map<string, string>();
  const read = (paths: Iterable<string>): void => {
    for (const path of new Set(paths)) {
      if (!checked(path) || texts.has(path)) continue;
      const text = textOf(root, scope, path);
      if (text !== null) texts.set(path, text);
    }
  };
  read(filesOf(root, scope));
  if (texts.has(SDK)) read(reachableOf(root, scope).filter((path) => SDK_REACH.test(path)));
  const reached = [...texts.keys()].some((path) => SDK_REACH.test(path))
    ? sdkDeclarations(root, (path) => (scope === "staged" ? texts.get(path) ?? textOf(root, scope, path) ?? undefined : undefined))
    : [];
  for (const [path, text] of texts) {
    const sdk = reached.filter(({ file }) => file === path);
    const found = refusedIn(path, text, sdk);
    const deleted = fix ? found.filter(({ kept }) => kept !== true) : [];
    if (deleted.length > 0) {
      writeFileSync(join(root, path), strip(text, deleted, path));
      fixed += deleted.length;
    }
    for (const comment of found) {
      if (deleted.includes(comment)) continue;
      refused.push({ file: path, line: comment.line, text: comment.text.split("\n")[0]!.trim().slice(0, 100), ...(comment.why === undefined ? {} : { why: comment.why }) });
    }
  }
  refused.push(...missingIn(reached));
  return { refused, fixed };
}

export const ADVICE = [
  "Code says what it does. A comment is a rule nothing enforces, and the next agent copies the workaround it excuses:",
  "  - a workaround: fix its cause;",
  "  - a rule: make it a test, a type or a check;",
  "  - what a name or a shape could say: rename, extract, type;",
  "  - a fact about what the repo cannot change (macOS, iOS, a provider, a protocol): `// external: …`;",
  "  - a sleep in a test that paces: `// paces: …`;",
  "  - in JavaScript, JSDoc that holds only types (`@type`, `@param {T} name`, `@returns`, `@typedef`, `@import`).",
  "What `packages/connect/sdk.ts` exports is the exception: every declaration and member it reaches carries a `/** … */`",
  "directly on it, one sentence saying what it means or does, with no `docs/`, `§` or `@` tag; a rule with a wrong value is a",
  "check (`packages/connect/admit.ts`, `packages/home/conformance.ts`), never a doc comment. `--sdk` lists every one still missing.",
  "`npx tsx tools/check-comments.ts --fix` deletes the others from every file the change touched (`--all`: every file).",
].join("\n");

function worklist(root: string): void {
  const missing = sdkDeclarations(root).filter(({ required, doc }) => required && doc === null);
  const files = new Map<string, number>();
  for (const { file, line, name } of missing) {
    console.log(`${file}:${line}: ${name}`);
    files.set(file, (files.get(file) ?? 0) + 1);
  }
  for (const [file, count] of files) console.log(`${String(count).padStart(5)} ${file}`);
  console.log(`check-comments: ${missing.length} SDK declaration(s) in ${files.size} file(s) have no doc comment`);
}

function main(): void {
  const staged = process.argv.includes("--staged");
  const fix = process.argv.includes("--fix");
  const all = process.argv.includes("--all");
  if (staged && (fix || all)) {
    console.error("check-comments: --staged reads the index; it takes no --fix or --all");
    process.exit(2);
  }
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  if (process.argv.includes("--sdk")) {
    worklist(root);
    return;
  }
  const { refused, fixed } = checkComments(root, staged ? "staged" : all ? "all" : "lane", fix);
  if (fix) console.log(`check-comments: ${fixed} comment(s) deleted`);
  if (refused.length === 0) return;
  for (const { file, line, text, why } of refused) console.log(`${file}:${line}: ${text}${why === undefined ? "" : ` (${why})`}`);
  console.log(`check-comments: ${refused.length} comment(s)\n${ADVICE}`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
