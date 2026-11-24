import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cameras as camerasConnect, faces as facesConnect, type Connector } from "@lifestreamprotocol/connect";
import { digest, openHomeFolder, openMemo, type Adapters, type Json, type LineAdapter, type MailAdapter, type MessagesAdapter, type PhotosAdapter, type ScreenAdapter, type SourceRow } from "@lifestreamprotocol/core";
import { made, plainFamily, type Family } from "@lifestreamprotocol/families";
import { familyFingerprint, FINGERPRINT_PARTS, fingerprintParts, labelerFingerprint } from "./due.js";
import { families, fedBy, type FolderAdapters } from "./registry-home.js";
import { textFamilies, textsOf } from "./search.js";
import { effective } from "./settings.js";
import { writeFolder } from "./test/folder.js";

const { camerasLabeler } = camerasConnect;
const { facesLabeler } = facesConnect;

const DIR = mkdtempSync(join(tmpdir(), "lifestream-families-seam-"));
writeFolder(DIR);
const SETTINGS = effective(DIR).settings;
const compared: Record<string, unknown> = {};

afterAll(() => {
  writeFileSync(join(DIR, "families-seam.json"), `${JSON.stringify(compared, null, 2)}\n`);
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(DIR, { recursive: true, force: true });
});

function declared(id: string, type: Connector["type"], name = id): Connector {
  return { id, product: id, name, vendor: "example", type, records: "Synthetic records.", sources: [{ id: `${id}:local:<home>`, read: `${id}-rows`, arrives: "poll" }] } as Connector;
}

const line = (version = "1", kinds: readonly string[] = ["line"]): LineAdapter => ({ version, kinds, line: () => null });
const chat = (version = "1"): MessagesAdapter => ({ version, kinds: ["msg"], message: () => null, group: () => false, members: (id) => [{ id, kind: "network" }] });
const mailbox = (version = "1"): MailAdapter => ({ version, kinds: ["mailmsg"], mail: () => null });
const library = (version = "1"): PhotosAdapter => ({ version, kinds: ["img"], rank: () => 10, copy: () => null, files: () => [], image: () => null, placedBy: () => null, position: () => null });
const recorder = (version = "1"): ScreenAdapter => ({ version, kinds: ["frame"], role: "frames" });

const log = (digest = "sha256:folder-a", adapter = line()): FolderAdapters => ({ connectors: [declared("example-log", "notes")], adapters: { "example-log": { line: adapter } }, digest });
const network = (adapter = chat()): FolderAdapters => ({ connectors: [declared("example-chat", "messages")], adapters: { "example-chat": { messages: adapter } } });

function prints(folders: readonly FolderAdapters[], list: readonly Family[] = families(SETTINGS, DIR, folders)): Record<string, string> {
  return Object.fromEntries(list.map((family) => [family.name, familyFingerprint(family, SETTINGS.day)]));
}

function walked(name: string, before: Record<string, string>, after: Record<string, string>): string[] {
  const names = Object.keys(before).filter((family) => before[family] !== after[family]).sort();
  compared[name] = { walked: names, before, after };
  return names;
}

