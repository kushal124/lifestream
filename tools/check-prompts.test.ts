import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { PromptShape } from "../packages/home/prompts.js";
import { checkPrompts } from "./check-prompts.js";

const roots: string[] = [];
const artifact: Record<string, string[]> = {};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  writeFileSync(join(tmpdir(), "check-prompts.json"), `${JSON.stringify(artifact, null, 2)}\n`);
});

const TAG = "packages/families/mail/prompts/mail-tag";
const kind = (...values: string[]) => ({ type: "object", properties: { kind: { type: "string", enum: values } }, required: ["kind"], additionalProperties: false });

function prompt(version: number, type: unknown, keeps: { version: number; type: unknown }[] = [], text = "Tag the mail.\n"): Record<string, string> {
  return { [`${TAG}.json`]: `${JSON.stringify({ version, type, keeps })}\n`, [`${TAG}.md`]: text };
}

function release(version: number, type: unknown, keeps: { version: number; type: unknown }[] = [], converted: number[] = []): Record<string, PromptShape> {
  return { "mail-tag": { version, type, keeps, converters: Object.fromEntries(converted.map((each) => [each, (answer: unknown) => answer])) } as PromptShape };
}

function repo(files: Record<string, string>, branch = "main"): string {
  const root = mkdtempSync(join(tmpdir(), "check-prompts-"));
  roots.push(root);
  git(root, "init", "-q", "-b", branch);
  commit(root, files);
  git(root, "checkout", "-q", "-b", "wp-lane");
  return root;
}

function commit(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "a change");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, "-c", "user.email=person-a@example.com", "-c", "user.name=person-a", ...args], { stdio: "ignore" });
}

function check(name: string, root: string, prompts: Record<string, PromptShape>): string[] {
  const faults = checkPrompts(root, prompts);
  artifact[name] = faults;
  return faults;
}

describe("the repo's prompt check", () => {
  it("fails a type narrowed at the same version", () => {
    const root = repo(prompt(1, kind("bill", "order", "other")));
    expect(check("narrowed", root, release(1, kind("bill", "order")))).toEqual([expect.stringMatching(/^mail-tag: version 1's answer type changed: give it a new version/u)]);
  });

  it("passes a type widened at the same version, and a text edit", () => {
    const root = repo(prompt(1, kind("bill", "order")));
    expect(check("widened", root, release(1, kind("bill", "order", "travel")))).toEqual([]);
  });

  it("fails a kept version whose type is not the one the base stated for it, and passes one whose descriptions alone changed", () => {
    const root = repo(prompt(1, kind("bill", "order")));
    expect(check("kept retyped", root, release(2, kind("bill", "order", "travel"), [{ version: 1, type: kind("bill", "order", "travel") }], [1])))
      .toEqual(["mail-tag: keeps version 1 with a type other than the one it was stated with"]);
    const described = { ...kind("bill", "order"), description: "what the mail is" };
    expect(check("kept described", root, release(2, kind("bill", "order", "travel"), [{ version: 1, type: described }]))).toEqual([]);
  });

  it("fails a kept version the current type does not read with no converter, and passes it with one", () => {
    const root = repo(prompt(1, kind("bill", "order")));
    expect(check("no converter", root, release(2, kind("bill"), [{ version: 1, type: kind("bill", "order") }])))
      .toEqual([expect.stringMatching(/^mail-tag: keeps version 1, whose answers version 2's type does not read .*, with no converter$/u)]);
    expect(check("a converter", root, release(2, kind("bill"), [{ version: 1, type: kind("bill", "order") }], [1]))).toEqual([]);
  });

  it("fails a version that went down, a kept version not below the current one, and a type outside the subset", () => {
    const root = repo(prompt(3, "text"));
    expect(check("went down", root, release(2, "text", [{ version: 2, type: "text" }]))).toEqual([
      "mail-tag: keeps version 2, which is not below its version 2",
      "mail-tag: went down from version 3 to 2",
    ]);
    expect(check("outside", repo(prompt(2, "text")), release(4, "text", [{ version: 3, type: { type: "string" } }], [3])))
      .toEqual(["mail-tag: version 3's answer type is outside the subset: the answer type is `text` or a JSON Schema whose root is an object"]);
  });

  it("passes a lane behind main: it is held to the merge base, not to main", () => {
    const root = repo(prompt(1, kind("bill", "order")));
    git(root, "checkout", "-q", "main");
    commit(root, prompt(2, kind("bill"), [], "Tag the mail again.\n"));
    git(root, "checkout", "-q", "wp-lane");
    expect(check("behind main", root, release(1, kind("bill", "order")))).toEqual([]);
  });

  it("takes a prompt the base lacks as new, and a .json with no text beside it as no prompt", () => {
    const root = repo({ "packages/families/screen/prompts/screen-schema.json": `${JSON.stringify({ type: "object" })}\n` });
    expect(check("new", root, release(4, kind("bill"), [{ version: 2, type: "text" }]))).toEqual([expect.stringMatching(/^mail-tag: keeps version 2, whose answers version 4's type does not read/u)]);
  });

  it("refuses a repo with no merge base with main, rather than skip the base's rules", () => {
    const root = repo(prompt(1, kind("bill", "order", "other")), "trunk");
    expect(() => checkPrompts(root, release(1, kind("bill", "order")))).toThrow(/merge-base/u);
  });
});
