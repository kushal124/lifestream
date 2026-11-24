import { describe, expect, it } from "vitest";
import type { AiAdapter } from "@lifestreamprotocol/core";
import { BLOB, statedOf } from "../test/stated.js";
import { aiFaults } from "./faults.js";

const TURN = { role: "user", words: "", attachments: [], images: 0, tools: [], documents: [] };

describe("aiFaults", () => {
  it("passes a turn with no voice, or a voice note whose audio is a blob hash", () => {
    expect(aiFaults(statedOf<AiAdapter>({}, "turn", TURN))).toEqual([]);
    expect(aiFaults(statedOf<AiAdapter>({}, "turn", { ...TURN, voice: null }))).toEqual([]);
    expect(aiFaults(statedOf<AiAdapter>({}, "turn", { ...TURN, voice: { audio: BLOB, ms: 4_000 } }))).toEqual([]);
  });

  it("names a voice note's audio that is no blob hash", () => {
    expect(aiFaults(statedOf<AiAdapter>({}, "turn", { ...TURN, voice: { audio: "SHA256:AB", ms: 4_000 } }))).toEqual(["`voice.audio` is `sha256:` and 64 lower-case hex digits: `SHA256:AB` is none"]);
  });
});
