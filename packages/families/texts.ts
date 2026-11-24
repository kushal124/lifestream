import { selects, type SourceParts } from "@lifestreamprotocol/core";
import type { Family } from "./family.js";

export function textFamilyOf(families: readonly Family[], source: Pick<SourceParts, "product" | "vendor" | "copy">, kind: string): Family | undefined {
  return families.find((family) => family.text?.kinds.includes(kind) === true &&
    family.inputs.some((input) => input.kinds.includes(kind) && selects(input.sources, source)));
}
