import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const LAYERS = {
  core: [],
  connect: ["core"],
  families: ["core"],
  model: ["core"],
  privacy: ["core"],
  home: ["core", "connect", "families", "model", "privacy"],
  runner: ["core", "model"],
} as const satisfies Record<string, readonly string[]>;

type PackageName = keyof typeof LAYERS;

const PACKAGE_NAMES = Object.keys(LAYERS) as PackageName[];

const WORKSPACES = "packages/*";

const pathOf = (packageName: PackageName): string => `packages/${packageName}`;

const ALLOWED_IMPORTS: ReadonlyMap<PackageName, ReadonlySet<string>> = allowedImports();

const TEST_IMPORTS: ReadonlyMap<PackageName, ReadonlySet<string>> = new Map([["families", new Set(["@lifestreamprotocol/connect"])]]);

const FROM_SPECIFIER = /\b(?:import|export)\s+(?:type\s+)?[^"'`;]*?\s+from\s+(["'])([^"']+)\1/gu;
const BARE_IMPORT = /\bimport\s*(["'])([^"']+)\1/gu;

export interface LayerViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: "relative import leaves package" | "package import is not allowed";
  readonly specifier: string;
}

export interface ManifestViolation {
  readonly file: string;
  readonly rule:
    | "manifest cannot be read"
    | "declared dependency is not allowed"
    | "allowed dependency is not declared"
    | "workspaces are not packages/*"
    | "package is not in the layer order";
  readonly detail: string;
}

export function checkLayers(root: string): LayerViolation[] {
  const absoluteRoot = resolve(root);
  const violations: LayerViolation[] = [];
  for (const packageName of PACKAGE_NAMES) {
    const packageRoot = resolve(absoluteRoot, pathOf(packageName));
    for (const file of typescriptFiles(packageRoot)) {
      const source = readFileSync(file, "utf8");
      const specifiers = [
        ...matches(source, FROM_SPECIFIER),
        ...matches(source, BARE_IMPORT),
      ].sort((left, right) => left.index - right.index);
      for (const { index, specifier } of specifiers) {
        const line = source.slice(0, index).split("\n").length;
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          const fromPackage = relative(packageRoot, target);
          if (fromPackage === ".." || fromPackage.startsWith(`..${sep}`)) {
            violations.push({
              file: relative(absoluteRoot, file),
              line,
              rule: "relative import leaves package",
              specifier,
            });
          }
          continue;
        }
        const importedPackage = lifestreamPackageName(specifier);
        if (packageName === "connect" && specifier === SDK) continue;
        if (importedPackage !== null && isTest(relative(packageRoot, file)) && TEST_IMPORTS.get(packageName)?.has(importedPackage) === true) continue;
        if (importedPackage !== null && !ALLOWED_IMPORTS.get(packageName)!.has(importedPackage)) {
          violations.push({
            file: relative(absoluteRoot, file),
            line,
            rule: "package import is not allowed",
            specifier,
          });
        }
      }
    }
  }
  return violations;
}

