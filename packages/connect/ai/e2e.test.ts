import { artifact, collect, counts, deliver, goldenSets, openTestHome, parityOf, readStoring, writeZip, type TestHome } from "../test/drive.js";
import { looked } from "../test/imports.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONSUMED, type JsonObject } from "@lifestreamprotocol/core";
import { chatgptConnector } from "./chatgpt/reader.js";
import { claudeConnector } from "./claude/reader.js";
import { CHATGPT_ACCOUNT, CHATGPT_SOURCE, chatgptExport, chatgptHanded, CLAUDE_ACCOUNT, CLAUDE_SOURCE, claudeExport, claudeHanded, claudeOffered, inFolder, zipped, type Files } from "./test/fixtures.js";

const GOLDEN = goldenSets(new URL("./test/parity.golden.json", import.meta.url));
const KINDS = ["chat", "msg"];
const T0 = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;

const homes: TestHome[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): TestHome {
  const made = openTestHome("connect-ai");
  homes.push(made);
  return made;
}

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "connect-ai-"));
  dirs.push(dir);
  return dir;
}

const imported = (kind: string) => ({ import: { kind, id: "import-0001" } });
const consumedOf = (rows: readonly { kind: string; key: string }[]) => rows.filter((row) => row.kind === CONSUMED).map((row) => row.key);

function claudeFiles(version: "first" | "later", drop?: string): Files {
  const exported = claudeExport(version);
  const dir = temp();
  const files: Files = { [exported.manifestName]: exported.manifest };
  for (const [name, members] of Object.entries(exported.archives)) {
    if (name === drop) continue;
    const path = join(dir, name);
    writeZip(path, Object.entries(members).map(([member, bytes]) => ({ name: member, bytes, method: "deflate" as const })));
    files[name] = readFileSync(path);
  }
  return files;
}

