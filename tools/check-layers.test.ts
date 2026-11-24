import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkConnectorNames, checkFolderImports, checkKeyUse, checkLayers, checkManifests, checkStoreOpens, checkWorker, runLayerCheck, STORE_OPENS } from "./check-layers.js";

const roots: string[] = [];
const packages = ["core", "connect", "families", "model", "privacy", "home", "runner"];
const pathOf = (packageName: string): string => `packages/${packageName}`;
const allowed: Record<string, readonly string[]> = {
  core: [],
  connect: ["core"],
  families: ["core"],
  model: ["core"],
  privacy: ["core"],
  home: ["connect", "core", "families", "model", "privacy"],
  runner: ["core", "model"],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("layer import checker", () => {
  it("accepts a clean fixture tree", () => {
    const root = fixtureRoot();
    write(root, "packages/connect/clean.ts", statement("ex" + "port", "@lifestreamprotocol/core/index"));
    write(root, "packages/families/clean.ts", statement("im" + "port", "@lifestreamprotocol/core"));
    write(root, "packages/home/clean.ts", bareImport("@lifestreamprotocol/model"));
    expect(checkLayers(root)).toEqual([]);
    expect(checkManifests(root)).toEqual([]);
    let output = "";
    expect(runLayerCheck(root, (text) => { output += text; })).toBe(0);
    expect(output).toBe("layer check: clean\n");
  });

  it("reports upward, sideways, and cross-package relative imports independently, and a runner that imports a package of the home's", () => {
    const root = fixtureRoot();
    write(root, "packages/core/upward.ts", statement("im" + "port", "@lifestreamprotocol/connect"));
    write(root, "packages/connect/relative.ts", statement("im" + "port", "../core/index.js"));
    write(root, "packages/families/sideways.ts", statement("ex" + "port", "@lifestreamprotocol/model"));
    write(root, "packages/runner/model.ts", statement("im" + "port", "@lifestreamprotocol/model"));
    write(root, "packages/runner/families.ts", statement("im" + "port", "@lifestreamprotocol/families"));
    write(root, "packages/runner/home.ts", statement("im" + "port", "@lifestreamprotocol/home"));
    const found = checkLayers(root);
    expect(found.filter((violation) => !violation.file.startsWith("packages/runner/"))).toMatchObject([
      { file: "packages/core/upward.ts", line: 1, rule: "package import is not allowed" },
      { file: "packages/connect/relative.ts", line: 1, rule: "relative import leaves package" },
      { file: "packages/families/sideways.ts", line: 1, rule: "package import is not allowed" },
    ]);
    expect(found.filter((violation) => violation.file.startsWith("packages/runner/")).map(({ file, rule }) => `${file} ${rule}`).sort()).toEqual([
      "packages/runner/families.ts package import is not allowed",
      "packages/runner/home.ts package import is not allowed",
    ]);
    let error = "";
    expect(runLayerCheck(root, () => {}, (text) => { error += text; })).toBe(1);
    expect(error).toContain("packages/core/upward.ts:1: package import is not allowed");
    expect(error).toContain("packages/connect/relative.ts:1: relative import leaves package");
    expect(error).toContain("packages/families/sideways.ts:1: package import is not allowed");
    expect(error).toContain("layer check: 5 violation(s)");
  });

  it("holds privacy to core alone, and keeps every other package below the home from it", () => {
    const root = fixtureRoot();
    write(root, "packages/privacy/clean.ts", statement("im" + "port", "@lifestreamprotocol/core"));
    write(root, "packages/home/privacy.ts", statement("im" + "port", "@lifestreamprotocol/privacy"));
    write(root, "packages/privacy/up.ts", statement("im" + "port", "@lifestreamprotocol/home"));
    write(root, "packages/privacy/sideways.ts", statement("im" + "port", "@lifestreamprotocol/model"));
    write(root, "packages/model/privacy.ts", statement("im" + "port", "@lifestreamprotocol/privacy"));
    write(root, "packages/runner/privacy.ts", statement("im" + "port", "@lifestreamprotocol/privacy"));
    expect(checkLayers(root).map(({ file, rule }) => `${file} ${rule}`).sort()).toEqual([
      "packages/model/privacy.ts package import is not allowed",
      "packages/privacy/sideways.ts package import is not allowed",
      "packages/privacy/up.ts package import is not allowed",
      "packages/runner/privacy.ts package import is not allowed",
    ]);
  });

  it("lets a family's tests import connect, and none of its own modules", () => {
    const root = fixtureRoot();
    write(root, "packages/families/family.ts", statement("im" + "port", "@lifestreamprotocol/connect"));
    put(root, "packages/families/messages/adapter.ts", statement("im" + "port", "@lifestreamprotocol/connect/sdk"));
    put(root, "packages/families/messages/messages.test.ts", statement("im" + "port", "@lifestreamprotocol/connect"));
    put(root, "packages/families/messages/test/adapters.ts", statement("im" + "port", "@lifestreamprotocol/connect"));
    put(root, "packages/families/test/journey.test-support.ts", statement("im" + "port", "@lifestreamprotocol/connect"));
    put(root, "packages/families/messages/test/home.ts", statement("im" + "port", "@lifestreamprotocol/home"));
    put(root, "packages/model/model.test.ts", statement("im" + "port", "@lifestreamprotocol/connect"));
    expect(checkLayers(root).map(({ file, specifier }) => `${file} ${specifier}`).sort()).toEqual([
      "packages/families/family.ts @lifestreamprotocol/connect",
      "packages/families/messages/adapter.ts @lifestreamprotocol/connect/sdk",
      "packages/families/messages/test/home.ts @lifestreamprotocol/home",
      "packages/model/model.test.ts @lifestreamprotocol/connect",
    ]);
  });
});

describe("worker import checker", () => {
  it("lets the worker import only itself and the platform, and nothing of ours import the worker", () => {
    const root = fixtureRoot();
    for (const folder of ["worker", "tools"]) mkdirSync(join(root, folder), { recursive: true });
    write(root, "worker/index.ts", statement("im" + "port", "./limits.json"));
    write(root, "worker/index.test.ts", statement("im" + "port", "node:sqlite"));
    expect(checkWorker(root)).toEqual([]);
    write(root, "worker/ours.ts", statement("im" + "port", "@lifestreamprotocol/core"));
    write(root, "worker/out.ts", statement("im" + "port", "../packages/home/feedback.js"));
    write(root, "packages/home/reads.ts", statement("im" + "port", "../../worker/index.js"));
    write(root, "tools/reads.ts", bareImport("../worker/index.js"));
    expect(checkWorker(root).map((violation) => `${violation.file} ${violation.rule}`).sort()).toEqual([
      "packages/home/reads.ts a part imports the worker",
      "tools/reads.ts a part imports the worker",
      "worker/ours.ts the worker imports a part of ours",
      "worker/out.ts the worker imports a part of ours",
    ]);
  });
});

describe("manifest checker", () => {
  it("reports a manifest that declares an upward dependency", () => {
    const root = fixtureRoot();
    writeManifest(root, "core", ["connect"]);
    expect(checkManifests(root)).toEqual([
      {
        file: "packages/core/package.json",
        rule: "declared dependency is not allowed",
        detail: "@lifestreamprotocol/connect",
      },
    ]);
    let error = "";
    expect(runLayerCheck(root, () => {}, (text) => { error += text; })).toBe(1);
    expect(error).toContain(
      "packages/core/package.json: declared dependency is not allowed: @lifestreamprotocol/connect",
    );
  });

  it("reports a manifest that omits a package it may import", () => {
    const root = fixtureRoot();
    writeManifest(root, "home", ["connect", "core", "families"]);
    expect(checkManifests(root)).toEqual([
      {
        file: "packages/home/package.json",
        rule: "allowed dependency is not declared",
        detail: "@lifestreamprotocol/model",
      },
      {
        file: "packages/home/package.json",
        rule: "allowed dependency is not declared",
        detail: "@lifestreamprotocol/privacy",
      },
    ]);
  });

  it("reports a missing manifest, workspaces that are not packages/*, and a package outside the layer order", () => {
    const root = fixtureRoot();
    rmSync(join(root, "packages/model/package.json"));
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ workspaces: ["packages/*", "tools"] })}\n`);
    mkdirSync(join(root, "packages/extra"));
    expect(checkManifests(root)).toMatchObject([
      { file: "packages/model/package.json", rule: "manifest cannot be read" },
      { file: "package.json", rule: "workspaces are not packages/*", detail: '["packages/*","tools"]' },
      { file: "packages/extra", rule: "package is not in the layer order", detail: "extra" },
    ]);
  });
});

describe("release folder checker", () => {
  const SDK = "@lifestreamprotocol/connect/sdk";

  it("lets a release folder take a release-only name from its module, and reports a public name taken past the SDK or a reach into another folder or package", () => {
    const root = fixtureRoot();
    put(root, "packages/connect/sdk.ts", 'export { value } from "./shared/json.js";\nexport { instant as value2 } from "@lifestreamprotocol/core";\n');
    put(root, "packages/connect/notes/acme/connector.ts", statement("im" + "port", SDK) + 'export const acme = { id: "acme", product: "acme" };\n');
    put(root, "packages/connect/notes/acme/reader.ts", [SDK, "node:fs", "better-sqlite3", "./connector.js"].map((each) => statement("im" + "port", each)).join(""));
    put(root, "packages/connect/notes/acme/shared.ts", [
      statement("im" + "port", "../../shared/json.js"),
      'import { phoneShipment } from "../../shared/phone-shipment.js";\n',
      'export { instant } from "@lifestreamprotocol/core";\n',
      'import { versionId } from "@lifestreamprotocol/core";\n',
      statement("im" + "port", "../other/reader.js"),
      statement("im" + "port", "@lifestreamprotocol/families"),
    ].join(""));
    put(root, "packages/connect/notes/other/connector.ts", 'export const other = { id: "other", product: "other" };\n');
    put(root, "packages/connect/notes/acme/test/fixture.ts", statement("im" + "port", "../../../shared/delivery.js"));
    put(root, "packages/connect/notes/acme/e2e.test.ts", statement("im" + "port", "../../test/drive.js"));
    put(root, "packages/connect/shared/json.ts", statement("im" + "port", "@lifestreamprotocol/core"));
    put(root, "packages/connect/templates/api/connector.ts", statement("im" + "port", "../../seams.js"));
    put(root, "packages/connect/templates/phone/connector.ts", statement("im" + "port", "../../seams.js"));
    expect(checkFolderImports(root)).toEqual([
      { file: "packages/connect/notes/acme/shared.ts", line: 1, rule: "release folder takes a public name past the SDK", detail: "value from ../../shared/json.js" },
      { file: "packages/connect/notes/acme/shared.ts", line: 3, rule: "release folder takes a public name past the SDK", detail: "instant from @lifestreamprotocol/core" },
      { file: "packages/connect/notes/acme/shared.ts", line: 5, rule: "release folder imports beyond the SDK", detail: "../other/reader.js" },
      { file: "packages/connect/notes/acme/shared.ts", line: 6, rule: "release folder imports beyond the SDK", detail: "@lifestreamprotocol/families" },
      { file: "packages/connect/templates/api/connector.ts", line: 1, rule: "home template imports beyond the SDK", detail: "../../seams.js" },
    ]);
  });

  const namesRoot = (): string => {
    const root = fixtureRoot();
    put(root, "packages/connect/notes/acme/connector.ts", 'export const acme = { id: "acme-notes", product: "acme", products: { "acme-drive": { name: "Acme Drive", vendor: "acme" } } };\n');
    put(root, "packages/connect/notes/acme/reader.ts", 'export const source = "acme:local:mac";\nexport const own = (product: string) => product === "acme-drive";\n');
    put(root, "packages/connect/browser/chrome/connector.ts", 'export const chrome = { id: "chrome", product: "chrome" };\n');
    put(root, "packages/connect/ios-app/connector.ts", 'export const location = { id: "location", product: "location" };\nexport const motion = { id: "motion", product: "motion" };\n');
    put(root, "packages/connect/macos-app/machine/connector.ts", 'export const machine = { id: "machine", product: "machine" };\n');
    put(root, "packages/connect/ai/claude/connector.ts", 'export const claude = { id: "claude", product: "claude" };\n');
    put(root, "packages/connect/social/x/connector.ts", 'export const x = { id: "x", product: "x" };\n');
    put(root, "packages/connect/people/connector.ts", 'export const people = { id: "people", product: "people" };\n');
    put(root, "packages/connect/places/connector.ts", 'export const places = { id: "places", product: "places", products: { "acme-maps": { name: "Acme Maps", vendor: "acme" } } };\n');
    put(root, "packages/connect/products.ts", "export function productName(connectors: readonly string[], product: string): string { return product; }\n");
    put(root, "packages/connect/index.ts", 'export { productName } from "./products.js";\n');
    return root;
  };
  const named = (root: string) =>
    checkConnectorNames(root, new Set(["people", "places"])).map((each) => `${each.file}:${each.line} ${each.detail}`);

  it("reports a connector's id or product where code names one: a source's spelling, a product held, compared, switched on, looked up or passed", () => {
    const root = namesRoot();
    put(root, "packages/home/flows.ts", [
      'export const source = "acme:local:mac";',
      "export const lane = (account: string) => `acme-drive:${account}:export`;",
      'export const mine = (row: { source: string }) => row.source.startsWith("acme:");',
      'export const its = (row: { product: string }) => row.product === "acme";',
      'export const NOTES = { product: ["acme"] };',
      'export const one = (connector: { id: string }) => connector.id !== "acme-notes";',
      'export interface Export { product: "acme" | "acme-drive" }',
      'export function words(product: string) { switch (product) { case "acme": return 1; default: return 0; } }',
      'const LISTED = ["acme-drive"];',
      "export const listed = (product: string) => LISTED.includes(product);",
      "const WORDS = { acme: 1, other: 2 };",
      "export const word = (product: keyof typeof WORDS) => WORDS[product];",
      'import { productName } from "@lifestreamprotocol/connect";',
      'export const name = productName([], "acme-drive");',
      "",
    ].join("\n"));
    expect(named(root)).toEqual([
      "packages/home/flows.ts:1 acme",
      "packages/home/flows.ts:2 acme-drive",
      "packages/home/flows.ts:3 acme",
      "packages/home/flows.ts:4 acme",
      "packages/home/flows.ts:5 acme",
      "packages/home/flows.ts:6 acme-notes",
      "packages/home/flows.ts:7 acme",
      "packages/home/flows.ts:7 acme-drive",
      "packages/home/flows.ts:8 acme",
      "packages/home/flows.ts:9 acme-drive",
      "packages/home/flows.ts:11 acme",
      "packages/home/flows.ts:14 acme-drive",
    ]);
  });

  it("passes another word of a product's spelling, its own folder, a comment, a test and the home's own", () => {
    const root = namesRoot();
    put(root, "packages/connect/declaration.ts", [
      'export type Road = "poll" | "chrome" | "mac";',
      'export type PhoneGrant = "location" | "motion";',
      'export const GRANTS: readonly PhoneGrant[] = ["location", "motion"];',
      "export const polled = (road: string) => road === \"chrome\";",
      "export const words = (road: string) => { switch (road) { case \"chrome\": return \"Open Chrome\"; default: return \"\"; } };",
      "",
    ].join("\n"));
    put(root, "packages/home/vault.ts", 'export const machines = (slots: { kind: string }[]) => slots.filter((slot) => slot.kind === "machine");\n');
    put(root, "packages/model/transports/claude.ts", 'export const claude = { name: "claude" };\nexport const ran = (run: (name: string) => void) => run("claude");\n');
    put(root, "packages/home/reads.ts", [
      'export const profiles = (value: string) => [{ network: "x", value }];',
      'export const lower = (network: string) => network === "x";',
      'export const place = (id: string) => `chrome:${id}`;',
      'export const details = (id: string) => `chrome://extensions/?id=${id}`;',
      'export const scheme = ["location:", "chrome:"];',
      '// "acme:local:mac" and product === "acme" in a comment',
      '/* product: ["acme"] */',
      'export const own = { product: ["people", "places", "acme-maps"] };',
      'export const named = (product: string) => product === "acme";',
      "",
    ].join("\n"));
    put(root, "packages/home/flows.test.ts", 'export const named = (product: string) => product === "acme";\n');
    put(root, "packages/connect/templates/notes/connector.ts", 'export const template = { id: "acme", product: "acme" };\n');
    expect(named(root)).toEqual(["packages/home/reads.ts:9 acme"]);
  });

  it("knows a product from a connector's id: a product's position names only a declared product, a connector's only a declared id", () => {
    const root = namesRoot();
    put(root, "packages/connect/google/activity/connector.ts", 'export const activity = { id: "acme-activity", product: "acme-takeout" };\n');
    put(root, "packages/core/handles.ts", [
      'export const RESERVED = ["phone", "acme-activity"];',
      "export const reserved = (product: string) => RESERVED.includes(product);",
      'export const mine = (connector: { id: string }) => connector.id === "acme";',
      'export const takeout = (product: string) => product === "acme-takeout";',
      'export const theirs = (connector: { id: string }) => connector.id === "acme-activity";',
      "",
    ].join("\n"));
    expect(named(root)).toEqual(["packages/core/handles.ts:4 acme-takeout", "packages/core/handles.ts:5 acme-activity"]);
  });

  it("reads a declaration by its syntax, whatever its layout or quoting", () => {
    const root = namesRoot();
    put(root, "packages/connect/notes/zeta/connector.ts", [
      'const ID = "zeta-notes";',
      "export const zeta = {",
      "  product: 'zeta',",
      '  name: "Zeta",',
      "  id: ID,",
      "  products: { zetadrive: { name: \"Zeta Drive\", vendor: \"zeta\" }, ['zeta-maps']: { name: \"Zeta Maps\", vendor: \"zeta\" } },",
      "  writes: [",
      "    'chrome',",
      "  ],",
      "};",
      "",
    ].join("\n"));
    put(root, "packages/connect/notes/zeta/reader.ts", 'export const browsed = (product: string) => product === "chrome";\n');
    put(root, "packages/home/zeta.ts", [
      'export const its = (product: string) => product === "zeta";',
      'export const one = (connector: { id: string }) => connector.id === "zeta-notes";',
      'export const drive = (product: string) => product === "zetadrive";',
      'export const maps = (product: string) => product === "zeta-maps";',
      "",
    ].join("\n"));
    expect(named(root)).toEqual([
      "packages/home/zeta.ts:1 zeta",
      "packages/home/zeta.ts:2 zeta-notes",
      "packages/home/zeta.ts:3 zetadrive",
      "packages/home/zeta.ts:4 zeta-maps",
    ]);
  });

  it("follows a product or a connector through an element access and an alias, in its own scope", () => {
    const root = namesRoot();
    put(root, "packages/home/access.ts", [
      'export const a = (row: Record<string, string>) => row["product"] === "acme";',
      'export const b = (connector: { id: string }) => connector["id"] === "acme-notes";',
      'export const c = ({ product: kind }: { product: string }) => kind === "acme";',
      'export const d = (row: { product: string }) => { const { product: p } = row; return p === "acme"; };',
      'export const e = (row: { product: string }) => { const held = row.product; return held === "acme"; };',
      'export const f = (row: Record<string, string>) => { const p = row["product"]; switch (p) { case "acme": return 1; default: return 0; } };',
      'export const g = (connector: { id: string }) => { const { id } = connector; return id === "acme-notes"; };',
      'export const h = (road: string) => { const p = road; return p === "chrome"; };',
      'export const i = (row: { id: string }) => { const { id } = row; return id === "acme-notes"; };',
      'export const j = (row: { source: string }) => { const s = row.source; return s.startsWith("acme:"); };',
      "",
    ].join("\n"));
    expect(named(root)).toEqual([
      "packages/home/access.ts:1 acme",
      "packages/home/access.ts:2 acme-notes",
      "packages/home/access.ts:3 acme",
      "packages/home/access.ts:4 acme",
      "packages/home/access.ts:5 acme",
      "packages/home/access.ts:6 acme",
      "packages/home/access.ts:7 acme-notes",
      "packages/home/access.ts:10 acme",
    ]);
  });

  it("knows a function by the symbol a call resolves to, never by its name alone", () => {
    const root = namesRoot();
    put(root, "packages/home/print.ts", [
      "class Printer { label(text: string): string { return text; } }",
      "class Tags { label(product: string): string { return product; } }",
      "const printer = new Printer();",
      'export const printed = printer.label("chrome");',
      'export const tagged = new Tags().label("chrome");',
      'import { productName as nameOf } from "@lifestreamprotocol/connect";',
      'export const called = nameOf([], "acme-drive");',
      "",
    ].join("\n"));
    put(root, "packages/model/words.ts", [
      "function productName(text: string): string { return text; }",
      'export const said = productName("chrome");',
      "",
    ].join("\n"));
    expect(named(root)).toEqual(["packages/home/print.ts:5 chrome", "packages/home/print.ts:7 acme-drive"]);
  });

  it("lets a folder name the products its declaration writes, and no other folder", () => {
    const root = namesRoot();
    const reader = 'export const FOLDERS = { "acme-drive": ["Drive"], "acme-takeout": ["Takeout"] };\nexport const folders = (product: string) => FOLDERS[product];\n';
    put(root, "packages/connect/google/activity/connector.ts", 'export const activity = { id: "acme-activity", product: "acme-takeout", writes: ["acme-drive"] };\n');
    put(root, "packages/connect/google/activity/reader.ts", reader);
    put(root, "packages/connect/social/x/reader.ts", reader);
    expect(named(root)).toEqual(["packages/connect/social/x/reader.ts:1 acme-drive", "packages/connect/social/x/reader.ts:1 acme-takeout"]);
  });
});