export function checkManifests(root: string): ManifestViolation[] {
  const absoluteRoot = resolve(root);
  const violations: ManifestViolation[] = [];
  for (const packageName of PACKAGE_NAMES) {
    const file = join(pathOf(packageName), "package.json");
    const manifest = readManifest(resolve(absoluteRoot, file));
    if (typeof manifest === "string") {
      violations.push({ file, rule: "manifest cannot be read", detail: manifest });
      continue;
    }
    const dependencies = manifest.dependencies;
    const declared = new Set(
      (isObject(dependencies) ? Object.keys(dependencies) : []).filter(
        (name) => lifestreamPackageName(name) === name,
      ),
    );
    const allowed = ALLOWED_IMPORTS.get(packageName)!;
    for (const name of [...declared].sort()) {
      if (!allowed.has(name)) {
        violations.push({ file, rule: "declared dependency is not allowed", detail: name });
      }
    }
    for (const name of [...allowed].sort()) {
      if (!declared.has(name)) {
        violations.push({ file, rule: "allowed dependency is not declared", detail: name });
      }
    }
  }
  const rootManifest = readManifest(resolve(absoluteRoot, "package.json"));
  if (typeof rootManifest === "string") {
    violations.push({ file: "package.json", rule: "manifest cannot be read", detail: rootManifest });
    return violations;
  }
  const workspaces = rootManifest.workspaces;
  if (!Array.isArray(workspaces) || workspaces.length !== 1 || workspaces[0] !== WORKSPACES) {
    violations.push({ file: "package.json", rule: "workspaces are not packages/*", detail: JSON.stringify(workspaces ?? null) });
  }
  const named = new Set<string>(PACKAGE_NAMES);
  for (const entry of readdirSync(resolve(absoluteRoot, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory() && !named.has(entry.name)) {
      violations.push({ file: `packages/${entry.name}`, rule: "package is not in the layer order", detail: entry.name });
    }
  }
  return violations;
}

export function formatViolation(violation: LayerViolation | ManifestViolation | FolderViolation): string {
  if ("specifier" in violation) return `${violation.file}:${violation.line}: ${violation.rule}: ${violation.specifier}`;
  return "line" in violation && violation.line > 0
    ? `${violation.file}:${violation.line}: ${violation.rule}: ${violation.detail}`
    : `${violation.file}: ${violation.rule}: ${violation.detail}`;
}

export function runLayerCheck(
  root: string,
  output: (text: string) => void = (text) => process.stdout.write(text),
  error: (text: string) => void = (text) => process.stderr.write(text),
): 0 | 1 {
  const violations = [...checkLayers(root), ...checkManifests(root), ...checkFolderImports(root), ...checkConnectorNames(root), ...checkStoreOpens(root), ...checkKeyUse(root), ...checkWorker(root)];
  if (violations.length === 0) {
    output("layer check: clean\n");
    return 0;
  }
  for (const violation of violations) error(`${formatViolation(violation)}\n`);
  error(`layer check: ${violations.length} violation(s)\n`);
  return 1;
}


const SDK = "@lifestreamprotocol/connect/sdk";

const HOME_OWN: ReadonlySet<string> = new Set(["ask", "cameras", "devices", "faces", "google-places", "groups", "people", "places", "stations", "upload"]);

export interface FolderViolation {
  readonly file: string;
  readonly line: number;
  readonly rule:
    | "release folder imports beyond the SDK"
    | "release folder takes a public name past the SDK"
    | "home template imports beyond the SDK"
    | "connector named outside its folder"
    | "a store opened outside the opener"
    | "allowed to open a store but opens none"
    | "a key used outside the home folder"
    | "the worker imports a part of ours"
    | "a part imports the worker";
  readonly detail: string;
}

const WORKER = "worker";

const WORKER_READERS = ["packages", "tools"] as const;

export function checkWorker(root: string): FolderViolation[] {
  const absoluteRoot = resolve(root);
  const worker = resolve(absoluteRoot, WORKER);
  const inWorker = (path: string): boolean => {
    const from = relative(worker, path);
    return from !== ".." && !from.startsWith(`..${sep}`);
  };
  const violations: FolderViolation[] = [];
  const scan = (folder: string, refused: (file: string, specifier: string) => FolderViolation["rule"] | null): void => {
    if (!existsSync(folder)) return;
    for (const file of typescriptFiles(folder)) {
      const source = readFileSync(file, "utf8");
      for (const { index, specifier } of [...matches(source, FROM_SPECIFIER), ...matches(source, BARE_IMPORT)]) {
        const rule = refused(file, specifier);
        if (rule !== null) violations.push({ file: relative(absoluteRoot, file), line: source.slice(0, index).split("\n").length, rule, detail: specifier });
      }
    }
  };
  scan(worker, (file, specifier) => specifier.startsWith("@lifestreamprotocol/") || (specifier.startsWith(".") && !inWorker(resolve(dirname(file), specifier)))
    ? "the worker imports a part of ours"
    : null);
  for (const folder of WORKER_READERS) {
    scan(resolve(absoluteRoot, folder), (file, specifier) => specifier.startsWith(".") && inWorker(resolve(dirname(file), specifier)) ? "a part imports the worker" : null);
  }
  return violations;
}

const OPENER = "packages/core/home-folder.ts";

export const STORE_OPENS: ReadonlySet<string> = new Set([
  OPENER,
  "packages/core/schema.ts",
  "packages/core/file-lock.ts",
]);

const OTHER_APPS = "packages/connect/";

const NEW_DATABASE = /\bnew\s+Database\s*\(/gu;

export function checkStoreOpens(root: string, allowed: ReadonlySet<string> = STORE_OPENS): FolderViolation[] {
  const absoluteRoot = resolve(root);
  const violations: FolderViolation[] = [];
  const opening = new Set<string>();
  for (const packageName of PACKAGE_NAMES) {
    const packageRoot = resolve(absoluteRoot, pathOf(packageName));
    if (!existsSync(packageRoot)) continue;
    for (const file of typescriptFiles(packageRoot)) {
      const path = relative(absoluteRoot, file).split(sep).join("/");
      if (isTest(relative(packageRoot, file)) || path.startsWith(OTHER_APPS)) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(NEW_DATABASE)) {
        opening.add(path);
        if (allowed.has(path)) continue;
        violations.push({ file: path, line: source.slice(0, match.index).split("\n").length, rule: "a store opened outside the opener", detail: `open it with ${OPENER}'s HomeFolder.store` });
      }
    }
  }
  for (const path of [...allowed].sort()) {
    if (!opening.has(path) && existsSync(resolve(absoluteRoot, path))) violations.push({ file: path, line: 0, rule: "allowed to open a store but opens none", detail: "take it off STORE_OPENS in tools/check-layers.ts" });
  }
  return violations;
}

const KEY_HOLDERS: ReadonlySet<string> = new Set([OPENER, "packages/core/keys.ts"]);

const KEY_USES = [
  /(?:\bPRAGMA\s+|\.pragma\s*\(\s*["'`]\s*)(?:hexrekey|hexkey|rekey|key|cipher\w*|algorithm)\b/giu,
  /\bATTACH\b[^;\n]*\bKEY\b/gu,
  /\bkeyBytesOf\b/gu,
];

export function checkKeyUse(root: string): FolderViolation[] {
  const absoluteRoot = resolve(root);
  const violations: FolderViolation[] = [];
  for (const packageName of PACKAGE_NAMES) {
    const packageRoot = resolve(absoluteRoot, pathOf(packageName));
    if (!existsSync(packageRoot)) continue;
    for (const file of typescriptFiles(packageRoot)) {
      const path = relative(absoluteRoot, file).split(sep).join("/");
      if (isTest(relative(packageRoot, file)) || KEY_HOLDERS.has(path)) continue;
      const source = readFileSync(file, "utf8");
      const found = KEY_USES.flatMap((pattern) => [...source.matchAll(pattern)]).sort((a, b) => a.index - b.index);
      for (const match of found) {
        violations.push({ file: path, line: source.slice(0, match.index).split("\n").length, rule: "a key used outside the home folder", detail: `${match[0].trim()}: a key, its pragma and the cipher's settings are ${OPENER}'s alone` });
      }
    }
  }
  return violations;
}

const RELEASE_TEMPLATES: ReadonlySet<string> = new Set(["phone", "label"]);

const isTest = (path: string): boolean => /\.test(?:-support)?\.ts$/u.test(path) || path.split(sep).includes("test");

function releaseFolders(connect: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "test") continue;
      if (dir === connect && (entry.name === "shared" || entry.name === "imports")) continue;
      walk(join(dir, entry.name));
    }
    if (existsSync(join(dir, "connector.ts"))) found.push(relative(connect, dir));
  };
  if (existsSync(connect)) walk(connect);
  return found.sort();
}

const folderOf = (folders: readonly string[], path: string): string | undefined =>
  folders.filter((folder) => path.startsWith(`${folder}${sep}`)).sort((a, b) => b.length - a.length)[0];

const moduleOf = (from: string, specifier: string): string => (specifier.startsWith(".") ? resolve(dirname(from), specifier).replace(/\.js$/u, ".ts") : specifier);

function sdkNames(connect: string): ReadonlySet<string> {
  const file = join(connect, "sdk.ts");
  if (!existsSync(file)) return new Set();
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  return new Set(source.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) return [];
    const origin = moduleOf(file, statement.moduleSpecifier.text);
    return statement.exportClause.elements.map((element) => `${origin}#${(element.propertyName ?? element.name).text}`);
  }));
}

