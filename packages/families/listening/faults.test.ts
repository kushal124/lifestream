import { describe, expect, it } from "vitest";
import type { ListeningAdapter } from "@lifestreamprotocol/core";
import { statedOf } from "../test/stated.js";
import { listeningFaults } from "./faults.js";

const HEARD = { device: "", title: "Synthetic song", artist: null, album: null, app: null, length_s: 200, played_ms: 180_000 };
const ENTRY = { device: "macbook-pro-0001", playing: true, changed: true, title: "Synthetic song", artist: null, album: null, app: null, length_s: null };
const play = (value: object) => listeningFaults(statedOf<ListeningAdapter>({}, "play", value));

describe("listeningFaults", () => {
  it("passes a play heard, one that heard nothing, and a log's entry", () => {
    expect(play(HEARD)).toEqual([]);
    expect(play({ ...HEARD, played_ms: 0 })).toEqual([]);
    expect(play({ ...HEARD, played_ms: null, length_s: null })).toEqual([]);
    expect(play(ENTRY)).toEqual([]);
  });

  it("names each rule a play breaks", () => {
    expect(play({ ...HEARD, played_ms: -500 })).toEqual(["`played_ms` is how long it played in milliseconds, 0 or more: -500 is not"]);
    expect(play({ ...HEARD, length_s: 0 })).toEqual(["`length_s` is the item's length in seconds, more than 0: 0 is not"]);
    expect(play({ ...ENTRY, length_s: -3 })).toEqual(["`length_s` is the item's length in seconds, more than 0: -3 is not"]);
  });
});
