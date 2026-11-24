import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { JsonObject } from "@lifestreamprotocol/core";
import type { FixtureDelivery, Spoiled } from "../../../test/drive.js";
import { writeZip } from "../../../test/drive.js";
import { messageKey, repairText, threadId } from "../../../shared/meta-export.js";

export function mojibake(text: string): string {
  return Buffer.from(text, "utf8").toString("latin1");
}

export function metaJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2).replace(/[\u007f-￿]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));
}

export const JPEG = (n: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`synthetic jpeg ${n}`)]);
export const PNG = (n: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`synthetic png ${n}`)]);
export const WEBP = (n: number): Buffer => Buffer.concat([Buffer.from("RIFF"), Buffer.from(`synthetic webp ${n}`)]);
export const GIF = (n: number): Buffer => Buffer.concat([Buffer.from("GIF89a"), Buffer.from(`synthetic gif ${n}`)]);
export const MP4 = (n: number): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftypmp42 synthetic video ${n}`)]);

export function zipOf(dir: string, members: Record<string, Buffer>, name: string): Buffer {
  const path = join(dir, name);
  writeZip(path, Object.entries(members).map(([member, bytes]) => ({ name: member, bytes, method: "deflate" as const })));
  return readFileSync(path);
}

export function extracted(members: Record<string, Buffer>, folder: string): Record<string, Buffer> {
  return Object.fromEntries(Object.entries(members).map(([path, bytes]) => [`${folder}/${path}`, bytes]));
}

export function metaFixture(folder: string, source: string, members: Record<string, Buffer>, profile: string, items: Record<string, (item: JsonObject) => string>): FixtureDelivery {
  const files: Record<string, Spoiled> = {};
  const threads = new Map<string, string[]>();
  for (const [path, bytes] of Object.entries(members)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), bytes);
    const thread = /^(.*\/messages\/[^/]+\/[^/]+)\/message_\d+\.json$/u.exec(path)?.[1];
    if (thread !== undefined) threads.set(thread, [...(threads.get(thread) ?? []), path]);
    const head = items[path];
    if (path === profile) files[path] = "trust";
    else if (head !== undefined) {
      const elements = JSON.parse(bytes.toString("utf8")) as JsonObject[];
      const half = Math.floor(bytes.length / 2);
      const closed = elements.filter((_, index) => metaJson(elements.slice(0, index + 1)).length - 2 <= half);
      files[path] = { alone: elements.map(head), prefix: closed.map(head) };
    } else files[path] = { alone: [] };
  }
  for (const parts of threads.values()) {
    for (const path of parts) {
      const value = JSON.parse(members[path]!.toString("utf8")) as { thread_path: string; messages: JsonObject[] };
      const thread = threadId(value.thread_path);
      const text = (stated: unknown) => (typeof stated === "string" ? repairText(stated) : stated);
      const messages = value.messages.map((message) => `msg ${messageKey(thread, { ...message, sender_name: text(message.sender_name), content: text(message.content) } as JsonObject)}`);
      files[path] = { alone: parts.length === 1 ? [...messages, `chat ${thread}`] : messages };
    }
  }
  return { source, facts: { exported_at: "2026-09-20T12:00:00.000Z" }, files };
}