interface Imported {
  readonly line: number;
  readonly specifier: string;
  readonly names: readonly string[];
}

function importsOf(file: string, text: string): Imported[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((statement): Imported[] => {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause;
    const names = bindings !== undefined && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
      ? bindings.elements.map((element: ts.ImportSpecifier | ts.ExportSpecifier) => (element.propertyName ?? element.name).text)
      : [];
    return [{ line, specifier: statement.moduleSpecifier.text, names }];
  });
}

export function checkFolderImports(root: string): FolderViolation[] {
  const connect = resolve(root, "packages", "connect");
  const folders = releaseFolders(connect);
  const exported = sdkNames(connect);
  const violations: FolderViolation[] = [];
  for (const folder of folders) {
    const [top, kind] = folder.split(sep);
    const homeTemplate = top === "templates" && kind !== undefined && !RELEASE_TEMPLATES.has(kind);
    for (const file of typescriptFiles(join(connect, folder))) {
      const path = relative(connect, file);
      if (isTest(path) || folderOf(folders, path) !== folder) continue;
      const at = relative(resolve(root), file);
      for (const { line, specifier, names } of importsOf(file, readFileSync(file, "utf8"))) {
        if (specifier === SDK || specifier.startsWith("node:")) continue;
        const local = specifier.startsWith(".");
        const target = moduleOf(file, specifier);
        if (local && relative(connect, target).startsWith(`${folder}${sep}`)) continue;
        if (!local && !specifier.startsWith("@lifestreamprotocol/")) continue;
        if (homeTemplate) {
          violations.push({ file: at, line, rule: "home template imports beyond the SDK", detail: specifier });
          continue;
        }
        const inside = local ? relative(connect, target) : null;
        const releaseOnly = specifier === "@lifestreamprotocol/core" || (inside !== null && !inside.startsWith("..") && folderOf(folders, inside) === undefined);
        if (!releaseOnly) {
          violations.push({ file: at, line, rule: "release folder imports beyond the SDK", detail: specifier });
          continue;
        }
        for (const name of names) {
          if (exported.has(`${target}#${name}`)) violations.push({ file: at, line, rule: "release folder takes a public name past the SDK", detail: `${name} from ${specifier}` });
        }
      }
    }
  }
  return violations;
}

