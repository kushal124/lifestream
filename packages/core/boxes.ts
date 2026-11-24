import type { Box } from "./hide.js";

export function overlap(a: Box, b: Box, over: "union" | "smaller"): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const shared = width * height;
  const areaA = a.width * a.height, areaB = b.width * b.height;
  return shared / Math.max(Number.EPSILON, over === "union" ? areaA + areaB - shared : Math.min(areaA, areaB));
}
