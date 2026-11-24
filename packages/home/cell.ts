import type { DetailType } from "@lifestreamprotocol/core";

export type Cell =
  | { is: "plain"; value: string | number | null }
  | { is: "text"; value: string }
  | { is: "person"; value: string; who?: string; handle?: string }
  | { is: "detail"; value: string; type: DetailType; who?: string }
  | { is: "ref"; value: string };

export const text = (value: string): Cell => ({ is: "text", value });

export const plain = (value: string | number | null): Cell => ({ is: "plain", value });
