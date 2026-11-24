import type { AnswerType, Json, JsonObject, Prompt } from "@lifestreamprotocol/core";


type Kind = "object" | "array" | "string" | "number" | "integer" | "boolean";
const KINDS: readonly string[] = ["object", "array", "string", "number", "integer", "boolean"];

export type Read = { value: Json } | { violations: string[] };

export function faults(type: AnswerType): string[] {
  if (type === "text") return [];
  if (!isObject(type) || type.type !== "object") return ["the answer type is `text` or a JSON Schema whose root is an object"];
  const found: string[] = [];
  nodeFaults(type, "", found);
  return found;
}

export function parse(type: AnswerType, text: string): Read {
  if (type === "text") return { value: text };
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) return { violations: ["the answer holds no JSON object"] };
  const first = objectAt(trimmed, start);
  if ("value" in first) return first;
  const fence = /```(?:json)?/u.exec(trimmed);
  const inside = fence === null ? -1 : trimmed.indexOf("{", fence.index + fence[0].length);
  if (inside < 0 || inside === start) return first;
  const fenced = objectAt(trimmed, inside);
  return "value" in fenced ? fenced : first;
}

function objectAt(text: string, start: number): Read {
  let depth = 0;
  let quoted = false;
  let end = text.length;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      end = index + 1;
      break;
    }
  }
  try {
    return { value: JSON.parse(text.slice(start, end)) as Json };
  } catch (error) {
    return { violations: [`the answer is not JSON: ${(error as Error).message}`] };
  }
}

export function fit(type: AnswerType, value: Json): Json {
  return type === "text" ? value : fitNode(type, value);
}

export function check(type: AnswerType, value: Json): string[] {
  if (type === "text") return typeof value === "string" ? [] : ["the answer must be text"];
  const found: string[] = [];
  checkNode(type, value, "", found);
  return found;
}

export function compatible(old: AnswerType, next: AnswerType): string[] {
  const outside = [...faults(old).map((fault) => `the old type: ${fault}`), ...faults(next).map((fault) => `the new type: ${fault}`)];
  if (outside.length > 0) return outside;
  if (old === "text" || next === "text") return old === next ? [] : [old === "text" ? "`text` became an object" : "an object became `text`"];
  const found: string[] = [];
  compareNodes(old, next, "", found);
  return found;
}

export function bare(type: AnswerType): AnswerType {
  return type === "text" ? type : bareNode(type);
}

function bareNode(node: JsonObject): JsonObject {
  const { description: _description, properties, items, ...rest } = node;
  const bared: JsonObject = { ...rest };
  if (properties !== undefined) bared.properties = isObject(properties) ? Object.fromEntries(Object.entries(properties).map(([name, child]) => [name, isObject(child) ? bareNode(child) : child])) : properties;
  if (items !== undefined) bared.items = isObject(items) ? bareNode(items) : items;
  return bared;
}

export function readAnswer(prompt: Prompt, version: number, text: string): Read {
  if (version === prompt.version) return read(prompt.type, text);
  const kept = prompt.keeps.find((each) => each.version === version);
  if (kept === undefined) return { violations: [`version ${version} is not kept by version ${prompt.version}`] };
  const parsed = parse(kept.type, text);
  if ("violations" in parsed) return parsed;
  let value = fit(kept.type, parsed.value);
  const converter = prompt.converters?.[version];
  if (converter !== undefined) {
    try {
      value = converter(value);
    } catch (error) {
      return { violations: [`version ${version}'s converter failed: ${(error as Error).message}`] };
    }
  }
  value = fit(prompt.type, value);
  const violations = check(prompt.type, value);
  return violations.length === 0 ? { value } : { violations };
}

export function read(type: AnswerType, text: string): Read {
  const parsed = parse(type, text);
  if ("violations" in parsed) return parsed;
  const value = fit(type, parsed.value);
  const violations = check(type, value);
  return violations.length === 0 ? { value } : { violations };
}

function kindOf(node: JsonObject): { kind: Kind; nullable: boolean } | undefined {
  const { type } = node;
  if (typeof type === "string") return KINDS.includes(type) ? { kind: type as Kind, nullable: false } : undefined;
  if (Array.isArray(type) && type.length === 2 && type[1] === "null" && typeof type[0] === "string" && KINDS.includes(type[0])) {
    return { kind: type[0] as Kind, nullable: true };
  }
  return undefined;
}

const MEMBERS: Record<Kind, readonly string[]> = {
  object: ["properties", "required", "additionalProperties"],
  array: ["items"],
  string: ["enum"],
  number: [],
  integer: [],
  boolean: [],
};

