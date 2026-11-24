import type { BlobReader, JsonObject, OpenView, Secrets, SourceSelector } from "@lifestreamprotocol/core";
import type { FetchedFile } from "./seams.js";

export interface Labeler {
  name: string;
  source: string;
  secrets?: readonly string[];
  inputs: { sources: SourceSelector; kinds: string[]; linked?: true }[];
  events?: readonly string[];
  reading?: { code: string; borrows: readonly string[] };
  label(view: OpenView, blobs: BlobReader, since: LabelSince, signal?: AbortSignal, secrets?: Secrets): Promise<LabelOutput | null>;
  draw?(photo: string, faces: readonly Framed[]): Buffer;
}

export interface Framed {
  name: string;
  box: [number, number, number, number];
}

export interface LabelSince {
  seq: number;
  reread: number;
  resting?: LabelerUnavailable["reason"];
}

export interface LabelOutput {
  files: FetchedFile[];
  facts: JsonObject;
}

export class LabelerUnavailable extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "LabelerUnavailable";
  }

  constructor(
    readonly reason: "not-installed" | "waiting-for-power" | "crashed" | "timeout" | "unreadable" | "refused",
    message: string,
    readonly output: LabelOutput | null = null,
  ) {
    super(message);
    this.name = "LabelerUnavailable";
  }
}
