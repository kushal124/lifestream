import { isObject, readJson, refuse, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";

export const API_FORMAT = "org.lifestreamprotocol.granola-api-pull/0.1";
export const MCP_FORMAT = "org.lifestreamprotocol.granola-mcp-pull/0.1";
export const PULL_MANIFEST = "pull.json";

export type Media = "json" | "sse";

export interface Element {
  attributes: Record<string, string>;
  children: { name: string; attributes: Record<string, string>; text: string | null }[];
}

export function rpcAnswer(body: string, media: Media, id: number, where: string): JsonObject {
  const messages: Json[] = [];
  if (media === "json") {
    const value = readJson(body, where);
    messages.push(...(Array.isArray(value) ? value : [value]));
  } else {
    for (const event of body.replace(/\r\n?/gu, "\n").split(/\n\n/u)) {
      const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
      if (data.length > 0) messages.push(readJson(data.join("\n"), where));
    }
  }
  const answer = messages.find((message) => isObject(message) && message.id === id);
  if (!isObject(answer)) refuse(`${where} holds no answer to request ${id}`);
  return answer;
}

export function toolText(answer: JsonObject, where: string): { error: boolean; text: string } {
  if (isObject(answer.error)) {
    const code = answer.error.code;
    refuse(`${where}: the server answered error${typeof code === "number" && Number.isSafeInteger(code) ? ` ${code}` : ""}`);
  }
  const result = isObject(answer.result) ? answer.result : refuse(`${where} states no result`);
  const content = Array.isArray(result.content) ? result.content : refuse(`${where}'s result states no content`);
  const text = content.filter((part): part is JsonObject => isObject(part) && part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n");
  return { error: result.isError === true, text };
}

export function meetingSources(text: string): string[] {
  const starts = [...text.matchAll(/<meeting(?=[\s/>])/gu)].map((match) => match.index);
  return starts.map((start, index) => {
    const next = starts[index + 1] ?? text.length;
    const close = text.indexOf("</meeting>", start);
    const tag = startTag(text, start);
    if (tag?.closed === true) return text.slice(start, tag.end);
    return close >= 0 && close < next ? text.slice(start, close + "</meeting>".length) : text.slice(start, next);
  });
}

export function holdsMeetings(text: string): boolean {
  return /<meetings_data(?=[\s/>])/u.test(text);
}

export function readMeeting(source: string, where: string): Element {
  const tag = startTag(source, 0) ?? refuse(`${where}: the meeting's start tag does not read`);
  const children: Element["children"] = [];
  if (!tag.closed) {
    const end = source.lastIndexOf("</meeting>");
    if (end < tag.end) refuse(`${where}: the meeting has no end tag`);
    const body = source.slice(tag.end, end);
    for (let at = 0; at < body.length; ) {
      const open = body.indexOf("<", at);
      if (open < 0) break;
      const child = startTag(body, open) ?? refuse(`${where}: a child element's tag does not read`);
      if (child.closed) {
        children.push({ name: child.name, attributes: child.attributes, text: null });
        at = child.end;
        continue;
      }
      const close = body.indexOf(`</${child.name}>`, child.end);
      if (close < 0) refuse(`${where}: <${child.name}> has no end tag`);
      children.push({ name: child.name, attributes: child.attributes, text: decoded(body.slice(child.end, close)) });
      at = close + child.name.length + 3;
    }
  }
  return { attributes: tag.attributes, children };
}

export function attributesOf(text: string, name: string): Record<string, string> | undefined {
  const match = new RegExp(`<${name}(?=[\\s/>])`, "u").exec(text);
  return match === null ? undefined : startTag(text, match.index)?.attributes;
}

export function textsOf(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gu"))].map((match) => decoded(match[1]!).trim());
}

function startTag(text: string, at: number): { name: string; attributes: Record<string, string>; end: number; closed: boolean } | undefined {
  const head = /<([A-Za-z_][\w.-]*)/uy;
  head.lastIndex = at;
  const name = head.exec(text);
  if (name === null) return undefined;
  const attributes: Record<string, string> = {};
  const attribute = /\s+([A-Za-z_][\w.:-]*)="([^"]*)"/uy;
  const end = /\s*(\/?)>/uy;
  let position = head.lastIndex;
  for (;;) {
    end.lastIndex = position;
    const closing = end.exec(text);
    if (closing !== null) return { name: name[1]!, attributes, end: end.lastIndex, closed: closing[1] === "/" };
    attribute.lastIndex = position;
    const pair = attribute.exec(text);
    if (pair === null || Object.hasOwn(attributes, pair[1]!)) return undefined;
    attributes[pair[1]!] = decoded(pair[2]!);
    position = attribute.lastIndex;
  }
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decoded(text: string): string {
  return text.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#x([0-9A-Fa-f]{1,6}));/gu, (whole, name: string | undefined, decimal: string | undefined, hex: string | undefined) => {
    if (name !== undefined) return ENTITIES[name]!;
    const point = decimal !== undefined ? Number(decimal) : Number.parseInt(hex!, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}