function programOf(packages: string, files: readonly string[]): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2023.d.ts"], types: [], noEmit: true, skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const manifests = new Map<string, Record<string, unknown> | string>();
  const ours = (specifier: string): string | undefined => {
    const [scope, name, ...rest] = specifier.split("/");
    if (scope !== "@lifestreamprotocol" || name === undefined) return undefined;
    if (!manifests.has(name)) manifests.set(name, readManifest(join(packages, name, "package.json")));
    const manifest = manifests.get(name)!;
    const exported = typeof manifest === "string" || !isObject(manifest.exports) ? undefined : manifest.exports[rest.length === 0 ? "." : `./${rest.join("/")}`];
    const file = join(packages, name, typeof exported === "string" ? exported : `${rest.length === 0 ? "index" : rest.join("/")}.ts`);
    return existsSync(file) ? file : undefined;
  };
  host.resolveModuleNameLiterals = (literals, containingFile, redirected, compilerOptions, containingSourceFile) =>
    literals.map((literal) => {
      const file = ours(literal.text);
      return file !== undefined
        ? { resolvedModule: { resolvedFileName: file, extension: ts.Extension.Ts, isExternalLibraryImport: false } }
        : ts.resolveModuleName(literal.text, containingFile, compilerOptions, host, undefined, redirected, ts.getModeForUsageLocation(containingSourceFile, literal, compilerOptions));
    });
  return ts.createProgram({ rootNames: files, options, host });
}

function declarationIn(checker: ts.TypeChecker, file: ts.SourceFile, name: ts.Identifier): ts.Declaration | undefined {
  const symbol = checker.getSymbolAtLocation(name);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration?.getSourceFile() === file ? declaration : undefined;
}

function valueIn(checker: ts.TypeChecker, file: ts.SourceFile, node: ts.Expression, seen = new Set<ts.Node>()): ts.Expression {
  const at = bare(node);
  const declaration = ts.isIdentifier(at) ? declarationIn(checker, file, at) : undefined;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined || seen.has(declaration)) return at;
  return valueIn(checker, file, declaration.initializer, new Set([...seen, declaration]));
}