describe("the families' seam", () => {
  it("a family is handed an adapter registered for another family, or one of a connector its folder does not hold", () => {
    const stray: FolderAdapters = { connectors: [declared("example-other", "notes")], adapters: { "example-gone": { line: line() } as Adapters } };
    const built = families(SETTINGS, DIR, [network(), log(), stray]);
    const handed = Object.fromEntries(built.map((family) => [family.name, (family.adapters ?? []).map((given) => `${given.product} ${given.name} ${given.type} ${given.digest ?? "release"}`)]));
    expect(handed).toEqual({
      ...Object.fromEntries(built.map((family) => [family.name, []])),
      messages: ["example-chat example-chat messages release"],
      plain: ["example-log example-log notes sha256:folder-a"],
    });
    expect(built.find((family) => family.name === "plain")!.inputs).toEqual([{ sources: { product: ["example-log"] }, kinds: ["line"], role: "evidence" }]);
    expect(Object.keys(fedBy([])).sort()).toEqual(Object.keys(handed).map((name) => (name === "plain" ? "line" : name)).sort());
  });

  it("a connector installed or removed walks a family it has no adapter of, or misses one it has", () => {
    const without = prints([network()]);
    const withLog = prints([network(), log()]);
    expect(walked("installed", without, withLog)).toEqual(["plain"]);
    expect(walked("removed", withLog, without)).toEqual(["plain"]);
    expect(walked("network installed", prints([log()]), withLog)).toEqual(["calls", "labels", "messages"]);
  });

  it("a connector that does not load leaves its families as they were", () => {
    expect(walked("failed to load", prints([network(), log()]), prints([network()]))).toEqual(["plain"]);
  });

  it("a home connector's folder edited walks no family it feeds, or one it does not", () => {
    expect(walked("folder edited", prints([network(), log("sha256:folder-a")]), prints([network(), log("sha256:folder-b")]))).toEqual(["plain"]);
  });

  it("a release that bumps an adapter's version, or changes the kinds it reads, walks no family, or another family", () => {
    expect(walked("version bumped", prints([network(chat("1")), log()]), prints([network(chat("2")), log()]))).toEqual(["calls", "labels", "messages"]);
    expect(walked("kinds changed", prints([log(undefined, line("1", ["line"]))]), prints([log(undefined, line("1", ["line", "entry"]))]))).toEqual(["plain"]);
  });

  it("a word a line prints, or a connector's vendor, changed with no version moved walks no family, or another", () => {
    const tasks = (word: string, vendor = "example"): FolderAdapters => ({
      connectors: [{ ...declared("example-tasks", "plans"), vendor }],
      adapters: { "example-tasks": { calendar: { version: "1", kinds: ["reminder"], authority: "own", keys: "name", units: "account", reminderWord: word, reminder: () => null, words: () => null } } },
      digest: "sha256:folder-a",
    });
    expect(walked("reminder word", prints([network(), tasks("Task")]), prints([network(), tasks("To-do")]))).toEqual(["calendar"]);
    expect(walked("vendor", prints([network(), tasks("Task")]), prints([network(), tasks("Task", "acme")]))).toEqual(["calendar"]);
  });

  it("an adapter holding a cyclic helper stops a start, or what an adapter holds beside its contract walks a family", () => {
    const helped = (cache: string): LineAdapter => {
      const adapter = { ...line(), helper: { cache, owner: undefined as unknown } };
      adapter.helper.owner = adapter;
      return adapter;
    };
    expect(() => prints([log(undefined, helped("empty"))])).not.toThrow();
    expect(walked("helper state", prints([log(undefined, helped("empty"))]), prints([log(undefined, helped("filled"))]))).toEqual([]);
    expect(walked("helped version", prints([log(undefined, helped("empty"))]), prints([log(undefined, { ...helped("empty"), version: "2" })]))).toEqual(["plain"]);
  });

  it("an adapter another family reads changed walks no family that reads it", () => {
    const folder = (id: string, type: Connector["type"], adapters: Adapters): FolderAdapters => ({ connectors: [declared(id, type)], adapters: { [id]: adapters } });
    expect(walked("mail bumped", prints([folder("example-mail", "mail", { mail: mailbox("1") })]), prints([folder("example-mail", "mail", { mail: mailbox("2") })])))
      .toEqual(["labels", "mail"]);
    expect(walked("photos bumped", prints([folder("example-photos", "photos", { photos: library("1") })]), prints([folder("example-photos", "photos", { photos: library("2") })])))
      .toEqual(["photos", "physical"]);
    expect(walked("screen bumped", prints([folder("example-recorder", "device-activity", { screen: recorder("1") })]), prints([folder("example-recorder", "device-activity", { screen: recorder("2") })])))
      .toEqual(["screen", "web"]);
    const built = families(SETTINGS, DIR, [network(), folder("example-photos", "photos", { photos: library() })]);
    const physical = built.find((family) => family.name === "physical")!;
    expect([physical.adapters, physical.borrowed?.photos?.map((given) => given.product)]).toEqual([[], ["example-photos"]]);
  });

  it("a family's code bumped does not walk it, or walks another", () => {
    const fed = fedBy([log()]);
    const plain = (code: string) => (given: Parameters<typeof plainFamily>[0]) => ({ ...plainFamily(given), code });
    const list = (code: string) => made({ ...makersOf(families(SETTINGS, DIR, [])), line: plain(code) }, fed);
    expect(walked("code bumped", prints([], list("1")), prints([], list("2")))).toEqual(["plain"]);
  });

  it("the fingerprint is not the digest of its kept parts, or a part moves where it does not, or names another", () => {
    const folder = (id: string, type: Connector["type"], adapters: Adapters): FolderAdapters => ({ connectors: [declared(id, type)], adapters: { [id]: adapters } });
    const folders = (version: string): FolderAdapters[] => [
      network(chat(version)), log(), folder("example-mail", "mail", { mail: mailbox() }), folder("example-photos", "photos", { photos: library() }),
      folder("example-recorder", "device-activity", { screen: recorder() }),
    ];
    const before = families(SETTINGS, DIR, folders("1"));
    const joined = (parts: ReturnType<typeof fingerprintParts>) => digest({
      code: parts.code, inputs: JSON.parse(parts.inputs) as Json, adapters: JSON.parse(parts.adapters) as Json, borrowed: JSON.parse(parts.borrowed) as Json,
      zone: parts.zone, day_start_hour: Number(parts.day_start),
    });
    expect(before.map((family) => family.name).sort()).toEqual(Object.keys(fedBy([])).map((name) => (name === "line" ? "plain" : name)).sort());
    for (const day of [SETTINGS.day, { zone: "Asia/Kolkata", day_start_hour: 4 }]) {
      const mismatched = before.filter((family) => familyFingerprint(family, day) !== joined(fingerprintParts(family, day))).map((family) => family.name);
      expect(mismatched).toEqual([]);
    }
    const after = families(SETTINGS, DIR, folders("2"));
    const moved = Object.fromEntries(before.map((family, index): [string, string[]] => {
      const [was, now] = [fingerprintParts(family, SETTINGS.day), fingerprintParts(after[index]!, SETTINGS.day)];
      return [family.name, FINGERPRINT_PARTS.filter((part) => was[part] !== now[part])];
    }).filter(([, parts]) => parts.length > 0));
    expect(moved).toEqual({ calls: ["borrowed"], labels: ["borrowed"], messages: ["adapters"] });
    expect(Object.keys(moved).sort()).toEqual(walked("parts moved", prints([], before), prints([], after)));
    expect(Object.keys(fingerprintParts(before[0]!, SETTINGS.day))).toEqual([...FINGERPRINT_PARTS]);
  });

  it("the fingerprint's own shape moved, which would walk every family of every home", () => {
    const family = {
      name: "made-up", code: "3",
      inputs: [{ sources: ["example-notes:"], kinds: ["line", "entry"], role: "read" }, { sources: { product: "example-screen" }, kinds: ["frame"], role: "context" }],
      adapters: [{ product: "example-notes", name: "Example notes", vendor: "example", type: "notes", adapter: { version: "2", kinds: ["line", "entry"], noun: "entry" } }],
      borrowed: { screen: [{ product: "example-screen", name: "Example screen", vendor: "example", type: "device-activity", digest: "abc", adapter: { version: "1", kinds: ["frame"] } }] },
    } as unknown as Family;
    expect(familyFingerprint(family, { zone: "Asia/Kolkata", day_start_hour: 4 })).toBe("sha256:e715a6e88b53f37845cc228319d9f063e4963b761a7583b8671e45950ee48b60");
  });

  it("the order folders load in, or the order an adapter lists its kinds in, walks a family", () => {
    const one = { ...network(), connectors: [...network().connectors, declared("example-second", "messages")], adapters: { ...network().adapters, "example-second": { messages: chat() } } };
    expect(walked("load order", prints([one, log()]), prints([log(), { ...one, connectors: [...one.connectors].reverse() }]))).toEqual([]);
    expect(walked("kind order", prints([log(undefined, line("1", ["line", "entry"]))]), prints([log(undefined, line("1", ["entry", "line"]))]))).toEqual([]);
  });

  it("a home connector's search pairs are owned without its folder's digest, or a release connector's with one, or an edit moves another's", () => {
    const release: FolderAdapters = { connectors: [declared("example-release", "notes")], adapters: { "example-release": { line: line() } } };
    const sources = ["example-log:local:test", "example-release:local:test"].map((id): SourceRow => {
      const [product, account, copy] = id.split(":") as [string, string, string];
      return { id, product, account, copy, vendor: "example", connector: `${product}-rows`, options: {}, read_through_ms: null, added_ms: 0 };
    });
    const owners = (digest: string) => textsOf(sources, textFamilies(families(SETTINGS, DIR, [release, log(digest)]))).owners;
    expect(owners("sha256:folder-a")).toEqual({
      "example-log:local:test\0line": "plain/1/sha256:folder-a",
      "example-release:local:test\0line": "plain/1",
    });
    const edited = owners("sha256:folder-b");
    expect(edited["example-log:local:test\0line"]).toBe("plain/1/sha256:folder-b");
    expect(edited["example-release:local:test\0line"]).toBe("plain/1");
    compared.owners = { before: owners("sha256:folder-a"), edited };
  });

  it("a home connector's network owns its label kinds' search pairs without its folder's digest", () => {
    const labelled: MessagesAdapter = { ...chat(), labels: { kinds: ["chat"] }, labelText: () => null };
    const source: SourceRow = { id: "example-chat:local:test", product: "example-chat", account: "local", copy: "test", vendor: "example", connector: "example-chat-rows", options: {}, read_through_ms: null, added_ms: 0 };
    const owners = (digest: string) => {
      const listed = textFamilies(families(SETTINGS, DIR, [{ ...network(labelled), digest }]));
      return { owners: textsOf([source], listed).owners, version: listed.find((family) => family.name === "messages")!.text!.version };
    };
    const { owners: before, version } = owners("sha256:folder-a");
    expect([before["example-chat:local:test\0msg"], before["example-chat:local:test\0chat"]]).toEqual([`messages/${version}/sha256:folder-a`, `messages/${version}/sha256:folder-a`]);
    expect(owners("sha256:folder-b").owners["example-chat:local:test\0chat"]).toBe(`messages/${version}/sha256:folder-b`);
    compared.label_owners = before;
  });
});