describe("store open checker", () => {
  const OPEN = 'const db = new Database(path, { readonly: true });\n';

  it("refuses new Database( outside the opener and the named files, but in connect's readers and in tests", () => {
    const root = fixtureRoot();
    put(root, "packages/core/home-folder.ts", OPEN);
    put(root, "packages/home/report.ts", OPEN);
    put(root, "packages/home/stray.ts", `const a = 1;\n${OPEN}`);
    put(root, "packages/model/stray.ts", "const db = new   Database (\":memory:\");\n");
    put(root, "packages/connect/messages/acme/reader.ts", OPEN);
    put(root, "packages/home/stray.test.ts", OPEN);
    put(root, "packages/home/test/fixture.ts", OPEN);
    put(root, "packages/home/words.ts", "const text = \"a Database of one\";\n");
    expect(checkStoreOpens(root, new Set(["packages/core/home-folder.ts", "packages/home/report.ts"]))).toEqual([
      { file: "packages/model/stray.ts", line: 1, rule: "a store opened outside the opener", detail: "open it with packages/core/home-folder.ts's HomeFolder.store" },
      { file: "packages/home/stray.ts", line: 2, rule: "a store opened outside the opener", detail: "open it with packages/core/home-folder.ts's HomeFolder.store" },
    ]);
  });

  it("names a file it allows that no longer opens a store, so the list only shrinks", () => {
    const root = fixtureRoot();
    put(root, "packages/core/home-folder.ts", OPEN);
    put(root, "packages/home/report.ts", "export const moved = true;\n");
    expect(checkStoreOpens(root, new Set(["packages/core/home-folder.ts", "packages/home/report.ts", "packages/home/gone.ts"]))).toEqual([
      { file: "packages/home/report.ts", line: 0, rule: "allowed to open a store but opens none", detail: "take it off STORE_OPENS in tools/check-layers.ts" },
    ]);
  });

  it("allows the opener, the in-memory schema and the lock alone", () => {
    expect([...STORE_OPENS].sort()).toEqual(["packages/core/file-lock.ts", "packages/core/home-folder.ts", "packages/core/schema.ts"]);
  });
});