function nameText(name: ts.PropertyName | ts.BindingName | ts.MemberName): string | undefined {
  if (ts.isComputedPropertyName(name)) return ts.isStringLiteralLike(name.expression) ? name.expression.text : undefined;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name) ? name.text : undefined;
}

function declaredNames(file: ts.SourceFile, checker: ts.TypeChecker): { readonly ids: string[]; readonly products: string[]; readonly writes: string[] } {
  const ids: string[] = [];
  const products: string[] = [];
  const writes: string[] = [];
  const member = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
    for (const property of object.properties) {
      if (ts.isPropertyAssignment(property) && nameText(property.name) === name) return valueIn(checker, file, property.initializer);
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return valueIn(checker, file, property.name);
    }
    return undefined;
  };
  const text = (node: ts.Expression | undefined): string | undefined => (node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined);
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const id = text(member(node, "id"));
      const product = text(member(node, "product"));
      if (id !== undefined && product !== undefined) {
        ids.push(id);
        products.push(product);
        const listed = member(node, "products");
        if (listed !== undefined && ts.isObjectLiteralExpression(listed)) {
          for (const property of listed.properties) {
            const key = property.name === undefined ? undefined : nameText(property.name);
            if (key !== undefined) products.push(key);
          }
        }
        const written = member(node, "writes");
        if (written !== undefined && ts.isArrayLiteralExpression(written)) {
          for (const element of written.elements) {
            const each = text(valueIn(checker, file, element));
            if (each !== undefined) writes.push(each);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { ids, products, writes };
}

type Position = "product" | "connector";

const HOLDERS: ReadonlyMap<string, Position> = new Map([["product", "product"], ["connector", "connector"]]);
const SOURCE_HOLDER = /(?:^s|S)ource$/u;
const COMPARISONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);
const MEMBERSHIP: ReadonlySet<string> = new Set(["includes", "has", "indexOf"]);

function bare(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function memberName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
  return undefined;
}

const heldBy = (name: ts.PropertyName | ts.BindingName): Position | undefined => HOLDERS.get(nameText(name) ?? "");

interface Holder {
  readonly word: string;
  readonly from?: ts.Expression | ts.BindingPattern;
}

class Namings {
  readonly found: { readonly node: ts.Node; readonly text: string; readonly position: Position }[] = [];

  constructor(readonly file: ts.SourceFile, readonly names: Readonly<Record<Position, ReadonlySet<string>>>, readonly checker: ts.TypeChecker) {
    this.#visit(file);
  }

  #take(node: ts.Node, text: string, position: Position): void {
    if (this.names[position].has(text)) this.found.push({ node, text, position });
  }

  #literals(node: ts.Expression, each: (literal: ts.Node, text: string) => void, seen = new Set<ts.Node>()): void {
    const at = bare(node);
    if (ts.isStringLiteralLike(at)) each(at, at.text);
    else if (ts.isArrayLiteralExpression(at)) for (const element of at.elements) this.#literals(ts.isSpreadElement(element) ? element.expression : element, each, seen);
    else if (ts.isConditionalExpression(at)) for (const branch of [at.whenTrue, at.whenFalse]) this.#literals(branch, each, seen);
    else if (ts.isNewExpression(at) && at.arguments?.[0] !== undefined) this.#literals(at.arguments[0], each, seen);
    else if (ts.isIdentifier(at)) {
      const declaration = declarationIn(this.checker, this.file, at);
      if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && !seen.has(declaration)) {
        this.#literals(declaration.initializer, each, new Set([...seen, declaration]));
      }
    }
  }

  #named(node: ts.Expression, position: Position): void {
    this.#literals(node, (literal, text) => this.#take(literal, text, position));
  }

  #mayName(node: ts.Expression): boolean {
    let may = false;
    this.#literals(node, (_, text) => { may ||= this.names.product.has(text) || this.names.connector.has(text); });
    return may;
  }

  #literalTypes(node: ts.TypeNode, position: Position): void {
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) this.#take(node.literal, node.literal.text, position);
    else if (ts.isUnionTypeNode(node)) for (const each of node.types) this.#literalTypes(each, position);
    else if (ts.isArrayTypeNode(node)) this.#literalTypes(node.elementType, position);
    else if (ts.isTypeOperatorNode(node) || ts.isParenthesizedTypeNode(node)) this.#literalTypes(node.type, position);
  }

  #keys(node: ts.Expression, position: Position): void {
    const literal = valueIn(this.checker, this.file, node);
    if (!ts.isObjectLiteralExpression(literal)) return;
    for (const property of literal.properties) {
      const name = property.name === undefined ? undefined : nameText(property.name);
      if (name !== undefined && property.name !== undefined) this.#take(property.name, name, position);
    }
  }

  #holder(node: ts.Expression, seen: Set<ts.Node>): Holder | undefined {
    const at = bare(node);
    const member = memberName(at);
    if (member !== undefined) return { word: member, from: (at as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression };
    if (!ts.isIdentifier(at)) return undefined;
    const own: Holder = { word: at.text };
    if (HOLDERS.has(at.text) || SOURCE_HOLDER.test(at.text)) return own;
    const declaration = declarationIn(this.checker, this.file, at);
    if (declaration === undefined || seen.has(declaration)) return own;
    seen.add(declaration);
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) return this.#holder(declaration.initializer, seen) ?? own;
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
      const word = nameText(declaration.propertyName ?? declaration.name);
      return word === undefined ? own : { word, from: declaration.parent };
    }
    return own;
  }

  #holds(node: ts.Expression, seen = new Set<ts.Node>()): Position | undefined {
    const holder = this.#holder(node, seen);
    if (holder === undefined) return undefined;
    const held = HOLDERS.get(holder.word);
    if (held !== undefined) return held;
    return holder.word === "id" && holder.from !== undefined && this.#holdsWhole(holder.from, seen) === "connector" ? "connector" : undefined;
  }

  #holdsWhole(from: ts.Expression | ts.BindingPattern, seen: Set<ts.Node>): Position | undefined {
    if (!ts.isObjectBindingPattern(from) && !ts.isArrayBindingPattern(from)) return this.#holds(from, seen);
    const parent = from.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer !== undefined) return this.#holds(parent.initializer, seen);
    if (ts.isBindingElement(parent)) return HOLDERS.get(nameText(parent.propertyName ?? parent.name) ?? "");
    return undefined;
  }

  #takes(call: ts.CallExpression): (readonly [number, Position])[] {
    if (!call.arguments.some((argument) => !ts.isSpreadElement(argument) && this.#mayName(argument))) return [];
    const declaration = this.checker.getResolvedSignature(call)?.declaration;
    if (declaration === undefined || ts.isJSDocSignature(declaration)) return [];
    return declaration.parameters.flatMap((parameter, index) => {
      const held = heldBy(parameter.name);
      return held === undefined ? [] : [[index, held] as const];
    });
  }

  #spelling(node: ts.Node): string | undefined {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `\u0000${span.literal.text}`).join("");
    return undefined;
  }

  #visit(node: ts.Node): void {
    const spelling = ts.isTemplateExpression(node) || (ts.isStringLiteralLike(node) && !ts.isLiteralTypeNode(node.parent) && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent))
      ? this.#spelling(node) : undefined;
    const source = spelling === undefined ? null : /^([\w-]+):[^:\s]*:/u.exec(spelling);
    if (source !== null) this.#take(node, source[1]!, "product");

    if (ts.isBinaryExpression(node)) {
      if (COMPARISONS.has(node.operatorToken.kind)) {
        const left = this.#holds(node.left);
        const right = this.#holds(node.right);
        if (left !== undefined) this.#named(node.right, left);
        if (right !== undefined) this.#named(node.left, right);
      } else if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = this.#holds(node.left);
        if (left !== undefined) this.#named(node.right, left);
      }
    } else if ((ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)) && node.initializer !== undefined && heldBy(node.name) !== undefined) {
      this.#named(node.initializer, heldBy(node.name)!);
    } else if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isParameter(node) || ts.isVariableDeclaration(node)) && node.type !== undefined && heldBy(node.name) !== undefined) {
      this.#literalTypes(node.type, heldBy(node.name)!);
    } else if (ts.isCaseClause(node) && this.#holds(node.parent.parent.expression) !== undefined) {
      this.#named(node.expression, this.#holds(node.parent.parent.expression)!);
    } else if (ts.isElementAccessExpression(node) && this.#holds(node.argumentExpression) !== undefined) {
      this.#keys(node.expression, this.#holds(node.argumentExpression)!);
    } else if (ts.isCallExpression(node)) {
      const callee = bare(node.expression);
      const [first] = node.arguments;
      if (ts.isPropertyAccessExpression(callee) && first !== undefined) {
        const member = this.#holds(first);
        if (MEMBERSHIP.has(callee.name.text) && member !== undefined) this.#named(callee.expression, member);
        if (callee.name.text === "startsWith" && SOURCE_HOLDER.test(this.#holder(callee.expression, new Set())?.word ?? "")) {
          const prefix = this.#spelling(bare(first));
          const product = prefix === undefined ? null : /^([\w-]+):$/u.exec(prefix);
          if (product !== null) this.#take(first, product[1]!, "product");
        }
      }
      for (const [index, position] of this.#takes(node)) {
        const argument = node.arguments[index];
        if (argument !== undefined && !ts.isSpreadElement(argument)) this.#named(argument, position);
      }
    }
    ts.forEachChild(node, (child) => this.#visit(child));
  }
}