function nodeFaults(node: Json, path: string, found: string[]): void {
  const at = where(path);
  if (!isObject(node)) return void found.push(`${at}: a type is a JSON object`);
  const shape = kindOf(node);
  if (shape === undefined) return void found.push(`${at}: type is one of ${KINDS.join(", ")}, or one of them and "null"`);
  const allowed = ["type", "description", ...MEMBERS[shape.kind]];
  for (const member of Object.keys(node)) if (!allowed.includes(member)) found.push(`${at}: "${member}" is not in the subset; a reader's rule says it`);
  if (node.description !== undefined && typeof node.description !== "string") found.push(`${at}: description is text`);
  if (shape.kind === "object") {
    if (!isObject(node.properties)) return void found.push(`${at}: an object states its properties`);
    const names = Object.keys(node.properties);
    const required = Array.isArray(node.required) ? node.required : [];
    if (required.length !== names.length || !names.every((name) => required.includes(name))) found.push(`${at}: an object requires every property`);
    if (node.additionalProperties !== false) found.push(`${at}: an object states additionalProperties false`);
    for (const name of names) nodeFaults(node.properties[name]!, member(path, name), found);
  } else if (shape.kind === "array") {
    if (node.items === undefined) found.push(`${at}: an array states its items`);
    else nodeFaults(node.items, `${path}[]`, found);
  } else if (shape.kind === "string" && node.enum !== undefined) {
    const values = Array.isArray(node.enum) ? node.enum : [];
    const strings = values.filter((value) => typeof value === "string");
    const nulls = values.filter((value) => value === null).length;
    if (strings.length === 0 || strings.length + nulls !== values.length) found.push(`${at}: an enum lists strings`);
    if (nulls !== (shape.nullable ? 1 : 0)) found.push(`${at}: a nullable enum lists null once, and only a nullable one does`);
  }
}

function fitNode(node: JsonObject, value: Json): Json {
  const shape = kindOf(node);
  if (shape?.kind === "object" && isObject(value) && isObject(node.properties)) {
    const fitted: JsonObject = {};
    for (const [name, child] of Object.entries(node.properties)) {
      if (!isObject(child)) continue;
      if (Object.hasOwn(value, name)) fitted[name] = fitNode(child, value[name]!);
      else if (kindOf(child)?.nullable === true) fitted[name] = null;
    }
    return fitted;
  }
  if (shape?.kind === "array" && Array.isArray(value) && isObject(node.items)) return value.map((item) => fitNode(node.items as JsonObject, item));
  return value;
}

function checkNode(node: JsonObject, value: Json, path: string, found: string[]): void {
  const shape = kindOf(node)!;
  const at = where(path);
  if (value === null) {
    if (!shape.nullable) found.push(`${at} must be ${A[shape.kind]}, not null`);
    return;
  }
  switch (shape.kind) {
    case "object": {
      if (!isObject(value)) return void found.push(`${at} must be ${A.object}`);
      const properties = node.properties as JsonObject;
      for (const [name, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, name)) found.push(`${where(member(path, name))} is missing`);
        else checkNode(child as JsonObject, value[name]!, member(path, name), found);
      }
      return;
    }
    case "array":
      if (!Array.isArray(value)) return void found.push(`${at} must be ${A.array}`);
      value.forEach((item, index) => checkNode(node.items as JsonObject, item, `${path}[${index}]`, found));
      return;
    case "string": {
      if (typeof value !== "string") return void found.push(`${at} must be ${A.string}`);
      const values = Array.isArray(node.enum) ? node.enum.filter((each) => typeof each === "string") : undefined;
      if (values !== undefined && !values.includes(value)) found.push(`${at} must be one of ${values.join(", ")}, not ${JSON.stringify(value)}`);
      return;
    }
    case "number":
      if (typeof value !== "number") found.push(`${at} must be ${A.number}`);
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) found.push(`${at} must be ${A.integer}`);
      return;
    case "boolean":
      if (typeof value !== "boolean") found.push(`${at} must be ${A.boolean}`);
  }
}

function compareNodes(old: JsonObject, next: JsonObject, path: string, found: string[]): void {
  const was = kindOf(old)!;
  const is = kindOf(next)!;
  const at = where(path);
  if (was.nullable && !is.nullable) found.push(`${at} is no longer nullable`);
  if (was.kind !== is.kind && !(was.kind === "integer" && is.kind === "number")) return void found.push(`${at} was ${A[was.kind]} and is ${A[is.kind]}`);
  if (was.kind === "string") {
    const values = (node: JsonObject) => (Array.isArray(node.enum) ? node.enum.filter((each): each is string => typeof each === "string") : undefined);
    const before = values(old);
    const after = values(next);
    if (after !== undefined && before === undefined) found.push(`${at} became an enum`);
    else if (after !== undefined && before !== undefined) {
      const lost = before.filter((value) => !after.includes(value));
      if (lost.length > 0) found.push(`${at}'s enum lost ${lost.join(", ")}`);
    }
  } else if (was.kind === "array") compareNodes(old.items as JsonObject, next.items as JsonObject, `${path}[]`, found);
  else if (was.kind === "object") {
    const before = old.properties as JsonObject;
    const after = next.properties as JsonObject;
    for (const name of Object.keys(before)) {
      if (!Object.hasOwn(after, name)) found.push(`${where(member(path, name))} was removed`);
      else compareNodes(before[name] as JsonObject, after[name] as JsonObject, member(path, name), found);
    }
    for (const name of Object.keys(after)) {
      if (!Object.hasOwn(before, name) && kindOf(after[name] as JsonObject)?.nullable !== true) found.push(`${where(member(path, name))} was added, and is not nullable`);
    }
  }
}

const A: Record<Kind, string> = {
  object: "an object", array: "an array", string: "a string", number: "a number", integer: "an integer", boolean: "true or false",
};

function member(path: string, name: string): string {
  return path === "" ? name : `${path}.${name}`;
}

function where(path: string): string {
  return path === "" ? "the answer" : `"${path}"`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
