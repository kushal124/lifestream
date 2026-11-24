import { readFileSync } from "node:fs";
import { CONSUMED } from "@lifestreamprotocol/core";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shapeFaults } from "../admit.js";
import { withRoadDefaults, type Connector } from "../declaration.js";
import { declarations, providers } from "../index.js";
import { PHONE_SOURCE } from "../messages/whatsapp/whatsapp.test-support.js";
import type { Reader } from "../seams.js";
import { fileMember } from "../shared/members.js";
import { isPattern, matches } from "../shared/patterns.js";
import { refuse } from "../shared/refused.js";
import { collect, deliver, openTestHome, temp, writeZip } from "../test/drive.js";
import { importKinds, iphoneBackup, isOfKind, leftOnly, listImport, recognisedKind, sourceOf, type ImportKind } from "./index.js";
import { backupJson, NOT_A_BACKUP, whatsappAccount } from "./iphone-backup/import.js";
import { BACKUP, backupJsonText, writeBackupFolders } from "./iphone-backup/test/fixture.js";

const CASES = JSON.parse(readFileSync(new URL("./iphone-backup/test/backup-json.json", import.meta.url), "utf8")) as {
  valid: { case: string; backup: Record<string, unknown> & { store: string }; text: string; named: string[]; stamp: string; time_ms: number }[];
  refused: { case: string; backup: unknown }[];
};
const TABLE = JSON.parse(readFileSync(new URL("../test/patterns.json", import.meta.url), "utf8")) as { rows: { pattern: string; path: string; matches: boolean }[] };
const release = () => importKinds(declarations(), providers().flatMap((provider) => provider.readers));

const example: Connector = withRoadDefaults({
  id: "example-export", product: "example", name: "Example", vendor: "example", records: "Every note.",
  sources: [{ id: "example:<account>:export", read: "example-export", arrives: "upload" }],
  export: { recognise: ["**/notes*.json"], guide: [{ words: "Download it." }], leaves: ["**/*.pdf"] },
});
const reader = (rest: Partial<Reader>): Reader => ({ name: "example-export", kinds: {}, read: async function* () {}, ...rest });
const kindOf = (rest: Partial<Reader>): ImportKind => importKinds([example], [reader(rest)])[0]!;

function members(files: Readonly<Record<string, string>>) {
  const home = openTestHome();
  const delivery = deliver(home, "example:test", Object.fromEntries(Object.entries(files).map(([path, text]) => [path, Buffer.from(text)])), {}, 0);
  return delivery.files.map((file) => fileMember(home.blobs, file));
}