describe("a labeler's fingerprint", () => {
  const folder = (id: string, type: Connector["type"], adapters: Adapters, digest?: string): FolderAdapters =>
    ({ connectors: [declared(id, type)], adapters: { [id]: adapters }, ...(digest === undefined ? {} : { digest }) });
  const fake = (name: string) => join(DIR, "faces", name);
  const cameras = camerasLabeler({ unit: "macbook-pro-0001", photos: [] }).reading!;
  const faces = facesLabeler({
    unit: "macbook-pro-0001", zone: "UTC", engine: fake("face-engine"), models: fake("models"), blobs: fake("blobs"), photos: [], messages: [],
    work: fake("work"), memo: (version) => openMemo(openHomeFolder(DIR), fake("memo.db"), version), fetch: fake("fetch-models.sh"), reference: fake("reference"),
  }).reading!;
  const print = (folders: readonly FolderAdapters[]) => {
    const list = families(SETTINGS, DIR, folders);
    return { cameras: labelerFingerprint(cameras, list), faces: labelerFingerprint(faces, list) };
  };
  const reset = (name: string, before: ReturnType<typeof print>, after: ReturnType<typeof print>) => {
    const names = (Object.keys(before) as (keyof typeof before)[]).filter((labeler) => before[labeler] !== after[labeler]).sort();
    compared[`labeler ${name}`] = { reset: names, before, after };
    return names;
  };

  it("an adapter it borrows moves it; one of a family it does not borrow, or the same adapters again, does not", () => {
    const photos = (version: string) => folder("example-photos", "photos", { photos: library(version) });
    expect(reset("same", print([photos("1"), network()]), print([photos("1"), network()]))).toEqual([]);
    expect(reset("photos bumped", print([photos("1")]), print([photos("2")]))).toEqual(["cameras", "faces"]);
    expect(reset("messages bumped", print([network(chat("1"))]), print([network(chat("2"))]))).toEqual(["faces"]);
    expect(reset("line installed", print([photos("1")]), print([photos("1"), log()]))).toEqual([]);
  });

  it("a home connector's folder digest moves it, and so does its code", () => {
    const photos = (digest: string) => folder("example-photos", "photos", { photos: library() }, digest);
    expect(reset("folder edited", print([photos("sha256:folder-a")]), print([photos("sha256:folder-b")]))).toEqual(["cameras", "faces"]);
    const list = families(SETTINGS, DIR, []);
    expect(labelerFingerprint({ ...cameras, code: `${cameras.code}-bumped` }, list)).not.toBe(labelerFingerprint(cameras, list));
    expect(labelerFingerprint({ ...faces, borrows: [...faces.borrows].reverse() }, list)).toBe(labelerFingerprint(faces, list));
  });
});

function makersOf(list: readonly Family[]): Parameters<typeof made>[0] {
  const key = (name: string) => (name === "plain" ? "line" : name);
  return Object.fromEntries(list.map((family) => [key(family.name), () => family])) as unknown as Parameters<typeof made>[0];
}
