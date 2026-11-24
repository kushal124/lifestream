import type { Projection, Version } from "@lifestreamprotocol/core";

export function fix(head: Version): Projection | "keep" {
  const content = head.content;
  const availability = typeof content === "object" && content !== null && !Array.isArray(content) && content.type === "photos.apple.availability";
  return head.kind === "img" && availability ? { content, kind: "img-file" } : "keep";
}
