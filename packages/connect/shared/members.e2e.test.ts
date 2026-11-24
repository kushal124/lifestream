import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BlobError, type BlobReader, type ReaderOutput } from "@lifestreamprotocol/core";
import { artifact, collect, counts, deliver, openTestHome, writeZip } from "../test/drive.js";
import { myActivity } from "../google/my-activity/reader.js";
import { activityFile, EXPORTED_AT, ROOT, source } from "../google/my-activity/test/fixtures.js";
import { gmail } from "../mail/gmail/reader.js";
import { SOURCE as GMAIL, takeoutFacts, takeoutMbox } from "../mail/gmail/test/fixtures.js";
import { archive } from "./members.js";
import { each } from "./refused.js";

const failing = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const openSync = ((path: Parameters<typeof fs.openSync>[0], ...rest: unknown[]) => {
    if (failing.has(String(path))) throw Object.assign(new Error(`EIO: i/o error, open '${String(path)}'`), { code: "EIO", errno: -5, syscall: "open" });
    return (fs.openSync as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof fs.openSync;
  return { ...fs, default: { ...fs, openSync }, openSync };
});

const MAILBOX = "takeout-20261012T000000Z-002.zip";
const DAMAGED = "takeout-20261012T000000Z-003.zip";

function counting(files: BlobReader): { reader: BlobReader; copied: string[] } {
  const copied: string[] = [];
  return {
    copied,
    reader: {
      has: (hash) => files.has(hash),
      bytes: (hash) => files.bytes(hash),
      text: (hash) => files.text(hash),
      prefix: (hash, bytes) => files.prefix(hash, bytes),
      materialise: async (hash) => {
        copied.push(hash);
        return files.materialise(hash);
      },
    },
  };
}

describe("a delivered archive with one bad file: each of these is impossible", () => {
  it("one bad file fails the delivery, is copied out before it is known, or goes unnamed", async () => {
    const home = openTestHome("connect-members-");
    const entry = (folder: string, title: string) => activityFile([{ header: folder, title, time: "2026-09-01T10:00:00.000Z", products: [folder] }]);
    const good = join(home.dir, "takeout-001.zip");
    writeZip(good, [
      { name: `${ROOT}/Search/MyActivity.json`, bytes: entry("Search", "Searched for synthetic words"), method: "deflate" },
      { name: `${ROOT}/Image Search/MyActivity.json`, bytes: entry("Image Search", "Searched for synthetic pictures"), method: "deflate" },
      { name: `${ROOT}/Video Search/MyActivity.json`, bytes: entry("Video Search", "Searched for synthetic videos"), method: "deflate" },
    ]);
    const files = {
      "takeout-20261012T000000Z-001.zip": readFileSync(good),
      [MAILBOX]: takeoutMbox(),
      [DAMAGED]: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("synthetic part cut short")]),
    };

    const activity = deliver(home, source("google-search"), files, { exported_at: EXPORTED_AT });
    const read = counting(home.blobs);
    const activityRows = await collect(myActivity.read(activity, read.reader));
    const landed = await home.land(myActivity, activity, activityRows);
    expect(landed).toMatchObject({ new: 3, refused: 1 });
    expect(landed.refusals).toEqual([{ kind: "file", key: DAMAGED, violations: [expect.stringContaining("its first bytes are a zip's, and it cannot be listed")] }]);
    const mailbox = activity.files.find((file) => file.path === MAILBOX)!.blob;
    expect(read.copied).not.toContain(mailbox);

    const mail = deliver(home, GMAIL, files, takeoutFacts(GMAIL, EXPORTED_AT));
    const mailRead = counting(home.blobs);
    const mailLanded = await home.land(gmail, mail, await collect(gmail.read(mail, mailRead.reader)));
    expect(mailLanded.new).toBeGreaterThan(0);
    expect(mailLanded.refusals).toEqual([{ kind: "file", key: DAMAGED, violations: [expect.stringContaining("cannot be listed")] }]);

    artifact(home.dir, "bad-file.json", { activity: counts(landed), mail: counts(mailLanded), copied: { activity: read.copied, mail: mailRead.copied } });
  });

  it("a zip whose listing breaks after it opens fails the delivery", async () => {
    const home = openTestHome("connect-listing-");
    const path = join(home.dir, "listing.zip");
    writeZip(path, [
      { name: "Takeout/Mail/first.mbox", bytes: takeoutMbox(), method: "deflate" },
      { name: "Takeout/Mail/second.mbox", bytes: takeoutMbox(), method: "deflate" },
    ]);
    const bytes = readFileSync(path);
    const second = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 4);
    bytes.writeUInt32LE(0, second);
    const BROKEN = "takeout-20261012T000000Z-004.zip";
    const mail = deliver(home, GMAIL, { [MAILBOX]: takeoutMbox(), [BROKEN]: bytes }, takeoutFacts(GMAIL, EXPORTED_AT));
    const landed = await home.land(gmail, mail, await collect(gmail.read(mail, home.blobs)));
    expect(landed.new).toBeGreaterThan(0);
    expect(landed.refusals).toEqual([{ kind: "file", key: BROKEN, violations: [expect.stringContaining("cannot be listed")] }]);
    const zip = mail.files.find((file) => file.path === BROKEN)!.blob;
    const faults: string[] = [];
    for (const code of ["BLOB_NO_SPACE", "BLOB_CORRUPT", "EIO"] as const) {
      const reader: BlobReader = {
        has: (hash) => home.blobs.has(hash),
        bytes: (hash) => home.blobs.bytes(hash),
        text: (hash) => home.blobs.text(hash),
        prefix: (hash, bytes) => home.blobs.prefix(hash, bytes),
        materialise: async (hash) => {
          if (code !== "EIO") throw new BlobError(code, `synthetic ${code}`);
          const copy = await home.blobs.materialise(hash);
          if (hash === zip) failing.add(copy.path);
          return copy;
        },
      };
      const thrown = await collect(gmail.read(mail, reader)).then(() => undefined, (error: unknown) => error);
      failing.clear();
      expect((thrown as { code?: unknown } | undefined)?.code, code).toBe(code);
      faults.push(`${code}: thrown`);
    }
    artifact(home.dir, "listing.json", { ...counts(landed), faults });
  });

  it("a member whose bytes cannot be read whole throws raw, or takes the members after it", async () => {
    const home = openTestHome("connect-member-");
    const path = join(home.dir, "part.zip");
    const text = (name: string) => Buffer.from(`synthetic member ${name}\n`.repeat(40));
    writeZip(path, [
      { name: "Takeout/a.txt", bytes: text("a"), method: "deflate" },
      { name: "Takeout/b.txt", bytes: text("b") },
      { name: "Takeout/c.txt", bytes: text("c"), method: "deflate" },
      { name: "Takeout/d.txt", bytes: text("d") },
    ]);
    const bytes = readFileSync(path);
    const dataOf = (name: string) => bytes.indexOf(Buffer.from(name)) + Buffer.byteLength(name);
    bytes.writeUInt8(bytes.readUInt8(dataOf("Takeout/b.txt") + 3) ^ 0x01, dataOf("Takeout/b.txt") + 3);
    bytes.writeUInt8(0xff, dataOf("Takeout/c.txt"));
    const PART = "takeout-20261012T000000Z-005.zip";
    const delivery = deliver(home, GMAIL, { [PART]: bytes }, takeoutFacts(GMAIL, EXPORTED_AT));
    const outcomes: Record<string, unknown> = {};
    for (const read of ["chunks", "bytes"] as const) {
      const rows = await collect(archive(delivery, home.blobs, (members) => each(members, (member) => member.where, async (member): Promise<ReaderOutput[]> => {
        const whole = read === "bytes" ? member.bytes() : Buffer.concat(await collect(member.chunks() as AsyncIterable<Buffer>));
        return [{ kind: "member", key: member.where, content: { lines: whole.toString("utf8").split("\n").length } }];
      })));
      const seen = rows.map((row) => (row.refused === undefined ? `${row.key}: read` : `${row.key}: ${row.refused}`));
      expect(seen, read).toEqual([
        `${PART}/Takeout/a.txt: read`,
        expect.stringMatching(new RegExp(`^${PART}/Takeout/b\\.txt: .* (?:reads as|expands past|does not inflate) `, "u")),
        expect.stringMatching(new RegExp(`^${PART}/Takeout/c\\.txt: .*does not inflate`, "u")),
        `${PART}/Takeout/d.txt: read`,
      ]);
      outcomes[read] = seen;
    }
    artifact(home.dir, "members.json", outcomes);
  });

  it("two members of one name hide one another, or are handed in another order next listing", async () => {
    const home = openTestHome("connect-twice-");
    const part = join(home.dir, "takeout-20261012T000000Z-006.zip");
    writeZip(part, [
      { name: "Takeout/Keep/note.txt", bytes: Buffer.from("first synthetic note\n") },
      { name: "Takeout/Keep/note.txt", bytes: Buffer.from("second synthetic note\n"), method: "deflate" },
      { name: "Takeout/Keep/note.txt", bytes: Buffer.from("third synthetic note\n") },
      { name: "Takeout/Keep/README", bytes: Buffer.from("synthetic readme\n") },
      { name: "Takeout/Keep/README", bytes: Buffer.from("another synthetic readme\n") },
    ]);
    const delivery = deliver(home, GMAIL, { "takeout-20261012T000000Z-006.zip": readFileSync(part) }, takeoutFacts(GMAIL, EXPORTED_AT));
    const runs: [string, string][][] = [];
    for (const _run of [1, 2]) {
      const seen: [string, string][] = [];
      await collect(archive(delivery, home.blobs, async function* (members) {
        for (const member of members) seen.push([member.name, member.bytes().toString("utf8")]);
      }));
      runs.push(seen);
    }
    expect(runs[0]).toEqual([
      ["Takeout/Keep/note.txt", "first synthetic note\n"],
      ["Takeout/Keep/note.txt", "second synthetic note\n"],
      ["Takeout/Keep/note.txt", "third synthetic note\n"],
      ["Takeout/Keep/README", "synthetic readme\n"],
      ["Takeout/Keep/README", "another synthetic readme\n"],
    ]);
    expect(runs[1]).toEqual(runs[0]);
    artifact(home.dir, "twice.json", runs[0]);
  });

  it("a part named `.zip` that is no zip is listed as a zip's members", async () => {
    const home = openTestHome("connect-named-");
    const delivery = deliver(home, GMAIL, { [MAILBOX]: takeoutMbox() }, takeoutFacts(GMAIL, EXPORTED_AT));
    const seen: [string, string | undefined][] = [];
    const rows = await collect(archive(delivery, home.blobs, async function* (members) {
      for (const member of members) seen.push([member.name, member.zip]);
    }));
    expect([seen, rows]).toEqual([[[MAILBOX, undefined]], []]);
  });
});
