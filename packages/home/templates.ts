import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { repoRoot } from "./programs.js";

export const RELEASE_KINDS: ReadonlySet<string> = new Set(["phone", "label"]);

export const templatesFolder = (): string => join(repoRoot(), "packages", "connect", "templates");

export const templateKinds = (): string[] => readdirSync(templatesFolder(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

function opening(text: string): { heading: string | null; paragraph: string } {
  const lines = text.replace(/\r\n/gu, "\n").trimStart().split("\n");
  const heading = lines[0]!.startsWith("# ") ? lines[0]!.trim() : null;
  const paragraphs = (heading === null ? lines : lines.slice(1)).join("\n").split(/\n\s*\n/u);
  return { heading, paragraph: paragraphs.map((each) => each.replace(/\s+/gu, " ").trim()).find((each) => each !== "") ?? "" };
}

export function templatePages(folder: string): { page: string; kind: string }[] {
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
  const within = relative(real(templatesFolder()), real(folder));
  if (within !== "" && !within.startsWith("..") && !within.includes(sep)) return [];
  const kinds = existsSync(templatesFolder()) ? templateKinds() : [];
  return readdirSync(folder).filter((name) => name.endsWith(".md")).sort().flatMap((page) => {
    const { heading, paragraph } = opening(readFileSync(join(folder, page), "utf8"));
    const kind = kinds.find((each) => heading?.endsWith(`(${each} template)`) === true || paragraph.startsWith(`The \`${each}\` kind's template`));
    return kind === undefined ? [] : [{ page, kind }];
  });
}
