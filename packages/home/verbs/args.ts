import { parseArgs } from "node:util";
import type { Json } from "@lifestreamprotocol/core";
import { fail } from "./context.js";
import { CLI } from "../cli-name.js";

type Options = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;

export function readArgs<const O extends Options>(
  verb: string, args: readonly string[], options: O, usage: string, positionals: number | { min: number; max: number } = 0,
) {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    return fail(`${verb}: ${(error as Error).message}\nusage: ${CLI} ${usage}`);
  }
  const { min, max } = typeof positionals === "number" ? { min: positionals, max: positionals } : positionals;
  const count = parsed.positionals.length;
  if (count < min || count > max) {
    const extra = count > max ? `: ${parsed.positionals.slice(max).map((word) => JSON.stringify(word)).join(" ")} is not an argument of ${verb}` : "";
    fail(`usage: ${CLI} ${usage}${extra}`);
  }
  return parsed;
}

export const JSON_FLAG = "--json";

export function answerForm(args: readonly string[]): { json: boolean; args: string[] } {
  const end = args.indexOf("--");
  const options = end < 0 ? args : args.slice(0, end);
  const json = options.includes(JSON_FLAG);
  return { json, args: json ? [...options.filter((word) => word !== JSON_FLAG), ...end < 0 ? [] : args.slice(end)] : [...args] };
}

export function read(word: string): Json {
  try {
    return JSON.parse(word) as Json;
  } catch {
    return word;
  }
}

export function required(value: string | undefined, name: string, usage: string): string {
  return value === undefined || value === "" ? fail(`--${name} is required\nusage: ${CLI} ${usage}`) : value;
}

export function wholeNumber(value: string, name: string, rule: (number: number) => boolean = () => true, what = "a whole number"): number {
  const number = /^-?\d+$/u.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(number) && rule(number) ? number : fail(`${name} is ${what}, not ${JSON.stringify(value)}`);
}
