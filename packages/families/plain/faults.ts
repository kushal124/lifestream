import type { Line, LineAdapter } from "@lifestreamprotocol/core";
import type { Stated } from "../family.js";
import { lineFaults } from "./family.js";

export function plainFaults({ member, value }: Stated<LineAdapter>): string[] {
  return member !== "line" || value === null || typeof value !== "object" ? [] : lineFaults(value as Line).map((fault) => `its line ${fault}`);
}
