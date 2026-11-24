import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { MAC_ONLY, macOnly, QUARANTINE, quarantined } from "../testing/files.mjs";

export interface Break {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

const LATENCY = "packages/home/home-full.e2e.test.ts";
const TEST = /(?:\.test\.(?:ts|mts|mjs)$)|(?:^(?:packages\/[^/]+|dashboard|mcp|extension)\/(?:.*\/)?test\/[^/]+\.(?:ts|mts|mjs)$)/u;
const RUNNERS = new Set(["it", "test", "describe", "suite", "beforeAll", "afterAll", "beforeEach", "afterEach", "before", "after"]);
const MODIFIERS = new Set(["each", "for", "skip", "skipIf", "runIf", "only", "concurrent", "sequential", "todo", "fails"]);
const WAITS: readonly (readonly [string, string])[] = [
  ["packages/model/", "packages/model/model.e2e.test.ts"],
  ["packages/runner/", "packages/runner/runner.e2e.test.ts"],
  ["packages/", "packages/home/test/harness-root.ts"],
  ["extension/", "extension/test/until.ts"],
  ["mcp/", "mcp/test/until.mjs"],
  ["dashboard/", "dashboard/test/until.mjs"],
];
const SLEEPS = new Set(["sleep", "delay"]);
const SLEEP_MS = 200;
const CLOCK_CALL = /^(?:Date\.now|performance\.now|process\.hrtime(?:\.bigint)?)\(\)$/u;
const SWIFT_UI = /^ios-app\/LifestreamCaptureUITests\/[^/]+\.swift$/u;
const SWIFT_SLEEP = /\b(?:usleep|sleep)\s*\(|\bRunLoop\.\w+\.run\(until:/u;
const SWIFT_SCROLL = /\.(?:swipeUp|swipeDown)\(|thenDragTo:/u;
const SWIFT_TIMED = /\b(?:waitForExistence|waitForNonExistence|waitForExpectations|waitUntil)\s*\(|\bXCTWaiter\b|\.wait\s*\(\s*for:|\(\s*within:/gu;
const HELPERS = new Set(["UITestNavigation.swift", "UITestKit.swift"]);
const EXEMPT = new Set([...HELPERS, "SpeedUITests.swift", "ScreenTourUITests.swift", "AppDiscoveryUITests.swift"]);
const UI_TESTS = { total: 40 };
const HELD = new Set(["AskFlowUITests.swift", "SearchFlowUITests.swift", "AgentSignInUITests.swift"]);
const SWIFT_UI_FOLDER = "ios-app/LifestreamCaptureUITests";
const SWIFT_TEST = /^\s*(?:(?:private|fileprivate|internal|public|override|final|@\w+)\s+)*func\s+(test\w*)\s*\(/u;
const SWIFT_LAUNCH = /\blaunchArguments\b|\bXCUIApplication\s*\(|\.\s*launch\s*\(\s*\)/gu;
const SWIFT_STRING = String.raw`"((?:[^"\\\n]|\\.)*)"`;
const SWIFT_NAME = String.raw`(?<![\w.$])([A-Za-z_]\w*)(?![\w.(\[])`;
const swiftLookups = (value: string): RegExp[] => [
  new RegExp(String.raw`(?<=[\w\])])\[\s*${value}\s*\]`, "gu"),
  new RegExp(String.raw`\.(?:contains|hasPrefix|hasSuffix)\(\s*${value}`, "gu"),
  new RegExp(String.raw`\b(?:said|text|item|by|row|menuItem|noteText)\(\s*(?:[\w.]+\s*,\s*)?${value}`, "gu"),
  new RegExp(String.raw`\b(?:becomes|saying):\s*${value}`, "gu"),
  new RegExp(String.raw`[!=]=\s*${value}`, "gu"),
  new RegExp(String.raw`${value}\s*[!=]=`, "gu"),
];
const SWIFT_LABEL_QUOTED = /\blabel\s*(?:==|!=|CONTAINS|BEGINSWITH|ENDSWITH|LIKE|MATCHES)(?:\[\w+\])?\s*'([^']*)'/gu;
const SWIFT_PLACEHOLDER = /%(?:@|K|l{0,2}[dfiu])/gu;
const SWIFT_LABEL_BOUND = /\blabel\s*(?:==|!=|CONTAINS|BEGINSWITH|ENDSWITH|LIKE|MATCHES)(?:\[\w+\])?\s*$/u;
const SWIFT_BOUND = new RegExp(String.raw`\b(?:let|var)\s+([A-Za-z_]\w*)\s*(?::\s*String\s*)?=\s*${SWIFT_STRING}[ \t]*(?=$|[;}\n])`, "gmu");
const SWIFT_HANDED = (value: string) => new RegExp(String.raw`(?:\.typeText|\btype|\b(?:re)?launch)\(\s*(?:"[^"\n]*"\s*,\s*)*${value}`, "gu");
const LOOKUP_WORDS = 4;

export function checkTests(root: string): Break[] {
  const files = testFiles(root);
  const breaks: Break[] = checkSwift(root, files.filter((file) => SWIFT_UI.test(file)));
  for (const { path, line } of existsSync(join(root, MAC_ONLY)) ? macOnly(root) : []) {
    if (!existsSync(join(root, path))) breaks.push({ file: MAC_ONLY, line, what: `${path} is no file: take its line off, or name the file it became` });
  }
  for (const { path, line } of existsSync(join(root, QUARANTINE)) ? quarantined(root) : []) {
    const swift = /^([\w-]+(?:\/[\w-]+)*)\/(\w+)\/\w+\/(\w+)$/u.exec(path);
    const manifest = swift === null ? "" : join(root, swift[1]!, "Package.swift");
    const declared = swift === null || !existsSync(manifest) ? undefined : new RegExp(`name: "${swift[2]}"[^)]*path: "([^"]+)"`, "u").exec(readFileSync(manifest, "utf8"))?.[1];
    const folders = swift === null ? [] : [join(root, swift[1]!, swift[2]!), join(root, swift[1]!, "Tests", swift[2]!), ...(declared === undefined ? [] : [join(root, swift[1]!, declared)])].filter((folder) => existsSync(folder));
    const there = swift === null
      ? existsSync(join(root, path))
      : folders.some((folder) => readdirSync(folder).some((name) => name.endsWith(".swift") && readFileSync(join(folder, name), "utf8").includes(`func ${swift[3]}(`)));
    if (!there) breaks.push({ file: QUARANTINE, line, what: `${path} is no test: take its line off, or name the test as it is now` });
  }
  for (const file of files.filter((file) => !SWIFT_UI.test(file))) {
    const text = readFileSync(join(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".ts") || file.endsWith(".mts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const lines = text.split("\n");
    const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const add = (node: ts.Node, what: string) => breaks.push({ file, line: at(node), what });
    const latency = file === LATENCY;
    const helper = WAITS.find(([folder]) => file.startsWith(folder))?.[1] ?? WAITS.find(([folder]) => folder === "packages/")![1];
    const starts = new Set<string>();
    const durations = new Set<string>();
    const visit = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === "until" && file !== helper) {
        add(node, `a wait helper of its own: use ${helper}, the suite's one wait, which names what it waits for and gives up in 30 s`);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        if (CLOCK_CALL.test(node.initializer.getText(source))) starts.add(node.name.text);
        else if (isDuration(node.initializer, source, starts)) durations.add(node.name.text);
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (RUNNERS.has(runner(callee))) {
          const last = node.arguments.at(-1);
          if (last !== undefined && node.arguments.length > 1 && !ts.isFunctionLike(last)) add(node, `a timeout stated by hand (${last.getText(source)}): the config's one timeout ends a hung test`);
          for (const argument of node.arguments) {
            if (!ts.isObjectLiteralExpression(argument)) continue;
            const timeout = argument.properties.find((property) => property.name?.getText(source) === "timeout");
            if (timeout !== undefined) add(node, `a timeout stated by hand (${timeout.getText(source)}): the config's one timeout ends a hung test`);
          }
        }
        const ms = sleepMs(node);
        if (ms !== null && Number(ms.replaceAll("_", "")) >= SLEEP_MS && !paces(lines, at(node))) {
          add(node, `a sleep of ${ms} ms: wait for an event that shows the point passed (or a paces: comment above it, where nothing is recorded)`);
        }
        if (ts.isPropertyAccessExpression(callee) && callee.getText(source) === "AbortSignal.timeout") add(node, "AbortSignal.timeout: a time the machine sets; wait for the answer");
        if (!latency && isAssertion(callee, source)) {
          for (const argument of node.arguments) {
            const named = timed(argument, source, starts, durations);
            if (named !== null) {
              add(node, `a duration in an assertion (${named}): assert a count or a state the code records`);
              break;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return breaks.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function checkSwift(root: string, files: readonly string[]): Break[] {
  const breaks: Break[] = [];
  let total = 0;
  for (const file of files) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    const exempt = EXEMPT.has(name);
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    lines.forEach((text, index) => {
      if (/^\s*(?:\/\/|\*)/u.test(text)) return;
      if (SWIFT_SLEEP.test(text) && !paces(lines, index + 1)) breaks.push({ file, line: index + 1, what: "a sleep: wait on what the app shows (`appears()`, `vanishes()`, `until`), or a paces: comment above it where nothing is recorded" });
      if (!exempt && SWIFT_SCROLL.test(text)) {
        breaks.push({ file, line: index + 1, what: "a swipe or drag of its own: scroll with UITestNavigation's `bringIntoView` or `scrolledTo`, close a sheet with `swipeAway`, drag a gesture under test with `drag(to:)`" });
      }
    });
    if (exempt) continue;
    const code = lines.map((text) => (/^\s*(?:\/\/|\*)/u.test(text) ? "" : text)).join("\n");
    const lineOf = (index: number) => code.slice(0, index).split("\n").length;
    const timed = new Set([...code.matchAll(SWIFT_TIMED)].map((match) => lineOf(match.index)));
    for (const line of timed) {
      breaks.push({ file, line, what: "a wait with a time of its own: wait through UITestNavigation's `until(what)`, `appears(what)` or `vanishes(what)`, which give up in 30 s" });
    }
    if (HELD.has(name)) continue;
    total += code.split("\n").filter((text) => SWIFT_TEST.test(text)).length;
    for (const line of new Set([...code.matchAll(SWIFT_LAUNCH)].map((match) => lineOf(match.index)))) {
      breaks.push({ file, line, what: "a launch of its own: launch through UITestKit's `launch` (or `relaunch`), dark, opened on its page with `open:`; SpringBoard is its `springboard`" });
    }
    const bound = new Map<string, string>();
    for (const match of code.matchAll(SWIFT_BOUND)) if (!bound.has(match[1]!)) bound.set(match[1]!, match[2]!);
    const handed = [...code.matchAll(SWIFT_HANDED(`(?:${SWIFT_STRING}|${SWIFT_NAME})`))]
      .map((match) => match[1] ?? bound.get(match[2]!))
      .filter((text): text is string => text !== undefined);
    const typed = (literal: string) => handed.some((text) => text.includes(literal))
      || !/\p{L}/u.test(handed.reduce((rest, text) => rest.replaceAll(text, " "), literal));
    const copied = new Map<number, string>();
    const keep = (index: number, literal: string | undefined) => {
      if (literal === undefined || words(literal) < LOOKUP_WORDS || typed(literal) || copied.has(lineOf(index))) return;
      copied.set(lineOf(index), literal);
    };
    const literalOf = (text: string) => {
      const value = new RegExp(String.raw`^\s*(?:${SWIFT_STRING}|([A-Za-z_]\w*))\s*$`, "u").exec(text);
      return value === null ? undefined : value[1] ?? bound.get(value[2]!);
    };
    for (const pattern of [...swiftLookups(SWIFT_STRING), SWIFT_LABEL_QUOTED]) {
      for (const match of code.matchAll(pattern)) keep(match.index, match[1]!);
    }
    if (bound.size > 0) {
      for (const pattern of swiftLookups(SWIFT_NAME)) for (const match of code.matchAll(pattern)) keep(match.index, bound.get(match[1]!));
    }
    for (const match of code.matchAll(/NSPredicate(?=\(\s*format:)/gu)) {
      const [format, ...rest] = callArguments(code, match.index + match[0].length);
      const text = format === undefined ? undefined : literalOf(format.text.replace(/^\s*format:/u, ""));
      if (text === undefined) continue;
      [...text.matchAll(SWIFT_PLACEHOLDER)].forEach((placeholder, at) => {
        const argument = rest[at];
        if (argument !== undefined && SWIFT_LABEL_BOUND.test(text.slice(0, placeholder.index))) keep(argument.at, literalOf(argument.text));
      });
    }
    for (const match of code.matchAll(/\bXCTAssertEqual\s*\(/gu)) {
      for (const argument of callArguments(code, match.index + match[0].length - 1).slice(0, 2)) {
        keep(argument.at + argument.text.search(/\S/u), literalOf(argument.text));
      }
    }
    for (const [line, literal] of copied) {
      breaks.push({ file, line, what: `copy as a lookup ("${literal}"): find the element by its accessibility identifier; when the words are the point, a unit test owns them` });
    }
  }
  if (total > UI_TESTS.total) {
    breaks.push({ file: SWIFT_UI_FOLDER, line: 0, what: `${total} UI tests, more than ${UI_TESTS.total}: fold the journeys that are not independent, and leave a rule, its states and its words to a unit test` });
  }
  return breaks;
}

function words(literal: string): number {
  return literal.replace(/\\\((?:[^()]|\([^()]*\))*\)/gu, " ").split(/\s+/u).filter((token) => /\p{L}/u.test(token)).length;
}

function callArguments(code: string, open: number): { text: string; at: number }[] {
  const found: { text: string; at: number }[] = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open; index < code.length; index++) {
    const char = code[index]!;
    if (char === '"') {
      for (index++; index < code.length && code[index] !== '"' && code[index] !== "\n"; index++) {
        if (code[index] === "\\") {
          index++;
          if (code[index] === "(") {
            let nested = 1;
            while (nested > 0 && ++index < code.length) {
              if (code[index] === "(") nested++;
              else if (code[index] === ")") nested--;
            }
          }
        }
      }
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) {
        found.push({ text: code.slice(start, index), at: start });
        return found;
      }
    } else if (char === "," && depth === 1) {
      found.push({ text: code.slice(start, index), at: start });
      start = index + 1;
    }
  }
  return found;
}

function runner(callee: ts.Expression): string {
  let node: ts.Expression = callee;
  for (;;) {
    if (ts.isCallExpression(node)) node = node.expression;
    else if (ts.isPropertyAccessExpression(node) && MODIFIERS.has(node.name.text)) node = node.expression;
    else break;
  }
  return ts.isIdentifier(node) ? node.text : "";
}

function sleepMs(call: ts.CallExpression): string | null {
  const callee = call.expression;
  const [first, second] = call.arguments;
  if (ts.isIdentifier(callee) && callee.text === "setTimeout" && first !== undefined && second !== undefined && ts.isNumericLiteral(second)) return second.getText();
  if (ts.isIdentifier(callee) && SLEEPS.has(callee.text) && first !== undefined && ts.isNumericLiteral(first)) return first.getText();
  return null;
}

function paces(lines: readonly string[], line: number): boolean {
  return lines.slice(Math.max(0, line - 4), line).some((text) => /(?:\/\/|\/\*|\*)\s*paces:\s*\S/u.test(text));
}

function isAssertion(callee: ts.Expression, source: ts.SourceFile): boolean {
  const name = callee.getText(source);
  return name === "expect" || name === "assert" || /^assert\.\w+$/u.test(name);
}

function isDuration(node: ts.Node, source: ts.SourceFile, starts: ReadonlySet<string>): boolean {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.MinusToken && CLOCK_CALL.test(node.left.getText(source))
    && ts.isIdentifier(node.right) && starts.has(node.right.text);
}

function timed(node: ts.Node, source: ts.SourceFile, starts: ReadonlySet<string>, durations: ReadonlySet<string>): string | null {
  if (isDuration(node, source, starts)) return node.getText(source);
  if (ts.isIdentifier(node) && durations.has(node.text)) return node.text;
  return ts.forEachChild(node, (child) => timed(child, source, starts, durations) ?? undefined) ?? null;
}

function testFiles(root: string): string[] {
  const listed = (...args: string[]) => execFileSync("git", ["-C", root, "ls-files", ...args], { encoding: "utf8" }).split("\n").filter(Boolean);
  const lane = execFileSync("git", ["-C", root, "rev-parse", "--git-dir"], { encoding: "utf8" }).includes("/worktrees/");
  const files = [...listed(), ...(lane ? listed("--others", "--exclude-standard") : [])];
  return [...new Set(files)].filter((file) => (SWIFT_UI.test(file) || (TEST.test(file) && !file.includes("node_modules/"))) && existsSync(join(root, file)));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const breaks = checkTests(root);
  for (const entry of breaks) process.stdout.write(`${relative(root, join(root, entry.file))}:${entry.line}: ${entry.what}\n`);
  if (breaks.length > 0) {
    process.stdout.write(`check-tests: ${breaks.length} broken (each line says its rule)\n`);
    process.exit(1);
  }
}
