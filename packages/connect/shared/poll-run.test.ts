import { describe, expect, it } from "vitest";
import { NotYet, type Acquirer, type Fetched, type Lent } from "../seams.js";
import { LENT, memorySecrets, pollCall, sealedFacts, type KeptPoll, type Sealing } from "./poll-run.js";

const answer = (more: Partial<Fetched & { left: number | null }> = {}): Fetched & { left?: number | null } => ({ files: [{ path: "a.json", bytes: Buffer.from("{}") }], facts: { fetched_at: "2026-09-15T12:00:00Z" }, state: { at: 1 }, ...more });

describe("what the home seals of a call's answer", () => {
  it("refuses facts that state what only the home states of a page, on a fetch and on a page", () => {
    for (const fact of ["history", "left", "start_ms"]) {
      expect(() => sealedFacts("synthetic", "fetch", answer({ facts: { [fact]: true } }), null)).toThrow(`acquirer synthetic's facts state ${fact}, which only the home states of a page`);
      expect(() => sealedFacts("synthetic", "page", answer({ facts: { [fact]: true }, left: 0 }), null)).toThrow(`acquirer synthetic's facts state ${fact}, which only the home states of a page`);
    }
  });

  it("refuses a read-through beside what it seals, or on a page, and takes one on a fetch that answered nothing new", () => {
    expect(() => sealedFacts("synthetic", "fetch", answer({ facts: { read_through: "2026-09-15T12:00:00Z" } }), null)).toThrow(/state read_through beside what it seals/u);
    expect(() => sealedFacts("synthetic", "page", answer({ files: [], facts: { read_through: "2026-09-15T12:00:00Z" }, left: 0 }), null)).toThrow(/state read_through beside what it seals/u);
    expect(sealedFacts("synthetic", "fetch", answer({ files: [], facts: { read_through: "2026-09-15T12:00:00Z" } }), null)).toBeNull();
  });

  it("seals a page stating history, its left and the start it ran under, even with no file; refuses a left that is no count", () => {
    expect(sealedFacts("synthetic", "page", answer({ files: [], left: 0 }), Date.UTC(2026, 0, 1))).toEqual({ fetched_at: "2026-09-15T12:00:00Z", history: true, left: 0, start_ms: Date.UTC(2026, 0, 1) });
    expect(sealedFacts("synthetic", "page", answer({ left: null }), null)).toEqual({ fetched_at: "2026-09-15T12:00:00Z", history: true, left: null, start_ms: null });
    expect(() => sealedFacts("synthetic", "page", answer({ left: -1 }), null)).toThrow("acquirer synthetic's page says -1 left: a count, or null while it cannot count");
  });

  it("seals an export as history, and nothing of a fetch that answered no file", () => {
    expect(sealedFacts("synthetic", "fetch", answer({ facts: { exported_at: "2026-09-01T00:00:00Z" } }), null)).toEqual({ exported_at: "2026-09-01T00:00:00Z", history: true });
    expect(sealedFacts("synthetic", "fetch", answer({ files: [] }), null)).toBeNull();
  });
});

describe("the shared driver seals as the home does", () => {
  const acquirer = (fetched: Fetched, page: Fetched & { left?: number | null }): Acquirer => ({
    name: "synthetic", source: "synthetic:person-a@example.com:cloud", fetch: async () => fetched, page: async () => ({ left: null, ...page }),
  });

  it("seals a page that answers no file, stating history, its left and the start it was lent", async () => {
    const sealed: Sealing[] = [];
    const kept: KeptPoll = { state: null };
    await pollCall(acquirer(answer(), answer({ files: [], left: 0 })), kept, memorySecrets({}), "page", (sealing) => sealed.push(sealing));
    expect(sealed).toEqual([{ files: {}, facts: { fetched_at: "2026-09-15T12:00:00Z", history: true, left: 0, start_ms: null }, source: "synthetic:person-a@example.com:cloud" }]);
    expect([kept.state, kept.left, kept.from_ms]).toEqual([{ at: 1 }, 0, null]);
  });

  it("lends no from_ms before a cursor, then the start each cursor was left under, through a refusal that leaves one too", async () => {
    const START = Date.UTC(2026, 0, 1);
    const seen: (number | null | undefined)[] = [];
    const answers: (() => Fetched)[] = [
      () => answer({ files: [] }),
      () => answer({ files: [] }),
      () => { throw new NotYet("offline", "the network went", { state: { at: 2 } }); },
      () => answer({ files: [] }),
    ];
    const calls: Acquirer = { name: "synthetic", source: "synthetic:person-a@example.com:cloud", fetch: async (_, __, lent: Lent) => { seen.push(lent.from_ms); return answers.shift()!(); } };
    const kept: KeptPoll = { state: null };
    await pollCall(calls, kept, memorySecrets({}), "fetch", () => undefined, { ...LENT, start_ms: START });
    await pollCall(calls, kept, memorySecrets({}), "fetch", () => undefined, { ...LENT, start_ms: null });
    await expect(pollCall(calls, kept, memorySecrets({}), "fetch", () => undefined, { ...LENT, start_ms: START })).rejects.toThrow("not yet: the network went");
    await pollCall(calls, kept, memorySecrets({}), "fetch", () => undefined, LENT);
    expect(seen).toEqual([undefined, START, null, START]);
    expect(kept.from_ms).toBeNull();
  });

  it("fails a fetch whose facts state history, sealing nothing and keeping the cursor it had", async () => {
    const sealed: Sealing[] = [];
    const kept: KeptPoll = { state: { at: 0 } };
    await expect(pollCall(acquirer(answer({ facts: { history: true } }), answer({ left: 0 })), kept, memorySecrets({}), "fetch", (sealing) => sealed.push(sealing)))
      .rejects.toThrow("acquirer synthetic's facts state history, which only the home states of a page");
    expect([sealed, kept.state]).toEqual([[], { at: 0 }]);
  });
});
