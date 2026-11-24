import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KeyError, openHomeFolder } from "@lifestreamprotocol/core";
import { keyedFolder } from "@lifestreamprotocol/core/test/keyed";
import { blockOf, change, changeAll, effective, effectiveOf, isReadBeforeKey, membersBeforeKey, personal, reset, runsAt, sealStrays, settingsPath } from "./settings.js";

const ACCOUNT = "zqx-canary-account@example.com";
const SOURCE = `gmail:${ACCOUNT}:inbox`;
const BEFORE_KEY = ["day.day_start_hour", "day.zone", "door.lan_port", "door.max_bundle_bytes", "door.port", "unit"];
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fresh(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `lifestream-settings-${name}-`));
  roots.push(root);
  return root;
}

const SET = { "day.zone": "UTC", unit: "macbook-pro-0001", "door.port": 4680, "connectors.gmail": { account: ACCOUNT }, "sources.off": [SOURCE], "connectors.macos-app": { modes: [{ app: "Synthetic Notes", mode: "exclude" }] }, helpers: 4 };

const plainText = (root: string) => readFileSync(settingsPath(root), "utf8");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
}

describe("which settings stay plain on a keyed home", () => {
  it("only what a process reads before it holds a key: the day, the unit and the door's address", () => {
    const every = effectiveOf({ "day.zone": "UTC", unit: "macbook-pro-0001" }, "the release").shown.map((shown) => shown.key);
    expect(every.filter(isReadBeforeKey).sort()).toEqual(BEFORE_KEY);
  });

  it("seals every connector's block, the sources turned off, and a key no release declares", () => {
    for (const key of ["connectors.gmail", "connectors.macos-app", "sources.off", "sites.chosen", "clients.google", "families.mail", "model.transports.address", "privacy.level", "not.a.setting"]) {
      expect(isReadBeforeKey(key), key).toBe(false);
    }
  });
});

describe("a plain home's settings", () => {
  it("stay one file, sorted, two spaces, a newline at the end, and nothing beside it", () => {
    const root = fresh("plain");
    const folder = openHomeFolder(root);
    changeAll(folder, SET);
    const sorted = Object.fromEntries(Object.entries(SET).sort(([left], [right]) => left.localeCompare(right)));
    expect(plainText(root)).toBe(`${JSON.stringify(sorted, null, 2)}\n`);
    expect(readdirSync(join(root, "config"))).toEqual(["settings.json"]);
    expect(personal(root)).toEqual(SET);
    expect(membersBeforeKey(root)).toEqual({ "day.zone": "UTC", unit: "macbook-pro-0001", "door.port": 4680 });
  });

  it("read and write what comes before a key without judging the form, and keep every other member as written", () => {
    const root = fresh("formless");
    changeAll(openHomeFolder(root), SET);
    symlinkSync("loop", join(root, "loop"));
    expect(() => effective(root)).toThrow(/ELOOP/u);
    expect(runsAt(root, "door.port")).toBe(4680);
    change(root, "door.port", 4690);
    change(root, "day.day_start_hour", 5);
    rmSync(join(root, "loop"));
    expect(personal(root)).toEqual({ ...SET, "door.port": 4690, "day.day_start_hour": 5 });
  });
});

describe("a keyed home's settings", () => {
  it("keep the account, the sources turned off and the excluded apps sealed, and read back whole", () => {
    const root = fresh("keyed");
    const folder = keyedFolder(root);
    changeAll(folder, SET);
    expect(JSON.parse(plainText(root))).toEqual({ "day.zone": "UTC", unit: "macbook-pro-0001", "door.port": 4680 });
    for (const file of filesUnder(root)) {
      const bytes = readFileSync(file, "utf8");
      expect(bytes.includes(ACCOUNT) || bytes.includes("Synthetic Notes"), file).toBe(false);
    }
    expect(existsSync(join(root, "config", "settings-sealed.json.k1"))).toBe(true);
    expect(personal(folder)).toEqual(SET);
    expect(blockOf(folder, "gmail")).toEqual({ account: ACCOUNT });
    expect(effective(folder).settings.sources.off).toEqual([SOURCE]);
    reset(folder, "connectors.gmail");
    expect(blockOf(folder, "gmail")).toEqual({});
  });

  it("read and write what comes before a key with no key, and refuse the rest", () => {
    const root = fresh("locked");
    changeAll(keyedFolder(root), SET);
    expect(membersBeforeKey(root)).toEqual({ "day.zone": "UTC", unit: "macbook-pro-0001", "door.port": 4680 });
    expect(runsAt(root, "door.lan_port")).toBe(4682);
    change(root, "door.port", 4690);
    expect(runsAt(root, "door.port")).toBe(4690);
    expect(() => effective(root)).toThrow(KeyError);
    expect(() => change(root, "sources.off", [])).toThrow(KeyError);
    expect(personal(keyedFolder(root))).toEqual({ ...SET, "door.port": 4690 });
  });

  it("read only the six from the plain file, and seal any other member found there at the home's start", () => {
    const root = fresh("hand");
    const folder = keyedFolder(root);
    changeAll(folder, { "day.zone": "UTC", unit: "macbook-pro-0001", helpers: 4 });
    writeFileSync(settingsPath(root), JSON.stringify({ ...JSON.parse(plainText(root)), "connectors.gmail": { account: ACCOUNT }, helpers: 8 }));
    expect(blockOf(folder, "gmail")).toEqual({});
    expect(effective(folder).settings.helpers).toBe(4);
    expect(sealStrays(folder)).toEqual(["connectors.gmail", "helpers"]);
    expect(JSON.parse(plainText(root))).toEqual({ "day.zone": "UTC", unit: "macbook-pro-0001" });
    expect(blockOf(folder, "gmail")).toEqual({ account: ACCOUNT });
    expect(effective(folder).settings.helpers).toBe(8);
    expect(sealStrays(folder)).toEqual([]);
  });

  it("never write the plain file when it holds nothing to seal", () => {
    const root = fresh("settled");
    const folder = keyedFolder(root);
    changeAll(folder, SET);
    writeFileSync(settingsPath(root), '{"unit":"macbook-pro-0001","day.zone":"UTC","door.port":4680}');
    expect(sealStrays(folder)).toEqual([]);
    expect(plainText(root)).toBe('{"unit":"macbook-pro-0001","day.zone":"UTC","door.port":4680}');
  });
});

describe("a plain home's settings at its start", () => {
  it("stay as written, every member read from the one file", () => {
    const root = fresh("plain-start");
    const folder = openHomeFolder(root);
    const text = `${JSON.stringify({ "connectors.gmail": { account: ACCOUNT }, unit: "macbook-pro-0001" })}\n`;
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(settingsPath(root), text);
    expect(sealStrays(folder)).toEqual([]);
    expect(plainText(root)).toBe(text);
    expect(readdirSync(join(root, "config"))).toEqual(["settings.json"]);
    expect(blockOf(folder, "gmail")).toEqual({ account: ACCOUNT });
  });
});
