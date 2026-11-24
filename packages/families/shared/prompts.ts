import { readFileSync } from "node:fs";
import { isObject, type AnswerType, type Json, type Prompt } from "@lifestreamprotocol/core";

const SHARED: Readonly<Record<string, string>> = Object.fromEntries(["PLACEHOLDERS", "COVERED"].map((mark) =>
  [`{${mark}}`, readFileSync(new URL(`./prompt-parts/${mark.toLowerCase()}.md`, import.meta.url), "utf8").trim()]));

export function statedPrompt(folder: URL, name: string, build: (text: string) => string = (text) => text): Prompt {
  const stated = JSON.parse(readFileSync(new URL(`${name}.json`, folder), "utf8")) as Json;
  const wrong = (why: string) => new TypeError(`prompts/${name}.json: ${why}`);
  if (!isObject(stated) || Object.keys(stated).sort().join() !== "keeps,type,version") throw wrong("it states version, type and keeps, and nothing else");
  const { version, type, keeps } = stated;
  if (!isVersion(version)) throw wrong("version is a whole number from 1");
  if (!isType(type)) throw wrong('type is "text" or a JSON Schema object');
  if (!Array.isArray(keeps)) throw wrong("keeps is a list");
  const kept = keeps.map((each) => {
    if (!isObject(each) || !isVersion(each.version) || !isType(each.type)) throw wrong("each kept version states its version and its type");
    return { version: each.version, type: each.type };
  });
  let text = build(readFileSync(new URL(`${name}.md`, folder), "utf8"));
  for (const [mark, words] of Object.entries(SHARED)) text = text.replaceAll(mark, words);
  return { version, type, keeps: kept, text };
}

function isVersion(value: Json | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isType(value: Json | undefined): value is AnswerType {
  return value === "text" || isObject(value);
}
