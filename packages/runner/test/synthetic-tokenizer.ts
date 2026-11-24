import { Tokenizer } from "@huggingface/tokenizers";

export const BYTE_CHARS: readonly string[] = (() => {
  const printable = (byte: number): boolean => (byte >= 0x21 && byte <= 0x7e) || (byte >= 0xa1 && byte <= 0xac) || (byte >= 0xae && byte <= 0xff);
  let next = 0;
  return Array.from({ length: 256 }, (_, byte) => String.fromCodePoint(printable(byte) ? byte : 256 + next++));
})();

export const END_OF_TEXT = 400;

export function syntheticTokenizer(merged: readonly string[] = []): { tokenizer: object; config: object } {
  const vocab: Record<string, number> = Object.fromEntries(BYTE_CHARS.map((character, byte) => [character, byte]));
  const merges: string[] = [];
  for (const text of merged) {
    const parts = [...Buffer.from(text, "utf8")].map((byte) => BYTE_CHARS[byte]!);
    let left = parts[0]!;
    for (const right of parts.slice(1)) {
      if (vocab[left + right] === undefined) {
        merges.push(`${left} ${right}`);
        vocab[left + right] = 256 + merges.length - 1;
      }
      left += right;
    }
  }
  const byteLevel = { type: "ByteLevel", add_prefix_space: false, trim_offsets: true, use_regex: true };
  return {
    tokenizer: {
      version: "1.0", truncation: null, padding: null, normalizer: null,
      added_tokens: [{ id: END_OF_TEXT, content: "<|endoftext|>", single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }],
      pre_tokenizer: byteLevel, post_processor: { ...byteLevel, trim_offsets: false }, decoder: byteLevel,
      model: { type: "BPE", dropout: null, unk_token: null, continuing_subword_prefix: null, end_of_word_suffix: null, fuse_unk: false, byte_fallback: false, ignore_merges: false, vocab, merges },
    },
    config: { eos_token: "<|endoftext|>", pad_token: "<|endoftext|>", tokenizer_class: "TokenizersBackend", model_input_names: ["input_ids", "attention_mask"] },
  };
}

export function tokenizerOf(merged: readonly string[] = []): Tokenizer {
  const { tokenizer, config } = syntheticTokenizer(merged);
  return new Tokenizer(tokenizer, config);
}
