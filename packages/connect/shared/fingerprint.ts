import { digest, FormatError, type Json } from "@lifestreamprotocol/core";
import { refuse } from "./refused.js";

/** The `sha256:` hash of a value's canonical JSON, which names a row by its fields, refusing a value that has no canonical JSON. */
export function fingerprint(fields: Json): string {
  try {
    return digest(fields);
  } catch (error) {
    if (error instanceof FormatError) refuse(error.message);
    throw error;
  }
}
