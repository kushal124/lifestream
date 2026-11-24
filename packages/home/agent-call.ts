import { CLI } from "./cli-name.js";
import { jobLabel } from "./release.js";
import { fail } from "./verbs/context.js";

export const MCP_ORIGIN = "http://127.0.0.1:4681";
export const CALL_USAGE = "agents call [<tool> [<json arguments>]]";
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

interface Schema {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly items?: Schema;
  readonly anyOf?: readonly Schema[];
  readonly description?: string;
}

export interface Tool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: { readonly properties?: Readonly<Record<string, Schema>>; readonly required?: readonly string[] };
}

export interface Called {
  readonly content?: readonly { readonly type: string; readonly text?: string; readonly mimeType?: string; readonly data?: string; readonly uri?: string }[];
  readonly isError?: boolean;
}

export interface CallAgent {
  readonly id: string;
  readonly name: string;
}

export interface CallOptions {
  readonly pass: () => Promise<{ pass: string; agent: CallAgent }>;
  readonly mcp: string;
  readonly line: (text: string) => void;
}

export async function agentsCall(words: readonly string[], options: CallOptions): Promise<{ answer: unknown; ok: boolean }> {
  if (words.length > 2 || words.some((word) => word.startsWith("--"))) fail(`usage: ${CLI} ${CALL_USAGE}`);
  const [name, text] = words;
  const args = text === undefined ? {} : argumentsOf(text);
  const { pass, agent } = await options.pass();
  const url = `${options.mcp}/mcp`;
  const { tools } = await rpc(url, pass, "tools/list", {}) as { tools: Tool[] };
  if (name === undefined) {
    options.line(`${tools.length} tools at ${url}, read as the agent "${agent.name}" (${agent.id}) under its access (${CLI} agents access ${agent.id} prints it):`);
    for (const tool of tools) for (const each of toolLines(tool)) options.line(each);
    options.line(`call one: ${CLI} agents call <tool> '{"<argument>": <value>}'; --json prints the server's answer as it is`);
    return { answer: { tools }, ok: true };
  }
  const tool = tools.find((each) => each.name === name);
  if (tool === undefined) fail(`no tool ${name}: the tools are ${tools.map((each) => each.name).join(", ")} (${CLI} agents call lists each with its arguments)`);
  const called = await rpc(url, pass, "tools/call", { name, arguments: args }) as Called;
  for (const each of called.content ?? []) options.line(each.type === "text" ? each.text ?? "" : each.type === "image" ? `[a picture, ${each.mimeType ?? "an image"}, ${Buffer.byteLength(each.data ?? "", "base64")} bytes]` : `[${each.type}${each.uri === undefined ? "" : ` ${each.uri}`}]`);
  if (called.isError === true) options.line(`${name} takes: ${argumentsSaid(tool)} (${CLI} agents call lists each)`);
  return { answer: called, ok: called.isError !== true };
}

function argumentsOf(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`a tool's arguments are one JSON object, quoted for the shell: ${CLI} agents call read '{"from":"2026-11-08"}' (${CLI} agents call lists each tool's)`);
  }
  return value as Record<string, unknown>;
}

export function toolLines(tool: Tool): string[] {
  const properties = Object.entries(tool.inputSchema?.properties ?? {});
  const required = new Set(tool.inputSchema?.required ?? []);
  return [
    "",
    `${tool.name}: ${tool.description ?? ""}`.trimEnd(),
    ...(properties.length === 0 ? ["  (no arguments)"] : properties.map(([name, schema]) => `  ${name}${required.has(name) ? "" : "?"}: ${typeOf(schema)}${schema.description === undefined ? "" : `. ${schema.description}`}`)),
  ];
}

function argumentsSaid(tool: Tool): string {
  const required = new Set(tool.inputSchema?.required ?? []);
  const names = Object.keys(tool.inputSchema?.properties ?? {});
  return names.length === 0 ? "no arguments" : names.map((name) => `${name}${required.has(name) ? "" : "?"}`).join(", ");
}

function typeOf(schema: Schema): string {
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((each) => JSON.stringify(each)).join(", ")}`;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(typeOf).join(" or ");
  const types = typeof schema.type === "string" ? [schema.type] : [...(schema.type ?? [])];
  if (types.length === 0) return "any JSON value";
  return types.map((type) => type === "array" ? `a list of ${plural(typeOf(schema.items ?? {}))}` : type).join(" or ");
}

function plural(type: string): string {
  return /^[a-z]+$/u.test(type) ? `${type}s` : type;
}

async function rpc(url: string, pass: string, method: string, params: object): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { ...HEADERS, authorization: `Bearer ${pass}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const label = jobLabel("mcp");
    return fail(`the MCP server is not answering at ${url} (${cause?.code ?? cause?.message ?? (error as Error).message}): it runs beside the home as ${label}; `
      + `start it (launchctl kickstart gui/$(id -u)/${label}, or node mcp/server.mjs in a checkout), then ask again`);
  }
  const text = await response.text();
  let body: { result?: unknown; error?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {}
  const said = typeof body.error === "string" ? body.error : typeof (body.error as { message?: unknown } | undefined)?.message === "string" ? (body.error as { message: string }).message : text.slice(0, 200);
  if (response.status === 503) fail(`the MCP server cannot reach the home's door (${said}): ${CLI} status says how the home stands; ask again once it answers`);
  if (response.status === 401) fail(`the MCP server refused the command line's pass (${said}): ask again; a pass removed meanwhile is made again`);
  if (response.status !== 200) fail(`the MCP server answered ${method} with ${response.status}: ${said}`);
  if (body.error !== undefined) fail(`the MCP server refused ${method}: ${said}`);
  return body.result;
}
