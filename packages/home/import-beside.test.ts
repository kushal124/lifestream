import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filesBeside } from "./import.js";
import { GONE, goneOf } from "./imports.js";
import { SWEPT_FILE } from "./inbox.js";
import type { Receipt } from "./sweep.js";
import { sealDelivery } from "./test/ops-support.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const A = "import/takeout-a";
const ARCHIVE = "takeout-20260901T000000Z-1-001.zip";
const OTHER = "takeout-20260901T000000Z-1-002.zip";
const MEMBER = `members/files/${ARCHIVE}/Takeout/Google Photos/Album/IMG_0001.jpg.supplemental-metadata.json`;

describe("the files beside an import's read", () => {
  it("leaves out a companion delivery's file marked gone, its bytes still present after a crash, and keeps the text members copied out of it", () => {
    const root = mkdtempSync(join(tmpdir(), "lifestream-import-beside-"));
    roots.push(root);
    const inbox = join(root, "inbox");
    const directory = sealDelivery(root, "import", "takeout-a", { [`files/${ARCHIVE}`]: Buffer.from("a synthetic archive"), [`files/${OTHER}`]: Buffer.from("another synthetic archive") });
    mkdirSync(join(directory, MEMBER, ".."), { recursive: true });
    writeFileSync(join(directory, MEMBER), "{\"title\": \"IMG_0001.jpg\"}");
    const receipt: Receipt = { swept_ms: 0, done: false, removed: [`files/${ARCHIVE}`], kept: [], copied: [MEMBER] };
    writeFileSync(join(directory, SWEPT_FILE), JSON.stringify(receipt));
    const meta = { get: (key: string) => (key === `${GONE}${A}` ? JSON.stringify([ARCHIVE]) : undefined) };

    const handed = filesBeside(openHomeFolder(dirname(inbox)), [{ id: A, gone: new Set(goneOf(meta, A)) }]).map(({ file }) => file.path).sort();
    expect(handed).toEqual([`${A}/${MEMBER}`, `${A}/${OTHER}`]);
  });
});
