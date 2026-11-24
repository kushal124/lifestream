import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkDeviceFiles, runDeviceFilesCheck, type Call, type Lists } from "./check-device-files.js";

const roots: string[] = [];
const NONE: Lists = { allowed: [], plainDefaults: [] };
const MAC = "macos-app/Sources/Shipping/Fixture.swift";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-device-files-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

const refused = (root: string, lists: Lists = NONE) => checkDeviceFiles(root, lists).map((finding) => `${finding.rule} ${finding.file}:${finding.line} ${finding.detail.split(":")[0]}`);

const EACH: readonly (readonly [Call, string])[] = [
  ["Data(contentsOf:", "let data = try Data(contentsOf: url)"],
  ["String(contentsOf:", "let text = try String(contentsOf: url, encoding: .utf8)"],
  [".write(to:", "try data.write(to: url, options: .atomic)"],
  [".write(toFile:", "try text.write(toFile: path, atomically: true, encoding: .utf8)"],
  ["FileHandle(", "let handle = try FileHandle(forReadingFrom: url)"],
  ["fopen(", "let file = fopen(path, \"r\")"],
  ["Darwin.open(", "let fd = Darwin.open(path, O_RDONLY)"],
  ["open(", "let fd = open(url.path, O_WRONLY | O_CREAT, 0o600)"],
  ["sqlite3_open", "sqlite3_open_v2(path, &handle, flags, nil)"],
  ["createFile", "FileManager.default.createFile(atPath: path, contents: nil)"],
  ["copyItem", "try FileManager.default.copyItem(at: from, to: to)"],
  ["fileSizeKey", "let values = try url.resourceValues(forKeys: [.fileSizeKey])"],
  ["attributesOfItem", "let facts = try FileManager.default.attributesOfItem(atPath: path)"],
  ["temporaryDirectory", "let folder = FileManager.default.temporaryDirectory"],
  ["NSTemporaryDirectory", "let folder = NSTemporaryDirectory()"],
  ["st_size", "let bytes = Int(facts.st_size)"],
  ["truncate(", "guard Darwin.truncate(url.path, off_t(end)) == 0 else { return }"],
  ["DeviceFiles(.plain)", "let files = DeviceFiles(.plain)"],
  ["contents(atPath:", "let data = FileManager.default.contents(atPath: path)"],
  ["InputStream(", "let stream = InputStream(url: url)"],
  ["OutputStream(", "let stream = OutputStream(url: url, append: true)"],
  ["replaceItemAt", "_ = try FileManager.default.replaceItemAt(url, withItemAt: staged)"],
];