describe("import kinds: each of these is impossible", () => {
  it("the release makes a kind it does not declare, leaves one out, or words one otherwise than its declaration", () => {
    expect(release().map((kind) => [kind.id, kind.name, kind.vendor, kind.reads.map((read) => `${read.product}:${read.copy} ${read.connector}`)[0]])).toEqual([
      ["google-takeout", "Google Takeout", "google", expect.any(String)],
      ["iphone-backup", "iPhone backup", "apple", expect.any(String)],
      ["chatgpt", "ChatGPT export", "openai", "chatgpt:export chatgpt-export"],
      ["claude", "Claude export", "anthropic", "claude:cloud claude-export"],
      ["google-timeline", "Google Maps Timeline", "google", "google-timeline:export google-timeline"],
      ["spotify", "Spotify", "spotify", "spotify:export spotify-export"],
    ]);
    const spotify = release().find((kind) => kind.id === "spotify")!;
    expect([spotify.takes, spotify.wait, spotify.file, spotify.ask, spotify.recognise, spotify.leaves, spotify.guide[0]!.title, spotify.guide[0]!.open]).toEqual([
      "Spotify takes up to 30 days", "Up to 30 days", "zip", "Whose Spotify is this?", ["**/Streaming_History_*.json"], ["**/ReadMeFirst_*.pdf"], "Ask Spotify",
      { label: "Open Spotify’s Privacy page", url: "https://www.spotify.com/account/privacy/" },
    ]);
    expect(release().some((kind) => ["x", "facebook", "instagram", "imessage", "whatsapp", "apple-calls", "gmail"].includes(kind.id))).toBe(false);
  });

  it("a file of one kind is taken for another's", () => {
    const kind = (id: string) => release().find((each) => each.id === id)!;
    const spotify = ["my_spotify_data/Spotify Extended Streaming History/Streaming_History_Audio_2024.json", "my_spotify_data/ReadMeFirst_ExtendedStreamingHistory.pdf"];
    const chatgpt = ["user.json", "conversations.json", "chat.html", "file-0001.jpg"];
    expect([isOfKind(kind("spotify"), spotify), isOfKind(kind("chatgpt"), spotify), isOfKind(kind("google-takeout"), spotify)]).toEqual([true, false, false]);
    expect([isOfKind(kind("chatgpt"), chatgpt), isOfKind(kind("spotify"), chatgpt)]).toEqual([true, false]);
    expect(isOfKind(kind("google-takeout"), ["takeout-20261027T103000Z-001/Takeout/Mail/All mail Including Spam and Trash.mbox"])).toBe(true);
  });

  it("a file handed in is taken for a kind its members are not, for none when one claims them, or for one that claims fewer than another", async () => {
    const home = openTestHome();
    const handed = (name: string, bytes: Buffer) => {
      const [file] = deliver(home, "upload:local:test", { [name]: bytes }, {}, 0).files;
      return { name, blob: file!.blob, size: file!.size };
    };
    const zipOf = (members: Readonly<Record<string, string>>): Buffer => {
      const path = join(temp("handed-zip-"), "handed.zip");
      writeZip(path, Object.entries(members).map(([name, text]) => ({ name, bytes: Buffer.from(text), method: "deflate" as const })));
      return readFileSync(path);
    };
    const kindIn = async (name: string, bytes: Buffer) => (await recognisedKind(release(), handed(name, bytes), home.blobs))?.id ?? null;
    expect(await kindIn("my_spotify_data.zip", zipOf({ "Spotify Extended Streaming History/Streaming_History_Audio_2025.json": "[]", "Spotify Extended Streaming History/ReadMeFirst_ExtendedStreamingHistory.pdf": "%PDF" }))).toBe("spotify");
    expect(await kindIn("renamed.bin", zipOf({ "Spotify Extended Streaming History/Streaming_History_Audio_2025.json": "[]" }))).toBe("spotify");
    expect(await kindIn("Streaming_History_Audio_2025.json", Buffer.from("[]"))).toBe("spotify");
    expect(await kindIn("chatgpt-export.zip", zipOf({ "user.json": "{}", "conversations.json": "[]", "chat.html": "<html></html>" }))).toBe("chatgpt");
    expect(await kindIn("takeout-20261027T103000Z-001.zip", zipOf({ "Takeout/Mail/All mail Including Spam and Trash.mbox": "From synthetic" }))).toBe("google-takeout");
    expect(await kindIn("photos.zip", zipOf({ "IMG_0001.jpg": "synthetic", "notes.txt": "synthetic" }))).toBeNull();
    expect(await kindIn("notes.txt", Buffer.from("a synthetic note"))).toBeNull();
    expect(await kindIn("broken.zip", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not the rest of a zip")]))).toBeNull();
    expect(await kindIn("data-0001.zip", zipOf({ "users.json": "[]", "conversations.json": "[]", "projects/synthetic-project/project.json": "{}" }))).toBe("claude");
    expect(await kindIn("light.zip", zipOf({ "users.json": "[]", "login_history.json": "[]" }))).toBeNull();
    expect(await kindIn("location-history.json", Buffer.from("[]"))).toBe("google-timeline");
    expect(await kindIn("account-data.zip", zipOf({ "Userdata.json": "{}", "Payments.json": "[]" }))).toBeNull();
  });

  it("a Claude file holding only what its kind leaves (its light zip) is taken as one to read, or one holding conversations as one to leave", () => {
    const claude = release().find((each) => each.id === "claude")!;
    const batch = ["users.json", "memories.json", "projects/synthetic-project/project.json", "design_chats/synthetic-design.json", "conversations.json"];
    const conversations = ["conversations.json"];
    const light = ["users.json", "login_history.json"];
    expect([batch, conversations, light].map((names) => [isOfKind(claude, names), leftOnly(claude, names)])).toEqual([[true, false], [true, false], [false, true]]);
    expect([isOfKind(claude, ["notes.txt"]), leftOnly(claude, ["notes.txt"])]).toEqual([false, false]);
  });

  it("an own export's account is read otherwise than its reader's rule says, or a refusal is not the import's in its words", async () => {
    const rule = { file: "account.json", json: (json: unknown) => ((json as { email?: string }).email ?? refuse("that is not Example's download")) };
    const kind = kindOf({ account: rule });
    expect(await kind.resolve(members({ "dl/account.json": '{"email":"Person-A@Example.com"}', "dl/notes.json": "[]" }))).toEqual({ products: [{ id: "example", named: ["person-a@example.com"] }] });
    expect(await kind.resolve(members({ "dl/account.json": "{}", "dl/notes.json": "[]" }))).toEqual({ refused: "that is not Example's download" });
    expect(await kind.resolve(members({ "dl/account.json": '{"email":"a b"}', "dl/notes.json": "[]" }))).toEqual({ refused: 'the account "a b" cannot name a source: no colon, slash, backslash, space or NUL' });
    expect(await kindOf({}).resolve(members({ "dl/notes.json": "[]" }))).toEqual({ products: [{ id: "example", named: [] }] });
    expect(await kind.resolve(members({ "dl/other.txt": "x" }))).toEqual({ products: [] });
  });

  it("an own export's account is read whole where its rule reads only a value at a path, or a CSV's row past the one that answers", async () => {
    const at = kindOf({ account: { file: "result.json", at: "personal_information", json: (info) => (info as { username?: string }).username } });
    expect(await at.resolve(members({ "result.json": '{"personal_information":{"username":"person-a"},"chats":[]}', "notes.json": "[]" }))).toEqual({ products: [{ id: "example", named: ["person-a"] }] });
    const row = kindOf({ account: { file: "profile.csv", row: (fields) => fields.Username } });
    expect(await row.resolve(members({ "profile.csv": "Date Joined,Username\r\n2020-01-01,person-a\r\n", "notes.json": "[]" }))).toEqual({ products: [{ id: "example", named: ["person-a"] }] });
    const text = kindOf({ account: { file: "account.txt", text: (words) => words.trim() } });
    expect(await text.resolve(members({ "account.txt": "person-a\n", "notes.json": "[]" }))).toEqual({ products: [{ id: "example", named: ["person-a"] }] });
  });

  it("an own export's time is a file's own where its reader states none, or a refusal of its anchor is not the import's", async () => {
    const held = members({ "notes.json": "[]" });
    expect(await kindOf({}).states("notes.zip", held, null)).toEqual({ time_ms: null });
    const anchored = kindOf({
      states: async (_members, anchor) => (anchor !== null && anchor !== "first-play" ? refuse("This history is another account's") : { time_ms: 42, anchor: "first-play" }),
    });
    expect(await anchored.states("notes.zip", held, null)).toEqual({ time_ms: 42, anchor: "first-play" });
    expect(await anchored.states("notes.zip", held, "first-play")).toEqual({ time_ms: 42, anchor: "first-play" });
    expect(await anchored.states("notes.zip", held, "other")).toEqual({ refused: "This history is another account's" });
    expect(await anchored.stamp("notes.zip", held)).toBeNull();
  });

  it("a connector's own export feeds no source, or is a kind of another id, name or product", () => {
    const kind = kindOf({});
    expect([kind.id, kind.name, kind.leaves, kind.products, kind.reads]).toEqual([
      "example-export", "Example", ["**/*.pdf"], [{ id: "example", name: "Example" }],
      [{ of: "example", members: "**/notes*.json", product: "example", copy: "export", connector: "example-export" }],
    ]);
    expect(() => importKinds([{ ...example, sources: [{ id: "example:<account>:browser", read: "example-export", arrives: "chrome" }] }], [])).toThrow(/no source on the upload road/u);
  });
});

describe("member patterns: each of these is impossible", () => {
  it("connect's matcher disagrees with a row of the table the Mac's reads too", () => {
    for (const row of TABLE.rows) expect([row.pattern, row.path, matches(row.pattern, row.path)]).toEqual([row.pattern, row.path, row.matches]);
  });

  it("a declared pattern is no pattern, or one that is not is taken", () => {
    for (const connector of declarations()) for (const pattern of connector.export?.recognise ?? []) expect([connector.id, pattern, isPattern(pattern)]).toEqual([connector.id, pattern, true]);
    for (const bad of ["", "/a.json", "a//b", "../a.json", "a/**b/c", "a\\b"]) expect([bad, isPattern(bad)]).toEqual([bad, false]);
  });
});

function folderMembers(paths: Readonly<Record<string, Buffer | string>>) {
  const home = openTestHome();
  const delivery = deliver(home, "iphone-backup:test", paths, {}, 0);
  return { home, delivery, members: delivery.files.map((file) => fileMember(home.blobs, file)) };
}
const holding = (text: string, at = "imessage/backup.json") => folderMembers({ [at]: Buffer.from(text) }).members;
const backupKind = () => release().find((kind) => kind.id === "iphone-backup")!;

describe("the iPhone backup's kind: each of these is impossible", () => {
  it("a backup.json the shared cases call valid is refused, words otherwise, or names, stamps or times otherwise than they say", async () => {
    const kind = backupKind();
    for (const valid of CASES.valid) {
      expect([valid.case, backupJson(valid.backup)]).toEqual([valid.case, valid.backup]);
      expect([valid.case, backupJsonText(valid.backup as never)]).toEqual([valid.case, valid.text]);
      expect(Object.keys(valid.backup).every((key) => ["accounts", "device", "encrypted", "ios", "last_backup", "model", "model_name", "serial4", "store"].includes(key))).toBe(true);
      const members = holding(valid.text, `${valid.backup.store}/backup.json`);
      expect([valid.case, await iphoneBackup.named(members)]).toEqual([valid.case, { named: valid.named }]);
      expect([valid.case, await kind.stamp(`${valid.backup.store}`, members), await kind.states(`${valid.backup.store}`, members, null)]).toEqual([valid.case, valid.stamp, { time_ms: valid.time_ms }]);
    }
  });

  it("a backup.json the shared cases refuse is read, or refuses otherwise than its folder whole in the person's words", async () => {
    const kind = backupKind();
    for (const refused of CASES.refused) {
      expect([refused.case, "refused" in backupJson(refused.backup)]).toEqual([refused.case, true]);
      const members = holding(JSON.stringify(refused.backup));
      expect([refused.case, await kind.resolve(members), await kind.stamp("imessage", members), await kind.device(members)]).toEqual([refused.case, { refused: NOT_A_BACKUP }, null, null]);
      expect([refused.case, await kind.states("imessage", members, null)]).toEqual([refused.case, { refused: NOT_A_BACKUP }]);
    }
  });

  it("a folder with no backup.json, two, one outside its store's folder, or one that is no JSON is read", async () => {
    const kind = backupKind();
    const text = backupJsonText({ ...BACKUP, store: "imessage" });
    const folders = [
      folderMembers({ "imessage/messages.db": Buffer.from("x") }).members,
      folderMembers({ "imessage/backup.json": Buffer.from(text), "whatsapp/backup.json": Buffer.from(text) }).members,
      holding(text, "whatsapp/backup.json"),
      holding(text, "my-imessage/backup.json"),
      holding("{not json"),
    ];
    for (const members of folders) expect(await kind.resolve(members)).toEqual({ refused: NOT_A_BACKUP });
    expect(await kind.resolve(holding(text, "a/b/imessage/backup.json"))).toEqual({ products: [] });
  });

  it("a WhatsApp JID is made an account otherwise than the WhatsApp source names its own, or a store naming two Apple IDs is taken as one", async () => {
    const kind = backupKind();
    for (const valid of CASES.valid.filter((each) => each.backup.store === "whatsapp")) {
      const jids = (valid.backup.accounts as { whatsapp: string[] }).whatsapp;
      expect(valid.named).toEqual(jids.map((jid) => whatsappAccount(jid)));
    }
    expect(`whatsapp:${whatsappAccount(BACKUP.accounts.whatsapp[0]!)}`).toBe(PHONE_SOURCE.slice(0, PHONE_SOURCE.lastIndexOf(":")));
    const dir = temp("backup-kind-");
    const two = writeBackupFolders(dir, { accounts: { apple: ["person-a@example.com", "person-b@example.com"], whatsapp: [] } });
    const resolved = await kind.resolve(folderMembers(prefixed("imessage", two.members.imessage)).members);
    expect(resolved).toEqual({ products: [{ id: "imessage", named: ["person-a@example.com", "person-b@example.com"] }] });
    expect(await kind.resolve(folderMembers(prefixed("whatsapp", two.members.whatsapp)).members)).toEqual({ products: [{ id: "whatsapp", named: [] }] });
  });

  it("an answer for Apple is carried to the WhatsApp import of the same backup, or iMessage and calls of one backup are two imports", async () => {
    const kind = backupKind();
    const { members } = writeBackupFolders(temp("backup-kind-"));
    const stamp = async (store: "imessage" | "whatsapp" | "apple-calls") => kind.stamp(store, folderMembers(prefixed(store, members[store])).members);
    expect([await stamp("imessage"), await stamp("apple-calls"), await stamp("whatsapp")]).toEqual([
      "3f9c0d1e2a4b5c6d:2026-08-28T09:12:44Z:apple", "3f9c0d1e2a4b5c6d:2026-08-28T09:12:44Z:apple", "3f9c0d1e2a4b5c6d:2026-08-28T09:12:44Z:whatsapp",
    ]);
    const later = writeBackupFolders(temp("backup-kind-"), { last_backup: "2026-09-28T21:00:05Z" });
    const held = folderMembers(prefixed("imessage", later.members.imessage)).members;
    expect([await kind.stamp("imessage", held), await kind.states("imessage", held, null)]).toEqual(["3f9c0d1e2a4b5c6d:2026-09-28T21:00:05Z:apple", { time_ms: Date.UTC(2026, 8, 28, 21, 0, 5) }]);
  });

  it("a backup's rows feed a source of another copy than the phone's unit, or a source with no unit at all", () => {
    const kind = backupKind();
    const unit = "iphone-17-pro-a1b2";
    expect(kind.reads.map((read) => [read.members, sourceOf(read, read.product === "whatsapp" ? "15550000001" : "person-a@example.com", unit), read.connector])).toEqual([
      ["**/imessage/messages.db", `imessage:person-a@example.com:${unit}`, "imessage-db"],
      ["**/imessage/attachments.json", `imessage:person-a@example.com:${unit}`, "imessage-db"],
      ["**/whatsapp/chats.sqlite", `whatsapp:15550000001:${unit}`, "whatsapp-db"],
      ["**/whatsapp/calls.sqlite", `whatsapp:15550000001:${unit}`, "whatsapp-db"],
      ["**/whatsapp/media.json", `whatsapp:15550000001:${unit}`, "whatsapp-db"],
      ["**/apple-calls/callhistory.sqlite", `apple-calls:person-a@example.com:${unit}`, "callhistory-mac"],
    ].sort((left, right) => kind.reads.findIndex((read) => read.members === left[0]) - kind.reads.findIndex((read) => read.members === right[0])));
    expect(() => sourceOf(kind.reads[0]!, "person-a@example.com")).toThrow(/feeds the unit of the device/u);
    const takeout = release().find((each) => each.id === "google-takeout")!;
    expect(sourceOf(takeout.reads[0]!, "person-a@example.com", unit)).not.toContain(unit);
  });

  it("a rootless kind of three products is taken for a connector's own export, asks of one company, or leaves its folders as nothing read", async () => {
    const kind = backupKind();
    expect([kind.root, kind.leaves, kind.products]).toEqual([undefined, [], [
      { id: "apple-calls", name: "Calls", noun: ["call", "calls"] },
      { id: "imessage", name: "iMessage", noun: ["message", "messages"] },
      { id: "whatsapp", name: "WhatsApp", noun: ["message", "messages"] },
    ]]);
    expect(["imessage", "apple-calls", "whatsapp"].map((product) => kind.whose(product))).toEqual([
      { vendor: "apple", ask: "Whose Apple ID is on this iPhone?" }, { vendor: "apple", ask: "Whose Apple ID is on this iPhone?" },
      { vendor: "meta", ask: "Whose WhatsApp is on this iPhone?" },
    ]);
    expect(release().find((each) => each.id === "google-takeout")!.whose("mail")).toEqual({ vendor: "google", ask: "Whose Google account is this?" });
    const { members } = writeBackupFolders(temp("backup-kind-"));
    const files = { ...prefixed("imessage", members.imessage), ...prefixed("whatsapp", members.whatsapp), ...prefixed("apple-calls", members["apple-calls"]) };
    for (const store of ["imessage", "whatsapp", "apple-calls"] as const) {
      const names = Object.keys(prefixed(store, members[store]));
      expect([store, isOfKind(kind, names), leftOnly(kind, names)]).toEqual([store, true, false]);
    }
    const { home, delivery } = folderMembers(files);
    const { listing } = await listImport(kind, delivery, home.blobs);
    expect(listing.files.map((file) => [file.path, file.unclaimed ?? 0, file.refused ?? null])).toEqual([["apple-calls", 0, null], ["imessage", 0, null], ["whatsapp", 0, null]]);
    expect(listing.products.map((product) => [product.id, product.files])).toEqual([["apple-calls", ["apple-calls"]], ["imessage", ["imessage"]], ["whatsapp", ["whatsapp"]]]);
    expect(listing.routes.map((route) => [route.members, route.copy, route.files])).toEqual(kind.reads.map((read) => [read.members, "<unit>", [read.members.split("/")[1]]]));
  });

  it("a backup states another phone than its own, or names the phone by its hardware id or serial", async () => {
    const kind = backupKind();
    const { members } = writeBackupFolders(temp("backup-kind-"));
    const accounts = [BACKUP.accounts.apple[0]!, BACKUP.accounts.whatsapp[0]!.split("@")[0]!].sort();
    for (const store of ["imessage", "whatsapp", "apple-calls"] as const) {
      expect(await kind.device(folderMembers(prefixed(store, members[store])).members)).toEqual({ device: "3f9c0d1e2a4b5c6d", accounts, model: "iPhone18,1", model_name: "iPhone 17 Pro", serial4: "c0de" });
    }
    const unserialed = writeBackupFolders(temp("backup-kind-"), { serial4: undefined });
    expect((await kind.device(folderMembers(prefixed("imessage", unserialed.members.imessage)).members))?.serial4).toBeNull();
    expect(await release().find((each) => each.id === "spotify")!.device([])).toBeNull();
  });

  it("the fixture's folders hold what a reader does not read, a reader reads its folder on the import road otherwise than a Mac's store, or leaves the folder held", async () => {
    const readers = new Map(providers().flatMap((provider) => provider.readers).map((reader) => [reader.name, reader]));
    const kind = backupKind();
    const unit = "iphone-17-pro-a1b2";
    const read = async (store: "imessage" | "whatsapp" | "apple-calls", account: string) => {
      const routes = kind.reads.filter((each) => each.members.startsWith(`**/${store}/`));
      const { members } = writeBackupFolders(temp("backup-kind-"));
      const own = Object.fromEntries(Object.entries(writeBackupFolders(temp("backup-kind-")).members[store]).filter(([name]) => name !== "backup.json"));
      expect(Object.keys(own).map((name) => routes.some((route) => matches(route.members, `${store}/${name}`)))).toEqual(Object.keys(own).map(() => true));
      const home = openTestHome();
      const reader = readers.get(routes[0]!.connector)!;
      const source = sourceOf(routes[0]!, account, unit);
      const imported = await collect(reader.read(deliver(home, source, prefixed(store, members[store]), { import: { kind: kind.id, id: "import-0001" } }, Date.UTC(2026, 7, 28)), home.blobs));
      const bundled = await collect(reader.read(deliver(home, source, own, {}, Date.UTC(2026, 7, 28)), home.blobs));
      const stated = imported.filter((row) => row.kind !== CONSUMED);
      expect(stated).toEqual(bundled);
      return {
        refused: imported.filter((row) => row.refused !== undefined).map((row) => row.refused),
        kinds: [...new Set(stated.map((row) => row.kind))].sort(),
        consumed: imported.filter((row) => row.kind === CONSUMED).map((row) => row.key),
      };
    };
    expect(await read("imessage", "person-a@example.com")).toEqual({ refused: [], kinds: ["chat", "chat-state", "msg"], consumed: ["imessage"] });
    expect(await read("whatsapp", "15550000001")).toEqual({ refused: [], kinds: ["call", "chat", "msg", "pushname"], consumed: ["whatsapp"] });
    expect(await read("apple-calls", "person-a@example.com")).toEqual({ refused: [], kinds: ["call"], consumed: ["apple-calls"] });
  });

  it("a connector names a kind the release does not declare, or a kind with a root, and is admitted", () => {
    const declared = declarations().find((connector) => connector.id === "apple-calls")!;
    const faults = (kind: string) => shapeFaults({ ...declared, export: { ...declared.export!, kind } });
    expect(faults("iphone-backup")).toEqual([]);
    expect(faults("google-takeout").map(([member]) => member)).toEqual(["export.kind"]);
    expect(faults("nokia-backup").map(([member]) => member)).toEqual(["export.kind"]);
  });
});

function prefixed(store: string, members: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(members).map(([name, path]) => [`${store}/${name}`, path]));
}
