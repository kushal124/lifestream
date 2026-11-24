import type { Adapter, InputRecord } from "@lifestreamprotocol/core";
import type { Stated } from "../family.js";

export const AT_MS = Date.UTC(2026, 10, 2, 9, 30);

export function recordOf(key: string, time?: { readonly start_ms: number; readonly end_ms?: number }): InputRecord {
  return {
    source: { id: "example-product:person-a@example.com:cloud", connector: "example-product", product: "example-product", account: "person-a@example.com", copy: "cloud" },
    version: { kind: "item", key, content: null, ...(time === undefined ? {} : { time: { ...time, precision: "ms" } }) },
  };
}

export function statedOf<A extends Adapter>(adapter: Partial<A>, member: string, value: unknown, record: InputRecord | null = recordOf("item-1", { start_ms: AT_MS })): Stated<A> {
  return { adapter: { version: "1", kinds: ["item"], ...adapter } as unknown as A, member, record, value };
}

export const HEX = "ab".repeat(32);
export const BLOB = `sha256:${HEX}`;
