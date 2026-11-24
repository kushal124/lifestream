import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnswerType } from "@lifestreamprotocol/core";
import { promptFaults, promptsOf, type PromptShape, type Recorded } from "../packages/home/prompts.js";
import { families } from "../packages/home/registry-home.js";
import { effectiveOf } from "../packages/home/settings.js";

const IN_PROMPTS = /^packages\/families\/[^/]+\/prompts\/[^/]+\.(?:json|md)$/u;

function promptFiles(paths: readonly string[]): string[] {
  const held = new Set(paths.filter((path) => IN_PROMPTS.test(path)));
  return [...held].filter((path) => path.endsWith(".json") && held.has(`${path.slice(0, -".json".length)}.md`));
}

type Stated = Pick<PromptShape, "version" | "type" | "keeps">;

export function checkPrompts(root: string, prompts: Readonly<Record<string, PromptShape>>): string[] {
  const base = git(root, "merge-base", "main", "HEAD").trim();
  const before: Recorded[] = promptFiles(git(root, "ls-tree", "-r", "--name-only", base, "--", "packages/families").split("\n"))
    .flatMap((path) => {
      const prompt = stated(git(root, "show", `${base}:${path}`), `${base.slice(0, 9)}:${path}`);
      const name = basename(path, ".json");
      return [{ name, version: prompt.version, type: prompt.type }, ...prompt.keeps.map((each) => ({ name, ...each }))];
    });
  return [...promptFaults(prompts, before, true)].flatMap(([name, faults]) => faults.map((why) => `${name}: ${why}`));
}

function stated(text: string, where: string): Stated {
  const value = JSON.parse(text) as { version?: unknown; type?: unknown; keeps?: unknown };
  const isType = (type: unknown): type is AnswerType => type === "text" || (typeof type === "object" && type !== null && !Array.isArray(type));
  const keeps = Array.isArray(value.keeps) ? value.keeps as { version?: unknown; type?: unknown }[] : null;
  if (!Number.isInteger(value.version) || !isType(value.type) || keeps === null || !keeps.every((each) => Number.isInteger(each.version) && isType(each.type))) {
    throw new TypeError(`${where}: a prompt's file states a whole version, a type and the versions it keeps, each with its type`);
  }
  return { version: value.version as number, type: value.type, keeps: keeps.map((each) => ({ version: each.version as number, type: each.type as AnswerType })) };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function releasePrompts(root: string): Record<string, PromptShape> {
  const built = families(effectiveOf({ "day.zone": "UTC", unit: "check-prompts" }, "the release's settings").settings, join(root, ".build", "check-prompts"));
  return Object.fromEntries([...promptsOf(built)].map(([name, { prompt }]) => [name, prompt]));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const faults = checkPrompts(root, releasePrompts(root));
  for (const fault of faults) process.stderr.write(`check-prompts: ${fault}\n`);
  process.stdout.write(faults.length === 0 ? "check-prompts: ok\n" : "");
  process.exitCode = faults.length === 0 ? 0 : 1;
}