describe("the device files check", () => {
  it.each(EACH)("refuses %s in the Mac app and in HomeLink, with its line", (call, line) => {
    const root = tree({ [MAC]: `import Foundation\n\n${line}\n`, "homelink/Sources/HomeLink/Fixture.swift": `${line}\n` });
    expect(refused(root)).toEqual([`refused ${MAC}:3 ${call.replace(/:$/u, "")}`, `refused homelink/Sources/HomeLink/Fixture.swift:1 ${call.replace(/:$/u, "")}`]);
  });

  it("matches st_size as a whole word only, so StreamCompression's dst_size passes", () => {
    const root = tree({ [MAC]: "stream.dst_size = capacity\nlet left = stream.src_size\n" });
    expect(refused(root)).toEqual([]);
  });

  it("takes POSIX's truncate and ftruncate and FileHandle's cut, never a Log's own truncate()", () => {
    const root = tree({ [MAC]: "try log.truncate()\ntry chunkFile?.truncate()\nftruncate(fd, 0)\ntruncate(path, 0)\ntry sink.truncate(atOffset: 0)\n" });
    expect(refused(root)).toEqual([`refused ${MAC}:3 truncate(`, `refused ${MAC}:4 truncate(`, `refused ${MAC}:5 truncate(`]);
  });

  it("takes an open( only when it is POSIX's on a path with its flags, never a method or an own function", () => {
    const root = tree({ [MAC]: "NSWorkspace.shared.open(url)\nlet file = try open(session, at: at)\nstatic func open(_ log: URL) -> Int32 { 0 }\n" });
    expect(refused(root)).toEqual([]);
  });

  it("passes an allowed stamp read and only the calls its entry names", () => {
    const file = "macos-app/Sources/Shipping/Domains/StoreMemory.swift";
    const root = tree({ [file]: "let size = Int64(facts.st_size)\nlet data = try Data(contentsOf: url)\n" });
    const lists: Lists = { ...NONE, allowed: [{ file, calls: ["st_size"], reason: "the stamp of another app's store" }] };
    expect(refused(root, lists)).toEqual([`refused ${file}:2 Data(contentsOf`]);
  });

  it("reads photolibrary for temporaryDirectory alone, and refuses it outside its one allowed entry", () => {
    const pass = "photolibrary/Sources/PhotoLibrary/Pass.swift";
    const other = "photolibrary/Sources/PhotoLibrary/Export.swift";
    const root = tree({ [pass]: "let exports = FileManager.default.temporaryDirectory\n", [other]: "let at = FileManager.default.temporaryDirectory\nlet data = try Data(contentsOf: url)\n" });
    const lists: Lists = { ...NONE, allowed: [{ file: pass, calls: ["temporaryDirectory"], reason: "the phone's export folder" }] };
    expect(refused(root, lists)).toEqual([`refused ${other}:1 temporaryDirectory`]);
  });

  it("says when an allowed entry finds nothing", () => {
    const root = tree({ "macos-app/Sources/Shipping/MacSettings.swift": "let root = files.root\n" });
    const lists: Lists = {
      ...NONE,
      allowed: [{ file: "macos-app/Sources/Shipping/MacSettings.swift", calls: ["temporaryDirectory"], reason: "the fallback root" }],
    };
    expect(refused(root, lists)).toEqual(["allowed entry finds nothing macos-app/Sources/Shipping/MacSettings.swift:0 temporaryDirectory"]);
  });

  it("takes a file's streams by path or URL, never a stream over bytes in memory", () => {
    const root = tree({ [MAC]: "let a = InputStream(data: bytes)\nlet b = OutputStream(toMemory: ())\nlet c = InputStream(fileAtPath: path)\nlet d = OutputStream(toFileAtPath: path, append: false)\n" });
    expect(refused(root)).toEqual([`refused ${MAC}:3 InputStream(`, `refused ${MAC}:4 OutputStream(`]);
  });

  it("lets HomeLink alone default a parameter to the plain form, and refuses any other plain instance", () => {
    const link = "homelink/Sources/HomeLink/Credentials.swift";
    const root = tree({
      [link]: "public init(url: URL, files: DeviceFiles = DeviceFiles(.plain)) {}\nself.files = files ?? DeviceFiles(.plain)\n",
      [MAC]: "init(files: DeviceFiles = DeviceFiles(.plain)) {}\nlet files = DeviceFiles(.plain)\n",
      "photolibrary/Sources/PhotoLibrary/Pass.swift": "let files = DeviceFiles(.plain)\n",
    });
    expect(refused(root, { ...NONE, plainDefaults: ["homelink/Sources/"] })).toEqual([`refused ${MAC}:1 DeviceFiles(.plain)`, `refused ${MAC}:2 DeviceFiles(.plain)`]);
  });

  it("reads no file outside the three source folders, devicefiles/ and the tests among them", () => {
    const root = tree({
      "devicefiles/Sources/DeviceFiles/Durable.swift": "let fd = Darwin.open(path, O_RDONLY)\n",
      "macos-app/Tests/ShippingTests/Fixture.swift": "let data = try Data(contentsOf: url)\n",
      "macos-app/Sources/Shipping/Notes.md": "Data(contentsOf: url)\n",
    });
    expect(refused(root)).toEqual([]);
  });

  it("holds the repository to its lists", () => {
    let output = "";
    let errors = "";
    expect(runDeviceFilesCheck(resolve(dirname(fileURLToPath(import.meta.url)), ".."), (text) => { output += text; }, (text) => { errors += text; })).toBe(0);
    expect([output, errors]).toEqual(["device files check: clean\n", ""]);
  });
});