export function checkConnectorNames(root: string, own = HOME_OWN): FolderViolation[] {
  const base = realpathSync(resolve(root));
  const packages = join(base, "packages");
  const connect = join(packages, "connect");
  const paths: string[] = [];
  for (const name of PACKAGE_NAMES) {
    const packageRoot = join(packages, name);
    if (!existsSync(packageRoot)) continue;
    for (const file of typescriptFiles(packageRoot)) {
      const path = relative(packages, file);
      if (!isTest(path) && !path.startsWith(`connect${sep}templates${sep}`)) paths.push(file);
    }
  }
  const program = programOf(packages, paths);
  const checker = program.getTypeChecker();
  const owner: Record<Position, Map<string, string>> = { product: new Map(), connector: new Map() };
  const writers = new Map<string, ReadonlySet<string>>();
  const ownFolders = new Set<string>();
  for (const folder of releaseFolders(connect).filter((each) => !each.startsWith(`templates${sep}`))) {
    const declared = declaredNames(program.getSourceFile(join(connect, folder, "connector.ts"))!, checker);
    for (const product of declared.products) owner.product.set(product, join(connect, folder));
    for (const id of declared.ids) owner.connector.set(id, join(connect, folder));
    if (declared.writes.length > 0) writers.set(join(connect, folder), new Set(declared.writes));
    if (declared.ids.some((id) => own.has(id))) ownFolders.add(join(connect, folder));
  }
  if (owner.connector.size === 0) return [];
  const names = { product: new Set(owner.product.keys()), connector: new Set(owner.connector.keys()) };
  const violations: FolderViolation[] = [];
  for (const path of paths) {
    const file = program.getSourceFile(path)!;
    const writes = [...writers].find(([folder]) => path.startsWith(`${folder}${sep}`))?.[1];
    for (const { node, text: named, position } of new Namings(file, names, checker).found) {
      const folder = owner[position].get(named)!;
      if (path.startsWith(`${folder}${sep}`) || own.has(named) || ownFolders.has(folder)) continue;
      if (position === "product" && writes?.has(named) === true) continue;
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      violations.push({ file: relative(base, path), line, rule: "connector named outside its folder", detail: named });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.detail.localeCompare(b.detail));
}


function allowedImports(): Map<PackageName, ReadonlySet<string>> {
  return new Map(PACKAGE_NAMES.map((packageName) => [packageName, new Set<string>(LAYERS[packageName].map((name) => `@lifestreamprotocol/${name}`))]));
}

function readManifest(path: string): Record<string, unknown> | string {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(value) ? value : "manifest is not a JSON object";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typescriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...typescriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function matches(
  source: string,
  expression: RegExp,
): Array<{ readonly index: number; readonly specifier: string }> {
  expression.lastIndex = 0;
  return [...source.matchAll(expression)].map((match) => ({
    index: match.index,
    specifier: match[2]!,
  }));
}

function lifestreamPackageName(specifier: string): string | null {
  if (!specifier.startsWith("@lifestreamprotocol/")) return null;
  return specifier.split("/").slice(0, 2).join("/");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = runLayerCheck(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
