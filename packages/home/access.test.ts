import { describe, expect, it } from "vitest";
import { readerOf } from "./access.js";
import type { Principal } from "./principals.js";

const pass = (members: Record<string, unknown>) => ({ id: "p-1a2b3c4d", kind: null, scopes: ["read"], ...members }) as unknown as Principal;

describe("the reader of a request", () => {
  it("is main's: an agent's pass its agent, a turn's pass or the person's naming a conversation Ask, any other the person", () => {
    expect(readerOf(pass({ kind: "agent", agent: { name: "Hermes" } }), null)).toEqual({ kind: "agent", reader: "p-1a2b3c4d" });
    expect(readerOf(pass({ kind: "agent", agent: { name: "Hermes" } }), "chat-1")).toEqual({ kind: "agent", reader: "p-1a2b3c4d" });
    expect(readerOf(pass({ turn: { id: "t-1", chat: "chat-1", level: "names" } }), null)).toEqual({ kind: "ask", reader: "ask" });
    expect(readerOf(pass({}), "chat-1")).toEqual({ kind: "ask", reader: "ask" });
    expect(readerOf(pass({}), null)).toEqual({ kind: "person" });
    expect(readerOf(pass({ kind: "phone" }), null)).toEqual({ kind: "person" });
  });
});
