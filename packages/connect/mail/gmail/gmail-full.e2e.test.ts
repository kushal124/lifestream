import { adopt, artifact, boundedRead, HEAP_MiB, MiB, temp } from "../../test/drive.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { largeMbox } from "./test/fixtures.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

describe("the gmail connector at scale: each of these is impossible", () => {
  it("memory grows with delivery size", () => {
    const dir = temp();
    const size = 4 * HEAP_MiB * MiB;
    const path = join(dir, "export.mbox");
    const messages = largeMbox(path, size);
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = { id: "d", source: "gmail:person-a@example.com:cloud", sealed_ms: 1, stated_ms: 1, facts: { sources: [{ id: "gmail:person-a@example.com:cloud", connector: "gmail-takeout" }] }, files: [{ path: "a.mbox", ...adopt(blobs, path) }] };
    const here = (relative: string): string => JSON.stringify(new URL(relative, import.meta.url).href);
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { join } from "node:path";
      import { openHomeFolder } from ${here("../../../core/index.ts")};
      import { gmail } from ${here("./reader.ts")};
      const blobs = openHomeFolder(${JSON.stringify(dir)}).blobs(join(${JSON.stringify(dir)}, "blobs"));
      const before = process.resourceUsage().maxRSS;
      let rows = 0;
      for await (const row of gmail.read(${JSON.stringify(delivery)}, blobs)) rows++;
      console.log(JSON.stringify({ rows, grew_mib: (process.resourceUsage().maxRSS - before) / 1024 }));
    `);
    const measured = boundedRead<{ rows: number; grew_mib: number }>(script);
    expect(measured.rows).toBe(messages + Math.min(500, messages));
    expect(measured.grew_mib).toBeLessThan(size / MiB / 2);
    artifact(dir, "memory.json", { ...measured, messages, heap_mib: HEAP_MiB, export_mib: size / MiB });
  });
});
