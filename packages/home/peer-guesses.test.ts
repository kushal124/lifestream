import { describe, expect, it } from "vitest";
import { CODE_GUESSES, CODE_MS, PEER_GUESSES, PeerGuesses, PEERS_KEPT, type Taken } from "./pairing.js";

const waitOf = (answer: ReturnType<PeerGuesses["take"]>): number | null => "wait" in answer ? answer.wait : null;
const took = (answer: ReturnType<PeerGuesses["take"]>): Taken => {
  if ("wait" in answer) throw new Error(`slowed for ${answer.wait} s`);
  return answer;
};

describe("a peer's own code guesses", () => {
  it("lets one peer make fewer guesses than end a code, and counts another peer's apart", () => {
    expect(PEER_GUESSES).toBeLessThan(CODE_GUESSES);
    const guesses = new PeerGuesses(() => 0);
    const one = Array.from({ length: PEER_GUESSES + 2 }, () => waitOf(guesses.take("100.100.0.1")));
    expect(one).toEqual([...Array.from({ length: PEER_GUESSES }, () => null), CODE_MS / 1_000, CODE_MS / 1_000]);
    expect(waitOf(guesses.take("100.100.0.2"))).toBeNull();
  });

  it("counts requests at once as they arrive, before any is answered, and gives back a guess the home did not find wrong", () => {
    const guesses = new PeerGuesses(() => 0);
    const taken = Array.from({ length: PEER_GUESSES }, () => took(guesses.take("192.168.1.20")));
    expect(waitOf(guesses.take("192.168.1.20"))).not.toBeNull();
    taken[0]!.giveBack();
    taken[0]!.giveBack();
    expect(waitOf(guesses.take("192.168.1.20"))).toBeNull();
    expect(waitOf(guesses.take("192.168.1.20"))).not.toBeNull();
  });

  it("frees only the guess of the request given back: an earlier one's refund leaves a later wrong guess counted for its whole life", () => {
    let now = 0;
    const guesses = new PeerGuesses(() => now);
    const first = took(guesses.take("100.100.0.4"));
    now = 1_000;
    took(guesses.take("100.100.0.4"));
    first.giveBack();
    for (let each = 1; each < PEER_GUESSES; each++) took(guesses.take("100.100.0.4"));
    expect(waitOf(guesses.take("100.100.0.4"))).toBe(CODE_MS / 1_000);
    now = 1_000 + CODE_MS - 1;
    expect(waitOf(guesses.take("100.100.0.4"))).not.toBeNull();
    now = 1_000 + CODE_MS;
    expect(waitOf(guesses.take("100.100.0.4"))).toBeNull();
  });

  it("frees nothing for a guess that lapsed or whose peer was let go: its refund never frees a newer request's guess", () => {
    let now = 0;
    const guesses = new PeerGuesses(() => now, PEER_GUESSES, 1);
    const lapsing = took(guesses.take("100.100.0.5"));
    now = CODE_MS;
    const fresh = Array.from({ length: PEER_GUESSES }, () => took(guesses.take("100.100.0.5")));
    lapsing.giveBack();
    expect(waitOf(guesses.take("100.100.0.5"))).not.toBeNull();
    took(guesses.take("100.100.0.6"));
    const again = Array.from({ length: PEER_GUESSES }, () => took(guesses.take("100.100.0.5")));
    for (const guess of fresh) guess.giveBack();
    expect(waitOf(guesses.take("100.100.0.5"))).not.toBeNull();
    again[0]!.giveBack();
    expect(waitOf(guesses.take("100.100.0.5"))).toBeNull();
  });

  it("lets a guess lapse once a code's life has passed since it, the wait it answers counting down to that", () => {
    let now = 1_000_000;
    const guesses = new PeerGuesses(() => now);
    took(guesses.take("100.100.0.3"));
    now += 60_000;
    for (let each = 1; each < PEER_GUESSES; each++) guesses.take("100.100.0.3");
    expect(waitOf(guesses.take("100.100.0.3"))).toBe((CODE_MS - 60_000) / 1_000);
    now += CODE_MS - 60_000;
    expect(waitOf(guesses.take("100.100.0.3"))).toBeNull();
    expect(waitOf(guesses.take("100.100.0.3"))).toBe(60);
  });

  it("keeps at most PEERS_KEPT peers, letting go of the one that guessed longest ago", () => {
    const guesses = new PeerGuesses(() => 0, PEER_GUESSES, 4);
    for (const peer of ["a", "b", "c", "d"]) for (let each = 0; each < PEER_GUESSES; each++) guesses.take(peer);
    expect(waitOf(guesses.take("a"))).not.toBeNull();
    guesses.take("e");
    expect(guesses.size).toBe(4);
    expect(waitOf(guesses.take("b"))).toBeNull();
    expect(waitOf(guesses.take("a"))).not.toBeNull();
    expect(PEERS_KEPT).toBe(1_024);
  });
});
