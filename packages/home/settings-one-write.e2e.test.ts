import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changeAll, effective, personal, SettingsError } from "./settings.js";
import { writeFolder } from "./test/folder.js";
import type { VerbContext } from "./verbs/context.js";
import { settings } from "./verbs/settings.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const RUNNER = "runner-macbook-pro-0001";

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "lifestream-settings-one-write-"));
  roots.push(root);
  writeFolder(root);
  return root;
}

const privacyOf = (root: string) => Object.fromEntries(Object.entries(personal(root)).filter(([key]) => key.startsWith("privacy.")));

describe("several settings in one write", () => {
  it("W1, W2: writes every member together, null as the key's default, or none of them when one is refused", () => {
    const root = folder();
    const shown = changeAll(root, { "privacy.level": "all", "privacy.detector": RUNNER });
    expect(shown.map(({ key, value }) => [key, value])).toEqual([["privacy.level", "all"], ["privacy.detector", RUNNER]]);
    expect(effective(root).settings.privacy).toMatchObject({ level: "all", detector: RUNNER });
    changeAll(root, { "privacy.level": "all", "privacy.detector": null });
    expect(privacyOf(root)).toEqual({ "privacy.level": "all" });
    expect(effective(root).settings.privacy.detector).toBe("off");
    const before = personal(root);
    expect(() => changeAll(root, { "privacy.level": "none", "privacy.detector": 7 })).toThrow(SettingsError);
    expect(() => changeAll(root, { "privacy.level": "none", "privacy.nothing": null })).toThrow(/privacy.nothing is not a setting/u);
    expect(() => changeAll(root, {})).toThrow(SettingsError);
    expect(personal(root)).toEqual(before);
  });

  it("W3: the verb takes one JSON object of home settings, refuses another act's keys and a word, and tells the running home", async () => {
    const root = folder();
    let told = 0;
    const out: string[] = [];
    const ctx = { folder: openHomeFolder(root), settingsChanged: () => { told += 1; }, out: (line: string) => out.push(line) } as unknown as VerbContext;
    const answer = await settings(ctx, ["set", JSON.stringify({ "privacy.level": "none", "privacy.detector": RUNNER })]) as { changed: { key: string }[] };
    expect(answer.changed.map((each) => each.key)).toEqual(["privacy.level", "privacy.detector"]);
    expect(privacyOf(root)).toEqual({ "privacy.level": "none", "privacy.detector": RUNNER });
    expect(told).toBe(1);
    expect(out).toHaveLength(2);
    const before = personal(root);
    await expect(settings(ctx, ["set", JSON.stringify({ "privacy.level": "all", "connectors.gmail": {} })])).rejects.toThrow(/lifestream connectors set/u);
    await expect(settings(ctx, ["set", JSON.stringify({ "privacy.level": "all", "model.defaults.text": null })])).rejects.toThrow(/lifestream models default/u);
    await expect(settings(ctx, ["set", "privacy.level"])).rejects.toThrow(/one JSON object/u);
    await expect(settings(ctx, ["set", JSON.stringify({ "privacy.level": "all", "privacy.detector": 7 })])).rejects.toMatchObject({ status: 422, code: "SETTING_REFUSED", words: "privacy.detector is off or a runner, runner-<unit>" });
    expect(personal(root)).toEqual(before);
    expect(told).toBe(1);
  });

  it("W4: search by meaning's settings: off, EmbeddingGemma 2 and plugged-in-and-idle by default, a runner and a model file id taken, anything else refused, run at once", async () => {
    const root = folder();
    expect(effective(root).settings.search).toEqual({ meaning: "off", model: "embeddinggemma-2-q8-512", power: "plugged-idle" });
    const out: string[] = [];
    const ctx = { folder: openHomeFolder(root), settingsChanged: () => undefined, out: (line: string) => out.push(line) } as unknown as VerbContext;
    await settings(ctx, ["set", JSON.stringify({ "search.meaning": RUNNER, "search.meaning.model": "another-model-1" })]);
    expect(effective(root).settings.search).toEqual({ meaning: RUNNER, model: "another-model-1", power: "plugged-idle" });
    expect(out.every((line) => line.includes("it runs at once"))).toBe(true);
    const before = personal(root);
    for (const [key, value] of [["search.meaning", "macbook-pro-0001"], ["search.meaning", "on"], ["search.meaning.model", "Not An Id"], ["search.meaning.power", "always"]] as const) {
      expect(() => changeAll(root, { [key]: value })).toThrow(SettingsError);
    }
    expect(personal(root)).toEqual(before);
    changeAll(root, { "search.meaning": null });
    expect(effective(root).settings.search.meaning).toBe("off");
  });
});
