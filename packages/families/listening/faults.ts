import type { ListeningAdapter, PlayHeard } from "@lifestreamprotocol/core";
import type { Stated } from "../family.js";

export function listeningFaults({ member, value }: Stated<ListeningAdapter>): string[] {
  if (member !== "play" || value === null || typeof value !== "object") return [];
  const play = value as Partial<PlayHeard>;
  const faults: string[] = [];
  const { played_ms, length_s } = play;
  if ("played_ms" in play && played_ms !== null && !(typeof played_ms === "number" && Number.isFinite(played_ms) && played_ms >= 0)) {
    faults.push(`\`played_ms\` is how long it played in milliseconds, 0 or more: ${String(played_ms)} is not`);
  }
  if (length_s !== null && length_s !== undefined && !(typeof length_s === "number" && Number.isFinite(length_s) && length_s > 0)) {
    faults.push(`\`length_s\` is the item's length in seconds, more than 0: ${String(length_s)} is not`);
  }
  return faults;
}
