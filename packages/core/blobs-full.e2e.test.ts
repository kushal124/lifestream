import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256File, temp, writeLargeText } from "./test/large.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MiB = 1024 * 1024;

describe("the blob store at scale: each of these is impossible", () => {
  it("putFile or materialise holds a large blob in memory, whole or chunk by chunk", () => {
    const dir = temp("core-blobs-full-");
    const root = join(dir, "blobs");
    const sizes = { warm: 8 * MiB, warmer: 32 * MiB, large: 256 * MiB };
    for (const [name, size] of Object.entries(sizes)) writeLargeText(join(dir, `${name}.sqlite`), size);
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { openHomeFolder } from ${JSON.stringify(pathToFileURL(join(HERE, "home-folder.ts")).href)};
      const store = openHomeFolder(${JSON.stringify(dirname(root))}).blobs(${JSON.stringify(root)});
      const run = async (name) => {
        const hash = await store.putFile(${JSON.stringify(dir)} + "/" + name + ".sqlite", { mediaType: "application/vnd.sqlite3" });
        const opened = await store.materialise(hash);
        opened.dispose();
        for await (const _chunk of store.stream(hash)) {
          // Read to its end: the stream checks the bytes against the name there.
        }
        return hash;
      };
      await run("warm");
      await run("warmer");
      const before = process.resourceUsage().maxRSS * 1024;
      const hash = await run("large");
      const after = process.resourceUsage().maxRSS * 1024;
      console.log(JSON.stringify({ hash, before, after }));
    `);
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: dirname(HERE), encoding: "utf8" });
    expect(result.stderr).toBe("");
    const measured = JSON.parse(result.stdout) as { hash: string; before: number; after: number };
    expect(measured.hash).toBe(sha256File(join(dir, "large.sqlite")));
    expect(measured.after - measured.before).toBeLessThan(sizes.large / 2);
    writeFileSync(join(dir, "blobs.json"), `${JSON.stringify({ ...measured, growth_mib: (measured.after - measured.before) / MiB, blob_mib: sizes.large / MiB }, null, 2)}\n`);
  });
});
