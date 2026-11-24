import { vectorText, type EmbedAnswer, type EmbedRole } from "@lifestreamprotocol/model";
import type { OllamaManifest } from "./files.js";
import { Failed } from "./library.js";


export interface Embedder {
  readonly dimensions: number;
  readonly prompts: Readonly<Record<EmbedRole, string>>;
}

export function cut(values: readonly number[], dimensions: number): Float32Array {
  if (values.length < dimensions) throw new Failed("failed", `a vector of ${values.length} dimensions cannot be cut to ${dimensions}`);
  const vector = Float32Array.from(values.slice(0, dimensions));
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) throw new Failed("failed", "a vector with no length cannot be made unit length");
  for (let at = 0; at < dimensions; at++) vector[at]! /= norm;
  return vector;
}

export function embedAnswer(vectors: readonly (readonly number[])[], dimensions: number): string {
  const answer: EmbedAnswer = { dimensions, vectors: vectors.map((values) => vectorText(cut(values, dimensions))) };
  return JSON.stringify(answer);
}

export const EMBEDDINGGEMMA_2_Q8: OllamaManifest = {
  schemaVersion: 2, mediaType: "application/vnd.docker.distribution.manifest.v2+json",
  config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: "sha256:bee15587bacd25fd66b558cca24a3806313c43da235226d779b78f3fdccfc87b", size: 158 },
  layers: [
    { mediaType: "application/vnd.ollama.image.model", digest: "sha256:111e84992a0406bacb70d11dddd8874001c783cc56b82c462ec82a2f5b8d08b1", size: 303_957_280, from: "sha256-111e84992a0406bacb70d11dddd8874001c783cc56b82c462ec82a2f5b8d08b1" },
  ],
  runner: "llamacpp", format: "gguf",
};

export const EMBEDDINGGEMMA_2_EMBEDS: Embedder = {
  dimensions: 512,
  prompts: { query: "task: search result | query: ", document: "title: none | text: " },
};
