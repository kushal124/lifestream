import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openHome, openHomeFolder, type HomeDb } from "@lifestreamprotocol/core";
import { openFeed, readFeed, type Feed, type FeedReads, type Page, type Position } from "./feed.js";
import { HomeFile } from "./home-file.js";
import { until } from "./test/harness-root.js";

const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";
const cleanups: (() => void | Promise<void>)[] = [];
async function cleanUp(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

class FlakyReads implements FeedReads {
  failures = 0;
  readonly failed: Position[] = [];
  heads = 0;
  constructor(readonly file: HomeFile) {}
  head(): Promise<Position | undefined> {
    this.heads++;
    return Promise.resolve(readFeed(this.file, "head") as Position | undefined);
  }
  page(after: Position): Promise<Page | undefined> {
    if (this.failures > 0) {
      this.failures--;
      this.failed.push(after);
      return Promise.reject(new Error("SQLITE_BUSY: database is locked"));
    }
    return Promise.resolve(readFeed(this.file, { after }) as Page | undefined);
  }
}

interface Bench {
  dir: string;
  home: HomeDb;
  reads: FlakyReads;
  seen: string[];
  append(key: string): void;
}

async function bench(): Promise<Bench> {
  const dir = mkdtempSync(join(tmpdir(), "home-feed-"));
  cleanups.push(() => (KEEP ? void process.stdout.write(`kept ${dir}\n`) : rmSync(dir, { recursive: true, force: true })));
  const home = openHome(openHomeFolder(dir), "migrate");
  cleanups.push(() => home.close());
  const append = (key: string) => home.commit((tx) => { tx.tables.events.append({ at_ms: 1_790_000_000_000, kind: "day", key }); });
  append("2026-10-01");
  const reads = new FlakyReads(new HomeFile(openHomeFolder(dir)));
  const feed: Feed = openFeed(reads);
  const server: Server = createServer((request, response) => feed.follow(request, response, () => true));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { feed.close(); server.close(() => resolve()); }));
  const seen: string[] = [];
  await new Promise<void>((resolve, reject) => {
    get(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/feed`, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        for (let end = text.indexOf("\n\n"); end >= 0; end = text.indexOf("\n\n")) {
          const block = text.slice(0, end);
          text = text.slice(end + 2);
          const id = /^id: (.+)$/mu.exec(block)?.[1];
          const data = /^data: (.+)$/mu.exec(block)?.[1];
          if (id === undefined || data === undefined) continue;
          const parsed = JSON.parse(data) as { kind?: string; key?: string };
          seen.push(block.includes("event: reset") ? `reset ${id}` : `${id} ${parsed.kind} ${parsed.key}`);
        }
      });
      cleanups.push(() => void response.destroy());
      resolve();
    }).on("error", reject);
  });
  return { dir, home, reads, seen, append };
}

describe("feed", () => {
  it("one failed page read strands a reader until the head moves again", async () => {
    try {
      const b = await bench();
      const heads = b.reads.heads;
      await until("two polls of the feed", () => b.reads.heads >= heads + 2);
      expect(b.seen).toEqual([]);
      b.reads.failures = 1;
      b.append("2026-10-02");
      await until("the page read failed", () => b.reads.failed.length === 1);
      await until("the reader brought up", () => b.seen.length > 0);
      expect(b.seen).toEqual(["2:1790000000000 day 2026-10-02"]);
      writeFileSync(join(b.dir, "feed.json"), `${JSON.stringify({ seen: b.seen, failed: b.reads.failed }, null, 2)}\n`);
    } finally {
      await cleanUp();
    }
  });
});
