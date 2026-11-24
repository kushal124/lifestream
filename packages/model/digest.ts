import { digest, type Json } from "@lifestreamprotocol/core";


export interface Sampling {
  temperature: number;
  seed?: number;
}

export function promptHash(text: string): string {
  return digest(text);
}

export function inputHash(input: string, identity?: Json): string {
  return digest(identity === undefined ? input : identity);
}

export function requestKey(request: {
  model: string;
  prompt: string;
  version: number;
  input_hash: string;
  effort: string | null;
  sampling?: Sampling | null;
}): string {
  const sampling = request.sampling ?? null;
  return digest({
    model: request.model,
    prompt: request.prompt,
    version: request.version,
    input: request.input_hash,
    effort: request.effort,
    sampling: sampling === null ? null : { temperature: sampling.temperature, ...(sampling.seed === undefined ? {} : { seed: sampling.seed }) },
  });
}

export function retryIdentity(refusedInputHash: string, answer: string): string {
  return digest({ retry_of: refusedInputHash, answer: digest(answer) });
}
