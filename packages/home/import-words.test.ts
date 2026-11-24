import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { imports as declared } from "@lifestreamprotocol/connect";
import { openHome, openHomeFolder, type HomeDb } from "@lifestreamprotocol/core";
import { readImports } from "./imports-report.js";
import { admitImport, failedLook, filesLooked, HELD, type HeldImport, type Looked } from "./imports.js";
import { effective } from "./settings.js";
import { sizeWords } from "./stream-words.js";
import { makeRoot, readHome, removeRoot } from "./test/harness-root.js";
import importsRegistry from "./test/imports-registry.js";
import { reaching } from "./verbs/import.js";

const NOW = Date.UTC(2026, 10, 15, 12);
const DAY_MS = 86_400_000;
const UUID = "11111111-1111-4111-8111-111111111111";
const NB = " ";

const opened: { root: string; db: HomeDb }[] = [];
afterEach(() => {
  for (const { root, db } of opened.splice(0)) {
    db.close();
    removeRoot(root);
  }
});

function home() {
  const root = makeRoot("lifestream-import-words-", { sources: {} });
  const db = openHome(openHomeFolder(root), "migrate");
  opened.push({ root, db });
  return { root, db };
}

const report = (root: string) => readHome(root, (read) => readImports(read, {
  folder: openHomeFolder(root), now_ms: NOW, connectors: importsRegistry().connectors, free_bytes: Number.MAX_SAFE_INTEGER, max_bundle_bytes: Number.MAX_SAFE_INTEGER, day: effective(root).settings.day, stated: null,
}));

