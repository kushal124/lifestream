import { artifact, boundedRead, childScript, exportLines, HEAP_MiB, MiB, temp, writeZip } from "../test/drive.js";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sha = (chunks: Iterable<Buffer>): string => {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
};

describe("zip at scale: each of these is impossible", () => {
  it("memory grows with the size of a member or the archive", () => {
    const dir = temp();
    const large = join(dir, "large.zip");
    const size = 256 * MiB;
    writeZip(large, [
      { name: "Takeout/Mail/All mail.mbox", bytes: () => exportLines(size), method: "deflate" },
      { name: "Takeout/Photos/video.mov", bytes: () => exportLines(size) },
    ]);
    const script = childScript(dir, `
      import { createHash } from "node:crypto";
      import { openZip } from "./zip.ts";
      const zip = openZip(${JSON.stringify(large)});
      const before = process.resourceUsage().maxRSS;
      const read = {};
      for (const entry of zip.entries()) {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of entry.stream()) { hash.update(chunk); bytes += chunk.length; }
        read[entry.name] = { bytes, sha256: hash.digest("hex") };
      }
      zip.close();
      read.grew_mib = (process.resourceUsage().maxRSS - before) / 1024;
      console.log(JSON.stringify(read));
    `);
    const read = boundedRead<Record<string, { bytes: number; sha256: string }> & { grew_mib: number }>(script);
    expect(read["Takeout/Mail/All mail.mbox"]).toEqual({ bytes: size, sha256: sha(exportLines(size)) });
    expect(read["Takeout/Photos/video.mov"]?.bytes).toBe(size);
    expect(read.grew_mib).toBeLessThan(size / MiB / 2);
    artifact(dir, "memory.json", { read, heap_mib: HEAP_MiB, member_mib: size / MiB, archive_mib: statSync(large).size / MiB });
  });
});