describe("key use checker", () => {
  it("refuses a key or cipher pragma, a keyed ATTACH and the Keys reader outside the home folder and the keys module, but in tests", () => {
    const root = fixtureRoot();
    const pragma = 'db.pragma(`key = "x\'${hex}\'"`);\n';
    put(root, "packages/core/home-folder.ts", `${pragma}db.pragma("cipher = 'aegis'");\ndb.pragma("algorithm = 'aegis-256'");\nimport { keyBytesOf } from "./keys.js";\nconst sql = "ATTACH DATABASE ? AS x KEY ?";\n`);
    put(root, "packages/core/keys.ts", "export function keyBytesOf() {}\n");
    put(root, "packages/home/stray.ts", `const a = 1;\n${pragma}`);
    put(root, "packages/model/cipher.ts", "db.pragma(\"cipher = 'aegis'\");\ndb.exec(\"PRAGMA rekey = 'x'\");\ndb.pragma(\"algorithm = 'aegis-256'\");\n");
    put(root, "packages/home/attach.ts", 'db.prepare(`ATTACH DATABASE ? AS "s" KEY ?`).run(path, key);\n');
    put(root, "packages/privacy/reader.ts", 'import { keyBytesOf } from "@lifestreamprotocol/core";\n');
    put(root, "packages/home/fine.ts", 'db.pragma("foreign_key_check");\ndb.exec("PRAGMA foreign_keys = ON");\nconst words = "the key of a record";\n');
    put(root, "packages/home/keyed.test.ts", pragma);
    put(root, "packages/core/test/keyed.ts", 'import { keyBytesOf } from "../keys.js";\n');
    expect(checkKeyUse(root).map((found) => `${found.file}:${found.line} ${found.rule}`).sort()).toEqual([
      "packages/home/attach.ts:1 a key used outside the home folder",
      "packages/home/stray.ts:2 a key used outside the home folder",
      "packages/model/cipher.ts:1 a key used outside the home folder",
      "packages/model/cipher.ts:2 a key used outside the home folder",
      "packages/model/cipher.ts:3 a key used outside the home folder",
      "packages/privacy/reader.ts:1 a key used outside the home folder",
    ]);
  });
});

function put(root: string, path: string, source: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), source);
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lifestream-layers-"));
  roots.push(root);
  for (const packageName of packages) {
    mkdirSync(join(root, pathOf(packageName)), { recursive: true });
    writeManifest(root, packageName, allowed[packageName]!);
  }
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ workspaces: ["packages/*"] })}\n`);
  return root;
}

function writeManifest(root: string, packageName: string, dependencies: readonly string[]): void {
  const manifest: Record<string, unknown> = { name: `@lifestreamprotocol/${packageName}` };
  if (dependencies.length > 0) {
    manifest.dependencies = Object.fromEntries(
      dependencies.map((name) => [`@lifestreamprotocol/${name}`, `file:../${name}`]),
    );
  }
  writeFileSync(join(root, pathOf(packageName), "package.json"), `${JSON.stringify(manifest)}\n`);
}

function write(root: string, path: string, source: string): void {
  writeFileSync(join(root, path), source);
}

function statement(keyword: string, specifier: string): string {
  return `${keyword} { value } from ${JSON.stringify(specifier)};\n`;
}

function bareImport(specifier: string): string {
  return `${"im" + "port"} ${JSON.stringify(specifier)};\n`;
}