describe("what the import road says", () => {
  it("the verb says it reads the file at once, and that macOS may be asking while the file's first bytes have not come; nothing more once they have", async () => {
    const folder = mkdtempSync(join(tmpdir(), "lifestream-reaching-"));
    try {
      const held = join(folder, "Downloads", "takeout-20261115T120000Z-1-001.zip");
      mkdirSync(dirname(held));
      execFileSync("mkfifo", [held]);
      const said: string[] = [];
      let written: Promise<void> = Promise.resolve();
      await reaching(held, (line) => {
        said.push(line);
        if (said.length === 2) written = writeFile(held, "PK");
      }, undefined, 0);
      await written;
      expect(said).toEqual([
        "Reading takeout-20261115T120000Z-1-001.zip…",
        "Still reading takeout-20261115T120000Z-1-001.zip: macOS may be asking on this Mac's screen to let Lifestream read Downloads. Allow it there.",
      ]);
      const file = join(folder, "my_spotify_data.zip");
      writeFileSync(file, "PK");
      const quick: string[] = [];
      await reaching(file, (line) => quick.push(line));
      await reaching(folder, (line) => quick.push(line));
      expect(quick).toEqual(["Reading my_spotify_data.zip…", `Reading ${basename(folder)}…`]);
      await expect(reaching(join(folder, "nowhere.zip"), () => undefined)).rejects.toThrow(/ENOENT/u);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("a file under a megabyte is said in KB", () => {
    expect([400, 2_048, 999_400, 999_600, 41_000_000].map(sizeWords)).toEqual([`1${NB}KB`, `2${NB}KB`, `999${NB}KB`, `1${NB}MB`, `41${NB}MB`]);
  });

  it("an import's heading names its account unless it is an opaque id; one asked whose comes first; Timeline's line is the guide's", () => {
    const { root, db } = home();
    const entry = (account: string | null, at_ms: number, more: Partial<HeldImport> = {}): HeldImport => ({ kind: "claude", account, stamp: null, time_ms: null, at_ms, deliveries: [], ...more });
    const held: Record<string, HeldImport> = {
      asked: entry(null, NOW - 3 * DAY_MS),
      refused: entry(null, NOW - DAY_MS, { refused: "This isn't a Claude export", ended: true }),
      opaque: entry(UUID, NOW - 2 * DAY_MS),
      address: { ...entry("person-a@example.com", NOW - 4 * DAY_MS), kind: "google-takeout", stamp: "20261111T120000Z" },
      username: { ...entry("person-a", NOW - 5 * DAY_MS), kind: "spotify" },
      hex: { ...entry("0123456789abcdef0123456789abcdef", NOW - 6 * DAY_MS), kind: "spotify" },
      digits: { ...entry("31415926535897932", NOW - 7 * DAY_MS), kind: "spotify" },
      short: { ...entry("user42", NOW - 8 * DAY_MS), kind: "spotify" },
      chatgpt: { ...entry("user-synthetic0001", NOW - 9 * DAY_MS), kind: "chatgpt" },
    };
    db.commit((tx) => tx.tables.meta.set(HELD, JSON.stringify(held)));
    const imports = report(root).imports;
    const claude = imports.find((each) => each.kind === "claude")!;
    expect(claude.held.map((each) => [each.id, each.name])).toEqual([
      ["asked", "12 Nov 2026 · Claude export"], ["refused", "14 Nov 2026 · Claude export"], ["opaque", "13 Nov 2026 · Claude export"],
    ]);
    expect(imports.find((each) => each.kind === "google-takeout")!.held.map((each) => each.name)).toEqual(["11 Nov 2026 · person-a@example.com"]);
    expect(imports.find((each) => each.kind === "spotify")!.held.map((each) => [each.id, each.name])).toEqual([
      ["username", "10 Nov 2026 · person-a"], ["hex", "9 Nov 2026 · Spotify"], ["digits", "8 Nov 2026 · Spotify"],
      ["short", "7 Nov 2026 · user42"],
    ]);
    expect(imports.find((each) => each.kind === "chatgpt")!.held.map((each) => [each.id, each.name])).toEqual([["chatgpt", "6 Nov 2026 · ChatGPT export"]]);
    expect(imports.find((each) => each.kind === "google-timeline")!.takes).toBe("Google Maps exports it at once, on your phone");
  });

  it("a file the home admitted is in, one it refused whole or that broke refused, any other nothing; each once, in the order asked", () => {
    const { db } = home();
    const kind = declared.importKinds(importsRegistry().connectors, importsRegistry().readers).find((each) => each.id === "spotify")!;
    const file = (digest: string) => ({ files: [{ path: "files/my_spotify_data.zip", blob: `sha256:${digest}`, size: 4_096 }] });
    const [admitted, refused, broken, unseen] = ["aa", "bb", "cc", "dd"].map((pair) => pair.repeat(32)) as [string, string, string, string];
    const admit = (id: string, look: Looked) => db.commit((tx) => admitImport(tx, importsRegistry().connectors, { id, facts: { import: { kind: "spotify" } }, stated_ms: NOW }, "import", look, NOW, []));
    const looked = (digest: string, more: Partial<Looked> = {}): Looked => ({
      kind: "spotify", digest, stamp: null, named: [], account: null, time_ms: null, anchor: null, refused: null, contradicted: null, checked: null, device: null,
      listing: { kind: "spotify", hash: "synthetic", files: [{ path: "my_spotify_data.zip", bytes: 4_096 }], products: [], routes: [] }, ...more,
    });
    admit("import/1", looked(admitted));
    admit("import/2", looked(refused, { refused: "This isn't a Spotify export" }));
    admit("import/3", failedLook(kind, file(broken), new Error("a reader's fault")));
    const keys = [unseen, broken, admitted, refused, admitted].map((digest) => `spotify/${digest}`);
    expect(db.commit((tx) => filesLooked(tx.tables.meta, [...keys, `chatgpt/${admitted}`]))).toEqual([
      { kind: "spotify", digest: broken, state: "refused" }, { kind: "spotify", digest: admitted, state: "in" }, { kind: "spotify", digest: refused, state: "refused" },
    ]);
  });
});