describe("chatgpt connector", () => {
  it("the parity golden differs", async () => {
    const at = home();
    for (const version of ["first", "later"] as const) {
      const delivery = deliver(at, CHATGPT_SOURCE, chatgptExport(version), {}, T0);
      const read = await collect(chatgptConnector.read(delivery, at.blobs));
      expect(parityOf(read), version).toEqual(parityOf(GOLDEN[`chatgpt-${version}`]!));
    }
    artifact(at.dir, "parity.json", { first: GOLDEN["chatgpt-first"]!.length, later: GOLDEN["chatgpt-later"]!.length });
  });

  it("a synthetic delivery lands different heads than expected", async () => {
    const at = home();
    const delivery = deliver(at, CHATGPT_SOURCE, chatgptExport("first"), {}, T0);
    const rows = await collect(chatgptConnector.read(delivery, at.blobs));
    const landed = await at.land(chatgptConnector, delivery);
    expect(landed).toMatchObject({ new: 8, refused: 0, duplicated: 0 });
    const landedHeads = at.heads(CHATGPT_SOURCE, KINDS);
    expect(landedHeads.map((head) => [head.kind, head.key, head.version])).toEqual(parityOf(GOLDEN["chatgpt-first"]!).map((row) => [row.kind, row.key, row.id]));
    const first = rows.find((row) => row.key.endsWith(":a0000000-0000-4000-8000-000000000001"))!;
    const blob = (path: string) => delivery.files.find((file) => file.path === path)!.blob;
    expect(first.blobs).toEqual([blob("file-AbC123-synthetic.png"), blob("file_00aa11.dat")].sort());
    artifact(at.dir, "heads.json", { landed: counts(landed), heads: landedHeads });
  });

  it("a degraded conversation or a smaller export lands a gone", async () => {
    const at = home();
    await at.land(chatgptConnector, deliver(at, CHATGPT_SOURCE, chatgptExport("first"), {}, T0));
    const later = await at.land(chatgptConnector, deliver(at, CHATGPT_SOURCE, chatgptExport("later"), {}, T0 + DAY));
    expect(later).toMatchObject({ gone: 0, new: 1, changed: 1, restated: 3, late: 0 });
    expect(later.changedPaths).toEqual({ current_node: 1, title: 1, update_time: 1 });
    expect(at.heads(CHATGPT_SOURCE, KINDS)).toHaveLength(9);
    artifact(at.dir, "degraded.json", counts(later));
  });

  it("an older export landing after a newer one moves a head", async () => {
    const at = home();
    await at.land(chatgptConnector, deliver(at, CHATGPT_SOURCE, chatgptExport("later"), {}, T0 + DAY));
    const older = await at.land(chatgptConnector, deliver(at, CHATGPT_SOURCE, chatgptExport("first"), {}, T0));
    expect(older).toMatchObject({ late: 1, new: 4, restated: 3, changed: 0 });
    const shell = at.heads(CHATGPT_SOURCE, ["chat"]).find((head) => head.key.startsWith("bbbbbbbb"))!;
    expect((shell.content as JsonObject).title).toBe("Synthetic recipe, renamed");
    artifact(at.dir, "older.json", counts(older));
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const at = home();
    const files = chatgptExport("first");
    files["conversations-002.json"] = files["conversations-001.json"]!;
    const landed = await at.land(chatgptConnector, deliver(at, CHATGPT_SOURCE, files, {}, T0));
    expect(landed.duplicated).toBe(2);
    artifact(at.dir, "duplicated.json", counts(landed));
  });

  it("a number a double cannot carry refuses the export or changes its spelling silently", async () => {
    const at = home();
    const files = chatgptExport("first");
    const lossy = "0.1000000000000000055511151231257827";
    files["conversations-001.json"] = Buffer.from(files["conversations-001.json"]!.toString().replace('"weight":1', `"weight":${lossy}`));
    const rows = await collect(chatgptConnector.read(deliver(at, CHATGPT_SOURCE, files, {}, T0), at.blobs));
    const node = (rows.find((row) => row.key.startsWith("cccccccc") && row.kind === "msg")!.content as { node: { message: JsonObject } }).node;
    expect(node.message.weight).toBe(lossy);
    artifact(at.dir, "lossy.json", node.message);
  });

  it("a conversation the export cannot name, or a shard that breaks, refuses more than itself", async () => {
    const at = home();
    const files = chatgptExport("first");
    files["conversations-001.json"] = Buffer.from(files["conversations-001.json"]!.toString().replace('"id":"cccccccc-0000-4000-8000-00000000000c"}', '"id":"not-a-uuid"}'));
    const named = await at.land(chatgptConnector, deliver(at, CHATGPT_SOURCE, files, {}, T0));
    expect(named).toMatchObject({ new: 6, refused: 1 });
    expect(named.refusals.map((refusal) => refusal.key)).toEqual(["conversations-001.json:conversations[0]"]);
    expect(at.heads(CHATGPT_SOURCE, KINDS).filter((head) => head.key.startsWith("cccccccc"))).toEqual([]);
    const cut = chatgptExport("first");
    const shard = cut["conversations-000.json"]!.toString();
    cut["conversations-000.json"] = Buffer.from(shard.slice(0, shard.indexOf(',{},') + 1));
    const other = openTestHome("connect-ai");
    homes.push(other);
    const broken = await other.land(chatgptConnector, deliver(other, CHATGPT_SOURCE, cut, {}, T0));
    expect(broken).toMatchObject({ new: 6, refused: 1 });
    expect(broken.refusals[0]).toMatchObject({ key: "conversations-000.json" });
    expect(broken.refusals[0]!.violations[0]).toMatch(/after 1 value/u);
    expect(other.heads(CHATGPT_SOURCE, ["chat"]).map((head) => head.key)).toEqual(["aaaaaaaa-0000-4000-8000-00000000000a", "cccccccc-0000-4000-8000-00000000000c"]);
    await expect(at.land(chatgptConnector, deliver(at, "chatgpt:user-someone-else:export", chatgptExport("first"), {}, T0))).rejects.toThrow(/the source is chatgpt:user-someone-else:export/u);
    artifact(at.dir, "refused.json", { named: counts(named), broken: counts(broken) });
  });
});

