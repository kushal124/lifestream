import { createHash } from "node:crypto";
import type { Projection, Version } from "@lifestreamprotocol/core";

const FRACTION = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d+Z$/u;

export function fix(head: Version): Projection | "keep" {
  const { time, header, title, titleUrl } = head.content as { time?: unknown; header?: unknown; title?: unknown; titleUrl?: unknown };
  const second = typeof time === "string" ? FRACTION.exec(time) : null;
  if (second === null || typeof header !== "string" || typeof title !== "string") return "keep";
  const fields = { header, time: `${second[1]}Z`, title, ...(typeof titleUrl === "string" ? { titleUrl } : {}) };
  const key = `sha256:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
  return key === head.key ? "keep" : { content: head.content, key };
}
