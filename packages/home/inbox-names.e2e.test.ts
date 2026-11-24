import { execFile } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { declarations } from "@lifestreamprotocol/connect";
import { openHomeFolder, type HomeFolder, type JsonObject, type ReadTables } from "@lifestreamprotocol/core";
import { keyedFolder, testMachine } from "@lifestreamprotocol/core/test/keyed";
import { afterEach, describe, expect, it } from "vitest";
import { deliveredFile, deliveryDirectory, inboxLane, lanes, openSealing, readDelivery } from "./inbox.js";
import { fileOfPath, GONE } from "./imports.js";
import { checkoutProgram } from "./programs.js";
import { readReceipt, sweepInbox } from "./sweep.js";
import { REPO } from "./test/harness-root.js";
import { DAY, openTestHome, removeDir, sha256, T0, tempDir } from "./test/ops-support.js";
import { zip } from "./test/support.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()!();
});

const CANARY = {
  account: "zqx-canary-account-8d21@example.com",
  file: "ZQX-CANARY-file-3b70",
  member: "ZQX-CANARY-member-a94e",
} as const;
const GMAIL = `gmail:${CANARY.account}:cloud`;
const NESTED = `files/export/chats/${CANARY.file}.txt`;
const ARCHIVE = "files/export/archive.zip";
const MEMBER = `${CANARY.member}.json`;
const COPIED = `members/${ARCHIVE}/${MEMBER}`;
const BYTES = {
  mail: Buffer.from('{"message":"synthetic"}\n'),
  nested: Buffer.from("a synthetic chat line\n"),
  member: Buffer.from('{"title":"synthetic"}'),
};

async function seal(folder: HomeFolder, source: string, name: string, files: Record<string, Buffer>, facts: JsonObject = {}): Promise<string> {
  const sealing = openSealing(folder, { source, name, feeder: "synthetic", fetched_at: "2026-09-01T08:00:00.000Z" });
  for (const [file, bytes] of Object.entries(files)) await sealing.write(file, (async function* () { yield bytes; })());
  sealing.seal(facts);
  return deliveryDirectory(folder, source, name);
}

function paths(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

function canaryPaths(folder: string, machine: string): Promise<{ kind: string; path: string; detail: string }[]> {
  const args = [...checkoutProgram(join(REPO, "tools", "inventory.ts")), "--folder", folder, "--machine", machine, ...Object.values(CANARY).flatMap((canary) => ["--canary", canary])];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }, (_error, stdout, stderr) => {
      try {
        const flags = (JSON.parse(stdout) as { flags: { kind: string; path: string; detail: string }[] }).flags;
        resolve(flags.filter((flag) => flag.kind === "canary" && flag.detail.startsWith("its path holds")));
      } catch {
        reject(new Error(`the inventory printed no report: ${stderr}`));
      }
    });
  });
}

describe("the inbox's names on a plain and on a keyed home", () => {
  it.each(["plain", "keyed"] as const)("a %s home's account in a source id, a nested import file name or an archive member copied by the sweep naming a path, or a delivery not read back by its logical names after the sweep", async (form) => {
    const root = tempDir(`inbox-names-${form}`);
    const machine = testMachine();
    const folder = form === "keyed" ? keyedFolder(root, machine) : openHomeFolder(root);
    const test = openTestHome(root, folder);
    cleanup.push(() => removeDir(root), () => test.close());
    const inbox = join(root, "inbox");
    await seal(folder, GMAIL, "20260901T080000Z", { "mail.ndjson": BYTES.mail });
    const imported = await seal(folder, "import", "20260901T080001Z", { [NESTED]: BYTES.nested, [ARCHIVE]: zip([[MEMBER, BYTES.member]]) }, { import: { kind: "whatsapp" }, history: true });
    test.db.commit((tx) => tx.tables.meta.set(`${GONE}import/20260901T080001Z`, JSON.stringify([fileOfPath(ARCHIVE)])));

    const read = <T>(work: (tables: ReadTables) => T): T => {
      const view = test.db.view();
      try {
        return work(view.tables);
      } finally {
        view.close();
      }
    };
    const swept = sweepInbox({ folder, read, commit: (work) => test.db.commit(work), blobs: test.blobs, now_ms: T0 + 30 * DAY, off: [], connectors: declarations() });
    expect(swept).toMatchObject({ import_files: 1, unreadable: [] });

    expect(lanes(folder)).toEqual([GMAIL, "import"].sort());
    expect(readDelivery(folder, GMAIL, "20260901T080000Z")?.files.map((file) => file.path)).toEqual(["mail.ndjson"]);
    expect(deliveredFile(folder, deliveryDirectory(folder, GMAIL, "20260901T080000Z"), "mail.ndjson").read()?.equals(BYTES.mail)).toBe(true);
    expect(readDelivery(folder, "import", "20260901T080001Z")?.files.map((file) => file.path).sort()).toEqual([ARCHIVE, NESTED]);
    expect(readReceipt(folder, imported)).toMatchObject({ done: true, removed: [ARCHIVE], copied: [COPIED] });
    expect(deliveredFile(folder, imported, NESTED).read()?.equals(BYTES.nested)).toBe(true);
    expect(deliveredFile(folder, imported, COPIED).read()?.equals(BYTES.member)).toBe(true);
    expect(deliveredFile(folder, imported, ARCHIVE).exists()).toBe(false);

    const named = paths(inbox).join("\n");
    if (form === "plain") {
      expect(existsSync(join(inbox, GMAIL, "20260901T080000Z", "mail.ndjson"))).toBe(true);
      expect(existsSync(join(inbox, "import", "20260901T080001Z", NESTED))).toBe(true);
      expect(existsSync(join(inbox, "import", "20260901T080001Z", COPIED))).toBe(true);
      expect(paths(inbox).some((path) => path.endsWith("lane"))).toBe(false);
    } else {
      for (const canary of Object.values(CANARY)) expect(named).not.toContain(canary);
      expect(named).not.toContain("import/");
      expect(await canaryPaths(root, machine)).toEqual([]);
    }
  });

  it("a keyed lane made by a blob stored with no delivery missing from the lanes, or one whose lane file no longer opens stopping the look and the sweep instead of counted unreadable", async () => {
    const root = tempDir("inbox-names-lane");
    const folder = keyedFolder(root);
    const test = openTestHome(root, folder);
    cleanup.push(() => removeDir(root), () => test.close());
    const bytes = Buffer.from("a synthetic carried photo");
    const hex = sha256(bytes);
    expect(await inboxLane(folder, GMAIL).store(hex, (async function* () { yield bytes; })(), bytes.length)).toBe(true);
    expect(lanes(folder)).toEqual([GMAIL]);
    expect(inboxLane(folder, GMAIL).has(hex)).toBe("file");

    const inbox = join(root, "inbox");
    for (const name of readdirSync(inbox)) {
      for (const entry of readdirSync(join(inbox, name), { withFileTypes: true })) if (entry.isFile()) writeFileSync(join(inbox, name, entry.name), "damaged");
    }
    const unreadable: string[] = [];
    expect(lanes(folder, { unreadable: (why) => unreadable.push(why) })).toEqual([]);
    expect(unreadable).toHaveLength(1);
    const read = <T>(work: (tables: ReadTables) => T): T => {
      const view = test.db.view();
      try {
        return work(view.tables);
      } finally {
        view.close();
      }
    };
    expect(sweepInbox({ folder, read, commit: (work) => test.db.commit(work), blobs: test.blobs, now_ms: T0, off: [], connectors: declarations() }).unreadable).toHaveLength(1);
  });
});
