import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { MANIFEST_FILE, openSealing } from "./inbox.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const SOURCE = "machine:local:macbook-pro-0001";

function inboxOn(platform: NodeJS.Platform) {
  const root = mkdtempSync(join(tmpdir(), "lifestream-seal-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const inbox = join(root, "inbox");
  mkdirSync(inbox);
  const seal = async (name: string, files: string[], by: "write" | "put" = "write"): Promise<{ path: string; manifest: boolean }[]> => {
    const flushed: { path: string; manifest: boolean }[] = [];
    const directory = join(inbox, SOURCE, name);
    const sealing = openSealing(openHomeFolder(dirname(inbox)), { source: SOURCE, name, feeder: "synthetic", fetched_at: "2026-11-13T04:00:00.000Z" }, {
      platform, flush: (path: string) => flushed.push({ path, manifest: existsSync(join(directory, MANIFEST_FILE)) }),
    });
    for (const file of files) {
      if (by === "put") sealing.put(file, Buffer.from("{}\n"));
      else await sealing.write(file, Readable.from([Buffer.from("{}\n")]));
    }
    sealing.seal({ synthetic: files.length });
    return flushed;
  };
  return { inbox, lane: join(inbox, SOURCE), seal };
}

describe("a seal on Linux", () => {
  it("flushes the lane's directory and inbox/ for every delivery, the lane's first and a later one", async () => {
    const { inbox, lane, seal } = inboxOn("linux");
    expect(await seal("20261113T040000.000Z", ["a.jsonl"])).toEqual([{ path: lane, manifest: true }, { path: inbox, manifest: true }]);
    expect(await seal("20261113T040100.000Z", ["a.jsonl"])).toEqual([{ path: lane, manifest: true }, { path: inbox, manifest: true }]);
  });

  it("flushes inbox/ for a lane whose first seal was abandoned before its manifest", async () => {
    const { inbox, lane, seal } = inboxOn("linux");
    const flushed: string[] = [];
    const abandoned = openSealing(openHomeFolder(dirname(inbox)), { source: SOURCE, name: "20261113T035900.000Z", feeder: "synthetic", fetched_at: "2026-11-13T03:59:00.000Z" }, {
      platform: "linux", flush: (path: string) => flushed.push(path),
    });
    await abandoned.write("a.jsonl", Readable.from([Buffer.from("{}\n")]));
    abandoned.abandon();
    expect(flushed).toEqual([]);
    expect(existsSync(lane)).toBe(true);
    expect(await seal("20261113T040000.000Z", ["a.jsonl"])).toEqual([{ path: lane, manifest: true }, { path: inbox, manifest: true }]);
  });

  it("flushes each sub-directory a file went into, the deepest first and before the manifest is in place", async () => {
    const { inbox, lane, seal } = inboxOn("linux");
    const name = "20261113T040000.000Z";
    const directory = join(lane, name);
    expect(await seal(name, ["a.jsonl", "nested/deep/b.jsonl", "nested/c.jsonl"])).toEqual([
      { path: join(directory, "nested", "deep"), manifest: false },
      { path: join(directory, "nested"), manifest: false },
      { path: lane, manifest: true },
      { path: inbox, manifest: true },
    ]);
  });

  it("a file put from memory is listed, flushed and stored as one written from a stream", async () => {
    const { lane, seal } = inboxOn("linux");
    const files = ["a.jsonl", "nested/b.jsonl"];
    const written = await seal("20261113T040000.000Z", files);
    const put = await seal("20261113T040100.000Z", files, "put");
    const listed = (name: string) => (JSON.parse(readFileSync(join(lane, name, MANIFEST_FILE), "utf8")) as { files: unknown[] }).files;
    expect(put.map((each) => ({ ...each, path: each.path.replace("20261113T040100.000Z", "20261113T040000.000Z") }))).toEqual(written);
    expect(listed("20261113T040100.000Z")).toEqual(listed("20261113T040000.000Z"));
    expect(files.map((file) => readFileSync(join(lane, "20261113T040100.000Z", file), "utf8"))).toEqual(["{}\n", "{}\n"]);
  });
});

describe("a seal on a Mac", () => {
  it("flushes none of them: the delivery's own flush holds them on APFS", async () => {
    const { seal } = inboxOn("darwin");
    expect(await seal("20261113T040000.000Z", ["a.jsonl", "nested/b.jsonl"])).toEqual([]);
    expect(await seal("20261113T040100.000Z", ["a.jsonl"])).toEqual([]);
  });
});
