import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { handedFile } from "./handed.js";
import { blobHanded, filesAt, IMPORT_LANE, sealImport } from "./import-file.js";
import { digestOf, importFiles } from "./imports.js";
import { readDelivery } from "./inbox.js";
import { makeRoot, removeRoot } from "./test/harness-root.js";
import importsRegistry from "./test/imports-registry.js";
import { sha256, zip } from "./test/support.js";

const AT = Date.UTC(2026, 10, 1, 12);
const FILE = "my_spotify_data.zip";
const BYTES = zip([["Spotify Extended Streaming History/Streaming_History_Audio_2025.json", Buffer.from("[]")]]);
const HEX = sha256(BYTES);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root);
});

function root(): string {
  const made = makeRoot("lifestream-handed-", { sources: {} });
  roots.push(made);
  return made;
}

describe("a file handed in, looked at for an import", () => {
  it("names its file otherwise than the upload reader stated it, or a record that states no original file as one", () => {
    const content = {
      type: "upload.file", path: FILE, name: FILE, bytes: BYTES.length, media_type: "application/zip", shared_at: "2026-11-01T12:00:00Z",
      blobs: [{ hash: `sha256:${HEX}`, bytes: BYTES.length, role: "original" }],
    };
    expect(handedFile(content)).toEqual({ name: FILE, blob: `sha256:${HEX}`, size: BYTES.length });
    expect(handedFile({ ...content, blobs: [{ hash: `sha256:${HEX}`, bytes: BYTES.length, role: "preview" }] })).toBeNull();
    expect(handedFile({ ...content, name: 7 })).toBeNull();
    expect([handedFile(null), handedFile("file"), handedFile([content])]).toEqual([null, null, null]);
  });

  it("sealed from the home's blob store, is another file than the same bytes handed by path, or two seals at one instant share a name", async () => {
    const home = root();
    const folder = openHomeFolder(home);
    const blobs = folder.blobs(join(home, "blobs"));
    const blob = blobs.put(BYTES);
    const downloads = join(home, "downloads");
    mkdirSync(downloads);
    writeFileSync(join(downloads, FILE), BYTES);
    const registry = importsRegistry();
    const byPath = await sealImport(folder, registry, "spotify", filesAt(join(downloads, FILE)), AT);
    const byBlob = await sealImport(folder, registry, "spotify", [blobHanded(FILE, blob, blobs)], AT);
    expect(byBlob).not.toBe(byPath);
    const read = (id: string) => readDelivery(folder, IMPORT_LANE, id.slice(`${IMPORT_LANE}/`.length))!;
    const [path, stored] = [read(byPath), read(byBlob)];
    expect([path.files, path.facts, digestOf(importFiles(path.files))]).toEqual([[{ path: `files/${FILE}`, blob: `sha256:${HEX}`, size: BYTES.length }], { import: { kind: "spotify" }, history: true }, HEX]);
    expect([stored.files, stored.facts, digestOf(importFiles(stored.files))]).toEqual([path.files, path.facts, HEX]);
    expect(stored.sealed_ms).toBe(path.sealed_ms + 1);
  });

  it("is named by a path, a name that cannot name a file, or for another kind than the home's", async () => {
    const home = root();
    const folder = openHomeFolder(home);
    const blobs = folder.blobs(join(home, "blobs"));
    const blob = blobs.put(BYTES);
    expect([blobHanded(`Downloads/${FILE}`, blob, blobs).path, blobHanded("..", blob, blobs).path, blobHanded("", blob, blobs).path, blobHanded("shared/", blob, blobs).path])
      .toEqual([`files/${FILE}`, `files/${HEX}`, `files/${HEX}`, `files/${HEX}`]);
    await expect(sealImport(folder, importsRegistry(), "no-such-kind", [blobHanded(FILE, blob, blobs)], AT)).rejects.toThrow(/no-such-kind is no import kind of this home/u);
  });
});