describe("claude connector", () => {
  it("the parity golden differs", async () => {
    const at = home();
    for (const version of ["first", "later"] as const) {
      const rows = parityOf(await collect(claudeConnector.read(deliver(at, CLAUDE_SOURCE, claudeFiles(version), {}, T0), at.blobs)));
      expect(rows, version).toEqual(parityOf(GOLDEN[`claude-${version}`]!));
    }
  });

  it("a synthetic delivery lands different heads than expected", async () => {
    const at = home();
    const landed = await at.land(claudeConnector, deliver(at, CLAUDE_SOURCE, claudeFiles("first"), {}, T0));
    expect(landed).toMatchObject({ new: 5, refused: 0, duplicated: 0 });
    const landedHeads = at.heads(CLAUDE_SOURCE, KINDS);
    expect(landedHeads.map((head) => [head.kind, head.key, head.version])).toEqual(parityOf(GOLDEN["claude-first"]!).map((row) => [row.kind, row.key, row.id]));
    artifact(at.dir, "heads.json", { landed: counts(landed), heads: landedHeads });
  });

  it("an empty placeholder or a re-issued signature lands a gone or an unnamed change", async () => {
    const at = home();
    await at.land(claudeConnector, deliver(at, CLAUDE_SOURCE, claudeFiles("first"), {}, T0));
    const later = await at.land(claudeConnector, deliver(at, CLAUDE_SOURCE, claudeFiles("later"), {}, T0 + DAY));
    expect(later).toMatchObject({ gone: 0, new: 0, changed: 3, restated: 1, late: 0 });
    expect(later.changedPaths).toEqual({ "message.content[].signature": 1, name: 2, updated_at: 2 });
    expect(at.heads(CLAUDE_SOURCE, ["msg"])).toHaveLength(3);
    artifact(at.dir, "placeholder.json", counts(later));
  });

  it("an older export landing after a newer one moves a head", async () => {
    const at = home();
    await at.land(claudeConnector, deliver(at, CLAUDE_SOURCE, claudeFiles("later"), {}, T0 + DAY));
    const older = await at.land(claudeConnector, deliver(at, CLAUDE_SOURCE, claudeFiles("first"), {}, T0));
    expect(older).toMatchObject({ late: 3, new: 1, changed: 0 });
    artifact(at.dir, "older.json", counts(older));
  });

  it("a zip of the export missing, or its manifest absent, lands nothing of the rest, or a conversation in two of its files lands twice", async () => {
    const missing = home();
    expect(await missing.land(claudeConnector, deliver(missing, CLAUDE_SOURCE, claudeFiles("first", "data-0002.zip"), {}, T0))).toMatchObject({ new: 3, refused: 0 });
    const { "manifest-synthetic.json": _, ...unmanifested } = claudeFiles("first");
    const bare = home();
    expect(await bare.land(claudeConnector, deliver(bare, CLAUDE_SOURCE, unmanifested, {}, T0))).toMatchObject({ new: 5, refused: 0 });
    const twice = home();
    const extra = { ...claudeFiles("first"), "data-0003.zip": claudeFiles("first")["data-0002.zip"]! };
    const landed = await twice.land(claudeConnector, deliver(twice, CLAUDE_SOURCE, extra, {}, T0));
    expect(landed).toMatchObject({ new: 5, refused: 1 });
    expect(landed.refusals[0]!.violations[0]).toMatch(/is also in data-0002\.zip:conversations\.json; the export's files must be disjoint/u);
    artifact(twice.dir, "sample.json", counts(landed));
  });

  it("a conversation it cannot read, or an archive whose conversations do not read, refuses more than itself", async () => {
    const exported = claudeExport("first");
    const dir = temp();
    const zipped = (members: Files, method: "stored" | "deflate" = "deflate"): Buffer => {
      const path = join(dir, `${Object.keys(members).join("-")}-${method}.zip`);
      writeZip(path, Object.entries(members).map(([name, bytes]) => ({ name, bytes, method })));
      return readFileSync(path);
    };
    const second = exported.archives["data-0002.zip"]!["conversations.json"]!.toString();
    const otherAccount = zipped({ "conversations.json": Buffer.from(second.replace(`"uuid":"${CLAUDE_ACCOUNT}"`, '"uuid":"99999999-9999-4999-8999-999999999999"')) });
    const stored = zipped({ "conversations.json": Buffer.from(second) }, "stored");
    const badCrc = Buffer.from(stored);
    const at = badCrc.indexOf("Synthetic question.");
    badCrc[at] = "s".charCodeAt(0);
    const cases = { otherAccount, badCrc, notZip: Buffer.from("no archive at all") };
    const seen: Record<string, unknown> = {};
    for (const [name, archive] of Object.entries(cases)) {
      const scratch = home();
      const landed = await scratch.land(claudeConnector, deliver(scratch, CLAUDE_SOURCE, { ...claudeFiles("first"), "data-0002.zip": archive }, {}, T0));
      expect(landed, name).toMatchObject({ new: 3, refused: 1 });
      expect(landed.refusals[0]!.key, name).toBe({ otherAccount: "data-0002.zip:conversations.json:conversations[0]", badCrc: "data-0002.zip:conversations.json", notZip: "data-0002.zip" }[name]);
      expect(scratch.heads(CLAUDE_SOURCE, ["chat"]).map((head) => head.key), name).toEqual(["22222222-2222-4222-8222-222222222222"]);
      seen[name] = counts(landed);
    }
    artifact(home().dir, "refused.json", seen);
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const at = home();
    const exported = claudeExport("first");
    const dir = temp();
    const files: Files = { [exported.manifestName]: exported.manifest };
    for (const [name, members] of Object.entries(exported.archives)) {
      const conversations = JSON.parse(members["conversations.json"]!.toString()) as JsonObject[];
      const doubled = name === "data-0001.zip" ? [...conversations, conversations[0]!] : conversations;
      writeZip(join(dir, name), Object.entries({ ...members, "conversations.json": Buffer.from(JSON.stringify(doubled)) }).map(([member, bytes]) => ({ name: member, bytes })));
      files[name] = readFileSync(join(dir, name));
    }
    const landed = await at.land(claudeConnector, deliver(at, CLAUDE_SOURCE, files, {}, T0));
    expect(landed.duplicated).toBe(3);
    artifact(at.dir, "duplicated.json", counts(landed));
  });
});

describe("chatgpt export as an import", () => {
  it("its zip, or its unzipped folder, lands other heads or links other media than its files loose", async () => {
    const loose = home();
    await loose.land(chatgptConnector, deliver(loose, CHATGPT_SOURCE, chatgptExport("first"), {}, T0));
    const heads = (at: TestHome) => at.heads(CHATGPT_SOURCE, KINDS).map((head) => [head.kind, head.key, head.version]);
    for (const form of ["zip", "folder"] as const) {
      const [name, files] = [form, chatgptHanded("first", form)];
      const at = home();
      const delivery = deliver(at, CHATGPT_SOURCE, files, imported("chatgpt"), T0);
      const rows = await readStoring(chatgptConnector, delivery, at.blobs);
      expect(await at.land(chatgptConnector, delivery, rows), name).toMatchObject({ new: 8, refused: 0 });
      expect(heads(at), name).toEqual(heads(loose));
      const first = rows.find((row) => row.key.endsWith(":a0000000-0000-4000-8000-000000000001"))!;
      const looseBlob = (path: string) => at.blobs.put(chatgptExport("first")[path]!);
      expect(first.blobs, name).toEqual([looseBlob("file-AbC123-synthetic.png"), looseBlob("file_00aa11.dat")].sort());
    }
    artifact(loose.dir, "heads.json", heads(loose));
  });

  it("an export's account is other than its user.json states, its time other than its newest conversation's update, or two exports read as one", async () => {
    const at = home();
    const seen = await looked("chatgpt", deliver(at, "upload:local:macbook-pro-0001", chatgptHanded("first"), {}, T0), at.blobs);
    expect(seen.resolved).toEqual({ products: [{ id: "chatgpt", named: [CHATGPT_ACCOUNT] }] });
    expect(seen.stated).toEqual({ time_ms: 1754000300 * 1000 });
    expect(new Set(seen.listing.routes.map((route) => `${route.product}:${route.copy} ${route.connector}`))).toEqual(new Set(["chatgpt:export chatgpt-export"]));
    expect((await looked("chatgpt", deliver(at, "upload:local:macbook-pro-0001", inFolder(chatgptExport("later"), "later"), {}, T0), at.blobs)).stated).toEqual({ time_ms: 1754100200 * 1000 });
    const both = { ...inFolder(chatgptExport("first"), "a"), ...inFolder(chatgptExport("later"), "b") };
    expect((await looked("chatgpt", deliver(at, "upload:local:macbook-pro-0001", both, {}, T0), at.blobs)).stated).toEqual({ refused: "This ChatGPT export holds 2 user.json: one export at a time" });
    artifact(at.dir, "looked.json", seen);
  });

  it("a zip holding media no conversation names is let go, or one read whole is kept", async () => {
    const at = home();
    const read = async (files: Files) => consumedOf(await readStoring(chatgptConnector, deliver(at, CHATGPT_SOURCE, files, imported("chatgpt"), T0), at.blobs));
    expect(await read(chatgptHanded("first"))).toEqual(["chatgpt-export.zip"]);
    expect(await read(chatgptHanded("first", "zip", { "file-Unnamed01-photo.png": Buffer.from("synthetic png bytes, named by none") }))).toEqual([]);
    expect(await read(chatgptHanded("first", "folder"))).toEqual(["chatgpt-export"]);
  });

  it("a ZIP attachment in its unzipped folder is opened as an archive in its place, left unlinked, and the folder let go with it unread", async () => {
    const upload = zipped({ "notes.bin": Buffer.from("synthetic attachment bytes") }, "inner.zip")["inner.zip"]!;
    for (const form of ["zip", "folder"] as const) {
      const at = home();
      const rows = await readStoring(chatgptConnector, deliver(at, CHATGPT_SOURCE, chatgptHanded("first", form, { "file-Missing1-upload.zip": upload }), imported("chatgpt"), T0), at.blobs);
      const first = rows.find((row) => row.key.endsWith(":a0000000-0000-4000-8000-000000000001"))!;
      expect([first.blobs?.includes(at.blobs.put(upload)), consumedOf(rows)], form).toEqual([true, [form === "zip" ? "chatgpt-export.zip" : "chatgpt-export"]]);
    }
  });
});

describe("claude export as an import", () => {
  it("its one zip, or its unzipped folder, lands other heads than the manifest's archives", async () => {
    const manifest = home();
    await manifest.land(claudeConnector, deliver(manifest, CLAUDE_SOURCE, claudeFiles("first"), {}, T0));
    const heads = (at: TestHome) => at.heads(CLAUDE_SOURCE, KINDS).map((head) => [head.kind, head.key, head.version]);
    for (const form of ["zip", "folder"] as const) {
      const [name, files] = [form, claudeHanded("first", form)];
      const at = home();
      expect(await at.land(claudeConnector, deliver(at, CLAUDE_SOURCE, files, imported("claude"), T0)), name).toMatchObject({ new: 5, refused: 0 });
      expect(heads(at), name).toEqual(heads(manifest));
    }
    artifact(manifest.dir, "heads.json", heads(manifest));
  });

  it("an export's account is other than its users.json names, else its first conversation's, or its time other than its manifest's, else its newest conversation's update", async () => {
    const at = home();
    const look = (files: Files) => looked("claude", deliver(at, "upload:local:macbook-pro-0001", files, {}, T0), at.blobs);
    const one = await look(claudeHanded("first"));
    expect(one.resolved).toEqual({ products: [{ id: "claude", named: [CLAUDE_ACCOUNT] }] });
    expect(one.stated).toEqual({ time_ms: Date.UTC(2026, 7, 31, 10, 1) });
    expect((await look({ "data-0002.zip": claudeFiles("first")["data-0002.zip"]! })).resolved).toEqual({ products: [{ id: "claude", named: [CLAUDE_ACCOUNT] }] });
    expect((await look(claudeFiles("later"))).stated).toEqual({ time_ms: Date.UTC(2026, 8, 3, 11) });
    expect((await look({ "users.json": claudeOffered("first")["users.json"]! })).stated).toEqual({ time_ms: null });
    artifact(at.dir, "looked.json", one);
  });

  it("another account's users.json is read, or a file read whole is kept", async () => {
    const at = home();
    const theirs = { ...claudeOffered("first"), "users.json": Buffer.from(JSON.stringify([{ uuid: "99999999-9999-4999-8999-999999999999", email_address: "person-b@example.com" }])) };
    await expect(at.land(claudeConnector, deliver(at, CLAUDE_SOURCE, zipped(theirs, "data-batch-0000.zip"), imported("claude"), T0))).rejects.toThrow(/users\.json states 99999999-9999-4999-8999-999999999999; the source is claude:/u);
    expect(at.heads(CLAUDE_SOURCE, KINDS)).toEqual([]);
    const rows = await collect(claudeConnector.read(deliver(at, CLAUDE_SOURCE, claudeHanded("first"), imported("claude"), T0), at.blobs));
    expect(consumedOf(rows)).toEqual(["data-batch-0000.zip"]);
  });
});
