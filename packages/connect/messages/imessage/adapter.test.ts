import { describe, expect, it } from "vitest";
import { imessageMessages } from "./adapter-messages.js";

describe("iMessage's adapter", () => {
  it("a chat of one handle read as a group, or a group's handles left out of its people", () => {
    expect([imessageMessages.group("+15550000001"), imessageMessages.group("+15550000001,person-a@example.com")]).toEqual([false, true]);
    expect(imessageMessages.group("+15550000001,+15550000001(smsft)")).toBe(false);
    expect(imessageMessages.members("+15550000001,person-a@example.com")).toEqual([{ id: "+15550000001", kind: "phone" }, { id: "person-a@example.com", kind: "email" }]);
  });

  it("a source's account spelled as the owner's own id: a phone with its `+`, its digits alone among them, or an address", () => {
    expect(["15550000001", "+15550000001", "Person-A@Example.com", "local"].map((account) => imessageMessages.self!(account)))
      .toEqual(["+15550000001", "+15550000001", "person-a@example.com", null]);
  });
});
